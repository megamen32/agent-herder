export interface HealthExecutionProfile {
  runtime: "opencode";
  provider: "openai-codex";
  model: "gpt-5.6-luna";
  reasoning: "high";
  topic: "health";
}

const CANONICAL_PROFILE: HealthExecutionProfile = {
  runtime: "opencode",
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  reasoning: "high",
  topic: "health",
};

function bounded(value: unknown, field: string, limit = 64): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > limit) {
    throw new Error(`health execution ${field} must be a bounded non-empty string`);
  }
  return value.trim();
}

/** Validate the exact execution profile selected by the health workflow. */
export function normalizeHealthExecution(value: unknown): HealthExecutionProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("health execution profile must be an object");
  }
  const raw = value as Record<string, unknown>;
  const profile = {
    runtime: bounded(raw.runtime, "runtime"),
    provider: bounded(raw.provider, "provider"),
    model: bounded(raw.model, "model"),
    reasoning: bounded(raw.reasoning, "reasoning", 16),
    topic: bounded(raw.topic, "topic"),
  };
  for (const [field, expected] of Object.entries(CANONICAL_PROFILE)) {
    if (profile[field as keyof typeof profile] !== expected) {
      throw new Error(`health execution ${field} must be ${expected}`);
    }
  }
  return { ...CANONICAL_PROFILE };
}

/** Translate the provider/model contract to the selected coding harness. */
export function healthModelForHarness(harness: string, execution: HealthExecutionProfile): string {
  return harness === "opencode" ? `${execution.provider}/${execution.model}` : execution.model;
}
