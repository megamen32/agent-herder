import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readZcodeNativeTranscript, ZCODE_SQLITE_TRANSCRIPT_SCHEMA, ZcodeNativeTranscriptError } from "../src/adapters/zcode-native-transcript.js";
import { ZcodeAdapter } from "../src/adapters/zcode.js";
import type { ZcodeClientLike } from "../src/adapters/zcode-protocol.js";
import { createZcodeTranscriptReader } from "../src/zcode-transcript-reader.js";

const dirs: string[] = [];
afterEach(() => { for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(count = 2) {
  const directory = mkdtempSync(join(tmpdir(), "zcode-complete-native-"));
  dirs.push(directory);
  const path = join(directory, "native.sqlite");
  const db = new DatabaseSync(path);
  db.exec([
    "PRAGMA journal_mode=WAL;",
    "CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, revert TEXT, time_deleted INTEGER);",
    "CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT, sequence INTEGER, time_created INTEGER, time_updated INTEGER);",
    "CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, sequence INTEGER, time_created INTEGER, time_updated INTEGER);",
    "INSERT INTO session VALUES('exact', '/work', NULL, NULL);",
  ].join("\n"));
  const message = db.prepare("INSERT INTO message VALUES(?,?,?,?,?,?)");
  const part = db.prepare("INSERT INTO part VALUES(?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < count; i++) {
    message.run("m" + i, "exact", JSON.stringify({
      role: i % 2 ? "assistant" : "user", time: { created: 100 + i },
      ...(i === 0 ? { source: "agent_listing_delta", anchor: { sourceCommandId: "original-command" } } : {}),
    }), i, 100 + i, 100 + i);
    part.run("p" + i, "m" + i, "exact", JSON.stringify({ type: "text", text: "text-" + i }), 0, 100 + i, 100 + i);
  }
  db.exec("COMMIT");
  db.close();
  return { path, mutate(sql: string) { const writer = new DatabaseSync(path); try { writer.exec(sql); } finally { writer.close(); } } };
}

describe("complete persisted ZCode transcript", () => {
  it("exports all native messages beyond the UI tail with exact provenance and anchors", async () => {
    const native = fixture(205);
    const result = await readZcodeNativeTranscript(native.path, "exact");
    const snapshot = JSON.parse(Buffer.from(result.bytes).toString("utf8"));
    expect(result).toMatchObject({ complete: true, source: { kind: "native-file", location: native.path, format: "json" } });
    expect(snapshot).toMatchObject({ schema: ZCODE_SQLITE_TRANSCRIPT_SCHEMA,
      snapshot: { consistency: "sqlite-read-transaction", currentConversation: true, messageCount: 205, partCount: 205 },
      session: { sessionId: "exact" } });
    expect(snapshot.messages).toHaveLength(205);
    expect(snapshot.messages[0].info).toMatchObject({ messageId: "m0", sessionId: "exact", source: "agent_listing_delta", anchor: { sourceCommandId: "original-command" } });
    expect(snapshot.messages[204].parts[0]).toMatchObject({ partId: "p204", messageId: "m204", sessionId: "exact", text: "text-204" });
    const scope = { hostId: "host", harness: "zcode" as const, nativeSessionId: "exact" };
    const reader = createZcodeTranscriptReader({ scope, getRawTranscript: async () => result });
    const page = await reader({ scope, cursor: null, limit: 100 });
    expect(page.totalEvents).toBe(205);
    expect(page.events[0].nativeEventId).toBe("m0");
    const next = await reader({ scope, cursor: page.nextCursor, limit: 200 });
    expect(next.events).toHaveLength(105);
    expect(next.hasMore).toBe(false);
  });

  it("reads a cold exact session without any lifecycle command or shortened native retry", async () => {
    const native = fixture(205);
    const call = vi.fn(async () => { throw new Error("Session runtime is not ready"); });
    const client = { start: vi.fn(), call } as unknown as ZcodeClientLike;
    const adapter = new ZcodeAdapter({ client, localDbPath: native.path });
    const result = await adapter.getRawTranscript("exact");
    expect(result?.source.kind).toBe("native-file");
    expect(JSON.parse(Buffer.from(result!.bytes).toString()).messages).toHaveLength(205);
    expect(call).toHaveBeenCalledExactlyOnceWith("zcode-agent", "readSession", [
      expect.objectContaining({ runtimePolicy: "existing-only", sessionId: "exact" }),
    ]);
    expect((call.mock.calls[0] as unknown as unknown[])[2]).not.toEqual([expect.objectContaining({ messageLimit: 1 })]);
  });

  it.each([
    ["UPDATE session SET revert='{}'", "native_current_conversation_unverified"],
    ["UPDATE session SET time_deleted=1", "native_current_conversation_unverified"],
    ["UPDATE message SET data='bad-json' WHERE id='m0'", "native_row_invalid"],
    ["UPDATE message SET data='{\"role\":\"user\",\"sessionId\":\"other\"}' WHERE id='m0'", "native_identity_mismatch"],
    ["UPDATE part SET message_id='absent' WHERE id='p0'", "native_identity_mismatch"],
    ["UPDATE part SET data='{\"type\":\"text\",\"messageId\":\"other\"}' WHERE id='p0'", "native_identity_mismatch"],
  ])("rejects incomplete or mismatched native source: %s", async (sql, code) => {
    const native = fixture();
    native.mutate(sql);
    await expect(readZcodeNativeTranscript(native.path, "exact")).rejects.toMatchObject({ code });
  });

  it("preserves native fields that have the same name as storage provenance", async () => {
    const native = fixture();
    native.mutate("UPDATE part SET data='{\"type\":\"text\",\"text\":\"original\",\"nativeRow\":{\"providerOwned\":true}}' WHERE id='p0'");
    const raw = await readZcodeNativeTranscript(native.path, "exact");
    const message = JSON.parse(Buffer.from(raw.bytes).toString()).messages[0];
    expect(message.parts[0]).toMatchObject({ text: "original", nativeRow: { providerOwned: true } });
    expect(message.nativePartRows).toEqual([{ partId: "p0", sequence: 0, time_created: 100, time_updated: 100 }]);
  });

  it("never confuses an absent exact session or oversize source with complete empty history", async () => {
    const native = fixture();
    await expect(readZcodeNativeTranscript(native.path, "other")).rejects.toMatchObject({ code: "session_not_found" });
    await expect(readZcodeNativeTranscript(native.path, "exact", 200)).rejects.toMatchObject({ code: "native_source_oversize" });
    expect(await readZcodeNativeTranscript(native.path, "exact")).toMatchObject({ complete: true });
  });

  it("accepts a provably empty conversation and rejects an unversioned native-file export", async () => {
    const native = fixture(0);
    const raw = await readZcodeNativeTranscript(native.path, "exact");
    const scope = { hostId: "host", harness: "zcode" as const, nativeSessionId: "exact" };
    const reader = createZcodeTranscriptReader({ scope, getRawTranscript: async () => raw });
    expect(await reader({ scope, cursor: null, limit: 20 })).toMatchObject({ totalEvents: 0, hasMore: false });
    const value = JSON.parse(Buffer.from(raw.bytes).toString());
    delete value.schema;
    const unversioned = createZcodeTranscriptReader({ scope, getRawTranscript: async () => ({ ...raw, bytes: Buffer.from(JSON.stringify(value)) }) });
    await expect(unversioned({ scope, cursor: null, limit: 20 })).rejects.toThrow("native SQLite provenance");
  });

  it("returns only safe error codes when SQLite schema cannot be read", async () => {
    const native = fixture();
    native.mutate("DROP TABLE part");
    try { await readZcodeNativeTranscript(native.path, "exact"); throw Error("must reject"); }
    catch (error) {
      expect(error).toBeInstanceOf(ZcodeNativeTranscriptError);
      expect(error).toMatchObject({ code: "native_source_unreadable" });
      expect(String(error)).not.toContain(native.path);
    }
  });
});
