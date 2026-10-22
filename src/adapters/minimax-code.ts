import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { MinimaxCodeControl } from "./minimax-code-control.js";
import { MINIMAX_CODE_HARNESS_CWD, MINIMAX_CODE_SESSION_STORE } from "./minimax-code-store.js";
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
import { localSessionHostId } from "../types/index.js";

/** Store of the MiniMax Code local runtime, shared with the mesh observer. */
export { MINIMAX_CODE_SESSION_STORE, MINIMAX_CODE_HARNESS_CWD };

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_MODEL_BYTES = 512 * 1024;
/** Head window used to find the first user message that becomes the title. */
const TITLE_WINDOW_BYTES = 64 * 1024;
const TITLE_FALLBACK_BYTES = 256 * 1024;
/** Tail window used to find the last message of a session. */
const TAIL_WINDOW_BYTES = 32 * 1024;
const TAIL_FALLBACK_BYTES = [128 * 1024, 512 * 1024];
/** Upper bound of transcript bytes read from the message log. */
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
/** Upper bound of transcript text kept in memory. */
const MAX_TRANSCRIPT_TEXT = 2 * 1024 * 1024;
/** Upper bound of one rendered message. */
const MAX_MESSAGE_CHARS = 64 * 1024;
/** Upper bound of all retained message text. */
const MAX_RETAINED_CHARS = 4 * 1024 * 1024;
const MAX_MESSAGE_LIMIT = 5_000;
const MAX_TITLE_LENGTH = 120;
const MAX_LAST_MESSAGE_LENGTH = 400;
/** The session index is re-read at most this often. */
const INDEX_TTL_MS = 10_000;

export interface MinimaxCodeAdapterOptions {
  /** Root of the MiniMax Code local-runtime session store. */
  sessionStore?: string;
  /** Pseudo working directory reported for MiniMax Code sessions. */
  cwd?: string;
  /** Upper bound for one enumeration pass. */
  maxSessions?: number;
  /** Live control transport published by the desktop app. */
  control?: MinimaxCodeControl;
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

/**
 * Streams complete lines of a file without ever holding the whole file in
 * memory. The fleet node runs under a hard RSS contract, so a 17MiB message
 * log must never become one 17MiB buffer.
 */
async function* readLines(path: string, maxBytes: number): AsyncGenerator<string> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return;
  }
  try {
    const info = await handle.stat();
    const total = Math.min(maxBytes, info.size);
    if (total <= 0) return;
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const decoder = new StringDecoder("utf8");
    let position = 0;
    let pending = "";
    while (position < total) {
      const wanted = Math.min(chunk.length, total - position);
      const { bytesRead } = await handle.read(chunk, 0, wanted, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      pending += decoder.write(chunk.subarray(0, bytesRead));
      let start = 0;
      let index = pending.indexOf("\n");
      while (index >= 0) {
        yield pending.slice(start, index);
        start = index + 1;
        index = pending.indexOf("\n", start);
      }
      pending = start > 0 ? pending.slice(start) : pending;
    }
    pending += decoder.end();
    if (pending.length > 0) yield pending;
  } catch {
    return;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseRecord(line: string): MinimaxMessageRecord | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as MinimaxMessageRecord;
  } catch {
    // A truncated or partially written record is skipped, never fatal.
    return null;
  }
}

function extractText(content: unknown, maxLength = Number.MAX_SAFE_INTEGER): string {
  if (typeof content === "string") return content.length > maxLength ? content.slice(0, maxLength) : content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  let total = 0;
  for (const part of content) {
    if (total >= maxLength) break;
    if (typeof part === "string") {
      parts.push(part);
      total += part.length;
      continue;
    }
    if (part && typeof part === "object") {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") {
        parts.push(text);
        total += text.length;
      }
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

interface FileStamp {
  mtimeMs: number;
  size: number;
}

async function stampFile(path: string): Promise<FileStamp | null> {
  try {
    const info = await stat(path);
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return null;
  }
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
 * Delivery is implemented against the live runtime of the desktop app. The app
 * publishes that runtime on loopback HTTP while it runs, and the transport
 * reaches the very session the app is showing, so a prompt can steer the
 * running turn, sit in the queue for the next turn, or start a turn outright.
 * The store on disk stays the enumeration source: it survives a closed app and
 * it never writes into a session the app owns.
 *
 * Enumeration cost is bounded on purpose. The fleet node is supervised under
 * a hard RSS contract, so a poll must not re-read and re-parse every message
 * log: the index is cached, the rendered session is cached against the file
 * stamp of its own transcript, and transcripts are streamed line by line.
 */
export class MinimaxCodeAdapter implements HarnessAdapter {
  readonly type = "minimax-code" as const;
  readonly name = "MiniMax Code";
  readonly lazyDiscovery = true;

  private readonly sessionStore: string;
  private readonly cwd: string;
  private readonly maxSessions: number;
  private readonly control: MinimaxCodeControl;
  private indexCache: { at: number; entries: MinimaxStoredSession[] } | null = null;
  private contentCache = new Map<string, { stamp: string; session: AgentSession }>();
  private liveControlAvailable = false;

  constructor(options: MinimaxCodeAdapterOptions = {}) {
    this.sessionStore = options.sessionStore || MINIMAX_CODE_SESSION_STORE;
    this.cwd = options.cwd || MINIMAX_CODE_HARNESS_CWD;
    this.maxSessions = options.maxSessions || 500;
    this.control = options.control || new MinimaxCodeControl();
  }

  /**
   * Native controls of the live transport. They exist only while the desktop
   * app publishes its runtime, so the gate follows the transport instead of
   * promising a write that would fail.
   */
  get controlCapabilities(): HarnessCapabilities {
    const live = this.liveControlAvailable;
    return {
      steer: live,
      cancelTurn: live,
      detach: false,
      resume: false,
      terminate: false,
      recover: false,
      fork: false,
      modelSwitch: false,
      subagents: false,
      events: false,
    };
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
    this.liveControlAvailable = await this.control.available();
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<AgentSession[]> {
    if (options.cwd && options.cwd !== this.cwd) return [];
    // The live transport can appear or disappear with the desktop app, so the
    // capability gate follows it instead of the process start.
    void this.liveControl();
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
    const blocks: string[] = [];
    let size = 0;
    for await (const line of readLines(join(entry.dir, "messages.jsonl"), MAX_TRANSCRIPT_BYTES)) {
      const record = parseRecord(line);
      if (!record) continue;
      const message = record.message;
      if (!message?.role) continue;
      const text = extractText(message.content, MAX_MESSAGE_CHARS).trim();
      if (!text) continue;
      const block = `## ${message.role}\n${text}`;
      blocks.push(block);
      size += block.length;
      if (size >= MAX_TRANSCRIPT_TEXT) break;
    }
    return blocks.join("\n\n");
  }

  async getSessionMessages(id: string, limit = 100): Promise<SessionMessageView[] | null> {
    const stored = await this.readStoredSessions();
    const entry = stored.find((candidate) => candidate.id === id);
    if (!entry) return null;
    const views: SessionMessageView[] = [];
    const keep = limit > 0 ? limit : MAX_MESSAGE_LIMIT;
    let retained = 0;
    let total = 0;
    for await (const line of readLines(join(entry.dir, "messages.jsonl"), MAX_TRANSCRIPT_BYTES)) {
      const record = parseRecord(line);
      if (!record) continue;
      const message = record.message;
      const role = message?.role;
      if (!role) continue;
      const text = extractText(message.content, MAX_MESSAGE_CHARS);
      if (!text.trim()) continue;
      total += 1;
      views.push({
        id: record.message_id || `${entry.id}:${total}`,
        role: role === "user" || role === "assistant" || role === "tool" ? role : "system",
        turnId: record.turn_id,
        timestamp: message.timestamp,
        model: message.model,
        text,
        parts: [{ type: "text", text }],
      });
      retained += text.length;
      while (views.length > keep || (retained > MAX_RETAINED_CHARS && views.length > 1)) {
        const dropped = views.shift();
        retained -= dropped?.text?.length ?? 0;
      }
    }
    return views;
  }

  async sendMessage(id: string, options: SendMessageOptions): Promise<SendMessageResult> {
    const control = await this.liveControl();
    if (!control) {
      return {
        ok: false,
        error: "MiniMax Code desktop sessions are owned by the local runtime; publish the desktop control transport to deliver messages",
      };
    }
    if (options.steer === true) {
      const result = await control.steer(id, options.message);
      if (!result.ok) return { ok: false, error: result.error };
      const body = (result.body ?? {}) as { success?: boolean; turn_id?: string; item_id?: string };
      return { ok: true, admitted: true, turnId: body.turn_id ?? body.item_id, ...(options.inputId ? { inputId: options.inputId } : {}) };
    }
    if (options.queue === true) {
      const result = await control.enqueue(id, options.message);
      if (!result.ok) return { ok: false, error: result.error };
      const body = (result.body ?? {}) as { item_id?: string; status?: string };
      return { ok: true, admitted: true, turnId: body.item_id, ...(options.inputId ? { inputId: options.inputId } : {}) };
    }
    const result = await control.sendMessage(id, options.message);
    if (!result.ok) {
      // A running turn owns the session: the desktop app queues such a message
      // instead of failing the delivery.
      if (!/busy|active turn/i.test(result.error ?? "")) return { ok: false, error: result.error };
      const queued = await control.enqueue(id, options.message);
      if (!queued.ok) return { ok: false, error: queued.error };
      const body = (queued.body ?? {}) as { item_id?: string };
      return { ok: true, admitted: true, turnId: body.item_id, ...(options.inputId ? { inputId: options.inputId } : {}) };
    }
    const body = (result.body ?? {}) as { turn_id?: string; id?: string };
    return { ok: true, admitted: true, turnId: body.turn_id ?? body.id, ...(options.inputId ? { inputId: options.inputId } : {}) };
  }

  async stopSession(id: string): Promise<ControlResult> {
    const control = await this.liveControl();
    if (!control) {
      return { ok: false, error: "MiniMax Code turn cancellation needs the desktop control transport" };
    }
    const result = await control.abort(id);
    if (!result.ok) return { ok: false, error: result.error };
    const body = (result.body ?? {}) as { success?: boolean };
    return { ok: body.success !== false, sessionId: id };
  }

  async cancelTurn(id: string): Promise<ControlResult> {
    return this.stopSession(id);
  }

  async respondPermission(
    _sessionId: string,
    _permissionId: string,
    _response: "allow" | "deny",
    _remember?: boolean,
  ): Promise<{ ok: boolean; error?: string }> {
    return {
      ok: false,
      error: "MiniMax Code permission replies are addressed to a pending request of the desktop runtime; Herder has no request identity yet",
    };
  }

  async setPermissions(_sessionId: string, _options: SetPermissionsOptions): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: "MiniMax Code permissions are controlled by the MiniMax Code product surface" };
  }

  /** Live control transport of the desktop app, when it publishes one. */
  private async liveControl(): Promise<MinimaxCodeControl | null> {
    const available = await this.control.available();
    this.liveControlAvailable = available;
    return available ? this.control : null;
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
    const live = new Set(sessions.map((session) => session.id));
    for (const id of this.contentCache.keys()) {
      if (!live.has(id)) this.contentCache.delete(id);
    }
    return sessions;
  }

  private async toSession(entry: MinimaxStoredSession): Promise<AgentSession> {
    const stamp = await this.transcriptStamp(entry);
    const cached = this.contentCache.get(entry.id);
    if (cached && cached.stamp === stamp) return cached.session;
    const [title, lastMessage, model] = await Promise.all([
      this.readTitle(entry),
      this.readLastMessage(entry),
      this.readModel(entry),
    ]);
    const session: AgentSession = {
      id: entry.id,
      harness: "minimax-code",
      status: "idle",
      title,
      cwd: this.cwd,
      hostId: localSessionHostId(),
      lastActivity: new Date(entry.updatedAtMs || entry.createdAtMs || 0).toISOString(),
      model,
      needsPermission: false,
      lastMessage,
      meta: {
        transport: "minimax-code-local-runtime-store",
        readOnly: true,
        liveStatus: "unknown",
        // The runtime keeps one working directory for every session, so the
        // reported cwd is a pseudo project: the work directory of a session is
        // only known once the session declares it.
        workDirectory: "pseudo",
        layout: entry.manifest.layout,
        source: entry.manifest.source,
        sessionDir: entry.dir,
      },
    };
    this.contentCache.set(entry.id, { stamp, session });
    return session;
  }

  /** Fingerprint of the files a rendered session is derived from. */
  private async transcriptStamp(entry: MinimaxStoredSession): Promise<string> {
    const messages = await stampFile(join(entry.dir, "messages.jsonl"));
    const call = await stampFile(join(entry.dir, "llm-call.json"));
    return `${messages?.mtimeMs ?? 0}:${messages?.size ?? 0}:${call?.mtimeMs ?? 0}:${call?.size ?? 0}`;
  }

  private async readTitle(entry: MinimaxStoredSession): Promise<string> {
    const path = join(entry.dir, "messages.jsonl");
    for (const size of [TITLE_WINDOW_BYTES, TITLE_FALLBACK_BYTES]) {
      const window = await readTextWindow(path, size, false);
      for (const line of window.split("\n")) {
        const record = parseRecord(line);
        if (!record) continue;
        if (record.message?.role !== "user") continue;
        const text = stripRuntimeReminders(extractText(record.message.content, 4096));
        if (!text) continue;
        return truncate(text, MAX_TITLE_LENGTH);
      }
      if (window.length < size) break;
    }
    return `MiniMax Code session ${entry.id.slice(-8)}`;
  }

  private async readLastMessage(entry: MinimaxStoredSession): Promise<string | undefined> {
    const path = join(entry.dir, "messages.jsonl");
    for (const size of [TAIL_WINDOW_BYTES, ...TAIL_FALLBACK_BYTES]) {
      const window = await readTextWindow(path, size, true);
      const lines = window.split("\n");
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const record = parseRecord(lines[index]);
        if (!record) continue;
        const message = record.message;
        if (!message?.role) continue;
        const text = extractText(message.content, 4096).trim();
        if (!text) continue;
        return truncate(text, MAX_LAST_MESSAGE_LENGTH);
      }
      if (window.length < size) break;
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
