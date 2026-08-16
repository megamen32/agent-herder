import { isAbsolute, normalize } from "node:path";
import type { AutopilotHarness } from "./session-store.js";

export const AUTOPILOT_POLICY_SCHEMA_VERSION = 1 as const;
export const AUTOPILOT_INGRESS_ID = "codex-stop-hook-v1" as const;
export const DEFAULT_AUTOPILOT_DELAY_MS = 30 * 60 * 1_000;
export const AUTOPILOT_HARNESSES: readonly AutopilotHarness[] = ["codex", "opencode", "claude", "hermes"];

const DEFAULT_MAX_CONTINUATIONS = 3;
const MAX_CONTINUATIONS = 100;
const MAX_TEXT_LENGTH = 512;

export type CodexSelector = {
  harness: "codex";
  sessionId: string;
  conversationId: string;
  cwd: string;
  ingressId: typeof AUTOPILOT_INGRESS_ID;
};

export type AutopilotPolicy = {
  schemaVersion: typeof AUTOPILOT_POLICY_SCHEMA_VERSION;
  enabled: boolean;
  harnesses: AutopilotHarness[];
  scope: { mode: "all_ingress" } | { mode: "allowlist"; selectors: CodexSelector[] };
  maxContinuationsPerSession: number;
  timeout: { mode: "hold" | "auto_continue"; delayMs: number };
  card: { includeUserMessage: boolean; includeAssistantMessage: boolean; includeReason: boolean };
};

export type PersistedAutopilotPolicy = {
  schemaVersion: typeof AUTOPILOT_POLICY_SCHEMA_VERSION;
  revision: string;
  policy: AutopilotPolicy;
  updatedAt: string;
};

export type LegacyArming = {
  allIngress: boolean;
  sessionIds: string[];
};

export type EffectivePolicy = {
  policy: AutopilotPolicy;
  source: "persisted" | "legacy" | "default" | "error";
  revision: string;
  coverage: "enabled-harnesses" | "codex-ingress" | "codex-selected-sessions" | "none";
  legacyArming?: LegacyArming;
  legacyConflict?: string;
  error?: string;
};

/** Return the explicit, safe policy used before an operator enables autopilot. */
export function createDefaultAutopilotPolicy(): AutopilotPolicy {
  return {
    schemaVersion: AUTOPILOT_POLICY_SCHEMA_VERSION,
    enabled: false,
    harnesses: [...AUTOPILOT_HARNESSES],
    scope: { mode: "all_ingress" },
    maxContinuationsPerSession: DEFAULT_MAX_CONTINUATIONS,
    timeout: { mode: "auto_continue", delayMs: DEFAULT_AUTOPILOT_DELAY_MS },
    card: { includeUserMessage: true, includeAssistantMessage: true, includeReason: true },
  };
}

/** Strictly validate and canonicalize an immutable Codex session selector. */
export function normalizeCodexSelector(value: unknown): CodexSelector {
  const object = objectValue(value, "selector");
  exactKeys(object, ["harness", "sessionId", "conversationId", "cwd", "ingressId"], "selector");
  if (object.harness !== "codex" || object.ingressId !== AUTOPILOT_INGRESS_ID) {
    throw new Error("Codex selectors must use the installed Codex Stop ingress");
  }
  const sessionId = text(object.sessionId, "selector.sessionId");
  const conversationId = text(object.conversationId, "selector.conversationId");
  if (conversationId !== sessionId) throw new Error("selector.conversationId must equal selector.sessionId for schema v1");
  const cwd = text(object.cwd, "selector.cwd");
  if (!isAbsolute(cwd)) throw new Error("selector.cwd must be an absolute path");
  return { harness: "codex", sessionId, conversationId, cwd: canonicalCwd(cwd), ingressId: AUTOPILOT_INGRESS_ID };
}

/** Create a canonical v1 selector from the only current identity delivered by a Codex Stop hook. */
export function createCodexSelectorFromStopSession(input: { sessionId: string; cwd: string }): CodexSelector {
  return normalizeCodexSelector({
    harness: "codex",
    sessionId: input.sessionId,
    conversationId: input.sessionId,
    cwd: input.cwd,
    ingressId: AUTOPILOT_INGRESS_ID,
  });
}

/** Strictly validate policy JSON and normalize allowlist ordering for stable revisions. */
export function normalizeAutopilotPolicy(value: unknown): AutopilotPolicy {
  const object = objectValue(value, "policy");
  exactKeys(object, ["schemaVersion", "enabled", "harnesses", "scope", "maxContinuationsPerSession", "timeout", "card"], "policy");
  if (object.schemaVersion !== AUTOPILOT_POLICY_SCHEMA_VERSION) throw new Error("unknown policy schemaVersion");
  if (typeof object.enabled !== "boolean") throw new Error("policy.enabled must be boolean");
  const maxContinuations = object.maxContinuationsPerSession;
  if (typeof maxContinuations !== "number" || !Number.isInteger(maxContinuations) || maxContinuations < 0 || maxContinuations > MAX_CONTINUATIONS) {
    throw new Error("policy.maxContinuationsPerSession must be an integer from 0 to 100");
  }
  return {
    schemaVersion: AUTOPILOT_POLICY_SCHEMA_VERSION,
    enabled: object.enabled,
    // Policies written before the multi-harness UI were Codex-only. Preserve
    // that meaning instead of silently widening an existing installation.
    harnesses: object.harnesses === undefined ? ["codex"] : normalizeHarnesses(object.harnesses),
    scope: normalizeScope(object.scope),
    maxContinuationsPerSession: maxContinuations,
    timeout: normalizeTimeout(object.timeout),
    card: normalizeCard(object.card),
  };
}

/** Apply the persisted-policy, legacy-environment, then default precedence rule. */
export function resolveEffectivePolicy(input: {
  state?: PersistedAutopilotPolicy | null;
  stateError?: string;
  env?: NodeJS.ProcessEnv;
  legacySessionIds?: Iterable<string>;
}): EffectivePolicy {
  const fallback = createDefaultAutopilotPolicy();
  if (input.stateError) {
    return { policy: fallback, source: "error", revision: "invalid", coverage: "none", error: input.stateError };
  }
  const legacy = legacyArming(input.env ?? process.env, input.legacySessionIds);
  if (input.state) {
    return {
      policy: input.state.policy,
      source: "persisted",
      revision: input.state.revision,
      coverage: coverageFor(input.state.policy),
      ...(legacy ? { legacyConflict: "Legacy environment arming is ignored while a persisted policy exists" } : {}),
    };
  }
  if (legacy) {
    const policy: AutopilotPolicy = {
      ...fallback,
      enabled: true,
      harnesses: ["codex"],
      scope: legacy.allIngress ? { mode: "all_ingress" } : { mode: "allowlist", selectors: legacy.sessionIds.map((sessionId) => ({ harness: "codex", sessionId, conversationId: sessionId, cwd: "/", ingressId: AUTOPILOT_INGRESS_ID })) },
    };
    return {
      policy,
      source: "legacy",
      revision: "legacy",
      coverage: legacy.allIngress ? "codex-ingress" : "codex-selected-sessions",
      legacyArming: legacy,
    };
  }
  return { policy: fallback, source: "default", revision: "default", coverage: "none" };
}

/** Return a stable equality key for canonical selectors. */
export function codexSelectorKey(selector: CodexSelector): string {
  const canonical = normalizeCodexSelector(selector);
  return JSON.stringify([canonical.harness, canonical.sessionId, canonical.conversationId, canonical.cwd, canonical.ingressId]);
}

/** Check whether a persisted policy allows a canonical selector. */
export function policyAllowsSelector(policy: AutopilotPolicy, selector: CodexSelector): boolean {
  if (!policy.enabled || !policy.harnesses.includes("codex")) return false;
  if (policy.scope.mode === "all_ingress") return true;
  const key = codexSelectorKey(selector);
  return policy.scope.selectors.some((candidate) => codexSelectorKey(candidate) === key);
}

/** Authorize any supported lifecycle target; the legacy selector scope remains Codex-specific. */
export function effectivePolicyAllowsTarget(
  effective: EffectivePolicy,
  target: { harness: AutopilotHarness; sessionId: string; cwd: string },
): boolean {
  if (target.harness === "codex") {
    return effectivePolicyAllowsSelector(
      effective,
      createCodexSelectorFromStopSession({ sessionId: target.sessionId, cwd: target.cwd }),
    );
  }
  return effective.source !== "legacy"
    && effective.policy.enabled
    && effective.policy.harnesses.includes(target.harness);
}

/** Authorize a selector against the effective contract, including legacy bare-ID compatibility. */
export function effectivePolicyAllowsSelector(effective: EffectivePolicy, selector: CodexSelector): boolean {
  if (effective.source !== "legacy") return policyAllowsSelector(effective.policy, selector);
  const legacy = effective.legacyArming;
  if (!legacy) return false;
  const canonical = normalizeCodexSelector(selector);
  return legacy.allIngress || legacy.sessionIds.includes(canonical.sessionId);
}

/** Derive the honest ingress coverage label shown by later API/UI layers. */
export function coverageFor(policy: AutopilotPolicy): EffectivePolicy["coverage"] {
  if (!policy.enabled || policy.harnesses.length === 0) return "none";
  if (policy.harnesses.some((harness) => harness !== "codex")) return "enabled-harnesses";
  return policy.scope.mode === "all_ingress" ? "codex-ingress" : "codex-selected-sessions";
}

/** Parse the old explicit hook environment without letting it override saved state. */
function legacyArming(env: NodeJS.ProcessEnv, suppliedSessionIds?: Iterable<string>): LegacyArming | null {
  const allIngress = env.AGENT_HERDER_AUTOPILOT_ALL_SESSIONS === "1";
  const inlineSessionIds = normalizeLegacySessionIds((env.AGENT_HERDER_AUTOPILOT_SESSION_ID ?? "").split(","));
  const sessionIds = inlineSessionIds.length > 0
    ? inlineSessionIds
    : normalizeLegacySessionIds(suppliedSessionIds ?? []);
  return allIngress || sessionIds.length > 0 ? { allIngress, sessionIds } : null;
}

/** Normalize bounded legacy bare IDs without treating them as persisted canonical selectors. */
function normalizeLegacySessionIds(values: Iterable<string>): string[] {
  const sessionIds = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const sessionId = value.trim();
    if (sessionId && sessionId.length <= MAX_TEXT_LENGTH) sessionIds.add(sessionId);
  }
  return [...sessionIds].sort();
}

/** Validate the scope union and canonicalize a deduplicated allowlist. */
function normalizeScope(value: unknown): AutopilotPolicy["scope"] {
  const object = objectValue(value, "policy.scope");
  if (object.mode === "all_ingress") {
    exactKeys(object, ["mode"], "policy.scope");
    return { mode: "all_ingress" };
  }
  exactKeys(object, ["mode", "selectors"], "policy.scope");
  if (object.mode !== "allowlist" || !Array.isArray(object.selectors)) throw new Error("policy.scope must be all_ingress or allowlist");
  const selectors = object.selectors.map(normalizeCodexSelector);
  const deduplicated = new Map(selectors.map((selector) => [codexSelectorKey(selector), selector]));
  return { mode: "allowlist", selectors: [...deduplicated.values()].sort((left, right) => codexSelectorKey(left).localeCompare(codexSelectorKey(right))) };
}

/** Validate and deduplicate the harness switches while retaining display order. */
function normalizeHarnesses(value: unknown): AutopilotHarness[] {
  if (!Array.isArray(value)) throw new Error("policy.harnesses must be an array");
  const selected = new Set<AutopilotHarness>();
  for (const harness of value) {
    if (!(AUTOPILOT_HARNESSES as readonly unknown[]).includes(harness)) {
      throw new Error("policy.harnesses contains an unsupported harness");
    }
    selected.add(harness as AutopilotHarness);
  }
  return AUTOPILOT_HARNESSES.filter((harness) => selected.has(harness));
}

/** Validate the timeout choice and bounded delay. */
function normalizeTimeout(value: unknown): AutopilotPolicy["timeout"] {
  const object = objectValue(value, "policy.timeout");
  exactKeys(object, ["mode", "delayMs"], "policy.timeout");
  if (object.mode !== "hold" && object.mode !== "auto_continue") throw new Error("policy.timeout.mode is invalid");
  const delayMs = object.delayMs;
  if (typeof delayMs !== "number" || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 7 * 24 * 60 * 60 * 1_000) throw new Error("policy.timeout.delayMs is invalid");
  return { mode: object.mode, delayMs };
}

/** Validate the three explicit notification-context switches. */
function normalizeCard(value: unknown): AutopilotPolicy["card"] {
  const object = objectValue(value, "policy.card");
  exactKeys(object, ["includeUserMessage", "includeAssistantMessage", "includeReason"], "policy.card");
  if (typeof object.includeUserMessage !== "boolean" || typeof object.includeAssistantMessage !== "boolean" || typeof object.includeReason !== "boolean") throw new Error("policy.card fields must be boolean");
  return { includeUserMessage: object.includeUserMessage, includeAssistantMessage: object.includeAssistantMessage, includeReason: object.includeReason };
}

/** Require a non-array record before extracting typed fields. */
function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

/** Reject unknown fields so future schemas cannot accidentally become active. */
function exactKeys(object: Record<string, unknown>, keys: string[], label: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(object)) if (!allowed.has(key)) throw new Error(`unknown ${label} field '${key}'`);
}

/** Require bounded non-empty text and trim external whitespace. */
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_TEXT_LENGTH) throw new Error(`${label} must be non-empty text`);
  return value.trim();
}

/** Normalize an absolute project path without retaining a non-root trailing separator. */
function canonicalCwd(cwd: string): string {
  const normalized = normalize(cwd);
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}
