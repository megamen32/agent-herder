import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { makeConfiguredAdapter, serveBrowserChatAhap } from "../src/ahap-browser-runner.js";
import { VibeChromePageTools, type VibeChromePageToolsOptions } from "../src/adapters/vibe-chrome-transport.js";
import { readProtectedBrowserMcpToken } from "../src/adapters/browser-mcp-profile.js";
import { CHATGPT_MAC_SNAPSHOT } from "../src/adapters/chatgpt-mac-cdp-driver.js";
import { CHATGPT_CREATE_SCOPE_SCRIPT } from "../src/adapters/browser-chat-new-page.js";
import { CHATGPT_LIST_API_PASSIVE_SCRIPT } from "../src/adapters/browser-chat-api-scripts.js";

// These unit tests isolate the wire schema and ownership boundary. The real
// installed-Vibe async bridge is exercised by vibe-chrome-async-transport.test.ts.
vi.mock("../src/adapters/vibe-async-evaluation.js", () => ({
  evaluateVibeAsync: async (input: {
    functionDeclaration: string; args?: unknown[];
    evaluateOnce: (declaration: string, args?: unknown[]) => Promise<string>;
  }) => input.evaluateOnce(input.functionDeclaration, input.args),
}));

const scope = "a".repeat(64), otherScope = "b".repeat(64);
const id = "12345678-abcd-4abc-8def-123456789abc";
const createdId = 1115967601, foreignId = 1115967000;
const endpoint = "https://mcp.bezrabotnyi.com/server/vibemacminilocal/mcp";
let root: string;
const closers: Array<() => void | Promise<void>> = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ahap-vibe-"));
  process.env.AGENT_HERDER_BROWSER_CHAT_INVENTORY_ROOT = join(root, "inventory");
});
afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => Promise.resolve(close()).catch(() => undefined)));
  delete process.env.AGENT_HERDER_BROWSER_CHAT_INVENTORY_ROOT;
  await rm(root, { recursive: true, force: true });
});
const response = (text: string) => ({ content: [{ type: "text", text }] });
const evaluated = (result: unknown) => response(JSON.stringify({ success: true, result, type: "object" }));
async function fixture(options: { actualScope?: string; modal?: boolean; stripQuery?: boolean; createFails?: boolean } = {}) {
  const profileFile = join(root, "profile.json");
  await writeFile(profileFile, JSON.stringify({ authorization: "Bearer protected-fixture-token" }), { mode: 0o600 });
  let created = false, pageUrl = "https://chatgpt.com/", closed = false;
  const actualScope = options.actualScope ?? scope;
  const connect = vi.fn(async () => {});
  const close = vi.fn(async () => { closed = true; });
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const callTool = vi.fn(async (input: { name: string; arguments: Record<string, unknown> }) => {
    if (closed) throw new Error("closed");
    calls.push(input);
    if (input.name === "list_pages") return response([
      "Found " + (created ? 2 : 1) + " page(s):",
      'Page ' + foreignId + ': "A human tab" - https://chatgpt.com/c/other',
      ...(created ? ['Page ' + createdId + ': "Owned background tab" - ' + pageUrl] : []),
    ].join("\n"));
    if (input.name === "new_page") {
      if (options.createFails) throw new Error("Creation acknowledgement unknown");
      created = true;
      pageUrl = options.stripQuery ? "https://chatgpt.com/" : String(input.arguments.url);
      return response("Successfully created new background page (ID: " + createdId + "), navigated to " + pageUrl + " and page is ready");
    }
    const page = input.arguments.tabId ?? input.arguments.pageId;
    if (page !== createdId) throw new Error("A foreign page must never be probed or adopted");
    if (input.name === "evaluate_script") {
      const script = String(input.arguments.function);
      if (script === CHATGPT_CREATE_SCOPE_SCRIPT) return evaluated({ scope: actualScope });
      if (script === CHATGPT_MAC_SNAPSHOT) return evaluated({
        origin: "https://chatgpt.com", path: new URL(pageUrl).pathname, authenticated: true, composer: true,
        phase: "idle", draftPresent: false, chats: [{ id, title: "Existing task" }],
        ...(options.modal ? { modalPrompts: [{
          role: "dialog", title: "Continue working?", body: "Allow ChatGPT to continue working.",
          buttons: [{ label: "Continue", disabled: false }],
        }] } : {}),
      });
      if (script === CHATGPT_LIST_API_PASSIVE_SCRIPT) return evaluated({
        scope: actualScope, chats: [{ id, title: "Existing task" }], source: "passive",
      });
      if (script.includes("conversation_read")) return evaluated({ messages: [
        { id: "user-one", role: "user", text: "Please finish." },
        { id: "assistant-one", role: "assistant", text: "Done.", phase: "final", completionStatus: "finished_successfully", endTurn: true },
      ] });
      if (script.includes("cooldownUntil")) return evaluated({ cooldownUntil: 0 });
      if (script.includes("window.name")) return evaluated({ owned: true });
      throw new Error("Unexpected evaluation");
    }
    throw new Error("Unexpected browser action " + input.name);
  });
  let selected: VibeChromePageToolsOptions | undefined;
  const adapter = makeConfiguredAdapter({
    AHAP_HARNESS: "chatgpt", AHAP_BROWSER_TRANSPORT: "vibe-mcp",
    AHAP_BROWSER_ACCOUNT_SCOPE: scope, AHAP_BROWSER_MCP_URL: endpoint, AHAP_BROWSER_MCP_PROFILE_FILE: profileFile,
  }, {
    macMini: () => { throw new Error("Mac Mini route must not be selected"); },
    directCdp: () => { throw new Error("Direct CDP route must not be selected"); },
    vibeMcp: config => {
      selected = config;
      return new VibeChromePageTools({ ...config, clientFactory: () => ({ connect, callTool, close }), transportFactory: () => ({}) });
    },
  });
  closers.push(() => adapter.close?.());
  return { adapter, connect, close, calls, callTool, profileFile, selected: () => selected };
}

describe("Vibe ChatGPT AHAP owner wiring", () => {
  it.each([false, true])("creates exactly one background page for repeated AHAP reads, including stripped query=%s", async stripQuery => {
    const f = await fixture({ stripQuery });
    await f.adapter.verifyPinnedAccountScope?.();
    await f.adapter.init();
    await f.adapter.verifyPinnedAccountScope?.();
    const messages = await f.adapter.getSessionMessages("chatgpt::" + id);
    expect(messages?.at(-1)).toMatchObject({ text: "Done.", completionStatus: "finished_successfully", endTurn: true });
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.calls.filter(call => call.name === "new_page")).toHaveLength(1);
    expect(f.calls.filter(call => call.name !== "new_page" && call.name !== "list_pages")
      .every(call => (call.arguments.tabId ?? call.arguments.pageId) === createdId)).toBe(true);
    expect(f.selected()).toMatchObject({ url: endpoint, ownedPagesOnly: true });
    expect(await f.selected()!.tokenProvider()).toBe("protected-fixture-token");
    await f.adapter.close?.();
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to an existing user tab after unknown new-page creation", async () => {
    const f = await fixture({ createFails: true });
    await expect(f.adapter.verifyPinnedAccountScope?.()).rejects.toThrow();
    expect(f.calls.filter(call => call.name === "new_page")).toHaveLength(1);
    expect(f.calls.some(call => call.name === "evaluate_script" || call.name === "fill" || call.name === "navigate_page")).toBe(false);
  });

  it("refuses a mismatched account in the owned new page without reading conversation content or sending", async () => {
    const f = await fixture({ actualScope: otherScope });
    await expect(f.adapter.verifyPinnedAccountScope?.()).rejects.toThrow("account scope mismatch");
    expect(f.calls.some(call => String(call.arguments.function).includes("conversation_read"))).toBe(false);
    expect(f.calls.some(call => call.name === "fill" || call.name === "navigate_page")).toBe(false);
  });

  it("keeps a native modal blocked and never answers consent during reads", async () => {
    const f = await fixture({ modal: true });
    await f.adapter.verifyPinnedAccountScope?.();
    await f.adapter.init();
    const sessions = await f.adapter.listSessions();
    expect(sessions.find(session => session.id === "chatgpt::" + id)?.status).toBe("running");
    expect(f.calls.some(call => String(call.arguments.function).includes(".click("))).toBe(false);
    expect(f.calls.some(call => call.name === "fill" || call.name === "navigate_page")).toBe(false);
  });

  it("rejects old page/CDP hints and non-protected endpoint configuration on the Vibe route", () => {
    const env = {
      AHAP_HARNESS: "chatgpt", AHAP_BROWSER_TRANSPORT: "vibe-mcp", AHAP_BROWSER_ACCOUNT_SCOPE: scope,
      AHAP_BROWSER_MCP_URL: endpoint, AHAP_BROWSER_MCP_PROFILE_FILE: "/private/profile.json",
    };
    expect(() => makeConfiguredAdapter({ ...env, AHAP_BROWSER_PAGE_ID: String(foreignId) })).toThrow("only pages created");
    expect(() => makeConfiguredAdapter({ ...env, AHAP_BROWSER_MCP_PROFILE_FILE: "relative.json" })).toThrow("absolute protected");
    expect(() => makeConfiguredAdapter({ ...env, AHAP_BROWSER_MCP_URL: "https://other.example/mcp" })).toThrow("endpoint_invalid");
  });

  it("fails closed on public or symlink credential files without printing their contents", async () => {
    const path = join(root, "credential.json");
    await writeFile(path, JSON.stringify({ authorization: "Bearer secret-fixture-value" }), { mode: 0o600 });
    await chmod(path, 0o644);
    await expect(readProtectedBrowserMcpToken(path)).rejects.toThrow("browser_mcp_protected_profile_unavailable");
    await chmod(path, 0o600);
    const link = join(root, "linked-credential.json"); await symlink(path, link);
    await expect(readProtectedBrowserMcpToken(link)).rejects.toThrow("browser_mcp_protected_profile_unavailable");
    await writeFile(path, JSON.stringify({ authorization: "Bearer secret-fixture-value\nbad" }), { mode: 0o600 });
    await expect(readProtectedBrowserMcpToken(path)).rejects.toThrow("browser_mcp_authorization_unavailable");
  });

  it("awaits pending RPCs before closing the persistent transport on input EOF", async () => {
    const input = new PassThrough(), output = new PassThrough();
    const events: string[] = [];
    let completeRead!: () => void;
    let readStarted!: () => void;
    const started = new Promise<void>(resolve => { readStarted = resolve; });
    const adapter = {
      type: "chatgpt", name: "fixture", browserFeatures: {},
      getAccountScope: () => scope, init: async () => {},
      getSessionMessages: async () => {
        events.push("read-start"); readStarted();
        await new Promise<void>(resolve => { completeRead = resolve; });
        events.push("read-finished"); return [];
      },
      close: async () => { await Promise.resolve(); events.push("closed"); },
    };
    const running = serveBrowserChatAhap(adapter as Parameters<typeof serveBrowserChatAhap>[0], input, output, scope);
    input.end([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { harness: "chatgpt", ahapVersion: "0.1" } },
      { jsonrpc: "2.0", id: 2, method: "init" },
      { jsonrpc: "2.0", id: 3, method: "getSessionMessages", params: { id: "session-one" } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    await started;
    expect(events).toEqual(["read-start"]);
    completeRead(); await running;
    expect(events).toEqual(["read-start", "read-finished", "closed"]);
  });
});
