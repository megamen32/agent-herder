import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HumanRequestRegistry, resumeHumanRequestOnce } from "../src/human-request/index.js";
import { HumanStopStore } from "../src/human-stop-store.js";
import { LineageStore } from "../src/lineage-store.js";
import { SessionSupervisor } from "../src/session-supervisor.js";
import type { AgentSession, HarnessAdapter, SendMessageOptions } from "../src/types/index.js";
import { resumeSelectedTarget } from "../src/web/server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.unstubAllEnvs();
});

async function fixture(): Promise<{
  supervisor: SessionSupervisor;
  humanStops: HumanStopStore;
  deliveries: SendMessageOptions[];
  session: AgentSession;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-resume-fence-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  vi.stubEnv("AGENT_HERDER_HUMAN_STOP_STORE", join(root, "human-stops.json"));
  const session: AgentSession = {
    id: "zcode-incident", harness: "zcode", status: "needs_input", title: "Incident answer",
    cwd: "/workspace/incident", lastActivity: new Date().toISOString(), needsPermission: false,
  };
  const deliveries: SendMessageOptions[] = [];
  const adapter: HarnessAdapter = {
    type: "zcode", name: "resume fence fixture", async init() {},
    async listSessions(options) { return options?.cwd === session.cwd ? [{ ...session }] : []; },
    async getSession(id) { return id === session.id ? { ...session } : null; },
    async resumeSession() { return { ok: true }; },
    async sendMessage(_id, options) { deliveries.push(options); return { ok: true }; },
    async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; },
    async setPermissions() { return { ok: true }; },
  };
  const adapters = new Map<string, HarnessAdapter>([["zcode", adapter]]);
  const humanStops = new HumanStopStore(join(root, "human-stops.json"));
  const supervisor = new SessionSupervisor(
    adapters,
    { async convert() { throw new Error("unused"); } } as never,
    new LineageStore(join(root, "lineage.json")),
    { humanStopStore: humanStops },
  );
  return { supervisor, humanStops, deliveries, session };
}

const target = { agent: "zcode" as const, session_id: "zcode-incident", cwd: "/workspace/incident" };

describe("bound resume transport", () => {
  it("carries one stable native input identity for the same idempotency key", async () => {
    const { supervisor, deliveries } = await fixture();
    const request = { target, result_ref: "result://answer/1", idempotency_key: "human-request:req-1:attempt-1" };

    const first = await resumeSelectedTarget(request, supervisor, "human");
    const replay = await resumeSelectedTarget(request, supervisor, "human");

    expect(first.status).toBe("accepted");
    expect(replay.status).toBe("accepted");
    expect(deliveries).toHaveLength(2);
    // The deduplicating ingress receives the same key for the same answer.
    expect(deliveries[0]?.inputId).toBe(deliveries[1]?.inputId);
    expect(deliveries[0]?.inputId).toMatch(/^herder-resume-[0-9a-f]{32}$/);
    const other = await resumeSelectedTarget({ ...request, idempotency_key: "human-request:req-1:attempt-2" }, supervisor, "human");
    expect(other.status).toBe("accepted");
    expect(deliveries[2]?.inputId).not.toBe(deliveries[0]?.inputId);
  });

  it("keeps an old answer held by a newer explicit human stop", async () => {
    const { supervisor, humanStops, deliveries, session } = await fixture();
    const registry = new HumanRequestRegistry(join(process.env.AGENT_HERDER_HUMAN_STOP_STORE!, "../human-requests.json"));
    const created = await registry.create({ kind: "user", target: { agent: "zcode", sessionId: session.id, cwd: session.cwd } });
    const admitted = await registry.admitResume(created.requestId, { resultRef: "result://answer/1" });

    // The human stops the session after that answer was admitted.
    await humanStops.hold(session, { id: "stop-after-answer", at: new Date(Date.parse(admitted.record.admittedAt!) + 1_000).toISOString(), reason: "explicit stop" });
    expect(await humanStops.isHeld("zcode", session.id)).toBe(true);

    const leaseExpired = new Date(Date.parse(admitted.record.admittedAt!) + 10 * 60_000);
    const outcome = await resumeHumanRequestOnce({
      registry,
      requestId: created.requestId,
      resultRef: "result://answer/1",
      resume: (request) => resumeSelectedTarget(request, supervisor, "human"),
      now: leaseExpired,
    });

    expect(outcome.status).toBe("resume_failed");
    expect(deliveries).toHaveLength(0);
    expect(await humanStops.isHeld("zcode", session.id)).toBe(true);
  });

  it("delivers an answer that a human made after the stop", async () => {
    const { supervisor, humanStops, deliveries, session } = await fixture();
    const registry = new HumanRequestRegistry(join(process.env.AGENT_HERDER_HUMAN_STOP_STORE!, "../human-requests.json"));
    const created = await registry.create({ kind: "user", target: { agent: "zcode", sessionId: session.id, cwd: session.cwd } });
    await humanStops.hold(session, { id: "stop-before-answer", at: new Date(Date.now() - 60_000).toISOString(), reason: "explicit stop" });

    const outcome = await resumeHumanRequestOnce({
      registry,
      requestId: created.requestId,
      resultRef: "result://answer/1",
      resume: (request) => resumeSelectedTarget(request, supervisor, "human"),
    });

    expect(outcome.status).toBe("resumed");
    expect(deliveries).toHaveLength(1);
    expect(typeof deliveries[0]?.humanRequestedAt).toBe("number");
    expect(await humanStops.isHeld("zcode", session.id)).toBe(false);
  });
});