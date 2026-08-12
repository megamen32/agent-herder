import { HarnessAdapter, AgentSession, RawTranscriptExport, SendMessageOptions, SetPermissionsOptions } from "../types/index.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, stat, access, open } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);

interface ParsedSession {
  title: string;
  cwd: string;
  lastActivity: string;
  model?: string;
  messageCount: number;
  lastMessage?: string;
}

/**
 * Claude Code adapter — uses CLI commands and session files on disk.
 *
 * Claude Code stores current sessions in ~/.claude/projects/<hash>/<id>.jsonl;
 * older releases used ~/.claude/projects/<hash>/sessions/<id>.jsonl.
 * The adapter reads session files from disk for rich metadata extraction
 * (model, last message, transcript).
 */
export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly type = "claude" as const;
  readonly name = "Claude Code";

  private claudeBin: string;
  private claudeDir: string;

  constructor(config: { claudeBin?: string; claudeDir?: string } = {}) {
    this.claudeBin = config.claudeBin || process.env.CLAUDE_BIN || "claude";
    this.claudeDir = config.claudeDir || join(homedir(), ".claude");
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
    const runningPids = await this.getRunningClaudePids();

    return sessions.map((s) => ({
      ...s,
      status: runningPids.has(s.id) ? ("running" as const) : ("stopped" as const),
    }));
  }

  async getSession(id: string): Promise<AgentSession | null> {
    const all = await this.listSessions();
    const found = all.find((s) => s.id === id);
    if (!found) {
      const filePath = await this.findSessionFile(id);
      if (!filePath) return null;
      const parsed = await this.parseSessionFile(filePath, "");
      const runningPids = await this.getRunningClaudePids();
      return {
        id,
        harness: "claude",
        status: runningPids.has(id) ? "running" : "stopped",
        title: parsed.title,
        cwd: parsed.cwd,
        lastActivity: parsed.lastActivity,
        model: parsed.model,
        needsPermission: false,
        messageCount: parsed.messageCount,
        lastMessage: parsed.lastMessage,
        meta: { filePath },
      };
    }

    // For getSession, always try to load lastMessage if not already present
    if (!found.lastMessage) {
      const filePath = found.meta?.filePath as string | undefined;
      if (filePath) {
        try {
          const parsed = await this.parseSessionFile(filePath, "");
          found.lastMessage = parsed.lastMessage;
        } catch { /* ignore */ }
      }
    }
    return found;
  }

  async sendMessage(id: string, options: SendMessageOptions): Promise<{ ok: boolean; error?: string }> {
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
      const { spawn } = await import("node:child_process");
      const child = spawn(this.claudeBin, args, {
        cwd: session.cwd,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return { ok: true };
    }

    try {
      await execFileAsync(this.claudeBin, args, {
        cwd: session.cwd,
        timeout: 300000,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async stopSession(id: string): Promise<{ ok: boolean; error?: string }> {
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
    return {
      ok: false,
      error: "Claude Code CLI does not support remote permission response. Use --allowedTools when starting the session, or use the Agent SDK with a custom permission callback.",
    };
  }

  async setPermissions(_sessionId: string, options: SetPermissionsOptions): Promise<{ ok: boolean; error?: string }> {
    if (options.allowedTools || options.mode) {
      return {
        ok: false,
        error:
          "Claude Code permissions are set at launch time. Use --allowedTools flag (e.g. 'claude -p \"task\" --allowedTools \"Read,Edit,Bash\"') or configure in .claude/settings.json.",
      };
    }
    return { ok: true };
  }

  async changeModel(_sessionId: string, model: string): Promise<{ ok: boolean; error?: string }> {
    // Claude Code CLI doesn't support changing model mid-session.
    // Model is set at launch with --model flag or in settings.
    return {
      ok: false,
      error: `Claude Code CLI cannot change model for existing sessions. Start a new session with --model ${model} or set it in ~/.claude/settings.json under "model".`,
    };
  }

  async listModels(): Promise<string[]> {
    // Claude Code supports these common models
    return [
      "claude-sonnet-4-20250514",
      "claude-opus-4-20250115",
      "claude-3-7-sonnet-20250219",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
      "claude-3-haiku-20240307",
    ];
  }

  /**
   * Get the full transcript of a session for summarization.
   * Reads the JSONL file and extracts all text content.
   */
  async getTranscript(id: string): Promise<string | null> {
    const filePath = await this.findSessionFile(id);
    return filePath ? this.extractTranscriptText(filePath) : null;
  }

  async getRawTranscript(id: string): Promise<RawTranscriptExport | null> {
    const filePath = await this.findSessionFile(id);
    if (!filePath) return null;
    return {
      bytes: await readFile(filePath),
      complete: true,
      source: { kind: "native-file", location: filePath, format: "jsonl" },
      timestampCoverage: "native",
    };
  }

  // ---- Internal helpers ----

  private async listSessionsFromDisk(): Promise<Omit<AgentSession, "status">[]> {
    const projectsDir = join(this.claudeDir, "projects");
    const sessions: Omit<AgentSession, "status">[] = [];
    const candidates: Array<{ id: string; hash: string; filePath: string; mtimeMs: number }> = [];

    try {
      const projectHashes = await readdir(projectsDir);
      for (const hash of projectHashes) {
        const projectDir = join(projectsDir, hash);
        for (const sessionDir of [projectDir, join(projectDir, "sessions")]) {
          try {
            const files = await readdir(sessionDir, { withFileTypes: true });
            for (const file of files) {
              if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
              const filePath = join(sessionDir, file.name);
              const fileStat = await stat(filePath);
              candidates.push({ id: file.name.slice(0, -".jsonl".length), hash, filePath, mtimeMs: fileStat.mtimeMs });
            }
          } catch {
            // This Claude Code layout is absent for the project.
          }
        }
      }
    } catch {
      // No projects dir at all
    }

    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const limit = boundedPositiveInteger(process.env.CLAUDE_SESSION_LIMIT, 100, 500);
    const seen = new Set<string>();
    const selected = candidates.filter((candidate) => {
      if (seen.has(candidate.id)) return false;
      seen.add(candidate.id);
      return true;
    }).slice(0, limit);
    for (let offset = 0; offset < selected.length; offset += 8) {
      const batch = await Promise.all(selected.slice(offset, offset + 8).map(async ({ id, hash, filePath }) => {
        try {
          const info = await this.parseSessionFile(filePath, hash);
          return {
            id,
            harness: "claude" as const,
            title: info.title,
            cwd: info.cwd,
            lastActivity: info.lastActivity,
            model: info.model,
            needsPermission: false,
            messageCount: info.messageCount,
            lastMessage: info.lastMessage,
            meta: { projectHash: hash, filePath },
          };
        } catch {
          return null;
        }
      }));
      sessions.push(...batch.filter((session): session is NonNullable<typeof session> => session !== null));
    }
    sessions.sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
    return sessions;
  }

  private async parseSessionFile(
    filePath: string,
    _projectHash: string
  ): Promise<ParsedSession> {
    const { lines, fileStat } = await readSessionSample(filePath);
    let title = "Untitled session";
    let model: string | undefined;
    let messageCount = 0;
    let lastMessage: string | undefined;
    let lastHumanMsg = "";
    let lastAssistantMsg = "";

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        messageCount++;

        // Extract title from first user message
        if (!title || title === "Untitled session") {
          if ((entry.type === "human" || entry.type === "user" || entry.message?.role === "user") && entry.message?.content) {
            const text = this.extractTextContent(entry.message.content);
            if (text) title = text.slice(0, 120);
          }
        }

        // Track last human and assistant messages
        if ((entry.type === "human" || entry.type === "user" || entry.message?.role === "user") && entry.message?.content) {
          const text = this.extractTextContent(entry.message.content);
          if (text) lastHumanMsg = text;
        }
        if (entry.type === "assistant" && entry.message?.content) {
          const text = this.extractAssistantText(entry.message.content);
          if (text) lastAssistantMsg = text;
        }

        // Extract model — look for model in multiple places
        if (!model) {
          if (entry.model) {
            model = entry.model;
          } else if (entry.message?.model) {
            model = entry.message.model;
          } else if (entry.message?.metadata?.model) {
            model = entry.message.metadata.model;
          }
        }
        // Keep updating model to get the most recent one used
        if (entry.model) model = entry.model;
        else if (entry.message?.model) model = entry.message.model;
      } catch {
        // skip bad lines
      }
    }

    // Prefer last assistant message, fall back to last human message
    lastMessage = lastAssistantMsg || lastHumanMsg || undefined;
    if (lastMessage && lastMessage.length > 300) {
      lastMessage = lastMessage.slice(0, 300) + "...";
    }

    // Current transcripts carry cwd on each event. Older layouts may use project.json.
    let cwd = process.cwd();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (typeof entry.cwd === "string" && entry.cwd.trim()) cwd = entry.cwd;
      } catch { /* ignore malformed lines */ }
    }
    try {
      const parent = dirname(filePath);
      const projectFile = join(parent.endsWith("/sessions") ? dirname(parent) : parent, "project.json");
      const proj = JSON.parse(await readFile(projectFile, "utf-8"));
      if (proj.path) cwd = proj.path;
    } catch {
      // fallback
    }

    return {
      title,
      cwd,
      lastActivity: fileStat.mtime.toISOString(),
      model,
      messageCount,
      lastMessage,
    };
  }

  /**
   * Extract plain text from a Claude message content block.
   */
  private extractTextContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const textBlock = content.find((b: { type?: string; text?: string }) => b.type === "text" && b.text);
      return textBlock?.text || "";
    }
    return "";
  }

  /**
   * Extract text from assistant message, including tool_use summaries.
   */
  private extractAssistantText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";

    const parts: string[] = [];
    for (const block of content) {
      if (block.type === "text" && block.text) {
        parts.push(block.text);
      } else if (block.type === "tool_use" && block.name) {
        parts.push(`[Tool: ${block.name}]`);
      } else if (block.type === "tool_result") {
        // Skip tool results (too verbose)
        continue;
      }
    }
    return parts.join(" ").trim();
  }

  /**
   * Extract full transcript text from a JSONL session file for summarization.
   */
  private async extractTranscriptText(filePath: string): Promise<string> {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const parts: string[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const role = entry.type === "human" || entry.type === "user" || entry.message?.role === "user"
          ? "User"
          : entry.type === "assistant" || entry.message?.role === "assistant"
            ? "Assistant"
            : entry.type;
        if (role === "User" || role === "Assistant") {
          const text = role === "User"
            ? this.extractTextContent(entry.message?.content)
            : this.extractAssistantText(entry.message?.content);
          if (text && text.length > 0) {
            parts.push(`${role}: ${text.slice(0, 2000)}`);
          }
        }
      } catch {
        continue;
      }
    }

    return parts.join("\n\n");
  }

  private async findSessionFile(id: string): Promise<string | null> {
    const projectsDir = join(this.claudeDir, "projects");
    try {
      for (const hash of await readdir(projectsDir)) {
        for (const filePath of [
          join(projectsDir, hash, `${id}.jsonl`),
          join(projectsDir, hash, "sessions", `${id}.jsonl`),
        ]) {
          try {
            await access(filePath);
            return filePath;
          } catch { /* try the next layout */ }
        }
      }
    } catch { /* no projects directory */ }
    return null;
  }

  private async getRunningClaudePids(): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    try {
      const { stdout } = await execFileAsync("pgrep", ["-af", "claude"], { timeout: 5000 });
      for (const line of stdout.split("\n")) {
        const match = line.match(/^(\d+)\s+.*claude.*--session(?:-id)?\s+(\S+)/);
        if (match) {
          result.set(match[2], parseInt(match[1], 10));
        }
        const matchResume = line.match(/^(\d+)\s+.*claude.*--resume\s+(\S+)/);
        if (matchResume) {
          result.set(matchResume[2], parseInt(matchResume[1], 10));
        }
      }
    } catch {
      // pgrep returns non-zero if no matches
    }
    return result;
  }
}

async function readSessionSample(filePath: string): Promise<{ lines: string[]; fileStat: Awaited<ReturnType<typeof stat>> }> {
  const fileStat = await stat(filePath);
  const headBytes = 64 * 1024;
  const tailBytes = 512 * 1024;
  if (fileStat.size <= headBytes + tailBytes) {
    return { lines: (await readFile(filePath, "utf8")).split("\n").filter(Boolean), fileStat };
  }

  const handle = await open(filePath, "r");
  try {
    const head = Buffer.alloc(headBytes);
    const tail = Buffer.alloc(tailBytes);
    const headRead = await handle.read(head, 0, head.length, 0);
    const tailRead = await handle.read(tail, 0, tail.length, fileStat.size - tailBytes);
    const headLines = head.subarray(0, headRead.bytesRead).toString("utf8").split("\n");
    headLines.pop();
    const tailText = tail.subarray(0, tailRead.bytesRead).toString("utf8");
    const firstBreak = tailText.indexOf("\n");
    const tailLines = tailText.slice(firstBreak < 0 ? tailText.length : firstBreak + 1).split("\n").filter(Boolean);
    return { lines: [...headLines.filter(Boolean), ...tailLines], fileStat };
  } finally {
    await handle.close();
  }
}

function boundedPositiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}
