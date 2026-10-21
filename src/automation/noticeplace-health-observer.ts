import { buildSessionProgress, type SessionProgressSummary } from "../health-progress.js";
import { createIncidentUpdateSink, type IncidentProgressUpdate, type IncidentUpdateSink, type NoticeIncidentBinding } from "../autopilot/notice-incident.js";
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
  /** Override the sink in tests; production posts into the original incident. */
  publish?: (update: IncidentProgressUpdate) => Promise<void>;
  /** Operational receipt after a successful publication. */
  onPublished?: (update: IncidentProgressUpdate) => void;
  /** How often the executor is observed. */
  intervalMs?: number;
  /** Hard bound: an executor that never ends must not keep publishing forever. */
  maxLifetimeMs?: number;
  onError?: (message: string) => void;
}

/** The executor session no longer progresses in these states. */
const TERMINAL_STATUS = new Set(["idle", "completed", "done", "failed", "error", "cancelled"]);
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_MAX_LIFETIME_MS = 45 * 60_000;

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
  private readonly targets = new Map<string, { startedAt: number; lastFingerprint: string; timer?: NodeJS.Timeout }>();
  private sink?: IncidentUpdateSink;

  constructor(private readonly options: NoticeplaceHealthObserverOptions) {}

  /** Begin watching one executor session. Repeated calls for it are ignored. */
  start(target: NoticeplaceHealthTarget): void {
    const key = targetKey(target);
    if (this.targets.has(key)) return;
    const state = { startedAt: Date.now(), lastFingerprint: "" };
    this.targets.set(key, state);
    void this.tick(target, state);
  }

  /** Stop every observation; used on shutdown. */
  stop(): void {
    for (const state of this.targets.values()) if (state.timer) clearTimeout(state.timer);
    this.targets.clear();
  }

  private async tick(target: NoticeplaceHealthTarget, state: { startedAt: number; lastFingerprint: string; timer?: NodeJS.Timeout }): Promise<void> {
    const key = targetKey(target);
    try {
      const details = await this.options.readDetails(target.harness, target.sessionId);
      const summary = buildSessionProgress(details, 5);
      const status = summary.session.status;
      if (summary.fingerprint !== state.lastFingerprint) {
        state.lastFingerprint = summary.fingerprint;
        await this.publish(target, summary, status);
      }
      if (TERMINAL_STATUS.has(status)) {
        await this.publishFinal(target, status);
        this.targets.delete(key);
        return;
      }
    } catch (error) {
      this.options.onError?.(`Notice health observer failed for ${target.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (Date.now() - state.startedAt >= (this.options.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS)) {
      this.targets.delete(key);
      return;
    }
    state.timer = setTimeout(() => { void this.tick(target, state); }, this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
    state.timer.unref?.();
  }

  private async publish(target: NoticeplaceHealthTarget, summary: SessionProgressSummary, status: string): Promise<void> {
    const step = describeStep(summary, status);
    if (!step) return;
    await this.send({
      binding: target.binding,
      idempotencyKey: `noticeplace-health:${target.binding.incidentId}:${summary.fingerprint}`,
      step,
      evidenceRefs: summary.evidence.map((item) => item.kind === "tool" ? `tool:${item.name ?? item.id}` : `message:${item.id}`),
      fingerprint: summary.fingerprint,
    });
  }

  private async publishFinal(target: NoticeplaceHealthTarget, status: string): Promise<void> {
    await this.send({
      binding: target.binding,
      idempotencyKey: `noticeplace-health:${target.binding.incidentId}:final:${status}`,
      step: `Исполнитель закончил работу (статус ${status}); ждём независимую проверку источника.`,
      evidenceRefs: [],
      fingerprint: `final:${status}`,
    });
  }

  private async send(update: IncidentProgressUpdate): Promise<void> {
    if (this.options.publish) {
      await this.options.publish(update);
      return;
    }
    this.sink ??= createIncidentUpdateSink();
    await this.sink.send(update);
    this.options.onPublished?.(update);
  }
}

function targetKey(target: NoticeplaceHealthTarget): string {
  return `${target.harness}:${target.sessionId}`;
}

/** A short real step in Russian; never a verdict and never an invented fact. */
function describeStep(summary: SessionProgressSummary, status: string): string | undefined {
  const last = summary.session.lastMessage?.trim();
  if (!last) {
    return status === "running" ? "Исполнитель запущен, первый шаг ещё не отчитан." : undefined;
  }
  const trimmed = last.length > 220 ? `${last.slice(0, 217)}...` : last;
  return `Исполнитель работает: ${trimmed}`;
}
