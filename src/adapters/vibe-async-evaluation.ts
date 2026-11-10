import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { parseChromeEvaluation } from "./mac-mini-chrome-transport.js";

export const VIBE_ASYNC_EVALUATION_PROTOCOL = "agent-herder-vibe-async-v1";
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const FRAME_HEADROOM_BYTES = 4096;
type EvaluationFrame = {
  protocol: typeof VIBE_ASYNC_EVALUATION_PROTOCOL;
  nonce: string;
  state: "pending" | "done" | "error" | "missing";
  value?: unknown;
  code?: string;
};
export type VibeAsyncEvaluationOptions = {
  functionDeclaration: string;
  args?: unknown[];
  /** One native evaluate_script on the same already-authorized owned tab.
   * Returns the normalized fenced JSON from that synchronous native call. */
  evaluateOnce(declaration: string, args?: unknown[]): Promise<string>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
};
function failure(code: string): Error { return new Error("vibe_async_evaluation_" + code); }
function bytes(value: string): number { return Buffer.byteLength(value, "utf8"); }
function setting(input: number | undefined, fallback: number, min: number, max: number): number {
  const value = input ?? fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw failure("invalid_budget");
  return value;
}
function fenced(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined || bytes(text) > MAX_RESPONSE_BYTES - 16) throw failure("result_too_large");
  const fence = String.fromCharCode(96).repeat(3);
  return fence + "json\n" + text + "\n" + fence;
}

/** Must remain synchronous: Vibe 1.1.41 serializes a Promise nested in its
 * result envelope as {} even when Runtime.evaluate has awaitPromise enabled. */
function browserBootstrap(
  options: { nonce: string; ttlMs: number; maxBytes: number },
  invoke: () => unknown,
): EvaluationFrame {
  const page = globalThis as any;
  const key = "__agentHerderVibeAsyncEvaluationV1";
  const protocol = "agent-herder-vibe-async-v1" as const;
  const { nonce, ttlMs, maxBytes } = options;
  let cache = page[key];
  if (cache === undefined) {
    cache = { version: 1, entries: Object.create(null) };
    Object.defineProperty(page, key, { value: cache, configurable: true });
  }
  if (!cache || cache.version !== 1 || !cache.entries || typeof cache.entries !== "object"
    || Array.isArray(cache.entries)) return { protocol, nonce, state: "error", code: "cache_unavailable" };
  const now = Date.now();
  for (const [id, entry] of Object.entries(cache.entries) as Array<[string, any]>) {
    if (!entry || entry.expiresAt <= now) {
      if (entry?.timer !== undefined) page.clearTimeout(entry.timer);
      delete cache.entries[id];
    }
  }
  // Even an accidental duplicate bootstrap nonce must never invoke work twice.
  if (Object.prototype.hasOwnProperty.call(cache.entries, nonce))
    return { protocol, nonce, state: "error", code: "cache_unavailable" };
  if (Object.keys(cache.entries).length >= 32)
    return { protocol, nonce, state: "error", code: "cache_unavailable" };
  const entry: any = { state: "pending", expiresAt: now + ttlMs };
  cache.entries[nonce] = entry;
  const expire = () => {
    if (page[key] === cache && cache.entries[nonce] === entry) delete cache.entries[nonce];
  };
  entry.timer = page.setTimeout(expire, ttlMs);
  Promise.resolve().then(invoke).then(
    value => {
      if (page[key] !== cache || cache.entries[nonce] !== entry || Date.now() >= entry.expiresAt) return;
      try {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) { entry.state = "error"; entry.code = "unsupported_result"; return; }
        // Snapshot the value. Later mutations of the returned object cannot
        // change the result observed by a subsequent synchronous poll.
        const snapshot = JSON.parse(serialized);
        const frame = { protocol, nonce, state: "done", value: snapshot };
        // Bound the native wrapper and its MCP text serialization, not only
        // the unescaped inner value. No appended page state is requested.
        const native = JSON.stringify({ success: true, result: frame, executionTime: 0, type: "object", message: "" });
        const wire = JSON.stringify({ content: [{ type: "text", text: native }] });
        if (new page.TextEncoder().encode(wire).length > maxBytes) {
          entry.state = "error"; entry.code = "result_too_large"; return;
        }
        entry.value = snapshot; entry.state = "done";
      } catch { entry.state = "error"; entry.code = "unsupported_result"; }
    },
    () => {
      if (page[key] === cache && cache.entries[nonce] === entry) {
        entry.state = "error"; entry.code = "execution_failed";
      }
    },
  );
  return { protocol, nonce, state: "pending" };
}
/** Read-only with respect to the original operation: it is never called here. */
function browserPoll(nonce: string): EvaluationFrame {
  const page = globalThis as any, cache = page.__agentHerderVibeAsyncEvaluationV1;
  const protocol = "agent-herder-vibe-async-v1" as const;
  const entry = cache?.version === 1 ? cache.entries?.[nonce] : undefined;
  if (!entry || Date.now() >= entry.expiresAt) return { protocol, nonce, state: "missing" };
  if (entry.state === "done") return { protocol, nonce, state: "done", value: entry.value };
  if (entry.state === "error") return { protocol, nonce, state: "error", code: entry.code };
  return { protocol, nonce, state: "pending" };
}
function browserCleanup(nonce: string): { cleaned: boolean } {
  const page = globalThis as any, cache = page.__agentHerderVibeAsyncEvaluationV1;
  const entry = cache?.version === 1 ? cache.entries?.[nonce] : undefined;
  if (!entry) return { cleaned: false };
  if (entry.timer !== undefined) page.clearTimeout(entry.timer);
  delete cache.entries[nonce];
  return { cleaned: true };
}

function frame(text: string, nonce: string): EvaluationFrame {
  if (typeof text !== "string" || bytes(text) > MAX_RESPONSE_BYTES) throw failure("outcome_unknown");
  let result: EvaluationFrame;
  try { result = parseChromeEvaluation<EvaluationFrame>(text); } catch { throw failure("outcome_unknown"); }
  if (!result || typeof result !== "object" || Array.isArray(result)
    || result.protocol !== VIBE_ASYNC_EVALUATION_PROTOCOL || result.nonce !== nonce
    || !["pending", "done", "error", "missing"].includes(result.state)) throw failure("outcome_unknown");
  if (result.state === "done" && !Object.prototype.hasOwnProperty.call(result, "value")) throw failure("outcome_unknown");
  return result;
}

/** Executes the supplied function exactly once. A lost bootstrap receipt,
 * missing nonce after navigation, failed poll or deadline is UNKNOWN; neither
 * this helper nor its polls resubmit the original function. */
export async function evaluateVibeAsync(options: VibeAsyncEvaluationOptions): Promise<string> {
  const timeoutMs = setting(options.timeoutMs, 30_000, 1, 120_000);
  const pollIntervalMs = setting(options.pollIntervalMs, 100, 1, 1000);
  if (typeof options.functionDeclaration !== "string" || !options.functionDeclaration.trim()
    || options.args !== undefined && !Array.isArray(options.args)) throw failure("invalid_input");
  try {
    if (bytes(JSON.stringify({ function: options.functionDeclaration, args: options.args })) > MAX_RESPONSE_BYTES)
      throw failure("input_too_large");
  } catch { throw failure("invalid_input"); }
  const nonce = randomUUID(), deadline = Date.now() + timeoutMs;
  const bootstrap = "(...__herderArgs) => (" + browserBootstrap.toString() + ")("
    + JSON.stringify({ nonce, ttlMs: timeoutMs + 5000, maxBytes: MAX_RESPONSE_BYTES - FRAME_HEADROOM_BYTES })
    + ", () => (" + options.functionDeclaration + ")(...__herderArgs))";
  const poll = "() => (" + browserPoll.toString() + ")(" + JSON.stringify(nonce) + ")";
  const cleanup = "() => (" + browserCleanup.toString() + ")(" + JSON.stringify(nonce) + ")";

  const call = async (declaration: string, args?: unknown[], maximumMs?: number): Promise<string> => {
    const remaining = Math.min(deadline - Date.now(), maximumMs ?? timeoutMs);
    if (remaining <= 0 || options.signal?.aborted) throw failure("outcome_unknown");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await new Promise<string>((resolve, reject) => {
        const rejectUnknown = () => reject(failure("outcome_unknown"));
        timer = setTimeout(rejectUnknown, remaining);
        onAbort = rejectUnknown;
        options.signal?.addEventListener("abort", onAbort, { once: true });
        Promise.resolve().then(() => {
          if (options.signal?.aborted || Date.now() >= deadline) throw failure("outcome_unknown");
          return options.evaluateOnce(declaration, args);
        }).then(resolve, rejectUnknown);
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    }
  };
  const pause = async () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || options.signal?.aborted) throw failure("outcome_unknown");
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
  };
  let current = frame(await call(bootstrap, options.args), nonce);
  for (;;) {
    if (current.state === "done") {
      const value = fenced(current.value);
      // Cleanup is best effort after the result has arrived and been validated.
      // A cleanup timeout/refusal cannot change a successful original outcome.
      await call(cleanup, undefined, 1000).catch(() => undefined);
      return value;
    }
    if (current.state === "missing") throw failure("outcome_unknown");
    if (current.state === "error") {
      const code = ["execution_failed", "unsupported_result", "result_too_large", "cache_unavailable"].includes(current.code ?? "")
        ? current.code! : "outcome_unknown";
      await call(cleanup, undefined, 1000).catch(() => undefined);
      throw failure(code);
    }
    await pause();
    current = frame(await call(poll), nonce);
  }
}
