import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readModelQuotas } from "../src/model-quota.js";

describe("live provider quota reads", () => {
  it("reads GLM, MiniMax and Codex independently and strips credential-shaped fields", async () => {
    const authorization = new Map<string, string | null>();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      authorization.set(url, new Headers(init?.headers).get("authorization"));
      if (url.includes("api.z.ai")) return Response.json({ code: 200, data: { limits: [{ type: "TOKENS_LIMIT", percentage: 72, remaining: 28, nextResetTime: 1792440000000, api_key: "must-not-escape" }] } });
      return Response.json({ model_remains: [{ model: "MiniMax-M3.1-Flash", remains_time: 41, usage_limit: 100, current_usage_count: 59 }] });
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
      { provider: "minimax", state: "reported", details: { model_remains: [{ model: "MiniMax-M3.1-Flash", remains_time: 41, usage_limit: 100, current_usage_count: 59 }] } },
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
          if (String(input).includes("api.z.ai")) return Response.json({ code: 200, data: { limits: [{ remaining: 12 }] } });
          return Response.json({ base_resp: { status_code: 0 }, model_remains: [{ current_interval_remaining_percent: 50 }] });
        },
        now: () => 1792430000000,
        codexQuota: async () => ({ primary_used: 10 }),
      });
      expect(authorization.get("https://api.z.ai/api/monitor/usage/quota/limit")).toBe("glm-file-test-secret");
      expect(result.providers[0]).toMatchObject({ provider: "glm", state: "reported", details: { limits: [{ remaining: 12 }] } });
      expect(JSON.stringify(result)).not.toContain("glm-file-test-secret");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
