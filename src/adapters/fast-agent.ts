import { readdir, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, join, relative, resolve } from "node:path";
import { spawnDetachedWorkload } from "../workload-launcher.js";
import type {
  AgentSession,
  CreateSessionOptions,
  HarnessAdapter,
  HarnessCapabilities,
  ListSessionsOptions,
  RawTranscriptExport,
  SendMessageOptions,
  SessionMessagePart,
  SessionMessageView,
  SetPermissionsOptions,
} from "../types/index.js";

type PersistedMessage = {
  role?: unknown;
  timestamp?: unknown;
  content?: unknown;
};

type PersistedSession = {
  session_id?: unknown;
  created_at?: unknown;
  last_activity?: unknown;
  metadata?: {
    title?: unknown;
    label?: unknown;
    first_user_preview?: unknown;
    extras?: Record<string, unknown>;
  };
  execution?: { status?: unknown } | null;
  continuation?: { agents?: Record<string, { model?: unknown }> };
  analysis?: { usage_summary?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown } };
  model?: unknown;
};

type FastAgentUsage = { provider?: string; model?: string; cacheRead: number; cacheWrite: number };

type SessionRecord = {
  directory: string;
  snapshot: PersistedSession;
  historyPath: string;
  messages: SessionMessageView[];
  usage: FastAgentUsage;
  liveProcess: boolean;
};

export interface FastAgentFileAdapterOptions {
  /** Existing fast-agent home. This adapter never starts a process. */
  home: string;
  /** Workspace shown for sessions whose persisted metadata has no cwd. */
  cwd?: string;
  /** Fast Agent CLI binary used for resume/send control. */
  fastAgentBin?: string;
}

const READ_ONLY_ERROR = "Fast Agent is connected read-only from its persisted home; start/control remains with fast-agent.";

/**
 * Observes an already-running or previously persisted fast-agent home.
 *
 * Fast-agent's ACP transport is stdio-owned by its parent process, so it is not
 * attachable after the fact. Reading the native session files is the safe seam
 * for Agent Herder's dashboard and transcript tools: it never creates a second
 * fast-agent session or steals an existing stdio stream.
 */
export class FastAgentFileAdapter implements HarnessAdapter {
  readonly type = "fast-agent" as const;
  readonly name = "Fast Agent";
  readonly lazyStart = true;
  readonly lazyDiscovery = true;
  readonly controlCapabilities: HarnessCapabilities = {
    cancelTurn: false,
    detach: false,
    resume: true,
    terminate: false,
    recover: false,
    fork: false,
    modelSwitch: false,
    subagents: false,
    events: false,
  };

  private readonly home: string;
  private readonly sessionsRoot: string;
  private readonly fallbackCwd: string;
  private initialized = false;
  private readonly fastAgentBin: string;

  constructor(options: FastAgentFileAdapterOptions) {
    this.home = resolve(options.home);
    this.sessionsRoot = join(this.home, "sessions");
    this.fallbackCwd = resolve(options.cwd || process.cwd());
    this.fastAgentBin = options.fastAgentBin || process.env.FAST_AGENT_BIN || "/home/roomhacker/.local/bin/fast-agent";
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    const info = await stat(this.home);
    if (!info.isDirectory()) throw new Error(`Fast Agent home is not a directory: ${this.home}`);
    this.initialized = true;
  }

  isReady(): boolean {
    return this.initialized;
  }

  async listSessions(options?: ListSessionsOptions): Promise<AgentSession[]> {
    await this.init();
    const directories = await findSessionDirectories(this.sessionsRoot);
    const records = await Promise.all(directories.map((directory) => this.readRecord(directory)));
    return records
      .filter((record): record is SessionRecord => record !== null)
      .map((record) => this.toSession(record))
      .filter((session) => !options?.cwd || session.cwd === resolve(options.cwd))
      .sort((left, right) => Date.parse(right.lastActivity) - Date.parse(left.lastActivity));
  }

  async getSession(id: string): Promise<AgentSession | null> {
    const sessions = await this.listSessions();
    return sessions.find((session) => session.id === id || session.meta?.nativeSessionId === id) || null;
  }

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    await this.init();
    const id = `fast-agent:launch:${randomUUID()}`;
    const cwd = resolve(options.cwd);
    const args = [
      "go",
      "--name", options.name,
      "--home", this.home,
      "--workspace", cwd,
      "--message", "Session initialized from Agent Herder. Wait for the user's task.",
      "--quiet",
    ];
    if (options.model) args.push("--model", options.model);
    spawnDetachedWorkload(this.fastAgentBin, args, {
      label: "fast-agent-session", cwd, stdio: "ignore",
      env: { ...process.env, FAST_AGENT_HOME: this.home },
    });
    return {
      id, harness: this.type, status: "running", title: options.name, cwd,
      lastActivity: new Date().toISOString(), model: options.model, needsPermission: false, messageCount: 0,
      meta: { transientLaunch: true, readOnly: false },
    };
  }

  async sendMessage(id: string, options: SendMessageOptions): Promise<{ ok: boolean; error?: string }> {
    const session = await this.getSession(id);
    if (!session) return { ok: false, error: `Fast Agent session '${id}' not found` };
    const nativeId = stringValue(session.meta?.nativeSessionId);
    if (!nativeId) return { ok: false, error: `Fast Agent session '${id}' has no native session id` };
    const args = [
      "go", "--home", this.home, "--workspace", session.cwd,
      "--resume", nativeId, "--message", options.message, "--quiet",
    ];
    if (options.queue) {
      try {
        spawnDetachedWorkload(this.fastAgentBin, args, {
          label: "fast-agent-queue", cwd: session.cwd, stdio: "ignore",
          env: { ...process.env, FAST_AGENT_HOME: this.home },
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    return await new Promise((resolveResult) => {
      const child = spawn(this.fastAgentBin, args, {
        cwd: session.cwd, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FAST_AGENT_HOME: this.home },
      });
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
      child.once("error", (error) => resolveResult({ ok: false, error: error.message }));
      child.once("close", (code) => resolveResult(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `fast-agent exited with code ${code}` }));
    });
  }

  async resumeSession(_id: string): Promise<{ ok: boolean; error?: string }> {
    return { ok: true };
  }

  async stopSession(_id: string): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: READ_ONLY_ERROR };
  }

  async respondPermission(_sessionId: string, _permissionId: string, _response: "allow" | "deny", _remember?: boolean): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: READ_ONLY_ERROR };
  }

  async setPermissions(_sessionId: string, _options: SetPermissionsOptions): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: READ_ONLY_ERROR };
  }

  async getTranscript(id: string): Promise<string | null> {
    const record = await this.findRecord(id);
    if (!record) return null;
    return record.messages
      .map((message) => `${capitalize(message.role)}: ${message.text || message.parts.map(partText).filter(Boolean).join(" ")}`)
      .join("\n\n");
  }

  async getRawTranscript(id: string): Promise<RawTranscriptExport | null> {
    const record = await this.findRecord(id);
    if (!record) return null;
    return {
      bytes: await readFile(record.historyPath),
      complete: true,
      source: { kind: "native-file", location: record.historyPath, format: "json" },
      timestampCoverage: "native",
    };
  }

  async getSessionMessages(id: string, limit = 3): Promise<SessionMessageView[] | null> {
    const record = await this.findRecord(id);
    return record ? record.messages.slice(-Math.max(1, limit)) : null;
  }

  async listModels(): Promise<string[]> {
    const models: string[] = [];
    const add = (value: unknown) => {
      if (typeof value !== "string") return;
      const model = value.trim().replace(/^['"]|['"]$/g, "");
      if (model && !models.includes(model)) models.push(model);
    };
    try {
      const config = await readFile(join(this.home, "fast-agent.yaml"), "utf8");
      for (const match of config.matchAll(/^default_model:\s*(.+)$/gm)) add(match[1]);
      const refs = config.match(/model_references:\s*\n([\s\S]*?)(?=^\S|\Z)/m)?.[1] ?? "";
      for (const match of refs.matchAll(/^[ \t]+[A-Za-z0-9_.-]+:[ \t]*(.+)$/gm)) add(match[1]);
    } catch { /* cache can still be populated from logs */ }
    try {
      const log = await readFile(join(this.home, "fast-agent-log.jsonl"), "utf8");
      for (const line of log.split("\n").slice(-5000)) {
        if (!line.includes('"model"')) continue;
        try {
          const row = JSON.parse(line) as { namespace?: unknown; data?: { model?: unknown } };
          const raw = stringValue(row.data?.model);
          if (!raw) continue;
          const ns = stringValue(row.namespace) || "";
          if (ns.includes("codex_responses") && !raw.includes(".")) add(`codexresponses.${raw}`);
          else if (raw === "MiniMax-M3") add("generic.MiniMax-M3");
          else add(raw);
        } catch { /* ignore malformed log rows */ }
      }
    } catch { /* log is optional */ }
    return models.filter((model) => {
      if (!model.includes(".") && models.includes(`codexresponses.${model}`)) return false;
      if (!model.includes(".") && models.includes(`generic.${model}`)) return false;
      if (model === "gpt-5.3-codex-spark" && models.includes("codexspark")) return false;
      return true;
    });
  }

  private async findRecord(id: string): Promise<SessionRecord | null> {
    const sessions = await this.listSessions();
    const session = sessions.find((candidate) => candidate.id === id || candidate.meta?.nativeSessionId === id);
    if (!session) return null;
    const directories = await findSessionDirectories(this.sessionsRoot);
    for (const directory of directories) {
      const record = await this.readRecord(directory);
      if (record && (this.externalId(record.snapshot.session_id as string) === session.id || record.snapshot.session_id === session.meta?.nativeSessionId)) return record;
    }
    return null;
  }

  private async readRecord(directory: string): Promise<SessionRecord | null> {
    try {
      const snapshot = JSON.parse(await readFile(join(directory, "session.json"), "utf8")) as PersistedSession;
      const nativeId = stringValue(snapshot.session_id);
      if (!nativeId) return null;
      const historyPath = await latestHistoryPath(directory);
      if (!historyPath) return null;
      const history = JSON.parse(await readFile(historyPath, "utf8")) as { messages?: unknown };
      const messages = Array.isArray(history.messages)
        ? history.messages.map((message) => messageView(message)).filter((message): message is SessionMessageView => message !== null)
        : [];
      return { directory, snapshot, historyPath, messages, usage: extractFastAgentUsage(history), liveProcess: hasLiveFastAgentProcess(history) };
    } catch {
      return null;
    }
  }

  private toSession(record: SessionRecord): AgentSession {
    const nativeId = stringValue(record.snapshot.session_id)!;
    const executionStatus = stringValue(record.snapshot.execution?.status);
    const messages = record.messages;
    const preview = [...messages].reverse().map((message) => message.text || message.parts.map(partText).filter(Boolean).join(" ")).find(Boolean);
    const firstPreview = stringValue(record.snapshot.metadata?.first_user_preview);
    const title = stringValue(record.snapshot.metadata?.title) || stringValue(record.snapshot.metadata?.label) || firstPreview?.split(/\r?\n/, 1)[0] || `Fast Agent · ${nativeId}`;
    const lastActivity = stringValue(record.snapshot.last_activity) || stringValue(record.snapshot.created_at) || new Date(0).toISOString();
    const status = record.liveProcess ? "running" as const : sessionStatus(executionStatus);
    const usage = record.snapshot.analysis?.usage_summary as Record<string, unknown> | undefined;
    const promptTokens = typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
    const completionTokens = typeof usage?.completion_tokens === "number" ? usage.completion_tokens : undefined;
    const totalTokens = typeof usage?.total_tokens === "number" ? usage.total_tokens : undefined;
    const snapshotModel = stringValue((record.snapshot as Record<string, unknown>).model)
      || stringValue(record.snapshot.continuation?.agents?.dev?.model)
      || stringValue((record.snapshot.metadata as Record<string, unknown> | undefined)?.model);
    const model = snapshotModel || (record.usage.model
      ? record.usage.provider === "generic" ? `generic.${record.usage.model}`
        : record.usage.provider === "codexresponses" ? `codexresponses.${record.usage.model}`
          : record.usage.model
      : undefined);
    return {
      id: this.externalId(nativeId),
      harness: this.type,
      status,
      title: title.slice(0, 240),
      cwd: this.fallbackCwd,
      lastActivity,
      model,
      needsPermission: status === "needs_input",
      messageCount: messages.length,
      lastMessage: preview?.slice(0, 300),
      meta: {
        source: "fast-agent-persisted-home",
        readOnly: true,
        home: this.home,
        sessionDirectory: relative(this.home, record.directory),
        nativeSessionId: nativeId,
        executionStatus: executionStatus || "unknown",
        historyPath: relative(this.home, record.historyPath),
        ...(promptTokens !== undefined ? { input_tokens: promptTokens } : {}),
        ...(completionTokens !== undefined ? { output_tokens: completionTokens } : {}),
        ...(totalTokens !== undefined ? { total_tokens: totalTokens } : {}),
        ...(record.usage.cacheRead > 0 ? { cache_read_tokens: record.usage.cacheRead } : {}),
        ...(record.usage.cacheWrite > 0 ? { cache_write_tokens: record.usage.cacheWrite } : {}),
        ...(record.usage.provider ? { billing_provider: record.usage.provider } : {}),
      },
    };
  }

  private externalId(nativeId: string): string {
    return `fast-agent:${nativeId}`;
  }
}

async function findSessionDirectories(root: string): Promise<string[]> {
  const directories: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return directories;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = join(root, entry.name);
    if (await isDirectory(join(directory, "session.json"))) {
      directories.push(directory);
      continue;
    }
    directories.push(...await findSessionDirectories(directory));
  }
  return directories;
}

async function latestHistoryPath(directory: string): Promise<string | null> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const candidates = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.startsWith("history_") && entry.name.endsWith(".json"))
      .map(async (entry) => ({ path: join(directory, entry.name), mtime: (await stat(join(directory, entry.name))).mtimeMs })));
    candidates.sort((left, right) => right.mtime - left.mtime);
    return candidates[0]?.path || null;
  } catch {
    return null;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function messageView(value: unknown): SessionMessageView | null {
  if (!value || typeof value !== "object") return null;
  const message = value as PersistedMessage;
  const role = message.role === "assistant" || message.role === "user" || message.role === "tool" || message.role === "system" ? message.role : "system";
  const parts = contentParts(message.content);
  return {
    id: `${String(message.timestamp || "message")}-${role}`,
    role,
    timestamp: stringValue(message.timestamp),
    text: parts.filter((part) => part.type === "text" || part.type === "thinking").map(partText).filter(Boolean).join("\n"),
    parts,
  };
}

function contentParts(value: unknown): SessionMessagePart[] {
  if (typeof value === "string") return value ? [{ type: "text", text: value }] : [];
  if (!Array.isArray(value)) return [];
  const parts: SessionMessagePart[] = [];
  for (const block of value) {
    if (typeof block === "string") {
      parts.push({ type: "text", text: block });
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    const type = stringValue(item.type);
    if (type === "text") parts.push({ type: "text", text: stringValue(item.text) || stringValue(item.content) || "" });
    else if (type === "thinking" || type === "reasoning") parts.push({ type: "thinking", text: stringValue(item.text) || stringValue(item.content) || "" });
    else if (type === "tool_use" || type === "tool_call") parts.push({ type: "tool_call", name: stringValue(item.name) || stringValue(item.tool_name) || "tool", input: item.input ?? item.arguments });
    else if (type === "tool_result") parts.push({ type: "tool_result", name: stringValue(item.name), output: stringValue(item.output) || stringValue(item.content), error: item.is_error === true || item.error === true });
  }
  return parts.filter((part) => partText(part) || part.type === "tool_call");
}

function extractFastAgentUsage(history: unknown): FastAgentUsage {
  const result: FastAgentUsage = { cacheRead: 0, cacheWrite: 0 };
  const visit = (value: unknown): void => {
    if (typeof value === "string" && value.includes("fast-agent.usage/v2")) {
      try {
        const parsed = JSON.parse(value) as { schema?: string; provider_attempts?: Array<Record<string, unknown>> };
        if (parsed.schema !== "fast-agent.usage/v2") return;
        for (const attempt of parsed.provider_attempts ?? []) {
          const provider = stringValue(attempt.provider);
          const model = stringValue(attempt.model);
          if (provider) result.provider = provider;
          if (model) result.model = model;
          const prompt = attempt.prompt && typeof attempt.prompt === "object" ? attempt.prompt as Record<string, unknown> : {};
          if (typeof prompt.cache_read === "number") result.cacheRead += prompt.cache_read;
          if (typeof prompt.cache_write === "number") result.cacheWrite += prompt.cache_write;
        }
      } catch { /* not a usage payload */ }
      return;
    }
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (value && typeof value === "object") for (const item of Object.values(value as Record<string, unknown>)) visit(item);
  };
  visit(history);
  return result;
}

function hasLiveFastAgentProcess(history: unknown): boolean {
  const pids = new Set<number>();
  const visit = (value: unknown): void => {
    if (typeof value === "string" && value.includes("os_process_id")) {
      try { visit(JSON.parse(value)); } catch { /* ordinary text */ }
      return;
    }
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (object.process_status === "running" && typeof object.os_process_id === "number" && Number.isSafeInteger(object.os_process_id) && object.os_process_id > 1) {
      pids.add(object.os_process_id);
    }
    for (const item of Object.values(object)) visit(item);
  };
  visit(history);
  for (const pid of pids) {
    try { process.kill(pid, 0); return true; } catch { /* stale persisted PID */ }
  }
  return false;
}

function sessionStatus(status?: string): AgentSession["status"] {
  if (status === "running" || status === "active") return "running";
  if (status === "needs_input" || status === "waiting") return "needs_input";
  if (status === "failed" || status === "error") return "error";
  if (status === "completed" || status === "stopped") return "stopped";
  return "idle";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function partText(part: SessionMessagePart): string {
  return part.text || part.output || "";
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}
