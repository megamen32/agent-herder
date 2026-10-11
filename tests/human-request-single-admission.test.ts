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

/** Provider receipt ledger keyed by the stable idempotency key of one attempt. */
function ledger(): { calls: ResumeTransportRequest[]; query: (request: ResumeTransportRequest) => Promise<ResumeReceipt>; resume: (request: ResumeTransportRequest) => Promise<ResumeReceipt> } {
  const receipts = new Map<string, string>();
  const calls: ResumeTransportRequest[] = [];
  return {
    calls,
    async resume(request) {
      calls.push(request);
      const existing = receipts.get(request.idempotency_key!);
      if (existing) return { status: "accepted", target: request.target, result_ref: request.result_ref, receipt_ref: existing, idempotency_key: request.idempotency_key };
      const receiptRef = `agent-resume://receipt/${receipts.size + 1}`;
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

async function registry(): Promise<HumanRequestRegistry> {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-human-admission-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return new HumanRequestRegistry(join(root, "human-requests.json"));
}

describe("single human-request admission", () => {
  it("admits one resume for simultaneous answers and preserves the canonical admitted answer", async () => {
    const store = await registry();
    const created = await store.create({ kind: "user", target: { agent: "opencode", sessionId: "ses_open", cwd: "/workspace/app" } });
    const provider = ledger();

    const outcomes = await Promise.all([
      resumeHumanRequestOnce({ registry: store, requestId: created.requestId, resultRef: "result://answer/1", resume: provider.resume, queryReceipt: provider.query }),
      resumeHumanRequestOnce({ registry: store, requestId: created.requestId, resultRef: "result://answer/2", resume: provider.resume, queryReceipt: provider.query }),
      resumeHumanRequestOnce({ registry: store, requestId: created.requestId, resultRef: "result://answer/3", resume: provider.resume, queryReceipt: provider.query }),
      resumeHumanRequestOnce({ registry: store, requestId: created.requestId, resultRef: "result://answer/4", resume: provider.resume, queryReceipt: provider.query }),
    ]);

    // Exactly one native resume, one attempt and one provider receipt.
    expect(provider.calls).toHaveLength(1);
    expect(new Set(outcomes.map((outcome) => outcome.idempotencyKey)).size).toBe(1);
    expect(outcomes.every((outcome) => outcome.status === "resumed")).toBe(true);
    expect(outcomes.filter((outcome) => !outcome.duplicate)).toHaveLength(1);
    await expect(store.get(created.requestId)).resolves.toMatchObject({
      status: "resumed",
      resultRef: "result://answer/1",
      receipt: "agent-resume://receipt/1",
    });
  });

  it("returns the same durable receipt for repeated answers after completion", async () => {
    const store = await registry();
    const created = await store.create({ kind: "user", target: { agent: "opencode", sessionId: "ses_open", cwd: "/workspace/app" } });
    const provider = ledger();

    const first = await resumeHumanRequestOnce({ registry: store, requestId: created.requestId, resultRef: "result://answer/1", resume: provider.resume });
    const repeated = await resumeHumanRequestOnce({ registry: store, requestId: created.requestId, resultRef: "result://answer/9", resume: provider.resume, queryReceipt: provider.query });

    expect(first.status).toBe("resumed");
    expect(repeated).toMatchObject({ status: "resumed", duplicate: true, idempotencyKey: first.idempotencyKey });
    expect(repeated.record.receipt).toBe("agent-resume://receipt/1");
    expect(provider.calls).toHaveLength(1);
  });

  it("delivers one canonical instruction that tells the session to read the answer", async () => {
    const store = await registry();
    // The question-binding seam is what creates a Notice question row.
    const created = await store.create({ kind: "user", target: { agent: "opencode", sessionId: "ses_open", cwd: "/workspace/app" }, answerSource: "notice_question" });
    const provider = ledger();
    const prompts: string[] = [];

    await resumeHumanRequestOnce({
      registry: store,
      requestId: created.requestId,
      resultRef: "result://answer/1",
      resume: async (request) => {
        prompts.push(request.prompt ?? "");
        return { status: "accepted", target: request.target, result_ref: request.result_ref, receipt_ref: "agent-resume://receipt/1", idempotency_key: request.idempotency_key };
      },
    });
    // A repeated answer of the same request cannot change the instruction.
    await resumeHumanRequestOnce({
      registry: store,
      requestId: created.requestId,
      resultRef: "result://answer/2",
      resume: async (request) => {
        prompts.push(request.prompt ?? "");
        return { status: "accepted", target: request.target, result_ref: request.result_ref, receipt_ref: "agent-resume://receipt/1", idempotency_key: request.idempotency_key };
      },
    });

    const record = (await store.get(created.requestId))!;
    const canonical = continuationPrompt(record, "result://answer/1");
    expect(canonical).toContain(record.requestId);
    expect(canonical).toContain("noticeplace_question_result");
    expect(canonical).toContain("result://answer/1");
    expect(prompts[0]).toBe(canonical);
    // The second call is a terminal replay: it never reaches the transport.
    expect(prompts).toHaveLength(1);
  });

  it("never points a metadata-only request at a Notice question row", async () => {
    const store = await registry();
    const provider = ledger();
    // The judge and any other metadata-only caller create without a card.
    const created = await store.create({ kind: "user", target: { agent: "opencode", sessionId: "ses_open", cwd: "/workspace/app" } });
    expect(created.answerSource).toBe("human_channel");
    const prompts: string[] = [];

    await resumeHumanRequestOnce({
      registry: store,
      requestId: created.requestId,
      resultRef: "result://answer/1",
      resume: async (request) => {
        prompts.push(request.prompt ?? "");
        return { status: "accepted", target: request.target, result_ref: request.result_ref, receipt_ref: "agent-resume://receipt/1", idempotency_key: request.idempotency_key };
      },
    });

    expect(prompts[0]).not.toContain("noticeplace_question_result");
    expect(prompts[0]).toContain("arrived through this session");
  });

  it("keeps a secret answer opaque", async () => {
    const store = await registry();
    const created = await store.create({ kind: "secret", target: { agent: "opencode", sessionId: "ses_open", cwd: "/workspace/app" } });
    const prompts: string[] = [];

    await resumeHumanRequestOnce({
      registry: store,
      requestId: created.requestId,
      resultRef: "result://secret/1",
      resume: async (request) => {
        prompts.push(request.prompt ?? "");
        return { status: "accepted", target: request.target, result_ref: request.result_ref, receipt_ref: "agent-resume://receipt/1", idempotency_key: request.idempotency_key };
      },
    });

    expect(prompts[0]).toContain("secret reference result://secret/1");
    expect(prompts[0]).not.toContain("noticeplace_question_result");
    expect(prompts[0]).not.toContain("Apply it");
  });

  it("keeps a conflicting repeat from becoming a second attempt in the durable file", async () => {
    const store = await registry();
    const created = await store.create({ kind: "user", target: { agent: "zcode", sessionId: "ses_zcode", cwd: "/workspace/zcode" } });
    const provider = ledger();

    const admitted = await store.admitResume(created.requestId, { resultRef: "result://canonical" });
    const conflict = await store.admitResume(created.requestId, { resultRef: "result://conflicting" });

    expect(admitted.admitted).toBe(true);
    expect(conflict.admitted).toBe(false);
    expect(conflict.idempotencyKey).toBe(admitted.idempotencyKey);
    expect(conflict.record).toMatchObject({ status: "resuming", attemptId: admitted.record.attemptId, resultRef: "result://canonical" });
    expect(provider.calls).toHaveLength(0);
  });

  it("keeps an unanswered in-flight answer in flight instead of resuming a second time", async () => {
    const store = await registry();
    const created = await store.create({ kind: "user", target: { agent: "opencode", sessionId: "ses_open", cwd: "/workspace/app" } });
    const provider = ledger();

    const admitted = await store.admitResume(created.requestId, { resultRef: "result://answer/1" });
    const duplicate = await resumeHumanRequestOnce({
      registry: store,
      requestId: created.requestId,
      resultRef: "result://answer/1",
      resume: provider.resume,
      queryReceipt: provider.query,
    });

    expect(admitted.admitted).toBe(true);
    expect(duplicate).toMatchObject({ status: "in_flight", duplicate: true, idempotencyKey: admitted.idempotencyKey });
    expect(provider.calls).toHaveLength(0);
    await expect(store.get(created.requestId)).resolves.toMatchObject({ status: "resuming" });
  });

  it("fails a request whose bound session has no resumable native target", async () => {
    const store = await registry();
    const created = await store.create({ kind: "user", target: { agent: "hermes", sessionId: "agent:main:telegram:1" } });
    const provider = ledger();

    const outcome = await resumeHumanRequestOnce({ registry: store, requestId: created.requestId, resultRef: "result://answer/1", resume: provider.resume });

    expect(outcome.status).toBe("unsupported_target");
    expect(provider.calls).toHaveLength(0);
    await expect(store.get(created.requestId)).resolves.toMatchObject({ status: "resume_failed", receipt: "resume-target-unsupported" });
  });
});