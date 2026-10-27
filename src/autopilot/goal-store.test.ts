import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GoalStore, type GoalIdentity } from "./goal-store.js";

const roots: string[] = [];
async function store(): Promise<{ root: string; value: GoalStore }> {
  const root = await mkdtemp(join(tmpdir(), "herder-goal-store-")); roots.push(root); return { root, value: new GoalStore(root) };
}
const identity: GoalIdentity = { harness: "codex", sessionId: "test-session", cwd: "/isolated/project" };

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("GoalStore", () => {
  it("persists the full primary event once and fences an old completion ticket", async () => {
    const { root, value: first } = await store();
    await first.arm({ identity, goal: { eventId: "human-1", text: "Full original instruction", refs: [{ uri: "file:///brief.md" }] }, requirements: [{ id: "r1", text: "Deliver result", sourceEventIds: ["human-1"] }] });
    const preAudit = await first.snapshot(identity);
    const auditEvidence = [{ id: "e1", requirementId: "r1", version: "sha256:a", provenance: "readback:local", observedAt: new Date().toISOString(), materialLoaded: true }];
    const check = await first.checkCompletion(identity, preAudit, auditEvidence);
    expect(check.ok).toBe(true);
    if (!check.ok) return;

    const restarted = new GoalStore(root);
    const accepted = await restarted.acceptHumanEvent(identity, { eventId: "human-2", text: "Please include this correction" });
    expect(accepted.snapshot.primaryEvents.at(-1)?.text).toBe("Please include this correction");
    expect((await restarted.acceptHumanEvent(identity, { eventId: "human-2", text: "Please include this correction" })).duplicate).toBe(true);
    await expect(restarted.acceptHumanEvent(identity, { eventId: "human-2", text: "Different content under reused id" })).rejects.toThrow("different primary content");
    expect(await restarted.applyCompletion(identity, check.ticket)).toBe(false);
    expect((await restarted.snapshot(identity)).inputCursor).toBe(2);
  });

  it("requires projected input and loaded evidence, and stop survives restart", async () => {
    const { root, value: first } = await store();
    await first.arm({ identity, goal: { eventId: "human-1", text: "Do the task" }, requirements: [{ id: "r1", text: "Verify it", sourceEventIds: ["human-1"] }] });
    const staleExtraction = await first.snapshot(identity);
    await first.acceptHumanEvent(identity, { eventId: "human-2", text: "Add a required verification" });
    expect(await first.applyRequirements(identity, staleExtraction, 1, [{ id: "r1", text: "stale extraction", sourceEventIds: ["human-1"] }])).toBeNull();
    expect((await first.checkCompletion(identity, staleExtraction)).ok).toBe(false);
    const current = await first.snapshot(identity);
    await first.applyRequirements(identity, current, 2, [
      { id: "r1", text: "Verify it", sourceEventIds: ["human-1"] },
      { id: "r2", text: "Required verification", sourceEventIds: ["human-2"] },
    ]);
    await first.recordEvidence(identity, [{ id: "e1", requirementId: "r1", version: "v1", provenance: "proof", observedAt: new Date().toISOString(), materialLoaded: true }]);
    expect((await first.checkCompletion(identity, await first.snapshot(identity))).ok).toBe(false);
    await first.stop(identity);
    const restarted = new GoalStore(root);
    await expect(restarted.snapshot(identity)).resolves.toMatchObject({ stopped: true, armed: false, completed: false });
    const resumed = await restarted.resume(identity);
    expect(resumed).toMatchObject({ stopped: false, armed: true, primaryEvents: [{ text: "Do the task" }, { text: "Add a required verification" }] });
  });

  it("does not attach a delayed completion audit to a late human input", async () => {
    const { value: goals } = await store();
    await goals.arm({ identity, goal: { eventId: "human-1", text: "Original goal" }, requirements: [{ id: "r1", text: "Complete original goal", sourceEventIds: ["human-1"] }] });
    const auditStart = await goals.snapshot(identity);
    await goals.acceptHumanEvent(identity, { eventId: "human-2", text: "Also do this" });
    const staleAudit = await goals.checkCompletion(identity, auditStart, [{ id: "e1", requirementId: "r1", version: "v1", provenance: "delayed-audit", observedAt: new Date().toISOString(), materialLoaded: true }]);
    expect(staleAudit).toMatchObject({ ok: false, reasons: ["goal changed while completion audit was running"] });
    expect((await goals.snapshot(identity)).evidence).toEqual([]);
  });

  it("starts an explicit new goal with the stopped goal archived", async () => {
    const { value: goals } = await store();
    await goals.arm({ identity, goal: { eventId: "old", text: "Old assignment" }, requirements: [{ id: "old-r", text: "Old requirement", sourceEventIds: ["old"] }] });
    await goals.stop(identity);
    const next = await goals.newGoal({ identity, goal: { eventId: "new", text: "New assignment" }, requirements: [{ id: "new-r", text: "New requirement", sourceEventIds: ["new"] }] });
    expect(next.primaryEvents).toEqual([{ eventId: "new", text: "New assignment", refs: [], receivedAt: expect.any(String) }]);
    expect(next.goalHistory).toHaveLength(1);
    expect(next.goalHistory[0]?.primaryEvents[0]?.text).toBe("Old assignment");
  });

  it("persists requirement memo and UI status only against the exact evaluation fence", async () => {
    const { value: goals } = await store();
    await goals.arm({ identity, goal: { eventId: "human-1", text: "Implement a result" }, requirements: [{ id: "r1", text: "Complete it", sourceEventIds: ["human-1"] }] });
    const expected = await goals.snapshot(identity);
    const metadata = {
      requirementMemo: { goalRevision: "1", primaryHash: "sha256:primary", requirements: [{ id: "r1", text: "Complete it", sourceEventIds: ["human-1"] }], supersessions: [] },
      requirementsStatus: [{ id: "r1", status: "open" as const, evidenceIds: [] }], lastDecision: "continue" as const,
      lastReason: "Evidence is still missing", usage: { inputTokens: 25, outputTokens: 8 },
    };
    const saved = await goals.recordEvaluation(identity, expected, metadata);
    expect(saved?.evaluation).toMatchObject({ lastDecision: "continue", requirementsStatus: [{ id: "r1", status: "open" }], usage: { inputTokens: 25 } });
    const stale = await goals.snapshot(identity);
    await goals.acceptHumanEvent(identity, { eventId: "human-2", text: "Add a new acceptance point" });
    expect(await goals.recordEvaluation(identity, stale, metadata)).toBeNull();
  });

  it("keeps persisted supersessions append-only and refuses credential-shaped metadata", async () => {
    const { value: goals } = await store();
    await goals.arm({ identity, goal: { eventId: "human-1", text: "Implement a result" }, requirements: [{ id: "r1", text: "Complete it", sourceEventIds: ["human-1"] }] });
    await goals.acceptHumanEvent(identity, { eventId: "human-2", text: "Replace the requirement with a new one" });
    const expected = await goals.snapshot(identity);
    const prior = { requirementId: "r1", amendmentEventId: "human-2", reason: "Human explicitly replaced it", previous: { id: "r1", text: "Old requirement", sourceEventIds: ["human-1"] }, replacementRequirementId: "r2" };
    const metadata = {
      requirementMemo: { goalRevision: "2", primaryHash: "hash", requirements: [{ id: "r2", text: "New requirement", sourceEventIds: ["human-2"] }], supersessions: [prior] },
      requirementsStatus: [{ id: "r2", status: "open" as const, evidenceIds: [] }], lastDecision: "continue" as const,
    };
    await goals.recordEvaluation(identity, expected, metadata);
    const current = await goals.snapshot(identity);
    await expect(goals.recordEvaluation(identity, current, { ...metadata, requirementMemo: { ...metadata.requirementMemo, supersessions: [] } })).rejects.toThrow("append-only");
    await expect(goals.recordEvaluation(identity, current, { ...metadata, lastReason: "api_key=super-secret-value" })).rejects.toThrow("credential-shaped");
  });

  it("serializes native continuation admission before a concurrent human amendment", async () => {
    const { value: goals } = await store();
    await goals.arm({ identity, goal: { eventId: "human-1", text: "Original goal" }, requirements: [{ id: "r1", text: "Finish original goal", sourceEventIds: ["human-1"] }] });
    const expected = await goals.snapshot(identity);
    let markAdmitting!: () => void;
    let releaseAdmission!: () => void;
    const admissionStarted = new Promise<void>((resolve) => { markAdmitting = resolve; });
    const admissionGate = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    const order: string[] = [];
    const admission = goals.withContinuationAdmission(identity, expected, async () => {
      markAdmitting();
      await admissionGate;
      order.push("native-admission");
      return "accepted-receipt";
    });
    await admissionStarted;
    let humanAccepted = false;
    const human = goals.acceptHumanEvent(identity, { eventId: "human-2", text: "Late amendment" }).then((result) => {
      humanAccepted = true;
      order.push("human-accepted");
      return result;
    });
    await Promise.resolve();
    expect(humanAccepted).toBe(false);
    releaseAdmission();
    await expect(admission).resolves.toEqual({ admitted: true, result: "accepted-receipt" });
    await human;
    expect(order).toEqual(["native-admission", "human-accepted"]);
  });

  it("records only accepted or unknown continuation fingerprints under the admission fence", async () => {
    const { value: goals } = await store();
    await goals.arm({ identity, goal: { eventId: "human-1", text: "Continue until complete" }, requirements: [{ id: "r1", text: "Complete the goal", sourceEventIds: ["human-1"] }] });
    const expected = await goals.snapshot(identity);
    const submission = {
      actionFingerprint: "sha256:action-v1", evidenceFingerprint: "sha256:evidence-v1",
      classify: (result: { status: string }) => result.status === "accepted" ? "accepted" as const : result.status === "unknown" ? "unknown" as const : "not-admitted" as const,
    };
    await goals.withContinuationAdmission(identity, expected, async () => ({ status: "accepted" }), submission);
    const accepted = await goals.snapshot(identity);
    expect(accepted.evaluation?.lastAdmission).toMatchObject({ actionFingerprint: "sha256:action-v1", evidenceFingerprint: "sha256:evidence-v1", inputCursor: expected.inputCursor, goalRevision: expected.goalRevision, evidenceVersion: expected.evidenceVersion, outcome: "accepted" });

    await goals.withContinuationAdmission(identity, accepted, async () => ({ status: "failed" }), { ...submission, actionFingerprint: "sha256:rejected" });
    expect((await goals.snapshot(identity)).evaluation?.lastAdmission?.actionFingerprint).toBe("sha256:action-v1");

    const unknownExpected = await goals.snapshot(identity);
    await goals.withContinuationAdmission(identity, unknownExpected, async () => ({ status: "unknown" }), { ...submission, actionFingerprint: "sha256:unknown" });
    expect((await goals.snapshot(identity)).evaluation?.lastAdmission).toMatchObject({ actionFingerprint: "sha256:unknown", outcome: "unknown" });
  });

  it("stores a verified native cursor without bumping goal versions and fences stale cursor updates", async () => {
    const { value: goals } = await store();
    await goals.arm({ identity, goal: { eventId: "human-1", text: "Use the current transcript" }, requirements: [{ id: "r1", text: "Finish from current context", sourceEventIds: ["human-1"] }], nativeCursor: "native-100" });
    const initial = await goals.snapshot(identity);
    expect(initial.nativeCursor).toBe("native-100");
    expect(await goals.recordNativeCursor(identity, initial, "native-101")).toBe(true);
    const advanced = await goals.snapshot(identity);
    expect(advanced.nativeCursor).toBe("native-101");
    expect(advanced).toMatchObject({ goalRevision: initial.goalRevision, evidenceVersion: initial.evidenceVersion, inputCursor: initial.inputCursor });
    expect(await goals.recordNativeCursor(identity, initial, "native-102")).toBe(false);
    expect((await goals.snapshot(identity)).nativeCursor).toBe("native-101");
  });
});
