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

/** One recorded attempt of one operation on one harness. */
export interface ProjectLaunchAttempt {
  harness: HarnessType;
  outcome: LaunchOutcome | "human_hold";
  reason: string;
  at: string;
  /** The stable native operation identity of this attempt. */
  inputId: string;
  sessionId?: string;
}

export interface ProjectLaunchDispatchResult {
  operationId: string;
  project: string;
  /** Human-readable reason the route advanced or stopped. */
  routingReason: string;
  attempts: ProjectLaunchAttempt[];
  outcome: LaunchOutcome | "human_hold" | "no_harness";
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
  cwd: string;
  message: string;
  /** Explicit harness request; otherwise the project route decides. */
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
  const project = canonicalProjectKey(input.project);
  const operationId = input.operationId?.trim() || randomUUID();
  const cwd = input.cwd;
  const mode: NamedSessionMode = input.mode ?? "sync";
  const attempts = await log.attempts(project, operationId);

  if (attempts.some((attempt) => STOP_OUTCOMES.has(attempt.outcome))) {
    // The chain already ended: a repeat callback reports it and touches no harness.
    const last = attempts[attempts.length - 1]!;
    return {
      operationId,
      project,
      attempts,
      outcome: last.outcome,
      routingReason: last.reason,
      selectedHarness: last.harness,
      ...(last.sessionId ? { sessionId: last.sessionId } : {}),
    };
  }

  const attempted = attempts.map((attempt) => attempt.harness);
  const previous = attempts[attempts.length - 1];
  const resolution = resolveProjectLaunch(input.policy, {
    project,
    ...(attempted.length > 0 ? { attempted } : {}),
    ...(previous && previous.outcome !== "human_hold" ? { outcome: previous.outcome } : {}),
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
          ? `Среда ${input.harness} не разрешена для автоматического запуска.`
          : "Для проекта нет маршрута, а автоматический запуск новых сессий выключен.",
      };
    }
    harness = fallback.harness;
    model = input.model ?? fallback.model;
    launchMode = "create";
    routingReason = `Для проекта нет маршрута: используется ${harnessLabel(harness)}.`;
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
  } else if (input.harness && input.harness !== resolution.harness && !attempted.includes(input.harness)) {
    // An explicit request still has to fit the configured route of this project.
    return {
      operationId,
      project,
      attempts,
      outcome: "no_harness",
      routingReason: `Запрошенная среда ${harnessLabel(input.harness)} не совпадает с маршрутом проекта; по маршруту выбрана ${harnessLabel(resolution.harness)}.`,
      selectedHarness: resolution.harness,
      ...(resolution.model ? { model: resolution.model } : {}),
    };
  } else {
    harness = resolution.harness;
    model = input.model ?? resolution.model;
    launchMode = resolution.mode;
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
    routingReason = attempts.length === 0
      ? `По маршруту проекта выбрана среда ${harnessLabel(harness)}.`
      : routingReasonOf(attempts);
  }

  const inputId = attemptInputId(operationId, harness);
  const result = await run({ harness, cwd, message: input.message, ...(model ? { model } : {}), mode, inputId });
  const outcome = outcomeOf(result);
  const attempt: ProjectLaunchAttempt = {
    harness,
    outcome,
    reason: outcome === "accepted"
      ? (attempts.length === 0 ? routingReason : `${routingReason} Среда ${harnessLabel(harness)} приняла запуск${result.error ? `: ${result.error}` : ""}.`)
      : routingDetail(harness, outcome, result),
    at: new Date().toISOString(),
    inputId,
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
  };
  await log.append(project, operationId, attempt);
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

  /** Append one durable attempt. Repeating the same attempt is a no-op. */
  async append(project: string, operationId: string, attempt: ProjectLaunchAttempt): Promise<void> {
    return this.serial(() => this.withFileLock(async () => {
      const file = await this.read();
      const operations = file.projects[project] ?? (file.projects[project] = {});
      const attempts = operations[operationId] ?? (operations[operationId] = []);
      if (!attempts.some((item) => item.inputId === attempt.inputId && item.outcome === attempt.outcome && item.at === attempt.at)) {
        attempts.push(attempt);
      }
      await this.write(file);
    }));
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

}
