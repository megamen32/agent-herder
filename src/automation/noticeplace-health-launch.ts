import { createHash, timingSafeEqual } from "node:crypto";
import { healthModelForHarness, INCIDENT_EXECUTION } from "../health-remediation.js";

export const NOTICEPLACE_HEALTH_PURPOSE = "noticeplace.health-analysis";
/** Internal capability: JSON request bodies cannot supply a symbol property. */
export const NOTICEPLACE_HEALTH_AUTHORIZED: unique symbol = Symbol("noticeplace.health-analysis.authorized");

/** Exact owner-approved NoticePlace incident route. */
export const INCIDENT_MODELS: ReadonlySet<string> = new Set([
  healthModelForHarness("opencode", INCIDENT_EXECUTION),
]);

/** A qualified route; the project policy determines eligibility. */
export function isIncidentModelRoute(model: unknown): model is string {
  return typeof model === "string" && model.length <= 256 && model === model.trim()
    && /^[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:$-]+)+$/.test(model);
}

/**
 * A bare model id of the incident execution is a model of the pinned provider.
 *
 * The center may state an exact approved model id without its provider, while
 * this gate compares fully-qualified OpenCode routes. Qualify only exact
 * bare ids from the allowlist so no other model gains access to the route.
 */
export function qualifyNoticeplaceHealthModel(model: unknown): unknown {
  if (typeof model !== "string" || model.includes("/")) return model;
  for (const route of INCIDENT_MODELS) {
    const separator = route.indexOf("/");
    if (separator > 0 && route.slice(0, separator) === "minimax-coding-plan" && route.slice(separator + 1) === model) return route;
  }
  return model;
}

/** Only the HTTP boundary uses the dedicated verifier; no global MCP token. */
export function hasNoticeplaceHealthBearer(authorization: string | undefined): boolean {
  const token = process.env.NOTICEPLACE_HEALTH_LAUNCH_TOKEN;
  if (!token?.trim() || !authorization) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(authorization), digest(`Bearer ${token}`));
}

export function validateNoticeplaceHealthLaunch(input: {
  harness?: unknown; model?: unknown; operationId?: unknown;
}): string | undefined {
  if (input.harness !== "opencode" || (input.model !== undefined && !isIncidentModelRoute(input.model))) {
    return "Для анализа инцидента нужен OpenCode и полный маршрут модели provider/model.";
  }
  if (typeof input.operationId !== "string" || !input.operationId.trim()) {
    return "Для анализа инцидента требуется стабильный operation_id.";
  }
  return undefined;
}
