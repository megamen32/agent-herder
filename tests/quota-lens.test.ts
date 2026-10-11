import { describe, expect, it } from "vitest";
import { normalizeQuotaSample } from "../src/web/quota-lens.js";

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
