import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { completionEvidence, createAnthropicCompatibleSessionCompletionJudge, createOpenAICompatibleSessionCompletionJudge, enforcePlanWorkspaceBoundaries, estimateBatchPlannerInputTokens, estimateContextTokens, fitBatchContext, fitBatchContextForSerializedRequest, SessionAutostartStore, UnfinishedSessionStore, } from "../src/autopilot/unfinished-session-launcher.js";
import type { AgentSession, SessionMessageView } from "../src/types/index.js";
function fixtureSession(status: AgentSession["status"] = "idle", harness: "codex" | "zcode" = "zcode"): AgentSession {
    return {
        id: "session-1",
        harness,
        status,
        title: "Незавершённая проверка",
        cwd: "/tmp/autostart-canary",
        // Keep the shared fixture inside the launcher's 48-hour discovery window.
        lastActivity: new Date(Date.now() - 10 * 60000).toISOString(),
        model: "account:zai-individual-coding-plan/GLM-5.3-Flash$high",
        needsPermission: status === "needs_input",
        messageCount: 2,
    };
}
describe("explicit unfinished inventory pure contracts", () => {
    it("always gives MiniMax the first user goal, latest request, and latest model answer", () => {
        const evidence = completionEvidence([
            { id: "u-old", role: "user", text: "старый запрос", parts: [{ type: "text", text: "старый запрос" }] },
            { id: "a-last", role: "assistant", text: `ответ-модели-${"а".repeat(1500)}`, parts: [{ type: "text", text: `ответ-модели-${"а".repeat(1500)}` }] },
            { id: "tool", role: "tool", text: "шум инструмента", parts: [{ type: "tool_result", output: "шум инструмента" }] },
            { id: "u-last", role: "user", text: `последний-запрос-${"б".repeat(1500)}`, parts: [{ type: "text", text: `последний-запрос-${"б".repeat(1500)}` }] },
        ], 2);
        expect(evidence).toContain("АГЕНТ: ответ-модели-");
        expect(evidence).toContain("ПОЛЬЗОВАТЕЛЬ: последний-запрос-");
        expect(evidence).toContain("ПЕРВЫЙ ПОЛЬЗОВАТЕЛЬСКИЙ ЗАПРОС");
        expect(evidence).toContain("старый запрос");
        expect(evidence).not.toContain("шум инструмента");
        expect(evidence).toContain("а".repeat(1500));
        expect(evidence).toContain("б".repeat(1500));
        expect(evidence.length).toBeGreaterThan(3000);
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
            transcriptTail: `ПЕРВЫЙ ПОЛЬЗОВАТЕЛЬСКИЙ ЗАПРОС:\nцель-${id}\n\nПОСЛЕДНИЙ СМЫСЛОВОЙ КОНТЕКСТ:\n${id.repeat(12000)}`,
        }));
        const packed = fitBatchContext(sessions, 6000);
        expect(packed).toHaveLength(3);
        for (const candidate of packed) {
            expect(candidate.transcriptTail).toContain(`цель-${candidate.session.id}`);
            expect(candidate.transcriptTail).toContain("ПОСЛЕДНИЙ СМЫСЛОВОЙ КОНТЕКСТ");
        }
        expect(estimateBatchPlannerInputTokens(packed)).toBeLessThanOrEqual(6000);
    });
    it("fits the final escaped JSON request under 480k tokens", () => {
        const hostile = `${'"\\\n'.repeat(70000)}конец`;
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
        const fitted = fitBatchContextForSerializedRequest(sessions, 480000, buildRequest);
        expect(fitted.sessions).toHaveLength(sessions.length);
        expect(fitted.estimatedTokens).toBe(estimateContextTokens(JSON.stringify(fitted.request)));
        expect(fitted.estimatedTokens).toBeLessThanOrEqual(480000);
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
        expect(() => fitBatchContext(sessions, 1000)).toThrow(/above the 1000 token ceiling/);
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
        const body = JSON.parse(String(requestInit?.body)) as {
            model: string;
            system: Array<{
                cache_control?: {
                    type?: string;
                };
            }>;
        };
        expect(body.model).toBe("MiniMax-M3");
        expect(body.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    });
    it("passes an explicit reasoning effort to an OpenAI-compatible batch planner", async () => {
        let requestUrl = "";
        let requestBody: Record<string, unknown> = {};
        const judge = createOpenAICompatibleSessionCompletionJudge({
            baseUrl: "https://api.z.ai/api/coding/paas/v4/",
            model: "glm-5.3-flash",
            token: "test-token",
            reasoningEffort: "low",
            fetchImpl: async (url, init) => {
                requestUrl = String(url);
                requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
                return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ groups: [{
                    source_session_ids: ["S1"], primary_session_id: "S1", verdict: "completed",
                    reason: "Задача завершена", confidence: 0.99, topic: "Проверка ZCode", handoff: "",
                }] }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
            },
        });
        await expect(judge.plan?.({ sessions: [{ session: fixtureSession("idle", "zcode"), transcriptTail: "Работа завершена" }] }))
            .resolves.toMatchObject({ groups: [{ verdict: "completed", confidence: 0.99 }] });
        expect(requestUrl).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions");
        expect(requestBody.reasoning_effort).toBe("low");
        expect(requestBody.response_format).toEqual({ type: "json_object" });
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
                            source_session_ids: [], primary_session_id: "S2", verdict: "completed",
                            reason: "Пустая группа модели", confidence: 0.1, topic: "Пусто", handoff: "",
                        }, {
                            source_session_ids: ["S3"], primary_session_id: "S3", verdict: "unfinished",
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
        expect(requestBody.max_tokens).toBe(16384);
        expect(requestBody.stream).toBe(true);
        expect(requestBody.output_config).toEqual({ effort: "low" });
    });
    it("accepts bounded numeric and decimal-string aliases when MiniMax strips the S prefix", async () => {
        const judge = createAnthropicCompatibleSessionCompletionJudge({
            baseUrl: "https://api.minimax.io/anthropic/",
            model: "MiniMax-M3.1-Flash-Preview",
            token: "test-token",
            fetchImpl: async () => {
                const text = JSON.stringify({ groups: [{
                            source_session_ids: [1, "2"], primary_session_id: "2", verdict: "completed",
                            reason: "done", confidence: 1, topic: "Both", handoff: "",
                        }] });
                return new Response([
                    `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}`,
                    "data: [DONE]",
                    "",
                ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
            },
        });
        const plan = await judge.plan?.({ sessions: [
                { session: { ...fixtureSession("idle", "codex"), id: "first" }, transcriptTail: "first" },
                { session: { ...fixtureSession("idle", "zcode"), id: "second" }, transcriptTail: "second" },
            ] });
        expect(plan).toMatchObject({ groups: [{
                    sourceSessionIds: ["codex:first:/tmp/autostart-canary", "zcode:second:/tmp/autostart-canary"],
                    primarySessionId: "zcode:second:/tmp/autostart-canary",
                }] });
    });
    it("rejects a numeric-string alias that collides with a different native session id", async () => {
        const judge = createAnthropicCompatibleSessionCompletionJudge({
            baseUrl: "https://api.minimax.io/anthropic/", model: "MiniMax-M3.1-Flash-Preview", token: "test-token",
            fetchImpl: async () => {
                const text = JSON.stringify({ groups: [{
                            source_session_ids: ["1"], primary_session_id: "1", verdict: "completed",
                            reason: "done", confidence: 1, topic: "Ambiguous", handoff: "",
                        }] });
                return new Response([
                    `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}`,
                    "data: [DONE]", "",
                ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
            },
        });
        await expect(judge.plan?.({ sessions: [
                { session: { ...fixtureSession("idle", "codex"), id: "position-one" }, transcriptTail: "first" },
                { session: { ...fixtureSession("idle", "zcode"), id: "1" }, transcriptTail: "native numeric id" },
            ] })).rejects.toThrow(/ambiguous numeric session 1/);
    });
    it("keeps a JSON number positional even when its text collides with another native id", async () => {
        const judge = createAnthropicCompatibleSessionCompletionJudge({
            baseUrl: "https://api.minimax.io/anthropic/", model: "MiniMax-M3.1-Flash-Preview", token: "test-token",
            fetchImpl: async () => {
                const text = JSON.stringify({ groups: [{
                            source_session_ids: [1], primary_session_id: 1, verdict: "completed",
                            reason: "done", confidence: 1, topic: "Positional", handoff: "",
                        }] });
                return new Response([
                    `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}`,
                    "data: [DONE]", "",
                ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
            },
        });
        await expect(judge.plan?.({ sessions: [
                { session: { ...fixtureSession("idle", "codex"), id: "position-one" }, transcriptTail: "first" },
                { session: { ...fixtureSession("idle", "zcode"), id: "1" }, transcriptTail: "native numeric id" },
            ] })).resolves.toMatchObject({ groups: [{
                    sourceSessionIds: ["codex:position-one:/tmp/autostart-canary"],
                    primarySessionId: "codex:position-one:/tmp/autostart-canary",
                }] });
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
    it("prunes legacy out-of-scope turns and inventory older than the configured window", async () => {
        const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-prune-"));
        const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
        const now = Date.now();
        await store.markStarted({ ...fixtureSession("idle", "codex"), harness: "opencode", id: "legacy-health" });
        await store.markStarted({ ...fixtureSession("idle", "codex"), id: "kept-codex" });
        await store.upsertInventory({
            harness: "codex", sessionId: "old", cwd: "/tmp", title: "Old", status: "idle",
            lastActivity: new Date(now - 49 * 60 * 60000).toISOString(), transcriptTail: "old", observedAt: new Date(now).toISOString(),
        });
        await store.upsertInventory({
            harness: "codex", sessionId: "recent", cwd: "/tmp", title: "Recent", status: "idle",
            lastActivity: new Date(now - 47 * 60 * 60000).toISOString(), transcriptTail: "recent", observedAt: new Date(now).toISOString(),
        });
        await store.upsertInventory({
            harness: "fast-agent", sessionId: "recent-fast-agent", cwd: "/tmp", title: "Recent Fast Agent", status: "stopped",
            lastActivity: new Date(now - 1 * 60 * 60000).toISOString(), transcriptTail: "recent", observedAt: new Date(now).toISOString(),
        });
        await store.upsertInventory({
            harness: "opencode", sessionId: "recent-opencode", cwd: "/tmp", title: "Recent OpenCode", status: "idle",
            lastActivity: new Date(now - 1 * 60 * 60000).toISOString(), transcriptTail: "recent", observedAt: new Date(now).toISOString(),
        });
        await expect(store.pruneAutocontinueScope(new Date(now - 48 * 60 * 60000))).resolves.toEqual({ sessions: 1, inventory: 3 });
        expect((await store.list()).map((record) => record.sessionId)).toEqual(["kept-codex"]);
        expect((await store.listInventory()).map((record) => record.sessionId)).toEqual(["recent"]);
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
    it("migrates v1 settings with same-session continuation as the default", async () => {
        const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-v1-"));
        const path = join(root, "settings.json");
        await writeFile(path, JSON.stringify({ version: 1, enabled: true, sessions: [] }));
        const settingsStore = new SessionAutostartStore(path, {});
        expect(await settingsStore.getSettings()).toMatchObject({
            version: 7,
            enabled: true,
            pinActiveSessions: true,
            rolloverExpiredCache: false,
            movePinnedOnRollover: false,
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
    it("persists explicit rollover choices while defaulting legacy files to same-session continuation", async () => {
        const root = await mkdtemp(join(tmpdir(), "agent-herder-autostart-rollover-setting-"));
        const path = join(root, "settings.json");
        await writeFile(path, JSON.stringify({
            version: 3, enabled: true, inventoryWindowHours: 48, evidenceMessageCount: 4,
            judgeModel: "MiniMax-M3.1-Flash-Preview", autopilotJudgeModel: "MiniMax-M3", harnesses: [], sessions: [],
        }));
        const settingsStore = new SessionAutostartStore(path, {});
        await expect(settingsStore.getSettings()).resolves.toMatchObject({ version: 7, pinActiveSessions: true, rolloverExpiredCache: false, movePinnedOnRollover: false, evidenceMessageCount: 200, source: "persisted" });
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
});
