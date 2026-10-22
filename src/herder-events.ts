import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type HerderEventKind = "coordination" | "human-request" | "sessions" | "presence" | "jobs" | "adapters" | "health";

export interface HerderEvent {
  kind: HerderEventKind;
  uri: string;
  action: "created" | "updated" | "deleted" | "changed";
  at: string;
  id?: string;
  source?: string;
  /**
   * The stable ASCII class of the refusal, when the event states one.
   *
   * A health refusal names the class of the refusal and not its wording, so an
   * observer reads the code and not the Russian text of the reason. The value
   * is one of the agreed codes, e.g. `automation_disabled` or
   * `model_not_permitted_for_project`.
   */
  reason_code?: string;
  sequence: number;
  revision: number;
}

/**
 * The uri of one health refusal.
 *
 * The uri names the incident the refusal belongs to, so an observer reads the
 * refusals of one incident by the prefix of its uri and never by the wording
 * of a reason.
 */
export function healthRefusalUri(incidentId: string): string {
  return `herder://health/refusals/${encodeURIComponent(incidentId)}`;
}

/** One health refusal, as the event states it. */
export interface HealthRefusalEventInput {
  /** The incident the refusal belongs to. */
  incidentId: string;
  /** The stable ASCII class of the refusal, e.g. `automation_disabled`. */
  reasonCode: string;
  /** The source of the refusal, e.g. the harness or the blocked work key. */
  source?: string;
}

/**
 * The event of one health refusal.
 *
 * The kind is `health` and the class of the refusal travels in `reason_code`.
 * The event states a fact and decides nothing: a policy refusal leaves the
 * incident open and waits for the operator, and the observer reads the class
 * and acts by it.
 *
 * The class of a refusal is required. A refusal whose class is unknown has no
 * machine-readable meaning, and an event that states no class would be a
 * refusal no observer can act on, so the builder refuses it instead.
 */
export function healthRefusalEvent(input: HealthRefusalEventInput): Omit<HerderEvent, "at" | "sequence" | "revision"> & { at?: string } {
  const reasonCode = input.reasonCode.trim();
  if (!reasonCode) throw new Error("a health refusal states the class of its refusal");
  return {
    kind: "health",
    uri: healthRefusalUri(input.incidentId),
    action: "changed",
    id: input.incidentId,
    ...(input.source ? { source: input.source } : {}),
    reason_code: reasonCode,
  };
}

interface PersistedEventJournal {
  version: 1;
  latestSequence: number;
  revisions: Record<string, number>;
  events: HerderEvent[];
}

export interface HerderEventBusOptions {
  persistencePath?: string;
  maxRetained?: number;
  /** Coalesce bursty native events before rewriting the retained journal. */
  persistDebounceMs?: number;
}

export function defaultHerderEventPath(): string {
  return process.env.AGENT_HERDER_EVENTS_PATH || join(homedir(), ".local", "state", "agent-herder", "events.json");
}

export class HerderEventBus {
  private readonly listeners = new Set<(event: HerderEvent) => void>();
  private readonly events: HerderEvent[] = [];
  private readonly revisions = new Map<string, number>();
  private readonly persistencePath?: string;
  private readonly maxRetained: number;
  private readonly persistDebounceMs: number;
  private persistTimer?: NodeJS.Timeout;
  private nextSequence = 1;

  constructor(options: HerderEventBusOptions = {}) {
    this.persistencePath = options.persistencePath;
    this.maxRetained = Math.max(100, options.maxRetained ?? 5_000);
    this.persistDebounceMs = Math.max(0, options.persistDebounceMs ?? 0);
    this.restore();
  }

  publish(event: Omit<HerderEvent, "at" | "sequence" | "revision"> & { at?: string }): HerderEvent {
    const revision = (this.revisions.get(event.uri) ?? 0) + 1;
    this.revisions.set(event.uri, revision);
    const normalized: HerderEvent = {
      ...event,
      at: event.at ?? new Date().toISOString(),
      sequence: this.nextSequence++,
      revision,
    };
    this.events.push(normalized);
    if (this.events.length > this.maxRetained) this.events.splice(0, this.events.length - this.maxRetained);
    this.schedulePersist();
    for (const listener of [...this.listeners]) {
      try { listener(normalized); } catch { /* one listener must not block peers */ }
    }
    return normalized;
  }

  subscribe(listener: (event: HerderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  latestSequence(): number {
    return this.nextSequence - 1;
  }

  revision(uri: string): number {
    return this.revisions.get(uri) ?? 0;
  }

  listAfter(afterSequence = 0, limit = 500, uriPrefix?: string): HerderEvent[] {
    const bounded = Math.max(1, Math.min(limit, 2_000));
    return this.events
      .filter((event) => event.sequence > Math.max(0, afterSequence))
      .filter((event) => !uriPrefix || event.uri.startsWith(uriPrefix))
      .slice(0, bounded)
      .map((event) => ({ ...event }));
  }

  oldestSequence(): number | null {
    return this.events[0]?.sequence ?? null;
  }

  private restore(): void {
    if (!this.persistencePath || !existsSync(this.persistencePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.persistencePath, "utf8")) as PersistedEventJournal;
      if (parsed.version !== 1) return;
      const events = Array.isArray(parsed.events) ? parsed.events.slice(-this.maxRetained) : [];
      this.events.push(...events);
      for (const [uri, revision] of Object.entries(parsed.revisions || {})) {
        if (Number.isInteger(revision) && revision >= 0) this.revisions.set(uri, revision);
      }
      const highestEventSequence = events.reduce((max, event) => Math.max(max, event.sequence || 0), 0);
      this.nextSequence = Math.max(1, Number(parsed.latestSequence || 0), highestEventSequence) + 1;
    } catch (error) {
      console.error(`[agent-herder] failed to restore event journal: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private persist(): void {
    if (!this.persistencePath) return;
    try {
      mkdirSync(dirname(this.persistencePath), { recursive: true });
      const temp = `${this.persistencePath}.tmp-${process.pid}`;
      const file: PersistedEventJournal = {
        version: 1,
        latestSequence: this.latestSequence(),
        revisions: Object.fromEntries(this.revisions),
        events: this.events,
      };
      writeFileSync(temp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
      renameSync(temp, this.persistencePath);
    } catch (error) {
      console.error(`[agent-herder] failed to persist event journal: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private schedulePersist(): void {
    if (!this.persistencePath) return;
    if (this.persistDebounceMs === 0) {
      this.persist();
      return;
    }
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persist();
    }, this.persistDebounceMs);
    this.persistTimer.unref?.();
  }
}

/**
 * Publish one health refusal into the event journal.
 *
 * The refusal of the health contour travels through the bus of the herder, so
 * an observer of the events reads the class of the refusal without reading
 * the audit trail and without a second protocol. The caller states the refusal
 * that already happened; publishing it never decides anything.
 */
export function publishHealthRefusal(
  input: HealthRefusalEventInput,
  bus: HerderEventBus = herderEvents,
): HerderEvent {
  return bus.publish(healthRefusalEvent(input));
}

export const herderEvents = new HerderEventBus({
  persistencePath: process.env.VITEST ? undefined : defaultHerderEventPath(),
  persistDebounceMs: 1_000,
});
