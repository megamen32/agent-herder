import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_AUDIT_SCRIPT = join(homedir(), ".local", "bin", "codex-session-audit");

function errorDetail(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  const message = error instanceof Error ? error.message : "";
  return (stderr || message).trim().replace(/\s+/g, " ").slice(0, 500);
}

/** Render the existing local Codex session graph generator into an HTML response. */
export async function renderCodexSessionGraph(sessionId: string): Promise<string> {
  if (sessionId.trim().length === 0 || sessionId.length > 512) {
    throw new Error("session id must be a bounded non-empty string");
  }

  const workspace = await mkdtemp(join(tmpdir(), "agent-herder-session-graph-"));
  const graphPath = join(workspace, "session-graph.html");
  const python = process.env.AGENT_HERDER_CODEX_AUDIT_PYTHON || "python3";
  const script = process.env.AGENT_HERDER_CODEX_SESSION_AUDIT || DEFAULT_AUDIT_SCRIPT;
  try {
    await execFileAsync(python, [script, "--id", sessionId, "--graph", graphPath, "--trace-only"], {
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return await readFile(graphPath, "utf8");
  } catch (error) {
    const detail = errorDetail(error);
    throw new Error(detail ? `Session visualization failed: ${detail}` : "Session visualization failed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
