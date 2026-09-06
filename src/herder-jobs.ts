import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { herderEvents, type HerderEventBus } from "./herder-events.js";
import { jobResourceUri } from "./herder-resource-uris.js";

export type HerderJobState = "queued" | "running" | "waiting" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted";

export interface HerderJob<T = unknown> {
  id: string;
  kind: string;
  state: HerderJobState;
  createdAt: string;
  updatedAt: string;
  ownerSessionId?: string;
  progress?: number;
  statusMessage?: string;
  result?: T;
  error?: string;
  resultRef: string;
}

export interface HerderJobContext {
  signal: AbortSignal;
  progress(value: number, statusMessage?: string): void;
  waiting(statusMessage?: string): void;
}

interface InternalJob<T = unknown> {
  record: HerderJob<T>;
  controller: AbortController;
}

interface PersistedJobFile {
  version: 1;
  jobs: HerderJob[];
}

export interface HerderJobRegistryOptions {
  maxRetained?: number;
  persistencePath?: string;
}

export function defaultHerderJobPath(): string {
  return process.env.AGENT_HERDER_JOBS_PATH || join(homedir(), ".local", "state", "agent-herder", "jobs.json");
}

export class HerderJobRegistry {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly maxRetained: number;
  private readonly persistencePath?: string;

  constructor(private readonly events: HerderEventBus = herderEvents, options: HerderJobRegistryOptions = {}) {
    this.maxRetained = Math.max(10, options.maxRetained ?? 500);
    this.persistencePath = options.persistencePath;
    this.restore();
  }

  list(limit = 100): HerderJob[] {
    return [...this.jobs.values()]
      .map(({ record }) => clone(record))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(limit, 500)));
  }

  get<T = unknown>(id: string): HerderJob<T> | null {
    const job = this.jobs.get(id);
    return job ? clone(job.record as HerderJob<T>) : null;
  }

  start<T>(input: {
    kind: string;
    ownerSessionId?: string;
    run: (context: HerderJobContext) => Promise<T>;
  }): HerderJob<T> {
    const now = new Date().toISOString();
    const id = `job_${randomUUID()}`;
    const internal: InternalJob<T> = {
      controller: new AbortController(),
      record: {
        id,
        kind: input.kind,
        state: "queued",
        createdAt: now,
        updatedAt: now,
        ownerSessionId: input.ownerSessionId,
        resultRef: jobResourceUri(id),
      },
    };
    this.jobs.set(id, internal);
    this.trim();
    this.persist();
    this.publish(internal.record, "created");
    void this.run(internal, input.run);
    return clone(internal.record);
  }

  cancel(id: string): HerderJob | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (isTerminal(job.record.state)) return clone(job.record);
    job.controller.abort();
    job.record.state = "cancelling";
    job.record.updatedAt = new Date().toISOString();
    job.record.statusMessage = "Cancellation requested";
    this.persist();
    this.publish(job.record, "updated");
    return clone(job.record);
  }

  private async run<T>(job: InternalJob<T>, runner: (context: HerderJobContext) => Promise<T>): Promise<void> {
    if (job.controller.signal.aborted) return;
    this.patch(job.record, { state: "running", statusMessage: undefined }, "updated");
    const context: HerderJobContext = {
      signal: job.controller.signal,
      progress: (value, statusMessage) => {
        if (job.record.state === "cancelled" || job.record.state === "cancelling") return;
        this.patch(job.record, { state: "running", progress: Math.max(0, Math.min(1, value)), statusMessage }, "updated");
      },
      waiting: (statusMessage) => {
        if (job.record.state === "cancelled" || job.record.state === "cancelling") return;
        this.patch(job.record, { state: "waiting", statusMessage }, "updated");
      },
    };
    try {
      const result = await runner(context);
      if (job.controller.signal.aborted || job.record.state === "cancelled" || job.record.state === "cancelling") {
        this.patch(job.record, { state: "cancelled", statusMessage: "Cancelled" }, "updated");
        return;
      }
      this.patch(job.record, { state: "completed", progress: 1, result, statusMessage: undefined }, "updated");
    } catch (error) {
      if (job.controller.signal.aborted || job.record.state === "cancelled" || job.record.state === "cancelling") {
        this.patch(job.record, { state: "cancelled", statusMessage: "Cancelled" }, "updated");
        return;
      }
      this.patch(job.record, { state: "failed", error: error instanceof Error ? error.message : String(error), statusMessage: undefined }, "updated");
    }
  }

  private patch<T>(record: HerderJob<T>, patch: Partial<HerderJob<T>>, action: "updated"): void {
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    this.persist();
    this.publish(record, action);
  }

  private publish(record: HerderJob, action: "created" | "updated"): void {
    this.events.publish({ kind: "jobs", uri: "herder://jobs", action, id: record.id });
    this.events.publish({ kind: "jobs", uri: jobResourceUri(record.id), action, id: record.id });
  }

  private trim(): void {
    if (this.jobs.size <= this.maxRetained) return;
    const removable = [...this.jobs.values()]
      .filter(({ record }) => isTerminal(record.state))
      .sort((a, b) => a.record.updatedAt.localeCompare(b.record.updatedAt));
    for (const job of removable) {
      if (this.jobs.size <= this.maxRetained) break;
      this.jobs.delete(job.record.id);
    }
  }

  private restore(): void {
    if (!this.persistencePath || !existsSync(this.persistencePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.persistencePath, "utf8")) as PersistedJobFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.jobs)) return;
      const now = new Date().toISOString();
      let changed = false;
      for (const raw of parsed.jobs.slice(-this.maxRetained)) {
        if (!raw || typeof raw.id !== "string" || typeof raw.kind !== "string" || typeof raw.state !== "string") continue;
        const record = clone(raw);
        if (record.state === "queued" || record.state === "running" || record.state === "waiting" || record.state === "cancelling") {
          record.state = "interrupted";
          record.updatedAt = now;
          record.statusMessage = "Agent Herder restarted before this job completed";
          record.error = record.error || "interrupted by service restart";
          changed = true;
        }
        this.jobs.set(record.id, { record, controller: new AbortController() });
      }
      if (changed) this.persist();
    } catch (error) {
      console.error(`[agent-herder] failed to restore job registry: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private persist(): void {
    if (!this.persistencePath) return;
    try {
      mkdirSync(dirname(this.persistencePath), { recursive: true });
      const temp = `${this.persistencePath}.tmp-${process.pid}`;
      const file: PersistedJobFile = { version: 1, jobs: this.list(this.maxRetained) };
      writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, this.persistencePath);
    } catch (error) {
      console.error(`[agent-herder] failed to persist job registry: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function isTerminal(state: HerderJobState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled" || state === "interrupted";
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const herderJobs = new HerderJobRegistry(herderEvents, { persistencePath: defaultHerderJobPath() });
