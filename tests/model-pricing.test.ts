import { describe, expect, it } from "vitest";
import { estimateSessionCost, type ModelsDevCatalog } from "../src/model-pricing.js";
import type { AgentSession } from "../src/types/index.js";

const catalog: ModelsDevCatalog = {
  openai: { models: { "gpt-test": { cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 } } } },
  minimax: { models: { "MiniMax-M3": { cost: { input: 0.3, output: 1.2, cache_read: 0.06 } } } },
};
const base = { id: "x", status: "stopped", title: "x", cwd: "/tmp", lastActivity: new Date().toISOString(), needsPermission: false } as const;

describe("models.dev pricing", () => {
  it("prices OpenAI Codex usage with cached input separately", () => {
    const session = { ...base, harness: "codex", model: "gpt-test", meta: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 100, total_tokens: 1100 } } as AgentSession;
    const result = estimateSessionCost(catalog, session)!;
    expect(result.provider).toBe("openai");
    expect(result.costUsd).toBeCloseTo((600 * 2 + 400 * 0.2 + 100 * 10) / 1_000_000, 10);
  });
  it("normalizes Fast Agent generic MiniMax model", () => {
    const session = { ...base, harness: "fast-agent", model: "generic.MiniMax-M3", meta: { input_tokens: 1000, output_tokens: 100 } } as AgentSession;
    expect(estimateSessionCost(catalog, session)?.provider).toBe("minimax");
  });
  it("does not overwrite actual adapter cost", () => {
    const session = { ...base, harness: "codex", model: "gpt-test", costUsd: 1.23, meta: { input_tokens: 1000 } } as AgentSession;
    expect(estimateSessionCost(catalog, session)).toBeNull();
  });
});
