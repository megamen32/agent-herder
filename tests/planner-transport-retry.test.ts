import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AutopilotPolicyStore } from "../src/autopilot/policy-store.js";
import { AutopilotSessionStore } from "../src/autopilot/session-store.js";
import { SessionAutostartStore, UnfinishedSessionLauncher, UnfinishedSessionStore, type UnfinishedSessionNotice } from "../src/autopilot/unfinished-session-launcher.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

const POLICY = { schemaVersion: 1, enabled: true, harnesses: ["codex"], scope: { mode: "all_ingress" },
    maxContinuationsPerSession: 10, timeout: { mode: "auto_continue", delayMs: 1000 },
    card: { includeUserMessage: true, includeAssistantMessage: true, includeReason: true } } as const;

function fixture(id: string): AgentSession {
    return { id, harness: "codex", status: "idle", title: "Transient planner retry fixture",
        cwd: "/tmp/planner-transport-retry", lastActivity: new Date(Date.now() - 600000).toISOString(),
        needsPermission: false, messageCount: 2 };
}

/** Two idle sessions in one workspace so a single chunk covers both. */
function fakeAdapter(current: () => AgentSession[]): HarnessAdapter {
    return { type: "codex", name: "fixture", async init() { }, async listSessions() { return current().map((s) => ({ ...s })); },
        async getSession(id) { const found = current().find((s) => s.id === id); return found ? { ...found } : null; },
        async getSessionMessages() { return [{ id: "u", role: "user", text: "work", parts: [{ type: "text", text: "work" }] }]; },
        async resumeSession() { return { ok: true }; }, async sendMessage() { return { ok: true }; },
        async stopSession() { return { ok: true }; }, async respondPermission() { return { ok: true }; },
        async setPermissions() { return { ok: true }; } };
}

/** Exactly the diagnostic shape JudgeRequestError builds for a transport timeout. */
function judgeTransportFailure(model: string, endpoint: string): Error {
    const diagnostic = { model, operation: "batch-plan", endpoint: `${endpoint}/chat/completions`,
        stage: "headers", kind: "network", elapsedMs: 548, transportCode: "ETIMEDOUT" };
    return new Error(`LLM ${model}: сбой соединения; ${JSON.stringify(diagnostic)}`);
}

describe("transient planner transport failure retries instead of failing the cohort", () => {
    // Fast unit: one transient network timeout on the batch planner must not fail
    // every assessed session. Catches a planner phase that aborts on the first
    // transport error and leaves the whole cohort with assessmentFailure.
    // Expected <3s, maximum 15s; isolated temp store, no network, no native calls.
    it("recovers the cohort when the planner transport fails once then succeeds", async () => {
        const root = await mkdtemp(join(tmpdir(), "planner-transport-retry-"));
        try {
            const sessions = [fixture("session-a"), fixture("session-b")];
            const notices: UnfinishedSessionNotice[] = [];
            const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
            await policyStore.replacePolicy(POLICY, null);
            const settings = new SessionAutostartStore(join(root, "settings.json"), {});
            await settings.setGlobal(false);
            let planCalls = 0;
            const launcher = new UnfinishedSessionLauncher({
                adapters: new Map([["codex", fakeAdapter(() => sessions)]]),
                store: new UnfinishedSessionStore(join(root, "state.json")),
                settingsStore: settings,
                autopilotPolicyStore: policyStore,
                autopilotSessionStore: new AutopilotSessionStore(join(root, "sessions.json")),
                discoveryIdleMs: 1, plannerTransportRetryDelayMs: 20,
                notify: async (notice) => { notices.push(notice); },
                judge: {
                    async decide() { return { verdict: "unfinished", reason: "work remains", confidence: 1 }; },
                    async plan({ sessions: requested }) {
                        planCalls += 1;
                        // First transport attempt fails exactly like the observed
                        // ETIMEDOUT burst; the retry must reach the same cohort.
                        if (planCalls === 1) throw judgeTransportFailure("glm-5.3-flash", "https://api.z.ai/api/coding/paas/v4");
                        return { groups: [{ sourceSessionIds: requested.map((s) => s.session.id), primarySessionId: requested[0]!.session.id,
                            verdict: "unfinished", reason: "работа не завершена", confidence: 1, topic: "retry", handoff: "" }] };
                    },
                },
            });
            await launcher.runAutopilotCycle();
            expect(planCalls).toBeGreaterThanOrEqual(2);
            const inventory = await new UnfinishedSessionStore(join(root, "state.json")).listInventory();
            const failed = inventory.filter((record) => record.assessmentFailure);
            expect(failed.map((record) => `${record.harness}:${record.sessionId}`)).toEqual([]);
            // A single transient blip must never raise the operator alarm.
            expect(notices.filter((notice) => notice.signalType === "autocontinue-assessment-failed")).toEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    // Fast unit: a permanent planner fault must still fail the cohort. Guards the
    // retry against turning an unsafe plan into a silent success.
    // Expected <3s, maximum 15s; isolated temp store, no network, no native calls.
    it("still fails the cohort when the planner keeps failing", async () => {
        const root = await mkdtemp(join(tmpdir(), "planner-transport-hard-"));
        try {
            const sessions = [fixture("session-a"), fixture("session-b")];
            const notices: UnfinishedSessionNotice[] = [];
            const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
            await policyStore.replacePolicy(POLICY, null);
            const settings = new SessionAutostartStore(join(root, "settings.json"), {});
            await settings.setGlobal(false);
            const launcher = new UnfinishedSessionLauncher({
                adapters: new Map([["codex", fakeAdapter(() => sessions)]]),
                store: new UnfinishedSessionStore(join(root, "state.json")),
                settingsStore: settings,
                autopilotPolicyStore: policyStore,
                autopilotSessionStore: new AutopilotSessionStore(join(root, "sessions.json")),
                discoveryIdleMs: 1, plannerTransportRetryDelayMs: 20,
                notify: async (notice) => { notices.push(notice); },
                judge: {
                    async decide() { return { verdict: "unfinished", reason: "work remains", confidence: 1 }; },
                    async plan() { throw judgeTransportFailure("glm-5.3-flash", "https://api.z.ai/api/coding/paas/v4"); },
                },
            });
            await launcher.runAutopilotCycle();
            await launcher.runAutopilotCycle();
            const inventory = await new UnfinishedSessionStore(join(root, "state.json")).listInventory();
            expect(inventory.filter((record) => record.assessmentFailure).length).toBeGreaterThan(0);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});