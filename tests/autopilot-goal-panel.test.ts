import { describe, expect, it } from "vitest";
import { goalEvaluationIsCurrent } from "../src/web-ui/autopilot-goal-panel.js";

describe("goal panel evaluation freshness", () => {
  it("accepts matching and legacy epochs but rejects an evaluation from before resume", () => {
    const goal = { controlEpoch: 8 };
    expect(goalEvaluationIsCurrent(goal, { controlEpoch: 8 })).toBe(true);
    expect(goalEvaluationIsCurrent(goal, {})).toBe(true);
    expect(goalEvaluationIsCurrent(goal, { controlEpoch: 7 })).toBe(false);
    expect(goalEvaluationIsCurrent(goal, undefined)).toBe(false);
  });
});
