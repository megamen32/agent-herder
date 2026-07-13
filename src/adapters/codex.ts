import { HarnessAdapter, AgentSession, SendMessageOptions, SetPermissionsOptions } from "../types/index.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir, tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

/**
 * Codex CLI adapter.
 *
 * Codex can run as an MCP server itself (`codex -m <model> -c ...`).
 * We interact via:
 *   - CLI commands for session listing (codex stores state in ~/.codex/)
 *   - Direct CLI invocation for sending messages
 *
 * Prerequisites:
 *   - `codex` CLI installed
 *   - OPENAI_API_KEY set
 */
export class CodexAdapter implements HarnessAdapter {
  readonly type = "codex" as const;
  readonly name = "Codex CLI";

  private codexBin: string;
  private codexDir: string;

  constructor(config: { codexBin?: string; codexDir?: string } = {}) {
    this.codexBin = config.codexBin || process.env.CODEX_BIN || "codex";
    this.codexDir = config.codexDir || process.env.CODEX_DATA_DIR || join(homedir(), ".codex");
  }

  async init(): Promise<void> {
    try {
      await execFileAsync(this.codexBin, ["--version"], { timeout: 10000 });
    } catch {
      throw new Error(
        `'${this.codexBin}' not found or not executable. Make sure Codex CLI is installed.`
      );
    }
  }

  async listSessions(): Promise<AgentSession[]> {
    const sessionsDir = join(this.codexDir, "sessions");
    const sessions: AgentSession[] = [];
    const runningPids = await this.getRunningCodexPids();

    try {
      const files = await readdir(sessionsDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const filePath = join(sessionsDir, file);
        try {
          const data = JSON.parse(await readFile(filePath, "utf-8"));
          const sessionId = basename(file, ".json");

          sessions.push({
            id: sessionId,
            harness: "codex",
            status: runningPids.has(sessionId) ? "running" : "stopped",
            title: data.prompt?.slice(0, 120) || data.title || "Untitled session",
            cwd: data.cwd || process.cwd(),
            lastActivity: data.updatedAt || data.createdAt || (await stat(filePath)).mtime.toISOString(),
            model: data.model,
            needsPermission: false,
            messageCount: data.messageCount,
            costUsd: data.costUsd,
            durationSec: data.createdAt
              ? (Date.now() - new Date(data.createdAt).getTime()) / 1000
              : undefined,
            meta: { filePath },
          });
        } catch {
          // skip
        }
      }
    } catch {
      // no sessions dir
    }

    sessions.sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
    return sessions;
  }

  async getSession(id: string): Promise<AgentSession | null> {
    const all = await this.listSessions();
    return all.find((s) => s.id === id) || null;
  }

  async sendMessage(id: string, options: SendMessageOptions): Promise<{ ok: boolean; error?: string }> {
    const session = await this.getSession(id);
    if (!session) return { ok: false, error: `Session ${id} not found` };

    const args = [
      "--full-auto",
      options.message,
      "--cwd",
      session.cwd,
    ];

    if (options.queue) {
      const { spawn } = await import("node:child_process");
      const child = spawn(this.codexBin, args, {
        cwd: session.cwd,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return { ok: true };
    }

    try {
      await execFileAsync(this.codexBin, args, {
        cwd: session.cwd,
        timeout: 300000,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async stopSession(id: string): Promise<{ ok: boolean; error?: string }> {
    const runningPids = await this.getRunningCodexPids();
    const pid = runningPids.get(id);
    if (!pid) return { ok: false, error: `No running process found for session ${id}` };

    try {
      process.kill(pid, "SIGTERM");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async respondPermission(
    _sessionId: string,
    _permissionId: string,
    _response: "allow" | "deny",
    _remember?: boolean
  ): Promise<{ ok: boolean; error?: string }> {
    return {
      ok: false,
      error: "Codex CLI does not support remote permission response. Use --full-auto or --approve-tools flags when starting.",
    };
  }

  async setPermissions(_sessionId: string, options: SetPermissionsOptions): Promise<{ ok: boolean; error?: string }> {
    if (options.allowedTools || options.mode) {
      return {
        ok: false,
        error:
          "Codex CLI permissions are set at launch time. Use --full-auto, --approve-tools, or --suggest flags.",
      };
    }
    return { ok: true };
  }

  // ---- Internal ----

  private async getRunningCodexPids(): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    try {
      const { stdout } = await execFileAsync("pgrep", ["-af", "codex"], { timeout: 5000 });
      for (const line of stdout.split("\n")) {
        // codex doesn't expose session ID in cmdline easily,
        // so we track PIDs generically
        const match = line.match(/^(\d+)\s+/);
        if (match) {
          // We can't map to session ID, use process tracking
          result.set(`pid-${match[1]}`, parseInt(match[1], 10));
        }
      }
    } catch {
      // no matches
    }
    return result;
  }
}