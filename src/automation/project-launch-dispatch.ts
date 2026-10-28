import { randomUUID } from "node:crypto";
import {projectLaunchTitle} from './project-launch-title.js';
import type {IncidentSessionRouter} from './incident-session-router.js';
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";

import {
  canonicalProjectKey,
  findProjectRouteKey,
  resolveProjectLaunch,
  type AutomationLaunchPolicy,
  type LaunchOutcome,
  type ProjectLaunchResolution,
} from "../automation-launch-policy.js";
import type { HarnessAdapter, HarnessType } from "../types/common.js";
import { newOrResumeNamedSession, type NamedSessionMode, type NamedSessionResult } from "../named-session.js";
import { HUMAN_STOP_MESSAGE } from "../human-stop-actions.js";
import { MINIMAX_SUBSCRIPTION_MODEL, type MiniMaxQuotaPreflight } from "./minimax-quota-preflight.js";
import { NOTICEPLACE_HEALTH_AUTHORIZED, validateNoticeplaceHealthLaunch } from "./noticeplace-health-launch.js";
import { MODEL_NOT_PERMITTED_CODE, ModelNotPermittedError } from "../project-model-policy.js";
import { assertModelAllowedForProjectRoute } from "../project-model-gate.js";
import { AUTOMATION_DISABLED_CODE } from "./health-reason-codes.js";
import { automationDisarmDecision, humanWorkKey, projectWorkKey, AutomationDisarmStore } from "../automation-disarm/index.js";

/**
 * One recorded attempt of one operation on one harness.
 *
 * An attempt is reserved durably before the native call and completed after it,
 * so a crash leaves an `in_flight` reservation instead of an unrecorded launch.
 */
export interface ProjectLaunchAttempt {
  harness: HarnessType;
  /** `in_flight` is a durable reservation whose outcome is not known yet. */
  outcome: LaunchOutcome | "human_hold" | "in_flight";
  reason: string;
  at: string;
  /** The stable native operation identity of this attempt. */
  inputId: string;
  sessionId?: string;
  /** The exact model, mode and delivery of this attempt, kept for a full replay. */
  model?: string;
  mode?: NamedSessionMode;
  /** Whether this attempt created a session or resumed an existing one. */
  created?: boolean;
  delivery?: NamedSessionResult["delivery"];
  error?: string;
  atCompleted?: string;
  /** Complete native receipt, including admission state, preserved across restart. */
  result?: NamedSessionResult;
}

export interface ProjectLaunchDispatchResult extends Partial<NamedSessionResult> {
  operationId: string;
  project: string;
  /** Human-readable reason the route advanced or stopped. */
  routingReason: string;
  /**
   * Stable ASCII class of the routing decision, for a machine observer.
   *
   * The reason text is written for a person and may be reworded; the code
   * names the class of the decision and stays stable.
   */
  routingReasonCode?: string;
  /**
   * Stable ASCII class of the cause behind the routing decision.
   *
   * The code names the class of the decision itself; this field names the
   * class of the cause inside it, so a forbidden automation is told from a
   * blocked work without reading the wording of the reason.
   */
  routingReasonDetail?: string;
  /**
   * The logical work key the refusal was made on, in its readable form.
   *
   * A refusal of a blocked work names the work that is blocked, so an
   * operator reads what to unblock and never guesses it from the project: the
   * project of a refusal is the route the policy resolved, which is not
   * necessarily the blocked one. The key is the readable form the owner may
   * type, and it is present only when a work is blocked: a forbidden
   * automation has no blocked work to name.
   */
  routingReasonWorkKey?: string;
  attempts: ProjectLaunchAttempt[];
  outcome: LaunchOutcome | "human_hold" | "in_flight" | "no_harness";
  selectedHarness?: HarnessType;
  model?: string;
  mode?: "create" | "resume" | "handoff_required";
  /** The key of the route the project is, when the project has a route of its own. */
  routeKey?: string;
  /** The root of the route replaced the requested working folder. */
  workspaceReplaced?: boolean;
  sessionId?: string;
  delivery?: NamedSessionResult["delivery"];
  error?: string;
}

export interface ProjectLaunchSourceSession {
  harness: HarnessType;
  sessionId: string;
  /** Stable Herder host identity prevents cross-node session ID aliasing. */
  hostId: string;
}

/** The actual native call. It is the only place that may create an executor. */
export type ProjectLaunchRunner = (request: {
  incidentRouting?: boolean;
  harness: HarnessType;
  cwd: string;
  message: string;
  model?: string;
  mode: NamedSessionMode;
  /** Ordered same-session model fallbacks; only definite pre-admission rejection advances. */
  fallbackModels?: string[];
  /** Stable per operation and harness, so a repeat attempt is deduplicated natively. */
  inputId: string;
  /** Only an explicit project route may authorize the route quota fallback. */
  configuredRoute?: boolean;
  sourceSessions?: ProjectLaunchSourceSession[];
  requireSourceHostId?: boolean;
}) => Promise<NamedSessionResult>;

/** The production dispatch port injected into the web seam. */
export interface ProjectLaunchDispatcher {
  (input: {
    [NOTICEPLACE_HEALTH_AUTHORIZED]?: true;
    project: string;
    cwd: string;
    message: string;
    harness?: HarnessType;
    model?: string;
    mode?: NamedSessionMode;
    operationId?: string;
    name?: string;
    sourceSessions?: ProjectLaunchSourceSession[];
  }): Promise<ProjectLaunchDispatchResult>;
}

export interface ProjectLaunchDispatchInput {
  /** Set only after dedicated Notice Place bearer verification in HTTP. */
  [NOTICEPLACE_HEALTH_AUTHORIZED]?: true;
  policy: AutomationLaunchPolicy;
  /** Canonical project root or the identifier a real card carries. */
  project: string;
  /** Workspace of the launch. A configured route is authoritative over it. */
  cwd?: string;
  message: string;
  /**
   * Profile default. It applies only to a project without a configured route;
   * a configured route decides the harness, the model and the workspace.
   */
  harness?: HarnessType;
  model?: string;
  mode?: NamedSessionMode;
  /** Stable operation identity. Repeating it never launches a second executor. */
  operationId?: string;
  /** Human-readable session name used by the existing named-session seam. */
  name?: string;
  sourceSessions?: ProjectLaunchSourceSession[];
}

/** Human-readable harness names for the routing reason a person reads. */
const HARNESS_LABELS: Partial<Record<HarnessType, string>> = {
  opencode: "OpenCode", zcode: "ZCode", codex: "Codex", claude: "Claude Code",
  qoder: "Qoder", hermes: "Hermes", "fast-agent": "Fast Agent", chatgpt: "ChatGPT",
};

function harnessLabel(harness: string): string {
  return HARNESS_LABELS[harness as HarnessType] ?? harness;
}

/**
 * Stable ASCII classes of a routing decision.
 *
 * The model class is the shared code of the per-project model policy, so the
 * launch field and the tool error code name the same refusal.
 */
const ROUTING_CODE_HARNESS_NOT_ALLOWED = "harness_not_allowed";
const ROUTING_CODE_NO_ROUTE = "no_route";
const ROUTING_CODE_NO_HARNESS_LEFT = "no_harness_left";
const ROUTING_CODE_ADMISSION_NOT_CONFIRMED = "admission_not_confirmed";
const ROUTING_CODE_INCIDENT_SCOPE_NOT_PERMITTED = "incident_scope_not_permitted";
const ROUTING_CODE_INCIDENT_ATTEMPT_FAILED = "incident_attempt_failed";

/** Outcomes that must never advance to another harness. */
const STOP_OUTCOMES: ReadonlySet<LaunchOutcome | "human_hold"> = new Set<LaunchOutcome | "human_hold">([
  "accepted",
  "admission_unknown",
  "human_hold",
]);

/**
 * Dispatch one project launch through its ordered harness route.
 *
 * The ordered attempt log is authoritative: every native outcome is recorded
 * with its stable input id before the next harness is considered. Only a
 * definite pre-admission failure advances the route, and an accepted or unknown
 * admission stops it, so a repeated callback, a crash or a Notice retry can
 * never produce a second executor.
 */
export async function dispatchProjectLaunch(
  input: ProjectLaunchDispatchInput,
  log: ProjectLaunchAttemptLog,
  run: ProjectLaunchRunner,
): Promise<ProjectLaunchDispatchResult> {
  // The attempt log is keyed by the configured route key, so an alias, a path
  // spelling or a case variant of the same project shares one authority.
  const project = attemptKeyOf(input.policy, input.project);
  const operationId = input.operationId?.trim() || randomUUID();
  const mode: NamedSessionMode = input.mode ?? "sync";
  let cwd = input.cwd ?? "";
  const healthAnalysis = input[NOTICEPLACE_HEALTH_AUTHORIZED] === true;
  const routeKey = routeKeyOf(input.policy, input.project);
  const healthRoute = routeKey ? input.policy.projectRoutes?.[routeKey] : undefined;
  // The receipt names the route the project IS and states whether the root of
  // that route replaced the requested working folder, so the fact is readable
  // from the receipt and not only from the routing text.
  const routeReceipt = routeReceiptOf(input.policy, input.project, input.cwd);
  if (healthAnalysis) {
    const error = validateNoticeplaceHealthLaunch(input)
      ?? (!input.policy.allowedHarnesses.includes("opencode") || (healthRoute && !healthRoute.harnesses.includes("opencode"))
        ? "Политика проекта не разрешает OpenCode для анализа инцидента; переключение среды запрещено." : undefined);
    if (error) {
      return {
        operationId, project, attempts: [], outcome: "no_harness", routingReason: error, error,
        routingReasonCode: ROUTING_CODE_INCIDENT_SCOPE_NOT_PERMITTED,
        ...routeReceipt,
      };
    }
  }
  const attempts = await log.attempts(project, operationId);
  // The owner-level automation lever. A dispatch is an automatic run, so a
  // disarmed runtime refuses it here, before any harness is touched. The
  // refusal names the reason and never changes the owner state: a retry, a
  // policy reload or a re-dispatch cannot lift the lever.
  //
  // The work of a dispatch has two project names: the project the caller
  // asked for and the project the route governs. A route may resolve a
  // directory to the root that contains it, so the key the owner blocked can
  // be either of the two names. The gate checks both of them, so a block
  // never falls silent when the route resolution of a project changes.
  const requestedWorkKey = projectWorkKey(canonicalProjectKey(input.project));
  const routedWorkKey = projectWorkKey(project);
  const disarm = await automationDisarmDecision(
    AutomationDisarmStore.forRuntime(),
    requestedWorkKey === routedWorkKey ? [requestedWorkKey] : [requestedWorkKey, routedWorkKey],
    "automation",
  );
  if (!disarm.allowed) {
    const reason = disarm.reason ?? "Автоматический запуск запрещён владельцем.";
    return {
      operationId, project, attempts, outcome: "no_harness", routingReason: reason, error: reason,
      // The class of the refusal is the same one the owner gate names, so an
      // observer reads the class and not the wording of the reason.
      routingReasonCode: AUTOMATION_DISABLED_CODE,
      // The area of the refusal, as a structured value beside the class: the
      // canonical path of the scope that refused, or the catch-all scope when
      // the whole automation is forbidden.
      ...(disarm.routingReasonDetail ? { routingReasonDetail: disarm.routingReasonDetail } : {}),
      // The work the refusal was made on, in the readable form of a work key.
      // The gate checks the requested and the routed name, so the work is not
      // always the project of the refusal: without the key an operator reads
      // a project that was not refused and cannot tell what to look at. The
      // area beside the class says what to unblock: the whole contour or one
      // scope of it.
      ...(disarm.workKey ? { routingReasonWorkKey: humanWorkKey(disarm.workKey) } : {}),
      ...routeReceipt,
    };
  }

  if (attempts.some((attempt) => attempt.outcome === "in_flight")) {
    const reserved = attempts.find((attempt) => attempt.outcome === "in_flight")!;
    return {
      operationId,
      project,
      attempts,
      outcome: "in_flight",
      routingReason: `Запуск ${harnessLabel(reserved.harness)} уже зарезервирован, результат неизвестен. Повтор не создаёт второго исполнителя.`,
      routingReasonCode: ROUTING_CODE_ADMISSION_NOT_CONFIRMED,
      selectedHarness: reserved.harness,
      ...(reserved.model ? { model: reserved.model } : {}),
      ...routeReceipt,
    };
  }
  if (attempts.some((attempt) => STOP_OUTCOMES.has(attempt.outcome as LaunchOutcome | "human_hold"))) {
    // The chain already ended: a repeat callback reports it and touches no harness.
    const last = attempts[attempts.length - 1]!;
    return projectReceipt({ operationId, project, attempts, completed: last, routeReceipt });
  }

  const attempted = attempts.map((attempt) => attempt.harness);
  if (healthAnalysis && attempted.includes("opencode")) {
    return {
      operationId, project, attempts, outcome: "no_harness",
      routingReason: "Попытка анализа инцидента уже завершилась отказом. Переключение среды и провайдера запрещено.",
      routingReasonCode: ROUTING_CODE_INCIDENT_ATTEMPT_FAILED,
      ...routeReceipt,
    };
  }
  const previous = attempts[attempts.length - 1];
  // A health request selects only the allowed OpenCode entry; it never walks
  // the ordinary fallback chain. The original policy remains unchanged.
  const resolutionPolicy = healthAnalysis && routeKey && healthRoute
    ? { ...input.policy, projectRoutes: { ...input.policy.projectRoutes, [routeKey]: { ...healthRoute, harnesses: ["opencode" as const] } } }
    : input.policy;
  const resolution = resolveProjectLaunch(resolutionPolicy, {
    project,
    ...(attempted.length > 0 ? { attempted } : {}),
    ...(previous && previous.outcome !== "human_hold" ? { outcome: previous.outcome as LaunchOutcome } : {}),
  });

  let harness: HarnessType;
  let model: string | undefined;
  let routingReason: string;
  // The class of the routing decision, carried into the result: an observer
  // reads the class, not the wording of the reason.
  let routingReasonCode: string | undefined;
  if (resolution.kind === "unconfigured") {
    const fallback = defaultTarget(input.policy, input.harness);
    if (!fallback) {
      return {
        operationId,
        project,
        attempts,
        outcome: "no_harness",
        routingReason: input.harness
          ? `Среда ${harnessLabel(input.harness)} не разрешена для автоматического запуска.`
          : "Для проекта нет маршрута, а автоматический запуск новых сессий выключен.",
        routingReasonCode: input.harness ? ROUTING_CODE_HARNESS_NOT_ALLOWED : AUTOMATION_DISABLED_CODE,
        ...routeReceipt,
      };
    }
    harness = fallback.harness;
    model = input.model ?? fallback.model;
    routingReason = `Для проекта нет маршрута: используется профиль ${harnessLabel(harness)}.`;
    routingReasonCode = ROUTING_CODE_NO_ROUTE;
  } else if (resolution.kind === "exhausted") {
    return {
      operationId,
      project,
      attempts,
      outcome: "no_harness",
      routingReason: resolution.reason === "no_harness_left"
        ? "Все среды маршрута уже tried и ни одна не подтвердила запуск."
        : resolution.reason === "model_not_permitted"
          ? `Ни одна среда маршрута не использует модель, разрешённую для проекта ${project}. Проверьте списки «Разрешённые модели» и «Запрещённые модели» в настройке проектов.`
          : routingReasonOf(attempts),
      routingReasonCode: resolution.reason === "no_harness_left"
        ? ROUTING_CODE_NO_HARNESS_LEFT
        : resolution.reason === "model_not_permitted"
          ? MODEL_NOT_PERMITTED_CODE
          : ROUTING_CODE_ADMISSION_NOT_CONFIRMED,
      ...(attempts.length > 0 ? { selectedHarness: attempts[attempts.length - 1]!.harness } : {}),
      ...routeReceipt,
    };
  } else {
    // A configured project is authoritative: the route decides harness, model
    // and workspace. A profile value is reported as overridden, never rejected.
    harness = resolution.harness;
    model = healthAnalysis ? input.model : resolution.model;
    // The analysis path runs the model of the request, and the lists of the
    // route judge the model of the route only. The model of the request is
    // judged by the same lists here, so a project that permits the model of
    // its route and forbids the model of the request refuses the launch
    // instead of running the forbidden model. The check stands before the
    // session is reserved, so a forbidden model never reaches a harness.
    if (healthAnalysis && input.model) {
      try {
        assertModelAllowedForProjectRoute(input.policy, project, input.model);
      } catch (error) {
        if (!(error instanceof ModelNotPermittedError)) throw error;
        return {
          operationId,
          project,
          attempts,
          outcome: "no_harness",
          routingReason: `Модель ${input.model} не разрешена для проекта ${project}. Проверьте списки «Разрешённые модели» и «Запрещённые модели» в настройке проектов. Переключение среды и провайдера запрещено.`,
          routingReasonCode: MODEL_NOT_PERMITTED_CODE,
          ...routeReceipt,
        };
      }
    }
    const routeProject = routeKeyOf(input.policy, input.project);
    let prefix = "";
    if (routeProject?.startsWith("/")) {
      if (cwd && normalizeWorkspace(cwd) !== normalizeWorkspace(routeProject)) {
        prefix = `Маршрут проекта задаёт рабочую папку ${routeProject}; переданная ${cwd} проигнорирована. `;
      }
      cwd = routeProject;
    } else if (!cwd) {
      prefix = `Для маршрута ${routeProject ?? project} нужна рабочая папка. `;
    }
    if (!healthAnalysis && input.harness && input.harness !== harness) {
      prefix += `Профиль предлагал ${harnessLabel(input.harness)}, но маршрут проекта выбирает ${harnessLabel(harness)}. `;
    }
    if (!healthAnalysis && input.model && input.model !== model) {
      prefix += `Модель профиля ${input.model} проигнорирована: маршрут задаёт ${model ?? "модель по умолчанию"}. `;
    }
    if (resolution.mode === "handoff" && !attempted.includes(harness)) {
      // A live session of another harness is not replaced silently. The caller
      // must use the existing context-preserving handoff for this session.
      return {
        operationId,
        project,
        attempts,
        outcome: "no_harness",
        routingReason: `Сессия ${resolution.sessionId ?? ""} работает в среде ${harnessLabel(resolution.fromHarness ?? "")}; переход на ${harnessLabel(harness)} требует явной передачи контекста.`,
        routingReasonCode: ROUTING_CODE_HARNESS_NOT_ALLOWED,
        selectedHarness: harness,
        ...(resolution.model ? { model: resolution.model } : {}),
        mode: "handoff_required",
        ...(resolution.sessionId ? { sessionId: resolution.sessionId } : {}),
        ...routeReceipt,
      };
    }
    routingReason = `${prefix}${attempts.length === 0
      ? `По маршруту проекта выбрана среда ${harnessLabel(harness)}.`
      : routingReasonOf(attempts)}`;
  }

  const inputId = attemptInputId(operationId, harness);
  // Reserve the attempt durably before the native call. A concurrent or
  // restarted caller sees the reservation instead of launching a second one.
  const reservation = await log.reserve(project, operationId, {
    harness, inputId, mode,
    ...(model ? { model } : {}),
    reason: routingReason,
  });
  if (!reservation.claimed) {
    // Another caller owns this attempt. Report its state without any native
    // call: an unclaimed second POST would be a second executor.
    const completed = reservation.record;
    if (completed.outcome === "in_flight") {
      return {
        operationId,
        project,
        attempts: [...attempts.filter((item) => item.inputId !== completed.inputId), completed],
        outcome: "in_flight",
        routingReason: `Запуск ${harnessLabel(completed.harness)} уже выполняется другим вызовом; второй запуск не создаётся.`,
        routingReasonCode: ROUTING_CODE_ADMISSION_NOT_CONFIRMED,
        selectedHarness: completed.harness,
        ...(completed.model ? { model: completed.model } : {}),
        ...routeReceipt,
      };
    }
    if (!STOP_OUTCOMES.has(completed.outcome as LaunchOutcome | "human_hold")) {
      return dispatchProjectLaunch({ ...input, operationId }, log, run);
    }
    return projectReceipt({ operationId, project, attempts, completed, routeReceipt });
  }

  const nativeResult = await run({ harness, cwd, message: input.message, ...(model ? { model } : {}), mode, inputId,
    ...(healthAnalysis ? {incidentRouting: true} : {}),
    ...(!healthAnalysis && input.policy.fallbackModels?.[harness as "opencode" | "zcode"]
      ? { fallbackModels: input.policy.fallbackModels[harness as "opencode" | "zcode"] }
      : healthAnalysis ? { fallbackModels: [] } : {}),
    configuredRoute: resolution.kind === "launch", ...(input.sourceSessions ? { sourceSessions: input.sourceSessions } : {}) });
  // Optional undefined fields disappear in JSON. Project the same durable shape
  // on the first response so a restart cannot change its receipt or model.
  const result = Object.fromEntries(Object.entries(nativeResult).filter(([, value]) => value !== undefined)) as NamedSessionResult;
  const outcome = outcomeOf(result);
  const attempt: ProjectLaunchAttempt = {
    harness,
    outcome,
    reason: outcome === "accepted"
      ? (attempts.length === 0 ? routingReason : `${routingReason} Среда ${harnessLabel(harness)} приняла запуск${result.error ? `: ${result.error}` : ""}.`)
      : healthAnalysis
        ? `OpenCode: анализ инцидента не подтвердил приём${result.error ? `: ${result.error}` : ""}. Переключение среды и провайдера запрещено.`
        : routingDetail(harness, outcome, result),
    at: reservation.record.at,
    atCompleted: new Date().toISOString(),
    inputId,
    result,
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    ...(model ? { model } : {}),
    mode,
    ...(result.created === undefined ? {} : { created: result.created }),
    ...(result.delivery ? { delivery: result.delivery } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
  await log.complete(project, operationId, inputId, attempt);
  const recorded = [...attempts, attempt];

  if (STOP_OUTCOMES.has(outcome)) {
    return projectReceipt({
      operationId, project, attempts: recorded, completed: attempt,
      ...(routingReasonCode ? { routingReasonCode } : {}),
      routeReceipt,
    });
  }
  // A definite pre-admission failure: continue down the ordered route.
  const next = resolveProjectLaunch(input.policy, { project, attempted: [...attempted, harness], outcome: outcome as LaunchOutcome });
  if (!healthAnalysis && next.kind === "launch") return dispatchProjectLaunch({ ...input, operationId }, log, run);
  return {
    ...result,
    operationId,
    project,
    attempts: recorded,
    outcome: "no_harness",
    routingReason: healthAnalysis
      ? "OpenCode не подтвердил запуск анализа инцидента. Переключение среды и провайдера запрещено."
      : `${attempt.reason} Других сред в маршруте нет.`,
    routingReasonCode: healthAnalysis
      ? ROUTING_CODE_ADMISSION_NOT_CONFIRMED
      : exhaustedRouteCode(next) ?? routingReasonCode ?? ROUTING_CODE_ADMISSION_NOT_CONFIRMED,
    ...(result.error ? { error: result.error } : {}),
    ...routeReceipt,
  };
}

/**
 * The class of an exhausted route.
 *
 * The route itself knows why it is exhausted: a route without a harness left
 * and a route whose remaining models are all forbidden are two different
 * refusals, and neither of them is an unconfirmed admission.
 */
function exhaustedRouteCode(next: ProjectLaunchResolution): string | undefined {
  if (next.kind !== "exhausted") return undefined;
  if (next.reason === "model_not_permitted") return MODEL_NOT_PERMITTED_CODE;
  if (next.reason === "no_harness_left") return ROUTING_CODE_NO_HARNESS_LEFT;
  return undefined;
}

/** Project first delivery and every replay from the same durable native receipt. */
function projectReceipt(input: {
  operationId: string;
  project: string;
  attempts: ProjectLaunchAttempt[];
  completed: ProjectLaunchAttempt;
  /** The class of the routing decision, when the dispatch made one. */
  routingReasonCode?: string;
  /** The route facts of the launch, when a route governed it. */
  routeReceipt?: ProjectLaunchRouteReceipt;
}): ProjectLaunchDispatchResult {
  const { completed } = input;
  // A confirmed launch carries no class of refusal; an unconfirmed or held one
  // is an admission that never happened.
  const routingReasonCode = input.routingReasonCode
    ?? (completed.outcome === "accepted" ? undefined : ROUTING_CODE_ADMISSION_NOT_CONFIRMED);
  return {
    // Legacy records have no complete receipt; retain their known fields.
    ...(completed.model ? { model: completed.model } : {}),
    ...(completed.sessionId ? { sessionId: completed.sessionId } : {}),
    ...(completed.delivery ? { delivery: completed.delivery } : {}),
    ...(completed.error ? { error: completed.error } : {}),
    ...completed.result,
    operationId: input.operationId,
    project: input.project,
    ...input.routeReceipt,
    attempts: [...input.attempts.filter((attempt) => attempt.inputId !== completed.inputId), completed],
    outcome: completed.outcome as LaunchOutcome | "human_hold",
    routingReason: completed.reason,
    ...(routingReasonCode ? { routingReasonCode } : {}),
    selectedHarness: completed.harness,
    mode: (completed.result?.created ?? completed.created) === false ? "resume" : "create",
  };
}

/** The route facts of one launch, as the receipt states them. */
export interface ProjectLaunchRouteReceipt {
  /** The key of the route the project is. */
  routeKey: string;
  /** The root of the route replaced the requested working folder that was named. */
  workspaceReplaced: boolean;
}

/**
 * The route facts of one launch.
 *
 * The route key names the route the project IS: the exact folder, its case
 * variant or a declared alias, found by the identity lookup of this base.
 * The flag states that the root of that route replaced the requested
 * working folder: a folder that was named and the root ignored. A launch that
 * named no folder has nothing replaced by the route; a directory inside a
 * route has no route of its own.
 *
 * The flag reads the requested folder only, never the spelling of the
 * project: an alias and the route root name one launch, so the receipt of
 * the first response and the receipt of the restart replay stay equal.
 */
function routeReceiptOf(
  policy: AutomationLaunchPolicy,
  project: string,
  cwd?: string,
): ProjectLaunchRouteReceipt | undefined {
  const routeKey = routeKeyOf(policy, project);
  if (!routeKey) return undefined;
  const root = canonicalProjectKey(routeKey);
  const requested = canonicalProjectKey(cwd ?? "");
  // The flag is true only when a working folder was actually named and the
  // root of the route ignored it. A route that supplies the folder of a launch
  // that named none replaces nothing, and the dispatch says the same: it
  // reports an ignored folder only when a folder was passed.
  return { routeKey, workspaceReplaced: root.startsWith("/") && Boolean(cwd) && requested !== root };
}

/** The durable key of a project: its configured route key, else the canonical name. */
export function attemptKeyOf(policy: AutomationLaunchPolicy, project: string): string {
  return routeKeyOf(policy, project) ?? canonicalProjectKey(project);
}

/**
 * The canonical route key of a project, when one is configured.
 *
 * The lookup is the one rule of the shared route lookup: the exact canonical
 * folder of the route, its case variant, a declared alias and finally the
 * longest route root that contains the project. A directory inside a routed
 * project therefore shares the key and the authority of that project.
 */
export function routeKeyOf(policy: AutomationLaunchPolicy, project: string): string | undefined {
  return findProjectRouteKey(policy, project);
}

function normalizeWorkspace(cwd: string): string {
  return cwd.replace(/\/+$/, "");
}

/** The default launch target of a project without a configured route. */
function defaultTarget(policy: AutomationLaunchPolicy, requested?: HarnessType): { harness: HarnessType; model?: string } | undefined {
  const allowed = policy.allowedHarnesses;
  if (requested) {
    if (allowed.length > 0 && !allowed.includes(requested)) return undefined;
    return { harness: requested, ...(policy.models[requested] ? { model: policy.models[requested] } : {}) };
  }
  const harness = allowed.includes(policy.preferredHarness) ? policy.preferredHarness : allowed[0];
  if (!harness) return undefined;
  return { harness, ...(policy.models[harness] ? { model: policy.models[harness] } : {}) };
}

function routingReasonOf(attempts: ProjectLaunchAttempt[]): string {
  return attempts[attempts.length - 1]?.reason ?? "";
}

/** A session a human stopped is never a reason to try another harness. */
function isHumanHold(error: string | undefined): boolean {
  if (!error) return false;
  return error.includes(HUMAN_STOP_MESSAGE)
    || error.includes("явно остановлен")
    || error.includes("held by a manual stop");
}

/** Build the production runner over the existing named-session seam. */
export function namedSessionRunner(adapters: Map<string, HarnessAdapter>, name: string, quotaPreflight?: MiniMaxQuotaPreflight, incidentRouter?: IncidentSessionRouter): ProjectLaunchRunner {
  return async (request) => {
    // OpenCode uses its native provider/model catalog, so an explicitly
    // configured OmniRoute candidate may follow a failure on any provider.
    // ZCode's catalog is OmniRoute-backed and stays scoped to that namespace.
    // Passing [] for OpenCode without a saved list also disables legacy
    // implicit defaults: recovery only follows an operator-configured policy.
    const configuredFallbacks = request.harness === "opencode"
      ? request.fallbackModels ?? []
      : request.harness === "zcode" && typeof request.model === "string" && /^omniroute\//iu.test(request.model)
        ? request.fallbackModels
        : undefined;
    if (request.configuredRoute && request.harness === "opencode" && request.model === MINIMAX_SUBSCRIPTION_MODEL
      && quotaPreflight && await quotaPreflight(request.model).catch(() => "unknown") === "quota_exhausted") {
      return {
        ok: false, created: false, harness: request.harness, name, cwd: request.cwd, model: request.model,
        inputId: request.inputId, delivery: "not_attempted", failureCode: "quota_exhausted", nonRetryable: true,
        error: "Лимит маршрута MiniMax исчерпан (4292056). Бизнес-задача не отправлена; используется следующая среда маршрута.",
      };
    }
    const launch = (existingSessionId?: string) => newOrResumeNamedSession(adapters, {
      ...(existingSessionId ? {existingSessionId} : {}),
      harness: request.harness,
      name,
      ...(name.startsWith('project-launch-') ? {displayTitle:projectLaunchTitle(request.message, request.cwd)} : {}),
      cwd: request.cwd,
      message: existingSessionId
        ? 'Новый связанный инцидент передан в уже работающую сессию. Продолжай общий ремонт без второго исполнителя; учитывай исходные ID и независимую проверку каждого инцидента. Сохрани прежние результаты и публикуй прогресс по каждому исходному ID.\n\n' + request.message
        : request.message,
      // OpenCode 2 can inject related telemetry into the current native turn.
      // Queueing it behind the repair would hide the new symptom until later.
      mode: existingSessionId ? "sync" : request.mode,
      ...(request.model ? { model: request.model } : {}),
      ...(configuredFallbacks ? { fallbackModels: configuredFallbacks } : {}),
      ...(request.inputId ? { inputId: request.inputId } : {}),
      ...(request.sourceSessions ? { sourceSessions: request.sourceSessions } : {}),
      requireSourceHostId: true,
    });
    return request.incidentRouting && incidentRouter ? incidentRouter.run(request, launch) : launch();
  };
}

/** Stable native operation identity per operation and harness. */
export function attemptInputId(operationId: string, harness: string): string {
  return `herder-launch:${harness}:${operationId}`;
}

/** Map a real named-session result onto a launch outcome. */
export function outcomeOf(result: NamedSessionResult): LaunchOutcome | "human_hold" {
  if (result.ok) return "accepted";
  if (result.admissionUnknown) return "admission_unknown";
  // An executor exists: the turn was admitted and then failed natively.
  if (result.admitted || result.delivery === "accepted_failed") return "accepted";
  if (result.delivery === "not_attempted" && result.failureCode === "quota_exhausted") return "quota_exhausted";
  if (isHumanHold(result.error)) return "human_hold";
  if (result.delivery === "deferred" || result.delivery === "skipped_inactive" || result.delivery === "not_found") return "unavailable";
  return "pre_admission_rejected";
}

function routingReason(attempts: ProjectLaunchAttempt[]): string {
  const last = attempts[attempts.length - 1];
  return last?.reason ?? "";
}

function routingDetail(harness: string, outcome: LaunchOutcome | "human_hold", result: NamedSessionResult): string {
  const label = harnessLabel(harness);
  const detail = result.error ? `: ${result.error}` : "";
  if (outcome === "accepted") return `${label} принял запуск${detail}. Следующая среда не используется.`;
  if (outcome === "admission_unknown") return `${label} не подтвердил приём запуска${detail}. Переключение запрещено: возможен уже работающий исполнитель.`;
  if (outcome === "human_hold") return `${label}: сессия остановлена человеком${detail}. Переключение среды запрещено.`;
  return `${label} не запустилась до подтверждения приёма${detail}. Выбираем следующую среду маршрута.`;
}

type AttemptFile = { version: 1; projects: Record<string, Record<string, ProjectLaunchAttempt[]>> };

/** Durable ordered attempt log: the authority for what a project already tried. */
export class ProjectLaunchAttemptLog {
  private operation: Promise<unknown> = Promise.resolve();
  private readonly lockTarget: string;

  constructor(private readonly path: string) {
    this.lockTarget = `${path}.lock`;
  }

  /** Attempts recorded for one project operation, in attempt order. */
  async attempts(project: string, operationId: string): Promise<ProjectLaunchAttempt[]> {
    return this.serial(async () => (await this.read()).projects[project]?.[operationId] ?? []);
  }

  /**
   * Reserve one attempt before any native call, atomically.
   *
   * The read, the exclusive insert and the write happen under one lock, so a
   * concurrent caller receives `claimed: false` and the existing record. Only
   * `claimed: true` may call the native writer: OpenCode has no native input-id
   * deduplication, so a second native POST would be a second executor.
   */
  async reserve(
    project: string,
    operationId: string,
    attempt: Omit<ProjectLaunchAttempt, "outcome" | "at"> & { reason?: string },
  ): Promise<{ claimed: boolean; record: ProjectLaunchAttempt }> {
    return this.serial(() => this.withFileLock(async () => {
      const file = await this.read();
      const operations = file.projects[project] ?? (file.projects[project] = {});
      const attempts = operations[operationId] ?? (operations[operationId] = []);
      const existing = attempts.find((item) => item.inputId === attempt.inputId);
      if (existing) return { claimed: false, record: existing };
      const reserved: ProjectLaunchAttempt = { ...attempt, outcome: "in_flight", at: new Date().toISOString() };
      attempts.push(reserved);
      await this.write(file);
      return { claimed: true, record: reserved };
    }));
  }

  /** Complete a reserved attempt with its real outcome. */
  async complete(project: string, operationId: string, inputId: string, attempt: ProjectLaunchAttempt): Promise<void> {
    return this.serial(() => this.withFileLock(async () => {
      const file = await this.read();
      const attempts = file.projects[project]?.[operationId];
      const index = attempts?.findIndex((item) => item.inputId === inputId) ?? -1;
      if (!attempts || index < 0) throw new Error("project launch attempt was not reserved");
      attempts[index] = { ...attempts[index], ...attempt };
      await this.write(file);
    }));
  }

  private async read(): Promise<AttemptFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as AttemptFile;
      if (parsed.version !== 1 || !parsed.projects || typeof parsed.projects !== "object") return { version: 1, projects: {} };
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, projects: {} };
      throw error;
    }
  }

  private async write(file: AttemptFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Bounded interprocess lock: the attempt log is the authority for every writer. */
  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const handle = await open(this.lockTarget, "a", 0o600);
    await handle.close();
    const release = await lockfile.lock(this.lockTarget, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 20, minTimeout: 20, maxTimeout: 100, factor: 1 },
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }
}
