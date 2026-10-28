import { expect, it } from "vitest";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";

const turn = {
  id: "01a1829d-eeea-7761-93cf-4c4373357135", status: "failed", completedAt: 1793196087,
  items: [], error: { message: "Selected model is at capacity. Please try a different model.", codexErrorInfo: "serverOverloaded" },
};

it("projects terminal capacity after the public session reader resolves its model from the archive on a cold cache", async () => {
  const adapter = new CodexAppServerAdapter({ socketPath: "/unused-capacity-fixture" });
  const native = adapter as any;
  native.ensureReady = async () => undefined;
  native.request = async (method: string) => method === "thread/read"
    ? { thread: { id: "target", status: "idle", cwd: "/tmp/capacity" } }
    : { data: [turn] };
  native.rawTranscriptAdapter.getSessionObservation = async () => ({ id: "target", harness: "codex", model: "gpt-6.1-sol", status: "idle", cwd: "/tmp/capacity", lastActivity: "2026-10-28T14:01:27.000Z", meta: {} });
  try {
    const session = await adapter.getSession("target");
    expect(session?.model).toBe("gpt-6.1-sol");
    expect((session?.meta?.nativeLastTurn as any)?.capacityFailure).toMatchObject({ classification: "model_capacity", modelId: "gpt-6.1-sol", nativeTurnId: turn.id });
  } finally { await adapter.dispose(); }
});

it("preserves explicit terminal model capacity across native snapshot reads without treating it as quota", async () => {
  const adapter = new CodexAppServerAdapter({ socketPath: "/unused-capacity-fixture" });
  const native = adapter as any;
  native.threads.set("target", { id: "target", model: "gpt-6.1-sol" });
  native.request = async () => ({ data: [turn] });
  try {
    await native.refreshActiveTurnId("target");
    const state = native.toSession(native.threads.get("target"));
    expect(state.meta.nativeLastTurn.capacityFailure).toMatchObject({ classification: "model_capacity", nativeTurnId: turn.id, providerId: "codex", modelId: "gpt-6.1-sol", errorCode: "serverOverloaded", message: turn.error.message });
    expect(state.meta.nativeLastTurn.quotaFailure).toBeUndefined();
    expect(state.meta.nativeLastTurn.capacityFailure.inputId).toBeUndefined();
  } finally { await adapter.dispose(); }
});

it("emits the same exact capacity evidence on native terminal failure events", async () => {
  const adapter = new CodexAppServerAdapter({ socketPath: "/unused-capacity-fixture" });
  const native = adapter as any;
  const events: any[] = [];
  native.threads.set("target", { id: "target", model: "gpt-6.1-sol" });
  native.emitEvent = (event: unknown) => events.push(event);
  try {
    native.consumeMessage({ method: "turn/completed", params: { threadId: "target", turn } });
    expect(events.find(event => event.kind === "turn.failed")?.data).toMatchObject({ turnId: turn.id, capacityFailure: { classification: "model_capacity", errorCode: "serverOverloaded" } });
  } finally { await adapter.dispose(); }
});

it.each([
  { ...turn, status: "inProgress" },
  { ...turn, status: "interrupted" },
  { ...turn, completedAt: undefined },
  { ...turn, error: { message: "Network timed out", codexErrorInfo: "networkError" } },
  { ...turn, error: { message: "Service temporarily overloaded", codexErrorInfo: "serverOverloaded" } },
])("does not infer capacity from ambiguous or nonterminal native state", async candidate => {
  const adapter = new CodexAppServerAdapter({ socketPath: "/unused-capacity-fixture" });
  const native = adapter as any;
  native.threads.set("target", { id: "target", model: "gpt-6.1-sol" });
  native.request = async () => ({ data: [candidate] });
  try {
    await native.refreshActiveTurnId("target");
    expect(native.toSession(native.threads.get("target")).meta.nativeLastTurn.capacityFailure).toBeUndefined();
  } finally { await adapter.dispose(); }
});

it("clears capacity evidence when a fresh native read no longer carries the explicit failure", async () => {
  const adapter = new CodexAppServerAdapter({ socketPath: "/unused-capacity-fixture" });
  const native = adapter as any;
  native.threads.set("target", { id: "target", model: "gpt-6.1-sol" });
  let current: unknown = turn;
  native.request = async () => ({ data: [current] });
  try {
    await native.refreshActiveTurnId("target");
    expect(native.toSession(native.threads.get("target")).meta.nativeLastTurn.capacityFailure).toBeDefined();
    current = { ...turn, error: undefined };
    await native.refreshActiveTurnId("target");
    expect(native.toSession(native.threads.get("target")).meta.nativeLastTurn.capacityFailure).toBeUndefined();
  } finally { await adapter.dispose(); }
});
