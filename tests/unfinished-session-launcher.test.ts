import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  SessionAutostartStore,
  UnfinishedSessionLauncher,
  UnfinishedSessionStore,
} from "../src/autopilot/unfinished-session-launcher.js";
import type { AgentSession, HarnessAdapter, HarnessEvent } from "../src/types/index.js";

function fixtureSession(status: AgentSession["status"] = "idle"): AgentSession {
  return {
    id: "session-1",
    harness: "zcode",
    status,
    title: "Незавершённая проверка",
    cwd: "/tmp/autostart-canary",
    lastActivity: "2026-10-03T12:00:00.000Z",
    model: "account:zai-individual-coding-plan/GLM-5.3-Flash$high",
    needsPermission: status === "needs_input",
    messageCount: 2,
  };
}

function enabledSettings(root: string) {
  return { settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}) };
}

function fixtureAdapter(session: AgentSession, calls: { resumes: number; messages: string[] }): HarnessAdapter {
  return {
    type: "zcode",
    name: "ZCode fixture",
    async init() {},
    async listSessions() { return [{ ...session }]; },
    async getSession(id) { return id === session.id ? { ...session } : null; },
    async sendMessage(id, input) {
      expect(id).toBe(session.id);
      calls.messages.push(input.message);
      return { ok: true };
    },
    async resumeSession(id) {
      expect(id).toBe(session.id);
      calls.resumes += 1;
      return { ok: true };
    },
    async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; },
    async setPermissions() { return { ok: true }; },
  };
}

describe("unfinished session launcher", () => {
  it("persists a running autopilot turn and starts the same session after a fresh process", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const settings = enabledSettings(root);
    const calls = { resumes: 0, messages: [] as string[] };
    const adapter = fixtureAdapter(fixtureSession("idle"), calls);
    const adapters = new Map<string, HarnessAdapter>([["zcode", adapter]]);
    const first = new UnfinishedSessionLauncher({ adapters, store, ...settings, retryDelayMs: 0 });

    await first.handleEvent("zcode", { kind: "turn.started", harness: "zcode", sessionId: "session-1" });
    expect(await store.list()).toMatchObject([{
      harness: "zcode",
      sessionId: "session-1",
      cwd: "/tmp/autostart-canary",
      model: "account:zai-individual-coding-plan/GLM-5.3-Flash$high",
      attempts: 0,
    }]);

    const afterRestart = new UnfinishedSessionLauncher({ adapters, store, ...settings, retryDelayMs: 0 });
    await afterRestart.recoverPending();

    expect(calls.resumes).toBe(1);
    expect(calls.messages).toHaveLength(1);
    expect(calls.messages[0]).toContain("Продолжи незавершённую задачу");
    expect((await store.list())[0]).toMatchObject({ attempts: 1 });

    await afterRestart.handleEvent("zcode", { kind: "turn.completed", harness: "zcode", sessionId: "session-1" });
    expect(await store.list()).toEqual([]);
  });

  it("does not duplicate a turn that is still running and does not answer a human prompt", async () => {
    for (const status of ["running", "needs_input"] as const) {
      const root = await mkdtemp(join(tmpdir(), `agent-herder-autostart-${status}-`));
      const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
      const settings = enabledSettings(root);
      await store.markStarted(fixtureSession(status), "same-process");
      const calls = { resumes: 0, messages: [] as string[] };
      const launcher = new UnfinishedSessionLauncher({
        adapters: new Map([["zcode", fixtureAdapter(fixtureSession(status), calls)]]),
        store,
        ...settings,
        retryDelayMs: 0,
        generationId: "same-process",
      });

      await launcher.recoverPending();
      expect(calls).toEqual({ resumes: 0, messages: [] });
    }
  });

  it("does not trust a stale running status from the previous Herder generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-generation-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    await store.markStarted(fixtureSession("running"), "old-process");
    const calls = { resumes: 0, messages: [] as string[] };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", fixtureAdapter(fixtureSession("running"), calls)]]),
      store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}),
      retryDelayMs: 0,
      generationId: "new-process",
    });

    await launcher.recoverPending();

    expect(calls.resumes).toBe(1);
    expect(calls.messages).toHaveLength(1);
    expect((await store.list())[0]).toMatchObject({ generationId: "new-process", attempts: 1, state: "active" });
  });

  it("bounds restart retries and emits one Russian Notice Place incident", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-failure-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const settings = enabledSettings(root);
    await store.markStarted(fixtureSession("idle"));
    const notices: Array<{ title: string; body: string }> = [];
    const adapter = fixtureAdapter(fixtureSession("idle"), { resumes: 0, messages: [] });
    adapter.resumeSession = async () => ({ ok: false, error: "transport unavailable" });

    for (let restart = 0; restart < 5; restart += 1) {
      await new UnfinishedSessionLauncher({
        adapters: new Map([["zcode", adapter]]),
        store,
        ...settings,
        retryDelayMs: 0,
        maxAttempts: 3,
        notify: async (notice) => { notices.push(notice); },
      }).recoverPending();
    }

    expect((await store.list())[0]).toMatchObject({ attempts: 3, state: "exhausted" });
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toContain("Agent Herder");
    expect(notices[0].body).toContain("ZCode");
    expect(notices[0].body).toContain("не запущена");
  });

  it("is independent from autopilot, defaults on, and supports a per-session opt-out", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-setting-"));
    const settingsStore = new SessionAutostartStore(join(root, "settings.json"), {});
    expect(await settingsStore.getEffective("codex", "codex-1", "/tmp/codex")).toMatchObject({ enabled: true, source: "default" });
    expect(await settingsStore.getEffective("zcode", "session-1", "/tmp/autostart-canary")).toMatchObject({ enabled: true, source: "default" });

    await settingsStore.setSession({ harness: "zcode", sessionId: "session-1", cwd: "/tmp/autostart-canary" }, false);
    expect(await settingsStore.getEffective("zcode", "session-1", "/tmp/autostart-canary")).toMatchObject({ enabled: false, source: "session" });
    expect(await settingsStore.getEffective("codex", "codex-1", "/tmp/codex")).toMatchObject({ enabled: true, source: "global" });
  });

  it("retries inside one Herder process and stops after the configured attempt budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-live-retry-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    await store.markStarted(fixtureSession("idle"));
    let resumes = 0;
    const adapter = fixtureAdapter(fixtureSession("idle"), { resumes: 0, messages: [] });
    adapter.resumeSession = async () => { resumes += 1; return { ok: false, error: "still unavailable" }; };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", adapter]]),
      store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}),
      maxAttempts: 3,
      retryDelayMs: 1,
    });
    const stop = launcher.start();
    for (let tick = 0; tick < 30 && resumes < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    stop();

    expect(resumes).toBe(3);
    expect((await store.list())[0]).toMatchObject({ attempts: 3, state: "exhausted" });
  });
});
