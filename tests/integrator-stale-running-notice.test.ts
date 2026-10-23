import { describe, expect, it } from "vitest";
import { buildIntegratorProgress, staleRunningQuestionBinding } from "../src/integrator-progress.js";
import { deliverStaleRunningQuestion } from "../src/human-request/notice-question.js";
import type { AgentSession, SessionDetails } from "../src/types/index.js";

const now = Date.parse("2026-10-23T09:00:00.000Z");
const stamp = (ageMs: number) => new Date(now - ageMs).toISOString();
const session = (overrides: Partial<AgentSession> = {}): AgentSession => ({
  id: "s1", harness: "codex", status: "running", title: "work", cwd: "/repo",
  lastActivity: stamp(30_000), needsPermission: false, ...overrides,
});
const details = (overrides: { session?: AgentSession } = {}): SessionDetails => ({
  session: overrides.session ?? session(), lineage: { kind: "root" }, children: [], messages: [],
  history: { source: "acp-load", complete: true },
});
const progress = (overrides: Partial<Parameters<typeof buildIntegratorProgress>[0]> = {}) =>
  buildIntegratorProgress({ now, staleAfterMs: 60_000, ...overrides });

interface Call { url: string; init: RequestInit }
const recorder = (): { calls: Call[]; fetchImpl: typeof fetch } => {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200 } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};
const config = (fetchImpl: typeof fetch) => ({
  endpoint: "http://127.0.0.1:8091/v1/human-requests",
  token: "test-token",
  project: "hermes",
  recipient: "operator",
  fetchImpl,
});
const headersOf = (call: Call): Record<string, string> => call.init.headers as Record<string, string>;
const bodyOf = (call: Call): Record<string, unknown> => JSON.parse(String(call.init.body)) as Record<string, unknown>;

describe("the stale running fact and the existing Notice question producer", () => {
  it("asks the operator exactly once through the existing producer", async () => {
    const { calls, fetchImpl } = recorder();
    const stale = progress({ details: details({ session: session({ lastActivity: stamp(120_000) }) }) });
    expect(stale.state).toBe("stale_running");
    expect(await deliverStaleRunningQuestion(stale, { harness: "codex", session_id: "s1", cwd: "/repo" }, config(fetchImpl))).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8091/v1/human-requests");
    expect(calls[0]!.init.method).toBe("POST");
    expect(headersOf(calls[0]!)["idempotency-key"]).toBe("stale-running:codex:s1");
    expect(bodyOf(calls[0]!)).toMatchObject({
      schema: "ask_human.request.v1", project: "hermes", recipient: "operator", mode: "choice", kind: "user",
    });
    expect(bodyOf(calls[0]!).choices).toHaveLength(3);
    expect(bodyOf(calls[0]!).native_target).toMatchObject({ harness: "codex", session_id: "s1", cwd: "/repo" });
  });

  it("makes no call for any other progress state", async () => {
    const { calls, fetchImpl } = recorder();
    const fresh = progress({ details: details({ session: session({ lastActivity: stamp(1_000) }) }) });
    expect(fresh.state).toBe("active_progress");
    expect(await deliverStaleRunningQuestion(fresh, { harness: "codex", session_id: "s1" }, config(fetchImpl))).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("keeps a redelivery on the same card", async () => {
    const { calls, fetchImpl } = recorder();
    const stale = progress({ details: details({ session: session({ lastActivity: stamp(120_000) }) }) });
    await deliverStaleRunningQuestion(stale, { harness: "codex", session_id: "s1" }, config(fetchImpl));
    await deliverStaleRunningQuestion(stale, { harness: "codex", session_id: "s1" }, config(fetchImpl));
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((call) => headersOf(call)["idempotency-key"])).size).toBe(1);
    expect(new Set(calls.map((call) => bodyOf(call).request_id)).size).toBe(1);
  });

  it("builds no question for a state that is not stale running", () => {
    expect(staleRunningQuestionBinding(progress({ details: details({ session: session({ lastActivity: stamp(1_000) }) }) }), { harness: "codex", session_id: "s1" })).toBeUndefined();
    expect(staleRunningQuestionBinding(progress({ details: details({ session: session({ status: "stopped", lastActivity: stamp(120_000) }) }) }), { harness: "codex", session_id: "s1" })).toBeUndefined();
  });
});
