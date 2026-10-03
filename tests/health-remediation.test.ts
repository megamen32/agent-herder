import { describe, expect, it } from "vitest";
import { normalizeHealthExecution } from "../src/health-remediation.js";

describe("health remediation execution profile", () => {
  it("accepts the canonical ZCode/OmniRoute/GLM Flash profile", () => {
    expect(normalizeHealthExecution({
      runtime: "zcode",
      provider: "omniroute",
      model: "zc/glm-5.3-flash",
      reasoning: "high",
      topic: "health",
    })).toEqual({
      runtime: "zcode",
      provider: "omniroute",
      model: "zc/glm-5.3-flash",
      reasoning: "high",
      topic: "health",
    });
  });

  it("rejects a profile that silently changes runtime, provider, model, or reasoning", () => {
    expect(() => normalizeHealthExecution({
      runtime: "zcode",
      provider: "omniroute",
      model: "gpt-4o",
      reasoning: "high",
      topic: "health",
    })).toThrow(/model/);
  });

  it("rejects Hermes as the canonical runtime", () => {
    expect(() => normalizeHealthExecution({
      runtime: "hermes",
      provider: "omniroute",
      model: "zc/glm-5.3-flash",
      reasoning: "high",
      topic: "health",
    })).toThrow(/runtime/);
  });
});
