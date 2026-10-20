import type { HerderJob } from "./herder-jobs.js";
import type { SessionLifecycleSnapshot } from "./session-lifecycle.js";
import type { HarnessEvent, SessionDetails, SessionMessageView } from "./types/index.js";

export type IntegratorProgressState =
  | "queued"
  | "active_progress"
  | "externally_waiting"
  | "blocked"
  | "terminal"
  | "unknown"
  | "stale_running";

export interface IntegratorProgressInput {
  now: number;
  staleAfterMs: number;
  allowedFutureSkewMs?: number;
  /** Native adapter snapshot plus its already-loaded transcript evidence. */
  details?: SessionDetails;
  /** Snapshot from lifecycleEntryFor(harness, sessionId). */
  lifecycle?: SessionLifecycleSnapshot;
  /** Events are scoped to details.session.id before use. */
  events?: readonly HarnessEvent[];
  /** Durable jobs are scoped by their native ownerSessionId. */
  jobs?: readonly HerderJob[];
  /** Accepted only as explicit timestamped receipts; there is no inference fallback. */
  externalWait?: { kind: "human" | "provider"; receiptId: string; observedAt: string; reason: string; turnId?: string };
  blocked?: { receiptId: string; observedAt: string; reason: string; turnId?: string };
}

export interface IntegratorProgressResult {
  state: IntegratorProgressState;
  source?: string;
  observedAt?: string;
  receiptId?: string;
  turnId?: string;
  reason: string;
  ageMs?: number;
}

interface Candidate {
  state: IntegratorProgressState;
  source: string;
  at: number;
  receiptId?: string;
  turnId?: string;
  reason: string;
  priority: number;
}

/**
 * Normalize existing native session, transcript, lifecycle, event and durable
 * job types into a dashboard read model. This is a pure projection: elapsed
 * time may label running evidence stale, but never proves death or triggers
 * restart/fallback.
 */
export function buildIntegratorProgress(input: IntegratorProgressInput): IntegratorProgressResult {
  if (!Number.isFinite(input.now)) return { state: "unknown", reason: "clock input is invalid" };
  if (!Number.isFinite(input.staleAfterMs) || input.staleAfterMs < 0) return { state: "unknown", reason: "staleness threshold is invalid" };
  const allowedFutureSkewMs = input.allowedFutureSkewMs ?? 30_000;
  if (!Number.isFinite(allowedFutureSkewMs) || allowedFutureSkewMs < 0) return { state: "unknown", reason: "future clock-skew tolerance is invalid" };

  const candidates: Candidate[] = [];
  const rejectedReasons: string[] = [];
  const session = input.details?.session;
  const currentTurnId = session?.status === "running" && typeof session.meta?.nativeActiveTurnId === "string"
    ? session.meta.nativeActiveTurnId : undefined;
  const add = (candidate: Omit<Candidate, "at"> & { at: string | number | undefined }): void => {
    const at = toEpoch(candidate.at);
    if (at === undefined) { rejectedReasons.push("evidence timestamp is missing or invalid"); return; }
    if (at - input.now > allowedFutureSkewMs) { rejectedReasons.push("evidence timestamp is in the future"); return; }
    candidates.push({ ...candidate, at });
  };
  const freshRunningProofs: Array<{ at: number; turnId?: string }> = [];
  const freshProof = (value: string | number | undefined, turnId?: string): void => {
    const at = toEpoch(value);
    if (at === undefined || at - input.now > allowedFutureSkewMs || input.now - at > input.staleAfterMs) return;
    freshRunningProofs.push({ at, ...(turnId ? { turnId } : {}) });
  };

  const scopedEvents = session ? (input.events ?? []).filter((event) => event.harness === session.harness && event.sessionId === session.id) : [];
  if (session?.status === "running") freshProof(session.lastActivity, currentTurnId);
  if (input.lifecycle?.state === "running") freshProof(input.lifecycle.at, currentTurnId);
  for (const event of scopedEvents) {
    if (event.kind === "turn.started") freshProof(event.at, dataString(event.data, "turnId"));
  }
  const sessionTerminalAt = session && (session.status === "stopped" || session.status === "error") ? toEpoch(session.lastActivity) : undefined;

  if (session) {
    const at = session.lastActivity;
    if (session.status === "running") add({ state: "active_progress", source: "session-snapshot", at,
      ...(currentTurnId ? { turnId: currentTurnId } : {}), reason: "native session snapshot reports running", priority: 40 });
    else if (session.status === "stopped" || session.status === "error") add({ state: "terminal", source: "session-status", at,
      reason: `session status is ${session.status}`, priority: 70 });
    else if (session.status === "needs_input") {
      if (session.needsPermission && session.permissionDetails?.id) add({ state: "externally_waiting", source: "session-permission-snapshot", at,
        receiptId: session.permissionDetails.id, reason: "native session awaits permission", priority: 80 });
      else add({ state: "unknown", source: "session-snapshot", at, reason: "session needs input but no typed permission receipt is available", priority: 20 });
    } else if (session.status === "idle") add({ state: "unknown", source: "session-snapshot", at,
      reason: "native session snapshot reports idle", priority: 20 });
  }

  const lifecycle = input.lifecycle;
  if (lifecycle) add({ state: lifecycle.state === "ended" ? "terminal" : lifecycle.state === "running" ? "active_progress" : "unknown",
    source: "lifecycle-hook", at: lifecycle.at, ...(currentTurnId && lifecycle.state === "running" ? { turnId: currentTurnId } : {}),
    reason: lifecycle.state === "running" ? "native lifecycle reports running" : `native lifecycle reports ${lifecycle.state}`,
    priority: lifecycle.state === "ended" ? 70 : lifecycle.state === "running" ? 40 : 20 });

  if (session) {
    for (const message of input.details?.messages ?? []) {
      const messageAt = toEpoch(message.timestamp);
      if (messageAt === undefined || messageAt - input.now > allowedFutureSkewMs || input.now - messageAt > input.staleAfterMs) continue;
      if (sessionTerminalAt !== undefined && session.status !== "running" && sessionTerminalAt >= messageAt) continue;
      const compatibleProof = freshRunningProofs.some((proof) => {
        if (sessionTerminalAt !== undefined && session.status !== "running" && proof.at <= sessionTerminalAt) return false;
        if (proof.turnId) return message.turnId === proof.turnId;
        return Math.abs(messageAt - proof.at) <= allowedFutureSkewMs;
      });
      if (compatibleProof) addMessage(candidates, message, input.now, allowedFutureSkewMs);
    }
    for (const event of scopedEvents) {
      if (!event.at) continue;
      const turnId = dataString(event.data, "turnId");
      if (event.kind === "turn.started") add({ state: "active_progress", source: "harness-event", at: event.at,
        receiptId: event.messageId, turnId, reason: "native turn.started event observed", priority: 60 });
      else if (event.kind === "turn.completed" || event.kind === "turn.failed" || event.kind === "session.deleted") add({ state: "terminal", source: "harness-event", at: event.at,
        receiptId: event.messageId, turnId, reason: `native ${event.kind} event observed`, priority: 70 });
      else if (event.kind === "permission.requested") add({ state: "externally_waiting", source: "harness-event", at: event.at,
        receiptId: event.permissionId, turnId, reason: "native permission request is pending", priority: 80 });
    }
    for (const job of input.jobs ?? []) {
      if (job.ownerSessionId !== session.id) continue;
      if (job.state === "queued") add({ state: "queued", source: "herder-job", at: job.updatedAt,
        receiptId: job.id, reason: "durable Herder job is queued", priority: 50 });
      else if (job.state === "running") add({ state: "active_progress", source: "herder-job", at: job.updatedAt,
        receiptId: job.id, reason: job.statusMessage || "durable Herder job is running", priority: 45 });
    }
  }

  if (input.externalWait) add({ state: "externally_waiting", source: `external-${input.externalWait.kind}`, at: input.externalWait.observedAt,
    receiptId: input.externalWait.receiptId, turnId: input.externalWait.turnId, reason: input.externalWait.reason, priority: 80 });
  if (input.blocked) add({ state: "blocked", source: "explicit-block", at: input.blocked.observedAt,
    receiptId: input.blocked.receiptId, turnId: input.blocked.turnId, reason: input.blocked.reason, priority: 85 });

  if (!candidates.length) {
    const rejectedReason = rejectedReasons.includes("evidence timestamp is in the future") ? "evidence timestamp is in the future" : undefined;
    const hasTimestampedInput = Boolean(session || lifecycle || input.events?.length || input.jobs?.length || input.externalWait || input.blocked);
    return { state: "unknown", reason: rejectedReason ?? (hasTimestampedInput ? "no usable timestamped evidence" : "no progress evidence") };
  }

  candidates.sort((a, b) => {
    const timeDelta = b.at - a.at;
    const aCurrent = Boolean(currentTurnId && a.turnId === currentTurnId);
    const bCurrent = Boolean(currentTurnId && b.turnId === currentTurnId);
    if (Math.abs(timeDelta) <= allowedFutureSkewMs && a.turnId && b.turnId && a.turnId !== b.turnId && aCurrent !== bCurrent) return aCurrent ? -1 : 1;
    return timeDelta || b.priority - a.priority;
  });
  const selected = candidates[0]!;
  const ageMs = Math.max(0, input.now - selected.at);
  const state = selected.state === "active_progress" && ageMs > input.staleAfterMs ? "stale_running" : selected.state;
  return { state, source: selected.source, observedAt: new Date(selected.at).toISOString(),
    ...(selected.receiptId ? { receiptId: selected.receiptId } : {}), ...(selected.turnId ? { turnId: selected.turnId } : {}),
    reason: state === "stale_running" ? "running evidence is stale" : selected.reason, ageMs };
}

function addMessage(candidates: Candidate[], message: SessionMessageView, now: number, futureSkew: number): void {
  if (!message.timestamp || (message.role !== "assistant" && message.role !== "tool")) return;
  const at = toEpoch(message.timestamp);
  if (at === undefined || at - now > futureSkew) return;
  const hasToolOutput = message.parts.some((part) => part.type === "tool_result");
  candidates.push({ state: "active_progress", source: "native-message", at, receiptId: message.id, turnId: message.turnId,
    reason: hasToolOutput ? "native tool output observed" : "native assistant message observed", priority: 60 });
}

function toEpoch(value: string | number | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? epoch : undefined;
}

function dataString(data: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = data?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
