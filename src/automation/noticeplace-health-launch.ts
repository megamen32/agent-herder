import { createHash, timingSafeEqual } from "node:crypto";
import { isApprovedHealthRoute } from "../health-remediation.js";

export const NOTICEPLACE_HEALTH_PURPOSE = "noticeplace.health-analysis";
/** Internal capability: JSON request bodies cannot supply a symbol property. */
export const NOTICEPLACE_HEALTH_AUTHORIZED: unique symbol = Symbol("noticeplace.health-analysis.authorized");

/**
 * The health routes that are known to work for the analysis of an incident.
 *
 * The list is a hint, not the gate: the owner picks the incident model by
 * hand, so every other route of the OmniRoute gateway is accepted as well.
 * The MiniMax subscription route is accepted as a fallback; every other
 * provider stays refused.
 */
export const INCIDENT_MODELS: ReadonlySet<string> = new Set([
  "omniroute/minimax-combo-m3.1",
  "omniroute/glm-5.3-flash-minimax-m3.1",
  "minimax-coding-plan/MiniMax-M3.1-Flash",
]);

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
  if (input.harness !== "opencode" || !isApprovedHealthRoute(input.model)) {
    return `Для анализа инцидента разрешены только OpenCode и маршрут OmniRoute без подмены провайдера (маршрут MiniMax по подписке — как запасной). Известные маршруты: ${[...INCIDENT_MODELS].join(", ")}.`;
  }
  if (typeof input.operationId !== "string" || !input.operationId.trim()) {
    return "Для анализа инцидента требуется стабильный operation_id.";
  }
  return undefined;
}
