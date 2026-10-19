import { readMiniMaxQuota } from "../model-quota.js";

export const MINIMAX_SUBSCRIPTION_MODEL = "minimax-coding-plan/MiniMax-M3.1-Flash";
export type MiniMaxQuotaAvailability = "available" | "quota_exhausted" | "unknown";
export type MiniMaxQuotaPreflight = (model: string) => Promise<MiniMaxQuotaAvailability>;

export function createMiniMaxQuotaPreflight(options: {
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  cacheMs?: number;
  now?: () => number;
}): MiniMaxQuotaPreflight {
  const token = options.token?.trim();
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = Math.min(5_000, Math.max(1, options.timeoutMs ?? 5_000));
  const cacheMs = Math.min(30_000, Math.max(1, options.cacheMs ?? 30_000));
  let cached: { at: number; result: MiniMaxQuotaAvailability } | undefined;
  let inFlight: Promise<MiniMaxQuotaAvailability> | undefined;

  return async (model) => {
    if (!token || model !== MINIMAX_SUBSCRIPTION_MODEL) return "unknown";
    if (inFlight) return inFlight;
    if (cached && now() - cached.at < cacheMs) return cached.result;
    const controller = new AbortController();
    const pending = (async (): Promise<MiniMaxQuotaAvailability> => {
      const quota = await readMiniMaxQuota({ token, fetchImpl, now, signal: controller.signal });
      // A positive snapshot is telemetry, not a token reservation. Unknown never becomes available.
      return quota.state === "reported" ? "available" : quota.state;
    })();
    let timer!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<MiniMaxQuotaAvailability>((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve("unknown"); }, timeoutMs);
    });
    const bounded = Promise.race([pending, deadline]);
    inFlight = bounded;
    // Keep the one slot until the actual fetch settles, even if an injected
    // transport ignores abort. Timeouts never accumulate additional probes.
    void pending.finally(() => { clearTimeout(timer); if (inFlight === bounded) inFlight = undefined; });
    const result = await bounded;
    cached = { at: now(), result };
    return result;
  };
}
