import { HarnessAdapter, AgentSession, ControlResult, RawTranscriptExport, SendMessageOptions, SetPermissionsOptions, SessionMessageView, SessionSnapshotReceipt } from "../types/index.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream, existsSync, realpathSync } from "node:fs";
import { open, readFile, readdir, readlink, realpath, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { spawnDetachedWorkload } from "../workload-launcher.js";
import { getHumanStopStore } from "../human-stop-store.js";

const execFileAsync = promisify(execFile);

interface CodexSessionIndexEntry {
  id: string;
  thread_name?: string;
  updated_at?: string;
}

export interface CodexAutomationStop {
  id: string;
  at: string;
  reason: "interrupted";
  turnId?: string;
}

export interface CodexNativeAutomationMetadata {
  automationStop?: CodexAutomationStop;
}

interface CodexSessionState {
  title?: string;
  cwd?: string;
  filePath: string;
  lastMessage?: string;
  model?: string;
  parentThreadId?: string;
  threadSource?: string;
  agentRole?: string;
  pinned?: boolean;
  status?: "running" | "idle";
  automationStop?: CodexAutomationStop;
  updatedAtMs: number;
}

interface CodexTranscriptItem {
  type?: string;
  timestamp?: string | number;
  payload?: {
    type?: string;
    id?: string;
    role?: string;
    phase?: string;
    internal_chat_message_metadata_passthrough?: { turn_id?: string };
    model?: string;
    turn_id?: string;
    reason?: string;
    completed_at?: string | number;
    content?: Array<{ type?: string; text?: string }>;
  };
}

interface CodexRolloutTail {
  lastMessage?: string;
  model?: string;
  status?: "running" | "idle";
  automationStop?: CodexAutomationStop;
  updatedAtMs: number;
}

function rolloutIsoTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
    const parsed = new Date(milliseconds);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
  }
  return undefined;
}

function nativeAutomationMetadataFromLines(lines: string[]): CodexNativeAutomationMetadata {
  let automationStop: CodexAutomationStop | undefined;
  for (const line of lines) {
    try {
      const item = JSON.parse(line) as CodexTranscriptItem;
      const payload = item.payload;
      if (!payload) continue;
      if (!automationStop && item.type === "event_msg" && payload.type === "turn_aborted" && payload.reason === "interrupted") {
        const at = rolloutIsoTimestamp(item.timestamp) || rolloutIsoTimestamp(payload.completed_at);
        const turnId = typeof payload.turn_id === "string" && payload.turn_id ? payload.turn_id : undefined;
        if (at && turnId) {
          automationStop = {
            id: turnId,
            at,
            reason: "interrupted",
            turnId,
          };
        }
      }
      if (automationStop) break;
    } catch {
      // Ignore partial trailing records and malformed historical lines.
    }
  }
  return automationStop ? { automationStop } : {};
}

function mapCodexMessage(id: string, item: CodexTranscriptItem & { timestamp?: string }, recordOffset: number, contextTurnId?: string): SessionMessageView | null {
  if (item.type !== "response_item" || item.payload?.type !== "message") return null;
  if (item.payload.role !== "user" && item.payload.role !== "assistant") return null;
  const parts = (item.payload.content || [])
    .filter((part) => part.type === "input_text" || part.type === "output_text")
    .map((part) => ({ type: "text" as const, text: part.text || "" }))
    .filter((part) => part.text.trim().length > 0);
  const messageText = parts.map((part) => part.text).join("\n").trim();
  if (!messageText) return null;
  const turnId = item.payload.internal_chat_message_metadata_passthrough?.turn_id || item.payload.turn_id || contextTurnId;
  return {
    id: item.payload.id || `${id}:record:${recordOffset}`,
    role: item.payload.role,
    ...(turnId ? { turnId } : {}),
    ...(item.payload.phase ? { phase: item.payload.phase } : {}),
    timestamp: item.timestamp,
    text: messageText,
    parts,
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
  private sessionStatesCachedAt = 0;
  private sessionStatesRefresh?: Promise<Map<string, CodexSessionState>>;
  private sessionSnapshotReceipt: SessionSnapshotReceipt = {
    exhaustive: false,
    observedAt: new Date(0).toISOString(),
    source: "codex-state-index",
    reason: "not_observed",
  };

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
    const [indexSnapshot, sessionStates, runningPids, openRolloutPaths] = await Promise.all([
      this.readSessionIndex(),
      this.getSessionStates(),
      this.getRunningCodexPids(),
      this.getOpenCodexRolloutPaths(),
    ]);
    const index = indexSnapshot.entries;
    this.sessionSnapshotReceipt = {
      exhaustive: indexSnapshot.exhaustive,
      observedAt: new Date().toISOString(),
      source: "codex-state-index",
      ...(indexSnapshot.exhaustive ? {} : { reason: "session_index_unavailable" }),
    };
    const sessions = index.map((entry) => {
      const state = sessionStates.get(entry.id);
      const persistedStatus = this.reconcilePersistedStatus(state, openRolloutPaths);
      return {
        id: entry.id,
        harness: "codex" as const,
        status: persistedStatus ?? (runningPids.has(entry.id) ? "running" as const : "stopped" as const),
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
          ...(state?.automationStop ? { automationStop: state.automationStop } : {}),
          pinned: state?.pinned ?? false,
        },
      };
    });

    sessions.sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
    return sessions;
  }

  getSessionSnapshotReceipt(): SessionSnapshotReceipt {
    return { ...this.sessionSnapshotReceipt };
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

  async getNativeSessionMetadata(): Promise<Map<string, Pick<CodexSessionState, "parentThreadId" | "threadSource" | "agentRole" | "status" | "pinned" | "automationStop">>> {
    const [states, openRolloutPaths] = await Promise.all([
      this.getSessionStates(),
      this.getOpenCodexRolloutPaths(),
    ]);
    return new Map([...states.entries()].map(([id, state]) => [id, {
      parentThreadId: state.parentThreadId,
      threadSource: state.threadSource,
      agentRole: state.agentRole,
      status: this.reconcilePersistedStatus(state, openRolloutPaths),
      pinned: state.pinned,
      automationStop: state.automationStop,
    }]));
  }

  async getNativeAutomationMetadata(id: string): Promise<CodexNativeAutomationMetadata> {
    const session = await this.getSessionObservation(id);
    const automationStop = session?.meta?.automationStop as CodexAutomationStop | undefined;
    return automationStop ? { automationStop } : {};
  }

  /** Exact persisted metadata and a fresh bounded tail; no global discovery or full metrics. */
  async getSessionObservation(id: string): Promise<AgentSession | null> {
    const databaseAvailable = existsSync(join(this.codexDir, "state_5.sqlite"));
    let state = await this.readSessionStateFromDatabase(id);
    if (!state && !databaseAvailable) {
      state = this.sessionStatesCache?.get(id) ?? null;
      if (!state) {
        // Legacy installations have no native path index. Inspect only rollout
        // filenames for this ID, never parse the entire session corpus.
        const paths = await this.findJsonlFiles(join(this.codexDir, "sessions"));
        for (const path of paths.filter(path => basename(path).includes(id))) {
          const header = await this.readSessionHeader(path);
          if (this.getHeaderSessionId(header) !== id) continue;
          state = { filePath: path, cwd: this.getHeaderString(header, "cwd"), model: this.extractLatestTurnModel(header), ...this.extractLineage(header), updatedAtMs: 0 };
          break;
        }
      }
    }
    if (!state) return null;
    let tail: CodexRolloutTail;
    try { tail = await this.readSessionTail(state.filePath); }
    catch (error) {
      if (!isFileNotFound(error)) throw error;
      // Archiving can move the rollout between exact lookup and open. Refresh
      // this ID once, preserving failure if fresh stop evidence is unavailable.
      const current = await this.readSessionStateFromDatabase(id);
      if (!current || current.filePath === state.filePath) throw error;
      state = current;
      tail = await this.readSessionTail(current.filePath);
    }
    return {
      id, harness: "codex", title: state.title || "Untitled session",
      cwd: state.cwd || process.cwd(), model: tail?.model || state.model,
      // Persisted lifecycle is metadata, not a live native turn observation.
      status: "stopped", needsPermission: false,
      lastActivity: new Date(tail?.updatedAtMs || state.updatedAtMs || 0).toISOString(),
      lastMessage: tail?.lastMessage || state.lastMessage,
      meta: {
        sessionIndexPath: join(this.codexDir, "session_index.jsonl"),
        sessionFilePath: state.filePath,
        ...(state.parentThreadId ? { parentThreadId: state.parentThreadId } : {}),
        ...(state.threadSource ? { threadSource: state.threadSource } : {}),
        ...(state.agentRole ? { agentRole: state.agentRole } : {}),
        ...(tail?.automationStop ? { automationStop: tail.automationStop } : {}),
        pinned: state.pinned ?? false,
      },
    };
  }

  async findNativeNamedThreads(name: string, cwd: string): Promise<Array<{ id: string; name: string; cwd: string }> | null> {
    const databasePath = join(this.codexDir, "state_5.sqlite");
    if (!existsSync(databasePath)) return null;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        db.exec("pragma busy_timeout=5000");
        const columns = new Set((db.prepare("pragma table_info(threads)").all() as Array<{ name?: string }>)
          .map((column) => column.name)
          .filter((column): column is string => typeof column === "string"));
        if (!["id", "name", "cwd"].every((column) => columns.has(column))) return null;
        const archiveFilter = columns.has("archived")
          ? " and (archived = 0 or archived is null)"
          : columns.has("archived_at") ? " and archived_at is null" : "";
        const rows = db.prepare(`select id, name, cwd from threads where name = ?${archiveFilter}`)
          .all(name) as Array<{ id?: unknown; name?: unknown; cwd?: unknown }>;
        const canonicalCwd = await realpath(cwd).catch(() => cwd);
        const matches: Array<{ id: string; name: string; cwd: string }> = [];
        for (const row of rows) {
          if (typeof row.id !== "string" || typeof row.name !== "string" || typeof row.cwd !== "string") continue;
          if (row.cwd !== cwd && await realpath(row.cwd).catch(() => row.cwd) !== canonicalCwd) continue;
          matches.push({ id: row.id, name: row.name, cwd: row.cwd });
        }
        return matches;
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  }

  async setSessionPinned(id: string, pinned: boolean): Promise<ControlResult> {
    const databasePath = join(this.codexDir, "state_5.sqlite");
    if (!existsSync(databasePath)) return { ok: false, error: "Codex state database is unavailable" };
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(databasePath);
      try {
        db.exec("pragma busy_timeout=5000");
        const columns = db.prepare("pragma table_info(threads)").all() as Array<{ name?: string }>;
        if (!columns.some((column) => column.name === "is_pinned")) {
          return { ok: false, error: "Codex state database does not expose is_pinned" };
        }
        const changed = db.prepare("update threads set is_pinned = ? where id = ?").run(pinned ? 1 : 0, id);
        if (Number(changed.changes) !== 1) return { ok: false, error: `Codex session ${id} is missing from the state database` };
        const cached = this.sessionStatesCache?.get(id);
        if (cached) cached.pinned = pinned;
        return { ok: true, sessionId: id };
      } finally {
        db.close();
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async sendMessage(id: string, options: SendMessageOptions): Promise<{ ok: boolean; error?: string }> {
    const session = await this.getSession(id);
    if (!session) return { ok: false, error: `Session ${id} not found` };

    // `codex <prompt>` starts an unrelated conversation. exec resume attaches
    // the prompt to the indexed thread while remaining suitable for an MCP call.
    const args = ["exec", "resume"];
    if (session.model) args.push("--model", session.model);
    args.push(id, options.message);

    try {
      const stopStore = getHumanStopStore();
      if (await stopStore.observe(session)) {
        return { ok: false, error: `Codex session ${id} is held by a manual stop; prompt was dropped` };
      }
      if (options.origin !== "human") {
        await stopStore.rememberGeneratedPrompt("codex", id, options.message);
      }
      if (await stopStore.isHeld("codex", id)) return { ok: false, error: `Codex session ${id} is held by a manual stop; prompt was dropped` };
    } catch (error) {
      return { ok: false, error: `Codex prompt preflight failed: ${error instanceof Error ? error.message : String(error)}` };
    }
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
    const messages = await this.withCurrentSessionState(id, async (state) => {
      const file = await open(state.filePath, "r");
      try {
        const fileStat = await file.stat();
        const target = Math.max(1, Math.min(limit, 50));
        let bytesToRead = Math.min(fileStat.size, 256 * 1024);
        let bestMessages: SessionMessageView[] = [];
        while (bytesToRead <= Math.min(fileStat.size, 4 * 1024 * 1024)) {
          const buffer = Buffer.alloc(bytesToRead);
          const { bytesRead } = await file.read(buffer, 0, bytesToRead, fileStat.size - bytesToRead);
          const startByte = bytesToRead === fileStat.size ? 0 : Math.max(0, buffer.subarray(0, bytesRead).indexOf(10) + 1);
          const lines = buffer.subarray(startByte, bytesRead).toString("utf8").split("\n");
          const currentMessages: SessionMessageView[] = [];
          let contextTurnId: string | undefined;
          let recordOffset = fileStat.size - bytesToRead + startByte;
          for (let index = 0; index < lines.length; index++) {
            try {
              const item = JSON.parse(lines[index]) as CodexTranscriptItem & { timestamp?: string };
              if (item.type === "turn_context" || item.type === "event_msg" && item.payload?.type === "task_started") {
                contextTurnId = item.payload?.turn_id || undefined;
              }
              const message = mapCodexMessage(id, item, recordOffset, contextTurnId);
              if (message) currentMessages.push(message);
              if (item.type === "event_msg" && ["task_complete", "turn_aborted"].includes(item.payload?.type || "")) contextTurnId = undefined;
            } catch { /* partial or non-message line */ }
            recordOffset += Buffer.byteLength(lines[index], "utf8") + 1;
          }
          bestMessages = currentMessages;
          if (currentMessages.length >= target || bytesToRead === fileStat.size) return currentMessages.slice(-target);
          const next = Math.min(fileStat.size, bytesToRead * 2);
          if (next === bytesToRead) return currentMessages.slice(-target);
          bytesToRead = next;
        }
        return bestMessages.slice(-target);
      } finally {
        await file.close();
      }
    });
    return messages ?? null;
  }

  async getFirstUserMessage(id: string): Promise<SessionMessageView | null> {
    const message = await this.withCurrentSessionState(id, async (state) => {
      const stream = createReadStream(state.filePath, { encoding: "utf8" });
      let pending = "";
      let recordOffset = 0;
      const firstUser = (line: string): SessionMessageView | null => {
        try {
          const item = JSON.parse(line) as CodexTranscriptItem & { timestamp?: string };
          const message = mapCodexMessage(id, item, recordOffset);
          return message?.role === "user" ? message : null;
        } catch { return null; }
      };
      try {
        for await (const chunk of stream) {
          pending += chunk;
          let newline: number;
          while ((newline = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newline);
            const message = firstUser(line);
            if (message) return message;
            recordOffset += Buffer.byteLength(line, "utf8") + 1;
            pending = pending.slice(newline + 1);
          }
        }
        return pending ? firstUser(pending) : null;
      } finally {
        stream.destroy();
      }
    });
    return message ?? null;
  }

  async getTranscript(id: string): Promise<string | null> {
    try {
      const content = await this.withCurrentSessionState(id, (state) => readFile(state.filePath, "utf-8"));
      if (content === undefined) return null;
      const messages = content.split("\n").flatMap((line) => this.extractTranscriptMessage(line));
      return messages.join("\n\n") || null;
    } catch {
      return null;
    }
  }

  async getRawTranscript(id: string, signal?: AbortSignal): Promise<RawTranscriptExport | null> {
    try {
      const result = await this.withCurrentSessionState<RawTranscriptExport>(id, async (state) => ({
        bytes: await readFile(state.filePath, { signal }),
        complete: true,
        source: { kind: "native-file", location: state.filePath, format: "jsonl" },
        timestampCoverage: "native",
      }));
      return result ?? null;
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

  private async readSessionIndex(): Promise<{ entries: CodexSessionIndexEntry[]; exhaustive: boolean }> {
    try {
      const content = await readFile(join(this.codexDir, "session_index.jsonl"), "utf-8");
      const byId = new Map<string, CodexSessionIndexEntry>();
      let exhaustive = true;
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as CodexSessionIndexEntry;
          if (typeof entry.id !== "string") {
            exhaustive = false;
            continue;
          }
          const previous = byId.get(entry.id);
          if (!previous || String(entry.updated_at || "") >= String(previous.updated_at || "")) byId.set(entry.id, entry);
        } catch {
          exhaustive = false;
        }
      }
      return { entries: [...byId.values()], exhaustive };
    } catch {
      return { entries: [], exhaustive: false };
    }
  }

  private async readSessionStates(): Promise<Map<string, CodexSessionState>> {
    const indexed = await this.readSessionStatesFromDatabase();
    if (indexed) return indexed;
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
            status: tail.status,
            automationStop: tail.automationStop,
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

  /**
   * Modern Codex already indexes rollout paths and metadata in state_5.sqlite.
   * Reading that index avoids reparsing hundreds of megabytes across thousands
   * of archived JSONL files on every control-plane refresh.
   */
  private async readSessionStatesFromDatabase(): Promise<Map<string, CodexSessionState> | null> {
    const databasePath = join(this.codexDir, "state_5.sqlite");
    if (!existsSync(databasePath)) return null;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        db.exec("pragma busy_timeout=5000");
        const edges = new Map((db.prepare("select child_thread_id, parent_thread_id from thread_spawn_edges").all() as Array<{
          child_thread_id: string; parent_thread_id: string;
        }>).map((row) => [row.child_thread_id, row.parent_thread_id]));
        const columns = db.prepare("pragma table_info(threads)").all() as Array<{ name?: string }>;
        const pinnedColumn = columns.some((column) => column.name === "is_pinned") ? "is_pinned" : "0 as is_pinned";
        const rows = db.prepare(`
          select id, rollout_path, cwd, model, preview, updated_at_ms, thread_source, agent_role, ${pinnedColumn}
          from threads
        `).all() as Array<{
          id: string; rollout_path: string; cwd?: string; model?: string; preview?: string;
          updated_at_ms?: number; thread_source?: string; agent_role?: string; is_pinned?: number;
        }>;
        const result = new Map<string, CodexSessionState>();
        for (const row of rows) {
          if (!row.id || !row.rollout_path) continue;
          result.set(row.id, {
            cwd: row.cwd,
            filePath: row.rollout_path,
            lastMessage: row.preview,
            model: row.model,
            parentThreadId: edges.get(row.id),
            threadSource: row.thread_source,
            agentRole: row.agent_role,
            pinned: row.is_pinned === 1,
            updatedAtMs: normalizeEpochMs(row.updated_at_ms),
          });
        }
        // Probe only the newest native rollouts for lifecycle markers. Twenty
        // covers the visible concurrent Desktop set while keeping startup
        // bounded; older rows remain cheap directory entries from SQLite.
        const liveCandidates = [...result.entries()]
          .filter(([, state]) => state.updatedAtMs > 0 && Date.now() - state.updatedAtMs <= 48 * 60 * 60 * 1_000 && existsSync(state.filePath))
          .sort((left, right) => right[1].updatedAtMs - left[1].updatedAtMs)
          .slice(0, 20);
        for (const [id, state] of liveCandidates) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          const tail = await this.readSessionTail(state.filePath);
          state.lastMessage = tail.lastMessage || state.lastMessage;
          state.model = tail.model || state.model;
          state.status = tail.status;
          state.automationStop = tail.automationStop;
          state.updatedAtMs = tail.updatedAtMs;
        }
        return result;
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  }

  /** Refresh one exact native ID after an archive moved its rollout behind our TTL cache. */
  private async readSessionStateFromDatabase(id: string): Promise<CodexSessionState | null> {
    const databasePath = join(this.codexDir, "state_5.sqlite");
    if (!existsSync(databasePath)) return null;
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      db.exec("pragma busy_timeout=5000");
      const columns = new Set((db.prepare("pragma table_info(threads)").all() as Array<{ name?: string }>)
        .map((column) => column.name)
        .filter((name): name is string => typeof name === "string"));
      if (!columns.has("id") || !columns.has("rollout_path")) return null;
      const optional = (column: string, alias = column) => columns.has(column) ? column : `null as ${alias}`;
      const row = db.prepare(`select id, rollout_path, ${optional("name")}, ${optional("cwd")}, ${optional("model")}, ${optional("preview")}, ${optional("updated_at_ms")}, ${optional("thread_source")}, ${optional("agent_role")}, ${optional("is_pinned", "is_pinned")} from threads where id = ? limit 1`)
        .get(id) as {
          id?: unknown; rollout_path?: unknown; name?: unknown; cwd?: unknown; model?: unknown; preview?: unknown;
          updated_at_ms?: unknown; thread_source?: unknown; agent_role?: unknown; is_pinned?: unknown;
        } | undefined;
      if (!row || row.id !== id || typeof row.rollout_path !== "string" || !row.rollout_path) return null;
      let parentThreadId: string | undefined;
      if (existsSync(databasePath)) {
        const edgeColumns = new Set((db.prepare("pragma table_info(thread_spawn_edges)").all() as Array<{ name?: string }>)
          .map((column) => column.name)
          .filter((name): name is string => typeof name === "string"));
        if (edgeColumns.has("child_thread_id") && edgeColumns.has("parent_thread_id")) {
          const edge = db.prepare("select parent_thread_id from thread_spawn_edges where child_thread_id = ? limit 1")
            .get(id) as { parent_thread_id?: unknown } | undefined;
          if (typeof edge?.parent_thread_id === "string" && edge.parent_thread_id !== id) parentThreadId = edge.parent_thread_id;
        }
      }
      return {
        filePath: row.rollout_path,
        ...(typeof row.name === "string" ? { title: row.name } : {}),
        ...(typeof row.cwd === "string" ? { cwd: row.cwd } : {}),
        ...(typeof row.model === "string" ? { model: row.model } : {}),
        ...(typeof row.preview === "string" ? { lastMessage: row.preview } : {}),
        ...(typeof row.thread_source === "string" ? { threadSource: row.thread_source } : {}),
        ...(typeof row.agent_role === "string" ? { agentRole: row.agent_role } : {}),
        ...(parentThreadId ? { parentThreadId } : {}),
        pinned: row.is_pinned === 1,
        updatedAtMs: normalizeEpochMs(typeof row.updated_at_ms === "number" ? row.updated_at_ms : undefined),
      };
    } finally {
      db.close();
    }
  }

  /** Retry one exact-ID operation once if its cached native rollout was moved. */
  private async withCurrentSessionState<T>(
    id: string,
    operation: (state: CodexSessionState) => Promise<T>,
  ): Promise<T | undefined> {
    const states = await this.getSessionStates();
    const state = states.get(id);
    if (!state) return undefined;
    try {
      return await operation(state);
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
      const current = await this.readSessionStateFromDatabase(id);
      if (!current || current.filePath === state.filePath) throw error;
      states.set(id, current);
      return operation(current);
    }
  }

  /** Share one expensive rollout scan across the dashboard, observer and recovery loop. */
  private getSessionStates(): Promise<Map<string, CodexSessionState>> {
    const ttlMs = Math.max(1_000, Number(process.env.AGENT_HERDER_CODEX_STATE_CACHE_MS || 60_000));
    if (this.sessionStatesCache && Date.now() - this.sessionStatesCachedAt < ttlMs) {
      return Promise.resolve(this.sessionStatesCache);
    }
    if (this.sessionStatesRefresh) return this.sessionStatesRefresh;
    this.sessionStatesRefresh = this.readSessionStates()
      .then((states) => {
        this.sessionStatesCache = states;
        this.sessionStatesCachedAt = Date.now();
        return states;
      })
      .finally(() => { this.sessionStatesRefresh = undefined; });
    return this.sessionStatesRefresh;
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

  private async readSessionTail(filePath: string): Promise<CodexRolloutTail> {
    const file = await open(filePath, "r");
    try {
      const fileStat = await stat(filePath);
      const fileSize = fileStat.size;
      let bytesToRead = Math.min(fileSize, 32 * 1024);
      let buffer = Buffer.alloc(bytesToRead);
      let read = await file.read(buffer, 0, bytesToRead, fileSize - bytesToRead);
      let lines = buffer.subarray(0, read.bytesRead).toString("utf-8").split("\n").reverse();
      let lastMessage: string | undefined;
      let model: string | undefined;
      let status: "running" | "idle" | undefined;
      let nativeSignals = nativeAutomationMetadataFromLines(lines);
      for (const line of lines) {
        if (!lastMessage) {
          const message = this.extractTranscriptMessage(line)[0];
          if (message) lastMessage = message.slice(0, 300);
        }
        if (!model) model = this.extractTurnModel(line);
        if (!status) status = this.extractLifecycleStatus(line);
        if (lastMessage && model && status && nativeSignals.automationStop) break;
      }
      if (!status
        && Date.now() - fileStat.mtimeMs <= 48 * 60 * 60 * 1_000
        && bytesToRead < Math.min(fileSize, 4 * 1024 * 1024)) {
        bytesToRead = Math.min(fileSize, 4 * 1024 * 1024);
        buffer = Buffer.alloc(bytesToRead);
        read = await file.read(buffer, 0, bytesToRead, fileSize - bytesToRead);
        lines = buffer.subarray(0, read.bytesRead).toString("utf-8").split("\n").reverse();
        nativeSignals = nativeAutomationMetadataFromLines(lines);
        for (const line of lines) {
          status = this.extractLifecycleStatus(line);
          if (status) break;
        }
      }
      const activeWindowMs = Number(process.env.AGENT_HERDER_ACTIVE_WINDOW_MS || 5 * 60 * 1_000);
      if (status === "running" && Date.now() - fileStat.mtimeMs > activeWindowMs) status = "idle";
      return { lastMessage, model, status, ...nativeSignals, updatedAtMs: fileStat.mtimeMs };
    } finally {
      await file.close();
    }
  }

  private extractLifecycleStatus(line: string): "running" | "idle" | undefined {
    try {
      const item = JSON.parse(line) as { type?: string; payload?: { type?: string } };
      if (item.type !== "event_msg") return undefined;
      if (item.payload?.type === "task_started") return "running";
      if (item.payload?.type === "task_complete" || item.payload?.type === "turn_aborted") return "idle";
      return undefined;
    } catch {
      return undefined;
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

  private reconcilePersistedStatus(
    state: CodexSessionState | undefined,
    openRolloutPaths: Set<string> | null,
  ): CodexSessionState["status"] {
    if (state?.status !== "running" || openRolloutPaths === null || !state.filePath) return state?.status;
    const filePath = existsSync(state.filePath) ? realpathSync(state.filePath) : state.filePath;
    return openRolloutPaths.has(filePath) ? "running" : "idle";
  }

  /**
   * A live Codex writer keeps its rollout open. Lifecycle JSONL can end at
   * task_started when that process dies, so file age alone leaves a dead turn
   * looking active until the stale window expires. Linux /proc gives an
   * immediate, read-only liveness signal; other platforms retain the bounded
   * timestamp fallback.
   */
  private async getOpenCodexRolloutPaths(): Promise<Set<string> | null> {
    if (!existsSync("/proc")) return null;
    const result = new Set<string>();
    const pids = await this.getCodexCandidatePids();
    if (pids === null) return null;
    const inspections = await Promise.all(pids.map((pid) => this.inspectCodexProcessRollouts(pid)));
    if (inspections.some((inspection) => inspection === null)) return null;
    for (const inspection of inspections) {
      for (const rolloutPath of inspection || []) result.add(rolloutPath);
    }
    return result;
  }

  private async inspectCodexProcessRollouts(pid: string): Promise<Set<string> | null> {
    let commandLine: string;
    let descriptors: string[];
    try {
      commandLine = await readFile(`/proc/${pid}/cmdline`, "utf8");
      const argv0 = commandLine.split("\0", 1)[0] || "";
      if (!/^codex(?:-|$)/.test(basename(argv0))) return new Set();
      descriptors = await readdir(`/proc/${pid}/fd`);
    } catch {
      // A short-lived or unreadable process has not provided evidence that it
      // owns one of our rollout files, so it cannot make the whole scan unknown.
      return new Set();
    }

    const result = new Set<string>();
    const sessionRoot = join(this.codexDir, "sessions");
    const canonicalSessionRoot = existsSync(sessionRoot) ? realpathSync(sessionRoot) : sessionRoot;
    let relevantComplete = true;
    await Promise.all(descriptors.map(async (descriptor) => {
      let target: string;
      try {
        target = await readlink(`/proc/${pid}/fd/${descriptor}`);
      } catch {
        // Volatile sockets and unrelated descriptors routinely disappear.
        return;
      }
      if (!target.startsWith(`${canonicalSessionRoot}/`) || !target.endsWith(".jsonl")) return;
      try {
        const fdInfo = await readFile(`/proc/${pid}/fdinfo/${descriptor}`, "utf8");
        const flags = fdInfo.match(/^flags:\s*([0-7]+)$/m)?.[1];
        if (!flags) {
          relevantComplete = false;
          return;
        }
        const accessMode = Number.parseInt(flags, 8) & 0b11;
        if (accessMode === 1 || accessMode === 2) result.add(target);
      } catch {
        // We already proved this descriptor targets our rollout; losing its
        // access-mode evidence must fail closed to avoid a duplicate writer.
        relevantComplete = false;
      }
    }));
    return relevantComplete ? result : null;
  }

  private async getCodexCandidatePids(): Promise<string[] | null> {
    let processList = "";
    try {
      ({ stdout: processList } = await execFileAsync("pgrep", ["-af", "codex"], { timeout: 5000 }));
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 1 || code === "1") return [];
      return null;
    }
    return processList.split("\n")
      .map((line) => line.match(/^(\d+)\s/)?.[1])
      .filter((pid): pid is string => !!pid);
  }
}

function normalizeEpochMs(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value < 0) return 0;
  let normalized = value;
  while (normalized > 10_000_000_000_000) normalized /= 1_000;
  if (normalized < 10_000_000_000) normalized *= 1_000;
  return normalized;
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
