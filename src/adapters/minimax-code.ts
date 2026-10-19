import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentSession,
  ControlResult,
  HarnessAdapter,
  HarnessCapabilities,
  ListSessionsOptions,
  SendMessageOptions,
  SendMessageResult,
  SessionMessageView,
  SetPermissionsOptions,
} from "../types/index.js";

/** Root of the MiniMax Code local-runtime session store. */
export const MINIMAX_CODE_SESSION_STORE = join(homedir(), ".minimax", "v2", "sessions");

/**
 * MiniMax Code keeps one working directory for the whole runtime, so its
 * sessions are reported under this pseudo project.
 */
export const MINIMAX_CODE_HARNESS_CWD = join(homedir(), ".minimax");

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_MODEL_BYTES = 512 * 1024;
const MAX_HEAD_BYTES = 96 * 1024;
const MAX_TAIL_BYTES = 96 * 1024;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_TITLE_LENGTH = 120;
const MAX_LAST_MESSAGE_LENGTH = 400;
/** The session index is re-read at most this often. */
const INDEX_TTL_MS = 5_000;

export interface MinimaxCodeAdapterOptions {
  /** Root of the MiniMax Code local-runtime session store. */
  sessionStore?: string;
  /** Pseudo working directory reported for MiniMax Code sessions. */
  cwd?: string;
  /** Upper bound for one enumeration pass. */
  maxSessions?: number;
}

interface MinimaxManifest {
  schemaVersion?: number;
  sessionId?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  source?: string;
  layout?: string;
  paths?: Record<string, string>;
}

interface MinimaxMessageRecord {
  message_id?: string;
  turn_id?: string;
  message?: {
    role?: string;
    content?: unknown;
    provider?: string;
    model?: string;
    timestamp?: string;
  };
  history_artifact?: string;
}

interface MinimaxStoredSession {
  id: string;
  dir: string;
  manifest: MinimaxManifest;
  createdAtMs: number;
  updatedAtMs: number;
}

async function readJsonFile<T>(path: string, maxBytes: number): Promise<T | null> {
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
      if (bytesRead > maxBytes) return null;
      return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as T;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function readTextWindow(path: string, maxBytes: number, fromEnd: boolean): Promise<string> {
  try {
    const handle = await open(path, "r");
    try {
      const info = await handle.stat();
      const length = Math.min(maxBytes, info.size);
      if (length <= 0) return "";
      const position = fromEnd ? info.size - length : 0;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, position);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

function parseRecords(window: string): MinimaxMessageRecord[] {
  const records: MinimaxMessageRecord[] = [];
  for (const line of window.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      records.push(JSON.parse(trimmed) as MinimaxMessageRecord);
    } catch {
      // A truncated or partially written record is skipped, never fatal.
    }
  }
  return records;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (part && typeof part === "object") {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

/** Runtime reminders are injected into user messages and are not a user title. */
function stripRuntimeReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

function truncate(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * The local runtime stores every session in a dated directory whose name ends
 * with the base64url encoded session id.
 */
function decodeSessionKey(directoryName: string): string | null {
  const marker = "-session_";
  const index = directoryName.lastIndexOf(marker);
  if (index < 0) return null;
  const encoded = directoryName.slice(index + marker.length);
  if (!encoded) return null;
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    return decoded.startsWith("mvs_") ? decoded : null;
  } catch {
    return null;
  }
}

async function collectSessionDirectories(root: string, limit: number): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (found.length >= limit || depth > 3) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.name.includes("-session_")) {
        found.push(full);
        if (found.length >= limit) return;
      } else {
        await walk(full, depth + 1);
      }
    }
  };
  await walk(root, 0);
  return found;
}

/**
 * Read-only MiniMax Code harness.
 *
 * MiniMax Code sessions live in the desktop local runtime store
 * (`~/.minimax/v2/sessions/YYYY/MM/DD/<time>-session_<base64url(sessionId)>`).
 * Each session directory owns a `manifest.json` with the native identity, a
 * `llm-call.json` with the last model, and a `messages.jsonl` transcript.
 *
 * Delivery is deliberately not implemented: the desktop runtime owns live
 * sessions in memory, and the standalone agent CLI stores sessions in a
 * different layout (`<agentDir>/sessions/<cwd>`), so neither a file write nor a
 * CLI resume can reach a running desktop session. The control transport for
 * the next revision is the CLI JSON-lines RPC mode (`pi --mode rpc`) together
 * with the OAuth lease broker.
 */
export class MinimaxCodeAdapter implements HarnessAdapter {
  readonly type = "minimax-code" as const;
  readonly name = "MiniMax Code";
  readonly controlCapabilities: HarnessCapabilities = {
    steer: false,
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
  readonly lazyDiscovery = true;

  private readonly sessionStore: string;
  private readonly cwd: string;
  private readonly maxSessions: number;
  private indexCache: { at: number; entries: MinimaxStoredSession[] } | null = null;

  constructor(options: MinimaxCodeAdapterOptions = {}) {
    this.sessionStore = options.sessionStore || MINIMAX_CODE_SESSION_STORE;
    this.cwd = options.cwd || MINIMAX_CODE_HARNESS_CWD;
    this.maxSessions = options.maxSessions || 500;
  }

  async init(): Promise<void> {
    try {
      const info = await stat(this.sessionStore);
      if (!info.isDirectory()) {
        throw new Error(`MiniMax Code session store is not a directory: ${this.sessionStore}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("MiniMax Code session store is not")) throw error;
      throw new Error(`MiniMax Code session store not found at ${this.sessionStore}`);
    }
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<AgentSession[]> {
    if (options.cwd && options.cwd !== this.cwd) return [];
    const stored = await this.readStoredSessions();
    const limited = options.limit ? stored.slice(0, options.limit) : stored;
    const sessions: AgentSession[] = [];
    for (const entry of limited) sessions.push(await this.toSession(entry));
    return sessions;
  }

  async findNamedSessions(name: string, cwd: string): Promise<AgentSession[]> {
    if (cwd !== this.cwd) return [];
    const normalized = name.trim();
    if (!normalized) return [];
    const sessions = await this.listSessions();
    return sessions.filter((session) => session.title.trim() === normalized);
  }

  async getSession(id: string): Promise<AgentSession | null> {
    const stored = await this.readStoredSessions();
    const entry = stored.find((candidate) => candidate.id === id);
    return entry ? this.toSession(entry) : null;
  }

  async getTranscript(id: string): Promise<string | null> {
    const stored = await this.readStoredSessions();
    const entry = stored.find((candidate) => candidate.id === id);
    if (!entry) return null;
    const window = await readTextWindow(join(entry.dir, "messages.jsonl"), MAX_TRANSCRIPT_BYTES, false);
    if (!window.trim()) return "";
    const lines: string[] = [];
    for (const record of parseRecords(window)) {
      const message = record.message;
      if (!message?.role) continue;
      const text = extractText(message.content).trim();
      if (!text) continue;
      lines.push(`## ${message.role}\n${text}`);
    }
    return lines.join("\n\n");
  }

  async getSessionMessages(id: string, limit = 100): Promise<SessionMessageView[] | null> {
    const stored = await this.readStoredSessions();
    const entry = stored.find((candidate) => candidate.id === id);
    if (!entry) return null;
    const window = await readTextWindow(join(entry.dir, "messages.jsonl"), MAX_TRANSCRIPT_BYTES, false);
    const views: SessionMessageView[] = [];
    for (const record of parseRecords(window)) {
      const message = record.message;
      const role = message?.role;
      if (!role) continue;
      const text = extractText(message.content);
      if (!text.trim()) continue;
      views.push({
        id: record.message_id || `${entry.id}:${views.length}`,
        role: role === "user" || role === "assistant" || role === "tool" ? role : "system",
        turnId: record.turn_id,
        timestamp: message.timestamp,
        model: message.model,
        text,
        parts: [{ type: "text", text }],
      });
    }
    return limit > 0 ? views.slice(-limit) : views;
  }

  async sendMessage(_id: string, _options: SendMessageOptions): Promise<SendMessageResult> {
    return {
      ok: false,
      error: "MiniMax Code desktop sessions are owned by the local runtime; Herder cannot write to them",
    };
  }

  async stopSession(): Promise<ControlResult> {
    return { ok: false, error: "MiniMax Code turn cancellation is not exposed to external readers" };
  }

  async respondPermission(): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: "MiniMax Code permission prompts are handled inside the desktop runtime" };
  }

  async setPermissions(_sessionId: string, _options: SetPermissionsOptions): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: "MiniMax Code permissions are controlled by the MiniMax Code product surface" };
  }

  private async readStoredSessions(): Promise<MinimaxStoredSession[]> {
    const now = Date.now();
    if (this.indexCache && now - this.indexCache.at < INDEX_TTL_MS) return this.indexCache.entries;
    const directories = await collectSessionDirectories(this.sessionStore, this.maxSessions);
    const sessions: MinimaxStoredSession[] = [];
    for (const dir of directories) {
      const manifest = await readJsonFile<MinimaxManifest>(join(dir, "manifest.json"), MAX_MANIFEST_BYTES);
      const id = manifest?.sessionId || decodeSessionKey(dir.slice(dir.lastIndexOf("/") + 1));
      if (!id) continue;
      const createdAtMs = manifest?.createdAtMs ?? 0;
      const updatedAtMs = manifest?.updatedAtMs ?? createdAtMs;
      sessions.push({ id, dir, manifest: manifest ?? {}, createdAtMs, updatedAtMs });
    }
    sessions.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
    this.indexCache = { at: now, entries: sessions };
    return sessions;
  }

  private async toSession(entry: MinimaxStoredSession): Promise<AgentSession> {
    const [title, lastMessage, model] = await Promise.all([
      this.readTitle(entry),
      this.readLastMessage(entry),
      this.readModel(entry),
    ]);
    return {
      id: entry.id,
      harness: "minimax-code",
      status: "idle",
      title,
      cwd: this.cwd,
      lastActivity: new Date(entry.updatedAtMs || entry.createdAtMs || 0).toISOString(),
      model,
      needsPermission: false,
      lastMessage,
      meta: {
        transport: "minimax-code-local-runtime-store",
        readOnly: true,
        liveStatus: "unknown",
        layout: entry.manifest.layout,
        source: entry.manifest.source,
        sessionDir: entry.dir,
      },
    };
  }

  private async readTitle(entry: MinimaxStoredSession): Promise<string> {
    const window = await readTextWindow(join(entry.dir, "messages.jsonl"), MAX_HEAD_BYTES, false);
    for (const record of parseRecords(window)) {
      if (record.message?.role !== "user") continue;
      const text = stripRuntimeReminders(extractText(record.message.content));
      if (!text) continue;
      return truncate(text, MAX_TITLE_LENGTH);
    }
    return `MiniMax Code session ${entry.id.slice(-8)}`;
  }

  private async readLastMessage(entry: MinimaxStoredSession): Promise<string | undefined> {
    const window = await readTextWindow(join(entry.dir, "messages.jsonl"), MAX_TAIL_BYTES, true);
    const records = parseRecords(window);
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const message = records[index]?.message;
      if (!message?.role) continue;
      const text = extractText(message.content).trim();
      if (!text) continue;
      return truncate(text, MAX_LAST_MESSAGE_LENGTH);
    }
    return undefined;
  }

  private async readModel(entry: MinimaxStoredSession): Promise<string | undefined> {
    const call = await readJsonFile<{ model?: string; provider?: string }>(
      join(entry.dir, "llm-call.json"),
      MAX_MODEL_BYTES,
    );
    if (!call?.model) return undefined;
    return call.provider ? `${call.provider}/${call.model}` : call.model;
  }
}
