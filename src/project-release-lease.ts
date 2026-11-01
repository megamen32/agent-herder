import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import lockfile from "proper-lockfile";
import { execFileSync } from "node:child_process";

export interface ReleaseOwner { hostId: string; harness: string; nativeSessionId: string }
export interface ReleaseLease {
  project: string; deploymentTarget?: { fleetDir: string; unit: string }; owner: ReleaseOwner; fence: number; acquiredAt: number; expiresAt: number;
}
interface StoredLease extends ReleaseLease { tokenHash: string }
interface State { version: 1; projects: Record<string, { fence: number; lease?: StoredLease }> }
export interface ReleaseProof { owner: ReleaseOwner; fence: number; token: string }
const sameOwner = (a: ReleaseOwner, b: ReleaseOwner) => a.hostId === b.hostId && a.harness === b.harness && a.nativeSessionId === b.nativeSessionId;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const publicLease = (lease: StoredLease): ReleaseLease => {
  const { tokenHash: _, ...safe } = lease; return safe;
};

/** One authority file on the release host. Shared by all local MCP processes.
 * The capability is returned once, never in status. This is coordination, not OS access control. */
export class ProjectReleaseLeaseStore {
  constructor(
    readonly file = process.env.AGENT_HERDER_RELEASE_LEASES || join(homedir(), ".local/state/agent-herder/project-release-leases.json"),
    readonly now: () => number = Date.now,
  ) {}
  private async transaction<T>(fn: (state: State) => T | Promise<T>): Promise<T> {
    await mkdir(dirname(this.file), { recursive: true });
    const unlock = await lockfile.lock(this.file, { realpath: false, stale: 30000, retries: { retries: 30, minTimeout: 10, maxTimeout: 100 } });
    try {
      let state: State;
      try { state = JSON.parse(await readFile(this.file, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; state = { version: 1, projects: {} }; }
      if (state.version !== 1 || !state.projects || typeof state.projects !== "object") throw new Error("release_lease_state_invalid");
      const result = await fn(state);
      const temp = this.file + "." + randomBytes(8).toString("hex") + ".tmp";
      await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
      await rename(temp, this.file);
      return result;
    } finally { await unlock(); }
  }
  /** Probe the same OS lock held for the complete rollout, including cleanup.
   * Called under the short ledger lock. Python waits for that ledger lock after
   * taking its OS lock, so no admitted mutation can race initial admission. */
  private deploying(lease?: Pick<ReleaseLease, "deploymentTarget">): boolean {
    if (!lease?.deploymentTarget) return false;
    const path = join(dirname(this.file), "deploy-unit-" + hash(lease.deploymentTarget.unit) + ".lock");
    const result = execFileSync("python3", ["-c", [
      "import os,fcntl,sys",
      "fd=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600)",
      "try:",
      " fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)",
      " print('free')",
      "except BlockingIOError: print('busy')",
      "finally: os.close(fd)",
    ].join("\n"), path], { encoding: "utf8", timeout: 5000 }).trim();
    if (result !== "busy" && result !== "free") throw new Error("release_deployment_lock_probe_failed");
    return result === "busy";
  }
  private retire(value: { lease?: StoredLease }) {
    if (this.deploying(value.lease)) {
      // Preserve the fence for this rollout's conditional cleanup. Expiry asks
      // it to abort; another session cannot acquire until the OS lock closes.
      value.lease!.expiresAt = Math.min(value.lease!.expiresAt, this.now());
    } else delete value.lease;
  }
  private live(state: State, project: string) {
    const lease = state.projects[project]?.lease;
    return lease && lease.expiresAt > this.now() ? lease : undefined;
  }
  private ttl(seconds: number) {
    if (!Number.isInteger(seconds) || seconds < 30 || seconds > 1800) throw new Error("release_lease_ttl_invalid");
    return seconds * 1000;
  }
  private require(state: State, project: string, proof: ReleaseProof): StoredLease {
    const lease = this.live(state, project);
    if (!lease || lease.fence !== proof.fence || !sameOwner(lease.owner, proof.owner) || lease.tokenHash !== hash(proof.token)) throw new Error("release_lease_not_owned_or_expired");
    return lease;
  }
  async acquire(project: string, owner: ReleaseOwner, ttlSeconds = 300, deploymentTarget?: { fleetDir: string; unit: string }) {
    const ttl = this.ttl(ttlSeconds);
    return this.transaction(state => {
      const previous = state.projects[project]?.lease;
      const held = this.live(state, project) || (this.deploying(previous) ? previous : undefined);
      if (held) return { acquired: false as const, lease: publicLease(held), remainingSeconds: Math.max(0, Math.ceil((held.expiresAt - this.now()) / 1000)) };
      if (deploymentTarget && this.deploying({ deploymentTarget })) throw new Error("release_target_deployment_in_progress");
      const token = randomBytes(32).toString("hex");
      const fence = (state.projects[project]?.fence || 0) + 1;
      const lease: StoredLease = { project, ...(deploymentTarget ? { deploymentTarget } : {}), owner, fence, acquiredAt: this.now(), expiresAt: this.now() + ttl, tokenHash: hash(token) };
      state.projects[project] = { fence, lease };
      return { acquired: true as const, lease: publicLease(lease), token };
    });
  }
  async status(project: string) {
    return this.transaction(state => {
      const previous = state.projects[project]?.lease;
      const deploymentInProgress = this.deploying(previous);
      const lease = this.live(state, project) || (deploymentInProgress ? previous : undefined);
      return { deploymentInProgress, lease: lease ? publicLease(lease) : null, remainingSeconds: lease ? Math.max(0, Math.ceil((lease.expiresAt - this.now()) / 1000)) : 0,
        nextFence: (state.projects[project]?.fence || 0) + 1,
        contact: lease ? { tool: "SendMessage", hostId: lease.owner.hostId, harness: lease.owner.harness, sessionId: lease.owner.nativeSessionId } : null };
    });
  }
  async renew(project: string, proof: ReleaseProof, ttlSeconds = 300) {
    const ttl = this.ttl(ttlSeconds);
    return this.transaction(state => { const lease = this.require(state, project, proof); lease.expiresAt = this.now() + ttl; return publicLease(lease); });
  }
  async release(project: string, proof: ReleaseProof) {
    return this.transaction(state => { this.require(state, project, proof); this.retire(state.projects[project]!); return { released: true }; });
  }
  async check(project: string, proof: ReleaseProof) {
    return this.transaction(state => publicLease(this.require(state, project, proof)));
  }
  /** Called only by the existing trusted lifecycle controller, not exposed as a public bulk-release tool.
   * Timestamp limits prevent a delayed end event releasing a newer acquisition. */
  async endSession(owner: ReleaseOwner, endedAt: number) {
    return this.transaction(state => {
      let released = 0;
      for (const value of Object.values(state.projects)) {
        if (value.lease && sameOwner(value.lease.owner, owner) && value.lease.acquiredAt <= endedAt) { this.retire(value); released++; }
      }
      return { released };
    });
  }
}
export const projectReleaseLeases = new ProjectReleaseLeaseStore();

/** Missing/invalid event timestamps cannot prove which session generation ended. */
export function terminalReleaseAt(value: unknown, now = Date.now()): number | null {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) && at <= now ? at : null;
}
