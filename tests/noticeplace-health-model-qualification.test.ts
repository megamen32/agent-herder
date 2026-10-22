import { describe, expect, it } from "vitest";
import { qualifyNoticeplaceHealthModel, validateNoticeplaceHealthLaunch } from "../src/automation/noticeplace-health-launch.js";

/** The model the center states for the incident execution: the modelID alone. */
const CENTER_MODEL = "minimax-combo-m3.1";

describe("the model of an incident analysis", () => {
  it("qualifies the bare model id of the center with the pinned provider", () => {
    const qualified = qualifyNoticeplaceHealthModel(CENTER_MODEL);
    expect(qualified).toBe("omniroute/minimax-combo-m3.1");
    expect(validateNoticeplaceHealthLaunch({ harness: "opencode", model: qualified, operationId: "op-1" })).toBeUndefined();
  });

  it("keeps a route that is already qualified", () => {
    expect(qualifyNoticeplaceHealthModel("omniroute/minimax-combo-m3.1")).toBe("omniroute/minimax-combo-m3.1");
    expect(qualifyNoticeplaceHealthModel("minimax-coding-plan/MiniMax-M3.1-Flash")).toBe("minimax-coding-plan/MiniMax-M3.1-Flash");
    expect(qualifyNoticeplaceHealthModel("account:zai-individual-coding-plan/GLM-5.3-Flash$high")).toBe("account:zai-individual-coding-plan/GLM-5.3-Flash$high");
  });

  it("refuses the bare model id without the qualification", () => {
    expect(validateNoticeplaceHealthLaunch({ harness: "opencode", model: CENTER_MODEL, operationId: "op-1" })).toBeTruthy();
  });

  it("does not invent a route and does not normalize a value that is only nearly right", () => {
    expect(qualifyNoticeplaceHealthModel(undefined)).toBeUndefined();
    expect(qualifyNoticeplaceHealthModel(42)).toBe(42);
    expect(qualifyNoticeplaceHealthModel("")).toBe("");
    // A near miss stays as it is and is refused by the gate.
    expect(qualifyNoticeplaceHealthModel("minimax-combo-m3.1 ")).toBe("minimax-combo-m3.1 ");
    expect(qualifyNoticeplaceHealthModel("other/model")).toBe("other/model");
    expect(validateNoticeplaceHealthLaunch({ harness: "opencode", model: "minimax-combo-m3.1 ", operationId: "op-1" })).toBeTruthy();
  });
});
