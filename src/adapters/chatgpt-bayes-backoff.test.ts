import { describe, expect, it } from "vitest";
import {
  BAYES_TARGET_CHATGPT_LIST,
  ChatGptBayesBackoff,
} from "./chatgpt-bayes-backoff.js";

/** Deterministic RNG so the stochastic tests are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hidden site: a probe below the true safe interval 429s 90% of the time;
 * even a safe interval still 429s 10% of the time (window effects). */
class HiddenSite {
  constructor(readonly safeIntervalMs: number) {}
  p429(intervalMs: number): number {
    return intervalMs < this.safeIntervalMs ? 0.9 : 0.1;
  }
}

const OWNER_FLOOR_MS = 120_000;

/** Drives the estimator against a hidden limit with a realistic loop:
 * every probe happens after the real elapsed wait, and the elapsed wait —
 * not the nominal gap — is what gets recorded. */
function drive(
  bb: ChatGptBayesBackoff,
  site: HiddenSite,
  rng: () => number,
  iterations: number,
  onEvent?: (event: { outcome: "429" | "200"; intervalMs: number }) => void,
): void {
  let clock = 0;
  let lastProbeAt = -Number.MAX_SAFE_INTEGER;
  for (let n = 0; n < iterations; n++) {
    const interval = n === 0 ? 30_000 : clock - lastProbeAt;
    lastProbeAt = clock;
    const outcome = rng() < site.p429(interval) ? "429" : "200";
    onEvent?.({ outcome, intervalMs: interval });
    if (outcome === "429") {
      const v = bb.record429(BAYES_TARGET_CHATGPT_LIST, interval);
      clock += Math.max(15_000, v.cooldownMs); // we really wait the cooldown out
    } else {
      bb.recordSuccess(BAYES_TARGET_CHATGPT_LIST, interval);
      clock += 30_000; // healthy gap, back to the floor
    }
  }
}

describe("ChatGptBayesBackoff", () => {
  it("converges inside the owner's 120-300s band and then almost never 429s", () => {
    const site = new HiddenSite(150_000);
    const rng = mulberry32(42);
    const bb = new ChatGptBayesBackoff();
    let four29 = 0;
    drive(bb, site, rng, 200, ({ outcome }) => {
      if (outcome === "429") four29++;
    });
    const est = bb.estimateMs(BAYES_TARGET_CHATGPT_LIST);
    expect(four29).toBeGreaterThan(0);
    expect(est).toBeGreaterThan(150_000 * 0.8);
    expect(est).toBeLessThan(150_000 * 2.5);
    // Calm phase: probing at 2x the estimate must almost never 429 — the
    // estimate must not grossly undershoot the true tolerated interval.
    // (Probing at the raw request gap would legitimately 429 here, since the
    // gap sits below the true limit on purpose.)
    let safe429 = 0;
    for (let n = 0; n < 10; n++) {
      const probe = Math.max(OWNER_FLOOR_MS, Math.round(bb.estimateMs(BAYES_TARGET_CHATGPT_LIST) * 2));
      if (rng() < site.p429(probe)) {
        safe429++;
        bb.record429(BAYES_TARGET_CHATGPT_LIST, probe);
      } else {
        bb.recordSuccess(BAYES_TARGET_CHATGPT_LIST, probe);
      }
    }
    expect(safe429).toBeLessThanOrEqual(3);
  });

  it("climbs out of the owner's band when the site is stricter", () => {
    // Owner believes 120-300s; the real tolerated interval is 900s.
    const site = new HiddenSite(900_000);
    const rng = mulberry32(11);
    const bb = new ChatGptBayesBackoff();
    drive(bb, site, rng, 150);
    const est = bb.estimateMs(BAYES_TARGET_CHATGPT_LIST);
    expect(est).toBeGreaterThan(900_000 * 0.7);
    expect(est).toBeLessThan(900_000 * 1.8);
  });

  it("never proposes a cooldown below the owner's floor", () => {
    const bb = new ChatGptBayesBackoff();
    const first = bb.record429(BAYES_TARGET_CHATGPT_LIST, 15_000);
    expect(first.cooldownMs).toBeGreaterThanOrEqual(OWNER_FLOOR_MS);
    for (let n = 0; n < 5; n++) bb.recordSuccess(BAYES_TARGET_CHATGPT_LIST, 120_000);
    const afterHealthy = bb.record429(BAYES_TARGET_CHATGPT_LIST, 120_000);
    expect(afterHealthy.cooldownMs).toBeGreaterThanOrEqual(OWNER_FLOOR_MS);
  });

  it("tracks a limit that improves 4x mid-run (forgetting)", () => {
    const rng = mulberry32(7);
    const bb = new ChatGptBayesBackoff();
    // 150 probes against a strict limit, then the limit improves 4x.
    drive(bb, new HiddenSite(1_800_000), rng, 150);
    drive(bb, new HiddenSite(450_000), rng, 150);
    const est = bb.estimateMs(BAYES_TARGET_CHATGPT_LIST);
    expect(est).toBeGreaterThan(450_000 * 0.8);
    expect(est).toBeLessThan(450_000 * 2.0);
  });

  it("escalates toward the cap when the site keeps answering 429", () => {
    const bb = new ChatGptBayesBackoff();
    let interval = 15_000;
    for (let n = 0; n < 15; n++) {
      const v = bb.record429(BAYES_TARGET_CHATGPT_LIST, interval);
      interval = Math.max(15_000, v.cooldownMs);
    }
    expect(interval).toBeGreaterThan(300_000);
    expect(interval).toBeLessThanOrEqual(1_920_000);
  });

  it("honors Retry-After as a floor and never exceeds the cap", () => {
    const bb = new ChatGptBayesBackoff();
    const moderate = bb.record429(BAYES_TARGET_CHATGPT_LIST, 15_000, 180);
    expect(moderate.cooldownMs).toBeGreaterThanOrEqual(180_000);
    const huge = bb.record429(BAYES_TARGET_CHATGPT_LIST, 15_000, 3_000);
    expect(huge.cooldownMs).toBe(1_920_000);
  });

  it("clears the cooldown after healthy traffic and keeps the estimate in range", () => {
    const bb = new ChatGptBayesBackoff();
    bb.record429(BAYES_TARGET_CHATGPT_LIST, 15_000);
    expect(bb.remainingCooldownMs(BAYES_TARGET_CHATGPT_LIST)).toBeGreaterThan(0);
    for (let n = 0; n < 5; n++) bb.recordSuccess(BAYES_TARGET_CHATGPT_LIST, 60_000);
    expect(bb.remainingCooldownMs(BAYES_TARGET_CHATGPT_LIST)).toBe(0);
    const est = bb.estimateMs(BAYES_TARGET_CHATGPT_LIST);
    expect(est).toBeGreaterThanOrEqual(30_000);
    expect(est).toBeLessThanOrEqual(1_920_000);
  });

  it("announces the new number in the operator log line", () => {
    const bb = new ChatGptBayesBackoff();
    const v = bb.record429(BAYES_TARGET_CHATGPT_LIST, 15_000);
    expect(v.message).toContain("запрос превышен");
    expect(v.message).toContain("новое число");
    expect(v.message).toMatch(/проба №\d+/);
    expect(bb.recordSuccess(BAYES_TARGET_CHATGPT_LIST, 60_000).message).toBeNull();
  });
});
