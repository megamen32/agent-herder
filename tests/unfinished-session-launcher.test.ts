import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { completionEvidence, createAnthropicCompatibleSessionCompletionJudge, fitBatchContext, SessionAutostartStore, UnfinishedSessionLauncher, UnfinishedSessionStore, type UnfinishedSessionNotice } from "../src/autopilot/unfinished-session-launcher.js";
import { AutopilotPolicyStore } from "../src/autopilot/policy-store.js";
import { AutopilotSessionStore } from "../src/autopilot/session-store.js";
import { AutomationLaunchPolicyStore } from "../src/automation-launch-policy.js";
import { getHumanStopStore, HumanStopStore } from "../src/human-stop-store.js";
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
    // Fast unit: a human Stop during the final semantic read must prevent a
    // native action, including a rollover which would create a new identity.
    // Expected <2s, maximum 10s; all stores and adapters are isolated.
    it.each(["resume", "send", "create"] as const)("honors a human hold during the final semantic read before %s", async (operation) => {
        const root = await mkdtemp(join(tmpdir(), "late-semantic-human-stop-"));
        try {
            const current = { ...fixture("idle", "zcode", `held-${operation}`), ...(operation === "create" ? { model: "minimax-m3", lastActivity: new Date(Date.now() - 10 * 60000).toISOString() } : {}) };
            const calls = { resumes: 0, messages: [] as string[] };
            let creates = 0, armed = false;
            const adapter = fakeAdapter(() => current, calls);
            adapter.createSession = async () => { creates += 1; return { ...current, id: "new-identity" }; };
            const stops = new HumanStopStore(join(root, "stops.json"));
            const policyStore = new AutopilotPolicyStore(join(root, "policy.json"));
            await policyStore.replacePolicy({ schemaVersion: 1, enabled: true, harnesses: ["zcode"], scope: { mode: "all_ingress" }, maxContinuationsPerSession: 10, timeout: { mode: "auto_continue", delayMs: 1000 }, card: { includeUserMessage: true, includeAssistantMessage: true, includeReason: true } }, null);
            const read = policyStore.readEffective.bind(policyStore);
            policyStore.readEffective = async () => {
                const effective = await read();
                if (armed) {
                    armed = false;
                    await stops.hold(current, { id: "manual-stop-during-policy-read", at: new Date().toISOString(), reason: "human Stop" });
                }
                return effective;
            };
            const settings = new SessionAutostartStore(join(root, "settings.json"), {});
            await settings.setRuntimeSettings({ inventoryWindowHours: 48, evidenceMessageCount: 200, judgeModel: "fixture", autopilotJudgeModel: "fixture", rolloverExpiredCache: true });
            const launcher = new UnfinishedSessionLauncher({
                adapters: new Map([["zcode", adapter]]), store: new UnfinishedSessionStore(join(root, "unfinished.json")), settingsStore: settings,
                autopilotPolicyStore: policyStore, autopilotSessionStore: new AutopilotSessionStore(join(root, "sessions.json")), humanStopStore: stops, discoveryIdleMs: 1,
                admissionGate: async (_session, requested) => { if (requested === operation) armed = true; return { allowed: true }; },
                judge: {
                    async decide() { return { verdict: "unfinished", reason: "work remains", confidence: 1 }; },
                    async plan({ sessions }) { return { groups: [{ sourceSessionIds: sessions.map(({ session }) => session.id), primarySessionId: current.id, verdict: "unfinished", reason: "work remains", confidence: 1, topic: "task", handoff: "continue" }] }; },
                },
            });
            await launcher.runAutopilotCycle();
            expect(creates).toBe(0);
            expect(calls.messages).toEqual([]);
            expect(calls.resumes).toBe(operation === "send" ? 1 : 0);
            expect(await stops.isHeld("zcode", current.id)).toBe(true);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
    // Fast unit: reproduce opt-out during an awaited planner/attach/admission
    // boundary. Expected <2s, maximum 10s; no native/provider activity.
    it.each(["plan", "resume", "admission"] as const)("honors a late session opt-out during %s before admitting another prompt", async (boundary) => {
        const root = await mkdtemp(join(tmpdir(), "late-autopilot-opt-out-"));
        try {
            const current = fixture("idle", "zcode", `late-opt-out-${boundary}`);
            const calls = { resumes: 0, messages: [] as string[] };
            const adapter = fakeAdapter(() => current, calls);
            const policyStore = new AutopilotPolicyStore(join(root, "policy.json"));
            await policyStore.replacePolicy({ schemaVersion: 1, enabled: true, harnesses: ["zcode"], scope: { mode: "all_ingress" }, maxContinuationsPerSession: 10, timeout: { mode: "auto_continue", delayMs: 1000 }, card: { includeUserMessage: true, includeAssistantMessage: true, includeReason: true } }, null);
            const overrides = new AutopilotSessionStore(join(root, "sessions.json"));
            const disable = () => overrides.set({ harness: "zcode", sessionId: current.id, cwd: current.cwd }, false);
            adapter.resumeSession = async () => {
                calls.resumes += 1;
                if (boundary === "resume") await disable();
                return { ok: true };
            };
            const launcher = new UnfinishedSessionLauncher({
                adapters: new Map([["zcode", adapter]]), store: new UnfinishedSessionStore(join(root, "unfinished.json")),
                settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}),
                autopilotPolicyStore: policyStore, autopilotSessionStore: overrides, discoveryIdleMs: 1,
                admissionGate: async (_session, operation) => {
                    if (boundary === "admission" && operation === "send") await disable();
                    return { allowed: true };
                },
                judge: {
                    async decide() { return { verdict: "unfinished", reason: "work remains", confidence: 1 }; },
                    async plan({ sessions }) {
                        if (boundary === "plan") await disable();
                        return { groups: [{ sourceSessionIds: sessions.map(({ session }) => session.id), primarySessionId: current.id, verdict: "unfinished", reason: "work remains", confidence: 1, topic: "task", handoff: "continue" }] };
                    },
                },
            });
            await launcher.runAutopilotCycle();
            expect(calls.messages).toEqual([]);
            expect(calls.resumes).toBe(boundary === "plan" ? 0 : 1);
            expect((await overrides.get("zcode", current.id))?.enabled).toBe(false);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
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
    it("runs Autopilot independently with recovery disabled and preserves each ZCode session id", async () => {
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
        const recoverySettings = new SessionAutostartStore(join(root, "settings.json"), {});
        await recoverySettings.setGlobal(false);
        const launcher = new UnfinishedSessionLauncher({
            adapters: new Map([["zcode", adapter]]), store: new UnfinishedSessionStore(join(root, "state.json")),
            settingsStore: recoverySettings, autopilotPolicyStore: policyStore,
            autopilotSessionStore: new AutopilotSessionStore(join(root, "sessions.json")), discoveryIdleMs: 1,
            judge: { async decide() { return { verdict: "unfinished", reason: "work remains", confidence: 1 }; }, async plan({ sessions: candidates }) { return { groups: [{ sourceSessionIds: candidates.map(({ session }) => session.id), primarySessionId: candidates[0]!.session.id, verdict: "unfinished", reason: "work remains", confidence: 1, topic: "shared topic", handoff: "finish the task" }] }; } },
        });
        await launcher.runAutopilotCycle();
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
        await launcher.runAutopilotCycle();
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

    it("recovers a local runtime shutdown once, preserving newer work, native queues and human stops", async () => {
        for (const mode of ["shutdown", "new-desktop-work", "pending-native-input", "human-stop"] as const) {
            const root = await mkdtemp(join(tmpdir(), `cold-local-runtime-${mode}-`));
            const current = coldFailureSession({ status: "cancelled", retryable: false, cancelledByUser: true,
                transportLost: true, pendingInput: mode === "pending-native-input" });
            if (mode === "new-desktop-work") current.status = "running";
            const calls = { resumes: 0, messages: [] as string[] };
            const state = new UnfinishedSessionStore(join(root, "state.json"));
            const stops = getHumanStopStore({ AGENT_HERDER_HUMAN_STOP_STORE: join(root, "stops.json") });
            if (mode === "human-stop") await stops.hold(current, { id: "local-explicit-stop", at: new Date().toISOString(), reason: "user stop", turnId: "native-turn-1" });
            const options = { humanStopStore: stops, adapters: new Map([["zcode", fakeAdapter(() => current, calls)]]),
                store: state, settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}) };
            await new UnfinishedSessionLauncher(options).recoverPending();
            await new UnfinishedSessionLauncher({ ...options, store: new UnfinishedSessionStore(join(root, "state.json")) }).recoverPending();
            expect(calls.resumes).toBe(mode === "shutdown" ? 1 : 0);
            expect(calls.messages).toHaveLength(mode === "shutdown" ? 1 : 0);
            if (mode === "shutdown") expect((await state.list())[0]).toMatchObject({sessionId: current.id, recoveryTurnId: "native-turn-1", admissionPhase: "accepted_pending"});
            else expect(await state.list()).toEqual([]);
            await rm(root, {recursive:true,force:true});
        }
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

describe("original task completion evidence", () => {
    it("assesses same-title original and replacement independently without native actions", async () => {
        const root = await mkdtemp(join(tmpdir(), "original-completion-"));
        const original = fixture("idle", "codex", "original");
        const replacement = { ...fixture("idle", "codex", "replacement"), lastActivity: new Date(Date.now() - 30000).toISOString() };
        const calls = { resumes: 0, messages: [] as string[] };
        const adapter = fakeAdapter(() => original, calls);
        adapter.listSessions = async () => [replacement, original];
        adapter.getSession = async (id) => id === original.id ? original : replacement;
        const assessed: string[] = [];
        const store = new UnfinishedSessionStore(join(root, "state.json"));
        const launcher = new UnfinishedSessionLauncher({
            adapters: new Map([["codex", adapter]]), store,
            settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}),
            discoveryIdleMs: 1,
            judge: { async decide({ session }) {
                assessed.push(session.id);
                return { verdict: "unfinished", reason: "consumer acceptance is pending", confidence: 1 };
            } },
        });
        await launcher.auditInventory();
        expect(assessed.sort()).toEqual(["original", "replacement"]);
        expect((await store.listInventory()).map((record) => record.verdict?.verdict)).toEqual(["unfinished", "unfinished"]);
        expect(calls).toEqual({ resumes: 0, messages: [] });
    });

    // Fast unit: a backlog wider than the safe planner window is a capacity fact,
    // not a reason to refuse every session. The fixture carries the real
    // reserved-envelope shape (eight user messages per session), so it also
    // catches a window measured against less than the phase really reserves.
    // Expected <5s, maximum 30s; judge.plan is a stub and no native action runs.
    it("plans a bounded priority window instead of refusing an oversized backlog", async () => {
        const root = await mkdtemp(join(tmpdir(), "oversized-backlog-"));
        try {
            const sessions: AgentSession[] = Array.from({ length: 124 }, (_, index) => ({
                ...fixture("idle", "zcode", `backlog-${index}`),
                cwd: `/tmp/oversized-backlog-${index}`,
                lastActivity: new Date(Date.now() - (index + 1) * 1000).toISOString(),
            }));
            const calls = { resumes: 0, messages: [] as string[] };
            const adapter = fakeAdapter(() => sessions[0]!, calls);
            adapter.listSessions = async () => sessions.map((session) => ({ ...session }));
            adapter.getSessionMessages = async () => Array.from({ length: 8 }, (_, index) => ({ id: `u${index}`, role: "user" as const, text: `задача ${index} ${"я".repeat(1200)}`, parts: [{ type: "text" as const, text: `задача ${index} ${"я".repeat(1200)}` }] }));
            const planned: string[] = [];
            let planCalls = 0;
            const policyStore = new AutopilotPolicyStore(join(root, "policy.json"));
            await policyStore.replacePolicy({ schemaVersion: 1, enabled: true, harnesses: ["zcode"], scope: { mode: "all_ingress" }, maxContinuationsPerSession: 10, timeout: { mode: "auto_continue", delayMs: 1000 }, card: { includeUserMessage: true, includeAssistantMessage: true, includeReason: true } }, null);
            const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
            const launcher = new UnfinishedSessionLauncher({
                adapters: new Map([["zcode", adapter]]), store,
                settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}),
                autopilotPolicyStore: policyStore, autopilotSessionStore: new AutopilotSessionStore(join(root, "sessions.json")),
                discoveryIdleMs: 1,
                judge: {
                    async decide() { return { verdict: "unfinished", reason: "work remains", confidence: 1 }; },
                    async plan({ sessions: plannedSessions }) {
                        planned.push(...plannedSessions.map(({ session }) => session.id));
                        planCalls += 1;
                        return { groups: plannedSessions.map(({ session }) => ({ sourceSessionIds: [session.id], primarySessionId: session.id, verdict: "completed", reason: "verified", confidence: 1, topic: "task", handoff: "" })) };
                    },
                },
            });
            await launcher.runAutopilotCycle();
            const inventory = await store.listInventory();
            expect(inventory).toHaveLength(124);
            // Planned sessions get their verdict; the rest keep a refreshed
            // snapshot and stay verdict-free for the next cycle, with no
            // assessment failure and no growing backoff invented for them.
            expect(planned.length).toBeGreaterThan(0);
            expect(planned.length).toBeLessThan(124);
            expect(new Set(planned).size).toBe(planned.length);
            // One provider round per chunk at the configured concurrency: a cycle
            // must stay short enough to finish inside its own deadline, because
            // nothing is applied until the whole phase returns.
            expect(planCalls).toBeLessThanOrEqual(12);
            expect(inventory.filter((record) => record.verdict?.verdict === "completed").length).toBe(planned.length);
            expect(inventory.filter((record) => record.assessmentFailure)).toEqual([]);
            expect(inventory.every((record) => record.transcriptTail !== undefined)).toBe(true);
            expect(calls).toEqual({ resumes: 0, messages: [] });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("keeps forgotten-session completion unverified instead of claiming the task done", async () => {
        const root = await mkdtemp(join(tmpdir(), "forgotten-completion-"));
        const current = fixture();
        const calls = { resumes: 0, messages: [] as string[] };
        const store = new UnfinishedSessionStore(join(root, "state.json"));
        const launcher = new UnfinishedSessionLauncher({
            adapters: new Map([["codex", fakeAdapter(() => current, calls)]]), store,
            settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}),
            discoveryIdleMs: 1,
        });
        await launcher.forget("codex", current.id);
        await launcher.auditInventory();
        expect((await store.listInventory())[0]?.verdict?.verdict).toBe("needs_human");
        expect(calls).toEqual({ resumes: 0, messages: [] });
    });

    // Fast unit: an archived native store refuses to resume the thread, but the
    // refusal is reversible. Expected <2s, maximum 10s; no native app, database
    // or LLM is launched by these fixtures.
    it("restores an archived native session and continues the interrupted turn", async () => {
        const root = await mkdtemp(join(tmpdir(), "archived-repair-"));
        try {
            const current = fixture("error", "codex", "archived-session");
            const calls = { resumes: 0, unarchives: 0, messages: [] as string[] };
            let archived = true;
            const adapter = fakeAdapter(() => current, calls);
            adapter.resumeSession = async (id: string) => {
                calls.resumes += 1;
                if (archived) return { ok: false, error: `session ${id} is archived. Run \`codex unarchive ${id}\` to unarchive it first.` };
                return { ok: true };
            };
            adapter.unarchiveSession = async (id: string) => {
                calls.unarchives += 1;
                archived = false;
                return { ok: true, sessionId: id };
            };
            const notices: UnfinishedSessionNotice[] = [];
            const store = new UnfinishedSessionStore(join(root, "state.json"));
            await store.markRecoveryEligible(current, "turn.failed", { turnId: "t1" });
            const launcher = new UnfinishedSessionLauncher({
                adapters: new Map([["codex", adapter]]), store,
                settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}),
                discoveryIdleMs: 1,
                notify: async (notice: UnfinishedSessionNotice) => { notices.push(notice); },
            });
            await launcher.recoverPending();
            expect(calls.unarchives).toBe(1);
            expect(calls.messages).toHaveLength(1);
            expect(notices.map((notice) => notice.signalType)).not.toContain("unfinished-session-autostart-failed");
            expect((await store.list())[0]).toMatchObject({ state: "active", attempts: 0 });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("keeps an unrepairable archived session armed and reports one actionable notice", async () => {
        const root = await mkdtemp(join(tmpdir(), "archived-blocked-"));
        try {
            const current = fixture("error", "codex", "archived-blocked");
            const calls = { resumes: 0, messages: [] as string[] };
            const adapter = fakeAdapter(() => current, calls);
            adapter.resumeSession = async (id: string) => ({
                ok: false,
                error: `session ${id} is archived. Run \`codex unarchive ${id}\` to unarchive it first.`,
            });
            const notices: UnfinishedSessionNotice[] = [];
            const store = new UnfinishedSessionStore(join(root, "state.json"));
            await store.markRecoveryEligible(current, "turn.failed", { turnId: "t1" });
            const launcher = new UnfinishedSessionLauncher({
                adapters: new Map([["codex", adapter]]), store,
                settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}),
                discoveryIdleMs: 1,
                notify: async (notice: UnfinishedSessionNotice) => { notices.push(notice); },
            });
            await launcher.recoverPending();
            const record = (await store.list())[0];
            // A refusal that repeats identically is not a retry: the record stays
            // armed and the retry budget is untouched.
            expect(record).toMatchObject({ state: "active", attempts: 0 });
            expect(record.lastError).toContain("is archived");
            expect(notices).toHaveLength(1);
            expect(notices[0].severity).toBe("notice");
            expect(notices[0].signalType).toBe("unfinished-session-archived");
            expect(notices[0].body).toContain(`codex unarchive ${current.id}`);
            expect(calls.messages).toHaveLength(0);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("re-arms an exhausted archived record and continues the interrupted turn", async () => {
        const root = await mkdtemp(join(tmpdir(), "archived-exhausted-"));
        try {
            const current = fixture("error", "codex", "archived-exhausted");
            const calls = { resumes: 0, messages: [] as string[] };
            const adapter = fakeAdapter(() => current, calls);
            const store = new UnfinishedSessionStore(join(root, "state.json"));
            await store.markRecoveryEligible(current, "turn.failed", { turnId: "t1" });
            const archivedRefusal = `session ${current.id} is archived. Run \`codex unarchive ${current.id}\` to unarchive it first.`;
            for (let attempt = 0; attempt < 3; attempt += 1) {
                const reserved = await store.beginAttempt("codex", current.id, 3, 0, new Date(), current.cwd);
                if (!reserved) break;
                await store.markFailure("codex", current.id, archivedRefusal, 3, new Date(), current.cwd);
            }
            expect((await store.list())[0]).toMatchObject({ state: "exhausted", attempts: 3 });
            const notices: UnfinishedSessionNotice[] = [];
            const launcher = new UnfinishedSessionLauncher({
                adapters: new Map([["codex", adapter]]), store,
                settingsStore: new SessionAutostartStore(join(root, "settings.json"), {}),
                discoveryIdleMs: 1,
                notify: async (notice: UnfinishedSessionNotice) => { notices.push(notice); },
            });
            await launcher.recoverPending();
            // The restored thread is resumable again, so the exhausted record
            // returns to the armed state and the turn continues.
            expect(calls.messages).toHaveLength(1);
            expect((await store.list())[0]).toMatchObject({ state: "active", attempts: 0 });
            expect(notices.map((notice) => notice.signalType)).not.toContain("unfinished-session-autostart-failed");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe("terminal quota recovery", () => {
  function quotaSession(status: AgentSession["status"] = "error", model = "omniroute/openai/current"): AgentSession {
    const completedAt = Date.now() - 120_000;
    const evidence = { classification: "quota_exhausted", nativeTurnId: "native-failed-1", inputId: "native-input-1", providerId: "omniroute", modelId: "openai/current", resetAt: new Date(Date.now() - 1_000).toISOString() };
    return {
      ...fixture(status, "zcode", "quota-session"), harness: "opencode", model,
      meta: { nativeLastTurn: { turnId: evidence.nativeTurnId, inputId: evidence.inputId, status: "error", completedAt, userMessageId: "user-input-1", quotaFailure: evidence } },
    };
  }

  async function optedInSettings(root: string): Promise<SessionAutostartStore> {
    const settings = new SessionAutostartStore(join(root, "settings.json"), {});
    await settings.setGlobal(true);
    await settings.setSessionWaitForQuota({ harness: "opencode", sessionId: "quota-session", cwd: "/tmp/recovery" }, true);
    return settings;
  }

  function quotaAdapter(current: () => AgentSession, sent: Array<{ model?: string; inputId?: string }>, models: string[] = ["omniroute/openai/current", "omniroute/anthropic/fallback"]): HarnessAdapter {
    const adapter = fakeAdapter(current, { resumes: 0, messages: [] });
    return {
      ...adapter,
      type: "opencode",
      async listModels() { return models; },
      async changeModel(_id, model) { (current() as { model?: string }).model = model; return { ok: true }; },
      async sendMessage(_id, options) { sent.push({ model: options.model, inputId: options.inputId }); return { ok: true, admitted: true, inputId: options.inputId }; },
    };
  }

  it("queues an exact opted-in terminal event and sends one durable fallback continuation", async () => {
    const root = await mkdtemp(join(tmpdir(), "quota-recovery-event-"));
    try {
      let current = quotaSession("running");
      const sent: Array<{ model?: string; inputId?: string }> = [];
      const adapter = quotaAdapter(() => current, sent);
      const storePath = join(root, "unfinished.json");
      const store = new UnfinishedSessionStore(storePath);
      const settings = await optedInSettings(root);
      const launcher = new UnfinishedSessionLauncher({
        adapters: new Map([["opencode", adapter]]), store, settingsStore: settings,
        fallbackModelsForHarness: async () => ["omniroute/openai/current", "omniroute/anthropic/fallback", "OmniRoute/anthropic/fallback"],
      });
      await launcher.handleEvent("opencode", { kind: "turn.started", harness: "opencode", sessionId: current.id, data: { turnId: "native-failed-1", inputId: "native-input-1" } });
      current = quotaSession("error");
      const quotaFailure = (current.meta!.nativeLastTurn as Record<string, unknown>).quotaFailure;
      await launcher.handleEvent("opencode", { kind: "turn.failed", harness: "opencode", sessionId: current.id, data: { turnId: "native-failed-1", inputId: "native-input-1", quotaFailure } });
      expect((await store.list())[0]?.quotaRecovery?.state).toBe("waiting");
      await launcher.recoverPending();
      await launcher.recoverPending();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ model: "omniroute/anthropic/fallback" });
      expect(sent[0]?.inputId).toMatch(/^herder-quota:/u);
      expect((await new UnfinishedSessionStore(storePath).list())[0]?.quotaRecovery?.state).toBe("accepted");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("reconciles an opted-in terminal quota snapshot after restart without an event", async () => {
    const root = await mkdtemp(join(tmpdir(), "quota-recovery-startup-"));
    try {
      const current = quotaSession("error");
      const sent: Array<{ model?: string; inputId?: string }> = [];
      const launcher = new UnfinishedSessionLauncher({
        adapters: new Map([["opencode", quotaAdapter(() => current, sent)]]),
        store: new UnfinishedSessionStore(join(root, "unfinished.json")), settingsStore: await optedInSettings(root),
        fallbackModelsForHarness: async () => ["omniroute/anthropic/fallback"],
      });
      await launcher.recoverPending();
      expect(sent).toHaveLength(1);
      expect(sent[0]?.model).toBe("omniroute/anthropic/fallback");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("enrolls an explicitly authorized failed session from exact native terminal identity and dispatches only the configured fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "operator-cohort-quota-recovery-"));
    try {
      const failedAt = new Date(Date.now() - 30_000).toISOString();
      let current: AgentSession = {
        ...fixture("error", "opencode", "operator-session"), model: "zai-coding-plan/glm-5.3-flash",
        meta: { nativeLastTurn: {
          sessionId: "operator-session", turnId: "native-turn-42", assistantMessageId: "assistant-42",
          providerId: "zai-coding-plan", modelId: "glm-5.3-flash", status: "failed", completedAt: failedAt,
        } },
      };
      const sent: Array<{ model?: string; inputId?: string }> = [];
      const adapter = quotaAdapter(() => current, sent, ["omniroute/minimax-combo-m3.1"]);
      const settings = new SessionAutostartStore(join(root, "settings.json"), {});
      await settings.setGlobalOptions({ enabled: false });
      const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
      const projectLaunchPolicyStore = new AutomationLaunchPolicyStore(join(root, "launch-policy.json"));
      await projectLaunchPolicyStore.replace({ version: 1, allowedHarnesses: ["opencode"], preferredHarness: "opencode",
        models: { opencode: "omniroute/minimax-combo-m3.1" },
        fallbackModels: { opencode: ["omniroute/minimax-combo-m3.1"] },
        projectRoutes: { [current.cwd]: { harnesses: ["opencode"] } },
      });
      const launcher = new UnfinishedSessionLauncher({
        adapters: new Map([["opencode", adapter]]), store, settingsStore: settings,
        fallbackModelsForHarness: async () => ["omniroute/minimax-combo-m3.1"],
        projectLaunchPolicyStore,
      });
      const evidence = {
        nativeTurnId: "native-turn-42", assistantMessageId: "assistant-42", providerId: "zai-coding-plan",
        modelId: "glm-5.3-flash", completedAt: failedAt,
      };
      const enrolled = await launcher.enrollOperatorCohortEntry("operator-batch-2026-10-21-01", {
        sessionId: current.id, cwd: current.cwd, expected: evidence,
      });
      expect(enrolled).toMatchObject({ outcome: "enrolled", wait: { origin: "operator_cohort", state: "waiting", currentModel: "glm-5.3-flash" } });
      await expect(launcher.enrollOperatorCohortEntry("operator-batch-2026-10-21-01", {
        sessionId: current.id, cwd: current.cwd, expected: evidence,
      })).resolves.toMatchObject({ outcome: "already_enrolled", wait: { origin: "operator_cohort", state: "waiting" } });
      expect(await settings.getEffective("opencode", current.id, current.cwd)).toMatchObject({ enabled: false, waitForQuota: true, waitForQuotaSource: "session" });
      await launcher.recoverPending();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ model: "omniroute/minimax-combo-m3.1" });
      expect((await store.list())[0]?.quotaRecovery).toMatchObject({ state: "accepted", evidence: { classification: "operator_cohort", authorizationId: "operator-batch-2026-10-21-01" } });
      expect((await store.list())[0]?.recoveryCause).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    { cwd: "/home/roomhacker/PycharmProjects/TelegramAuto", model: "omniroute/minimax-combo-m3.1", leaves: [
      { providerId: "minimax-code", modelId: "mmcode/MiniMax-M3.1-Flash" },
      { providerId: "minimax", modelId: "minimax/MiniMax-M3.1-Flash" },
    ] },
    { cwd: "/home/roomhacker/PycharmProjects/TelegramAuto/ATV", model: "omniroute/minimax-combo-m3.1", leaves: [
      { providerId: "minimax-code", modelId: "mmcode/MiniMax-M3.1-Flash" },
      { providerId: "minimax", modelId: "minimax/MiniMax-M3.1-Flash" },
    ] },
    { cwd: "/home/roomhacker/PycharmProjects/video_watching", model: "omniroute/minimax-combo-m3.1", leaves: [
      { providerId: "minimax-code", modelId: "mmcode/MiniMax-M3.1-Flash" },
      { providerId: "minimax", modelId: "minimax/MiniMax-M3.1-Flash" },
    ] },
    { cwd: "/home/roomhacker/PycharmProjects/video_watching/worker", model: "omniroute/minimax-combo-m3.1", leaves: [
      { providerId: "minimax-code", modelId: "mmcode/MiniMax-M3.1-Flash" },
      { providerId: "minimax", modelId: "minimax/MiniMax-M3.1-Flash" },
    ] },
    { cwd: "/home/roomhacker/PycharmProjects/TelegramAuto", model: "omniroute/zai-coding-plan/glm-5.3-flash", leaves: [
      { providerId: "zai-coding-plan", modelId: "glm-5.3-flash" },
    ] },
  ])("admits a restricted cohort session only when the exact fallback resolves to allowed provider leaves (%s)", async ({ cwd, model, leaves }) => {
    const root = await mkdtemp(join(tmpdir(), "operator-cohort-resolved-safe-leaves-"));
    try {
      const failedAt = new Date(Date.now() - 30_000).toISOString();
      const current: AgentSession = {
        ...fixture("error", "opencode", "restricted-session"), cwd, model: "minimax-coding-plan/MiniMax-M3.1-Flash",
        meta: { nativeLastTurn: {
          sessionId: "restricted-session", turnId: "restricted-native-turn", assistantMessageId: "restricted-assistant",
          providerId: "minimax-coding-plan", modelId: "MiniMax-M3.1-Flash", status: "failed", completedAt: failedAt,
        } },
      };
      const sent: Array<{ model?: string; inputId?: string }> = [];
      const baseAdapter = quotaAdapter(() => current, sent, [model]);
      const adapter = {
        ...baseAdapter,
        async resolveModelProviderLeaves(nativeModelId: string) {
          return {
            nativeHarness: "opencode",
            nativeModelId,
            resolvedProviderLeaves: leaves,
          };
        },
      };
      const settings = new SessionAutostartStore(join(root, "settings.json"), {});
      await settings.setGlobalOptions({ enabled: false });
      const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
      const projectLaunchPolicyStore = new AutomationLaunchPolicyStore(join(root, "launch-policy.json"));
      await projectLaunchPolicyStore.replace({ version: 1, allowedHarnesses: ["opencode"], preferredHarness: "opencode",
        models: { opencode: model },
        fallbackModels: { opencode: [model] },
      });
      const launcher = new UnfinishedSessionLauncher({
        adapters: new Map([["opencode", adapter]]), store, settingsStore: settings,
        fallbackModelsForHarness: async () => [model], projectLaunchPolicyStore,
      });
      const enrolled = await launcher.enrollOperatorCohortEntry("operator-restricted-2026-10-21-01", {
        sessionId: current.id, cwd, expected: {
          nativeTurnId: "restricted-native-turn", assistantMessageId: "restricted-assistant",
          providerId: "minimax-coding-plan", modelId: "MiniMax-M3.1-Flash", completedAt: failedAt,
        },
      });
      expect(enrolled).toMatchObject({ outcome: "enrolled", wait: { state: "waiting", origin: "operator_cohort" } });
      await launcher.recoverPending();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ model });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    { providerId: "openai", modelId: "gpt-5-codex" },
    { providerId: "anthropic", modelId: "claude-sonnet" },
  ])("fails closed for a restricted cohort when a resolved fallback contains forbidden provider leaf %s", async (forbiddenLeaf) => {
    const root = await mkdtemp(join(tmpdir(), "operator-cohort-resolved-forbidden-leaf-"));
    try {
      const failedAt = new Date(Date.now() - 30_000).toISOString();
      const current: AgentSession = {
        ...fixture("error", "opencode", "restricted-forbidden-session"),
        cwd: "/home/roomhacker/PycharmProjects/TelegramAuto", model: "minimax-coding-plan/MiniMax-M3.1-Flash",
        meta: { nativeLastTurn: {
          sessionId: "restricted-forbidden-session", turnId: "restricted-native-turn", assistantMessageId: "restricted-assistant",
          providerId: "minimax-coding-plan", modelId: "MiniMax-M3.1-Flash", status: "failed", completedAt: failedAt,
        } },
      };
      const baseAdapter = quotaAdapter(() => current, [], ["omniroute/minimax-combo-m3.1"]);
      const adapter = {
        ...baseAdapter,
        async resolveModelProviderLeaves(nativeModelId: string) {
          return {
            nativeHarness: "opencode",
            nativeModelId,
            resolvedProviderLeaves: [
              { providerId: "minimax-code", modelId: "mmcode/MiniMax-M3.1-Flash" },
              forbiddenLeaf,
            ],
          };
        },
      };
      const settings = new SessionAutostartStore(join(root, "settings.json"), {});
      const projectLaunchPolicyStore = new AutomationLaunchPolicyStore(join(root, "launch-policy.json"));
      await projectLaunchPolicyStore.replace({ version: 1, allowedHarnesses: ["opencode"], preferredHarness: "opencode",
        models: { opencode: "omniroute/minimax-combo-m3.1" },
        fallbackModels: { opencode: ["omniroute/minimax-combo-m3.1"] },
      });
      const launcher = new UnfinishedSessionLauncher({
        adapters: new Map([["opencode", adapter]]), store: new UnfinishedSessionStore(join(root, "unfinished.json")), settingsStore: settings,
        fallbackModelsForHarness: async () => ["omniroute/minimax-combo-m3.1"], projectLaunchPolicyStore,
      });
      const result = await launcher.enrollOperatorCohortEntry("operator-restricted-2026-10-21-02", {
        sessionId: current.id, cwd: current.cwd, expected: {
          nativeTurnId: "restricted-native-turn", assistantMessageId: "restricted-assistant",
          providerId: "minimax-coding-plan", modelId: "MiniMax-M3.1-Flash", completedAt: failedAt,
        },
      });
      expect(result).toMatchObject({ outcome: "ineligible", reason: "project_policy_disallows_fallback_model" });
      expect((await settings.getEffective("opencode", current.id, current.cwd)).waitForQuota).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects stale or mismatched operator identity without opting the session in", async () => {
    const root = await mkdtemp(join(tmpdir(), "operator-cohort-stale-identity-"));
    try {
      const current: AgentSession = {
        ...fixture("idle", "opencode", "operator-session-stale"), model: "zai-coding-plan/glm-5.3-flash",
        meta: { nativeLastTurn: {
          sessionId: "operator-session-stale", turnId: "native-turn-new", assistantMessageId: "assistant-new",
          providerId: "zai-coding-plan", modelId: "glm-5.3-flash", status: "failed", completedAt: new Date().toISOString(),
        } },
      };
      const settings = new SessionAutostartStore(join(root, "settings.json"), {});
      const launcher = new UnfinishedSessionLauncher({
        adapters: new Map([["opencode", fakeAdapter(() => current, { resumes: 0, messages: [] })]]),
        store: new UnfinishedSessionStore(join(root, "unfinished.json")), settingsStore: settings,
        fallbackModelsForHarness: async () => ["omniroute/minimax-combo-m3.1"],
      });
      const result = await launcher.enrollOperatorCohortEntry("operator-batch-2026-10-21-02", {
        sessionId: current.id, cwd: current.cwd,
        expected: { nativeTurnId: "native-turn-old", assistantMessageId: "assistant-old", providerId: "zai-coding-plan", modelId: "glm-5.3-flash", completedAt: new Date().toISOString() },
      });
      expect(result).toMatchObject({ outcome: "ineligible", reason: "native_terminal_identity_mismatch" });
      expect((await settings.getEffective("opencode", current.id, current.cwd)).waitForQuota).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("cancels a waiting quota record when a new native turn starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "quota-recovery-new-turn-"));
    try {
      let current = quotaSession("running");
      const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
      const evidence = (current.meta!.nativeLastTurn as Record<string, unknown>).quotaFailure as import("../src/autopilot/unfinished-session-launcher.js").QuotaFailureEvidence;
      await store.markQuotaRecoveryEligible(current, evidence, ["omniroute/anthropic/fallback"]);
      current = { ...current, status: "running" };
      const launcher = new UnfinishedSessionLauncher({
        adapters: new Map([["opencode", quotaAdapter(() => current, [])]]), store,
        settingsStore: await optedInSettings(root), fallbackModelsForHarness: async () => [],
      });
      await launcher.handleEvent("opencode", { kind: "turn.started", harness: "opencode", sessionId: current.id, data: { turnId: "native-new-turn", inputId: "native-new-input" } });
      expect((await store.list())[0]?.quotaRecovery).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps an expired dispatch claim settleable while a competing process checks receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "quota-recovery-claim-"));
    try {
      const current = quotaSession("error");
      const path = join(root, "unfinished.json");
      const firstStore = new UnfinishedSessionStore(path);
      const evidence = (current.meta!.nativeLastTurn as Record<string, unknown>).quotaFailure as import("../src/autopilot/unfinished-session-launcher.js").QuotaFailureEvidence;
      await firstStore.markQuotaRecoveryEligible(current, { ...evidence, resetAt: new Date(Date.now() - 120_000).toISOString() }, ["omniroute/anthropic/fallback"], "quota-test", new Date(Date.now() - 60_000));
      const snapshot = (await firstStore.list())[0]!;
      const [first, second] = await Promise.all([
        firstStore.claimQuotaRecoveryAttempt(snapshot, "omniroute/anthropic/fallback", new Date(Date.now() - 60_000)),
        new UnfinishedSessionStore(path).claimQuotaRecoveryAttempt(snapshot, "omniroute/anthropic/fallback", new Date(Date.now() - 60_000)),
      ]);
      expect([first, second].filter(Boolean)).toHaveLength(1);
      const claimed = first ?? second!;
      const sent: Array<{ model?: string; inputId?: string }> = [];
      const launcher = new UnfinishedSessionLauncher({
        adapters: new Map([["opencode", quotaAdapter(() => current, sent)]]),
        store: new UnfinishedSessionStore(path), settingsStore: await optedInSettings(root),
        fallbackModelsForHarness: async () => ["omniroute/anthropic/fallback"],
      });
      await launcher.recoverPending();
      expect(sent).toEqual([]);
      expect((await firstStore.list()).find((record) => record.sessionId === current.id)?.quotaRecovery).toMatchObject({ state: "dispatching", reasonCode: "delivery_unknown" });
      expect(claimed.quotaRecovery?.dispatchInputId).toMatch(/^herder-quota:/u);
      await firstStore.settleQuotaRecoveryAttempt(claimed, "accepted", { turnId: "native-accepted-after-probe" });
      expect((await firstStore.list()).find((record) => record.sessionId === current.id)?.quotaRecovery?.state).toBe("accepted");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
