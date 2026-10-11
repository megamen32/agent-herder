import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HumanRequestRegistry, resumeHumanRequestOnce } from "../src/human-request/index.js";
import { continuationPrompt } from "../src/human-request/resume-admission.js";
import type { ResumeReceipt, ResumeTransportRequest } from "../src/resume-transport.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface ProviderLedger {
  calls: ResumeTransportRequest[];
  resume: (request: ResumeTransportRequest) => Promise<ResumeReceipt>;
  query: (request: ResumeTransportRequest) => Promise<ResumeReceipt>;
}

function ledger(): ProviderLedger {
  const receipts = new Map<string, string>();
  const calls: ResumeTransportRequest[] = [];
  return {
    calls,
    async resume(request) {
      calls.push(request);
      const existing = receipts.get(request.idempotency_key!);
      const receiptRef = existing ?? `agent-resume://receipt/${receipts.size + 1}`;
      receipts.set(request.idempotency_key!, receiptRef);
      return { status: "accepted", target: request.target, result_ref: request.result_ref, receipt_ref: receiptRef, idempotency_key: request.idempotency_key };
    },
    async query(request) {
      const receiptRef = receipts.get(request.idempotency_key!);
      if (!receiptRef) return { status: "ambiguous", target: request.target, result_ref: request.result_ref, reason: "no_receipt", idempotency_key: request.idempotency_key };
      return { status: "accepted", target: request.target, result_ref: request.result_ref, receipt_ref: receiptRef, idempotency_key: request.idempotency_key };
    },
  };
}

async function registryPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-human-crash-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return join(root, "human-requests.json");
}

describe("human-request resume across a crash", () => {
  it("waits for the admitted attempt while its lease is alive and then takes the same attempt over", async () => {
    const path = await registryPath();
    const provider = ledger();
    const firstProcess = new HumanRequestRegistry(path);
    const created = await firstProcess.create({ kind: "user", target: { agent: "opencode", sessionId: "ses_open", cwd: "/workspace/app" } });

    // A service admits the answer and then dies before it can invoke anything.
    const admitted = await firstProcess.admitResume(created.requestId, { resultRef: "result://answer/1" });
    expect(admitted.admitted).toBe(true);

    // A repeated answer while the lease is alive must not resume anything.
    const duringLease = await resumeHumanRequestOnce({
      registry: firstProcess,
      requestId: created.requestId,
      resultRef: "result://answer/1",
      resume: provider.resume,
      queryReceipt: provider.query,
    });
    expect(duringLease).toMatchObject({ status: "in_flight", idempotencyKey: admitted.idempotencyKey });
    expect(provider.calls).toHaveLength(0);

    // A restarted service takes the same attempt and key over once the lease expired.
    const restarted = new HumanRequestRegistry(path);
    const afterLease = await resumeHumanRequestOnce({
      registry: restarted,
      requestId: created.requestId,
      resultRef: "result://answer/1",
      resume: provider.resume,
      queryReceipt: provider.query,
      now: new Date(Date.now() + 10 * 60_000),
    });

    expect(afterLease.status).toBe("resumed");
    expect(afterLease.idempotencyKey).toBe(admitted.idempotencyKey);
    expect(afterLease.record.attemptId).toBe(admitted.record.attemptId);
    expect(provider.calls).toHaveLength(1);
    await expect(restarted.get(created.requestId)).resolves.toMatchObject({ status: "resumed", receipt: "agent-resume://receipt/1" });
  });

  it("reconciles a delivered attempt from the durable provider receipt without relaunching the session", async () => {
    const path = await registryPath();
    const provider = ledger();
    const firstProcess = new HumanRequestRegistry(path);
    const created = await firstProcess.create({ kind: "user", target: { agent: "opencode", sessionId: "ses_open", cwd: "/workspace/app" } });
    const admitted = await firstProcess.admitResume(created.requestId, { resultRef: "result://answer/1" });

    // The native resume was accepted by the provider, then the service died
    // before it could persist the terminal record.
    const accepted = await provider.resume({
      target: { agent: "opencode", session_id: "ses_open", cwd: "/workspace/app" },
      result_ref: "result://answer/1",
      idempotency_key: admitted.idempotencyKey,
    });
    expect(accepted.status).toBe("accepted");
    expect(provider.calls).toHaveLength(1);

    const restarted = new HumanRequestRegistry(path);
    const reconciled = await resumeHumanRequestOnce({
      registry: restarted,
      requestId: created.requestId,
      resultRef: "result://answer/1",
      resume: provider.resume,
      queryReceipt: provider.query,
    });

    expect(reconciled).toMatchObject({ status: "resumed", duplicate: true, idempotencyKey: admitted.idempotencyKey });
    expect(reconciled.record.receipt).toBe("agent-resume://receipt/1");
    // The session was delivered exactly once across both service lifetimes.
    expect(provider.calls).toHaveLength(1);
  });

  it("delivers the canonical admitted answer after a crash, not the conflicting repeat", async () => {
    const path = await registryPath();
    const delivered: ResumeTransportRequest[] = [];
    const store = new HumanRequestRegistry(path);
    const created = await store.create({ kind: "user", target: { agent: "opencode", sessionId: "ses_open", cwd: "/workspace/app" } });
    const admitted = await store.admitResume(created.requestId, { resultRef: "result://canonical-answer" });

    const takeover = await resumeHumanRequestOnce({
      registry: new HumanRequestRegistry(path),
      requestId: created.requestId,
      // A repeated provider callback that carries a different answer reference.
      resultRef: "result://conflicting-answer",
      resume: async (request) => {
        delivered.push(request);
        return { status: "accepted", target: request.target, result_ref: request.result_ref, receipt_ref: "agent-resume://receipt/1", idempotency_key: request.idempotency_key };
      },
      now: new Date(Date.now() + 10 * 60_000),
    });

    expect(takeover.status).toBe("resumed");
    expect(takeover.idempotencyKey).toBe(admitted.idempotencyKey);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.result_ref).toBe("result://canonical-answer");
    // The continuation instruction is derived from the durable record, so a
    // conflicting repeat cannot substitute its own prompt.
    expect(delivered[0]?.prompt).toBe(continuationPrompt(
      (await store.get(created.requestId))!,
      "result://canonical-answer",
    ));
    expect(delivered[0]?.prompt).toContain(created.requestId);
    expect(delivered[0]?.prompt).toContain("noticeplace_question_result");
    // The admission instant of the real answer travels with the resume, so an
    // explicit stop newer than that answer still fences it.
    expect(delivered[0]?.human_requested_at).toBe(Date.parse(admitted.record.admittedAt!));
    await expect(store.get(created.requestId)).resolves.toMatchObject({ status: "resumed", resultRef: "result://canonical-answer" });
  });

  it("never resumes a session again after a terminal failure", async () => {
    const path = await registryPath();
    const provider = ledger();
    const store = new HumanRequestRegistry(path);
    const created = await store.create({ kind: "user", target: { agent: "opencode", sessionId: "ses_open", cwd: "/workspace/app" } });

    const failed = await resumeHumanRequestOnce({
      registry: store,
      requestId: created.requestId,
      resultRef: "result://answer/1",
      resume: async (request) => ({ status: "failed", target: request.target, result_ref: request.result_ref, reason: "unavailable", idempotency_key: request.idempotency_key }),
    });
    expect(failed.status).toBe("resume_failed");

    const repeated = await resumeHumanRequestOnce({
      registry: store,
      requestId: created.requestId,
      resultRef: "result://answer/2",
      resume: provider.resume,
      queryReceipt: provider.query,
    });

    expect(repeated).toMatchObject({ status: "resume_failed", duplicate: true });
    expect(provider.calls).toHaveLength(0);
    await expect(store.get(created.requestId)).resolves.toMatchObject({ status: "resume_failed", resultRef: "result://answer/1" });
  });
});