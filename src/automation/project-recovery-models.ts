import type { AutomationLaunchPolicy } from "../automation-launch-policy.js";
import { findGoverningProjectRoute } from "../automation-launch-policy.js";
import { routeModelViolation } from "../project-model-gate.js";
import { isRecoveryModelReference } from "../recovery-model-reference.js";

/**
 * Resolve the ordered quota recovery models for one exact project directory.
 * A route-specific list replaces the global list, including an explicit [];
 * an absent route value inherits the global list.
 */
export function resolveProjectRecoveryModels(
  policy: AutomationLaunchPolicy,
  harness: "opencode" | "zcode",
  cwd: string,
): string[] {
  if (policy.allowedHarnesses.length > 0 && !policy.allowedHarnesses.includes(harness)) return [];
  if (typeof cwd !== "string" || cwd.length === 0) return [];

  const route = findGoverningProjectRoute(policy, cwd);
  if (route && !route.harnesses.includes(harness)) return [];

  const candidates = route?.fallbackModels?.[harness] ?? policy.fallbackModels?.[harness] ?? [];
  return candidates.filter((model) => isRecoveryModelReference(model, harness)
    && (!route || routeModelViolation(route, model) === undefined));
}

/** Gate any recovery model, including the original model used while waiting for quota. */
export function projectRecoveryModelAllowed(
  policy: AutomationLaunchPolicy,
  harness: "opencode" | "zcode",
  cwd: string,
  model: string,
): boolean {
  if (policy.allowedHarnesses.length > 0 && !policy.allowedHarnesses.includes(harness)) return false;
  if (typeof cwd !== "string" || cwd.length === 0 || !isRecoveryModelReference(model, harness)) return false;
  const route = findGoverningProjectRoute(policy, cwd);
  if (!route) return true;
  return route.harnesses.includes(harness) && routeModelViolation(route, model) === undefined;
}
