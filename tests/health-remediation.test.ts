import { describe, expect, it } from "vitest";
import { normalizeHealthExecution, healthModelForHarness } from "../src/health-remediation.js";

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

  it("accepts the canonical Hermes profile", () => {
    expect(normalizeHealthExecution({
      runtime: "hermes",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      reasoning: "high",
      topic: "health",
    })).toEqual({
      runtime: "hermes",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      reasoning: "high",
      topic: "health",
    });
  });
  it("pins independent Fast Agent remediation to MiniMax", () => {
    const execution = normalizeHealthExecution({ runtime: "fast-agent", provider: "minimax", model: "MiniMax-M3.1-Flash-Preview", reasoning: "default", topic: "health" });
    expect(healthModelForHarness("fast-agent", execution)).toBe("anthropic.MiniMax-M3.1-Flash-Preview");
    expect(() => normalizeHealthExecution({ ...execution, provider: "openai-codex" })).toThrow(/provider/);
  });

});
