import { expect, it } from "vitest";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";

function fixture(mode: "confirm" | "foreign" | "mismatch" | "missing" = "confirm") {
  const adapter = new CodexAppServerAdapter({ socketPath: "/unused-tier-socket", requestTimeoutMs: 15 });
  const native = adapter as any;
  const calls: Array<{ method: string; params: any }> = [];
  native.ensureReady = async () => undefined;
  native.isReady = () => true;
  native.activeTurns.set("target", "active-turn");
  native.request = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === "thread/loaded/list") return { data: mode === "missing" ? [] : ["target"] };
    if (method === "thread/read") return { thread: { id: "target", model: "gpt-6-luna", reasoningEffort: "high", status: "active" } };
    if (method === "thread/settings/update") {
      native.consumeMessage({ method: "thread/settings/updated", params: {
        threadId: mode === "foreign" ? "another" : "target",
        threadSettings: { serviceTier: mode === "mismatch" ? "default" : params.serviceTier },
      } });
      return {};
    }
    throw new Error(`Forbidden native operation ${method}`);
  };
  return { adapter, native, calls };
}

it("changes only service tier for a loaded active Codex thread and confirms the native event", async () => {
  const { adapter, native, calls } = fixture();
  try {
    expect(await native.getServiceTier("target")).toMatchObject({ canSet: true, scope: "session" });
    expect(await native.setServiceTier("target", "fast")).toMatchObject({ ok: true, sessionId: "target", serviceTier: "fast", nativeServiceTier: "fast", appliesTo: "subsequent-turns" });
    expect(calls.filter(c => c.method === "thread/settings/update")).toEqual([{ method: "thread/settings/update", params: { threadId: "target", serviceTier: "fast" } }]);
    expect((await native.getServiceTier("target")).serviceTier).toBe("fast");
    expect(native.activeTurns.get("target")).toBe("active-turn");
    expect((await native.setServiceTier("target", "normal"))).toMatchObject({ ok: true, nativeServiceTier: "default", serviceTier: "normal" });
    expect(calls.some(c => /resume|turn\/|config\//.test(c.method))).toBe(false);
  } finally { await adapter.dispose(); }
});

for (const mode of ["foreign", "mismatch"] as const) it(`refuses false success after ${mode} settings notification`, async () => {
  const { adapter, native, calls } = fixture(mode);
  try {
    expect(await native.setServiceTier("target", "fast")).toMatchObject({ ok: false, nonRetryable: true, error: expect.stringContaining("unknown") });
    expect(calls.filter(c => c.method === "thread/settings/update")).toHaveLength(1);
    expect((await native.getServiceTier("target")).serviceTier).not.toBe("fast");
  } finally { await adapter.dispose(); }
});

it("never resumes an unloaded thread or accepts invalid tiers", async () => {
  const { adapter, native, calls } = fixture("missing");
  try {
    expect(await native.setServiceTier("target", "fast")).toMatchObject({ ok: false, nonRetryable: true });
    expect(await native.setServiceTier("target", "priority")).toMatchObject({ ok: false, nonRetryable: true });
    expect(calls.some(c => c.method !== "thread/loaded/list")).toBe(false);
  } finally { await adapter.dispose(); }
});

it("does not reuse confirmed tier after the native transport is replaced", async () => {
  const { adapter, native } = fixture();
  try {
    expect(await native.setServiceTier("target", "fast")).toMatchObject({ ok: true });
    native.transportGeneration += 1;
    expect((await native.getServiceTier("target")).serviceTier).toBeUndefined();
  } finally { await adapter.dispose(); }
});

it("rejects a transport replacement during native preflight before sending any update", async () => {
  const { adapter, native, calls } = fixture();
  const request = native.request;
  native.request = async (method: string, params: any) => {
    const result = await request(method, params);
    if (method === "thread/read") native.transportGeneration += 1;
    return result;
  };
  try {
    expect(await native.setServiceTier("target", "fast")).toMatchObject({ ok: false, error: expect.stringContaining("transport changed") });
    expect(calls.some(c => c.method === "thread/settings/update")).toBe(false);
  } finally { await adapter.dispose(); }
});
