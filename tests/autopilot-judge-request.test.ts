import { describe, expect, it } from "vitest";
import { JudgeRequestError, JudgeRequestTrace } from "../src/autopilot/judge-request.js";
import { createAnthropicCompatibleSessionCompletionJudge, createOpenAICompatibleSessionCompletionJudge } from "../src/autopilot/unfinished-session-launcher.js";
import { createOpenAICompatibleJudge, type StopHookInput } from "../src/autopilot/index.js";
const endpoint = "https://api.z.ai/api/coding/paas/v4/chat/completions";
const trace = () => new JudgeRequestTrace({ endpoint, model: "glm-5.3-flash", operation: "stop" });
async function errorOf(promise: Promise<unknown>): Promise<JudgeRequestError> {
  try { await promise; throw Error("expected failure"); }
  catch (error) { expect(error).toBeInstanceOf(JudgeRequestError); return error as JudgeRequestError; }
}
const hook: StopHookInput = { hook_event_name: "Stop", session_id: "diagnostic-test", turn_id: "1", cwd: "/test", last_assistant_message: "Test", transcript_path: null, stop_hook_active: false };
describe("judge provider diagnostics", () => {
  it.each([["1302", "rate_limited"], ["1305", "overloaded"], ["1310", "quota_exhausted"]])("retains Z.AI HTTP429 native code %s", async (code, kind) => {
    const judge = createOpenAICompatibleJudge({ baseUrl: "https://api.z.ai/api/coding/paas/v4", model: "glm-5.3-flash", token: "secret-test-token",
      fetchImpl: async () => Response.json({ error: { code, message: "limit reached for secret-test-token" } }, { status: 429, headers: { "retry-after": "45", "x-request-id": "provider-123" } }) });
    const error = await errorOf(judge.decide({ hook, evidence: "must never be logged", remainingContinuations: 1 }));
    expect(error.diagnostic).toMatchObject({ model: "glm-5.3-flash", endpoint, operation: "stop", httpStatus: 429, providerCode: code, kind, retryAfter: "45", requestId: "provider-123", stage: "body" });
    expect(error.message).not.toContain("secret-test-token"); expect(error.message).not.toContain("must never be logged");
  });
  it("does not infer exhausted subscription quota from a generic429", async () => {
    const t = trace(); const e = await errorOf(t.fetch(async () => new Response("busy", { status: 429 }), endpoint, {}));
    expect(e.diagnostic.kind).toBe("rate_limited"); expect(e.diagnostic.providerCode).toBeUndefined();
  });
  it("distinguishes a timeout with no received HTTP headers", async () => {
    const e = await errorOf(trace().fetch(async () => { throw new DOMException("timeout", "TimeoutError"); }, endpoint, {}));
    expect(e.diagnostic).toMatchObject({ kind: "timeout", stage: "headers" });
    expect(e.diagnostic.httpStatus).toBeUndefined(); expect(e.diagnostic.providerCode).toBeUndefined();
  });
  it("retains HTTP200/request id when the body times out after headers", async () => {
    const t = trace(); const response = await t.fetch(async () => new Response(new ReadableStream({ start(c) { c.error(new DOMException("timeout", "TimeoutError")); } }), { headers: { "x-request-id": "slow-body" } }), endpoint, {});
    const e = await errorOf(t.json(response));
    expect(e.diagnostic).toMatchObject({ kind: "timeout", stage: "body", httpStatus: 200, requestId: "slow-body" });
  });
  it("distinguishes caller cancellation and a DNS/network failure", async () => {
    const controller = new AbortController(); controller.abort();
    const cancelled = await errorOf(trace().fetch(async () => { throw new DOMException("cancelled", "AbortError"); }, endpoint, { signal: controller.signal }));
    expect(cancelled.diagnostic.kind).toBe("cancelled");
    const network = await errorOf(trace().fetch(async () => { throw Object.assign(Error("fetch failed"), { cause: { code: "ENOTFOUND" } }); }, endpoint, {}));
    expect(network.diagnostic).toMatchObject({ kind: "network", transportCode: "ENOTFOUND" });
  });
  it("captures a MiniMax native quota error even in an HTTP200 envelope", async () => {
    const url = "https://api.minimax.io/anthropic/v1/messages";
    const t = new JudgeRequestTrace({ endpoint: url, model: "MiniMax-M3.1-Flash-Preview", operation: "batch-plan" });
    const r = await t.fetch(async () => Response.json({ base_resp: { status_code: 2056, status_msg: "usage limit exceeded" } }), url, {});
    expect((await errorOf(t.json(r))).diagnostic).toMatchObject({ httpStatus: 200, providerCode: "2056", kind: "quota_exhausted" });
  });
  it("keeps an Anthropic SSE error native code, model and request id", async () => {
    const judge = createAnthropicCompatibleSessionCompletionJudge({ baseUrl: "https://api.minimax.io/anthropic", model: "MiniMax-M3.1-Flash-Preview", token: "secret-test-token", fetchImpl: async () => new Response('data: {"type":"error","error":{"code":"2056","message":"usage limit exceeded"}}\n\n', { headers: { "content-type": "text/event-stream", "request-id": "stream-123" } }) });
    const e = await errorOf(judge.plan!({ sessions: [] }));
    expect(e.diagnostic).toMatchObject({ kind: "quota_exhausted", providerCode: "2056", requestId: "stream-123", model: "MiniMax-M3.1-Flash-Preview", httpStatus: 200 });
  });
  it("preserves malformed-reconciliation classification for the bounded repair path", async () => {
    const judge = createOpenAICompatibleSessionCompletionJudge({ baseUrl: "https://api.z.ai/api/coding/paas/v4", model: "glm-5.3-flash", fetchImpl: async () => new Response("invalid private body") });
    await expect(judge.reconcile!({ groups: [] })).rejects.toMatchObject({ name: "BatchReconciliationValidationError" });
  });
  it("bounds and discards an unstructured error body, strips endpoint query credentials", async () => {
    const url = endpoint + "?api_key=secret-test-token";
    const t = new JudgeRequestTrace({ endpoint: url, model: "glm-5.3-flash", operation: "stop" });
    let cancelled = false;
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x".repeat(8193))); }, cancel() { cancelled = true; } });
    const e = await errorOf(t.fetch(async () => new Response(body, { status: 503 }), url, {}));
    expect(cancelled).toBe(true); expect(e.diagnostic.endpoint).toBe(endpoint); expect(e.diagnostic.providerMessage).toBeUndefined();
  });
  it("diagnoses malformed JSON without including the raw response", async () => {
    const t = trace(); const r = await t.fetch(async () => new Response("private response"), endpoint, {});
    const e = await errorOf(t.json(r)); expect(e.diagnostic.kind).toBe("invalid_json"); expect(e.message).not.toContain("private response");
  });
});
