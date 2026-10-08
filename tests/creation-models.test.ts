import { describe, it, expect } from "vitest";
import { creationModels } from "../src/web-ui/creation-models.js";
describe("native new-session model choices", () => {
  it("offers the required ZCode reasoning selection instead of its rejected alias", () => {
    const base = "account:zai-individual-coding-plan/GLM-5.3";
    expect(creationModels("zcode", [base, "minimax/MiniMax-M3", `${base}$max`])).toEqual([`${base}$max`, "minimax/MiniMax-M3"]);
  });
  it("preserves explicit variants and models without variants for every other harness", () => {
    const models = ["provider/model", "provider/model$high", "provider/other"];
    expect(creationModels("codex", models)).toEqual(models);
    expect(creationModels("zcode", models)).toEqual(["provider/model$high", "provider/other"]);
  });
});
