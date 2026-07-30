import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentSession,
  HarnessAdapter,
  RawTranscriptExport,
  SendMessageOptions,
  SetPermissionsOptions,
} from "../types/index.js";

const execFileAsync = promisify(execFile);

interface QoderAdapterConfig {
  qoderBin?: string;
  qoderDir?: string;
  qoderArgs?: string[];
  cwd?: string;
  env?: Record<string, string>;
  defaultModel?: string;
}

interface ParsedSession {
  title: string;
  cwd: string;
  lastActivity: string;
  model?: string;
  messageCount: number;
  lastMessage?: string;
}

/** Controls Qoder sessions stored by qodercli through its supported CLI flags. */
export class QoderAdapter implements HarnessAdapter {
  readonly type = "qoder" as const;
  readonly name = "Qoder";

  private readonly qoderBin: string;
  private readonly qoderDir: string;
  private readonly qoderArgs: string[];
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly modelOverrides = new Map<string, string>();
  private defaultModel?: string;

  constructor(config: QoderAdapterConfig = {}) {
    this.qoderBin = config.qoderBin || process.env.QODER_BIN || "qodercli";
    this.qoderDir = config.qoderDir || process.env.QODER_DIR || join(homedir(), ".qoder");
    this.qoderArgs = [...(config.qoderArgs || [])];
    this.cwd = config.cwd || process.env.QODER_CWD || process.cwd();
    this.env = { ...process.env, ...config.env };
    this.defaultModel = config.defaultModel || process.env.QODER_MODEL;
  }

  async init(): Promise<void> {
    try {
      await execFileAsync(this.qoderBin, [...this.qoderArgs, "--version"], {
        cwd: this.cwd,
        env: this.env,
        timeout: 10_000,
      });
    } catch {
      throw new Error(`'${this.qoderBin}' not found or not executable. Make sure Qoder CLI is installed.`);
    }
  }

  async listSessions(): Promise<AgentSession[]> {
    const projectRoot = join(this.qoderDir, "projects");
    const running = await this.getRunningQoderPids();
    const sessions: AgentSession[] = [];
    let projects;
    try {
      projects = await readdir(projectRoot, { withFileTypes: true });
    } catch {
      return [];
    }

    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const projectDir = join(projectRoot, project.name);
      let files;
      try {
        files = await readdir(projectDir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const id = file.slice(0, -".jsonl".length);
        const filePath = join(projectDir, file);
        try {
          const info = await this.parseSessionFile(filePath);
          sessions.push({
            id,
            harness: "qoder",
            status: running.has(id) ? "running" : "stopped",
            title: info.title,
            cwd: info.cwd,
            lastActivity: info.lastActivity,
            model: this.modelOverrides.get(id) || info.model,
            needsPermission: false,
            messageCount: info.messageCount,
            lastMessage: info.lastMessage,
            meta: { filePath, projectDir, qoderDir: this.qoderDir },
          });
        } catch {
          // A partially written session should not prevent other sessions from being listed.
        }
      }
    }
    sessions.sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
    return sessions;
  }

  async getSession(id: string): Promise<AgentSession | null> {
    return (await this.listSessions()).find((session) => session.id === id) || null;
  }

  async sendMessage(id: string, options: SendMessageOptions): Promise<{ ok: boolean; error?: string }> {
    const session = await this.getSession(id);
    if (!session) return { ok: false, error: `Qoder session '${id}' not found` };
    const args = [...this.qoderArgs, "-p", options.message, "--resume", id, "--output-format", "json"];
    const model = this.modelOverrides.get(id) || this.defaultModel;
    if (model) args.push("--model", model);

    if (options.queue) {
      const child: ChildProcess = spawn(this.qoderBin, args, {
        cwd: session.cwd,
        env: this.env,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return { ok: true };
    }

    try {
      await execFileAsync(this.qoderBin, args, { cwd: session.cwd, env: this.env, timeout: 300_000 });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async stopSession(id: string): Promise<{ ok: boolean; error?: string }> {
    const pid = (await this.getRunningQoderPids()).get(id);
    if (!pid) return { ok: false, error: `No running Qoder process found for session '${id}'` };
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
  ): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: "Qoder CLI permission prompts are not exposed through its remote CLI protocol" };
  }

  async setPermissions(_sessionId: string, _options: SetPermissionsOptions): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: "Qoder permissions must be configured at CLI startup" };
  }

  async changeModel(sessionId: string, model: string): Promise<{ ok: boolean; error?: string }> {
    if (sessionId) {
      if (!(await this.getSession(sessionId))) return { ok: false, error: `Qoder session '${sessionId}' not found` };
      this.modelOverrides.set(sessionId, model);
    } else {
      this.defaultModel = model;
    }
    return { ok: true };
  }

  async listModels(): Promise<string[]> {
    await this.init();
    try {
      const result = await execFileAsync(this.qoderBin, [...this.qoderArgs, "--list-models"], {
        cwd: this.cwd,
        env: this.env,
        timeout: 30_000,
      });
      return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !/^model$/i.test(line) && !/^[-_ ]+$/.test(line));
    } catch (err) {
      throw new Error(`Qoder model discovery failed: ${(err as Error).message}`);
    }
  }

  async resumeSession(id: string): Promise<{ ok: boolean; error?: string }> {
    return (await this.getSession(id)) ? { ok: true } : { ok: false, error: `Qoder session '${id}' not found` };
  }

  async getTranscript(id: string): Promise<string | null> {
    const session = await this.getSession(id);
    const filePath = session?.meta?.filePath;
    if (typeof filePath !== "string") return null;
    try {
      return this.extractTranscript(await readFile(filePath, "utf8"));
    } catch {
      return null;
    }
  }

  async getRawTranscript(id: string): Promise<RawTranscriptExport | null> {
    const session = await this.getSession(id);
    const filePath = session?.meta?.filePath;
    if (typeof filePath !== "string") return null;
    try {
      return {
        bytes: await readFile(filePath),
        complete: true,
        source: { kind: "native-file", location: filePath, format: "jsonl" },
        timestampCoverage: "native",
      };
    } catch {
      return null;
    }
  }

  private async parseSessionFile(filePath: string): Promise<ParsedSession> {
    const content = await readFile(filePath, "utf8");
    const fileStat = await stat(filePath);
    let title = "Untitled Qoder session";
    let cwd = this.cwd;
    let model: string | undefined;
    let lastActivity = fileStat.mtime.toISOString();
    let lastHuman = "";
    let lastAssistant = "";
    let messageCount = 0;

    for (const line of content.split("\n").filter(Boolean)) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const message = entry.message as Record<string, unknown> | undefined;
        const role = typeof message?.role === "string" ? message.role : typeof entry.type === "string" ? entry.type : "";
        const text = this.extractContent(message?.content);
        if (role === "user" || entry.type === "user") {
          messageCount++;
          if (text) lastHuman = text;
          if (title === "Untitled Qoder session" && text) title = text.slice(0, 120);
        } else if (role === "assistant" || entry.type === "assistant") {
          messageCount++;
          if (text) lastAssistant = text;
        }
        if (typeof entry.cwd === "string") cwd = entry.cwd;
        if (typeof entry.model === "string") model = entry.model;
        if (typeof message?.model === "string") model = message.model;
        if (typeof entry.timestamp === "string") lastActivity = entry.timestamp;
      } catch {
        // Ignore a truncated final JSONL record.
      }
    }
    const lastMessage = (lastAssistant || lastHuman).slice(0, 300) || undefined;
    return { title, cwd, lastActivity, model, messageCount, lastMessage };
  }

  private extractContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((part): part is { type?: string; text?: string } => typeof part === "object" && part !== null)
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text || "")
      .join(" ")
      .trim();
  }

  private extractTranscript(content: string): string {
    const messages: string[] = [];
    for (const line of content.split("\n").filter(Boolean)) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const message = entry.message as Record<string, unknown> | undefined;
        const text = this.extractContent(message?.content);
        if (!text) continue;
        const role = message?.role === "user" || entry.type === "user" ? "User" : "Assistant";
        messages.push(`${role}: ${text.slice(0, 2000)}`);
      } catch {
        // Ignore malformed records.
      }
    }
    return messages.join("\n\n");
  }

  private async getRunningQoderPids(): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    try {
      const { stdout } = await execFileAsync("pgrep", ["-af", "qodercli"], { timeout: 5_000 });
      for (const line of stdout.split("\n")) {
        const match = line.match(/^(\d+)\s+.*(?:--resume|--remote-control)\s+(\S+)/);
        if (match) result.set(match[2], Number(match[1]));
      }
    } catch {
      // pgrep exits non-zero when no Qoder process is running.
    }
    return result;
  }
}
