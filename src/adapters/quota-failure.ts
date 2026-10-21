/** A quota failure tied to one observed, terminal native turn. */
export interface TerminalQuotaFailure {
  classification: "quota_exhausted";
  status: "error" | "failed";
  nativeTurnId: string;
  inputId: string;
  providerId: string;
  modelId: string;
  resetAt?: string;
}

export interface TerminalQuotaFailureEvidence {
  terminal: boolean;
  status?: string;
  nativeTurnId?: string;
  inputId?: string;
  providerId?: string;
  modelId?: string;
  statusCode?: number;
  errorCode?: string;
  errorType?: string;
  modelErrorType?: string;
  errorMessage?: string;
  resetAt?: unknown;
}

const explicitQuotaCode = /^(?:insufficient[_-]quota|quota[_-](?:exhausted|exceeded)|usage[_-]limit[_-](?:exceeded|exhausted))$/i;
const explicitQuotaMessage = /(?:\b(?:quota|usage)\s+(?:limit\s+)?(?:has\s+been\s+)?(?:exhausted|exceeded)\b|\b(?:daily|weekly|monthly)(?:\s*\/\s*(?:daily|weekly|monthly))*\s+limit\s+(?:has\s+been\s+)?(?:exhausted|exceeded)\b|\binsufficient[_ -]quota\b|\bquota[_ -](?:exhausted|exceeded)\b)/i;
const unsafeFailure = /(?:unauthori[sz]ed|forbidden|authentication|bad[ _-]?gateway|network|timed?\s*out|connection\s+(?:reset|refused|failed)|admission[ _-]+(?:unknown|uncertain)|unknown[ _-]+(?:error|failure))/i;

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeQuotaResetAt(value: unknown): string | undefined {
  const text = nonEmpty(value);
  // Provider prose often prints a wall-clock time without a timezone. Do not
  // reinterpret that value using the Herder host's local timezone.
  if (!text || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) return undefined;
  const milliseconds = Date.parse(text);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

/**
 * Classify only explicit provider quota exhaustion after exact terminal-native
 * correlation. Generic rate limits, auth failures, transport errors and
 * incomplete identities intentionally produce no recovery candidate.
 */
export function terminalQuotaFailure(evidence: TerminalQuotaFailureEvidence): TerminalQuotaFailure | undefined {
  if (evidence.terminal !== true || (evidence.status !== "error" && evidence.status !== "failed")) return undefined;
  const nativeTurnId = nonEmpty(evidence.nativeTurnId);
  const inputId = nonEmpty(evidence.inputId);
  const providerId = nonEmpty(evidence.providerId);
  const modelId = nonEmpty(evidence.modelId);
  if (!nativeTurnId || !inputId || !providerId || !modelId) return undefined;

  const statusCode = evidence.statusCode;
  if (statusCode === 401 || statusCode === 403 || statusCode === 502) return undefined;
  if (/^(?:HTTP[_ -]?)?(?:401|403|502)$/i.test(nonEmpty(evidence.errorCode) ?? "")) return undefined;
  if (statusCode !== undefined && (!Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 500)) return undefined;

  const errorCode = nonEmpty(evidence.errorCode);
  const errorType = nonEmpty(evidence.errorType);
  const modelErrorType = nonEmpty(evidence.modelErrorType);
  const message = nonEmpty(evidence.errorMessage);
  if (unsafeFailure.test(`${errorCode ?? ""} ${errorType ?? ""} ${message ?? ""}`)) return undefined;

  const explicitCode = [errorCode, modelErrorType].some((value) => value && explicitQuotaCode.test(value));
  const explicitMessage = Boolean(message && explicitQuotaMessage.test(message));
  if (!explicitCode && !explicitMessage) return undefined;
  // HTTP 429 alone is ambiguous (usually generic rate limiting). Accept it
  // only when the provider also supplies a specific quota code or message.

  const resetAt = normalizeQuotaResetAt(evidence.resetAt);
  return {
    classification: "quota_exhausted",
    status: evidence.status,
    nativeTurnId,
    inputId,
    providerId,
    modelId,
    ...(resetAt ? { resetAt } : {}),
  };
}

/** Split a native provider/model ref once; model IDs may themselves contain '/'. */
export function splitProviderModel(value: unknown): { providerId: string; modelId: string } | undefined {
  const text = nonEmpty(value);
  if (!text) return undefined;
  const separator = text.indexOf("/");
  if (separator <= 0 || separator === text.length - 1) return undefined;
  const providerId = text.slice(0, separator).trim();
  const modelId = text.slice(separator + 1).trim();
  return providerId && modelId ? { providerId, modelId } : undefined;
}

/** Keep provider error details bounded and redact common credential forms. */
export function safeNativeErrorField(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim()
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/gi, "[redacted-key]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1[redacted]")
    .slice(0, limit);
}
