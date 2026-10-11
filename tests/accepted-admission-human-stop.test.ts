import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AutopilotPolicyStore } from "../src/autopilot/policy-store.js";
import { AutopilotSessionStore } from "../src/autopilot/session-store.js";
import { SessionAutostartStore, UnfinishedSessionLauncher, UnfinishedSessionStore, type UnfinishedSessionNotice } from "../src/autopilot/unfinished-session-launcher.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

// Live tuple observed on 2026-10-11 for the session that produced
// inc_d445c846e740487da25aa8a3fd1cb199 (agent-herder:accepted-timeout:
// 7a23cdde02ad5f233fa77ce8 == sha256 of the source key below).
const SOURCE_KEY = "zcode:sess_70a3ebe9-e9a4-475e-b14e-68b4e9b57261:/home/roomhacker/PycharmProjects/video_watching";

function humanCancelledSession(overrides: Record<string, unknown> = {}): AgentSession {
  const acceptedAt = Date.now() - 45 * 60_000;
  const completedAt = Date.now() - 40 * 60_000;
  return {
    id: "sess_70a3ebe9-e9a4-475e-b14e-68b4e9b57261",
    harness: "zcode",
    status: "stopped",
    title: "selfheal_1791666905_1791666905",
    cwd: "/home/roomhacker/PycharmProjects/video_watching",
    lastActivity: new Date(completedAt).toISOString(),
    needsPermission: false,
    messageCount: 2,
    meta: {
      workspaceIdentity: "/home/roomhacker/PycharmProjects/video_watching",
      persistedTaskStatus: "completed",
      nativeLastTurn: {
        turnId: "turn_9613d227-eb2c-4058-b8e0-3b77581e1f07",
        status: "cancelled",
        userMessageId: "msg_mv4f4zc7_143918e9-3df1-4c27-9251-db2ecf288f48",
        startedAt: acceptedAt - 60_000,
        completedAt,
        rootSession: true,
        cancelledByUser: true,
        retryable: false,
        contextExceeded: false,
        errorType: "turn_cancelled",
        errorCode: "TURN_CANCELLED",
        pendingInput: true,
        userMessageMatchesLatest: false,
        assistantSucceeded: false,
        progressedAfterFailure: false,
        requiresHuman: false,
        ...overrides,
      },
    },
  };
}

function harness(session: AgentSession, calls: { messages: string[] }): HarnessAdapter {
  return {
    type: "zcode",
    name: "fixture",
    async init() {},
    async listSessions() { return [{ ...session }]; },
    async getSession(id) { return id === session.id ? { ...session } : null; },
    async getSessionMessages() {
      return [{ id: "u", role: "user", text: "continue the accepted task", parts: [{ type: "text", text: "continue the accepted task" }] }];
    },
    async resumeSession() { return { ok: true }; },
    async sendMessage(_id, input) { calls.messages.push(input.message); return { ok: true }; },
    async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; },
    async setPermissions() { return { ok: true }; },
  };
}

async function acceptedInProgressFixture(session: AgentSession, notices: UnfinishedSessionNotice[]) {
  const root = await mkdtemp(join(tmpdir(), "accepted-admission-human-"));
  const calls = { messages: [] as string[] };
  const store = new UnfinishedSessionStore(join(root, "state.json"));
  const acceptedAt = new Date(Date.now() - 45 * 60_000);
  await store.markStarted(session, "generation-1", acceptedAt, false, true);
  await store.markAdmissionInProgress(session.harness as "zcode", session.id, session.cwd, "fingerprint-1", acceptedAt);
  const policyStore = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
  await policyStore.replacePolicy({
    schemaVersion: 1,
    enabled: true,
    harnesses: ["zcode"],
    scope: { mode: "all_ingress" },
    maxContinuationsPerSession: 10,
    timeout: { mode: "auto_continue", delayMs: 1000 },
    card: { includeUserMessage: true, includeAssistantMessage: true, includeReason: true },
  }, null);
  const settingsStore = new SessionAutostartStore(join(root, "settings.json"), {});
  await settingsStore.setGlobal(false);
  const launcher = new UnfinishedSessionLauncher({
    adapters: new Map([["zcode", harness(session, calls)]]),
    store,
    settingsStore,
    autopilotPolicyStore: policyStore,
    autopilotSessionStore: new AutopilotSessionStore(join(root, "sessions.json")),
    discoveryIdleMs: 1,
    acceptedAdmissionTimeoutMs: 30 * 60_000,
    notify: async (notice) => { notices.push(notice); },
    judge: {
      async decide() { return { verdict: "unfinished", reason: "work remains", confidence: 1 }; },
      async plan({ sessions }) {
        return {
          groups: sessions.map(({ session: candidate }) => ({
            sourceSessionIds: [candidate.id],
            primarySessionId: candidate.id,
            verdict: "unfinished",
            reason: "work remains",
            confidence: 1,
            topic: "shared topic",
            handoff: "finish the task",
          })),
        };
      },
    },
  });
  await launcher.runAutopilotCycle();
  return { store, calls, launcher };
}

describe("accepted admission stopped by the human", () => {
  it("reconciles a human-cancelled accepted turn instead of alarming that completion never arrived", async () => {
    const notices: UnfinishedSessionNotice[] = [];
    const { store, calls } = await acceptedInProgressFixture(humanCancelledSession(), notices);

    expect(notices.filter((notice) => notice.signalType === "accepted-admission-timeout")).toEqual([]);
    const record = (await store.list()).find((candidate) => candidate.sessionId === "sess_70a3ebe9-e9a4-475e-b14e-68b4e9b57261");
    expect(record).toMatchObject({
      admissionPhase: "terminal_observed",
      nonRetryableAdmission: true,
      terminalReason: "turn.failed",
    });
    const inventory = (await store.listInventory())
      .find((candidate) => candidate.sessionId === "sess_70a3ebe9-e9a4-475e-b14e-68b4e9b57261");
    expect(inventory?.verdict?.verdict).toBe("needs_human");
    expect(inventory?.verdict?.reason).toContain("остановлено человеком");
    // Autopilot must not fight the human who stopped the turn.
    expect(calls.messages).toEqual([]);
  });

  it("still alarms when an accepted turn stalls without any native cancel", async () => {
    const notices: UnfinishedSessionNotice[] = [];
    const stalled = humanCancelledSession({
      status: "error",
      cancelledByUser: false,
      errorType: "provider_error",
      errorCode: "E_RETRY",
      retryable: true,
    });
    await acceptedInProgressFixture(stalled, notices);

    expect(notices.filter((notice) => notice.signalType === "accepted-admission-timeout")).toHaveLength(1);
  });

  it("leaves an adapter-proven transport abort to the existing recovery path", async () => {
    const notices: UnfinishedSessionNotice[] = [];
    // The zcode adapter reclassifies a cancelled_by_user=1 turn as a transport
    // abort when a detached client dropped a remote workspace. That class keeps
    // its own cold-recovery handling and must not become a human stop.
    const transportLost = {
      ...humanCancelledSession({ pendingInput: false, userMessageMatchesLatest: true, transportLost: true }),
      status: "error" as const,
      meta: {
        ...humanCancelledSession({ pendingInput: false, userMessageMatchesLatest: true, transportLost: true }).meta,
        workspaceIdentity: "remote:ssh:mac-mini",
      },
    };
    await acceptedInProgressFixture(transportLost, notices);

    expect(notices.filter((notice) => notice.signalType === "accepted-admission-timeout")).toHaveLength(1);
  });

  it("does not reconcile a cancel that has not completed yet", async () => {
    const notices: UnfinishedSessionNotice[] = [];
    const stillRunning = humanCancelledSession({ completedAt: Date.now() + 60_000 });
    await acceptedInProgressFixture(stillRunning, notices);

    expect(notices.filter((notice) => notice.signalType === "accepted-admission-timeout")).toHaveLength(1);
  });
});