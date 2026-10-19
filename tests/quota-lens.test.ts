import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeQuotaSample, readCodexUsage } from "../src/web/quota-lens.js";

it("preserves actual Codex weekly period/reset seconds, null secondary, and both windows without extra payload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "herder-codex-quota-"));
  const file = join(dir, "auth.json");
  await writeFile(file, JSON.stringify({ tokens: { access_token: "fixture", account_id: "fixture" } }), { mode: 0o600 });
  vi.stubEnv("QUOTA_LENS_CODEX_AUTH", file);
  const primary = { used_percent: 35, limit_window_seconds: 604800, reset_after_seconds: 434942, reset_at: 1792874442 };
  try {
    for (const secondary of [null, { used_percent: 50, limit_window_seconds: 18000, reset_after_seconds: 123, reset_at: 1792439623 }]) {
      const fetchImpl = vi.fn(async () => Response.json({ plan_type: "pro", rate_limit: { allowed: true, limit_reached: false,
        primary_window: { ...primary, access_token: "hidden" }, secondary_window: secondary } }));
      vi.stubGlobal("fetch", fetchImpl);
      const result = await readCodexUsage();
      expect(result).toMatchObject({ plan: "pro", allowed: true, primary_used: 35, primary_window_seconds: 604800,
        primary_reset_at: 1792874442, primary_reset_s: 434942, primary_window: primary, secondary_window: secondary });
      if (secondary) expect(result).toMatchObject({ secondary_used: 50, secondary_reset_s: 123, secondary_window_seconds: 18000, secondary_reset_at: 1792439623 });
      expect(JSON.stringify(result)).not.toContain("hidden");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0][1]?.body).toBeUndefined();
    }
  } finally {
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});

describe("quota sampler schema compatibility", () => {
  it("keeps zero usage and normalizes native milliseconds and fields", () => {
    const record = normalizeQuotaSample({ ts: 1791720000000, quota: { primary_used: 0, secondary_used: 42, primary_reset_s: 3600 } });
    expect(record.ts).toBe(1791720000);
    expect(record.quota).toMatchObject({ primary: 0, secondary: 42, reset_s: 3600 });
  });

  it("retains the already canonical Python history without replacing valid zero values", () => {
    const record = normalizeQuotaSample({ ts: 1791720000, quota: { primary: 0, primary_used: 12, secondary: 50, reset_s: 0 } });
    expect(record.ts).toBe(1791720000);
    expect(record.quota).toMatchObject({ primary: 0, secondary: 50, reset_s: 0 });
  });

  it("preserves unavailable samples as unknown rather than inventing usage", () => {
    expect(normalizeQuotaSample({ ts: 1791720000, quota: { error: "unavailable" } }).quota).toMatchObject({ error: "unavailable", primary: undefined });
  });
});
