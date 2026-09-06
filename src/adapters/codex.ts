import { HarnessAdapter, AgentSession, RawTranscriptExport, SendMessageOptions, SetPermissionsOptions, SessionMessageView } from "../types/index.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnDetachedWorkload } from "../workload-launcher.js";

const execFileAsync = promisify(execFile);

interface CodexSessionIndexEntry {
  id: string;
  thread_name?: string;
  updated_at?: string;
}

interface CodexSessionState {
  cwd?: string;
  filePath: string;
  lastMessage?: string;
  model?: string;
  parentThreadId?: string;
  threadSource?: string;
  agentRole?: string;
  updatedAtMs: number;
}

interface CodexTranscriptItem {
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    model?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
}

/**
 * Codex CLI adapter backed by Codex's current JSONL session index.
 *
 * session_index.jsonl contains IDs accepted by `codex exec resume`; dated
 * rollout JSONL files supply the original working directory and transcript.
 */
export class CodexAdapter implements HarnessAdapter {
  readonly type = "codex" as const;
  readonly name = "Codex CLI";

  private codexBin: string;
  private codexDir: string;
  private sessionStatesCache?: Map<string, CodexSessionState>;

  constructor(config: { codexBin?: string; codexDir?: string } = {}) {
    this.codexBin = config.codexBin || process.env.CODEX_BIN || "codex";
    this.codexDir = config.codexDir || process.env.CODEX_DATA_DIR || join(homedir(), ".codex");
  }

  async init(): Promise<void> {
    try {
      await execFileAsync(this.codexBin, ["--version"], { timeout: 10000 });
    } catch {
      throw new Error(`'${this.codexBin}' not found or not executable. Make sure Codex CLI is installed.`);
    }
  }

  async listSessions(): Promise<AgentSession[]> {
    const [index, sessionStates, runningPids] = await Promise.all([
      this.readSessionIndex(),
      this.readSessionStates(),
      this.getRunningCodexPids(),
    ]);
    this.sessionStatesCache = sessionStates;

    const sessions = index.map((entry) => {
      const state = sessionStates.get(entry.id);
      return {
        id: entry.id,
        harness: "codex" as const,
        status: runningPids.has(entry.id) ? "running" as const : "stopped" as const,
        title: entry.thread_name || "Untitled session",
        cwd: state?.cwd || process.cwd(),
        lastActivity: entry.updated_at || new Date(0).toISOString(),
        model: state?.model,
        needsPermission: false,
        lastMessage: state?.lastMessage,
        meta: {
          sessionIndexPath: join(this.codexDir, "session_index.jsonl"),
          sessionFilePath: state?.filePath,
          ...(state?.parentThreadId ? { parentThreadId: state.parentThreadId } : {}),
          ...(state?.threadSource ? { threadSource: state.threadSource } : {}),
          ...(state?.agentRole ? { agentRole: state.agentRole } : {}),
        },
      };
    });

    sessions.sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
    return sessions;
  }

  async getSession(id: string): Promise<AgentSession | null> {
    const all = await this.listSessions();
    const session = all.find((candidate) => candidate.id === id) || null;
    if (!session) return null;
    const state = this.sessionStatesCache?.get(id);
    if (!state?.filePath) return session;
    const metrics = await this.readSessionMetrics(state.filePath);
    return {
      ...session,
      model: metrics.model || session.model,
      messageCount: metrics.messageCount,
      durationSec: metrics.durationSec,
      meta: {
        ...session.meta,
        ...(metrics.totalTokens !== undefined ? { total_tokens: metrics.totalTokens } : {}),
        ...(metrics.inputTokens !== undefined ? { input_tokens: metrics.inputTokens } : {}),
        ...(metrics.outputTokens !== undefined ? { output_tokens: metrics.outputTokens } : {}),
        ...(metrics.cachedInputTokens !== undefined ? { cached_input_tokens: metrics.cachedInputTokens } : {}),
      },
    };
  }

  async getNativeSessionMetadata(): Promise<Map<string, Pick<CodexSessionState, "parentThreadId" | "threadSource" | "agentRole">>> {
    const states = this.sessionStatesCache || await this.readSessionStates();
    this.sessionStatesCache = states;
    return new Map([...states.entries()].map(([id, state]) => [id, {
      parentThreadId: state.parentThreadId,
      threadSource: state.threadSource,
      agentRole: state.agentRole,
    }]));
  }

  async sendMessage(id: string, options: SendMessageOptions): Promise<{ ok: boolean; error?: string }> {
    const session = await this.getSession(id);
    if (!session) return { ok: false, error: `Session ${id} not found` };

    // `codex <prompt>` starts an unrelated conversation. exec resume attaches
    // the prompt to the indexed thread while remaining suitable for an MCP call.
    const args = ["exec", "resume"];
    if (session.model) args.push("--model", session.model);
    args.push(id, options.message);

    if (options.queue) {
      spawnDetachedWorkload(this.codexBin, args, { label: "codex-queue", cwd: session.cwd, stdio: "ignore" });
      return { ok: true };
    }

    try {
      await execFileAsync(this.codexBin, args, { cwd: session.cwd, timeout: 300000 });
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
      error: "Codex CLI does not support remote permission response. Configure permissions when starting the session.",
    };
  }

  async setPermissions(_sessionId: string, options: SetPermissionsOptions): Promise<{ ok: boolean; error?: string }> {
    if (options.allowedTools || options.mode) {
      return {
        ok: false,
        error: "Codex CLI permissions are set at launch time via --ask-for-approval and --sandbox.",
      };
    }
    return { ok: true };
  }

  async changeModel(_sessionId: string, model: string): Promise<{ ok: boolean; error?: string }> {
    const configFile = join(this.codexDir, "config.json");
    try {
      const config = JSON.parse(await readFile(configFile, "utf-8")) as Record<string, unknown>;
      config.model = model;
      await writeFile(configFile, JSON.stringify(config, null, 2));
      return { ok: true, error: `Default model updated to '${model}' in ${configFile}. Applies to new sessions only.` };
    } catch {
      return {
        ok: false,
        error: `Codex cannot change model for existing sessions. Start new sessions with --model ${model}.`,
      };
    }
  }

  async listModels(): Promise<string[]> {
    return ["o4-mini", "o3", "o3-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4o", "gpt-4o-mini", "codex-mini"];
  }

  async getSessionMessages(id: string, limit = 12): Promise<SessionMessageView[] | null> {
    const state = this.sessionStatesCache?.get(id) || (await this.readSessionStates()).get(id);
    if (!state) return null;
    const file = await open(state.filePath, "r");
    try {
      const fileStat = await file.stat();
      const target = Math.max(1, Math.min(limit, 50));
      let bytesToRead = Math.min(fileStat.size, 256 * 1024);
      while (bytesToRead <= Math.min(fileStat.size, 4 * 1024 * 1024)) {
        const buffer = Buffer.alloc(bytesToRead);
        const { bytesRead } = await file.read(buffer, 0, bytesToRead, fileStat.size - bytesToRead);
        const text = buffer.subarray(0, bytesRead).toString("utf8");
        const lines = text.slice(bytesToRead === fileStat.size ? 0 : Math.max(0, text.indexOf("\n") + 1)).split("\n");
        const messages: SessionMessageView[] = [];
        for (let index = 0; index < lines.length; index++) {
          try {
            const item = JSON.parse(lines[index]) as CodexTranscriptItem & { timestamp?: string };
            if (item.type !== "response_item" || item.payload?.type !== "message") continue;
            if (item.payload.role !== "user" && item.payload.role !== "assistant") continue;
            const parts = (item.payload.content || [])
              .filter((part) => part.type === "input_text" || part.type === "output_text")
              .map((part) => ({ type: "text" as const, text: part.text || "" }))
              .filter((part) => part.text.trim().length > 0);
            const messageText = parts.map((part) => part.text).join("\n").trim();
            if (!messageText) continue;
            messages.push({
              id: `${id}:tail:${index}:${item.timestamp || ""}`,
              role: item.payload.role,
              timestamp: item.timestamp,
              text: messageText,
              parts,
            });
          } catch { /* partial or non-message line */ }
        }
        if (messages.length >= target || bytesToRead === fileStat.size) return messages.slice(-target);
        const next = Math.min(fileStat.size, bytesToRead * 2);
        if (next === bytesToRead) return messages.slice(-target);
        bytesToRead = next;
      }
      return [];
    } finally {
      await file.close();
    }
  }

  async getTranscript(id: string): Promise<string | null> {
    const state = this.sessionStatesCache?.get(id) || (await this.readSessionStates()).get(id);
    if (!state) return null;

    try {
      const content = await readFile(state.filePath, "utf-8");
      const messages = content.split("\n").flatMap((line) => this.extractTranscriptMessage(line));
      return messages.join("\n\n") || null;
    } catch {
      return null;
    }
  }

  async getRawTranscript(id: string): Promise<RawTranscriptExport | null> {
    const state = this.sessionStatesCache?.get(id) || (await this.readSessionStates()).get(id);
    if (!state) return null;
    try {
      return {
        bytes: await readFile(state.filePath),
        complete: true,
        source: { kind: "native-file", location: state.filePath, format: "jsonl" },
        timestampCoverage: "native",
      };
    } catch {
      return null;
    }
  }

  private async readSessionMetrics(filePath: string): Promise<{
    model?: string;
    messageCount: number;
    durationSec?: number;
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  }> {
    try {
      const content = await readFile(filePath, "utf-8");
      let model: string | undefined;
      let messageCount = 0;
      let firstTimestampMs: number | undefined;
      let lastTimestampMs: number | undefined;
      let totalTokens: number | undefined;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let cachedInputTokens: number | undefined;
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line) as {
            timestamp?: string;
            type?: string;
            payload?: {
              type?: string;
              role?: string;
              model?: string;
              info?: { total_token_usage?: Record<string, unknown> };
            };
          };
          const timestampMs = Date.parse(item.timestamp || "");
          if (Number.isFinite(timestampMs)) {
            firstTimestampMs = firstTimestampMs === undefined ? timestampMs : Math.min(firstTimestampMs, timestampMs);
            lastTimestampMs = lastTimestampMs === undefined ? timestampMs : Math.max(lastTimestampMs, timestampMs);
          }
          if (item.type === "turn_context" && typeof item.payload?.model === "string") model = item.payload.model;
          if (item.type === "response_item" && item.payload?.type === "message" && (item.payload.role === "user" || item.payload.role === "assistant")) messageCount += 1;
          if (item.type === "event_msg" && item.payload?.type === "token_count") {
            const usage = item.payload.info?.total_token_usage;
            const number = (key: string) => typeof usage?.[key] === "number" ? usage[key] as number : undefined;
            totalTokens = number("total_tokens") ?? totalTokens;
            inputTokens = number("input_tokens") ?? inputTokens;
            outputTokens = number("output_tokens") ?? outputTokens;
            cachedInputTokens = number("cached_input_tokens") ?? cachedInputTokens;
          }
        } catch { /* ignore a partial line while Codex is writing */ }
      }
      return {
        model,
        messageCount,
        durationSec: firstTimestampMs !== undefined && lastTimestampMs !== undefined ? Math.max(0, Math.round((lastTimestampMs - firstTimestampMs) / 1000)) : undefined,
        totalTokens, inputTokens, outputTokens, cachedInputTokens,
      };
    } catch {
      return { messageCount: 0 };
    }
  }

  private extractTranscriptMessage(line: string): string[] {
    try {
      const item = JSON.parse(line) as CodexTranscriptItem;
      if (item.type !== "response_item" || item.payload?.type !== "message") return [];
      const text = item.payload.content
        ?.filter((part) => part.type === "input_text" || part.type === "output_text")
        .map((part) => part.text || "")
        .join("\n")
        .trim();
      return text ? [`${item.payload.role || "unknown"}: ${text.slice(0, 2000)}`] : [];
    } catch {
      return [];
    }
  }

  private async readSessionIndex(): Promise<CodexSessionIndexEntry[]> {
    try {
      const content = await readFile(join(this.codexDir, "session_index.jsonl"), "utf-8");
      const byId = new Map<string, CodexSessionIndexEntry>();
      for (const line of content.split("\n")) {
        try {
          const entry = JSON.parse(line) as CodexSessionIndexEntry;
          if (typeof entry.id !== "string") continue;
          const previous = byId.get(entry.id);
          if (!previous || String(entry.updated_at || "") >= String(previous.updated_at || "")) byId.set(entry.id, entry);
        } catch {
          // Ignore incomplete or corrupt index lines while Codex is writing.
        }
      }
      return [...byId.values()];
    } catch {
      return [];
    }
  }

  private async readSessionStates(): Promise<Map<string, CodexSessionState>> {
    const result = new Map<string, CodexSessionState>();
    const sessionFiles = await this.findJsonlFiles(join(this.codexDir, "sessions"));
    await Promise.all(sessionFiles.map(async (filePath) => {
      try {
        const header = await this.readSessionHeader(filePath);
        const sessionId = this.getHeaderSessionId(header);
        if (sessionId) {
          const tail = await this.readSessionTail(filePath);
          const state: CodexSessionState = {
            cwd: this.getHeaderString(header, "cwd"),
            filePath,
            lastMessage: tail.lastMessage,
            // The initial turn context persists the model for the thread. A
            // tail context wins when a later turn explicitly changed it.
            model: tail.model || this.extractLatestTurnModel(header),
            ...this.extractLineage(header),
            updatedAtMs: tail.updatedAtMs,
          };
          const current = result.get(sessionId);
          const merged = {
            ...state,
            parentThreadId: (state.parentThreadId && state.parentThreadId !== sessionId)
              ? state.parentThreadId
              : current?.parentThreadId !== sessionId ? current?.parentThreadId : undefined,
            threadSource: state.threadSource || current?.threadSource,
            agentRole: state.agentRole || current?.agentRole,
          };
          if (!current || state.updatedAtMs >= current.updatedAtMs) result.set(sessionId, merged);
          else if (merged.parentThreadId && !current.parentThreadId) result.set(sessionId, { ...current, ...merged, updatedAtMs: current.updatedAtMs });
        }
      } catch {
        // Ignore incomplete or corrupt rollout files while Codex is writing them.
      }
    }));
    return result;
  }

  private async readSessionHeader(filePath: string): Promise<string> {
    const file = await open(filePath, "r");
    try {
      // Initial turn_context follows large persisted prompts, but remains near
      // the start of the rollout; it supplies the session's persisted model.
      const buffer = Buffer.alloc(128 * 1024);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString("utf-8");
    } finally {
      await file.close();
    }
  }

  private async readSessionTail(
    filePath: string
  ): Promise<{ lastMessage?: string; model?: string; updatedAtMs: number }> {
    const file = await open(filePath, "r");
    try {
      const fileStat = await stat(filePath);
      const fileSize = fileStat.size;
      const bytesToRead = Math.min(fileSize, 32 * 1024);
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await file.read(buffer, 0, bytesToRead, fileSize - bytesToRead);
      const lines = buffer.subarray(0, bytesRead).toString("utf-8").split("\n").reverse();
      let lastMessage: string | undefined;
      let model: string | undefined;
      for (const line of lines) {
        if (!lastMessage) {
          const message = this.extractTranscriptMessage(line)[0];
          if (message) lastMessage = message.slice(0, 300);
        }
        if (!model) model = this.extractTurnModel(line);
        if (lastMessage && model) break;
      }
      return { lastMessage, model, updatedAtMs: fileStat.mtimeMs };
    } finally {
      await file.close();
    }
  }

  private extractTurnModel(line: string): string | undefined {
    try {
      const item = JSON.parse(line) as CodexTranscriptItem;
      return item.type === "turn_context" && typeof item.payload?.model === "string"
        ? item.payload.model
        : undefined;
    } catch {
      return undefined;
    }
  }

  private extractLatestTurnModel(content: string): string | undefined {
    for (const line of content.split("\n").reverse()) {
      const model = this.extractTurnModel(line);
      if (model) return model;
    }
    return undefined;
  }

  private getHeaderString(header: string, key: "session_id" | "cwd"): string | undefined {
    const match = header.match(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`));
    if (!match) return undefined;
    try {
      return JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return undefined;
    }
  }

  private getHeaderSessionId(header: string): string | undefined {
    const firstLine = header.split("\n").find((line) => line.includes('"type":"session_meta"'));
    if (firstLine) {
      try {
        const payload = (JSON.parse(firstLine) as { payload?: Record<string, unknown> }).payload;
        if (typeof payload?.id === "string") return payload.id;
        if (typeof payload?.session_id === "string") return payload.session_id;
      } catch {
        // Fall through to the legacy header parser.
      }
    }
    return this.getHeaderString(header, "session_id");
  }

  private extractLineage(header: string): Pick<CodexSessionState, "parentThreadId" | "threadSource" | "agentRole"> {
    const firstLine = header.split("\n").find((line) => line.includes('"type":"session_meta"'));
    if (!firstLine) return {};
    try {
      const payload = (JSON.parse(firstLine) as { payload?: Record<string, unknown> }).payload;
      if (!payload) return {};
      const source = typeof payload.source === "object" && payload.source
        ? (payload.source as Record<string, unknown>)
        : undefined;
      const subagent = source?.subagent && typeof source.subagent === "object"
        ? source.subagent as Record<string, unknown>
        : undefined;
      const spawn = subagent?.thread_spawn && typeof subagent.thread_spawn === "object"
        ? subagent.thread_spawn as Record<string, unknown>
        : undefined;
      const parentThreadId = typeof payload.parent_thread_id === "string"
        ? payload.parent_thread_id
        : typeof spawn?.parent_thread_id === "string" ? spawn.parent_thread_id : undefined;
      const threadSource = typeof payload.thread_source === "string" ? payload.thread_source : undefined;
      const agentRole = typeof payload.agent_role === "string" ? payload.agent_role
        : typeof payload.agent_nickname === "string" ? payload.agent_nickname : undefined;
      return { parentThreadId, threadSource, agentRole };
    } catch {
      return {};
    }
  }

  private async findJsonlFiles(directory: string): Promise<string[]> {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      const nested = await Promise.all(entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return this.findJsonlFiles(path);
        return entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [];
      }));
      return nested.flat();
    } catch {
      return [];
    }
  }

  private async getRunningCodexPids(): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    try {
      const { stdout } = await execFileAsync("pgrep", ["-af", "codex"], { timeout: 5000 });
      for (const line of stdout.split("\n")) {
        const match = line.match(/^(\d+)\s+.*\bcodex\b.*\bexec\s+resume\s+(\S+)/);
        if (match) result.set(match[2], parseInt(match[1], 10));
      }
    } catch {
      // pgrep returns non-zero when no Codex processes are running.
    }
    return result;
  }
}
