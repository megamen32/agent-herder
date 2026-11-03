/** Bayesian adaptive 429 backoff for ChatGPT browser reads.
 *
 * Model: the safe request interval L (the minimum pause between
 * herder-initiated reads that chatgpt.com tolerates) is unknown and drifts
 * over the day. Every herder read is a probe at interval I with a noisy
 * binary outcome:
 *   - 429 is strong evidence that L > I (we were too fast);
 *   - 200 is strong evidence that L <= I.
 * The posterior over L lives on a log-spaced grid (30s .. 32min); each
 * update multiplies by the likelihood of the observed outcome and mixes a
 * small share of the prior back in (exponential forgetting), so the
 * estimate tracks hourly limit changes instead of freezing on the first
 * calibration.
 *
 * The working number is the 80% posterior quantile — slightly conservative.
 * The prior encodes the owner's calibration: the tolerated interval is
 * believed to sit around 120-300s (the site 429s even its own sparse
 * background traffic below that), so the prior is centered on ~190s, the
 * working floor is 120s (no probe ever runs faster than that, whatever the
 * posterior says), and the data can still climb well above the band when
 * the site is stricter than believed (validated in
 * chatgpt-bayes-backoff.test.ts). A 429 cooldown never lands below the
 * Retry-After the site sent and never above the 32min cap.
 *
 * Recording discipline: exactly ONE recording point per HTTP outcome (the
 * driver's trace ingest). The history cache and the prompt poller only
 * consume verdicts, so outcomes are never double-counted.
 */

const GRID_MIN_MS = 30_000;
const GRID_MAX_MS = 1_920_000; // 32 min cap
const GRID_POINTS = 40;
const FORGET = 0.015; // share of the prior remixed per update (limit drift)
const P429_SAFE = 0.15; // P(429 | I >= L)
const P429_UNSAFE = 0.85; // P(429 | I < L)
const P200_SAFE = 0.85; // P(200 | I >= L)
const P200_UNSAFE = 0.15; // P(200 | I < L)
const QUANTILE = 0.80; // working cooldown AND reported estimate
const FLOOR_MS = 120_000; // owner's optimistic bound: never probe faster
const PRIOR_CENTER_MS = 190_000; // geometric center of the owner's 120-300s band
const PRIOR_LOG_SIGMA = 0.7; // broad enough to climb out if the site is stricter

export type BayesBackoffTarget = string;

export const BAYES_TARGET_CHATGPT_LIST = "chatgpt:list";
export const BAYES_TARGET_CHATGPT_HISTORY = "chatgpt:history";
export const BAYES_TARGET_ZAI_HISTORY = "zai:history";

export type BayesVerdict = {
  target: BayesBackoffTarget;
  outcome: "429" | "200";
  cooldownMs: number; // 0 when healthy
  estimateMs: number; // 80% posterior quantile of the safe interval
  confidence: number; // posterior mass within x2 of the estimate, 0..1
  probes: number;
  message: string | null; // the operator line for a 429, else null
};

function buildGrid(): number[] {
  const grid: number[] = [];
  const ratio = GRID_MAX_MS / GRID_MIN_MS;
  for (let i = 0; i < GRID_POINTS; i++) {
    grid.push(Math.round(GRID_MIN_MS * Math.pow(ratio, i / (GRID_POINTS - 1))));
  }
  return grid;
}

/** Broad log-normal prior centered on 90s: "a normal safe gap" without
 * pretending to know the site's real limit. */
function buildPrior(grid: number[]): Float64Array {
  const prior = new Float64Array(GRID_POINTS);
  for (let i = 0; i < GRID_POINTS; i++) {
    const z = Math.log(grid[i] / PRIOR_CENTER_MS) / PRIOR_LOG_SIGMA;
    prior[i] = Math.exp(-0.5 * z * z);
  }
  let total = 0;
  for (let i = 0; i < GRID_POINTS; i++) total += prior[i];
  for (let i = 0; i < GRID_POINTS; i++) prior[i] /= total;
  return prior;
}

export class ChatGptBayesBackoff {
  private readonly grid = buildGrid();
  private readonly prior: Float64Array;
  private readonly weights = new Map<BayesBackoffTarget, Float64Array>();
  private readonly cooldownUntil = new Map<BayesBackoffTarget, number>();
  private readonly probeCounts = new Map<BayesBackoffTarget, number>();
  private readonly lastRequestAt = new Map<BayesBackoffTarget, number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.prior = buildPrior(this.grid);
  }

  private state(target: BayesBackoffTarget): Float64Array {
    let w = this.weights.get(target);
    if (!w) {
      w = new Float64Array(this.prior);
      this.weights.set(target, w);
    }
    return w;
  }

  private quantile(w: Float64Array, q: number): number {
    let acc = 0;
    for (let i = 0; i < GRID_POINTS; i++) {
      acc += w[i];
      if (acc >= q) return this.grid[i];
    }
    return this.grid[GRID_POINTS - 1];
  }

  /** Interval since the previous request of this target; the caller's hint
   * (a configured request gap) wins when present, the wall-clock delta of
   * recorded probes comes next, and the current estimate is the last resort. */
  private observedInterval(target: BayesBackoffTarget, hinted?: number): number {
    if (hinted !== undefined && Number.isFinite(hinted) && hinted > 0) return hinted;
    const last = this.lastRequestAt.get(target);
    if (last !== undefined) {
      const delta = this.now() - last;
      if (delta > 0) return delta;
    }
    return this.estimateMs(target);
  }

  record429(target: BayesBackoffTarget, observedIntervalMs?: number, retryAfterS?: number): BayesVerdict {
    const interval = this.observedInterval(target, observedIntervalMs);
    const verdict = this.update(target, "429", interval);
    let cooldown = Math.min(Math.max(verdict.cooldownMs, FLOOR_MS), GRID_MAX_MS);
    const retryMs = retryAfterS !== undefined && Number.isFinite(retryAfterS) && retryAfterS > 0
      ? retryAfterS * 1000 : 0;
    if (retryMs > 0) cooldown = Math.min(Math.max(cooldown, retryMs), GRID_MAX_MS);
    this.cooldownUntil.set(target, this.now() + cooldown);
    verdict.cooldownMs = Math.round(cooldown);
    verdict.message = "[chatgpt-backoff] Опа, всё, запрос превышен (429), новое число: "
      + Math.round(cooldown / 1000) + "с — оценка безопасного интервала ~"
      + Math.round(verdict.estimateMs / 1000) + "с, проба №" + verdict.probes
      + (retryMs > 0 ? " (Retry-After " + Math.round(retryMs / 1000) + "с)" : "");
    return verdict;
  }

  recordSuccess(target: BayesBackoffTarget, observedIntervalMs?: number): BayesVerdict {
    const interval = this.observedInterval(target, observedIntervalMs);
    const verdict = this.update(target, "200", interval);
    this.cooldownUntil.set(target, 0);
    return verdict;
  }

  remainingCooldownMs(target: BayesBackoffTarget): number {
    const until = this.cooldownUntil.get(target) ?? 0;
    return Math.max(0, until - this.now());
  }

  cooldownUntilMs(target: BayesBackoffTarget): number {
    return this.cooldownUntil.get(target) ?? 0;
  }

  /** The working number: the same 80% quantile the cooldown is built from. */
  estimateMs(target: BayesBackoffTarget): number {
    return this.quantile(this.state(target), QUANTILE);
  }

  probes(target: BayesBackoffTarget): number {
    return this.probeCounts.get(target) ?? 0;
  }

  private update(target: BayesBackoffTarget, outcome: "429" | "200", intervalMs: number): BayesVerdict {
    const w = this.state(target);
    for (let i = 0; i < GRID_POINTS; i++) {
      // Hypothesis L_i: intervals at or above L_i are tolerated by the site.
      const safe = this.grid[i] <= intervalMs;
      const likelihood = outcome === "429"
        ? (safe ? P429_SAFE : P429_UNSAFE)
        : (safe ? P200_SAFE : P200_UNSAFE);
      w[i] *= likelihood;
    }
    let total = 0;
    for (let i = 0; i < GRID_POINTS; i++) total += w[i];
    if (!(total > 0)) {
      w.set(this.prior);
      total = 1;
    }
    for (let i = 0; i < GRID_POINTS; i++) w[i] = (w[i] / total) * (1 - FORGET) + this.prior[i] * FORGET;
    total = 0;
    for (let i = 0; i < GRID_POINTS; i++) total += w[i];
    for (let i = 0; i < GRID_POINTS; i++) w[i] /= total;

    this.probeCounts.set(target, (this.probeCounts.get(target) ?? 0) + 1);
    this.lastRequestAt.set(target, this.now());

    const estimate = this.quantile(w, QUANTILE);
    let confidence = 0;
    for (let i = 0; i < GRID_POINTS; i++) {
      if (this.grid[i] >= estimate / 2 && this.grid[i] <= estimate * 2) confidence += w[i];
    }
    return {
      target,
      outcome,
      cooldownMs: Math.round(outcome === "429" ? estimate : 0),
      estimateMs: Math.round(estimate),
      confidence: Math.round(confidence * 100) / 100,
      probes: this.probeCounts.get(target) ?? 0,
      message: null,
    };
  }
}

let singleton: ChatGptBayesBackoff | undefined;

export function getChatGptBayesBackoff(): ChatGptBayesBackoff {
  if (!singleton) singleton = new ChatGptBayesBackoff();
  return singleton;
}
