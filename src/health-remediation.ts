export interface HealthExecutionProfile {
  runtime: "zcode" | "hermes" | "fast-agent" | "opencode";
  provider: "account:zai-individual-coding-plan" | "openai-codex" | "minimax" | "omniroute" | "minimax-coding-plan";
  model: string;
  reasoning: "high" | "default";
  topic: "health";
}

/** The longest model route a health execution may carry. */
export const MAX_HEALTH_MODEL_LENGTH = 256;

/** The exact direct subscription route allowed for new incident analysis. */
const INCIDENT_ROUTE = "minimax-coding-plan/MiniMax-M3.1-Flash";

export function isApprovedHealthRoute(value: unknown): value is string {
  return value === INCIDENT_ROUTE;
}

const CANONICAL_PROFILES: Record<HealthExecutionProfile["runtime"], HealthExecutionProfile> = {
  opencode: { runtime: "opencode", provider: "minimax-coding-plan", model: "MiniMax-M3.1-Flash", reasoning: "default", topic: "health" },
  "fast-agent": { runtime: "fast-agent", provider: "minimax", model: "MiniMax-M3.1-Flash", reasoning: "default", topic: "health" },
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

/**
 * Validate the model route of an OpenCode health execution.
 *
 * The incident model is pinned to the direct MiniMax subscription.
 */
function incidentModelRoute(value: unknown): string {
  const model = bounded(value, "model", MAX_HEALTH_MODEL_LENGTH);
  if (/[\u0000-\u001f\u007f]/u.test(model)) {
    throw new Error("health execution model must not contain control characters");
  }
  if (model !== "MiniMax-M3.1-Flash" && !isApprovedHealthRoute(model)) {
    throw new Error("health execution model must be the direct MiniMax subscription model");
  }
  return model;
}

/**
 * Validate the execution profile selected by the health workflow.
 *
 * The provider, the reasoning and the topic stay pinned to the profile of the
 * runtime. The OpenCode model must match the direct subscription route.
 */
export function normalizeHealthExecution(value: unknown): HealthExecutionProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("health execution profile must be an object");
  }
  const raw = value as Record<string, unknown>;
  const profile = {
    runtime: bounded(raw.runtime, "runtime"),
    provider: bounded(raw.provider, "provider"),
    model: bounded(raw.model, "model", MAX_HEALTH_MODEL_LENGTH),
    reasoning: bounded(raw.reasoning, "reasoning", 16),
    topic: bounded(raw.topic, "topic"),
  };
  if (profile.runtime !== "zcode" && profile.runtime !== "hermes" && profile.runtime !== "fast-agent" && profile.runtime !== "opencode") {
    throw new Error("health execution runtime must be opencode, zcode, hermes, or fast-agent");
  }
  const canonical = CANONICAL_PROFILES[profile.runtime];
  for (const field of ["provider", "reasoning", "topic"] as const) {
    if (profile[field] !== canonical[field]) {
      throw new Error(`health execution ${field} must be ${canonical[field]}`);
    }
  }
  if (profile.runtime === "opencode") {
    return {
      runtime: "opencode",
      provider: canonical.provider,
      model: incidentModelRoute(profile.model),
      reasoning: canonical.reasoning,
      topic: canonical.topic,
    };
  }
  if (profile.model !== canonical.model) {
    throw new Error(`health execution model must be ${canonical.model}`);
  }
  return { ...canonical };
}

/** Translate the provider/model contract to the selected coding harness. */
export function healthModelForHarness(harness: string, execution: HealthExecutionProfile): string {
  if (harness === "fast-agent") return `anthropic.${execution.model}`;
  if (harness === "zcode") return `${execution.provider}/${execution.model}$${execution.reasoning}`;
  if (harness !== "opencode") return execution.model;
  // Preserve the fully qualified direct route or qualify the pinned model ID.
  return execution.model.includes("/") ? execution.model : `${execution.provider}/${execution.model}`;
}

/** Exact owner-selected direct MiniMax incident model. */
export const INCIDENT_EXECUTION: HealthExecutionProfile = {
  runtime: "opencode",
  provider: "minimax-coding-plan",
  model: "MiniMax-M3.1-Flash",
  reasoning: "default",
  topic: "health",
};
export function normalizeIncidentExecution(value: unknown): HealthExecutionProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("incident execution profile must be an object");
  }
  const raw = value as Record<string, unknown>;
  for (const field of ["runtime", "provider", "model", "reasoning", "topic"] as const) {
    const actual = bounded(raw[field], field, field === "model" ? MAX_HEALTH_MODEL_LENGTH : 64);
    if (actual !== INCIDENT_EXECUTION[field]) {
      throw new Error(`incident execution ${field} must be ${INCIDENT_EXECUTION[field]}`);
    }
  }
  return { ...INCIDENT_EXECUTION };
}
