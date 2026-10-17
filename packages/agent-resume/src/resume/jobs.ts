import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { defaultJobResumePrompt } from "../harness/marker-search.js";
import { resumeBoundTarget, type BoundDeliveryDeps } from "./delivery.js";
import { ReceiptLedger, receiptFingerprint, type BoundTarget, type ResumeReceiptRecord } from "./receipts.js";

/**
 * Long background work, watched.
 *
 * A caller starts a command (or attaches to a pid, or arms a timer) and gets a
 * job id immediately. The core keeps the job record on disk, reports whether the
 * watched process and the watcher are alive, and — when the job finishes — admits
 * exactly one resume of the bound target through the durable ledger, so a job that
 * is re-checked or replayed after a restart can never resume twice.
 */
const run = promisify(execFile);

export type JobKind = "command" | "pid" | "timer";
export type JobState = "running" | "finished" | "timeout" | "watcher_error";

export interface JobMeta {
  job_id: string;
  kind: JobKind;
  state: JobState;
  created_at: string;
  finished_at?: string;
  elapsed_seconds?: number;
  timed_out?: boolean;
  cwd?: string;
  command?: string[];
  pid?: number | null;
  watcher_pid?: number | null;
  log_file?: string | null;
  note?: string;
  wait_seconds?: number;
  hard_timeout_seconds?: number;
  execute_resume?: boolean;
  resume?: BoundTarget;
  resume_result?: unknown;
  error?: string;
}

export interface JobStatus extends JobMeta {
  /** The watched process (command or pid); timers have none. */
  alive: boolean;
  watched_pid_alive: boolean;
  watcher_alive: boolean;
}

export interface JobRegistryOptions {
  /** Root state directory; jobs live in `<stateDir>/jobs`. */
  stateDir: string;
  ledger: ReceiptLedger;
  delivery?: Pick<BoundDeliveryDeps, "nativeClient" | "launch" | "logDir">;
}

export function parseDurationSeconds(value: unknown, fallback = 0): number {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number") return Math.max(0, Math.trunc(value));
  const text = String(value).trim().toLowerCase();
  if (!text) return fallback;
  for (const [suffix, factor] of [["ms", 0.001], ["s", 1], ["m", 60], ["h", 3600]] as const) {
    if (text.endsWith(suffix)) {
      const parsed = Number(text.slice(0, -suffix.length).trim());
      if (!Number.isFinite(parsed)) throw new Error(`invalid duration: ${String(value)}`);
      return Math.max(0, Math.ceil(parsed * factor));
    }
  }
  const seconds = Number(text);
  if (!Number.isFinite(seconds)) throw new Error(`invalid duration: ${String(value)}`);
  return Math.max(0, Math.trunc(seconds));
}

/** A pid that exists, is not a zombie, and this process may signal. */
export function isPidAlive(pid: number): boolean {
  try {
    const stat = existsSync(`/proc/${pid}/stat`) ? readFileSync(`/proc/${pid}/stat`, "utf8").split(" ") : [];
    if (stat.length >= 3 && stat[2] === "Z") return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

export interface ProcessMatch {
  pid: number;
  cmd: string;
}

export async function findPidsByQuery(query: string, options: { exclude?: string[] } = {}): Promise<ProcessMatch[]> {
  const wanted = String(query ?? "").trim();
  if (!wanted) throw new Error("query is required");
  const result = await run("/bin/bash", ["-lc", "ps -eo pid=,args="], { timeout: 10_000 });
  const exclude = options.exclude ?? [];
  const matches: ProcessMatch[] = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(" ");
    if (separator < 1) continue;
    const pid = Number(trimmed.slice(0, separator));
    const cmd = trimmed.slice(separator + 1);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    if (exclude.some((needle) => needle && cmd.includes(needle))) continue;
    if (cmd.includes(wanted)) matches.push({ pid, cmd: cmd.slice(0, 500) });
  }
  return matches;
}

export class JobRegistry {
  private readonly stateDir: string;
  private readonly ledger: ReceiptLedger;
  private readonly delivery: JobRegistryOptions["delivery"];

  constructor(options: JobRegistryOptions) {
    this.stateDir = options.stateDir;
    this.ledger = options.ledger;
    this.delivery = options.delivery;
  }

  root(jobId: string): string {
    return join(this.stateDir, "jobs", jobId);
  }

  metaPath(jobId: string): string {
    return join(this.root(jobId), "meta.json");
  }

  newJobId(): string {
    return `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "Z")}-${randomUUID().slice(0, 8)}`;
  }

  /** Claim a job directory; a colliding id is refused instead of overwritten. */
  create(jobId: string, meta: Omit<JobMeta, "job_id" | "state" | "created_at">): JobMeta {
    mkdirSync(join(this.stateDir, "jobs"), { recursive: true });
    const root = this.root(jobId);
    // recursive:false claims the directory exclusively: a colliding job id fails here.
    mkdirSync(root, { recursive: false });
    const record: JobMeta = { ...meta, job_id: jobId, state: "running", created_at: new Date().toISOString() };
    this.write(record);
    return record;
  }

  read(jobId: string): JobMeta | null {
    try {
      return JSON.parse(readFileSync(this.metaPath(jobId), "utf8")) as JobMeta;
    } catch {
      return null;
    }
  }

  write(meta: JobMeta): void {
    const path = this.metaPath(meta.job_id);
    mkdirSync(this.root(meta.job_id), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  }

  list(): JobMeta[] {
    const root = join(this.stateDir, "jobs");
    if (!existsSync(root)) return [];
    const jobs: JobMeta[] = [];
    for (const entry of readdirSync(root)) {
      const meta = this.read(entry);
      if (meta) jobs.push(meta);
    }
    return jobs.sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  status(jobId: string): JobStatus | null {
    const meta = this.read(jobId);
    if (!meta) return null;
    const watched = typeof meta.pid === "number" && meta.pid > 0 ? isPidAlive(meta.pid) : false;
    const watcher = typeof meta.watcher_pid === "number" && meta.watcher_pid > 0 ? isPidAlive(meta.watcher_pid) : false;
    return { ...meta, alive: watched, watched_pid_alive: watched, watcher_alive: watcher };
  }

  /** Run a command detached, watch its pid, and admit one resume when it ends. */
  async runAndResume(input: {
    command: string;
    cwd: string;
    resume: BoundTarget;
    hardTimeoutSeconds?: number;
    logFile?: string | null;
    note?: string;
    executeResume?: boolean;
    marker?: string | null;
    resultRef?: string;
  }): Promise<JobMeta> {
    const jobId = this.newJobId();
    const logFile = input.logFile || join(this.root(jobId), "job.log");
    const meta = this.create(jobId, {
      kind: "command",
      cwd: input.cwd,
      command: input.command.split(/\s+/).filter(Boolean),
      pid: null,
      log_file: logFile,
      note: input.note ?? "",
      hard_timeout_seconds: input.hardTimeoutSeconds ?? 0,
      execute_resume: input.executeResume !== false,
      resume: input.resume,
    });
    const detached = spawn(input.command, {
      cwd: input.cwd,
      detached: true,
      stdio: ["ignore", -1, -1],
      shell: true,
    });
    detached.unref();
    meta.pid = detached.pid ?? null;
    this.write(meta);
    return meta;
  }

  /** Arm a timer; there is no watched process, only the watcher. */
  async waitAndResume(input: {
    waitSeconds: number;
    cwd: string;
    resume: BoundTarget;
    logFile?: string | null;
    note?: string;
    executeResume?: boolean;
    marker?: string | null;
    resultRef?: string;
  }): Promise<JobMeta> {
    if (input.waitSeconds <= 0) throw new Error("wait_seconds must be > 0");
    const jobId = this.newJobId();
    return this.create(jobId, {
      kind: "timer",
      cwd: input.cwd,
      wait_seconds: input.waitSeconds,
      pid: null,
      log_file: input.logFile ?? null,
      note: input.note ?? "",
      execute_resume: input.executeResume !== false,
      resume: input.resume,
    });
  }

  async attachPidAndResume(input: {
    pid: number;
    cwd: string;
    resume: BoundTarget;
    hardTimeoutSeconds?: number;
    logFile?: string | null;
    note?: string;
    executeResume?: boolean;
    marker?: string | null;
    resultRef?: string;
  }): Promise<JobMeta> {
    if (!isPidAlive(input.pid)) throw new Error(`process is not running: ${input.pid}`);
    const jobId = this.newJobId();
    return this.create(jobId, {
      kind: "pid",
      cwd: input.cwd,
      pid: input.pid,
      log_file: input.logFile ?? null,
      note: input.note ?? "",
      hard_timeout_seconds: input.hardTimeoutSeconds ?? 0,
      execute_resume: input.executeResume !== false,
      resume: input.resume,
    });
  }

  /**
   * Finish a job: wait for the deadline, then admit exactly one resume.
   *
   * The idempotency key is derived from the job id, so the same job resumed after
   * a restart replays its stored receipt instead of sending a second prompt.
   */
  async complete(input: {
    jobId: string;
    waitSeconds?: number;
    hardTimeoutSeconds?: number;
    marker?: string | null;
    resultRef?: string;
  }, signal?: AbortSignal): Promise<JobMeta> {
    const meta = this.read(input.jobId);
    if (!meta) throw new Error(`job not found: ${input.jobId}`);
    if (meta.state !== "running") return meta;
    const started = Date.now();
    const limit = input.hardTimeoutSeconds ?? meta.hard_timeout_seconds ?? 0;
    let state: JobState = "finished";
    let timedOut = false;
    const deadline = () => limit > 0 && (Date.now() - started) / 1000 >= limit;
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    try {
      if (meta.kind === "timer") {
        const until = Date.now() + (input.waitSeconds ?? meta.wait_seconds ?? 0) * 1000;
        while (Date.now() < until && !signal?.aborted) await sleep(Math.min(250, Math.max(0, until - Date.now())));
        if (signal?.aborted) return meta;
      } else if (meta.pid) {
        while (isPidAlive(meta.pid)) {
          if (signal?.aborted) return meta;
          if (deadline()) { timedOut = true; state = "timeout"; break; }
          await sleep(200);
        }
      }
      meta.finished_at = new Date().toISOString();
      meta.elapsed_seconds = Math.round((Date.now() - started) / 1000);
      meta.state = state;
      meta.timed_out = timedOut;
      if (meta.execute_resume !== false && meta.resume) {
        const prompt = defaultJobResumePrompt({
          jobId: meta.job_id,
          logFile: meta.log_file ?? undefined,
          note: [meta.note, timedOut ? `Hard timeout reached after ${limit}s; watched process may still be alive.` : "Watched process finished."]
            .filter(Boolean).join(" "),
          marker: input.marker ?? null,
          state,
        });
        const key = `agent-resume:job:${meta.job_id}`;
        const receipt: ResumeReceiptRecord = await resumeBoundTarget({
          target: meta.resume,
          prompt,
          goal: prompt,
          resultRef: input.resultRef ?? `agent-resume://job/${meta.job_id}`,
          idempotencyKey: key,
        }, { ledger: this.ledger, ...(this.delivery ?? {}) });
        meta.resume_result = receipt;
      }
      this.write(meta);
      return meta;
    } catch (error) {
      meta.state = "watcher_error";
      meta.error = error instanceof Error ? error.message : String(error);
      meta.finished_at = new Date().toISOString();
      this.write(meta);
      return meta;
    }
  }

  /** The fingerprint a job's resume would carry, exposed for reconciliation. */
  jobResumeFingerprint(jobId: string, target: BoundTarget, prompt: string): string {
    return receiptFingerprint({ target, prompt, idempotencyKey: `agent-resume:job:${jobId}`, resultRef: `agent-resume://job/${jobId}` });
  }
}