import { randomUUID } from "node:crypto";
import { mkdir, lstat, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ChatGptAccountExportDriver } from "./chatgpt-account-archive.js";

export type ChatView = "unread" | "working" | "recent";

export interface PageIdentity {
  origin: string;
  accountRef: string;
  pageRef: string;
  leaseRef: string;
}

export interface MediaRecord {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface MessageRecord {
  id: string;
  role: string;
  text: string;
  version: number;
  createdAt: string;
  media: MediaRecord[];
}

export interface ChatRecord {
  id: string;
  title: string;
  unread: boolean;
  working: boolean;
  updatedAt: string;
  messages: MessageRecord[];
}

export interface ChatSnapshot {
  chats: ChatRecord[];
}

export interface DownloadedMedia {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

/** The narrow page seam implemented by a BrowserClaw/CDP adapter. */
export interface CdpChatPage {
  identity(): Promise<PageIdentity>;
  snapshot(): Promise<ChatSnapshot>;
  createChat(input: { title?: string }): Promise<ChatRecord>;
  sendMessage(input: { chatId: string; text: string }): Promise<MessageRecord>;
  editMessage(input: {
    chatId: string;
    messageId: string;
    text: string;
    expectedVersion?: number;
    expectedText?: string;
  }): Promise<MessageRecord>;
  downloadMedia(input: { chatId: string; messageId: string; mediaId: string }): Promise<DownloadedMedia>;
}

export type CdpChatOperation =
  | "new_chat"
  | "list_chats"
  | "search_chat"
  | "export_chat"
  | "send_message"
  | "edit_message"
  | "download_media";

export type CdpChatCapabilities = Readonly<Record<CdpChatOperation, boolean>>;

export const ALL_CDP_CHAT_CAPABILITIES: CdpChatCapabilities = {
  new_chat: true,
  list_chats: true,
  search_chat: true,
  export_chat: true,
  send_message: true,
  edit_message: true,
  download_media: true,
};

/** Acquires the one authenticated page owned by this MCP process. */
export interface CdpChatDriver {
  acquirePage(): Promise<CdpChatPage>;
  /** Undefined keeps the original full-driver contract; concrete partial drivers must opt out explicitly. */
  capabilities?: CdpChatCapabilities;
  /** Optional account-wide export action sharing this driver's one BrowserClaw page lease. */
  accountExportDriver?: ChatGptAccountExportDriver;
}

export interface CdpChatOptions {
  mediaRoot?: string;
  recentWindowMs?: number;
  maxExportBytes?: number;
  maxMediaBytes?: number;
  allowedMediaTypes?: ReadonlySet<string>;
  writeGateTtlMs?: number;
  now?: () => number;
}

export interface NewChatInput {
  confirmation: string;
  idempotencyKey: string;
  title?: string;
}

export interface ListChatsInput {
  view: ChatView;
  limit?: number;
  cursor?: string;
}

export interface SearchChatInput {
  query: string;
  limit?: number;
}

export interface ExportChatInput {
  chatRef: string;
  format: "json" | "markdown";
  maxMessages?: number;
}

export interface SendMessageInput {
  chatRef: string;
  text: string;
  confirmation: string;
  idempotencyKey: string;
}

export interface EditMessageInput {
  chatRef: string;
  messageRef: string;
  text: string;
  confirmation: string;
  idempotencyKey: string;
  expectedVersion?: number;
  expectedText?: string;
}

export interface DownloadMediaInput {
  chatRef: string;
  messageRef: string;
  mediaRef: string;
  outputDir?: string;
}

export interface FixtureReceipt {
  origin: string;
  accountRef: string;
  pageRef: string;
  leaseRef: string;
  chatRef: string;
}

export interface PublicChat {
  chatRef: string;
  title: string;
  unread: boolean;
  working: boolean;
  updatedAt: string;
  fixtureBound: boolean;
  matchedMessageRefs?: string[];
}

export interface ListChatsResult {
  view: ChatView;
  semantics: string;
  chats: PublicChat[];
  nextCursor?: string;
}

export interface SearchChatResult {
  query: string;
  semantics: string;
  chats: PublicChat[];
}

export interface NewChatResult {
  chatRef: string;
  fixture: true;
  receipt: FixtureReceipt;
}

export interface ExportedMedia {
  mediaRef: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface ExportedMessage {
  messageRef: string;
  role: string;
  text: string;
  version: number;
  createdAt: string;
  media: ExportedMedia[];
}

export interface ExportChatResult {
  chatRef: string;
  format: "json" | "markdown";
  content: string;
  messages: ExportedMessage[];
  truncated: boolean;
}

export interface SendMessageResult {
  chatRef: string;
  messageRef: string;
  message: ExportedMessage;
}

export interface EditMessageResult {
  chatRef: string;
  messageRef: string;
  message: ExportedMessage;
}

export interface DownloadMediaResult {
  chatRef: string;
  messageRef: string;
  mediaRef: string;
  path: string;
  bytes: number;
  mimeType: string;
}

type RefKind = "chat" | "message" | "media";

interface RefBinding {
  kind: RefKind;
  rawId: string;
  identity: PageIdentity;
  chatRawId?: string;
  messageRawId?: string;
  fixture: boolean;
}

interface FixtureBinding {
  identity: PageIdentity;
  rawChatId: string;
  chatRef: string;
}

interface GateRecord {
  fingerprint: string;
  createdAt: number;
  used: boolean;
}

const DEFAULT_ALLOWED_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "text/plain",
]);

const DEFAULT_OPTIONS: Required<Omit<CdpChatOptions, "allowedMediaTypes" | "now">> = {
  mediaRoot: resolve(process.cwd(), "cdp-chat-media"),
  recentWindowMs: 7 * 24 * 60 * 60 * 1000,
  maxExportBytes: 64 * 1024,
  maxMediaBytes: 5 * 1024 * 1024,
  writeGateTtlMs: 60 * 1000,
};

/** Error raised when the page, fixture, or bounded output policy is unsafe. */
export class CdpChatError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CdpChatError";
  }
}

/** Return a deterministic JSON representation for an idempotency fingerprint. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

/** Validate and normalize an opaque identifier supplied by the page seam. */
function requireOpaque(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || !/^[A-Za-z0-9._:/=-]+$/.test(value)) {
    throw new CdpChatError("invalid_page_identity", `${label} must be a compact opaque reference`);
  }
  return value;
}

/** Validate the page identity without exposing cookies, handles, or DOM objects. */
function validateIdentity(input: PageIdentity): PageIdentity {
  let origin: string;
  try {
    const parsed = new URL(input.origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== input.origin) throw new Error("origin");
    origin = parsed.origin;
  } catch {
    throw new CdpChatError("invalid_page_identity", "page origin must be an http(s) origin");
  }
  return {
    origin,
    accountRef: requireOpaque(input.accountRef, "accountRef"),
    pageRef: requireOpaque(input.pageRef, "pageRef"),
    leaseRef: requireOpaque(input.leaseRef, "leaseRef"),
  };
}

/** Compare all ownership coordinates that make a page lease safe to reuse. */
function sameIdentity(left: PageIdentity, right: PageIdentity): boolean {
  return left.origin === right.origin && left.accountRef === right.accountRef && left.pageRef === right.pageRef && left.leaseRef === right.leaseRef;
}

/** Return a stable in-process key for one page lease and raw object. */
function identityKey(identity: PageIdentity): string {
  return `${identity.origin}|${identity.accountRef}|${identity.pageRef}|${identity.leaseRef}`;
}

/** Measure UTF-8 bytes rather than JavaScript code units for output bounds. */
function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Truncate text to a UTF-8 byte limit without splitting a surrogate pair. */
function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  let end = Math.max(0, Math.min(value.length, maxBytes));
  while (end > 0 && byteLength(value.slice(0, end)) > maxBytes) end -= 1;
  return value.slice(0, end);
}

/** Encode a page offset as a bounded opaque cursor. */
function encodeCursor(offset: number): string {
  return `cursor:v1:${Buffer.from(String(offset), "utf8").toString("base64url")}`;
}

/** Decode and validate an opaque pagination cursor. */
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = /^cursor:v1:([A-Za-z0-9_-]+)$/.exec(cursor);
  if (!match) throw new CdpChatError("invalid_cursor", "cursor is invalid or belongs to another route");
  const offset = Number(Buffer.from(match[1], "base64url").toString("utf8"));
  if (!Number.isSafeInteger(offset) || offset < 0) throw new CdpChatError("invalid_cursor", "cursor offset is invalid");
  return offset;
}

/** Keep a list limit within the deliberately small fast-path bound. */
function boundedLimit(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > 100) throw new CdpChatError("invalid_limit", "limit must be an integer from 1 to 100");
  return result;
}

/** Check that a resolved path stays under its configured root. */
function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !path.includes(`..${sep}`) && !isAbsolute(path));
}

/** Replace unsafe filename characters while rejecting explicit path traversal. */
function safeFilename(filename: string): string {
  if (!filename || filename === "." || filename === ".." || /[\\/]/.test(filename)) {
    throw new CdpChatError("invalid_media_name", "media filename must not contain path separators");
  }
  const cleaned = filename.replace(/[\u0000-\u001f\u007f]/g, "_").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  if (!cleaned || cleaned === "." || cleaned === "..") throw new CdpChatError("invalid_media_name", "media filename is empty after validation");
  return cleaned;
}

/** Build the bounded Markdown representation of exported messages. */
function markdownExport(chat: ChatRecord, messages: ExportedMessage[]): string {
  const lines = [`# ${chat.title}`, `Updated: ${chat.updatedAt}`, ""];
  for (const entry of messages) {
    lines.push(`## ${entry.role} (${entry.messageRef})`, entry.text, "");
    for (const media of entry.media) lines.push(`Attachment: ${media.filename} (${media.mimeType}, ${media.mediaRef})`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Create a JSON or Markdown export while preserving a truncation marker. */
function buildBoundedExport(chat: ChatRecord, chatRef: string, messages: ExportedMessage[], format: "json" | "markdown", maxBytes: number): { content: string; messages: ExportedMessage[]; truncated: boolean } {
  let selected = messages.slice();
  let truncated = false;
  const render = (): string => format === "json"
    ? JSON.stringify({ chatRef, title: chat.title, updatedAt: chat.updatedAt, messages: selected, truncated })
    : markdownExport(chat, selected) + (truncated ? "\n[TRUNCATED: max export bytes]\n" : "");

  let content = render();
  for (let attempt = 0; byteLength(content) > maxBytes && attempt < 32; attempt += 1) {
    truncated = true;
    if (selected.length > 1) {
      selected = selected.slice(0, -1);
    } else if (selected.length === 1 && selected[0].text.length > 0) {
      selected = [{ ...selected[0], text: selected[0].text.slice(0, Math.max(0, Math.floor(selected[0].text.length / 2))) }];
    } else if (selected.length === 1 && selected[0].media.length > 0) {
      selected = [{ ...selected[0], media: [] }];
    } else {
      selected = [];
    }
    content = render();
  }
  if (byteLength(content) > maxBytes) {
    truncated = true;
    if (format === "json") {
      content = JSON.stringify({ chatRef, messages: [], truncated: true, truncation: "max_export_bytes" });
    } else {
      content = truncateUtf8("[TRUNCATED: max export bytes]", maxBytes);
    }
  }
  return { content, messages: selected, truncated };
}

/** Read a real path and reject symlinked or escaping media directories. */
async function confinedDirectory(rootInput: string, requested: string | undefined): Promise<string> {
  const root = resolve(rootInput);
  await mkdir(root, { recursive: true });
  const realRoot = await realpath(root);
  const candidate = requested ? (isAbsolute(requested) ? resolve(requested) : resolve(realRoot, requested)) : realRoot;

  if (!isInside(realRoot, candidate)) throw new CdpChatError("media_path_escape", "outputDir must stay inside the configured media root");
  let existingAncestor = candidate;
  let realAncestor: string;
  while (true) {
    try {
      realAncestor = await realpath(existingAncestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      existingAncestor = parent;
    }
  }
  if (!isInside(realRoot, realAncestor)) throw new CdpChatError("media_path_escape", "outputDir must stay inside the configured media root");

  await mkdir(candidate, { recursive: true });
  const realCandidate = await realpath(candidate);
  if (!isInside(realRoot, realCandidate)) throw new CdpChatError("media_path_escape", "outputDir must stay inside the configured media root");
  return realCandidate;
}

/** Standalone ChatGPT/E-Frontier adapter with fixture and page-lease safety. */
export class CdpChatClient {
  private readonly options: Required<Omit<CdpChatOptions, "allowedMediaTypes" | "now">> & { allowedMediaTypes: ReadonlySet<string>; now: () => number };
  private readonly refs = new Map<string, RefBinding>();
  private readonly chatRefs = new Map<string, string>();
  private readonly messageRefs = new Map<string, string>();
  private readonly mediaRefs = new Map<string, string>();
  private readonly gates = new Map<string, GateRecord>();
  private boundIdentity?: PageIdentity;
  private fixture?: FixtureBinding;
  private newChatInFlight = false;

  /** Construct a client around one injected CDP page driver. */
  constructor(private readonly driver: CdpChatDriver, options: CdpChatOptions = {}) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
      mediaRoot: resolve(options.mediaRoot ?? DEFAULT_OPTIONS.mediaRoot),
      allowedMediaTypes: options.allowedMediaTypes ?? DEFAULT_ALLOWED_MEDIA_TYPES,
      now: options.now ?? Date.now,
    };
    if (this.options.recentWindowMs < 1 || this.options.maxExportBytes < 256 || this.options.maxMediaBytes < 1 || this.options.writeGateTtlMs < 1) {
      throw new CdpChatError("invalid_options", "bounds and TTL must be positive; maxExportBytes must be at least 256");
    }
  }

  /** Create and bind exactly one disposable fixture chat without submitting a prompt. */
  async newChat(input: NewChatInput): Promise<NewChatResult> {
    if (this.fixture) throw new CdpChatError("fixture_already_bound", "this MCP client already owns one disposable fixture");
    if (input.confirmation !== "NEW_CHAT") throw new CdpChatError("confirmation_required", "new_chat requires confirmation NEW_CHAT");
    const key = requireOpaque(input.idempotencyKey, "idempotencyKey");
    if (input.title !== undefined && (input.title.trim().length === 0 || input.title.length > 256)) throw new CdpChatError("invalid_title", "title must contain 1 to 256 characters");
    if (this.newChatInFlight) throw new CdpChatError("new_chat_in_progress", "another disposable fixture is currently being created");
    this.newChatInFlight = true;
    try {
      this.consumeGate("new_chat", key, { title: input.title ?? "" });
      return await this.withPage("new_chat", async (page, pageIdentity) => {
        const before = await page.snapshot();
        const existingChatIds = new Set(before.chats.map((chat) => chat.id));
        const record = await page.createChat({ title: input.title?.trim() });
        if (!record.id) throw new CdpChatError("invalid_page_result", "new_chat returned no chat identity");
        if (existingChatIds.has(record.id)) throw new CdpChatError("fixture_not_new", "new_chat returned a chat that was already visible before creation");
        const after = await page.snapshot();
        if (!after.chats.some((chat) => chat.id === record.id)) throw new CdpChatError("fixture_not_visible", "new_chat result was not visible in the post-create page snapshot");
        const chatRef = this.rememberChat(record.id, pageIdentity);
        this.fixture = { identity: pageIdentity, rawChatId: record.id, chatRef };
        const binding = this.refs.get(chatRef);
        if (binding) binding.fixture = true;
        return {
          chatRef,
          fixture: true as const,
          receipt: { ...pageIdentity, chatRef },
        };
      });
    } finally {
      this.newChatInFlight = false;
    }
  }

  /** List page-visible chats using explicit unread, working, or UTC-recent semantics. */
  async listChats(input: ListChatsInput): Promise<ListChatsResult> {
    const limit = boundedLimit(input.limit, 50);
    const offset = decodeCursor(input.cursor);
    return this.withPage("list_chats", async (page, pageIdentity) => {
      const snapshot = await page.snapshot();
      const cutoff = this.options.now() - this.options.recentWindowMs;
      const filtered = snapshot.chats
        .filter((chat) => input.view === "unread" ? chat.unread : input.view === "working" ? chat.working : new Date(chat.updatedAt).getTime() >= cutoff)
        .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
      const pageRows = filtered.slice(offset, offset + limit).map((chat) => this.publicChat(chat, pageIdentity));
      const nextOffset = offset + pageRows.length;
      return {
        view: input.view,
        semantics: input.view === "unread"
          ? "page snapshot unread marker, sorted by updatedAt descending"
          : input.view === "working"
            ? "page snapshot observable generation/stop state, sorted by updatedAt descending"
            : `updatedAt within the last ${this.options.recentWindowMs}ms, UTC ISO timestamps, sorted descending`,
        chats: pageRows,
        ...(nextOffset < filtered.length ? { nextCursor: encodeCursor(nextOffset) } : {}),
      };
    });
  }

  /** Search page-visible titles and message text without opening another tab. */
  async searchChat(input: SearchChatInput): Promise<SearchChatResult> {
    const query = input.query.trim();
    if (!query || query.length > 256) throw new CdpChatError("invalid_query", "query must contain 1 to 256 characters");
    const limit = boundedLimit(input.limit, 50);
    const lowered = query.toLocaleLowerCase();
    return this.withPage("search_chat", async (page, pageIdentity) => {
      const snapshot = await page.snapshot();
      const matches = snapshot.chats
        .map((chat) => ({ chat, messages: chat.messages.filter((entry) => entry.text.toLocaleLowerCase().includes(lowered)) }))
        .filter(({ chat, messages }) => chat.title.toLocaleLowerCase().includes(lowered) || messages.length > 0)
        .sort((left, right) => new Date(right.chat.updatedAt).getTime() - new Date(left.chat.updatedAt).getTime())
        .slice(0, limit)
        .map(({ chat, messages }) => ({ ...this.publicChat(chat, pageIdentity), ...(messages.length > 0 ? { matchedMessageRefs: messages.map((entry) => this.rememberMessage(chat.id, entry.id, pageIdentity)) } : {}) }));
      return { query, semantics: "case-insensitive title/message search over one fresh page snapshot", chats: matches };
    });
  }

  /** Export only a fixture-bound chat with message and byte limits. */
  async exportChat(input: ExportChatInput): Promise<ExportChatResult> {
    const maxMessages = input.maxMessages ?? 50;
    if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 100) throw new CdpChatError("invalid_limit", "maxMessages must be an integer from 1 to 100");
    return this.withPage("export_chat", async (page, pageIdentity) => {
      const rawChatId = this.resolveChat(input.chatRef, pageIdentity, true);
      const chat = await this.findChat(page, rawChatId);
      const messages = chat.messages.slice(0, maxMessages).map((entry) => this.exportedMessage(chat.id, entry, pageIdentity));
      const bounded = buildBoundedExport(chat, input.chatRef, messages, input.format, this.options.maxExportBytes);
      return { chatRef: input.chatRef, format: input.format, content: bounded.content, messages: bounded.messages, truncated: bounded.truncated };
    });
  }

  /** Send exactly one fixture message after consuming an exact one-shot gate. */
  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    if (!input.text.trim()) throw new CdpChatError("invalid_message", "text must contain at least one non-space character");
    const key = requireOpaque(input.idempotencyKey, "idempotencyKey");
    if (input.confirmation !== "SEND_MESSAGE") throw new CdpChatError("confirmation_required", "send_message requires confirmation SEND_MESSAGE");
    this.consumeGate("send_message", key, { chatRef: input.chatRef, text: input.text });
    return this.withPage("send_message", async (page, pageIdentity) => {
      const rawChatId = this.resolveChat(input.chatRef, pageIdentity, true);
      const message = await page.sendMessage({ chatId: rawChatId, text: input.text });
      const publicMessage = this.exportedMessage(rawChatId, message, pageIdentity);
      return { chatRef: input.chatRef, messageRef: publicMessage.messageRef, message: publicMessage };
    });
  }

  /** Edit exactly one fixture message with an expected version or old-text guard. */
  async editMessage(input: EditMessageInput): Promise<EditMessageResult> {
    if (!input.text.trim()) throw new CdpChatError("invalid_message", "text must contain at least one non-space character");
    if (input.expectedVersion === undefined && input.expectedText === undefined) throw new CdpChatError("expected_version_required", "edit_message requires expectedVersion or expectedText");
    if (input.expectedVersion !== undefined && (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1)) throw new CdpChatError("invalid_version", "expectedVersion must be a positive integer");
    const key = requireOpaque(input.idempotencyKey, "idempotencyKey");
    if (input.confirmation !== "EDIT_MESSAGE") throw new CdpChatError("confirmation_required", "edit_message requires confirmation EDIT_MESSAGE");
    this.consumeGate("edit_message", key, { chatRef: input.chatRef, messageRef: input.messageRef, text: input.text, expectedVersion: input.expectedVersion, expectedText: input.expectedText });
    return this.withPage("edit_message", async (page, pageIdentity) => {
      const rawChatId = this.resolveChat(input.chatRef, pageIdentity, true);
      const rawMessageId = this.resolveMessage(input.messageRef, pageIdentity, rawChatId);
      const message = await page.editMessage({ chatId: rawChatId, messageId: rawMessageId, text: input.text, expectedVersion: input.expectedVersion, expectedText: input.expectedText });
      const publicMessage = this.exportedMessage(rawChatId, message, pageIdentity);
      return { chatRef: input.chatRef, messageRef: publicMessage.messageRef, message: publicMessage };
    });
  }

  /** Download one fixture attachment under a confined root and MIME/size allowlist. */
  async downloadMedia(input: DownloadMediaInput): Promise<DownloadMediaResult> {
    return this.withPage("download_media", async (page, pageIdentity) => {
      const rawChatId = this.resolveChat(input.chatRef, pageIdentity, true);
      const rawMessageId = this.resolveMessage(input.messageRef, pageIdentity, rawChatId);
      const rawMediaId = this.resolveMedia(input.mediaRef, pageIdentity, rawChatId, rawMessageId);
      const result = await page.downloadMedia({ chatId: rawChatId, messageId: rawMessageId, mediaId: rawMediaId });
      if (!this.options.allowedMediaTypes.has(result.mimeType)) throw new CdpChatError("media_type_rejected", `media MIME type ${result.mimeType} is not allowlisted`);
      if (result.bytes.byteLength > this.options.maxMediaBytes) throw new CdpChatError("media_too_large", "media exceeds the configured byte limit");
      const directory = await confinedDirectory(this.options.mediaRoot, input.outputDir);
      const filename = safeFilename(result.filename);
      const path = join(directory, filename);
      try {
        await lstat(path);
        throw new CdpChatError("media_exists", "refusing to overwrite an existing media file");
      } catch (error) {
        if (error instanceof CdpChatError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await writeFile(path, Buffer.from(result.bytes), { flag: "wx", mode: 0o600 });
      return { chatRef: input.chatRef, messageRef: input.messageRef, mediaRef: input.mediaRef, path, bytes: result.bytes.byteLength, mimeType: result.mimeType };
    });
  }

  /** Acquire and re-check one page lease around every operation. */
  private async withPage<T>(operation: string, callback: (page: CdpChatPage, identity: PageIdentity) => Promise<T>): Promise<T> {
    const page = await this.driver.acquirePage();
    const start = validateIdentity(await page.identity());
    if (this.boundIdentity && !sameIdentity(this.boundIdentity, start)) throw new CdpChatError("page_lease_lost", `${operation} rejected because page ownership changed`);
    if (!this.boundIdentity) this.boundIdentity = start;
    const result = await callback(page, start);
    const end = validateIdentity(await page.identity());
    if (!sameIdentity(start, end)) throw new CdpChatError("page_lease_lost", `${operation} rejected because page identity changed during the action`);
    return result;
  }

  /** Consume a confirmation and idempotency key before any browser mutation. */
  private consumeGate(operation: string, key: string, payload: unknown): void {
    const fingerprint = canonicalize({ operation, payload });
    const existing = this.gates.get(key);
    const now = this.options.now();
    if (existing) {
      if (now - existing.createdAt > this.options.writeGateTtlMs) {
        this.gates.delete(key);
        throw new CdpChatError("gate_expired", "idempotency gate expired by TTL");
      }
      if (existing.fingerprint !== fingerprint) throw new CdpChatError("idempotency_conflict", "idempotency key is bound to a different operation or payload");
      if (existing.used) throw new CdpChatError("gate_used", "one-shot idempotency gate was already consumed");
    }
    this.gates.set(key, { fingerprint, createdAt: now, used: true });
  }

  /** Map one raw page object to an opaque chat reference bound to its lease. */
  private rememberChat(rawId: string, pageIdentity: PageIdentity): string {
    const key = `${identityKey(pageIdentity)}|chat|${rawId}`;
    const existing = this.chatRefs.get(key);
    if (existing) return existing;
    const ref = `cdpchat:v1:chat:${randomUUID()}`;
    this.chatRefs.set(key, ref);
    this.refs.set(ref, { kind: "chat", rawId, identity: pageIdentity, fixture: this.fixture?.rawChatId === rawId && sameIdentity(this.fixture.identity, pageIdentity) });
    return ref;
  }

  /** Map one raw page message to an opaque reference tied to its chat and lease. */
  private rememberMessage(rawChatId: string, rawMessageId: string, pageIdentity: PageIdentity): string {
    const key = `${identityKey(pageIdentity)}|message|${rawChatId}|${rawMessageId}`;
    const existing = this.messageRefs.get(key);
    if (existing) return existing;
    const ref = `cdpchat:v1:message:${randomUUID()}`;
    this.messageRefs.set(key, ref);
    this.refs.set(ref, { kind: "message", rawId: rawMessageId, chatRawId: rawChatId, identity: pageIdentity, fixture: this.fixture?.rawChatId === rawChatId && sameIdentity(this.fixture.identity, pageIdentity) });
    return ref;
  }

  /** Map one raw attachment to an opaque reference tied to message and lease. */
  private rememberMedia(rawChatId: string, rawMessageId: string, rawMediaId: string, pageIdentity: PageIdentity): string {
    const key = `${identityKey(pageIdentity)}|media|${rawChatId}|${rawMessageId}|${rawMediaId}`;
    const existing = this.mediaRefs.get(key);
    if (existing) return existing;
    const ref = `cdpchat:v1:media:${randomUUID()}`;
    this.mediaRefs.set(key, ref);
    this.refs.set(ref, { kind: "media", rawId: rawMediaId, chatRawId: rawChatId, messageRawId: rawMessageId, identity: pageIdentity, fixture: this.fixture?.rawChatId === rawChatId && sameIdentity(this.fixture.identity, pageIdentity) });
    return ref;
  }

  /** Convert a page chat to a bounded public record without exposing its raw ID. */
  private publicChat(chat: ChatRecord, pageIdentity: PageIdentity): PublicChat {
    const chatRef = this.rememberChat(chat.id, pageIdentity);
    return { chatRef, title: chat.title, unread: chat.unread, working: chat.working, updatedAt: chat.updatedAt, fixtureBound: this.refs.get(chatRef)?.fixture ?? false };
  }

  /** Convert a page message and its attachments into export-safe opaque references. */
  private exportedMessage(rawChatId: string, message: MessageRecord, pageIdentity: PageIdentity): ExportedMessage {
    const messageRef = this.rememberMessage(rawChatId, message.id, pageIdentity);
    return {
      messageRef,
      role: message.role,
      text: message.text,
      version: message.version,
      createdAt: message.createdAt,
      media: message.media.map((media) => ({ mediaRef: this.rememberMedia(rawChatId, message.id, media.id, pageIdentity), filename: media.filename, mimeType: media.mimeType, size: media.size })),
    };
  }

  /** Read the current snapshot and select one exact raw chat. */
  private async findChat(page: CdpChatPage, rawChatId: string): Promise<ChatRecord> {
    const chat = (await page.snapshot()).chats.find((entry) => entry.id === rawChatId);
    if (!chat) throw new CdpChatError("chat_not_visible", "fixture chat is not visible on the owned page");
    return chat;
  }

  /** Resolve a chat reference and require the disposable fixture binding. */
  private resolveChat(chatRef: string, pageIdentity: PageIdentity, requireFixture: boolean): string {
    const binding = this.refs.get(chatRef);
    if (!binding || binding.kind !== "chat" || !sameIdentity(binding.identity, pageIdentity)) throw new CdpChatError("invalid_chat_ref", "chatRef is unknown or belongs to another page lease");
    if (requireFixture && (!binding.fixture || !this.fixture || !sameIdentity(this.fixture.identity, pageIdentity) || this.fixture.chatRef !== chatRef)) throw new CdpChatError("fixture_required", "only the one disposable fixture chat may be targeted");
    return binding.rawId;
  }

  /** Resolve a message reference and bind it to the selected raw chat. */
  private resolveMessage(messageRef: string, pageIdentity: PageIdentity, rawChatId: string): string {
    const binding = this.refs.get(messageRef);
    if (!binding || binding.kind !== "message" || binding.chatRawId !== rawChatId || !binding.fixture || !sameIdentity(binding.identity, pageIdentity)) throw new CdpChatError("invalid_message_ref", "messageRef is unknown, unbound, or belongs to another fixture");
    return binding.rawId;
  }

  /** Resolve an attachment reference and bind it to the selected raw message. */
  private resolveMedia(mediaRef: string, pageIdentity: PageIdentity, rawChatId: string, rawMessageId: string): string {
    const binding = this.refs.get(mediaRef);
    if (!binding || binding.kind !== "media" || binding.chatRawId !== rawChatId || binding.messageRawId !== rawMessageId || !binding.fixture || !sameIdentity(binding.identity, pageIdentity)) throw new CdpChatError("invalid_media_ref", "mediaRef is unknown, unbound, or belongs to another fixture");
    return binding.rawId;
  }
}
