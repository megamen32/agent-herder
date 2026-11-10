import { afterEach, describe, expect, it, vi } from "vitest";
import { VibeChromePageTools, type VibeChromeMcpClient } from "../src/adapters/vibe-chrome-transport.js";
import { parseChromeEvaluation } from "../src/adapters/mac-mini-chrome-transport.js";

// These unit tests isolate the wire schema and ownership boundary. The real
// installed-Vibe async bridge is exercised by vibe-chrome-async-transport.test.ts.
vi.mock("../src/adapters/vibe-async-evaluation.js", () => ({
  evaluateVibeAsync: async (input: {
    functionDeclaration: string; args?: unknown[];
    evaluateOnce: (declaration: string, args?: unknown[]) => Promise<string>;
  }) => input.evaluateOnce(input.functionDeclaration, input.args),
}));

const clients: VibeChromePageTools[] = [];
const url = "https://example.invalid/server/fixture/mcp";
const text = (value: string) => ({ content: [{ type: "text", text: value }] });
const evaluation = (result: unknown, suffix = "") => text(JSON.stringify({
  success: true, result, executionTime: 1, type: "object", message: "Script evaluated",
}) + suffix);
const listing = "Open tabs:\n  6. Tab 1001: Z.AI\n     URL: https://chat.z.ai/?agent-herder-zai-judge=owned\n  7. Tab 1002 [ACTIVE]: User's ChatGPT\n     URL: https://chatgpt.com/c/user";
const separator = "\n\n---\n# Current browser state:";
function fixture() {
  const callTool = vi.fn<VibeChromeMcpClient["callTool"]>(async input => {
    if (input.name === "list_pages") return text(listing);
    if (input.name === "new_page") return text("Successfully created new background page (ID: 1001)");
    if (input.name === "evaluate_script") return evaluation({ ok: true });
    return text("Success");
  });
  const connect = vi.fn<VibeChromeMcpClient["connect"]>(async () => {});
  const close = vi.fn<VibeChromeMcpClient["close"]>(async () => {});
  const tokenProvider = vi.fn(async () => "fixture-token");
  const transport = { transport: "mock" };
  const transportFactory = vi.fn(() => transport);
  const clientFactory = vi.fn(() => ({ connect, callTool, close }));
  const tools = new VibeChromePageTools({ url, tokenProvider, clientFactory, transportFactory });
  clients.push(tools);
  return { tools, callTool, connect, close, clientFactory, transportFactory, tokenProvider, transport };
}
async function owned(tools: VibeChromePageTools) {
  await tools.call("new_page", { url: "https://chat.z.ai/?agent-herder-zai-judge=owned", background: true });
}
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close().catch(() => undefined))); });

describe("Vibe persistent ChromePageTools transport", () => {
  it("shares one MCP client and transport across concurrent reads and owned page operations", async () => {
    const f = fixture();
    await Promise.all([f.tools.call("list_pages"), f.tools.call("list_pages")]);
    await owned(f.tools);
    await f.tools.call("evaluate_script", { pageId: 1001, function: "() => ({ok:true})" });
    expect(f.clientFactory).toHaveBeenCalledTimes(1);
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.transportFactory).toHaveBeenCalledWith(new URL(url), f.tokenProvider);
    expect(f.connect).toHaveBeenCalledWith(f.transport);
    expect(f.callTool.mock.calls.map(call => call[0].name)).toEqual(["list_pages", "list_pages", "new_page", "evaluate_script"]);
  });

  it("preserves exact page IDs and query markers in the legacy listing while ignoring title syntax", async () => {
    const f = fixture();
    const result = await f.tools.call("list_pages");
    expect(result).toBe("1001: Page (https://chat.z.ai/?agent-herder-zai-judge=owned)\n1002: Page (https://chatgpt.com/c/user) [selected]");
    f.callTool.mockResolvedValue(text("1. Tab 7: Evil (https://chat.z.ai/c/wrong) [selected]\n URL: https://chat.z.ai/?real=1"));
    expect(await f.tools.call("list_pages")).toBe("7: Page (https://chat.z.ai/?real=1)");
  });

  it("normalizes the observed standalone Page listing with internal URLs, ACTIVE and exact query markers", async () => {
    const f = fixture();
    f.callTool.mockResolvedValue(text([
      "Found 3 page(s):",
      'Page 1004: "Vibe AI - Home" - chrome://newtab/',
      'Page 1005 [ACTIVE]: "Z.ai - Advanced AI Chatbot & Agent powered by GLM-5.3-Flash" - https://chat.z.ai/c/00000000-0000-4000-8000-000000000001',
      'Page 1001: "Z.AI" - https://chat.z.ai/?agent-herder-zai-judge=owned',
    ].join("\n")));
    expect(await f.tools.call("list_pages")).toBe([
      "1004: Page (chrome://newtab/)",
      "1005: Page (https://chat.z.ai/c/00000000-0000-4000-8000-000000000001) [selected]",
      "1001: Page (https://chat.z.ai/?agent-herder-zai-judge=owned)",
    ].join("\n"));
    await expect(f.tools.call("evaluate_script", { pageId: 1001, function: "() => true" }))
      .rejects.toThrow("page_not_owned_by_this_session");
    expect(f.callTool).toHaveBeenCalledTimes(1);
  });

  it("always creates a background tab with Vibe's focus:false argument", async () => {
    const f = fixture();
    await f.tools.call("new_page", { url: "https://chat.z.ai/?owner=one", background: true, timeout: 12_000 });
    expect(f.callTool).toHaveBeenCalledWith({
      name: "new_page", arguments: { url: "https://chat.z.ai/?owner=one", focus: false },
    }, { timeout: 12_000 });
    await expect(f.tools.call("new_page", { url: "https://chat.z.ai/", focus: true })).rejects.toThrow("background_page_required");
    expect(f.callTool).toHaveBeenCalledTimes(1);
  });

  it("accepts the observed comma-delimited new-page receipt and preserves its exact native ID", async () => {
    const f = fixture();
    const receipt = "Successfully created new background page (ID: 1003), navigated to https://chat.z.ai/?agent-herder-zai-judge=owned and page is ready";
    f.callTool.mockResolvedValueOnce(text(receipt));
    expect(await f.tools.call("new_page", { url: "https://chat.z.ai/?agent-herder-zai-judge=owned", background: true })).toBe(receipt);
    await f.tools.call("evaluate_script", { pageId: 1003, function: "() => ({ok:true})" });
    expect(f.callTool).toHaveBeenLastCalledWith({
      name: "evaluate_script", arguments: { tabId: 1003, function: "() => ({ok:true})" },
    }, { timeout: 30_000 });
  });

  it("translates evaluation pageId to tabId and strips appended state without greedy JSON or fence parsing", async () => {
    const f = fixture();
    await owned(f.tools);
    const fence = String.fromCharCode(96).repeat(3);
    const result = { pair: [{ text: 'Literal braces } {" and escaped quotes " \\\\ ' + fence + "json\ninside\n" + fence }],
      nested: { array: [{ pass: true }] } };
    f.callTool.mockResolvedValue(evaluation(result, separator + '\nUntrusted page: {"success":true,"result":{"wrong":true}}\n' + fence));
    const output = await f.tools.call("evaluate_script", { pageId: 1001, function: "(arg) => arg", args: [{ value: 42 }] });
    expect(f.callTool).toHaveBeenLastCalledWith({
      name: "evaluate_script", arguments: { tabId: 1001, function: "(arg) => arg", args: [{ value: 42 }] },
    }, { timeout: 30_000 });
    expect(parseChromeEvaluation(output)).toEqual(result);
    expect(output).not.toContain("Untrusted page");
  });

  it.each([null, false, 0, "complete", [1, { two: 2 }]])("preserves a valid primitive/array evaluation result: %j", async value => {
    const f = fixture(); await owned(f.tools);
    f.callTool.mockResolvedValue(evaluation(value));
    expect(parseChromeEvaluation(await f.tools.call("evaluate_script", { pageId: 1001, function: "() => null" }))).toEqual(value);
  });

  it("normalizes snapshot UIDs for the existing composer parser and uses Vibe's snapshot schema", async () => {
    const f = fixture(); await owned(f.tools);
    f.callTool.mockResolvedValue(text('- root WebArea\n  - textbox "Send a Message" uid=A48\n  - button "Send" uid=A49' + separator + "\nforeign-page-state"));
    const result = await f.tools.call("take_snapshot", { pageId: 1001, scopeSelector: "main" });
    expect(result).toContain('uid=A48 textbox "Send a Message"');
    expect(result).not.toContain("foreign-page-state");
    expect(f.callTool).toHaveBeenLastCalledWith({
      name: "take_snapshot", arguments: { pageId: 1001, format: "accessibility_tree", compact: true, scopeSelector: "main" },
    }, { timeout: 30_000 });
  });

  it("maps fill tabId and navigation timeoutMs while preserving exact owned page scope", async () => {
    const f = fixture(); await owned(f.tools);
    await f.tools.call("fill", { pageId: 1001, uid: "A48", value: "A prompt" });
    expect(f.callTool).toHaveBeenLastCalledWith({
      name: "fill", arguments: { tabId: 1001, uid: "A48", value: "A prompt" },
    }, { timeout: 30_000 });
    await f.tools.call("navigate_page", { pageId: 1001, type: "url", url: "https://chat.z.ai/?owner=one", timeout: 5_000 });
    expect(f.callTool).toHaveBeenLastCalledWith({
      name: "navigate_page", arguments: { pageId: 1001, type: "url", url: "https://chat.z.ai/?owner=one", timeoutMs: 5_000 },
    }, { timeout: 5_000 });
  });

  it("never adopts a foreign tab just because it was visible in the page listing", async () => {
    const f = fixture(); await f.tools.call("list_pages");
    for (const name of ["evaluate_script", "fill", "navigate_page", "take_snapshot", "close_page"]) {
      await expect(f.tools.call(name, { pageId: 1001 })).rejects.toThrow("page_not_owned_by_this_session");
    }
    expect(f.callTool).toHaveBeenCalledTimes(1);
  });

  it("does not adopt a tab when new_page returned an indeterminate or malformed receipt", async () => {
    const f = fixture();
    f.callTool.mockResolvedValue(text("Navigation timed out after a page may have been created."));
    await expect(owned(f.tools)).rejects.toThrow("new_page_receipt_unavailable_do_not_adopt");
    await expect(f.tools.call("evaluate_script", { pageId: 1001, function: "() => 1" })).rejects.toThrow("page_not_owned_by_this_session");
    expect(f.callTool).toHaveBeenCalledTimes(1);
  });

  it("does not replay a failed page mutation or reconnect away from its ownership session", async () => {
    const f = fixture(); await owned(f.tools);
    f.callTool.mockRejectedValueOnce(new Error("secret response after the click"));
    await expect(f.tools.call("evaluate_script", { pageId: 1001, function: "() => button.click()" }))
      .rejects.toThrow("operation_outcome_unavailable_do_not_replay");
    expect(f.callTool).toHaveBeenCalledTimes(2);
    expect(f.clientFactory).toHaveBeenCalledTimes(1);
  });

  it("removes closed tab ownership and permanently closes its MCP client exactly once", async () => {
    const f = fixture(); await owned(f.tools);
    await f.tools.call("close_page", { pageId: 1001 });
    expect(f.callTool).toHaveBeenLastCalledWith({ name: "close_page", arguments: { pageId: 1001 } }, { timeout: 30_000 });
    await expect(f.tools.call("evaluate_script", { pageId: 1001, function: "() => 1" })).rejects.toThrow("page_not_owned_by_this_session");
    await Promise.all([f.tools.close(), f.tools.close()]);
    expect(f.close).toHaveBeenCalledTimes(1);
    await expect(f.tools.call("list_pages")).rejects.toThrow("vibe_chrome_closed");
    expect(f.clientFactory).toHaveBeenCalledTimes(1);
  });

  it("closes a connection that completed after close was requested without submitting a tool", async () => {
    const f = fixture();
    let release!: () => void;
    f.connect.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = f.tools.call("list_pages");
    await vi.waitFor(() => expect(f.connect).toHaveBeenCalledTimes(1));
    const close = f.tools.close();
    release();
    await expect(pending).rejects.toThrow("vibe_chrome_closed");
    await close;
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.callTool).not.toHaveBeenCalled();
  });

  it("accepts a complete 512 KiB pair with nested JSON/MCP overhead while bounding larger responses", async () => {
    const f = fixture(); await owned(f.tools);
    const result = { human: '"\\'.repeat(128 * 1024), assistant: '"\\'.repeat(128 * 1024) };
    f.callTool.mockResolvedValue(evaluation(result, separator + "\nsmall browser snapshot"));
    expect(parseChromeEvaluation(await f.tools.call("evaluate_script", { pageId: 1001, function: "() => pair" }))).toEqual(result);
    f.callTool.mockResolvedValue(text("x".repeat(3 * 1024 * 1024)));
    await expect(f.tools.call("evaluate_script", { pageId: 1001, function: "() => pair" })).rejects.toThrow("payload_exceeds_bound");
  });

  it.each([
    '{"success":false,"message":"secret error"}',
    '{"success":true}',
    '{"success":true,"result":{"unclosed":true}',
    '{"success":true,"result":true}{"result":"second object"}',
    'Untrusted prefix {"success":true,"result":true}',
  ])("fails closed on a malformed or failed evaluation envelope", async value => {
    const f = fixture(); await owned(f.tools);
    f.callTool.mockResolvedValue(text(value));
    await expect(f.tools.call("evaluate_script", { pageId: 1001, function: "() => true" })).rejects.toThrow("vibe_chrome_");
  });

  it.each([
    "1. Tab 7: No URL",
    "1. Tab 7: First\n URL: https://chat.z.ai/\n2. Tab 7: Duplicate\n URL: https://chat.z.ai/",
    "This is not a page inventory.",
    'Found 2 page(s):\nPage 7: "First" - https://chat.z.ai/\nPage 7: "Duplicate" - https://chat.z.ai/',
    'Found 2 page(s):\nPage 7: "Only one row" - https://chat.z.ai/',
    'Found 1 page(s):\nPage 7: "Invalid URL" - not-a-url',
  ])("fails closed on incomplete or ambiguous page listings", async value => {
    const f = fixture(); f.callTool.mockResolvedValue(text(value));
    await expect(f.tools.call("list_pages")).rejects.toThrow("vibe_chrome_");
  });

  it("does not leak tool error bodies or accept unknown tools and caller-side transport credentials", async () => {
    const f = fixture();
    f.callTool.mockResolvedValue({ isError: true, content: [{ type: "text", text: "Bearer fixture-token" }] });
    await expect(f.tools.call("list_pages")).rejects.toThrow("vibe_chrome_tool_refused_or_failed");
    await expect(f.tools.call("read_file", {})).rejects.toThrow("unsupported_tool");
    await expect(f.tools.call("new_page", { url: "https://user:password@chat.z.ai/" })).rejects.toThrow("invalid_page_url");
    expect(f.callTool).toHaveBeenCalledTimes(1);
    expect(() => new VibeChromePageTools({ url: "http://insecure.test/mcp", tokenProvider: f.tokenProvider })).toThrow("invalid_mcp_url");
  });
});
