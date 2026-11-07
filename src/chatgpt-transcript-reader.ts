import { randomUUID } from "node:crypto";
import type { RawTranscriptExport } from "./types/index.js";
import type { NativeTranscriptEvent, NativeTranscriptPageReader, TranscriptSessionScope } from "./integrator-transcript.js";

/** A cursor reads a frozen complete native export, without further browser requests. */
export function createChatgptTranscriptReader(input: {
  scope: TranscriptSessionScope;
  getRawTranscript: (id: string) => Promise<RawTranscriptExport | null>;
}): NativeTranscriptPageReader {
  type Snapshot = { events: NativeTranscriptEvent[]; expires: number };
  const cursors = new Map<string, { snapshot: Snapshot; offset: number }>();
  const fail = (reason: string): never => { throw new Error(`Native ChatGPT transcript rejected: ${reason}`); };
  return async ({ scope, cursor, limit }) => {
    if (scope.hostId !== input.scope.hostId || scope.harness !== "chatgpt" || scope.nativeSessionId !== input.scope.nativeSessionId) return fail("scope mismatch");
    const now = Date.now();
    for (const [key, state] of cursors) if (state.snapshot.expires <= now) cursors.delete(key);
    let state = cursor ? cursors.get(cursor) : undefined;
    if (cursor && !state) return fail("unknown or expired cursor; restart from page one");
    if (!state) {
      const raw = await input.getRawTranscript(scope.nativeSessionId);
      if (!raw || raw.complete !== true || raw.source?.kind !== "native-api" || raw.source.format !== "json"
        || !(raw.bytes instanceof Uint8Array) || raw.bytes.byteLength > 16 * 1024 * 1024) return fail("complete native JSON required");
      let data: any;
      try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw.bytes)); }
      catch { return fail("invalid native JSON"); }
      let nativeId = scope.nativeSessionId;
      if (nativeId.startsWith("chatgpt::")) {
        try { nativeId = decodeURIComponent(nativeId.slice(9)); } catch { return fail("invalid session ID"); }
      }
      const resolved = data?.conversation_id;
      const admittedDraft = nativeId.startsWith("draft:") && typeof resolved === "string" && /^[a-f0-9-]{28,80}$/i.test(resolved)
        && raw.source.location === `https://chatgpt.com/c/${resolved}`;
      if (!data || (resolved !== nativeId && !admittedDraft) || !data.mapping || typeof data.mapping !== "object" || Array.isArray(data.mapping)) return fail("native session or mapping mismatch");
      const seen = new Set<string>();
      const events: NativeTranscriptEvent[] = [];
      for (const node of Object.values(data.mapping) as any[]) {
        if (!node || typeof node !== "object" || Array.isArray(node)) return fail("invalid native mapping node");
        if (node.message == null) continue;
        const message = node.message;
        const id = message?.id, role = message?.author?.role;
        if (typeof id !== "string" || !id || id.length > 1024 || /[\x00-\x1f\x7f]/u.test(id) || seen.has(id) || typeof role !== "string") return fail("invalid native message identity or role");
        seen.add(id);
        const parts = message.content?.parts;
        const text = Array.isArray(parts) ? parts.map((part: unknown) => typeof part === "string" ? part : "").filter(Boolean).join("\n") : typeof message.content?.text === "string" ? message.content.text : "";
        const kind = role === "assistant" ? "assistant" : role === "system" ? "system" : role === "tool" ? "tool" : "unknown";
        const time = message.create_time;
        const timestamp = typeof time === "number" && Number.isFinite(time) && Number.isFinite(new Date(time * 1000).getTime()) ? new Date(time * 1000).toISOString() : undefined;
        events.push({ sequence: events.length, eventId: id, nativeEventId: id, kind: "message", author: { kind, sourceRole: role }, ...(text ? { text } : {}), ...(timestamp ? { timestamp } : {}), payload: node });
      }
      // Bound snapshots while allowing independent consumers to page concurrently.
      const snapshots = [...new Set([...cursors.values()].map(entry => entry.snapshot))];
      while (snapshots.length >= 4) {
        const oldest = snapshots.shift();
        for (const [key, entry] of cursors) if (entry.snapshot === oldest) cursors.delete(key);
      }
      state = { snapshot: { events, expires: now + 30 * 60 * 1000 }, offset: 0 };
    }
    const events = state.snapshot.events;
    const page = events.slice(state.offset, state.offset + limit);
    const next = state.offset + page.length;
    let nextCursor: string | null = null;
    if (next < events.length) {
      while (cursors.size >= 2048) cursors.delete(cursors.keys().next().value!);
      nextCursor = randomUUID();
      cursors.set(nextCursor, { snapshot: state.snapshot, offset: next });
    }
    return { scope, requestedCursor: cursor, nextCursor, hasMore: nextCursor !== null, totalEvents: events.length, startSequence: state.offset, events: page, source: "native-complete-export" };
  };
}
