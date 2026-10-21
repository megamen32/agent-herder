import { createHash, timingSafeEqual } from "node:crypto";

export const NOTICEPLACE_HEALTH_PURPOSE = "noticeplace.health-analysis";
/** Internal capability: JSON request bodies cannot supply a symbol property. */
export const NOTICEPLACE_HEALTH_AUTHORIZED: unique symbol = Symbol("noticeplace.health-analysis.authorized");

const INCIDENT_MODELS: ReadonlySet<string> = new Set([
  "omniroute/minimax-combo-m3.1",
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
  if (input.harness !== "opencode" || typeof input.model !== "string" || !INCIDENT_MODELS.has(input.model)) {
    return "Для анализа инцидента разрешены только OpenCode и утверждённая модель MiniMax без подмены провайдера.";
  }
  if (typeof input.operationId !== "string" || !input.operationId.trim()) {
    return "Для анализа инцидента требуется стабильный operation_id.";
  }
  return undefined;
}
