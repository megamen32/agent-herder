import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
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

// Keep the append-only tail bounded while avoiding a multi-megabyte snapshot
// rewrite for every small batch of native events.
const EVENT_JOURNAL_COMPACT_BYTES = 8 * 1024 * 1024;

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
  private readonly journalPath?: string;
  private readonly pendingEvents: HerderEvent[] = [];
  private journalBytes = 0;
  private journalNeedsSeparator = false;
  private persistTimer?: NodeJS.Timeout;
  private nextSequence = 1;

  constructor(options: HerderEventBusOptions = {}) {
    this.persistencePath = options.persistencePath;
    this.journalPath = options.persistencePath ? `${options.persistencePath}.journal` : undefined;
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
    if (this.persistencePath) this.pendingEvents.push(normalized);
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
    if (!this.persistencePath) return;
    let snapshotSequence = 0;
    if (existsSync(this.persistencePath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.persistencePath, "utf8")) as PersistedEventJournal;
        if (parsed.version === 1) {
          const events = Array.isArray(parsed.events) ? parsed.events.slice(-this.maxRetained) : [];
          this.events.push(...events);
          for (const [uri, revision] of Object.entries(parsed.revisions || {})) {
            if (Number.isInteger(revision) && revision >= 0) this.revisions.set(uri, revision);
          }
          snapshotSequence = Math.max(Number(parsed.latestSequence || 0), ...events.map((event) => event.sequence || 0));
        }
      } catch (error) {
        console.error(`[agent-herder] failed to restore event journal: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (this.journalPath && existsSync(this.journalPath)) {
      try {
        const contents = readFileSync(this.journalPath, "utf8");
        chmodSync(this.journalPath, 0o600);
        this.journalBytes = Buffer.byteLength(contents);
        this.journalNeedsSeparator = contents.length > 0 && !contents.endsWith("\n");
        const replayed = new Set(this.events.map((event) => event.sequence));
        for (const line of contents.split("\n")) {
          if (!line) continue;
          let event: HerderEvent;
          try { event = JSON.parse(line) as HerderEvent; } catch { continue; }
          if (!event || !Number.isSafeInteger(event.sequence) || event.sequence <= snapshotSequence
            || !Number.isSafeInteger(event.revision) || event.revision < 1
            || typeof event.uri !== "string" || !event.uri || replayed.has(event.sequence)) continue;
          replayed.add(event.sequence);
          this.events.push(event);
          this.revisions.set(event.uri, Math.max(this.revisions.get(event.uri) ?? 0, event.revision));
          snapshotSequence = Math.max(snapshotSequence, event.sequence);
        }
        if (this.events.length > this.maxRetained) this.events.splice(0, this.events.length - this.maxRetained);
      } catch (error) {
        console.error(`[agent-herder] failed to replay event journal: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.nextSequence = Math.max(0, snapshotSequence) + 1;
  }

  private persist(): void {
    if (!this.persistencePath || !this.journalPath) return;
    try {
      mkdirSync(dirname(this.persistencePath), { recursive: true });
      if (this.pendingEvents.length > 0) {
        const payload = `${this.journalNeedsSeparator ? "\n" : ""}${this.pendingEvents.map((event) => JSON.stringify(event)).join("\n")}\n`;
        this.journalNeedsSeparator = true;
        const created = !existsSync(this.journalPath);
        const fd = openSync(this.journalPath, "a", 0o600);
        try {
          writeFileSync(fd, payload, "utf8");
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        if (created) {
          const directoryFd = openSync(dirname(this.journalPath), "r");
          try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
        }
        this.journalBytes = statSync(this.journalPath).size;
        this.journalNeedsSeparator = false;
        this.pendingEvents.splice(0, this.pendingEvents.length);
      }
      if (this.journalBytes >= EVENT_JOURNAL_COMPACT_BYTES) this.compactJournal();
    } catch (error) {
      console.error(`[agent-herder] failed to persist event journal: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private compactJournal(): void {
    if (!this.persistencePath || !this.journalPath) return;
    const temp = `${this.persistencePath}.tmp-${process.pid}`;
    const directory = dirname(this.persistencePath);
    const file: PersistedEventJournal = {
      version: 1,
      latestSequence: this.latestSequence(),
      revisions: Object.fromEntries(this.revisions),
      events: this.events,
    };
    writeFileSync(temp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    const snapshotFd = openSync(temp, "r+");
    try { fsyncSync(snapshotFd); } finally { closeSync(snapshotFd); }
    renameSync(temp, this.persistencePath);
    const directoryFd = openSync(directory, "r");
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }

    // The new v1 snapshot is durable before truncating the append-only tail.
    // If a crash happens before truncation, restore ignores rows covered by
    // latestSequence, so the same event sequence is never applied twice.
    const journalFd = openSync(this.journalPath, "w", 0o600);
    try { fsyncSync(journalFd); } finally { closeSync(journalFd); }
    chmodSync(this.journalPath, 0o600);
    this.journalBytes = 0;
    this.journalNeedsSeparator = false;
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
