import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";

export type MinimaxExecPolicyMode = "unset" | "smart" | "full" | "off";
export interface MinimaxExecPolicyTarget {
  hostId: string;
  harness: "minimax-code";
  sessionId: string;
}
export interface MinimaxExecPolicy {
  target: MinimaxExecPolicyTarget;
  scope: "next_herder_cli_exec";
  mode: MinimaxExecPolicyMode;
  revision: number;
  updatedAt: string;
}
interface StoredMinimaxExecPolicy extends MinimaxExecPolicy { activeJobs: string[] }

export class MinimaxExecPolicyConflict extends Error {
  constructor(message: string) { super(message); this.name = "MinimaxExecPolicyConflict"; }
}

export class MinimaxExecPolicyStore {
  private readonly directory: string;

  constructor(directory = process.env.AGENT_HERDER_MINIMAX_EXEC_POLICY_DIR
    || join(process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR || join(homedir(), ".local", "state", "agent-herder"), "minimax-exec-policies")) {
    this.directory = directory;
  }

  async withSnapshot<T>(target: MinimaxExecPolicyTarget, callback: (policy: MinimaxExecPolicy, reserve: (jobId: string) => Promise<void>) => Promise<T> | T): Promise<T> {
    return this.withTargetLock(target, async (path) => {
      const stored = await this.read(path, target);
      const reserve = async (jobId: string) => {
        if (!/^job_[a-f0-9]{64}$/.test(jobId)) throw new MinimaxExecPolicyConflict("Invalid durable MiniMax job identity.");
        if (stored.activeJobs.includes(jobId)) return;
        stored.activeJobs.push(jobId);
        await this.write(path, stored);
      };
      return callback(this.publicPolicy(stored), reserve);
    });
  }

  async releaseAdmission(target: MinimaxExecPolicyTarget, jobId: string): Promise<void> {
    await this.withTargetLock(target, async (path) => {
      const stored = await this.read(path, target);
      const next = stored.activeJobs.filter((active) => active !== jobId);
      if (next.length === stored.activeJobs.length) return;
      stored.activeJobs = next;
      await this.write(path, stored);
    });
  }

  async update(
    target: MinimaxExecPolicyTarget,
    expectedRevision: number,
    mode: MinimaxExecPolicyMode,
    reconcileActiveJobs?: (current: MinimaxExecPolicy, activeJobIds: readonly string[]) => Promise<readonly string[]>,
    beforeWrite?: (current: MinimaxExecPolicy) => void | Promise<void>,
  ): Promise<MinimaxExecPolicy> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !isMinimaxExecPolicyMode(mode)) {
      throw new MinimaxExecPolicyConflict("Invalid MiniMax execution policy update.");
    }
    return this.withTargetLock(target, async (path) => {
      const current = await this.read(path, target);
      if (current.revision !== expectedRevision) throw new MinimaxExecPolicyConflict("MiniMax execution policy changed; refresh before updating.");
      if (current.activeJobs.length > 0) {
        if (!reconcileActiveJobs) throw new MinimaxExecPolicyConflict("A MiniMax Herder delivery is already admitted for this session; wait for its terminal receipt before changing policy.");
        const clear = new Set(await reconcileActiveJobs(this.publicPolicy(current), [...current.activeJobs]));
        if ([...clear].some((jobId) => !current.activeJobs.includes(jobId))) throw new MinimaxExecPolicyConflict("Active MiniMax delivery reconciliation returned an unknown job identity.");
        current.activeJobs = current.activeJobs.filter((jobId) => !clear.has(jobId));
        if (current.activeJobs.length > 0) throw new MinimaxExecPolicyConflict("A MiniMax Herder delivery is still active or its native idle state is unknown; policy was not changed.");
      }
      await beforeWrite?.(current);
      const next: StoredMinimaxExecPolicy = { ...current, target, scope: "next_herder_cli_exec", mode, revision: current.revision + 1, updatedAt: new Date().toISOString() };
      await this.write(path, next);
      return this.publicPolicy(next);
    });
  }

  private async withTargetLock<T>(target: MinimaxExecPolicyTarget, callback: (path: string) => Promise<T>): Promise<T> {
    if (!target.hostId || target.harness !== "minimax-code" || !target.sessionId) throw new MinimaxExecPolicyConflict("Exact MiniMax host and session are required.");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const key = createHash("sha256").update(`${target.hostId}\0${target.harness}\0${target.sessionId}`).digest("hex");
    const path = join(this.directory, `${key}.json`);
    const handle = await open(path, "a", 0o600);
    await handle.close();
    const release = await lockfile.lock(path, { realpath: false, retries: { retries: 30, minTimeout: 10, maxTimeout: 100 } });
    try { return await callback(path); } finally { await release(); }
  }

  private async read(path: string, target: MinimaxExecPolicyTarget): Promise<StoredMinimaxExecPolicy> {
    let raw: string;
    try { raw = await readFile(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { target, scope: "next_herder_cli_exec", mode: "unset", revision: 0, updatedAt: "", activeJobs: [] };
      }
      throw error;
    }
    if (!raw.trim()) return { target, scope: "next_herder_cli_exec", mode: "unset", revision: 0, updatedAt: "", activeJobs: [] };
    let parsed: unknown;
    try { parsed = JSON.parse(raw) as unknown; }
    catch { throw new MinimaxExecPolicyConflict("Stored MiniMax execution policy is corrupt; update refused."); }
    if (!isMinimaxExecPolicy(parsed) || parsed.target.hostId !== target.hostId
      || parsed.target.harness !== target.harness || parsed.target.sessionId !== target.sessionId) {
      throw new MinimaxExecPolicyConflict("Stored MiniMax execution policy is invalid or bound to another target.");
    }
    return { ...parsed, activeJobs: Array.isArray((parsed as StoredMinimaxExecPolicy).activeJobs)
      ? (parsed as StoredMinimaxExecPolicy).activeJobs.filter((jobId) => typeof jobId === "string" && /^job_[a-f0-9]{64}$/.test(jobId)) : [] };
  }

  private publicPolicy(stored: StoredMinimaxExecPolicy): MinimaxExecPolicy {
    const { activeJobs: _activeJobs, ...policy } = stored;
    return policy;
  }

  private async write(path: string, value: StoredMinimaxExecPolicy): Promise<void> {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  }
}

export function isMinimaxExecPolicyMode(value: unknown): value is MinimaxExecPolicyMode {
  return value === "unset" || value === "smart" || value === "full" || value === "off";
}

function isMinimaxExecPolicy(value: unknown): value is MinimaxExecPolicy {
  if (!value || typeof value !== "object") return false;
  const policy = value as Partial<StoredMinimaxExecPolicy>;
  return policy.scope === "next_herder_cli_exec" && isMinimaxExecPolicyMode(policy.mode)
    && Number.isSafeInteger(policy.revision) && (policy.revision ?? -1) >= 0
    && (policy.revision !== 0 || policy.mode === "unset")
    && typeof policy.updatedAt === "string" && !!policy.target && typeof policy.target.hostId === "string"
    && policy.target.harness === "minimax-code" && typeof policy.target.sessionId === "string"
    && (policy.activeJobs === undefined || (Array.isArray(policy.activeJobs) && policy.activeJobs.every((jobId) => typeof jobId === "string" && /^job_[a-f0-9]{64}$/.test(jobId))));
}
