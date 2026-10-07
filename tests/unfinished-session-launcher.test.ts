import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { completionEvidence, createAnthropicCompatibleSessionCompletionJudge, fitBatchContext, SessionAutostartStore, UnfinishedSessionLauncher, UnfinishedSessionStore, type UnfinishedSessionNotice } from "../src/autopilot/unfinished-session-launcher.js";
import { AutopilotPolicyStore } from "../src/autopilot/policy-store.js";
import { AutopilotSessionStore } from "../src/autopilot/session-store.js";
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
function coldFailureSession(overrides: Record<string, unknown> = {}): AgentSession {
    const completedAt = Date.now() - 60000;
    return { ...fixture("stopped", "zcode"), meta: { nativeLastTurn: { turnId: "native-turn-1", status: "error", startedAt: completedAt - 10000, completedAt, userMessageId: "user-message-1", rootSession: true, cancelledByUser: false, retryable: true, userMessageMatchesLatest: true, assistantSucceeded: false, progressedAfterFailure: false, pendingInput: false, errorType: "provider_error", errorCode: "E_RETRY", ...overrides } } };
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
    it("runs a ZCode-only semantic backlog through enabled Autopilot and preserves each session id", async () => {
        const root = await mkdtemp(join(tmpdir(), "semantic-zcode-autopilot-"));
        const sessions = [fixture("idle", "zcode", "zcode-1"), fixture("idle", "zcode", "zcode-2")];
        const calls = { resumes: [] as string[], messages: [] as Array<{ id: string; message: string }> };
        const adapter: HarnessAdapter = {
            type: "zcode", name: "fixture", async init() { }, async listSessions() { return sessions.map((session) => ({ ...session })); },
            async getSession(id) { return sessions.find((session) => session.id === id) ?? null; },
            async getSessionMessages(id) { return [{ id: `${id}-u`, role: "user", text: `finish ${id}`, parts: [{ type: "text", text: `finish ${id}` }] }]; },
            async resumeSession(id) { calls.resumes.push(id); return { ok: true }; },
            async sendMessage(id, input) { calls.messages.push({ id, message: input.message }); return { ok: true }; },
            async stopSession() { return { ok: true }; }, async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
        };
        const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
        await policyStore.replacePolicy({ schemaVersion: 1, enabled: true, harnesses: ["zcode"], scope: { mode: "all_ingress" }, maxContinuationsPerSession: 10, timeout: { mode: "auto_continue", delayMs: 1000 }, card: { includeUserMessage: true, includeAssistantMessage: true, includeReason: true } }, null);
        const launcher = new UnfinishedSessionLauncher({
            adapters: new Map([["zcode", adapter]]), store: new UnfinishedSessionStore(join(root, "state.json")),
            settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}), autopilotPolicyStore: policyStore,
            autopilotSessionStore: new AutopilotSessionStore(join(root, "sessions.json")), discoveryIdleMs: 1,
            judge: { async decide() { return { verdict: "unfinished", reason: "work remains", confidence: 1 }; }, async plan({ sessions: candidates }) { return { groups: [{ sourceSessionIds: candidates.map(({ session }) => session.id), primarySessionId: candidates[0]!.session.id, verdict: "unfinished", reason: "work remains", confidence: 1, topic: "shared topic", handoff: "finish the task" }] }; } },
        });
        await launcher.recoverPending();
        expect(calls.resumes.sort()).toEqual(["zcode-1", "zcode-2"]);
        expect(calls.messages.map(({ id }) => id).sort()).toEqual(["zcode-1", "zcode-2"]);
    });
    it("does not inventory or resume Codex when the durable Autopilot policy selects only ZCode", async () => {
        const root = await mkdtemp(join(tmpdir(), "semantic-zcode-only-"));
        const current = fixture("idle", "codex", "codex-1");
        const calls = { resumes: 0, messages: [] as string[] };
        let plans = 0;
        const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
        await policyStore.replacePolicy({ schemaVersion: 1, enabled: true, harnesses: ["zcode"], scope: { mode: "all_ingress" }, maxContinuationsPerSession: 10, timeout: { mode: "auto_continue", delayMs: 1000 }, card: { includeUserMessage: true, includeAssistantMessage: true, includeReason: true } }, null);
        const launcher = new UnfinishedSessionLauncher({
            adapters: new Map([["codex", fakeAdapter(() => current, calls)]]), store: new UnfinishedSessionStore(join(root, "state.json")),
            settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}), autopilotPolicyStore: policyStore,
            autopilotSessionStore: new AutopilotSessionStore(join(root, "sessions.json")), discoveryIdleMs: 1,
            judge: { async decide() { return { verdict: "unfinished", reason: "work remains", confidence: 1 }; }, async plan() { plans += 1; return { groups: [] }; } },
        });
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
    it.each(["transport failure", "native absence"])("preserves durable state during watchdog %s", async (outcome) => {
        const root = await mkdtemp(join(tmpdir(), "watchdog-unavailable-"));
        const current = fixture("running", "zcode");
        const calls = { resumes: 0, messages: [] as string[] };
        const adapter = fakeAdapter(() => current, calls);
        let reads = 0;
        adapter.getSession = async () => {
            reads += 1;
            if (outcome === "transport failure") throw new Error("native transport unavailable");
            return null;
        };
        const state = new UnfinishedSessionStore(join(root, "state.json"));
        await state.markStarted(current, "existing-owner");
        const before = await state.list();
        const settings = new SessionAutostartStore(join(root, "settings.json"), {});
        const cfg = await settings.getSettings();
        await settings.setRuntimeSettings({ ...cfg, enabled: true, watchdogEnabled: true });
        await settings.setSession({ harness: current.harness, sessionId: current.id, cwd: current.cwd }, true);
        const launcher = new UnfinishedSessionLauncher({ adapters: new Map([["zcode", adapter]]), store: state, settingsStore: settings });
        const watchdog = launcher as unknown as { started: boolean; runWatchdog(): Promise<void>; urgentSessions: Set<string> };
        watchdog.started = true;
        try {
            for (let pass = 0; pass < 4; pass++) await watchdog.runWatchdog();
            expect(reads).toBe(4);
            expect(await state.list()).toEqual(before);
            expect(watchdog.urgentSessions.size).toBe(0);
            expect(calls).toEqual({ resumes: 0, messages: [] });
        } finally {
            watchdog.started = false;
        }
    });
    it.each(["attempt", "resume", "send"])("defers fleet admission at %s without consuming a recovery retry", async (heldOperation) => {
        const root = await mkdtemp(join(tmpdir(), "fleet-admission-recovery-"));
        const current = fixture("error", "zcode");
        const calls = { resumes: 0, messages: [] as string[] };
        const state = new UnfinishedSessionStore(join(root, "state.json"));
        await state.markRecoveryEligible(current, "turn.failed", { turnId: "failed" });
        const settings = new SessionAutostartStore(join(root, "settings.json"), {});
        const cfg = await settings.getSettings();
        await settings.setRuntimeSettings({ ...cfg, enabled: true });
        await settings.setSession({ harness: current.harness, sessionId: current.id, cwd: current.cwd }, true);
        const gate = async (_session: AgentSession, operation: string) => operation === heldOperation
            ? { allowed: false as const, reason: "existing owner resource hold" } : { allowed: true as const };
        const adapter = fakeAdapter(() => current, calls);
        let nativeReads = 0;
        adapter.getSession = async () => { nativeReads += 1; return current; };
        const makeLauncher = () => new UnfinishedSessionLauncher({ adapters: new Map([["zcode", adapter]]), store: state, settingsStore: settings, admissionGate: gate, discoveryIdleMs: 1 });
        await makeLauncher().recoverPending();
        const [held] = await state.list();
        expect(held.attempts).toBe(0);
        expect(held.recoveryCause).toBe("turn.failed");
        expect(held.lastError).toBeUndefined();
        expect(calls.messages).toEqual([]);
        expect(calls.resumes).toBe(heldOperation === "send" ? 1 : 0);
        if (heldOperation === "attempt") {
            expect(nativeReads).toBe(0);
            await makeLauncher().recoverPending();
            expect((await state.list())[0].attempts).toBe(0);
            expect(calls).toEqual({ resumes: 0, messages: [] });
        }
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

    it("ingests one exact cold ZCode failure and preserves its admission across restart", async () => {
        const root = await mkdtemp(join(tmpdir(), "cold-failure-"));
        const path = join(root, "state.json");
        const current = coldFailureSession();
        const calls = { init: 0, gets: 0, resumes: 0, messages: [] as string[] };
        const adapter = fakeAdapter(() => current, calls);
        adapter.init = async () => { calls.init += 1; };
        adapter.getSession = async () => { calls.gets += 1; return current; };
        const settings = new SessionAutostartStore(join(root, "settings.json"), {});
        const state = new UnfinishedSessionStore(path);
        await new UnfinishedSessionLauncher({ adapters: new Map([["zcode", adapter]]), store: state, settingsStore: settings, discoveryIdleMs: 1 }).recoverPending();
        const admitted = (await state.list())[0]!;
        await new UnfinishedSessionLauncher({ adapters: new Map([["zcode", adapter]]), store: new UnfinishedSessionStore(path), settingsStore: settings, discoveryIdleMs: 1 }).recoverPending();
        expect(calls.init).toBe(0);
        expect(calls.resumes).toBe(1);
        expect(calls.messages).toHaveLength(1);
        expect((await new UnfinishedSessionStore(path).list())[0]).toMatchObject({ recoveryTurnId: "native-turn-1", recoveryInputId: "user-message-1", attempts: admitted.attempts, acceptedAt: admitted.acceptedAt, admissionPhase: "accepted_pending" });
    });

    it("keeps non-retryable, unknown, and human-required cold failures blocked without native RPC", async () => {
        for (const [name, overrides] of [
            ["nonretryable", { retryable: false }],
            ["unknown", { retryable: undefined }],
            ["captcha", { retryable: true, errorType: "CAPTCHA_REQUIRED" }],
            ["canonical-human", { retryable: false, errorType: "UNKNOWN_ERROR", errorCode: "UNKNOWN", requiresHuman: true, blockedReason: "CAPTCHA challenge" }],
        ] as const) {
            const root = await mkdtemp(join(tmpdir(), `cold-blocked-${name}-`));
            const current = coldFailureSession(overrides);
            const calls = { init: 0, gets: 0, resumes: 0, messages: [] as string[] };
            const adapter = fakeAdapter(() => current, calls);
            adapter.init = async () => { calls.init += 1; };
            adapter.getSession = async () => { calls.gets += 1; return current; };
            const state = new UnfinishedSessionStore(join(root, "state.json"));
            await new UnfinishedSessionLauncher({ adapters: new Map([["zcode", adapter]]), store: state, settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}) }).recoverPending();
            expect(calls).toEqual({ init: 0, gets: 0, resumes: 0, messages: [] });
            expect((await state.list())[0]).toMatchObject({ recoveryTurnId: "native-turn-1", attempts: 0, state: "active" });
            expect((await state.list())[0]?.recoveryBlockedReason).toBeTruthy();
            expect((await state.list())[0]?.acceptedAt).toBeUndefined();
        }
    });

    it("recovers one exact remote SSH cancellation as transport loss in the same ZCode session", async () => {
        const root = await mkdtemp(join(tmpdir(), "cold-ssh-transport-loss-"));
        const current = { ...coldFailureSession({ status: "cancelled", retryable: false, cancelledByUser: true, transportLost: true }), meta: { ...coldFailureSession().meta, persistedTaskStatus: "running", workspaceIdentity: "remote:ssh:example.test:22:user:/workspace", nativeLastTurn: { ...(coldFailureSession().meta!.nativeLastTurn as Record<string, unknown>), status: "cancelled", retryable: false, cancelledByUser: true, transportLost: true, userMessageMatchesLatest: false, progressedAfterFailure: true } } };
        const calls = { resumes: 0, messages: [] as string[] };
        const state = new UnfinishedSessionStore(join(root, "state.json"));
        await new UnfinishedSessionLauncher({ adapters: new Map([["zcode", fakeAdapter(() => current, calls)]]), store: state, settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}) }).recoverPending();
        expect(calls.resumes).toBe(1);
        expect(calls.messages).toHaveLength(1);
        expect((await state.list())[0]).toMatchObject({ sessionId: current.id, recoveryTurnId: "native-turn-1", admissionPhase: "accepted_pending" });
    });

    it("does not ingest a cold failure while the same root session is human-held", async () => {
        const root = await mkdtemp(join(tmpdir(), "cold-human-held-"));
        const current = coldFailureSession();
        const calls = { init: 0, gets: 0, resumes: 0, messages: [] as string[] };
        const adapter = fakeAdapter(() => current, calls);
        adapter.init = async () => { calls.init += 1; };
        adapter.getSession = async () => { calls.gets += 1; return current; };
        const stops = getHumanStopStore({ AGENT_HERDER_HUMAN_STOP_STORE: join(root, "stops.json") });
        await stops.hold(current, { id: "cold-stop", at: new Date().toISOString(), reason: "user stop", turnId: "native-turn-1" });
        const state = new UnfinishedSessionStore(join(root, "state.json"));
        await new UnfinishedSessionLauncher({ humanStopStore: stops, adapters: new Map([["zcode", adapter]]), store: state, settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}) }).recoverPending();
        expect(calls).toEqual({ init: 0, gets: 0, resumes: 0, messages: [] });
        expect(await state.list()).toEqual([]);
    });

    it("does not replace a different accepted native admission with a lagging cold failure", async () => {
        const root = await mkdtemp(join(tmpdir(), "cold-existing-admission-"));
        const current = coldFailureSession();
        const state = new UnfinishedSessionStore(join(root, "state.json"));
        await state.markStarted(current, "already-admitted", new Date(), true, true, true);
        const before = (await state.list())[0]!;
        const calls = { resumes: 0, messages: [] as string[] };
        await new UnfinishedSessionLauncher({ adapters: new Map([["zcode", fakeAdapter(() => current, calls)]]), store: state, settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}) }).recoverPending();
        expect(calls).toEqual({ resumes: 0, messages: [] });
        expect((await state.list())[0]).toEqual(before);
    });

    it("preserves a same-turn disconnect admission when cold failure evidence arrives after restart", async () => {
        const root = await mkdtemp(join(tmpdir(), "cold-same-turn-disconnect-"));
        const current = coldFailureSession();
        const state = new UnfinishedSessionStore(join(root, "state.json"));
        await state.markRecoveryEligible(current, "process.disconnected", { turnId: "native-turn-1" });
        await state.markStarted(current, "already-admitted", new Date(), false, true, true);
        const before = (await state.list())[0]!;
        const calls = { resumes: 0, messages: [] as string[] };
        await new UnfinishedSessionLauncher({ adapters: new Map([["zcode", fakeAdapter(() => current, calls)]]), store: state, settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}) }).recoverPending();
        expect(calls).toEqual({ resumes: 0, messages: [] });
        expect((await state.list())[0]).toEqual(before);
    });

    it("requires enabled recovery and a fresh exact root failure receipt", async () => {
        const rejected = [
            { rootSession: false },
            { status: "completed" },
            { cancelledByUser: true },
            { userMessageMatchesLatest: false },
            { assistantSucceeded: true },
            { progressedAfterFailure: true },
            { pendingInput: true },
            { pendingInput: undefined },
            { completedAt: Date.now() - 49 * 60 * 60 * 1000 },
            { completedAt: Number.MAX_SAFE_INTEGER },
        ];
        for (const overrides of rejected) {
            const root = await mkdtemp(join(tmpdir(), "cold-rejected-"));
            const current = coldFailureSession(overrides);
            const calls = { resumes: 0, messages: [] as string[] };
            const state = new UnfinishedSessionStore(join(root, "state.json"));
            await new UnfinishedSessionLauncher({ adapters: new Map([["zcode", fakeAdapter(() => current, calls)]]), store: state, settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}) }).recoverPending();
            expect(calls).toEqual({ resumes: 0, messages: [] });
            expect(await state.list()).toEqual([]);
        }
        const root = await mkdtemp(join(tmpdir(), "cold-disabled-"));
        const settings = new SessionAutostartStore(join(root, "settings.json"), {});
        const config = await settings.getSettings();
        await settings.setRuntimeSettings({ inventoryWindowHours: config.inventoryWindowHours, evidenceMessageCount: config.evidenceMessageCount, judgeModel: config.judgeModel, autopilotJudgeModel: config.autopilotJudgeModel, recoverOnFailure: false });
        const state = new UnfinishedSessionStore(join(root, "state.json"));
        const calls = { resumes: 0, messages: [] as string[] };
        await new UnfinishedSessionLauncher({ adapters: new Map([["zcode", fakeAdapter(() => coldFailureSession(), calls)]]), store: state, settingsStore: settings }).recoverPending();
        expect(calls).toEqual({ resumes: 0, messages: [] });
        expect(await state.list()).toEqual([]);
    });

});
