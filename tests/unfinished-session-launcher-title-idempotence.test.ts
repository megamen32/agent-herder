import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionAutostartStore, UnfinishedSessionLauncher, UnfinishedSessionStore, type UnfinishedSessionNotice } from "../src/autopilot/unfinished-session-launcher.js";
import { AutopilotPolicyStore } from "../src/autopilot/policy-store.js";
import { AutopilotSessionStore } from "../src/autopilot/session-store.js";
import { HumanStopStore } from "../src/human-stop-store.js";
import type { AgentSession, CreateSessionOptions, HarnessAdapter } from "../src/types/index.js";

/** The deterministic continuation title of the planned topic "task". */
const CONTINUATION_TITLE = "Автопродолжение — Task";
const CWD = "/tmp/recovery";

function sourceSession(): AgentSession {
    return {
        id: "source-1",
        harness: "zcode",
        status: "idle",
        title: "Recovery fixture",
        cwd: CWD,
        lastActivity: new Date(Date.now() - 10 * 60_000).toISOString(),
        needsPermission: false,
        messageCount: 2,
        model: "minimax-m3",
    };
}

interface AdapterFixture {
    adapter: HarnessAdapter;
    created: CreateSessionOptions[];
    sent: Array<{ id: string; message: string }>;
    named: Array<{ name: string; cwd: string }>;
}

/** A zcode adapter that counts creations, sends and named searches. */
function fakeAdapter(options: { named?: AgentSession[]; searchFails?: boolean; withNamedSearch?: boolean } = {}): AdapterFixture {
    const created: CreateSessionOptions[] = [];
    const sent: Array<{ id: string; message: string }> = [];
    const named: Array<{ name: string; cwd: string }> = [];
    const current = sourceSession();
    const adapter: HarnessAdapter = {
        type: "zcode",
        name: "fixture",
        async init() {},
        async listSessions() { return [{ ...current }]; },
        async getSession(id) { return id === current.id ? { ...current } : null; },
        async getSessionMessages() { return [{ id: "u", role: "user", text: "work", parts: [{ type: "text", text: "work" }] }]; },
        async resumeSession() { return { ok: true }; },
        async sendMessage(id, input) { sent.push({ id, message: input.message }); return { ok: true }; },
        async stopSession() { return { ok: true }; },
        async respondPermission() { return { ok: true }; },
        async setPermissions() { return { ok: true }; },
        async createSession(createOptions) {
            created.push(createOptions);
            return {
                ...current,
                id: `created-${created.length}`,
                title: createOptions.name,
                cwd: createOptions.cwd,
                model: createOptions.model,
                status: "idle",
                lastActivity: new Date().toISOString(),
            };
        },
    };
    if (options.withNamedSearch !== false) {
        adapter.findNamedSessions = async (name, cwd) => {
            named.push({ name, cwd });
            if (options.searchFails) throw new Error("named search is unavailable");
            return (options.named ?? []).map((session) => ({ ...session }));
        };
    }
    return { adapter, created, sent, named };
}

/** One autopilot cycle over a single unfinished session that must roll over. */
async function runAutopilotCycle(fixture: AdapterFixture, notices: UnfinishedSessionNotice[]): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "herder-title-idempotence-"));
    try {
        const policyStore = new AutopilotPolicyStore(join(root, "policy.json"));
        await policyStore.replacePolicy({ schemaVersion: 1, enabled: true, harnesses: ["zcode"], scope: { mode: "all_ingress" }, maxContinuationsPerSession: 10, timeout: { mode: "auto_continue", delayMs: 1000 }, card: { includeUserMessage: true, includeAssistantMessage: true, includeReason: true } }, null);
        const settings = new SessionAutostartStore(join(root, "settings.json"), {});
        await settings.setRuntimeSettings({ inventoryWindowHours: 48, evidenceMessageCount: 200, judgeModel: "fixture", autopilotJudgeModel: "fixture", rolloverExpiredCache: true });
        const current = sourceSession();
        const launcher = new UnfinishedSessionLauncher({
            adapters: new Map([["zcode", fixture.adapter]]),
            store: new UnfinishedSessionStore(join(root, "unfinished.json")),
            settingsStore: settings,
            autopilotPolicyStore: policyStore,
            autopilotSessionStore: new AutopilotSessionStore(join(root, "sessions.json")),
            humanStopStore: new HumanStopStore(join(root, "stops.json")),
            discoveryIdleMs: 1,
            admissionGate: async () => ({ allowed: true }),
            notify: async (notice) => { notices.push(notice); },
            judge: {
                async decide() { return { verdict: "unfinished", reason: "work remains", confidence: 1 }; },
                async plan({ sessions }) {
                    return { groups: [{ sourceSessionIds: sessions.map(({ session }) => session.id), primarySessionId: current.id, verdict: "unfinished", reason: "work remains", confidence: 1, topic: "task", handoff: "continue" }] };
                },
            },
        });
        await launcher.runAutopilotCycle();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

describe("continuation title idempotence", () => {
    let stateDir = "";

    beforeEach(async () => {
        stateDir = await mkdtemp(join(tmpdir(), "herder-disarm-state-"));
        vi.stubEnv("AGENT_HERDER_AUTOPILOT_STATE_DIR", stateDir);
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(stateDir, { recursive: true, force: true });
    });

    it("reuses the existing session of the same name and cwd instead of creating a second executor", async () => {
        const existing: AgentSession = { ...sourceSession(), id: "existing-1", title: CONTINUATION_TITLE, status: "idle" };
        const fixture = fakeAdapter({ named: [existing] });
        const notices: UnfinishedSessionNotice[] = [];

        await runAutopilotCycle(fixture, notices);

        expect(fixture.named).toEqual([{ name: CONTINUATION_TITLE, cwd: CWD }]);
        expect(fixture.created).toEqual([]);
        expect(fixture.sent.map((entry) => entry.id)).toContain("existing-1");
        expect(notices).toEqual([]);
    });

    it("creates the session when no session of the same name and cwd exists", async () => {
        const fixture = fakeAdapter({ named: [] });
        const notices: UnfinishedSessionNotice[] = [];

        await runAutopilotCycle(fixture, notices);

        expect(fixture.named).toEqual([{ name: CONTINUATION_TITLE, cwd: CWD }]);
        expect(fixture.created.map((options) => options.name)).toEqual([CONTINUATION_TITLE]);
        expect(fixture.created.map((options) => options.cwd)).toEqual([CWD]);
    });

    it("refuses to start a second executor when two sessions carry the same name", async () => {
        const first: AgentSession = { ...sourceSession(), id: "existing-1", title: CONTINUATION_TITLE, status: "idle" };
        const second: AgentSession = { ...sourceSession(), id: "existing-2", title: CONTINUATION_TITLE, status: "idle" };
        const fixture = fakeAdapter({ named: [first, second] });
        const notices: UnfinishedSessionNotice[] = [];

        await runAutopilotCycle(fixture, notices);

        expect(fixture.created).toEqual([]);
        expect(fixture.sent).toEqual([]);
        expect(notices.map((notice) => notice.signalType)).toContain("continuation-refused");
    });

    it("keeps the previous behaviour for an adapter without the named search", async () => {
        const fixture = fakeAdapter({ withNamedSearch: false });
        const notices: UnfinishedSessionNotice[] = [];

        await runAutopilotCycle(fixture, notices);

        expect(fixture.named).toEqual([]);
        expect(fixture.created.map((options) => options.name)).toEqual([CONTINUATION_TITLE]);
    });

    it("creates the replacement when the named session is gone for good", async () => {
        const crashed: AgentSession = { ...sourceSession(), id: "existing-1", title: CONTINUATION_TITLE, status: "error" };
        const fixture = fakeAdapter({ named: [crashed] });
        const notices: UnfinishedSessionNotice[] = [];

        await runAutopilotCycle(fixture, notices);

        expect(fixture.created.map((options) => options.name)).toEqual([CONTINUATION_TITLE]);
        expect(fixture.sent.map((entry) => entry.id)).toContain("created-1");
    });

    it("refuses to create when the named search cannot prove the absence", async () => {
        const fixture = fakeAdapter({ searchFails: true });
        const notices: UnfinishedSessionNotice[] = [];

        await runAutopilotCycle(fixture, notices);

        expect(fixture.created).toEqual([]);
        expect(fixture.sent).toEqual([]);
    });
});
