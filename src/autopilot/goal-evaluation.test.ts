import { describe, expect, it } from "vitest";
import { evaluateGoal, type GoalEvaluationInput, type GoalModel } from "./goal-evaluation.js";

const input: GoalEvaluationInput = {
  goalRevision: "r1", fullObjective: "Build and verify X", inputCursor: "c1", evidenceVersion: "e1", controlEpoch: "s1",
  userEvents: [{ id: "u1", cursor: "c1", kind: "objective", text: "Build and verify X" }],
  requirements: [{ id: "req1", text: "Build X", sourceEventIds: ["u1"], status: "open", evidenceIds: [] }], evidence: [],
  materials: [{ id: "u1", text: "Build and verify X", complete: true, version: "v1" }],
};

describe("evaluateGoal", () => {
  it("requires separate complete coverage audit before returning done candidate", async () => {
    const stages: string[] = [];
    const model: GoalModel = { async call({ stage }) {
      stages.push(stage);
      if (stage === "requirements") return { requirements: input.requirements, supersessions: [] };
      if (stage === "evidence-reconciliation") return { assessments: [{ requirementId: "req1", fulfilled: true, evidenceIds: ["proof1"], reason: "verified" }] };
      if (stage === "next-action") return { kind: "complete", summary: "looks done" };
      return { complete: true, coverage: [{ requirementId: "req1", covered: true, evidenceIds: ["proof1"] }], supersessionChecks: [], summary: "covered" };
    } };
    const result = await evaluateGoal({ ...input, evidence: [{ id: "proof1", requirementId: "req1", text: "verified", observedVersion: "v1", source: "test", loaded: true }] }, model);
    expect(stages).toEqual(["requirements", "evidence-reconciliation", "next-action", "coverage-audit"]);
    expect(result.decision.kind).toBe("done-candidate");
  });

  it("continues evaluation with incomplete materials but never returns done", async () => {
    const stages: string[] = [];
    let auditMaterials: unknown;
    const result = await evaluateGoal({ ...input, evidence: [{ id: "proof1", requirementId: "req1", text: "proof", observedVersion: "v1", source: "test", loaded: true }], materials: [{ ...input.materials[0]!, complete: false }] }, { async call({ stage, payload }) {
      stages.push(stage);
      if (stage === "requirements") return { requirements: input.requirements, supersessions: [] };
      if (stage === "evidence-reconciliation") return { assessments: [{ requirementId: "req1", fulfilled: true, evidenceIds: ["proof1"], reason: "proof" }] };
      if (stage === "next-action") return { kind: "complete", summary: "done" };
      auditMaterials = (payload as { materials: unknown }).materials;
      return { complete: true, coverage: [{ requirementId: "req1", covered: true, evidenceIds: ["proof1"] }], supersessionChecks: [], summary: "looks done" };
    } });
    expect(stages).toEqual(["requirements", "evidence-reconciliation", "next-action", "coverage-audit"]);
    expect(auditMaterials).toEqual([{ ...input.materials[0]!, complete: false }]);
    expect(result.decision.kind).toBe("blocked");
  });

  it("rejects model-created fulfillment", async () => {
    const result = await evaluateGoal(input, { async call({ stage }) {
      if (stage === "requirements") return { requirements: [{ ...input.requirements[0], status: "fulfilled", evidenceIds: ["made-up"] }], supersessions: [] };
      return { kind: "complete", summary: "done" };
    } });
    expect(result.decision.kind).toBe("blocked");
  });

  it("demotes stale evidence and refuses completion with remaining open requirements", async () => {
    const result = await evaluateGoal({ ...input, now: 100, evidence: [{ id: "old", requirementId: "req1", text: "proof", observedVersion: "v1", source: "test", validUntil: 99 }] }, { async call({ stage }) {
      if (stage === "requirements") return { requirements: input.requirements, supersessions: [] };
      if (stage === "evidence-reconciliation") return { assessments: [{ requirementId: "req1", fulfilled: false, evidenceIds: [], reason: "stale" }] };
      if (stage === "next-action") return { kind: "complete", summary: "done" };
      return { complete: true, coverage: [{ requirementId: "req1", covered: true, evidenceIds: ["old"] }], supersessionChecks: [], summary: "claimed coverage" };
    } });
    expect(result.requirements[0]?.status).toBe("open");
    expect(result.decision.kind).toBe("blocked");
  });

  it("reuses exact primary requirement memo without another extraction call", async () => {
    let extracted = false;
    const primaryHash = (await import("node:crypto")).createHash("sha256").update(JSON.stringify({ fullObjective: input.fullObjective, userEvents: input.userEvents })).digest("hex");
    const result = await evaluateGoal({ ...input, requirementMemo: { goalRevision: "r1", primaryHash, requirements: [{ id: "req1", text: "Build X", sourceEventIds: ["u1"] }], supersessions: [] } }, { async call({ stage }) {
      if (stage === "requirements") extracted = true;
      if (stage === "evidence-reconciliation") return { assessments: [{ requirementId: "req1", fulfilled: false, evidenceIds: [], reason: "none" }] };
      return { kind: "continue", nextAction: "continue work" };
    } });
    expect(extracted).toBe(false);
    expect(result.decision.kind).toBe("continue");
  });

  it("retains old requirement details through explicit event-linked supersession", async () => {
    const amended: GoalEvaluationInput = { ...input, userEvents: [...input.userEvents, { id: "u2", cursor: "c2", kind: "amendment", text: "Replace the old result" }], inputCursor: "c2", requirements: [{ id: "old", text: "Old result", sourceEventIds: ["u1"], status: "open", evidenceIds: [] }] };
    const result = await evaluateGoal(amended, { async call({ stage }) {
      if (stage === "requirements") return { requirements: [{ id: "new", text: "New result", sourceEventIds: ["u2"], status: "open", evidenceIds: [] }], supersessions: [{ requirementId: "old", amendmentEventId: "u2", replacementRequirementId: "new", reason: "User changed requested output" }] };
      if (stage === "evidence-reconciliation") return { assessments: [{ requirementId: "new", fulfilled: false, evidenceIds: [], reason: "not yet" }] };
      return { kind: "continue", nextAction: "Build new result" };
    } });
    expect(result.supersessions[0]?.previous.text).toBe("Old result");
    expect(result.decision.kind).toBe("continue");
  });
});
