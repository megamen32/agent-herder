import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type {
  AgentSession,
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
};

type SessionRecord = {
  directory: string;
  snapshot: PersistedSession;
  historyPath: string;
  messages: SessionMessageView[];
};

export interface FastAgentFileAdapterOptions {
  /** Existing fast-agent home. This adapter never starts a process. */
  home: string;
  /** Workspace shown for sessions whose persisted metadata has no cwd. */
  cwd?: string;
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
    resume: false,
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

  constructor(options: FastAgentFileAdapterOptions) {
    this.home = resolve(options.home);
    this.sessionsRoot = join(this.home, "sessions");
    this.fallbackCwd = resolve(options.cwd || process.cwd());
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

  async sendMessage(_id: string, _options: SendMessageOptions): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: READ_ONLY_ERROR };
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
    return [];
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
      return { directory, snapshot, historyPath, messages };
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
    const status = sessionStatus(executionStatus);
    return {
      id: this.externalId(nativeId),
      harness: this.type,
      status,
      title: title.slice(0, 240),
      cwd: this.fallbackCwd,
      lastActivity,
      needsPermission: status === "needs_input",
      messageCount: messages.length,
      lastMessage: preview?.slice(0, 300),
      meta: {
        source: "fast-agent-persisted-home",
        home: this.home,
        sessionDirectory: relative(this.home, record.directory),
        nativeSessionId: nativeId,
        executionStatus: executionStatus || "unknown",
        historyPath: relative(this.home, record.historyPath),
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
