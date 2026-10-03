import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  completionEvidence,
  createAnthropicCompatibleSessionCompletionJudge,
  SessionAutostartStore,
  UnfinishedSessionLauncher,
  UnfinishedSessionStore,
} from "../src/autopilot/unfinished-session-launcher.js";
import type { AgentSession, HarnessAdapter, HarnessEvent } from "../src/types/index.js";

function fixtureSession(status: AgentSession["status"] = "idle", harness: "codex" | "zcode" = "zcode"): AgentSession {
  return {
    id: "session-1",
    harness,
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

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for launcher state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fixtureAdapter(session: AgentSession, calls: { resumes: number; messages: string[] }): HarnessAdapter {
  return {
    type: session.harness,
    name: `${session.harness} fixture`,
    async init() {},
    async listSessions() { return [{ ...session }]; },
    async getSession(id) { return id === session.id ? { ...session } : null; },
    async getSessionMessages(id) {
      if (id !== session.id) return null;
      return [{ id: "message-1", role: "user", text: "Продолжи.", parts: [{ type: "text", text: "Продолжи." }] }];
    },
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
  it("always gives MiniMax the latest user request and latest model answer", () => {
    const evidence = completionEvidence([
      { id: "u-old", role: "user", text: "старый запрос", parts: [{ type: "text", text: "старый запрос" }] },
      { id: "a-last", role: "assistant", text: `ответ-модели-${"а".repeat(1_500)}`, parts: [{ type: "text", text: `ответ-модели-${"а".repeat(1_500)}` }] },
      { id: "tool", role: "tool", text: "шум инструмента", parts: [{ type: "tool_result", output: "шум инструмента" }] },
      { id: "u-last", role: "user", text: `последний-запрос-${"б".repeat(1_500)}`, parts: [{ type: "text", text: `последний-запрос-${"б".repeat(1_500)}` }] },
    ], 2);

    expect(evidence).toContain("АГЕНТ: ответ-модели-");
    expect(evidence).toContain("ПОЛЬЗОВАТЕЛЬ: последний-запрос-");
    expect(evidence).not.toContain("старый запрос");
    expect(evidence).not.toContain("шум инструмента");
    expect(evidence).toContain("а".repeat(1_500));
    expect(evidence).toContain("б".repeat(1_500));
    expect(evidence.length).toBeGreaterThan(3_000);
  });

  it("classifies through the direct Anthropic endpoint with an explicit cache breakpoint", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const judge = createAnthropicCompatibleSessionCompletionJudge({
      baseUrl: "https://api.minimax.io/anthropic/",
      model: "MiniMax-M3",
      token: "test-token",
      fetchImpl: async (url, init) => {
        requestUrl = String(url);
        requestInit = init;
        return new Response(JSON.stringify({ content: [{ type: "text", text: '{"verdict":"unfinished","reason":"Работа оборвана","confidence":0.97}' }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(judge.decide({ session: fixtureSession("idle", "codex"), transcriptTail: "ПОЛЬЗОВАТЕЛЬ: продолжи" }))
      .resolves.toEqual({ verdict: "unfinished", reason: "Работа оборвана", confidence: 0.97 });
    expect(requestUrl).toBe("https://api.minimax.io/anthropic/v1/messages");
    expect(new Headers(requestInit?.headers).get("authorization")).toBe("Bearer test-token");
    const body = JSON.parse(String(requestInit?.body)) as { model: string; system: Array<{ cache_control?: { type?: string } }> };
    expect(body.model).toBe("MiniMax-M3");
    expect(body.system[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("sends one direct Anthropic batch request with every full session evidence block", async () => {
    let requestBody: Record<string, unknown> = {};
    const judge = createAnthropicCompatibleSessionCompletionJudge({
      baseUrl: "https://api.minimax.io/anthropic/",
      model: "MiniMax-M3.1-Flash-Preview",
      token: "test-token",
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ groups: [{
          source_session_ids: ["codex-1", "zcode-1"], primary_session_id: "zcode-1", verdict: "unfinished",
          reason: "Одна задача оборвалась в двух клиентах", confidence: 0.98,
          topic: "Восстановить отправку комментариев", handoff: "Общий handoff обеих сессий",
        }] }) }] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const evidence = "ПОЛЬЗОВАТЕЛЬ: полный запрос\n\nАГЕНТ: полный ответ";
    const plan = await judge.plan?.({ sessions: [
      { session: { ...fixtureSession("idle", "codex"), id: "codex-1" }, transcriptTail: `${evidence} codex-marker` },
      { session: { ...fixtureSession("idle", "zcode"), id: "zcode-1" }, transcriptTail: `${evidence} zcode-marker` },
    ] });

    expect(plan?.groups).toMatchObject([{ sourceSessionIds: ["codex-1", "zcode-1"], primarySessionId: "zcode-1", topic: "Восстановить отправку комментариев" }]);
    expect(JSON.stringify(requestBody)).toContain("codex-marker");
    expect(JSON.stringify(requestBody)).toContain("zcode-marker");
    expect(JSON.stringify(requestBody)).toContain("последние четыре полных смысловых сообщения");
    expect(requestBody.max_tokens).toBe(32_768);
  });

  it("plans all Codex and ZCode evidence once, deduplicates one task, and launches one readable continuation", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-batch-plan-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const settingsStore = new SessionAutostartStore(join(root, "settings.json"), {});
    const now = Date.now() - 5 * 60_000;
    const sessions: AgentSession[] = [
      { ...fixtureSession("idle", "zcode"), id: "duplicate-old", title: "Починить комментарии", cwd: "/workspace/video", lastActivity: new Date(now - 60_000).toISOString() },
      { ...fixtureSession("idle", "zcode"), id: "duplicate-new", title: "Комментарии снова не отправляются", cwd: "/workspace/video", model: "account:zai-start-plan/GLM-5.3-Flash", lastActivity: new Date(now).toISOString() },
    ];
    await store.upsertInventory({
      harness: "zcode", sessionId: "duplicate-old", cwd: "/workspace/video", title: "Починить комментарии",
      status: "idle", lastActivity: sessions[0]!.lastActivity, transcriptTail: "старый сохранённый хвост", observedAt: new Date().toISOString(),
      verdict: { verdict: "completed", reason: "Предыдущая оценка могла быть ошибочной", confidence: 0.6, judgedAt: new Date().toISOString() },
    });
    const created: AgentSession = { ...sessions[1]!, id: "merged-session", status: "running", title: "Автопродолжение — Восстановить отправку комментариев" };
    const names: string[] = [];
    const models: Array<string | undefined> = [];
    const prompts: string[] = [];
    const adapter: HarnessAdapter = {
      type: "zcode", name: "fixture", async init() {}, async listSessions() { return sessions; },
      async getSession(id) { return id === created.id ? created : sessions.find((session) => session.id === id) || null; },
      async getSessionMessages(id) {
        return [
          { id: `${id}-u1`, role: "user", text: `${id}-полный-запрос-1`, parts: [{ type: "text", text: `${id}-полный-запрос-1` }] },
          { id: `${id}-a1`, role: "assistant", text: `${id}-полный-ответ-1`, parts: [{ type: "text", text: `${id}-полный-ответ-1` }] },
          { id: `${id}-u2`, role: "user", text: `${id}-полный-запрос-2`, parts: [{ type: "text", text: `${id}-полный-запрос-2` }] },
          { id: `${id}-a2`, role: "assistant", text: `${id}-полный-ответ-2`, parts: [{ type: "text", text: `${id}-полный-ответ-2` }] },
        ];
      },
      async createSession(options) { names.push(options.name); models.push(options.model); return { ...created, model: options.model }; },
      async sendMessage(id, input) { expect(id).toBe(created.id); prompts.push(input.message); return { ok: true }; },
      async resumeSession() { return { ok: true }; }, async stopSession() { return { ok: true }; },
      async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
    };
    let planned: Array<{ session: AgentSession; transcriptTail: string }> = [];
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", adapter]]), store, settingsStore, discoveryIdleMs: 1, retryDelayMs: 0,
      judge: {
        async decide() { throw new Error("per-session fallback must not run"); },
        async plan(input) {
          planned = input.sessions;
          return { groups: [{
            sourceSessionIds: ["duplicate-new", "duplicate-old"], primarySessionId: "duplicate-new",
            verdict: "unfinished", reason: "Одна задача оборвалась в двух сессиях", confidence: 0.99,
            topic: "Восстановить отправку комментариев",
            handoff: "Проверено в обеих сессиях: исправление начато, остались тест и production-canary.",
          }] };
        },
      },
    });
    await launcher.recoverPending();

    expect(planned).toHaveLength(2);
    expect(planned.map((item) => item.session.id).sort()).toEqual(["duplicate-new", "duplicate-old"]);
    for (const item of planned) {
      expect(item.transcriptTail).toContain(`${item.session.id}-полный-запрос-1`);
      expect(item.transcriptTail).toContain(`${item.session.id}-полный-ответ-2`);
    }
    expect(names).toEqual(["Автопродолжение — Восстановить отправку комментариев"]);
    expect(models).toEqual(["account:zai-individual-coding-plan/GLM-5.3-Flash$high"]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("исправление начато, остались тест и production-canary");
    expect(prompts[0]).toContain("duplicate-new");
    expect(prompts[0]).toContain("duplicate-old");
    await expect(settingsStore.getEffective("zcode", "duplicate-new", "/workspace/video")).resolves.toMatchObject({ enabled: false, source: "session" });
    await expect(settingsStore.getEffective("zcode", "duplicate-old", "/workspace/video")).resolves.toMatchObject({ enabled: false, source: "session" });
    expect((await store.list()).map((record) => record.sessionId)).toEqual(["merged-session"]);
  });

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

  it("prioritizes the most recently interrupted backlog when the cycle budget is full", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-priority-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const older = { ...fixtureSession("idle", "codex"), id: "older" };
    const newer = { ...fixtureSession("idle", "codex"), id: "newer" };
    await store.markStarted(older, "previous-process");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.markStarted(newer, "previous-process");
    const resumed: string[] = [];
    const adapter: HarnessAdapter = {
      type: "codex", name: "fixture", async init() {}, async listSessions() { return []; },
      async getSession(id) { return id === newer.id ? newer : id === older.id ? older : null; },
      async resumeSession(id) { resumed.push(id); return { ok: true }; },
      async sendMessage() { return { ok: true }; },
      async stopSession() { return { ok: true }; }, async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
    };
    await new UnfinishedSessionLauncher({
      adapters: new Map([["codex", adapter]]), store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}),
      retryDelayMs: 0, discoveryIdleMs: 1, maxResumesPerCycle: 1, generationId: "new-process",
    }).recoverPending();
    expect(resumed).toEqual(["newer"]);
  });

  it("defers Codex continuation when the Desktop writer still owns the thread", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-busy-writer-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const session = { ...fixtureSession("idle", "codex"), lastActivity: new Date(Date.now() - 60_000).toISOString() };
    await store.markStarted(session, "previous-process");
    const deferred: Array<{ id: string; sessionId: string; message: string; createdAt: string }> = [];
    const adapter = fixtureAdapter(session, { resumes: 0, messages: [] });
    adapter.listSessions = async () => [];
    adapter.sendMessage = async () => ({ ok: false, error: `thread ${session.id} already has an active writer` });
    await new UnfinishedSessionLauncher({
      adapters: new Map([["codex", adapter]]), store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}),
      retryDelayMs: 0, discoveryIdleMs: 1, generationId: "new-process",
      deferredStore: {
        async list(id) { return deferred.filter((message) => message.sessionId === id); },
        async add(sessionId, message) {
          const item = { id: `deferred-${deferred.length + 1}`, sessionId, message, createdAt: new Date().toISOString() };
          deferred.push(item);
          return item;
        },
      },
    }).recoverPending();
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.message).toContain("Продолжи незавершённую задачу");
    expect(await store.list()).toMatchObject([{ sessionId: session.id, state: "active", generationId: "new-process" }]);
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

  it.each(["codex", "zcode"] as const)("does not duplicate a %s running session from the previous Herder generation", async (harness) => {
    const root = await mkdtemp(join(tmpdir(), `agent-herder-autostart-generation-${harness}-`));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const session = fixtureSession("running", harness);
    await store.markStarted(session, "old-process");
    const calls = { resumes: 0, messages: [] as string[] };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([[harness, fixtureAdapter(session, calls)]]),
      store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}),
      retryDelayMs: 0,
      generationId: "new-process",
    });

    await launcher.recoverPending();

    expect(calls).toEqual({ resumes: 0, messages: [] });
    expect((await store.list())[0]).toMatchObject({ generationId: "new-process", attempts: 0, state: "active" });
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

  it("migrates v1 settings and supports a harness-wide opt-out below the global default", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-v1-"));
    const path = join(root, "settings.json");
    await writeFile(path, JSON.stringify({ version: 1, enabled: true, sessions: [] }));
    const settingsStore = new SessionAutostartStore(path, {});
    expect(await settingsStore.getSettings()).toMatchObject({
      version: 3,
      enabled: true,
      inventoryWindowHours: 48,
      evidenceMessageCount: 4,
      judgeModel: "MiniMax-M3.1-Flash-Preview",
      autopilotJudgeModel: "MiniMax-M3",
      harnesses: [],
    });
    await settingsStore.setHarness("opencode", false);
    expect(await settingsStore.getEffective("opencode", "session-1", "/tmp/opencode")).toMatchObject({ enabled: false, source: "harness" });
    expect(await settingsStore.getEffective("codex", "session-2", "/tmp/codex")).toMatchObject({ enabled: true, source: "global" });
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
    for (let tick = 0; tick < 30 && (await store.list())[0]?.state !== "exhausted"; tick += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    stop();

    expect(resumes).toBe(3);
    expect((await store.list())[0]).toMatchObject({ attempts: 3, state: "exhausted" });
  });

  it("discovers an unfinished session from adapter history and reconciles it again without a process restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-reconcile-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const calls = { resumes: 0, messages: [] as string[] };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", fixtureAdapter(fixtureSession("idle"), calls)]]),
      store,
      ...enabledSettings(root),
      maxAttempts: 3,
      retryDelayMs: 0,
      reconcileIntervalMs: 10,
    });

    const stop = launcher.start();
    await waitUntil(() => calls.resumes === 1);
    await new Promise((resolve) => setTimeout(resolve, 35));
    stop();

    expect(calls.resumes).toBe(1);
    expect(calls.messages).toHaveLength(1);
  });

  it("does not prompt a running discovered session during repeated reconciliation", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-running-reconcile-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const calls = { resumes: 0, messages: [] as string[] };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", fixtureAdapter(fixtureSession("running"), calls)]]),
      store,
      ...enabledSettings(root),
      reconcileIntervalMs: 10,
    });

    const stop = launcher.start();
    for (let tick = 0; tick < 100 && (await store.list()).length === 0; tick += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    stop();

    expect(calls).toEqual({ resumes: 0, messages: [] });
    expect(await store.list()).toHaveLength(1);
  });

  it("keeps a completed session removed across later reconciliation cycles", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-completed-reconcile-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const calls = { resumes: 0, messages: [] as string[] };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", fixtureAdapter(fixtureSession("idle"), calls)]]),
      store,
      ...enabledSettings(root),
      retryDelayMs: 0,
      reconcileIntervalMs: 10,
    });

    const stop = launcher.start();
    await waitUntil(() => calls.resumes === 1);
    await launcher.handleEvent("zcode", { kind: "turn.completed", harness: "zcode", sessionId: "session-1" });
    await new Promise((resolve) => setTimeout(resolve, 35));
    stop();

    expect(calls.resumes).toBe(1);
    expect(await store.list()).toEqual([]);
  });

  it("stop clears the process-lifetime reconciliation timer", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-stop-reconcile-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    let lists = 0;
    const calls = { resumes: 0, messages: [] as string[] };
    const adapter = fixtureAdapter(fixtureSession("running"), calls);
    const listSessions = adapter.listSessions.bind(adapter);
    adapter.listSessions = async () => { lists += 1; return listSessions(); };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", adapter]]),
      store,
      ...enabledSettings(root),
      reconcileIntervalMs: 10,
    });

    const stop = launcher.start();
    await waitUntil(() => lists >= 2);
    stop();
    const stoppedAt = lists;
    await new Promise((resolve) => setTimeout(resolve, 35));

    expect(lists).toBe(stoppedAt);
  });

  it("rolls a stale session into a new cache handoff instead of resuming the expensive history", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-handoff-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const old = fixtureSession("idle", "codex");
    await store.markStarted(old);
    const calls = { resumes: 0, messages: [] as string[] };
    const oldAdapter = fixtureAdapter(old, calls);
    const next = { ...old, id: "session-2", status: "running" as const, lastActivity: "2026-10-03T13:00:00.000Z" };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["codex", oldAdapter]]), store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}), retryDelayMs: 0,
      cacheHandoff: { async maybeRollover() { return { kind: "rolled_over", session: next, ageMs: 3_600_000, cache: { ttlMs: 1_800_000, source: "openai-30m" } }; } },
    });
    await launcher.recoverPending();
    expect(calls.resumes).toBe(0);
    expect(await store.list()).toMatchObject([{ sessionId: "session-2", state: "active" }]);
  });

  it("discovers a recent stopped session whose last turn is still unanswered", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-discovery-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const session = { ...fixtureSession("idle", "codex"), lastActivity: new Date(Date.now() - 1_000).toISOString() };
    const calls = { resumes: 0, messages: [] as string[] };
    const candidate = fixtureAdapter(session, calls);
    candidate.getSessionMessages = async () => [{ id: "last", role: "user", text: "Продолжи", parts: [{ type: "text", text: "Продолжи" }] }];
    await new UnfinishedSessionLauncher({
      adapters: new Map([["codex", candidate]]), store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}), retryDelayMs: 0, discoveryIdleMs: 1,
    }).recoverPending();
    expect(calls.resumes).toBe(1);
    expect(calls.messages).toHaveLength(1);
    expect(await store.list()).toMatchObject([{ sessionId: "session-1", state: "active" }]);
  });

  it("records but never double-prompts a session that its harness still reports as running", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-running-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const session = { ...fixtureSession("running", "zcode"), lastActivity: new Date(Date.now() - 1_000).toISOString() };
    const calls = { resumes: 0, messages: [] as string[] };
    const candidate = fixtureAdapter(session, calls);
    await new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", candidate]]), store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}), retryDelayMs: 0, discoveryIdleMs: 1,
    }).recoverPending();
    expect(calls.resumes).toBe(0);
    expect(calls.messages).toHaveLength(0);
    expect(await store.list()).toMatchObject([{ sessionId: "session-1", state: "active" }]);
  });

  it("continues only the newest duplicate task discovered in the same harness and workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-dedupe-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const base = { ...fixtureSession("idle", "zcode"), title: "Проверка доступности рабочего каталога" };
    const sessions = [
      { ...base, id: "old", lastActivity: new Date(Date.now() - 3_600_000).toISOString() },
      { ...base, id: "new", lastActivity: new Date(Date.now() - 1_800_000).toISOString() },
    ];
    const resumed: string[] = [];
    const adapter: HarnessAdapter = {
      type: "zcode", name: "fixture", async init() {}, async listSessions() { return sessions; },
      async getSession(id) { return sessions.find((session) => session.id === id) || null; },
      async getSessionMessages(id) { return [{ id: `${id}-user`, role: "user", text: "Проверь", parts: [{ type: "text", text: "Проверь" }] }]; },
      async resumeSession(id) { resumed.push(id); return { ok: true }; }, async sendMessage() { return { ok: true }; },
      async stopSession() { return { ok: true }; }, async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
    };
    await new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", adapter]]), store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}), retryDelayMs: 0, discoveryIdleMs: 1,
    }).recoverPending();
    expect(resumed).toEqual(["new"]);
    expect((await store.list()).map((record) => record.sessionId)).toEqual(["new"]);
    expect((await store.listInventory()).find((record) => record.sessionId === "old")?.verdict?.reason).toContain("Заменена более новой сессией");
  });

  it("persists a MiniMax completed verdict and never resumes that session", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-judge-complete-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const session = { ...fixtureSession("idle", "codex"), lastActivity: new Date(Date.now() - 30 * 60_000).toISOString() };
    const calls = { resumes: 0, messages: [] as string[] };
    let judgedTail = "";
    await new UnfinishedSessionLauncher({
      adapters: new Map([["codex", fixtureAdapter(session, calls)]]), store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}), discoveryIdleMs: 1,
      judge: { async decide(input) { judgedTail = input.transcriptTail; return { verdict: "completed", reason: "Задача завершена", confidence: 0.98 }; } },
    }).recoverPending();

    expect(judgedTail).toContain("Продолжи.");
    expect(judgedTail.length).toBeLessThanOrEqual(2_000);
    expect(calls).toEqual({ resumes: 0, messages: [] });
    expect(await store.list()).toEqual([]);
    expect(await store.listInventory()).toMatchObject([{ sessionId: "session-1", verdict: { verdict: "completed", confidence: 0.98 } }]);
  });

  it("bounds MiniMax attempts per reconciliation cycle even when the judge is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-judge-budget-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const base = { ...fixtureSession("idle", "zcode"), lastActivity: new Date(Date.now() - 30 * 60_000).toISOString() };
    const sessions = ["one", "two", "three"].map((id, index) => ({ ...base, id, title: `Task ${index}` }));
    const adapter = fixtureAdapter(sessions[0]!, { resumes: 0, messages: [] });
    adapter.listSessions = async () => sessions;
    adapter.getSessionMessages = async (id) => [{ id: `${id}-user`, role: "user", text: "Продолжи", parts: [{ type: "text", text: "Продолжи" }] }];
    let attempts = 0;
    const settingsStore = new SessionAutostartStore(join(root, "settings.json"), {});
    await settingsStore.setHarness("zcode", false);
    await new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", adapter]]), store,
      settingsStore, discoveryIdleMs: 1,
      maxJudgementsPerCycle: 2,
      judge: { async decide() { attempts += 1; throw new Error("offline"); } },
    }).recoverPending();

    expect(attempts).toBe(2);
    expect(await store.list()).toEqual([]);
    expect(await store.listInventory()).toHaveLength(3);
  });

  it("queues a successful continuation and retries the same idle unfinished session after the cooldown", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-idle-again-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const session = { ...fixtureSession("idle", "zcode"), lastActivity: new Date(Date.now() - 30 * 60_000).toISOString() };
    await store.markStarted(session, "previous-process");
    const calls = { resumes: 0, messages: [] as string[] };
    const queues: Array<boolean | undefined> = [];
    const adapter = fixtureAdapter(session, calls);
    const send = adapter.sendMessage.bind(adapter);
    adapter.sendMessage = async (id, input) => { queues.push(input.queue); return send(id, input); };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", adapter]]), store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}),
      generationId: "current-process", retryDelayMs: 0, discoveryIdleMs: 5,
    });

    await launcher.recoverPending();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await launcher.recoverPending();

    expect(calls.resumes).toBe(2);
    expect(queues).toEqual([true, true]);
  });
});
