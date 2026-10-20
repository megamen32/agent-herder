import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";
import {
  createRawTranscriptPageReader,
  iterateIntegratorTranscriptPages,
  MAX_NATIVE_TRANSCRIPT_SNAPSHOT_BYTES,
  readIntegratorTranscriptPage,
  type NativeTranscriptEvent,
  type NativeTranscriptPageReader,
  type TranscriptSessionScope,
} from "../src/integrator-transcript.js";
import type { RawTranscriptExport } from "../src/types/index.js";

const scope: TranscriptSessionScope = { hostId: "server-100", harness: "codex", nativeSessionId: "thread-7" };
const human: NativeTranscriptEvent = {
  sequence: 0, eventId: "evt-0", nativeEventId: "evt-0", kind: "message",
  author: { kind: "unknown", sourceRole: "user" }, text: "please run the tool", turnId: "turn-1",
};
const toolCall: NativeTranscriptEvent = {
  sequence: 1, eventId: "evt-1", nativeEventId: "evt-1", kind: "tool_call",
  author: { kind: "assistant", sourceRole: "assistant" }, toolName: "shell_exec", toolCallId: "call-1", payload: { command: "pwd" },
};
const toolResult: NativeTranscriptEvent = {
  sequence: 2, eventId: "evt-2", nativeEventId: "evt-2", kind: "tool_result",
  author: { kind: "unknown", sourceRole: "tool" }, toolName: "shell_exec", toolCallId: "call-1", payload: { exitCode: 0 },
};

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function page(cursor: string | null, events: NativeTranscriptEvent[], startSequence: number, nextCursor: string | null) {
  return { scope, requestedCursor: cursor, nextCursor, hasMore: nextCursor !== null, totalEvents: 3, startSequence, events } as const;
}

describe("readIntegratorTranscriptPage", () => {
  it("continues with the exact injected cursor and proves contiguous event positions", async () => {
    const reader = vi.fn<NativeTranscriptPageReader>()
      .mockResolvedValueOnce(page(null, [human, toolCall], 0, "native-cursor-2"))
      .mockResolvedValueOnce(page("native-cursor-2", [toolResult], 2, null));
    const first = await readIntegratorTranscriptPage({ scope, limit: 2, reader });
    expect(first).toMatchObject({ complete: false, totalEvents: 3, events: [{ sequence: 0 }, { sequence: 1 }] });
    expect(first.nextCursor).toBeTruthy();
    const last = await readIntegratorTranscriptPage({ scope, cursor: first.nextCursor!, limit: 2, reader });
    expect(reader.mock.calls.map(([request]) => request.cursor)).toEqual([null, "native-cursor-2"]);
    expect(last).toMatchObject({ complete: true, events: [{ sequence: 2, eventId: "evt-2" }] });
    expect([...first.events, ...last.events].map((event) => event.sequence)).toEqual([0, 1, 2]);
  });

  it("rejects an omitted prefix and duplicate event IDs across pages", async () => {
    await expect(readIntegratorTranscriptPage({ scope, reader: async () => page(null, [{ ...human, sequence: 1 }], 1, null) }))
      .rejects.toThrow(/gap or overlap/);
    const repeatedIdReader = vi.fn<NativeTranscriptPageReader>()
      .mockResolvedValueOnce(page(null, [human], 0, "cursor-1"))
      .mockResolvedValueOnce(page("cursor-1", [{ ...toolCall, sequence: 1, eventId: human.eventId }, toolResult], 1, null));
    const pages = iterateIntegratorTranscriptPages({ scope, reader: repeatedIdReader });
    await pages.next();
    await expect(pages.next()).rejects.toThrow(/duplicate native event ID across pages/);
  });

  it("preserves native authorship certainty and tool identity without deriving either from text", async () => {
    const result = await readIntegratorTranscriptPage({ scope, reader: async () => ({
      ...page(null, [{ ...toolCall, sequence: 0 }, { ...toolResult, sequence: 1 }], 0, null), totalEvents: 2,
    }) });
    expect(result.events).toMatchObject([
      { kind: "tool_call", author: { kind: "assistant" }, toolName: "shell_exec", toolCallId: "call-1" },
      { kind: "tool_result", author: { kind: "unknown", sourceRole: "tool" }, toolName: "shell_exec", toolCallId: "call-1" },
    ]);
    expect(Object.isFrozen(result.events[0]!.author)).toBe(true);
  });

  it("rejects a cursor used with another host, harness, or native session", async () => {
    const reader = vi.fn<NativeTranscriptPageReader>().mockResolvedValue(page(null, [human], 0, "next"));
    const first = await readIntegratorTranscriptPage({ scope, reader });
    await expect(readIntegratorTranscriptPage({ scope: { ...scope, hostId: "server-44" }, cursor: first.nextCursor!, reader })).rejects.toThrow(/cross-session cursor/);
    await expect(readIntegratorTranscriptPage({ scope: { ...scope, harness: "claude" }, cursor: first.nextCursor!, reader })).rejects.toThrow(/cross-session cursor/);
    await expect(readIntegratorTranscriptPage({ scope: { ...scope, nativeSessionId: "thread-8" }, cursor: first.nextCursor!, reader })).rejects.toThrow(/cross-session cursor/);
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed cursors before invoking the reader", async () => {
    const reader = vi.fn<NativeTranscriptPageReader>();
    await expect(readIntegratorTranscriptPage({ scope, cursor: "not-a-cursor", reader })).rejects.toThrow(/malformed cursor/);
    expect(reader).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong echoed cursor", page("other", [human], 0, "next")],
    ["missing sequence", page(null, [{ ...human, sequence: 1 }], 0, "next")],
    ["empty nonterminal page", page(null, [], 0, "next")],
    ["duplicate event identity", page(null, [human, { ...human, sequence: 1 }], 0, "next")],
    ["missing tool identity", page(null, [{ ...toolCall, toolName: "", toolCallId: "" }], 0, "next")],
    ["truncated final page", page(null, [human], 0, null)],
  ])("fails closed for %s", async (_case, badPage) => {
    await expect(readIntegratorTranscriptPage({ scope, reader: async () => badPage })).rejects.toThrow(/Native transcript page rejected/);
  });

  it("rejects unstable event totals or a repeated native cursor between pages", async () => {
    const first = await readIntegratorTranscriptPage({ scope, reader: async () => page(null, [human], 0, "cursor-1") });
    await expect(readIntegratorTranscriptPage({ scope, cursor: first.nextCursor!, reader: async () => ({ ...page("cursor-1", [toolCall], 1, null), totalEvents: 2 }) })).rejects.toThrow(/changed while paging/);
    await expect(readIntegratorTranscriptPage({ scope, cursor: first.nextCursor!, reader: async () => page("cursor-1", [toolCall], 1, "cursor-1") })).rejects.toThrow(/repeated its cursor/);
  });

  it("pages the actual complete Codex adapter JSONL export, including tools beyond its 50-message preview", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "herder-integrator-transcript-"));
    roots.push(codexDir);
    const sessionDir = join(codexDir, "sessions", "2026", "10", "20");
    await mkdir(sessionDir, { recursive: true });
    const rolloutPath = join(sessionDir, "rollout-thread-7.jsonl");
    const record = (type: string, payload: unknown) => JSON.stringify({ type, timestamp: "2026-10-20T12:00:00.000Z", payload });
    const transcript = [record("session_meta", { id: "thread-7", cwd: "/workspace" })];
    for (let index = 0; index < 52; index++) {
      const role = index % 2 === 0 ? "user" : "assistant";
      const text = index === 19 ? "Привет 🌍" : `body-${index}`;
      transcript.push(record("response_item", { type: "message", id: `message-${index}`, role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] }));
    }
    for (let index = 0; index < 4; index++) {
      transcript.push(record("response_item", { type: "function_call", id: `call-event-${index}`, call_id: `call-${index}`, name: "shell_exec", arguments: JSON.stringify({ command: "pwd" }) }));
      transcript.push(record("response_item", { type: "function_call_output", id: `result-event-${index}`, call_id: `call-${index}`, output: "/workspace" }));
    }
    await writeFile(rolloutPath, `${transcript.join("\n")}\n`);
    await writeFile(join(codexDir, "session_index.jsonl"), `${JSON.stringify({ id: "thread-7", updated_at: "2026-10-20T12:00:00.000Z" })}\n`);
    const adapter = new CodexAdapter({ codexDir, codexBin: "/not-started" });
    const raw = await adapter.getRawTranscript("thread-7");
    expect(raw).toMatchObject({ complete: true, source: { kind: "native-file", format: "jsonl" } });
    const reader = createRawTranscriptPageReader({ scope, getRawTranscript: (id) => adapter.getRawTranscript(id) });
    const first = await readIntegratorTranscriptPage({ scope, limit: 20, reader });
    expect(first).toMatchObject({ totalEvents: 60, complete: false });
    await appendFile(rolloutPath, `${record("response_item", { type: "message", id: "appended-1", role: "user", content: [{ type: "input_text", text: "追加 Привет" }] })}\n`);
    const second = await readIntegratorTranscriptPage({ scope, cursor: first.nextCursor!, limit: 20, reader });
    await appendFile(rolloutPath, `${record("response_item", { type: "message", id: "appended-2", role: "assistant", content: [{ type: "output_text", text: "added" }] })}\n`);
    const third = await readIntegratorTranscriptPage({ scope, cursor: second.nextCursor!, limit: 20, reader });
    const pages = [first, second, third];
    const events = pages.flatMap((result) => result.events);
    expect(pages).toHaveLength(3);
    expect(pages.map((result) => result.totalEvents)).toEqual([60, 60, 60]);
    expect(pages[0]).toMatchObject({ source: "native-complete-export", complete: false });
    expect(events).toHaveLength(60);
    expect(events.map((event) => event.sequence)).toEqual(Array.from({ length: 60 }, (_, index) => index));
    expect(events.filter((event) => event.kind.startsWith("tool_")).map((event) => event.kind)).toEqual([
      "tool_call", "tool_result", "tool_call", "tool_result", "tool_call", "tool_result", "tool_call", "tool_result",
    ]);
    expect(events[0]).toMatchObject({ author: { kind: "unknown", sourceRole: "user" }, nativeEventId: "message-0" });
    expect(events[19]?.text).toBe("Привет 🌍");
    expect(events[52]).toMatchObject({ kind: "tool_call", toolName: "shell_exec", toolCallId: "call-0" });
    expect(events.some((event) => event.eventId === "appended-1" || event.eventId === "appended-2")).toBe(false);
    const freshSnapshot = await readIntegratorTranscriptPage({ scope, limit: 100, reader });
    expect(freshSnapshot.totalEvents).toBe(62);
    expect(freshSnapshot.events.slice(-2).map((event) => event.nativeEventId)).toEqual(["appended-1", "appended-2"]);
  });

  it("rejects coordinated outer cursor sequence tampering while preserving replay", async () => {
    const bytes = new TextEncoder().encode(Array.from({ length: 4 }, (_, index) => JSON.stringify({
      type: "response_item", payload: { type: "message", id: `m${index}`, role: "user", content: [{ type: "input_text", text: `m${index}` }] },
    })).join("\n") + "\n");
    const reader = createRawTranscriptPageReader({ scope, getRawTranscript: async () => ({
      bytes, complete: true, source: { kind: "native-file", location: "fixture", format: "jsonl" }, timestampCoverage: "native",
    }) });
    const first = await readIntegratorTranscriptPage({ scope, limit: 1, reader });
    const replay = await readIntegratorTranscriptPage({ scope, cursor: first.nextCursor!, limit: 1, reader });
    expect(await readIntegratorTranscriptPage({ scope, cursor: first.nextCursor!, limit: 1, reader })).toEqual(replay);
    const outer = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8")) as { nextSequence: number; totalEvents: number };
    outer.nextSequence += 1;
    const forged = Buffer.from(JSON.stringify(outer), "utf8").toString("base64url");
    await expect(readIntegratorTranscriptPage({ scope, cursor: forged, limit: 1, reader })).rejects.toThrow(/sequence has a gap or overlap/);
    expect(replay.events.map((event) => event.nativeEventId)).toEqual(["m1"]);
  });

  it("expires issued cursors when the reader is restarted", async () => {
    const bytes = new TextEncoder().encode(Array.from({ length: 2 }, (_, index) => JSON.stringify({
      type: "response_item", payload: { type: "message", id: `restart-${index}`, role: "user", content: [{ type: "input_text", text: "x" }] },
    })).join("\n") + "\n");
    const getRawTranscript = async () => ({ bytes, complete: true as const, source: { kind: "native-file" as const, location: "fixture", format: "jsonl" as const }, timestampCoverage: "native" as const });
    const first = await readIntegratorTranscriptPage({ scope, limit: 1, reader: createRawTranscriptPageReader({ scope, getRawTranscript }) });
    const restartedReader = createRawTranscriptPageReader({ scope, getRawTranscript });
    await expect(readIntegratorTranscriptPage({ scope, cursor: first.nextCursor!, limit: 1, reader: restartedReader })).rejects.toThrow(/not issued by this reader or has expired/);
  });

  it("rejects impossible trailing UTF-8 but excludes a valid incomplete multibyte EOF", async () => {
    const row = JSON.stringify({ type: "response_item", payload: { type: "message", id: "valid", role: "user", content: [{ type: "input_text", text: "valid" }] } });
    const source = { kind: "native-file" as const, location: "fixture", format: "jsonl" as const };
    const read = (bytes: Uint8Array) => readIntegratorTranscriptPage({ scope, reader: createRawTranscriptPageReader({
      scope, getRawTranscript: async () => ({ bytes, complete: true, source, timestampCoverage: "native" }),
    }) });
    await expect(read(Buffer.concat([Buffer.from(`${row}\n`), Buffer.from([0xff])]))).rejects.toThrow(/invalid UTF-8/);
    const partialUtf8 = Buffer.concat([Buffer.from(`${row}\n`), Buffer.from('{"pending":"'), Buffer.from([0xf0, 0x9f])]);
    const result = await read(partialUtf8);
    expect(result).toMatchObject({ totalEvents: 1, complete: true, events: [{ nativeEventId: "valid" }] });
  });

  it("rejects rewrite and truncation of a frozen canonical prefix", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "herder-integrator-append-"));
    roots.push(codexDir);
    const sessionDir = join(codexDir, "sessions", "2026", "10", "20");
    await mkdir(sessionDir, { recursive: true });
    const rolloutPath = join(sessionDir, "rollout-thread-7.jsonl");
    const header = JSON.stringify({ type: "session_meta", payload: { id: "thread-7", cwd: "/workspace" } });
    const message = (id: string) => JSON.stringify({ type: "response_item", payload: { type: "message", id, role: "user", content: [{ type: "input_text", text: id }] } });
    await writeFile(rolloutPath, `${header}\n${Array.from({ length: 3 }, (_, index) => message(`before-${index}`)).join("\n")}\n`);
    await writeFile(join(codexDir, "session_index.jsonl"), `${JSON.stringify({ id: "thread-7" })}\n`);
    const adapter = new CodexAdapter({ codexDir, codexBin: "/not-started" });
    const reader = createRawTranscriptPageReader({ scope, getRawTranscript: (id) => adapter.getRawTranscript(id) });
    const first = await readIntegratorTranscriptPage({ scope, limit: 2, reader });
    expect(first.nextCursor).toBeTruthy();
    const original = await readFile(rolloutPath);
    const rewritten = Buffer.from(original);
    const before = Buffer.from("before-0");
    const after = Buffer.from("rewrite0");
    expect(after.byteLength).toBe(before.byteLength);
    const replacementAt = rewritten.indexOf(before);
    expect(replacementAt).toBeGreaterThanOrEqual(0);
    after.copy(rewritten, replacementAt);
    await writeFile(rolloutPath, rewritten);
    await expect(readIntegratorTranscriptPage({ scope, cursor: first.nextCursor!, limit: 2, reader })).rejects.toThrow(/prefix was rewritten/);

    const secondFirst = await readIntegratorTranscriptPage({ scope, limit: 2, reader });
    await writeFile(rolloutPath, original.subarray(0, Math.max(1, original.byteLength - 40)));
    await expect(readIntegratorTranscriptPage({ scope, cursor: secondFirst.nextCursor!, limit: 2, reader })).rejects.toThrow(/truncated/);
  });

  it("rejects a corrupt inner snapshot cursor", async () => {
    const raw: RawTranscriptExport = {
      bytes: new TextEncoder().encode(JSON.stringify([{ type: "response_item", payload: { type: "message", id: "m1", role: "user", content: [{ type: "input_text", text: "hello" }] } }])),
      complete: true, source: { kind: "native-file", location: "fixture", format: "jsonl" }, timestampCoverage: "native",
    };
    const reader = createRawTranscriptPageReader({ scope, getRawTranscript: async () => raw });
    await expect(reader({ scope, cursor: "not-a-snapshot-cursor", limit: 1 })).rejects.toThrow(/not issued by this reader or has expired/);
  });

  it("rejects a forged inner snapshot cursor because continuations are reader-issued opaque tokens", async () => {
    const raw: RawTranscriptExport = {
      bytes: new TextEncoder().encode([
        JSON.stringify({ type: "response_item", payload: { type: "message", id: "m1", role: "user", content: [{ type: "input_text", text: "one" }] } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", id: "m2", role: "assistant", content: [{ type: "output_text", text: "two" }] } }),
        "",
      ].join("\n")),
      complete: true, source: { kind: "native-file", location: "fixture", format: "jsonl" }, timestampCoverage: "native",
    };
    const reader = createRawTranscriptPageReader({ scope, getRawTranscript: async () => raw });
    const first = await readIntegratorTranscriptPage({ scope, limit: 1, reader });
    const outer = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8")) as { nativeCursor: string };
    outer.nativeCursor = "forged-inner-state";
    const corrupt = Buffer.from(JSON.stringify(outer), "utf8").toString("base64url");
    await expect(readIntegratorTranscriptPage({ scope, cursor: corrupt, limit: 1, reader })).rejects.toThrow(/not issued by this reader or has expired/);
  });

  it("rejects source metadata changes even when transcript bytes are identical", async () => {
    const bytes = new TextEncoder().encode([
      JSON.stringify({ type: "response_item", payload: { type: "message", id: "m1", role: "user", content: [{ type: "input_text", text: "one" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", id: "m2", role: "assistant", content: [{ type: "output_text", text: "two" }] } }),
    ].join("\n") + "\n");
    let raw: RawTranscriptExport = { bytes, complete: true, source: { kind: "native-file", location: "fixture-a", format: "jsonl" }, timestampCoverage: "native" };
    const reader = createRawTranscriptPageReader({ scope, getRawTranscript: async () => raw });
    const first = await readIntegratorTranscriptPage({ scope, limit: 1, reader });
    raw = { ...raw, source: { ...raw.source, location: "fixture-b" } };
    await expect(readIntegratorTranscriptPage({ scope, cursor: first.nextCursor!, limit: 1, reader })).rejects.toThrow(/source metadata changed/);
  });

  it("rejects native export metadata that names a different session", async () => {
    const bytes = new TextEncoder().encode(`${JSON.stringify({ type: "session_meta", payload: { id: "thread-foreign" } })}\n${JSON.stringify({ type: "response_item", payload: { type: "message", id: "m1", role: "user", content: [{ type: "input_text", text: "one" }] } })}\n`);
    const reader = createRawTranscriptPageReader({ scope, getRawTranscript: async () => ({
      bytes, complete: true, source: { kind: "native-file", location: "fixture", format: "jsonl" }, timestampCoverage: "native",
    }) });
    await expect(readIntegratorTranscriptPage({ scope, reader })).rejects.toThrow(/does not match the requested session/);
  });

  it("keeps a frozen page snapshot at the last complete event while an EOF record is still being written", async () => {
    const row = (id: string) => JSON.stringify({ type: "response_item", payload: { type: "message", id, role: "user", content: [{ type: "input_text", text: id }] } });
    const firstRow = row("complete-1");
    const secondRow = row("complete-2");
    const pendingRow = row("pending-3");
    let bytes = new TextEncoder().encode(`${firstRow}\n${secondRow}\n${pendingRow.slice(0, 40)}`);
    const reader = createRawTranscriptPageReader({ scope, getRawTranscript: async () => ({
      bytes, complete: true, source: { kind: "native-file", location: "fixture", format: "jsonl" }, timestampCoverage: "native",
    }) });
    const first = await readIntegratorTranscriptPage({ scope, limit: 1, reader });
    expect(first.totalEvents).toBe(2);
    bytes = new TextEncoder().encode(`${firstRow}\n${secondRow}\n${pendingRow}`);
    const second = await readIntegratorTranscriptPage({ scope, cursor: first.nextCursor!, limit: 1, reader });
    expect(second).toMatchObject({ totalEvents: 2, complete: true, events: [{ nativeEventId: "complete-2" }] });
    const refreshed = await readIntegratorTranscriptPage({ scope, limit: 10, reader });
    expect(refreshed.totalEvents).toBe(3);
    expect(refreshed.events.at(-1)).toMatchObject({ nativeEventId: "pending-3" });
  });

  it("denies oversized, incomplete, non-native, and unsupported-format exports", async () => {
    const bytes = new Uint8Array(MAX_NATIVE_TRANSCRIPT_SNAPSHOT_BYTES + 1);
    const good: RawTranscriptExport = { bytes, complete: true, source: { kind: "native-file", location: "fixture", format: "jsonl" }, timestampCoverage: "native" };
    const oversized = createRawTranscriptPageReader({ scope, getRawTranscript: async () => good });
    await expect(readIntegratorTranscriptPage({ scope, reader: oversized })).rejects.toThrow(/exceeds/);
    for (const raw of [
      { ...good, complete: false },
      { ...good, source: { ...good.source, kind: "observed-cli-output" as const } },
      { ...good, source: { ...good.source, format: "json" as const } },
    ]) {
      const unsupported = createRawTranscriptPageReader({ scope, getRawTranscript: async () => raw });
      await expect(readIntegratorTranscriptPage({ scope, reader: unsupported })).rejects.toThrow(/no supported complete JSONL export/);
    }
    const unsupportedHarness = { ...scope, harness: "fast-agent" };
    const harnessReader = createRawTranscriptPageReader({ scope: unsupportedHarness, getRawTranscript: async () => good });
    await expect(readIntegratorTranscriptPage({ scope: unsupportedHarness, reader: harnessReader })).rejects.toThrow(/unsupported native JSONL harness/);
  });
});
