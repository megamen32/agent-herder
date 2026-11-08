import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { BrowserChatAdapter } from "../src/adapters/browser-chat.js";
import { makeConfiguredAdapter, serveBrowserChatAhap } from "../src/ahap-browser-runner.js";
import { AhapReadError } from "../src/ahap-legacy-read.js";

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
        if (name === "list_pages") return "7: ChatGPT (https://chatgpt.com/c/11111111-1111-4111-8111-111111111111)\n8: ChatGPT (https://chatgpt.com/c/22222222-2222-4222-8222-222222222222)";
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
    expect(calls[0]?.name).toBe("list_pages");
    expect(calls.some(call => call.name === "evaluate_script")).toBe(true);
    expect(calls[1]?.args?.pageId).toBe(7);
  });

  it("treats the configured page number as a hint and never fails on a missing number", async () => {
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
    await expect(adapter.listSessions()).rejects.toThrow();
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

  it("fails closed when the Mac Mini transport lacks the exact account scope", () => {
    expect(() => makeConfiguredAdapter({ AHAP_HARNESS: "chatgpt", AHAP_CHATGPT_TRANSPORT: "mac-mini" }))
      .toThrow(/exact account scope is required/i);
    expect(() => makeConfiguredAdapter({ AHAP_HARNESS: "chatgpt", AHAP_CHATGPT_TRANSPORT: "mac-mini", AHAP_CHATGPT_PAGE_ID: "7" }))
      .toThrow(/exact account scope is required/i);
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
          return name === "list_pages" ? "9: ChatGPT (https://chatgpt.com/c/11111111-1111-4111-8111-111111111111)"
            : `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify({ scope })}\n\`\`\``;
        } };
      },
    });
    await adapter.verifyPinnedAccountScope?.();
    expect(selected).toEqual([{ endpoint: "ws://127.0.0.1:9222/devtools", contextId: "context-exact", targetId: "target-exact", accountScope: scope }]);
    expect(calls[0]?.name).toBe("list_pages");
    expect(calls.some(call => call.name === "evaluate_script")).toBe(true);
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
    expect(calls.map(call => call.name)).toEqual(["list_pages", "evaluate_script", "evaluate_script"]);
    expect(calls[2]?.args?.pageId).toBe(17);
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
    // A missing page number is not a failure any more: the driver owns one
    // tab per provider and finds it by its own marker.
    await expect(missingPage.verifyPinnedAccountScope?.()).rejects.toThrow();

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
    let verifiedOnce = false;
    const replies = await run({
      type: "chatgpt", name: "ChatGPT browser", browserFeatures: {},
      getAccountScope: () => currentScope,
      async init() {},
      async verifyPinnedAccountScope() { if (verifiedOnce) currentScope = "b".repeat(64); verifiedOnce = true; },
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

for (const harness of ["chatgpt", "zai"] as const) {
  for (const matches of [true, false]) {
    it(`${harness} verifies an unpopulated fresh-profile scope before passive init (matches=${matches})`, async () => {
      let currentScope: string | undefined;
      const calls: string[] = [];
      let sends = 0;
      const requests = [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { harness, ahapVersion: "0.1" } },
        { jsonrpc: "2.0", id: 2, method: "init" },
        ...(!matches ? [{ jsonrpc: "2.0", id: 3, method: "sendMessage", params: { id: "fixture-chat", options: { message: "must not send", queue: true, inputId: "blocked" } } }] : []),
        { jsonrpc: "2.0", id: 4, method: "shutdown" },
      ];
      const replies = await run({
        type: harness, name: harness, browserFeatures: {},
        getAccountScope: () => currentScope,
        async init() { calls.push("passive-init"); },
        async verifyPinnedAccountScope() {
          calls.push("verify");
          currentScope = matches ? scope : "b".repeat(64);
        },
        async sendMessage() { sends++; return { ok: true }; },
      }, requests);
      expect(calls).toEqual(["verify", "passive-init"]);
      if (matches) {
        expect(replies[1].error).toBeUndefined();
        expect(replies[1].result).toBeNull();
      } else {
        expect(replies[1].error).toBeDefined();
        expect(replies[2].error).toBeDefined();
      }
      expect(sends).toBe(0);
    });
  }
}

it("configured Z.ai verifier exposes its verified scope with an empty driver cache and fails closed on mismatch", async () => {
  let observedScope = scope;
  const adapter = makeConfiguredAdapter({
    AHAP_HARNESS: "zai", AHAP_BROWSER_TRANSPORT: "mac-mini",
    AHAP_BROWSER_PAGE_ID: "7", AHAP_BROWSER_ACCOUNT_SCOPE: scope,
  }, {
    macMini: () => ({ async call(name: string) {
      if (name === "list_pages") return "7: Z.ai (https://chat.z.ai/)";
      if (name === "evaluate_script") return `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify({ scope: observedScope })}\n\`\`\``;
      throw new Error("Unexpected fixture transport call");
    } }),
    directCdp: () => { throw new Error("Unexpected direct transport"); },
  });
  expect(adapter.getAccountScope()).toBeUndefined();
  await adapter.verifyPinnedAccountScope?.();
  expect(adapter.getAccountScope()).toBe(scope);
  observedScope = "b".repeat(64);
  await expect(adapter.verifyPinnedAccountScope?.()).rejects.toThrow("scope mismatch");
  expect(adapter.getAccountScope()).toBeUndefined();
});

for (const [stage, message, reason] of [
  ["adapter_init", "Mac mini Chrome gateway returned no JSON", "transport_no_json"],
  ["verify_pinned_account", "Pinned ChatGPT page unavailable; no read data returned", "pinned_page_unavailable"],
  ["verify_pinned_account", "ChatGPT pinned account scope mismatch; no read data returned", "account_scope_mismatch"],
  ["account_match", "", "account_scope_mismatch"],
  ["adapter_init", "PRIVATE token=secret https://private.example/account", "unknown"],
  ["verify_pinned_account", "Pinned ChatGPT page unavailable; no read data returned PRIVATE", "unknown"],
] as const) {
  it(`FIXBI reports safe init stage ${stage}/${reason} without exception text`, async () => {
    let sends = 0;
    const replies = await run({
      type: "chatgpt", name: "fixture", browserFeatures: {},
      async init() { if (stage === "adapter_init") throw new Error(message); },
      async verifyPinnedAccountScope() { if (stage === "verify_pinned_account") throw new Error(message); },
      getAccountScope: () => "b".repeat(64),
      async sendMessage() { sends++; return { ok: true }; },
    }, [initialize, { jsonrpc: "2.0", id: 2, method: "init" },
      { jsonrpc: "2.0", id: 3, method: "sendMessage", params: { id: "fixture", options: { message: "blocked", queue: true } } }]);
    expect(replies[1].error).toMatchObject({ code: -32000, data: { outcome: "read_failed", method: "init", stage, reason } });
    expect(replies[2].error).toBeDefined();
    expect(sends).toBe(0);
    const output = JSON.stringify(replies);
    for (const secret of ["PRIVATE", "token=secret", "https://", "b".repeat(64)]) expect(output).not.toContain(secret);
    if (message) expect(output).not.toContain(message);
  });
}

it("FIXBI verifies before passive init that depends on the verified account", async () => {
  let currentScope: string | undefined;
  const calls: string[] = [];
  const replies = await run({
    type: "chatgpt", name: "fixture", browserFeatures: {},
    getAccountScope: () => currentScope,
    async verifyPinnedAccountScope() { calls.push("verify"); currentScope = scope; },
    async init() { calls.push("passive-init"); if (currentScope !== scope) throw new Error("ChatGPT pinned account scope mismatch; no read data returned"); },
  }, [initialize, { jsonrpc: "2.0", id: 2, method: "init" }]);
  expect(replies[1].error).toBeUndefined();
  expect(replies[1].result).toBeNull();
  expect(calls).toEqual(["verify", "passive-init"]);
});

it("FIXBI verifier mismatch prevents passive reads and send", async () => {
  let reads = 0, sends = 0;
  const replies = await run({
    type: "chatgpt", name: "fixture", browserFeatures: {},
    getAccountScope: () => undefined,
    async verifyPinnedAccountScope() { throw new Error("ChatGPT pinned account scope mismatch; no read data returned"); },
    async init() { reads++; },
    async sendMessage() { sends++; return { ok: true }; },
  }, [initialize, { jsonrpc: "2.0", id: 2, method: "init" },
    { jsonrpc: "2.0", id: 3, method: "sendMessage", params: { id: "fixture", options: { message: "blocked", queue: true } } }]);
  expect(replies[1].error).toMatchObject({ data: { stage: "verify_pinned_account", reason: "account_scope_mismatch" } });
  expect(reads).toBe(0);
  expect(sends).toBe(0);
});

it("advertises and routes archive only when the browser driver implements it", async () => {
  const ids:string[]=[];
  const adapter={type:"chatgpt",name:"ChatGPT",init:async()=>{},getAccountScope:()=>scope,
    archiveSession:async(id:string)=>{ids.push(id);return {ok:true,sessionId:id}},supportsArchive:()=>true};
  const result=await run(adapter,[initialize,{jsonrpc:"2.0",id:2,method:"init"},{jsonrpc:"2.0",id:3,method:"archiveSession",params:{id:"chatgpt::native"}}]);
  expect((result[0]!.result as any).capabilities.methods).toContain("archiveSession");
  expect(result[2]!.result).toEqual({ok:true,sessionId:"chatgpt::native"});expect(ids).toEqual(["chatgpt::native"]);
  const unsupported=await run({...adapter,supportsArchive:()=>false},[initialize,{jsonrpc:"2.0",id:4,method:"archiveSession",params:{id:"chatgpt::native"}}]);
  expect((unsupported[0]!.result as any).capabilities.methods).not.toContain("archiveSession");expect(unsupported[1]!.error).toMatchObject({code:-32601});expect(ids.length).toBe(1);
});

describe("bounded send failure diagnostics", () => {
  const send = { jsonrpc: "2.0", id: 3, method: "sendMessage", params: {
    id: "chatgpt::PRIVATE_SESSION", options: { message: "PRIVATE_PROMPT", queue: true },
  } };
  const known = [
    ["ChatGPT submission rejected before click: draft_changed", "preclick", "draft_changed"],
    ["ZAI submission blocked before click: send_not_ready", "preclick", "send_not_ready"],
    ["ChatGPT first message not submitted: draft_changed", "preclick", "draft_changed"],
    ["pinned browser account scope mismatch", "account_check", "account_scope_mismatch"],
    ["ChatGPT pinned account scope mismatch; no read data returned", "account_check", "account_scope_mismatch"],
    ["Mac mini Chrome operation timeout; do not replay an uncertain write", "transport", "transport_timeout"],
    ["direct_cdp_timeout:Runtime.evaluate; operation outcome may be unknown; do not retry", "transport", "transport_timeout"],
    ["ZAI submission admission unknown: do not retry automatically", "native_admission", "native_admission_unknown"],
    ["Message submitted but unique native message receipt unavailable; read history before any retry", "native_admission", "native_admission_unknown"],
    ["ChatGPT history unavailable: read_cooldown", "readback", "read_failed"],
    ["Z.ai history unavailable: history_http_429", "readback", "read_failed"],
  ] as const;
  it("sanitizes typed errors on the send path without changing their code", async () => {
    const replies = await run({
      type: "chatgpt", name: "fixture", browserFeatures: {},
      getAccountScope: () => scope, async init() {},
      async sendMessage() { throw new AhapReadError(-32001, "PRIVATE_TOKEN=sk-private PRIVATE_PROMPT"); },
    }, [initialize, { jsonrpc: "2.0", id: 2, method: "init" }, send]);
    expect(replies[2].error).toMatchObject({ code: -32001, data: {
      outcome: "unknown", retryable: false, stage: "send", reason: "unknown",
    } });
    expect(JSON.stringify(replies[2])).not.toContain("PRIVATE");
  });
  for (const mode of ["return", "throw"] as const) {
    for (const [message, stage, reason] of known) {
      it(`${mode} maps only the known send failure ${stage}/${reason}`, async () => {
        let sends = 0;
        const replies = await run({
          type: "chatgpt", name: "fixture", browserFeatures: {},
          getAccountScope: () => scope, async init() {},
          async sendMessage() {
            sends++;
            if (mode === "throw") throw new Error(message);
            return { ok: false, error: message, notSubmitted: true };
          },
        }, [initialize, { jsonrpc: "2.0", id: 2, method: "init" }, send]);
        expect(replies[2].error).toMatchObject({ code: -32000, data: {
          method: "sendMessage", outcome: "unknown", retryable: false, stage, reason,
        } });
        expect(sends).toBe(1);
        const output = JSON.stringify(replies[2]);
        for (const secret of [message, "PRIVATE_PROMPT", "PRIVATE_SESSION", scope]) expect(output).not.toContain(secret);
        expect(output.length).toBeLessThan(1000);
        expect(output).not.toContain('"effect":"none"');
      });
    }
    for (const message of [
      "ChatGPT submission rejected before click: draft_changed PRIVATE_TOKEN=sk-private",
      "direct_cdp_timeout:Runtime.evaluate PRIVATE_TOKEN; operation outcome may be unknown; do not retry",
      "ChatGPT history unavailable: PRIVATE_TOKEN https://private.example/account",
      "pinned browser account scope mismatch " + scope,
      "PRIVATE_PROMPT " + "secret".repeat(10000),
    ]) {
      it(`${mode} never copies raw send errors or classifies arbitrary suffixes`, async () => {
        const replies = await run({
          type: "chatgpt", name: "fixture", browserFeatures: {},
          getAccountScope: () => scope, async init() {},
          async sendMessage() {
            if (mode === "throw") throw new Error(message);
            return { ok: false, error: message, notSubmitted: true };
          },
        }, [initialize, { jsonrpc: "2.0", id: 2, method: "init" }, send]);
        expect(replies[2].error).toMatchObject({ data: {
          outcome: "unknown", retryable: false, stage: "send", reason: "unknown",
        } });
        const output = JSON.stringify(replies[2]);
        for (const secret of [message, "PRIVATE", "sk-private", "https://", scope, "secret"])
          expect(output).not.toContain(secret);
        expect(output.length).toBeLessThan(1000);
      });
    }
  }
  it("reports the pre-dispatch account guard without calling send", async () => {
    let sends = 0;
    let current = scope;
    const replies = await run({
      type: "chatgpt", name: "fixture", browserFeatures: {},
      getAccountScope: () => current,
      async init() {},
      async getSession() { current = "b".repeat(64); return null; },
      async sendMessage() { sends++; return { ok: true }; },
    }, [initialize, { jsonrpc: "2.0", id: 2, method: "init" },
      { jsonrpc: "2.0", id: 4, method: "getSession", params: { id: "chatgpt::x" } }, send]);
    expect(replies[3].error).toMatchObject({ data: {
      outcome: "unknown", retryable: false, stage: "account_check", reason: "account_scope_mismatch",
    } });
    expect(sends).toBe(0);
  });
});
