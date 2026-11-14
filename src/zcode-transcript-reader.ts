import { createHash, randomUUID } from "node:crypto";
import { ZCODE_SQLITE_TRANSCRIPT_SCHEMA } from "./adapters/zcode-native-transcript.js";
import type { RawTranscriptExport } from "./types/index.js";
import type { NativeTranscriptEvent, NativeTranscriptPageReader, TranscriptSessionScope } from "./integrator-transcript.js";

type Cursor = { offset: number; total: number; hash: string; expiresAt: number };

/** Pages a complete native API or transactional persisted snapshot for one exact session. */
export function createZcodeTranscriptReader(input: {
  scope: TranscriptSessionScope;
  getRawTranscript: (id: string) => Promise<RawTranscriptExport | null>;
}): NativeTranscriptPageReader {
  const cursors = new Map<string, Cursor>();
  const fail = (reason: string): never => { throw new Error(`Native ZCode transcript rejected: ${reason}`); };
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return async ({ scope, cursor, limit }) => {
    if (scope.hostId !== input.scope.hostId || scope.harness !== "zcode" || scope.nativeSessionId !== input.scope.nativeSessionId) return fail("scope mismatch");
    const state = cursor ? cursors.get(cursor) : undefined;
    if (cursor && (!state || state.expiresAt <= Date.now())) return fail("unknown or expired cursor");
    const raw = await input.getRawTranscript(scope.nativeSessionId);
    if (!raw || raw.complete !== true || !(raw.source?.kind === "native-api" || raw.source?.kind === "native-file") || raw.source.format !== "json"
      || !(raw.bytes instanceof Uint8Array) || raw.bytes.byteLength > 16 * 1024 * 1024) return fail("complete native JSON required");
    let snapshot: any;
    try { snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw.bytes)); }
    catch { return fail("invalid native JSON"); }
    if (!snapshot || snapshot.session?.sessionId !== scope.nativeSessionId || !Array.isArray(snapshot.messages)) return fail("native session or messages mismatch");
    if (raw.source.kind === "native-file") {
      if (snapshot.schema !== ZCODE_SQLITE_TRANSCRIPT_SCHEMA
        || snapshot.snapshot?.consistency !== "sqlite-read-transaction" || snapshot.snapshot.currentConversation !== true
        || snapshot.session.id !== scope.nativeSessionId || snapshot.session.revert !== null || snapshot.session.time_deleted !== null
        || snapshot.snapshot.messageCount !== snapshot.messages.length
        || !snapshot.messages.every((message: any) => message && Array.isArray(message.parts))
        || snapshot.snapshot.partCount !== snapshot.messages.reduce((total: number, message: any) => total + message.parts.length, 0)) {
        return fail("native SQLite provenance or completeness mismatch");
      }
    }
    const messages: unknown[] = snapshot.messages;
    const total = state?.total ?? messages.length;
    if (messages.length < total || (state && digest(messages.slice(0, total)) !== state.hash)) return fail("snapshot prefix changed");
    const pinned = messages.slice(0, total);
    const hash = digest(pinned);
    const seen = new Set<string>();
    const events: NativeTranscriptEvent[] = pinned.map((value, sequence) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid message");
      const row = value as { info?: Record<string, unknown>; parts?: unknown[] };
      const info = row.info;
      const id = info?.messageId;
      const role = info?.role;
      if (typeof id !== "string" || !id || id.length > 1024 || /[\x00-\x1f\x7f]/u.test(id) || seen.has(id)
        || info?.sessionId !== scope.nativeSessionId || (role !== "user" && role !== "assistant") || !Array.isArray(row.parts)) return fail("invalid native message identity or parts");
      seen.add(id);
      const text = row.parts.filter((part): part is { type: string; text: string } => Boolean(part) && typeof part === "object"
        && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string").map(part => part.text).join("\n");
      return { sequence, eventId: id, nativeEventId: id, kind: "message", author: { kind: role === "user" ? "unknown" : "assistant", sourceRole: role }, ...(text ? { text } : {}), payload: value };
    });
    const start = state?.offset ?? 0;
    const page = events.slice(start, start + limit);
    const next = start + page.length;
    let nextCursor: string | null = null;
    if (next < total) {
      const now = Date.now();
      for (const [key, value] of cursors) if (value.expiresAt <= now) cursors.delete(key);
      while (cursors.size >= 2048) cursors.delete(cursors.keys().next().value!);
      nextCursor = randomUUID();
      cursors.set(nextCursor, { offset: next, total, hash, expiresAt: now + 30 * 60 * 1000 });
    }
    return { scope, requestedCursor: cursor, nextCursor, hasMore: nextCursor !== null, totalEvents: total, startSequence: start, events: page, source: "native-complete-export" };
  };
}
