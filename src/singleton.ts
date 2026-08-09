import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

function lockPath(): string {
  const runtime = process.env.AGENT_HERDER_SINGLETON_LOCK
    || (process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, "agent-herder", "agent-herder.lock") : join(tmpdir(), `agent-herder-${process.getuid?.() ?? "unknown"}.lock`));
  return runtime;
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Hold one per-user lock for the lifetime of this Agent Herder process. */
export function acquireAgentHerderSingleton(): () => void {
  const path = lockPath();
  mkdirForLock(path);
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    if (pidIsAlive(owner)) throw new Error(`Agent Herder singleton already running (pid ${owner})`);
    unlinkSync(path);
    fd = openSync(path, "wx", 0o600);
  }
  writeFileSync(fd, `${process.pid}\n`, "utf8");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    closeSync(fd);
    try {
      if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path);
    } catch {
      // The runtime directory may disappear during shutdown.
    }
  };
}

function mkdirForLock(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}
