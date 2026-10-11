import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";

import {
  canonicalProjectKey,
  resolveProjectLaunch,
  type AutomationLaunchPolicy,
  type LaunchOutcome,
  type ProjectLaunchResolution,
} from "../automation-launch-policy.js";
import type { HarnessAdapter, HarnessType } from "../types/common.js";
import { newOrResumeNamedSession, type NamedSessionMode, type NamedSessionResult } from "../named-session.js";
import { HUMAN_STOP_MESSAGE } from "../human-stop-actions.js";

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
  delivery?: NamedSessionResult["delivery"];
  atCompleted?: string;
}

export interface ProjectLaunchDispatchResult {
  operationId: string;
  project: string;
  /** Human-readable reason the route advanced or stopped. */
  routingReason: string;
  attempts: ProjectLaunchAttempt[];
  outcome: LaunchOutcome | "human_hold" | "in_flight" | "no_harness";
  selectedHarness?: HarnessType;
  model?: string;
  mode?: "create" | "resume" | "handoff_required";
  sessionId?: string;
  delivery?: NamedSessionResult["delivery"];
  error?: string;
}

/** The actual native call. It is the only place that may create an executor. */
export type ProjectLaunchRunner = (request: {
  harness: HarnessType;
  cwd: string;
  message: string;
  model?: string;
  mode: NamedSessionMode;
  /** Stable per operation and harness, so a repeat attempt is deduplicated natively. */
  inputId: string;
}) => Promise<NamedSessionResult>;

/** The production dispatch port injected into the web seam. */
export interface ProjectLaunchDispatcher {
  (input: {
    project: string;
    cwd: string;
    message: string;
    harness?: HarnessType;
    model?: string;
    mode?: NamedSessionMode;
    operationId?: string;
    name?: string;
  }): Promise<ProjectLaunchDispatchResult>;
}

export interface ProjectLaunchDispatchInput {
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
}

/** Human-readable harness names for the routing reason a person reads. */
const HARNESS_LABELS: Partial<Record<HarnessType, string>> = {
  opencode: "OpenCode", zcode: "ZCode", codex: "Codex", claude: "Claude Code",
  qoder: "Qoder", hermes: "Hermes", "fast-agent": "Fast Agent", chatgpt: "ChatGPT",
};

function harnessLabel(harness: string): string {
  return HARNESS_LABELS[harness as HarnessType] ?? harness;
}

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
  const attempts = await log.attempts(project, operationId);

  if (attempts.some((attempt) => attempt.outcome === "in_flight")) {
    const reserved = attempts.find((attempt) => attempt.outcome === "in_flight")!;
    return {
      operationId,
      project,
      attempts,
      outcome: "in_flight",
      routingReason: `Запуск ${harnessLabel(reserved.harness)} уже зарезервирован, результат неизвестен. Повтор не создаёт второго исполнителя.`,
      selectedHarness: reserved.harness,
      ...(reserved.model ? { model: reserved.model } : {}),
    };
  }
  if (attempts.some((attempt) => STOP_OUTCOMES.has(attempt.outcome as LaunchOutcome | "human_hold"))) {
    // The chain already ended: a repeat callback reports it and touches no harness.
    const last = attempts[attempts.length - 1]!;
    return {
      operationId,
      project,
      attempts,
      outcome: last.outcome,
      routingReason: last.reason,
      selectedHarness: last.harness,
      // A replay answers with the full receipt of the attempt that already ran.
      ...(last.model ? { model: last.model } : {}),
      ...(last.delivery ? { delivery: last.delivery } : {}),
      ...(last.sessionId ? { sessionId: last.sessionId } : {}),
      mode: attempts.some((attempt) => attempt.outcome !== "in_flight") ? "create" : undefined,
    };
  }

  const attempted = attempts.map((attempt) => attempt.harness);
  const previous = attempts[attempts.length - 1];
  const resolution = resolveProjectLaunch(input.policy, {
    project,
    ...(attempted.length > 0 ? { attempted } : {}),
    ...(previous && previous.outcome !== "human_hold" ? { outcome: previous.outcome as LaunchOutcome } : {}),
  });

  let harness: HarnessType;
  let model: string | undefined;
  let launchMode: "create" | "resume" | "handoff";
  let routingReason: string;
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
      };
    }
    harness = fallback.harness;
    model = input.model ?? fallback.model;
    launchMode = "create";
    routingReason = `Для проекта нет маршрута: используется профиль ${harnessLabel(harness)}.`;
  } else if (resolution.kind === "exhausted") {
    return {
      operationId,
      project,
      attempts,
      outcome: "no_harness",
      routingReason: resolution.reason === "no_harness_left"
        ? "Все среды маршрута уже tried и ни одна не подтвердила запуск."
        : routingReasonOf(attempts),
      ...(attempts.length > 0 ? { selectedHarness: attempts[attempts.length - 1]!.harness } : {}),
    };
  } else {
    // A configured project is authoritative: the route decides harness, model
    // and workspace. A profile value is reported as overridden, never rejected.
    harness = resolution.harness;
    model = resolution.model;
    launchMode = resolution.mode;
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
    if (input.harness && input.harness !== harness) {
      prefix += `Профиль предлагал ${harnessLabel(input.harness)}, но маршрут проекта выбирает ${harnessLabel(harness)}. `;
    }
    if (input.model && input.model !== model) {
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
        selectedHarness: harness,
        ...(resolution.model ? { model: resolution.model } : {}),
        mode: "handoff_required",
        ...(resolution.sessionId ? { sessionId: resolution.sessionId } : {}),
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
  if (reservation.outcome !== "in_flight") {
    const completed = reservation;
    if (!STOP_OUTCOMES.has(completed.outcome as LaunchOutcome | "human_hold")) {
      return dispatchProjectLaunch({ ...input, operationId }, log, run);
    }
    return {
      operationId,
      project,
      attempts: [...attempts.filter((attempt) => attempt.inputId !== completed.inputId), completed],
      outcome: completed.outcome as LaunchOutcome | "human_hold",
      routingReason: completed.reason,
      selectedHarness: completed.harness,
      ...(completed.model ? { model: completed.model } : {}),
      mode: launchMode === "handoff" ? "handoff_required" : launchMode,
      ...(completed.sessionId ? { sessionId: completed.sessionId } : {}),
      ...(completed.delivery ? { delivery: completed.delivery } : {}),
    };
  }
  if (attempts.some((attempt) => attempt.inputId === inputId && attempt.outcome === "in_flight")) {
    return {
      operationId,
      project,
      attempts,
      outcome: "in_flight",
      routingReason: `Запуск ${harnessLabel(harness)} уже зарезервирован, результат неизвестен. Повтор не создаёт второго исполнителя.`,
      selectedHarness: harness,
      ...(model ? { model } : {}),
    };
  }
  const result = await run({ harness, cwd, message: input.message, ...(model ? { model } : {}), mode, inputId });
  const outcome = outcomeOf(result);
  const attempt: ProjectLaunchAttempt = {
    harness,
    outcome,
    reason: outcome === "accepted"
      ? (attempts.length === 0 ? routingReason : `${routingReason} Среда ${harnessLabel(harness)} приняла запуск${result.error ? `: ${result.error}` : ""}.`)
      : routingDetail(harness, outcome, result),
    at: reservation.at,
    atCompleted: new Date().toISOString(),
    inputId,
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    ...(model ? { model } : {}),
    mode,
    ...(result.delivery ? { delivery: result.delivery } : {}),
  };
  await log.complete(project, operationId, inputId, attempt);
  const recorded = [...attempts, attempt];

  if (STOP_OUTCOMES.has(outcome)) {
    return {
      operationId,
      project,
      attempts: recorded,
      outcome,
      routingReason: attempt.reason,
      selectedHarness: harness,
      ...(model ? { model } : {}),
      mode: launchMode === "handoff" ? "handoff_required" : launchMode,
      ...(result.delivery ? { delivery: result.delivery } : {}),
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
  }
  // A definite pre-admission failure: continue down the ordered route.
  const next = resolveProjectLaunch(input.policy, { project, attempted: [...attempted, harness], outcome: outcome as LaunchOutcome });
  if (next.kind === "launch") return dispatchProjectLaunch({ ...input, operationId }, log, run);
  return {
    operationId,
    project,
    attempts: recorded,
    outcome: "no_harness",
    routingReason: `${attempt.reason} Других сред в маршруте нет.`,
    ...(result.error ? { error: result.error } : {}),
  };
}

/** The durable key of a project: its configured route key, else the canonical name. */
export function attemptKeyOf(policy: AutomationLaunchPolicy, project: string): string {
  return routeKeyOf(policy, project) ?? canonicalProjectKey(project);
}

/** The canonical route key of a project, when one is configured. */
export function routeKeyOf(policy: AutomationLaunchPolicy, project: string): string | undefined {
  const routes = policy.projectRoutes;
  if (!routes) return undefined;
  const key = canonicalProjectKey(project);
  const folded = key.toLocaleLowerCase("en-US");
  for (const [candidate, route] of Object.entries(routes)) {
    if (candidate.toLocaleLowerCase("en-US") === folded) return candidate;
    if (route.aliases?.some((alias) => alias.trim().toLocaleLowerCase("en-US") === folded)) return candidate;
  }
  return undefined;
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
export function namedSessionRunner(adapters: Map<string, HarnessAdapter>, name: string): ProjectLaunchRunner {
  return async (request) => await newOrResumeNamedSession(adapters, {
    harness: request.harness,
    name,
    cwd: request.cwd,
    message: request.message,
    mode: request.mode,
    ...(request.model ? { model: request.model } : {}),
    ...(request.inputId ? { inputId: request.inputId } : {}),
  });
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
   * Reserve one attempt before any native call.
   *
   * The reservation is exclusive per input id, so a concurrent caller or a
   * restarted service sees the existing attempt instead of launching a second
   * executor.
   */
  async reserve(
    project: string,
    operationId: string,
    attempt: Omit<ProjectLaunchAttempt, "outcome" | "at"> & { reason?: string },
  ): Promise<ProjectLaunchAttempt> {
    return this.serial(() => this.withFileLock(async () => {
      const file = await this.read();
      const operations = file.projects[project] ?? (file.projects[project] = {});
      const attempts = operations[operationId] ?? (operations[operationId] = []);
      const existing = attempts.find((item) => item.inputId === attempt.inputId);
      if (existing) return existing;
      const reserved: ProjectLaunchAttempt = { ...attempt, outcome: "in_flight", at: new Date().toISOString() };
      attempts.push(reserved);
      await this.write(file);
      return reserved;
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
