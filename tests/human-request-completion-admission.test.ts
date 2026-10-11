import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HumanRequestRegistry } from "../src/human-request/index.js";
import type { ResumeReceipt, ResumeTransportRequest } from "../src/resume-transport.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";
import { createWebServer } from "../src/web/server.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("internal human-request completion admission", () => {
  it("resumes the exact session once for simultaneous provider callbacks", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-human-completion-admission-"));
    const session: AgentSession = {
      id: "opencode-incident", harness: "opencode", status: "needs_input", title: "Incident awaits an answer",
      cwd: "/workspace/incident", lastActivity: new Date().toISOString(), needsPermission: false,
    };
    const adapter: HarnessAdapter = {
      type: "opencode", name: "opencode admission fixture", async init() {},
      async listSessions() { return [{ ...session }]; },
      async getSession(id) { return id === session.id ? { ...session } : null; },
      async resumeSession() { return { ok: true }; },
      async sendMessage() { return { ok: true }; },
      async stopSession() { return { ok: true }; }, async respondPermission() { return { ok: true }; },
      async setPermissions() { return { ok: true }; },
    };
    const adapters = new Map<string, HarnessAdapter>([["opencode", adapter]]);
    const humanRequests = new HumanRequestRegistry(join(root, "human-requests.json"));
    const request = await humanRequests.create({ kind: "user", target: { agent: "opencode", sessionId: session.id, cwd: session.cwd } });

    const invocations: ResumeTransportRequest[] = [];
    const receipts = new Map<string, string>();
    const choiceResume = async (input: ResumeTransportRequest): Promise<ResumeReceipt> => {
      invocations.push(input);
      const receiptRef = `agent-resume://opencode/${receipts.size + 1}`;
      receipts.set(input.idempotency_key!, receiptRef);
      return { status: "accepted", target: input.target, result_ref: input.result_ref, receipt_ref: receiptRef, idempotency_key: input.idempotency_key };
    };
    const choiceQuery = async (input: ResumeTransportRequest): Promise<ResumeReceipt> => {
      const receiptRef = receipts.get(input.idempotency_key!);
      return receiptRef
        ? { status: "accepted", target: input.target, result_ref: input.result_ref, receipt_ref: receiptRef, idempotency_key: input.idempotency_key }
        : { status: "ambiguous", target: input.target, result_ref: input.result_ref, reason: "no_receipt", idempotency_key: input.idempotency_key };
    };

    const server = createWebServer({ adapters, converter: { async convert() { throw new Error("unused"); } }, humanRequests, choiceResume, choiceQuery, sessionObservationManagedExternally: true });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const endpoint = `http://127.0.0.1:${address.port}/internal/human-requests/ask-user-completion`;

    const bodies = Array.from({ length: 5 }, () => JSON.stringify({
      event: "ask.user.completed", event_version: 1, status: "completed", request_id: request.requestId, result_ref: randomUUID(),
    }));
    const responses = await Promise.all(bodies.map((body) => fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json" }, body,
    })));

    expect(responses.map((response) => response.status)).toEqual([202, 202, 202, 202, 202]);
    for (const response of responses) {
      await expect(response.json()).resolves.toMatchObject({ request_id: request.requestId, status: "resumed" });
    }
    expect(invocations).toHaveLength(1);
    expect(new Set(invocations.map((input) => input.idempotency_key)).size).toBe(1);
    expect(invocations[0]?.idempotency_key).toMatch(new RegExp(`^human-request:${request.requestId}:`));
    expect(invocations[0]?.target).toMatchObject({ agent: "opencode", session_id: session.id, cwd: session.cwd });
    expect(invocations[0]?.prompt).toContain("Human Request resolved:");
    await expect(humanRequests.get(request.requestId)).resolves.toMatchObject({ status: "resumed" });
  });

  it("reports an in-flight answer instead of launching a second resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-human-completion-inflight-"));
    const session: AgentSession = {
      id: "opencode-inflight", harness: "opencode", status: "needs_input", title: "Answer already in flight",
      cwd: "/workspace/inflight", lastActivity: new Date().toISOString(), needsPermission: false,
    };
    const adapters = new Map<string, HarnessAdapter>([["opencode", {
      type: "opencode", name: "opencode in-flight fixture", async init() {},
      async listSessions() { return [{ ...session }]; },
      async getSession(id) { return id === session.id ? { ...session } : null; },
      async resumeSession() { return { ok: true }; },
      async sendMessage() { return { ok: true }; },
      async stopSession() { return { ok: true }; }, async respondPermission() { return { ok: true }; },
      async setPermissions() { return { ok: true }; },
    } satisfies HarnessAdapter]]);
    const humanRequests = new HumanRequestRegistry(join(root, "human-requests.json"));
    const request = await humanRequests.create({ kind: "user", target: { agent: "opencode", sessionId: session.id, cwd: session.cwd } });
    const admitted = await humanRequests.admitResume(request.requestId, { resultRef: "result://first" });

    let launches = 0;
    const server = createWebServer({
      adapters,
      converter: { async convert() { throw new Error("unused"); } },
      humanRequests,
      choiceResume: async (input) => { launches += 1; return { status: "accepted", target: input.target, result_ref: input.result_ref, receipt_ref: "agent-resume://unexpected", idempotency_key: input.idempotency_key }; },
      choiceQuery: async (input) => ({ status: "ambiguous", target: input.target, result_ref: input.result_ref, reason: "no_receipt", idempotency_key: input.idempotency_key }),
      sessionObservationManagedExternally: true,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const response = await fetch(`http://127.0.0.1:${address.port}/internal/human-requests/ask-user-completion`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "ask.user.completed", event_version: 1, status: "completed", request_id: request.requestId, result_ref: randomUUID() }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ status: "resuming", in_flight: true, idempotency_key: admitted.idempotencyKey });
    expect(launches).toBe(0);
    await expect(humanRequests.get(request.requestId)).resolves.toMatchObject({ status: "resuming", resultRef: "result://first" });
  });
});