import { afterEach, describe, expect, it, vi } from "vitest";
import { JudgeRequestError, type JudgeFailureKind } from "../src/autopilot/judge-request.js";
import {
  runZaiModelCycle, ZAI_AUTOPILOT_MODELS, ZaiModelCycleStoppedError, type ZaiModelCycleRetry,
} from "../src/autopilot/zai-failover.js";

afterEach(() => vi.useRealTimers());

function failure(kind: JudgeFailureKind = "overloaded", extra: Partial<JudgeRequestError["diagnostic"]> = {}) {
  return new JudgeRequestError({
    model: "glm-5.3", endpoint: "https://api.z.ai/api/coding/paas/v4/chat/completions",
    operation: "stop", elapsedMs: 1, stage: "headers", kind, ...extra,
  });
}

describe("Z.AI autopilot model cycle", () => {
  it("tries 5.3, 5.2, then 5.3 Flash and returns the first successful result", async () => {
    const calls: Array<[string, number]> = [];
    const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => {});
    const events: ZaiModelCycleRetry[] = [];
    const result = await runZaiModelCycle({
      attempt: async (model, number) => {
        calls.push([model, number]);
        if (number < 3) throw failure(number === 1 ? "overloaded" : "rate_limited");
        return { kind: "continue", nextGoal: "Verify the result" };
      }, sleep, onRetry: event => events.push(event),
    });
    expect(calls).toEqual([["glm-5.3", 1], ["glm-5.2", 2], ["glm-5.3-flash", 3]]);
    expect(result).toEqual({ kind: "continue", nextGoal: "Verify the result" });
    expect(sleep.mock.calls.map(call => call[0])).toEqual([1_000, 1_000]);
    expect(events.map(event => [event.model, event.nextModel, event.cycle])).toEqual([
      ["glm-5.3", "glm-5.2", 1], ["glm-5.2", "glm-5.3-flash", 1],
    ]);
  });

  it("continues through more than one complete cycle with growing cycle delays", async () => {
    const models: string[] = [];
    const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => {});
    await expect(runZaiModelCycle({
      attempt: async (model, number) => { models.push(model); if (number <= 6) throw failure(); return "accepted"; },
      sleep,
    })).resolves.toBe("accepted");
    expect(models).toEqual([...ZAI_AUTOPILOT_MODELS, ...ZAI_AUTOPILOT_MODELS, "glm-5.3"]);
    expect(sleep.mock.calls.map(call => call[0])).toEqual([1000, 1000, 1000, 1000, 1000, 2000]);
  });

  it("caps exponential backoff without spinning or capping a provider cooldown", async () => {
    const waits: number[] = [];
    const events: ZaiModelCycleRetry[] = [];
    await runZaiModelCycle({
      attempt: async (_model, number) => { if (number <= 15) throw failure(); return true; },
      maxDelayMs: 4_000, sleep: async ms => { waits.push(ms); }, onRetry: event => events.push(event),
    });
    expect(waits.every(ms => ms >= 1000 && ms <= 4000)).toBe(true);
    expect(events.filter(event => event.attempt % 3 === 0).map(event => event.delayMs)).toEqual([1000, 2000, 4000, 4000, 4000]);
    const cooldown: number[] = [];
    await runZaiModelCycle({
      attempt: async (_model, number) => { if (number === 1) throw failure("rate_limited", { retryAfter: "120" }); return true; },
      sleep: async ms => { cooldown.push(ms); },
    });
    expect(cooldown).toEqual([60_000, 60_000]);
  });

  it("cancels during a retry delay and removes its timer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const attempt = vi.fn(async () => { throw failure(); });
    const result = runZaiModelCycle({ attempt, signal: controller.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort("do not expose this caller reason");
    const error = await result;
    expect(error).toBeInstanceOf(ZaiModelCycleStoppedError);
    expect(error).toMatchObject({ name: "AbortError", reason: "aborted" });
    expect(error.message).not.toContain("do not expose");
    expect(vi.getTimerCount()).toBe(0);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending attempt even if the transport ignores its abort signal", async () => {
    const controller = new AbortController();
    const attempt = vi.fn(() => new Promise<never>(() => {}));
    const result = runZaiModelCycle({ attempt, signal: controller.signal }).catch(error => error);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    controller.abort();
    expect(await result).toMatchObject({ name: "AbortError", reason: "aborted" });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch after an already aborted signal or a failed eligibility guard", async () => {
    const controller = new AbortController(); controller.abort();
    const attempt = vi.fn(async () => "unexpected");
    await expect(runZaiModelCycle({ attempt, signal: controller.signal })).rejects.toMatchObject({ reason: "aborted" });
    await expect(runZaiModelCycle({ attempt, shouldContinue: () => false })).rejects.toMatchObject({ reason: "guard" });
    expect(attempt).not.toHaveBeenCalled();
  });

  it("checks the fence during a long cooldown and suppresses the next attempt", async () => {
    vi.useFakeTimers();
    let allowed = true;
    const attempt = vi.fn(async () => { throw failure("rate_limited", { retryAfter: "45" }); });
    const result = runZaiModelCycle({ attempt, shouldContinue: () => allowed }).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    allowed = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ reason: "guard" });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not return a successful verdict after its session fence changed", async () => {
    let allowed = true;
    await expect(runZaiModelCycle({
      shouldContinue: () => allowed,
      attempt: async () => { allowed = false; return { kind: "continue" }; },
    })).rejects.toMatchObject({ reason: "guard" });
  });

  it.each<JudgeFailureKind>([
    "authentication", "access_denied", "quota_exhausted", "cancelled",
    "invalid_json", "truncated_output", "http_error", "timeout", "network",
  ])("returns %s immediately without a fallback by default", async kind => {
    const error = failure(kind);
    const attempt = vi.fn(async () => { throw error; });
    const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => {});
    await expect(runZaiModelCycle({ attempt, sleep })).rejects.toBe(error);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rotates on an exact unsupported-model code but not a message containing model", async () => {
    const models: string[] = [];
    await runZaiModelCycle({
      attempt: async (model, number) => {
        models.push(model);
        if (number === 1) throw failure("http_error", { httpStatus: 404, providerCode: "model_not_found" });
        return true;
      }, sleep: async () => {},
    });
    expect(models).toEqual(["glm-5.3", "glm-5.2"]);
    const misleading = failure("http_error", { httpStatus: 400, providerMessage: "The model is unavailable because your input is invalid" });
    await expect(runZaiModelCycle({ attempt: async () => { throw misleading; } })).rejects.toBe(misleading);
    const forbidden = failure("authentication", { httpStatus: 401, providerCode: "model_not_found" });
    await expect(runZaiModelCycle({ attempt: async () => { throw forbidden; } })).rejects.toBe(forbidden);
  });

  it.each<JudgeFailureKind>(["timeout", "network"])("retries %s only with explicit pure-inference transport policy", async kind => {
    const models: string[] = [];
    await runZaiModelCycle({
      retryTransportErrors: true,
      attempt: async (model, number) => { models.push(model); if (number === 1) throw failure(kind); return true; },
      sleep: async () => {},
    });
    expect(models).toEqual(["glm-5.3", "glm-5.2"]);
    const unknown = new TypeError("ambiguous browser send");
    await expect(runZaiModelCycle({ retryTransportErrors: true, attempt: async () => { throw unknown; } })).rejects.toBe(unknown);
  });

  it.each(["7", "Sun, 08 Nov 2026 22:00:07 GMT"])("honors Retry-After %s", async retryAfter => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-08T22:00:00Z"));
    const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => {});
    await runZaiModelCycle({
      attempt: async (_model, number) => { if (number === 1) throw failure("rate_limited", { retryAfter }); return "ok"; },
      sleep,
    });
    expect(sleep.mock.calls.map(call => call[0])).toEqual([7000]);
  });

  it.each(["nonsense", "-1", "Infinity"])("ignores invalid Retry-After %s while preserving minimum delay", async retryAfter => {
    const waits: number[] = [];
    await runZaiModelCycle({
      attempt: async (_model, number) => { if (number === 1) throw failure("overloaded", { retryAfter }); return true; },
      sleep: async ms => { waits.push(ms); },
    });
    expect(waits).toEqual([1000]);
  });

  it("does not serialize independent sessions behind an overloaded one", async () => {
    const controller = new AbortController();
    let waiting!: () => void;
    const blocked = new Promise<void>(resolve => { waiting = resolve; });
    const first = runZaiModelCycle({
      signal: controller.signal, attempt: async () => { throw failure(); },
      sleep: async () => { waiting(); await new Promise<never>(() => {}); },
    }).catch(error => error);
    await blocked;
    await expect(runZaiModelCycle({ attempt: async () => "another session completed" })).resolves.toBe("another session completed");
    controller.abort();
    expect(await first).toMatchObject({ reason: "aborted" });
  });

  it("emits only bounded retry metadata, never provider text or credentials", async () => {
    const events: ZaiModelCycleRetry[] = [];
    await runZaiModelCycle({
      attempt: async (_model, number) => {
        if (number === 1) throw failure("overloaded", { providerMessage: "secret-token private conversation" });
        return true;
      }, sleep: async () => {}, onRetry: event => events.push(event),
    });
    expect(events).toEqual([{ model: "glm-5.3", nextModel: "glm-5.2", attempt: 1, cycle: 1, delayMs: 1000, kind: "overloaded" }]);
    expect(JSON.stringify(events)).not.toContain("secret-token");
  });

  it("rejects unsafe delay settings before dispatch", async () => {
    const attempt = vi.fn(async () => true);
    for (const value of [0, 999, 60_001, NaN, Infinity, 1.5]) {
      await expect(runZaiModelCycle({ attempt, minDelayMs: value })).rejects.toBeInstanceOf(RangeError);
    }
    await expect(runZaiModelCycle({ attempt, minDelayMs: 2000, maxDelayMs: 1000 })).rejects.toBeInstanceOf(RangeError);
    expect(attempt).not.toHaveBeenCalled();
  });
});
