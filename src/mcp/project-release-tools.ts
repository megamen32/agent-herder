import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { hostname } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { projectReleaseLeases, type ProjectReleaseLeaseStore } from "../project-release-lease.js";

const run = promisify(execFile);
/** All worktrees of a repository share its git common directory. */
export async function releaseProject(cwd: string): Promise<string> {
  const path = await realpath(cwd);
  const { stdout } = await run("git", ["-C", path, "rev-parse", "--git-common-dir"], { timeout: 5000 });
  return realpath(resolve(path, stdout.trim()));
}
const ownerSchema = z.object({ hostId: z.string().min(1).max(256), harness: z.string().min(1).max(64), nativeSessionId: z.string().min(1).max(256) }).strict();
const schema = z.object({
  action: z.enum(["acquire", "renew", "release", "status", "check"]),
  cwd: z.string().min(1).max(4096),
  owner: ownerSchema.optional(),
  ttlSeconds: z.number().int().min(30).max(1800).optional(),
  deploymentTarget: z.object({ fleetDir: z.string().min(1).max(4096), unit: z.string().regex(/^[A-Za-z0-9_.@-]+$/) }).strict().optional(),
  token: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  fence: z.number().int().positive().optional(),
}).strict();
export function registerProjectReleaseTools(server: McpServer, store: ProjectReleaseLeaseStore = projectReleaseLeases) {
  server.registerTool("project_release_lease", {
    description: "Acquire/renew/release/check an exclusive project release lease on this authority host, or inspect holder session and remaining TTL to contact it through existing SendMessage. Worktrees share one project key. Owner is attribution under existing MCP authorization, not authentication. Acquisition returns a short-lived ownership capability once; do not publish it. Renew before expiry and use token+fence at the final deployment boundary. No command execution, merge, or deployment is authorized by a lease.",
    inputSchema: schema,
  }, async args => {
    const project = await releaseProject(args.cwd);
    let result: unknown;
    if (args.action === "status") result = await store.status(project);
    else {
      if (!args.owner) throw new Error("release_lease_owner_required");
      if (args.owner.hostId !== hostname()) throw new Error("release_lease_use_owner_authority_host");
      if (args.action === "acquire") {
        const target = args.deploymentTarget ? { fleetDir: await realpath(args.deploymentTarget.fleetDir), unit: args.deploymentTarget.unit } : undefined;
        result = await store.acquire(project, args.owner, args.ttlSeconds, target);
      }
      else {
        if (!args.token || !args.fence) throw new Error("release_lease_proof_required");
        const proof = { owner: args.owner, token: args.token, fence: args.fence };
        result = args.action === "renew" ? await store.renew(project, proof, args.ttlSeconds)
          : args.action === "release" ? await store.release(project, proof) : await store.check(project, proof);
      }
    }
    return { content: [{ type: "text" as const, text: JSON.stringify({ authorityHost: hostname(), project, ...result as object }) }] };
  });
  server.registerTool("project_integration", {
    description: "Inspect durable last-worker integration follow-up and project worktrees. Claim under an owned release lease, integrate known changes via authorized PRs, verify the whole project, then finish with evidence/blockers. Cleanup removes only exact merged clean inactive linked worktrees, never branches or unknown/active/dirty artifacts. No merge authorization is granted.",
    inputSchema: z.object({
      action: z.enum(["status", "inventory", "claim", "finish", "cleanup"]),
      cwd: z.string().min(1), target: z.string().min(1).default("main"),
      owner: ownerSchema.optional(), token: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      fence: z.number().int().positive().optional(), integrationId: z.string().optional(),
      path: z.string().optional(), expectedHead: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
      blockers: z.array(z.string().max(2000)).max(100).optional(), verification: z.string().min(1).max(8000).optional(),
    }).strict(),
  }, async args => {
    const project = await releaseProject(args.cwd);
    const { inventoryProjectWorktrees, cleanupProjectWorktree } = await import("../project-worktree-inventory.js");
    let result: unknown;
    if (args.action === "status") result = await store.integrationStatus(project);
    else if (args.action === "inventory") result = await inventoryProjectWorktrees(args.cwd, args.target);
    else {
      if (!args.owner || args.owner.hostId !== hostname() || !args.token || !args.fence || !args.integrationId)
        throw new Error("project_integration_local_owner_proof_required");
      const proof = { owner: args.owner, token: args.token, fence: args.fence };
      if (args.action === "claim") result = await store.claimIntegration(project, proof, args.integrationId);
      else if (args.action === "finish") {
        if (!args.verification) throw new Error("project_integration_verification_evidence_required");
        result = await store.finishIntegration(project, proof, args.integrationId, args.blockers || [], args.verification);
      } else {
        if (!args.path || !args.expectedHead) throw new Error("project_integration_exact_worktree_required");
        const path = await realpath(args.path);
        result = await store.withIntegrationCleanup(project, proof, args.integrationId, path,
          () => cleanupProjectWorktree(args.cwd, { path, expectedHead: args.expectedHead!, target: args.target, verifiedInactive: true }), args.target);
      }
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
