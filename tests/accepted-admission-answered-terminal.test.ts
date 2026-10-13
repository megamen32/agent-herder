import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AutopilotPolicyStore } from "../src/autopilot/policy-store.js";
import { AutopilotSessionStore } from "../src/autopilot/session-store.js";
import { SessionAutostartStore, UnfinishedSessionLauncher, UnfinishedSessionStore, type UnfinishedSessionNotice } from "../src/autopilot/unfinished-session-launcher.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

// Live tuple observed on 2026-10-13 for the session behind
// inc_f34145d41a9f4743ab1ab2372e00b4d4 (agent-herder:accepted-terminal-
// exhausted:389a7546041a7a711edff315 == sha256 of this source key).
const SESSION_ID = "sess_e2077a20-3e61-4816-9301-73fe52e75d2b";
const CWD = "/home/roomhacker/PycharmProjects/TelegramAuto";

/**
 * The session accepted a continuation, that turn failed without an assistant
 * answer, and the one bounded re-admission then produced a real assistant
 * answer. A answered terminal must not inherit the previous retry count.
 */
function answeredAfterRejectionSession(acceptedAt: string): AgentSession {
  return {
    id: SESSION_ID,
    harness: "zcode",
    status: "idle",
    title: "zcode-20261013102645-e1c5df91",
    cwd: CWD,
    lastActivity: new Date(Date.now() - 30_000).toISOString(),
    needsPermission: false,
    messageCount: 8,
    meta: { workspaceIdentity: CWD },
  };
}

function harness(session: AgentSession, calls: { messages: string[] }, acceptedAt: string): HarnessAdapter {
  return {
    type: "zcode",
    name: "fixture",
    async init() {},
    async listSessions() { return [{ ...session }]; },
    async getSession(id) { return id === session.id ? { ...session } : null; },
    async getSessionMessages() {
      return [
        {
          id: "u-accepted",
          role: "user",
          text: "Продолжи незавершённую задачу с того места, где выполнение было прервано.",
          timestamp: acceptedAt,
          parts: [{ type: "text", text: "Продолжи незавершённую задачу с того места, где выполнение было прервано." }],
        },
        {
          id: "a-answered",
          role: "assistant",
          text: "Принято — продолжаю задачу и параллельно считаю модель.",
          timestamp: new Date(Date.parse(acceptedAt) + 10_000).toISOString(),
          parts: [{ type: "text", text: "Принято — продолжаю задачу и параллельно считаю модель." }],
        },
      ];
    },
    async resumeSession() { return { ok: true }; },
    async sendMessage(_id, input) { calls.messages.push(input.message); return { ok: true }; },
    async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; },
    async setPermissions() { return { ok: true }; },
  };
}

async function answeredAfterRejectionFixture(notices: UnfinishedSessionNotice[]) {
  const root = await mkdtemp(join(tmpdir(), "accepted-admission-answered-"));
  const calls = { messages: [] as string[] };
  const store = new UnfinishedSessionStore(join(root, "state.json"));
  const session = answeredAfterRejectionSession("");
  const firstAcceptedAt = new Date(Date.now() - 30 * 60_000);
  await store.markStarted(session, "generation-1", firstAcceptedAt, false, true);
  await store.markAdmissionTerminal(
    session.harness as "zcode",
    session.id,
    session.cwd,
    "turn.failed",
    undefined,
    false,
    new Date(firstAcceptedAt.getTime() + 60_000),
  );
  const readmittedAt = new Date(Date.now() - 20 * 60_000);
  await store.markStarted(session, "generation-1", readmittedAt, false, true);
  expect((await store.list())[0]).toMatchObject({ admissionPhase: "accepted_pending", terminalRetryCount: 1 });

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
    adapters: new Map([["zcode", harness(session, calls, readmittedAt.toISOString())]]),
    store,
    settingsStore,
    autopilotPolicyStore: policyStore,
    autopilotSessionStore: new AutopilotSessionStore(join(root, "sessions.json")),
    discoveryIdleMs: 1,
    acceptedAdmissionTimeoutMs: 60 * 60_000,
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
  return { store, calls, inventory: await store.listInventory() };
}

describe("accepted admission answered after a rejected turn", () => {
  it("does not exhaust a session whose re-admitted turn produced an assistant answer", async () => {
    const notices: UnfinishedSessionNotice[] = [];
    const { store, calls, inventory } = await answeredAfterRejectionFixture(notices);

    expect(notices.filter((notice) => notice.signalType === "accepted-admission-exhausted")).toEqual([]);
    expect(notices.filter((notice) => notice.signalType === "accepted-admission-timeout")).toEqual([]);
    const record = (await store.list()).find((candidate) => candidate.sessionId === SESSION_ID);
    // A terminal that carried an assistant answer discharges the retry budget,
    // so the answered session is admitted again instead of handed to a human.
    expect(record?.terminalRetryCount).toBe(0);
    expect(calls.messages).toHaveLength(1);
    const assessed = inventory.find((candidate) => candidate.sessionId === SESSION_ID);
    expect(assessed?.verdict?.verdict).not.toBe("needs_human");
  });
});