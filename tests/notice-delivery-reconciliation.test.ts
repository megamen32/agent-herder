import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HumanRequestRegistry } from "../src/human-request/registry.js";

const roots: string[] = [];
const fingerprint = "a".repeat(64);
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(claim = true) {
  const root = await mkdtemp(join(tmpdir(), "notice-reconciliation-"));
  roots.push(root);
  const store = new HumanRequestRegistry(join(root, "requests.json"));
  const request = await store.create({
    kind: "user", target: { harness: "codex", sessionId: "test-session" },
    answerSource: "notice_question", noticeDeliveryMode: "automatic",
    notify: { project: "test", recipient: "test", kind: "human_request", severity: "important", title: "Question" },
  });
  const delivery = claim ? await store.claimNoticeDelivery(request.requestId, fingerprint) : undefined;
  return { store, requestId: request.requestId, claimId: delivery?.claimId ?? "missing-claim" };
}

describe("Notice delivery exact receipt reconciliation", () => {
  it.each(["claimed", "unknown"] as const)("upgrades %s with the original claim and never rearms it", async (state) => {
    const { store, requestId, claimId } = await fixture();
    if (state === "unknown") await store.completeNoticeDelivery(requestId, claimId, { state: "unknown", httpStatus: 401 });
    const before = (await store.get(requestId))!.noticeDelivery!;
    const receipt = { httpStatus: 201 as const, noticeRequestId: requestId, deliveryStatus: "sent" as const };
    const result = await store.reconcileNoticeDeliveryReceipt(requestId, claimId, fingerprint, receipt);
    expect(result.status).toBe("pending");
    expect(result.noticeDelivery).toMatchObject({ ...before, ...receipt, state: "accepted", reconciledAt: expect.any(String) });
    expect(result.noticeDelivery!.settledAt).toBe(before.settledAt ?? result.noticeDelivery!.reconciledAt);
    expect(await store.reconcileNoticeDeliveryReceipt(requestId, claimId, fingerprint, receipt)).toEqual(result);
    expect((await store.claimNoticeDelivery(requestId, fingerprint)).admitted).toBe(false);
  });

  it("rejects mismatched proof without changing the unknown delivery", async () => {
    const { store, requestId, claimId } = await fixture();
    await store.completeNoticeDelivery(requestId, claimId, { state: "unknown" });
    const before = await store.get(requestId);
    const valid = { httpStatus: 200 as const, noticeRequestId: requestId, deliveryStatus: "sent" as const };
    for (const [claim, hash, receipt] of [
      ["foreign", fingerprint, valid], [claimId, "b".repeat(64), valid],
      [claimId, fingerprint, { ...valid, noticeRequestId: "foreign" }],
      [claimId, fingerprint, { ...valid, httpStatus: 202 }],
      [claimId, fingerprint, { ...valid, deliveryStatus: "queued" }],
    ] as const) {
      await expect(store.reconcileNoticeDeliveryReceipt(requestId, claim, hash, receipt as typeof valid)).rejects.toThrow();
      expect(await store.get(requestId)).toEqual(before);
    }
    expect((await store.claimNoticeDelivery(requestId, fingerprint)).admitted).toBe(false);
  });

  it("does not manufacture a missing claim", async () => {
    const { store, requestId, claimId } = await fixture(false);
    const before = await store.get(requestId);
    await expect(store.reconcileNoticeDeliveryReceipt(requestId, claimId, fingerprint, {
      httpStatus: 200, noticeRequestId: requestId, deliveryStatus: "sent",
    })).rejects.toThrow();
    expect(await store.get(requestId)).toEqual(before);
  });

  it("keeps accepted receipt terminal and rejects a conflicting status", async () => {
    const { store, requestId, claimId } = await fixture();
    await store.completeNoticeDelivery(requestId, claimId, { state: "accepted", httpStatus: 201, noticeRequestId: requestId, deliveryStatus: "sent" });
    const before = await store.get(requestId);
    expect(await store.reconcileNoticeDeliveryReceipt(requestId, claimId, fingerprint, {
      httpStatus: 201, noticeRequestId: requestId, deliveryStatus: "sent",
    })).toEqual(before);
    await expect(store.reconcileNoticeDeliveryReceipt(requestId, claimId, fingerprint, {
      httpStatus: 200, noticeRequestId: requestId, deliveryStatus: "sent",
    })).rejects.toThrow();
    expect(await store.get(requestId)).toEqual(before);
  });
});
