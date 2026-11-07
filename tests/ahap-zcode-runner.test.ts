import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import type { ZcodeAdapter } from "../src/adapters/zcode.js";
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

it("exposes only the bounded ZCode AHAP methods", async () => {
  const replies = await run({ async dispose() {} }, [initialize, { jsonrpc: "2.0", id: 2, method: "shutdown" }]);
  expect(replies[0].result).toMatchObject({
    harness: "zcode",
    capabilities: { methods: ["init", "createSession", "sendMessage", "getSession", "getSessionMessages"], controlCapabilities: { events: false, steer: false } },
  });
});

it("forces restricted create, Queue delivery and exact read routing", async () => {
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
  expect(calls.find((call) => call.method === "sendMessage")?.args).toEqual(["zcode-session-exact", { message: "one input", queue: true, activeTurnOnly: true, inputId: "input-17", origin: "automation" }]);
  expect(calls.find((call) => call.method === "getSessionMessages")?.args).toEqual(["zcode-session-exact", 20]);
  expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
  expect(calls.at(-1)?.method).toBe("dispose");
});

it("rejects implicit full access and steering before native calls", async () => {
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
