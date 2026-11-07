import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { ZcodeAdapter } from "../src/adapters/zcode.js";
import { serveZcodeAhap } from "../src/ahap-zcode-runner.js";

async function run(adapter: Partial<ZcodeAdapter>, requests: unknown[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => chunks.push(chunk));
  const completed = serveZcodeAhap(adapter as ZcodeAdapter, input, output);
  input.end(requests.map((request) => JSON.stringify(request)).join("\n") + "\n");
  await completed;
  return chunks.join("").trim().split("\n").map((line) => JSON.parse(line));
}

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { harness: "zcode", ahapVersion: "0.1" } };

function offlineAdapter(native: { sessionId: string; inputId: string; userMessageId?: string; turnId?: string }) {
  const directory = mkdtempSync(join(tmpdir(), "ahap-zcode-receipt-"));
  const dbPath = join(directory, "native.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE message(session_id TEXT, id TEXT, data TEXT, sequence INTEGER); CREATE TABLE turn_usage(session_id TEXT, user_message_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER);");
  if (native.userMessageId) {
    const data = JSON.stringify({ role: "user", anchor: { sourceCommandId: `agent-herder:auto:${native.inputId}`, ...(native.turnId ? { turnId: native.turnId } : {}) } });
    db.prepare("INSERT INTO message(session_id,id,data,sequence) VALUES(?,?,?,?)").run(native.sessionId, native.userMessageId, data, 1);
    if (native.turnId) db.prepare("INSERT INTO turn_usage(session_id,user_message_id,turn_id,status,started_at) VALUES(?,?,?,?,?)").run(native.sessionId, native.userMessageId, native.turnId, "running", 1);
  } else if (native.turnId) {
    db.prepare("INSERT INTO turn_usage(session_id,user_message_id,turn_id,status,started_at) VALUES(?,?,?,?,?)").run(native.sessionId, "unlinked-user", native.turnId, "running", 1);
  }
  db.close();

  const adapter = Object.create(ZcodeAdapter.prototype) as ZcodeAdapter & { localDbPath: string; sendConversationInput: (...args: any[]) => Promise<unknown>; dispose: () => Promise<void> };
  adapter.localDbPath = dbPath;
  let sends = 0;
  adapter.sendConversationInput = async (id, options) => {
    sends++;
    expect(id).toBe(native.sessionId);
    expect(options.inputId).toBe(native.inputId);
    return { ok: true, admitted: true, pending: true, inputId: native.inputId, ...(native.turnId ? { turnId: native.turnId } : {}) };
  };
  adapter.dispose = async () => {};
  return { adapter, get sends() { return sends; }, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

it("exposes only the bounded ZCode AHAP methods", async () => {
  const replies = await run({ async dispose() {} }, [initialize, { jsonrpc: "2.0", id: 2, method: "shutdown" }]);
  expect(replies[0].result).toMatchObject({
    harness: "zcode",
    capabilities: { methods: ["init", "createSession", "sendMessage", "getSession", "getSessionMessages"], controlCapabilities: { events: false, steer: false } },
  });
});

it("keeps restricted create, requested Queue delivery and exact read routing", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const adapter = {
    async init() { calls.push({ method: "init", args: [] }); },
    async createSession(options: unknown) { calls.push({ method: "createSession", args: [options] }); return { id: "zcode-session-exact" }; },
    async sendMessage(id: string, options: unknown) { calls.push({ method: "sendMessage", args: [id, options] }); return { ok: true, admitted: true, inputId: "input-17", nativeInputMessageId: "native-msg-17" }; },
    async getSession(id: string) { calls.push({ method: "getSession", args: [id] }); return { id }; },
    async getSessionMessages(id: string, limit?: number) { calls.push({ method: "getSessionMessages", args: [id, limit] }); return [{ id: "native-msg-17" }]; },
    async dispose() { calls.push({ method: "dispose", args: [] }); },
  };
  const replies = await run(adapter, [initialize,
    { jsonrpc: "2.0", id: 2, method: "init" },
    { jsonrpc: "2.0", id: 3, method: "createSession", params: { options: { name: "fixture", cwd: "/tmp/work" } } },
    { jsonrpc: "2.0", id: 4, method: "sendMessage", params: { id: "zcode-session-exact", options: { message: "one input", queue: true, inputId: "input-17" } } },
    { jsonrpc: "2.0", id: 5, method: "getSession", params: { id: "zcode-session-exact" } },
    { jsonrpc: "2.0", id: 6, method: "getSessionMessages", params: { id: "zcode-session-exact", limit: 20 } },
    { jsonrpc: "2.0", id: 7, method: "shutdown" },
  ]);
  expect(replies[2].result.id).toBe("zcode-session-exact");
  expect(replies[3].result).toMatchObject({ inputId: "input-17", nativeInputMessageId: "native-msg-17" });
  expect(replies[3].result.inputId).not.toBe(replies[3].result.nativeInputMessageId);
  expect(calls.find((call) => call.method === "createSession")?.args[0]).toMatchObject({ mode: "build", fullAccess: false });
  expect(calls.find((call) => call.method === "sendMessage")?.args).toEqual(["zcode-session-exact", { message: "one input", queue: true, inputId: "input-17" }]);
  expect(calls.find((call) => call.method === "getSessionMessages")?.args).toEqual(["zcode-session-exact", 20]);
  expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
  expect(calls.at(-1)?.method).toBe("dispose");
});

it("rejects implicit full access and conflicting delivery modes before native calls", async () => {
  let mutations = 0;
  const adapter = {
    async createSession() { mutations++; return {} as never; },
    async sendMessage() { mutations++; return {} as never; },
    async dispose() {},
  };
  const replies = await run(adapter, [initialize,
    { jsonrpc: "2.0", id: 2, method: "createSession", params: { options: { name: "unsafe", cwd: "/tmp", fullAccess: true } } },
    { jsonrpc: "2.0", id: 3, method: "sendMessage", params: { id: "exact", options: { message: "steer", queue: true, steer: true, inputId: "input" } } },
    { jsonrpc: "2.0", id: 4, method: "shutdown" },
  ]);
  expect(replies[1].error.code).toBe(-32602);
  expect(replies[2].error.code).toBe(-32602);
  expect(mutations).toBe(0);
});

it("reports ambiguous mutations as UNKNOWN without retry", async () => {
  let sends = 0;
  const replies = await run({
    async sendMessage() { sends++; throw new Error("lost response"); },
    async dispose() {},
  }, [initialize,
    { jsonrpc: "2.0", id: 2, method: "sendMessage", params: { id: "exact", options: { message: "once", queue: true, inputId: "stable" } } },
    { jsonrpc: "2.0", id: 3, method: "shutdown" },
  ]);
  expect(sends).toBe(1);
  expect(replies[1].error).toMatchObject({ code: -32000, data: { outcome: "unknown", retryable: false } });
});

it("passes only the exact native message anchor while preserving caller inputId", async () => {
  const offline = offlineAdapter({ sessionId: "sess/zcode:17", inputId: "caller-17", userMessageId: "native-user:42", turnId: "native-turn:9" });
  try {
    const replies = await run(offline.adapter, [initialize,
      { jsonrpc: "2.0", id: 2, method: "sendMessage", params: { id: "sess/zcode:17", options: { message: "one queued input", queue: true, inputId: "caller-17" } } },
      { jsonrpc: "2.0", id: 3, method: "shutdown" },
    ]);
    expect(replies[1].result).toMatchObject({
      admitted: true,
      pending: true,
      inputId: "caller-17",
      nativeInputMessageId: "native-user:42",
      turnId: "native-turn:9",
    });
    expect(replies[1].result.inputId).not.toBe(replies[1].result.nativeInputMessageId);
    expect(offline.sends).toBe(1);
  } finally {
    offline.cleanup();
  }
});

it("does not turn turnId-only evidence into a native message receipt", async () => {
  const offline = offlineAdapter({ sessionId: "sess/zcode:18", inputId: "caller-18", turnId: "turn-only:1" });
  try {
    const replies = await run(offline.adapter, [initialize,
      { jsonrpc: "2.0", id: 2, method: "sendMessage", params: { id: "sess/zcode:18", options: { message: "one queued input", queue: true, inputId: "caller-18" } } },
      { jsonrpc: "2.0", id: 3, method: "shutdown" },
    ]);
    expect(replies[1].result).toMatchObject({ admitted: true, pending: true, inputId: "caller-18", turnId: "turn-only:1" });
    expect(replies[1].result.nativeInputMessageId).toBeUndefined();
    expect(offline.sends).toBe(1);
  } finally {
    offline.cleanup();
  }
});

it("does not borrow a native receipt from another session or command correlation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ahap-zcode-receipt-mismatch-"));
  const dbPath = join(directory, "native.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE message(session_id TEXT, id TEXT, data TEXT, sequence INTEGER); CREATE TABLE turn_usage(session_id TEXT, user_message_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER);");
  db.prepare("INSERT INTO message(session_id,id,data,sequence) VALUES(?,?,?,?)").run(
    "some-other-session", "native-user:other", JSON.stringify({ role: "user", anchor: { sourceCommandId: "agent-herder:auto:caller-mismatch" } }), 1,
  );
  db.prepare("INSERT INTO message(session_id,id,data,sequence) VALUES(?,?,?,?)").run(
    "sess/zcode:19", "native-user:wrong-command", JSON.stringify({ role: "user", anchor: { sourceCommandId: "agent-herder:auto:someone-else" } }), 2,
  );
  db.close();

  const adapter = Object.create(ZcodeAdapter.prototype) as ZcodeAdapter & { localDbPath: string; sendConversationInput: (...args: any[]) => Promise<unknown>; dispose: () => Promise<void> };
  adapter.localDbPath = dbPath;
  let sends = 0;
  adapter.sendConversationInput = async () => { sends++; return { ok: true, admitted: true, pending: true, inputId: "caller-mismatch" }; };
  adapter.dispose = async () => {};
  try {
    const replies = await run(adapter, [initialize,
      { jsonrpc: "2.0", id: 2, method: "sendMessage", params: { id: "sess/zcode:19", options: { message: "one queued input", queue: true, inputId: "caller-mismatch" } } },
      { jsonrpc: "2.0", id: 3, method: "shutdown" },
    ]);
    expect(replies[1].result).toMatchObject({ admitted: true, pending: true, inputId: "caller-mismatch" });
    expect(replies[1].result.nativeInputMessageId).toBeUndefined();
    expect(sends).toBe(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("preserves explicit steer and sync delivery for existing sessions", async () => {
  const calls:unknown[]=[];
  const adapter={async sendMessage(id:string,options:any){calls.push([id,options]);return {ok:true,inputId:options.inputId,turnId:"native-turn"};},async dispose(){}};
  const options={message:"existing steer",queue:false,steer:true,inputId:"steer-exact",activeTurnOnly:true,origin:"human"};
  const sync={message:"existing sync",queue:false,inputId:"sync-exact"};
  const replies=await run(adapter,[initialize,{jsonrpc:"2.0",id:2,method:"sendMessage",params:{id:"existing",options}},{jsonrpc:"2.0",id:3,method:"sendMessage",params:{id:"existing",options:sync}}]);
  expect(calls).toEqual([["existing",options],["existing",sync]]);
  expect(replies[1].result.turnId).toBe("native-turn");expect(replies[2].result.inputId).toBe("sync-exact");
});
