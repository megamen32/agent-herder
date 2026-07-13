import { HarnessAdapter, AgentSession, SendMessageOptions, SetPermissionsOptions } from "../types/index.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);

/**
 * Claude Code adapter — uses CLI commands and session files on disk.
 *
 * Claude Code stores sessions in ~/.claude/projects/<hash>/sessions/<id>.jsonl
 * The adapter uses `claude --list-sessions` and `claude -p` for interactions.
 */
export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly type = "claude" as const;
  readonly name = "Claude Code";

  private claudeBin: string;

  constructor(config: { claudeBin?: string } = {}) {
    this.claudeBin = config.claudeBin || process.env.CLAUDE_BIN || "claude";
  }

  async init(): Promise<void> {
    try {
      await execFileAsync(this.claudeBin, ["--version"], { timeout: 10000 });
    } catch {
      throw new Error(
        `'${this.claudeBin}' not found or not executable. Make sure Claude Code CLI is installed.`
      );
    }
  }

  async listSessions(): Promise<AgentSession[]> {
    const sessions = await this.listSessionsFromDisk();
    // Check which claude processes are actually running
    const runningPids = await this.getRunningClaudePids();

    return sessions.map((s) => ({
      ...s,
      status: runningPids.has(s.id) ? ("running" as const) : ("stopped" as const),
    }));
  }

  async getSession(id: string): Promise<AgentSession | null> {
    const all = await this.listSessions();
    return all.find((s) => s.id === id) || null;
  }

  async sendMessage(id: string, options: SendMessageOptions): Promise<{ ok: boolean; error?: string }> {
    // Find the session's working directory
    const session = await this.getSession(id);
    if (!session) return { ok: false, error: `Session ${id} not found` };

    const args = [
      "-p",
      options.message,
      "--resume",
      id,
      "--output-format",
      "json",
    ];

    if (options.queue) {
      // Fire-and-forget: spawn detached
      const { spawn } = await import("node:child_process");
      const child = spawn(this.claudeBin, args, {
        cwd: session.cwd,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return { ok: true };
    }

    // Synchronous: wait for output
    try {
      await execFileAsync(this.claudeBin, args, {
        cwd: session.cwd,
        timeout: 300000, // 5 min
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async stopSession(id: string): Promise<{ ok: boolean; error?: string }> {
    // Find the process associated with this session and kill it
    const runningPids = await this.getRunningClaudePids();
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
    // Claude Code CLI doesn't expose a permission-response API from outside the TTY session.
    // Permissions are handled in the interactive session or via --allowedTools.
    return {
      ok: false,
      error: "Claude Code CLI does not support remote permission response. Use --allowedTools when starting the session, or use the Agent SDK with a custom permission callback.",
    };
  }

  async setPermissions(_sessionId: string, options: SetPermissionsOptions): Promise<{ ok: boolean; error?: string }> {
    // Claude Code permissions are set at launch time, not per-session.
    // Return info about how to do it.
    if (options.allowedTools || options.mode) {
      return {
        ok: false,
        error:
          "Claude Code permissions are set at launch time. Use --allowedTools flag (e.g. 'claude -p \"task\" --allowedTools \"Read,Edit,Bash\"') or configure in .claude/settings.json.",
      };
    }
    return { ok: true };
  }

  // ---- Internal helpers ----

  private async listSessionsFromDisk(): Promise<Omit<AgentSession, "status">[]> {
    const claudeDir = join(homedir(), ".claude");
    const projectsDir = join(claudeDir, "projects");

    const sessions: Omit<AgentSession, "status">[] = [];

    try {
      const projectHashes = await readdir(projectsDir);
      for (const hash of projectHashes) {
        const sessionDir = join(projectsDir, hash, "sessions");
        try {
          const files = await readdir(sessionDir);
          for (const file of files) {
            if (!file.endsWith(".jsonl")) continue;
            const sessionId = file.replace(".jsonl", "");
            const filePath = join(sessionDir, file);

            try {
              const info = await this.parseSessionFile(filePath, hash);
              sessions.push({
                id: sessionId,
                harness: "claude",
                title: info.title,
                cwd: info.cwd,
                lastActivity: info.lastActivity,
                model: info.model,
                needsPermission: false,
                messageCount: info.messageCount,
                meta: { projectHash: hash, filePath },
              });
            } catch {
              // Skip corrupt/unreadable session files
            }
          }
        } catch {
          // No sessions dir for this project
        }
      }
    } catch {
      // No projects dir at all
    }

    // Sort by last activity, most recent first
    sessions.sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
    return sessions;
  }

  private async parseSessionFile(
    filePath: string,
    projectHash: string
  ): Promise<{ title: string; cwd: string; lastActivity: string; model?: string; messageCount: number }> {
    // Read just the first few lines for metadata (JSONL format)
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    let title = "Untitled session";
    let model: string | undefined;
    let messageCount = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        messageCount++;
        // Extract title from first user message
        if (!title && entry.type === "human" && entry.message?.content) {
          const c = Array.isArray(entry.message.content)
            ? entry.message.content.find((b: { type: string; text?: string }) => b.type === "text")
            : entry.message.content;
          if (c?.text) {
            title = c.text.slice(0, 120);
          }
        }
        // Extract model
        if (!model && entry.model) {
          model = entry.model;
        }
      } catch {
        // skip bad lines
      }
    }

    // Get the working directory from project path mapping
    // Claude stores project paths in ~/.claude/projects/<hash>/project.json or similar
    let cwd = process.cwd();
    try {
      const projectFile = join(dirname(dirname(filePath)), "project.json");
      const proj = JSON.parse(await readFile(projectFile, "utf-8"));
      if (proj.path) cwd = proj.path;
    } catch {
      // fallback
    }

    const stat = await import("node:fs/promises").then((fs) => fs.stat(filePath));
    return {
      title,
      cwd,
      lastActivity: stat.mtime.toISOString(),
      model,
      messageCount,
    };
  }

  private async getRunningClaudePids(): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    try {
      const { stdout } = await execFileAsync("pgrep", ["-af", "claude"], { timeout: 5000 });
      for (const line of stdout.split("\n")) {
        const match = line.match(/^(\d+)\s+.*claude.*--session\s+(\S+)/);
        if (match) {
          result.set(match[2], parseInt(match[1], 10));
        }
        // Also try to match resume id
        const matchResume = line.match(/^(\d+)\s+.*claude.*--resume\s+(\S+)/);
        if (matchResume) {
          result.set(matchResume[2], parseInt(matchResume[1], 10));
        }
      }
    } catch {
      // pgrep returns non-zero if no matches, that's fine
    }
    return result;
  }
}