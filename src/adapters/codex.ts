import { HarnessAdapter, AgentSession, SendMessageOptions, SetPermissionsOptions } from "../types/index.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);

interface CodexSessionData {
  prompt?: string;
  title?: string;
  cwd?: string;
  model?: string;
  updatedAt?: string;
  createdAt?: string;
  messageCount?: number;
  costUsd?: number;
  messages?: Array<{ role?: string; content?: string }>;
}

/**
 * Codex CLI adapter.
 *
 * Codex stores state in ~/.codex/sessions/*.json
 * We interact via CLI commands for session listing and direct invocation for messages.
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
          const data: CodexSessionData = JSON.parse(await readFile(filePath, "utf-8"));
          const sessionId = basename(file, ".json");

          // Extract last message from session data
          let lastMessage: string | undefined;
          if (Array.isArray(data.messages) && data.messages.length > 0) {
            const last = data.messages[data.messages.length - 1];
            if (last.content && typeof last.content === "string") {
              lastMessage = last.content.length > 300
                ? last.content.slice(0, 300) + "..."
                : last.content;
            }
          }

          sessions.push({
            id: sessionId,
            harness: "codex",
            status: runningPids.has(sessionId) ? "running" : "stopped",
            title: data.prompt?.slice(0, 120) || data.title || "Untitled session",
            cwd: data.cwd || process.cwd(),
            lastActivity: data.updatedAt || data.createdAt || (await stat(filePath)).mtime.toISOString(),
            model: data.model || this.detectModelFromContent(data),
            needsPermission: false,
            messageCount: data.messageCount ?? (data.messages?.length),
            costUsd: data.costUsd,
            durationSec: data.createdAt
              ? (Date.now() - new Date(data.createdAt).getTime()) / 1000
              : undefined,
            lastMessage,
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

  async changeModel(_sessionId: string, model: string): Promise<{ ok: boolean; error?: string }> {
    // Codex uses --model flag at launch. Can't change mid-session.
    // Update the global config file if it exists.
    const configFile = join(this.codexDir, "config.json");
    try {
      const config = JSON.parse(await readFile(configFile, "utf-8")) as Record<string, unknown>;
      config.model = model;
      const { writeFile } = await import("node:fs/promises");
      await writeFile(configFile, JSON.stringify(config, null, 2));
      return {
        ok: true,
        error: `Default model updated to '${model}' in ${configFile}. Applies to new sessions only.`,
      };
    } catch {
      return {
        ok: false,
        error: `Codex cannot change model for existing sessions. Start new sessions with --model ${model} or update ~/.codex/config.json.`,
      };
    }
  }

  async listModels(): Promise<string[]> {
    // Codex uses OpenAI model names
    return [
      "o4-mini",
      "o3",
      "o3-mini",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "gpt-4o",
      "gpt-4o-mini",
      "codex-mini",
    ];
  }

  async getTranscript(id: string): Promise<string | null> {
    const sessionsDir = join(this.codexDir, "sessions");
    const filePath = join(sessionsDir, `${id}.json`);
    try {
      const data: CodexSessionData = JSON.parse(await readFile(filePath, "utf-8"));
      if (!Array.isArray(data.messages) || data.messages.length === 0) return null;

      const parts: string[] = [];
      for (const msg of data.messages) {
        const role = msg.role || "unknown";
        if (typeof msg.content === "string" && msg.content.trim()) {
          parts.push(`${role}: ${msg.content.slice(0, 2000)}`);
        }
      }
      return parts.join("\n\n") || null;
    } catch {
      return null;
    }
  }

  // ---- Internal ----

  /**
   * Try to detect the model from the session content if not explicitly set.
   */
  private detectModelFromContent(data: CodexSessionData): string | undefined {
    // Check if messages contain model info in system prompt
    if (Array.isArray(data.messages)) {
      for (const msg of data.messages) {
        if (msg.role === "system" && typeof msg.content === "string") {
          const modelMatch = msg.content.match(/model[:\s]+([a-zA-Z0-9._-]+)/i);
          if (modelMatch) return modelMatch[1];
        }
      }
    }
    return undefined;
  }

  private async getRunningCodexPids(): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    try {
      const { stdout } = await execFileAsync("pgrep", ["-af", "codex"], { timeout: 5000 });
      for (const line of stdout.split("\n")) {
        const match = line.match(/^(\d+)\s+/);
        if (match) {
          result.set(`pid-${match[1]}`, parseInt(match[1], 10));
        }
      }
    } catch {
      // no matches
    }
    return result;
  }
}