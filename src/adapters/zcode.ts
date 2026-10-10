import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import {
  type AgentSession,
  type ControlResult,
  type CreateSessionOptions,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessEvent,
  type ListSessionsOptions,
  type RawTranscriptExport,
  type SendMessageResult,
  type SendMessageOptions,
  type MessageAdmissionResult,
  type SessionSnapshotReceipt,
  type SessionMessagePart,
  type SessionMessageView,
  type SetPermissionsOptions,
} from "../types/index.js";
import { ZcodeAppServerClient, type ZcodeClientLike } from "./zcode-protocol.js";
import { readExistingZcodeRuntimeObservation } from "./zcode-runtime-observation.js";
import { lifecycleEntryFor, lifecycleStateFor, type SessionLifecycleSnapshot } from "../session-lifecycle.js";
import { getHumanStopStore } from "../human-stop-store.js";

interface ZcodeWorkspaceRef {
  workspacePath: string;
  workspaceIdentity: string;
  /** Current zcode-server builds validate this key; older ones used workspaceIdentity. */
  workspaceKey: string;
}

interface ZcodeModelRef {
  providerId: string;
  modelId: string;
  options?: {
    reasoningLevel?: string;
  };
}

interface ZcodeLocalConfig {
  model?: Record<string, unknown>;
  provider?: Record<string, {
    name?: string;
    models?: Record<string, unknown>;
  }>;
}

interface ZcodeSessionInfo {
  sessionId: string;
  workspace?: { workspacePath?: string; workspaceIdentity?: string };
  parentSessionId?: string;
  traceId?: string;
  sessionKind?: string;
  title?: string;
  mode?: string;
  status?: string;
  model?: ZcodeModelRef;
  createdAt?: number | string;
  updatedAt?: number | string;
}

const HEALTH_SESSION_TOOL_ALLOWLIST = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"] as const;

interface ZcodeMessage {
  info?: {
    messageId?: string;
    parentMessageId?: string;
    role?: string;
    time?: { created?: number | string };
    metadata?: Record<string, unknown>;
    semantics?: { origin?: string; kind?: string; source?: string };
    source?: string;
    synthetic?: boolean;
    visibility?: string;
    cost?: number;
  };
  parts?: Array<Record<string, unknown>>;
}

interface ZcodeSessionEvent {
  eventId?: string;
  sessionId?: string;
  turnId?: string;
  seq?: number;
  timestamp?: number | string;
  type?: string;
  payload?: Record<string, unknown>;
}

interface AutomationStopMarker {
  id: string;
  at: string;
  reason: "cancelled";
  turnId?: string;
}

interface LatestUserPrompt {
  id: string;
  at: string;
  turnId?: string;
  text?: string;
}

interface UserPromptCandidate extends LatestUserPrompt {
  seq?: number;
}

interface ZcodeSnapshot {
  session?: ZcodeSessionInfo;
  settings?: {
    model?: {
      current?: ZcodeModelRef;
      available?: Array<ZcodeModelRef | string>;
    };
    permission?: { mode?: string; rulesRevision?: number };
  };
  runtime?: { eventSeq?: number; stateRevision?: number; pendingRequestIds?: string[] };
  messages?: ZcodeMessage[];
}

interface TurnStartResult {
  ok: boolean;
  error?: string;
  pending?: boolean;
  turnId?: string;
}

interface NativeTurnFailure {
  code?: string;
  message?: string;
}

interface ZcodeCommand {
  command: string;
  args: string[];
}

export interface ZcodeAdapterOptions {
  /** Override the stdio app-server executable, primarily for tests. */
  command?: string;
  args?: string[];
  cwd?: string;
  modelIds?: string[];
  /** Inject a transport in tests or when embedding agent-herder. */
  client?: ZcodeClientLike;
  /** Optional persisted cross-workspace task index; injectable for tests. */
  tasksIndexDbPath?: string;
  /** Optional native session database; injectable for persisted identity tests. */
  localDbPath?: string;
  /** Bound for proving that an admitted prompt actually began a native turn. */
  turnStartTimeoutMs?: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function nativePermissionMode(snapshot: unknown): string | undefined {
  return nonEmptyString(record(record(record(snapshot).settings).permission).mode);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function timestamp(value: unknown, fallback = Date.now()): string {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(fallback).toISOString();
}

function exactTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return new Date(value).toISOString();
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return undefined;
}

const AGENT_HERDER_AUTOMATION_INPUT_PREFIX = "agent-herder:auto:";
const MAX_LATEST_USER_PROMPT_TEXT_LENGTH = 100_000;

function zcodeInputId(inputId: string, origin: "human" | "automation"): string {
  if (origin === "human" || inputId.startsWith(AGENT_HERDER_AUTOMATION_INPUT_PREFIX)) return inputId;
  return `${AGENT_HERDER_AUTOMATION_INPUT_PREFIX}${inputId}`;
}

function modelName(model: ZcodeModelRef | undefined): string | undefined {
  if (!model?.providerId || !model.modelId) return undefined;
  const reasoningLevel = model.options?.reasoningLevel;
  return `${model.providerId}/${model.modelId}${reasoningLevel ? `$${reasoningLevel}` : ""}`;
}

function modelNameFromCatalogEntry(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const entry = record(value);
  const ref = record(entry.ref) as unknown as ZcodeModelRef;
  return modelName(ref) || nonEmptyString(entry.label);
}

function parseModelName(value: string, currentProviderId?: string): ZcodeModelRef | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const separator = trimmed.indexOf("/");
  if (separator > 0) {
    const providerId = trimmed.slice(0, separator).trim();
    const modelAndReasoning = trimmed.slice(separator + 1);
    const reasoningSeparator = modelAndReasoning.indexOf("$");
    return {
      providerId,
      modelId: reasoningSeparator >= 0 ? modelAndReasoning.slice(0, reasoningSeparator) : modelAndReasoning,
      ...(reasoningSeparator >= 0 ? { options: { reasoningLevel: modelAndReasoning.slice(reasoningSeparator + 1) } } : {}),
    };
  }
  if (!currentProviderId) return undefined;
  return { providerId: currentProviderId, modelId: trimmed };
}

export function zcodeConfiguredModels(config: ZcodeLocalConfig): string[] {
  const result = Object.values(config.model ?? {})
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  for (const [providerId, provider] of Object.entries(config.provider ?? {})) {
    const alias = provider.name?.trim() || providerId;
    for (const modelId of Object.keys(provider.models ?? {})) {
      result.push(`${alias}/${modelId}`);
    }
  }
  return [...new Set(result)];
}

export function resolveConfiguredZcodeModel(value: string, config: ZcodeLocalConfig): ZcodeModelRef | undefined {
  const separator = value.indexOf("/");
  if (separator <= 0) return undefined;
  const providerAlias = value.slice(0, separator).trim();
  const modelAndReasoning = value.slice(separator + 1);
  const reasoningSeparator = modelAndReasoning.indexOf("$");
  const modelId = reasoningSeparator >= 0 ? modelAndReasoning.slice(0, reasoningSeparator) : modelAndReasoning;
  for (const [providerId, provider] of Object.entries(config.provider ?? {})) {
    if (providerId !== providerAlias && provider.name?.trim().toLowerCase() !== providerAlias.toLowerCase()) continue;
    if (!Object.hasOwn(provider.models ?? {}, modelId)) continue;
    return {
      providerId,
      modelId,
      ...(reasoningSeparator >= 0 ? { options: { reasoningLevel: modelAndReasoning.slice(reasoningSeparator + 1) } } : {}),
    };
  }
  return undefined;
}

function mapStatus(status: unknown): AgentSession["status"] {
  switch (status) {
    case "running": return "running";
    case "waiting": return "needs_input";
    case "error": return "error";
    case "completed": return "stopped";
    case "paused":
    case "idle":
    default: return "idle";
  }
}

function textFromMessage(message: ZcodeMessage): string {
  return (message.parts ?? [])
    .filter((part) => part.type === "text" || part.type === "reasoning")
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("");
}

function hasActiveToolCall(messages: ZcodeMessage[]): boolean {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (record(messages[index]?.info).role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  const currentTurn = messages.slice(latestUserIndex + 1);
  return currentTurn.some((message) => (message.parts ?? []).some((part) => {
    if (part.type !== "tool") return false;
    const status = nonEmptyString(record(part.state).status)?.toLowerCase();
    return status === "running" || status === "pending" || status === "in_progress" || status === "in-progress";
  }));
}

function isInactiveSessionError(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value ?? "");
  return /\bSession (?:is not active|not found):/i.test(message) || /\bnot active\b/i.test(message);
}

function terminalInactiveResult(sessionId: string, cause: unknown): { ok: false; error: string } {
  const message = cause instanceof Error ? cause.message : String(cause ?? "unknown native error");
  return {
    ok: false,
    error: `ZCode terminal inactive: session ${sessionId} could not be reattached by native resume (${message})`,
  };
}

function mapMessagePart(part: Record<string, unknown>): SessionMessagePart[] {
  if (part.type === "text" && typeof part.text === "string") {
    return [{ type: "text", text: part.text }];
  }
  if (part.type === "reasoning" && typeof part.text === "string") {
    return [{ type: "thinking", text: part.text }];
  }
  if (part.type === "tool") {
    const state = record(part.state);
    const input = state.input;
    const name = typeof part.tool === "string" ? part.tool : undefined;
    const result: SessionMessagePart[] = [{ type: "tool_call", name, input }];
    if (state.status === "completed" && typeof state.output === "string") {
      result.push({ type: "tool_result", name, output: state.output });
    } else if (state.status === "error" && typeof state.error === "string") {
      result.push({ type: "tool_result", name, output: state.error, error: true });
    }
    return result;
  }
  return [];
}

function mapMessage(message: ZcodeMessage, index: number): SessionMessageView {
  const info = record(message.info);
  const role = info.role === "user" || info.role === "assistant" ? info.role : "assistant";
  const id = nonEmptyString(info.messageId) || `zcode-message-${index + 1}`;
  const parts = (message.parts ?? []).flatMap(mapMessagePart);
  const text = textFromMessage(message);
  return {
    id,
    role,
    timestamp: timestamp(record(info.time).created),
    text: text || undefined,
    parts,
  };
}

function sessionEventsFromPayload(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload.filter((event): event is Record<string, unknown> => Boolean(event) && typeof event === "object");
  const events = record(payload).events;
  return Array.isArray(events)
    ? events.filter((event): event is Record<string, unknown> => Boolean(event) && typeof event === "object")
    : [];
}

function nativeSessionEvent(value: unknown): Record<string, unknown> | undefined {
  const root = record(value);
  if (root.type === "session.event" && root.event && typeof root.event === "object") return record(root.event);
  return typeof root.type === "string" && typeof root.eventId === "string" ? root : undefined;
}

function safeNativeFailureField(value: unknown, maxLength: number): string | undefined {
  const raw = nonEmptyString(value);
  if (!raw) return undefined;
  const redacted = raw
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b(?:sk|ghp|glpat|xox[baprs])-[-A-Za-z0-9_]{12,}\b/gi, "[redacted-secret]")
    .replace(/(["'])(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|credential)\1\s*:\s*(["'])[^"'\r\n]*\3/gi, "$1$2$1:$3[redacted]$3")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|credential)\s*[:=]\s*([^\s,;]+)/gi, "$1=[redacted]")
    .replace(/([?&](?:token|key|secret|password|signature)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!redacted) return undefined;
  return redacted.length > maxLength ? `${redacted.slice(0, Math.max(0, maxLength - 3))}...` : redacted;
}

function nativeFailureCode(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return nonEmptyString(value);
}

function nativeTurnFailure(value: unknown): NativeTurnFailure | undefined {
  const envelope = record(value);
  const root = nativeSessionEvent(value) || envelope;
  const payload = record(root.payload);
  const errorValue = payload.error ?? root.error ?? envelope.error;
  const error = record(errorValue);
  const code = safeNativeFailureField(
    nativeFailureCode(error.code)
      || nativeFailureCode(error.type)
      || nativeFailureCode(error.name)
      || nativeFailureCode(payload.errorCode)
      || nativeFailureCode(root.errorCode),
    96,
  );
  const message = safeNativeFailureField(
    typeof errorValue === "string"
      ? errorValue
      : nonEmptyString(error.message)
        || nonEmptyString(payload.errorMessage)
        || nonEmptyString(root.errorMessage),
    384,
  );
  return code || message ? { ...(code ? { code } : {}), ...(message ? { message } : {}) } : undefined;
}

function nativeTurnFailureDetail(value: unknown): string | undefined {
  const failure = nativeTurnFailure(value);
  if (!failure) return undefined;
  if (failure.code && failure.message) return `[${failure.code}] ${failure.message}`;
  return failure.message || `[${failure.code}]`;
}

function admittedNativeTurnFailure(sessionId: string, value: unknown): string {
  const detail = nativeTurnFailureDetail(value);
  return `ZCode принял запрос для ${sessionId}, но выполнение завершилось ошибкой.${detail ? ` Native failure: ${detail}` : ""}`;
}

function automationStopFromEvent(value: unknown): (AutomationStopMarker & { seq?: number }) | undefined {
  const event = nativeSessionEvent(value);
  if (!event || event.type !== "turn.completed") return undefined;
  if (record(event.payload).resultType !== "cancelled") return undefined;
  const id = nonEmptyString(event.eventId);
  const at = exactTimestamp(event.timestamp);
  if (!id || !at) return undefined;
  const turnId = nonEmptyString(event.turnId);
  const seq = typeof event.seq === "number" && Number.isInteger(event.seq) && event.seq >= 0 ? event.seq : undefined;
  return { id, at, reason: "cancelled", ...(turnId ? { turnId } : {}), ...(seq !== undefined ? { seq } : {}) };
}

function userPromptCandidate(message: ZcodeMessage, events: Array<Record<string, unknown>>): UserPromptCandidate | undefined {
  const info = record(message.info);
  const semantics = record(info.semantics);
  const metadata = record(info.metadata);
  const inputId = nonEmptyString(metadata.inputId);
  const id = nonEmptyString(info.messageId);
  const start = id ? events.map(nativeSessionEvent).find((event) => {
    const payload = record(event?.payload);
    return event?.type === "turn.started" && nonEmptyString(payload.messageId) === id;
  }) : undefined;
  const startPayload = record(start?.payload);
  const originMeta = record(startPayload.originMeta);
  if (info.role !== "user"
    || semantics.origin !== "real_user"
    || semantics.kind !== "user_prompt"
    || info.synthetic === true
    || info.visibility === "model-only"
    || nonEmptyString(info.source)
    || nonEmptyString(metadata.automationId)
    || nonEmptyString(metadata.offPeakTaskId)
    || nonEmptyString(startPayload.inputSource)
    || nonEmptyString(originMeta.automationId)
    || nonEmptyString(originMeta.offPeakTaskId)
    || (inputId && inputId.startsWith(AGENT_HERDER_AUTOMATION_INPUT_PREFIX))) return undefined;
  const at = exactTimestamp(record(info.time).created);
  if (!id || !at) return undefined;
  const seq = typeof start?.seq === "number" && Number.isInteger(start.seq) && start.seq >= 0 ? start.seq : undefined;
  const turnId = nonEmptyString(start?.turnId) || nonEmptyString(metadata.turnId);
  const text = textFromMessage(message);
  return {
    id,
    at,
    ...(turnId ? { turnId } : {}),
    ...(text.length <= MAX_LATEST_USER_PROMPT_TEXT_LENGTH ? { text } : {}),
    ...(seq !== undefined ? { seq } : {}),
  };
}

function latestExplicitUserPrompt(
  messages: ZcodeMessage[],
  events: Array<Record<string, unknown>>,
  generatedMessageIds: ReadonlySet<string> = new Set(),
): (LatestUserPrompt & { seq?: number }) | undefined {
  for (const message of [...messages].reverse()) {
    const candidate = userPromptCandidate(message, events);
    if (candidate && !generatedMessageIds.has(candidate.id)) {
      return candidate;
    }
  }
  return undefined;
}

function currentAutomationStop(events: Array<Record<string, unknown>>, latestPrompt?: LatestUserPrompt & { seq?: number }): AutomationStopMarker | undefined {
  for (const rawEvent of [...events].reverse()) {
    const marker = automationStopFromEvent(rawEvent);
    if (!marker) continue;
    const nativeSeq = (marker as AutomationStopMarker & { seq?: number }).seq;
    if (latestPrompt && ((nativeSeq !== undefined && latestPrompt.seq !== undefined && latestPrompt.seq > nativeSeq)
      || (latestPrompt.seq === undefined && Date.parse(latestPrompt.at) > Date.parse(marker.at)))) return undefined;
    const { seq: _seq, ...publicMarker } = marker as AutomationStopMarker & { seq?: number };
    return publicMarker;
  }
  return undefined;
}

function sessionInfoFromPayload(payload: unknown): ZcodeSessionInfo | undefined {
  const root = record(payload);
  const nested = record(root.session);
  const source = Object.keys(nested).length > 0 ? nested : root;
  const sessionId = nonEmptyString(source.sessionId);
  return sessionId ? {
    sessionId,
    workspace: record(source.workspace) as ZcodeSessionInfo["workspace"],
    parentSessionId: nonEmptyString(source.parentSessionId),
    traceId: nonEmptyString(source.traceId),
    sessionKind: nonEmptyString(source.sessionKind),
    title: typeof source.title === "string" ? source.title : undefined,
    mode: typeof source.mode === "string" ? source.mode : undefined,
    status: typeof source.status === "string" ? source.status : undefined,
    model: record(source.model) as unknown as ZcodeModelRef,
    createdAt: typeof source.createdAt === "number" || typeof source.createdAt === "string" ? source.createdAt : undefined,
    updatedAt: typeof source.updatedAt === "number" || typeof source.updatedAt === "string" ? source.updatedAt : undefined,
  } : undefined;
}

function mapSession(
  payload: unknown,
  fallbackCwd: string,
  fallbackTitle?: string,
  nativeEvents: Array<Record<string, unknown>> = [],
  nativeEventHistoryAvailable = false,
): AgentSession {
  const root = record(payload);
  const session = sessionInfoFromPayload(payload);
  if (!session) throw new Error("ZCode returned a session payload without sessionId");
  const workspace = record(session.workspace);
  const cwd = nonEmptyString(workspace.workspacePath) || fallbackCwd;
  const snapshot = root as ZcodeSnapshot;
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  const views = messages.map(mapMessage);
  const lastMessage = [...views].reverse().find((message) => message.text)?.text;
  const createdAt = typeof session.createdAt === "number" ? session.createdAt : Date.parse(String(session.createdAt ?? ""));
  const updatedAt = typeof session.updatedAt === "number" ? session.updatedAt : Date.parse(String(session.updatedAt ?? ""));
  const durationSec = Number.isFinite(createdAt) && Number.isFinite(updatedAt) && updatedAt >= createdAt
    ? (updatedAt - createdAt) / 1000
    : undefined;
  const pendingRequestIds = Array.isArray(record(root.runtime).pendingRequestIds)
    ? (record(root.runtime).pendingRequestIds as unknown[]).filter((id): id is string => typeof id === "string")
    : [];
  const costUsd = messages.reduce((sum, message) => sum + (typeof record(message.info).cost === "number" ? record(message.info).cost as number : 0), 0);
  const latestUserPrompt = latestExplicitUserPrompt(messages, nativeEvents);
  const automationStop = currentAutomationStop(nativeEvents, latestUserPrompt);
  const automationStopSequence = automationStop
    ? nativeEvents.map(nativeSessionEvent).find((event) => event?.eventId === automationStop.id)?.seq
    : undefined;
  const meta: Record<string, unknown> = {
    sessionKind: session.sessionKind,
    mode: session.mode,
    permissionMode: nonEmptyString(record(record(root.settings).permission).mode),
    permissionRulesRevision: typeof record(record(root.settings).permission).rulesRevision === "number"
      ? record(record(root.settings).permission).rulesRevision
      : undefined,
    traceId: session.traceId,
    parentSessionId: session.parentSessionId,
    workspaceIdentity: nonEmptyString(workspace.workspaceIdentity),
    pendingRequestIds,
    automationStop,
    automationStopSequence: typeof automationStopSequence === "number" ? automationStopSequence : undefined,
    automationStopHistoryAvailable: nativeEventHistoryAvailable,
    latestUserPrompt: latestUserPrompt ? {
      id: latestUserPrompt.id,
      at: latestUserPrompt.at,
      ...(latestUserPrompt.turnId ? { turnId: latestUserPrompt.turnId } : {}),
      ...(latestUserPrompt.text !== undefined ? { text: latestUserPrompt.text } : {}),
    } : undefined,
    latestUserPromptSequence: latestUserPrompt?.seq,
  };
  const rawStatus = mapStatus(session.status);
  // Preferred source: the hook-fed lifecycle registry observes real session
  // events (start/turn boundaries/end). Fallback: updatedAt recency, because
  // the tasks-index-backed status is stale for interactive TUI sessions —
  // it reports "idle" while a turn is literally executing (verified
  // 2026-09-05: live sessions at updatedAt age 5-78s vs a 1.6h gap to the
  // next one).
  const activeWindowMs = Number(process.env.AGENT_HERDER_ACTIVE_WINDOW_MS || 5 * 60 * 1000);
  const recentlyActive = Number.isFinite(updatedAt) && updatedAt > 0 && Date.now() - updatedAt < activeWindowMs;
  const recencyStatus = recentlyActive && !["stopped", "error", "archived", "needs_input"].includes(rawStatus)
    ? "running"
    : rawStatus;
  const lifecycle = lifecycleStateFor("zcode", session.sessionId);
  meta.hasActiveToolCall = lifecycle === "running" && hasActiveToolCall(messages);
  const status = pendingRequestIds.length > 0 ? "needs_input"
    : lifecycle === "ended" ? "stopped"
    : lifecycle === "running" ? "running"
    : lifecycle === "idle" ? "idle"
    : recencyStatus;
  return {
    id: session.sessionId,
    harness: "zcode",
    status,
    title: session.title || fallbackTitle || "Untitled ZCode session",
    cwd,
    lastActivity: timestamp(session.updatedAt ?? session.createdAt),
    model: modelName(session.model),
    needsPermission: pendingRequestIds.length > 0,
    messageCount: messages.length || undefined,
    costUsd: costUsd || undefined,
    durationSec,
    lastMessage,
    meta,
  };
}

function snapshotMessages(payload: unknown): ZcodeMessage[] {
  if (Array.isArray(payload)) return payload as ZcodeMessage[];
  const root = record(payload);
  if (Array.isArray(root.messages)) return root.messages as ZcodeMessage[];
  return [];
}

function snapshotConfirmsPromptTurnStarted(
  current: ZcodeSnapshot,
  baseline: ZcodeSnapshot,
  inputId: string,
  message: string,
  acceptedStateRevision: number | undefined,
): boolean {
  const currentRevision = current.runtime?.stateRevision;
  if (acceptedStateRevision !== undefined && currentRevision !== undefined && currentRevision < acceptedStateRevision) return false;

  const beforeMessages = baseline.messages ?? [];
  const messages = current.messages ?? [];
  const previousUserId = [...beforeMessages].reverse()
    .find((candidate) => record(candidate.info).role === "user");
  const previousUserMessageId = nonEmptyString(record(previousUserId?.info).messageId);
  const userMessage = [...messages].reverse().find((candidate) => {
    const info = record(candidate.info);
    if (info.role !== "user") return false;
    const messageId = nonEmptyString(info.messageId);
    if (!messageId || messageId === previousUserMessageId) return false;
    const metadataInputId = nonEmptyString(record(info.metadata).inputId);
    return metadataInputId ? metadataInputId === inputId : textFromMessage(candidate) === message;
  });
  if (!userMessage) return false;

  const userMessageId = nonEmptyString(record(userMessage.info).messageId);
  if (!userMessageId) return false;
  return messages.some((candidate) => {
    const info = record(candidate.info);
    return info.role === "assistant" && nonEmptyString(info.parentMessageId) === userMessageId;
  });
}

function normalizeZcodeTaskEvent(sessionId: string, payload: unknown): HarnessEvent | null {
  const envelope = record(payload);
  if (envelope.type === "snapshot") return null;
  const rawNativeEvent = nativeSessionEvent(payload);
  const root = rawNativeEvent || envelope;
  const nativeType = nonEmptyString(root.type) || "task.event";
  const lower = nativeType.toLowerCase();
  let kind: HarnessEvent["kind"];
  let status: AgentSession["status"] | undefined;
  if (/(task|turn).*(start|running|begin)/.test(lower)) { kind = "turn.started"; status = "running"; }
  else if (/(task|turn).*(complete|success|finish|done)/.test(lower)) { kind = "turn.completed"; status = "idle"; }
  else if (/(task|turn).*(error|fail)/.test(lower)) { kind = "turn.failed"; status = "error"; }
  else if (/permission.*(request|ask|pending)|elicitation.*request/.test(lower)) { kind = "permission.requested"; status = "needs_input"; }
  else if (/permission.*(response|resolve)|elicitation.*response/.test(lower)) { kind = "permission.resolved"; status = "running"; }
  else if (/message|text|reasoning|tool|delta|stream/.test(lower)) kind = "message.updated";
  else if (/session.*(closed|deleted)/.test(lower)) kind = "session.deleted";
  else kind = "session.updated";
  const payloadData = record(root.payload);
  const failure = kind === "turn.failed" ? nativeTurnFailure(payload) : undefined;
  const inputId = nonEmptyString(root.inputId) || nonEmptyString(payloadData.inputId) || nonEmptyString(envelope.inputId);
  const resultType = nonEmptyString(payloadData.resultType) || nonEmptyString(envelope.stopReason);
  const exactStop = rawNativeEvent ? automationStopFromEvent({ type: "session.event", event: rawNativeEvent }) : undefined;
  const legacyStopAt = exactTimestamp(envelope.timestamp);
  const legacyStopId = nonEmptyString(envelope.eventId) || nonEmptyString(envelope.turnId) || nonEmptyString(envelope.traceId) || inputId;
  const legacyStop = !rawNativeEvent && kind === "turn.completed" && resultType === "cancelled" && legacyStopAt && legacyStopId
    ? { id: legacyStopId, at: legacyStopAt, reason: "cancelled" as const, ...(nonEmptyString(envelope.turnId) ? { turnId: nonEmptyString(envelope.turnId) } : {}) }
    : undefined;
  const automationStop: AutomationStopMarker | undefined = exactStop
    ? { id: exactStop.id, at: exactStop.at, reason: exactStop.reason, ...(exactStop.turnId ? { turnId: exactStop.turnId } : {}) }
    : legacyStop;
  const eventTimestamp = rawNativeEvent?.timestamp ?? envelope.timestamp;
  const at = exactTimestamp(eventTimestamp) || new Date().toISOString();
  return {
    kind,
    harness: "zcode",
    sessionId,
    nativeType,
    status: automationStop ? "stopped" : status,
    at,
    data: {
      nativeType,
      ...(inputId ? { inputId } : {}),
      ...(resultType ? { nativeResultType: resultType } : {}),
      ...(nonEmptyString(rawNativeEvent?.eventId) ? { nativeEventId: nonEmptyString(rawNativeEvent?.eventId) } : {}),
      ...(nonEmptyString(rawNativeEvent?.turnId) || nonEmptyString(envelope.turnId)
        ? { turnId: nonEmptyString(rawNativeEvent?.turnId) || nonEmptyString(envelope.turnId) }
        : {}),
      ...(rawNativeEvent && typeof rawNativeEvent.seq === "number" ? { nativeEventSeq: rawNativeEvent.seq } : {}),
      ...(automationStop ? { automationStop } : {}),
      ...(nonEmptyString(payloadData.inputSource) ? { inputSource: nonEmptyString(payloadData.inputSource) } : {}),
      ...(nonEmptyString(payloadData.messageId) ? { messageId: nonEmptyString(payloadData.messageId) } : {}),
      ...(failure?.code ? { nativeErrorCode: failure.code } : {}),
      ...(failure?.message ? { nativeErrorMessage: failure.message } : {}),
    },
  };
}

function unsupported(operation: string): ControlResult {
  return { ok: false, error: `ZCode Protocol operation '${operation}' is not supported by the native app-server` };
}

export interface NativeTurnUsageRow {
  sessionId: string;
  turnId?: string;
  userMessageId?: string | null;
  status?: string;
  startedAt?: number;
  firstModelStartAt?: number | null;
  firstTokenAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
  toolCallCount?: number | null;
  retryable?: number | null;
  cancelledByUser?: number | null;
  contextExceeded?: number | null;
  errorType?: string | null;
  errorCode?: string | null;
}

export interface NativeLastTurn {
  turnId?: string;
  status?: string;
  userMessageId?: string;
  startedAt?: number;
  completedAt?: number;
  firstModelStartAt?: number;
  firstTokenAt?: number;
  durationMs?: number;
  toolCallCount?: number;
  retryable?: boolean;
  cancelledByUser?: boolean;
  contextExceeded?: boolean;
  errorType?: string;
  errorCode?: string;
  rootSession?: boolean;
  pendingInput?: boolean;
  userMessageMatchesLatest?: boolean;
  assistantSucceeded?: boolean;
  progressedAfterFailure?: boolean;
  requiresHuman?: boolean;
  blockedReason?: string;
  /** A remote SSH task still expected to run, but its exact latest turn was cancelled without a durable human-stop receipt. */
  transportLost?: boolean;
}

/** Latest durable turn for one session, or undefined when the rows are stale
 * against a newer unconsumed user input. Deterministic on (startedAt,
 * completedAt, turnId) so duplicate timestamps cannot flip the winner.
 * Pure: the launcher must be able to reason about this without the DB. */
export function pickNativeLastTurn(rows: NativeTurnUsageRow[], lastInputAt?: number): NativeLastTurn | undefined {
  if (rows.length === 0) return undefined;
  let latest = rows[0]!;
  for (const row of rows.slice(1)) {
    const cl = latest.startedAt ?? 0, cc = latest.completedAt ?? 0;
    const rl = row.startedAt ?? 0, rc = row.completedAt ?? 0;
    if (rl > cl || (rl === cl && (rc > cc || (rc === cc && (row.turnId ?? "") > (latest.turnId ?? ""))))) latest = row;
  }
  const boundary = Math.max(latest.startedAt ?? 0, latest.completedAt ?? 0);
  if (typeof lastInputAt === "number" && lastInputAt > boundary) return undefined;
  return {
    ...(latest.turnId ? { turnId: latest.turnId } : {}),
    ...(latest.status ? { status: latest.status } : {}),
    ...(latest.userMessageId ? { userMessageId: latest.userMessageId } : {}),
    ...(typeof latest.startedAt === "number" && latest.startedAt > 0 ? { startedAt: latest.startedAt } : {}),
    ...(typeof latest.completedAt === "number" && latest.completedAt > 0 ? { completedAt: latest.completedAt } : {}),
    ...(typeof latest.firstModelStartAt === "number" && latest.firstModelStartAt > 0 ? { firstModelStartAt: latest.firstModelStartAt } : {}),
    ...(typeof latest.firstTokenAt === "number" && latest.firstTokenAt > 0 ? { firstTokenAt: latest.firstTokenAt } : {}),
    ...(typeof latest.durationMs === "number" && latest.durationMs > 0 ? { durationMs: latest.durationMs } : {}),
    ...(typeof latest.toolCallCount === "number" && latest.toolCallCount > 0 ? { toolCallCount: latest.toolCallCount } : {}),
    ...(latest.retryable === 0 || latest.retryable === 1 ? { retryable: latest.retryable === 1 } : {}),
    ...(latest.cancelledByUser === 0 || latest.cancelledByUser === 1 ? { cancelledByUser: latest.cancelledByUser === 1 } : {}),
    ...(latest.contextExceeded === 0 || latest.contextExceeded === 1 ? { contextExceeded: latest.contextExceeded === 1 } : {}),
    ...(latest.errorType ? { errorType: latest.errorType } : {}),
    ...(latest.errorCode ? { errorCode: latest.errorCode } : {}),
  };
}

export interface PersistedZcodeStatusInput {
  rawStatus?: string;
  /** tasks-index updated_at in epoch ms. */
  tasksUpdatedAt: number;
  /** Native session DB time_updated in epoch ms; refreshed on every runtime
   * write, so a running turn keeps it current even when the tasks-index row
   * froze at prompt-submit time. */
  nativeUpdatedAt?: number;
  /** Hook-fed observed lifecycle, when the daemon has seen an event for this session. */
  lifecycle?: SessionLifecycleSnapshot;
  now: number;
  activeWindowMs: number;
}

/** Status for tasks-index-discovered sessions. Precedence: runtime error and
 * waiting states first, then hook-observed lifecycle while it is at least as
 * fresh as the last native write, then native/tasks recency ("writing right
 * now"), then the persisted task status. */
export function resolvePersistedZcodeStatus(input: PersistedZcodeStatusInput): AgentSession["status"] {
  const raw = input.rawStatus?.toLowerCase();
  if (raw === "error") return "error";
  if (raw === "waiting" || raw === "needs_input") return "needs_input";
  const native = typeof input.nativeUpdatedAt === "number" && input.nativeUpdatedAt > 0 ? input.nativeUpdatedAt : undefined;
  if (input.lifecycle && input.lifecycle.at + 1000 >= (native ?? 0)) {
    if (input.lifecycle.state === "ended") return "stopped";
    if (input.lifecycle.state === "idle") return "idle";
    // A running observation is a heartbeat, not a latch: trust it only while
    // fresh, so a crashed turn decays to idle instead of running for a day.
    if (input.now - input.lifecycle.at < input.activeWindowMs) return "running";
  }
  const lastActive = Math.max(input.tasksUpdatedAt, native ?? 0);
  const recentlyActive = lastActive > 0 && input.now - lastActive < input.activeWindowMs;
  if (recentlyActive && raw !== "completed") return "running";
  if (raw === "completed") return "stopped";
  return "idle";
}

function defaultCommand(): ZcodeCommand {
  const runtimeRoot = process.env.ZCODE_SERVER_RUNTIME_ROOT || join(homedir(), ".zcode", "server");
  const serverNode = process.env.ZCODE_SERVER_NODE || join(runtimeRoot, "node");
  const serverEntry = process.env.ZCODE_SERVER_ENTRY || join(runtimeRoot, "zcode-server.cjs");
  if (existsSync(serverNode) && existsSync(serverEntry)) {
    return { command: serverNode, args: [serverEntry] };
  }
  let args = ["app-server"];
  if (process.env.ZCODE_ARGS) {
    const parsed: unknown = JSON.parse(process.env.ZCODE_ARGS);
    if (!Array.isArray(parsed) || !parsed.every((arg) => typeof arg === "string")) {
      throw new Error("ZCODE_ARGS must be a JSON array of strings");
    }
    args = parsed;
  }
  return { command: process.env.ZCODE_BIN || "zcode", args };
}

/** ZCode adapter backed by the local stdio app-server, not the remote GUI relay. */
export class ZcodeAdapter implements HarnessAdapter {
  readonly type = "zcode" as const;
  readonly name = "ZCode";
  readonly lazyStart = true;
  // Sessions live in workspace-scoped app-server storage that is readable
  // without starting a run; discovery must not wait for lazyStart. The
  // persisted listing reads the tasks-index/native DB directly and never
  // spawns the stdio app-server, so listings stay available even while the
  // lazy transport is not initialized (e.g. after a daemon restart with
  // autocontinue disabled — verified 2026-10-06: 656 sessions served while
  // isReady() was false). Explicit control actions still initialize on demand.
  readonly lazyDiscovery = true;
  readonly controlCapabilities: HarnessCapabilities = {
    cancelTurn: true,
    detach: true,
    resume: true,
    terminate: true,
    recover: true,
    fork: false,
    modelSwitch: true,
    subagents: true,
    events: true,
  };

  private readonly cwd: string;
  private readonly modelIds: string[];
  private readonly client: ZcodeClientLike;
  private readonly useLocalConfig: boolean;
  private readonly localDbPath: string;
  private readonly tasksIndexDbPath?: string;
  private readonly turnStartTimeoutMs: number;
  private readonly persistedSessionIds = new Set<string>();
  private readonly desiredSessionTitles = new Map<string, string>();
  private readonly titlePersistenceTimers = new Map<string, NodeJS.Timeout>();
  private readonly queuedPrompts = new Map<string, Array<{ message: string; origin: "human" | "automation" }>>();
  private readonly queuedPromptTimers = new Map<string, NodeJS.Timeout>();
  private readonly queuedPromptFlushes = new Set<string>();
  private readonly turnStartWaiters = new Map<string, (result: TurnStartResult) => void>();
  private reportedEmptyTasksIndex = false;
  private readonly sessionWorkspaces = new Map<string, ZcodeWorkspaceRef>();
  private readonly sessionEventCursors = new Map<string, number>();
  private readonly locallyCancelledSessions = new Map<string, { requestedAt: number; turnId?: string }>();
  /** Read-after-write identity for sessions created before the task index catches up. */
  private readonly createdSessions = new Map<string, AgentSession>();
  private readonly eventListeners = new Set<(event: HarnessEvent) => void>();
  private readonly sessionEventUnsubscribers = new Map<string, () => void>();
  private readonly sessionEventTasks = new Set<Promise<void>>();
  private readonly observedActiveTurns = new Map<string, { turnId?: string; inputId?: string }>();
  private sessionSnapshotReceipt: SessionSnapshotReceipt = {
    exhaustive: false,
    observedAt: new Date(0).toISOString(),
    source: "zcode-tasks-index",
    reason: "not_observed",
  };
  private initialized = false;

  constructor(options: ZcodeAdapterOptions = {}) {
    this.cwd = resolve(options.cwd || process.env.ZCODE_CWD || process.cwd());
    this.modelIds = options.modelIds ?? [];
    this.useLocalConfig = !options.client;
    this.localDbPath = options.localDbPath ?? (process.env.ZCODE_DB_PATH || join(homedir(), ".zcode", "cli", "db", "db.sqlite"));
    this.turnStartTimeoutMs = options.turnStartTimeoutMs ?? 30_000;
    // An injected transport is an isolated embedding/test boundary: ambient
    // desktop paths must not silently merge unrelated live sessions into it.
    this.tasksIndexDbPath = options.tasksIndexDbPath
      ?? (this.useLocalConfig
        ? process.env.ZCODE_TASKS_INDEX_DB || join(homedir(), ".zcode", "v2", "tasks-index.sqlite")
        : undefined);
    if (options.client) {
      this.client = options.client;
    } else {
      const command = options.command || process.env.ZCODE_SERVER_NODE || defaultCommand().command;
      const args = options.args || (process.env.ZCODE_SERVER_NODE
        ? [process.env.ZCODE_SERVER_ENTRY || join(process.env.ZCODE_SERVER_RUNTIME_ROOT || join(homedir(), ".zcode", "server"), "zcode-server.cjs")]
        : defaultCommand().args);
      this.client = new ZcodeAppServerClient({
        command,
        args,
        cwd: this.cwd,
        // standalone-server authority: the spawned app-server uses the CLI
        // provider registry (zcode login) instead of requiring a desktop
        // attachment — without it initialize reports provider_not_ready.
        env: { ZCODE_SERVICE_AUTHORITY_MODE: "standalone-server" },
      });
    }
    this.client.onDisconnect?.(() => {
      this.initialized = false;
      for (const [sessionId, identity] of this.observedActiveTurns) {
        this.emitEvent({ kind: "process.disconnected", harness: "zcode", sessionId, nativeType: "transport-exit", data: { transport: "app-server-events", ...identity } });
      }
      this.observedActiveTurns.clear();
      for (const unsubscribe of this.sessionEventUnsubscribers.values()) { try { unsubscribe(); } catch { /* already disconnected */ } }
      this.sessionEventUnsubscribers.clear();
      this.emitEvent({ kind: "process.disconnected", harness: "zcode", nativeType: "transport-exit", data: { transport: "app-server-events" } });
    });
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      await this.client.start();
      const result = record(await this.callAgent("initialize", this.workspace()));
      if (result.available !== true) {
        // provider_not_ready only blocks session CREATION; discovery and
        // messaging of existing sessions (listSessions/sendPrompt) work —
        // degrade instead of failing the whole adapter.
        const reason = nonEmptyString(result.reason) || "ZCode app-server reported unavailable";
        console.error(`[agent-herder-zcode] app-server degraded: ${reason}`);
      }
      this.initialized = true;
      this.emitEvent({ kind: "process.connected", harness: "zcode", data: { transport: "app-server-events" } });
    } catch (error) {
      await this.client.close().catch(() => undefined);
      throw new Error(`Cannot initialize ZCode app-server: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  isReady(): boolean { return this.initialized; }

  /** Partial native observation: does not start transport or workspace runtime. */
  async observeExistingRuntime(sessionId: string, cwd: string) {
    return readExistingZcodeRuntimeObservation(this.client, this.workspace(cwd), sessionId);
  }

  getSessionSnapshotReceipt(): SessionSnapshotReceipt {
    return { ...this.sessionSnapshotReceipt };
  }

  subscribeEvents(handler: (event: HarnessEvent) => void): () => void {
    this.eventListeners.add(handler);
    if (this.initialized) queueMicrotask(() => handler({ kind: "process.connected", harness: "zcode", data: { transport: "app-server-events" } }));
    return () => { this.eventListeners.delete(handler); };
  }

  async dispose(): Promise<void> {
    this.initialized = false;
    this.observedActiveTurns.clear();
    for (const timer of this.titlePersistenceTimers.values()) clearTimeout(timer);
    this.titlePersistenceTimers.clear();
    for (const timer of this.queuedPromptTimers.values()) clearTimeout(timer);
    this.queuedPromptTimers.clear();
    for (const resolveWaiter of this.turnStartWaiters.values()) {
      resolveWaiter({ ok: false, error: "ZCode adapter disposed before turn start confirmation" });
    }
    this.turnStartWaiters.clear();
    for (const unsubscribe of this.sessionEventUnsubscribers.values()) { try { unsubscribe(); } catch { /* best effort */ } }
    this.sessionEventUnsubscribers.clear();
    await Promise.allSettled([...this.sessionEventTasks]);
    await this.client.close();
    this.emitEvent({ kind: "process.disconnected", harness: "zcode", data: { transport: "app-server-events" } });
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<AgentSession[]> {
    const persisted = await this.listPersistedSessions(options);
    const created = [...this.createdSessions.values()].filter((session) => !options.cwd || session.cwd === resolve(options.cwd));
    const mergeCreated = (sessions: AgentSession[]): AgentSession[] => {
      const merged = new Map(sessions.map((session) => [session.id, session]));
      for (const session of created) if (!merged.has(session.id)) merged.set(session.id, session);
      return [...merged.values()].sort((left, right) => Date.parse(right.lastActivity) - Date.parse(left.lastActivity));
    };
    if (!options.cwd && persisted.length === 0 && !this.reportedEmptyTasksIndex) {
      this.reportedEmptyTasksIndex = true;
      console.error(`[agent-herder] ZCode tasks-index returned no sessions (local=${this.useLocalConfig}, path=${this.tasksIndexDbPath || "unset"})`);
    }
    // The tasks index is the authoritative cross-workspace directory. Do not
    // turn a dashboard refresh into N live app-server workspace calls merely
    // because a prior resume made the transport ready. Scoped callers may
    // still request one workspace and receive a live overlay below.
    if ((!options.cwd && persisted.length > 0) || (this.useLocalConfig && !this.isReady())) return mergeCreated(persisted);
    const rows: Array<{ workspace: ZcodeWorkspaceRef; row: unknown }> = [];
    for (const workspace of await this.workspaceCandidates(options.cwd)) {
      try {
        const result = await this.callAgent("listSessions", {
          ...workspace,
          includeArchived: false,
          limit: 200,
        });
        const list = Array.isArray(result)
          ? result
          : (Array.isArray(record(result).sessions) ? record(result).sessions as unknown[] : []);
        for (const row of list) rows.push({ workspace, row });
      } catch {
        // A workspace the app-server cannot serve (e.g. provider_not_ready
        // creation-only paths) must not hide the other workspaces.
      }
    }
    const seen = new Set<string>();
    const sessions = new Map(persisted.map((session) => [session.id, session]));
    for (const { workspace, row } of rows) {
      const info = sessionInfoFromPayload(row);
      if (!info) throw new Error("ZCode returned an invalid listSessions entry");
      if (seen.has(info.sessionId)) continue;
      seen.add(info.sessionId);
      const rowWorkspace = this.workspace(nonEmptyString(record(info.workspace).workspacePath) || workspace.workspacePath);
      this.sessionWorkspaces.set(info.sessionId, rowWorkspace);
      let mapped = mapSession(row, rowWorkspace.workspacePath);
      if (!mapped.lastMessage) {
        try {
          const snapshot = await this.readSnapshot(info.sessionId, rowWorkspace, 1);
          mapped = mapSession(snapshot, rowWorkspace.workspacePath, mapped.title);
        } catch {
          // A list row is still useful when a historical snapshot cannot be read.
        }
      }
      sessions.set(mapped.id, mapped);
    }
    return mergeCreated([...sessions.values()]);
  }

  async findNamedSessions(name: string, cwd: string): Promise<AgentSession[]> {
    const normalizedCwd = resolve(cwd);
    const sessions = await this.listSessions({ cwd: normalizedCwd });
    return sessions.filter((session) => session.cwd === normalizedCwd && (
      session.title === name || this.desiredSessionTitles.get(session.id) === name
    ));
  }

  private async listPersistedSessions(options: ListSessionsOptions): Promise<AgentSession[]> {
    this.sessionSnapshotReceipt = {
      exhaustive: false,
      observedAt: new Date().toISOString(),
      source: "zcode-tasks-index",
      reason: "snapshot_in_progress",
    };
    if (!this.tasksIndexDbPath) {
      this.sessionSnapshotReceipt = {
        ...this.sessionSnapshotReceipt,
        observedAt: new Date().toISOString(),
        reason: "tasks_index_unconfigured",
      };
      return [];
    }
    try {
      const dbPath = this.tasksIndexDbPath;
      if (!existsSync(dbPath)) {
        this.sessionSnapshotReceipt = {
          ...this.sessionSnapshotReceipt,
          observedAt: new Date().toISOString(),
          reason: "tasks_index_missing",
        };
        return [];
      }
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const columns = db.prepare("pragma table_info(tasks)").all() as Array<{ name?: string }>;
        const pinnedColumn = columns.some((column) => column.name === "pinned") ? "pinned" : "0 as pinned";
        const workspaceIdentityColumn = columns.some((column) => column.name === "workspace_identity")
          ? "workspace_identity"
          : "null as workspace_identity";
        const workspaceKeyColumn = columns.some((column) => column.name === "workspace_key")
          ? "workspace_key"
          : "null as workspace_key";
        type PersistedTaskRow = {
          task_rowid: number;
          task_id: string;
          workspace_path?: string;
          workspace_identity?: string | null;
          workspace_key?: string | null;
          title?: string;
          task_status?: string;
          model?: string | null;
          created_at?: number;
          updated_at?: number;
          pinned?: number;
        };
        const pageSize = 500;
        const rows: PersistedTaskRow[] = [];
        const page = db.prepare(`
          select rowid as task_rowid, task_id, workspace_path, ${workspaceIdentityColumn}, ${workspaceKeyColumn},
                 title, task_status, model, created_at, updated_at, ${pinnedColumn}
          from tasks
          where coalesce(deleted, 0) = 0 and coalesce(archived, 0) = 0
          order by updated_at desc, task_id asc, workspace_path asc, rowid asc
          limit ? offset ?
        `);
        db.exec("begin");
        try {
          for (let offset = 0; ; offset += pageSize) {
            const next = page.all(pageSize, offset) as PersistedTaskRow[];
            rows.push(...next);
            if (next.length < pageSize) break;
          }
          db.exec("commit");
        } catch (error) {
          db.exec("rollback");
          throw error;
        }

        const nativeSessions = new Map<string, { directory?: string; workspaceIdentity?: string; timeUpdated?: number; parentId?: string | null; rootKnown: boolean; lastTurn?: NativeLastTurn }>();
        let nativeCanonicalizationError: string | undefined;
        if (existsSync(this.localDbPath)) {
          try {
            const nativeDb = new DatabaseSync(this.localDbPath, { readOnly: true });
            try {
              nativeDb.exec("begin");
              const nativeColumns = nativeDb.prepare("pragma table_info(session)").all() as Array<{ name?: string }>;
              const names = new Set(nativeColumns.map((column) => column.name));
              if (names.has("id") && names.has("directory")) {
                const workspaceIdentity = names.has("workspace_id") ? "workspace_id" : "null as workspace_id";
                const timeUpdatedExpr = names.has("time_updated") ? "time_updated" : "null as time_updated";
                const parentIdExpr = names.has("parent_id") ? "parent_id" : "null as parent_id";
                const nativeRows = nativeDb.prepare(`select id, directory, ${workspaceIdentity}, ${timeUpdatedExpr}, ${parentIdExpr} from session`).all() as Array<{
                  id: string;
                  directory?: string;
                  workspace_id?: string | null;
                  time_updated?: number | null;
                  parent_id?: string | null;
                }>;
                for (const row of nativeRows) {
                  nativeSessions.set(row.id, {
                    rootKnown: names.has("parent_id"),
                    parentId: row.parent_id,
                    directory: nonEmptyString(row.directory),
                    workspaceIdentity: nonEmptyString(row.workspace_id),
                    timeUpdated: typeof row.time_updated === "number" && row.time_updated > 0 ? row.time_updated : undefined,
                  });
                }
                // Readonly recovery evidence for the autocontinue launcher:
                // the newest durable turn per session from turn_usage
                // (completed/cancelled alone is not interruption;
                // cancelled_by_user is a strict human stop) plus the newest
                // session_input timestamp, so a turn record that is stale
                // against a newer unconsumed user prompt is excluded.
                const nativeTableNames = new Set((nativeDb.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name?: string }>).map((table) => table.name));
                const nativeTurnRowsBySession = new Map<string, NativeTurnUsageRow[]>();
                if (nativeTableNames.has("turn_usage")) {
                  const turnColumns = new Set((nativeDb.prepare("pragma table_info(turn_usage)").all() as Array<{ name?: string }>).map((column) => column.name));
                  const requiredTurnColumns = ["session_id", "turn_id", "status", "started_at"];
                  const optionalTurnColumn = (column: string, alias: string, type: "number" | "string") => {
                    if (!turnColumns.has(column)) return `null as ${alias}`;
                    return type === "number"
                      ? `cast(${column} as integer) as ${alias}`
                      : `cast(${column} as text) as ${alias}`;
                  };
                  if (requiredTurnColumns.every((column) => turnColumns.has(column))) {
                    const nativeTurnStatement = nativeDb.prepare(`
                      select session_id as session_id, turn_id as turn_id,
                             ${optionalTurnColumn("user_message_id", "user_message_id", "string")},
                             status as status,
                             cast(started_at as integer) as started_at,
                             ${optionalTurnColumn("first_model_start_at", "first_model_start_at", "number")},
                             ${optionalTurnColumn("first_token_at", "first_token_at", "number")},
                             ${optionalTurnColumn("completed_at", "completed_at", "number")},
                             ${optionalTurnColumn("duration_ms", "duration_ms", "number")},
                             ${optionalTurnColumn("tool_call_count", "tool_call_count", "number")},
                             ${optionalTurnColumn("retryable", "retryable", "number")},
                             ${optionalTurnColumn("cancelled_by_user", "cancelled_by_user", "number")},
                             ${optionalTurnColumn("context_exceeded", "context_exceeded", "number")},
                             ${optionalTurnColumn("error_type", "error_type", "string")},
                             ${optionalTurnColumn("error_code", "error_code", "string")}
                      from turn_usage
                      where (session_id, turn_id) in (
                        select value, (select turn_id from turn_usage
                          where session_id = target.value
                          order by started_at desc, ${turnColumns.has("completed_at") ? "completed_at" : "0+0"} desc, turn_id desc limit 1)
                        from json_each(?) as target
                      )
                    `);
                    const taskIds = [...new Set(rows.map((task) => task.task_id))];
                    const nativeTurnRows: Array<Record<string, unknown>> = [];
                    for (let offset = 0; offset < taskIds.length; offset += 200) {
                      nativeTurnRows.push(...nativeTurnStatement.all(JSON.stringify(taskIds.slice(offset, offset + 200))) as Array<Record<string, unknown>>);
                    }
                    for (const row of nativeTurnRows) {
                      const sessionId = typeof row.session_id === "string" ? row.session_id : "";
                      if (!sessionId) continue;
                      const group = nativeTurnRowsBySession.get(sessionId) ?? [];
                      group.push({
                        sessionId,
                        turnId: typeof row.turn_id === "string" ? row.turn_id : undefined,
                        userMessageId: typeof row.user_message_id === "string" ? row.user_message_id : null,
                        status: typeof row.status === "string" ? row.status : undefined,
                        startedAt: typeof row.started_at === "number" ? row.started_at : undefined,
                        firstModelStartAt: typeof row.first_model_start_at === "number" ? row.first_model_start_at : null,
                        firstTokenAt: typeof row.first_token_at === "number" ? row.first_token_at : null,
                        completedAt: typeof row.completed_at === "number" ? row.completed_at : null,
                        durationMs: typeof row.duration_ms === "number" ? row.duration_ms : null,
                        toolCallCount: typeof row.tool_call_count === "number" ? row.tool_call_count : null,
                        retryable: typeof row.retryable === "number" ? row.retryable : null,
                        cancelledByUser: typeof row.cancelled_by_user === "number" ? row.cancelled_by_user : null,
                        contextExceeded: typeof row.context_exceeded === "number" ? row.context_exceeded : null,
                        errorType: typeof row.error_type === "string" ? row.error_type : null,
                        errorCode: typeof row.error_code === "string" ? row.error_code : null,
                      });
                      nativeTurnRowsBySession.set(sessionId, group);
                    }
                  }
                }
                const nativeLastInputBySession = new Map<string, number>();
                const nativePendingInputs = new Set<string>();
                let pendingInputsKnown = false;
                if (nativeTableNames.has("session_input")) {
                  const inputColumns = new Set((nativeDb.prepare("pragma table_info(session_input)").all() as Array<{ name?: string }>).map((column) => column.name));
                  pendingInputsKnown = inputColumns.has("session_id") && inputColumns.has("status");
                  if (inputColumns.has("session_id") && inputColumns.has("time_created")) {
                    const inputRows = nativeDb.prepare(`
                      select session_id, max(cast(time_created as integer)) as last_input_at
                      ${pendingInputsKnown ? ", max(case when status in ('promoted','cancelled','discarded') then 0 else 1 end) as pending" : ""}
                      from session_input where session_id in (select value from json_each(?)) group by session_id
                    `);
                    const taskIds = [...new Set(rows.map((task) => task.task_id))];
                    for (let offset = 0; offset < taskIds.length; offset += 200) {
                      for (const row of inputRows.all(JSON.stringify(taskIds.slice(offset, offset + 200))) as Array<{session_id: string; last_input_at?: number; pending?: number}>) {
                        if (typeof row.last_input_at === "number" && row.last_input_at > 0) nativeLastInputBySession.set(row.session_id, row.last_input_at);
                        if (row.pending === 1) nativePendingInputs.add(row.session_id);
                      }
                    }
                  } else pendingInputsKnown = false;
                }
                const messageColumns = nativeTableNames.has("message")
                  ? new Set((nativeDb.prepare("pragma table_info(message)").all() as Array<{ name?: string }>).map((column) => column.name)) : new Set();
                const canReadMessages = ["id", "session_id", "data", "sequence", "time_updated"].every((column) => messageColumns.has(column));
                const latestMessage = canReadMessages ? nativeDb.prepare("select id, data, time_updated, sequence from message where session_id = ? order by sequence desc limit 1") : undefined;
                const latestUser = canReadMessages ? nativeDb.prepare("select id, sequence from message where session_id = ? and json_valid(data) and json_extract(data, '$.role') = 'user' order by sequence desc limit 1") : undefined;
                for (const [sessionId, entry] of nativeSessions) {
                  const lastTurn = pickNativeLastTurn(nativeTurnRowsBySession.get(sessionId) ?? [], nativeLastInputBySession.get(sessionId));
                  if (!lastTurn) continue;
                  lastTurn.rootSession = entry.rootKnown && !entry.parentId;
                  if (pendingInputsKnown) lastTurn.pendingInput = nativePendingInputs.has(sessionId);
                  if ((lastTurn.status === "error" || lastTurn.status === "cancelled") && lastTurn.userMessageId && latestMessage && latestUser) {
                    try {
                      const user = latestUser.get(sessionId) as { id?: string; sequence?: number } | undefined;
                      const tail = latestMessage.get(sessionId) as { id?: string; data?: string; time_updated?: number; sequence?: number } | undefined;
                      const info = tail?.data ? record(JSON.parse(tail.data)) : {};
                      const outcomeKnown = !!user?.id && !!tail?.id && typeof user.sequence === "number" && typeof tail.sequence === "number" && (info.role === "user" || info.role === "assistant");
                      if (outcomeKnown) {
                        lastTurn.userMessageMatchesLatest = user!.id === lastTurn.userMessageId;
                        const parentId = nonEmptyString(info.parentID);
                        const error = record(info.error);
                        lastTurn.assistantSucceeded = info.role === "assistant" && parentId === lastTurn.userMessageId
                          && !info.error && (info.finish === "stop" || info.finish === "length");
                        lastTurn.progressedAfterFailure = typeof tail?.time_updated !== "number" || typeof lastTurn.completedAt !== "number"
                          || tail.time_updated > lastTurn.completedAt
                          || (info.role === "assistant" && parentId !== lastTurn.userMessageId);
                        const errorText = String(record(error.data).message ?? "");
                        lastTurn.requiresHuman = /captcha|verification required|authentication required/i.test(errorText);
                        if (lastTurn.requiresHuman) lastTurn.blockedReason = "Провайдер требует подтверждения в своём интерфейсе; автоматические повторы остановлены.";
                      }
                    } catch { /* Unknown/partial transcript never qualifies cold recovery. */ }
                  }
                  entry.lastTurn = lastTurn;
                }
              } else {
                nativeCanonicalizationError = "native_session_schema_missing";
              }
            } finally {
              if (nativeDb.isTransaction) nativeDb.exec("rollback");
              nativeDb.close();
            }
          } catch (error) {
            // The task index remains usable while the native transcript DB is
            // temporarily unavailable. Duplicate rows fall back to recency.
            nativeCanonicalizationError = `native_session_read_failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        } else {
          nativeCanonicalizationError = "native_session_db_missing";
        }

        const rowsBySession = new Map<string, PersistedTaskRow[]>();
        for (const row of rows) {
          const group = rowsBySession.get(row.task_id) ?? [];
          group.push(row);
          rowsBySession.set(row.task_id, group);
        }
        const activeWindowMs = Number(process.env.AGENT_HERDER_ACTIVE_WINDOW_MS || 5 * 60 * 1_000);
        const requestedCwd = options.cwd ? resolve(options.cwd) : undefined;
        const sessions: AgentSession[] = [];
        for (const [sessionId, duplicateRows] of rowsBySession) {
          const native = nativeSessions.get(sessionId);
          const nativeDirectory = native?.directory ? resolve(native.directory) : undefined;
          const ranked = [...duplicateRows].sort((left, right) => {
            const leftPath = left.workspace_path ? resolve(left.workspace_path) : undefined;
            const rightPath = right.workspace_path ? resolve(right.workspace_path) : undefined;
            const leftIdentity = nonEmptyString(left.workspace_identity);
            const rightIdentity = nonEmptyString(right.workspace_identity);
            const leftScore = Number(Boolean(nativeDirectory && leftPath === nativeDirectory)) * 2
              + Number(Boolean(native?.workspaceIdentity && leftIdentity === native.workspaceIdentity));
            const rightScore = Number(Boolean(nativeDirectory && rightPath === nativeDirectory)) * 2
              + Number(Boolean(native?.workspaceIdentity && rightIdentity === native.workspaceIdentity));
            return rightScore - leftScore
              || Number(right.updated_at || right.created_at || 0) - Number(left.updated_at || left.created_at || 0)
              || right.task_rowid - left.task_rowid;
          });
          const row = ranked[0]!;
          const updatedAt = Number(row.updated_at || row.created_at || 0);
          const rawStatus = row.task_status?.toLowerCase();
          const nativeTimeUpdated = native?.timeUpdated;
          let status: AgentSession["status"] = resolvePersistedZcodeStatus({
            rawStatus,
            tasksUpdatedAt: updatedAt,
            nativeUpdatedAt: nativeTimeUpdated,
            lifecycle: lifecycleEntryFor("zcode", sessionId),
            now: Date.now(),
            activeWindowMs,
          });
          const turn = native?.lastTurn ? { ...native.lastTurn } : undefined;
          // The task index can flatten a failed native turn to completed. Only
          // exact current transcript evidence may overlay that historical row;
          // a running lifecycle or pending human request always wins.
          if (status !== "running" && status !== "needs_input" && turn?.status === "error"
            && turn.cancelledByUser === false && turn.pendingInput === false
            && turn.userMessageMatchesLatest === true && turn.assistantSucceeded === false
            && turn.progressedAfterFailure === false && typeof turn.startedAt === "number"
            && typeof turn.completedAt === "number" && turn.startedAt <= turn.completedAt
            && turn.completedAt <= Date.now()) status = "error";
          const lastActivityMs = Math.max(updatedAt, nativeTimeUpdated ?? 0);
          const cwd = nativeDirectory || resolve(row.workspace_path || this.cwd);
          if (requestedCwd && cwd !== requestedCwd) continue;
          const workspaceIdentity = native?.workspaceIdentity || nonEmptyString(row.workspace_identity) || cwd;
          const workspaceKey = nonEmptyString(row.workspace_key) || cwd;
          // A detached SSH client can abort its ZCode process while the task
          // index still says this exact root task is running. ZCode records
          // that transport abort as cancelled_by_user=1, so the flag alone is
          // not human-stop proof. The durable HumanStopStore remains the
          // authority; mark this readonly tuple for cold same-ID recovery.
          if (turn?.status === "cancelled"
            && turn.cancelledByUser === true
            && rawStatus === "running"
            && workspaceIdentity.startsWith("remote:ssh:")
            && turn.rootSession === true
            && turn.pendingInput === false
            && turn.requiresHuman !== true) {
            turn.transportLost = true;
            if (status !== "needs_input") status = "error";
          }
          this.persistedSessionIds.add(row.task_id);
          this.sessionWorkspaces.set(row.task_id, {
            workspacePath: cwd,
            workspaceIdentity,
            workspaceKey,
          });
          sessions.push({
            id: row.task_id,
            harness: "zcode" as const,
            status,
            title: row.title || "Untitled ZCode session",
            cwd,
            lastActivity: timestamp(lastActivityMs),
            model: nonEmptyString(row.model),
            needsPermission: status === "needs_input",
            meta: {
              persistedTaskStatus: rawStatus,
              discoverySource: "tasks-index",
              pinned: row.pinned === 1,
              workspaceIdentity,
              duplicateTaskRows: duplicateRows.length,
              ...(nativeTimeUpdated ? { nativeTimeUpdated } : {}),
              ...(turn ? { nativeLastTurn: turn } : {}),
              ...(nativeTimeUpdated && nativeTimeUpdated > updatedAt ? { lastActivitySource: "native-session-db" } : {}),
              ...(duplicateRows.length > 1 ? {
                taskIndexWorkspacePaths: duplicateRows.map((candidate) => candidate.workspace_path).filter(Boolean),
              } : {}),
            },
          });
        }
        this.sessionSnapshotReceipt = {
          exhaustive: nativeCanonicalizationError === undefined,
          observedAt: new Date().toISOString(),
          source: "zcode-tasks-index",
          ...(nativeCanonicalizationError ? { reason: nativeCanonicalizationError } : {}),
        };
        return sessions.sort((left, right) => Date.parse(right.lastActivity) - Date.parse(left.lastActivity));
      } finally {
        db.close();
      }
    } catch (error) {
      this.sessionSnapshotReceipt = {
        exhaustive: false,
        observedAt: new Date().toISOString(),
        source: "zcode-tasks-index",
        reason: `tasks_index_read_failed: ${error instanceof Error ? error.message : String(error)}`,
      };
      console.error(`[agent-herder] ZCode tasks-index discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  async getSession(id: string): Promise<AgentSession | null> {
    for (const workspace of this.sessionWorkspaces.has(id) ? [this.sessionWorkspaces.get(id)!] : await this.workspaceCandidates()) {
      try {
        const snapshot = await this.readSnapshot(id, workspace);
        if (sessionInfoFromPayload(snapshot)?.sessionId !== id) throw new Error("Native session identity mismatch");
        let nativeEvents: Array<Record<string, unknown>> = [];
        let nativeEventHistoryAvailable = false;
        try {
          const eventSeq = snapshot.runtime?.eventSeq ?? 0;
          const afterSeq = Math.max(0, eventSeq - 200);
          nativeEvents = sessionEventsFromPayload(await this.callAgent("readSessionEvents", {
            ...workspace,
            sessionId: id,
            afterSeq,
            limit: 200,
          })).sort((left, right) => Number(left.seq ?? 0) - Number(right.seq ?? 0));
          const lastSeq = nativeEvents.length > 0 ? Number(nativeEvents.at(-1)?.seq) : 0;
          const firstSeq = nativeEvents.length > 0 ? Number(nativeEvents[0]?.seq) : 0;
          nativeEventHistoryAvailable = eventSeq === 0
            || (eventSeq <= 200 && lastSeq >= eventSeq && firstSeq <= 1);
        } catch {
          // Missing native event history is not proof that no human stop occurred.
        }
        this.sessionWorkspaces.set(id, workspace);
        const eventSeq = snapshot.runtime?.eventSeq ?? 0;
        this.sessionEventCursors.set(id, eventSeq);
        const mapped = mapSession(snapshot, workspace.workspacePath, undefined, nativeEvents, nativeEventHistoryAvailable);
        // Native renameTask persists the display title in its task metadata even
        // when an empty V4 snapshot still exposes the old draft title.
        const displayTitle = await this.readTaskDisplayTitle(id, workspace);
        if (displayTitle) mapped.title = displayTitle;
        const lastTurn = [...nativeEvents].reverse().find((event) =>
          (event.type === "turn.started" || event.type === "turn.completed" || event.type === "turn.failed") && nonEmptyString(event.turnId));
        if (lastTurn) mapped.meta = { ...mapped.meta, nativeLastTurn: {
          turnId: lastTurn.turnId,
          status: lastTurn.type === "turn.started" ? "inProgress" : lastTurn.type === "turn.failed" ? "failed" : "completed",
        } };
        this.ensureSessionEventSubscription(id, workspace, eventSeq);
        mapped.meta = {...mapped.meta,nativeLoaded:true};
        return mapped;
      } catch {
        continue;
      }
    }
    // readSession is unavailable in headless spawns on current zcode-server
    // builds: it NPEs ("reading 'runtimePolicy'") for every interactive
    // session, params- and env-independent (the desktop-attached server
    // reads fine because the desktop app feeds it authority and cloud auth).
    // listSessions still returns those sessions — fall back to discovery.
    try {
      const sessions = await this.listSessions();
      const historical = sessions.find((session) => session.id === id);
      return historical ? {...historical,meta:{...historical.meta,nativeLoaded:false}} : null;
    } catch {
      return null;
    }
  }

  private async readTaskDisplayTitle(id: string, workspace: ZcodeWorkspaceRef): Promise<string | undefined> {
    if (!this.tasksIndexDbPath || !existsSync(this.tasksIndexDbPath)) return undefined;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(this.tasksIndexDbPath, { readOnly: true });
      try {
        const rows = db.prepare("select title from tasks where task_id = ? and workspace_path = ? and workspace_identity = ? order by updated_at desc limit 2")
          .all(id, workspace.workspacePath, workspace.workspaceIdentity) as Array<{ title?: string }>;
        const titles = new Set(rows.map(row => nonEmptyString(row.title)).filter(Boolean));
        return titles.size === 1 ? [...titles][0] : undefined;
      } finally { db.close(); }
    } catch { return undefined; }
  }

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    const workspace = this.workspace(options.cwd);
    const initialModel = options.model ? await this.resolveModelRef(options.model) : undefined;
    if (options.model && !initialModel) {
      throw new Error("ZCode model must be provider/model or a model ID with a known current provider");
    }
    const healthTools = options.name.startsWith("health_")
      ? { toolAllowlist: [...HEALTH_SESSION_TOOL_ALLOWLIST] }
      : {};
    let snapshot = await this.callAgent("createSession", {
      ...workspace,
      sessionTraceId: randomUUID(),
      // mode must be a concrete session mode ("build"): omitting it or
      // passing non-session values crashes this zcode-server build with an
      // NPE while resolving workspace defaults. Full-access creation is
      // confirmed separately through the native setMode response below.
      mode: options.fullAccess ? "yolo" : options.mode || "build",
      persistence: "immediate",
      ...(initialModel ? { model: initialModel } : {}),
      ...(initialModel?.options?.reasoningLevel ? { thoughtLevel: initialModel.options.reasoningLevel } : {}),
      ...healthTools,
    });
    const info = sessionInfoFromPayload(snapshot);
    if (!info) throw new Error("ZCode createSession returned no sessionId");
    if (options.fullAccess && nativePermissionMode(snapshot) !== "yolo") {
      snapshot = await this.callAgent("setMode", { ...workspace, sessionId: info.sessionId, mode: "yolo" });
      const updatedInfo = sessionInfoFromPayload(snapshot);
      if (updatedInfo?.sessionId !== info.sessionId || nativePermissionMode(snapshot) !== "yolo") {
        throw new Error("ZCode did not confirm full-access permission mode for the new session");
      }
    }
    this.sessionWorkspaces.set(info.sessionId, workspace);
    this.sessionEventCursors.set(info.sessionId, record(record(snapshot).runtime).eventSeq as number || 0);
    this.ensureSessionEventSubscription(info.sessionId, workspace, this.sessionEventCursors.get(info.sessionId));
    this.emitEvent({ kind: "session.created", harness: "zcode", sessionId: info.sessionId, status: "idle" });
    const created = mapSession(snapshot, workspace.workspacePath, undefined, [], true);
    this.createdSessions.set(created.id, created);
    // A native draft has no task-index row before its first prompt. The supported
    // metadata command preserves its name without submitting a prompt. If that
    // command fails, retain the already-created address and truthful native title.
    try {
      await this.callTask("renameTask", { ...workspace, taskId: info.sessionId, title: options.name });
      this.desiredSessionTitles.set(info.sessionId, options.name);
      created.title = options.name;
      created.meta = { ...created.meta, titleRenameConfirmed: true };
    } catch {
      created.meta = { ...created.meta, titleRenameConfirmed: false, requestedTitle: options.name, metadataWarning: "title_rename_failed" };
    }
    return created;
  }

  async getParent(id: string): Promise<AgentSession | null> {
    const session = await this.getSession(id);
    const parentId = typeof session?.meta?.parentSessionId === "string" ? session.meta.parentSessionId : undefined;
    return parentId ? this.getSession(parentId) : null;
  }

  async listChildren(id: string): Promise<AgentSession[]> {
    const session = await this.getSession(id);
    if (!session) return [];
    const sessions = await this.listSessions({ cwd: session.cwd });
    return sessions.filter((candidate) => candidate.meta?.parentSessionId === id);
  }

  async sendMessage(id: string, options: SendMessageOptions): Promise<SendMessageResult> {
    if (options.steer || options.queue) return this.sendConversationInput(id, options);
    const origin = options.origin === "human" ? "human" : "automation";
    const send = async (): Promise<{
      ok: boolean;
      error?: string;
      inputId?: string;
      baseline?: ZcodeSnapshot;
      acceptedStateRevision?: number;
    }> => {
      const baseline = await this.readCurrentSnapshot(id);
      const permissionError = this.pendingPermissionError(baseline);
      if (permissionError) return { ok: false, error: permissionError };
      const inputId = zcodeInputId(options.inputId || randomUUID(), origin);
      try {
        const stopStore = getHumanStopStore();
        if (await stopStore.isHeld("zcode", id)) return { ok: false, error: "Чат явно остановлен; автоматическая отправка запрещена." };
        if (origin !== "human") await stopStore.rememberGeneratedPrompt("zcode", id, options.message);
        if (await stopStore.isHeld("zcode", id)) return { ok: false, error: "Чат явно остановлен; автоматическая отправка запрещена." };
        const workspace = this.sessionWorkspaces.get(id) || this.workspace();
        const ack = record(await this.callAgent("sendPrompt", {
          ...workspace,
          sessionId: id,
          inputId,
          content: options.message,
        }));
        if (ack.accepted !== true) throw new Error("ZCode sendPrompt did not acknowledge prompt admission");
        const ackSessionId = nonEmptyString(ack.sessionId);
        if (ackSessionId && ackSessionId !== id) {
          throw new Error(`ZCode sendPrompt acknowledged a different session: ${ackSessionId}`);
        }
        const ackTurnId = nonEmptyString(ack.turnId) || nonEmptyString(record(ack.turn).id);
        if (origin !== "human" && ackTurnId) {
          try { await stopStore.rememberGeneratedPrompt("zcode", id, options.message, ackTurnId); }
          catch (error) { console.error(`[agent-herder] admitted ZCode prompt turn could not be registered: ${error instanceof Error ? error.message : String(error)}`); }
        }
        return {
          ok: true,
          inputId,
          baseline,
          acceptedStateRevision: typeof ack.stateRevision === "number" ? ack.stateRevision : undefined,
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    };
    let result = await send();
    if (!result.ok) {
      if (options.queue && /prompt is already running/i.test(result.error ?? "")) {
        const queue = this.queuedPrompts.get(id) ?? [];
        if (!queue.some((item) => item.message === options.message && item.origin === origin)) queue.push({ message: options.message, origin });
        this.queuedPrompts.set(id, queue);
        this.scheduleQueuedPromptFlush(id);
        return { ok: true };
      }
      // Interactive TUI sessions between turns reject direct prompts ("Session
      // is not active"). Resuming re-attaches the session to this app-server,
      // after which the same prompt delivers.
      if (!isInactiveSessionError(result.error)) return result;
      const resumed = await this.resumeSession(id);
      if (!resumed.ok) {
        return isInactiveSessionError(resumed.error) ? terminalInactiveResult(id, resumed.error) : resumed;
      }
      result = await send();
      if (!result.ok) {
        return isInactiveSessionError(result.error) ? terminalInactiveResult(id, result.error) : result;
      }
    }

    const workspace = this.sessionWorkspaces.get(id) || this.workspace();
    this.sessionWorkspaces.set(id, workspace);
    const started = await this.waitForTurnStart(id, workspace, result.inputId!, options.message, result.baseline, result.acceptedStateRevision);
    if (!started.ok) {
      if (started.pending) {
        console.error(`[agent-herder] ZCode prompt accepted for ${id}, but native turn confirmation remains armed: ${started.error || "unknown error"}`);
        return { ok: true, admitted: true, pending: true };
      }
      const error = started.error || `ZCode native turn failed for ${id}`;
      console.error(`[agent-herder] ZCode prompt accepted for ${id}, and the native turn then failed: ${error}`);
      return { ok: false, admitted: true, nonRetryable: true, error };
    }
    await this.persistDesiredSessionTitle(id);
    return { ok: true };
  }

  /** Native V4 owns guide/queue admission and command deduplication. Never
   * replace its receipt with our old RAM queue or retry through session/send. */
  private async sendConversationInput(id: string, options: SendMessageOptions): Promise<SendMessageResult> {
    const origin = options.origin === "human" ? "human" : "automation";
    const inputId = options.inputId || randomUUID();
    const commandId = zcodeInputId(inputId, origin);
    const requestedDelivery = options.steer ? "guide" : "queue";
    let attempted = false;
    try {
      if (await getHumanStopStore().isHeld("zcode", id)) return {ok:false,inputId,error:"Чат явно остановлен; автоматическая отправка запрещена."};
      const baseline = await this.readConversationBaseline(id);
      const permissionError = this.pendingPermissionError(baseline);
      if (permissionError) return { ok: false, inputId, error: permissionError };
      const stopStore = getHumanStopStore();
      if (await stopStore.isHeld("zcode", id)) return { ok: false, inputId, error: "Чат явно остановлен; автоматическая отправка запрещена." };
      if (origin !== "human") await stopStore.rememberGeneratedPrompt("zcode", id, options.message);
      if (await stopStore.isHeld("zcode", id)) return { ok: false, inputId, error: "Чат явно остановлен; автоматическая отправка запрещена." };
      const workspace = this.sessionWorkspaces.get(id) || this.workspace();
      attempted = true;
      // Pinned installed zcode-server.cjs exposes this exact service method.
      // requestedDelivery=guide injects at the next supported native boundary;
      // queue remains a native input intent, not a Herder timer/new inputId.
      const ack = record(await this.callAgent("sendConversationCommandV4", {
        ...workspace,
        envelope: {
          commandId, clientId: "agent-herder", sessionId: id, type: "sendText",
          payload: { text: options.message, requestedDelivery }, issuedAt: Date.now(),
        },
      }));
      if (ack.commandId !== commandId) throw new Error("ZCode вернул подтверждение другой команды; доставка не установлена.");
      const nativeInput = record(ack.result);
      if (ack.status !== "accepted" && ack.status !== "duplicate") {
        return { ok: false, admitted: false, inputId, nonRetryable: true,
          error: `ZCode не принял ${requestedDelivery === "guide" ? "доставку в текущий ход" : "сообщение в очередь"}: ${String(ack.reasonCode || ack.status || "invalid_receipt")}${ack.message ? ` (${String(ack.message)})` : ""}` };
      }
      if (nativeInput.type !== "inputAccepted" || !nonEmptyString(nativeInput.inputId)
        || !["guide", "queue", "startNow"].includes(String(nativeInput.delivery))) {
        throw new Error("ZCode подтвердил команду без подтверждения приёма сообщения; повторная отправка запрещена.");
      }
      if ((requestedDelivery === "guide" && nativeInput.delivery === "queue")
        || (requestedDelivery === "queue" && nativeInput.delivery === "guide")) {
        return { ok: false, admitted: true, inputId, nonRetryable: true,
          error: `ZCode принял сообщение в другом режиме (${String(nativeInput.delivery)}); повторная отправка запрещена.` };
      }
      this.ensureSessionEventSubscription(id, workspace);
      // Admission is sufficient. Do not wait for a new turn: a guided input
      // belongs to the already active turn, and a queued input has not begun.
      return { ok: true, admitted: true, inputId, ...(nativeInput.delivery === "queue" ? { pending: true } : {}) };
    } catch (error) {
      return { ok: false, inputId, ...(attempted ? { admissionUnknown: true, nonRetryable: true } : {}),
        error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async persistDesiredSessionTitle(id: string, attempt = 0): Promise<void> {
    const title = this.desiredSessionTitles.get(id);
    if (!title || !this.tasksIndexDbPath || !existsSync(this.tasksIndexDbPath)) return;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(this.tasksIndexDbPath);
      try {
        db.prepare("update tasks set title = ? where task_id = ?").run(title, id);
      } finally {
        db.close();
      }
    } catch (error) {
      console.error(`[agent-herder] ZCode title persistence failed for ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const delays = [250, 1_000, 3_000, 10_000, 30_000];
    if (attempt >= delays.length) {
      this.desiredSessionTitles.delete(id);
      this.titlePersistenceTimers.delete(id);
      return;
    }
    const previous = this.titlePersistenceTimers.get(id);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.titlePersistenceTimers.delete(id);
      void this.persistDesiredSessionTitle(id, attempt + 1);
    }, delays[attempt]!);
    timer.unref?.();
    this.titlePersistenceTimers.set(id, timer);
  }

  async setSessionPinned(id: string, pinned: boolean): Promise<ControlResult> {
    if (!this.tasksIndexDbPath || !existsSync(this.tasksIndexDbPath)) {
      return { ok: false, error: "ZCode tasks index is unavailable" };
    }
    const delays = [0, 50, 100, 250, 500, 1_000, 2_000];
    let lastError = `ZCode session ${id} is missing from the tasks index`;
    for (const delayMs of delays) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(this.tasksIndexDbPath);
        try {
          db.exec("pragma busy_timeout=5000");
          const columns = db.prepare("pragma table_info(tasks)").all() as Array<{ name?: string }>;
          if (!columns.some((column) => column.name === "pinned")) {
            return { ok: false, error: "ZCode tasks index does not expose pinned" };
          }
          const changed = db.prepare("update tasks set pinned = ? where task_id = ? and coalesce(deleted, 0) = 0").run(pinned ? 1 : 0, id);
          if (Number(changed.changes) > 0) {
            const created = this.createdSessions.get(id);
            if (created) created.meta = { ...created.meta, pinned };
            return { ok: true, sessionId: id };
          }
        } finally {
          db.close();
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    return { ok: false, error: lastError };
  }

  async stopSession(id: string): Promise<ControlResult> {
    return this.stopGeneration(id);
  }

  async cancelTurn(id: string): Promise<ControlResult> {
    return this.stopGeneration(id);
  }

  private async stopGeneration(id: string): Promise<ControlResult> {
    const before = await this.readCurrentSnapshot(id).catch(() => undefined);
    const turnId = nonEmptyString(record(record(before).runtime).activeTurnId);
    this.locallyCancelledSessions.set(id, { requestedAt: Date.now(), ...(turnId ? { turnId } : {}) });
    try {
      const workspace = this.sessionWorkspaces.get(id) || this.workspace();
      await this.callTask("stopGeneration", { ...workspace, taskId: id });
      return { ok: true };
    } catch (error) {
      this.locallyCancelledSessions.delete(id);
      const message = error instanceof Error ? error.message : String(error);
      if (/timed out/i.test(message)) {
        // A provider request can wedge the single ZCode app-server so even
        // stopGeneration cannot be served. Recycle only this adapter-owned
        // child before the caller starts the approved fallback provider.
        await this.dispose();
        try { await this.init(); } catch { /* the next explicit request will retry init */ }
      }
      return { ok: false, error: message };
    }
  }

  async detach(_id: string): Promise<ControlResult> {
    return { ok: true };
  }

  async terminate(id: string): Promise<ControlResult> {
    try {
      const workspace = this.sessionWorkspaces.get(id) || this.workspace();
      await this.callAgent("closeSession", { ...workspace, sessionId: id });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async recover(id: string, message?: string): Promise<ControlResult> {
    const resumed = await this.resumeSession(id);
    if (!resumed.ok || !message) return resumed;
    return this.sendMessage(id, { message, queue: true });
  }

  async getMessageAdmission(id: string, inputId: string, cwd?: string): Promise<MessageAdmissionResult> {
    const workspace = this.sessionWorkspaces.get(id) || this.workspace(cwd);
    const read = async () => sessionEventsFromPayload(await this.callAgent("readSessionEvents", {
      ...workspace,
      sessionId: id,
      limit: 200,
    }));
    let events: Array<Record<string, unknown>>;
    try {
      events = await read();
    } catch (error) {
      if (!isInactiveSessionError(error)) {
        return { state: "unknown", error: error instanceof Error ? error.message : String(error) };
      }
      const resumed = await this.resumeSession(id);
      if (!resumed.ok) return { state: "unknown", error: resumed.error || "native resume failed during admission reconciliation" };
      try {
        events = await read();
      } catch (retryError) {
        return { state: "unknown", error: retryError instanceof Error ? retryError.message : String(retryError) };
      }
    }
    const identities = new Set([inputId, zcodeInputId(inputId, "automation")]);
    const matches = (value: unknown) => typeof value === "string" && identities.has(value);
    const addIdentity = (value: unknown) => { const id = nonEmptyString(value); if (id) identities.add(id); };
    const inputs = (payload: Record<string, unknown>) => [payload, ...(Array.isArray(payload.drainedInputs) ? payload.drainedInputs.map(record) : [])];
    const belongs = (input: Record<string, unknown>) => [input.inputId, input.pendingInputId, input.sourceCommandId, record(input.intent).sourceCommandId].some(matches);
    // First recover canonical command-to-native input attribution; strict
    // turn.failed carries only native inputId, and history order can vary.
    for (const event of events) {
      for (const input of inputs(record(event.payload))) {
        if (!belongs(input)) continue;
        addIdentity(input.inputId); addIdentity(input.pendingInputId);
      }
    }
    let messageAdmitted = false;
    let messageReadError: string | undefined;
    try {
      const messages = snapshotMessages(await this.callAgent("readSessionMessages", { ...workspace, sessionId: id, limit: 200 }));
      for (const message of messages) {
        const info = record(message.info);
        const metadata = record(info.metadata);
        if (info.role !== "user" || ![info.sourceCommandId, metadata.sourceCommandId, metadata.inputId].some(matches)) continue;
        messageAdmitted = true;
        addIdentity(metadata.inputId);
      }
    } catch (error) {
      messageReadError = error instanceof Error ? error.message : String(error);
    }
    let admitted = messageAdmitted;
    for (const event of events) {
      if (!inputs(record(event.payload)).some(belongs)) continue;
      const type = nonEmptyString(event.type);
      if (type === "turn.failed") return { state: "failed", error: admittedNativeTurnFailure(id, event) };
      if (["turn.completed", "turn.started", "turn.steerQueued", "turn.steerDrained"].includes(type || "")) admitted = true;
    }
    return admitted ? { state: "admitted" } : { state: "unknown", error: messageReadError || "В доступной истории ZCode нет подтверждения этого сообщения; повторная отправка запрещена." };
  }

  async forkSession(_id: string, _message?: string): Promise<ControlResult> {
    return unsupported("fork");
  }

  async respondPermission(
    sessionId: string,
    permissionId: string,
    response: "allow" | "deny",
    remember = false,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const workspace = this.sessionWorkspaces.get(sessionId) || this.workspace();
      await this.callTask("respondPermission", {
        ...workspace,
        taskId: sessionId,
        requestId: permissionId,
        optionId: response === "deny" ? "deny" : remember ? "allowAlways" : "allowOnce",
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async setPermissions(_sessionId: string, _options: SetPermissionsOptions): Promise<{ ok: boolean; error?: string }> {
    return unsupported("permissions");
  }

  async changeModel(sessionId: string, model: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const workspace = this.sessionWorkspaces.get(sessionId) || this.workspace();
      const snapshot = await this.readSnapshot(sessionId, workspace, 1);
      const current = record(record(snapshot).settings).model;
      const currentModel = record(current).current as ZcodeModelRef | undefined;
      const modelRef = await this.resolveModelRef(model, currentModel?.providerId);
      if (!modelRef?.providerId || !modelRef.modelId) {
        return { ok: false, error: "ZCode model must be provider/model or a model ID with a known current provider" };
      }
      await this.callAgent("setModel", { ...workspace, sessionId, model: modelRef });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async getTranscript(id: string): Promise<string | null> {
    const messages = await this.getSessionMessages(id, 200);
    if (!messages || messages.length === 0) return null;
    return messages
      .map((message) => `${message.role}: ${message.text || message.parts.map((part) => part.text || part.output || "").join(" ")}`)
      .join("\n\n");
  }

  async getRawTranscript(id: string): Promise<RawTranscriptExport | null> {
    try {
      const workspace = this.sessionWorkspaces.get(id) || this.workspace();
      const snapshot = await this.readSnapshot(id, workspace);
      return {
        bytes: Buffer.from(JSON.stringify(snapshot, null, 2), "utf8"),
        complete: true,
        source: { kind: "native-api", location: "zcode app-server session/read", format: "json" },
        timestampCoverage: "native",
      };
    } catch {
      return null;
    }
  }

  async getSessionMessages(id: string, limit = 100): Promise<SessionMessageView[] | null> {
    if (this.persistedSessionIds.has(id)) {
      const local = await this.readLocalSessionMessages(id, limit);
      if (local?.length || !this.isReady()) return local;
    }
    try {
      const workspace = this.sessionWorkspaces.get(id) || this.workspace();
      const result = await this.callAgent("readSessionMessages", {
        ...workspace,
        sessionId: id,
        limit,
      });
      const messages = snapshotMessages(result).map(mapMessage);
      if (messages.length > 0) return messages;
    } catch {
      // Current headless zcode-server builds can list interactive sessions but
      // fail readSession/readSessionMessages because desktop runtimePolicy is
      // absent. The CLI SQLite store remains the canonical local transcript.
    }
    return this.readLocalSessionMessages(id, limit);
  }

  async getFirstUserMessage(id: string): Promise<SessionMessageView | null> {
    if (this.useLocalConfig) {
      const local = await this.readLocalFirstUserMessage(id);
      if (local || !this.isReady()) return local;
    }
    try {
      const workspace = this.sessionWorkspaces.get(id) || this.workspace();
      const snapshot = await this.readSnapshot(id, workspace);
      const firstUser = (snapshot.messages ?? []).map(mapMessage).find((message) => message.role === "user");
      if (firstUser) return firstUser;
    } catch {
      // Fall through to the canonical local store when the headless runtime
      // cannot expose a desktop-created session.
    }
    return this.readLocalFirstUserMessage(id);
  }

  private async readLocalFirstUserMessage(id: string): Promise<SessionMessageView | null> {
    if (!this.useLocalConfig || !existsSync(this.localDbPath)) return null;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(this.localDbPath, { readOnly: true });
      try {
        const row = db.prepare(`
          select id, data
          from message indexed by message_session_sequence_idx
          where session_id = ? and json_extract(data, '$.role') = 'user'
          order by sequence, time_created, id
          limit 1
        `).get(id) as { id: string; data: string } | undefined;
        if (!row) return null;
        const data = JSON.parse(row.data) as Record<string, unknown>;
        const parts = db.prepare(`
          select data
          from part
          where session_id = ? and message_id = ?
          order by sequence, time_created, id
        `).all(id, row.id) as Array<{ data: string }>;
        return mapMessage({
          info: { ...data, messageId: row.id } as ZcodeMessage["info"],
          parts: parts.map((part) => JSON.parse(part.data) as Record<string, unknown>),
        }, 0);
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  }

  private async readLocalSessionMessages(id: string, limit: number): Promise<SessionMessageView[] | null> {
    if (!this.useLocalConfig || !existsSync(this.localDbPath)) return null;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(this.localDbPath, { readOnly: true });
      try {
        const bounded = Math.max(1, Math.min(limit, 200));
        const rows = db.prepare(`
          select id, data
          from message indexed by message_session_sequence_idx
          where session_id = ?
          order by sequence desc, time_created desc, id desc
          limit ?
        `).all(id, bounded) as Array<{ id: string; data: string }>;
        if (rows.length === 0) return null;
        rows.reverse();
        const messages = new Map<string, ZcodeMessage>();
        for (const row of rows) {
          const data = JSON.parse(row.data) as Record<string, unknown>;
          messages.set(row.id, {
            info: { ...data, messageId: row.id } as ZcodeMessage["info"],
            parts: [],
          });
        }
        const placeholders = rows.map(() => "?").join(",");
        const partRows = db.prepare(`
          select message_id as messageId, data
          from part
          where session_id = ? and message_id in (${placeholders})
          order by message_id, sequence, time_created, id
        `).all(id, ...rows.map((row) => row.id)) as Array<{ messageId: string; data: string }>;
        for (const row of partRows) {
          const message = messages.get(row.messageId);
          if (!message) continue;
          message.parts!.push(JSON.parse(row.data) as Record<string, unknown>);
        }
        return rows.map((row, index) => mapMessage(messages.get(row.id)!, index));
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  }

  async resumeSession(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const workspace = this.sessionWorkspaces.get(id) || this.workspace();
      const snapshot = await this.callAgent("resumeSession", { ...workspace, sessionId: id });
      this.sessionWorkspaces.set(id, workspace);
      if (sessionInfoFromPayload(snapshot)?.sessionId !== id) throw new Error("ZCode resumeSession returned a different or missing sessionId");
      const eventSeq = record(record(snapshot).runtime).eventSeq;
      if (typeof eventSeq === "number") this.sessionEventCursors.set(id, eventSeq);
      this.ensureSessionEventSubscription(id, workspace, typeof eventSeq === "number" ? eventSeq : undefined);
      return { ok: true };
    } catch (error) {
      return isInactiveSessionError(error)
        ? terminalInactiveResult(id, error)
        : { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async listModels(): Promise<string[]> {
    const configured = [...this.modelIds];
    if (this.useLocalConfig) {
      try {
        const raw = JSON.parse(await readFile(join(homedir(), ".zcode", "cli", "config.json"), "utf8")) as ZcodeLocalConfig;
        configured.push(...zcodeConfiguredModels(raw));
      } catch { /* local CLI config is optional */ }
    }
    // Model refresh is passive discovery: never initialize/spawn the stdio
    // app-server just to populate dashboard metadata. Query live state only
    // when an explicit control action has already initialized the adapter.
    if (!this.isReady()) return [...new Set(configured)];
    try {
      const state = record(await Promise.race([
        this.callAgent("readWorkspaceState", this.workspace()),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("ZCode model catalog timeout")), 2_500)),
      ]));
      const settingsModel = record(record(state.settings).model);
      const available = Array.isArray(settingsModel.available) ? settingsModel.available : [];
      const models = available.map(modelNameFromCatalogEntry).filter((model): model is string => Boolean(model));
      return [...new Set([...models, ...configured])];
    } catch {
      return [...new Set(configured)];
    }
  }

  private workspace(cwd = this.cwd): ZcodeWorkspaceRef {
    const canonical = resolve(cwd);
    return { workspacePath: canonical, workspaceIdentity: canonical, workspaceKey: canonical };
  }

  /**
   * Workspaces to probe for sessions. The app-server scopes every call by
   * workspaceKey, so a daemon rooted at one directory cannot see sessions
   * from other workspaces. The zcode tasks index (workspace_path per task)
   * and the coordination-notes store (each author's cwd) together form a
   * cross-workspace directory of live workspaces.
   */
  private async workspaceCandidates(explicitCwd?: string): Promise<ZcodeWorkspaceRef[]> {
    if (explicitCwd) return [this.workspace(explicitCwd)];
    const candidates: ZcodeWorkspaceRef[] = [this.workspace()];
    const push = (value: unknown) => {
      if (typeof value !== "string" || value.length === 0) return;
      try {
        const ref = this.workspace(value);
        if (!existsSync(ref.workspacePath)) return;
        if (!candidates.some((c) => c.workspaceKey === ref.workspaceKey)) candidates.push(ref);
      } catch {
        // Unresolvable path: skip this candidate.
      }
    };
    try {
      const notesPath = process.env.AGENT_HERDER_COORDINATION_NOTES
        || join(homedir(), ".local", "state", "agent-herder", "coordination-notes.json");
      const raw = JSON.parse(readFileSync(notesPath, "utf8")) as { notes?: Array<{ cwd?: string }> };
      for (const note of raw.notes ?? []) push(note.cwd);
    } catch {
      // Missing or unreadable notes store: fall through to the tasks index.
    }
    try {
      const dbPath = process.env.ZCODE_TASKS_INDEX_DB
        || join(homedir(), ".zcode", "v2", "tasks-index.sqlite");
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = db.prepare(
          "select workspace_path from tasks where workspace_path is not null order by created_at desc limit 20"
        ).all();
        for (const row of rows) push((row as { workspace_path?: unknown }).workspace_path);
      } finally {
        db.close();
      }
    } catch {
      // Tasks index unavailable (older zcode builds): notes candidates still apply.
    }
    return candidates;
  }

  private async readSnapshot(id: string, workspace: ZcodeWorkspaceRef, messageLimit?: number): Promise<ZcodeSnapshot> {
    return await this.callAgent("readSession", {
      ...workspace,
      runtimePolicy:"existing-only",
      sessionId: id,
      ...(messageLimit !== undefined ? { messageLimit } : {}),
    }) as ZcodeSnapshot;
  }

  private conversationLoads = new Map<string, Promise<ZcodeSnapshot>>();

  private async readConversationBaseline(id: string): Promise<ZcodeSnapshot> {
    const workspace = this.sessionWorkspaces.get(id) || this.workspace();
    try {
      const snapshot = await this.readSnapshot(id, workspace);
      if (sessionInfoFromPayload(snapshot)?.sessionId !== id) throw new Error("Native read returned a different sessionId");
      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Only explicit absence permits a prompt-free same-ID load. A read
      // timeout/disconnect is unknown, and must never trigger send/replay.
      if (!["proto.sessionNotFound","ZCODE_AGENT_RUNTIME_UNAVAILABLE"].includes(String(record(error).code)) && !/\bSession not found\b|proto\.sessionNotFound|^ZCode Agent runtime is not running\.$/.test(message)) throw error;
      let loading = this.conversationLoads.get(id);
      if (!loading) {
        loading = (async () => {
          if (await getHumanStopStore().isHeld("zcode", id)) throw new Error("Чат явно остановлен; загрузка запрещена.");
          this.sessionWorkspaces.set(id, workspace);
          const result = await this.resumeSession(id);
          if (!result.ok) throw new Error(result.error || "Same-ID native load failed");
          const snapshot = await this.readSnapshot(id, workspace);
          if (sessionInfoFromPayload(snapshot)?.sessionId !== id) throw new Error("Loaded native session identity mismatch");
          return snapshot;
        })();
        this.conversationLoads.set(id, loading);
        void loading.finally(() => {this.conversationLoads.delete(id);}).catch(() => {});
      }
      return loading;
    }
  }

  private async readCurrentSnapshot(sessionId: string): Promise<ZcodeSnapshot | undefined> {
    for (const workspace of await this.workspaceCandidates(this.sessionWorkspaces.get(sessionId)?.workspacePath)) {
      try {
        const snapshot = await this.readSnapshot(sessionId, workspace);
        if (sessionInfoFromPayload(snapshot)?.sessionId !== sessionId) continue;
        this.sessionWorkspaces.set(sessionId, workspace);
        if (typeof snapshot.runtime?.eventSeq === "number") this.sessionEventCursors.set(sessionId, snapshot.runtime.eventSeq);
        return snapshot;
      } catch {
        // Try the next workspace known to the native session index.
      }
    }
    // Preserve the existing send/resume path when no workspace exposes a snapshot.
    return undefined;
  }

  private pendingPermissionError(snapshot: ZcodeSnapshot | undefined): string | undefined {
    const pendingRequestIds = record(record(snapshot).runtime).pendingRequestIds;
    return Array.isArray(pendingRequestIds) && pendingRequestIds.length > 0
      ? "ZCode ожидает вашего разрешения. Ответьте на запрос в этой сессии, затем продолжите работу."
      : undefined;
  }

  private ensureSessionEventSubscription(sessionId: string, workspace: ZcodeWorkspaceRef, afterSeq = this.sessionEventCursors.get(sessionId) ?? 0): void {
    const hasTurnWaiter = [...this.turnStartWaiters.keys()].some((key) => key.startsWith(`${sessionId}:`));
    if (this.sessionEventUnsubscribers.has(sessionId) || !this.client.listen || (this.eventListeners.size === 0 && !hasTurnWaiter)) return;
    let active = true;
    this.sessionEventUnsubscribers.set(sessionId, () => { active = false; });
    void this.client.start().then(() => {
      const stillHasTurnWaiter = [...this.turnStartWaiters.keys()].some((key) => key.startsWith(`${sessionId}:`));
      if (!active || (this.eventListeners.size === 0 && !stillHasTurnWaiter) || !this.client.listen) return;
      const unsubscribe = this.client.listen("zcode-agent", "onDynamicSessionEvent", {
        sessionId,
        workspacePath: workspace.workspacePath,
        workspaceIdentity: workspace.workspaceIdentity,
        deliveryKind: "replayable",
        afterSeq,
        includeSnapshot: true,
      }, (payload) => {
        if (!active) return;
        const task = (async () => {
          if (!active) return;
          const event = normalizeZcodeTaskEvent(sessionId, payload);
          if (event) {
            const inputId = nonEmptyString(record(event.data).inputId);
            const nativeResultType = nonEmptyString(record(event.data).nativeResultType);
            const cancelled = nativeResultType === "cancelled";
            if (cancelled) this.clearQueuedPrompts(sessionId);
            if (cancelled && this.isRecentHerderCancellation(sessionId, nonEmptyString(record(record(event.data).automationStop).turnId))) {
              if (event.data) {
                const marker = record(event.data.automationStop) as unknown as AutomationStopMarker;
                try {
                  await getHumanStopStore().ignoreNativeStop("zcode", sessionId, marker);
                  if (!active) return;
                  delete event.data.automationStop;
                  event.data.herderCancellation = true;
                } catch (error) {
                  console.error(`[agent-herder] failed to persist internal ZCode cancellation evidence: ${error instanceof Error ? error.message : String(error)}`);
                }
              }
            }
            if (!active) return;
            if (event.kind === "turn.started") {
              const turnId = nonEmptyString(record(event.data).turnId);
              if (turnId || inputId) this.observedActiveTurns.set(sessionId, { ...(turnId ? { turnId } : {}), ...(inputId ? { inputId } : {}) });
            } else if (event.kind === "turn.completed" || event.kind === "turn.failed" || event.kind === "session.deleted") {
              const observed = this.observedActiveTurns.get(sessionId);
              const turnId = nonEmptyString(record(event.data).turnId);
              const matches = observed?.turnId && turnId
                ? observed.turnId === turnId
                : !!observed?.inputId && !!inputId && observed.inputId === inputId;
              if (!observed || matches) this.observedActiveTurns.delete(sessionId);
            }
            if (inputId) {
              const waiterKey = `${sessionId}:${inputId}`;
              const waiter = this.turnStartWaiters.get(waiterKey);
              if (waiter && (event.kind === "turn.started" || event.kind === "turn.completed" || event.kind === "turn.failed")) {
                this.turnStartWaiters.delete(waiterKey);
                waiter(event.kind === "turn.failed"
                  ? { ok: false, error: admittedNativeTurnFailure(sessionId, {
                    payload: {
                      error: {
                        code: nonEmptyString(record(event.data).nativeErrorCode),
                        message: nonEmptyString(record(event.data).nativeErrorMessage),
                      },
                    },
                  }) }
                  : { ok: true, turnId: nonEmptyString(record(event.data).turnId) });
              }
            }
            this.emitEvent(event);
            if (!cancelled && (event.kind === "turn.completed" || event.kind === "turn.failed")) this.scheduleQueuedPromptFlush(sessionId, 0);
          }
        })().catch((error) => {
          console.error(`[agent-herder] ZCode event handling failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        });
        this.sessionEventTasks.add(task);
        void task.finally(() => this.sessionEventTasks.delete(task));
      });
      this.sessionEventUnsubscribers.set(sessionId, () => { active = false; unsubscribe(); });
      this.emitEvent({ kind: "process.connected", harness: "zcode", nativeType: "event-subscription-ready", data: { transport: "app-server-events" } });
    }).catch((error) => {
      this.sessionEventUnsubscribers.delete(sessionId);
      this.emitEvent({ kind: "process.disconnected", harness: "zcode", nativeType: "event-subscription-error", data: { transport: "app-server-events", error: error instanceof Error ? error.message : String(error) } });
    });
  }

  private clearQueuedPrompts(sessionId: string): void {
    this.queuedPrompts.delete(sessionId);
    const timer = this.queuedPromptTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.queuedPromptTimers.delete(sessionId);
  }

  private isRecentHerderCancellation(sessionId: string, turnId?: string): boolean {
    const request = this.locallyCancelledSessions.get(sessionId);
    if (!request || Date.now() - request.requestedAt > 60_000) {
      this.locallyCancelledSessions.delete(sessionId);
      return false;
    }
    if (!request.turnId || !turnId || request.turnId !== turnId) return false;
    this.locallyCancelledSessions.delete(sessionId);
    return true;
  }

  private emitEvent(event: HarnessEvent): void {
    const normalized = { ...event, at: event.at ?? new Date().toISOString() };
    for (const listener of [...this.eventListeners]) {
      try { listener(normalized); } catch { /* isolate listeners */ }
    }
  }

  private scheduleQueuedPromptFlush(sessionId: string, delayMs = 1_000): void {
    if (this.queuedPromptTimers.has(sessionId) || this.queuedPromptFlushes.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.queuedPromptTimers.delete(sessionId);
      void this.flushQueuedPrompt(sessionId);
    }, delayMs);
    timer.unref?.();
    this.queuedPromptTimers.set(sessionId, timer);
  }

  private async waitForTurnStart(
    sessionId: string,
    workspace: ZcodeWorkspaceRef,
    inputId: string,
    message: string,
    baseline: ZcodeSnapshot | undefined,
    acceptedStateRevision: number | undefined,
  ): Promise<TurnStartResult> {
    const waiterKey = `${sessionId}:${inputId}`;
    let resolveEvent!: (result: TurnStartResult) => void;
    const eventResult = new Promise<TurnStartResult>((resolve) => { resolveEvent = resolve; });
    this.turnStartWaiters.set(waiterKey, resolveEvent);
    this.ensureSessionEventSubscription(sessionId, workspace);
    const deadline = Date.now() + this.turnStartTimeoutMs;
    let lastReadError: string | undefined;
    let eventHistoryUnavailable = false;
    let keepArmed = false;
    try {
      do {
        if (!eventHistoryUnavailable) {
          try {
            const events = sessionEventsFromPayload(await this.callAgent("readSessionEvents", {
              ...workspace,
              sessionId,
              ...(typeof baseline?.runtime?.eventSeq === "number" ? { afterSeq: baseline.runtime.eventSeq } : {}),
              limit: 200,
            }));
            for (const event of events) {
              const payload = record(event.payload);
              if (nonEmptyString(payload.inputId) !== inputId) continue;
              const type = nonEmptyString(event.type);
              if (type === "turn.started" || type === "turn.completed") {
                return { ok: true, turnId: nonEmptyString(event.turnId) || nonEmptyString(payload.turnId) };
              }
              if (type === "turn.failed") {
                return { ok: false, error: admittedNativeTurnFailure(sessionId, event) };
              }
            }
            lastReadError = undefined;
          } catch (error) {
            lastReadError = error instanceof Error ? error.message : String(error);
            eventHistoryUnavailable = true;
          }
        }
        if (eventHistoryUnavailable && baseline) {
          try {
            const snapshot = await this.readSnapshot(sessionId, workspace);
            if (snapshotConfirmsPromptTurnStarted(snapshot, baseline, inputId, message, acceptedStateRevision)) {
              return { ok: true };
            }
          } catch (error) {
            lastReadError = error instanceof Error ? error.message : String(error);
          }
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        const signalled = await Promise.race([
          eventResult,
          new Promise<undefined>((resolve) => setTimeout(resolve, Math.min(250, remainingMs))),
        ]);
        if (signalled) return signalled;
      } while (Date.now() < deadline);
      keepArmed = true;
      return {
        ok: false,
        pending: true,
        error: `ZCode accepted prompt for ${sessionId}, but turn start was not observed${lastReadError ? ` (${lastReadError})` : ""}`,
      };
    } finally {
      if (!keepArmed && this.turnStartWaiters.get(waiterKey) === resolveEvent) this.turnStartWaiters.delete(waiterKey);
    }
  }

  private async flushQueuedPrompt(sessionId: string): Promise<void> {
    if (this.queuedPromptFlushes.has(sessionId)) return;
    const queue = this.queuedPrompts.get(sessionId);
    if (!queue?.length) return;
    const queuedPrompt = queue[0];
    const queuedMessage = queuedPrompt.message;
    let nextDelayMs = 0;
    this.queuedPromptFlushes.add(sessionId);
    try {
      let baseline = await this.readCurrentSnapshot(sessionId);
      const permissionError = this.pendingPermissionError(baseline);
      if (permissionError) {
        console.error(`[agent-herder] ${permissionError}`);
        nextDelayMs = 60_000;
        return;
      }
      if (await this.queuedPromptHeld(sessionId)) {
        this.queuedPrompts.delete(sessionId);
        return;
      }
      let workspace = this.sessionWorkspaces.get(sessionId) || this.workspace();
      let acceptedInputId: string | undefined;
      let acceptedStateRevision: number | undefined;
      const rememberQueuedGeneratedPrompt = async (turnId?: string): Promise<void> => {
        if (queuedPrompt.origin === "human") return;
        await getHumanStopStore().rememberGeneratedPrompt("zcode", sessionId, queuedMessage, turnId);
      };
      const bindQueuedGeneratedPromptTurn = async (turnId: string | undefined): Promise<void> => {
        if (!turnId || queuedPrompt.origin === "human") return;
        try {
          await rememberQueuedGeneratedPrompt(turnId);
        } catch (error) {
          console.error(`[agent-herder] failed to bind queued ZCode prompt turn for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      try {
        await rememberQueuedGeneratedPrompt();
        const inputId = zcodeInputId(randomUUID(), queuedPrompt.origin);
        const ack = record(await this.callAgent("sendPrompt", {
          ...workspace,
          sessionId,
          inputId,
          content: queuedMessage,
        }));
        if (ack.accepted !== true) throw new Error("ZCode sendPrompt did not acknowledge prompt admission");
        acceptedInputId = inputId;
        acceptedStateRevision = typeof ack.stateRevision === "number" ? ack.stateRevision : undefined;
        const ackTurnId = nonEmptyString(ack.turnId) || nonEmptyString(record(ack.turn).id);
        await bindQueuedGeneratedPromptTurn(ackTurnId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/prompt is already running/i.test(message)) {
          nextDelayMs = 1_000;
          return;
        }
        if (isInactiveSessionError(error)) {
          const resumed = await this.resumeSession(sessionId);
          if (resumed.ok) {
            try {
              baseline = await this.readCurrentSnapshot(sessionId);
              const retryPermissionError = this.pendingPermissionError(baseline);
              if (retryPermissionError) {
                console.error(`[agent-herder] ${retryPermissionError}`);
                nextDelayMs = 60_000;
                return;
              }
              if (await this.queuedPromptHeld(sessionId)) {
                this.queuedPrompts.delete(sessionId);
                return;
              }
              workspace = this.sessionWorkspaces.get(sessionId) || workspace;
              await rememberQueuedGeneratedPrompt();
              const inputId = zcodeInputId(randomUUID(), queuedPrompt.origin);
              const ack = record(await this.callAgent("sendPrompt", {
                ...workspace,
                sessionId,
                inputId,
                content: queuedMessage,
              }));
              if (ack.accepted !== true) throw new Error("ZCode sendPrompt did not acknowledge prompt admission");
              acceptedInputId = inputId;
              acceptedStateRevision = typeof ack.stateRevision === "number" ? ack.stateRevision : undefined;
              const ackTurnId = nonEmptyString(ack.turnId) || nonEmptyString(record(ack.turn).id);
              await bindQueuedGeneratedPromptTurn(ackTurnId);
            } catch (retryError) {
              const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
              if (/prompt is already running/i.test(retryMessage)) {
                nextDelayMs = 1_000;
                return;
              }
              if (!isInactiveSessionError(retryError)) {
                console.error(`[agent-herder] queued ZCode prompt failed for ${sessionId}: ${retryMessage}`);
                nextDelayMs = 5_000;
                return;
              }
              console.error(`[agent-herder] ${terminalInactiveResult(sessionId, retryError).error}; dropping queued prompts`);
              this.queuedPrompts.delete(sessionId);
              return;
            }
          } else {
            if (!isInactiveSessionError(resumed.error)) {
              console.error(`[agent-herder] queued ZCode prompt resume failed transiently for ${sessionId}: ${resumed.error || "ZCode native resume failed"}`);
              nextDelayMs = 5_000;
              return;
            }
            console.error(`[agent-herder] ${terminalInactiveResult(sessionId, resumed.error).error}; dropping queued prompts`);
            this.queuedPrompts.delete(sessionId);
            return;
          }
        } else {
          console.error(`[agent-herder] queued ZCode prompt failed for ${sessionId}: ${message}`);
          nextDelayMs = 5_000;
          return;
        }
      }
      if (!acceptedInputId) return;
      queue.shift();
      if (queue.length === 0) this.queuedPrompts.delete(sessionId);
      const started = await this.waitForTurnStart(sessionId, workspace, acceptedInputId, queuedMessage, baseline, acceptedStateRevision);
      if (started.ok) await bindQueuedGeneratedPromptTurn(started.turnId);
      if (!started.ok) {
        console.error(`[agent-herder] queued ZCode prompt admission was not followed by a turn for ${sessionId}: ${started.error || "unknown error"}`);
      }
      await this.persistDesiredSessionTitle(sessionId);
    } catch (error) {
      nextDelayMs = 5_000;
      console.error(`[agent-herder] queued ZCode prompt preflight failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.queuedPromptFlushes.delete(sessionId);
      if (this.queuedPrompts.get(sessionId)?.length) this.scheduleQueuedPromptFlush(sessionId, nextDelayMs);
    }
  }

  private async queuedPromptHeld(sessionId: string): Promise<boolean> {
    const fresh = await this.getSession(sessionId);
    if (fresh) return getHumanStopStore().observe(fresh);
    return getHumanStopStore().isHeld("zcode", sessionId);
  }

  private async callAgent(method: string, ...args: unknown[]): Promise<unknown> {
    await this.client.start();
    return this.client.call("zcode-agent", method, args);
  }

  private async resolveModelRef(model: string, currentProviderId?: string): Promise<ZcodeModelRef | undefined> {
    if (this.useLocalConfig) {
      try {
        const config = JSON.parse(await readFile(join(homedir(), ".zcode", "cli", "config.json"), "utf8")) as ZcodeLocalConfig;
        const configured = resolveConfiguredZcodeModel(model, config);
        if (configured) return configured;
      } catch { /* local CLI config is optional */ }
    }
    return parseModelName(model, currentProviderId);
  }

  private async callTask(method: string, ...args: unknown[]): Promise<unknown> {
    await this.client.start();
    return this.client.call("zcode-task", method, args);
  }
}
