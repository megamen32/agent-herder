import { describe, expect, it, vi } from "vitest";
import { createContext, runInContext } from "node:vm";
import {
  MAC_MINI_VIBE_TARGET, SERVER100_VIBE_TARGET, VibeChromeTransport, VibeMcpPort,
  VibeTransportError, normalizeVibePages, parseVibeEvaluation, parseVibeOpenedPage,
  vibeStdioParameters, type VibeMcpClient,
} from "../src/adapters/vibe-chrome-transport.js";
import { parseChromeEvaluation } from "../src/adapters/mac-mini-chrome-transport.js";

const text = (value: string) => ({ content: [{ type: "text", text: value }] });
const evaluation = (result: unknown) => text(JSON.stringify({ success: true, result, executionTime: 1, type: typeof result }));
const runtimeSettings = {
  vibeMacSshTarget: "fixture-user@fixture-host",
  vibeMacNodePath: "/tmp/fixture-node",
  vibeMacCliPath: "/tmp/fixture-vibe-cli",
};
const serverRuntimeSettings = { vibeServerCliPath: "/tmp/fixture-server-vibe-cli" };
const binding = { target: MAC_MINI_VIBE_TARGET, sessionId: "session_1", runtimeSettings };

describe("Vibe ChromePageTools contract", () => {
  it("normalizes every observed page and preserves the selected ID", async () => {
    const callTool = vi.fn().mockResolvedValue(text('Found 2 page(s):\nPage 71: "One" - https://chatgpt.com/\nPage 89 [ACTIVE]: "Two" - https://chat.z.ai/'));
    const tools = new VibeChromeTransport(binding, { callTool });
    expect(await tools.call("list_pages")).toBe("71: One (https://chatgpt.com/)\n89: Two (https://chat.z.ai/) [selected]");
    expect(callTool).toHaveBeenCalledExactlyOnceWith("list_pages", {});
    expect(() => normalizeVibePages('Found 2 page(s):\nPage 71: "One" - https://chatgpt.com/')).toThrow("vibe_page_list_incomplete");
    expect(() => normalizeVibePages('Found 2 page(s):\nPage 71: "One" - https://chatgpt.com/\nPage 71: "Again" - https://chatgpt.com/')).toThrow("vibe_page_list_invalid");
  });

  it("maps evaluation to exact tabId and the existing fenced JSON contract", async () => {
    const result = { marker: "owned fixture", nested: [1, true], text: "```json\nnot a fence\n```" };
    const context = createContext({ TextEncoder });
    const callTool = vi.fn(async (_name, args) => evaluation(runInContext(args.function, context)()));
    const tools = new VibeChromeTransport(binding, { callTool });
    const fn = `() => (${JSON.stringify(result)})`;
    const response = await tools.call("evaluate_script", { pageId: 71, function: fn });
    expect(callTool.mock.calls[0]![1].tabId).toBe(71);
    expect(callTool.mock.calls[0]![1].function).toContain(fn);
    expect(callTool.mock.calls.filter(call => call[1].function.includes(fn))).toHaveLength(1);
    expect(parseChromeEvaluation(response)).toEqual(result);
    expect(() => parseVibeEvaluation(text('{"success":false,"error":"private page detail"}'))).toThrow("vibe_evaluation_invalid");
    expect(() => parseVibeEvaluation(text('{"success":true}'))).toThrow("vibe_evaluation_invalid");
  });

  it("uses only the creation receipt, not an ID from appended browser state", async () => {
    const native = text("Successfully created new background page (ID: 71), navigated to https://chatgpt.com/, and page is ready\n\n---\n# Current browser state:\nTab ID: 999");
    const callTool = vi.fn().mockResolvedValue(native);
    const tools = new VibeChromeTransport(binding, { callTool });
    expect(await tools.call("new_page", { url: "https://chatgpt.com/", background: true, timeout: 12_000 })).toBe("Vibe page opened: 71");
    expect(parseVibeOpenedPage(native)).toBe(71);
    expect(callTool).toHaveBeenCalledExactlyOnceWith("new_page", { url: "https://chatgpt.com/", focus: false, waitForReady: true });
    expect(() => parseVibeOpenedPage(text("Page creation uncertain\n\n---\n# Current browser state:\nTab ID: 999"))).toThrow("vibe_new_page_receipt_invalid");
  });

  it("preserves exact accessibility refs while changing only the role/name ordering", async () => {
    const callTool = vi.fn().mockResolvedValue(text('# Accessibility Snapshot: fixture\n```text\n- textbox "Ask anything" uid=A17\n- button "Send" uid=A18\n```'));
    const tools = new VibeChromeTransport(binding, { callTool });
    const response = await tools.call("take_snapshot", { pageId: 71 });
    expect(callTool).toHaveBeenCalledExactlyOnceWith("take_snapshot", { pageId: 71, format: "accessibility_tree" });
    expect(response).toContain('uid=A17 textbox "Ask anything"');
    callTool.mockResolvedValue(text("Filled field"));
    await tools.call("fill", { pageId: 71, uid: "A17", value: "own fixture text" });
    expect(callTool).toHaveBeenLastCalledWith("fill", { tabId: 71, uid: "A17", value: "own fixture text" });
  });

  it("never supplies implicit foreground targeting or unsupported tool arguments", async () => {
    const callTool = vi.fn().mockResolvedValue(text("accepted"));
    const tools = new VibeChromeTransport(binding, { callTool });
    await expect(tools.call("evaluate_script", { function: "() => 1" })).rejects.toThrow("vibe_exact_page_required");
    await expect(tools.call("evaluate_script", { pageId: 71, tabId: 72, function: "() => 1" })).rejects.toThrow("vibe_conflicting_page_binding");
    await expect(tools.call("fill", { pageId: 71, uid: "legacy-1", value: "x" })).rejects.toThrow("vibe_invalid_accessibility_ref");
    await expect(tools.call("switch_to_page", { pageId: 71 })).rejects.toThrow("vibe_unsupported_tool");
    expect(callTool).not.toHaveBeenCalled();
    await tools.call("navigate_page", { pageId: 71, type: "url", url: "https://chatgpt.com/", timeout: 1200 });
    expect(callTool).toHaveBeenLastCalledWith("navigate_page", { pageId: 71, type: "url", url: "https://chatgpt.com/", timeoutMs: 1200 });
    await tools.call("close_page", { pageId: 71 });
    expect(callTool).toHaveBeenLastCalledWith("close_page", { pageId: 71 });
  });

  it.each([
    { isError: true, content: [{ type: "text", text: "private browser refusal" }] },
    { task: { taskId: "task-one", status: "working" } },
    { structuredContent: { taskId: "task-two", status: "accepted" }, content: [{ type: "text", text: "accepted" }] },
  ])("preserves refusals/accepted task receipts without retrying", async receipt => {
    const callTool = vi.fn().mockResolvedValue(receipt);
    const tools = new VibeChromeTransport(binding, { callTool });
    const error = await tools.call("evaluate_script", { pageId: 71, function: "() => 'fixture'" }).catch(value => value);
    expect(error).toBeInstanceOf(VibeTransportError);
    expect(error.receipt === receipt || error.receipt.native === receipt).toBe(true);
    expect(error.message).not.toContain("private");
    expect(callTool.mock.calls.filter(call => String(call[1].function).includes("() => 'fixture'"))).toHaveLength(1);
  });
});

describe("configured Vibe child binding", () => {
  it("pins the same durable extension session across independent runner invocations", () => {
    const first = vibeStdioParameters(binding);
    const second = vibeStdioParameters({ ...binding });
    expect(first).toEqual(second);
    expect(first.command).toBe("/usr/bin/ssh");
    expect(first.args).toContain("StrictHostKeyChecking=yes");
    expect(first.args?.slice(-4)).toEqual(["--session", "session_1", "--port", "19888"]);
    expect(JSON.stringify(first)).not.toContain("50260");
    expect(JSON.stringify(first)).not.toContain("firstConnected");
    const other = vibeStdioParameters({ ...binding, sessionId: "session_other" });
    expect(other.args).toContain("session_other");
    expect(other.args).not.toContain("session_1");
  });

  it("isolates a configured local CI relay and clears inherited remote selection", () => {
    const configured = vibeStdioParameters({ target: SERVER100_VIBE_TARGET, sessionId: "session_1", relayPort: 19898, relayStateDir: "/tmp/agent-herder-fixture/ci-vibe", runtimeSettings: serverRuntimeSettings });
    expect(configured.command).toBe(process.execPath);
    expect(configured.env).toMatchObject({
      VIBE_REMOTE_URL: "", VIBE_EXTENSION_UUID: "", VIBE_RELAY_UUID: "",
      VIBE_MCP_AGENT_PORT: "19898", VIBE_MCP_EXTENSION_PORT: "19899",
      VIBE_MCP_STATE_DIR: "/tmp/agent-herder-fixture/ci-vibe",
      VIBE_MCP_PID_FILE: "/tmp/agent-herder-fixture/ci-vibe/vibebrowser-relay.pid",
    });
    expect(() => vibeStdioParameters({ ...binding, relayPort: 19898 })).toThrow("vibe_custom_relay_requires_isolated_state");
  });

  it("rejects unknown targets, missing pins and shell metacharacters before launch", () => {
    expect(() => vibeStdioParameters({ ...binding, target: "other" })).toThrow("vibe_target_not_configured");
    expect(() => vibeStdioParameters({ ...binding, sessionId: "" })).toThrow("vibe_browser_session_required");
    expect(() => vibeStdioParameters({ ...binding, sessionId: "session_1;touch/tmp/x" })).toThrow("vibe_browser_session_required");
    expect(() => vibeStdioParameters({ ...binding, relayPort: 19898, relayStateDir: "/tmp/agent-herder-fixture/../other" })).toThrow("vibe_invalid_relay_state");
  });
});

describe("SDK Vibe MCP lifecycle", () => {
  function fakeClient(): VibeMcpClient {
    return { connect: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined),
      request: vi.fn().mockResolvedValue(evaluation({ ok: true })) };
  }

  it("retains one initialized SDK connection and raw image/result content", async () => {
    const client = fakeClient();
    const factory = vi.fn(() => client);
    const transportFactory = vi.fn(() => ({ own: "transport" }));
    const port = new VibeMcpPort(transportFactory, factory);
    const raw = { content: [{ type: "image", data: "fixture", mimeType: "image/png" }] };
    vi.mocked(client.request).mockResolvedValue(raw);
    expect(await port.callTool("take_screenshot", { pageId: 71 })).toBe(raw);
    await port.callTool("list_pages", {});
    expect(factory).toHaveBeenCalledTimes(1);
    expect(transportFactory).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledTimes(1);
    await port.close();
    expect(client.close).toHaveBeenCalledTimes(1);
    await expect(port.callTool("list_pages", {})).rejects.toThrow("vibe_mcp_closed");
  });

  it("records UNKNOWN after a dispatch exception and never retries the action", async () => {
    const client = fakeClient();
    vi.mocked(client.request).mockRejectedValueOnce(new Error("transport dropped after effect with private content"));
    const port = new VibeMcpPort(() => ({}), () => client);
    const error = await port.callTool("evaluate_script", { tabId: 71, function: "() => 'fixture'" }).catch(value => value);
    expect(error).toMatchObject({ code: "vibe_mcp_outcome_unknown", receipt: { tool: "evaluate_script", outcome: "unknown", replayed: false } });
    expect(error.message).not.toContain("private");
    expect(client.request).toHaveBeenCalledTimes(1);
    await port.callTool("list_pages", {});
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.request).mock.calls.map(call => call[0].params.name)).toEqual(["evaluate_script", "list_pages"]);
  });

  it("preserves native TaskCreateResult through a loose SDK request schema", async () => {
    const client = fakeClient();
    const receipt = { taskId: "native-one", status: "working", pollInterval: 500 };
    vi.mocked(client.request).mockImplementation(async (request, schema) => {
      expect(request).toEqual({ method: "tools/call", params: { name: "create", arguments: { request_key: "own-fixture" } } });
      return (schema as { parse(value: unknown): unknown }).parse(receipt);
    });
    const port = new VibeMcpPort(() => ({}), () => client);
    expect(await port.callTool("create", { request_key: "own-fixture" })).toEqual(receipt);
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("retains native error data for reconciliation after an uncertain dispatch", async () => {
    const client = fakeClient();
    const native = { taskId: "pending-native", status: "working" };
    vi.mocked(client.request).mockRejectedValue(Object.assign(new Error("private error detail"), { data: native }));
    const port = new VibeMcpPort(() => ({}), () => client);
    const error = await port.callTool("create", { request_key: "owned" }).catch(value => value);
    expect(error.receipt.native).toBe(native);
    expect(error.message).toBe("vibe_mcp_outcome_unknown");
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("does not substitute a fresh session after a failed connection", async () => {
    const client = fakeClient();
    vi.mocked(client.connect).mockRejectedValue(new Error("session unavailable"));
    const factory = vi.fn(() => client);
    const port = new VibeMcpPort(() => ({}), factory);
    await expect(port.callTool("list_pages", {})).rejects.toThrow("vibe_mcp_connection_failed");
    await expect(port.callTool("list_pages", {})).rejects.toThrow("vibe_mcp_closed");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("reads an existing native task through the SDK without resubmitting its tool", async () => {
    const client = fakeClient();
    const port = new VibeMcpPort(() => ({}), () => client);
    vi.mocked(client.request).mockResolvedValue({ taskId: "one", status: "completed" });
    expect(await port.request("tasks/get", { taskId: "one" })).toEqual({ taskId: "one", status: "completed" });
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.request).mock.calls[0]![0].method).toBe("tasks/get");
  });
});
