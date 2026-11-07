import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { BrowserChatAdapter } from "../src/adapters/browser-chat.js";
import { makeConfiguredAdapter, serveBrowserChatAhap } from "../src/ahap-browser-runner.js";

const scope = "a".repeat(64);
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { harness: "chatgpt", ahapVersion: "0.1" } };
type TestAdapter = Partial<BrowserChatAdapter> & {
  type?: string;
  name?: string;
  browserFeatures?: unknown;
  getAccountScope?: () => string | undefined;
  verifyPinnedAccountScope?: () => Promise<void>;
  close?: () => void;
};

async function run(adapter: TestAdapter, requests: unknown[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  let data = "";
  output.setEncoding("utf8");
  output.on("data", chunk => { data += chunk; });
  const serving = serveBrowserChatAhap(adapter as Parameters<typeof serveBrowserChatAhap>[0], input, output, scope);
  input.end(requests.map(request => JSON.stringify(request)).join("\n") + "\n");
  await serving;
  return data.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
}

describe("ChatGPT AHAP browser runner", () => {
  it("explicitly selects MacMiniChromeTransport and verifies the configured page and account", async () => {
    const selected: string[] = [];
    const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
    const macMini = {
      async call(name: string, args: Record<string, unknown> = {}) {
        calls.push({ name, args });
        if (name === "list_pages") return "7: ChatGPT (https://chatgpt.com/c/abc)\n8: ChatGPT (https://chatgpt.com/c/def)";
        return `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify({ scope })}\n\`\`\``;
      },
    };
    const adapter = makeConfiguredAdapter({
      AHAP_HARNESS: "chatgpt",
      AHAP_CHATGPT_TRANSPORT: "mac-mini",
      AHAP_CHATGPT_PAGE_ID: "7",
      AHAP_CHATGPT_ACCOUNT_SCOPE: scope,
    }, {
      macMini() { selected.push("mac-mini"); return macMini; },
      directCdp() { selected.push("direct-cdp"); throw new Error("unexpected direct CDP selection"); },
    });
    await adapter.verifyPinnedAccountScope?.();
    expect(selected).toEqual(["mac-mini"]);
    expect(calls.map(call => call.name)).toEqual(["list_pages", "evaluate_script"]);
    expect(calls[1]?.args?.pageId).toBe(7);
  });

  it("fails closed instead of selecting another page when the configured page is absent", async () => {
    const calls: string[] = [];
    const adapter = makeConfiguredAdapter({
      AHAP_HARNESS: "chatgpt",
      AHAP_CHATGPT_TRANSPORT: "mac-mini",
      AHAP_CHATGPT_PAGE_ID: "7",
      AHAP_CHATGPT_ACCOUNT_SCOPE: scope,
    }, {
      macMini() {
        return { async call(name: string) {
          calls.push(name);
          return name === "list_pages" ? "8: ChatGPT (https://chatgpt.com/c/other)" : "";
        } };
      },
      directCdp() { throw new Error("unexpected direct CDP selection"); },
    });
    await expect(adapter.listSessions()).rejects.toThrow("Configured ChatGPT page unavailable");
    expect(calls).toEqual(["list_pages"]);
  });

  it("requires an explicit transport and does not infer direct CDP from its variables", () => {
    expect(() => makeConfiguredAdapter({
      AHAP_HARNESS: "chatgpt",
      AHAP_CHATGPT_CDP_WS_URL: "ws://unused",
      AHAP_CHATGPT_CDP_CONTEXT_ID: "unused",
      AHAP_CHATGPT_CDP_TARGET_ID: "unused",
      AHAP_CHATGPT_PAGE_ID: "7",
      AHAP_CHATGPT_ACCOUNT_SCOPE: scope,
    })).toThrow("AHAP_BROWSER_TRANSPORT must explicitly select");
    expect(() => makeConfiguredAdapter({ AHAP_HARNESS: "opencode" }))
      .toThrow("AHAP_HARNESS must explicitly select chatgpt or zai");
  });

  it("fails closed when Mac Mini transport lacks exact page or account scope", () => {
    expect(() => makeConfiguredAdapter({ AHAP_HARNESS: "chatgpt", AHAP_CHATGPT_TRANSPORT: "mac-mini", AHAP_CHATGPT_ACCOUNT_SCOPE: scope }))
      .toThrow(/exact page ID and account scope are required/i);
    expect(() => makeConfiguredAdapter({ AHAP_HARNESS: "chatgpt", AHAP_CHATGPT_TRANSPORT: "mac-mini", AHAP_CHATGPT_PAGE_ID: "7" }))
      .toThrow(/exact page ID and account scope are required/i);
  });

  it("selects raw direct CDP only when explicitly configured and verifies its exact page", async () => {
    const selected: unknown[] = [];
    const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
    const adapter = makeConfiguredAdapter({
      AHAP_HARNESS: "chatgpt",
      AHAP_CHATGPT_TRANSPORT: "direct-cdp",
      AHAP_CHATGPT_CDP_WS_URL: "ws://127.0.0.1:9222/devtools",
      AHAP_CHATGPT_CDP_CONTEXT_ID: "context-exact",
      AHAP_CHATGPT_CDP_TARGET_ID: "target-exact",
      AHAP_CHATGPT_PAGE_ID: "9",
      AHAP_CHATGPT_ACCOUNT_SCOPE: scope,
    }, {
      macMini() { throw new Error("unexpected Mac Mini selection"); },
      directCdp(config) {
        selected.push(config);
        return { async call(name, args = {}) {
          calls.push({ name, args });
          return name === "list_pages" ? "9: ChatGPT (https://chatgpt.com/c/abc)"
            : `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify({ scope })}\n\`\`\``;
        } };
      },
    });
    await adapter.verifyPinnedAccountScope?.();
    expect(selected).toEqual([{ endpoint: "ws://127.0.0.1:9222/devtools", contextId: "context-exact", targetId: "target-exact" }]);
    expect(calls.map(call => call.name)).toEqual(["list_pages", "evaluate_script"]);
    expect(calls[1]?.args?.pageId).toBe(9);
  });

  it("selects the existing Z.ai driver on the explicit Mac Mini transport and proves the pinned page/account", async () => {
    const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
    const adapter = makeConfiguredAdapter({
      AHAP_HARNESS: "zai", AHAP_BROWSER_TRANSPORT: "mac-mini",
      AHAP_BROWSER_PAGE_ID: "17", AHAP_BROWSER_ACCOUNT_SCOPE: scope,
    }, {
      macMini: () => ({ async call(name, args = {}) {
        calls.push({ name, args });
        return name === "list_pages" ? "17: Z.ai (https://chat.z.ai/c/abc)\n18: ChatGPT (https://chatgpt.com/)"
          : `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify({ scope, chats: [{ user_id: scope }] })}\n\`\`\``;
      } }),
      directCdp() { throw new Error("unexpected direct CDP selection"); },
    });
    expect(adapter.type).toBe("zai");
    expect(adapter.name).toBe("Z.ai browser");
    await adapter.verifyPinnedAccountScope?.();
    expect(calls.map(call => call.name)).toEqual(["list_pages", "evaluate_script"]);
    expect(calls[1]?.args?.pageId).toBe(17);
  });

  it("fails closed for Z.ai when exact page or current account proof is unavailable", async () => {
    const calls: string[] = [];
    const missingPage = makeConfiguredAdapter({
      AHAP_HARNESS: "zai", AHAP_BROWSER_TRANSPORT: "mac-mini",
      AHAP_BROWSER_PAGE_ID: "17", AHAP_BROWSER_ACCOUNT_SCOPE: scope,
    }, {
      macMini: () => ({ async call(name) { calls.push(name); return "18: Z.ai (https://chat.z.ai/)"; } }),
      directCdp() { throw new Error("unexpected direct CDP selection"); },
    });
    await expect(missingPage.verifyPinnedAccountScope?.()).rejects.toThrow("Configured Z.ai page unavailable");
    expect(calls).toEqual(["list_pages"]);

    const emptyAccount = makeConfiguredAdapter({
      AHAP_HARNESS: "zai", AHAP_BROWSER_TRANSPORT: "mac-mini",
      AHAP_BROWSER_PAGE_ID: "17", AHAP_BROWSER_ACCOUNT_SCOPE: scope,
    }, {
      macMini: () => ({ async call(name) {
        return name === "list_pages" ? "17: Z.ai (https://chat.z.ai/)"
          : "Script ran on page and returned:\n```json\n{\"chats\":[]}\n```";
      } }),
      directCdp() { throw new Error("unexpected direct CDP selection"); },
    });
    await expect(emptyAccount.verifyPinnedAccountScope?.()).rejects.toThrow(/account verification unavailable/);
  });

  it("advertises only its bounded surface and routes init and exact reads", async () => {
    const calls: string[] = [];
    let closed = false;
    const session = { id: "chatgpt::native%2Fid", harness: "chatgpt", name: "one", cwd: "/tmp", status: "idle" } as never;
    const adapter = {
      type: "chatgpt", name: "ChatGPT browser", browserFeatures: {},
      getAccountScope: () => scope,
      close() { closed = true; },
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
    expect(closed).toBe(true);
  });

  it("reports the selected Z.ai harness, provider name and factual browser features", async () => {
    const replies = await run({
      type: "zai", name: "Z.ai browser", browserFeatures: { nativeConversationIds: false, queueAfterGeneration: true, chatCreation: true, accountArchiveViaCdp: false, projects: true },
      getAccountScope: () => scope,
      async init() {},
    }, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { harness: "zai", ahapVersion: "0.1" } },
      { jsonrpc: "2.0", id: 2, method: "shutdown" },
    ]);
    expect(replies[0].result).toMatchObject({
      harness: "zai", name: "Z.ai browser",
      capabilities: { browserFeatures: { nativeConversationIds: false, queueAfterGeneration: true, projects: true } },
    });
  });

  it("requires the configured account scope before any operation", async () => {
    let called = false;
    const replies = await run({
      type: "chatgpt", name: "ChatGPT browser", browserFeatures: {},
      getAccountScope: () => "b".repeat(64),
      async init() { called = true; },
    }, [initialize, { jsonrpc: "2.0", id: 2, method: "init" }, { jsonrpc: "2.0", id: 3, method: "shutdown" }]);
    expect(called).toBe(true);
    expect(replies[1].error).toBeDefined();
  });

  it("does not return a read result if the adapter scope changes during the call", async () => {
    let currentScope = scope;
    const session = { id: "chatgpt::native%2Fid", harness: "chatgpt", name: "wrong account", cwd: "/tmp", status: "idle" } as never;
    const replies = await run({
      type: "chatgpt", name: "ChatGPT browser", browserFeatures: {},
      getAccountScope: () => currentScope,
      async init() {},
      async listSessions() { currentScope = "b".repeat(64); return [session]; },
    }, [initialize, { jsonrpc: "2.0", id: 2, method: "init" },
      { jsonrpc: "2.0", id: 3, method: "listSessions" },
      { jsonrpc: "2.0", id: 4, method: "shutdown" },
    ]);
    expect(replies[2].error).toBeDefined();
    expect(replies[2].result).toBeUndefined();
  });

  it("checks the current provider scope before consulting cached session inventory", async () => {
    let currentScope = scope;
    let listed = false;
    const replies = await run({
      type: "chatgpt", name: "ChatGPT browser", browserFeatures: {},
      getAccountScope: () => currentScope,
      async init() {},
      async verifyPinnedAccountScope() { currentScope = "b".repeat(64); },
      async listSessions() { listed = true; return []; },
    }, [initialize, { jsonrpc: "2.0", id: 2, method: "init" },
      { jsonrpc: "2.0", id: 3, method: "listSessions" },
      { jsonrpc: "2.0", id: 4, method: "shutdown" },
    ]);
    expect(replies[2].error).toBeDefined();
    expect(listed).toBe(false);
  });

  it("preserves an ambiguous send as UNKNOWN and never retries", async () => {
    let sends = 0;
    const replies = await run({
      type: "chatgpt", name: "ChatGPT browser", browserFeatures: {},
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
      type: "chatgpt", name: "ChatGPT browser", browserFeatures: {},
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
    const replies = await run({ type: "chatgpt", name: "ChatGPT browser", browserFeatures: {} }, [null, [], initialize, { jsonrpc: "2.0", id: 2, method: "shutdown" }]);
    expect(replies.slice(0, 2).map(reply => (reply.error as { code: number }).code)).toEqual([-32600, -32600]);
    expect((replies[2].result as { harness: string }).harness).toBe("chatgpt");
  });
});

for (const harness of ["chatgpt", "zai"]) {
  it(`${harness} advertises exactly queue delivery without a steer claim`, async () => {
    const replies = await run({ type: harness, name: harness, browserFeatures: {} }, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { harness, ahapVersion: "0.1" } },
      { jsonrpc: "2.0", id: 2, method: "shutdown" },
    ]);
    const result = replies[0].result as { capabilities: { deliveryModes: string[]; controlCapabilities: { steer: boolean } } };
    expect(result.capabilities.deliveryModes).toEqual(["queue"]);
    expect(result.capabilities.controlCapabilities.steer).toBe(false);
  });
}
