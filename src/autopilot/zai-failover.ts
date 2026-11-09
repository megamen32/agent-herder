import { JudgeRequestError } from "./judge-request.js";

export const ZAI_AUTOPILOT_MODELS = ["glm-5.3", "glm-5.2", "glm-5.3-flash"] as const;
export type ZaiAutopilotModel = typeof ZAI_AUTOPILOT_MODELS[number];
export type ZaiRetryKind = "rate_limited" | "overloaded" | "model_unavailable" | "timeout" | "network";
export type ZaiModelCycleRetry = {
  model: ZaiAutopilotModel;
  nextModel: ZaiAutopilotModel;
  /** One-based attempt and cycle of the failed request. */
  attempt: number;
  cycle: number;
  delayMs: number;
  kind: ZaiRetryKind;
};
export type ZaiModelCycleOptions<T> = {
  attempt: (model: ZaiAutopilotModel, attemptNumber: number) => Promise<T>;
  signal?: AbortSignal;
  /** Recheck HumanStop, opt-out and the native-context fence here. */
  shouldContinue?: () => Promise<boolean> | boolean;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Contains no provider message, request body, URL or credentials. */
  onRetry?: (event: ZaiModelCycleRetry) => void;
  /** At least one second between attempts; defaults to one second. */
  minDelayMs?: number;
  /** Caps our exponential cycle backoff, not a provider's Retry-After. */
  maxDelayMs?: number;
  /**
   * Opt in only for a pure inference API, whose repeated request cannot duplicate
   * a native create/send action. Ambiguous transports are never retried by default.
   */
  retryTransportErrors?: boolean;
};

export class ZaiModelCycleStoppedError extends Error {
  readonly name = "AbortError";
  constructor(readonly reason: "aborted" | "guard") {
    super(reason === "aborted"
      ? "Z.AI autopilot model cycle cancelled"
      : "Z.AI autopilot session is no longer eligible");
  }
}

const MIN_DELAY_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const GUARD_INTERVAL_MS = 1_000;
const MODEL_UNAVAILABLE_CODES = new Set([
  "model_not_found", "model_not_supported", "unsupported_model", "invalid_model",
]);

/**
 * An independent asynchronous model cycle; there is no shared queue or lock.
 * The caller owns per-session admission and passes its cancellation/fence.
 * Every failure yields to a timer, and a blocked session cannot hold another
 * invocation. Only validated transient failures advance to another model.
 */
export async function runZaiModelCycle<T>(options: ZaiModelCycleOptions<T>): Promise<T> {
  const minDelayMs = delaySetting(options.minDelayMs ?? MIN_DELAY_MS, "minDelayMs");
  const maxDelayMs = delaySetting(options.maxDelayMs ?? MAX_BACKOFF_MS, "maxDelayMs");
  if (maxDelayMs < minDelayMs) throw new RangeError("maxDelayMs must be at least minDelayMs");
  const sleep = options.sleep ?? cancellableSleep;
  const active = async () => {
    assertNotAborted(options.signal);
    if (options.shouldContinue
      && !await withCancellation(() => Promise.resolve(options.shouldContinue!()), options.signal)) {
      throw new ZaiModelCycleStoppedError("guard");
    }
    assertNotAborted(options.signal);
  };

  for (let attemptNumber = 1; ; attemptNumber++) {
    await active();
    const modelIndex = (attemptNumber - 1) % ZAI_AUTOPILOT_MODELS.length;
    const model = ZAI_AUTOPILOT_MODELS[modelIndex]!;
    let failure: unknown;
    try {
      const result = await withCancellation(() => options.attempt(model, attemptNumber), options.signal);
      // A successful request still cannot authorize a stale or cancelled action.
      await active();
      return result;
    } catch (error) {
      failure = error;
    }
    await active();
    const kind = retryKind(failure, options.retryTransportErrors === true);
    if (!kind) throw failure;
    const cycle = Math.floor((attemptNumber - 1) / ZAI_AUTOPILOT_MODELS.length) + 1;
    const nextModel = ZAI_AUTOPILOT_MODELS[(modelIndex + 1) % ZAI_AUTOPILOT_MODELS.length]!;
    const cycleBackoff = modelIndex === ZAI_AUTOPILOT_MODELS.length - 1
      ? Math.min(maxDelayMs, minDelayMs * 2 ** Math.min(cycle - 1, 30))
      : minDelayMs;
    // Retry-After is a lower bound. A long provider cooldown is honored in
    // bounded waits instead of being truncated to our 60-second backoff cap.
    const delayMs = Math.max(cycleBackoff, retryAfterMs((failure as JudgeRequestError).diagnostic.retryAfter));
    options.onRetry?.({ model, nextModel, attempt: attemptNumber, cycle, delayMs, kind });
    let remaining = delayMs;
    while (remaining > 0) {
      await active();
      const chunk = Math.min(remaining, options.shouldContinue ? GUARD_INTERVAL_MS : MAX_BACKOFF_MS);
      await withCancellation(() => sleep(chunk, options.signal), options.signal);
      remaining -= chunk;
    }
  }
}

function delaySetting(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < MIN_DELAY_MS || value > MAX_BACKOFF_MS) {
    throw new RangeError(`${name} must be an integer from 1000 to 60000 milliseconds`);
  }
  return value;
}

function retryKind(error: unknown, allowTransport: boolean): ZaiRetryKind | undefined {
  if (!(error instanceof JudgeRequestError)) return undefined;
  const diagnostic = error.diagnostic;
  if (diagnostic.kind === "rate_limited" || diagnostic.kind === "overloaded") return diagnostic.kind;
  if (allowTransport && (diagnostic.kind === "timeout" || diagnostic.kind === "network")) return diagnostic.kind;
  // Never infer unsupported models from a free-form provider message. Codes
  // are exact, and authorization/quota/cancellation errors remain terminal.
  if ((diagnostic.kind === "http_error" || diagnostic.kind === "provider_error")
    && [400, 404, 422].includes(diagnostic.httpStatus ?? 0)
    && MODEL_UNAVAILABLE_CODES.has(diagnostic.providerCode?.trim().toLowerCase() ?? "")) {
    return "model_unavailable";
  }
  return undefined;
}

function retryAfterMs(value: string | undefined): number {
  const text = value?.trim();
  if (!text) return 0;
  if (/^\d+(?:\.\d+)?$/u.test(text)) {
    const milliseconds = Math.ceil(Number(text) * 1_000);
    return Number.isSafeInteger(milliseconds) ? milliseconds : 0;
  }
  // HTTP-date begins with a weekday. Reject signed/NaN/ISO-looking numbers
  // rather than allowing Date.parse to reinterpret them as calendar dates.
  if (!/^[A-Za-z]{3}, /u.test(text)) return 0;
  const milliseconds = Math.max(0, Date.parse(text) - Date.now());
  return Number.isSafeInteger(milliseconds) ? milliseconds : 0;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ZaiModelCycleStoppedError("aborted");
}

/** Race even injected waits/attempts, so an uncooperative dependency cannot
 * prevent cancellation. The caller must also pass signal to its HTTP request. */
function withCancellation<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve().then(work);
  if (signal.aborted) return Promise.reject(new ZaiModelCycleStoppedError("aborted"));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", aborted);
    const aborted = () => { cleanup(); reject(new ZaiModelCycleStoppedError("aborted")); };
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve().then(() => {
      assertNotAborted(signal);
      return work();
    }).then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); },
    );
  });
}

function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  assertNotAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", aborted);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const aborted = () => {
      clearTimeout(timer);
      cleanup();
      reject(new ZaiModelCycleStoppedError("aborted"));
    };
    signal?.addEventListener("abort", aborted, { once: true });
  });
}
