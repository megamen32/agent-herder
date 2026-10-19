import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readModelQuotas } from "../src/model-quota.js";

const observedGeneral = {
  model_name: "general", current_interval_status: 2, current_weekly_status: 1,
  current_interval_remaining_percent: 0, current_weekly_remaining_percent: 69,
  current_interval_total_count: 0, current_interval_usage_count: 0,
  current_weekly_total_count: 0, current_weekly_usage_count: 0,
  start_time: 1792422000000, end_time: 1792440000000, remains_time: 671257,
  weekly_start_time: 1792368000000, weekly_end_time: 1792972800000, weekly_remains_time: 533471257,
};

async function miniMax(body: unknown) {
  return (await readModelQuotas({ env: { MINIMAX_API_KEY: "fixture" },
    fetchImpl: async () => Response.json(body), codexQuota: async () => ({}), now: () => 1792430000000,
  })).providers[1];
}

it.each(["fixture-private-code", "", "123456789", "12\n", "-1", "1e2"])("redacts non-numeric or oversized string code %j at every telemetry depth", async (code) => {
  const result = await miniMax({ code, model_remains: [{ ...observedGeneral, code }] });
  const details = result.details as { code?: unknown; model_remains: Array<{ code?: unknown }> };
  expect(details).not.toHaveProperty("code");
  expect(details.model_remains[0]).not.toHaveProperty("code");
});

it.each(["0", "12345678", 2056])("preserves safe provider code %j", async (code) => {
  const result = await miniMax({ code, model_remains: [{ ...observedGeneral, code }] });
  expect(result.details).toMatchObject({ code, model_remains: [{ code }] });
});

it("classifies observed general interval zero / weekly69 as exhausted and preserves millisecond reset fields", async () => {
  expect(await miniMax({ base_resp: { status_code: 0 }, model_remains: [observedGeneral] }))
    .toMatchObject({ state: "quota_exhausted", details: { model_remains: [observedGeneral] } });
});

it("preserves GLM period counts and ignores exhausted tool-only limits for text", async () => {
  const limits = [{ type: "CREDIT_LIMIT", unit: 3, number: 5, remaining: 28000, percentage: 0 },
    { type: "CREDIT_LIMIT", unit: 6, number: 1, remaining: 1, nextResetTime: 1792778782999 },
    { type: "TIME_LIMIT", remaining: 0 }];
  const result = await readModelQuotas({ env: { ZAI_API_KEY: "fixture" }, fetchImpl: async () => Response.json({ code: 200, data: { limits } }), codexQuota: async () => ({}) });
  expect(result.providers[0]).toMatchObject({ state: "reported", details: { limits } });
});

it("treats saturated Codex secondary as exhausted despite a positive primary", async () => {
  const result = await readModelQuotas({ env: {}, codexQuota: async () => ({ primary_used: 34, secondary_used: 100, limit_reached: false }) });
  expect(result.providers[2].state).toBe("quota_exhausted");
});

it.each([
  [1792441000000, "reported", 1792441000000],
  [1792441000, "unknown", 1792441000], // seconds must never be guessed as milliseconds
  [1792440000000, "unknown", 1792440000000], // exact deadline
  [null, "reported", undefined],
  [undefined, "reported", undefined],
])("honors MiniMax millisecond deadline %j without coercing null or seconds", async (end_time, state, validUntilMs) => {
  const result = await readModelQuotas({ env: { MINIMAX_API_KEY: "fixture" }, now: () => 1792440000000,
    fetchImpl: async () => Response.json({ model_remains: [{ ...observedGeneral, current_interval_remaining_percent: 50,
      end_time, weekly_end_time: null }, { model_name: "video", end_time: 0 }] }), codexQuota: async () => ({}),
  });
  expect(result.providers[1].state).toBe(state);
  expect(result.providers[1].validUntilMs).toBe(validUntilMs);
  if (end_time !== undefined) expect((result.providers[1].details as { model_remains: Array<{ end_time: unknown }> }).model_remains[0].end_time).toBe(end_time);
  if (state === "unknown") expect(result.providers[1].error).toBe("quota_snapshot_expired");
});

describe("live provider quota reads", () => {
  it("reads GLM, MiniMax and Codex independently and strips credential-shaped fields", async () => {
    const authorization = new Map<string, string | null>();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      authorization.set(url, new Headers(init?.headers).get("authorization"));
      if (url.includes("api.z.ai")) return Response.json({ code: 200, data: { limits: [{ type: "TOKENS_LIMIT", percentage: 72, remaining: 28, nextResetTime: 1792440000000, api_key: "must-not-escape" }] } });
      return Response.json({ model_remains: [{ model: "MiniMax-M3.1-Flash", remains_time: 41, current_interval_remaining_percent: 41, current_weekly_remaining_percent: 69, usage_limit: 100, current_usage_count: 59 }] });
    });
    const result = await readModelQuotas({
      env: { ZAI_API_KEY: "glm-test-secret", MINIMAX_API_KEY: "minimax-test-secret" },
      fetchImpl,
      now: () => 1792430000000,
      codexQuota: async () => ({ plan: "plus", primary_used: 63, primary_reset_s: 1800, secondary_used: 21 }),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(authorization.get("https://api.z.ai/api/monitor/usage/quota/limit")).toBe("glm-test-secret");
    expect(authorization.get("https://www.minimax.io/v1/token_plan/remains")).toBe("Bearer minimax-test-secret");
    expect(result.providers).toMatchObject([
      { provider: "glm", state: "reported", details: { limits: [{ type: "TOKENS_LIMIT", percentage: 72, remaining: 28 }] } },
      { provider: "minimax", state: "reported", details: { model_remains: [{ model: "MiniMax-M3.1-Flash", remains_time: 41, current_interval_remaining_percent: 41, current_weekly_remaining_percent: 69, usage_limit: 100, current_usage_count: 59 }] } },
      { provider: "codex", state: "reported", details: { plan: "plus", primary_used: 63, secondary_used: 21 } },
    ]);
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
    expect(JSON.stringify(result)).not.toContain("test-secret");
  });

  it("reports missing provider credentials and confirmed MiniMax exhaustion without fabricating GLM/Codex values", async () => {
    const result = await readModelQuotas({
      env: { MINIMAX_API_KEY: "minimax-test-secret" },
      fetchImpl: async () => Response.json({ base_resp: { status_code: 2056 }, model_remains: [] }, { status: 429 }),
      now: () => 1792430000000,
      codexQuota: async () => ({ error: "no local auth" }),
    });
    expect(result.providers).toMatchObject([
      { provider: "glm", state: "unknown", error: "credential_not_configured" },
      { provider: "minimax", state: "quota_exhausted" },
      { provider: "codex", state: "unknown", error: "codex_quota_fields_missing" },
    ]);
  });

  it("marks explicit zero remaining quota as exhausted", async () => {
    const result = await readModelQuotas({
      env: { ZAI_API_KEY: "glm-test-secret" },
      fetchImpl: async () => Response.json({ code: 200, data: { limits: [{ type: "TOKENS_LIMIT", percentage: 100, remaining: 0 }] } }),
      now: () => 1792430000000,
      codexQuota: async () => ({ error: "not configured" }),
    });
    expect(result.providers[0]).toMatchObject({ provider: "glm", state: "quota_exhausted" });
  });

  it("reads the GLM credential from the configured protected token file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-herder-glm-quota-"));
    const tokenFile = join(dir, "zai-token");
    await writeFile(tokenFile, "glm-file-test-secret\n", { mode: 0o600 });
    const authorization = new Map<string, string | null>();
    try {
      const result = await readModelQuotas({
        env: { AGENT_HERDER_GLM_TOKEN_FILE: tokenFile },
        fetchImpl: async (input, init) => {
          authorization.set(String(input), new Headers(init?.headers).get("authorization"));
          if (String(input).includes("api.z.ai")) return Response.json({ code: 200, data: { limits: [{ type: "TOKENS_LIMIT", remaining: 12 }] } });
          return Response.json({ base_resp: { status_code: 0 }, model_remains: [{ current_interval_remaining_percent: 50 }] });
        },
        now: () => 1792430000000,
        codexQuota: async () => ({ primary_used: 10 }),
      });
      expect(authorization.get("https://api.z.ai/api/monitor/usage/quota/limit")).toBe("glm-file-test-secret");
      expect(result.providers[0]).toMatchObject({ provider: "glm", state: "reported", details: { limits: [{ type: "TOKENS_LIMIT", remaining: 12 }] } });
      expect(JSON.stringify(result)).not.toContain("glm-file-test-secret");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

 it.each([
  ["weekly zero", [{ ...observedGeneral, current_interval_remaining_percent: 50, current_weekly_remaining_percent: 0 }], "quota_exhausted"],
  ["video zero", [{ ...observedGeneral, current_interval_remaining_percent: 99 }, { model_name: "video", current_interval_remaining_percent: 0, current_weekly_remaining_percent: 0 }], "reported"],
  ["video only", [{ model_name: "video", current_interval_remaining_percent: 99 }], "unknown"],
  ["count placeholders", [{ model_name: "general", current_interval_total_count: 0, current_interval_usage_count: 0 }], "unknown"],
  ["unknown enum only", [{ model_name: "general", current_interval_status: 999, current_weekly_status: 1 }], "unknown"],
  ["unknown pool", [{ ...observedGeneral, model_name: "future" }], "unknown"],
  ["one window missing", [{ model_name: "general", current_interval_remaining_percent: 99 }], "unknown"],
  ["invalid percentages", [{ model_name: "general", current_interval_remaining_percent: 101, current_weekly_remaining_percent: 50 }], "unknown"],
  ["reset clock only", [{ model_name: "general", end_time: 1792440000000, remains_time: 0 }], "unknown"],
 ])("MiniMax %s", async (_name, rows, expected) => {
   expect((await miniMax({ model_remains: rows })).state).toBe(expected);
 });

 it.each([401, 403, 429, 500])("keeps provider HTTP%s unknown and redacts arbitrary payload", async (status) => {
  const result = await readModelQuotas({ env: { MINIMAX_API_KEY: "fixture" }, fetchImpl: async () => Response.json({
    model_remains: [observedGeneral], error: { code: "bad-credential-secret" }, api_key: "hidden", usage_secret: 123, authorization: "hidden",
  }, { status }), codexQuota: async () => ({ error: "hidden", primary_used: 5 }) });
  expect(result.providers[1].state).toBe("unknown");
  expect(result.providers[2].state).toBe("unknown");
  expect(JSON.stringify(result)).not.toMatch(/hidden|bad-credential-secret|usage_secret/);
 });

 it.each([null, [], "bad", { model_remains: [] }, { code: 123, model_remains: [observedGeneral] }])("keeps malformed or provider failure unknown: %j", async (payload) => {
   expect((await miniMax(payload)).state).toBe("unknown");
 });

 it("does not infer availability from counts/time/flags, and preserves Codex period units and null windows", async () => {
  for (const fields of [{}, { limit_reached: false }, { allowed: true }, { primary_used: 10, allowed: false }]) {
   const result = await readModelQuotas({ env: {}, codexQuota: async () => fields });
   expect(result.providers[2].state).toBe("unknown");
  }
  const fields = { primary_used: 35, primary_window_seconds: 604800, primary_reset_at: 1792874442,
   primary_reset_s: 434942, allowed: true, secondary_window: null };
  const result = await readModelQuotas({ env: {}, now: () => 1792439500814, codexQuota: async () => fields });
  expect(result.providers[2]).toMatchObject({ state: "reported", checkedAt: "2026-10-19T19:51:40.814Z", details: fields });
 });

 it("does not promote a zero quota after reset time passes without a new read", async () => {
  const result = await readModelQuotas({ env: { MINIMAX_API_KEY: "fixture" }, now: () => observedGeneral.end_time + 1,
   fetchImpl: async () => Response.json({ model_remains: [observedGeneral] }), codexQuota: async () => ({}) });
  expect(result.providers[1].state).toBe("quota_exhausted");
 });

 it("keeps invalid JSON and timeouts unknown without echoing errors", async () => {
  for (const fetchImpl of [async () => new Response("bad-json"), async () => { throw new DOMException("hidden", "TimeoutError"); }]) {
   const result = await readModelQuotas({ env: { MINIMAX_API_KEY: "fixture" }, fetchImpl, codexQuota: async () => { throw new Error("hidden"); } });
   expect(result.providers.every((quota) => quota.state === "unknown")).toBe(true);
   expect(JSON.stringify(result)).not.toContain("hidden");
  }
 });
