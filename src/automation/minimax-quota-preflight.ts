export const MINIMAX_SUBSCRIPTION_MODEL = "minimax-coding-plan/MiniMax-M3.1-Flash-Preview";
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
    // The same direct endpoint and protected MINIMAX_API_KEY already used by
    // Herder's MiniMax client. This is a one-token probe, never a business turn.
    // https://platform.minimax.io/docs/guides/text-generation
    const pending = (async (): Promise<MiniMaxQuotaAvailability> => {
      try {
        const response = await fetchImpl("https://api.minimax.io/anthropic/v1/messages", {
          method: "POST", signal: controller.signal,
          headers: { "x-api-key": token, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model: "MiniMax-M3.1-Flash-Preview", max_tokens: 1, output_config: { effort: "low" }, messages: [{ role: "user", content: "Reply OK." }] }),
        });
        const reader = response.body?.getReader();
        if (!reader) return "unknown";
        let raw = "";
        let bytes = 0;
        const decoder = new TextDecoder();
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 16_384) { controller.abort(); return "unknown"; }
            raw += decoder.decode(part.value, { stream: true });
          }
          raw += decoder.decode();
        } finally { reader.releaseLock(); }
        const body = JSON.parse(raw) as { error?: { code?: number | string; message?: string }; base_resp?: { status_code?: number | string } };
        const code = String(body.error?.code ?? body.base_resp?.status_code ?? "");
        const quotaCode = code === "4292056" || (response.status === 429 && (code === "2056"
          || /\b4292056\b|\(2056\)/u.test(body.error?.message ?? "")));
        if (!response.ok && quotaCode) return "quota_exhausted";
        if (response.ok && !body.error && (!body.base_resp || body.base_resp.status_code === 0)) return "available";
        return "unknown";
      } catch { return "unknown"; }
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
