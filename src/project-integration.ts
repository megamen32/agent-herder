import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { projectReleaseLeases, terminalReleaseAt, type ProjectReleaseLeaseStore, type ReleaseOwner, type ProjectIntegration } from "./project-release-lease.js";
import type { ResumeAfterService } from "./resume-after.js";

const run = promisify(execFile);
export async function integrationProject(cwd: string) {
  const canonical = await realpath(cwd);
  const { stdout } = await run("git", ["-C", canonical, "rev-parse", "--git-common-dir"], { timeout: 5000 });
  return { project: await realpath(resolve(canonical, stdout.trim())), cwd: canonical };
}
export type IntegrationWake = (input: Parameters<ResumeAfterService["register"]>[0]) => ReturnType<ResumeAfterService["register"]>;

/** Bounded existing-hook continuation, no scanner or new permanent background worker. */
export async function recordProjectLifecycle(
  input: { harness: string; sessionId: string; cwd?: string; event: string; at?: unknown },
  wake?: IntegrationWake,
  store: ProjectReleaseLeaseStore = projectReleaseLeases,
) {
  if (!input.cwd || !["start", "turn-start", "turn-end", "end", "abort", "error", "killed"].includes(input.event)) return;
  const { project, cwd } = await integrationProject(input.cwd);
  const owner: ReleaseOwner = { hostId: hostname(), harness: input.harness, nativeSessionId: input.sessionId };
  const terminal = ["end", "abort", "error", "killed"].includes(input.event);
  const at = terminalReleaseAt(input.at);
  const accepted = await store.projectLifecycle(project, owner, cwd, terminal ? "ended" : "active", terminal ? at : at ?? Date.now());
  if (!terminal || !accepted.accepted) return;
  const { inventoryProjectWorktrees } = await import("./project-worktree-inventory.js");
  const inventory = await inventoryProjectWorktrees(cwd, "main").catch(error => ({ project, target: "main", error: String(error).slice(0, 1000), worktrees: [] }));
  const fingerprint = createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
  const prepared = await store.prepareIntegration(project, owner, fingerprint, inventory);
  const item = prepared.integration;
  if (!item || item.state !== "pending" || item.wakeId || !wake) return item;
  return scheduleIntegration(project, item, wake, store);
}

async function scheduleIntegration(project: string, item: ProjectIntegration, wake: IntegrationWake, store: ProjectReleaseLeaseStore) {
  // Stable request identity makes registration recoverable if the process dies
  // between scheduling and persisting the receipt. Human-stop remains authoritative.
  const registered = await wake({ owner: { harness: item.owner.harness, sessionId: item.owner.nativeSessionId },
    requestId: item.id, trigger: { kind: "delay", delayMs: 1000 },
    message: [
      "Project integration follow-up " + item.id + " for " + project + ".",
      "The registered project workers ended; inspect project_integration status and freshly inventory worktrees.",
      "Acquire a project release lease and claim this follow-up atomically before integration.",
      "Integrate known task branches via PRs with the required specific merge authorization, verify the whole project.",
      "Clean only merged, clean, confirmed-inactive linked worktrees with exact HEAD checks; keep branches recoverable.",
      "Unknown, active, dirty, conflicted or unmerged artifacts remain visible blockers. Do not force merge/reset/remove.",
      "Finish this bounded follow-up with verification evidence or blockers; do not start an endless polling loop.",
    ].join("\n"),
  });
  await store.integrationWake(project, item.id, registered.id);
  return item;
}


/** One bounded pass over known durable records at the existing runtime startup.
 * Existing resume_after handles idempotency, receipts and human-stop, not a new daemon. */
export async function resumePendingProjectIntegrations(wake: IntegrationWake, store: ProjectReleaseLeaseStore = projectReleaseLeases) {
  const pending = await store.pendingIntegrations(32);
  const results = [];
  for (const {project, integration} of pending) {
    try { await scheduleIntegration(project, integration, wake, store); results.push({id:integration.id,scheduled:true}); }
    catch { results.push({id:integration.id,scheduled:false}); }
  }
  return results;
}
