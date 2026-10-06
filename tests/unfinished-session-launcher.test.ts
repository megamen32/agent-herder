import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { completionEvidence, createAnthropicCompatibleSessionCompletionJudge, fitBatchContext, SessionAutostartStore, UnfinishedSessionLauncher, UnfinishedSessionStore, type UnfinishedSessionNotice } from "../src/autopilot/unfinished-session-launcher.js";
import { getHumanStopStore } from "../src/human-stop-store.js";
import type { AgentSession, HarnessAdapter, SessionMessageView } from "../src/types/index.js";
function fixture(status: AgentSession["status"] = "idle", harness: "codex" | "zcode" = "codex", id = "session-1"): AgentSession {
    return { id, harness, status, title: "Recovery fixture", cwd: "/tmp/recovery", lastActivity: new Date(Date.now() - 60000).toISOString(), needsPermission: status === "needs_input", messageCount: 2 };
}
function fakeAdapter(current: () => AgentSession, calls: {
    resumes: number;
    messages: string[];
}): HarnessAdapter {
    return { type: current().harness, name: "fixture", async init() { }, async listSessions() { return [{ ...current() }]; }, async getSession(id) { return id === current().id ? { ...current() } : null; }, async getSessionMessages() { return [{ id: "u", role: "user", text: "work", parts: [{ type: "text", text: "work" }] }]; }, async resumeSession(id) { expect(id).toBe(current().id); calls.resumes += 1; return { ok: true }; }, async sendMessage(id, input) { expect(id).toBe(current().id); calls.messages.push(input.message); return { ok: true }; }, async stopSession() { return { ok: true }; }, async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; } };
}
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> { const end = Date.now() + timeoutMs; while (!await predicate()) {
    if (Date.now() >= end)
        throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
} }
describe("unfinished session crash recovery", () => {
    it("retains first goal and last answer in bounded evidence", () => {
        const messages: SessionMessageView[] = [{ id: "u", role: "user", text: "original goal", parts: [{ type: "text", text: "original goal" }] }, { id: "a", role: "assistant", text: "final result", parts: [{ type: "text", text: "final result" }] }];
        expect(completionEvidence(messages)).toContain("original goal");
        expect(completionEvidence(messages)).toContain("final result");
    });
    it("fits pure planner evidence under budget", () => {
        const packed = fitBatchContext(["a", "b"].map((id) => ({ session: fixture("idle", "codex", id), transcriptTail: `${id}:${"x".repeat(20000)}` })), 4000);
        expect(packed).toHaveLength(2);
        expect(packed.every(({ transcriptTail }) => transcriptTail.length < 20010)).toBe(true);
    });
    it("preserves settings defaults, legacy migration, and omitted flags", async () => {
        const root = await mkdtemp(join(tmpdir(), "recovery-settings-"));
        const path = join(root, "settings.json");
        await writeFile(path, JSON.stringify({ version: 7, enabled: true, pinActiveSessions: true, rolloverExpiredCache: false, movePinnedOnRollover: false, inventoryWindowHours: 48, evidenceMessageCount: 200, watchdogEnabled: false, watchdogIntervalSeconds: 10, stalledTurnMinutes: 2, judgeModel: "judge", autopilotJudgeModel: "autopilot", harnesses: [], sessions: [] }));
        const store = new SessionAutostartStore(path, {});
        expect(await store.getSettings()).toMatchObject({ recoverOnFailure: true, recoverOnDisconnect: true, watchdogEnabled: false });
        await store.setRuntimeSettings({ inventoryWindowHours: 48, evidenceMessageCount: 200, judgeModel: "judge", autopilotJudgeModel: "autopilot", recoverOnFailure: false });
        await store.setRuntimeSettings({ inventoryWindowHours: 48, evidenceMessageCount: 200, judgeModel: "judge", autopilotJudgeModel: "autopilot" });
        expect(await store.getSettings()).toMatchObject({ recoverOnFailure: false, recoverOnDisconnect: true, watchdogEnabled: false });
    });
    it("round-trips active and failed turn identity through the durable store", async () => {
        const root = await mkdtemp(join(tmpdir(), "recovery-store-"));
        const path = join(root, "state.json");
        const first = new UnfinishedSessionStore(path);
        const item = fixture("running", "zcode");
        await first.markNativeTurnStarted(item, { turnId: "t1", inputId: "i1" });
        expect(await new UnfinishedSessionStore(path).activeNativeTurn("zcode", item.id)).toEqual({ turnId: "t1", inputId: "i1" });
        await first.markRecoveryEligible({ ...item, status: "error" }, "turn.failed", { turnId: "t1", inputId: "i1" });
        expect(await new UnfinishedSessionStore(path).recoveryNativeTurn("zcode", item.id)).toEqual({ turnId: "t1", inputId: "i1" });
    });
    it("keeps requested plan artifacts complete in explicit audit without recovery action", async () => {
        const root = await mkdtemp(join(tmpdir(), "artifact-audit-"));
        let current = fixture();
        const calls = { resumes: 0, messages: [] as string[] };
        const native = fakeAdapter(() => current, calls);
        const request = "Return JSON status=plans_ready with three plans; do not execute them";
        const result = '{"status":"plans_ready","plans":[1,2,3]}';
        native.getSessionMessages = async () => [{ id: "u", role: "user", text: request, parts: [{ type: "text", text: request }] }, { id: "a", role: "assistant", text: result, parts: [{ type: "text", text: result }] }];
        const judge = createAnthropicCompatibleSessionCompletionJudge({ baseUrl: "https://judge.invalid", model: "judge", token: "token", fetchImpl: async (_url, init) => { const body = JSON.parse(String(init?.body)) as {
                system: Array<{
                    text: string;
                }>;
                messages: Array<{
                    content: string;
                }>;
            }; expect(body.system[0]!.text).toContain("валидный финальный артефакт означает completed"); expect(body.system[0]!.text).toContain("Если пользователь просил выполнить эти шаги"); expect(body.messages[0]!.content).toContain("plans_ready"); const text = JSON.stringify({ groups: [{ source_session_ids: ["S1"], primary_session_id: "S1", verdict: "completed", reason: "ready", confidence: 1, topic: "artifact", handoff: "" }] }); return new Response(`data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } }); } });
        const state = new UnfinishedSessionStore(join(root, "state.json"));
        await new UnfinishedSessionLauncher({ adapters: new Map([["codex", native]]), store: state, settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}), discoveryIdleMs: 1, judge }).auditInventory();
        expect((await state.listInventory())[0]?.verdict?.verdict).toBe("completed");
        expect(calls).toEqual({ resumes: 0, messages: [] });
    });
    it("does not scan or act on semantic unfinishedness in recovery cycles", async () => {
        const root = await mkdtemp(join(tmpdir(), "semantic-no-action-"));
        let current = fixture();
        const calls = { resumes: 0, messages: [] as string[] };
        let plans = 0;
        const launcher = new UnfinishedSessionLauncher({ adapters: new Map([["codex", fakeAdapter(() => current, calls)]]), store: new UnfinishedSessionStore(join(root, "state.json")), settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}), judge: { async decide() { return { verdict: "unfinished", reason: "semantic", confidence: 1 }; }, async plan() { plans += 1; return { groups: [] }; } } });
        await launcher.recoverPending();
        await launcher.recoverPending();
        await launcher.recoverPending();
        expect(plans).toBe(0);
        expect(calls).toEqual({ resumes: 0, messages: [] });
    });
    it("recovers one matching failed turn in the same session and does not repeat admission", async () => {
        const root = await mkdtemp(join(tmpdir(), "failed-recovery-"));
        let current = fixture("running");
        const calls = { resumes: 0, messages: [] as string[] };
        const launcher = new UnfinishedSessionLauncher({ adapters: new Map([["codex", fakeAdapter(() => current, calls)]]), store: new UnfinishedSessionStore(join(root, "state.json")), settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}), discoveryIdleMs: 1 });
        await launcher.handleEvent("codex", { kind: "turn.started", harness: "codex", sessionId: current.id, data: { turnId: "t1", inputId: "i1" } });
        current = { ...current, status: "error" };
        await launcher.handleEvent("codex", { kind: "turn.failed", harness: "codex", sessionId: current.id, data: { turnId: "t1", inputId: "i1" } });
        await launcher.recoverPending();
        await launcher.recoverPending();
        expect(calls.resumes).toBe(1);
        expect(calls.messages).toHaveLength(1);
    });
    it("recovers persisted active identity after launcher restart", async () => {
        const root = await mkdtemp(join(tmpdir(), "restart-recovery-"));
        const path = join(root, "state.json");
        let current = fixture("running", "zcode");
        const calls = { resumes: 0, messages: [] as string[] };
        const native = fakeAdapter(() => current, calls);
        const settings = new SessionAutostartStore(join(root, "settings.json"), {});
        await new UnfinishedSessionLauncher({ adapters: new Map([["zcode", native]]), store: new UnfinishedSessionStore(path), settingsStore: settings }).handleEvent("zcode", { kind: "turn.started", harness: "zcode", sessionId: current.id, data: { turnId: "t1" } });
        current = { ...current, status: "error" };
        const restarted = new UnfinishedSessionLauncher({ adapters: new Map([["zcode", native]]), store: new UnfinishedSessionStore(path), settingsStore: settings });
        await restarted.handleEvent("zcode", { kind: "turn.failed", harness: "zcode", sessionId: current.id, data: { turnId: "t1" } });
        await restarted.recoverPending();
        expect(calls.resumes).toBe(1);
        expect(calls.messages).toHaveLength(1);
    });
    it("matching completion supersedes recovery evidence while unrelated completion does not", async () => {
        const root = await mkdtemp(join(tmpdir(), "completion-order-"));
        let current = fixture("running", "zcode");
        const calls = { resumes: 0, messages: [] as string[] };
        const state = new UnfinishedSessionStore(join(root, "state.json"));
        const launcher = new UnfinishedSessionLauncher({ adapters: new Map([["zcode", fakeAdapter(() => current, calls)]]), store: state, settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}), discoveryIdleMs: 1 });
        await launcher.handleEvent("zcode", { kind: "turn.started", harness: "zcode", sessionId: current.id, data: { turnId: "t1" } });
        await launcher.handleEvent("zcode", { kind: "turn.completed", harness: "zcode", sessionId: current.id, data: { turnId: "other" } });
        current = { ...current, status: "error" };
        await launcher.handleEvent("zcode", { kind: "turn.failed", harness: "zcode", sessionId: current.id, data: { turnId: "t1" } });
        current = { ...current, status: "idle" };
        await launcher.handleEvent("zcode", { kind: "turn.completed", harness: "zcode", sessionId: current.id, data: { turnId: "t1" } });
        await launcher.recoverPending();
        expect(calls).toEqual({ resumes: 0, messages: [] });
        expect(await state.list()).toEqual([]);
    });
    it("cancels a reserved recovery when matching completion arrives during beginAttempt", async () => {
        const root = await mkdtemp(join(tmpdir(), "completion-during-reserve-"));
        const state = new UnfinishedSessionStore(join(root, "state.json"));
        let current = fixture("error", "zcode");
        const calls = { resumes: 0, messages: [] as string[] };
        await state.markRecoveryEligible(current, "turn.failed", { turnId: "t1" });
        const launcher = new UnfinishedSessionLauncher({ adapters: new Map([["zcode", fakeAdapter(() => current, calls)]]), store: state, settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}), discoveryIdleMs: 1 });
        const original = state.beginAttempt.bind(state);
        state.beginAttempt = async (...args: Parameters<typeof state.beginAttempt>) => {
            const attempt = await original(...args);
            current = { ...current, status: "idle" };
            await launcher.handleEvent("zcode", { kind: "turn.completed", harness: "zcode", sessionId: current.id, data: { turnId: "t1" } });
            return attempt;
        };
        await launcher.recoverPending();
        expect(calls).toEqual({ resumes: 0, messages: [] });
    });
    it("drops durable recovery when restart snapshot proves that exact turn completed", async () => {
        const root = await mkdtemp(join(tmpdir(), "snapshot-completion-"));
        const state = new UnfinishedSessionStore(join(root, "state.json"));
        let current = { ...fixture("idle", "codex"), meta: { nativeLastTurn: { turnId: "t1", status: "completed" } } };
        const calls = { resumes: 0, messages: [] as string[] };
        await state.markRecoveryEligible(current, "turn.failed", { turnId: "t1" });
        await new UnfinishedSessionLauncher({ adapters: new Map([["codex", fakeAdapter(() => current, calls)]]), store: state, settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}) }).recoverPending();
        expect(calls).toEqual({ resumes: 0, messages: [] });
        expect(await state.list()).toEqual([]);
    });
    it("gates already durable causes when recovery is disabled", async () => {
        const root = await mkdtemp(join(tmpdir(), "disabled-recovery-"));
        const state = new UnfinishedSessionStore(join(root, "state.json"));
        const settings = new SessionAutostartStore(join(root, "settings.json"), {});
        let current = fixture("error");
        const calls = { resumes: 0, messages: [] as string[] };
        await state.markRecoveryEligible(current, "turn.failed", { turnId: "t1" });
        const cfg = await settings.getSettings();
        await settings.setRuntimeSettings({ inventoryWindowHours: cfg.inventoryWindowHours, evidenceMessageCount: cfg.evidenceMessageCount, judgeModel: cfg.judgeModel, autopilotJudgeModel: cfg.autopilotJudgeModel, recoverOnFailure: false });
        await new UnfinishedSessionLauncher({ adapters: new Map([["codex", fakeAdapter(() => current, calls)]]), store: state, settingsStore: settings }).recoverPending();
        expect(calls).toEqual({ resumes: 0, messages: [] });
        expect(await state.list()).toEqual([]);
    });
    it("blocks waiting, human-held, and non-retryable admissions", async () => {
        const root = await mkdtemp(join(tmpdir(), "recovery-gates-"));
        let current = fixture("needs_input");
        const calls = { resumes: 0, messages: [] as string[] };
        const state = new UnfinishedSessionStore(join(root, "state.json"));
        await state.markRecoveryEligible(current, "turn.failed", { turnId: "t1" });
        const stops = getHumanStopStore({ AGENT_HERDER_HUMAN_STOP_STORE: join(root, "stops.json") });
        await stops.hold(current, { id: "stop", at: new Date().toISOString(), reason: "interrupted", turnId: "t1" });
        await new UnfinishedSessionLauncher({ humanStopStore: stops, adapters: new Map([["codex", fakeAdapter(() => current, calls)]]), store: state, settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}) }).recoverPending();
        expect(calls).toEqual({ resumes: 0, messages: [] });
        expect(await state.list()).toEqual([]);
        current = fixture("error");
        await state.markRecoveryEligible(current, "turn.failed", { turnId: "t2" });
        await state.markStarted(current, "accepted", new Date(), true, true, false, "non-retryable");
        await new UnfinishedSessionLauncher({ adapters: new Map([["codex", fakeAdapter(() => current, calls)]]), store: state, settingsStore: new SessionAutostartStore(join(root, "settings2.json"), {}) }).recoverPending();
        expect(calls).toEqual({ resumes: 0, messages: [] });
    });
    it("strictly excludes Codex subagent children from records, inventory, notices, and actions", async () => {
        const root = await mkdtemp(join(tmpdir(), "subagent-exclusion-"));
        let current = { ...fixture(), meta: { threadSource: "subagent" } };
        const calls = { resumes: 0, messages: [] as string[] };
        const notices: UnfinishedSessionNotice[] = [];
        const state = new UnfinishedSessionStore(join(root, "state.json"));
        const launcher = new UnfinishedSessionLauncher({ adapters: new Map([["codex", fakeAdapter(() => current, calls)]]), store: state, settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}), notify: async (notice) => { notices.push(notice); } });
        await launcher.recoverPending();
        await launcher.recoverPending();
        await launcher.recoverPending();
        current = { ...current, status: "running" };
        await launcher.handleEvent("codex", { kind: "turn.started", harness: "codex", sessionId: current.id, data: { turnId: "child" } });
        current = { ...current, status: "error" };
        await launcher.handleEvent("codex", { kind: "turn.failed", harness: "codex", sessionId: current.id, data: { turnId: "child" } });
        expect(calls).toEqual({ resumes: 0, messages: [] });
        expect(await state.list()).toEqual([]);
        expect(await state.listInventory()).toEqual([]);
        expect(notices).toEqual([]);
    });
    it("recovers a proven stalled active turn only with watchdog opt-in", async () => {
        const root = await mkdtemp(join(tmpdir(), "stalled-watchdog-"));
        let current = { ...fixture("running", "zcode"), lastActivity: new Date(Date.now() - 60000).toISOString() };
        const calls = { resumes: 0, messages: [] as string[] };
        const settings = new SessionAutostartStore(join(root, "settings.json"), {});
        const cfg = await settings.getSettings();
        await settings.setRuntimeSettings({ inventoryWindowHours: cfg.inventoryWindowHours, evidenceMessageCount: cfg.evidenceMessageCount, judgeModel: cfg.judgeModel, autopilotJudgeModel: cfg.autopilotJudgeModel, watchdogEnabled: true, watchdogIntervalSeconds: 5, stalledTurnMinutes: 1 });
        const launcher = new UnfinishedSessionLauncher({ adapters: new Map([["zcode", fakeAdapter(() => current, calls)]]), store: new UnfinishedSessionStore(join(root, "state.json")), settingsStore: settings, watchdogIntervalMs: 5, stalledTurnMs: 1, discoveryIdleMs: 1 });
        await launcher.handleEvent("zcode", { kind: "turn.started", harness: "zcode", sessionId: current.id, data: { turnId: "stalled" } });
        const stop = launcher.start();
        await waitUntil(() => calls.messages.length === 1);
        stop();
        expect(calls.resumes).toBe(1);
        expect(calls.messages).toHaveLength(1);
    });
    it("retires completed-turn race fences after operations settle", async () => {
        const root = await mkdtemp(join(tmpdir(), "fence-retirement-"));
        const calls = { resumes: 0, messages: [] as string[] };
        const current = fixture();
        const launcher = new UnfinishedSessionLauncher({ adapters: new Map([["codex", fakeAdapter(() => current, calls)]]), store: new UnfinishedSessionStore(join(root, "state.json")), settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}) });
        for (let turn = 0; turn < 200; turn++) {
            await launcher.handleEvent("codex", { kind: "turn.completed", harness: "codex", sessionId: current.id, data: { turnId: `completed-${turn}` } });
        }
        const fences = launcher as unknown as { turnGenerations: Map<string, number>; eagerCompletions: Set<string>; fenceUsers: number };
        expect(fences.fenceUsers).toBe(0);
        expect(fences.turnGenerations.size).toBe(0);
        expect(fences.eagerCompletions.size).toBe(0);
        expect(calls).toEqual({ resumes: 0, messages: [] });
    });

});
