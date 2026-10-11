import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ChoiceRegistry } from "../src/autopilot/choice-registry.js";
import { createAutopilotCore } from "../src/autopilot/index.js";
import { PendingQuestionGate } from "../src/autopilot/pending-question-gate.js";
import { runAutopilotStopHook } from "../src/autopilot-hook.js";
import { HumanRequestRegistry } from "../src/human-request/index.js";
import { HumanStopStore } from "../src/human-stop-store.js";
import { SessionAutostartStore, UnfinishedSessionLauncher, UnfinishedSessionStore } from "../src/autopilot/unfinished-session-launcher.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";
import { createWebServer } from "../src/web/server.js";

const servers: Server[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function root(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const session: AgentSession = {
  id: "zcode-question",
  harness: "zcode",
  status: "idle",
  title: "Incident waiting for a human answer",
  cwd: "/workspace/incident",
  lastActivity: new Date().toISOString(),
  needsPermission: false,
};

const adapter: HarnessAdapter = {
  type: "zcode",
  name: "pending question regression fixture",
  async init() {},
  async listSessions() { return [{ ...session }]; },
  async getSession(id) { return id === session.id ? { ...session } : null; },
  async resumeSession() { return { ok: true }; },
  async sendMessage() { return { ok: true }; },
  async stopSession() { return { ok: true }; },
  async respondPermission() { return { ok: true }; },
  async setPermissions() { return { ok: true }; },
};

const choices = [
  { choiceId: "continue", label: "Продолжить исправление", nextGoal: "исправить инцидент" },
  { choiceId: "rollback", label: "Откатить изменение", nextGoal: "откатить и проверить" },
];

describe("an unanswered question blocks every autopilot entry point", () => {
  it("does not judge or continue a new idle turn of a session with a pending question", async () => {
    const dir = await root("agent-herder-pending-question-core-");
    const humanRequests = new HumanRequestRegistry(join(dir, "human-requests.json"));
    const choiceRegistry = new ChoiceRegistry(join(dir, "choices.json"));
    await humanRequests.create({ kind: "user", target: { agent: "zcode", sessionId: session.id, cwd: session.cwd } });
    await choiceRegistry.create({ harness: "zcode", sessionId: session.id, turnId: "turn-question", cwd: session.cwd, choices });
    let judged = 0;

    const core = () => createAutopilotCore({
      judge: { async decide() { judged += 1; return { kind: "continue", nextGoal: "исправить инцидент" }; } },
      notify: { async send() {} },
      allowSessions: new Set([session.id]),
      receiptStore: new Map(),
      maxContinuationsPerSession: 3,
      harness: "zcode",
      humanRequests,
      choiceRegistry,
      pendingQuestions: new PendingQuestionGate({ humanRequests, choices: choiceRegistry }),
    });

    // A brand new turn after an idle stop is not a way past the question.
    await expect(core().handleStop({
      hook_event_name: "Stop", session_id: session.id, cwd: session.cwd, turn_id: "turn-after-idle",
      last_assistant_message: "Продолжаю.", transcript_path: null, stop_hook_active: false, harness: "zcode",
    })).resolves.toEqual({});
    await expect(core().handleStop({
      hook_event_name: "Stop", session_id: session.id, cwd: session.cwd, turn_id: "turn-after-idle-2",
      last_assistant_message: "Ещё шаг.", transcript_path: null, stop_hook_active: false, harness: "zcode",
    })).resolves.toEqual({});
    expect(judged).toBe(0);
  });

  it("applies the same fence in the Stop hook entry point", async () => {
    const dir = await root("agent-herder-pending-question-hook-");
    const humanRequests = new HumanRequestRegistry(join(dir, "human-requests.json"));
    const choiceRegistry = new ChoiceRegistry(join(dir, "choices.json"));
    await humanRequests.create({ kind: "user", target: { agent: "zcode", sessionId: session.id, cwd: session.cwd } });
    let judged = 0;

    await expect(runAutopilotStopHook({
      hook_event_name: "Stop", session_id: session.id, cwd: session.cwd, turn_id: "turn-hook",
      last_assistant_message: "Продолжаю.", transcript_path: null, stop_hook_active: false, harness: "zcode",
    }, {
      judge: { async decide() { judged += 1; return { kind: "continue", nextGoal: "исправить инцидент" }; } },
      notify: { async send() {} },
      allowSessions: new Set([session.id]),
      receiptStore: new Map(),
      maxContinuationsPerSession: 3,
      humanRequests,
      choiceRegistry,
      pendingQuestions: new PendingQuestionGate({ humanRequests, choices: choiceRegistry }),
      humanStopStore: new HumanStopStore(join(dir, "human-stops.json")),
    })).resolves.toEqual({});
    expect(judged).toBe(0);
  });

  it("sees a pending choice older than hundreds of later terminal records", async () => {
    const dir = await root("agent-herder-pending-question-old-");
    const choiceRegistry = new ChoiceRegistry(join(dir, "choices.json"));
    const humanRequests = new HumanRequestRegistry(join(dir, "human-requests.json"));
    const older = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
    const pending = await choiceRegistry.create({ harness: "zcode", sessionId: "zcode-old", turnId: "turn-old", cwd: "/workspace/old", choices });
    for (let index = 0; index < 250; index += 1) {
      const record = await choiceRegistry.create({ harness: "zcode", sessionId: `zcode-later-${index}`, turnId: `turn-${index}`, cwd: `/workspace/${index}`, choices });
      await choiceRegistry.claimForResume(record.requestId, "continue");
      await choiceRegistry.markResumed(record.requestId, "continue");
    }
    const gate = new PendingQuestionGate({ humanRequests, choices: choiceRegistry });

    await expect(gate.blocks("zcode", "zcode-old", "/workspace/old")).resolves.toBe(true);
    await expect(gate.blocks("zcode", "zcode-later-0", "/workspace/0")).resolves.toBe(false);
    expect(pending.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps durable recovery state while a question is pending and recovers it after the answer", async () => {
    const dir = await root("agent-herder-pending-question-recovery-");
    const humanRequests = new HumanRequestRegistry(join(dir, "human-requests.json"));
    const choiceRegistry = new ChoiceRegistry(join(dir, "choices.json"));
    const store = new UnfinishedSessionStore(join(dir, "unfinished.json"));
    const sends: string[] = [];
    const adapterWithSend: HarnessAdapter = { ...adapter, async sendMessage(id, input) { sends.push(input.message); return { ok: true }; } };
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map<string, HarnessAdapter>([["zcode", adapterWithSend]]),
      store,
      settingsStore: new SessionAutostartStore(join(dir, "autostart.json"), {}),
      humanRequests,
      choiceRegistry,
      humanStopStore: new HumanStopStore(join(dir, "human-stops.json")),
      pendingQuestionTtlMs: 0,
    });
    // An accepted turn that failed natively: durable recovery state exists.
    await store.markRecoveryEligible(session, "turn.failed", { turnId: "turn-failed" });
    const before = await store.list();
    expect(before).toMatchObject([{ harness: "zcode", sessionId: session.id, recoveryCause: "turn.failed" }]);

    const request = await humanRequests.create({ kind: "user", target: { agent: "zcode", sessionId: session.id, cwd: session.cwd } });
    const arming = await launcher.armSession(session);
    expect(arming).toBe(false);
    // The durable record survives the deferral.
    expect((await store.list()).length).toBe(before.length);
    expect(sends).toHaveLength(0);

    await humanRequests.admitResume(request.requestId, { resultRef: "result://answered" });
    expect(await launcher.armSession(session)).toBe(true);
  });

  it("keeps a human-stopped session held for an old answer through the canonical transport", async () => {
    const dir = await root("agent-herder-old-answer-stop-fence-");
    const humanRequests = new HumanRequestRegistry(join(dir, "human-requests.json"));
    const delivered: Array<{ message: string; humanRequestedAt?: number; inputId?: string }> = [];
    const supervisorServer = createWebServer({
      adapters: new Map<string, HarnessAdapter>([["zcode", adapter]]),
      converter: { async convert() { throw new Error("unused"); } },
      humanRequests,
      humanResume: async (input) => {
        delivered.push({ message: input.prompt ?? "", ...(input.human_requested_at === undefined ? {} : { humanRequestedAt: input.human_requested_at }) });
        return { status: "accepted", target: input.target, result_ref: input.result_ref, receipt_ref: "agent-resume://receipt/1", idempotency_key: input.idempotency_key };
      },
      sessionObservationManagedExternally: true,
    });
    servers.push(supervisorServer);
    await new Promise<void>((resolve) => supervisorServer.listen(0, "127.0.0.1", resolve));
    const address = supervisorServer.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const request = await humanRequests.create({ kind: "user", target: { agent: "zcode", sessionId: session.id, cwd: session.cwd } });
    const response = await fetch(`http://127.0.0.1:${address.port}/internal/human-requests/ask-user-completion`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "ask.user.completed", event_version: 1, status: "completed", request_id: request.requestId, result_ref: "11111111-1111-4111-8111-111111111111" }),
    });

    expect(response.status).toBe(202);
    expect(delivered).toHaveLength(1);
    // The answer carries the instant it was admitted, so a later explicit stop
    // can still fence this delivery in the supervisor.
    expect(typeof delivered[0]?.humanRequestedAt).toBe("number");
  });
});