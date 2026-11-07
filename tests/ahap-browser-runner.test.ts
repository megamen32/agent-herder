import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { BrowserChatAdapter } from "../src/adapters/browser-chat.js";
import { serveBrowserChatAhap } from "../src/ahap-browser-runner.js";

const scope = "a".repeat(64);
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { harness: "chatgpt", ahapVersion: "0.1" } };

async function run(adapter: Partial<BrowserChatAdapter>, requests: unknown[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  let data = "";
  output.setEncoding("utf8");
  output.on("data", chunk => { data += chunk; });
  const serving = serveBrowserChatAhap(adapter as BrowserChatAdapter, input, output, scope);
  input.end(requests.map(request => JSON.stringify(request)).join("\n") + "\n");
  await serving;
  return data.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
}

describe("ChatGPT AHAP browser runner", () => {
  it("advertises only its bounded surface and routes init and exact reads", async () => {
    const calls: string[] = [];
    const session = { id: "chatgpt::native%2Fid", harness: "chatgpt", name: "one", cwd: "/tmp", status: "idle" } as never;
    const adapter = {
      getAccountScope: () => scope,
      async init() { calls.push("init"); },
      async listSessions() { calls.push("listSessions"); return [session]; },
      async getSession(id: string) { calls.push(`getSession:${id}`); return session; },
      async getSessionMessages(id: string, limit?: number) { calls.push(`getSessionMessages:${id}:${limit}`); return []; },
      async createSession(options: { name: string; cwd: string }) { calls.push(`createSession:${options.name}:${options.cwd}`); return session; },
    };
    const replies = await run(adapter, [initialize,
      { jsonrpc: "2.0", id: 2, method: "init" },
      { jsonrpc: "2.0", id: 3, method: "listSessions" },
      { jsonrpc: "2.0", id: 4, method: "getSession", params: { id: "chatgpt::native%2Fid" } },
      { jsonrpc: "2.0", id: 5, method: "getSessionMessages", params: { id: "chatgpt::native%2Fid", limit: 25 } },
      { jsonrpc: "2.0", id: 6, method: "createSession", params: { options: { name: "new", cwd: "/tmp" } } },
      { jsonrpc: "2.0", id: 7, method: "shutdown" },
    ]);
    const caps = (replies[0].result as { capabilities: { methods: string[]; controlCapabilities: Record<string, boolean> } }).capabilities;
    expect(caps.methods).toContain("getSessionMessages");
    expect(caps.methods).not.toContain("listProjects");
    expect(caps.methods).not.toContain("subscribeEvents");
    expect(caps.methods).not.toContain("stopTurn");
    expect(caps.methods).not.toContain("listModels");
    expect(caps.controlCapabilities.events).toBe(false);
    expect(calls).toEqual(["init", "listSessions", "getSession:chatgpt::native%2Fid", "getSessionMessages:chatgpt::native%2Fid:25", "createSession:new:/tmp"]);
    expect(replies[1].result).toBeNull();
    expect((replies[2].result as unknown[])[0]).toEqual(session);
  });

  it("requires the configured account scope before any operation", async () => {
    let called = false;
    const replies = await run({
      getAccountScope: () => "b".repeat(64),
      async init() { called = true; },
    }, [initialize, { jsonrpc: "2.0", id: 2, method: "init" }, { jsonrpc: "2.0", id: 3, method: "shutdown" }]);
    expect(called).toBe(true);
    expect(replies[1].error).toBeDefined();
  });

  it("preserves an ambiguous send as UNKNOWN and never retries", async () => {
    let sends = 0;
    const replies = await run({
      getAccountScope: () => scope,
      async init() {},
      async sendMessage() { sends += 1; return { ok: false, admissionUnknown: true, nonRetryable: true, notSubmitted: true, error: "unknown" }; },
    }, [initialize, { jsonrpc: "2.0", id: 2, method: "init" },
      { jsonrpc: "2.0", id: 3, method: "sendMessage", params: { id: "chatgpt::x", options: { message: "hello" } } },
      { jsonrpc: "2.0", id: 4, method: "shutdown" },
    ]);
    expect(sends).toBe(1);
    expect((replies[2].error as { data: Record<string, unknown> }).data.outcome).toBe("unknown");
    expect((replies[2].error as { data: Record<string, unknown> }).data.retryable).toBe(false);
  });

  it("treats legacy notSubmitted send failures as UNKNOWN unless typed pre-effect proof exists", async () => {
    const replies = await run({
      getAccountScope: () => scope,
      async init() {},
      async sendMessage() { return { ok: false, notSubmitted: true, nonRetryable: true, error: "local draft admit failed after click" }; },
    }, [initialize, { jsonrpc: "2.0", id: 2, method: "init" },
      { jsonrpc: "2.0", id: 3, method: "sendMessage", params: { id: "chatgpt::x", options: { message: "hello" } } },
      { jsonrpc: "2.0", id: 4, method: "shutdown" },
    ]);
    expect(replies[2].error).toBeDefined();
    expect((replies[2].error as { data: Record<string, unknown> }).data).toMatchObject({ outcome: "unknown", retryable: false });
  });

  it("rejects malformed frames without preventing later valid requests", async () => {
    const replies = await run({}, [null, [], initialize, { jsonrpc: "2.0", id: 2, method: "shutdown" }]);
    expect(replies.slice(0, 2).map(reply => (reply.error as { code: number }).code)).toEqual([-32600, -32600]);
    expect((replies[2].result as { harness: string }).harness).toBe("chatgpt");
  });
});
