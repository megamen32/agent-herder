import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AutopilotPolicyStore } from "../src/autopilot/policy-store.js";
import { AutopilotSessionStore } from "../src/autopilot/session-store.js";
import { SessionAutostartStore, UnfinishedSessionLauncher, UnfinishedSessionStore, type UnfinishedSessionNotice } from "../src/autopilot/unfinished-session-launcher.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

function fixture(harness: "codex" | "zcode" = "codex", id = "session-1"): AgentSession {
    return { id, harness, status: "idle", title: "Planner route fixture", cwd: "/tmp/planner-route",
        lastActivity: new Date(Date.now() - 600000).toISOString(), needsPermission: false, messageCount: 2 };
}

function fakeAdapter(current: () => AgentSession): HarnessAdapter {
    return { type: current().harness, name: "fixture", async init() { }, async listSessions() { return [{ ...current() }]; },
        async getSession(id) { return id === current().id ? { ...current() } : null; },
        async getSessionMessages() { return [{ id: "u", role: "user", text: "work", parts: [{ type: "text", text: "work" }] }]; },
        async resumeSession() { return { ok: true }; }, async sendMessage() { return { ok: true }; },
        async stopSession() { return { ok: true }; }, async respondPermission() { return { ok: true }; },
        async setPermissions() { return { ok: true }; } };
}

/** Exactly the shape JudgeRequestError puts into the launcher error text. */
function judgeTransportFailure(model: string, endpoint: string): Error {
    const diagnostic = { model, operation: "batch-plan", endpoint: `${endpoint}/chat/completions`,
        stage: "headers", kind: "network", elapsedMs: 548, transportCode: "ETIMEDOUT" };
    return new Error(`LLM ${model}: сбой соединения; ${JSON.stringify(diagnostic)}`);
}

describe("planner failure notice names the configured route", () => {
    // Fast unit: the operator alarm must not blame a hardcoded vendor when the
    // deployment plans through a different route.
    // Expected <2s, maximum 10s; isolated temp store, no network, no native calls.
    it("reports the failing planner model and host instead of a hardcoded vendor", async () => {
        const root = await mkdtemp(join(tmpdir(), "planner-route-notice-"));
        try {
            const current = fixture();
            const notices: UnfinishedSessionNotice[] = [];
            const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
            await policyStore.replacePolicy({ schemaVersion: 1, enabled: true, harnesses: ["codex"], scope: { mode: "all_ingress" }, maxContinuationsPerSession: 10, timeout: { mode: "auto_continue", delayMs: 1000 }, card: { includeUserMessage: true, includeAssistantMessage: true, includeReason: true } }, null);
            const settings = new SessionAutostartStore(join(root, "settings.json"), {});
            await settings.setGlobal(false);
            const launcher = new UnfinishedSessionLauncher({
                adapters: new Map([["codex", fakeAdapter(() => current)]]),
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
            // First repeated failure is what raises the operator notice.
            await launcher.runAutopilotCycle();
            await launcher.runAutopilotCycle();
            expect(notices.length).toBe(1);
            const [notice] = notices;
            expect(notice.signalType).toBe("autocontinue-assessment-failed");
            expect(notice.body).toContain("glm-5.3-flash");
            expect(notice.body).toContain("api.z.ai");
            expect(notice.body).not.toContain("MiniMax");
            expect(notice.title).not.toContain("MiniMax");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    // Fast unit: a MiniMax deployment must keep naming MiniMax.
    // Expected <2s, maximum 10s; isolated temp store, no network, no native calls.
    it("keeps naming MiniMax when that is the configured route", async () => {
        const root = await mkdtemp(join(tmpdir(), "planner-route-notice-minimax-"));
        try {
            const current = fixture();
            const notices: UnfinishedSessionNotice[] = [];
            const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
            await policyStore.replacePolicy({ schemaVersion: 1, enabled: true, harnesses: ["codex"], scope: { mode: "all_ingress" }, maxContinuationsPerSession: 10, timeout: { mode: "auto_continue", delayMs: 1000 }, card: { includeUserMessage: true, includeAssistantMessage: true, includeReason: true } }, null);
            const settings = new SessionAutostartStore(join(root, "settings.json"), {});
            await settings.setGlobal(false);
            const launcher = new UnfinishedSessionLauncher({
                adapters: new Map([["codex", fakeAdapter(() => current)]]),
                store: new UnfinishedSessionStore(join(root, "state.json")),
                settingsStore: settings,
                autopilotPolicyStore: policyStore,
                autopilotSessionStore: new AutopilotSessionStore(join(root, "sessions.json")),
                discoveryIdleMs: 1, plannerTransportRetryDelayMs: 20,
                notify: async (notice) => { notices.push(notice); },
                judge: {
                    async decide() { return { verdict: "unfinished", reason: "work remains", confidence: 1 }; },
                    async plan() { throw judgeTransportFailure("MiniMax-M3.1-Flash-Preview", "https://api.minimax.io/anthropic"); },
                },
            });
            await launcher.runAutopilotCycle();
            await launcher.runAutopilotCycle();
            expect(notices.length).toBe(1);
            expect(notices[0]!.body).toContain("MiniMax-M3.1-Flash-Preview");
            expect(notices[0]!.body).toContain("api.minimax.io");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    // Fast unit: a provider overload must name the same route in its own message.
    // Expected <2s, maximum 10s; isolated temp store, no network, no native calls.
    it("names the configured route in the overload notice too", async () => {
        const root = await mkdtemp(join(tmpdir(), "planner-route-notice-overload-"));
        try {
            const current = fixture();
            const notices: UnfinishedSessionNotice[] = [];
            const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
            await policyStore.replacePolicy({ schemaVersion: 1, enabled: true, harnesses: ["codex"], scope: { mode: "all_ingress" }, maxContinuationsPerSession: 10, timeout: { mode: "auto_continue", delayMs: 1000 }, card: { includeUserMessage: true, includeAssistantMessage: true, includeReason: true } }, null);
            const settings = new SessionAutostartStore(join(root, "settings.json"), {});
            await settings.setGlobal(false);
            const launcher = new UnfinishedSessionLauncher({
                adapters: new Map([["codex", fakeAdapter(() => current)]]),
                store: new UnfinishedSessionStore(join(root, "state.json")),
                settingsStore: settings,
                autopilotPolicyStore: policyStore,
                autopilotSessionStore: new AutopilotSessionStore(join(root, "sessions.json")),
                discoveryIdleMs: 1, plannerTransportRetryDelayMs: 20,
                notify: async (notice) => { notices.push(notice); },
                judge: {
                    async decide() { return { verdict: "unfinished", reason: "work remains", confidence: 1 }; },
                    async plan() { throw new Error("LLM glm-5.3-flash HTTP 429: ограничена частота запросов; {\"model\":\"glm-5.3-flash\",\"endpoint\":\"https://api.z.ai/api/coding/paas/v4/chat/completions\",\"stage\":\"body\",\"kind\":\"rate_limited\",\"httpStatus\":429}"); },
                },
            });
            await launcher.runAutopilotCycle();
            await launcher.runAutopilotCycle();
            expect(notices.length).toBe(1);
            expect(notices[0]!.signalType).toBe("minimax-planner-overloaded");
            expect(notices[0]!.title).toContain("glm-5.3-flash");
            expect(notices[0]!.body).toContain("api.z.ai");
            expect(notices[0]!.body).not.toContain("MiniMax");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
describe("planner transport retry survives a dead connection window", () => {
    // Fast unit: a first transport error must not consume the only safe
    // retry inside the same dead window; the chunk must still produce a plan.
    // Expected <2s, maximum 10s; isolated temp store, no network, no native calls.
    it("spaces the single transport retry and returns the plan", async () => {
        const root = await mkdtemp(join(tmpdir(), "planner-transport-retry-"));
        try {
            const current = fixture();
            const notices: UnfinishedSessionNotice[] = [];
            const attempts: number[] = [];
            const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
            await policyStore.replacePolicy({ schemaVersion: 1, enabled: true, harnesses: ["codex"], scope: { mode: "all_ingress" }, maxContinuationsPerSession: 10, timeout: { mode: "auto_continue", delayMs: 1000 }, card: { includeUserMessage: true, includeAssistantMessage: true, includeReason: true } }, null);
            const settings = new SessionAutostartStore(join(root, "settings.json"), {});
            await settings.setGlobal(false);
            const launcher = new UnfinishedSessionLauncher({
                adapters: new Map([["codex", fakeAdapter(() => current)]]),
                store: new UnfinishedSessionStore(join(root, "state.json")),
                settingsStore: settings,
                autopilotPolicyStore: policyStore,
                autopilotSessionStore: new AutopilotSessionStore(join(root, "sessions.json")),
                discoveryIdleMs: 1, plannerTransportRetryDelayMs: 20,
                notify: async (notice) => { notices.push(notice); },
                judge: {
                    async decide() { return { verdict: "unfinished", reason: "work remains", confidence: 1 }; },
                    async plan({ sessions }) {
                        attempts.push(Date.now());
                        if (attempts.length === 1) throw judgeTransportFailure("glm-5.3-flash", "https://api.z.ai/api/coding/paas/v4");
                        return { groups: [{ sourceSessionIds: sessions.map(({ session }) => session.id), primarySessionId: current.id, verdict: "unfinished", reason: "work remains", confidence: 1, topic: "topic", handoff: "continue" }] };
                    },
                },
            });
            await launcher.runAutopilotCycle();
            expect(attempts.length).toBe(2);
            // The repeat must be spaced, otherwise it lands in the same dead window.
            expect(attempts[1]! - attempts[0]!).toBeGreaterThanOrEqual(15);
            expect(notices).toEqual([]);
            const inventory = await new UnfinishedSessionStore(join(root, "state.json")).listInventory();
            expect(inventory.filter((record) => record.assessmentFailure)).toEqual([]);
            expect(inventory.some((record) => record.verdict?.verdict)).toBe(true);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    // Fast unit: a non-transient planner failure must still abort without waiting.
    // Expected <2s, maximum 10s; isolated temp store, no network, no native calls.
    it("does not retry a non-transient planner failure", async () => {
        const root = await mkdtemp(join(tmpdir(), "planner-no-retry-"));
        try {
            const current = fixture();
            let attempts = 0;
            const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
            await policyStore.replacePolicy({ schemaVersion: 1, enabled: true, harnesses: ["codex"], scope: { mode: "all_ingress" }, maxContinuationsPerSession: 10, timeout: { mode: "auto_continue", delayMs: 1000 }, card: { includeUserMessage: true, includeAssistantMessage: true, includeReason: true } }, null);
            const settings = new SessionAutostartStore(join(root, "settings.json"), {});
            await settings.setGlobal(false);
            const launcher = new UnfinishedSessionLauncher({
                adapters: new Map([["codex", fakeAdapter(() => current)]]),
                store: new UnfinishedSessionStore(join(root, "state.json")),
                settingsStore: settings,
                autopilotPolicyStore: policyStore,
                autopilotSessionStore: new AutopilotSessionStore(join(root, "sessions.json")),
                discoveryIdleMs: 1, plannerTransportRetryDelayMs: 20,
                judge: {
                    async decide() { return { verdict: "unfinished", reason: "work remains", confidence: 1 }; },
                    async plan({ sessions }) { attempts += 1; throw new Error("LLM glm-5.3-flash HTTP 401: ошибка авторизации; {\"model\":\"glm-5.3-flash\",\"kind\":\"authentication\"}"); },
                },
            });
            const startedAt = Date.now();
            await launcher.runAutopilotCycle();
            expect(attempts).toBe(1);
            expect(Date.now() - startedAt).toBeLessThan(1000);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
