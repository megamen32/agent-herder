import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebServer } from "../src/web/server.js";
import { ChoiceRegistry } from "../src/autopilot/choice-registry.js";
import { createDefaultAutopilotPolicy } from "../src/autopilot/policy.js";
import { AutopilotPolicyStore } from "../src/autopilot/policy-store.js";
import { HumanStopStore } from "../src/human-stop-store.js";
import { SessionSupervisor } from "../src/session-supervisor.js";
import type { AgentSession, HarnessAdapter, SendMessageOptions } from "../src/types/index.js";

const servers: Server[] = [];
const roots: string[] = [];
let previousStopPath: string | undefined;
let changedStopPath = false;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (changedStopPath) {
    if (previousStopPath === undefined) delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    else process.env.AGENT_HERDER_HUMAN_STOP_STORE = previousStopPath;
    previousStopPath = undefined;
    changedStopPath = false;
  }
});

function fixtureSession(harness: "codex" | "zcode"): AgentSession {
  return {
    id: `${harness}-session-choice`, harness, status: "idle", title: "Choice target", cwd: "/workspace/choice",
    lastActivity: new Date().toISOString(), needsPermission: false,
  };
}

function receiptServer(harness: "codex" | "zcode", root: string) {
  const session = fixtureSession(harness);
  const messages: Array<{ id: string; options: SendMessageOptions }> = [];
  const adapter: HarnessAdapter = {
    type: harness, name: `${harness} choice fixture`, async init() {},
    async listSessions() { return [session]; },
    async getSession(id) { return id === session.id ? session : null; },
    async sendMessage(id, options) { messages.push({ id, options }); return { ok: true }; },
    async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; },
    async setPermissions() { return { ok: true }; },
  };
  const store = new HumanStopStore(join(root, "stops.json"));
  const adapters = new Map<string, HarnessAdapter>([[harness, adapter]]);
  const converter = { async convert() { return { success: true, targetSessionId: "x", targetPath: "/tmp/x", messageCount: 0 }; } };
  const supervisor = new SessionSupervisor(adapters, converter as any, undefined, { humanStopStore: store });
  return { session, messages, store, adapters, converter, supervisor };
}

async function startServer(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return address.port;
}

async function setupStopStore(root: string): Promise<string> {
  previousStopPath = process.env.AGENT_HERDER_HUMAN_STOP_STORE;
  changedStopPath = true;
  const path = join(root, "stops.json");
  process.env.AGENT_HERDER_HUMAN_STOP_STORE = path;
  return path;
}

describe("manual and automatic choice resume origins", () => {
  it.each(["codex", "zcode"] as const)("manual HTTP %s choice releases the held native ID once", async (harness) => {
    const root = await mkdtemp(join(tmpdir(), `agent-herder-manual-choice-${harness}-`));
    roots.push(root);
    await setupStopStore(root);
    const fixture = receiptServer(harness, root);
    if (harness === "zcode") {
      // A cold native lookup can report the daemon's default workspace until
      // scoped discovery binds this existing ID to its actual workspace.
      let bound = false;
      const adapter = fixture.adapters.get(harness)!;
      adapter.getSession = async () => ({ ...fixture.session, cwd: bound ? fixture.session.cwd : "/wrong-default-workspace" });
      adapter.listSessions = async (options = {}) => {
        bound = options.cwd === fixture.session.cwd;
        return bound ? [fixture.session] : [];
      };
    }
    const registry = new ChoiceRegistry(join(root, "choices.json"));
    const pending = await registry.create({
      harness,
      sessionId: fixture.session.id,
      turnId: "stopped-turn",
      cwd: fixture.session.cwd,
      choices: [
        { choiceId: "continue", label: "Продолжить", nextGoal: "Продолжай ту же задачу." },
        { choiceId: "inspect", label: "Проверить", nextGoal: "Проверь результат." },
      ],
    });
    await fixture.store.hold({ harness, id: fixture.session.id }, {
      id: `manual-stop-${harness}`, at: new Date(Date.now() - 1_000).toISOString(), reason: "interrupted", turnId: "stopped-turn",
    });
    const server = createWebServer({
      adapters: fixture.adapters, converter: fixture.converter, supervisor: fixture.supervisor, choiceRegistry: registry,
    });
    const port = await startServer(server);
    const url = `http://127.0.0.1:${port}/api/autopilot/choices/select`;
    const body = JSON.stringify({ request_id: pending.requestId, choice_id: "continue" });

    const selected = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(selected.status).toBe(202);
    expect(await selected.json()).toMatchObject({ status: "resumed", resumed: true, session_id: fixture.session.id });
    expect(fixture.messages).toHaveLength(1);
    expect(fixture.messages[0]).toMatchObject({
      id: fixture.session.id,
      options: { origin: "human", message: "Продолжай ту же задачу." },
    });
    expect(await fixture.store.isHeld(harness, fixture.session.id)).toBe(false);

    const duplicate = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({ duplicate: true, resumed: false });
    expect(fixture.messages).toHaveLength(1);
  });

  it.each(["codex", "zcode"] as const)("automatic expired %s choice refuses a held session without native delivery", async (harness) => {
    const root = await mkdtemp(join(tmpdir(), `agent-herder-auto-choice-${harness}-`));
    roots.push(root);
    await setupStopStore(root);
    const fixture = receiptServer(harness, root);
    const registry = new ChoiceRegistry(join(root, "choices.json"));
    const policyStore = new AutopilotPolicyStore(join(root, "policy.json"));
    const policy = {
      ...createDefaultAutopilotPolicy(),
      enabled: true,
      harnesses: [harness],
      scope: { mode: "all_ingress" as const },
      timeout: { mode: "auto_continue" as const, delayMs: 1 },
    };
    const saved = await policyStore.replacePolicy(policy, null);
    const pending = await registry.create({
      harness,
      sessionId: fixture.session.id,
      turnId: "stopped-turn",
      cwd: fixture.session.cwd,
      choices: [
        { choiceId: "continue", label: "Продолжить", nextGoal: "Не продолжать автоматически." },
        { choiceId: "inspect", label: "Проверить", nextGoal: "Проверь результат." },
      ],
      expiresAt: "2020-01-01T00:00:00.000Z",
      timeoutChoiceId: "continue",
      policyRevision: saved.revision,
      maxContinuationsPerSession: 2,
    });
    await fixture.store.hold({ harness, id: fixture.session.id }, {
      id: `automatic-stop-${harness}`, at: new Date(Date.now() - 1_000).toISOString(), reason: "interrupted", turnId: "stopped-turn",
    });
    const server = createWebServer({
      adapters: fixture.adapters,
      converter: fixture.converter,
      supervisor: fixture.supervisor,
      choiceRegistry: registry,
      autopilotPolicyStore: policyStore,
      autopilotSweepIntervalMs: 100,
    });
    await startServer(server);

    let final;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      final = await registry.get(pending.requestId);
      if (final?.status !== "pending") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(final?.status).toBe("failed");
    expect(final?.resumeReceipt).toMatchObject({ status: "failed" });
    expect(fixture.messages).toHaveLength(0);
    expect(await fixture.store.isHeld(harness, fixture.session.id)).toBe(true);
  });
});
