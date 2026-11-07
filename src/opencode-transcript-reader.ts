import { createHash, randomUUID } from "node:crypto";
import type { RawTranscriptExport } from "./types/index.js";
import type { NativeTranscriptEvent, NativeTranscriptPageReader, TranscriptSessionScope } from "./integrator-transcript.js";

/** Pages a verified complete native OpenCode message export for one session. */
export function createOpencodeTranscriptReader(input: { scope: TranscriptSessionScope; getRawTranscript: (id: string) => Promise<RawTranscriptExport | null> }): NativeTranscriptPageReader {
  const cursors = new Map<string, { offset: number; total: number; hash: string; expires: number }>();
  const fail = (reason: string): never => { throw new Error(`Native OpenCode transcript rejected: ${reason}`); };
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return async ({ scope, cursor, limit }) => {
    if (scope.hostId !== input.scope.hostId || scope.harness !== "opencode" || scope.nativeSessionId !== input.scope.nativeSessionId) return fail("scope mismatch");
    const state = cursor ? cursors.get(cursor) : undefined;
    if (cursor && (!state || state.expires <= Date.now())) return fail("unknown or expired cursor");
    const raw = await input.getRawTranscript(scope.nativeSessionId);
    if (!raw || !raw.complete || raw.source?.kind !== "native-api" || raw.source.format !== "json" || !(raw.bytes instanceof Uint8Array) || raw.bytes.byteLength > 16 * 1024 * 1024) return fail("complete native JSON required");
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw.bytes)); } catch { return fail("invalid native JSON"); }
    if (!Array.isArray(parsed)) return fail("invalid native message list");
    const total = state?.total ?? parsed.length;
    if (parsed.length < total || (state && digest(parsed.slice(0, total)) !== state.hash)) return fail("snapshot prefix changed");
    const pinned = parsed.slice(0, total);
    const hash = digest(pinned);
    const seen = new Set<string>();
    const events: NativeTranscriptEvent[] = pinned.map((value, sequence) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid native message");
      const row = value as Record<string, any>;
      const info = row.info && typeof row.info === "object" ? row.info : {};
      const id = row.id ?? info.id;
      const session = row.sessionID ?? row.sessionId ?? info.sessionID ?? info.sessionId;
      const role = row.type ?? row.role ?? info.role;
      if (typeof id !== "string" || !id || id.length > 1024 || /[\x00-\x1f\x7f]/u.test(id) || seen.has(id)
        || (session !== undefined && session !== scope.nativeSessionId) || (role !== "user" && role !== "assistant" && role !== "system" && role !== "idle")) return fail("invalid native message identity or role");
      seen.add(id);
      const parts = Array.isArray(row.parts) ? row.parts : Array.isArray(row.content) ? row.content : [];
      const text = typeof row.text === "string" ? row.text : parts.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n");
      return { sequence, eventId: id, nativeEventId: id, kind: "message", author: { kind: role === "user" ? "unknown" : role === "idle" ? "system" : role, sourceRole: role }, ...(text ? { text } : {}), payload: value };
    });
    const start = state?.offset ?? 0;
    const page = events.slice(start, start + limit);
    const next = start + page.length;
    let nextCursor: string | null = null;
    if (next < total) {
      const now = Date.now();
      for (const [key, value] of cursors) if (value.expires <= now) cursors.delete(key);
      while (cursors.size >= 2048) cursors.delete(cursors.keys().next().value!);
      nextCursor = randomUUID();
      cursors.set(nextCursor, { offset: next, total, hash, expires: now + 30 * 60 * 1000 });
    }
    return { scope, requestedCursor: cursor, nextCursor, hasMore: nextCursor !== null, totalEvents: total, startSequence: start, events: page, source: "native-complete-export" };
  };
}
