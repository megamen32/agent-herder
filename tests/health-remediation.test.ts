import { describe, expect, it } from "vitest";
import { normalizeHealthExecution } from "../src/health-remediation.js";

describe("health remediation execution profile", () => {
  it("accepts the canonical OpenCode/OpenAI-Codex/Luna high profile", () => {
    expect(normalizeHealthExecution({
      runtime: "opencode",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      reasoning: "high",
      topic: "health",
    })).toEqual({
      runtime: "opencode",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      reasoning: "high",
      topic: "health",
    });
  });

  it("rejects a profile that silently changes runtime, provider, model, or reasoning", () => {
    expect(() => normalizeHealthExecution({
      runtime: "opencode",
      provider: "openai-codex",
      model: "gpt-4o",
      reasoning: "high",
      topic: "health",
    })).toThrow(/model/);
  });

  it("rejects Hermes as the canonical runtime", () => {
    expect(() => normalizeHealthExecution({
      runtime: "hermes",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      reasoning: "high",
      topic: "health",
    })).toThrow(/runtime/);
  });
});
