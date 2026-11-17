import { expect, it } from "vitest";
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexAppServerConfig } from "../src/codex-composition.js";
import { loadTrustedOperatorProfile } from "../src/codex-trusted-transport.js";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";

const id = "00000000-0000-4000-8000-000000000001";
const config = { openai_base_url: "http://127.0.0.1:18127/backend-api/codex", features: { enable_request_compression: false } } as const;

function fixture() {
  const adapter = new CodexAppServerAdapter(createCodexAppServerConfig({ enabled: true, mappings: { [id]: config } }));
  const internal = adapter as any;
  const calls: Array<{ method: string; params: any }> = [];
  const loaded = new Set<string>();
  let model = "gpt-6.1-terra";
  internal.ensureReady = async () => {};
  internal.isReady = () => true;
  internal.threads.set(id, { id, modelProvider: "openai" });
  internal.threads.set("other-thread", { id: "other-thread", modelProvider: "omniroute" });
  internal.request = async (method: string, params: any, _stage: string, _timeout: number, _human: boolean, guard?: () => void) => {
    calls.push({ method, params });
    if (method === "thread/loaded/list") return { data: [...loaded], nextCursor: null };
    if (method === "thread/turns/list") return { data: [{ id: "completed-turn", status: "completed" }] };
    if (method === "thread/queue/list") return { data: [], nextCursor: null };
    if (method === "thread/read") return { thread: { id: params.threadId, modelProvider: "openai", model, reasoningEffort: "high",
      status: { type: loaded.has(params.threadId) ? "idle" : "notLoaded" } } };
    if (method !== "thread/resume") throw new Error("unexpected native method " + method);
    guard?.();
    loaded.add(params.threadId);
    model = params.model ?? model;
    return { thread: { id: params.threadId, modelProvider: params.modelProvider ?? "openai", model, reasoningEffort: "high", status: { type: "idle" } },
      model, reasoningEffort: "high", serviceTier: "priority" };
  };
  return { adapter, internal, calls, loaded };
}

it("production composition supports ordinary cold resume, hot resume, tier attach and model change", async () => {
  const f = fixture();
  try {
    expect(await f.adapter.resumeSession(id)).toMatchObject({ ok: true });
    expect(await f.adapter.resumeSession(id)).toMatchObject({ ok: true });
    expect(await f.adapter.getServiceTier(id)).toMatchObject({ canSet: true, serviceTier: "fast" });
    expect(await f.adapter.changeModel(id, "gpt-6.1-sol")).toMatchObject({ ok: true });
    expect(await f.adapter.resumeSession("other-thread")).toMatchObject({ ok: true });
    const resumes = f.calls.filter(call => call.method === "thread/resume");
    expect(resumes).toHaveLength(5);
    expect(resumes.map(call => call.params.config)).toEqual([config, undefined, undefined, undefined, undefined]);
    expect(resumes[0].params).not.toHaveProperty("modelProvider");
    expect(resumes.at(-1)?.params.modelProvider).toBe("omniroute");
    expect(resumes[3].params.model).toBe("gpt-6.1-sol");
  } finally { await f.adapter.dispose(); }
});

it("production mapped recovery never forks when a loaded thread cannot be safely adopted", async () => {
  const f = fixture(); let forks = 0;
  f.loaded.add(id);
  f.internal.forkSession = async () => { forks++; return { ok: true, sessionId: "wrong-child" }; };
  try {
    expect(await f.adapter.recover(id)).toMatchObject({ ok: false });
    expect(forks).toBe(0);
    expect(f.calls.some(call => call.method === "thread/resume")).toBe(false);
  } finally { await f.adapter.dispose(); }
});

it("does not confuse completed interrupt and input tombstones with an active writer", async () => {
  const f = fixture();
  f.internal.internalInterrupts.set(id, { turnId: "old-terminal", expiresAt: Date.now() + 86400000 });
  f.internal.pendingNativeUserInputs.set("old-request", { threadId: id, responded: true });
  try { expect(await f.adapter.resumeSession(id)).toMatchObject({ ok: true }); }
  finally { await f.adapter.dispose(); }
});

it("production composition invalidates the mapping after the native generation changes", async () => {
  const f = fixture();
  try {
    expect(await f.adapter.resumeSession(id)).toMatchObject({ ok: true });
    f.internal.beginTransportGeneration();
    expect(await f.adapter.resumeSession(id)).toMatchObject({ ok: false, error: expect.stringContaining("acknowledged") });
    f.loaded.delete(id);
    expect(await f.adapter.resumeSession(id)).toMatchObject({ ok: true });
    expect(f.calls.filter(call => call.method === "thread/resume").map(call => call.params.config)).toEqual([config, config]);
  } finally { await f.adapter.dispose(); }
});

it("disabled production profile preserves existing model and transport defaults", () => {
  const empty = createCodexAppServerConfig(undefined, {});
  expect(empty.trustedTransportResolver).toBeUndefined();
  expect(empty.modelIds).toEqual([]);
  const disabled = createCodexAppServerConfig({ enabled: false, mappings: { [id]: config } }, { CODEX_MODELS: " a, b " });
  expect(disabled.trustedTransportResolver).toBeUndefined();
  expect(disabled.modelIds).toEqual(["a", "b"]);
});

it("loads an exact private profile and rejects relative paths, symlinks, broad permissions and unknown fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-transport-profile-"));
  const path = join(dir, "profile.json"), link = join(dir, "link.json");
  const profile = { enabled: true, mappings: { [id]: config } };
  try {
    await writeFile(path, JSON.stringify(profile), { mode: 0o600 });
    expect(await loadTrustedOperatorProfile(path)).toEqual(profile);
    await expect(loadTrustedOperatorProfile("relative.json")).rejects.toThrow("absolute");
    await symlink(path, link);
    await expect(loadTrustedOperatorProfile(link)).rejects.toThrow();
    await chmod(path, 0o644);
    await expect(loadTrustedOperatorProfile(path)).rejects.toThrow("0600");
    await chmod(path, 0o600);
    await writeFile(path, JSON.stringify({ ...profile, preflightDir: "/tmp/not-proof" }));
    await expect(loadTrustedOperatorProfile(path)).rejects.toThrow("schema");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
