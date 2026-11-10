import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VibeChromePageTools } from "../src/adapters/vibe-chrome-transport.js";
import { parseChromeEvaluation } from "../src/adapters/mac-mini-chrome-transport.js";

const toolsToClose: VibeChromePageTools[] = [];
const text = (value: string) => ({ content: [{ type: "text", text: value }] });
function fixture(failBootstrap = false) {
  const page = createContext({
    TextEncoder,
    setTimeout: (callback: () => void, ms: number) => { const timer = setTimeout(callback, ms); timer.unref(); return timer; },
    clearTimeout,
    accepted: 0,
  });
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const callTool = vi.fn(async (input: { name: string; arguments: Record<string, unknown> }) => {
    calls.push(input);
    if (input.name === "new_page") return text("Successfully created new background page (ID: 817), navigated to https://chat.z.ai/ and page is ready");
    if (input.name !== "evaluate_script") throw new Error("unexpected tool");
    page.__nativeArgs = input.arguments.args ?? [];
    // Match installed Vibe 1.1.41: invoke synchronously, then serialize the
    // containing object. A directly returned Promise would become {}.
    const result = runInContext("(" + input.arguments.function + ")(...__nativeArgs)", page);
    if (failBootstrap && String(input.arguments.function).includes("const entry")) throw new Error("reply lost after browser execution");
    return text(JSON.stringify({ success: true, result, executionTime: 0, type: typeof result })
      + "\n\n---\n# Current browser state:\nUntrusted appended content.");
  });
  const close = vi.fn(async () => {});
  const tools = new VibeChromePageTools({
    url: "https://example.invalid/server/fixture/mcp", tokenProvider: async () => "fixture",
    clientFactory: () => ({ connect: async () => {}, callTool, close }), transportFactory: () => ({}),
  });
  toolsToClose.push(tools);
  return { page, tools, calls, callTool };
}
afterEach(async () => { await Promise.all(toolsToClose.splice(0).map(tools => tools.close())); });

describe("Vibe transport with the real async evaluation bridge", () => {
  it("executes an async function once, polls the same owned tab and returns the resolved native value", async () => {
    const f = fixture();
    await f.tools.call("new_page", { url: "https://chat.z.ai/" });
    const output = await f.tools.call("evaluate_script", {
      pageId: 817,
      function: "async (number) => { globalThis.accepted++; await Promise.resolve(); return {value:number+1,accepted:globalThis.accepted}; }",
      args: [41],
    });
    expect(parseChromeEvaluation(output)).toEqual({ value: 42, accepted: 1 });
    expect(f.page.accepted).toBe(1);
    const evaluations = f.calls.filter(call => call.name === "evaluate_script");
    expect(evaluations.length).toBeGreaterThanOrEqual(3);
    expect(evaluations.every(call => call.arguments.tabId === 817 && !("pageId" in call.arguments))).toBe(true);
    expect(evaluations.filter(call => String(call.arguments.function).includes("globalThis.accepted++"))).toHaveLength(1);
    expect(evaluations.every(call => !String(call.arguments.function).trimStart().startsWith("async"))).toBe(true);
    expect(evaluations[0]!.arguments.args).toEqual([41]);
    expect(evaluations.slice(1).every(call => call.arguments.args === undefined)).toBe(true);
  });

  it("does not replay a bootstrap whose response was lost after the browser admitted the async function", async () => {
    const f = fixture(true);
    await f.tools.call("new_page", { url: "https://chat.z.ai/" });
    await expect(f.tools.call("evaluate_script", {
      pageId: 817,
      function: "async () => { globalThis.accepted++; await Promise.resolve(); return {accepted:globalThis.accepted}; }",
    })).rejects.toThrow("outcome_unknown");
    await Promise.resolve(); await Promise.resolve();
    expect(f.page.accepted).toBe(1);
    expect(f.calls.filter(call => call.name === "evaluate_script")).toHaveLength(1);
  });
});
