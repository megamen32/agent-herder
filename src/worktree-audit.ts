import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const execFileAsync = promisify(execFile);

export interface WorktreeProcess {
  pid: number;
  parentPid?: number;
  harness: "opencode" | "claude" | "codex" | "unknown";
  cwd: string;
  command: string;
}

export interface WorktreeLock {
  reason?: string;
  pid?: number;
  pidStatus: "not_recorded" | "not_running" | "running";
  process?: WorktreeProcess;
}

export interface WorktreeAuditEntry {
  path: string;
  branch?: string;
  head: string;
  dirtyFiles: string[];
  lock?: WorktreeLock;
  activeAgents: WorktreeProcess[];
}

interface ParsedWorktree {
  path: string;
  branch?: string;
  head: string;
  locked: boolean;
  lockReason?: string;
}

/**
 * Inspect Git worktrees and correlate their locks and working directories with
 * live Claude, Codex, and OpenCode processes. This is intentionally read-only.
 */
export async function auditWorktrees(repoPath: string, includeClean = false): Promise<WorktreeAuditEntry[]> {
  const resolvedRepo = resolve(repoPath);
  const [worktrees, processes] = await Promise.all([
    readWorktrees(resolvedRepo),
    readAgentProcesses(),
  ]);
  const processesByPid = new Map(processes.map((process) => [process.pid, process]));

  const entries = await Promise.all(worktrees.map(async (worktree) => {
    const dirtyFiles = await readDirtyFiles(worktree.path);
    const activeAgents = processes.filter((process) =>
      isWithin(worktree.path, process.cwd)
    );

    const lock = !worktree.locked
      ? undefined
      : buildLock(worktree.lockReason, processesByPid);

    return {
      path: worktree.path,
      branch: worktree.branch,
      head: worktree.head,
      dirtyFiles,
      lock,
      activeAgents,
    } satisfies WorktreeAuditEntry;
  }));

  return includeClean
    ? entries
    : entries.filter((entry) => entry.dirtyFiles.length > 0 || entry.lock !== undefined || entry.activeAgents.length > 0);
}

async function readWorktrees(repoPath: string): Promise<ParsedWorktree[]> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, "worktree", "list", "--porcelain"], {
    maxBuffer: 1024 * 1024,
  });
  const records: ParsedWorktree[] = [];
  let current: ParsedWorktree | undefined;

  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) records.push(current);
      current = { path: line.slice("worktree ".length), head: "", locked: false };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
      current.lockReason = line.slice("locked".length).trim() || undefined;
    }
  }
  if (current) records.push(current);
  return records;
}

async function readDirtyFiles(worktreePath: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", [
    "-C", worktreePath, "status", "--porcelain=v1", "--untracked-files=all",
  ], { maxBuffer: 1024 * 1024 });
  return stdout.split("\n").filter(Boolean);
}

function buildLock(reason: string | undefined, processesByPid: Map<number, WorktreeProcess>): WorktreeLock {
  const pidMatch = reason?.match(/\bpid\s+(\d+)\b/i);
  const pid = pidMatch ? Number(pidMatch[1]) : undefined;
  const process = pid === undefined ? undefined : processesByPid.get(pid);

  return {
    reason: reason || undefined,
    pid,
    pidStatus: pid === undefined ? "not_recorded" : process ? "running" : "not_running",
    process,
  };
}

async function readAgentProcesses(): Promise<WorktreeProcess[]> {
  let entries;
  try {
    entries = await readdir("/proc", { withFileTypes: true });
  } catch {
    return [];
  }

  const processes = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map(async (entry) => {
      const pid = Number(entry.name);
      try {
        const [commandLine, cwd, status] = await Promise.all([
          readFile(`/proc/${pid}/cmdline`),
          readlink(`/proc/${pid}/cwd`),
          readFile(`/proc/${pid}/status`, "utf8"),
        ]);
        const command = commandLine.toString().replaceAll("\0", " ").trim();
        const harness = classifyHarness(command);
        if (!harness) return undefined;
        const parentPid = status.match(/^PPid:\s+(\d+)/m)?.[1];
        const process: WorktreeProcess = {
          pid,
          harness,
          cwd: resolve(cwd),
          command,
        };
        if (parentPid) process.parentPid = Number(parentPid);
        return process;
      } catch {
        return undefined;
      }
    }));

  return processes.filter((process): process is WorktreeProcess => process !== undefined);
}

function classifyHarness(command: string): Exclude<WorktreeProcess["harness"], "unknown"> | undefined {
  if (/(?:^|[\/\s])opencode(?:\s|$)/i.test(command)) return "opencode";
  if (/(?:^|[\/\s])claude(?:\s|$)/i.test(command)) return "claude";
  if (/(?:^|[\/\s])codex(?:\s|$)/i.test(command)) return "codex";
  return undefined;
}

function isWithin(root: string, candidate: string): boolean {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  if (rootPath === candidatePath) return true;
  const relativePath = relative(rootPath, candidatePath);
  if (isAbsolute(relativePath)) return false;
  return relativePath !== ".." && !relativePath.startsWith(".." + "/");
}
