import { afterEach, describe, expect, it, vi } from "vitest";
import { createContext, runInContext } from "node:vm";
import { Readable, Writable } from "node:stream";
import { MAC_MINI_VIBE_TARGET, SERVER100_VIBE_TARGET, VibeChromeTransport, VibeTransportError, VibeMcpPort, normalizeVibePages, parseVibeEvaluation, parseVibeOpenedPage, vibeStdioParameters, type VibeMcpClient, VibeChromePageTools } from "../src/adapters/vibe-chrome-transport.js";
import { serveBrowserChatAhap } from "../src/ahap-browser-runner.js";
import { createContext, runInContext, type Context } from "node:vm";
import { evaluateVibeAsync, VIBE_ASYNC_EVALUATION_PROTOCOL } from "../src/adapters/vibe-async-evaluation.js";
import { parseChromeEvaluation } from "../src/adapters/mac-mini-chrome-transport.js";

const cacheKey = "__agentHerderVibeAsyncEvaluationV1";
const fence = String.fromCharCode(96).repeat(3);
const normalized = (value: unknown) => fence + "json" + String.fromCharCode(10) + JSON.stringify(value) + String.fromCharCode(10) + fence;
const disposals: Array<() => void> = [];
function fixture() {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const effects: Record<string, number> = {};
  const calls: Array<{ declaration: string; args?: unknown[]; raw: unknown }> = [];
  const fresh = () => createContext({
    TextEncoder, Date, effects, location: { href: "https://chat.z.ai/" },
    setTimeout: (callback: () => void, milliseconds: number) => {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, milliseconds);
      timers.add(timer); return timer;
    },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => { timers.delete(timer); clearTimeout(timer); },
  });
  let context: Context = fresh();
  const evaluateOnce = vi.fn(async (declaration: string, args?: unknown[]) => {
    const result = runInContext("(" + declaration + ")", context)(...(args ?? []));
    calls.push({ declaration, args, raw: result });
    // Installed Vibe creates this ordinary object before CDP awaitPromise:
    // a Promise in result becomes {}, whereas our synchronous frames survive.
    const native = JSON.parse(JSON.stringify({
      success: true, result, executionTime: 0, type: typeof result,
    }));
    return normalized(native.result);
  });
  disposals.push(() => { for (const timer of timers) clearTimeout(timer); timers.clear(); });
  return {
    effects, calls, evaluateOnce,
    context: () => context,
    reload: () => { context = fresh(); },
    entries: () => Object.keys(context[cacheKey]?.entries ?? {}),
  };
}
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.useRealTimers();
});
const fast = { timeoutMs: 1000, pollIntervalMs: 2 };

describe("Vibe asynchronous evaluation bridge", () => {
  it("recovers the actual async value from the installed wrapper while invoking the original once", async () => {
    const f = fixture();
    const source = "async value => { effects.started = (effects.started || 0) + 1; await Promise.resolve(); return {ok:true,value}; }";
    expect(parseChromeEvaluation(await f.evaluateOnce(source, ["native"]))).toEqual({});
    await Promise.resolve();
    f.effects.started = 0; f.calls.length = 0;
    const result = await evaluateVibeAsync({ ...fast, functionDeclaration: source, args: ["bridge"], evaluateOnce: f.evaluateOnce });
    expect(parseChromeEvaluation(result)).toEqual({ ok: true, value: "bridge" });
    expect(f.effects.started).toBe(1);
    expect(f.calls[0].args).toEqual(["bridge"]);
    expect(f.calls.slice(1).every(call => call.args === undefined)).toBe(true);
    expect(f.calls.every(call => typeof (call.raw as { then?: unknown })?.then !== "function")).toBe(true);
    expect(f.entries()).toEqual([]);
  });

  it.each([null, false, 0, "complete", [1, { value: 2 }]].map(expected => ({ expected })))("preserves JSON result $expected without treating it as an absent value", async ({ expected }) => {
    const f = fixture();
    const result = await evaluateVibeAsync({ ...fast, functionDeclaration: "async value => value", args: [expected], evaluateOnce: f.evaluateOnce });
    expect(parseChromeEvaluation(result)).toEqual(expected);
  });

  it("keeps simultaneous operations independent and cleans only their own completed entries", async () => {
    const f = fixture();
    const original = "async (id, ms) => { effects[id] = (effects[id] || 0) + 1; await new Promise(r => setTimeout(r, ms)); return {id}; }";
    const results = await Promise.all([["slow", 25], ["fast", 1], ["middle", 10]].map(args =>
      evaluateVibeAsync({ ...fast, functionDeclaration: original, args, evaluateOnce: f.evaluateOnce })));
    expect(results.map(result => parseChromeEvaluation(result))).toEqual([{ id: "slow" }, { id: "fast" }, { id: "middle" }]);
    expect(f.effects).toEqual({ slow: 1, fast: 1, middle: 1 });
    expect(f.entries()).toEqual([]);
  });

  it("never retries the original when its bootstrap receipt is lost after execution", async () => {
    const f = fixture();
    const evaluateOnce = vi.fn(async (declaration: string, args?: unknown[]) => {
      await f.evaluateOnce(declaration, args);
      throw new Error("sensitive token in transport failure");
    });
    await expect(evaluateVibeAsync({ ...fast, evaluateOnce,
      functionDeclaration: "async () => { effects.sent = (effects.sent || 0) + 1; return {ok:true}; }",
    })).rejects.toThrow(/^vibe_async_evaluation_outcome_unknown$/);
    expect(evaluateOnce).toHaveBeenCalledTimes(1);
    expect(f.effects.sent).toBe(1);
  });

  it("treats an absent nonce after full navigation as UNKNOWN without executing again", async () => {
    const f = fixture();
    let count = 0;
    const evaluateOnce = async (declaration: string, args?: unknown[]) => {
      if (++count === 2) f.reload();
      return f.evaluateOnce(declaration, args);
    };
    await expect(evaluateVibeAsync({ ...fast, evaluateOnce,
      functionDeclaration: "async () => { effects.sent = (effects.sent || 0) + 1; return {ok:true}; }",
    })).rejects.toThrow(/^vibe_async_evaluation_outcome_unknown$/);
    expect(f.effects.sent).toBe(1);
    expect(count).toBe(2);
  });

  it("allows the operation's own SPA route transition when its exact nonce remains in the same realm", async () => {
    const f = fixture();
    const result = await evaluateVibeAsync({ ...fast, evaluateOnce: f.evaluateOnce,
      functionDeclaration: "async () => { location.href = 'https://chat.z.ai/c/owned-new-chat'; await Promise.resolve(); return {chatId:'owned-new-chat'}; }",
    });
    expect(parseChromeEvaluation(result)).toEqual({ chatId: "owned-new-chat" });
  });

  it("rejects a malformed or foreign bootstrap frame without resubmission", async () => {
    const f = fixture();
    const evaluateOnce = vi.fn(async (declaration: string, args?: unknown[]) => {
      const raw = await f.evaluateOnce(declaration, args);
      const value = parseChromeEvaluation<Record<string, unknown>>(raw);
      return normalized({ ...value, nonce: "another-operation" });
    });
    await expect(evaluateVibeAsync({ ...fast, evaluateOnce,
      functionDeclaration: "() => { effects.sent = (effects.sent || 0) + 1; return true; }",
    })).rejects.toThrow(/^vibe_async_evaluation_outcome_unknown$/);
    expect(evaluateOnce).toHaveBeenCalledTimes(1);
    expect(f.effects.sent).toBe(1);
  });

  it("bounds the whole attempt and expires abandoned entries without replay", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const promise = evaluateVibeAsync({ timeoutMs: 25, pollIntervalMs: 5, evaluateOnce: f.evaluateOnce,
      functionDeclaration: "async () => { effects.sent = (effects.sent || 0) + 1; return new Promise(() => {}); }",
    });
    const rejected = expect(promise).rejects.toThrow(/^vibe_async_evaluation_outcome_unknown$/);
    await vi.advanceTimersByTimeAsync(30); await rejected;
    expect(f.effects.sent).toBe(1); expect(f.entries()).toHaveLength(1);
    const count = f.calls.length;
    await vi.advanceTimersByTimeAsync(5030);
    expect(f.entries()).toEqual([]);
    expect(f.calls.length).toBe(count);
  });

  it("does not dispatch after pre-abort, and stops polls after a later abort", async () => {
    const f = fixture(), before = new AbortController();
    before.abort();
    await expect(evaluateVibeAsync({ ...fast, evaluateOnce: f.evaluateOnce, signal: before.signal,
      functionDeclaration: "() => true",
    })).rejects.toThrow(/^vibe_async_evaluation_outcome_unknown$/);
    expect(f.calls).toHaveLength(0);
    const during = new AbortController();
    const evaluateOnce = async (declaration: string, args?: unknown[]) => {
      const result = await f.evaluateOnce(declaration, args);
      during.abort(); return result;
    };
    await expect(evaluateVibeAsync({ ...fast, evaluateOnce, signal: during.signal,
      functionDeclaration: "async () => { effects.sent = (effects.sent || 0) + 1; return true; }",
    })).rejects.toThrow(/^vibe_async_evaluation_outcome_unknown$/);
    expect(f.effects.sent).toBe(1); expect(f.calls).toHaveLength(1);
  });

  it("sanitizes both original exceptions and native polling failures", async () => {
    const f = fixture();
    await expect(evaluateVibeAsync({ ...fast, evaluateOnce: f.evaluateOnce,
      functionDeclaration: "async () => { throw new Error('private account and token'); }",
    })).rejects.toThrow(/^vibe_async_evaluation_execution_failed$/);
    expect(f.entries()).toEqual([]);
    let count = 0;
    const evaluateOnce = async (declaration: string, args?: unknown[]) => {
      if (++count === 2) throw new Error("private response on failed poll");
      return f.evaluateOnce(declaration, args);
    };
    await expect(evaluateVibeAsync({ ...fast, evaluateOnce,
      functionDeclaration: "() => { effects.sent = (effects.sent || 0) + 1; return true; }",
    })).rejects.toThrow(/^vibe_async_evaluation_outcome_unknown$/);
    expect(f.effects.sent).toBe(1); expect(count).toBe(2);
  });

  it.each(["() => undefined", "() => 1n", "() => { const value = {}; value.self = value; return value; }"])(
    "rejects non-JSON results safely: %s", async functionDeclaration => {
      const f = fixture();
      await expect(evaluateVibeAsync({ ...fast, evaluateOnce: f.evaluateOnce, functionDeclaration }))
        .rejects.toThrow(/^vibe_async_evaluation_unsupported_result$/);
      expect(f.entries()).toEqual([]);
    },
  );

  it("bounds the complete escaped native/MCP result before it leaves the page", async () => {
    const f = fixture();
    await expect(evaluateVibeAsync({ ...fast, evaluateOnce: f.evaluateOnce,
      functionDeclaration: "() => String.fromCharCode(34).repeat(800000)",
    })).rejects.toThrow(/^vibe_async_evaluation_result_too_large$/);
    expect(f.calls.every(call => Buffer.byteLength(JSON.stringify(call.raw), "utf8") < 3 * 1024 * 1024)).toBe(true);
    expect(f.entries()).toEqual([]);
  });

  it("captures a JSON snapshot before the original object's later mutation", async () => {
    const f = fixture();
    const result = await evaluateVibeAsync({ ...fast, pollIntervalMs: 20, evaluateOnce: f.evaluateOnce,
      functionDeclaration: "() => { const result = {answer:'initial'}; setTimeout(() => { result.answer='changed'; }, 1); return result; }",
    });
    expect(parseChromeEvaluation(result)).toEqual({ answer: "initial" });
  });

  it("keeps an obtained result successful even if best-effort cleanup fails", async () => {
    const f = fixture(); let count = 0;
    const evaluateOnce = async (declaration: string, args?: unknown[]) => {
      if (++count === 3) throw new Error("cleanup unavailable");
      return f.evaluateOnce(declaration, args);
    };
    const result = await evaluateVibeAsync({ ...fast, evaluateOnce, functionDeclaration: "async () => ({ok:true})" });
    expect(parseChromeEvaluation(result)).toEqual({ ok: true });
    expect(count).toBe(3);
    expect(f.entries()).toHaveLength(1);
  });

  it("refuses a saturated cache before executing the original", async () => {
    const f = fixture();
    f.context()[cacheKey] = { version: 1, entries: Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [String(index), { state: "pending", expiresAt: Date.now() + 60000 }]),
    ) };
    await expect(evaluateVibeAsync({ ...fast, evaluateOnce: f.evaluateOnce,
      functionDeclaration: "() => { effects.sent = 1; return true; }",
    })).rejects.toThrow(/^vibe_async_evaluation_cache_unavailable$/);
    expect(f.effects.sent).toBeUndefined();
    expect(f.entries()).toHaveLength(32);
  });

  it("rejects unbounded or unrecognized frames with a sanitized error", async () => {
    for (const raw of ["x".repeat(3 * 1024 * 1024 + 1), normalized({}), normalized({ protocol: VIBE_ASYNC_EVALUATION_PROTOCOL, state: "done", nonce: "wrong", value: true })]) {
      const evaluateOnce = vi.fn(async () => raw);
      await expect(evaluateVibeAsync({ ...fast, evaluateOnce, functionDeclaration: "() => true" }))
        .rejects.toThrow(/^vibe_async_evaluation_outcome_unknown$/);
      expect(evaluateOnce).toHaveBeenCalledTimes(1);
    }
  });
});


// Installed/native Vibe transport coverage from the main release line.

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

const runtimeSettings = { vibeMacSshTarget: "fixture-user@fixture-host", vibeMacNodePath: "/tmp/fixture-node", vibeMacCliPath: "/tmp/fixture-vibe-cli" };
const binding = { target: MAC_MINI_VIBE_TARGET, sessionId: "session_1", timeoutMs: 300, runtimeSettings };

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
