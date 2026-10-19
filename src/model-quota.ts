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

const safeDetails = (value: unknown, depth = 0): unknown => {
  if (depth > 4) return undefined;
  if (Array.isArray(value)) return value.slice(0, 24).map((item) => safeDetails(item, depth + 1)).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/token|secret|authorization|api.?key|password/iu.test(key)) continue;
    if (!/(quota|limit|remain|usage|reset|window|plan|period|model|code|status|unit|type|percent|current|total|time|name|primary|secondary|exhausted)/iu.test(key)) continue;
    if (typeof item === "number" || typeof item === "boolean") out[key] = item;
    else if (typeof item === "string" && /^(?:model|type|unit|status|plan|period|name|code|primary|secondary)/iu.test(key)) out[key] = item.slice(0, 120);
    else {
      const nested = safeDetails(item, depth + 1);
      if (nested !== undefined) out[key] = nested;
    }
  }
  return out;
};

function explicitlyExhausted(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(explicitlyExhausted);
  if (!value || typeof value !== "object") return false;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:limit_reached|quota_exhausted|is_exhausted)$/iu.test(key) && item === true) return true;
    if (/^(?:remaining|remains|remaining_quota|quota_remaining)$/iu.test(key) && typeof item === "number" && item <= 0) return true;
    if (/^(?:used_percent|usage_percent|percentage)$/iu.test(key) && typeof item === "number" && item >= 100) return true;
    if (explicitlyExhausted(item)) return true;
  }
  return false;
}

function hasQuotaMeasurement(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasQuotaMeasurement);
  if (!value || typeof value !== "object") return false;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const measure = /(?:quota|limit|usage|percent|current|used|primary|secondary)/iu.test(key)
      || (/(?:remaining|remain)/iu.test(key) && !/time|second|minute/iu.test(key));
    if (measure && typeof item === "number") return true;
    if (hasQuotaMeasurement(item)) return true;
  }
  return false;
}

async function providerRequest(provider: "glm" | "minimax", endpoint: string, token: string | undefined, fetchImpl: typeof fetch, now: () => number, credentialError?: string): Promise<ProviderQuota> {
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
      signal: AbortSignal.timeout(5_000),
    });
    let body: Record<string, unknown> = {};
    try { body = await response.json() as Record<string, unknown>; } catch { return { provider, state: "unknown", checkedAt, error: `invalid_json_http_${response.status}` }; }
    const base = (body.base_resp && typeof body.base_resp === "object" ? body.base_resp : {}) as Record<string, unknown>;
    const nested = (body.data && typeof body.data === "object" ? body.data : body) as Record<string, unknown>;
    const code = String((body.error as Record<string, unknown> | undefined)?.code ?? base.status_code ?? nested.code ?? body.code ?? "");
    if (provider === "minimax" && ["2056", "4292056"].includes(code)) return { provider, state: "quota_exhausted", checkedAt, details: safeDetails(nested) };
    const successCodes = provider === "glm" ? ["0", "200"] : ["0"];
    if (!response.ok || (code && !successCodes.includes(code))) return { provider, state: "unknown", checkedAt, details: safeDetails(nested), error: `provider_http_${response.status}${code ? `_code_${code}` : ""}` };
    const details = safeDetails(nested);
    const hasQuotaData = hasQuotaMeasurement(nested) && typeof details === "object" && details !== null;
    return { provider, state: hasQuotaData ? (explicitlyExhausted(nested) ? "quota_exhausted" : "reported") : "unknown", checkedAt, ...(hasQuotaData ? { details } : {}), ...(!hasQuotaData ? { error: "quota_fields_missing" } : {}) };
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
    providerRequest("minimax", "https://www.minimax.io/v1/token_plan/remains", env.MINIMAX_API_KEY, fetchImpl, now),
    codexQuota().then((details): ProviderQuota => {
      const used = typeof details.primary_used === "number" ? details.primary_used : undefined;
      const exhausted = details.limit_reached === true || (used !== undefined && used >= 100);
      const state = exhausted ? "quota_exhausted" : details.error || (used === undefined && details.limit_reached !== false) ? "unknown" : "reported";
      return { provider: "codex", state, checkedAt: new Date(now()).toISOString(), details: safeDetails(details), ...(state === "unknown" ? { error: "codex_quota_fields_missing" } : {}) };
    }).catch((): ProviderQuota => ({ provider: "codex", state: "unknown", checkedAt: new Date(now()).toISOString(), error: "codex_usage_unavailable" })),
  ]);
  return { checkedAt, providers: [glm, minimax, codex] };
}
