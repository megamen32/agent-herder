import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import type { OpenCodeAdapter } from "../src/adapters/opencode.js";
import { serveOpenCodeAhap } from "../src/ahap-opencode-runner.js";

async function run(adapter: Partial<OpenCodeAdapter>, requests: unknown[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => chunks.push(chunk));
  const completed = serveOpenCodeAhap(adapter as OpenCodeAdapter, input, output);
  input.end(requests.map((request) => JSON.stringify(request)).join("\n") + "\n");
  await completed;
  return chunks.join("").trim().split("\n").map((line) => JSON.parse(line));
}

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { harness: "opencode", ahapVersion: "0.1" } };

it("rejects JSON primitives and arrays as invalid requests, then keeps serving", async () => {
  let adapterCalls = 0;
  const adapter = {
    async init() { adapterCalls += 1; },
    async createSession() { adapterCalls += 1; return {} as never; },
    async sendMessage() { adapterCalls += 1; return {} as never; },
    async getSession() { adapterCalls += 1; return null; },
    async getSessionMessages() { adapterCalls += 1; return null; },
  };
  const replies = await run(adapter, [null, "primitive", [], initialize, { jsonrpc: "2.0", id: 2, method: "init" }, { jsonrpc: "2.0", id: 3, method: "shutdown" }]);

  expect(replies.slice(0, 3)).toEqual([
    { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } },
    { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } },
    { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } },
  ]);
  expect(replies[3].result.harness).toBe("opencode");
  expect(replies[4].result).toBeNull();
  expect(adapterCalls).toBe(1);
});

it("maps create, Queue delivery and exact read results without rewriting receipts", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const adapter = {
    async init() { calls.push({ method: "init", args: [] }); },
    async createSession(options: unknown) {
      calls.push({ method: "createSession", args: [options] });
      return { id: "ses_created_exact", harness: "opencode", status: "idle", title: "worker", cwd: "/tmp/work", hostId: "fixture" };
    },
    async sendMessage(id: string, options: unknown) {
      calls.push({ method: "sendMessage", args: [id, options] });
      return { ok: true, admitted: true, pending: true, inputId: "caller-input-17", nativeInputMessageId: "msg_native_17" };
    },
    async getSession(id: string) {
      calls.push({ method: "getSession", args: [id] });
      return { id, harness: "opencode", status: "running", title: "worker", cwd: "/tmp/work", hostId: "fixture" };
    },
    async getSessionMessages(id: string, limit?: number) {
      calls.push({ method: "getSessionMessages", args: [id, limit] });
      return [{ id: "msg_native_17", role: "user", inputId: "caller-input-17", turnId: "turn_17", text: "do work", parts: [{ type: "text", text: "do work" }] }];
    },
  };
  const replies = await run(adapter, [
    initialize,
    { jsonrpc: "2.0", id: 2, method: "init" },
    { jsonrpc: "2.0", id: 3, method: "createSession", params: { options: { name: "worker", cwd: "/tmp/work" } } },
    { jsonrpc: "2.0", id: 4, method: "sendMessage", params: { id: "ses_created_exact", options: { message: "do work", queue: true, inputId: "caller-input-17" } } },
    { jsonrpc: "2.0", id: 5, method: "getSession", params: { id: "ses_created_exact" } },
    { jsonrpc: "2.0", id: 6, method: "getSessionMessages", params: { id: "ses_created_exact", limit: 50 } },
    { jsonrpc: "2.0", id: 7, method: "shutdown" },
  ]);

  expect(replies[0].result.capabilities.methods).toEqual(["init", "createSession", "sendMessage", "getSession", "getSessionMessages"]);
  expect(replies[0].result.capabilities.controlCapabilities).toMatchObject({ events: false, steer: false });
  expect(replies[2].result.id).toBe("ses_created_exact");
  expect(replies[3].result).toMatchObject({ inputId: "caller-input-17", nativeInputMessageId: "msg_native_17", admitted: true });
  expect(replies[3].result.inputId).not.toBe(replies[3].result.nativeInputMessageId);
  expect(replies[4].result.id).toBe("ses_created_exact");
  expect(replies[5].result[0]).toMatchObject({ id: "msg_native_17", inputId: "caller-input-17", turnId: "turn_17" });
  const send = calls.find((call) => call.method === "sendMessage")!;
  expect(send.args[0]).toBe("ses_created_exact");
  expect(send.args[1]).toMatchObject({ queue: true, activeTurnOnly: true, inputId: "caller-input-17" });
  expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
});

it("returns an UNKNOWN error after a lost mutating call and never invokes a fallback", async () => {
  let submits = 0;
  const adapter = {
    async init() {},
    async createSession() { throw new Error("response lost after native create"); },
    async sendMessage() { submits += 1; throw new Error("response lost after native queue"); },
    async getSession() { return null; },
    async getSessionMessages() { return null; },
  };
  const replies = await run(adapter, [
    initialize,
    { jsonrpc: "2.0", id: 2, method: "sendMessage", params: { id: "ses_exact", options: { message: "one input", queue: true, inputId: "input-once" } } },
    { jsonrpc: "2.0", id: 3, method: "shutdown" },
  ]);

  expect(submits).toBe(1);
  expect(replies[1].error).toMatchObject({ code: -32000, data: { outcome: "unknown", retryable: false } });
});

it("rejects unsupported delivery before calling the adapter and does not invent a native receipt", async () => {
  let submits = 0;
  const adapter = {
    async init() {},
    async createSession() { return {} as never; },
    async sendMessage(_id: string, _options: unknown) {
      submits += 1;
      return { ok: true, admitted: true, pending: true, inputId: "caller-input" };
    },
    async getSession() { return null; },
    async getSessionMessages() { return null; },
  };
  const replies = await run(adapter, [
    initialize,
    { jsonrpc: "2.0", id: 2, method: "sendMessage", params: { id: "ses_exact", options: { message: "no steer", queue: false, inputId: "input" } } },
    { jsonrpc: "2.0", id: 3, method: "sendMessage", params: { id: "ses_exact", options: { message: "accepted, receipt absent", queue: true, inputId: "caller-input" } } },
    { jsonrpc: "2.0", id: 4, method: "shutdown" },
  ]);

  expect(replies[1].error.code).toBe(-32602);
  expect(replies[2].result).toMatchObject({ admitted: true, inputId: "caller-input" });
  expect(replies[2].result.nativeInputMessageId).toBeUndefined();
  expect(submits).toBe(1);
});
