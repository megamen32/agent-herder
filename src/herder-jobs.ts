import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NativeCodexClient } from "./mesh/native-codex.js";
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
  requestFingerprint?: string;
  /** A native mutation whose receipt must never be evicted or replayed. */
  durableOnce?: boolean;
  onceKey?: string;
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

const stockController = "/home/roomhacker/ServersAdministartion/templates/server100-resource-guard/native_completion_handoff.py";
interface NativeStockCaseBinding {
  ownerSessionId: string;
  command: string[];
  cwd: string;
  deadlineMs: number;
  bindingFingerprint: string;
}

/** Keep actual output/outcome in job_get even when the operation fails. */
class NativeStockCaseFailure extends Error {
  constructor(message: string, readonly result: Record<string, unknown>) { super(message); }
}

export function defaultHerderJobPath(): string {
  return process.env.AGENT_HERDER_JOBS_PATH || join(homedir(), ".local", "state", "agent-herder", "jobs.json");
}

export class HerderJobRegistry {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly maxRetained: number;
  private readonly persistencePath?: string;
  private persistenceRestoreError?: string;

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
    idempotencyKey?: string;
    requestFingerprint?: string;
    durableOnce?: boolean;
    run: (context: HerderJobContext) => Promise<T>;
  }): HerderJob<T> {
    if (input.durableOnce && this.persistenceRestoreError) throw new Error("native_stock_case_history_unreadable_hold; no replay");
    if (input.durableOnce && (!input.idempotencyKey || !this.persistencePath)) throw new Error("native_stock_case_durable_registry_required");
    const now = new Date().toISOString();
    const id = input.idempotencyKey
      ? `job_${createHash("sha256").update(input.idempotencyKey).digest("hex")}`
      : `job_${randomUUID()}`;
    const existing = this.get<T>(id);
    if (existing) {
      if (existing.requestFingerprint !== input.requestFingerprint) throw new Error("Идентификатор сообщения уже использован для другого текста или режима");
      return existing;
    }
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
        ...(input.requestFingerprint ? { requestFingerprint: input.requestFingerprint } : {}),
        ...(input.durableOnce ? { durableOnce: true, onceKey: input.idempotencyKey } : {}),
      },
    };
    this.jobs.set(id, internal);
    this.trim();
    try { this.persist(Boolean(input.idempotencyKey)); }
    catch (error) { this.jobs.delete(id); throw error; }
    this.publish(internal.record, "created");
    void this.run(internal, input.run);
    return clone(internal.record);
  }

  /** Only a named, server-configured stock controller. Caller supplies no argv,
   * deadline, native thread, permission or shell. The WS belongs to this registry
   * runner, not the MCP request/transport/owner turn that admitted it. */
  startNativeStockCase(input: { caseId: string; ownerSessionId: string }): HerderJob {
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(input.caseId)) throw new Error("native_stock_case_id_invalid");
    const path = process.env.AGENT_HERDER_NATIVE_STOCK_CASES_PATH || join(homedir(), ".local/state/agent-herder/native-stock-cases.json");
    const configured = JSON.parse(readFileSync(path, "utf8")) as Record<string, NativeStockCaseBinding>;
    const binding = configured[input.caseId];
    if (!Object.hasOwn(configured, input.caseId) || !binding) throw new Error("native_stock_case_not_registered");
    if (!input.ownerSessionId || binding.ownerSessionId !== input.ownerSessionId) throw new Error("native_stock_case_owner_mismatch");
    const argv = binding.command;
    if (!Array.isArray(argv) || argv.length !== 10 || argv.some(value => typeof value !== "string")
      || argv.slice(0, 7).join("\0") !== ["/usr/bin/python3.10", "-I", "-S", "-B", stockController, "--run-native", "--plan"].join("\0")
      || !argv[7]?.startsWith("/") || argv[8] !== "--plan-sha256" || !/^[a-f0-9]{64}$/.test(argv[9] || "")
      || binding.bindingFingerprint !== argv[9] || typeof binding.cwd !== "string" || !binding.cwd.startsWith("/")
      || !Number.isSafeInteger(binding.deadlineMs) || binding.deadlineMs < 1 || binding.deadlineMs > 2147483647) throw new Error("native_stock_case_binding_invalid");
    const planBytes = readFileSync(argv[7]);
    if (createHash("sha256").update(planBytes).digest("hex") !== argv[9]) throw new Error("native_stock_case_plan_drift_hold");
    const plan = JSON.parse(planBytes.toString("utf8"));
    let stopUnix: number | undefined;
    if (plan?.completion_kind === "due261") {
      if (plan.mode !== "sequential-native-v1" || typeof plan.due_unix !== "number" || !Number.isFinite(plan.due_unix) || plan.due_unix <= 0
        || typeof plan.stop_unix !== "number" || !Number.isFinite(plan.stop_unix) || plan.stop_unix !== plan.due_unix + 900) throw new Error("native_stock_case_absolute_stop_invalid_hold");
      stopUnix = plan.stop_unix;
    }
    const requestFingerprint = createHash("sha256").update(JSON.stringify(binding)).digest("hex");
    const sourceSha256 = createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");
    return this.start({
      kind: "native-stock-case", ownerSessionId: binding.ownerSessionId,
      idempotencyKey: `native-stock-case:${input.caseId}`, requestFingerprint, durableOnce: true,
      run: async ({ signal, progress }) => {
        const result: Record<string, unknown> = { caseId: input.caseId, bindingFingerprint: binding.bindingFingerprint, requestFingerprint, sourceSha256, deadlineMs: binding.deadlineMs, nativeOutcome: "not_dispatched" };
        if (signal.aborted) throw new NativeStockCaseFailure("native_stock_case_cancelled_before_dispatch", result);
        const client = new NativeCodexClient();
        let dispatched = false;
        try {
          await client.connect();
          if (signal.aborted) throw new NativeStockCaseFailure("native_stock_case_cancelled_before_dispatch", result);
          progress(0.05, "Ожидается результат фиксированного native stock-case; клиент удерживается до callback/cleanup");
          // Bound the pinned paid due operation to its original absolute stop,
          // including registration/connect delay. Canary deadlines stay relative.
          const deadlineMs = stopUnix === undefined ? binding.deadlineMs : Math.min(binding.deadlineMs, Math.floor((stopUnix - Date.now() / 1000) * 1000));
          if (deadlineMs <= 0) throw new Error("native_stock_case_absolute_stop_expired_hold");
          Object.assign(result, { effectiveDeadlineMs: deadlineMs, ...(stopUnix === undefined ? {} : { stopUnix }) });
          dispatched = true;
          const native = await client.request("command/exec", { command: argv, cwd: binding.cwd, timeoutMs: deadlineMs, outputBytesCap: 65536 }, { timeoutMs: deadlineMs });
          Object.assign(result, { native, nativeOutcome: typeof native?.exitCode === "number" ? "known" : "unknown" });
          if (native?.exitCode !== 0) throw new NativeStockCaseFailure("native_stock_case_did_not_complete_zero; no replay", result);
          return result;
        } catch (error) {
          if (error instanceof NativeStockCaseFailure) throw error;
          Object.assign(result, { nativeOutcome: dispatched ? "unknown" : "not_dispatched", error: error instanceof Error ? error.message : String(error), replay: "forbidden" });
          throw new NativeStockCaseFailure("native_stock_case_outcome_unconfirmed; no replay", result);
        } finally {
          // No early close on MCP disconnect/owner completion or job_cancel.
          // At this point the exact response/deadline/transport loss was observed.
          client.close();
        }
      },
    });
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

  updateCompletedResult<T>(id: string, result: T): void {
    const job = this.jobs.get(id);
    if (!job || job.record.state !== "completed") return;
    this.patch(job.record, { result }, "updated");
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
        this.patch(job.record, { state: "cancelled", statusMessage: "Cancelled", ...(job.record.durableOnce ? { result } : {}) }, "updated");
        return;
      }
      this.patch(job.record, { state: "completed", progress: 1, result, statusMessage: undefined }, "updated");
    } catch (error) {
      if (job.controller.signal.aborted || job.record.state === "cancelled" || job.record.state === "cancelling") {
        this.patch(job.record, { state: "cancelled", statusMessage: "Cancelled", ...(error instanceof NativeStockCaseFailure ? { result: error.result as T } : {}) }, "updated");
        return;
      }
      this.patch(job.record, { state: "failed", error: error instanceof Error ? error.message : String(error), statusMessage: undefined, ...(error instanceof NativeStockCaseFailure ? { result: error.result as T } : {}) }, "updated");
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
      .filter(({ record }) => isTerminal(record.state) && !record.durableOnce)
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
      if (parsed.version !== 1 || !Array.isArray(parsed.jobs)) throw new Error("job history format invalid");
      for (const raw of parsed.jobs) {
        if ((raw?.durableOnce || raw?.kind === "native-stock-case")
          && (raw.durableOnce !== true || typeof raw.onceKey !== "string" || !raw.onceKey
            || raw.id !== `job_${createHash("sha256").update(raw.onceKey).digest("hex")}` || typeof raw.kind !== "string"
            || !["queued", "running", "waiting", "cancelling", "completed", "failed", "cancelled", "interrupted"].includes(raw.state))) throw new Error("durable once history record invalid");
      }
      const now = new Date().toISOString();
      let changed = false;
      for (const raw of [...parsed.jobs.filter(record => record?.durableOnce), ...parsed.jobs.filter(record => !record?.durableOnce).slice(-this.maxRetained)]) {
        if (!raw || typeof raw.id !== "string" || typeof raw.kind !== "string" || typeof raw.state !== "string") continue;
        const record = clone(raw);
        if (record.state === "queued" || record.state === "running" || record.state === "waiting" || record.state === "cancelling") {
          record.state = "interrupted";
          record.updatedAt = now;
          record.statusMessage = "Agent Herder restarted before this job completed";
          record.error = record.error || "interrupted by service restart";
          if (record.durableOnce) record.result = { nativeOutcome: "unknown", replay: "forbidden" };
          changed = true;
        }
        this.jobs.set(record.id, { record, controller: new AbortController() });
      }
      if (changed) this.persist();
    } catch (error) {
      this.persistenceRestoreError = error instanceof Error ? error.message : String(error);
      console.error(`[agent-herder] failed to restore job registry: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private persist(strict = false): void {
    if (!this.persistencePath) return;
    // Never let an ordinary job erase an unreadable durable-once history either.
    if (this.persistenceRestoreError) {
      if (strict) throw new Error("job_history_unreadable_hold");
      return;
    }
    try {
      mkdirSync(dirname(this.persistencePath), { recursive: true });
      const temp = `${this.persistencePath}.tmp-${process.pid}`;
      const durable = [...this.jobs.values()].filter(job => job.record.durableOnce).map(job => clone(job.record));
      const ordinary = this.list(500).filter(record => !record.durableOnce).slice(0, this.maxRetained);
      const file: PersistedJobFile = { version: 1, jobs: [...durable, ...ordinary] };
      writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, this.persistencePath);
    } catch (error) {
      if (strict) throw error;
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
