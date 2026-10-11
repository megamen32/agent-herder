import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HumanRequestRegistry, resumeHumanRequestOnce } from "../src/human-request/index.js";
import { HumanStopStore } from "../src/human-stop-store.js";
import { LineageStore } from "../src/lineage-store.js";
import { SessionSupervisor } from "../src/session-supervisor.js";
import type { AgentSession, HarnessAdapter, SendMessageOptions } from "../src/types/index.js";
import { nativeResumeReceiptQuery, resumeSelectedTarget } from "../src/web/server.js";

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

    // A definite native pre-admission failure may retry this same answer, but
    // must retain the original time rather than bypassing a later human stop.
    await registry.failResume(created.requestId, { attemptId: admitted.record.attemptId!, receipt: "agent-resume:native-unavailable", retryable: true });

    // The human stops the session after that answer was admitted.
    await humanStops.hold(session, { id: "stop-after-answer", at: new Date(Date.parse(admitted.record.admittedAt!) + 1_000).toISOString(), reason: "explicit stop" });
    expect(await humanStops.isHeld("zcode", session.id)).toBe(true);

    const leaseExpired = new Date(Date.parse(admitted.record.admittedAt!) + 10 * 60_000);
    const outcome = await resumeHumanRequestOnce({
      registry,
      requestId: created.requestId,
      resultRef: "result://answer/1",
      resume: (request) => resumeSelectedTarget(request, supervisor, "human", true),
      now: leaseExpired,
    });

    expect(outcome.status).toBe("resume_failed");
    expect(deliveries).toHaveLength(0);
    expect(await humanStops.isHeld("zcode", session.id)).toBe(true);
  });

  it("preserves a fresh stop when an old record has no verifiable answer time", async () => {
    const { supervisor, humanStops, deliveries, session } = await fixture();
    const store = join(process.env.AGENT_HERDER_HUMAN_STOP_STORE!, "../human-requests.json");
    const registry = new HumanRequestRegistry(store);
    const created = await registry.create({ kind: "user", target: { agent: "zcode", sessionId: session.id, cwd: session.cwd } });
    // A pre-lease record: resuming with an attempt id and no answer instant.
    const stored = JSON.parse(await readFile(store, "utf8")) as { version: number; requests: Array<Record<string, unknown>> };
    stored.requests[0]!.status = "resuming";
    stored.requests[0]!.attemptId = "attempt-legacy";
    await writeFile(store, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    await humanStops.hold(session, { id: "stop-now", at: new Date().toISOString(), reason: "explicit stop" });

    // The first replay only starts the wait for this pre-lease record.
    const first = await resumeHumanRequestOnce({
      registry,
      requestId: created.requestId,
      resultRef: "result://late-retry",
      resume: (request) => resumeSelectedTarget(request, supervisor, "human", true),
    });
    expect(first.status).toBe("in_flight");
    expect(deliveries).toHaveLength(0);

    // Expiry only transfers observation. Unknown admission never reaches the
    // transport, and the fresh stop still holds without an original answer time.
    const outcome = await resumeHumanRequestOnce({
      registry,
      requestId: created.requestId,
      resultRef: "result://late-retry",
      resume: (request) => resumeSelectedTarget(request, supervisor, "human", true),
      now: new Date(Date.now() + 10 * 60_000),
    });

    expect(outcome.status).toBe("in_flight");
    expect(deliveries).toHaveLength(0);
    expect(await humanStops.isHeld("zcode", session.id)).toBe(true);
  });

  it("reconciles a duplicate answer against native admission, never an external ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-native-receipt-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const admissions: Array<{ id: string; inputId: string }> = [];
    let admitted = false;
    const adapter: HarnessAdapter = {
      type: "zcode", name: "native admission fixture", async init() {},
      async listSessions() { return []; }, async getSession() { return null; },
      async resumeSession() { return { ok: true }; }, async sendMessage() { return { ok: true }; },
      async stopSession() { return { ok: true }; }, async respondPermission() { return { ok: true }; },
      async setPermissions() { return { ok: true }; },
      async getMessageAdmission(id, inputId) {
        admissions.push({ id, inputId });
        return admitted ? { state: "admitted" as const } : { state: "unknown" as const };
      },
    };
    const adapters = new Map<string, HarnessAdapter>([["zcode", adapter]]);
    const request = { target, result_ref: "result://answer/1", idempotency_key: "human-request:req-1:attempt-1" };

    expect((await nativeResumeReceiptQuery(request, adapters)).status).toBe("ambiguous");
    admitted = true;
    const reconciled = await nativeResumeReceiptQuery(request, adapters);

    expect(reconciled.status).toBe("accepted");
    expect(reconciled.idempotency_key).toBe("human-request:req-1:attempt-1");
    // The same stable input identity the delivery path used.
    expect(admissions).toHaveLength(2);
    expect(admissions[0]?.inputId).toBe(admissions[1]?.inputId);
    expect(admissions[0]?.inputId).toMatch(/^herder-resume-[0-9a-f]{32}$/);
    expect(admissions[0]?.id).toBe(target.session_id);
    // A harness without a native admission query is never treated as delivered.
    expect((await nativeResumeReceiptQuery(request, new Map())).status).toBe("ambiguous");
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
      resume: (request) => resumeSelectedTarget(request, supervisor, "human", true),
    });

    expect(outcome.status).toBe("resumed");
    expect(deliveries).toHaveLength(1);
    expect(typeof deliveries[0]?.humanRequestedAt).toBe("number");
    expect(await humanStops.isHeld("zcode", session.id)).toBe(false);
  });
});
