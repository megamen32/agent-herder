import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ChoiceRegistry } from "../src/autopilot/choice-registry.js";
import { SessionAutostartStore, UnfinishedSessionLauncher, UnfinishedSessionStore } from "../src/autopilot/unfinished-session-launcher.js";
import { HumanRequestRegistry } from "../src/human-request/index.js";
import { HumanStopStore } from "../src/human-stop-store.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface Fixture {
  launcher: UnfinishedSessionLauncher;
  humanRequests: HumanRequestRegistry;
  choices: ChoiceRegistry;
  humanStops: HumanStopStore;
  root: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-pending-question-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const session: AgentSession = {
    id: "zcode-pending",
    harness: "zcode",
    status: "idle",
    title: "Incident under an unanswered question",
    cwd: "/workspace/incident",
    lastActivity: new Date().toISOString(),
    needsPermission: false,
  };
  const adapter: HarnessAdapter = {
    type: "zcode",
    name: "pending question fixture",
    async init() {},
    async listSessions() { return [{ ...session }]; },
    async getSession(id) { return id === session.id ? { ...session } : null; },
    async resumeSession() { return { ok: true }; },
    async sendMessage() { return { ok: true }; },
    async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; },
    async setPermissions() { return { ok: true }; },
  };
  const humanRequests = new HumanRequestRegistry(join(root, "human-requests.json"));
  const choices = new ChoiceRegistry(join(root, "choices.json"));
  const humanStops = new HumanStopStore(join(root, "human-stops.json"));
  const launcher = new UnfinishedSessionLauncher({
    adapters: new Map<string, HarnessAdapter>([["zcode", adapter]]),
    store: new UnfinishedSessionStore(join(root, "unfinished.json")),
    settingsStore: new SessionAutostartStore(join(root, "autostart.json"), {}),
    humanRequests,
    choiceRegistry: choices,
    humanStopStore: humanStops,
    pendingQuestionTtlMs: 0,
  });
  return { launcher, humanRequests, choices, humanStops, root };
}

const question = { agent: "zcode" as const, sessionId: "zcode-pending", cwd: "/workspace/incident" };
const CHOICES = [
  { choiceId: "continue", label: "Продолжить исправление", nextGoal: "исправить инцидент" },
  { choiceId: "rollback", label: "Откатить изменение", nextGoal: "откатить и проверить" },
];

describe("UnfinishedSessionLauncher pending-question gate", () => {
  it("never arms or continues a session whose human answer is still pending", async () => {
    const { launcher, humanRequests, choices } = await fixture();
    const session: AgentSession = {
      id: question.sessionId, harness: "zcode", status: "idle", title: "t", cwd: question.cwd,
      lastActivity: new Date().toISOString(), needsPermission: false,
    };

    // No question yet: the session is armed normally.
    await expect(launcher.armSession(session)).resolves.toBe(true);

    await humanRequests.create({ kind: "user", target: question });

    await expect(launcher.armSession(session)).resolves.toBe(false);
    await expect(launcher.armSession({ ...session, status: "needs_input" })).resolves.toBe(false);

    // An unanswered pending choice is the same fence.
    await humanRequests.admitResume((await humanRequests.list("pending"))[0]!.requestId, { resultRef: "result://answered" });
    await choices.create({
      harness: "zcode", sessionId: question.sessionId, turnId: "turn-1", cwd: question.cwd,
      choices: CHOICES,
    });

    await expect(launcher.armSession(session)).resolves.toBe(false);
  });

  it("continues the same session once the answer has been applied", async () => {
    const { launcher, humanRequests, choices } = await fixture();
    const session: AgentSession = {
      id: question.sessionId, harness: "zcode", status: "idle", title: "t", cwd: question.cwd,
      lastActivity: new Date().toISOString(), needsPermission: false,
    };
    const request = await humanRequests.create({ kind: "user", target: question });
    await choices.create({
      harness: "zcode", sessionId: question.sessionId, turnId: "turn-1", cwd: question.cwd,
      choices: CHOICES,
    });
    expect(await launcher.armSession(session)).toBe(false);

    await humanRequests.admitResume(request.requestId, { resultRef: "result://answered" });
    await choices.claimForResume((await choices.list({ limit: 1 }))[0]!.requestId, "continue");
    await choices.markResumed((await choices.list({ limit: 1 }))[0]!.requestId, "continue");

    expect(await launcher.armSession(session)).toBe(true);
  });

  it("lifts the fence when an expired question is cancelled", async () => {
    const { launcher, humanRequests, humanStops } = await fixture();
    const session: AgentSession = {
      id: question.sessionId, harness: "zcode", status: "idle", title: "t", cwd: question.cwd,
      lastActivity: new Date().toISOString(), needsPermission: false,
    };
    const request = await humanRequests.create({ kind: "user", target: question });
    expect(await launcher.armSession(session)).toBe(false);

    const cancelled = await humanRequests.cancel(request.requestId, "notice://question/expired");
    expect(cancelled).toMatchObject({ status: "cancelled" });
    expect(await launcher.armSession(session)).toBe(true);
    // A cancelled request is never resumed later.
    await expect(humanRequests.admitResume(request.requestId, { resultRef: "result://late" })).rejects.toThrow("cancelled");
    expect(await humanRequests.get(request.requestId)).toMatchObject({ status: "cancelled" });
  });

  it("keeps the explicit human-stop fence authoritative over the pending-question gate", async () => {
    const { launcher, humanRequests, humanStops } = await fixture();
    const session: AgentSession = {
      id: question.sessionId, harness: "zcode", status: "idle", title: "t", cwd: question.cwd,
      lastActivity: new Date().toISOString(), needsPermission: false,
    };
    await humanRequests.create({ kind: "user", target: question });
    await humanStops.hold(session, { id: "stop-1", at: new Date().toISOString(), reason: "explicit-stop" });

    await expect(launcher.armSession(session)).resolves.toBe(false);
    await expect(humanStops.isHeld("zcode", question.sessionId)).resolves.toBe(true);
  });
});