import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HumanStopStore, getHumanStopStore } from "../src/human-stop-store.js";
import { SessionSupervisor } from "../src/session-supervisor.js";
import { createNamedSession, newOrResumeNamedSession } from "../src/named-session.js";
import { handleResumeAgent, handleSendMessage, handleStopAgent } from "../src/mcp-tools/handlers.js";
import type { AgentSession, HarnessAdapter, HarnessEvent } from "../src/types/index.js";

let root: string;
let path: string;
const observers: Array<() => void> = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "herder-human-stop-integration-"));
  path = join(root, "stops.json");
  vi.stubEnv("AGENT_HERDER_HUMAN_STOP_STORE", path);
});
afterEach(async () => {
  for (const stop of observers.splice(0)) stop();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function fixture(harness: "codex" | "zcode") {
  const current: AgentSession = {
    id: `${harness}-original`, harness, title: "human-stop-original", cwd: root,
    status: "running", lastActivity: new Date().toISOString(), needsPermission: false,
    meta: { activeTurnId: "original-turn" },
  };
  let visible = true;
  const listeners = new Set<(event: HarnessEvent) => void>();
  const sendMessage = vi.fn(async () => ({ ok: true }));
  const resumeSession = vi.fn(async () => ({ ok: true }));
  const recover = vi.fn(async () => ({ ok: true, sessionId: "recovered-session" }));
  const forkSession = vi.fn(async () => ({ ok: true, sessionId: "forked-session" }));
  const createSession = vi.fn(async () => ({ ...current, id: "replacement" }));
  const adapter: HarnessAdapter = {
    type: harness, name: "stop-proof", async init() {},
    async listSessions() { return visible ? [{ ...current }] : []; },
    async getSession(id) { return id === current.id && visible ? { ...current } : null; },
    sendMessage, resumeSession, recover, forkSession, createSession,
    async stopSession() {
      // The durable fence must exist before the native cancellation can emit late events.
      expect(await new HumanStopStore(path).isHeld(harness, current.id)).toBe(true);
      current.status = "idle";
      for (const handler of listeners) handler({ kind: "turn.failed", harness, sessionId: current.id });
      return { ok: true };
    },
    async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
    subscribeEvents(handler) { listeners.add(handler); return () => listeners.delete(handler); },
  };
  const adapters = new Map<string, HarnessAdapter>([[harness, adapter]]);
  const supervisor = () => new SessionSupervisor(adapters, { async convert() { return { success: true }; } } as any, undefined, {
    humanStopStore: new HumanStopStore(path), autoResumeFailedSessions: true, autoResumeDelayMs: 0,
  });
  return { current, adapters, supervisor, sendMessage, resumeSession, recover, forkSession, createSession,
    hide() { visible = false; }, show() { visible = true; },
    fail() { for (const handler of listeners) handler({ kind: "turn.failed", harness, sessionId: current.id }); },
  };
}

describe.each(["codex", "zcode"] as const)("%s explicit stop delivery boundary", (harness) => {
  it("answers a held hook and accepts fresh native prompt evidence without re-entering its blocked runtime", async () => {
    const f = fixture(harness);
    const store = new HumanStopStore(path);
    await store.hold(f.current, { id: "stop-before-hook", at: new Date(Date.now() - 1_000).toISOString(), reason: "explicit-stop" });
    const nativeRead = vi.fn(async () => { throw new Error("runtime is waiting for its UserPromptSubmit hook"); });
    f.adapters.get(harness)!.getSession = nativeRead;
    const supervisor = f.supervisor();
    await expect(supervisor.isAutomationHeld(harness, f.current.id)).resolves.toBe(true);
    await expect(supervisor.releaseHumanStop(harness, f.current.id, {
      id: "native-human-prompt", at: new Date().toISOString(), text: "fresh genuine request", turnId: "next-human-turn",
    })).resolves.toBe(true);
    expect(nativeRead).not.toHaveBeenCalled();
    expect(await store.isHeld(harness, f.current.id)).toBe(false);
  });
  it("accepts an explicit stop of an already idle chat and persists the fence without interrupting a nonexistent turn", async () => {
    const f = fixture(harness);
    f.current.status = "idle";
    const stopRpc = vi.fn(async () => ({ ok: false, error: "No active native turn" }));
    f.adapters.get(harness)!.stopSession = stopRpc;
    await expect(f.supervisor().stopSession(harness, f.current.id)).resolves.toEqual({ ok: true });
    expect(stopRpc).not.toHaveBeenCalled();
    expect(await getHumanStopStore().isHeld(harness, f.current.id)).toBe(true);
    await expect(f.supervisor().sendMessage(harness, f.current.id, { message: "automatic wake" })).resolves.toMatchObject({ ok: false });
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
  it("blocks replacement when an earlier ancestor stops while another source is being inspected", async () => {
    const f = fixture(harness);
    const adapter = f.adapters.get(harness)!;
    const originalGet = adapter.getSession.bind(adapter);
    adapter.getSession = async (id) => {
      if (id === "planner-ancestor") {
        await getHumanStopStore().hold(f.current, {
          id: "stop-during-ancestor-read", at: new Date().toISOString(), reason: "explicit-stop",
        });
        return { ...f.current, id, title: "planner ancestor" };
      }
      return originalGet(id);
    };
    const result = await newOrResumeNamedSession(f.adapters, {
      harness, name: "replacement with a different name", cwd: root, message: "automatic work",
      sourceSessions: [
        { harness, sessionId: f.current.id },
        { harness, sessionId: "planner-ancestor" },
      ],
    });
    expect(result).toMatchObject({ ok: false, created: false, delivery: "not_attempted" });
    expect(f.createSession).not.toHaveBeenCalled();
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
  it("survives supervisor restart and suppresses failure recovery, delivery and missing-session replacement", async () => {
    const f = fixture(harness);
    const initial = f.supervisor();
    const stopInitial = initial.startObservation(60_000);
    observers.push(stopInitial);
    await initial.stopSession(harness, f.current.id);
    stopInitial();
    const restarted = f.supervisor();
    observers.push(restarted.startObservation(60_000));
    f.fail();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(f.resumeSession).not.toHaveBeenCalled();
    expect(await restarted.sendMessage(harness, f.current.id, { message: "automatic continuation" })).toMatchObject({ ok: false });
    expect(await newOrResumeNamedSession(f.adapters, { harness, name: f.current.title, cwd: root, message: "automatic continuation" })).toMatchObject({ ok: false, created: false });
    f.hide();
    expect(await createNamedSession(f.adapters, { harness, name: f.current.title, cwd: root })).toMatchObject({ ok: false, created: false });
    expect(await newOrResumeNamedSession(f.adapters, { harness, name: "different replacement name", cwd: root, sourceSessionId: f.current.id, message: "automatic replacement" })).toMatchObject({ ok: false, created: false });
    expect(f.createSession).not.toHaveBeenCalled();
    expect(f.sendMessage).not.toHaveBeenCalled();
    f.show();
    await restarted.sendMessage(harness, f.current.id, { message: "new explicit user request", origin: "human" });
    expect(f.sendMessage).toHaveBeenCalledOnce();
    expect(await getHumanStopStore().isHeld(harness, f.current.id)).toBe(false);
  });

  it("MCP stop cannot be overridden by an automatic send/resume but accepts deliberate human resume", async () => {
    const f = fixture(harness);
    await handleStopAgent(f.adapters, { harness, sessionId: f.current.id });
    await handleSendMessage(f.adapters, { harness, sessionId: f.current.id, message: "automatic message" });
    await handleResumeAgent(f.adapters, { harness, sessionId: f.current.id, message: "automatic resume" });
    expect(f.sendMessage).not.toHaveBeenCalled();
    expect(f.resumeSession).not.toHaveBeenCalled();
    await handleResumeAgent(f.adapters, { harness, sessionId: f.current.id, message: "human requested resume", humanRequested: true });
    expect(f.resumeSession).toHaveBeenCalledOnce();
    expect(f.sendMessage).toHaveBeenCalledOnce();
    expect(await getHumanStopStore().isHeld(harness, f.current.id)).toBe(false);
  });

  it("blocks automatic recovery and fork behind a human stop but permits deliberate requests", async () => {
    const f = fixture(harness);
    const supervisor = f.supervisor();
    await supervisor.stopSession(harness, f.current.id);

    await expect(supervisor.recoverSession(harness, f.current.id, "automatic recovery")).resolves.toMatchObject({ ok: false });
    await expect(supervisor.forkSession(harness, f.current.id, "automatic fork")).resolves.toMatchObject({ ok: false });
    expect(f.recover).not.toHaveBeenCalled();
    expect(f.forkSession).not.toHaveBeenCalled();
    expect(await getHumanStopStore().isHeld(harness, f.current.id)).toBe(true);

    await expect(supervisor.recoverSession(harness, f.current.id, "requested recovery", undefined, true)).resolves.toMatchObject({ ok: true });
    expect(f.recover).toHaveBeenCalledOnce();
    expect(await getHumanStopStore().isHeld(harness, f.current.id)).toBe(false);
    await supervisor.stopSession(harness, f.current.id);
    await expect(supervisor.forkSession(harness, f.current.id, "requested fork", true)).resolves.toMatchObject({ ok: true });
    expect(f.forkSession).toHaveBeenCalledOnce();
    expect(await getHumanStopStore().isHeld(harness, f.current.id)).toBe(false);
  });

  it("rejects generated UserPromptSubmit evidence by turn and accepts identical text from a later human turn", async () => {
    const f = fixture(harness);
    const supervisor = f.supervisor();
    const store = new HumanStopStore(path);
    await store.hold({ harness, id: f.current.id }, {
      id: "explicit-stop", at: new Date(Date.now() - 2_000).toISOString(), reason: "interrupted", turnId: "stopped-turn",
    });
    const text = "continue with the requested change";
    await store.rememberGeneratedPrompt(harness, f.current.id, text);
    await store.rememberGeneratedPrompt(harness, f.current.id, text, "generated-turn");

    await expect(supervisor.releaseHumanStop(harness, f.current.id, {
      id: "generated-prompt-event", at: new Date().toISOString(), turnId: "generated-turn", text,
    })).resolves.toBe(false);
    await expect(store.isHeld(harness, f.current.id)).resolves.toBe(true);
    await expect(supervisor.releaseHumanStop(harness, f.current.id, {
      id: "genuine-human-prompt", at: new Date(Date.now() + 1_000).toISOString(), turnId: "later-human-turn", text,
    })).resolves.toBe(true);
    await expect(store.isHeld(harness, f.current.id)).resolves.toBe(false);
  });
});
