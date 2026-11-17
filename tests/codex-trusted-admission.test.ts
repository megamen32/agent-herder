import { describe, expect, it } from "vitest";
import { CodexTrustedAdmission, type TrustedAdmissionHooks } from "../src/codex-trusted-admission.js";

const id = "00000000-0000-4000-8000-000000000001";
const config = { openai_base_url: "http://127.0.0.1:18127/backend-api/codex", features: { enable_request_compression: false } };
const params = { threadId: id, modelProvider: "openai", excludeTurns: true };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

function fixture() {
  const admission = new CodexTrustedAdmission();
  const state = { generation: 1, ready: true, loaded: false, busy: false,
    status: undefined as unknown, turns: [{ id: "last", status: "completed" }] as unknown,
    queue: [] as unknown, provider: "openai", resumeCount: 0 };
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let onResume: (() => Promise<void>) | undefined;
  let beforeWrite: (() => void) | undefined;
  const hooks: TrustedAdmissionHooks = {
    generation: () => state.generation,
    ready: () => state.ready,
    locallyBusy: () => state.busy,
    request: async (method, body, guard) => {
      calls.push({ method, params: body });
      if (method === "thread/loaded/list") return { data: state.loaded ? [id] : [], nextCursor: null };
      if (method === "thread/read") return { thread: { id, modelProvider: state.provider,
        status: state.status ?? { type: state.loaded ? "idle" : "notLoaded" } } };
      if (method === "thread/turns/list") return { data: state.turns };
      if (method === "thread/queue/list") return { data: state.queue, nextCursor: null };
      if (method !== "thread/resume") throw new Error(`unexpected RPC ${method}`);
      beforeWrite?.(); guard?.();
      state.resumeCount++;
      await onResume?.();
      state.loaded = true;
      return { thread: { id, modelProvider: state.provider, status: { type: "idle" } } };
    },
  };
  return { admission, state, calls, hooks,
    onResume: (fn: () => Promise<void>) => { onResume = fn; },
    beforeWrite: (fn: () => void) => { beforeWrite = fn; },
    run: (allowCold = true) => admission.resume(id, config, params, hooks, allowCold) };
}

describe("trusted native transport admission", () => {
  it("applies once, preserves hot attach and reapplies after native cold GC", async () => {
    const f = fixture();
    await f.run(); await f.run(false);
    f.state.loaded = false;
    await f.run();
    const resumes = f.calls.filter(c => c.method === "thread/resume");
    expect(resumes.map(c => c.params.config)).toEqual([config, undefined, config]);
    expect(resumes.every(c => c.params.modelProvider === "openai")).toBe(true);
  });

  it("serializes the entire resume and receipt, not just its preflight", async () => {
    const f = fixture(), started = deferred(), receipt = deferred();
    f.onResume(async () => { started.resolve(); await receipt.promise; });
    const first = f.run(); await started.promise;
    const second = f.run(); await Promise.resolve();
    expect(f.state.resumeCount).toBe(1);
    receipt.resolve(); await Promise.all([first, second]);
    expect(f.calls.filter(c => c.method === "thread/resume").map(c => c.params.config)).toEqual([config, undefined]);
  });

  it.each([
    { type: "active", activeFlags: ["waitingOnApproval"] },
    { type: "active" },
    { type: "notLoaded", activeFlags: ["waitingOnUserInput"] },
    { type: "unknown" },
    "running",
  ])("refuses active or unknown typed native state %j", async status => {
    const f = fixture(); f.state.status = status;
    await expect(f.run()).rejects.toThrow("writer-free cold");
    expect(f.state.resumeCount).toBe(0);
  });

  it("refuses a missing native status instead of assuming it is cold", async () => {
    const f = fixture(), request = f.hooks.request;
    f.hooks.request = async (method, body, guard) => method === "thread/read"
      ? { thread: { id, modelProvider: "openai" } } : request(method, body, guard);
    await expect(f.run()).rejects.toThrow("thread status");
    expect(f.state.resumeCount).toBe(0);
  });

  it.each(["inProgress", "unknown"])("refuses a nonterminal native turn %s", async status => {
    const f = fixture(); f.state.turns = [{ id: "last", status }];
    await expect(f.run()).rejects.toThrow("turn is active or unknown");
    expect(f.state.resumeCount).toBe(0);
  });

  it("refuses pending native queue and local permission ownership", async () => {
    const queued = fixture(); queued.state.queue = [{ id: "pending" }];
    await expect(queued.run()).rejects.toThrow("queue is pending");
    const busy = fixture(); busy.state.busy = true;
    await expect(busy.run()).rejects.toThrow("writer-free cold");
    expect(queued.state.resumeCount + busy.state.resumeCount).toBe(0);
  });

  it("does not treat an empty nonterminal page as proof of an empty turn history", async () => {
    const f = fixture(), request = f.hooks.request;
    f.hooks.request = async (method, body, guard) => method === "thread/turns/list"
      ? { data: [], nextCursor: "unread" } : request(method, body, guard);
    await expect(f.run()).rejects.toThrow("turn page is incomplete");
    expect(f.state.resumeCount).toBe(0);
  });

  it("does not call a thread cold when it is on a later native loaded page", async () => {
    const f = fixture(), request = f.hooks.request;
    f.hooks.request = async (method, body, guard) => method === "thread/loaded/list"
      ? body.cursor ? { data: [id], nextCursor: null } : { data: ["other"], nextCursor: "page2" }
      : request(method, body, guard);
    await expect(f.run()).rejects.toThrow("no acknowledged configuration");
    expect(f.state.resumeCount).toBe(0);
  });

  it("fails closed on repeated pagination", async () => {
    const f = fixture(), request = f.hooks.request;
    f.hooks.request = async (method, body, guard) => method === "thread/loaded/list"
      ? { data: ["other"], nextCursor: "again" } : request(method, body, guard);
    await expect(f.run()).rejects.toThrow("pagination repeated");
  });

  it("rechecks the generation after an asynchronous admission guard", async () => {
    const f = fixture(); f.hooks.externalGuard = async () => { f.state.generation++; return true; };
    await expect(f.run()).rejects.toThrow("generation changed");
    expect(f.state.resumeCount).toBe(0);
  });

  it("checks generation again at the actual native write after quota admission", async () => {
    const f = fixture(); f.beforeWrite(() => { f.state.generation++; });
    await expect(f.run()).rejects.toThrow("generation changed");
    expect(f.state.resumeCount).toBe(0);
  });

  it("invalidates hot evidence after reconnect or native close", async () => {
    const f = fixture(); await f.run(); f.state.generation++;
    await expect(f.run()).rejects.toThrow("no acknowledged configuration");
    expect(f.state.resumeCount).toBe(1);
    const closed = fixture(); await closed.run(); closed.admission.forget(id);
    await expect(closed.run()).rejects.toThrow("no acknowledged configuration");
  });

  it("does not promote a lost resume receipt to a successful configuration", async () => {
    const f = fixture(); f.onResume(async () => { f.state.loaded = true; throw new Error("lost native receipt"); });
    await expect(f.run()).rejects.toThrow("lost native receipt");
    await expect(f.run()).rejects.toThrow("no acknowledged configuration");
    expect(f.state.resumeCount).toBe(1);
  });

  it("keeps an acknowledged transport after a harmless hot read failure", async () => {
    const f = fixture(); await f.run();
    const request = f.hooks.request;
    f.hooks.request = async () => { throw new Error("read unavailable"); };
    await expect(f.run()).rejects.toThrow("read unavailable");
    f.hooks.request = request;
    await f.run(false);
    expect(f.calls.filter(c => c.method === "thread/resume").map(c => c.params.config)).toEqual([config, undefined]);
  });

  it("refuses a loaded runtime whose provider changed after the acknowledgement", async () => {
    const f = fixture(); await f.run(); f.state.provider = "other-provider";
    await expect(f.admission.resume(id, config, { ...params, modelProvider: "other-provider" }, f.hooks)).rejects.toThrow("no acknowledged configuration");
    expect(f.state.resumeCount).toBe(1);
  });

  it("does not silently cold-load from an attach request", async () => {
    const f = fixture(); await expect(f.run(false)).rejects.toThrow("attach cannot load");
    expect(f.state.resumeCount).toBe(0);
  });
});
