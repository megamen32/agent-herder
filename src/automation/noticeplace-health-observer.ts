import { buildSessionProgress, type SessionProgressSummary } from "../health-progress.js";
import { createIncidentUpdateSink, type IncidentProgressUpdate, type IncidentUpdateSink, type NoticeIncidentBinding } from "../autopilot/notice-incident.js";
import { describeHealthStep } from "./noticeplace-health-text.js";
import { AUTOMATION_DISABLED_CODE, INCIDENT_NOT_OPEN_CODE, NO_SELECTED_HEALTH_PLAN_CODE, healthOwnerGate, healthWorkKeys, type HealthReasonRefusal } from "./health-reason-codes.js";
import type { SessionDetails } from "../types/index.js";

/** One native executor session bound to one original Notice Place incident. */
export interface NoticeplaceHealthTarget {
  harness: string;
  sessionId: string;
  cwd: string;
  binding: NoticeIncidentBinding;
}

export interface NoticeplaceHealthObserverOptions {
  /** Read the live session state; the same port the center polls. */
  readDetails: (harness: string, sessionId: string) => Promise<SessionDetails>;
  /**
   * The native active turn of the executor, when the harness exposes it.
   *
   * A session status alone cannot prove that an executor is finished: the
   * status of a busy session is reported as "idle" while the model keeps
   * working. An active turn is the only positive proof that work is running.
   */
  readActiveTurn?: (harness: string, sessionId: string) => Promise<string | null>;
  /** Override the sink in tests; production posts into the original incident. */
  publish?: (update: IncidentProgressUpdate) => Promise<void>;
  /** Operational receipt after a successful publication. */
  onPublished?: (update: IncidentProgressUpdate) => void;
  /** How often the executor is observed. */
  intervalMs?: number;
  /** Hard bound: an executor that never ends must not keep publishing forever. */
  maxLifetimeMs?: number;
  /** Maximum number of simultaneously observed executors. */
  maxTargets?: number;
  /** Maximum number of simultaneous native session reads. */
  maxConcurrentReads?: number;
  /** An idle executor without an active turn is finished after this silence. */
  idleFinishedAfterMs?: number;
  /** A refused publication is not retried more often than this. */
  retryIntervalMs?: number;
  /** Verify the incident binding at the center before anything is published. */
  validateTarget?: (target: NoticeplaceHealthTarget) => Promise<string | undefined>;
  /** The machine-readable class of a refusal, for a reader that counts them. */
  onRefused?: (refusal: HealthReasonRefusal) => void;
  onError?: (message: string) => void;
}

/**
 * Statuses that mean the executor is gone for good.
 *
 * Herder's own status vocabulary is "running" (working), "idle" (waiting, no
 * prompt pending), "needs_input" (blocked), "stopped" (finished or aborted)
 * and "error" (crashed). Only the last two end the observation: "idle" is
 * waiting, and a busy executor is reported as idle while it keeps working.
 */
const TERMINAL_STATUS = new Set(["stopped", "error"]);
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_MAX_LIFETIME_MS = 45 * 60_000;
const DEFAULT_MAX_TARGETS = 8;
const DEFAULT_MAX_CONCURRENT_READS = 4;
/** An idle executor with no active turn and no progress for this long is done. */
const DEFAULT_IDLE_FINISHED_AFTER_MS = 3 * 60_000;
/** A refused publication is retried at most once per this window. */
const DEFAULT_RETRY_INTERVAL_MS = 60_000;

interface TargetState {
  startedAt: number;
  /** Fingerprint of the last successfully published progress. */
  lastFingerprint: string;
  /** Fingerprint of the last observed progress, published or not. */
  lastObservedFingerprint: string;
  /** Fingerprint of the last publication attempt, successful or not. */
  lastAttemptFingerprint: string;
  /** When the last publication attempt was made. */
  lastAttemptAt: number;
  /** When the observed progress last changed. */
  lastProgressAt: number;
  timer?: NodeJS.Timeout;
  stopped: boolean;
}

/**
 * Detached observer for one Notice Place health executor.
 *
 * The center's own observer is bounded by a short budget on purpose: it must
 * return so the incident card is not held back by a long executor turn. That
 * budget is the observer's deadline, not the executor's.
 *
 * This loop keeps watching the same native session after the center stopped
 * polling and publishes every new fingerprint into the original incident, so
 * the card stays truthful until the executor really ends. It never blocks the
 * caller that armed the session and it never resolves an incident: closing
 * health stays the independent source check's job.
 */
export class NoticeplaceHealthObserver {
  private readonly targets = new Map<string, TargetState>();
  private sink?: IncidentUpdateSink;
  private stopped = false;
  private activeReads = 0;

  constructor(private readonly options: NoticeplaceHealthObserverOptions) {}

  /** How many executors are observed right now. */
  get size(): number {
    return this.targets.size;
  }

  /**
   * Begin watching one executor session.
   *
   * Repeated calls for it are ignored. A target without a selected health plan
   * is refused: the center only accepts progress for the selected plan, so a
   * guessed plan would only pollute the incident with refused attempts. The
   * incident binding is confirmed at the center before the first publication.
   */
  async start(target: NoticeplaceHealthTarget): Promise<"started" | "duplicate" | "refused"> {
    if (this.stopped) return "refused";
    const key = targetKey(target);
    if (this.targets.has(key)) return "duplicate";
    // The owner-level lever comes before every automatic act of the observer:
    // while automation is forbidden, no executor state is created and nothing
    // is published into the incident. The card stays open for the operator.
    if (await this.refuseWhenAutomationIsDisabled(target)) return "refused";
    if (!target.binding.planId) {
      this.refuse(target, `Notice health observer refused ${target.sessionId}: the incident ${target.binding.incidentId} has no selected health plan`, NO_SELECTED_HEALTH_PLAN_CODE);
      return "refused";
    }
    const maxTargets = this.options.maxTargets ?? DEFAULT_MAX_TARGETS;
    if (this.targets.size >= maxTargets) {
      this.options.onError?.(`Notice health observer skipped ${target.sessionId}: the ${maxTargets} observation slots are busy`);
      return "refused";
    }
    const now = Date.now();
    const state: TargetState = {
      startedAt: now,
      lastFingerprint: "",
      lastObservedFingerprint: "",
      lastAttemptFingerprint: "",
      lastAttemptAt: 0,
      lastProgressAt: now,
      stopped: false,
    };
    // The slot is reserved before the read-only check, so a second arming of
    // the same session cannot start a second observation.
    this.targets.set(key, state);
    const refusal = await this.options.validateTarget?.(target);
    if (this.stopped || state.stopped) {
      this.targets.delete(key);
      return "refused";
    }
    if (refusal) {
      this.targets.delete(key);
      this.refuse(target, `Notice health observer refused ${target.sessionId} incident ${target.binding.incidentId}: ${refusal}`, bindingRefusalCode(refusal));
      return "refused";
    }
    void this.tick(target, state);
    return "started";
  }

  /**
   * The owner-level lever decides before the observer does anything.
   *
   * A forbidden run creates no executor state and publishes nothing: the
   * incident card stays open and waits for the operator. The refusal names the
   * machine-readable class of the cause, so a reader never has to parse the
   * wording of the reason.
   */
  private async refuseWhenAutomationIsDisabled(target: NoticeplaceHealthTarget): Promise<boolean> {
    const decision = await healthOwnerGate({
      workKeys: healthWorkKeys({
        harness: target.harness,
        sessionId: target.sessionId,
        cwd: target.cwd,
        project: target.binding.project,
      }),
    });
    if (decision.allowed) return false;
    this.refuse(target, `Notice health observer refused ${target.sessionId} incident ${target.binding.incidentId}: ${decision.reason ?? "the owner forbids automation"}`, AUTOMATION_DISABLED_CODE);
    return true;
  }

  /**
   * Record one refusal with its machine-readable class.
   *
   * The wording an operator reads stays exactly as it was; the class is added
   * next to it, so a reader counts the refusals without parsing the text. A
   * refusal without a known class stays a plain refusal.
   */
  private refuse(target: NoticeplaceHealthTarget, message: string, code?: string): void {
    this.options.onError?.(code ? `${message} [${code}]` : message);
    if (!code) return;
    this.options.onRefused?.({
      code,
      reason: message,
      sessionId: target.sessionId,
      incidentId: target.binding.incidentId,
    });
  }

  /** Stop every observation; used on shutdown. */
  stop(): void {
    this.stopped = true;
    for (const state of this.targets.values()) {
      state.stopped = true;
      if (state.timer) clearTimeout(state.timer);
    }
    this.targets.clear();
  }

  /** Stop the observation of one executor and publish nothing more for it. */
  stopTarget(target: Pick<NoticeplaceHealthTarget, "harness" | "sessionId">): boolean {
    const key = `${target.harness}:${target.sessionId}`;
    const state = this.targets.get(key);
    if (!state) return false;
    state.stopped = true;
    if (state.timer) clearTimeout(state.timer);
    this.targets.delete(key);
    return true;
  }

  private async tick(target: NoticeplaceHealthTarget, state: TargetState): Promise<void> {
    if (this.stopped || state.stopped) return;
    const key = targetKey(target);
    try {
      const details = await this.read(target);
      if (this.stopped || state.stopped) return;
      if (details) {
        const summary = buildSessionProgress(details, 5);
        const status = summary.session.status;
        // The observed progress is tracked independently of its publication, so
        // a refused progress does not make a working executor look idle.
        if (summary.fingerprint !== state.lastObservedFingerprint) {
          state.lastObservedFingerprint = summary.fingerprint;
          state.lastProgressAt = Date.now();
        }
        // The terminal stream is decided first and fails on its own: a refused
        // progress must never keep a finished executor from being reported.
        if (await this.detectTerminal(target, state, summary)) {
          await this.publishFinal(target, status);
          this.targets.delete(key);
          return;
        }
        await this.publishProgress(target, state, summary, status, details.history.complete === true);
        if (this.stopped || state.stopped) return;
      }
    } catch (error) {
      this.reportError(target, error);
    }
    if (Date.now() - state.startedAt >= (this.options.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS)) {
      await this.publishLifetimeLimit(target, state);
      this.targets.delete(key);
      return;
    }
    this.scheduleNextTick(target, state);
  }

  /** One native read, bounded by the read slots; a busy pool skips the tick. */
  private async read(target: NoticeplaceHealthTarget): Promise<SessionDetails | undefined> {
    const maxReads = this.options.maxConcurrentReads ?? DEFAULT_MAX_CONCURRENT_READS;
    if (this.activeReads >= maxReads) {
      this.options.onError?.(`Notice health observer skipped a tick for ${target.sessionId}: ${maxReads} native reads are already running`);
      return undefined;
    }
    this.activeReads += 1;
    try {
      return await this.options.readDetails(target.harness, target.sessionId);
    } finally {
      this.activeReads -= 1;
    }
  }

  /**
   * Publish one progress update.
   *
   * The fingerprint is remembered only after the center accepted the update,
   * so a refused publication is retried with the same content instead of
   * being lost for the rest of the executor's life.
   */
  private async publishProgress(target: NoticeplaceHealthTarget, state: TargetState, summary: SessionProgressSummary, status: string, historyComplete: boolean): Promise<void> {
    if (summary.fingerprint === state.lastFingerprint) return;
    const now = Date.now();
    const retryIntervalMs = this.options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
    if (state.lastAttemptFingerprint === summary.fingerprint && now - state.lastAttemptAt < retryIntervalMs) {
      this.options.onError?.(`Notice health observer defers the retry for ${target.sessionId} incident ${target.binding.incidentId}: the center refused this progress ${Math.round((now - state.lastAttemptAt) / 1000)}s ago`);
      return;
    }
    state.lastAttemptFingerprint = summary.fingerprint;
    state.lastAttemptAt = now;
    try {
      await this.publish(target, summary, status, historyComplete);
    } catch (error) {
      this.reportError(target, error);
      return;
    }
    state.lastFingerprint = summary.fingerprint;
    state.lastProgressAt = Date.now();
  }

  /**
   * Whether the executor really finished.
   *
   * An explicit terminal status ends the observation. An idle session ends it
   * only when no native turn is active and neither the session nor the
   * observed progress moved for the idle window: a busy executor is reported
   * as idle, so the status alone would end the observation of a live executor.
   */
  private async detectTerminal(target: NoticeplaceHealthTarget, state: TargetState, summary: SessionProgressSummary): Promise<boolean> {
    const status = summary.session.status;
    if (TERMINAL_STATUS.has(status)) return true;
    if (status !== "idle") return false;
    const readActiveTurn = this.options.readActiveTurn;
    if (!readActiveTurn) return false;
    let activeTurn: string | null;
    try {
      activeTurn = await readActiveTurn(target.harness, target.sessionId);
    } catch {
      // An unreadable native status proves nothing; keep observing.
      return false;
    }
    if (activeTurn) return false;
    const idleFinishedAfterMs = this.options.idleFinishedAfterMs ?? DEFAULT_IDLE_FINISHED_AFTER_MS;
    const lastActivity = Date.parse(summary.session.lastActivity);
    const since = Math.max(state.lastProgressAt, Number.isFinite(lastActivity) ? lastActivity : 0);
    return Date.now() - since >= idleFinishedAfterMs;
  }

  private async publish(target: NoticeplaceHealthTarget, summary: SessionProgressSummary, status: string, historyComplete: boolean): Promise<void> {
    const step = describeStep(summary, status, historyComplete);
    if (!step) return;
    const planId = target.binding.planId;
    if (!planId) {
      this.refuseWithoutPlan(target);
      return;
    }
    await this.send({
      binding: target.binding,
      planId,
      idempotencyKey: `noticeplace-health:${target.binding.incidentId}:${summary.fingerprint}`,
      step,
      evidenceRefs: summary.evidence.map((item) => item.kind === "tool" ? `tool:${item.name ?? item.id}` : `message:${item.id}`),
      fingerprint: summary.fingerprint,
    });
  }

  private async publishFinal(target: NoticeplaceHealthTarget, status: string): Promise<void> {
    const planId = target.binding.planId;
    if (!planId) {
      this.refuseWithoutPlan(target);
      return;
    }
    try {
      await this.send({
        binding: target.binding,
        planId,
        // Two executors of one incident can finish with the same status; the
        // session identity keeps the second final from being swallowed as an
        // idempotent repeat of the first.
        idempotencyKey: `noticeplace-health:${target.binding.incidentId}:final:${target.harness}:${target.sessionId}:${status}`,
        step: `Исполнитель закончил работу (статус ${status}); ждём независимую проверку источника.`,
        evidenceRefs: [],
        fingerprint: `final:${target.harness}:${target.sessionId}:${status}`,
      });
    } catch (error) {
      this.reportError(target, error);
    }
  }

  /** The observation budget is spent: say so instead of leaving a live-looking card. */
  private async publishLifetimeLimit(target: NoticeplaceHealthTarget, state: TargetState): Promise<void> {
    const elapsed = Math.round((Date.now() - state.startedAt) / 1000);
    this.options.onError?.(`Notice health observer stopped ${target.sessionId} incident ${target.binding.incidentId}: the observation budget of ${elapsed}s is spent`);
    const planId = target.binding.planId;
    if (!planId) {
      this.refuseWithoutPlan(target);
      return;
    }
    try {
      await this.send({
        binding: target.binding,
        planId,
        idempotencyKey: `noticeplace-health:${target.binding.incidentId}:final:${target.harness}:${target.sessionId}:limit`,
        step: "Наблюдение остановлено по лимиту времени; ждём независимую проверку источника.",
        evidenceRefs: [],
        fingerprint: `limit:${target.harness}:${target.sessionId}`,
      });
    } catch (error) {
      this.reportError(target, error);
    }
  }

  /**
   * The progress of an incident belongs to its selected plan.
   *
   * The center accepts the progress of one selected plan only, so a target
   * without a known plan publishes nothing at all: an explicit refusal is
   * better than a progress under a guessed plan.
   */
  private refuseWithoutPlan(target: NoticeplaceHealthTarget): void {
    this.refuse(target, `Notice health observer published nothing for ${target.sessionId} incident ${target.binding.incidentId}: the incident has no selected health plan`, NO_SELECTED_HEALTH_PLAN_CODE);
  }

  private async send(update: IncidentProgressUpdate): Promise<void> {
    if (this.options.publish) {
      await this.options.publish(update);
      this.options.onPublished?.(update);
      return;
    }
    this.sink ??= createIncidentUpdateSink();
    await this.sink.send(update);
    this.options.onPublished?.(update);
  }

  private scheduleNextTick(target: NoticeplaceHealthTarget, state: TargetState): void {
    if (this.stopped || state.stopped) return;
    if (this.targets.get(targetKey(target)) !== state) return;
    const timer = setTimeout(() => { void this.tick(target, state); }, this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
    timer.unref?.();
    state.timer = timer;
  }

  private reportError(target: NoticeplaceHealthTarget, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    this.options.onError?.(`Notice health observer failed for ${target.sessionId} incident ${target.binding.incidentId} plan ${target.binding.planId ?? "unknown"}: ${reason}`);
  }
}

function targetKey(target: NoticeplaceHealthTarget): string {
  return `${target.harness}:${target.sessionId}`;
}

/**
 * The class of a refused incident binding.
 *
 * The center refuses a binding with a free wording, and the known refusals of
 * the health contour are told apart by that wording: an incident that is not
 * open any more is not the same refusal as a binding that belongs to another
 * project. Only a known wording gets a class; an unknown refusal stays a
 * plain refusal.
 */
function bindingRefusalCode(refusal: string): string | undefined {
  if (/is not open/i.test(refusal)) return INCIDENT_NOT_OPEN_CODE;
  return undefined;
}

/** A short real step in Russian; never a verdict and never an invented fact. */
function describeStep(summary: SessionProgressSummary, status: string, historyComplete: boolean): string | undefined {
  const tools = summary.evidence.filter((item) => item.kind === "tool").map((item) => item.name ?? "");
  return describeHealthStep({
    status,
    ...(summary.session.messageCount === undefined ? {} : { messageCount: summary.session.messageCount }),
    toolNames: tools,
    lastMessageRole: summary.session.lastMessage ? "assistant" : undefined,
    ...(summary.session.lastMessage ? { lastMessageText: summary.session.lastMessage } : {}),
    historySource: summary.activity.historySource,
    historyComplete,
  });
}
