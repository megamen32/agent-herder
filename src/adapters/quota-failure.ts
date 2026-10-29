/** A provider failure tied to one observed, terminal native turn. */
export type TerminalQuotaFailure = {
  status: "error" | "failed";
  nativeTurnId: string;
  inputId: string;
  providerId: string;
  modelId: string;
  resetAt?: string;
} & ({classification: "quota_exhausted"} | {classification: "provider_unavailable"});

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
const explicitProviderCircuitOpen = /^Provider [A-Za-z0-9][A-Za-z0-9._:-]* circuit breaker is open$/;
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
 * Classify explicit quota exhaustion or an exact open provider circuit after
 * terminal-native correlation. Generic rate limits, auth failures, transport errors and
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
  const message = nonEmpty(evidence.errorMessage);
  // The named failing provider can be a component behind the selected route.
  // Preserve the native route identity, never replace it with the message ID.
  if (message && explicitProviderCircuitOpen.test(message)) {
    if (statusCode !== undefined && statusCode !== 503) return undefined;
    if (/^(?:HTTP[_ -]?)?(?:401|403|502)$/i.test(nonEmpty(evidence.errorCode) ?? "")
      || unsafeFailure.test(`${evidence.errorCode ?? ""} ${evidence.errorType ?? ""} ${evidence.modelErrorType ?? ""}`)) return undefined;
    return {classification:"provider_unavailable",status:evidence.status,nativeTurnId,inputId,providerId,modelId};
  }
  if (statusCode === 401 || statusCode === 403 || statusCode === 502) return undefined;
  if (/^(?:HTTP[_ -]?)?(?:401|403|502)$/i.test(nonEmpty(evidence.errorCode) ?? "")) return undefined;
  if (statusCode !== undefined && (!Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 500)) return undefined;

  const errorCode = nonEmpty(evidence.errorCode);
  const errorType = nonEmpty(evidence.errorType);
  const modelErrorType = nonEmpty(evidence.modelErrorType);
  // Native ZCode wraps this exact ZAI provider payload in UNKNOWN_ERROR.
  // The wrapper is not the provider classification; retain all auth/transport
  // exclusions and require both native model lineage and the provider code.
  const glmQuotaWrapper = /^(?:account:)?(?:zai-individual-coding-plan|zai-coding-plan|zai|z-ai)$/i.test(providerId)
    && /^GLM-/i.test(modelId) && modelErrorType === "rate_limited"
    && /^\[1310\]\[?Weekly\/Monthly Limit Exhausted\b/i.test(message ?? "");
  const checkedCode = glmQuotaWrapper && /^UNKNOWN_ERROR$/i.test(errorCode ?? "") ? "" : errorCode ?? "";
  const checkedType = glmQuotaWrapper && /^unknown_error$/i.test(errorType ?? "") ? "" : errorType ?? "";
  if (unsafeFailure.test(`${checkedCode} ${checkedType} ${message ?? ""}`)) return undefined;

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

/** Normalize transport receipts before the recovery queue can consider fallback.
 * No HTTP status or nonRetryable text establishes that a native write did not occur. */
export function normalizeSendAdmission<T extends {
  ok: boolean; admission?: "not_submitted" | "accepted" | "pending" | "unknown";
  notSubmitted?: boolean; admitted?: boolean; pending?: boolean; admissionUnknown?: boolean;
  turnId?: string; nativeInputMessageId?: string; error?: string;
  quotaFailure?: { classification: "quota_exhausted"; resetAt?: string };
}>(result: T): T & { admission: "not_submitted" | "accepted" | "pending" | "unknown"; quotaFailure?: { classification: "quota_exhausted"; resetAt?: string } } {
  const accepted = result.admitted === true || Boolean(result.turnId || result.nativeInputMessageId) || result.admission === "accepted";
  const pending = result.pending === true || result.admission === "pending";
  const uncertain = result.admissionUnknown === true || result.admission === "unknown";
  const admission = accepted ? (pending ? "pending" : "accepted") : pending ? "pending" : uncertain ? "unknown"
    : result.notSubmitted === true || result.admission === "not_submitted" ? "not_submitted"
    : result.ok ? "accepted" : "unknown";
  const next = { ...result, admission } as T & { admission: typeof admission; quotaFailure?: { classification: "quota_exhausted"; resetAt?: string } };
  // A caller-supplied inputId alone is not a native admission receipt.
  if (admission !== "not_submitted") {
    if (result.notSubmitted) next.notSubmitted = false;
    delete next.quotaFailure;
  } else {
    next.notSubmitted = true;
    const error = result.error ?? "";
    if (!unsafeFailure.test(error) && !/\bHTTP[_ : -]*(?:401|403|502)\b/i.test(error)
      && (result.quotaFailure?.classification === "quota_exhausted" || explicitQuotaMessage.test(error))) {
      next.quotaFailure = result.quotaFailure ?? { classification: "quota_exhausted" };
    } else delete next.quotaFailure;
  }
  return next;
}
