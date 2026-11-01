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
}
