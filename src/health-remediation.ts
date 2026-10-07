export interface HealthExecutionProfile {
  runtime: "zcode" | "hermes" | "fast-agent";
  provider: "account:zai-individual-coding-plan" | "openai-codex" | "minimax";
  model: "GLM-5.3-Flash" | "gpt-5.6-luna" | "MiniMax-M3.1-Flash-Preview";
  reasoning: "high" | "default";
  topic: "health";
}

const CANONICAL_PROFILES: Record<HealthExecutionProfile["runtime"], HealthExecutionProfile> = {
  "fast-agent": { runtime: "fast-agent", provider: "minimax", model: "MiniMax-M3.1-Flash-Preview", reasoning: "default", topic: "health" },
  zcode: {
    runtime: "zcode",
    provider: "account:zai-individual-coding-plan",
    model: "GLM-5.3-Flash",
    reasoning: "high",
    topic: "health",
  },
  hermes: {
    runtime: "hermes",
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    reasoning: "high",
    topic: "health",
  },
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
  if (profile.runtime !== "zcode" && profile.runtime !== "hermes" && profile.runtime !== "fast-agent") {
    throw new Error("health execution runtime must be zcode, hermes, or fast-agent");
  }
  const canonical = CANONICAL_PROFILES[profile.runtime];
  for (const [field, expected] of Object.entries(canonical)) {
    if (profile[field as keyof typeof profile] !== expected) {
      throw new Error(`health execution ${field} must be ${expected}`);
    }
  }
  return { ...canonical };
}

/** Translate the provider/model contract to the selected coding harness. */
export function healthModelForHarness(harness: string, execution: HealthExecutionProfile): string {
  if (harness === "fast-agent") return `generic.${execution.provider}/${execution.model}`;
  if (harness === "zcode") return `${execution.provider}/${execution.model}$${execution.reasoning}`;
  return harness === "opencode" ? `${execution.provider}/${execution.model}` : execution.model;
}
