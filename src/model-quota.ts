import { readFile } from "node:fs/promises";
import { readCodexUsage } from "./web/quota-lens.js";

export type ModelQuotaState = "reported" | "quota_exhausted" | "unknown";
export type ProviderQuota = {
  provider: "glm" | "minimax" | "codex";
  state: ModelQuotaState;
  checkedAt: string;
  details?: unknown;
  error?: string;
};

type QuotaDeps = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  codexQuota?: () => Promise<Record<string, unknown>>;
  now?: () => number;
};

// Exact telemetry keys only: never echo arbitrary provider payloads or credentials.
const detailKeys = new Set([
  "limits", "model_remains", "type", "unit", "number", "model", "model_name", "name", "plan", "plan_type",
  "remaining", "remaining_quota", "quota_remaining", "percentage", "usage", "currentValue", "nextResetTime",
  "usage_limit", "current_usage_count", "remains_time", "start_time", "end_time",
  "weekly_start_time", "weekly_end_time", "weekly_remains_time",
  "current_interval_status", "current_interval_remaining_percent", "current_interval_total_count", "current_interval_usage_count",
  "current_weekly_status", "current_weekly_remaining_percent", "current_weekly_total_count", "current_weekly_usage_count",
  "primary_used", "primary_reset_s", "primary_window_seconds", "primary_reset_at", "primary_window",
  "secondary_used", "secondary_reset_s", "secondary_window_seconds", "secondary_reset_at", "secondary_window",
  "used_percent", "limit_window_seconds", "reset_after_seconds", "reset_at", "allowed", "limit_reached",
  "quota_exhausted", "is_exhausted", "code", "status", "status_code",
]);
const safeDetails = (value: unknown, depth = 0): unknown => {
  if (depth > 4) return undefined;
  if (Array.isArray(value)) return value.slice(0, 24).map((item) => safeDetails(item, depth + 1)).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!detailKeys.has(key)) continue;
    if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) out[key] = item;
    else if (typeof item === "string" && /^(?:model|type|unit|status|plan|period|name|code)/u.test(key)) out[key] = item.slice(0, 120);
    else {
      const nested = safeDetails(item, depth + 1);
      if (nested !== undefined) out[key] = nested;
    }
  }
  return out;
};

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const percent = (value: unknown): value is number => finite(value) && value >= 0 && value <= 100;
const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value)
  ? value.filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row)) : [];

function textQuotaState(provider: "glm" | "minimax", data: Record<string, unknown>): ModelQuotaState {
  if (provider === "minimax") {
    const rows = records(data.model_remains).filter((row) => row.model_name === "general"
      || row.model === "MiniMax-M3.1-Flash" || row.model_name === "MiniMax-M3.1-Flash");
    if (!rows.length) return "unknown";
    const states = rows.map((row): ModelQuotaState => {
      const interval = row.current_interval_remaining_percent;
      const weekly = row.current_weekly_remaining_percent;
      // Numeric status enums and 0/0 count placeholders do not establish allowance.
      if (interval === 0 || weekly === 0) return "quota_exhausted";
      if (percent(interval) && percent(weekly)) return "reported";
      return "unknown";
    });
    return states.includes("quota_exhausted") ? "quota_exhausted" : states.every((state) => state === "reported") ? "reported" : "unknown";
  }
  const rows = records(data.limits).filter((row) => row.type === "CREDIT_LIMIT" || row.type === "TOKENS_LIMIT");
  if (!rows.length) return "unknown";
  if (rows.some((row) => [row.remaining, row.remaining_quota, row.quota_remaining].some((value) => finite(value) && value <= 0)
    || (finite(row.percentage) && row.percentage >= 100))) return "quota_exhausted";
  return rows.every((row) => [row.remaining, row.remaining_quota, row.quota_remaining].some((value) => finite(value) && value > 0) || percent(row.percentage)) ? "reported" : "unknown";
}

async function providerRequest(provider: "glm" | "minimax", endpoint: string, token: string | undefined, fetchImpl: typeof fetch, now: () => number, credentialError?: string, signal?: AbortSignal): Promise<ProviderQuota> {
  const checkedAt = new Date(now()).toISOString();
  if (!token?.trim()) return { provider, state: "unknown", checkedAt, error: credentialError ?? "credential_not_configured" };
  try {
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers: {
        Authorization: provider === "glm" ? token.trim() : `Bearer ${token.trim()}`,
        Accept: "application/json",
        ...(provider === "glm" ? { "Accept-Language": "en-US,en", "Content-Type": "application/json" } : {}),
      },
      signal: signal ?? AbortSignal.timeout(5_000),
    });
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = await response.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid payload");
      body = parsed as Record<string, unknown>;
    } catch { return { provider, state: "unknown", checkedAt, error: `invalid_json_http_${response.status}` }; }
    const base = (body.base_resp && typeof body.base_resp === "object" ? body.base_resp : {}) as Record<string, unknown>;
    const nested = (body.data && typeof body.data === "object" ? body.data : body) as Record<string, unknown>;
    const code = String((body.error as Record<string, unknown> | undefined)?.code ?? base.status_code ?? nested.code ?? body.code ?? "");
    if (provider === "minimax" && response.status !== 401 && response.status !== 403 && ["2056", "4292056"].includes(code)) return { provider, state: "quota_exhausted", checkedAt, details: safeDetails(nested) };
    const successCodes = provider === "glm" ? ["0", "200"] : ["0"];
    if (!response.ok || (code && !successCodes.includes(code))) return { provider, state: "unknown", checkedAt, details: safeDetails(nested), error: `provider_http_${response.status}${/^\d{1,8}$/u.test(code) ? `_code_${code}` : ""}` };
    const details = safeDetails(nested);
    const state = textQuotaState(provider, nested);
    return { provider, state, checkedAt, details, ...(state === "unknown" ? { error: "quota_fields_missing" } : {}) };
  } catch (error) {
    const name = (error as { name?: string })?.name;
    return { provider, state: "unknown", checkedAt, error: name === "TimeoutError" ? "provider_timeout" : "provider_unavailable" };
  }
}

async function readGlmCredential(env: NodeJS.ProcessEnv): Promise<{ token?: string; error?: string }> {
  const directToken = [env.ANTHROPIC_AUTH_TOKEN, env.ZAI_API_KEY, env.GLM_API_KEY].find((value) => value?.trim());
  if (directToken) return { token: directToken };
  const tokenFile = env.AGENT_HERDER_GLM_TOKEN_FILE?.trim();
  if (!tokenFile) return { error: "credential_not_configured" };
  try {
    const token = (await readFile(tokenFile, "utf8")).trim();
    return token ? { token } : { error: "credential_file_unavailable" };
  } catch {
    return { error: "credential_file_unavailable" };
  }
}

export async function readModelQuotas(deps: QuotaDeps = {}): Promise<{ checkedAt: string; providers: ProviderQuota[] }> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const codexQuota = deps.codexQuota ?? readCodexUsage;
  const checkedAt = new Date(now()).toISOString();
  const glmCredential = await readGlmCredential(env);
  const [glm, minimax, codex] = await Promise.all([
    providerRequest("glm", "https://api.z.ai/api/monitor/usage/quota/limit", glmCredential.token, fetchImpl, now, glmCredential.error),
    readMiniMaxQuota({ token: env.MINIMAX_API_KEY, fetchImpl, now }),
    codexQuota().then((details): ProviderQuota => {
      const used = [details.primary_used, details.secondary_used].filter(finite);
      const exhausted = details.limit_reached === true || used.some((value) => value >= 100);
      const state = details.error ? "unknown" : exhausted ? "quota_exhausted"
        : details.allowed === false || !used.length || !used.every(percent) ? "unknown" : "reported";
      return { provider: "codex", state, checkedAt: new Date(now()).toISOString(), details: safeDetails(details), ...(state === "unknown" ? { error: "codex_quota_fields_missing" } : {}) };
    }).catch((): ProviderQuota => ({ provider: "codex", state: "unknown", checkedAt: new Date(now()).toISOString(), error: "codex_usage_unavailable" })),
  ]);
  return { checkedAt, providers: [glm, minimax, codex] };
}

/** Read-only subscription telemetry; never reserves tokens or invokes a model. */
export function readMiniMaxQuota(options: { token?: string; fetchImpl?: typeof fetch; now?: () => number; signal?: AbortSignal }): Promise<ProviderQuota> {
  return providerRequest("minimax", "https://www.minimax.io/v1/token_plan/remains", options.token,
    options.fetchImpl ?? fetch, options.now ?? Date.now, undefined, options.signal);
}
