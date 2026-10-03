import { describe, expect, it } from "vitest";
import { normalizeHealthExecution } from "../src/health-remediation.js";

describe("health remediation execution profile", () => {
  it("accepts the canonical ZCode/OmniRoute/GLM Flash profile", () => {
    expect(normalizeHealthExecution({
      runtime: "zcode",
      provider: "account:zai-individual-coding-plan",
      model: "GLM-5.3-Flash",
      reasoning: "high",
      topic: "health",
    })).toEqual({
      runtime: "zcode",
      provider: "account:zai-individual-coding-plan",
      model: "GLM-5.3-Flash",
      reasoning: "high",
      topic: "health",
    });
  });

  it("rejects a profile that silently changes runtime, provider, model, or reasoning", () => {
    expect(() => normalizeHealthExecution({
      runtime: "zcode",
      provider: "account:zai-individual-coding-plan",
      model: "gpt-4o",
      reasoning: "high",
      topic: "health",
    })).toThrow(/model/);
  });

  it("rejects Hermes as the canonical runtime", () => {
    expect(() => normalizeHealthExecution({
      runtime: "hermes",
      provider: "account:zai-individual-coding-plan",
      model: "GLM-5.3-Flash",
      reasoning: "high",
      topic: "health",
    })).toThrow(/runtime/);
  });
});
