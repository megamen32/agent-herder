/**
 * Product paging over a supported native transcript export. Each cursor pins
 * a complete canonical prefix; later appends remain outside that snapshot.
 */
import { createHash, randomUUID } from "node:crypto";
import type { RawTranscriptExport } from "./types/index.js";

export type TranscriptSessionScope = Readonly<{
  hostId: string;
  harness: string;
  nativeSessionId: string;
}>;

export type NativeTranscriptAuthor = Readonly<{
  /** Present only when the source supplies an actual author/tool identity. */
  id?: string;
  kind: "human" | "assistant" | "tool" | "system" | "unknown";
  /** Keep native role labels separate from verified person identity. */
  sourceRole?: string;
}>;

export type NativeTranscriptEvent = Readonly<{
  /** Zero-based position in the native session's complete event stream. */
  sequence: number;
  /** Stable event identity within the exact native snapshot. */
  eventId: string;
  /** Original native ID when the export provides one. */
  nativeEventId?: string;
  kind: "message" | "tool_call" | "tool_result";
  author: NativeTranscriptAuthor;
  turnId?: string;
  timestamp?: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  payload?: unknown;
}>;

export type NativeTranscriptPage = Readonly<{
  scope: TranscriptSessionScope;
  /** Must echo the exact opaque cursor passed to the reader. */
  requestedCursor: string | null;
  /** Opaque native continuation cursor; null exactly on the terminal page. */
  nextCursor: string | null;
  hasMore: boolean;
  /** Stable complete event count, required to detect a missing tail/page. */
  totalEvents: number;
  /** Position of events[0] in the full native event stream. */
  startSequence: number;
  events: readonly NativeTranscriptEvent[];
  source?: "injected-native-page-reader" | "native-complete-export";
}>;

export type NativeTranscriptPageReader = (input: Readonly<{
  scope: TranscriptSessionScope;
  cursor: string | null;
  limit: number;
}>) => Promise<NativeTranscriptPage>;

export type IntegratorTranscriptCursor = string;

export type IntegratorTranscriptPage = Readonly<{
  scope: TranscriptSessionScope;
  events: readonly NativeTranscriptEvent[];
  totalEvents: number;
  nextCursor: IntegratorTranscriptCursor | null;
  complete: boolean;
  source: "injected-native-page-reader" | "native-complete-export";
}>;

type CursorState = {
  version: 1;
  scope: string;
  nativeCursor: string;
  nextSequence: number;
  totalEvents: number;
};

const MAX_CURSOR_LENGTH = 4096;
const MAX_EVENT_ID_LENGTH = 1024;
const MAX_AUTHOR_ID_LENGTH = 512;
export const MAX_NATIVE_TRANSCRIPT_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const SUPPORTED_NATIVE_JSONL_HARNESSES = new Set(["codex", "claude", "qoder"]);
const SNAPSHOT_CURSOR_TTL_MS = 30 * 60 * 1000;
const MAX_ISSUED_SNAPSHOT_CURSORS = 2048;

function fail(reason: string): never {
  throw new Error(`Native transcript page rejected: ${reason}`);
}

function validId(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}

function scopeKey(scope: TranscriptSessionScope): string {
  if (!scope || !validId(scope.hostId, 512) || !validId(scope.harness, 128) || !validId(scope.nativeSessionId, 1024)) {
    return fail("invalid exact session scope");
  }
  return JSON.stringify([scope.hostId, scope.harness, scope.nativeSessionId]);
}

function copyScope(scope: TranscriptSessionScope): TranscriptSessionScope {
  return Object.freeze({ hostId: scope.hostId, harness: scope.harness, nativeSessionId: scope.nativeSessionId });
}

function encodeCursor(state: CursorState): IntegratorTranscriptCursor {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, expectedScope: string): CursorState {
  if (!validId(cursor, MAX_CURSOR_LENGTH)) return fail("malformed cursor");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return fail("malformed cursor");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("malformed cursor");
  const state = value as Partial<CursorState>;
  if (state.version !== 1 || state.scope !== expectedScope || !validId(state.nativeCursor, MAX_CURSOR_LENGTH)
    || !Number.isSafeInteger(state.nextSequence) || (state.nextSequence ?? -1) < 1
    || !Number.isSafeInteger(state.totalEvents) || (state.totalEvents ?? -1) < state.nextSequence!) {
    return fail("corrupt or cross-session cursor");
  }
  return state as CursorState;
}

function normalizeEvent(event: NativeTranscriptEvent, expectedSequence: number): NativeTranscriptEvent {
  if (!event || typeof event !== "object" || event.sequence !== expectedSequence
    || !validId(event.eventId, MAX_EVENT_ID_LENGTH)
    || !["message", "tool_call", "tool_result"].includes(event.kind)
    || !event.author || (event.author.id !== undefined && !validId(event.author.id, MAX_AUTHOR_ID_LENGTH))
    || !["human", "assistant", "tool", "system", "unknown"].includes(event.author.kind)
    || (event.nativeEventId !== undefined && !validId(event.nativeEventId, MAX_EVENT_ID_LENGTH))) {
    return fail("event identity, sequence, or native author metadata is invalid");
  }
  if (event.kind === "tool_call" && (!validId(event.toolName, 512) || !validId(event.toolCallId, MAX_EVENT_ID_LENGTH))) {
    return fail("tool event is missing native tool identity");
  }
  if (event.kind === "tool_result" && !validId(event.toolCallId, MAX_EVENT_ID_LENGTH)) return fail("tool result is missing native call identity");
  if (event.toolName !== undefined && !validId(event.toolName, 512)) return fail("invalid native tool name");
  if (event.turnId !== undefined && !validId(event.turnId, 1024)) return fail("invalid native turn identity");
  if (event.timestamp !== undefined && (typeof event.timestamp !== "string" || !Number.isFinite(Date.parse(event.timestamp)))) {
    return fail("invalid native timestamp");
  }
  if (event.text !== undefined && typeof event.text !== "string") return fail("invalid native message text");
  // Copy only typed native fields; never derive an author, event ID or tool
  // identity from user-visible text or arbitrary payload content.
  return Object.freeze({
    sequence: event.sequence,
    eventId: event.eventId,
    ...(event.nativeEventId ? { nativeEventId: event.nativeEventId } : {}),
    kind: event.kind,
    author: Object.freeze({
      ...(event.author.id ? { id: event.author.id } : {}),
      kind: event.author.kind,
      ...(event.author.sourceRole ? { sourceRole: event.author.sourceRole } : {}),
    }),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.timestamp ? { timestamp: event.timestamp } : {}),
    ...(event.text !== undefined ? { text: event.text } : {}),
    ...(event.toolName ? { toolName: event.toolName } : {}),
    ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
    ...(event.payload !== undefined ? { payload: structuredClone(event.payload) } : {}),
  });
}

/** Read and validate one page from the explicitly injected native owner seam. */
export async function readIntegratorTranscriptPage(input: {
  scope: TranscriptSessionScope;
  cursor?: IntegratorTranscriptCursor;
  limit?: number;
  reader: NativeTranscriptPageReader;
}): Promise<IntegratorTranscriptPage> {
  const key = scopeKey(input.scope);
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return fail("page limit must be 1..100");
  const state = input.cursor === undefined ? null : decodeCursor(input.cursor, key);
  const nativeCursor = state?.nativeCursor ?? null;
  const raw = await input.reader({ scope: copyScope(input.scope), cursor: nativeCursor, limit });
  if (!raw || typeof raw !== "object" || scopeKey(raw.scope) !== key) return fail("native reader returned another session");
  if (raw.requestedCursor !== nativeCursor) return fail("native reader cursor did not match request");
  if (!Number.isSafeInteger(raw.totalEvents) || raw.totalEvents < 0 || !Array.isArray(raw.events)
    || raw.events.length > limit || typeof raw.hasMore !== "boolean"
    || (raw.nextCursor !== null && !validId(raw.nextCursor, MAX_CURSOR_LENGTH))) return fail("malformed native page envelope");
  if (state && raw.totalEvents !== state.totalEvents) return fail("native transcript changed while paging");
  const expectedSequence = state?.nextSequence ?? 0;
  if (!Number.isSafeInteger(raw.startSequence) || raw.startSequence !== expectedSequence || expectedSequence < 0) {
    return fail("native page sequence has a gap or overlap");
  }
  const ids = new Set<string>();
  const events = raw.events.map((event, index) => {
    const normalized = normalizeEvent(event, expectedSequence + index);
    if (ids.has(normalized.eventId)) return fail("duplicate native event ID within page");
    ids.add(normalized.eventId);
    return normalized;
  });
  const endSequence = expectedSequence + events.length;
  if (endSequence > raw.totalEvents || raw.hasMore !== (raw.nextCursor !== null)
    || (raw.hasMore && (events.length === 0 || endSequence >= raw.totalEvents))
    || (!raw.hasMore && endSequence !== raw.totalEvents)) return fail("page count/cursor does not prove a complete contiguous range");
  if (state && raw.nextCursor === state.nativeCursor) return fail("native reader repeated its cursor");
  const nextCursor = raw.hasMore ? encodeCursor({
    version: 1,
    scope: key,
    nativeCursor: raw.nextCursor!,
    nextSequence: endSequence,
    totalEvents: raw.totalEvents,
  }) : null;
  return Object.freeze({
    scope: copyScope(input.scope),
    events: Object.freeze(events),
    totalEvents: raw.totalEvents,
    nextCursor,
    complete: !raw.hasMore,
    source: raw.source ?? "injected-native-page-reader" as const,
  });
}

/** Iterate one stable native transcript while checking cross-page identities. */
export async function* iterateIntegratorTranscriptPages(input: {
  scope: TranscriptSessionScope;
  limit?: number;
  reader: NativeTranscriptPageReader;
}): AsyncGenerator<IntegratorTranscriptPage> {
  let cursor: IntegratorTranscriptCursor | undefined;
  const seenCursors = new Set<string>();
  const seenEventIds = new Set<string>();
  for (;;) {
    const page = await readIntegratorTranscriptPage({ ...input, cursor });
    for (const event of page.events) {
      if (seenEventIds.has(event.eventId)) return fail("duplicate native event ID across pages");
      seenEventIds.add(event.eventId);
    }
    if (page.nextCursor && seenCursors.has(page.nextCursor)) return fail("native page cursor loop");
    if (page.nextCursor) seenCursors.add(page.nextCursor);
    yield page;
    if (page.complete) return;
    cursor = page.nextCursor!;
  }
}

type SnapshotCursor = {
  version: 2;
  scope: string;
  snapshotHash: string;
  sourceHash: string;
  snapshotBytes: number;
  nextSequence: number;
  totalEvents: number;
};

function sourceEventId(line: string, recordIndex: number, nativeId: unknown, subIndex = 0): { eventId: string; nativeEventId?: string } {
  const native = validId(nativeId, MAX_EVENT_ID_LENGTH) ? nativeId : undefined;
  const eventId = native
    ? `${native}${subIndex ? `:${subIndex}` : ""}`
    : `record:${recordIndex}:${subIndex}:${createHash("sha256").update(line).digest("hex").slice(0, 24)}`;
  return { eventId, ...(native ? { nativeEventId: native } : {}) };
}

function textContent(value: unknown, accepted: readonly string[]): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const part = item as Record<string, unknown>;
    return accepted.includes(String(part.type)) && typeof part.text === "string" ? [part.text] : [];
  });
  return parts.length ? parts.join("\n") : undefined;
}

function timestampString(value: unknown): string | undefined {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return undefined;
}

function normalizeCodexRecord(row: Record<string, unknown>, line: string, recordIndex: number, sequence: number): NativeTranscriptEvent[] {
  if (row.type !== "response_item") return [];
  const payload = row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : undefined;
  if (!payload) return [];
  const type = payload.type;
  const at = timestampString(row.timestamp);
  if (type === "message") {
    const role = payload.role;
    if (role !== "user" && role !== "assistant" && role !== "system") return [];
    const id = sourceEventId(line, recordIndex, payload.id ?? row.id);
    return [{
      sequence, ...id, kind: "message",
      author: role === "user" ? { kind: "unknown", sourceRole: "user" } : { kind: role, sourceRole: role },
      ...(typeof payload.turn_id === "string" ? { turnId: payload.turn_id } : {}),
      ...(at ? { timestamp: at } : {}),
      ...(textContent(payload.content, ["input_text", "output_text"]) !== undefined ? { text: textContent(payload.content, ["input_text", "output_text"]) } : {}),
      payload: { content: payload.content },
    }];
  }
  if (type === "function_call" || type === "mcp_tool_call" || type === "custom_tool_call") {
    const toolCallId = payload.call_id ?? payload.tool_call_id;
    const toolName = payload.name ?? payload.tool_name;
    if (!validId(toolCallId, MAX_EVENT_ID_LENGTH) || !validId(toolName, 512)) return fail("unsupported native Codex tool-call identity");
    if (payload.status !== undefined && (typeof payload.status !== "string" || !validId(payload.status, 128))) {
      return fail("unsupported native Codex tool-call status");
    }
    const id = sourceEventId(line, recordIndex, payload.event_id ?? payload.id ?? toolCallId);
    const passthrough = payload.internal_chat_message_metadata_passthrough && typeof payload.internal_chat_message_metadata_passthrough === "object"
      ? payload.internal_chat_message_metadata_passthrough as Record<string, unknown> : undefined;
    const turnId = payload.turn_id ?? passthrough?.turn_id;
    const input = payload.arguments ?? payload.input;
    const toolPayload = type === "custom_tool_call"
      ? { ...(typeof payload.status === "string" ? { status: payload.status } : {}), ...(input !== undefined ? { input } : {}) }
      : input ?? payload;
    return [{
      sequence, ...id, kind: "tool_call", author: { kind: "assistant", sourceRole: "assistant" },
      ...(typeof turnId === "string" ? { turnId } : {}), ...(at ? { timestamp: at } : {}), toolName, toolCallId,
      payload: toolPayload,
    }];
  }
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    const toolCallId = payload.call_id ?? payload.tool_call_id;
    if (!validId(toolCallId, MAX_EVENT_ID_LENGTH)) return fail("unsupported native Codex tool-result identity");
    const id = sourceEventId(line, recordIndex, payload.event_id ?? payload.id ?? `${toolCallId}:result`);
    const passthrough = payload.internal_chat_message_metadata_passthrough && typeof payload.internal_chat_message_metadata_passthrough === "object"
      ? payload.internal_chat_message_metadata_passthrough as Record<string, unknown> : undefined;
    const turnId = payload.turn_id ?? passthrough?.turn_id;
    return [{
      sequence, ...id, kind: "tool_result", author: { kind: "unknown", sourceRole: "tool" },
      ...(typeof turnId === "string" ? { turnId } : {}), ...(at ? { timestamp: at } : {}), toolCallId,
      ...(typeof payload.name === "string" ? { toolName: payload.name } : {}),
      payload: payload.output,
    }];
  }
  return [];
}

function normalizeClaudeRecord(row: Record<string, unknown>, line: string, recordIndex: number, sequence: number): NativeTranscriptEvent[] {
  const role = row.type === "human" || row.type === "user" ? "user" : row.type === "assistant" ? "assistant" : "";
  const message = row.message && typeof row.message === "object" ? row.message as Record<string, unknown> : undefined;
  const nativeRole = role || (message?.role === "user" || message?.role === "assistant" ? message.role : "");
  if (!nativeRole || !message || !Array.isArray(message.content)) return [];
  const events: NativeTranscriptEvent[] = [];
  const at = timestampString(row.timestamp);
  const baseId = row.uuid ?? row.id ?? message.id;
  let subIndex = 0;
  const text = textContent(message.content, ["text", "input_text", "output_text"]);
  if (text !== undefined) {
    const id = sourceEventId(line, recordIndex, baseId, subIndex++);
    events.push({
      sequence: sequence + events.length, ...id, kind: "message",
      author: nativeRole === "user" ? { kind: "unknown", sourceRole: "user" } : { kind: "assistant", sourceRole: "assistant" },
      ...(at ? { timestamp: at } : {}), text, payload: { content: message.content },
    });
  }
  for (const block of message.content) {
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    if (item.type === "tool_use") {
      if (!validId(item.id, MAX_EVENT_ID_LENGTH) || !validId(item.name, 512)) return fail("unsupported Claude native tool-call identity");
      const id = sourceEventId(line, recordIndex, item.id, subIndex++);
      events.push({ sequence: sequence + events.length, ...id, kind: "tool_call", author: { kind: "assistant", sourceRole: "assistant" }, ...(at ? { timestamp: at } : {}), toolName: item.name, toolCallId: item.id, payload: item.input });
    } else if (item.type === "tool_result") {
      if (!validId(item.tool_use_id, MAX_EVENT_ID_LENGTH)) return fail("unsupported Claude native tool-result identity");
      const id = sourceEventId(line, recordIndex, `${item.tool_use_id}:result`, subIndex++);
      events.push({ sequence: sequence + events.length, ...id, kind: "tool_result", author: { kind: "unknown", sourceRole: "tool" }, ...(at ? { timestamp: at } : {}), toolCallId: item.tool_use_id, payload: item.content });
    }
  }
  return events;
}

type ParsedTranscriptPrefix = { events: NativeTranscriptEvent[]; byteLength: number };

/** Return true only when EOF interrupts an otherwise valid UTF-8 sequence. */
function hasIncompleteUtf8Suffix(bytes: Uint8Array): boolean {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try { decoder.decode(bytes, { stream: true }); }
  catch { return false; }
  try { decoder.decode(); return false; }
  catch { return true; }
}

function parseJsonlRecords(records: Array<{ line: string; recordIndex: number }>, expectedSessionId: string): NativeTranscriptEvent[] {
  const events: NativeTranscriptEvent[] = [];
  const calls = new Map<string, string>();
  for (const { line, recordIndex } of records) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail(`native JSONL record ${recordIndex} is not an object`);
      row = parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof SyntaxError) return fail(`native JSONL record ${recordIndex} is corrupt`);
      throw error;
    }
    const payload = row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : undefined;
    const sessionIdentity = row.sessionId ?? row.session_id ?? payload?.session_id
      ?? (row.type === "session_meta" ? payload?.id : undefined);
    if (typeof sessionIdentity === "string" && sessionIdentity !== expectedSessionId) return fail("native export session metadata does not match the requested session");
    const parsed = row.type === "response_item"
      ? normalizeCodexRecord(row, line, recordIndex, events.length)
      : normalizeClaudeRecord(row, line, recordIndex, events.length);
    for (const event of parsed) {
      if (event.kind === "tool_call" && event.toolCallId && event.toolName) calls.set(event.toolCallId, event.toolName);
      if (event.kind === "tool_result" && event.toolCallId && !event.toolName && calls.has(event.toolCallId)) {
        (event as { toolName?: string }).toolName = calls.get(event.toolCallId);
      }
      events.push(event);
    }
  }
  return events.map((event, sequence) => Object.freeze({ ...event, sequence }));
}

/** Parse only whole newline-terminated records plus a valid final EOF record. */
function parseCompleteJsonlPrefix(bytes: Uint8Array, allowIncompleteTail: boolean, expectedSessionId: string): ParsedTranscriptPrefix {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records: Array<{ line: string; recordIndex: number }> = [];
  const decodeLine = (slice: Buffer, index: number): string => {
    const content = slice.length && slice[slice.length - 1] === 13 ? slice.subarray(0, -1) : slice;
    try { return new TextDecoder("utf-8", { fatal: true }).decode(content); }
    catch { return fail(`native JSONL record ${index} has invalid UTF-8`); }
  };
  let start = 0;
  let recordIndex = 0;
  let byteLength = 0;
  for (;;) {
    const newline = buffer.indexOf(10, start);
    if (newline < 0) break;
    records.push({ line: decodeLine(buffer.subarray(start, newline), recordIndex), recordIndex });
    recordIndex++;
    start = newline + 1;
    byteLength = start;
  }
  if (start < buffer.length) {
    const tail = buffer.subarray(start);
    let line: string | undefined;
    try {
      const content = tail.length && tail[tail.length - 1] === 13 ? tail.subarray(0, -1) : tail;
      line = new TextDecoder("utf-8", { fatal: true }).decode(content);
      // JSON parse here distinguishes a complete EOF record from a partial
      // concurrent write. The normalizer will parse it again with context.
      JSON.parse(line);
    } catch (error) {
      if (!allowIncompleteTail) return fail("cursor prefix ends inside a malformed or incomplete JSONL record");
      if (error instanceof TypeError) {
        if (!hasIncompleteUtf8Suffix(tail)) return fail("native JSONL tail has invalid UTF-8");
        return { events: parseJsonlRecords(records, expectedSessionId), byteLength };
      }
      if (error instanceof SyntaxError) {
        return { events: parseJsonlRecords(records, expectedSessionId), byteLength };
      }
      throw error;
    }
    records.push({ line: line!, recordIndex });
    byteLength = buffer.length;
  }
  return { events: parseJsonlRecords(records, expectedSessionId), byteLength };
}

/** Build real product paging over a complete supported native JSONL export. */
export function createRawTranscriptPageReader(input: {
  scope: TranscriptSessionScope;
  getRawTranscript: (nativeSessionId: string) => Promise<RawTranscriptExport | null>;
  maxSnapshotBytes?: number;
}): NativeTranscriptPageReader {
  const expectedScope = scopeKey(input.scope);
  const maxBytes = input.maxSnapshotBytes ?? MAX_NATIVE_TRANSCRIPT_SNAPSHOT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_NATIVE_TRANSCRIPT_SNAPSHOT_BYTES) throw new Error("Native transcript snapshot limit must be 1..16MiB");
  const issuedCursors = new Map<string, { state: SnapshotCursor; expiresAt: number; stateKey: string }>();
  const cursorByState = new Map<string, string>();
  const removeIssuedCursor = (token: string, entry: { state: SnapshotCursor; expiresAt: number; stateKey: string }): void => {
    issuedCursors.delete(token);
    if (cursorByState.get(entry.stateKey) === token) cursorByState.delete(entry.stateKey);
  };
  const pruneExpired = (now: number): void => {
    for (const [token, entry] of issuedCursors) {
      if (entry.expiresAt <= now) removeIssuedCursor(token, entry);
    }
  };
  const issueCursor = (state: SnapshotCursor): string => {
    const now = Date.now();
    pruneExpired(now);
    const stateKey = JSON.stringify(state);
    const existingToken = cursorByState.get(stateKey);
    const existing = existingToken ? issuedCursors.get(existingToken) : undefined;
    if (existing && existing.expiresAt > now) return existingToken!;
    if (existingToken && existing) removeIssuedCursor(existingToken, existing);
    while (issuedCursors.size >= MAX_ISSUED_SNAPSHOT_CURSORS) {
      const oldest = issuedCursors.entries().next().value as [string, { state: SnapshotCursor; expiresAt: number; stateKey: string }] | undefined;
      if (!oldest) break;
      removeIssuedCursor(oldest[0], oldest[1]);
    }
    const token = randomUUID();
    issuedCursors.set(token, { state: Object.freeze({ ...state }), expiresAt: now + SNAPSHOT_CURSOR_TTL_MS, stateKey });
    cursorByState.set(stateKey, token);
    return token;
  };
  const resolveCursor = (token: string): SnapshotCursor => {
    const now = Date.now();
    pruneExpired(now);
    const entry = issuedCursors.get(token);
    if (!entry) return fail("snapshot cursor was not issued by this reader or has expired; restart from page one");
    // Sliding expiry on read keeps active pagination live while preserving
    // replay: the same issued token always denotes the same immutable prefix.
    issuedCursors.delete(token);
    entry.expiresAt = now + SNAPSHOT_CURSOR_TTL_MS;
    issuedCursors.set(token, entry);
    return entry.state;
  };
  return async ({ scope, cursor, limit }) => {
    if (scopeKey(scope) !== expectedScope) return fail("reader was asked for another host/harness/session");
    if (!SUPPORTED_NATIVE_JSONL_HARNESSES.has(scope.harness)) return fail("unsupported native JSONL harness");
    const state = cursor === null ? null : resolveCursor(cursor);
    const raw = await input.getRawTranscript(scope.nativeSessionId);
    if (!raw || raw.complete !== true || !raw.source || !["native-file", "native-api"].includes(raw.source.kind)
      || raw.source.format !== "jsonl" || !(raw.bytes instanceof Uint8Array)) return fail("native adapter has no supported complete JSONL export");
    if (raw.bytes.byteLength > maxBytes) return fail(`native transcript exceeds ${maxBytes} byte snapshot limit`);
    const sourceHash = createHash("sha256").update(JSON.stringify(raw.source)).digest("hex");
    if (state && (raw.bytes.byteLength < state.snapshotBytes || sourceHash !== state.sourceHash)) {
      return fail("native transcript was truncated or its source metadata changed");
    }
    const candidateBytes = raw.bytes.subarray(0, state?.snapshotBytes ?? raw.bytes.byteLength);
    const snapshot = parseCompleteJsonlPrefix(candidateBytes, !state, scope.nativeSessionId);
    if (state && snapshot.byteLength !== state.snapshotBytes) return fail("cursor does not end on a complete native event boundary");
    const snapshotBytes = state?.snapshotBytes ?? snapshot.byteLength;
    const snapshotHash = createHash("sha256").update(raw.bytes.subarray(0, snapshotBytes)).digest("hex");
    if (state && snapshotHash !== state.snapshotHash) return fail("native transcript snapshot prefix was rewritten");
    const events = snapshot.events;
    if (state && state.totalEvents !== events.length) return fail("native transcript snapshot event count changed");
    const startSequence = state?.nextSequence ?? 0;
    const pageEvents = events.slice(startSequence, startSequence + limit);
    const nextSequence = startSequence + pageEvents.length;
    const hasMore = nextSequence < events.length;
    const nextCursor = hasMore ? issueCursor({
      version: 2, scope: expectedScope, snapshotHash, sourceHash,
      snapshotBytes,
      nextSequence, totalEvents: events.length,
    }) : null;
    return {
      scope: copyScope(input.scope), requestedCursor: cursor, nextCursor, hasMore,
      totalEvents: events.length, startSequence, events: pageEvents, source: "native-complete-export",
    };
  };
}
