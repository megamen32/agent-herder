import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { compactAutomaticMessage, readLongMessage } from "./long-messages.js";
import type { HerderJob } from "./herder-jobs.js";
import type { AgentSession, HarnessType, SendMessageResult, SessionMessageView } from "./types/index.js";

export const DELIVERY_RESPONSE_MAX_WAIT_MS = 30_000;
export const DELIVERY_RESPONSE_MAX_TEXT_CHARS = 8_000;
export const DELIVERY_RESPONSE_MAX_MESSAGES = 8_000;

export type DeliveryResponseTarget = {
  hostId: string;
  harness: HarnessType;
  sessionId: string;
};

export type DeliveryResponseBaselineMessage = {
  id: string;
  role: SessionMessageView["role"];
  turnId?: string;
  /** UTF-16 code-unit offset into the visible, redacted text for this message. */
  textOffset: number;
  textPrefixSha256: string;
};

export type DeliveryResponseBaseline = {
  version: 1;
  jobId: string;
  inputId: string;
  target: DeliveryResponseTarget;
  capturedAt: string;
  coverage: "complete" | "partial" | "unavailable";
  messageCount: number;
  messages: DeliveryResponseBaselineMessage[];
  snapshotSha256: string;
};

export type DeliveryResponseHistory = {
  messages: SessionMessageView[] | null;
  /** True only when the history source proves that its returned set is complete. */
  complete?: boolean;
  /** True only when a native latest-page reader returned the exact admitted input and its full ordered suffix. */
  inputTailComplete?: boolean;
  /** True only when the native/history source proves that the correlated turn finished. */
  turnComplete?: boolean;
};

export type DeliveryResponseCorrelation = "reply_to" | "observed_after_delivery" | "unavailable";
export type DeliveryResponseStatus = "pending" | "partial" | "completed" | "failed" | "unknown" | "unavailable";

export type DeliveryResponseResult = {
  jobId: string;
  inputId: string;
  jobRef: string;
  target: DeliveryResponseTarget;
  status: DeliveryResponseStatus;
  correlation: DeliveryResponseCorrelation;
  text: string;
  totalTextLength: number;
  responseSha256: string;
  /** Stable read-only resource for the latest response bound to this delivery. */
  responseFetchUri?: string;
  responseResourceUri?: string;
  nextOffset?: number;
  baselineCoverage: DeliveryResponseBaseline["coverage"];
  turnId?: string;
  observationCancelled?: boolean;
  reason?: "baseline_unavailable" | "baseline_gap" | "baseline_prefix_changed" | "job_unavailable" | "job_unknown" | "history_unavailable" | "no_visible_response";
};

export type DeliveryResponsePage = {
  messageId: string;
  sha256: string;
  total: number;
  offset: number;
  nextOffset: number | null;
  text: string;
};

export type DeliveryResponseReceipt = {
  inputId: string;
  target: DeliveryResponseTarget;
  responseResourceUri: string;
  responseSha256: string;
  totalTextLength: number;
};

export type DeliveryResponseSnapshotReader = (
  target: DeliveryResponseTarget,
  limit: number,
  signal?: AbortSignal,
) => Promise<DeliveryResponseHistory>;

export type DeliveryResponseJobReader = (jobId: string, signal?: AbortSignal) => HerderJob<SendMessageResult> | null | Promise<HerderJob<SendMessageResult> | null>;
export type DeliveryResponseBaselineReader = (jobId: string) => DeliveryResponseBaseline | null | Promise<DeliveryResponseBaseline | null>;

/** Admission and idle alone do not prove completion of the delivered input. */
export function nativeDeliveryResponseComplete(
  session: Pick<AgentSession, "id" | "status" | "needsPermission" | "meta">,
  job: HerderJob<SendMessageResult> | null,
): boolean {
  if (!job || job.state !== "completed" || !job.result?.ok || job.result.admissionUnknown
    || job.ownerSessionId !== session.id || session.status !== "idle" || session.needsPermission) return false;
  const turnId = job.result.turnId;
  const native = session.meta?.nativeLastTurn as { turnId?: unknown; status?: unknown } | undefined;
  return typeof turnId === "string" && turnId.length > 0
    && native?.turnId === turnId && native.status === "completed";
}

function exactNativeInputBoundary(input: {
  target: DeliveryResponseTarget;
  inputId: string;
  job: HerderJob<SendMessageResult> | null;
  history: DeliveryResponseHistory;
}): { inputIndex: number; nativeInputMessageId: string; turnId?: string } | null {
  const job = input.job;
  const nativeInputMessageId = job?.result?.nativeInputMessageId;
  if (input.target.harness !== "opencode" || !job || job.state !== "completed" || !job.result?.ok
    || job.result.admitted !== true || job.result.admissionUnknown || job.ownerSessionId !== input.target.sessionId
    || job.result.inputId !== input.inputId || typeof nativeInputMessageId !== "string" || !nativeInputMessageId
    || input.history.inputTailComplete !== true || !input.history.messages) return null;

  const messages = input.history.messages;
  const matches = messages.flatMap((message, index) => message.id === nativeInputMessageId && message.role === "user" ? [index] : []);
  if (matches.length !== 1) return null;
  const inputIndex = matches[0]!;
  if (messages.slice(inputIndex + 1).some((message) => message.role === "user")) return null;

  const turnId = job.result.turnId;
  if (turnId && messages.slice(inputIndex + 1).some((message) => message.role === "assistant" && message.turnId && message.turnId !== turnId)) return null;
  return { inputIndex, nativeInputMessageId, ...(turnId ? { turnId } : {}) };
}

/**
 * Native input ID, exact ordered history, final assistant finish, and stable
 * idle readback can close a missing OpenCode pre-send baseline. No text before
 * the native input is considered, and any ambiguity keeps the result unknown.
 */
export function nativeDeliveryResponseCompleteByInput(input: {
  target: DeliveryResponseTarget;
  inputId: string;
  job: HerderJob<SendMessageResult> | null;
  before: Pick<AgentSession, "id" | "harness" | "hostId" | "status" | "needsPermission">;
  after: Pick<AgentSession, "id" | "harness" | "hostId" | "status" | "needsPermission">;
  history: DeliveryResponseHistory;
}): boolean {
  const identityMatches = (session: typeof input.before) => session.id === input.target.sessionId
    && session.harness === input.target.harness && session.hostId === input.target.hostId
    && session.status === "idle" && !session.needsPermission;
  if (!identityMatches(input.before) || !identityMatches(input.after)) return false;
  const boundary = exactNativeInputBoundary(input);
  if (!boundary || !input.history.messages) return false;
  const afterInput = input.history.messages.slice(boundary.inputIndex + 1);
  const assistants = afterInput.filter((message) => message.role === "assistant");
  const terminals = assistants.filter((message) => message.phase === "stop");
  const terminal = terminals.at(-1);
  if (!terminal || terminals.length !== 1 || afterInput.at(-1)?.id !== terminal.id) return false;
  if (boundary.turnId && terminal.turnId !== boundary.turnId) return false;
  return true;
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const emptyTextSha256 = sha256("");

function sameTarget(a: DeliveryResponseTarget, b: DeliveryResponseTarget): boolean {
  return a.hostId === b.hostId && a.harness === b.harness && a.sessionId === b.sessionId;
}

function validTarget(value: unknown): value is DeliveryResponseTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<DeliveryResponseTarget>;
  return typeof target.hostId === "string" && target.hostId.length > 0
    && typeof target.sessionId === "string" && target.sessionId.length > 0
    && typeof target.harness === "string" && target.harness.length > 0;
}

/**
 * Extract the user-visible, normalized part of one history message. When a
 * structured message contains reasoning, tools, or other non-text parts, only
 * explicit `text` parts are eligible. A text-only `message.text` fallback is
 * allowed only when the trusted normalized contract has no structured parts.
 */
export function visibleHistoryText(message: SessionMessageView): string {
  if (!Array.isArray(message.parts)) return typeof message.text === "string" ? message.text : "";
  const visibleParts = message.parts.filter((part) => part.type === "text" && typeof part.text === "string");
  if (visibleParts.length > 0) return visibleParts.map((part) => part.text || "").join("\n");
  if (message.parts.length > 0) return "";
  return typeof message.text === "string" ? message.text : "";
}

function baselineDigest(input: Omit<DeliveryResponseBaseline, "snapshotSha256">): string {
  return sha256(JSON.stringify({
    version: input.version,
    jobId: input.jobId,
    inputId: input.inputId,
    target: input.target,
    capturedAt: input.capturedAt,
    coverage: input.coverage,
    messageCount: input.messageCount,
    messages: input.messages,
  }));
}

export function validateDeliveryResponseBaseline(
  value: unknown,
  expected?: { jobId?: string; inputId?: string; target?: DeliveryResponseTarget },
): value is DeliveryResponseBaseline {
  if (!value || typeof value !== "object") return false;
  const baseline = value as Partial<DeliveryResponseBaseline>;
  if (baseline.version !== 1 || typeof baseline.jobId !== "string" || !baseline.jobId
    || typeof baseline.inputId !== "string" || !baseline.inputId || !validTarget(baseline.target)
    || typeof baseline.capturedAt !== "string" || !Number.isFinite(Date.parse(baseline.capturedAt))
    || !["complete", "partial", "unavailable"].includes(String(baseline.coverage))
    || !Number.isSafeInteger(baseline.messageCount) || (baseline.messageCount ?? -1) < 0
    || !Array.isArray(baseline.messages) || baseline.messages.length > DELIVERY_RESPONSE_MAX_MESSAGES
    || typeof baseline.snapshotSha256 !== "string" || !/^[a-f0-9]{64}$/.test(baseline.snapshotSha256)) return false;
  if (Object.keys(baseline).some((key) => !["version", "jobId", "inputId", "target", "capturedAt", "coverage", "messageCount", "messages", "snapshotSha256"].includes(key))) return false;
  if (expected?.jobId && baseline.jobId !== expected.jobId) return false;
  if (expected?.inputId && baseline.inputId !== expected.inputId) return false;
  if (expected?.target && !sameTarget(baseline.target, expected.target)) return false;
  const seen = new Set<string>();
  for (const item of baseline.messages) {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id
      || !["user", "assistant", "tool", "system"].includes(item.role)
      || (item.turnId !== undefined && typeof item.turnId !== "string")
      || !Number.isSafeInteger(item.textOffset) || item.textOffset < 0
      || typeof item.textPrefixSha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.textPrefixSha256)
      || Object.keys(item).some((key) => !["id", "role", "turnId", "textOffset", "textPrefixSha256"].includes(key))) return false;
    if (seen.has(item.id)) return false;
    seen.add(item.id);
  }
  const { snapshotSha256: _snapshotSha256, ...digestInput } = baseline as DeliveryResponseBaseline;
  return baselineDigest(digestInput) === baseline.snapshotSha256;
}

/** Capture private IDs/offsets/hashes only; the baseline never stores old text. */
export async function captureDeliveryResponseBaseline(input: {
  jobId: string;
  inputId: string;
  target: DeliveryResponseTarget;
  readMessages: DeliveryResponseSnapshotReader;
  now?: () => Date;
}): Promise<DeliveryResponseBaseline> {
  const capturedAt = (input.now?.() ?? new Date()).toISOString();
  let history: DeliveryResponseHistory;
  try {
    history = await input.readMessages(input.target, DELIVERY_RESPONSE_MAX_MESSAGES);
  } catch {
    history = { messages: null };
  }
  const messages = history.messages?.slice(-DELIVERY_RESPONSE_MAX_MESSAGES) ?? null;
  const baselineMessages: DeliveryResponseBaselineMessage[] = [];
  for (const message of messages ?? []) {
    if (typeof message.id !== "string" || !message.id || baselineMessages.some((row) => row.id === message.id)) continue;
    const text = message.role === "assistant" || message.role === "user" ? visibleHistoryText(message) : "";
    baselineMessages.push({
      id: message.id,
      role: message.role,
      ...(message.turnId ? { turnId: message.turnId } : {}),
      textOffset: text.length,
      textPrefixSha256: sha256(text),
    });
  }
  const baselineWithoutDigest: Omit<DeliveryResponseBaseline, "snapshotSha256"> = {
    version: 1,
    jobId: input.jobId,
    inputId: input.inputId,
    target: { ...input.target },
    capturedAt,
    coverage: messages === null ? "unavailable" : history.complete === true && messages.length < DELIVERY_RESPONSE_MAX_MESSAGES ? "complete" : "partial",
    messageCount: messages?.length ?? 0,
    messages: baselineMessages,
  };
  return { ...baselineWithoutDigest, snapshotSha256: baselineDigest(baselineWithoutDigest) };
}

export type DeliveryResponseDelta = {
  text: string;
  correlation: DeliveryResponseCorrelation;
  integrity: "verified" | "baseline_unavailable" | "baseline_gap" | "baseline_prefix_changed" | "history_unavailable";
  turnId?: string;
};

/** Return only appended/new visible assistant text; never reconstruct old history. */
export function diffDeliveryResponse(input: {
  baseline: DeliveryResponseBaseline;
  history: DeliveryResponseHistory;
  target: DeliveryResponseTarget;
  jobId: string;
  inputId: string;
  turnId?: string;
}): DeliveryResponseDelta {
  const unavailable: DeliveryResponseDelta = { text: "", correlation: "unavailable", integrity: "baseline_unavailable" };
  if (!validateDeliveryResponseBaseline(input.baseline, input)) return unavailable;
  if (input.baseline.coverage === "unavailable") return unavailable;
  const current = input.history.messages;
  if (!current) return { text: "", correlation: "unavailable", integrity: "history_unavailable" };
  const previous = new Map(input.baseline.messages.map((message) => [message.id, message]));
  const baselineTail = input.baseline.messages.at(-1)?.id;
  if (!baselineTail && (input.baseline.messageCount > 0 || input.baseline.coverage !== "complete")) {
    return { text: "", correlation: "unavailable", integrity: "baseline_gap" };
  }
  const tailIndex = baselineTail ? current.findIndex((message) => message.id === baselineTail) : -1;
  if (baselineTail && tailIndex < 0) return { text: "", correlation: "unavailable", integrity: "baseline_gap" };

  // New messages that appear before the ordered tail anchor cannot be
  // distinguished from rows omitted by a bounded/partial baseline. Refuse the
  // whole window instead of accidentally returning older assistant history.
  if (tailIndex >= 0) {
    const prefixIds = new Set(current.slice(0, tailIndex).map((message) => message.id));
    if (current.slice(0, tailIndex).some((message) => !previous.has(message.id))) {
      return { text: "", correlation: "unavailable", integrity: "baseline_gap" };
    }
    const baselinePrefix = input.baseline.messages.slice(0, -1).map((message) => message.id).filter((id) => prefixIds.has(id));
    const currentBaselinePrefix = current.slice(0, tailIndex).map((message) => message.id).filter((id) => previous.has(id));
    if (baselinePrefix.join("\0") !== currentBaselinePrefix.join("\0")) {
      return { text: "", correlation: "unavailable", integrity: "baseline_gap" };
    }
  }

  const visibleParts: string[] = [];
  let prefixChanged = false;
  let exactTurn = false;
  for (let index = 0; index < current.length; index++) {
    const message = current[index]!;
    // Existing assistant messages before the capture tail are old history;
    // only the tail itself may have streamed an append after the baseline.
    if (tailIndex >= 0 && index < tailIndex) continue;
    if (message.role !== "assistant") continue;
    const currentText = visibleHistoryText(message);
    if (!currentText) continue;
    const old = previous.get(message.id);
    let delta: string;
    if (!old) {
      if (tailIndex >= 0 && index <= tailIndex) continue;
      delta = currentText;
    } else {
      if (old.role !== "assistant") { prefixChanged = true; continue; }
      if (currentText.length < old.textOffset || sha256(currentText.slice(0, old.textOffset)) !== old.textPrefixSha256) {
        prefixChanged = true;
        continue;
      }
      delta = currentText.slice(old.textOffset);
    }
    if (!delta) continue;
    visibleParts.push(delta);
    if (input.turnId && message.turnId === input.turnId) exactTurn = true;
  }
  const text = visibleParts.join("\n");
  return {
    text,
    correlation: exactTurn ? "reply_to" : text ? "observed_after_delivery" : "unavailable",
    integrity: prefixChanged ? "baseline_prefix_changed" : "verified",
    ...(exactTurn && input.turnId ? { turnId: input.turnId } : {}),
  };
}

function resultStatus(job: HerderJob<SendMessageResult>, history: DeliveryResponseHistory, delta: DeliveryResponseDelta): DeliveryResponseStatus {
  if (delta.integrity === "baseline_unavailable" || delta.integrity === "baseline_gap" || delta.integrity === "history_unavailable") return "unknown";
  if (["failed", "cancelled", "interrupted"].includes(job.state)) {
    if (job.result?.admissionUnknown || job.result?.admitted || job.state === "interrupted") return "unknown";
    return "failed";
  }
  if (delta.integrity === "baseline_prefix_changed") return delta.text ? "partial" : "unknown";
  if (history.turnComplete === true) return "completed";
  return delta.text ? "partial" : "pending";
}

async function formatResponseText(text: string): Promise<{ text: string; responseResourceUri?: string; nextOffset?: number }> {
  if (text.length <= DELIVERY_RESPONSE_MAX_TEXT_CHARS) return { text };
  const compact = await compactAutomaticMessage(text, text.slice(0, DELIVERY_RESPONSE_MAX_TEXT_CHARS));
  const messageId = compact.match(/herder:\/\/m\/([a-f0-9]{8,64})/)?.[1];
  if (!messageId) throw new Error("Failed to persist response continuation");
  return { text: compact, responseResourceUri: `herder://m/${messageId}`, nextOffset: DELIVERY_RESPONSE_MAX_TEXT_CHARS };
}

async function toResult(input: {
  target: DeliveryResponseTarget;
  jobId: string;
  inputId: string;
  baseline: DeliveryResponseBaseline;
  job: HerderJob<SendMessageResult> | null;
  history: DeliveryResponseHistory;
  turnId?: string;
  observationCancelled?: boolean;
  recordResponseReceipt?: (jobId: string, receipt: DeliveryResponseReceipt) => void | Promise<void>;
}): Promise<DeliveryResponseResult> {
  if (!input.job || input.job.id !== input.jobId || input.job.ownerSessionId !== input.target.sessionId) {
    return {
      jobId: input.jobId, inputId: input.inputId, jobRef: `herder://jobs/${input.jobId}`,
      target: input.target, status: "unknown", correlation: "unavailable", text: "", totalTextLength: 0,
      responseSha256: sha256(""), baselineCoverage: input.baseline.coverage, reason: "job_unavailable",
    };
  }
  const exactBoundary=input.baseline.coverage==='unavailable'?exactNativeInputBoundary({target:input.target,inputId:input.inputId,job:input.job,history:input.history}):null;
  let baselineForDiff=input.baseline;
  if(exactBoundary&&input.history.messages){
    const prefix=input.history.messages.slice(0,exactBoundary.inputIndex+1);
    baselineForDiff=await captureDeliveryResponseBaseline({jobId:input.jobId,inputId:input.inputId,target:input.target,readMessages:async()=>({messages:prefix,complete:true})});
  }
  const terminalAssistant=exactBoundary&&input.history.messages
    ?input.history.messages.slice(exactBoundary.inputIndex+1).filter(message=>message.role==='assistant'&&message.phase==='stop').at(-1)
    :undefined;
  const turnId=input.turnId??input.job.result?.turnId??terminalAssistant?.turnId;
  const delta = diffDeliveryResponse({
    baseline: baselineForDiff, history: input.history, target: input.target,
    jobId: input.jobId, inputId: input.inputId,
    ...(turnId?{turnId}:{}),
  });
  const status = resultStatus(input.job, input.history, delta);
  const correlation=exactBoundary&&delta.integrity==='verified'?'reply_to':delta.correlation;
  const formatted = await formatResponseText(delta.text);
  if (formatted.responseResourceUri && input.recordResponseReceipt) {
    await input.recordResponseReceipt(input.jobId, {
      inputId: input.inputId,
      target: { ...input.target },
      responseResourceUri: formatted.responseResourceUri,
      responseSha256: sha256(delta.text),
      totalTextLength: delta.text.length,
    });
  }
  return {
    jobId: input.jobId, inputId: input.inputId, jobRef: input.job.resultRef,
    target: input.target, status, correlation, text: formatted.text,
    totalTextLength: delta.text.length, responseSha256: sha256(delta.text),
    responseFetchUri: `herder://delivery-responses/${encodeURIComponent(input.target.hostId)}/${encodeURIComponent(input.target.harness)}/${encodeURIComponent(input.target.sessionId)}/${encodeURIComponent(input.jobId)}/${encodeURIComponent(input.inputId)}`,
    ...(formatted.responseResourceUri ? { responseResourceUri: formatted.responseResourceUri } : {}),
    ...(formatted.nextOffset !== undefined ? { nextOffset: formatted.nextOffset } : {}),
    baselineCoverage: input.baseline.coverage,
    ...(delta.turnId||turnId ? { turnId: delta.turnId||turnId } : {}),
    ...(input.observationCancelled ? { observationCancelled: true } : {}),
    ...(delta.integrity === "baseline_gap" ? { reason: "baseline_gap" as const } : {}),
    ...(delta.integrity === "baseline_prefix_changed" ? { reason: "baseline_prefix_changed" as const } : {}),
    ...(delta.integrity === "baseline_unavailable" ? { reason: "baseline_unavailable" as const } : {}),
    ...(delta.integrity === "history_unavailable" ? { reason: "history_unavailable" as const } : {}),
    ...(status === "completed" && delta.text.length === 0 ? { reason: "no_visible_response" as const } : {}),
    ...(status === "unknown" && !delta.integrity.startsWith("baseline_") && delta.integrity !== "history_unavailable" ? { reason: "job_unknown" as const } : {}),
  };
}

function raceRead<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<{ kind: "value"; value: T } | { kind: "timeout" } | { kind: "aborted" }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const readerController = new AbortController();
    const finish = (value: { kind: "value"; value: T } | { kind: "timeout" } | { kind: "aborted" }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(value);
    };
    const timer = setTimeout(() => {
      readerController.abort(new Error("delivery response read deadline exceeded"));
      finish({ kind: "timeout" });
    }, timeoutMs);
    const abort = () => {
      readerController.abort(signal?.reason);
      finish({ kind: "aborted" });
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    if (!settled) {
      Promise.resolve().then(() => operation(readerController.signal)).then(
        (value) => finish({ kind: "value", value }),
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      );
    }
  });
}

/** Observe one already-admitted job. This function has no send/cancel/retry path. */
export async function waitForDeliveryResponse(input: {
  jobId: string;
  inputId: string;
  target: DeliveryResponseTarget;
  baseline: DeliveryResponseBaseline;
  readJob: DeliveryResponseJobReader;
  readHistory: DeliveryResponseSnapshotReader;
  waitMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  delay?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
  recordResponseReceipt?: (jobId: string, receipt: DeliveryResponseReceipt) => void | Promise<void>;
  /** Return the first verified new visible text as a partial response. */
  returnOnVisibleText?: boolean;
  /** Read one bounded asynchronous snapshot, without waiting for another change. */
  snapshotOnly?: boolean;
}): Promise<DeliveryResponseResult> {
  if (!validateDeliveryResponseBaseline(input.baseline, input)) {
    return toResult({ ...input, job: null, history: { messages: null } });
  }
  const now = input.now ?? Date.now;
  const waitMs = Math.max(0, Math.min(DELIVERY_RESPONSE_MAX_WAIT_MS, Math.floor(input.waitMs ?? DELIVERY_RESPONSE_MAX_WAIT_MS)));
  const pollInterval = Math.max(50, Math.min(2_000, Math.floor(input.pollIntervalMs ?? 250)));
  const sleep = input.delay ?? ((ms: number, signal?: AbortSignal) => delay(ms, undefined, signal ? { signal } : undefined));
  const deadline = now() + waitMs;
  let latestJob: HerderJob<SendMessageResult> | null = null;
  let latestHistory: DeliveryResponseHistory = { messages: null };
  let turnId: string | undefined;

  while (true) {
    if (input.signal?.aborted) {
      return toResult({ ...input, job: latestJob, history: latestHistory, turnId, observationCancelled: true });
    }
    const remaining = Math.max(0, deadline - now());
    const outcome = await raceRead(async (readSignal) => {
      const [job, history] = await Promise.all([
        Promise.resolve().then(() => input.readJob(input.jobId, readSignal)).catch(() => null),
        input.readHistory(input.target, DELIVERY_RESPONSE_MAX_MESSAGES, readSignal).catch(() => ({ messages: null })),
      ]);
      return { job, history };
    }, remaining, input.signal);
    if (outcome.kind === "value") {
      latestJob = outcome.value.job;
      latestHistory = outcome.value.history;
      if (latestJob?.id === input.jobId && latestJob.ownerSessionId === input.target.sessionId) {
        turnId = latestJob.result?.turnId ?? turnId;
        const delta = diffDeliveryResponse({
          baseline: input.baseline, history: latestHistory, target: input.target,
          jobId: input.jobId, inputId: input.inputId, ...(turnId ? { turnId } : {}),
        });
        const status = resultStatus(latestJob, latestHistory, delta);
        if (status === "completed" || status === "failed" || (status === "unknown" && delta.integrity !== "baseline_gap" && delta.integrity !== "baseline_prefix_changed")
          || (input.returnOnVisibleText && delta.text.length > 0)) {
          return toResult({ ...input, job: latestJob, history: latestHistory, turnId });
        }
      }
    } else {
      return toResult({ ...input, job: latestJob, history: latestHistory, turnId, observationCancelled: outcome.kind === "aborted" });
    }
    if (input.snapshotOnly) return toResult({ ...input, job: latestJob, history: latestHistory, turnId });
    const left = deadline - now();
    if (left <= 0) return toResult({ ...input, job: latestJob, history: latestHistory, turnId });
    try {
      await sleep(Math.min(pollInterval, left), input.signal);
    } catch {
      return toResult({ ...input, job: latestJob, history: latestHistory, turnId, observationCancelled: true });
    }
  }
}

export async function readDeliveryResponseContinuation(input: {
  resourceUri: string;
  jobId: string;
  inputId: string;
  target: DeliveryResponseTarget;
  readJob: DeliveryResponseJobReader;
  readBaseline: DeliveryResponseBaselineReader;
  readReceipt: (jobId: string, expected: { inputId: string; target: DeliveryResponseTarget }) => DeliveryResponseReceipt | null | Promise<DeliveryResponseReceipt | null>;
  offset?: number;
  limit?: number;
}): Promise<DeliveryResponsePage> {
  const [job, baseline, receipt] = await Promise.all([
    input.readJob(input.jobId),
    input.readBaseline(input.jobId),
    input.readReceipt(input.jobId, { inputId: input.inputId, target: input.target }),
  ]);
  if (!job || job.id !== input.jobId || job.ownerSessionId !== input.target.sessionId
    || !validateDeliveryResponseBaseline(baseline, { jobId: input.jobId, inputId: input.inputId, target: input.target })) {
    throw new Error("Delivery response continuation is not bound to this exact target and job");
  }
  if (!receipt || receipt.inputId !== input.inputId || !sameTarget(receipt.target, input.target)
    || receipt.responseResourceUri !== input.resourceUri || !/^[a-f0-9]{64}$/.test(receipt.responseSha256)
    || !Number.isSafeInteger(receipt.totalTextLength) || receipt.totalTextLength <= DELIVERY_RESPONSE_MAX_TEXT_CHARS) {
    throw new Error("Delivery response continuation is not bound to a previously returned response");
  }
  const messageId = input.resourceUri.match(/^herder:\/\/m\/([a-f0-9]{8,64})$/)?.[1];
  if (!messageId) throw new Error("Invalid response continuation reference");
  const page = await readLongMessage({ messageId, offset: input.offset, limit: input.limit });
  if (page.sha256 !== receipt.responseSha256 || page.total !== receipt.totalTextLength) {
    throw new Error("Delivery response continuation content does not match its recorded receipt");
  }
  return page;
}
