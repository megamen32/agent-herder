import { afterEach, describe, expect, it, vi } from "vitest";
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
