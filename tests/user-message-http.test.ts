import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createWebServer } from "../src/web/server.js";
import { SessionSupervisor } from "../src/session-supervisor.js";
import { HumanStopStore } from "../src/human-stop-store.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import type { AgentSession, HarnessAdapter, SendMessageOptions } from "../src/types/index.js";

async function fixture(test: (base: string, idle: () => void, send: ReturnType<typeof vi.fn>, nativeStop: (resumeImmediately?: boolean) => Promise<void>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "herder-human-http-"));
  let status: AgentSession["status"] = "running";
  const session = (): AgentSession => ({ id: "thread", harness: "codex", status, title: "HTTP fixture", cwd: dir, lastActivity: new Date().toISOString() });
  const send = vi.fn(async (_id: string, _options: SendMessageOptions) => { status = "running"; return { ok: true, admitted: true, turnId: "actual-adapter-turn" }; });
  const adapter = { type: "codex", name: "Fixture", async init() {}, async listSessions() { return [session()]; }, async getSession() { return session(); }, sendMessage: send, async stopSession() { status = "stopped"; return { ok: true }; }, async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; } } as HarnessAdapter;
  const adapters = new Map([["codex", adapter]]);
  const converter = { async convert() { return { success: true, targetSessionId: "x", targetPath: dir, messageCount: 0 }; } };
  const stops = new HumanStopStore(join(dir, "stops.json"));
  const supervisor = new SessionSupervisor(adapters, converter, undefined, { humanStopStore: stops });
  const server = createWebServer({ adapters, converter, supervisor, jobs: new HerderJobRegistry(new HerderEventBus()) });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture bind failed");
  try { await test(`http://127.0.0.1:${address.port}`, () => { status = "idle"; }, send, async (resumeImmediately = false) => {
    status = "stopped";
    await stops.hold(session(), { id: "native-user-stop", at: new Date().toISOString(), reason: "human stopped native chat" });
    if (resumeImmediately) { await stops.release("codex", "thread"); status = "idle"; }
  }); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
}

const post = (base: string, inputId: string, mode = "queue") => fetch(`${base}/api/sessions/codex/thread/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "A separate task", humanRequested: true, inputId, mode }) });
const status = async (base: string, inputId: string) => (await fetch(`${base}/api/sessions/codex/thread/message-status?inputId=${inputId}`)).json();

describe("registered HTTP human delivery route", () => {
  it("acknowledges queue immediately, forwards native identity once after idle, and exposes its receipt", async () => fixture(async (base, idle, send) => {
    const first = await post(base, "human-http-1");
    expect(first.status).toBe(202);
    const receipt = await first.json();
    expect(receipt).toMatchObject({ inputId: "human-http-1", delivery: "deferred" });
    expect(send).not.toHaveBeenCalled();
    expect((await (await post(base, "human-http-1")).json()).job.id).toBe(receipt.job.id);
    idle();
    await vi.waitFor(async () => expect(await status(base, "human-http-1")).toMatchObject({ admitted: true, turnId: "actual-adapter-turn" }), { timeout: 3_500, interval: 25 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toMatchObject({ inputId: "human-http-1", origin: "human", queue: true });
    expect((await (await post(base, "human-http-1")).json()).turnId).toBe("actual-adapter-turn");
    expect(send).toHaveBeenCalledTimes(1);
  }));

  it("cancels waiting human input on explicit stop rather than waking the chat afterwards", async () => fixture(async (base, idle, send) => {
    await post(base, "human-stop-1");
    await fetch(`${base}/api/sessions/codex/thread/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    idle();
    await vi.waitFor(async () => expect(await status(base, "human-stop-1")).toMatchObject({ ok: false, nonRetryable: true }), { timeout: 1_000, interval: 25 });
    expect(send).not.toHaveBeenCalled();
  }));

  it("honors a later native stop even when it did not arrive through the web stop route", async () => fixture(async (base, _idle, send, nativeStop) => {
    await post(base, "native-stop-1");
    await nativeStop();
    await vi.waitFor(async () => expect(await status(base, "native-stop-1")).toMatchObject({ ok: false, nonRetryable: true }), { timeout: 3_500, interval: 25 });
    expect(send).not.toHaveBeenCalled();
  }));

  it("does not revive old queued intent when a different newer human input releases the stop", async () => fixture(async (base, _idle, send, nativeStop) => {
    await post(base, "old-intent-1");
    await nativeStop(true);
    await vi.waitFor(async () => expect(await status(base, "old-intent-1")).toMatchObject({ ok: false, nonRetryable: true }), { timeout: 3_500, interval: 25 });
    expect(send).not.toHaveBeenCalled();
  }));
});
