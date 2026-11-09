import { createContext, runInContext } from "node:vm";
import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { MAC_MINI_VIBE_TARGET, VibeChromeTransport, VibeTransportError } from "../src/adapters/vibe-chrome-transport.js";
import { parseChromeEvaluation } from "../src/adapters/mac-mini-chrome-transport.js";
import { serveBrowserChatAhap } from "../src/ahap-browser-runner.js";

function nativeVibe() {
  const context = createContext({ TextEncoder, setTimeout, counter: 0 });
  const callTool = vi.fn(async (_name: string, args: Record<string, unknown>) => {
    // Installed Vibe wraps the function return without awaiting it. JSON
    // serialization turns a Promise into {}, just as the live RED probe did.
    const result = runInContext(String(args.function), context)(...(args.args as unknown[] ?? []));
    return { content: [{ type: "text", text: JSON.stringify({ success: true, result, type: typeof result }) }] };
  });
  return { context, callTool };
}

const binding = { target: MAC_MINI_VIBE_TARGET, sessionId: "session_1", timeoutMs: 300 };

describe("Vibe asynchronous evaluations", () => {
  it("awaits a Promise through read-only polls and dispatches its action exactly once", async () => {
    const native = nativeVibe();
    const tools = new VibeChromeTransport(binding, native);
    const result = await tools.call("evaluate_script", {
      pageId: 71, args: ["owned-value"],
      function: "async (value) => { globalThis.counter++; await new Promise(resolve => setTimeout(resolve, 30)); return {value, count: globalThis.counter}; }",
    });
    expect(parseChromeEvaluation(result)).toEqual({ value: "owned-value", count: 1 });
    expect(native.context.counter).toBe(1);
    expect(native.callTool.mock.calls.filter(call => String(call[1].function).includes("globalThis.counter++"))).toHaveLength(1);
  });

  it("preserves a bound pending receipt on timeout without re-running the action", async () => {
    const native = nativeVibe();
    const tools = new VibeChromeTransport({ ...binding, timeoutMs: 100 }, native);
    const error = await tools.call("evaluate_script", {
      pageId: 71,
      function: "() => { globalThis.counter++; return new Promise(() => {}); }",
    }).catch(value => value);
    expect(error.code).toBe("vibe_evaluation_pending");
    expect(error.receipt).toMatchObject({ target: MAC_MINI_VIBE_TARGET, sessionId: "session_1", pageId: 71, dispatches: 1, state: "pending" });
    expect(error.receipt.operationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(native.context.counter).toBe(1);
  });

  it("reports rejected Promises without leaking their private message", async () => {
    const native = nativeVibe();
    const tools = new VibeChromeTransport(binding, native);
    const error = await tools.call("evaluate_script", { pageId: 71, function: "async () => { throw Error('private credential-like detail'); }" }).catch(value => value);
    expect(error.code).toBe("vibe_evaluation_failed");
    expect(error.message).not.toContain("private");
    expect(error.receipt.state).toBe("failed");
  });

  it("keeps synchronous values and explicit undefined, exception and JSON bounds", async () => {
    const native = nativeVibe();
    const tools = new VibeChromeTransport(binding, native);
    expect(parseChromeEvaluation(await tools.call("evaluate_script", { pageId: 71, function: "() => [null, false, 0, '']" }))).toEqual([null, false, 0, ""]);
    await expect(tools.call("evaluate_script", { pageId: 71, function: "() => undefined" })).rejects.toMatchObject({ code: "vibe_evaluation_undefined" });
    await expect(tools.call("evaluate_script", { pageId: 71, function: "() => {throw Error('private')}" })).rejects.toMatchObject({ code: "vibe_evaluation_failed" });
    await expect(tools.call("evaluate_script", { pageId: 71, function: "() => 1n" })).rejects.toMatchObject({ code: "vibe_evaluation_not_json" });
    await expect(tools.call("evaluate_script", { pageId: 71, function: "() => 'x'.repeat(2 * 1024 * 1024)" })).rejects.toMatchObject({ code: "vibe_evaluation_too_large" });
  });

  it("reconciles a lost dispatch acknowledgement with reads and keeps other operation entries", async () => {
    const native = nativeVibe();
    native.context.__agentHerderVibeEvaluationsV1 = { another: { state: "complete", json: "1" } };
    const invoke = native.callTool.getMockImplementation()!;
    let first = true;
    native.callTool.mockImplementation(async (name, args) => {
      const response = await invoke(name, args);
      if (first) { first = false; throw new VibeTransportError("vibe_mcp_outcome_unknown"); }
      return response;
    });
    const tools = new VibeChromeTransport(binding, native);
    expect(parseChromeEvaluation(await tools.call("evaluate_script", { pageId: 71, function: "() => ++globalThis.counter" }))).toBe(1);
    expect(native.context.counter).toBe(1);
    expect(Object.keys(native.context.__agentHerderVibeEvaluationsV1)).toEqual(["another"]);
  });

  it("includes only safe operation metadata in an AHAP error", async () => {
    const scope = "a".repeat(64);
    const receipt = { operationId: "10000000-0000-4000-8000-000000000001", target: MAC_MINI_VIBE_TARGET,
      sessionId: "session_1", pageId: 71, state: "pending", dispatches: 1, native: { private: "must-not-leak" } };
    const adapter = {
      type: "chatgpt", name: "fixture", browserFeatures: {}, init: async () => {},
      getAccountScope: () => scope, verifyPinnedAccountScope: async () => {},
      createSession: async () => { throw new VibeTransportError("vibe_evaluation_pending", receipt); },
    } as unknown as Parameters<typeof serveBrowserChatAhap>[0];
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { harness: "chatgpt", ahapVersion: "0.1" } },
      { jsonrpc: "2.0", id: 2, method: "init", params: {} },
      { jsonrpc: "2.0", id: 3, method: "createSession", params: { options: { name: "fixture", cwd: "/owned/fixture" } } },
    ];
    let output = "";
    await serveBrowserChatAhap(adapter, Readable.from(requests.map(value => JSON.stringify(value) + "\n")),
      new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } }), scope);
    const last = JSON.parse(output.trim().split("\n").at(-1)!);
    expect(last.error.data.transport_receipt.operationId).toBe(receipt.operationId);
    expect(output).not.toContain("must-not-leak");
  });
});
