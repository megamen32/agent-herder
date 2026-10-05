import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  completionEvidence,
  createAnthropicCompatibleSessionCompletionJudge,
  enforcePlanWorkspaceBoundaries,
  estimateBatchPlannerInputTokens,
  estimateContextTokens,
  fitBatchContext,
  fitBatchContextForSerializedRequest,
  SessionAutostartStore,
  UnfinishedSessionLauncher,
  UnfinishedSessionStore,
} from "../src/autopilot/unfinished-session-launcher.js";
import { CacheHandoffService } from "../src/cache-handoff.js";
import { LineageStore } from "../src/lineage-store.js";
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

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
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
  it("always gives MiniMax the first user goal, latest request, and latest model answer", () => {
    const evidence = completionEvidence([
      { id: "u-old", role: "user", text: "старый запрос", parts: [{ type: "text", text: "старый запрос" }] },
      { id: "a-last", role: "assistant", text: `ответ-модели-${"а".repeat(1_500)}`, parts: [{ type: "text", text: `ответ-модели-${"а".repeat(1_500)}` }] },
      { id: "tool", role: "tool", text: "шум инструмента", parts: [{ type: "tool_result", output: "шум инструмента" }] },
      { id: "u-last", role: "user", text: `последний-запрос-${"б".repeat(1_500)}`, parts: [{ type: "text", text: `последний-запрос-${"б".repeat(1_500)}` }] },
    ], 2);

    expect(evidence).toContain("АГЕНТ: ответ-модели-");
    expect(evidence).toContain("ПОЛЬЗОВАТЕЛЬ: последний-запрос-");
    expect(evidence).toContain("ПЕРВЫЙ ПОЛЬЗОВАТЕЛЬСКИЙ ЗАПРОС");
    expect(evidence).toContain("старый запрос");
    expect(evidence).not.toContain("шум инструмента");
    expect(evidence).toContain("а".repeat(1_500));
    expect(evidence).toContain("б".repeat(1_500));
    expect(evidence.length).toBeGreaterThan(3_000);
  });

  it("keeps explicit first-goal and fresh-tail sections even for a one-message session", () => {
    const evidence = completionEvidence([
      { id: "u-only", role: "user", text: "single task", parts: [{ type: "text", text: "single task" }] },
    ]);
    expect(evidence).toContain("ПЕРВЫЙ ПОЛЬЗОВАТЕЛЬСКИЙ ЗАПРОС:\nПОЛЬЗОВАТЕЛЬ: single task");
    expect(evidence).toContain("ПОСЛЕДНИЙ СМЫСЛОВОЙ КОНТЕКСТ:\nПОЛЬЗОВАТЕЛЬ: single task");
  });

  it("fairly packs every 48-hour candidate under one conservative token budget", () => {
    const sessions = ["a", "b", "c"].map((id) => ({
      session: { ...fixtureSession("idle", "zcode"), id },
      transcriptTail: `ПЕРВЫЙ ПОЛЬЗОВАТЕЛЬСКИЙ ЗАПРОС:\nцель-${id}\n\nПОСЛЕДНИЙ СМЫСЛОВОЙ КОНТЕКСТ:\n${id.repeat(12_000)}`,
    }));
    const packed = fitBatchContext(sessions, 6_000);
    expect(packed).toHaveLength(3);
    for (const candidate of packed) {
      expect(candidate.transcriptTail).toContain(`цель-${candidate.session.id}`);
      expect(candidate.transcriptTail).toContain("ПОСЛЕДНИЙ СМЫСЛОВОЙ КОНТЕКСТ");
    }
    expect(estimateBatchPlannerInputTokens(packed)).toBeLessThanOrEqual(6_000);
  });

  it("fits the final escaped JSON request under 480k tokens", () => {
    const hostile = `${'"\\\n'.repeat(70_000)}конец`;
    const sessions = Array.from({ length: 6 }, (_, index) => ({
      session: { ...fixtureSession("idle", index % 2 ? "zcode" : "codex"), id: `escaped-${index}` },
      transcriptTail: `ПЕРВЫЙ ПОЛЬЗОВАТЕЛЬСКИЙ ЗАПРОС:\nцель-${index}\n\nПОСЛЕДНИЙ СМЫСЛОВОЙ КОНТЕКСТ:\n${hostile}`,
    }));
    const buildRequest = (packed: typeof sessions) => ({
      model: "MiniMax-M3.1-Flash-Preview",
      system: [{ type: "text", text: "planner" }],
      messages: [{ role: "user", content: JSON.stringify({ sessions: packed.map((candidate) => ({
        id: candidate.session.id,
        semantic_context: candidate.transcriptTail,
      })) }) }],
    });
    const fitted = fitBatchContextForSerializedRequest(sessions, 480_000, buildRequest);
    expect(fitted.sessions).toHaveLength(sessions.length);
    expect(fitted.estimatedTokens).toBe(estimateContextTokens(JSON.stringify(fitted.request)));
    expect(fitted.estimatedTokens).toBeLessThanOrEqual(480_000);
    for (const candidate of fitted.sessions) {
      expect(candidate.transcriptTail).toContain("ПЕРВЫЙ ПОЛЬЗОВАТЕЛЬСКИЙ ЗАПРОС");
      expect(candidate.transcriptTail).toContain("ПОСЛЕДНИЙ СМЫСЛОВОЙ КОНТЕКСТ");
    }
  });

  it("refuses an impossible metadata-only batch instead of exceeding the input ceiling", () => {
    const sessions = Array.from({ length: 40 }, (_, index) => ({
      session: { ...fixtureSession("idle", "zcode"), id: `session-${index}-${"x".repeat(200)}` },
      transcriptTail: "короткий хвост",
    }));

    expect(() => fitBatchContext(sessions, 1_000)).toThrow(/above the 1000 token ceiling/);
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
        const planText = JSON.stringify({ groups: [{
          source_session_ids: ["S1"], primary_session_id: "S1", verdict: "unfinished",
          reason: "Первая часть задачи оборвалась", confidence: 0.98,
          topic: "Дубль аудита t-proxy", handoff: "Первая часть общего handoff",
        }, {
          source_session_ids: ["S2"], primary_session_id: "S2", verdict: "unfinished",
          reason: "Вторая часть той же задачи оборвалась", confidence: 0.97,
          topic: "Дубль аудита t-proxy", handoff: "Вторая часть общего handoff",
        }, {
          source_session_ids: ["S2"], primary_session_id: "S2", verdict: "unfinished",
          reason: "Ошибочный повтор группы", confidence: 0.1,
          topic: "Повтор", handoff: "Повторный handoff",
        }, {
          source_session_ids: [], primary_session_id: "S2", verdict: "completed",
          reason: "Пустая группа модели", confidence: 0.1, topic: "Пусто", handoff: "",
        }, {
          source_session_ids: ["S3"], primary_session_id: "S2", verdict: "unfinished",
          reason: "Модель забыла сводку", confidence: 0.7, topic: "Пропущенная задача", handoff: "",
        }] });
        const split = Math.floor(planText.length / 2);
        const stream = [
          `data: ${JSON.stringify({ type: "content_block_start", content_block: { type: "text", text: "" } })}`,
          `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "grouping" } })}`,
          `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: planText.slice(0, split) } })}`,
          `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: planText.slice(split) } })}`,
          "data: [DONE]",
          "",
        ].join("\n\n");
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    const evidence = "ПОЛЬЗОВАТЕЛЬ: полный запрос\n\nАГЕНТ: полный ответ";
    const plan = await judge.plan?.({ sessions: [
      { session: { ...fixtureSession("idle", "codex"), id: "codex-1" }, transcriptTail: `${evidence} codex-marker` },
      { session: { ...fixtureSession("idle", "zcode"), id: "zcode-1" }, transcriptTail: `${evidence} zcode-marker` },
      { session: { ...fixtureSession("idle", "codex"), id: "omitted-1", title: "Пропущенная задача" }, transcriptTail: `${evidence} omitted-marker` },
    ] });

    expect(plan?.groups[0]).toMatchObject({
      sourceSessionIds: [
        "codex:codex-1:/tmp/autostart-canary",
        "zcode:zcode-1:/tmp/autostart-canary",
      ],
      primarySessionId: "codex:codex-1:/tmp/autostart-canary",
      topic: "Аудит t-proxy",
    });
    expect(plan?.groups[0]?.handoff).toContain("Первая часть общего handoff");
    expect(plan?.groups[0]?.handoff).toContain("Вторая часть общего handoff");
    expect(plan?.groups).toHaveLength(2);
    expect(plan?.groups[1]).toMatchObject({
      sourceSessionIds: ["codex:omitted-1:/tmp/autostart-canary"],
      primarySessionId: "codex:omitted-1:/tmp/autostart-canary",
      verdict: "needs_human", confidence: 0, topic: "Пропущенная задача",
    });
    expect(JSON.stringify(requestBody)).toContain("codex-marker");
    expect(JSON.stringify(requestBody)).toContain("zcode-marker");
    expect(JSON.stringify(requestBody)).toContain("первый пользовательский запрос");
    expect(JSON.stringify(requestBody)).toContain("semantic_context");
    expect(JSON.stringify(requestBody)).toContain("session_ref");
    expect(JSON.stringify(requestBody)).toContain("S1");
    expect(requestBody.max_tokens).toBe(16_384);
    expect(requestBody.stream).toBe(true);
    expect(requestBody.output_config).toEqual({ effort: "low" });
  });

  it("rejects a syntactically valid MiniMax plan that omits an assessed session", async () => {
    const judge = createAnthropicCompatibleSessionCompletionJudge({
      baseUrl: "https://api.minimax.io/anthropic/",
      model: "MiniMax-M3.1-Flash-Preview",
      token: "test-token",
      fetchImpl: async () => {
        const planText = JSON.stringify({ groups: [{
          source_session_ids: ["S1"], primary_session_id: "S1", verdict: "completed",
          reason: "done", confidence: 1, topic: "First", handoff: "",
        }] });
        return new Response([
          `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: planText } })}`,
          "data: [DONE]",
          "",
        ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });

    await expect(judge.plan?.({ sessions: [
      { session: { ...fixtureSession("idle", "codex"), id: "covered" }, transcriptTail: "covered evidence" },
      { session: { ...fixtureSession("idle", "zcode"), id: "omitted" }, transcriptTail: "omitted evidence" },
    ] })).rejects.toThrow(/omitted 1 session/);
  });

  it("rejects a compact reconciliation that omits a chunk group", async () => {
    const judge = createAnthropicCompatibleSessionCompletionJudge({
      baseUrl: "https://api.minimax.io/anthropic/",
      model: "MiniMax-M3.1-Flash-Preview",
      token: "test-token",
      fetchImpl: async () => {
        const text = JSON.stringify({ clusters: [["G1"]] });
        return new Response([
          `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}`,
          "data: [DONE]",
          "",
        ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    const groups = ["G1", "G2"].map((groupRef) => ({
      groupRef,
      workspaceIdentity: "/workspace",
      topic: `Topic ${groupRef}`,
      verdict: "completed" as const,
      reason: "done",
      handoff: "",
      sourceSessionIds: [`source-${groupRef}`],
      memberTitles: [`Title ${groupRef}`],
      humanGate: false,
    }));

    await expect(judge.reconcile?.({ groups })).rejects.toThrow(/omitted 1 group/);
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
      verdict: { verdict: "needs_human", reason: "Предыдущая оценка не завершилась", confidence: 0, judgedAt: new Date().toISOString() },
    });
    const created: AgentSession = { ...sessions[1]!, id: "merged-session", status: "running", title: "Автопродолжение — Восстановить отправку комментариев" };
    const names: string[] = [];
    const models: Array<string | undefined> = [];
    const modes: Array<string | undefined> = [];
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
      async createSession(options) { names.push(options.name); models.push(options.model); modes.push(options.mode); return { ...created, model: options.model }; },
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
    expect(modes).toEqual(["yolo"]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/^Автопродолжение — Восстановить отправку комментариев\n\n/);
    expect(prompts[0]).toContain("исправление начато, остались тест и production-canary");
    expect(prompts[0]).toContain("duplicate-new");
    expect(prompts[0]).toContain("duplicate-old");
    await expect(settingsStore.getEffective("zcode", "duplicate-new", "/workspace/video")).resolves.toMatchObject({ enabled: false, source: "session" });
    await expect(settingsStore.getEffective("zcode", "duplicate-old", "/workspace/video")).resolves.toMatchObject({ enabled: false, source: "session" });
    expect((await store.list()).map((record) => record.sessionId)).toEqual(["merged-session"]);
  });

  it("partitions a mixed MiniMax group by cwd without splitting legitimate same-workspace duplicates", () => {
    const sessions = [
      { ...fixtureSession("idle", "codex"), id: "A1", cwd: "/workspace/a" },
      { ...fixtureSession("idle", "codex"), id: "A2", cwd: "/workspace/a" },
      { ...fixtureSession("idle", "codex"), id: "B1", cwd: "/workspace/b" },
    ];
    const candidates = new Map(sessions.map((session) => [session.id, { session, transcriptTail: session.id }]));
    const result = enforcePlanWorkspaceBoundaries({ groups: [{
      sourceSessionIds: ["A1", "A2", "B1"], primarySessionId: "A2", verdict: "unfinished",
      reason: "Same task", confidence: 1, topic: "Finish Agent Herder", handoff: "Combined handoff",
    }] }, candidates);

    expect(result.groups).toMatchObject([
      { sourceSessionIds: ["A1", "A2"], primarySessionId: "A2", verdict: "needs_human", confidence: 0 },
      { sourceSessionIds: ["B1"], primarySessionId: "B1", verdict: "needs_human", confidence: 0 },
    ]);
  });

  it("keeps equal native session ids separate when their workspace identities differ", () => {
    const left = { ...fixtureSession("idle", "zcode"), id: "same-id", cwd: "/workspace/a", meta: { workspaceIdentity: "workspace-a" } };
    const right = { ...fixtureSession("idle", "zcode"), id: "same-id", cwd: "/workspace/b", meta: { workspaceIdentity: "workspace-b" } };
    const leftKey = "zcode:same-id:workspace-a";
    const rightKey = "zcode:same-id:workspace-b";
    const candidates = new Map([
      [leftKey, { session: left, transcriptTail: "left" }],
      [rightKey, { session: right, transcriptTail: "right" }],
    ]);
    const result = enforcePlanWorkspaceBoundaries({ groups: [{
      sourceSessionIds: [leftKey, rightKey], primarySessionId: rightKey, verdict: "unfinished",
      reason: "same id", confidence: 1, topic: "Two workspaces", handoff: "unsafe merge",
    }] }, candidates);
    expect(result.groups).toMatchObject([
      { sourceSessionIds: [leftKey], primarySessionId: leftKey, verdict: "needs_human", confidence: 0 },
      { sourceSessionIds: [rightKey], primarySessionId: rightKey, verdict: "needs_human", confidence: 0 },
    ]);
  });

  it("stores each workspace-qualified source exactly once and prunes stale snapshot members", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-qualified-inventory-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const base = {
      harness: "zcode" as const, sessionId: "same-id", title: "Task", status: "idle" as const,
      lastActivity: new Date().toISOString(), transcriptTail: "evidence", observedAt: new Date().toISOString(),
    };
    await store.upsertInventoryBatch([
      { ...base, cwd: "/a", workspaceIdentity: "workspace-a" },
      { ...base, cwd: "/b", workspaceIdentity: "workspace-b" },
      { ...base, sessionId: "stale", cwd: "/stale", workspaceIdentity: "workspace-stale" },
    ]);
    await store.upsertInventory({ ...base, cwd: "/a", workspaceIdentity: "workspace-a", title: "Task refreshed" });
    expect(await store.reconcileInventorySnapshot(new Set(["zcode"]), new Set([
      "zcode:same-id:workspace-a",
      "zcode:same-id:workspace-b",
    ]))).toBe(1);
    expect((await store.listInventory()).map((record) => `${record.workspaceIdentity}:${record.title}`).sort()).toEqual([
      "workspace-a:Task refreshed",
      "workspace-b:Task",
    ]);
  });

  it("never merges or completes same-topic sessions from different workspaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-cross-workspace-dedupe-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const sessions: AgentSession[] = [
      { ...fixtureSession("idle", "codex"), id: "root-work", title: "Finish Agent Herder", cwd: "/home/roomhacker/agents-projects", lastActivity: new Date(Date.now() - 10_000).toISOString() },
      { ...fixtureSession("idle", "codex"), id: "canary", title: "Finish Agent Herder", cwd: "/tmp/agent-herder-codex-canary", lastActivity: new Date().toISOString() },
    ];
    const calls = { resumes: 0, messages: [] as string[] };
    const adapter = fixtureAdapter(sessions[0]!, calls);
    adapter.listSessions = async () => sessions;
    adapter.getSession = async (id) => sessions.find((session) => session.id === id) ?? null;
    adapter.getSessionMessages = async (id) => [{ id: `${id}-u`, role: "user", text: "Finish Agent Herder", parts: [{ type: "text", text: "Finish Agent Herder" }] }];
    const settingsStore = new SessionAutostartStore(join(root, "settings.json"), {});
    await new UnfinishedSessionLauncher({
      adapters: new Map([["codex", adapter]]), store, settingsStore, discoveryIdleMs: 1,
      judge: {
        async decide() { throw new Error("fallback should not run"); },
        async plan() {
          return { groups: [{
            sourceSessionIds: ["root-work", "canary"], primarySessionId: "canary", verdict: "unfinished" as const,
            reason: "Same topic", confidence: 1, topic: "Finish Agent Herder", handoff: "Continue the combined task",
          }] };
        },
      },
    }).recoverPending();

    expect(calls).toEqual({ resumes: 0, messages: [] });
    expect(await store.listInventory()).toMatchObject([
      { sessionId: "canary", verdict: { verdict: "needs_human", confidence: 0 } },
      { sessionId: "root-work", verdict: { verdict: "needs_human", confidence: 0 } },
    ]);
    await expect(settingsStore.getEffective("codex", "root-work", sessions[0]!.cwd)).resolves.toMatchObject({ enabled: true, source: "default" });
    await expect(settingsStore.getEffective("codex", "canary", sessions[1]!.cwd)).resolves.toMatchObject({ enabled: true, source: "default" });
  });

  it("resumes the same broken session while its provider cache is still fresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-fresh-cache-resume-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const session: AgentSession = {
      ...fixtureSession("idle", "zcode"),
      lastActivity: new Date(Date.now() - 270_000).toISOString(),
    };
    const calls = { resumes: 0, messages: [] as string[] };
    const adapter = fixtureAdapter(session, calls);
    let created = 0;
    adapter.createSession = async () => { created += 1; return { ...session, id: `replacement-${created}` }; };
    const settingsStore = new SessionAutostartStore(join(root, "settings.json"), {});
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", adapter]]), store,
      settingsStore,
      judge: {
        async decide() { throw new Error("fallback should not run"); },
        async plan() {
          return { groups: [{
            sourceSessionIds: [session.id], primarySessionId: session.id, verdict: "unfinished",
            reason: "Сессия оборвалась", confidence: 0.99, topic: "Продолжить проверку",
            handoff: "Проверить текущее состояние и продолжить с последнего шага.",
          }] };
        },
      },
    });
    await launcher.recoverPending();
    await launcher.recoverPending();

    expect(calls.resumes).toBe(2);
    expect(calls.messages).toHaveLength(2);
    expect(calls.messages[0]).toContain("Продолжить проверку");
    expect(created).toBe(0);
    await expect(settingsStore.getEffective("zcode", session.id, session.cwd)).resolves.toMatchObject({ enabled: true });
    expect((await store.list())).toMatchObject([{ sessionId: session.id, state: "active" }]);
  });

  it("does not enqueue another continuation while the previous Herder prompt still awaits an assistant response", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-awaiting-continuation-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const session = { ...fixtureSession("idle", "codex"), lastActivity: new Date(Date.now() - 5 * 60_000).toISOString() };
    const calls = { resumes: 0, messages: [] as string[] };
    const adapter = fixtureAdapter(session, calls);
    adapter.getSessionMessages = async () => [
      { id: "goal", role: "user", text: "Доделай Agent Herder", parts: [{ type: "text", text: "Доделай Agent Herder" }] },
      { id: "progress", role: "assistant", text: "Исправления внесены, запускаю тесты.", parts: [{ type: "text", text: "Исправления внесены, запускаю тесты." }] },
      { id: "queued", role: "user", text: "Автопродолжение — Тестирование Agent Herder\n\nПроверь состояние и продолжи.", parts: [{ type: "text", text: "Автопродолжение — Тестирование Agent Herder\n\nПроверь состояние и продолжи." }] },
    ];
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["codex", adapter]]), store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}),
      discoveryIdleMs: 1,
      judge: {
        async decide() { throw new Error("fallback should not run"); },
        async plan() {
          return { groups: [{
            sourceSessionIds: [session.id], primarySessionId: session.id, verdict: "unfinished",
            reason: "Нужно дождаться тестов", confidence: 0.99, topic: "Тестирование Agent Herder", handoff: "Проверить тесты.",
          }] };
        },
      },
    });

    await launcher.recoverPending();
    await launcher.recoverPending();

    expect(calls.resumes).toBe(0);
    expect(calls.messages).toEqual([]);
    expect(await store.listInventory()).toMatchObject([{ sessionId: session.id, verdict: { verdict: "unfinished" } }]);
  });

  it.each([
    { status: "needs_input" as const, needsPermission: false },
    { status: "idle" as const, needsPermission: true },
  ])("keeps a $status/$needsPermission human gate out of planner launches", async ({ status, needsPermission }) => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-human-gate-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const session = {
      ...fixtureSession(status, "zcode"),
      needsPermission,
      lastActivity: new Date(Date.now() - 5 * 60_000).toISOString(),
    };
    const calls = { resumes: 0, messages: [] as string[] };
    await new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", fixtureAdapter(session, calls)]]), store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}),
      discoveryIdleMs: 1,
      judge: {
        async decide() { throw new Error("fallback should not run"); },
        async plan() {
          return { groups: [{
            sourceSessionIds: [session.id], primarySessionId: session.id, verdict: "unfinished",
            reason: "Continue autonomously", confidence: 1, topic: "Human-gated task", handoff: "Continue.",
          }] };
        },
      },
    }).recoverPending();

    expect(calls).toEqual({ resumes: 0, messages: [] });
    expect(await store.list()).toEqual([]);
    expect(await store.listInventory()).toMatchObject([{
      sessionId: session.id,
      verdict: { verdict: "needs_human", confidence: 1 },
    }]);
  });

  it("keeps every source in a human-gated task blocked across discovery cycles", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-group-human-gate-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const sessions: AgentSession[] = [
      {
        ...fixtureSession("needs_input", "zcode"),
        id: "human-gate",
        lastActivity: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
      {
        ...fixtureSession("idle", "zcode"),
        id: "resumable-sibling",
        needsPermission: false,
        lastActivity: new Date(Date.now() - 6 * 60_000).toISOString(),
      },
    ];
    const calls = { resumes: 0, messages: [] as string[] };
    let plans = 0;
    const adapter = fixtureAdapter(sessions[0]!, calls);
    adapter.listSessions = async () => sessions;
    adapter.getSession = async (id) => sessions.find((session) => session.id === id) || null;
    adapter.getSessionMessages = async (id) => [{ id: `${id}-goal`, role: "user", text: `Goal ${id}`, parts: [{ type: "text", text: `Goal ${id}` }] }];
    adapter.resumeSession = async () => { calls.resumes += 1; return { ok: true }; };
    adapter.sendMessage = async (_id, input) => { calls.messages.push(input.message); return { ok: true }; };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", adapter]]), store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}),
      discoveryIdleMs: 1,
      judge: {
        async decide() { throw new Error("fallback should not run"); },
        async plan() {
          plans += 1;
          return { groups: [{
            sourceSessionIds: sessions.map((session) => session.id),
            primarySessionId: "resumable-sibling",
            verdict: "unfinished",
            reason: "Continue the sibling",
            confidence: 1,
            topic: "One human-gated task",
            handoff: "Continue.",
          }] };
        },
      },
    });

    await launcher.recoverPending();
    await launcher.recoverPending();

    expect(plans).toBe(1);
    expect(calls).toEqual({ resumes: 0, messages: [] });
    const verdicts = (await store.listInventory()).map((record) => record.verdict);
    expect(verdicts).toHaveLength(2);
    expect(verdicts.every((verdict) => verdict?.verdict === "needs_human"
      && verdict.confidence === 1
      && verdict.reason === "Объединённая задача ожидает ответа или разрешения человека")).toBe(true);
  });

  it("never replaces a fresh-cache session when same-ID continuation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-fresh-cache-failure-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const session = { ...fixtureSession("idle", "zcode"), lastActivity: new Date(Date.now() - 270_000).toISOString() };
    let created = 0;
    const adapter = fixtureAdapter(session, { resumes: 0, messages: [] });
    adapter.resumeSession = async () => ({ ok: false, error: "temporary ZCode attach failure" });
    adapter.createSession = async () => { created += 1; return { ...session, id: "replacement" }; };
    await new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", adapter]]), store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}),
      judge: {
        async decide() { throw new Error("fallback should not run"); },
        async plan() {
          return { groups: [{
            sourceSessionIds: [session.id], primarySessionId: session.id, verdict: "unfinished",
            reason: "Сессия оборвалась", confidence: 0.99, topic: "Продолжить проверку", handoff: "Продолжить.",
          }] };
        },
      },
    }).recoverPending();

    expect(created).toBe(0);
    expect(await store.listInventory()).toMatchObject([{ sessionId: session.id, verdict: { verdict: "unfinished" } }]);
  });

  it("resumes an expired session in place when cache rollover is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-rollover-disabled-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const settingsStore = new SessionAutostartStore(join(root, "settings.json"), {});
    await settingsStore.setRuntimeSettings({
      inventoryWindowHours: 48,
      evidenceMessageCount: 4,
      judgeModel: "MiniMax-M3.1-Flash-Preview",
      autopilotJudgeModel: "MiniMax-M3",
      rolloverExpiredCache: false,
    });
    const session = { ...fixtureSession("idle", "zcode"), lastActivity: new Date(Date.now() - 10 * 60_000).toISOString() };
    const calls = { resumes: 0, messages: [] as string[] };
    let created = 0;
    const adapter = fixtureAdapter(session, calls);
    adapter.createSession = async () => { created += 1; return { ...session, id: "replacement" }; };
    await new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", adapter]]), store, settingsStore, discoveryIdleMs: 1,
      judge: {
        async decide() { throw new Error("fallback should not run"); },
        async plan() {
          return { groups: [{
            sourceSessionIds: [session.id], primarySessionId: session.id, verdict: "unfinished",
            reason: "Сессия оборвалась", confidence: 0.99, topic: "Продолжить проверку", handoff: "Продолжить.",
          }] };
        },
      },
    }).recoverPending();

    expect(calls.resumes).toBe(1);
    expect(calls.messages).toHaveLength(1);
    expect(created).toBe(0);
  });

  it("defers a fresh Codex batch continuation when the Desktop writer is busy", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-batch-busy-writer-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const session = { ...fixtureSession("idle", "codex"), model: "gpt-5.6-sol", lastActivity: new Date(Date.now() - 5 * 60_000).toISOString() };
    let created = 0;
    const deferred: Array<{ id: string; sessionId: string; message: string; createdAt: string }> = [];
    let plans = 0;
    const adapter = fixtureAdapter(session, { resumes: 0, messages: [] });
    adapter.resumeSession = async () => ({ ok: false, error: `thread ${session.id} already has an active writer` });
    adapter.createSession = async () => { created += 1; return { ...session, id: "replacement" }; };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["codex", adapter]]), store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}), discoveryIdleMs: 1,
      deferredStore: {
        async list(id) { return deferred.filter((message) => message.sessionId === id); },
        async add(sessionId, message) {
          const item = { id: `deferred-${deferred.length + 1}`, sessionId, message, createdAt: new Date().toISOString() };
          deferred.push(item);
          return item;
        },
      },
      judge: {
        async decide() { throw new Error("fallback should not run"); },
        async plan() {
          plans += 1;
          return { groups: [{
            sourceSessionIds: [session.id], primarySessionId: session.id, verdict: "unfinished",
            reason: "Сессия оборвалась", confidence: 0.99, topic: "Продолжить проверку", handoff: `Продолжить, формулировка ${plans}.`,
          }] };
        },
      },
    });
    await launcher.recoverPending();
    await launcher.recoverPending();

    expect(created).toBe(0);
    expect(plans).toBe(2);
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.sessionId).toBe(session.id);
    expect(deferred[0]?.message).toContain("Продолжить проверку");
    expect(await store.list()).toMatchObject([{ sessionId: session.id, state: "active" }]);
  });

  it("never falls back to per-session launches when the one batch plan fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-batch-no-fallback-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const calls = { resumes: 0, messages: [] as string[] };
    const session = { ...fixtureSession("idle", "codex"), lastActivity: new Date(Date.now() - 5 * 60_000).toISOString() };
    await store.markStarted(session, "previous-process");
    let individualDecisions = 0;
    await new UnfinishedSessionLauncher({
      adapters: new Map([["codex", fixtureAdapter(session, calls)]]), store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}), discoveryIdleMs: 1,
      judge: {
        async decide() { individualDecisions += 1; return { verdict: "unfinished", reason: "fallback", confidence: 1 }; },
        async plan() { throw new Error("batch timeout"); },
      },
    }).recoverPending();
    expect(individualDecisions).toBe(0);
    expect(calls).toEqual({ resumes: 0, messages: [] });
    expect(await store.list()).toMatchObject([{ sessionId: session.id, generationId: "previous-process", state: "active" }]);
  });

  it("applies none of a partial injected plan and leaves every assessed session undecided", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-batch-partial-atomic-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const sessions = [
      { ...fixtureSession("idle", "codex"), id: "covered", title: "Covered" },
      { ...fixtureSession("idle", "codex"), id: "omitted", title: "Omitted" },
    ];
    const calls = { resumes: 0, messages: [] as string[] };
    const adapter = fixtureAdapter(sessions[0]!, calls);
    adapter.listSessions = async () => sessions;
    adapter.getSession = async (id) => sessions.find((session) => session.id === id) || null;
    adapter.getSessionMessages = async (id) => [{ id: `${id}-u`, role: "user", text: id, parts: [{ type: "text", text: id }] }];
    await new UnfinishedSessionLauncher({
      adapters: new Map([["codex", adapter]]), store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}), discoveryIdleMs: 1,
      judge: {
        async decide() { throw new Error("fallback should not run"); },
        async plan() {
          return { groups: [{
            sourceSessionIds: ["covered"], primarySessionId: "covered", verdict: "unfinished",
            reason: "continue", confidence: 1, topic: "Covered", handoff: "continue covered",
          }] };
        },
      },
    }).recoverPending();

    expect(calls).toEqual({ resumes: 0, messages: [] });
    expect(await store.list()).toEqual([]);
    const inventory = await store.listInventory();
    expect(inventory.map((record) => record.sessionId).sort()).toEqual(["covered", "omitted"]);
    expect(inventory.every((record) => record.verdict === undefined)).toBe(true);
  });

  it("keeps a MiniMax-omitted candidate pending for the next batch without blindly resuming it", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-batch-omitted-retry-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const calls = { resumes: 0, messages: [] as string[] };
    const session = { ...fixtureSession("idle", "codex"), lastActivity: new Date(Date.now() - 5 * 60_000).toISOString() };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["codex", fixtureAdapter(session, calls)]]), store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}), discoveryIdleMs: 1,
      judge: {
        async decide() { throw new Error("fallback should not run"); },
        async plan() {
          return { groups: [{
            sourceSessionIds: [session.id], primarySessionId: session.id, verdict: "needs_human",
            reason: "MiniMax omitted this candidate", confidence: 0, topic: session.title, handoff: "",
          }] };
        },
      },
    });

    await launcher.recoverPending();

    expect(calls).toEqual({ resumes: 0, messages: [] });
    expect(await store.list()).toMatchObject([{ sessionId: session.id, state: "active", attempts: 0 }]);
    expect(await store.listInventory()).toMatchObject([{ sessionId: session.id, verdict: { verdict: "needs_human", confidence: 0 } }]);
  });

  it("sends a large inventory to MiniMax in one globally deduplicated request", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-batch-size-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const sessions = Array.from({ length: 33 }, (_, index): AgentSession => ({
      ...fixtureSession("idle", "codex"), id: `session-${index}`, title: `Task ${index}`,
      lastActivity: new Date(Date.now() - 10 * 60_000 - index).toISOString(),
    }));
    const sizes: number[] = [];
    const adapter = fixtureAdapter(sessions[0]!, { resumes: 0, messages: [] });
    adapter.listSessions = async () => sessions;
    adapter.getSessionMessages = async (id) => [{ id: `${id}-u`, role: "user", text: "done", parts: [{ type: "text", text: "done" }] }];
    await new UnfinishedSessionLauncher({
      adapters: new Map([["codex", adapter]]), store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}),
      judge: {
        async decide() { throw new Error("fallback should not run"); },
        async plan({ sessions: batch }) {
          sizes.push(batch.length);
          return { groups: batch.map(({ session }) => ({
            sourceSessionIds: [session.id], primarySessionId: session.id, verdict: "completed" as const,
            reason: "done", confidence: 1, topic: session.title, handoff: "",
          })) };
        },
        async reconcile({ groups }) {
          return { clusters: groups.map(({ groupRef }) => [groupRef]) };
        },
      },
    }).recoverPending();
    expect(sizes).toEqual([33]);
    expect(await store.listInventory()).toHaveLength(33);
  });

  it("partitions output-heavy inventories deterministically and applies only after every chunk is complete", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-batch-output-chunks-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const sessions = Array.from({ length: 70 }, (_, index): AgentSession => ({
      ...fixtureSession("idle", "codex"), id: `chunked-${index}`, title: `Chunked ${index}`,
      lastActivity: new Date(Date.now() - 10 * 60_000 - index).toISOString(),
    }));
    const sizes: number[] = [];
    const adapter = fixtureAdapter(sessions[0]!, { resumes: 0, messages: [] });
    adapter.listSessions = async () => sessions;
    adapter.getSessionMessages = async (id) => [{ id: `${id}-u`, role: "user", text: id, parts: [{ type: "text", text: id }] }];
    await new UnfinishedSessionLauncher({
      adapters: new Map([["codex", adapter]]), store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}), discoveryIdleMs: 1,
      judge: {
        async decide() { throw new Error("fallback should not run"); },
        async plan({ sessions: batch }) {
          sizes.push(batch.length);
          return { groups: batch.map(({ session }) => ({
            sourceSessionIds: [session.id], primarySessionId: session.id, verdict: "completed" as const,
            reason: "done", confidence: 1, topic: session.title, handoff: "",
          })) };
        },
        async reconcile({ groups }) {
          return { clusters: groups.map(({ groupRef }) => [groupRef]) };
        },
      },
    }).recoverPending();

    expect(sizes).toEqual([64, 6]);
    expect(await store.listInventory()).toHaveLength(70);
    expect((await store.listInventory()).every((record) => record.verdict?.verdict === "completed")).toBe(true);
  });

  it("shares one 480k evidence budget across chunk requests plus compact reconciliation overhead", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-global-chunk-budget-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const sessions = Array.from({ length: 70 }, (_, index): AgentSession => ({
      ...fixtureSession("idle", "codex"), id: `budgeted-${index}`, title: `Budgeted ${index}`,
      lastActivity: new Date(Date.now() - 10 * 60_000 - index).toISOString(),
    }));
    const requestBodies: unknown[] = [];
    const previousBudget = process.env.AGENT_HERDER_UNFINISHED_BATCH_CONTEXT_TOKENS;
    process.env.AGENT_HERDER_UNFINISHED_BATCH_CONTEXT_TOKENS = "480000";
    const judge = createAnthropicCompatibleSessionCompletionJudge({
      baseUrl: "https://api.minimax.io/anthropic/",
      model: "MiniMax-M3.1-Flash-Preview",
      token: "test-token",
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          system: Array<{ text: string }>;
          messages: Array<{ content: string }>;
        };
        requestBodies.push(body);
        const payload = JSON.parse(body.messages[0]!.content) as { sessions?: Array<{ session_ref: string }>; groups?: Array<{ group_ref: string }> };
        const text = body.system[0]!.text.includes("финальный дедупликатор")
          ? JSON.stringify({ clusters: (payload.groups || []).map(({ group_ref }) => [group_ref]) })
          : JSON.stringify({ groups: (payload.sessions || []).map(({ session_ref }) => ({
            source_session_ids: [session_ref], primary_session_id: session_ref, verdict: "completed",
            reason: "done", confidence: 1, topic: `Topic ${session_ref}`, handoff: "",
          })) });
        return new Response([
          `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}`,
          "data: [DONE]",
          "",
        ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    const adapter = fixtureAdapter(sessions[0]!, { resumes: 0, messages: [] });
    adapter.listSessions = async () => sessions;
    adapter.getSessionMessages = async (id) => [{
      id: `${id}-u`, role: "user", text: `${id}:${'"\\\n'.repeat(5_000)}`,
      parts: [{ type: "text", text: `${id}:${'"\\\n'.repeat(5_000)}` }],
    }];
    try {
      await new UnfinishedSessionLauncher({
        adapters: new Map([["codex", adapter]]), store,
        settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}), discoveryIdleMs: 1,
        judge,
      }).recoverPending();
    } finally {
      if (previousBudget === undefined) delete process.env.AGENT_HERDER_UNFINISHED_BATCH_CONTEXT_TOKENS;
      else process.env.AGENT_HERDER_UNFINISHED_BATCH_CONTEXT_TOKENS = previousBudget;
    }

    expect(requestBodies).toHaveLength(3);
    const totalTokens = requestBodies.reduce((sum, body) => sum + estimateContextTokens(JSON.stringify(body)), 0);
    expect(totalTokens).toBeLessThanOrEqual(512_000);
    expect(await store.listInventory()).toHaveLength(70);
  });

  it("globally reconciles one task split across the 64-session boundary into one send", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-cross-chunk-dedupe-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const sessions = Array.from({ length: 65 }, (_, index): AgentSession => ({
      ...fixtureSession("idle", "codex"), id: `cross-${index}`,
      title: index >= 63 ? `Shared interrupted task part ${index - 62}` : `Completed task ${index}`,
      cwd: "/workspace/cross-chunk",
      lastActivity: new Date(Date.now() - 60_000 - index).toISOString(),
    }));
    const resumed: string[] = [];
    const sent: Array<{ id: string; message: string }> = [];
    const adapter = fixtureAdapter(sessions[0]!, { resumes: 0, messages: [] });
    adapter.listSessions = async () => sessions;
    adapter.getSession = async (id) => sessions.find((session) => session.id === id) || null;
    adapter.getSessionMessages = async (id) => [{ id: `${id}-u`, role: "user", text: id, parts: [{ type: "text", text: id }] }];
    adapter.resumeSession = async (id) => { resumed.push(id); return { ok: true }; };
    adapter.sendMessage = async (id, input) => { sent.push({ id, message: input.message }); return { ok: true }; };
    await new UnfinishedSessionLauncher({
      adapters: new Map([["codex", adapter]]), store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}), discoveryIdleMs: 1,
      judge: {
        async decide() { throw new Error("fallback should not run"); },
        async plan({ sessions: batch }) {
          return { groups: batch.map(({ session }) => ({
            sourceSessionIds: [session.id], primarySessionId: session.id,
            verdict: session.id === "cross-63" || session.id === "cross-64" ? "unfinished" as const : "completed" as const,
            reason: "classified", confidence: 1,
            topic: session.id === "cross-63" || session.id === "cross-64" ? "Shared cross chunk task" : session.title,
            handoff: session.id === "cross-63" || session.id === "cross-64" ? `Continue ${session.id}` : "",
          })) };
        },
        async reconcile({ groups }) {
          const shared = groups.filter((group) => group.topic === "Shared cross chunk task");
          const other = groups.filter((group) => group.topic !== "Shared cross chunk task");
          return { clusters: [...other.map(({ groupRef }) => [groupRef]), shared.map(({ groupRef }) => groupRef)] };
        },
      },
    }).recoverPending();

    expect(resumed).toEqual(["cross-63"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: "cross-63" });
    expect(sent[0]?.message).toContain("Continue cross-63");
    expect(sent[0]?.message).toContain("Continue cross-64");
  });

  it("lets a human-gated member block its cross-chunk sibling after global reconciliation", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-cross-chunk-human-gate-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const sessions = Array.from({ length: 65 }, (_, index): AgentSession => ({
      ...fixtureSession(index === 64 ? "needs_input" : "idle", "codex"), id: `gated-${index}`,
      title: index >= 63 ? `Gated shared task part ${index - 62}` : `Completed gated test ${index}`,
      cwd: "/workspace/cross-chunk-gate",
      needsPermission: index === 64,
      lastActivity: new Date(Date.now() - 60_000 - index).toISOString(),
    }));
    const calls = { resumes: 0, messages: [] as string[] };
    const adapter = fixtureAdapter(sessions[0]!, calls);
    adapter.listSessions = async () => sessions;
    adapter.getSession = async (id) => sessions.find((session) => session.id === id) || null;
    adapter.getSessionMessages = async (id) => [{ id: `${id}-u`, role: "user", text: id, parts: [{ type: "text", text: id }] }];
    adapter.resumeSession = async () => { calls.resumes += 1; return { ok: true }; };
    adapter.sendMessage = async (_id, input) => { calls.messages.push(input.message); return { ok: true }; };
    await new UnfinishedSessionLauncher({
      adapters: new Map([["codex", adapter]]), store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}), discoveryIdleMs: 1,
      judge: {
        async decide() { throw new Error("fallback should not run"); },
        async plan({ sessions: batch }) {
          return { groups: batch.map(({ session }) => ({
            sourceSessionIds: [session.id], primarySessionId: session.id,
            verdict: session.id === "gated-63" || session.id === "gated-64" ? "unfinished" as const : "completed" as const,
            reason: "classified", confidence: 1,
            topic: session.id === "gated-63" || session.id === "gated-64" ? "Gated shared task" : session.title,
            handoff: session.id === "gated-63" || session.id === "gated-64" ? "Continue shared work" : "",
          })) };
        },
        async reconcile({ groups }) {
          const shared = groups.filter((group) => group.topic === "Gated shared task");
          const other = groups.filter((group) => group.topic !== "Gated shared task");
          return { clusters: [...other.map(({ groupRef }) => [groupRef]), shared.map(({ groupRef }) => groupRef)] };
        },
      },
    }).recoverPending();

    expect(calls).toEqual({ resumes: 0, messages: [] });
    const inventory = await store.listInventory();
    expect(inventory.find((record) => record.sessionId === "gated-64")?.verdict?.verdict).toBe("needs_human");
    expect(inventory.find((record) => record.sessionId === "gated-63")?.verdict?.verdict).toBe("needs_human");
  });

  it("prepends the adapter-owned first user request when the evidence tail is truncated", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-first-user-anchor-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const session = { ...fixtureSession("idle", "codex"), lastActivity: new Date(Date.now() - 10 * 60_000).toISOString() };
    const adapter = fixtureAdapter(session, { resumes: 0, messages: [] });
    adapter.getSessionMessages = async () => Array.from({ length: 200 }, (_, index) => ({
      id: `tail-${index}`,
      role: index % 2 ? "assistant" as const : "user" as const,
      text: `tail message ${index}`,
      parts: [{ type: "text" as const, text: `tail message ${index}` }],
    }));
    adapter.getFirstUserMessage = async () => ({
      id: "original-user",
      role: "user",
      text: "original task outside the bounded tail",
      parts: [{ type: "text", text: "original task outside the bounded tail" }],
    });
    let evidence = "";
    await new UnfinishedSessionLauncher({
      adapters: new Map([["codex", adapter]]),
      store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}),
      discoveryIdleMs: 1,
      judge: {
        async decide() { throw new Error("fallback should not run"); },
        async plan({ sessions }) {
          evidence = sessions[0]?.transcriptTail ?? "";
          return { groups: [{
            sourceSessionIds: [session.id], primarySessionId: session.id, verdict: "completed" as const,
            reason: "done", confidence: 1, topic: session.title, handoff: "",
          }] };
        },
      },
    }).recoverPending();

    expect(evidence).toContain("ПЕРВЫЙ ПОЛЬЗОВАТЕЛЬСКИЙ ЗАПРОС:\nПОЛЬЗОВАТЕЛЬ: original task outside the bounded tail");
    expect(evidence).toContain("tail message 199");
  });

  it("replans only new or changed sessions instead of the whole 48-hour inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-actionable-inventory-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const oldActivity = new Date(Date.now() - 10 * 60_000).toISOString();
    let sessions: AgentSession[] = [
      { ...fixtureSession("idle", "codex"), id: "settled", title: "Settled", lastActivity: oldActivity },
      { ...fixtureSession("idle", "codex"), id: "changed", title: "Changed", lastActivity: oldActivity },
    ];
    const batches: string[][] = [];
    const adapter = fixtureAdapter(sessions[0]!, { resumes: 0, messages: [] });
    adapter.listSessions = async () => sessions;
    adapter.getSessionMessages = async (id) => [{ id: `${id}-u`, role: "user", text: id, parts: [{ type: "text", text: id }] }];
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["codex", adapter]]), store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}),
      discoveryIdleMs: 1,
      judge: {
        async decide() { throw new Error("fallback should not run"); },
        async plan({ sessions: batch }) {
          batches.push(batch.map(({ session }) => session.id));
          return { groups: batch.map(({ session }) => ({
            sourceSessionIds: [session.id], primarySessionId: session.id, verdict: "completed" as const,
            reason: "done", confidence: 1, topic: session.title, handoff: "",
          })) };
        },
      },
    });

    await launcher.recoverPending();
    sessions = [
      sessions[0]!,
      { ...sessions[1]!, lastActivity: new Date(Date.now() - 5 * 60_000).toISOString() },
      { ...fixtureSession("idle", "codex"), id: "new", title: "New", lastActivity: oldActivity },
      { ...fixtureSession("running", "codex"), id: "healthy-running", title: "Running", lastActivity: new Date().toISOString() },
    ];
    await launcher.recoverPending();

    expect(batches).toEqual([["settled", "changed"], ["changed", "new"]]);
  });

  it("rebuilds legacy evidence and reaudits a changed disabled session without launching it", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-disabled-audit-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const settingsStore = new SessionAutostartStore(join(root, "settings.json"), {});
    let session = { ...fixtureSession("idle", "codex"), id: "disabled", lastActivity: new Date(Date.now() - 10 * 60_000).toISOString() };
    await settingsStore.setSession({ harness: "codex", sessionId: session.id, cwd: session.cwd }, false);
    await store.upsertInventory({
      harness: "codex", sessionId: session.id, cwd: session.cwd, title: session.title,
      status: session.status, lastActivity: session.lastActivity, transcriptTail: "legacy tail",
      observedAt: new Date().toISOString(),
      verdict: { verdict: "completed", reason: "legacy", confidence: 1, judgedAt: new Date().toISOString() },
    });
    const calls = { resumes: 0, messages: [] as string[] };
    const adapter = fixtureAdapter(session, calls);
    adapter.listSessions = async () => [session];
    adapter.getSessionMessages = async () => [{
      id: "u", role: "user", text: `goal-${session.lastActivity}`, parts: [{ type: "text", text: `goal-${session.lastActivity}` }],
    }];
    let plans = 0;
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["codex", adapter]]), store, settingsStore, discoveryIdleMs: 1,
      judge: {
        async decide() { throw new Error("fallback should not run"); },
        async plan({ sessions }) {
          plans += 1;
          return { groups: sessions.map(({ session: candidate }) => ({
            sourceSessionIds: [candidate.id], primarySessionId: candidate.id, verdict: "completed" as const,
            reason: "audited", confidence: 1, topic: candidate.title, handoff: "",
          })) };
        },
      },
    });

    await launcher.recoverPending();
    let inventory = await store.listInventory();
    expect(plans).toBe(1);
    expect(calls).toEqual({ resumes: 0, messages: [] });
    expect(inventory[0]).toMatchObject({ evidenceVersion: 1, verdict: { verdict: "completed" } });
    expect(inventory[0]?.transcriptTail).toContain("ПЕРВЫЙ ПОЛЬЗОВАТЕЛЬСКИЙ ЗАПРОС");
    expect(inventory[0]?.transcriptTail).toContain("ПОСЛЕДНИЙ СМЫСЛОВОЙ КОНТЕКСТ");

    session = { ...session, lastActivity: new Date(Date.now() - 5 * 60_000).toISOString() };
    await launcher.recoverPending();
    inventory = await store.listInventory();
    expect(plans).toBe(2);
    expect(calls).toEqual({ resumes: 0, messages: [] });
    expect(inventory[0]?.lastActivity).toBe(session.lastActivity);
    expect(inventory[0]?.transcriptTail).toContain(`goal-${session.lastActivity}`);
    expect(await store.list()).toEqual([]);
  });

  it("atomically migrates a legacy active key before one canonical session can send", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-legacy-identity-"));
    const statePath = join(root, "unfinished.json");
    const now = new Date(Date.now() - 10_000).toISOString();
    await writeFile(statePath, JSON.stringify({ version: 1, sessions: [{
      harness: "zcode", sessionId: "same-native", cwd: "/legacy", title: "Legacy", startedAt: now, updatedAt: now,
      generationId: "legacy", attempts: 0, state: "active",
    }], inventory: [{
      harness: "zcode", sessionId: "same-native", cwd: "/legacy", title: "Legacy", status: "idle",
      lastActivity: now, transcriptTail: "legacy", observedAt: now,
    }] }));
    const store = new UnfinishedSessionStore(statePath);
    const session = {
      ...fixtureSession("idle", "zcode"), id: "same-native", cwd: "/canonical", lastActivity: now,
      meta: { workspaceIdentity: "workspace-42" },
    };
    const calls = { resumes: 0, messages: [] as string[] };
    const adapter = fixtureAdapter(session, calls);
    adapter.getSessionSnapshotReceipt = () => ({ exhaustive: true, observedAt: new Date().toISOString(), source: "test" });
    await new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", adapter]]), store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}), discoveryIdleMs: 1,
      judge: {
        async decide() { throw new Error("fallback should not run"); },
        async plan() { return { groups: [{
          sourceSessionIds: [session.id], primarySessionId: session.id, verdict: "unfinished" as const,
          reason: "continue", confidence: 1, topic: "Canonical task", handoff: "continue once",
        }] }; },
      },
    }).recoverPending();
    expect(calls).toEqual({ resumes: 1, messages: [expect.stringContaining("continue once")] });
    expect(await store.list()).toHaveLength(1);
    expect((await store.list())[0]).toMatchObject({ sessionId: session.id, cwd: "/canonical", workspaceIdentity: "workspace-42" });
    expect(await store.listInventory()).toHaveLength(1);
    expect((await store.listInventory())[0]).toMatchObject({ sessionId: session.id, cwd: "/canonical", workspaceIdentity: "workspace-42" });
  });

  it("preserves a disabled ghost override and reaudits canonical evidence after identity rewrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-ghost-identity-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const settingsStore = new SessionAutostartStore(join(root, "settings.json"), {});
    const calls = { resumes: 0, messages: [] as string[] };
    let session: AgentSession = {
      ...fixtureSession("idle", "zcode"), id: "ghost", cwd: "/ghost",
      lastActivity: new Date(Date.now() - 20_000).toISOString(), meta: { workspaceIdentity: "ghost-workspace" },
    };
    let transcript = "ghost task completed";
    const adapter = fixtureAdapter(session, calls);
    adapter.listSessions = async () => [session];
    adapter.getSession = async () => session;
    adapter.getSessionMessages = async () => [{ id: "u", role: "user", text: transcript, parts: [{ type: "text", text: transcript }] }];
    adapter.getFirstUserMessage = async () => ({ id: "first", role: "user", text: transcript, parts: [{ type: "text", text: transcript }] });
    adapter.getSessionSnapshotReceipt = () => ({ exhaustive: true, observedAt: new Date().toISOString(), source: "test" });
    const plannedEvidence: string[] = [];
    let verdict: "completed" | "unfinished" = "completed";
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", adapter]]), store, settingsStore, discoveryIdleMs: 1,
      judge: {
        async decide() { throw new Error("fallback should not run"); },
        async plan({ sessions }) {
          plannedEvidence.push(sessions[0]!.transcriptTail);
          return { groups: [{
            sourceSessionIds: [session.id], primarySessionId: session.id, verdict,
            reason: verdict, confidence: 1, topic: "Ghost migration", handoff: verdict === "unfinished" ? "must not launch" : "",
          }] };
        },
      },
    });
    await launcher.recoverPending();
    await settingsStore.setSession({ harness: "zcode", sessionId: session.id, cwd: session.cwd }, false);

    verdict = "unfinished";
    transcript = "canonical task is unfinished";
    session = {
      ...session, cwd: "/canonical", lastActivity: new Date(Date.now() - 10_000).toISOString(),
      meta: { workspaceIdentity: "canonical-workspace" },
    };
    await launcher.recoverPending();

    expect(await settingsStore.getEffective("zcode", session.id, session.cwd)).toMatchObject({ enabled: false, source: "session", cwd: "/canonical" });
    expect(calls).toEqual({ resumes: 0, messages: [] });
    expect(plannedEvidence).toHaveLength(2);
    expect(plannedEvidence[1]).toContain("canonical task is unfinished");
    expect(plannedEvidence[1]).not.toContain("ghost task completed");
    expect(await store.listInventory()).toMatchObject([{
      sessionId: session.id, cwd: "/canonical", workspaceIdentity: "canonical-workspace",
      verdict: { verdict: "unfinished" },
    }]);
  });

  it("prunes unseen inventory only after an explicitly exhaustive adapter snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-snapshot-receipt-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const now = new Date(Date.now() - 10_000).toISOString();
    await store.upsertInventory({
      harness: "codex", sessionId: "unseen", cwd: "/tmp", title: "Unseen", status: "idle",
      lastActivity: now, transcriptTail: "legacy", observedAt: now,
    });
    const session = { ...fixtureSession("idle", "codex"), id: "visible", lastActivity: now };
    const adapter = fixtureAdapter(session, { resumes: 0, messages: [] });
    let exhaustive = false;
    adapter.getSessionSnapshotReceipt = () => ({ exhaustive, observedAt: new Date().toISOString(), source: "test" });
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["codex", adapter]]), store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}), discoveryIdleMs: 1,
      judge: { async decide() { throw new Error("fallback"); }, async plan({ sessions }) { return { groups: sessions.map(({ session: candidate }) => ({
        sourceSessionIds: [candidate.id], primarySessionId: candidate.id, verdict: "completed" as const,
        reason: "done", confidence: 1, topic: candidate.title, handoff: "",
      })) }; } },
    });
    await launcher.recoverPending();
    expect((await store.listInventory()).map((record) => record.sessionId).sort()).toEqual(["unseen", "visible"]);
    exhaustive = true;
    await launcher.recoverPending();
    expect((await store.listInventory()).map((record) => record.sessionId)).toEqual(["visible"]);
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
    expect((await store.list())[0]).toMatchObject({ attempts: 0 });

    await afterRestart.handleEvent("zcode", { kind: "turn.completed", harness: "zcode", sessionId: "session-1" });
    expect(await store.list()).toMatchObject([{ sessionId: "session-1", state: "active", attempts: 0 }]);
  });

  it("keeps non-Codex/ZCode infrastructure turns out of the unfinished registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-scope-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const session: AgentSession = { ...fixtureSession("running", "codex"), harness: "opencode", id: "health_diagnosis_1" };
    const adapter = fixtureAdapter(session, { resumes: 0, messages: [] });
    adapter.type = "opencode";
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["opencode", adapter]]), store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}),
    });

    await expect(launcher.armSession(session)).resolves.toBe(false);
    await launcher.handleEvent("opencode", { kind: "turn.completed", harness: "opencode", sessionId: session.id });

    expect(await store.list()).toEqual([]);
  });

  it("prunes legacy out-of-scope turns and inventory older than the configured window", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-prune-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const now = Date.now();
    await store.markStarted({ ...fixtureSession("idle", "codex"), harness: "opencode", id: "legacy-health" });
    await store.markStarted({ ...fixtureSession("idle", "codex"), id: "kept-codex" });
    await store.upsertInventory({
      harness: "codex", sessionId: "old", cwd: "/tmp", title: "Old", status: "idle",
      lastActivity: new Date(now - 49 * 60 * 60_000).toISOString(), transcriptTail: "old", observedAt: new Date(now).toISOString(),
    });
    await store.upsertInventory({
      harness: "codex", sessionId: "recent", cwd: "/tmp", title: "Recent", status: "idle",
      lastActivity: new Date(now - 47 * 60 * 60_000).toISOString(), transcriptTail: "recent", observedAt: new Date(now).toISOString(),
    });
    await store.upsertInventory({
      harness: "fast-agent", sessionId: "recent-fast-agent", cwd: "/tmp", title: "Recent Fast Agent", status: "stopped",
      lastActivity: new Date(now - 1 * 60 * 60_000).toISOString(), transcriptTail: "recent", observedAt: new Date(now).toISOString(),
    });
    await store.upsertInventory({
      harness: "opencode", sessionId: "recent-opencode", cwd: "/tmp", title: "Recent OpenCode", status: "idle",
      lastActivity: new Date(now - 1 * 60 * 60_000).toISOString(), transcriptTail: "recent", observedAt: new Date(now).toISOString(),
    });

    await expect(store.pruneAutocontinueScope(new Date(now - 48 * 60 * 60_000))).resolves.toEqual({ sessions: 1, inventory: 3 });
    expect((await store.list()).map((record) => record.sessionId)).toEqual(["kept-codex"]);
    expect((await store.listInventory()).map((record) => record.sessionId)).toEqual(["recent"]);
  });

  it("removes a disabled exhausted session instead of retaining a permanent alert", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-disabled-exhausted-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const session = fixtureSession("idle", "codex");
    await store.markStarted(session);
    const attempt = await store.beginAttempt("codex", session.id, 1, 0);
    expect(attempt).not.toBeNull();
    await store.markFailure("codex", session.id, "failed", 1);
    const settingsStore = new SessionAutostartStore(join(root, "settings.json"), {});
    await settingsStore.setSession({ harness: "codex", sessionId: session.id, cwd: session.cwd }, false);
    const launcher = new UnfinishedSessionLauncher({ adapters: new Map(), store, settingsStore });

    await launcher.recoverPending();

    expect(await store.list()).toEqual([]);
  });

  it("recovers a persisted ZCode turn even when fresh inventory cannot enumerate it", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-zcode-missing-inventory-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const session = fixtureSession("idle", "zcode");
    await store.markStarted(session, "previous-process");
    const calls = { resumes: 0, messages: [] as string[] };
    const adapter = fixtureAdapter(session, calls);
    adapter.listSessions = async () => [];
    let plans = 0;
    await new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", adapter]]), store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}),
      retryDelayMs: 0, generationId: "current-process",
      judge: {
        async decide() { throw new Error("no fresh candidate exists"); },
        async plan() { plans += 1; return { groups: [] }; },
      },
    }).recoverPending();

    expect(plans).toBe(0);
    expect(calls).toEqual({ resumes: 1, messages: [expect.stringContaining("Продолжи незавершённую задачу")] });
    expect(await store.list()).toMatchObject([{ sessionId: session.id, generationId: "current-process", state: "active" }]);
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

  it("resolves workspace override aliases by recency before migrating them", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-alias-recency-"));
    const settingsStore = new SessionAutostartStore(join(root, "settings.json"), {});
    const older = new Date("2026-10-05T00:00:00.000Z");
    const newer = new Date("2026-10-05T00:01:00.000Z");

    await settingsStore.setSession({ harness: "zcode", sessionId: "reenabled", cwd: "/legacy" }, false, older);
    await settingsStore.setSession({ harness: "zcode", sessionId: "reenabled", cwd: "/canonical" }, true, newer);
    expect(await settingsStore.getEffective("zcode", "reenabled", "/canonical")).toMatchObject({ enabled: true, cwd: "/canonical" });
    await settingsStore.migrateWorkspaceIdentities([{
      ...fixtureSession("idle", "zcode"), id: "reenabled", cwd: "/canonical", meta: { workspaceIdentity: "canonical" },
    }]);
    expect(await settingsStore.getEffective("zcode", "reenabled", "/canonical")).toMatchObject({ enabled: true, cwd: "/canonical" });

    await settingsStore.setSession({ harness: "zcode", sessionId: "disabled", cwd: "/legacy" }, true, older);
    await settingsStore.setSession({ harness: "zcode", sessionId: "disabled", cwd: "/canonical" }, false, newer);
    expect(await settingsStore.getEffective("zcode", "disabled", "/canonical")).toMatchObject({ enabled: false, cwd: "/canonical" });
    await settingsStore.migrateWorkspaceIdentities([{
      ...fixtureSession("idle", "zcode"), id: "disabled", cwd: "/canonical", meta: { workspaceIdentity: "canonical" },
    }]);
    expect(await settingsStore.getEffective("zcode", "disabled", "/canonical")).toMatchObject({ enabled: false, cwd: "/canonical" });
  });

  it("migrates v1 settings and supports a harness-wide opt-out below the global default", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-v1-"));
    const path = join(root, "settings.json");
    await writeFile(path, JSON.stringify({ version: 1, enabled: true, sessions: [] }));
    const settingsStore = new SessionAutostartStore(path, {});
    expect(await settingsStore.getSettings()).toMatchObject({
      version: 7,
      enabled: true,
      pinActiveSessions: true,
      rolloverExpiredCache: true,
      movePinnedOnRollover: true,
      inventoryWindowHours: 48,
      evidenceMessageCount: 200,
      judgeModel: "MiniMax-M3.1-Flash-Preview",
      autopilotJudgeModel: "MiniMax-M3",
      harnesses: [],
    });
    await settingsStore.setHarness("opencode", false);
    expect(await settingsStore.getEffective("opencode", "session-1", "/tmp/opencode")).toMatchObject({ enabled: false, source: "harness" });
    expect(await settingsStore.getEffective("codex", "session-2", "/tmp/codex")).toMatchObject({ enabled: true, source: "global" });
  });

  it("persists rollover choices and defaults legacy files to moving the pin", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-rollover-setting-"));
    const path = join(root, "settings.json");
    await writeFile(path, JSON.stringify({
      version: 3, enabled: true, inventoryWindowHours: 48, evidenceMessageCount: 4,
      judgeModel: "MiniMax-M3.1-Flash-Preview", autopilotJudgeModel: "MiniMax-M3", harnesses: [], sessions: [],
    }));
    const settingsStore = new SessionAutostartStore(path, {});
    await expect(settingsStore.getSettings()).resolves.toMatchObject({ version: 7, pinActiveSessions: true, rolloverExpiredCache: true, movePinnedOnRollover: true, evidenceMessageCount: 200, source: "persisted" });
    await settingsStore.setRuntimeSettings({
      inventoryWindowHours: 48,
      evidenceMessageCount: 4,
      judgeModel: "MiniMax-M3.1-Flash-Preview",
      autopilotJudgeModel: "MiniMax-M3",
      pinActiveSessions: false,
      rolloverExpiredCache: false,
      movePinnedOnRollover: false,
    });
    await expect(new SessionAutostartStore(path, {}).getSettings()).resolves.toMatchObject({ version: 7, pinActiveSessions: false, rolloverExpiredCache: false, movePinnedOnRollover: false, evidenceMessageCount: 4, source: "persisted" });
  });

  it("migrates v6 settings to v7 with active-session pinning enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-v6-"));
    const path = join(root, "settings.json");
    await writeFile(path, JSON.stringify({
      version: 6,
      enabled: true,
      rolloverExpiredCache: false,
      movePinnedOnRollover: false,
      inventoryWindowHours: 48,
      evidenceMessageCount: 200,
      watchdogEnabled: true,
      watchdogIntervalSeconds: 10,
      stalledTurnMinutes: 2,
      judgeModel: "MiniMax-M3.1-Flash-Preview",
      autopilotJudgeModel: "MiniMax-M3",
      harnesses: [],
      sessions: [],
    }));

    await expect(new SessionAutostartStore(path, {}).getSettings()).resolves.toMatchObject({
      version: 7,
      pinActiveSessions: true,
      rolloverExpiredCache: false,
      movePinnedOnRollover: false,
      source: "persisted",
    });
  });

  it("pins an armed Codex session and never removes the pin when its turn completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-pin-active-"));
    const session = fixtureSession("running", "codex");
    const adapter = fixtureAdapter(session, { resumes: 0, messages: [] });
    const pins: Array<[string, boolean]> = [];
    adapter.setSessionPinned = async (sessionId, pinned) => {
      pins.push([sessionId, pinned]);
      return { ok: true, sessionId };
    };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["codex", adapter]]),
      store: new UnfinishedSessionStore(join(root, "unfinished.json")),
      ...enabledSettings(root),
    });

    await expect(launcher.armSession(session)).resolves.toBe(true);
    await launcher.handleEvent("codex", { kind: "turn.completed", harness: "codex", sessionId: session.id });

    expect(pins).toEqual([[session.id, true]]);
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

  it("watchdog auto-approves permissions only for legacy ZCode autocontinue sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-zcode-permission-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const session: AgentSession = {
      ...fixtureSession("running", "zcode"),
      title: "Автопродолжение — Довести проверку",
      meta: { pendingRequestIds: ["perm-1"] },
    };
    await store.markStarted(session);
    const approvals: Array<[string, string, string, boolean | undefined]> = [];
    const adapter = fixtureAdapter(session, { resumes: 0, messages: [] });
    adapter.respondPermission = async (sessionId, permissionId, response, remember) => {
      approvals.push([sessionId, permissionId, response, remember]);
      return { ok: true };
    };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", adapter]]), store,
      ...enabledSettings(root),
      reconcileIntervalMs: 60_000,
      watchdogIntervalMs: 5,
    });

    const stop = launcher.start();
    await waitUntil(() => approvals.length > 0);
    stop();

    expect(approvals[0]).toEqual([session.id, "perm-1", "allow", true]);
  });

  it("watchdog urgently rechecks and resumes a stalled running session before normal TTL", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-watchdog-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const session = {
      ...fixtureSession("running", "zcode"),
      lastActivity: new Date(Date.now() - 60_000).toISOString(),
    };
    await store.markStarted(session, "watchdog-process");
    const calls = { resumes: 0, messages: [] as string[] };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", fixtureAdapter(session, calls)]]),
      store,
      ...enabledSettings(root),
      generationId: "watchdog-process",
      reconcileIntervalMs: 60_000,
      discoveryIdleMs: 60_000,
      watchdogIntervalMs: 5,
      stalledTurnMs: 10,
      judge: {
        async decide() { throw new Error("fallback should not run"); },
        async plan({ sessions }) {
          return { groups: sessions.map(({ session: candidate }) => ({
            sourceSessionIds: [candidate.id], primarySessionId: candidate.id, verdict: "unfinished" as const,
            reason: "Ход завис без прогресса", confidence: 1, topic: "Продолжить зависшую задачу", handoff: "Продолжить с последнего подтверждённого шага.",
          })) };
        },
      },
    });

    const stop = launcher.start();
    await waitUntil(() => calls.messages.length > 0);
    await waitUntil(async () => (await store.listInventory()).some((record) => record.sessionId === session.id));
    stop();

    expect(calls.resumes).toBeGreaterThanOrEqual(1);
    expect(calls.messages[0]).toContain("Продолжить с последнего подтверждённого шага");
  });

  it("watchdog does not wake a running session while its tool call is still active", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-watchdog-tool-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const session = {
      ...fixtureSession("running", "zcode"),
      lastActivity: new Date(Date.now() - 60_000).toISOString(),
      meta: { hasActiveToolCall: true },
    };
    await store.markStarted(session, "watchdog-tool-process");
    const calls = { resumes: 0, messages: [] as string[] };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", fixtureAdapter(session, calls)]]),
      store,
      ...enabledSettings(root),
      generationId: "watchdog-tool-process",
      reconcileIntervalMs: 60_000,
      discoveryIdleMs: 60_000,
      watchdogIntervalMs: 5,
      stalledTurnMs: 10,
    });

    const stop = launcher.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    stop();

    expect(calls).toEqual({ resumes: 0, messages: [] });
  });

  it("watchdog rechecks an accepted delivery that became idle even when the native completion event was lost", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-watchdog-idle-delivery-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const acceptedAt = new Date(Date.now() - 1_000);
    const stableNativeTimestamp = acceptedAt.toISOString();
    const acceptedSnapshot = {
      ...fixtureSession("idle", "zcode"),
      lastActivity: stableNativeTimestamp,
    };
    await store.markStarted(acceptedSnapshot, "idle-delivery-process", acceptedAt, true, true, true);
    const session = { ...acceptedSnapshot, status: "running" as AgentSession["status"] };
    const calls = { resumes: 0, messages: [] as string[] };
    let plans = 0;
    const adapter = fixtureAdapter(session, calls);
    adapter.getSessionMessages = async () => [
      { id: "goal", role: "user", text: "Finish the task", parts: [{ type: "text", text: "Finish the task" }] },
      { id: "done", role: "assistant", text: "Completed and verified", parts: [{ type: "text", text: "Completed and verified" }] },
    ];
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", adapter]]),
      store,
      ...enabledSettings(root),
      generationId: "idle-delivery-process",
      reconcileIntervalMs: 60_000,
      discoveryIdleMs: 60_000,
      watchdogIntervalMs: 5,
      judge: {
        async decide() { throw new Error("fallback should not run"); },
        async plan({ sessions }) {
          plans += 1;
          return { groups: sessions.map(({ session: candidate }) => ({
            sourceSessionIds: [candidate.id], primarySessionId: candidate.id, verdict: "completed" as const,
            reason: "Accepted delivery completed", confidence: 1, topic: "Completed task", handoff: "",
          })) };
        },
      },
    });

    const stop = launcher.start();
    await waitUntil(async () => Boolean((await store.list())[0]?.progressObservedAt));
    // Polling a running turn refreshes record.updatedAt. Native ZCode may then
    // publish idle with the same second-resolution timestamp, so neither field
    // can be used as the completion edge.
    session.status = "idle";
    await waitUntil(async () => (await store.listInventory()).some((record) =>
      record.sessionId === session.id && record.verdict?.verdict === "completed"));
    stop();

    expect(plans).toBe(1);
    expect(calls).toEqual({ resumes: 0, messages: [] });
    expect(await store.list()).toEqual([]);
    expect(await store.listInventory()).toMatchObject([{ sessionId: session.id, verdict: { verdict: "completed" } }]);
  });

  it("watchdog does not rearm an unchanged completed explicit control session after it stops", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-completed-watchdog-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const settingsStore = new SessionAutostartStore(join(root, "settings.json"), {});
    const session: AgentSession = {
      ...fixtureSession("idle", "codex"),
      title: "Agent Herder control canary",
      lastActivity: new Date(Date.now() - 5 * 60_000).toISOString(),
      model: "gpt-5.6-sol",
    };
    await settingsStore.setSession({ harness: "codex", sessionId: session.id, cwd: session.cwd }, true);
    const calls = { resumes: 0, messages: [] as string[] };
    let plans = 0;
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["codex", fixtureAdapter(session, calls)]]),
      store,
      settingsStore,
      reconcileIntervalMs: 60_000,
      discoveryIdleMs: 1,
      watchdogIntervalMs: 5,
      judge: {
        async decide() { throw new Error("fallback should not run"); },
        async plan({ sessions }) {
          plans += 1;
          return { groups: sessions.map(({ session: candidate }) => ({
            sourceSessionIds: [candidate.id], primarySessionId: candidate.id, verdict: "completed" as const,
            reason: "Control canary completed", confidence: 1, topic: "Completed canary", handoff: "",
          })) };
        },
      },
    });

    await launcher.recoverPending();
    const stop = launcher.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.status = "stopped";
    await new Promise((resolve) => setTimeout(resolve, 80));
    stop();

    expect(plans).toBe(1);
    expect(calls).toEqual({ resumes: 0, messages: [] });
    expect(await store.list()).toEqual([]);
    expect(await store.listInventory()).toMatchObject([{
      sessionId: session.id,
      verdict: { verdict: "completed", confidence: 1 },
    }]);
  });

  it("watchdog urgently re-audits a completed explicit session with newer native activity", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-completed-progress-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const settingsStore = new SessionAutostartStore(join(root, "settings.json"), {});
    const session: AgentSession = {
      ...fixtureSession("idle", "codex"),
      title: "Agent Herder control canary",
      lastActivity: new Date(Date.now() - 5 * 60_000).toISOString(),
      model: "gpt-5.6-sol",
    };
    await settingsStore.setSession({ harness: "codex", sessionId: session.id, cwd: session.cwd }, true);
    const calls = { resumes: 0, messages: [] as string[] };
    let plans = 0;
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["codex", fixtureAdapter(session, calls)]]),
      store,
      settingsStore,
      reconcileIntervalMs: 60_000,
      discoveryIdleMs: 1,
      watchdogIntervalMs: 5,
      judge: {
        async decide() { throw new Error("fallback should not run"); },
        async plan({ sessions }) {
          plans += 1;
          const unfinished = plans > 1;
          return { groups: sessions.map(({ session: candidate }) => ({
            sourceSessionIds: [candidate.id],
            primarySessionId: candidate.id,
            verdict: unfinished ? "unfinished" as const : "completed" as const,
            reason: unfinished ? "New native activity needs work" : "Control canary completed",
            confidence: 1,
            topic: "Control canary",
            handoff: unfinished ? "Продолжить после новой активности." : "",
          })) };
        },
      },
    });

    await launcher.recoverPending();
    const stop = launcher.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.status = "stopped";
    session.lastActivity = new Date().toISOString();
    await waitUntil(() => calls.messages.length > 0);
    await waitUntil(async () => (await store.listInventory()).some((record) =>
      record.sessionId === session.id && record.verdict?.verdict === "unfinished"));
    stop();

    expect(plans).toBe(2);
    expect(calls.resumes).toBeGreaterThanOrEqual(1);
    expect(calls.messages[0]).toContain("Продолжить после новой активности");
    expect(await store.listInventory()).toMatchObject([{
      sessionId: session.id,
      verdict: { verdict: "unfinished", confidence: 1 },
    }]);
  });

  it("watchdog protects an explicitly enabled session even before a native turn-start event", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-explicit-watchdog-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const settingsStore = new SessionAutostartStore(join(root, "settings.json"), {});
    const session = { ...fixtureSession("stopped", "codex"), lastActivity: new Date().toISOString(), model: "gpt-5.6-sol" };
    await settingsStore.setSession({ harness: "codex", sessionId: session.id, cwd: session.cwd }, true);
    const calls = { resumes: 0, messages: [] as string[] };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["codex", fixtureAdapter(session, calls)]]),
      store,
      settingsStore,
      reconcileIntervalMs: 60_000,
      discoveryIdleMs: 60_000,
      watchdogIntervalMs: 5,
      judge: {
        async decide() { throw new Error("fallback should not run"); },
        async plan({ sessions }) {
          return { groups: sessions.map(({ session: candidate }) => ({
            sourceSessionIds: [candidate.id], primarySessionId: candidate.id, verdict: "unfinished" as const,
            reason: "Native turn stopped", confidence: 1, topic: "Resume explicit session", handoff: "Продолжить текущую задачу.",
          })) };
        },
      },
    });

    const stop = launcher.start();
    await waitUntil(() => calls.messages.length > 0);
    await waitUntil(async () => (await store.listInventory()).some((record) => record.sessionId === session.id));
    stop();

    expect(calls.resumes).toBeGreaterThanOrEqual(1);
    expect(await store.list()).toMatchObject([{ sessionId: session.id, state: "active" }]);
  });

  it("watchdog inspects every explicitly enabled session even when the recovery budget is smaller", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-explicit-fairness-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const settingsStore = new SessionAutostartStore(join(root, "settings.json"), {});
    const sessions = Array.from({ length: 5 }, (_, index) => ({
      ...fixtureSession("idle", "codex"),
      id: `explicit-${index + 1}`,
      lastActivity: new Date(Date.now() - index * 1_000).toISOString(),
    }));
    for (const [index, session] of sessions.entries()) {
      await settingsStore.setSession(
        { harness: "codex", sessionId: session.id, cwd: session.cwd },
        true,
        new Date(Date.now() - index * 1_000),
      );
    }
    const inspected = new Set<string>();
    const adapter = fixtureAdapter(sessions[0]!, { resumes: 0, messages: [] });
    adapter.listSessions = async () => [];
    adapter.getSession = async (id) => {
      inspected.add(id);
      return sessions.find((session) => session.id === id) ?? null;
    };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["codex", adapter]]),
      store,
      settingsStore,
      maxResumesPerCycle: 1,
      reconcileIntervalMs: 60_000,
      watchdogIntervalMs: 5,
    });

    const stop = launcher.start();
    await waitUntil(() => inspected.size === sessions.length);
    stop();

    expect([...inspected].sort()).toEqual(sessions.map((session) => session.id).sort());
  });

  it("watchdog ignores two transient native-state misses when the session reappears", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-transient-miss-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const settingsStore = new SessionAutostartStore(join(root, "settings.json"), {});
    const session = { ...fixtureSession("idle", "codex"), id: "transient-miss" };
    await settingsStore.setSession({ harness: "codex", sessionId: session.id, cwd: session.cwd }, true);
    const calls = { resumes: 0, messages: [] as string[] };
    const adapter = fixtureAdapter(session, calls);
    adapter.listSessions = async () => [];
    let inspections = 0;
    adapter.getSession = async () => {
      inspections += 1;
      return inspections <= 2 ? null : session;
    };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["codex", adapter]]),
      store,
      settingsStore,
      reconcileIntervalMs: 60_000,
      watchdogIntervalMs: 5,
    });

    const stop = launcher.start();
    await waitUntil(() => inspections >= 4);
    stop();

    expect(calls).toEqual({ resumes: 0, messages: [] });
    expect(await store.list()).toEqual([]);
  });

  it("watchdog urgently resumes only after three consecutive native-state misses", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-persistent-miss-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const settingsStore = new SessionAutostartStore(join(root, "settings.json"), {});
    const session = { ...fixtureSession("idle", "codex"), id: "persistent-miss" };
    await settingsStore.setSession({ harness: "codex", sessionId: session.id, cwd: session.cwd }, true);
    const calls = { resumes: 0, messages: [] as string[] };
    const adapter = fixtureAdapter(session, calls);
    adapter.listSessions = async () => [];
    let inspections = 0;
    let resumedAfterInspections = 0;
    adapter.getSession = async () => { inspections += 1; return null; };
    adapter.resumeSession = async (id) => {
      expect(id).toBe(session.id);
      resumedAfterInspections = inspections;
      calls.resumes += 1;
      return { ok: true };
    };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["codex", adapter]]),
      store,
      settingsStore,
      reconcileIntervalMs: 60_000,
      watchdogIntervalMs: 5,
    });

    const stop = launcher.start();
    await waitUntil(() => calls.messages.length === 1);
    await waitUntil(async () => (await store.list())[0]?.state === "active");
    stop();

    expect(calls.resumes).toBe(1);
    expect(resumedAfterInspections).toBeGreaterThanOrEqual(3);
  });

  it("does not confuse a completed turn with a completed user task", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-completed-reconcile-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const calls = { resumes: 0, messages: [] as string[] };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", fixtureAdapter(fixtureSession("idle"), calls)]]),
      store,
      ...enabledSettings(root),
      retryDelayMs: 0,
      reconcileIntervalMs: 10,
      discoveryIdleMs: 1,
    });

    const stop = launcher.start();
    await waitUntil(() => calls.resumes === 1);
    await launcher.handleEvent("zcode", { kind: "turn.completed", harness: "zcode", sessionId: "session-1" });
    await waitUntil(() => calls.messages.length >= 2);
    await waitUntil(async () => (await store.list())[0]?.state === "active");
    stop();

    expect(calls.resumes).toBeGreaterThanOrEqual(2);
    expect(await store.list()).toMatchObject([{ sessionId: "session-1", state: "active" }]);
  });

  it("stop cancels a queued urgent recovery after a completed turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-stop-urgent-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const calls = { resumes: 0, messages: [] as string[] };
    const session = fixtureSession("idle");
    const adapter = fixtureAdapter(session, calls);
    adapter.listSessions = async () => [];
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", adapter]]),
      store,
      ...enabledSettings(root),
      retryDelayMs: 0,
      reconcileIntervalMs: 60_000,
      watchdogIntervalMs: 60_000,
      generationId: "stop-urgent-process",
    });

    await launcher.armSession(session);
    const stop = launcher.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await launcher.handleEvent("zcode", { kind: "turn.completed", harness: "zcode", sessionId: "session-1" });
    stop();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(calls).toEqual({ resumes: 0, messages: [] });
  });

  it("stop invalidates a batch plan that is still waiting on the judge", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-stop-plan-"));
    const calls = { resumes: 0, messages: [] as string[] };
    let planStarted = false;
    let releasePlan!: () => void;
    const planGate = new Promise<void>((resolve) => { releasePlan = resolve; });
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", fixtureAdapter(fixtureSession("idle"), calls)]]),
      store: new UnfinishedSessionStore(join(root, "unfinished.json")),
      ...enabledSettings(root),
      discoveryIdleMs: 1,
      reconcileIntervalMs: 60_000,
      judge: {
        async decide() { throw new Error("fallback should not run"); },
        async plan({ sessions }) {
          planStarted = true;
          await planGate;
          return { groups: sessions.map(({ session }) => ({
            sourceSessionIds: [session.id], primarySessionId: session.id, verdict: "unfinished" as const,
            reason: "Нужно продолжить", confidence: 1, topic: "Продолжить задачу", handoff: "Продолжить безопасно.",
          })) };
        },
      },
    });

    const stop = launcher.start();
    await waitUntil(() => planStarted);
    stop();
    releasePlan();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(calls).toEqual({ resumes: 0, messages: [] });
  });

  it("stop rolls back a retry attempt reserved before any native resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-stop-attempt-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const session = fixtureSession("idle");
    await store.markStarted(session, "previous-process");
    const calls = { resumes: 0, messages: [] as string[] };
    const originalBeginAttempt = store.beginAttempt.bind(store);
    let attemptReserved = false;
    let releaseAttempt!: () => void;
    const attemptGate = new Promise<void>((resolve) => { releaseAttempt = resolve; });
    store.beginAttempt = async (harness, sessionId, maxAttempts, retryDelayMs, now) => {
      const attempt = await originalBeginAttempt(harness, sessionId, maxAttempts, retryDelayMs, now);
      attemptReserved = true;
      await attemptGate;
      return attempt;
    };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", fixtureAdapter(session, calls)]]),
      store,
      ...enabledSettings(root),
      discoveryIdleMs: 1,
      reconcileIntervalMs: 60_000,
    });

    const stop = launcher.start();
    await waitUntil(() => attemptReserved);
    stop();
    releaseAttempt();
    await waitUntil(async () => (await store.list())[0]?.state === "active");

    expect(calls).toEqual({ resumes: 0, messages: [] });
    expect(await store.list()).toMatchObject([{ attempts: 0, state: "active" }]);
  });

  it("stop during native resume rolls back the unused retry attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-stop-resume-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const session = fixtureSession("idle");
    await store.markStarted(session, "previous-process");
    const calls = { resumes: 0, messages: [] as string[] };
    const adapter = fixtureAdapter(session, calls);
    let resumeStarted = false;
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => { releaseResume = resolve; });
    adapter.resumeSession = async () => {
      calls.resumes += 1;
      resumeStarted = true;
      await resumeGate;
      return { ok: true };
    };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", adapter]]), store,
      ...enabledSettings(root), discoveryIdleMs: 1, reconcileIntervalMs: 60_000,
    });

    const stop = launcher.start();
    await waitUntil(() => resumeStarted);
    stop();
    releaseResume();
    await waitUntil(async () => (await store.list())[0]?.state === "active");

    expect(calls.messages).toEqual([]);
    expect(await store.list()).toMatchObject([{ attempts: 0, state: "active" }]);
  });

  it("stop during a failed native resume still rolls back the retry attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-stop-resume-fail-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const session = fixtureSession("idle");
    await store.markStarted(session, "previous-process");
    const calls = { resumes: 0, messages: [] as string[] };
    const adapter = fixtureAdapter(session, calls);
    let resumeStarted = false;
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => { releaseResume = resolve; });
    adapter.resumeSession = async () => {
      calls.resumes += 1;
      resumeStarted = true;
      await resumeGate;
      return { ok: false, error: "temporary attach failure" };
    };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", adapter]]), store,
      ...enabledSettings(root), discoveryIdleMs: 1, reconcileIntervalMs: 60_000,
    });

    const stop = launcher.start();
    await waitUntil(() => resumeStarted);
    stop();
    releaseResume();
    await waitUntil(async () => (await store.list())[0]?.state === "active");

    expect(calls.messages).toEqual([]);
    expect(await store.list()).toMatchObject([{ attempts: 0, state: "active" }]);
  });

  it("stop during pinning rolls back before sending a continuation", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-stop-pin-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const session = fixtureSession("idle");
    await store.markStarted(session, "previous-process");
    const calls = { resumes: 0, messages: [] as string[] };
    const adapter = fixtureAdapter(session, calls);
    let pinStarted = false;
    let releasePin!: () => void;
    const pinGate = new Promise<void>((resolve) => { releasePin = resolve; });
    adapter.setSessionPinned = async () => {
      pinStarted = true;
      await pinGate;
      return { ok: true };
    };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", adapter]]), store,
      ...enabledSettings(root), discoveryIdleMs: 1, reconcileIntervalMs: 60_000,
    });

    const stop = launcher.start();
    await waitUntil(() => pinStarted);
    stop();
    releasePin();
    await waitUntil(async () => (await store.list())[0]?.state === "active");

    expect(calls.resumes).toBe(1);
    expect(calls.messages).toEqual([]);
    expect(await store.list()).toMatchObject([{ attempts: 0, state: "active" }]);
  });

  it("stop during a rejected send rolls back the retry attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-stop-send-fail-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const session = fixtureSession("idle");
    await store.markStarted(session, "previous-process");
    const calls = { resumes: 0, messages: [] as string[] };
    const adapter = fixtureAdapter(session, calls);
    let sendStarted = false;
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    adapter.sendMessage = async (_id, input) => {
      calls.messages.push(input.message);
      sendStarted = true;
      await sendGate;
      return { ok: false, error: "temporary send failure" };
    };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", adapter]]), store,
      ...enabledSettings(root), discoveryIdleMs: 1, reconcileIntervalMs: 60_000,
    });

    const stop = launcher.start();
    await waitUntil(() => sendStarted);
    stop();
    releaseSend();
    await waitUntil(async () => (await store.list())[0]?.state === "active");

    expect(calls.resumes).toBe(1);
    expect(calls.messages).toHaveLength(1);
    expect(await store.list()).toMatchObject([{ attempts: 0, state: "active" }]);
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
    const pins: Array<[string, boolean]> = [];
    oldAdapter.setSessionPinned = async (sessionId, pinned) => {
      pins.push([sessionId, pinned]);
      return { ok: true, sessionId };
    };
    const next = { ...old, id: "session-2", status: "running" as const, lastActivity: "2026-10-03T13:00:00.000Z" };
    const settingsStore = new SessionAutostartStore(join(root, "settings.json"), {});
    await settingsStore.setRuntimeSettings({
      inventoryWindowHours: 48,
      evidenceMessageCount: 200,
      judgeModel: "MiniMax-M3.1-Flash-Preview",
      autopilotJudgeModel: "MiniMax-M3",
      pinActiveSessions: true,
      movePinnedOnRollover: false,
    });
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["codex", oldAdapter]]), store,
      settingsStore, retryDelayMs: 0,
      cacheHandoff: { async maybeRollover() { return { kind: "rolled_over", session: next, ageMs: 3_600_000, cache: { ttlMs: 1_800_000, source: "openai-30m" } }; } },
    });
    await launcher.recoverPending();
    expect(calls.resumes).toBe(0);
    expect(pins).toEqual([[next.id, true]]);
    expect(await store.list()).toMatchObject([{ sessionId: "session-2", state: "active" }]);
  });

  it("does not repeat a cache handoff whose replacement turn failed after admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-handoff-admitted-failure-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const old = fixtureSession("idle", "codex");
    await store.markStarted(old, "previous-process");
    const calls = { resumes: 0, messages: [] as string[] };
    const adapter = fixtureAdapter(old, calls);
    const next = { ...old, id: "session-2", status: "error" as const, lastActivity: new Date().toISOString() };
    const settingsStore = new SessionAutostartStore(join(root, "settings.json"), {});
    await settingsStore.setRuntimeSettings({
      inventoryWindowHours: 48,
      evidenceMessageCount: 4,
      judgeModel: "MiniMax-M3.1-Flash-Preview",
      autopilotJudgeModel: "MiniMax-M3",
      rolloverExpiredCache: true,
    });
    let handoffs = 0;
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["codex", adapter]]), store, settingsStore, retryDelayMs: 0,
      cacheHandoff: {
        async maybeRollover() {
          handoffs += 1;
          return {
            kind: "admitted_failed" as const,
            session: next,
            admittedFailure: "native cache handoff turn failed",
            ageMs: 3_600_000,
            cache: { ttlMs: 1_800_000, source: "openai-30m" as const },
          };
        },
      },
    });

    await launcher.recoverPending();
    await launcher.recoverPending();

    expect(handoffs).toBe(1);
    expect(calls.resumes).toBe(0);
    expect(calls.messages).toHaveLength(0);
    expect(await store.list()).toMatchObject([{
      sessionId: "session-2",
      state: "active",
      nonRetryableAdmission: true,
      lastError: "native cache handoff turn failed",
    }]);
  });

  it("restores a prepared cache admission after process recreation without creating or sending again", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-handoff-crash-window-"));
    const lineagePath = join(root, "lineage.json");
    const storePath = join(root, "unfinished.json");
    const old = fixtureSession("idle", "codex");
    const replacement = { ...old, id: "session-2", status: "error" as const, lastActivity: new Date().toISOString() };
    const firstCalls = { resumes: 0, messages: [] as string[] };
    const firstAdapter = fixtureAdapter(old, firstCalls);
    let firstCreates = 0;
    firstAdapter.createSession = async () => { firstCreates += 1; return replacement; };
    firstAdapter.sendMessage = async (_id, input) => {
      firstCalls.messages.push(input.message);
      return { ok: false, admitted: true, nonRetryable: true, error: "native handoff turn failed" };
    };
    class CrashAfterAdmissionLineage extends LineageStore {
      private recordCalls = 0;
      override async record(record: Parameters<LineageStore["record"]>[0]): Promise<void> {
        this.recordCalls += 1;
        if (this.recordCalls === 2) throw new Error("simulated process crash after native admission");
        await super.record(record);
      }
    }
    const firstService = new CacheHandoffService(
      new Map([["codex", firstAdapter]]),
      { summarize: async () => "handoff" },
      new CrashAfterAdmissionLineage(lineagePath),
    );

    await expect(firstService.maybeRollover(old, new Date("2026-10-03T13:00:00.000Z")))
      .rejects.toThrow("simulated process crash");
    expect(firstCreates).toBe(1);
    expect(firstCalls.messages).toHaveLength(1);

    const restartedStore = new UnfinishedSessionStore(storePath);
    await restartedStore.markStarted(old, "crashed-process");
    const restartedCalls = { resumes: 0, messages: [] as string[] };
    const restartedAdapter = fixtureAdapter(old, restartedCalls);
    restartedAdapter.getMessageAdmission = async () => ({ state: "failed", error: "native handoff turn failed" });
    let restartedCreates = 0;
    restartedAdapter.createSession = async () => { restartedCreates += 1; return { ...replacement, id: `unexpected-${restartedCreates}` }; };
    const restartedService = new CacheHandoffService(
      new Map([["codex", restartedAdapter]]),
      { summarize: async () => { throw new Error("durable admission must bypass summarization"); } },
      new LineageStore(lineagePath),
    );
    const settingsStore = new SessionAutostartStore(join(root, "settings.json"), {});
    await settingsStore.setRuntimeSettings({
      inventoryWindowHours: 48,
      evidenceMessageCount: 4,
      judgeModel: "MiniMax-M3.1-Flash-Preview",
      autopilotJudgeModel: "MiniMax-M3",
      rolloverExpiredCache: true,
    });
    const restartedLauncher = new UnfinishedSessionLauncher({
      adapters: new Map([["codex", restartedAdapter]]),
      store: restartedStore,
      settingsStore,
      retryDelayMs: 0,
      cacheHandoff: restartedService,
    });

    await restartedLauncher.recoverPending();
    await restartedLauncher.recoverPending();

    expect(restartedCreates).toBe(0);
    expect(restartedCalls.messages).toHaveLength(0);
    expect(await restartedStore.list()).toMatchObject([{
      sessionId: replacement.id,
      nonRetryableAdmission: true,
      lastError: "native handoff turn failed",
    }]);
  });

  it("retries the same prepared operation after a crash before send without creating a second replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-handoff-before-send-crash-"));
    const lineagePath = join(root, "lineage.json");
    const storePath = join(root, "unfinished.json");
    const old = fixtureSession("idle", "codex");
    const replacement = { ...old, id: "session-2", status: "idle" as const, lastActivity: new Date().toISOString() };
    const firstAdapter = fixtureAdapter(old, { resumes: 0, messages: [] });
    let firstCreates = 0;
    firstAdapter.createSession = async () => { firstCreates += 1; return replacement; };
    firstAdapter.sendMessage = async () => { throw new Error("simulated crash before native send"); };
    const firstService = new CacheHandoffService(
      new Map([["codex", firstAdapter]]),
      { summarize: async () => "handoff" },
      new LineageStore(lineagePath),
    );

    await expect(firstService.maybeRollover(old, new Date("2026-10-03T13:00:00.000Z")))
      .rejects.toThrow("simulated crash before native send");
    expect(firstCreates).toBe(1);
    const prepared = (await new LineageStore(lineagePath).children("codex:session-1"))[0]?.cacheHandoffAdmission;
    expect(prepared).toMatchObject({ state: "prepared", session: { id: replacement.id }, operationId: expect.any(String) });

    const restartedStore = new UnfinishedSessionStore(storePath);
    await restartedStore.markStarted(old, "crashed-before-send");
    const restartedCalls = { resumes: 0, messages: [] as string[] };
    const restartedAdapter = fixtureAdapter(old, restartedCalls);
    restartedAdapter.getSessionMessages = async (id) => id === replacement.id ? [] : [{
      id: "source-user", role: "user", text: "Продолжи.", parts: [{ type: "text", text: "Продолжи." }],
    }];
    let restartedCreates = 0;
    let retriedInputId: string | undefined;
    restartedAdapter.createSession = async () => { restartedCreates += 1; return { ...replacement, id: `unexpected-${restartedCreates}` }; };
    restartedAdapter.sendMessage = async (_id, input) => {
      restartedCalls.messages.push(input.message);
      retriedInputId = input.inputId;
      return { ok: true };
    };
    const restartedService = new CacheHandoffService(
      new Map([["codex", restartedAdapter]]),
      { summarize: async () => { throw new Error("prepared retry must reuse persisted prompt"); } },
      new LineageStore(lineagePath),
    );
    const settingsStore = new SessionAutostartStore(join(root, "settings-before-send.json"), {});
    await settingsStore.setRuntimeSettings({
      inventoryWindowHours: 48,
      evidenceMessageCount: 4,
      judgeModel: "MiniMax-M3.1-Flash-Preview",
      autopilotJudgeModel: "MiniMax-M3",
      rolloverExpiredCache: true,
    });
    const restartedLauncher = new UnfinishedSessionLauncher({
      adapters: new Map([["codex", restartedAdapter]]),
      store: restartedStore,
      settingsStore,
      retryDelayMs: 0,
      cacheHandoff: restartedService,
    });

    await restartedLauncher.recoverPending();
    await restartedLauncher.recoverPending();

    expect(restartedCreates).toBe(0);
    expect(restartedCalls.messages).toHaveLength(1);
    expect(retriedInputId).toBe(prepared?.operationId);
    expect(await restartedStore.list()).toMatchObject([{ sessionId: replacement.id, state: "active" }]);
  });

  it("keeps restart continuation on the expired session when rollover is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-no-handoff-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const old = fixtureSession("idle", "codex");
    await store.markStarted(old, "previous-process");
    const calls = { resumes: 0, messages: [] as string[] };
    const adapter = fixtureAdapter(old, calls);
    const pins: Array<[string, boolean]> = [];
    adapter.setSessionPinned = async (sessionId, pinned) => {
      pins.push([sessionId, pinned]);
      return { ok: true, sessionId };
    };
    const settingsStore = new SessionAutostartStore(join(root, "settings.json"), {});
    await settingsStore.setRuntimeSettings({
      inventoryWindowHours: 48,
      evidenceMessageCount: 4,
      judgeModel: "MiniMax-M3.1-Flash-Preview",
      autopilotJudgeModel: "MiniMax-M3",
      rolloverExpiredCache: false,
    });
    let handoffs = 0;
    await new UnfinishedSessionLauncher({
      adapters: new Map([["codex", adapter]]), store, settingsStore,
      retryDelayMs: 0, generationId: "current-process",
      cacheHandoff: { async maybeRollover() { handoffs += 1; throw new Error("rollover must stay disabled"); } },
    }).recoverPending();

    expect(handoffs).toBe(0);
    expect(calls).toEqual({ resumes: 1, messages: [expect.stringContaining("Продолжи незавершённую задачу")] });
    expect(pins).toEqual([[old.id, true]]);
    expect(await store.list()).toMatchObject([{ sessionId: old.id, state: "active", generationId: "current-process" }]);
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

  it("never repeats a prompt whose native admission is accepted but turn start is still pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-pending-admission-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const session = { ...fixtureSession("idle", "zcode"), lastActivity: new Date(Date.now() - 30 * 60_000).toISOString() };
    await store.markStarted(session, "previous-process");
    const calls = { resumes: 0, messages: [] as string[] };
    const adapter = fixtureAdapter(session, calls);
    adapter.sendMessage = async (_id, input) => {
      calls.messages.push(input.message);
      return { ok: true, pending: true };
    };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", adapter]]),
      store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}),
      generationId: "current-process",
      retryDelayMs: 0,
      discoveryIdleMs: 1,
    });

    await launcher.recoverPending();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await launcher.recoverPending();

    expect(calls.resumes).toBe(1);
    expect(calls.messages).toHaveLength(1);
    expect(await store.list()).toMatchObject([{ sessionId: session.id, deliveryPending: true, state: "active" }]);
  });

  it("never repeats a prompt whose admitted native turn failed non-retryably", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-admitted-failure-"));
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const session = { ...fixtureSession("idle", "zcode"), lastActivity: new Date(Date.now() - 30 * 60_000).toISOString() };
    await store.markStarted(session, "previous-process");
    const calls = { resumes: 0, messages: [] as string[] };
    const adapter = fixtureAdapter(session, calls);
    adapter.sendMessage = async (_id, input) => {
      calls.messages.push(input.message);
      return { ok: false, admitted: true, nonRetryable: true, error: "exact native turn failed" };
    };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", adapter]]), store,
      settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}),
      generationId: "current-process", retryDelayMs: 0, discoveryIdleMs: 1,
    });

    await launcher.recoverPending();
    await launcher.recoverPending();

    expect(calls.resumes).toBe(1);
    expect(calls.messages).toHaveLength(1);
    expect(await store.list()).toMatchObject([{
      sessionId: session.id, nonRetryableAdmission: true, lastError: "exact native turn failed", state: "active",
    }]);
  });
});
