import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const exec = promisify(execFile);
async function git(args: string[]): Promise<string> {
  return (await exec("git", args, { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
}
export interface ProjectWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  primary: boolean;
  locked: boolean;
  lockReason?: string;
  prunable: boolean;
  pruneReason?: string;
  dirty: boolean | null;
  unmerged: boolean | null;
  inspectionError?: string;
}
export interface ProjectWorktreeInventory {
  project: string;
  target: string;
  targetHead: string;
  worktrees: ProjectWorktree[];
}
/** NUL format preserves literal spaces, newlines, and Git's lock/prune reasons. */
export function parseWorktreePorcelain(raw: string): ProjectWorktree[] {
  const result: ProjectWorktree[] = [];
  let row: ProjectWorktree | undefined;
  for (const field of raw.split("\0")) {
    if (!field) { row = undefined; continue; }
    const split = field.indexOf(" ");
    const key = split < 0 ? field : field.slice(0, split);
    const value = split < 0 ? "" : field.slice(split + 1);
    if (key === "worktree") {
      row = { path: value, head: null, branch: null, detached: false, bare: false,
        primary: result.length === 0, locked: false, prunable: false, dirty: null, unmerged: null };
      result.push(row);
    } else if (row) {
      if (key === "HEAD") row.head = value;
      else if (key === "branch") row.branch = value;
      else if (key === "detached") row.detached = true;
      else if (key === "bare") row.bare = true;
      else if (key === "locked") { row.locked = true; row.lockReason = value; }
      else if (key === "prunable") { row.prunable = true; row.pruneReason = value; }
    }
  }
  return result;
}
async function projectPath(cwd: string): Promise<string> {
  const root = await realpath(cwd);
  const common = (await git(["-C", root, "rev-parse", "--git-common-dir"])).trim();
  return realpath(resolve(root, common));
}
async function targetHead(project: string, target: string): Promise<string> {
  if (!target || target.startsWith("-") || /[\0\r\n]/.test(target)) throw new Error("worktree_target_invalid");
  return (await git(["--git-dir", project, "rev-parse", "--verify", "--end-of-options", target + "^{commit}"])).trim();
}
async function listWorktrees(project: string): Promise<string> {
  try { return await git(["--git-dir", project, "worktree", "list", "--porcelain", "-z"]); }
  catch (error) {
    if ((error as { code?: number }).code !== 129) throw error;
    // Git 2.34 on existing fleet nodes predates -z. Never guess C-quoted paths:
    // plain safe records work; unusual/ambiguous paths fail closed until upgrade.
    const text = await git(["-c", "core.quotePath=true", "--git-dir", project, "worktree", "list", "--porcelain"]);
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.startsWith('worktree "') || line.includes("\0") ||
          (line && !/^(worktree \/.*|HEAD [a-f0-9]+|branch refs\/.*|detached|bare|locked(?: .*)?|prunable(?: .*)?)$/.test(line))) {
        throw new Error("worktree_requires_nul_capable_git");
      }
    }
    return lines.join("\0");
  }
}
/** Read only this repository's registered worktrees. No filesystem discovery. */
export async function inventoryProjectWorktrees(cwd: string, target: string): Promise<ProjectWorktreeInventory> {
  const project = await projectPath(cwd);
  const targetSha = await targetHead(project, target);
  const worktrees = parseWorktreePorcelain(await listWorktrees(project));
  for (const row of worktrees) {
    if (row.bare || row.prunable) continue;
    try {
      if (await projectPath(row.path) !== project) throw new Error("different_project");
      // Ignored files are also data; never silently remove them during cleanup.
      row.dirty = (await git(["-C", row.path, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"])).length > 0;
      if (!row.head) throw new Error("missing_head");
      try {
        await git(["--git-dir", project, "merge-base", "--is-ancestor", row.head, targetSha]);
        row.unmerged = false;
      } catch (error) {
        if ((error as { code?: number }).code !== 1) throw error;
        row.unmerged = true;
      }
    } catch {
      row.inspectionError = "worktree_inspection_failed";
    }
  }
  return { project, target, targetHead: targetSha, worktrees };
}
export interface WorktreeCleanupRequest {
  path: string;
  expectedHead: string;
  target: string;
  /** Caller must establish absence of any active session/owner, not infer from Git cleanliness. */
  verifiedInactive: boolean;
  activeOwner?: string | null;
}
/** Explicit cleanup only; retains the branch and never uses force/reset/clean/prune. */
export async function cleanupProjectWorktree(cwd: string, request: WorktreeCleanupRequest) {
  if (request.verifiedInactive !== true || request.activeOwner) throw new Error("worktree_activity_not_verified");
  if (!isAbsolute(request.path) || resolve(request.path) !== request.path) throw new Error("worktree_exact_path_required");
  if (!/^[a-f0-9]{40,64}$/.test(request.expectedHead)) throw new Error("worktree_expected_head_required");
  const inventory = await inventoryProjectWorktrees(cwd, request.target);
  const row = inventory.worktrees.find(item => item.path === request.path);
  if (!row) throw new Error("worktree_not_registered_in_project");
  if (row.primary || row.bare) throw new Error("worktree_primary_forbidden");
  if (row.locked || row.prunable) throw new Error("worktree_locked_or_prunable");
  if (row.inspectionError || row.dirty !== false || row.unmerged !== false) throw new Error("worktree_not_clean_and_merged");
  if (row.head !== request.expectedHead) throw new Error("worktree_head_changed");
  // Re-read immediately at the destructive boundary. Git's own normal remove
  // additionally refuses changed/locked worktrees. Caller owns activity exclusion.
  if ((await git(["-C", row.path, "rev-parse", "HEAD"])).trim() !== request.expectedHead) throw new Error("worktree_head_changed");
  if (await targetHead(inventory.project, request.target) !== inventory.targetHead) throw new Error("worktree_target_changed");
  await git(["--git-dir", inventory.project, "worktree", "remove", "--", request.path]);
  return { removed: true as const, path: request.path, head: request.expectedHead, retainedBranch: row.branch };
}
