import { JudgeRequestTrace, JudgeRequestError } from "./judge-request.js";
import { UserStyleStore, USER_STYLE_PROMPT, type StyleObservation } from "./user-style.js";
import type { RecoveryAdmissionGate, RecoveryOperation } from "./recovery-admission.js";
import {parseNativeOwnerProof,type NativeOwnerProof,type WorkspaceCrash} from '../adapters/zcode-workspace-lifecycle.js';

type WorkspaceLifecycleAdapter={
 restoreParentRuntimeLoss?(id:string,proof:NativeOwnerProof,session:AgentSession):boolean;
 workspaceCrashRecoveryAllowed?(sessionId:string,turnId?:string,inputId?:string):boolean|undefined;
 getWorkspaceCrashBoundary?(sessionId:string):WorkspaceCrash|undefined;
};
import { PendingQuestionGate } from "./pending-question-gate.js";
import type { ChoiceRegistry } from "./choice-registry.js";
import type { HumanRequestRegistry } from "../human-request/registry.js";
import type { CodexTrackedTurnCompletion } from "../adapters/codex-app-server.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import lockfile from "proper-lockfile";

import type { AgentSession, HarnessAdapter, HarnessEvent, HarnessType, SendMessageResult, SessionMessageView } from "../types/index.js";
import { localSessionHostId } from "../types/index.js";
import type { HumanStopStore } from "../human-stop-store.js";
import { cacheWindowFor, continuationModelFor, movePinnedContinuation, semanticTranscript, unfinishedProbeDelayMs, type CacheHandoffService } from "../cache-handoff.js";
import { deferredMessages, isBusyCodexWriter, type DeferredMessageStore } from "../deferred-messages.js";
import { effectivePolicyAllowsTarget, type EffectivePolicy } from "./policy.js";
import type { AutopilotPolicyStore } from "./policy-store.js";
import type { AutopilotSessionStore } from "./session-store.js";
import { AutomationLaunchPolicyStore, findProjectRoute, operatorCohortRecoveryAllowed } from "../automation-launch-policy.js";
import { resolveAutopilotStateDir } from "./state-dir.js";
import { automationDisarmDecision, sessionWorkKey, AutomationDisarmStore } from "../automation-disarm/index.js";

const SUPPORTED_HARNESSES: readonly HarnessType[] = ["codex", "opencode", "claude", "qoder", "hermes", "zcode", "fast-agent", "chatgpt"];
const DEFAULT_CONTINUATION = "Продолжи незавершённую задачу с того места, где выполнение было прервано. Сначала проверь текущее состояние и не повторяй уже завершённые действия.";
const MAX_TEXT = 1_024;
const DEFAULT_EVIDENCE_MESSAGE_COUNT = 200;
const MAX_EVIDENCE_MESSAGE_COUNT = 200;
const DEFAULT_BATCH_CONTEXT_TOKEN_BUDGET = 480_000;
const DEFAULT_BATCH_OUTPUT_TOKENS = 16_384;
// Bound group count against the 16k response ceiling. Any still-truncated
// chunk is rejected by exact coverage before a verdict or continuation applies.
const MAX_BATCH_PLAN_SESSIONS_PER_REQUEST = 32;
const MAX_BATCH_PLAN_CHUNKS = 64;
/**
 * Sequential provider rounds one planning phase may spend, at the configured
 * concurrency. The phase deadline is a ceiling, not a schedule: it cannot stop
 * a phase that keeps requesting inside it, and nothing is applied until the
 * whole phase finishes.
 */
const MAX_BATCH_PLAN_ROUNDS = 4;
const DEFAULT_BATCH_PLAN_CONCURRENCY = 3;
const MAX_REPAIRED_CHUNKS = 6;
/** Enough to leave a dead pooled connection behind, short enough to keep the phase budget. */
const TRANSIENT_PLANNER_RETRY_DELAY_MS = 5_000;
const QUOTA_DISPATCH_CLAIM_LEASE_MS = 30_000;
const CODEX_CLAUDE_RESTRICTED_PROJECT_ROOTS = [
  "/home/roomhacker/PycharmProjects/TelegramAuto",
  "/home/roomhacker/PycharmProjects/video_watching",
] as const;
const MAX_OMISSION_DECISION_CONCURRENCY = 4;
const MAX_PERSISTENT_OMISSION_DECISIONS = 4;
const MAX_SESSION_EVIDENCE_CHARS = 120_000;
// Version 3 invalidates completion inferred from matching titles or lifecycle
// exclusion. Original task evidence must be assessed independently.
const CURRENT_EVIDENCE_VERSION = 3;
// Increment only when semantic planning/packing changes make persisted
// assessment failures obsolete. Successful verdict evidence is unaffected.
// Version 3 bounds one cycle to a fitting priority window instead of refusing
// an oversized backlog, so the refusals stored under version 2 are obsolete.
const CURRENT_ASSESSMENT_PIPELINE_VERSION = 3;
const REQUESTED_ARTIFACT_COMPLETION_RULE = [
  "Сначала сопоставь финальный ответ с исходной пользовательской целью.",
  "Если пользователь просил только подготовить план, отчёт, черновик или JSON-артефакт, валидный финальный артефакт означает completed; будущие шаги внутри него — содержимое результата, а не оставшиеся действия агента.",
  "Если пользователь просил выполнить эти шаги, один лишь план, отчёт о намерении или черновик означает unfinished.",
  "Завершение turn, idle/stopped, queued/start/ADMITTED, перенос, replacement или совпадение названия с новой сессией сами по себе не доказывают completed исходной задачи.",
  "При запросе выполнения до результата проверяй фактический consumer и сохранённые checkpoint/blocker; незавершённый consumer или неустранённый blocker сохраняет задачу unfinished либо needs_human, без повторения внешних действий.",
].join(" ");

class BatchPlanValidationError extends Error {
  override name = "BatchPlanValidationError";
}

class BatchReconciliationValidationError extends Error {
  override name = "BatchReconciliationValidationError";
}

function sessionProgressFingerprint(session: AgentSession): string {
  return [
    session.status,
    session.lastActivity,
    session.messageCount ?? "",
    session.lastMessage?.slice(-256) ?? "",
    session.meta?.hasActiveToolCall === true ? "tool-active" : "tool-idle",
  ].join("|");
}

function sessionInventoryProgressFingerprint(session: AgentSession): string {
  return [
    session.messageCount ?? "",
    session.lastMessage?.slice(-256) ?? "",
    session.meta?.hasActiveToolCall === true ? "tool-active" : "tool-idle",
  ].join("|");
}

function nativeRecoveryIdentity(event: HarnessEvent): { turnId?: string; inputId?: string } {
  const data = event.data ?? {};
  const turnId = nonEmptyText(data.turnId) || nonEmptyText(data.nativeTurnId);
  const inputId = nonEmptyText(data.inputId) || nonEmptyText(data.promptId) || nonEmptyText(event.messageId);
  return { ...(turnId ? { turnId } : {}), ...(inputId ? { inputId } : {}) };
}

function sameNativeRecoveryIdentity(
  active: { turnId?: string; inputId?: string },
  observed: { turnId?: string; inputId?: string },
): boolean {
  if (active.turnId && observed.turnId) return active.turnId === observed.turnId;
  if (active.inputId && observed.inputId) return active.inputId === observed.inputId;
  return false;
}

function nativeTurnFenceKey(harness: string, sessionId: string, identity: { turnId?: string; inputId?: string }): string | undefined {
  if (identity.turnId) return `${sessionKey(harnessType(harness), sessionId)}:turn:${encodeURIComponent(identity.turnId)}`;
  if (identity.inputId) return `${sessionKey(harnessType(harness), sessionId)}:input:${encodeURIComponent(identity.inputId)}`;
  return undefined;
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

type OpenCodeResolvedProviderLeaf = { providerId: string; modelId: string };
type OpenCodeModelProviderResolution = {
  nativeHarness: string;
  nativeModelId: string;
  resolvedProviderLeaves: OpenCodeResolvedProviderLeaf[];
};

function isCodexClaudeRestrictedCohortProject(cwd: string): boolean {
  const project = normalize(cwd).replace(/\\/gu, "/").replace(/\/+$/u, "").toLocaleLowerCase("en-US");
  return CODEX_CLAUDE_RESTRICTED_PROJECT_ROOTS.some((root) => {
    const canonicalRoot = normalize(root).replace(/\\/gu, "/").replace(/\/+$/u, "").toLocaleLowerCase("en-US");
    return project === canonicalRoot || project.startsWith(`${canonicalRoot}/`);
  });
}

function isAllowedRestrictedProviderLeaf(leaf: OpenCodeResolvedProviderLeaf): boolean {
  const providerId = leaf.providerId.trim().toLocaleLowerCase("en-US");
  const modelId = leaf.modelId.trim().toLocaleLowerCase("en-US");
  if (!providerId || !modelId || /codex|claude/u.test(`${providerId}/${modelId}`)) return false;
  const allowedMiniMax = new Set(["minimax", "minimax-code", "minimax-coding-plan"]);
  const allowedGlm = new Set(["glm", "zai", "zai-coding-plan", "zhipu"]);
  const isMiniMax = allowedMiniMax.has(providerId) && /minimax|mmcode/u.test(modelId);
  const isGlm = allowedGlm.has(providerId) && /(^|[/_-])glm([-_/]|$)/u.test(modelId);
  return isMiniMax || isGlm;
}

function isAllowedRestrictedProviderResolution(
  resolution: OpenCodeModelProviderResolution | null | undefined,
  requestedModel: string,
): boolean {
  return resolution?.nativeHarness === "opencode"
    && resolution.nativeModelId === requestedModel
    && Array.isArray(resolution.resolvedProviderLeaves)
    && resolution.resolvedProviderLeaves.length > 0
    && resolution.resolvedProviderLeaves.every((leaf) => isAllowedRestrictedProviderLeaf(leaf));
}

function isSubagentSession(session: AgentSession | null | undefined): boolean {
  return session?.meta?.threadSource === "subagent";
}

/**
 * A native store that archived the session refuses to resume it and names the
 * exact repair in its own error text.
 *
 * The refusal repeats identically on every attempt, so it is a deterministic
 * condition rather than a transient failure: it must be repaired or reported
 * precisely, never retried as if another attempt could change the outcome.
 */
export function isArchivedSessionFailure(error: unknown): boolean {
  return typeof error === "string" && /\bis archived\b/i.test(error);
}

export type QuotaFailureEvidence = {
  classification: "quota_exhausted";
  nativeTurnId: string;
  inputId: string;
  providerId: string;
  modelId: string;
  resetAt?: string;
};

/** A human-authorized cohort entry backed by a fresh native terminal snapshot. */
export type OperatorCohortEvidence = {
  classification: "operator_cohort";
  authorizationId: string;
  nativeTurnId: string;
  assistantMessageId: string;
  providerId: string;
  modelId: string;
  completedAt: string;
};

/**
 * A new operator-authorized continuation from a fresh failed native-session
 * snapshot. The old accepted input remains UNKNOWN as to provider execution;
 * this record deliberately does not claim that its terminal frame belongs to
 * that input or that the provider did not execute it.
 */
export type OperatorContinuationEvidence = {
  classification: "operator_continuation";
  authorizationId: string;
  priorDispatchInputId: string;
  priorNativeInputMessageId: string;
  priorSelectedModel: string;
  snapshotToken: string;
  latestUserMessageId: string;
  latestTerminalEventId: string;
  terminalAt: string;
  providerExecution: "unknown";
};

export type QuotaRecoveryEvidence = QuotaFailureEvidence | OperatorCohortEvidence | OperatorContinuationEvidence;

export type QuotaRecoveryState = "waiting" | "dispatching" | "accepted" | "held" | "exhausted";

export type QuotaRecoveryRecord = {
  evidence: QuotaRecoveryEvidence;
  state: QuotaRecoveryState;
  nextAttemptAt: string;
  candidateModels: string[];
  candidateIndex: number;
  attempts: number;
  revision: number;
  selectedModel?: string;
  dispatchInputId?: string;
  dispatchNativeInputId?: string;
  dispatchTurnId?: string;
  claimedAt?: string;
  updatedAt: string;
  reasonCode?: "quota_waiting" | "quota_probe_due" | "dispatching" | "delivery_unknown" | "model_unavailable" | "candidate_exhausted" | "recovery_disabled" | "native_snapshot_changed" | "human_stop_active";
};

export type QuotaRecoveryHistoryEntry = {
  quotaRecovery: QuotaRecoveryRecord;
  acceptedAt?: string;
  admissionPhase?: UnfinishedSessionRecord["admissionPhase"];
  terminalReason?: UnfinishedSessionRecord["terminalReason"];
  terminalObservedAt?: string;
};

export type QuotaRecoveryWaitStatus = {
  harness: "opencode" | "zcode";
  sessionId: string;
  cwd: string;
  state: QuotaRecoveryState;
  origin: "native_quota" | "operator_cohort";
  reason: string;
  nextAttemptAt: string;
  resetAt?: string;
  currentModel: string;
  selectedModel?: string;
  attempts: number;
};

export type OperatorCohortEnrollmentTarget = {
  sessionId: string;
  cwd: string;
  expected: Pick<OperatorCohortEvidence, "nativeTurnId" | "assistantMessageId" | "providerId" | "modelId" | "completedAt">;
};

export type OperatorContinuationEnrollmentTarget = {
  sessionId: string;
  cwd: string;
  priorAccepted: {
    dispatchInputId: string;
    nativeInputMessageId: string;
  };
};

export type OperatorCohortEnrollmentResult = {
  sessionId: string;
  outcome: "enrolled" | "already_enrolled" | "ineligible";
  reason?: string;
  wait?: QuotaRecoveryWaitStatus;
};

type NativeLastTurn = {
  sessionId?: string;
  turnId?: string;
  assistantMessageId?: string;
  providerId?: string;
  modelId?: string;
  inputId?: string;
  status?: string;
  startedAt?: string;
  completedAt?: string;
  userMessageId?: string;
  rootSession?: boolean;
  cancelledByUser?: boolean;
  retryable?: boolean;
  userMessageMatchesLatest?: boolean;
  assistantSucceeded?: boolean;
  progressedAfterFailure?: boolean;
  pendingInput?: boolean;
  requiresHuman?: boolean;
  blockedReason?: string;
  errorType?: string;
  errorCode?: string;
  transportLost?: boolean;
  quotaFailure?: QuotaFailureEvidence;
};

type OpenCodeNativeContinuationReader = (sessionId: string, cwd: string) => Promise<OpenCodeOperatorContinuationSnapshot | null>;

export type OpenCodeOperatorContinuationSnapshot = {
  sessionId: string;
  cwd: string;
  modelId: string;
  outcome: "failed";
  active: "absent" | "idle";
  permissionCount: 0;
  inboxIds: [];
  latestUserMessageId: string;
  latestUserInputId: string;
  latestTerminalEventId: string;
  terminalAt: string;
  snapshotToken: string;
};

function nativeTimestamp(value: unknown): string | undefined {
  const timestamp = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= 8_640_000_000_000_000
    ? new Date(timestamp).toISOString() : undefined;
}

function nativeLastTurn(session: AgentSession | null | undefined): NativeLastTurn | undefined {
  const value = session?.meta?.nativeLastTurn;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const sessionId = nonEmptyText(record.sessionId);
  const turnId = nonEmptyText(record.turnId);
  const assistantMessageId = nonEmptyText(record.assistantMessageId);
  const providerId = nonEmptyText(record.providerId);
  const modelId = nonEmptyText(record.modelId);
  const status = nonEmptyText(record.status);
  const startedAt = nativeTimestamp(record.startedAt);
  const completedAt = nativeTimestamp(record.completedAt);
  const userMessageId = nonEmptyText(record.userMessageId);
  const inputId = nonEmptyText(record.inputId);
  const quotaFailure = normalizeQuotaFailureEvidence(record.quotaFailure);
  const errorType = nonEmptyText(record.errorType);
  const errorCode = nonEmptyText(record.errorCode);
  const blockedReason = nonEmptyText(record.blockedReason);
  return turnId || status ? {
    ...(sessionId ? { sessionId } : {}), ...(assistantMessageId ? { assistantMessageId } : {}),
    ...(providerId ? { providerId } : {}), ...(modelId ? { modelId } : {}),
    ...(turnId ? { turnId } : {}), ...(status ? { status } : {}),
    ...(inputId ? { inputId } : {}),
    ...(startedAt ? { startedAt } : {}), ...(completedAt ? { completedAt } : {}),
    ...(userMessageId ? { userMessageId } : {}),
    ...(typeof record.rootSession === "boolean" ? { rootSession: record.rootSession } : {}),
    ...(typeof record.cancelledByUser === "boolean" ? { cancelledByUser: record.cancelledByUser } : {}),
    ...(typeof record.retryable === "boolean" ? { retryable: record.retryable } : {}),
    ...(typeof record.userMessageMatchesLatest === "boolean" ? { userMessageMatchesLatest: record.userMessageMatchesLatest } : {}),
    ...(typeof record.assistantSucceeded === "boolean" ? { assistantSucceeded: record.assistantSucceeded } : {}),
    ...(typeof record.progressedAfterFailure === "boolean" ? { progressedAfterFailure: record.progressedAfterFailure } : {}),
    ...(typeof record.pendingInput === "boolean" ? { pendingInput: record.pendingInput } : {}),
    ...(typeof record.requiresHuman === "boolean" ? { requiresHuman: record.requiresHuman } : {}),
    ...(typeof record.transportLost === "boolean" ? { transportLost: record.transportLost } : {}),
    ...(blockedReason ? { blockedReason } : {}),
    ...(errorType ? { errorType } : {}), ...(errorCode ? { errorCode } : {}),
    ...(quotaFailure ? { quotaFailure } : {}),
  } : undefined;
}

function normalizeQuotaFailureEvidence(value: unknown): QuotaFailureEvidence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (input.classification !== "quota_exhausted") return undefined;
  const nativeTurnId = nonEmptyText(input.nativeTurnId);
  const inputId = nonEmptyText(input.inputId);
  const providerId = nonEmptyText(input.providerId);
  const modelId = nonEmptyText(input.modelId);
  if (!nativeTurnId || !inputId || !providerId || !modelId
    || [nativeTurnId, inputId, providerId, modelId].some((part) => /[\u0000-\u001f\u007f]/u.test(part) || part.length > 512)) return undefined;
  const resetAt = input.resetAt === undefined ? undefined : nativeTimestamp(input.resetAt);
  if (input.resetAt !== undefined && !resetAt) return undefined;
  return { classification: "quota_exhausted", nativeTurnId, inputId, providerId, modelId, ...(resetAt ? { resetAt } : {}) };
}

function normalizeOperatorCohortEvidence(value: unknown): OperatorCohortEvidence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (input.classification !== "operator_cohort") return undefined;
  const authorizationId = nonEmptyText(input.authorizationId);
  const nativeTurnId = nonEmptyText(input.nativeTurnId);
  const assistantMessageId = nonEmptyText(input.assistantMessageId);
  const providerId = nonEmptyText(input.providerId);
  const modelId = nonEmptyText(input.modelId);
  const completedAt = nativeTimestamp(input.completedAt);
  if (!authorizationId || !nativeTurnId || !assistantMessageId || !providerId || !modelId || !completedAt
    || [authorizationId, nativeTurnId, assistantMessageId, providerId, modelId].some((part) => /[\u0000-\u001f\u007f]/u.test(part) || part.length > 512)) return undefined;
  return { classification: "operator_cohort", authorizationId, nativeTurnId, assistantMessageId, providerId, modelId, completedAt };
}

function normalizeOperatorContinuationEvidence(value: unknown): OperatorContinuationEvidence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (input.classification !== "operator_continuation" || input.providerExecution !== "unknown") return undefined;
  const authorizationId = nonEmptyText(input.authorizationId);
  const priorDispatchInputId = nonEmptyText(input.priorDispatchInputId);
  const priorNativeInputMessageId = nonEmptyText(input.priorNativeInputMessageId);
  const priorSelectedModel = nonEmptyText(input.priorSelectedModel);
  const snapshotToken = nonEmptyText(input.snapshotToken);
  const latestUserMessageId = nonEmptyText(input.latestUserMessageId);
  const latestTerminalEventId = nonEmptyText(input.latestTerminalEventId);
  const terminalAt = nativeTimestamp(input.terminalAt);
  const ids = [authorizationId, priorDispatchInputId, priorNativeInputMessageId, priorSelectedModel,
    snapshotToken, latestUserMessageId, latestTerminalEventId].filter((value): value is string => Boolean(value));
  if (ids.length !== 7 || !terminalAt || ids.some((part) => /[\u0000-\u001f\u007f]/u.test(part) || part.length > 512)
    || !/^[a-f0-9]{64}$/iu.test(snapshotToken!)) return undefined;
  return {
    classification: "operator_continuation", authorizationId: authorizationId!, priorDispatchInputId: priorDispatchInputId!,
    priorNativeInputMessageId: priorNativeInputMessageId!, priorSelectedModel: priorSelectedModel!, snapshotToken: snapshotToken!,
    latestUserMessageId: latestUserMessageId!, latestTerminalEventId: latestTerminalEventId!, terminalAt,
    providerExecution: "unknown",
  };
}

function normalizeQuotaRecoveryEvidence(value: unknown): QuotaRecoveryEvidence | undefined {
  return normalizeQuotaFailureEvidence(value) ?? normalizeOperatorCohortEvidence(value) ?? normalizeOperatorContinuationEvidence(value);
}

function recoveryEvidenceTurnId(evidence: QuotaRecoveryEvidence): string | undefined {
  return evidence.classification === "operator_continuation" ? undefined : evidence.nativeTurnId;
}
function recoveryEvidenceInputId(evidence: QuotaRecoveryEvidence): string | undefined {
  return evidence.classification === "quota_exhausted" ? evidence.inputId
    : evidence.classification === "operator_continuation" ? evidence.priorDispatchInputId : undefined;
}
function recoveryEvidenceModelId(evidence: QuotaRecoveryEvidence): string {
  return evidence.classification === "quota_exhausted" ? quotaModelId(evidence) ?? evidence.modelId
    : evidence.classification === "operator_continuation" ? evidence.priorSelectedModel : evidence.modelId;
}

function isOperatorRecoveryEvidence(evidence: QuotaRecoveryEvidence): evidence is OperatorCohortEvidence | OperatorContinuationEvidence {
  return evidence.classification !== "quota_exhausted";
}

function sameRecoveryEvidence(left: QuotaRecoveryEvidence | undefined, right: QuotaRecoveryEvidence | undefined): boolean {
  if (!left || !right || left.classification !== right.classification) return false;
  if (left.classification === "quota_exhausted" && right.classification === "quota_exhausted") return sameQuotaFailure(left, right);
  if (left.classification === "operator_cohort" && right.classification === "operator_cohort") {
    return left.nativeTurnId === right.nativeTurnId && left.authorizationId === right.authorizationId
      && left.assistantMessageId === right.assistantMessageId && left.providerId === right.providerId
      && left.modelId === right.modelId && left.completedAt === right.completedAt;
  }
  return left.classification === "operator_continuation" && right.classification === "operator_continuation"
    && left.authorizationId === right.authorizationId && left.priorDispatchInputId === right.priorDispatchInputId
    && left.priorNativeInputMessageId === right.priorNativeInputMessageId && left.priorSelectedModel === right.priorSelectedModel
    && left.snapshotToken === right.snapshotToken && left.latestUserMessageId === right.latestUserMessageId
    && left.latestTerminalEventId === right.latestTerminalEventId && left.terminalAt === right.terminalAt
    && left.providerExecution === right.providerExecution;
}

function sameQuotaFailure(left: QuotaFailureEvidence | undefined, right: QuotaFailureEvidence | undefined): boolean {
  return Boolean(left && right
    && left.nativeTurnId === right.nativeTurnId
    && left.inputId === right.inputId
    && left.providerId === right.providerId
    && left.modelId === right.modelId);
}

function quotaModelId(evidence: QuotaFailureEvidence): string | undefined {
  if (evidence.providerId.toLocaleLowerCase("en-US") !== "omniroute") return undefined;
  const model = evidence.modelId.replace(/^omniroute\//iu, "");
  const fullId = `omniroute/${model}`;
  return model && model.length <= 256 && /^omniroute\/[A-Za-z0-9._-]+\/[^/\\]+(?:\/[^/\\]+)*$/iu.test(fullId)
    ? fullId : undefined;
}

function exactTerminalQuotaSnapshot(session: AgentSession | null | undefined, evidence: QuotaFailureEvidence): boolean {
  const last = nativeLastTurn(session);
  return Boolean(session && last
    && (last.status === "failed" || last.status === "error")
    && last.cancelledByUser !== true
    && last.turnId === evidence.nativeTurnId
    && last.inputId === evidence.inputId
    && sameQuotaFailure(last.quotaFailure, evidence));
}

function exactTerminalRecoverySnapshot(session: AgentSession | null | undefined, evidence: QuotaRecoveryEvidence): boolean {
  if (evidence.classification === "operator_continuation") return false;
  if (evidence.classification === "quota_exhausted") return exactTerminalQuotaSnapshot(session, evidence);
  const last = nativeLastTurn(session);
  return Boolean(session && last && last.sessionId === session.id
    && (last.status === "failed" || last.status === "error") && last.cancelledByUser !== true
    && last.turnId === evidence.nativeTurnId && last.assistantMessageId === evidence.assistantMessageId
    && last.providerId === evidence.providerId && last.modelId === evidence.modelId
    && last.completedAt && Date.parse(last.completedAt) === Date.parse(evidence.completedAt));
}

function quotaCandidateModels(fallbackModels: readonly string[], currentModel: string | readonly string[]): string[] {
  const currentModels = typeof currentModel === "string" ? [currentModel] : [...currentModel];
  const seen = new Set<string>(currentModels.map((model) => model.toLocaleLowerCase("en-US")));
  const candidates: string[] = [];
  for (const raw of fallbackModels) {
    const model = typeof raw === "string" ? raw.trim() : "";
    if (!model || model.length > 256 || /[\u0000-\u0020\u007f]/u.test(model) || !/^omniroute\//iu.test(model)) continue;
    const key = model.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(model);
    if (candidates.length >= 8) break;
  }
  candidates.push(...currentModels);
  return candidates;
}

function operatorFallbackCandidates(fallbackModels: readonly string[], currentModels: readonly string[]): string[] {
  const current = new Set(currentModels.map((model) => model.toLocaleLowerCase("en-US")));
  return quotaCandidateModels(fallbackModels, currentModels).filter((model) => !current.has(model.toLocaleLowerCase("en-US")));
}

function operatorContinuationModelCandidates(fallbackModels: readonly string[], currentModel: string): string[] {
  const exact = new Set(fallbackModels.map((value) => value.trim()).filter(Boolean));
  return exact.has(currentModel) && currentModel.startsWith("omniroute/") ? [currentModel] : [];
}

function openCodeEnvelope(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value) && "data" in value
    ? (value as Record<string, unknown>).data : value;
}

function openCodeRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function openCodeCreatedAt(value: unknown): number | undefined {
  const record = openCodeRecord(value);
  return typeof record?.created === "number" && Number.isFinite(record.created) ? record.created : undefined;
}

/**
 * Read-only native snapshot used only for a fresh operator continuation. The
 * terminal frame and prior accepted input are recorded as co-snapshot values;
 * this function intentionally does not claim the frame is input-bound or that
 * the provider did not execute the prior input.
 */
async function readOpenCodeOperatorContinuationSnapshot(
  sessionId: string,
  cwd: string,
): Promise<OpenCodeOperatorContinuationSnapshot | null> {
  const base = process.env.OPENCODE_URL?.trim() || "http://127.0.0.1:4095";
  let origin: URL;
  try {
    origin = new URL(base);
    if (!/^https?:$/u.test(origin.protocol) || origin.username || origin.password || origin.search || origin.hash
      || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(origin.hostname)) return null;
  } catch { return null; }
  const username = process.env.OPENCODE_SERVER_USERNAME?.trim() || "opencode";
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const headers: Record<string, string> = { accept: "application/json" };
  if (password) headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const prefix = `${origin.origin}/api`;
  const signal = AbortSignal.timeout(8_000);
  const get = async (path: string): Promise<unknown> => {
    const response = await fetch(`${prefix}${path}`, { method: "GET", headers, redirect: "error", signal });
    if (!response.ok) throw new Error("OpenCode operator snapshot read refused");
    return response.json() as Promise<unknown>;
  };
  try {
    const encoded = encodeURIComponent(sessionId);
    const [sessionValue, activeValue, permissionValue, inboxValue, messagesValue] = await Promise.all([
      get(`/session/${encoded}`), get("/session/active"), get("/permission/request"), get(`/session/${encoded}/inbox`),
      get(`/session/${encoded}/message?limit=150&order=desc`),
    ]);
    const session = openCodeRecord(openCodeEnvelope(sessionValue));
    const activeMap = openCodeRecord(openCodeEnvelope(activeValue));
    const permissions = openCodeEnvelope(permissionValue);
    const inbox = openCodeEnvelope(inboxValue);
    const fetchedMessages = openCodeEnvelope(messagesValue);
    if (!session || session.id !== sessionId || !activeMap || !Array.isArray(permissions) || !Array.isArray(inbox)
      || !Array.isArray(fetchedMessages) || session.outcome !== "failed") return null;
    const directory = nonEmptyText(openCodeRecord(session.location)?.directory) || nonEmptyText(session.directory);
    if (!directory || normalize(directory) !== normalize(cwd)) return null;
    const model = openCodeRecord(session.model);
    const provider = nonEmptyText(model?.providerID);
    const modelIdPart = nonEmptyText(model?.id);
    if (!provider || !modelIdPart) return null;
    const modelId = `${provider}/${modelIdPart}`;
    const activeEntry = openCodeRecord(activeMap[sessionId]);
    const activeType = nonEmptyText(activeEntry?.type) || nonEmptyText(activeEntry?.status);
    if (activeEntry && activeType !== "idle") return null;
    const pendingPermissions = permissions.filter((item) => openCodeRecord(item)?.sessionID === sessionId);
    if (pendingPermissions.length) return null;
    if (inbox.length) return null;
    const messages = fetchedMessages.map(openCodeRecord).filter((item): item is Record<string, unknown> => Boolean(item));
    if (!messages.length || messages.some((item) => !nonEmptyText(item.id) || item.sessionID && item.sessionID !== sessionId)) return null;
    const chronological = [...messages].reverse();
    const actors = chronological.filter((item) => item.type === "user" || item.type === "assistant");
    const latestActor = actors.at(-1);
    if (!latestActor || latestActor.type !== "user") return null;
    const metadata = openCodeRecord(latestActor.metadata);
    const latestUserMessageId = nonEmptyText(latestActor.id);
    const latestUserInputId = nonEmptyText(metadata?.agentHerderInputId);
    if (!latestUserMessageId || !latestUserInputId) return null;
    const terminalFrames = chronological.filter((item) => item.type === "idle" && item.outcome === "failed");
    const terminal = terminalFrames.at(-1);
    const latestTerminalEventId = nonEmptyText(terminal?.id);
    const terminalAtNumber = openCodeCreatedAt(terminal?.time);
    const userAt = openCodeCreatedAt(latestActor.time);
    if (!terminal || !latestTerminalEventId || terminalAtNumber === undefined || userAt === undefined || terminalAtNumber < userAt) return null;
    const safeMessages = chronological.map((item) => {
      const itemMetadata = openCodeRecord(item.metadata);
      const itemModel = openCodeRecord(item.model);
      return {
        id: item.id,
        type: item.type,
        outcome: item.outcome,
        time: openCodeCreatedAt(item.time),
        inputId: nonEmptyText(itemMetadata?.agentHerderInputId),
        providerId: nonEmptyText(itemModel?.providerID),
        modelId: nonEmptyText(itemModel?.id),
        errorType: nonEmptyText(openCodeRecord(item.error)?.type),
      };
    });
    const activeState: OpenCodeOperatorContinuationSnapshot["active"] = activeEntry ? "idle" : "absent";
    const snapshotToken = createHash("sha256").update(JSON.stringify({
      sessionId, cwd: normalize(directory), outcome: session.outcome, modelId,
      active: activeState, permissionCount: pendingPermissions.length, inboxIds: [], messages: safeMessages,
    })).digest("hex");
    return {
      sessionId, cwd: normalize(directory), modelId, outcome: "failed", active: activeState,
      permissionCount: 0, inboxIds: [], latestUserMessageId, latestUserInputId, latestTerminalEventId,
      terminalAt: new Date(terminalAtNumber).toISOString(), snapshotToken,
    };
  } catch {
    return null;
  }
}

function quotaBackoffMs(attempts: number): number {
  return Math.min(5 * 60_000, 30_000 * (2 ** Math.max(0, Math.min(3, attempts - 1))));
}

function confirmedQuotaFailureText(value: unknown): boolean {
  return typeof value === "string"
    && /(?:\b4292056\b|\b2056\b|\b(?:1308|1310|1316|1317|1318|1319|1320|1321)\b|quota[_ -]exhausted|quota exceeded|usage limit exceeded)/iu.test(value);
}

function quotaNextAttemptAt(evidence: QuotaFailureEvidence, now: Date): Date {
  const resetAt = evidence.resetAt ? Date.parse(evidence.resetAt) : Number.NaN;
  if (Number.isFinite(resetAt)) return resetAt > now.getTime() ? new Date(resetAt) : now;
  return new Date(now.getTime() + quotaBackoffMs(0));
}

function quotaRecoveryReason(quota: QuotaRecoveryRecord): string {
  if (quota.state === "held" && quota.reasonCode === "human_stop_active") {
    return "HumanStop активен; новое операторское продолжение удержано.";
  }
  if (quota.state === "held" && quota.reasonCode === "native_snapshot_changed") {
    return "Снимок native-сессии изменился после операторского разрешения; отправка удержана.";
  }
  if (quota.evidence.classification === "operator_continuation" && quota.state === "waiting") {
    return "Ожидает нового операторского продолжения; исполнение прежнего принятого ввода остаётся неизвестным, повтор прежнего ввода запрещён.";
  }
  if (quota.evidence.classification === "operator_continuation" && quota.state === "accepted") {
    return "Новый операторский ввод принят; исполнение прежнего принятого ввода остаётся неизвестным.";
  }
  if (quota.evidence.classification === "operator_cohort" && quota.state === "waiting") {
    return "Ожидает разрешённого продолжения; перед отправкой Herder повторно проверит точный завершённый сбой и ограничения сессии.";
  }
  if (quota.state === "waiting") return quota.evidence.classification === "quota_exhausted" && quota.evidence.resetAt
    ? "Ожидает срока сброса квоты; затем проверит точную нативную сессию перед продолжением."
    : "Ожидает ограниченной повторной попытки; неизвестная квота не считается доступной.";
  if (quota.state === "dispatching" && quota.reasonCode === "delivery_unknown") return "Квитанция отправки пока не подтверждена; повторная отправка запрещена, идёт точная сверка.";
  if (quota.state === "dispatching") return "Продолжение отправляется; повторная отправка запрещена до сверки нативной квитанции.";
  if (quota.state === "accepted") return "Нативный ввод принят; ожидается результат этого точного ввода.";
  if (quota.state === "exhausted" || quota.reasonCode === "candidate_exhausted") return "Запасные модели исчерпаны; автоматическая отправка остановлена.";
  if (quota.reasonCode === "delivery_unknown") return "Результат доставки неизвестен; автоматическая повторная отправка остановлена.";
  if (quota.reasonCode === "model_unavailable") return "Выбранная модель недоступна или не подтверждена нативным runtime.";
  if (quota.reasonCode === "recovery_disabled") return "Автовозобновление квоты отключено для этой сессии.";
  return "Автоматическое продолжение удержано до безопасной проверки.";
}

function coldFailureBlockReason(turn: NativeLastTurn): string | undefined {
  const diagnostic = `${turn.errorType ?? ""} ${turn.errorCode ?? ""}`.trim();
  if (turn.requiresHuman === true || /captcha|human|required.?action|action.?required|interaction.?required|permission|authentication|reauth|login.?required|consent/i.test(diagnostic)) {
    return `Сбой требует действия человека${turn.blockedReason || diagnostic ? `: ${turn.blockedReason || diagnostic}` : ""}`;
  }
  if (turn.transportLost === true) return undefined;
  if (turn.retryable !== true) return turn.retryable === false
    ? "Нативный сбой не допускает автоматический повтор"
    : "Нативный сбой не содержит подтверждённого разрешения на повтор";
  return undefined;
}

function admittedNonRetryableFailure(result: SendMessageResult): string | undefined {
  return !result.ok && result.admitted === true && result.nonRetryable === true
    ? result.error || "Native harness admitted the prompt, then failed the exact turn"
    : undefined;
}

export type UnfinishedSessionState = "active" | "recovering" | "exhausted";

export type SessionAutostartOverride = {
  harness: HarnessType;
  sessionId: string;
  cwd: string;
  enabled: boolean;
  updatedAt: string;
};

export type SessionAutostartHarnessOverride = {
  harness: HarnessType;
  enabled: boolean;
  updatedAt: string;
};

export type WaitForQuotaSource = "session" | "harness" | "global" | "default";

export type WaitForQuotaHarnessOverride = {
  harness: HarnessType;
  waitForQuota: boolean;
  updatedAt: string;
};

export type WaitForQuotaSessionOverride = {
  harness: HarnessType;
  sessionId: string;
  cwd: string;
  waitForQuota: boolean;
  updatedAt: string;
};

export type SessionAutostartFile = {
  version: 8;
  enabled: boolean;
  /** Independent opt-in for exact terminal provider quota recovery. */
  waitForQuota: boolean;
  /** Keep Codex/ZCode sessions visible while Autocontinue is responsible for them. */
  pinActiveSessions: boolean;
  /** Start a compact replacement after the provider cache window expires. */
  rolloverExpiredCache: boolean;
  /** Pin the replacement, then unpin the stale source sessions after a successful handoff. */
  movePinnedOnRollover: boolean;
  inventoryWindowHours: number;
  evidenceMessageCount: number;
  recoverOnFailure: boolean;
  recoverOnDisconnect: boolean;
  watchdogEnabled: boolean;
  watchdogIntervalSeconds: number;
  stalledTurnMinutes: number;
  judgeModel: string;
  autopilotJudgeModel: string;
  harnesses: SessionAutostartHarnessOverride[];
  sessions: SessionAutostartOverride[];
  waitForQuotaHarnesses: WaitForQuotaHarnessOverride[];
  waitForQuotaSessions: WaitForQuotaSessionOverride[];
};

/** Independent opt-out setting for restart continuation; it does not read autopilot policy. */
export class SessionAutostartStore {
  private operation: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string, private readonly env: NodeJS.ProcessEnv = process.env) {}

  async getSettings(): Promise<SessionAutostartFile & { source: "persisted" | "default"; waitForQuotaSource: "global" | "default" }> {
    const loaded = await this.readOptional();
    return loaded
      ? { ...cloneAutostartFile(loaded), source: "persisted", waitForQuotaSource: "global" }
      : { ...defaultAutostartFile(this.env), source: "default", waitForQuotaSource: "default" };
  }

  async getEffective(harness: string, sessionId: string, cwd: string): Promise<{
    enabled: boolean;
    source: "session" | "harness" | "global" | "default";
    cwd: string;
    updatedAt?: string;
    waitForQuota: boolean;
    waitForQuotaSource: WaitForQuotaSource;
    waitForQuotaOverride?: boolean;
  }> {
    const normalizedHarness = harnessType(harness);
    const normalizedCwd = normalize(bounded(cwd, "cwd"));
    const normalizedSessionId = bounded(sessionId, "sessionId");
    const settings = await this.getSettings();
    const aliases = settings.sessions.filter((record) => record.harness === normalizedHarness && record.sessionId === normalizedSessionId);
    const override = resolveSessionOverride(aliases, normalizedCwd);
    const quota = resolveWaitForQuota(settings, normalizedHarness, normalizedSessionId, normalizedCwd);
    if (override) return { enabled: override.enabled, source: "session", cwd: override.cwd, updatedAt: override.updatedAt, ...quota };
    const harnessOverride = settings.harnesses.find((record) => record.harness === normalizedHarness);
    return harnessOverride
      ? { enabled: harnessOverride.enabled, source: "harness", cwd: normalize(bounded(cwd, "cwd")), updatedAt: harnessOverride.updatedAt, ...quota }
      : { enabled: settings.enabled, source: settings.source === "persisted" ? "global" : "default", cwd: normalizedCwd, ...quota };
  }

  async setGlobalWaitForQuota(waitForQuota: boolean): Promise<SessionAutostartFile> {
    if (typeof waitForQuota !== "boolean") throw new Error("waitForQuota must be a boolean");
    return this.setGlobalOptions({ waitForQuota });
  }

  async setHarnessWaitForQuota(harness: string, waitForQuota: boolean | null, now = new Date()): Promise<void> {
    const normalizedHarness = harnessType(harness);
    if (waitForQuota !== null && typeof waitForQuota !== "boolean") throw new Error("waitForQuota must be a boolean or null");
    await this.mutate((file) => {
      const index = file.waitForQuotaHarnesses.findIndex((record) => record.harness === normalizedHarness);
      if (waitForQuota === null) {
        if (index >= 0) file.waitForQuotaHarnesses.splice(index, 1);
        return;
      }
      const record = { harness: normalizedHarness, waitForQuota, updatedAt: now.toISOString() };
      if (index < 0) file.waitForQuotaHarnesses.push(record);
      else file.waitForQuotaHarnesses[index] = record;
      file.waitForQuotaHarnesses.sort((left, right) => left.harness.localeCompare(right.harness));
    });
  }

  async setSessionWaitForQuota(target: { harness: string; sessionId: string; cwd: string }, waitForQuota: boolean | null, now = new Date()): Promise<void> {
    const normalized = {
      harness: harnessType(target.harness),
      sessionId: bounded(target.sessionId, "sessionId"),
      cwd: normalize(bounded(target.cwd, "cwd")),
    };
    if (waitForQuota !== null && typeof waitForQuota !== "boolean") throw new Error("waitForQuota must be a boolean or null");
    await this.mutate((file) => {
      const key = sessionKey(normalized.harness, normalized.sessionId, normalized.cwd);
      const index = file.waitForQuotaSessions.findIndex((record) => sessionKey(record.harness, record.sessionId, record.cwd) === key);
      if (waitForQuota === null) {
        if (index >= 0) file.waitForQuotaSessions.splice(index, 1);
        return;
      }
      const record = { ...normalized, waitForQuota, updatedAt: now.toISOString() };
      if (index < 0) file.waitForQuotaSessions.push(record);
      else file.waitForQuotaSessions[index] = record;
      file.waitForQuotaSessions.sort((left, right) => sessionKey(left.harness, left.sessionId, left.cwd).localeCompare(sessionKey(right.harness, right.sessionId, right.cwd)));
    });
  }

  async setGlobal(enabled: boolean): Promise<SessionAutostartFile> {
    return this.setGlobalOptions({ enabled });
  }

  async setGlobalOptions(input: { enabled?: boolean; waitForQuota?: boolean }): Promise<SessionAutostartFile> {
    if (input.enabled === undefined && input.waitForQuota === undefined) throw new Error("at least one global setting is required");
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("enabled must be a boolean");
    if (input.waitForQuota !== undefined && typeof input.waitForQuota !== "boolean") throw new Error("waitForQuota must be a boolean");
    return this.mutate((file) => {
      if (input.enabled !== undefined) file.enabled = input.enabled;
      if (input.waitForQuota !== undefined) file.waitForQuota = input.waitForQuota;
      return cloneAutostartFile(file);
    });
  }

  async setRuntimeSettings(input: { enabled?: boolean; waitForQuota?: boolean; pinActiveSessions?: boolean; inventoryWindowHours: number; evidenceMessageCount: number; judgeModel: string; autopilotJudgeModel: string; rolloverExpiredCache?: boolean; movePinnedOnRollover?: boolean; recoverOnFailure?: boolean; recoverOnDisconnect?: boolean; watchdogEnabled?: boolean; watchdogIntervalSeconds?: number; stalledTurnMinutes?: number }): Promise<SessionAutostartFile> {
    const inventoryWindowHours = positiveInteger(input.inventoryWindowHours, -1);
    if (inventoryWindowHours < 1 || inventoryWindowHours > 24 * 90) throw new Error("inventoryWindowHours must be an integer from 1 to 2160");
    const evidenceMessageCount = positiveInteger(input.evidenceMessageCount, -1);
    if (evidenceMessageCount < 2 || evidenceMessageCount > MAX_EVIDENCE_MESSAGE_COUNT) throw new Error(`evidenceMessageCount must be an integer from 2 to ${MAX_EVIDENCE_MESSAGE_COUNT}`);
    const judgeModel = boundedText(input.judgeModel, "judgeModel", 256).trim();
    const autopilotJudgeModel = boundedText(input.autopilotJudgeModel, "autopilotJudgeModel", 256).trim();
    if (!judgeModel || !autopilotJudgeModel) throw new Error("judge models must not be empty");
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("enabled must be a boolean");
    if (input.waitForQuota !== undefined && typeof input.waitForQuota !== "boolean") throw new Error("waitForQuota must be a boolean");
    if (input.pinActiveSessions !== undefined && typeof input.pinActiveSessions !== "boolean") throw new Error("pinActiveSessions must be a boolean");
    if (input.rolloverExpiredCache !== undefined && typeof input.rolloverExpiredCache !== "boolean") throw new Error("rolloverExpiredCache must be a boolean");
    if (input.movePinnedOnRollover !== undefined && typeof input.movePinnedOnRollover !== "boolean") throw new Error("movePinnedOnRollover must be a boolean");
    if (input.recoverOnFailure !== undefined && typeof input.recoverOnFailure !== "boolean") throw new Error("recoverOnFailure must be a boolean");
    if (input.recoverOnDisconnect !== undefined && typeof input.recoverOnDisconnect !== "boolean") throw new Error("recoverOnDisconnect must be a boolean");
    if (input.watchdogEnabled !== undefined && typeof input.watchdogEnabled !== "boolean") throw new Error("watchdogEnabled must be a boolean");
    const watchdogIntervalSeconds = boundedInteger(input.watchdogIntervalSeconds ?? 10, 5, 300, "watchdogIntervalSeconds");
    const stalledTurnMinutes = boundedInteger(input.stalledTurnMinutes ?? 2, 1, 120, "stalledTurnMinutes");
    return this.mutate((file) => {
      if (input.enabled !== undefined) file.enabled = input.enabled;
      if (input.waitForQuota !== undefined) file.waitForQuota = input.waitForQuota;
      if (input.pinActiveSessions !== undefined) file.pinActiveSessions = input.pinActiveSessions;
      file.inventoryWindowHours = inventoryWindowHours;
      file.evidenceMessageCount = evidenceMessageCount;
      file.judgeModel = judgeModel;
      file.autopilotJudgeModel = autopilotJudgeModel;
      if (input.rolloverExpiredCache !== undefined) file.rolloverExpiredCache = input.rolloverExpiredCache;
      if (input.movePinnedOnRollover !== undefined) file.movePinnedOnRollover = input.movePinnedOnRollover;
      if (input.recoverOnFailure !== undefined) file.recoverOnFailure = input.recoverOnFailure;
      if (input.recoverOnDisconnect !== undefined) file.recoverOnDisconnect = input.recoverOnDisconnect;
      if (input.watchdogEnabled !== undefined) file.watchdogEnabled = input.watchdogEnabled;
      file.watchdogIntervalSeconds = watchdogIntervalSeconds;
      file.stalledTurnMinutes = stalledTurnMinutes;
      return cloneAutostartFile(file);
    });
  }

  async getHarnessEffective(harness: string): Promise<{
    enabled: boolean;
    source: "harness" | "global" | "default";
    updatedAt?: string;
    waitForQuota: boolean;
    waitForQuotaSource: Exclude<WaitForQuotaSource, "session">;
    waitForQuotaOverride?: boolean;
  }> {
    const normalizedHarness = harnessType(harness);
    const settings = await this.getSettings();
    const override = settings.harnesses.find((record) => record.harness === normalizedHarness);
    const quotaOverride = settings.waitForQuotaHarnesses.find((record) => record.harness === normalizedHarness);
    const quota = quotaOverride
      ? { waitForQuota: quotaOverride.waitForQuota, waitForQuotaSource: "harness" as const, waitForQuotaOverride: quotaOverride.waitForQuota }
      : { waitForQuota: settings.waitForQuota, waitForQuotaSource: settings.waitForQuotaSource };
    return override
      ? { enabled: override.enabled, source: "harness", updatedAt: override.updatedAt, ...quota }
      : { enabled: settings.enabled, source: settings.source === "persisted" ? "global" : "default", ...quota };
  }

  async setHarness(harness: string, enabled: boolean, now = new Date()): Promise<SessionAutostartHarnessOverride> {
    const normalized: SessionAutostartHarnessOverride = {
      harness: harnessType(harness),
      enabled,
      updatedAt: now.toISOString(),
    };
    return this.mutate((file) => {
      const index = file.harnesses.findIndex((record) => record.harness === normalized.harness);
      if (index < 0) file.harnesses.push(normalized);
      else file.harnesses[index] = normalized;
      file.harnesses.sort((left, right) => left.harness.localeCompare(right.harness));
      return { ...normalized };
    });
  }

  async deleteHarness(harness: string): Promise<boolean> {
    return this.mutate((file) => {
      const normalizedHarness = harnessType(harness);
      const before = file.harnesses.length + file.waitForQuotaHarnesses.length;
      file.harnesses = file.harnesses.filter((record) => record.harness !== normalizedHarness);
      file.waitForQuotaHarnesses = file.waitForQuotaHarnesses.filter((record) => record.harness !== normalizedHarness);
      return file.harnesses.length + file.waitForQuotaHarnesses.length !== before;
    });
  }

  async setSession(target: { harness: string; sessionId: string; cwd: string }, enabled: boolean, now = new Date()): Promise<SessionAutostartOverride> {
    const normalized: SessionAutostartOverride = {
      harness: harnessType(target.harness),
      sessionId: bounded(target.sessionId, "sessionId"),
      cwd: normalize(bounded(target.cwd, "cwd")),
      enabled,
      updatedAt: now.toISOString(),
    };
    return this.mutate((file) => {
      const key = sessionKey(normalized.harness, normalized.sessionId, normalized.cwd);
      const index = file.sessions.findIndex((record) => sessionKey(record.harness, record.sessionId, record.cwd) === key);
      if (index < 0) file.sessions.push(normalized);
      else file.sessions[index] = normalized;
      file.sessions.sort((left, right) => sessionKey(left.harness, left.sessionId, left.cwd).localeCompare(sessionKey(right.harness, right.sessionId, right.cwd)));
      return { ...normalized };
    });
  }

  async deleteSession(harness: string, sessionId: string): Promise<boolean> {
    return this.mutate((file) => {
      const normalizedHarness = harnessType(harness);
      const normalizedSessionId = bounded(sessionId, "sessionId");
      const before = file.sessions.length + file.waitForQuotaSessions.length;
      file.sessions = file.sessions.filter((record) => record.harness !== normalizedHarness || record.sessionId !== normalizedSessionId);
      file.waitForQuotaSessions = file.waitForQuotaSessions.filter((record) => record.harness !== normalizedHarness || record.sessionId !== normalizedSessionId);
      return file.sessions.length + file.waitForQuotaSessions.length !== before;
    });
  }

  /** Atomically rewrite every legacy session override to the canonical cwd. */
  async migrateWorkspaceIdentities(sessions: AgentSession[]): Promise<number> {
    if (sessions.length === 0) return 0;
    return this.mutate((file) => {
      let migrated = 0;
      for (const session of sessions) {
        const harness = harnessType(session.harness);
        const matches = file.sessions.filter((record) => record.harness === harness && record.sessionId === session.id);
        if (matches.length === 0) continue;
        const canonicalCwd = normalize(session.cwd);
        if (matches.length === 1 && matches[0]!.cwd === canonicalCwd) continue;
        const selected = resolveSessionOverride(matches, canonicalCwd)!;
        file.sessions = file.sessions.filter((record) => record.harness !== harness || record.sessionId !== session.id);
        file.sessions.push({ ...selected, cwd: canonicalCwd });
        migrated += matches.length;
      }
      file.sessions.sort((left, right) => sessionKey(left.harness, left.sessionId, left.cwd).localeCompare(sessionKey(right.harness, right.sessionId, right.cwd)));
      return migrated;
    }, (migrated) => migrated > 0);
  }

  private async readOptional(): Promise<SessionAutostartFile | null> {
    try {
      return parseAutostartFile(JSON.parse(await readFile(this.path, "utf8")) as unknown, this.env);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async mutate<T>(
    operation: (file: SessionAutostartFile) => T | Promise<T>,
    shouldWrite: (result: T) => boolean = () => true,
  ): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const file = await this.readOptional() ?? defaultAutostartFile(this.env);
      const result = await operation(file);
      if (shouldWrite(result)) await atomicWrite(this.path, file);
      return result;
    } finally {
      release();
    }
  }
}

export interface UnfinishedSessionRecord {
  harness: HarnessType;
  sessionId: string;
  cwd: string;
  workspaceIdentity?: string;
  model?: string;
  title?: string;
  threadSource?: string;
  startedAt: string;
  updatedAt: string;
  /** Stable boundary for the most recent prompt accepted by the native harness. */
  acceptedAt?: string;
  /** Native status/message fingerprint captured at that acceptance boundary. */
  acceptedFingerprint?: string;
  /** Durable proof that native state changed after the accepted prompt. */
  progressObservedAt?: string;
  /** Admission was acknowledged, but the exact native turn has not started yet. */
  deliveryPending?: boolean;
  /** Durable native-admission phase; never infer terminal state from a stale idle snapshot. */
  admissionPhase?: "accepted_pending" | "in_progress" | "terminal_observed";
  /** Latest native progress fingerprint observed after admission. */
  lastProgressFingerprint?: string;
  /** Time of the latest distinct native snapshot after admission. */
  lastNativeProgressAt?: string;
  /** Explicit native terminal event which allows semantic completion assessment. */
  terminalReason?: "turn.completed" | "turn.failed";
  terminalObservedAt?: string;
  /** Durable assistant output followed this accepted prompt. */
  terminalAssistantObserved?: boolean;
  /** Number of bounded re-admissions after an explicit terminal turn without an assistant result. */
  terminalRetryCount?: number;
  /** Native admission crossed the idempotency boundary and then failed terminally. */
  nonRetryableAdmission?: boolean;
  /** Native proof authorizing same-session crash recovery. Semantic verdicts never set this. */
  recoveryCause?: "turn.failed" | "process.disconnected" | "stalled" | "quota_exhausted";
  /** Native receipt proves this turn must remain visible but must never be replayed automatically. */
  recoveryBlockedReason?: string;
  recoveryObservedAt?: string;
  recoveryTurnId?: string;
  recoveryInputId?: string;
  quotaRecovery?: QuotaRecoveryRecord;
  /** Immutable snapshots of accepted/unknown attempts superseded by a new operator intent. */
  quotaRecoveryHistory?: QuotaRecoveryHistoryEntry[];
  activeNativeOwner?: NativeOwnerProof;
  activeTurnStartedAt?: string;
  activeTurnId?: string;
  activeInputId?: string;
  generationId: string;
  attempts: number;
  state: UnfinishedSessionState;
  nextAttemptAt?: string;
  lastError?: string;
  notifiedAt?: string;
}

export type SessionCompletionVerdict = "completed" | "unfinished" | "needs_human";

export interface SessionInventoryVerdict {
  verdict: SessionCompletionVerdict;
  reason: string;
  confidence: number;
  judgedAt: string;
}

export interface UnfinishedSessionInventoryRecord {
  harness: "codex" | "zcode" | "opencode" | "fast-agent";
  sessionId: string;
  cwd: string;
  /** Stable adapter-owned workspace identity; cwd is the compatibility fallback. */
  workspaceIdentity?: string;
  title: string;
  status: AgentSession["status"];
  lastActivity: string;
  transcriptTail: string;
  /** Version/fingerprint prove that legacy evidence was rebuilt by the current packer. */
  evidenceVersion?: number;
  evidenceFingerprint?: string;
  /** Native status/message snapshot used to detect progress when timestamps collide. */
  progressFingerprint?: string;
  observedAt: string;
  verdict?: SessionInventoryVerdict;
  /** Durable semantic-planning backoff, independent from native resume attempts. */
  assessmentFailure?: {
    pipelineVersion: number;
    cohortId: string;
    evidenceFingerprint: string;
    count: number;
    lastError: string;
    failedAt: string;
    nextAttemptAt?: string;
    notifiedAt?: string;
  };
}

export interface SessionCompletionJudge {
  decide(input: { session: AgentSession; transcriptTail: string; signal?: AbortSignal }): Promise<Omit<SessionInventoryVerdict, "judgedAt">>;
  plan?(input: { sessions: SessionBatchCandidate[]; signal?: AbortSignal }): Promise<SessionBatchPlan>;
  reconcile?(input: { groups: SessionBatchReconciliationCandidate[]; signal?: AbortSignal }): Promise<SessionBatchReconciliation>;
}

export interface SessionBatchCandidate {
  humanMessages?: StyleObservation[];
  session: AgentSession;
  transcriptTail: string;
}

export interface SessionBatchPlanGroup {
  sourceSessionIds: string[];
  primarySessionId: string;
  verdict: SessionCompletionVerdict;
  reason: string;
  confidence: number;
  topic: string;
  handoff: string;
}

export interface SessionBatchPlan {
  groups: SessionBatchPlanGroup[];
}

export interface SessionBatchReconciliationCandidate {
  groupRef: string;
  workspaceIdentity: string;
  topic: string;
  verdict: SessionCompletionVerdict;
  reason: string;
  handoff: string;
  sourceSessionIds: string[];
  memberTitles: string[];
  humanGate: boolean;
}

export interface SessionBatchReconciliation {
  clusters: string[][];
}

type AssessedSession = SessionBatchCandidate & {
  adapter: HarnessAdapter;
  sourceKey: string;
  autoResumeEnabled: boolean;
  urgentSignalVersions: Map<string, number>;
  latestSemanticMessage?: Pick<SessionMessageView, "role" | "text">;
  acceptedTerminalRetryCount?: number;
  acceptedTerminalReason?: string;
  acceptedAdmissionTimedOut?: boolean;
};
type DiscoveryOutcome = "ready" | "idle" | "blocked";

type UnfinishedSessionFile = {
  version: 1;
  sessions: UnfinishedSessionRecord[];
  inventory?: UnfinishedSessionInventoryRecord[];
};

export interface UnfinishedSessionNotice {
  severity?: "critical" | "notice" | "info";
  title: string;
  body: string;
  dedupKey: string;
  correlationId: string;
  sourceId: string;
  signalType: string;
}

/** Durable, process-independent list of autopilot turns that have not completed. */
export class UnfinishedSessionStore {
  private operation: Promise<unknown> = Promise.resolve();
  private readonly lockTarget: string;

  constructor(private readonly path: string) {
    this.lockTarget = `${path}.lock`;
  }

  async list(): Promise<UnfinishedSessionRecord[]> {
    return (await this.read()).sessions.map(cloneUnfinishedSessionRecord);
  }

  async listInventory(): Promise<UnfinishedSessionInventoryRecord[]> {
    return (await this.read()).inventory?.map(cloneInventoryRecord) ?? [];
  }

  async upsertInventory(record: UnfinishedSessionInventoryRecord): Promise<void> {
    await this.upsertInventoryBatch([record]);
  }

  async upsertInventoryBatch(records: UnfinishedSessionInventoryRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.mutate((file) => {
      const inventory = file.inventory ??= [];
      const positions = new Map(inventory.map((candidate, index) => [inventoryRecordKey(candidate), index]));
      for (const record of records) {
        const key = inventoryRecordKey(record);
        const index = positions.get(key);
        if (index === undefined) {
          positions.set(key, inventory.length);
          inventory.push(cloneInventoryRecord(record));
        } else inventory[index] = cloneInventoryRecord(record);
      }
      inventory.sort((left, right) => Date.parse(right.lastActivity) - Date.parse(left.lastActivity));
    });
  }

  /** Keep inventory equal to the latest successful native snapshots for the selected harnesses. */
  async reconcileInventorySnapshot(harnesses: ReadonlySet<"codex" | "zcode">, sourceKeys: ReadonlySet<string>): Promise<number> {
    if (harnesses.size === 0) return 0;
    return this.mutate((file) => {
      if (!file.inventory) return 0;
      const before = file.inventory.length;
      file.inventory = file.inventory.filter((record) => !harnesses.has(record.harness as "codex" | "zcode")
        || sourceKeys.has(inventoryRecordKey(record)));
      return before - file.inventory.length;
    }, (removed) => removed > 0);
  }

  async excludeSession(harness: string, sessionId: string): Promise<void> {
    await this.mutate((file) => {
      file.sessions = file.sessions.filter((record) => record.harness !== harness || record.sessionId !== sessionId);
      if (file.inventory) file.inventory = file.inventory.filter((record) => record.harness !== harness || record.sessionId !== sessionId);
    });
  }

  /** Atomically migrate legacy cwd-only keys before recovery can observe both identities. */
  async migrateWorkspaceIdentities(sessions: AgentSession[]): Promise<{ sessions: number; inventory: number }> {
    if (sessions.length === 0) return { sessions: 0, inventory: 0 };
    return this.mutate((file) => {
      let migratedSessions = 0;
      let migratedInventory = 0;
      for (const session of sessions) {
        const harness = harnessType(session.harness);
        const identity = sessionWorkspaceIdentity(session);
        const matchingRecords = file.sessions.filter((record) => record.harness === harness && record.sessionId === session.id);
        if (matchingRecords.length > 0 && (matchingRecords.length > 1
          || matchingRecords[0]!.workspaceIdentity !== identity
          || matchingRecords[0]!.cwd !== normalize(session.cwd))) {
          const merged = mergeUnfinishedIdentityRecords(matchingRecords, session, identity);
          file.sessions = file.sessions.filter((record) => record.harness !== harness || record.sessionId !== session.id);
          file.sessions.push(merged);
          migratedSessions += matchingRecords.length;
        }
        const matchingInventory = (file.inventory ?? []).filter((record) => record.harness === harness && record.sessionId === session.id);
        if (matchingInventory.length > 0 && (matchingInventory.length > 1
          || matchingInventory[0]!.workspaceIdentity !== identity
          || matchingInventory[0]!.cwd !== normalize(session.cwd))) {
          const merged = mergeInventoryIdentityRecords(matchingInventory, session, identity);
          file.inventory = (file.inventory ?? []).filter((record) => record.harness !== harness || record.sessionId !== session.id);
          file.inventory.push(merged);
          migratedInventory += matchingInventory.length;
        }
      }
      sortRecords(file.sessions);
      file.inventory?.sort((left, right) => Date.parse(right.lastActivity) - Date.parse(left.lastActivity));
      return { sessions: migratedSessions, inventory: migratedInventory };
    }, ({ sessions: migratedSessions, inventory }) => migratedSessions > 0 || inventory > 0);
  }

  /** Remove legacy non-Codex/ZCode turn records and inventory outside the configured audit window. */
  async pruneAutocontinueScope(inventoryCutoff: Date): Promise<{ sessions: number; inventory: number }> {
    return this.mutate((file) => {
      const beforeSessions = file.sessions.length;
      const beforeInventory = file.inventory?.length ?? 0;
      file.sessions = file.sessions.filter((record) => isAutocontinueInventoryHarness(record.harness) || Boolean(record.quotaRecovery));
      if (file.inventory) {
        const cutoff = inventoryCutoff.getTime();
        file.inventory = file.inventory.filter((record) => {
          const lastActivity = Date.parse(record.lastActivity);
          return (isAutocontinueInventoryHarness(record.harness) || record.harness === "opencode")
            && Number.isFinite(lastActivity)
            && lastActivity >= cutoff;
        });
      }
      return {
        sessions: beforeSessions - file.sessions.length,
        inventory: beforeInventory - (file.inventory?.length ?? 0),
      };
    }, (removed) => removed.sessions > 0 || removed.inventory > 0);
  }

  async markStarted(
    session: AgentSession,
    generationId = "external",
    now = new Date(),
    resetAttempts = false,
    acceptedDelivery = false,
    deliveryPending = false,
    admittedFailure?: string,
  ): Promise<UnfinishedSessionRecord> {
    const harness = harnessType(session.harness);
    const normalized = normalizeRecordTarget({
      harness,
      sessionId: session.id,
      cwd: session.cwd,
      model: session.model,
      title: session.title,
      threadSource: nonEmptyText(session.meta?.threadSource),
    });
    return this.mutate((file) => {
      const workspaceIdentity = sessionWorkspaceIdentity(session);
      const key = sessionKey(harness, session.id, workspaceIdentity);
      const index = file.sessions.findIndex((record) => unfinishedRecordKey(record) === key);
      const existing = index >= 0 ? file.sessions[index] : undefined;
      const reset = existing?.state === "exhausted";
      const fingerprint = sessionProgressFingerprint(session);
      const readmission = acceptedDelivery && existing?.admissionPhase === "terminal_observed"
        && existing.terminalAssistantObserved !== true;
      const record: UnfinishedSessionRecord = {
        ...normalized,
        workspaceIdentity,
        startedAt: reset || !existing ? now.toISOString() : existing.startedAt,
        updatedAt: now.toISOString(),
        generationId: existing?.activeNativeOwner&&existing.activeTurnId&&!acceptedDelivery ? existing.generationId : bounded(generationId, "generationId"),
        attempts: reset || resetAttempts ? 0 : existing?.attempts ?? 0,
        state: "active",
        ...(existing?.recoveryCause ? {
          recoveryCause: existing.recoveryCause,
          ...(existing.recoveryObservedAt ? { recoveryObservedAt: existing.recoveryObservedAt } : {}),
          ...(existing.recoveryTurnId ? { recoveryTurnId: existing.recoveryTurnId } : {}),
          ...(existing.recoveryInputId ? { recoveryInputId: existing.recoveryInputId } : {}),
        } : {}),
        ...(existing?.quotaRecovery ? { quotaRecovery: cloneQuotaRecovery(existing.quotaRecovery) } : {}),
        ...(existing?.activeNativeOwner ? {activeNativeOwner:existing.activeNativeOwner} : {}),
        ...(existing?.activeTurnStartedAt ? {
          activeTurnStartedAt: existing.activeTurnStartedAt,
          ...(existing.activeTurnId ? { activeTurnId: existing.activeTurnId } : {}),
          ...(existing.activeInputId ? { activeInputId: existing.activeInputId } : {}),
        } : {}),
        ...(acceptedDelivery
          ? {
              acceptedAt: now.toISOString(),
              acceptedFingerprint: fingerprint,
              admissionPhase: "accepted_pending",
              lastProgressFingerprint: fingerprint,
              lastNativeProgressAt: now.toISOString(),
              terminalRetryCount: readmission
                ? (existing?.terminalRetryCount ?? 0) + 1
                : existing?.terminalAssistantObserved ? 0 : existing?.terminalRetryCount ?? 0,
              ...(deliveryPending ? { deliveryPending: true } : {}),
              ...(admittedFailure ? { lastError: bounded(admittedFailure, "admittedFailure"), nonRetryableAdmission: true } : {}),
            }
          : existing?.acceptedAt
            ? {
                acceptedAt: existing.acceptedAt,
                ...(existing.acceptedFingerprint ? { acceptedFingerprint: existing.acceptedFingerprint } : {}),
                ...(existing.progressObservedAt ? { progressObservedAt: existing.progressObservedAt } : {}),
                ...(existing.deliveryPending ? { deliveryPending: true } : {}),
                ...(existing.admissionPhase ? { admissionPhase: existing.admissionPhase } : {}),
                ...(existing.lastProgressFingerprint ? { lastProgressFingerprint: existing.lastProgressFingerprint } : {}),
                ...(existing.lastNativeProgressAt ? { lastNativeProgressAt: existing.lastNativeProgressAt } : {}),
                ...(existing.terminalReason ? { terminalReason: existing.terminalReason } : {}),
                ...(existing.terminalObservedAt ? { terminalObservedAt: existing.terminalObservedAt } : {}),
                ...(existing.terminalRetryCount !== undefined ? { terminalRetryCount: existing.terminalRetryCount } : {}),
                ...(existing.terminalAssistantObserved ? { terminalAssistantObserved: true } : {}),
                ...(existing.nonRetryableAdmission ? {
                  nonRetryableAdmission: true,
                  ...(existing.lastError ? { lastError: existing.lastError } : {}),
                } : {}),
              }
            : {}),
      };
      if (index < 0) file.sessions.push(record);
      else file.sessions[index] = record;
      sortRecords(file.sessions);
      return { ...record };
    });
  }

  async markRecoveryEligible(
    session: AgentSession,
    cause: NonNullable<UnfinishedSessionRecord["recoveryCause"]>,
    identity: { turnId?: string; inputId?: string },
    generationId = "native-recovery",
    now = new Date(),
  ): Promise<UnfinishedSessionRecord> {
    await this.markStarted(session, generationId, now, true);
    return this.mutate((file) => {
      const record = findUnfinishedRecord(file.sessions, harnessType(session.harness), session.id, sessionWorkspaceIdentity(session));
      if (!record) throw new Error("native recovery record disappeared");
      record.recoveryCause = cause;
      record.recoveryObservedAt = now.toISOString();
      if (identity.turnId) record.recoveryTurnId = bounded(identity.turnId, "recoveryTurnId");
      if (identity.inputId) record.recoveryInputId = bounded(identity.inputId, "recoveryInputId");
      delete record.activeTurnStartedAt;
      delete record.activeTurnId;
      delete record.activeInputId;
      record.updatedAt = now.toISOString();
      return { ...record };
    });
  }

  /** Persist exact terminal quota evidence and an idempotent candidate schedule. */
  async markQuotaRecoveryEligible(
    session: AgentSession,
    rawEvidence: QuotaFailureEvidence,
    fallbackModels: readonly string[],
    generationId = "quota-recovery",
    now = new Date(),
  ): Promise<UnfinishedSessionRecord> {
    const evidence = normalizeQuotaFailureEvidence(rawEvidence);
    const currentModel = evidence ? quotaModelId(evidence) : undefined;
    if (!evidence || !currentModel || !["opencode", "zcode"].includes(session.harness)) throw new Error("invalid terminal quota recovery evidence");
    const normalized = normalizeRecordTarget({ harness: harnessType(session.harness), sessionId: session.id, cwd: session.cwd,
      model: session.model, title: session.title, threadSource: nonEmptyText(session.meta?.threadSource) });
    const candidates = quotaCandidateModels(fallbackModels, currentModel);
    const nowIso = now.toISOString();
    const nextAttemptAt = quotaNextAttemptAt(evidence, now).toISOString();
    return this.mutate((file) => {
      const workspaceIdentity = sessionWorkspaceIdentity(session);
      const key = sessionKey(normalized.harness, session.id, workspaceIdentity);
      const index = file.sessions.findIndex((record) => unfinishedRecordKey(record) === key);
      const existing = index < 0 ? undefined : file.sessions[index];
      if (existing?.quotaRecovery
        && existing.quotaRecovery.evidence.classification === "quota_exhausted"
        && existing.quotaRecovery.evidence.nativeTurnId === evidence.nativeTurnId
        && existing.quotaRecovery.evidence.inputId === evidence.inputId) return { ...existing };
      const quotaRecovery: QuotaRecoveryRecord = {
        evidence,
        state: "waiting",
        nextAttemptAt,
        candidateModels: candidates,
        candidateIndex: 0,
        attempts: 0,
        revision: (existing?.quotaRecovery?.revision ?? 0) + 1,
        updatedAt: nowIso,
        reasonCode: "quota_waiting",
      };
      const record: UnfinishedSessionRecord = {
        ...(existing ?? {
          ...normalized,
          workspaceIdentity,
          startedAt: nowIso,
          generationId: bounded(generationId, "generationId"),
          attempts: 0,
          state: "active" as const,
        }),
        ...normalized,
        workspaceIdentity,
        updatedAt: nowIso,
        state: "active",
        recoveryCause: "quota_exhausted",
        recoveryObservedAt: nowIso,
        recoveryTurnId: evidence.nativeTurnId,
        recoveryInputId: evidence.inputId,
        quotaRecovery,
        nextAttemptAt,
        admissionPhase: existing?.acceptedAt ? "terminal_observed" : existing?.admissionPhase,
        ...(existing?.acceptedAt ? { terminalReason: "turn.failed" as const, terminalObservedAt: nowIso } : {}),
      };
      delete record.activeTurnStartedAt;
      delete record.activeTurnId;
      delete record.activeInputId;
      delete record.recoveryBlockedReason;
      delete record.lastError;
      if (index < 0) file.sessions.push(record);
      else file.sessions[index] = record;
      sortRecords(file.sessions);
      return { ...record };
    });
  }

  /** Persist one explicitly authorized cohort continuation, separate from quota proof. */
  async markOperatorCohortEligible(
    session: AgentSession,
    evidence: OperatorCohortEvidence,
    fallbackModels: readonly string[],
    generationId = "operator-cohort",
    now = new Date(),
  ): Promise<UnfinishedSessionRecord> {
    const normalizedEvidence = normalizeOperatorCohortEvidence(evidence);
    const currentModel = normalizedEvidence?.modelId;
    if (!normalizedEvidence || session.harness !== "opencode" || !currentModel) throw new Error("invalid operator cohort evidence");
    const normalized = normalizeRecordTarget({ harness: "opencode", sessionId: session.id, cwd: session.cwd,
      model: session.model, title: session.title, threadSource: nonEmptyText(session.meta?.threadSource) });
    const candidates = operatorFallbackCandidates(fallbackModels, [currentModel, session.model ?? ""]);
    if (!candidates.length) throw new Error("no configured fallback candidate is available for this operator cohort session");
    const nowIso = now.toISOString();
    return this.mutate((file) => {
      const workspaceIdentity = sessionWorkspaceIdentity(session);
      const key = sessionKey("opencode", session.id, workspaceIdentity);
      const index = file.sessions.findIndex((record) => unfinishedRecordKey(record) === key);
      const existing = index < 0 ? undefined : file.sessions[index];
      const previous = existing?.quotaRecovery;
      if (previous?.evidence.classification === "operator_cohort"
        && previous.evidence.authorizationId === normalizedEvidence.authorizationId
        && sameRecoveryEvidence(previous.evidence, normalizedEvidence)) return { ...existing! };
      if (previous && (["waiting", "dispatching", "accepted"].includes(previous.state)
        || previous.state === "held" && previous.reasonCode === "delivery_unknown")) {
        throw new Error("session already has pending, in-flight, accepted, or unknown quota recovery");
      }
      const quotaRecovery: QuotaRecoveryRecord = {
        evidence: normalizedEvidence,
        state: "waiting",
        nextAttemptAt: nowIso,
        candidateModels: candidates,
        candidateIndex: 0,
        attempts: 0,
        revision: (previous?.revision ?? 0) + 1,
        updatedAt: nowIso,
        reasonCode: "quota_waiting",
      };
      const record: UnfinishedSessionRecord = {
        ...(existing ?? { ...normalized, workspaceIdentity, startedAt: nowIso, generationId: bounded(generationId, "generationId"), attempts: 0, state: "active" as const }),
        ...normalized,
        workspaceIdentity,
        updatedAt: nowIso,
        state: "active",
        quotaRecovery,
        nextAttemptAt: nowIso,
      };
      delete record.activeTurnStartedAt;
      delete record.activeTurnId;
      delete record.activeInputId;
      delete record.recoveryCause;
      delete record.recoveryTurnId;
      delete record.recoveryInputId;
      delete record.recoveryObservedAt;
      delete record.recoveryBlockedReason;
      delete record.lastError;
      if (index < 0) file.sessions.push(record);
      else file.sessions[index] = record;
      sortRecords(file.sessions);
      return { ...record };
    });
  }

  /** Replace only an exactly matched accepted/unknown receipt with a new, audited operator continuation. */
  async markOperatorContinuationEligible(
    session: AgentSession,
    rawEvidence: OperatorContinuationEvidence,
    now = new Date(),
  ): Promise<UnfinishedSessionRecord> {
    const evidence = normalizeOperatorContinuationEvidence(rawEvidence);
    const currentModel = session.model?.trim();
    if (!evidence || session.harness !== "opencode" || !currentModel || currentModel !== evidence.priorSelectedModel) {
      throw new Error("invalid operator continuation snapshot");
    }
    const normalized = normalizeRecordTarget({ harness: "opencode", sessionId: session.id, cwd: session.cwd,
      model: session.model, title: session.title, threadSource: nonEmptyText(session.meta?.threadSource) });
    const nowIso = now.toISOString();
    return this.mutate((file) => {
      const workspaceIdentity = sessionWorkspaceIdentity(session);
      const key = sessionKey("opencode", session.id, workspaceIdentity);
      const index = file.sessions.findIndex((record) => unfinishedRecordKey(record) === key);
      const existing = index < 0 ? undefined : file.sessions[index];
      const previous = existing?.quotaRecovery;
      if (previous?.evidence.classification === "operator_continuation"
        && sameRecoveryEvidence(previous.evidence, evidence) && previous.state !== "held" && previous.state !== "exhausted") {
        return { ...existing! };
      }
      if (!existing || !previous || !["accepted", "held"].includes(previous.state)
        || previous.state === "held" && previous.reasonCode !== "delivery_unknown"
        || previous.dispatchInputId !== evidence.priorDispatchInputId
        || previous.dispatchNativeInputId !== evidence.priorNativeInputMessageId
        || previous.selectedModel !== evidence.priorSelectedModel) {
        throw new Error("prior accepted/unknown receipt does not exactly match this operator continuation");
      }
      const history = [...(existing.quotaRecoveryHistory ?? []), {
        quotaRecovery: cloneQuotaRecovery(previous),
        ...(existing.acceptedAt ? { acceptedAt: existing.acceptedAt } : {}),
        ...(existing.admissionPhase ? { admissionPhase: existing.admissionPhase } : {}),
        ...(existing.terminalReason ? { terminalReason: existing.terminalReason } : {}),
        ...(existing.terminalObservedAt ? { terminalObservedAt: existing.terminalObservedAt } : {}),
      }].slice(-16);
      const quotaRecovery: QuotaRecoveryRecord = {
        evidence,
        state: "waiting",
        nextAttemptAt: nowIso,
        candidateModels: [evidence.priorSelectedModel],
        candidateIndex: 0,
        attempts: 0,
        revision: previous.revision + 1,
        updatedAt: nowIso,
        reasonCode: "quota_waiting",
      };
      const record: UnfinishedSessionRecord = {
        ...existing,
        ...normalized,
        workspaceIdentity,
        updatedAt: nowIso,
        state: "active",
        quotaRecoveryHistory: history,
        quotaRecovery,
        nextAttemptAt: nowIso,
      };
      delete record.acceptedAt;
      delete record.acceptedFingerprint;
      delete record.progressObservedAt;
      delete record.deliveryPending;
      delete record.admissionPhase;
      delete record.lastProgressFingerprint;
      delete record.lastNativeProgressAt;
      delete record.terminalReason;
      delete record.terminalObservedAt;
      delete record.terminalAssistantObserved;
      delete record.terminalRetryCount;
      delete record.nonRetryableAdmission;
      delete record.activeTurnStartedAt;
      delete record.activeTurnId;
      delete record.activeInputId;
      delete record.recoveryCause;
      delete record.recoveryTurnId;
      delete record.recoveryInputId;
      delete record.recoveryObservedAt;
      delete record.recoveryBlockedReason;
      delete record.lastError;
      if (index < 0) file.sessions.push(record);
      else file.sessions[index] = record;
      sortRecords(file.sessions);
      return { ...record };
    });
  }

  /** Atomically claim one due model attempt across all service processes. */
  async claimQuotaRecoveryAttempt(snapshot: UnfinishedSessionRecord, selectedModel: string, now = new Date()): Promise<UnfinishedSessionRecord | null> {
    return this.mutate((file) => {
      const record = file.sessions.find((item) => unfinishedRecordKey(item) === unfinishedRecordKey(snapshot));
      const quota = record?.quotaRecovery;
      if (!record || !quota || quota.state !== "waiting" || quota.revision !== snapshot.quotaRecovery?.revision
        || Date.parse(quota.nextAttemptAt) > now.getTime() || quota.candidateModels[quota.candidateIndex] !== selectedModel) return null;
      quota.state = "dispatching";
      quota.selectedModel = bounded(selectedModel, "selectedModel");
      quota.dispatchInputId = `herder-quota:${randomUUID()}`;
      quota.claimedAt = now.toISOString();
      quota.attempts += 1;
      quota.revision += 1;
      quota.updatedAt = now.toISOString();
      quota.reasonCode = "dispatching";
      record.state = "recovering";
      delete record.nextAttemptAt;
      record.updatedAt = now.toISOString();
      return { ...record, quotaRecovery: { ...quota, evidence: { ...quota.evidence }, candidateModels: [...quota.candidateModels] } };
    }, (record) => record !== null);
  }

  /** Settle a claimed native attempt; accepted/unknown receipts are never requeued. */
  async settleQuotaRecoveryAttempt(
    snapshot: UnfinishedSessionRecord,
    outcome: "accepted" | "unknown" | "quota_pre_admission" | "rejected",
    receipt: { turnId?: string; nativeInputMessageId?: string } = {},
    now = new Date(),
  ): Promise<UnfinishedSessionRecord | null> {
    return this.mutate((file) => {
      const record = file.sessions.find((item) => unfinishedRecordKey(item) === unfinishedRecordKey(snapshot));
      const quota = record?.quotaRecovery;
      if (!record || !quota || quota.state !== "dispatching" || quota.revision !== snapshot.quotaRecovery?.revision
        || !quota.dispatchInputId) return null;
      quota.revision += 1;
      quota.updatedAt = now.toISOString();
      delete quota.claimedAt;
      if (outcome === "accepted") {
        quota.state = "accepted";
        quota.reasonCode = undefined;
        if (receipt.turnId) quota.dispatchTurnId = bounded(receipt.turnId, "dispatchTurnId");
        if (receipt.nativeInputMessageId) quota.dispatchNativeInputId = bounded(receipt.nativeInputMessageId, "dispatchNativeInputId");
        record.state = "active";
        record.acceptedAt = now.toISOString();
        record.admissionPhase = "accepted_pending";
        record.terminalRetryCount = 0;
        delete record.nextAttemptAt;
      } else if (outcome === "unknown") {
        quota.state = "held";
        quota.reasonCode = "delivery_unknown";
        record.state = "active";
        delete record.nextAttemptAt;
      } else if (outcome === "quota_pre_admission") {
        const next = quota.candidateIndex + 1;
        delete quota.dispatchInputId;
        delete quota.dispatchTurnId;
        if (next >= quota.candidateModels.length) {
          quota.state = "exhausted";
          quota.reasonCode = "candidate_exhausted";
          record.state = "exhausted";
          delete record.nextAttemptAt;
        } else {
          quota.state = "waiting";
          quota.candidateIndex = next;
          quota.nextAttemptAt = new Date(now.getTime() + quotaBackoffMs(quota.attempts)).toISOString();
          quota.reasonCode = "quota_waiting";
          record.state = "active";
          record.nextAttemptAt = quota.nextAttemptAt;
        }
      } else {
        quota.state = "held";
        quota.reasonCode = "model_unavailable";
        record.state = "active";
        delete record.nextAttemptAt;
      }
      record.updatedAt = now.toISOString();
      return { ...record, quotaRecovery: { ...quota, evidence: { ...quota.evidence }, candidateModels: [...quota.candidateModels] } };
    }, (record) => record !== null);
  }

  async holdQuotaRecovery(snapshot: UnfinishedSessionRecord, reasonCode: QuotaRecoveryRecord["reasonCode"], now = new Date()): Promise<void> {
    await this.mutate((file) => {
      const record = file.sessions.find((item) => unfinishedRecordKey(item) === unfinishedRecordKey(snapshot));
      const quota = record?.quotaRecovery;
      if (!record || !quota || quota.revision !== snapshot.quotaRecovery?.revision) return false;
      quota.state = "held";
      quota.reasonCode = reasonCode ?? "model_unavailable";
      quota.revision += 1;
      quota.updatedAt = now.toISOString();
      record.state = "active";
      delete record.nextAttemptAt;
      record.updatedAt = now.toISOString();
      return true;
    }, (changed) => changed);
  }

  /** Mark an aged dispatch as not yet reconciled without fencing its live sender. */
  async markQuotaDeliveryUnconfirmed(snapshot: UnfinishedSessionRecord, now = new Date()): Promise<void> {
    await this.mutate((file) => {
      const record = file.sessions.find((item) => unfinishedRecordKey(item) === unfinishedRecordKey(snapshot));
      const quota = record?.quotaRecovery;
      if (!quota || quota.state !== "dispatching" || quota.revision !== snapshot.quotaRecovery?.revision
        || quota.dispatchInputId !== snapshot.quotaRecovery?.dispatchInputId) return false;
      quota.reasonCode = "delivery_unknown";
      quota.updatedAt = now.toISOString();
      record.updatedAt = now.toISOString();
      return true;
    }, Boolean);
  }

  async clearWaitingQuotaRecovery(snapshot: UnfinishedSessionRecord): Promise<void> {
    await this.mutate((file) => {
      const record = file.sessions.find((item) => unfinishedRecordKey(item) === unfinishedRecordKey(snapshot));
      if (!record?.quotaRecovery || record.quotaRecovery.state !== "waiting"
        || record.quotaRecovery.revision !== snapshot.quotaRecovery?.revision
        || !sameRecoveryEvidence(record.quotaRecovery.evidence, snapshot.quotaRecovery?.evidence)) return false;
      delete record.quotaRecovery;
      delete record.recoveryCause;
      delete record.recoveryTurnId;
      delete record.recoveryInputId;
      delete record.recoveryObservedAt;
      delete record.nextAttemptAt;
      record.state = "active";
      record.updatedAt = new Date().toISOString();
      return true;
    }, Boolean);
  }

  async getQuotaRecoveryWaitStatus(harness: string, sessionId: string, cwd: string): Promise<QuotaRecoveryWaitStatus | null> {
    const normalizedHarness = harnessType(harness);
    if (normalizedHarness !== "opencode" && normalizedHarness !== "zcode") return null;
    const record = findUnfinishedRecord(await this.read().then((file) => file.sessions), normalizedHarness, sessionId, cwd);
    const quota = record?.quotaRecovery;
    if (!record || !quota) return null;
    return {
      harness: normalizedHarness,
      sessionId: record.sessionId,
      cwd: record.cwd,
      state: quota.state,
      origin: quota.evidence.classification === "quota_exhausted" ? "native_quota" : "operator_cohort",
      reason: quotaRecoveryReason(quota),
      nextAttemptAt: quota.nextAttemptAt,
      ...(quota.evidence.classification === "quota_exhausted" && quota.evidence.resetAt ? { resetAt: quota.evidence.resetAt } : {}),
      currentModel: recoveryEvidenceModelId(quota.evidence),
      ...(quota.selectedModel ? { selectedModel: quota.selectedModel } : {}),
      attempts: quota.attempts,
    };
  }

  async getQuotaRecoveryRecord(harness: string, sessionId: string, cwd: string): Promise<QuotaRecoveryRecord | null> {
    const normalizedHarness = harnessType(harness);
    const record = findUnfinishedRecord(await this.read().then((file) => file.sessions), normalizedHarness, sessionId, cwd);
    return record?.quotaRecovery ? cloneQuotaRecovery(record.quotaRecovery) : null;
  }

  async ingestColdFailure(
    session: AgentSession,
    turn: { turnId: string; completedAt: string; userMessageId: string },
    blockedReason?: string,
    now = new Date(),
  ): Promise<UnfinishedSessionRecord> {
    const harness = harnessType(session.harness);
    const workspaceIdentity = sessionWorkspaceIdentity(session);
    const normalized = normalizeRecordTarget({
      harness,
      sessionId: session.id,
      cwd: session.cwd,
      model: session.model,
      title: session.title,
      threadSource: nonEmptyText(session.meta?.threadSource),
    });
    return this.mutate((file) => {
      const key = sessionKey(harness, session.id, workspaceIdentity);
      const index = file.sessions.findIndex((record) => unfinishedRecordKey(record) === key);
      const existing = index >= 0 ? file.sessions[index] : undefined;
      if (existing?.recoveryTurnId === turn.turnId) {
        if (blockedReason && !existing.recoveryBlockedReason) {
          existing.recoveryBlockedReason = bounded(blockedReason, "recoveryBlockedReason");
          existing.lastError = bounded(blockedReason, "lastError");
          existing.updatedAt = now.toISOString();
        }
        return { ...existing };
      }
      if (existing && (existing.acceptedAt || existing.deliveryPending || existing.admissionPhase
        || existing.nonRetryableAdmission)) return { ...existing };
      if (existing && (existing.activeTurnStartedAt || existing.activeTurnId || existing.activeInputId)) {
        // After controller death no live failure event remains. Exact native
        // terminal proof for the persisted active turn closes that gap; a
        // lagging failure for another turn must preserve the newer identity.
        if (!sameNativeRecoveryIdentity(
          { turnId: existing.activeTurnId, inputId: existing.activeInputId },
          { turnId: turn.turnId, inputId: turn.userMessageId },
        )) return { ...existing };
        existing.recoveryCause = "turn.failed";
        existing.recoveryObservedAt = turn.completedAt;
        existing.recoveryTurnId = bounded(turn.turnId, "recoveryTurnId");
        existing.recoveryInputId = bounded(turn.userMessageId, "recoveryInputId");
        existing.updatedAt = now.toISOString();
        existing.attempts = 0;
        existing.state = "active";
        delete existing.activeTurnStartedAt;
        delete existing.activeTurnId;
        delete existing.activeInputId;
        if (blockedReason) {
          existing.recoveryBlockedReason = bounded(blockedReason, "recoveryBlockedReason");
          existing.lastError = bounded(blockedReason, "lastError");
        }
        return { ...existing };
      }
      const record: UnfinishedSessionRecord = {
        ...normalized,
        workspaceIdentity,
        startedAt: turn.completedAt,
        updatedAt: now.toISOString(),
        generationId: "cold-native-failure",
        attempts: 0,
        state: "active",
        recoveryCause: "turn.failed",
        recoveryObservedAt: turn.completedAt,
        recoveryTurnId: bounded(turn.turnId, "recoveryTurnId"),
        recoveryInputId: bounded(turn.userMessageId, "recoveryInputId"),
        ...(blockedReason ? {
          recoveryBlockedReason: bounded(blockedReason, "recoveryBlockedReason"),
          lastError: bounded(blockedReason, "lastError"),
        } : {}),
      };
      if (index < 0) file.sessions.push(record);
      else file.sessions[index] = record;
      sortRecords(file.sessions);
      return { ...record };
    });
  }

  async markNativeTurnStarted(
    session: AgentSession,
    identity: { turnId?: string; inputId?: string },
    generationId = "native-turn",
    now = new Date(),
  ): Promise<UnfinishedSessionRecord> {
    await this.markStarted(session, generationId, now);
    return this.mutate((file) => {
      const record = findUnfinishedRecord(file.sessions, harnessType(session.harness), session.id, sessionWorkspaceIdentity(session));
      if (!record) throw new Error("active native turn record disappeared");
      if(record.activeNativeOwner&&(record.activeNativeOwner.generationId!==generationId
        ||record.activeNativeOwner.turnId!==identity.turnId||record.activeNativeOwner.inputId!==identity.inputId))delete record.activeNativeOwner;
      record.generationId=bounded(generationId,"generationId");
      record.activeTurnStartedAt = now.toISOString();
      if (identity.turnId) record.activeTurnId = bounded(identity.turnId, "activeTurnId");
      if (identity.inputId) record.activeInputId = bounded(identity.inputId, "activeInputId");
      record.updatedAt = now.toISOString();
      return { ...record };
    });
  }

  /** Strict persist on this existing store, while exact native identity is
   * still live. A fresh daemon cannot retrofit an old record. */
  async recordNativeOwnerProof(sessionId:string,value:NativeOwnerProof,current:()=>boolean):Promise<boolean>{
    const proof=parseNativeOwnerProof(value);if(!proof)return false;
    return this.mutate(file=>{
      const record=findUnfinishedRecord(file.sessions,'zcode',sessionId,proof.cwd);
      if(!record||record.threadSource==='subagent'||record.generationId!==proof.generationId
        ||record.activeTurnId!==proof.turnId||record.activeInputId!==proof.inputId||!current())return false;
      record.activeNativeOwner=proof;return true;
    },written=>written);
  }

  async activeNativeTurn(harness: string, sessionId: string, cwd?: string): Promise<{ turnId?: string; inputId?: string } | undefined> {
    const records = await this.list();
    const matches = records.filter((record) => record.harness === harness && record.sessionId === sessionId
      && (!cwd || (record.workspaceIdentity || record.cwd) === normalize(cwd)));
    const record = matches.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
    if (!record?.activeTurnId && !record?.activeInputId) return undefined;
    return { ...(record.activeTurnId ? { turnId: record.activeTurnId } : {}), ...(record.activeInputId ? { inputId: record.activeInputId } : {}) };
  }

  async recoveryNativeTurn(harness: string, sessionId: string): Promise<{ turnId?: string; inputId?: string } | undefined> {
    const record = (await this.list())
      .filter((candidate) => candidate.harness === harness && candidate.sessionId === sessionId && candidate.recoveryCause)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
    if (!record?.recoveryTurnId && !record?.recoveryInputId) return undefined;
    return { ...(record.recoveryTurnId ? { turnId: record.recoveryTurnId } : {}), ...(record.recoveryInputId ? { inputId: record.recoveryInputId } : {}) };
  }

  async markPersistedActiveTurnFailed(
    harness: string,
    sessionId: string,
    cause: "turn.failed" | "process.disconnected",
    identity: { turnId?: string; inputId?: string },
    now = new Date(),
    owner?:NativeOwnerProof,
    current?:()=>boolean,
  ): Promise<UnfinishedSessionRecord | null> {
    return this.mutate((file) => {
      const record = file.sessions.find((candidate) => candidate.harness === harness && candidate.sessionId === sessionId
        && sameNativeRecoveryIdentity({ turnId: candidate.activeTurnId, inputId: candidate.activeInputId }, identity));
      if (!record || record.threadSource === "subagent") return null;
      if(owner&&(!current?.()||JSON.stringify(record.activeNativeOwner)!==JSON.stringify(owner)))return null;
      if(owner){record.admissionPhase="terminal_observed";record.terminalObservedAt=now.toISOString();record.terminalReason="turn.failed";record.terminalRetryCount=0;}
      record.recoveryCause = cause;
      record.recoveryObservedAt = now.toISOString();
      if (identity.turnId) record.recoveryTurnId = identity.turnId;
      if (identity.inputId) record.recoveryInputId = identity.inputId;
      delete record.activeTurnStartedAt;
      delete record.activeTurnId;
      delete record.activeInputId;
      record.updatedAt = now.toISOString();
      record.attempts = 0;
      record.state = "active";
      return { ...record };
    }, (record) => record !== null);
  }

  async observeAcceptedProgress(
    harness: HarnessType,
    sessionId: string,
    cwd: string,
    acceptedAt: string,
    fingerprint: string,
    now = new Date(),
  ): Promise<UnfinishedSessionRecord | null> {
    return this.mutate((file) => {
      const key = sessionKey(harness, sessionId, cwd);
      const record = file.sessions.find((candidate) => unfinishedRecordKey(candidate) === key);
      if (!record || record.acceptedAt !== acceptedAt || !record.acceptedFingerprint || record.acceptedFingerprint === fingerprint) return null;
      let changed = false;
      if (!record.progressObservedAt) {
        record.progressObservedAt = now.toISOString();
        changed = true;
      }
      if (record.deliveryPending) {
        delete record.deliveryPending;
        changed = true;
      }
      if (record.admissionPhase !== "in_progress") {
        record.admissionPhase = "in_progress";
        changed = true;
      }
      if (record.lastProgressFingerprint !== fingerprint) {
        record.lastProgressFingerprint = fingerprint;
        record.lastNativeProgressAt = now.toISOString();
        changed = true;
      }
      return changed ? { ...record } : null;
    }, (record) => record !== null);
  }

  async markAdmissionInProgress(
    harness: HarnessType,
    sessionId: string,
    cwd: string,
    fingerprint: string,
    now = new Date(),
  ): Promise<UnfinishedSessionRecord | null> {
    return this.mutate((file) => {
      const record = findUnfinishedRecord(file.sessions, harness, sessionId, cwd);
      if (!record?.acceptedAt) return null;
      record.admissionPhase = "in_progress";
      record.lastProgressFingerprint = bounded(fingerprint, "fingerprint");
      record.lastNativeProgressAt = now.toISOString();
      record.progressObservedAt ??= now.toISOString();
      record.updatedAt = now.toISOString();
      delete record.deliveryPending;
      delete record.terminalReason;
      delete record.terminalObservedAt;
      delete record.terminalAssistantObserved;
      return { ...record };
    }, (record) => record !== null);
  }

  async markAdmissionTerminal(
    harness: HarnessType,
    sessionId: string,
    cwd: string,
    reason: "turn.completed" | "turn.failed",
    fingerprint?: string,
    assistantObserved = false,
    now = new Date(),
  ): Promise<UnfinishedSessionRecord | null> {
    return this.mutate((file) => {
      const record = findUnfinishedRecord(file.sessions, harness, sessionId, cwd);
      if (!record?.acceptedAt) return null;
      record.admissionPhase = "terminal_observed";
      record.terminalReason = reason;
      record.terminalObservedAt = now.toISOString();
      // A terminal that carried a persisted assistant answer is a satisfied
      // admission, not a silent one. It discharges the bounded re-admission
      // budget exactly like markStarted does for terminalAssistantObserved;
      // keeping the previous count would later alarm as "answered twice".
      if (assistantObserved) {
        record.terminalAssistantObserved = true;
        record.terminalRetryCount = 0;
      } else delete record.terminalAssistantObserved;
      record.updatedAt = now.toISOString();
      if (fingerprint) record.lastProgressFingerprint = bounded(fingerprint, "fingerprint");
      delete record.deliveryPending;
      return { ...record };
    }, (record) => record !== null);
  }

  /**
   * A human terminated the accepted turn before any assistant answer existed.
   * That turn can never confirm completion and must never be submitted again,
   * so the admission ends here as an explicit non-retryable terminal state
   * instead of waiting for the accepted-admission deadline to alarm.
   */
  async markAdmissionStoppedByHuman(
    harness: HarnessType,
    sessionId: string,
    cwd: string,
    fingerprint?: string,
    now = new Date(),
  ): Promise<UnfinishedSessionRecord | null> {
    return this.mutate((file) => {
      const record = findUnfinishedRecord(file.sessions, harness, sessionId, cwd);
      if (!record?.acceptedAt) return null;
      if (record.nonRetryableAdmission) return null;
      record.admissionPhase = "terminal_observed";
      record.terminalReason = "turn.failed";
      record.terminalObservedAt = now.toISOString();
      record.nonRetryableAdmission = true;
      record.lastError = "accepted turn stopped by the human before any assistant answer";
      record.updatedAt = now.toISOString();
      if (fingerprint) record.lastProgressFingerprint = bounded(fingerprint, "fingerprint");
      delete record.deliveryPending;
      delete record.terminalAssistantObserved;
      return { ...record };
    }, (record) => record !== null);
  }

  async remove(harness: string, sessionId: string, cwd?: string): Promise<boolean> {
    return this.mutate((file) => {
      const normalizedHarness = harnessType(harness);
      const normalizedSessionId = bounded(sessionId, "sessionId");
      const key = cwd ? sessionKey(normalizedHarness, normalizedSessionId, cwd) : undefined;
      const before = file.sessions.length;
      file.sessions = file.sessions.filter((record) => key
        ? unfinishedRecordKey(record) !== key
        : record.harness !== normalizedHarness || record.sessionId !== normalizedSessionId);
      return file.sessions.length !== before;
    }, (changed) => changed);
  }

  /** One strict transaction: a semantic verdict cannot delete a newer turn or
   * accepted admission which arrived during the native read/judgement. */
  async settleTrackedCodexCompletion(expected: UnfinishedSessionRecord, inventory: UnfinishedSessionInventoryRecord,
    expectedInventory: UnfinishedSessionInventoryRecord | undefined, current: () => boolean | Promise<boolean>, stillCurrent: () => boolean = () => true): Promise<boolean> {
    return this.mutate(async file => {
      if (expected.harness !== "codex" || !expected.activeTurnId
        || inventory.verdict?.verdict !== "completed" || inventory.verdict.confidence <= 0) return false;
      const index = file.sessions.findIndex(record => unfinishedRecordKey(record) === unfinishedRecordKey(expected));
      if (index < 0 || JSON.stringify(file.sessions[index]) !== JSON.stringify(expected)) return false;
      const records = file.inventory ?? [];
      const previous = records.findIndex(record => inventoryRecordKey(record) === inventoryRecordKey(inventory));
      if (JSON.stringify(previous < 0 ? undefined : records[previous]) !== JSON.stringify(expectedInventory)) return false;
      // The existing operation queue/read can wait. Recheck native history,
      // policy, questions and Stop here, after that wait, before any mutation.
      if (!await current() || !stillCurrent()) return false;
      file.inventory ??= records;
      if (previous < 0) records.push(cloneInventoryRecord(inventory));
      else records[previous] = cloneInventoryRecord(inventory);
      file.sessions.splice(index, 1);
      return true;
    }, changed => changed);
  }

  /**
   * Drop only the same nonaccepted row that was observed before an async
   * completion-evidence read. A newer native event or accepted delivery must
   * survive that read and keep its urgency for the next recovery pass.
   */
  async discardUnchangedNonaccepted(
    expected: UnfinishedSessionRecord | undefined,
    harness: string,
    sessionId: string,
    cwd: string,
    stillCurrent: () => boolean,
  ): Promise<boolean> {
    return this.mutate((file) => {
      if (!stillCurrent()) return false;
      const key = sessionKey(harnessType(harness), bounded(sessionId, "sessionId"), cwd);
      const index = file.sessions.findIndex((record) => unfinishedRecordKey(record) === key);
      if (!expected) return index < 0;
      if (expected.acceptedAt || expected.deliveryPending || expected.admissionPhase) return false;
      if (unfinishedRecordKey(expected) !== key || index < 0) return false;
      const current = file.sessions[index]!;
      if (current.acceptedAt || current.deliveryPending || current.admissionPhase
        || JSON.stringify(current) !== JSON.stringify(expected)) return false;
      file.sessions.splice(index, 1);
      return true;
    }, (unchanged) => unchanged && expected !== undefined);
  }

  async beginAttempt(
    harness: HarnessType,
    sessionId: string,
    maxAttempts: number,
    retryDelayMs: number,
    now = new Date(),
    cwd?: string,
  ): Promise<UnfinishedSessionRecord | null> {
    return this.mutate((file) => {
      const record = findUnfinishedRecord(file.sessions, harness, sessionId, cwd);
      if (!record || record.state === "exhausted" || record.attempts >= maxAttempts) return null;
      if (record.nextAttemptAt && Date.parse(record.nextAttemptAt) > now.getTime()) return null;
      record.attempts += 1;
      record.state = "recovering";
      record.updatedAt = now.toISOString();
      record.nextAttemptAt = new Date(now.getTime() + retryDelayMs * (2 ** (record.attempts - 1))).toISOString();
      delete record.lastError;
      return { ...record };
    }, (record) => record !== null);
  }

  async cancelAttempt(attempt: UnfinishedSessionRecord, now = new Date()): Promise<boolean> {
    return this.mutate((file) => {
      const record = file.sessions.find((candidate) => unfinishedRecordKey(candidate) === unfinishedRecordKey(attempt));
      if (!record || record.state !== "recovering" || record.attempts !== attempt.attempts || record.updatedAt !== attempt.updatedAt) return false;
      record.attempts = Math.max(0, record.attempts - 1);
      record.state = "active";
      record.updatedAt = now.toISOString();
      delete record.nextAttemptAt;
      delete record.lastError;
      return true;
    }, (changed) => changed);
  }

  async markFailure(
    harness: HarnessType,
    sessionId: string,
    error: string,
    maxAttempts: number,
    now = new Date(),
    cwd?: string,
  ): Promise<UnfinishedSessionRecord | null> {
    return this.mutate((file) => {
      const record = findUnfinishedRecord(file.sessions, harness, sessionId, cwd);
      if (!record) return null;
      record.state = record.attempts >= maxAttempts ? "exhausted" : "active";
      record.lastError = bounded(error, "error");
      record.updatedAt = now.toISOString();
      return { ...record };
    }, (record) => record !== null);
  }

  /**
   * Record a deterministic failure without consuming the retry budget.
   *
   * A deterministic refusal repeats identically, so charging it against the
   * retry budget only hides the one action that actually repairs it. The record
   * stays armed and is probed again on the next cycle, with the operator-facing
   * reason kept in the durable ledger.
   */
  async markDeterministicFailure(
    harness: HarnessType,
    sessionId: string,
    error: string,
    nextAttemptAt: Date,
    now = new Date(),
    cwd?: string,
  ): Promise<UnfinishedSessionRecord | null> {
    return this.mutate((file) => {
      const record = findUnfinishedRecord(file.sessions, harness, sessionId, cwd);
      if (!record) return null;
      // Give the reserved attempt back only when one was actually reserved.
      const reserved = record.state === "recovering";
      record.state = "active";
      if (reserved) record.attempts = Math.max(0, record.attempts - 1);
      record.lastError = bounded(error, "error");
      record.nextAttemptAt = nextAttemptAt.toISOString();
      record.updatedAt = now.toISOString();
      return { ...record };
    }, (record) => record !== null);
  }

  async markNotified(harness: HarnessType, sessionId: string, now = new Date(), cwd?: string): Promise<void> {
    await this.mutate((file) => {
      const record = findUnfinishedRecord(file.sessions, harness, sessionId, cwd);
      if (record) {
        record.notifiedAt = now.toISOString();
        record.updatedAt = now.toISOString();
      }
    });
  }

  private async read(): Promise<UnfinishedSessionFile> {
    try {
      return parseFile(JSON.parse(await readFile(this.path, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, sessions: [] };
      throw error;
    }
  }

  private async mutate<T>(operation: (file: UnfinishedSessionFile) => T | Promise<T>, shouldWrite: (result: T) => boolean = () => true): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(this.lockTarget, "", { flag: "a", mode: 0o600 });
      const release = await lockfile.lock(this.lockTarget, {
        realpath: false,
        stale: 30_000,
        update: 10_000,
        retries: { retries: 30, minTimeout: 25, maxTimeout: 100, factor: 1.5, randomize: true },
      });
      try {
        const file = await this.read();
        const result = await operation(file);
        if (shouldWrite(result)) await atomicWrite(this.path, file);
        return result;
      } finally {
        await release();
      }
    } finally {
      release();
    }
  }
}

export interface UnfinishedSessionLauncherOptions {
  adapters: Map<string, HarnessAdapter>;
  store: UnfinishedSessionStore;
  settingsStore: SessionAutostartStore;
  fallbackModelsForHarness?: (harness: "opencode" | "zcode") => Promise<string[]>;
  /** Existing project launch policy is the authority for operator-cohort model admission. */
  projectLaunchPolicyStore?: Pick<AutomationLaunchPolicyStore, "load">;
  /** Read-only OpenCode session/active/permission/Inbox/transcript CAS snapshot for explicit operator continuations. */
  operatorContinuationSnapshotReader?: OpenCodeNativeContinuationReader;
  /** Rechecks owning fleet authorization before any automatic native work. */
  admissionGate?: RecoveryAdmissionGate;
  maxAttempts?: number;
  retryDelayMs?: number;
  /** Backoff before a deterministic refusal that repeats identically is probed again. */
  deterministicRetryDelayMs?: number;
  /** Pause before the single safe retry of a transient batch-planner transport failure. */
  plannerTransportRetryDelayMs?: number;
  reconcileIntervalMs?: number;
  inventoryWindowMs?: number;
  discoveryIdleMs?: number;
  maxJudgementsPerCycle?: number;
  maxResumesPerCycle?: number;
  watchdogIntervalMs?: number;
  stalledTurnMs?: number;
  /** Independent correctness deadline for an accepted turn with no explicit terminal proof. */
  acceptedAdmissionTimeoutMs?: number;
  judge?: SessionCompletionJudge;
  continuationMessage?: string;
  notify?: (notice: UnfinishedSessionNotice) => Promise<void>;
  /** Durable safe-boundary inbox used when a Codex Desktop writer still owns the thread. */
  deferredStore?: Pick<DeferredMessageStore, "add" | "list">;
  /** Replaces a stale provider-cache session with a compact same-harness continuation. */
  cacheHandoff?: Pick<CacheHandoffService, "maybeRollover">;
  /** Independent durable fence for sessions explicitly stopped by a human. */
  humanStopStore?: HumanStopStore;
  /** Pending human questions and choices; a session waiting for an answer is never continued. */
  humanRequests?: Pick<HumanRequestRegistry, "list">;
  choiceRegistry?: Pick<ChoiceRegistry, "list">;
  /** How long the pending-question snapshot is trusted before the registries are read again. */
  pendingQuestionTtlMs?: number;
  /** Durable Autopilot master policy; semantic backlog work stays opt-in. */
  autopilotPolicyStore?: Pick<AutopilotPolicyStore, "readEffective">;
  /** Per-session Autopilot switches override the enabled harness policy. */
  autopilotSessionStore?: Pick<AutopilotSessionStore, "get">;
  /** Stable only for one Agent Herder process; tests may inject it. */
  generationId?: string;
  /** The process-owned background Stop consumer currently owns this native decision. */
  semanticAdmissionHeld?: (session: AgentSession) => boolean;
}

/** Reconciles durable unfinished turns for the lifetime of the Agent Herder process. */
export class UnfinishedSessionLauncher {
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly deterministicRetryDelayMs: number;
  private readonly reconcileIntervalMs: number;
  private readonly discoveryIdleMs: number;
  private readonly maxJudgementsPerCycle: number;
  private readonly maxResumesPerCycle: number;
  private readonly continuationMessage: string;
  private readonly generationId: string;
  private readonly candidateDelayOverrideMs?: number;
  private readonly watchdogIntervalOverrideMs?: number;
  private readonly stalledTurnOverrideMs?: number;
  private readonly acceptedAdmissionTimeoutMs: number;
  private readonly projectLaunchPolicyStore: Pick<AutomationLaunchPolicyStore, "load">;
  private readonly plannerTransportRetryDelayMs: number;
  private readonly pendingQuestions?: PendingQuestionGate;
  private recovering: Promise<void> | null = null;
  private autopiloting: Promise<void> | null = null;
  private retryTimer?: NodeJS.Timeout;
  private watchdogTimer?: NodeJS.Timeout;
  private urgentTimer?: NodeJS.Timeout;
  private activePlannerController?: AbortController;
  private watchdogRunning = false;
  private started = false;
  /** Explicit lifecycle cancellation; unlike `started`, false before a manual one-shot recovery is valid. */
  private stopped = false;
  /** Invalidates recovery work that was already awaiting I/O when stop/restart happens. */
  private lifecycleEpoch = 0;
  private readonly completedSessions = new Set<string>();
  private readonly activeNativeTurns = new Map<string, { turnId?: string; inputId?: string }>();
  private readonly providerTurnGenerations = new Map<string, number>();
  private eventOperation: Promise<unknown> = Promise.resolve();
  private readonly turnGenerations = new Map<string, number>();
  /** Fences are retained only while event/recovery operations can hold a stale snapshot. */
  private fenceUsers = 0;

  private releaseTurnFences(): void {
    this.fenceUsers -= 1;
    if (this.fenceUsers === 0) {
      this.turnGenerations.clear();
      this.eagerCompletions.clear();
    }
  }
  private readonly eagerCompletions = new Set<string>();
  private readonly urgentSessions = new Set<string>();
  private readonly urgentSessionVersions = new Map<string, number>();
  private urgentSessionVersion = 0;
  private readonly watchdogObservations = new Map<string, {
    fingerprint: string;
    unchangedSince: number;
    misses: number;
    urgentFingerprint?: string;
  }>();
  /** Sessions already continued by the batch planner in the current recovery pass. */
  private readonly continuedThisRecovery = new Set<string>();

  constructor(private readonly options: UnfinishedSessionLauncherOptions) {
    this.projectLaunchPolicyStore = options.projectLaunchPolicyStore
      ?? new AutomationLaunchPolicyStore(join(resolveAutopilotStateDir(), "automation-launch-policy.json"));
    this.maxAttempts = positiveInteger(options.maxAttempts ?? Number(process.env.AGENT_HERDER_AUTOSTART_MAX_ATTEMPTS || 3), 3);
    this.retryDelayMs = nonNegativeInteger(options.retryDelayMs ?? Number(process.env.AGENT_HERDER_AUTOSTART_RETRY_DELAY_MS || 5_000), 5_000);
    this.deterministicRetryDelayMs = positiveInteger(
      options.deterministicRetryDelayMs ?? Number(process.env.AGENT_HERDER_DETERMINISTIC_RETRY_DELAY_MS || 60_000),
      60_000,
    );
    this.plannerTransportRetryDelayMs = nonNegativeInteger(
      options.plannerTransportRetryDelayMs ?? TRANSIENT_PLANNER_RETRY_DELAY_MS,
      TRANSIENT_PLANNER_RETRY_DELAY_MS,
    );
    this.reconcileIntervalMs = positiveInteger(
      options.reconcileIntervalMs ?? Number(process.env.AGENT_HERDER_UNFINISHED_RECONCILE_INTERVAL_MS || 60_000),
      60_000,
    );
    this.discoveryIdleMs = positiveInteger(
      options.discoveryIdleMs ?? Number(process.env.AGENT_HERDER_UNFINISHED_DISCOVERY_IDLE_MS || 60_000),
      60_000,
    );
    this.maxJudgementsPerCycle = positiveInteger(
      options.maxJudgementsPerCycle ?? Number(process.env.AGENT_HERDER_UNFINISHED_JUDGEMENTS_PER_CYCLE || 20),
      20,
    );
    this.maxResumesPerCycle = positiveInteger(
      options.maxResumesPerCycle ?? Number(process.env.AGENT_HERDER_UNFINISHED_RESUMES_PER_CYCLE || 8),
      8,
    );
    this.continuationMessage = options.continuationMessage?.trim() || DEFAULT_CONTINUATION;
    this.generationId = options.generationId?.trim() || `process-${process.pid}-${randomUUID()}`;
    this.candidateDelayOverrideMs = options.discoveryIdleMs;
    this.watchdogIntervalOverrideMs = options.watchdogIntervalMs;
    this.stalledTurnOverrideMs = options.stalledTurnMs;
    this.acceptedAdmissionTimeoutMs = positiveInteger(
      options.acceptedAdmissionTimeoutMs ?? Number(process.env.AGENT_HERDER_ACCEPTED_ADMISSION_TIMEOUT_MS || 30 * 60_000),
      30 * 60_000,
    );
    this.pendingQuestions = options.humanRequests || options.choiceRegistry
      ? new PendingQuestionGate(
        {
          ...(options.humanRequests ? { humanRequests: options.humanRequests } : {}),
          ...(options.choiceRegistry ? { choices: options.choiceRegistry } : {}),
        },
        {
          ...(options.pendingQuestionTtlMs === undefined ? {} : { ttlMs: options.pendingQuestionTtlMs }),
          ...(process.env.AGENT_HERDER_PENDING_QUESTION_TTL_MS
            ? { ttlMs: positiveInteger(Number(process.env.AGENT_HERDER_PENDING_QUESTION_TTL_MS), 15_000) }
            : {}),
        },
      )
      : undefined;
  }

  async handleEvent(provider: string, event: HarnessEvent): Promise<void> {
    if (event.data?.maintenance === "compact") return;
    this.fenceUsers += 1;
    event = { ...event, at: event.at ?? new Date().toISOString() };
    if (event.kind === "turn.started" && event.sessionId) {
      this.providerTurnGenerations.set(provider, (this.providerTurnGenerations.get(provider) ?? 0) + 1);
    }
    const providerGeneration = this.providerTurnGenerations.get(provider) ?? 0;
    const eventIdentity = nativeRecoveryIdentity(event);
    const generationKey = event.sessionId && isAutocontinueInventoryHarness(provider)
      ? nativeTurnFenceKey(provider, event.sessionId, eventIdentity) : undefined;
    if (generationKey && event.kind === "turn.completed") {
      this.turnGenerations.set(generationKey, (this.turnGenerations.get(generationKey) ?? 0) + 1);
      this.eagerCompletions.add(generationKey);
    }
    const eventGeneration = generationKey ? this.turnGenerations.get(generationKey) ?? 0 : 0;
    const previous = this.eventOperation;
    let release!: () => void;
    this.eventOperation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await this.handleEventSerialized(provider, event, eventGeneration, providerGeneration);
    } finally {
      this.releaseTurnFences();
      release();
    }
  }

  private async handleEventSerialized(provider: string, event: HarnessEvent, eventGeneration: number, providerGeneration = this.providerTurnGenerations.get(provider) ?? 0): Promise<void> {
    if (!isAutocontinueInventoryHarness(provider) && !(provider === "opencode" && (event.kind === "turn.started" || event.kind === "turn.failed" || event.kind === "turn.completed"))) return;
    if (!event.sessionId) {
      // A controller-wide transport exit can arrive after its per-session
      // event cache was lost. Use only already persisted active identities;
      // inventory idle/stopped rows and subscription access errors are not
      // failure evidence. The normal recovery path still re-reads native
      // state and owner admission before any resume or prompt.
      if (event.kind !== "process.disconnected" || event.nativeType === "event-subscription-error") return;
      const settings = await this.options.settingsStore.getSettings();
      if (!settings.recoverOnDisconnect) return;
      const disconnectedAt = Date.parse(event.at || "");
      if (!Number.isFinite(disconnectedAt)) return;
      for (const record of await this.options.store.list()) {
        // A turn-start received while this global event waited for I/O fences
        // the whole fanout. Never assign an obsolete transport event to the
        // currently observed native generation.
        if ((this.providerTurnGenerations.get(provider) ?? 0) !== providerGeneration) return;
        if (record.harness !== provider || record.threadSource === "subagent"
          || (!record.activeTurnId && !record.activeInputId)
          || !record.activeTurnStartedAt || !Number.isFinite(Date.parse(record.activeTurnStartedAt))
          || Date.parse(record.activeTurnStartedAt) > disconnectedAt) continue;
        const identity = { turnId: record.activeTurnId, inputId: record.activeInputId };
        const fence = nativeTurnFenceKey(provider, record.sessionId, identity);
        await this.handleEventSerialized(provider, {
          ...event, sessionId: record.sessionId,
          data: { ...event.data, ...identity },
        }, fence ? this.turnGenerations.get(fence) ?? 0 : 0);
      }
      return;
    }
    const eventKey = sessionKey(provider, event.sessionId);
    const identity = nativeRecoveryIdentity(event);
    if (event.kind === "session.deleted") {
      const prefix = `${eventKey}:`;
      for (const key of this.turnGenerations.keys()) {
        if (key.startsWith(prefix)) {
          this.turnGenerations.set(key, (this.turnGenerations.get(key) ?? 0) + 1);
          this.eagerCompletions.add(key);
        }
      }
      this.activeNativeTurns.delete(eventKey);
      this.completedSessions.add(sessionKey(provider, event.sessionId));
      this.clearUrgentSession(sessionKey(provider, event.sessionId));
      await this.options.store.remove(provider, event.sessionId);
      return;
    }
    if (event.kind === "turn.completed") {
      const activeIdentity = this.activeNativeTurns.get(eventKey)
        ?? await this.options.store.activeNativeTurn(provider, event.sessionId)
        ?? await this.options.store.recoveryNativeTurn(provider, event.sessionId);
      if (!activeIdentity || !sameNativeRecoveryIdentity(activeIdentity, identity)) return;
      this.activeNativeTurns.delete(eventKey);
      this.clearUrgentSession(eventKey);
      await this.options.store.remove(provider, event.sessionId);
      return;
    }
    if (event.kind === "turn.failed" || event.kind === "process.disconnected") {
      const eventFence = nativeTurnFenceKey(provider, event.sessionId, identity);
      if (eventFence && (this.turnGenerations.get(eventFence) ?? 0) !== eventGeneration) return;
      const activeIdentity = this.activeNativeTurns.get(eventKey)
        ?? await this.options.store.activeNativeTurn(provider, event.sessionId);
      this.activeNativeTurns.delete(eventKey);
      if (!activeIdentity || (event.kind === "turn.failed" && !sameNativeRecoveryIdentity(activeIdentity, identity))) return;
      const settings = await this.options.settingsStore.getSettings();
      const quotaEvidence = event.kind === "turn.failed" ? normalizeQuotaFailureEvidence(event.data?.quotaFailure) : undefined;
      if (quotaEvidence) {
        const eventMatches = identity.turnId === quotaEvidence.nativeTurnId && identity.inputId === quotaEvidence.inputId
          && activeIdentity.turnId === quotaEvidence.nativeTurnId && activeIdentity.inputId === quotaEvidence.inputId;
        if (!eventMatches || !quotaModelId(quotaEvidence) || !settings.recoverOnFailure || !this.options.fallbackModelsForHarness) return;
        let session: AgentSession | null | undefined;
        try { session = await this.options.adapters.get(provider)?.getSession(event.sessionId); } catch { return; }
        if (!session || session.id !== event.sessionId || session.harness !== provider
          || !exactTerminalQuotaSnapshot(session, quotaEvidence) || isSubagentSession(session)
          || session.needsPermission || session.status === "needs_input"
          || await this.suppressIfHumanStopped(provider, event.sessionId, session.cwd, session)) return;
        const effective = await this.options.settingsStore.getEffective(provider, session.id, session.cwd);
        if (!effective.enabled || !effective.waitForQuota || !await this.mayWorkOnSession(provider, session.id, session.cwd)) return;
        const fallbackModels = await this.options.fallbackModelsForHarness(provider as "opencode" | "zcode");
        await this.options.store.markQuotaRecoveryEligible(session, quotaEvidence, fallbackModels, this.generationId);
        this.queueUrgentSession(sessionSourceKey(session));
        this.scheduleUrgentRecovery(0);
        return;
      }
      if ((event.kind === "turn.failed" && !settings.recoverOnFailure)
        || (event.kind === "process.disconnected" && !settings.recoverOnDisconnect)) return;
      const adapter = this.options.adapters.get(provider);
      let session: AgentSession | null | undefined;
      try { session = await adapter?.getSession(event.sessionId); } catch { session = undefined; }
      if (isSubagentSession(session)) {
        await this.options.store.excludeSession(provider, event.sessionId);
        return;
      }
      if (await this.suppressIfHumanStopped(provider, event.sessionId, session?.cwd, session)) return;
      if (!session) {
        await this.options.store.markPersistedActiveTurnFailed(provider, event.sessionId, event.kind, activeIdentity);
        this.queueUrgentSession(eventKey);
        this.scheduleUrgentRecovery();
        return;
      }
      if (session.status === "needs_input" || session.needsPermission || !await this.mayWorkOnSession(session.harness, session.id, session.cwd)) return;
      await this.options.store.markRecoveryEligible(
        { ...session, status: event.kind === "turn.failed" ? "error" : "idle" },
        event.kind,
        activeIdentity,
        this.generationId,
      );
      const key = sessionSourceKey(session);
      this.queueUrgentSession(key);
      this.scheduleUrgentRecovery();
      return;
    }
    if (event.kind !== "turn.started") return;
    const adapter = this.options.adapters.get(provider);
    const session = await adapter?.getSession(event.sessionId);
    if (isSubagentSession(session)) {
      await this.options.store.excludeSession(provider, event.sessionId);
      return;
    }
    if (await this.suppressIfHumanStopped(provider, event.sessionId, session?.cwd, session)) return;
    if (session && await this.mayWorkOnSession(session.harness, session.id, session.cwd)) {
      if (!identity.turnId && !identity.inputId) return;
      const startedFence = nativeTurnFenceKey(provider, event.sessionId, identity);
      if (startedFence) this.eagerCompletions.delete(startedFence);
      this.activeNativeTurns.set(eventKey, identity);
      const quotaSnapshot = (await this.options.store.list()).find((record) => record.harness === provider
        && record.sessionId === event.sessionId && normalize(record.workspaceIdentity || record.cwd) === normalize(session.cwd));
      if (quotaSnapshot?.quotaRecovery?.state === "dispatching"
        && (identity.inputId === quotaSnapshot.quotaRecovery.dispatchInputId
          || identity.inputId === quotaSnapshot.quotaRecovery.dispatchNativeInputId)) {
        await this.options.store.settleQuotaRecoveryAttempt(quotaSnapshot, "accepted", { ...(identity.turnId ? { turnId: identity.turnId } : {}) });
      } else if (quotaSnapshot?.quotaRecovery?.state === "waiting"
        && quotaSnapshot.quotaRecovery.evidence.classification === "operator_continuation") {
        await this.options.store.holdQuotaRecovery(quotaSnapshot, "native_snapshot_changed");
      } else if (quotaSnapshot?.quotaRecovery?.state === "waiting"
        && (identity.turnId !== recoveryEvidenceTurnId(quotaSnapshot.quotaRecovery.evidence)
          || (recoveryEvidenceInputId(quotaSnapshot.quotaRecovery.evidence) !== undefined
            && identity.inputId !== recoveryEvidenceInputId(quotaSnapshot.quotaRecovery.evidence)))) {
        await this.options.store.clearWaitingQuotaRecovery(quotaSnapshot);
      }
      await this.options.store.markNativeTurnStarted(session, identity, this.generationId);
      this.watchdogObservations.delete(sessionSourceKey(session));
      const progressed = await this.options.store.markAdmissionInProgress(
        session.harness,
        session.id,
        sessionWorkspaceIdentity(session),
        sessionProgressFingerprint(session),
      );
      if (!progressed) {
        // Record only the active native identity in memory. A normal user turn
        // is not unfinished-session recovery work unless failure/disconnect is
        // later observed for this exact turn.
        this.completedSessions.delete(sessionSourceKey(session));
        this.clearUrgentSession(sessionSourceKey(session));
        await this.pinActiveSession(adapter!, session.id);
      }
    }
  }

  /**
   * Adopt a native turn already running outside Herder, without delivering any
   * prompt. Both exact-session switches and workspace identity must agree.
   */
  async adoptActiveSession(session: AgentSession): Promise<boolean> {
    if (session.harness !== "codex" || session.status !== "running" || session.needsPermission) return false;
    const turnId = nonEmptyText(session.meta?.activeTurnId);
    if (!turnId || !session.cwd.startsWith("/")) return false;
    const settings = await this.options.settingsStore.getEffective(session.harness, session.id, session.cwd);
    const autopilot = await this.options.autopilotSessionStore?.get("codex", session.id);
    if (!settings.enabled || settings.source !== "session" || !autopilot?.enabled
      || normalize(autopilot.cwd) !== normalize(session.cwd)) return false;
    const adapter = this.options.adapters.get("codex");
    const fresh = await adapter?.getSession(session.id);
    if (!fresh || fresh.id !== session.id || fresh.harness !== "codex"
      || fresh.status !== "running" || fresh.needsPermission
      || normalize(fresh.cwd) !== normalize(session.cwd)
      || nonEmptyText(fresh.meta?.activeTurnId) !== turnId) return false;
    const existing = await this.options.store.activeNativeTurn("codex", session.id);
    if (existing?.turnId === turnId && this.activeNativeTurns.get(sessionKey("codex", session.id))?.turnId === turnId) return true;
    if (!await this.armSession(fresh)) return false;
    // This replays a freshly observed native fact, not a synthetic failure or
    // a new user turn. The ordinary event path persists its recovery identity.
    await this.handleEvent("codex", {
      kind: "turn.started", harness: "codex", sessionId: fresh.id,
      data: { turnId, source: "active-session-adoption" },
    });
    return (await this.options.store.activeNativeTurn("codex", session.id))?.turnId === turnId;
  }

  /** Hook primary begin/progress uses the existing durable active-turn seam.
   * The caller supplies an exact native promoted identity and rechecks it after
   * semantic/Stop awaits; no SDK event replay or new tracking file is needed. */
  async recordNativeHook(session:AgentSession,identity:{turnId:string;inputId:string},phase:'begin'|'progress'|'success',progress:string,current:()=>boolean):Promise<boolean>{
    if(session.harness!=='zcode'||isSubagentSession(session)||!await this.mayWorkOnSession(session.harness,session.id,session.cwd))return false;
    if(await this.options.humanStopStore?.isHeld(session.harness,session.id)||!current())return false;
    const key=sessionKey(session.harness,session.id),active=await this.options.store.activeNativeTurn(session.harness,session.id);
    if(await this.options.humanStopStore?.isHeld(session.harness,session.id)||!current())return false;
    if(phase==='begin'){
      this.activeNativeTurns.set(key,identity);
      if(!active||!sameNativeRecoveryIdentity(active,identity))await this.options.store.markNativeTurnStarted(session,identity,this.generationId);
    }else if(!active||!sameNativeRecoveryIdentity(active,identity))return false;
    if(phase==='success'){
      // A question may have appeared after begin populated the TTL snapshot.
      // Success must read the existing registries again and preserve Stop.
      this.pendingQuestions?.invalidate();
      if(await this.pendingQuestionBlocks(session.harness,session.id,session.cwd))return false;
      if(await this.options.humanStopStore?.isHeld(session.harness,session.id)||!current())return false;
      await this.handleEvent('zcode',{kind:'turn.completed',harness:'zcode',sessionId:session.id,nativeType:'native-stop-hook-success',data:identity});
      return true;
    }
    await this.options.store.markAdmissionInProgress(session.harness,session.id,sessionWorkspaceIdentity(session),progress);
    return true;
  }

  async armSession(session: AgentSession, deliveryPending = false, admittedFailure?: string): Promise<boolean> {
    if (!isAutocontinueInventoryHarness(session.harness)) return false;
    if (isSubagentSession(session)) {
      await this.options.store.excludeSession(session.harness, session.id);
      return false;
    }
    if (await this.suppressIfHumanStopped(session.harness, session.id, session.cwd, session)) return false;
    const adapter = this.options.adapters.get(session.harness);
    if (!adapter?.resumeSession) return false;
    if (!await this.mayWorkOnSession(session.harness, session.id, session.cwd)) return false;
    await this.pinActiveSession(adapter, session.id);
    this.completedSessions.delete(sessionSourceKey(session));
    this.clearUrgentSession(sessionSourceKey(session));
    await this.options.store.markStarted(session, this.generationId, new Date(), true, true, deliveryPending, admittedFailure);
    return true;
  }

  async forget(harness: string, sessionId: string): Promise<void> {
    if (!isSupportedHarness(harness)) return;
    this.completedSessions.add(sessionKey(harness, sessionId));
    await this.options.store.remove(harness, sessionId);
  }

  async getQuotaRecoveryWaitStatus(harness: string, sessionId: string, cwd: string): Promise<QuotaRecoveryWaitStatus | null> {
    return this.options.store.getQuotaRecoveryWaitStatus(harness, sessionId, cwd);
  }

  /** Enroll one operator-approved session; all subsequent sends remain engine-owned. */
  async enrollOperatorCohortEntry(authorizationId: string, target: OperatorCohortEnrollmentTarget): Promise<OperatorCohortEnrollmentResult> {
    const sessionId = typeof target.sessionId === "string" ? target.sessionId.trim() : "";
    const cwd = typeof target.cwd === "string" ? target.cwd.trim() : "";
    const expected = normalizeOperatorCohortEvidence({ classification: "operator_cohort", authorizationId, ...target.expected });
    const ineligible = (reason: string): OperatorCohortEnrollmentResult => ({ sessionId, outcome: "ineligible", reason });
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/u.test(authorizationId) || !sessionId || sessionId.length > 512
      || !cwd || cwd.length > 4096 || !expected) return ineligible("invalid_enrollment_identity");
    const adapter = this.options.adapters.get("opencode");
    if (!adapter?.getSession || !this.options.fallbackModelsForHarness) return ineligible("recovery_runtime_unavailable");
    let session: AgentSession | null;
    try { session = await adapter.getSession(sessionId); } catch { return ineligible("native_snapshot_unavailable"); }
    // OpenCode maps a terminal native provider failure to AgentSession.status
    // "error". That state is safe here only with the exact fresh native
    // failed-turn proof checked immediately below; live/running sessions stay
    // ineligible.
    if (!session || session.id !== sessionId || session.harness !== "opencode" || normalize(session.cwd) !== normalize(cwd)
      || (session.status !== "idle" && session.status !== "error") || session.needsPermission || isSubagentSession(session)) return ineligible("session_not_idle_root_opencode");
    const last = nativeLastTurn(session);
    if (!exactTerminalRecoverySnapshot(session, expected) || last?.status !== "failed" && last?.status !== "error") {
      return ineligible("native_terminal_identity_mismatch");
    }
    if (await this.options.humanStopStore?.isHeld("opencode", sessionId)) return ineligible("human_stop_active");
    if (await this.pendingQuestionBlocks("opencode", sessionId, cwd)) return ineligible("pending_human_input");
    if (!await this.admissionAllowed(session, "resume")) {
      return ineligible("session_recovery_not_admitted");
    }
    const fallbackModels = await this.options.fallbackModelsForHarness("opencode");
    const candidates = operatorFallbackCandidates(fallbackModels, [expected.modelId, session.model ?? ""]);
    if (!candidates.length) return ineligible("no_configured_fallback_models");
    let admittedModel = false;
    for (const model of candidates) if (await this.operatorProjectModelAllowed(session, model)) { admittedModel = true; break; }
    if (!admittedModel) return ineligible("project_policy_disallows_fallback_model");
    const existing = await this.options.store.getQuotaRecoveryRecord("opencode", sessionId, cwd);
    if (existing) {
      const sameEnrollment = existing.evidence.classification === "operator_cohort"
        && existing.evidence.authorizationId === authorizationId && sameRecoveryEvidence(existing.evidence, expected);
      if (sameEnrollment && existing.state !== "held" && existing.state !== "exhausted") {
        return { sessionId, outcome: "already_enrolled", wait: (await this.options.store.getQuotaRecoveryWaitStatus("opencode", sessionId, cwd)) ?? undefined };
      }
      if (["waiting", "dispatching", "accepted"].includes(existing.state)
        || existing.state === "held" && existing.reasonCode === "delivery_unknown") {
        return ineligible("recovery_already_pending_or_delivery_unknown");
      }
    }
    const settings = await this.options.settingsStore.getEffective("opencode", sessionId, cwd);
    // The explicit operator enrollment sets only this independent opt-in. It
    // does not modify the general session autostart enabled flag.
    if (settings.waitForQuotaOverride !== true) await this.options.settingsStore.setSessionWaitForQuota({ harness: "opencode", sessionId, cwd }, true);
    const evidence: OperatorCohortEvidence = { ...expected, classification: "operator_cohort", authorizationId };
    let stored: UnfinishedSessionRecord;
    try { stored = await this.options.store.markOperatorCohortEligible(session, evidence, fallbackModels, this.generationId); }
    catch { return ineligible("recovery_already_pending_or_delivery_unknown"); }
    this.queueUrgentSession(sessionSourceKey(session));
    this.scheduleUrgentRecovery(0);
    const wait = await this.options.store.getQuotaRecoveryWaitStatus("opencode", sessionId, cwd);
    const matchingEnrollment = stored.quotaRecovery?.evidence.classification === "operator_cohort"
      && stored.quotaRecovery.evidence.authorizationId === authorizationId;
    return { sessionId, outcome: matchingEnrollment
      ? stored.quotaRecovery?.state === "waiting" ? "enrolled" : "already_enrolled"
      : "ineligible", ...(wait ? { wait } : {}) };
  }

  /**
   * Enroll a distinct, human-authorized continuation from a fresh terminal
   * session snapshot. The previous provider execution remains UNKNOWN and its
   * accepted receipt is archived byte-for-byte before a new claim is created.
   */
  async enrollOperatorContinuationEntry(
    authorizationId: string,
    target: OperatorContinuationEnrollmentTarget,
  ): Promise<OperatorCohortEnrollmentResult> {
    const sessionId = typeof target.sessionId === "string" ? target.sessionId.trim() : "";
    const cwd = typeof target.cwd === "string" ? target.cwd.trim() : "";
    const priorDispatchInputId = nonEmptyText(target.priorAccepted?.dispatchInputId);
    const priorNativeInputMessageId = nonEmptyText(target.priorAccepted?.nativeInputMessageId);
    const ineligible = (reason: string): OperatorCohortEnrollmentResult => ({ sessionId, outcome: "ineligible", reason });
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/u.test(authorizationId) || !sessionId || sessionId.length > 512
      || !cwd || cwd.length > 4096 || !priorDispatchInputId || !priorNativeInputMessageId) return ineligible("invalid_operator_continuation_identity");
    if (!this.options.humanStopStore || !this.pendingQuestions || !this.options.admissionGate) return ineligible("safety_gate_unavailable");
    const adapter = this.options.adapters.get("opencode");
    if (!adapter?.getSession || !adapter.listModels || !this.options.fallbackModelsForHarness) return ineligible("recovery_runtime_unavailable");
    let session: AgentSession | null;
    try { session = await adapter.getSession(sessionId); } catch { return ineligible("native_snapshot_unavailable"); }
    if (!session || session.id !== sessionId || session.harness !== "opencode" || normalize(session.cwd) !== normalize(cwd)
      || session.status !== "error" || session.needsPermission || isSubagentSession(session)) return ineligible("session_not_terminal_idle_root_opencode");
    if (await this.suppressIfHumanStopped("opencode", sessionId, cwd, session)) return ineligible("human_stop_active");
    if (await this.operatorContinuationPendingQuestionBlocks(sessionId, cwd)) return ineligible("pending_human_input");
    if (!await this.admissionAllowed(session, "resume")) return ineligible("session_recovery_not_admitted");
    const existing = await this.options.store.getQuotaRecoveryRecord("opencode", sessionId, cwd);
    if (!existing || !["accepted", "held"].includes(existing.state)
      || existing.state === "held" && existing.reasonCode !== "delivery_unknown"
      || existing.dispatchInputId !== priorDispatchInputId || existing.dispatchNativeInputId !== priorNativeInputMessageId
      || !existing.selectedModel || session.model !== existing.selectedModel
      || existing.evidence.classification !== "operator_cohort") {
      return ineligible("prior_accepted_or_unknown_receipt_mismatch");
    }
    if (existing.evidence.authorizationId === authorizationId) return ineligible("new_operator_authorization_required");
    const reader = this.options.operatorContinuationSnapshotReader ?? readOpenCodeOperatorContinuationSnapshot;
    const nativeSnapshot = await reader(sessionId, cwd);
    if (!nativeSnapshot || nativeSnapshot.sessionId !== sessionId || normalize(nativeSnapshot.cwd) !== normalize(cwd)
      || nativeSnapshot.modelId !== existing.selectedModel || nativeSnapshot.outcome !== "failed"
      || (nativeSnapshot.active !== "absent" && nativeSnapshot.active !== "idle")
      || nativeSnapshot.permissionCount !== 0 || nativeSnapshot.inboxIds.length !== 0
      || nativeSnapshot.latestUserMessageId !== priorNativeInputMessageId
      || nativeSnapshot.latestUserInputId !== priorDispatchInputId
      || !nativeSnapshot.latestTerminalEventId || !nativeSnapshot.snapshotToken) return ineligible("native_operator_snapshot_not_safe");
    const fallbackModels = await this.options.fallbackModelsForHarness("opencode");
    const candidates = operatorContinuationModelCandidates(fallbackModels, nativeSnapshot.modelId);
    if (!candidates.length) return ineligible("current_model_not_explicitly_configured_for_continuation");
    const [listedModels, projectAllowed] = await Promise.all([
      adapter.listModels(),
      this.operatorProjectModelAllowed(session, nativeSnapshot.modelId),
    ]);
    if (!listedModels.includes(nativeSnapshot.modelId) || !projectAllowed) return ineligible("project_policy_disallows_current_provider_route");
    const evidence: OperatorContinuationEvidence = {
      classification: "operator_continuation",
      authorizationId,
      priorDispatchInputId,
      priorNativeInputMessageId,
      priorSelectedModel: nativeSnapshot.modelId,
      snapshotToken: nativeSnapshot.snapshotToken,
      latestUserMessageId: nativeSnapshot.latestUserMessageId,
      latestTerminalEventId: nativeSnapshot.latestTerminalEventId,
      terminalAt: nativeSnapshot.terminalAt,
      providerExecution: "unknown",
    };
    let stored: UnfinishedSessionRecord;
    try { stored = await this.options.store.markOperatorContinuationEligible(session, evidence); }
    catch { return ineligible("prior_receipt_changed_or_operator_intent_pending"); }
    this.queueUrgentSession(sessionSourceKey(session));
    this.scheduleUrgentRecovery(0);
    const wait = await this.options.store.getQuotaRecoveryWaitStatus("opencode", sessionId, cwd);
    const matching = stored.quotaRecovery?.evidence.classification === "operator_continuation"
      && sameRecoveryEvidence(stored.quotaRecovery.evidence, evidence);
    return { sessionId, outcome: matching ? stored.quotaRecovery?.state === "waiting" ? "enrolled" : "already_enrolled" : "ineligible",
      ...(wait ? { wait } : {}) };
  }

  async reconcileQuotaRecoverySettings(): Promise<void> {
    const runtime = await this.options.settingsStore.getSettings();
    for (const record of await this.options.store.list()) {
      if (!record.quotaRecovery || record.quotaRecovery.state !== "waiting") continue;
      const effective = await this.options.settingsStore.getEffective(record.harness, record.sessionId, record.workspaceIdentity || record.cwd);
      const operatorIntent = isOperatorRecoveryEvidence(record.quotaRecovery.evidence);
      const oneShotOperatorContinuation = record.quotaRecovery.evidence.classification === "operator_continuation";
      if (!oneShotOperatorContinuation && ((!operatorIntent && !effective.enabled) || !effective.waitForQuota || (!operatorIntent && !runtime.recoverOnFailure))) {
        await this.options.store.clearWaitingQuotaRecovery(record);
      }
    }
  }

  private async suppressIfHumanStopped(harness: string, sessionId: string, cwd?: string, session?: AgentSession | null): Promise<boolean> {
    const fences = this.options.humanStopStore;
    if (!fences) return false;
    const adapter = this.options.adapters.get(harness);
    let freshSession: AgentSession | null | undefined;
    try {
      freshSession = await adapter?.getSession?.(sessionId);
    } catch {
      // Snapshot failure supplies no new stop evidence; an existing durable fence still blocks below.
    }
    const held = freshSession
      ? await fences.observe(freshSession)
      : await fences.isHeld(harness, sessionId);
    if (!held) return false;
    this.completedSessions.add(sessionKey(harnessType(harness), sessionId));
    const base = sessionKey(harnessType(harness), sessionId);
    const urgentKeys = new Set([...this.urgentSessions, ...this.urgentSessionVersions.keys()]);
    for (const key of urgentKeys) {
      if (key === base || key.startsWith(`${base}:`)) this.clearUrgentSession(key);
    }
    await this.options.store.remove(harness, sessionId, freshSession ? sessionWorkspaceIdentity(freshSession) : cwd ?? session?.cwd);
    return true;
  }

  /** Start process-lifetime recovery without delaying the HTTP/MCP control plane. */
  start(): () => void {
    this.lifecycleEpoch += 1;
    this.started = true;
    this.stopped = false;
    void this.recoverPending().catch((error) => {
      console.error(`[agent-herder] автозапуск незавершённых сессий завершился ошибкой: ${errorText(error)}`);
    });
    this.scheduleAutopilotCycle();
    void this.scheduleWatchdog(0);
    return () => this.stop();
  }

  stop(): void {
    this.lifecycleEpoch += 1;
    this.turnGenerations.clear();
    this.eagerCompletions.clear();
    this.started = false;
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = undefined;
    if (this.urgentTimer) clearTimeout(this.urgentTimer);
    this.urgentTimer = undefined;
    this.activePlannerController?.abort(new Error("Agent Herder launcher stopped"));
    this.activePlannerController = undefined;
  }

  private queueUrgentSession(key: string): number {
    this.urgentSessions.add(key);
    this.urgentSessionVersion += 1;
    this.urgentSessionVersions.set(key, this.urgentSessionVersion);
    return this.urgentSessionVersion;
  }

  private clearUrgentSession(key: string): void {
    this.urgentSessions.delete(key);
    this.urgentSessionVersions.delete(key);
  }

  private scheduleUrgentRecovery(delayMs = 250): void {
    if (!this.started) return;
    if (this.urgentTimer) clearTimeout(this.urgentTimer);
    this.urgentTimer = setTimeout(() => {
      this.urgentTimer = undefined;
      if (!this.started) return;
      void this.recoverPending().catch((error) => {
        console.error(`[agent-herder] срочное автопродолжение завершилось ошибкой: ${errorText(error)}`);
      });
    }, delayMs);
    this.urgentTimer.unref?.();
  }

  private async scheduleWatchdog(delayMs?: number): Promise<void> {
    if (!this.started) return;
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    const settings = await this.options.settingsStore.getSettings().catch(() => null);
    const configured = this.watchdogIntervalOverrideMs
      ?? Math.max(5_000, (settings?.watchdogIntervalSeconds ?? 10) * 1_000);
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = undefined;
      void this.runWatchdog().finally(() => { void this.scheduleWatchdog(); });
    }, delayMs ?? configured);
    this.watchdogTimer.unref?.();
  }

  private async runWatchdog(): Promise<void> {
    if (!this.started || this.watchdogRunning) return;
    this.watchdogRunning = true;
    try {
      const settings = await this.options.settingsStore.getSettings();
      if (!settings.watchdogEnabled) return;
      const stallMs = this.stalledTurnOverrideMs ?? settings.stalledTurnMinutes * 60_000;
      const records = (await this.options.store.list())
        .filter((record) => isAutocontinueInventoryHarness(record.harness) && record.state !== "exhausted" && !record.nonRetryableAdmission)
        .map((record) => ({
          durable: true,
          harness: record.harness,
          sessionId: record.sessionId,
          cwd: record.cwd,
          workspaceIdentity: record.workspaceIdentity,
          updatedAt: record.updatedAt,
          acceptedAt: record.acceptedAt,
          acceptedFingerprint: record.acceptedFingerprint,
          progressObservedAt: record.progressObservedAt,
          deliveryPending: record.deliveryPending,
          admissionPhase: record.admissionPhase,
          terminalReason: record.terminalReason,
          lastNativeProgressAt: record.lastNativeProgressAt,
        }));
      const explicit = settings.sessions
        .filter((record) => record.enabled && isAutocontinueInventoryHarness(record.harness))
        .map((record) => ({
          durable: false,
          harness: record.harness,
          sessionId: record.sessionId,
          cwd: record.cwd,
          workspaceIdentity: record.cwd,
          updatedAt: record.updatedAt,
          acceptedAt: undefined,
          acceptedFingerprint: undefined,
          progressObservedAt: undefined,
          deliveryPending: undefined,
          admissionPhase: undefined,
          terminalReason: undefined,
          lastNativeProgressAt: undefined,
        }));
      const inventory = new Map((await this.options.store.listInventory())
        .map((record) => [inventoryRecordKey(record), record]));
      // Durable records carry accepted-delivery progress. Let them override a
      // matching explicit setting while still adding explicitly enabled
      // sessions which have not emitted a turn-start event yet.
      const targets = [...new Map([...explicit, ...records]
        .map((record) => [sessionKey(record.harness, record.sessionId, record.workspaceIdentity || record.cwd), record])).values()]
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
      let urgent = false;
      for (const record of targets) {
        if (await this.suppressIfHumanStopped(record.harness, record.sessionId, record.cwd)) continue;
        if (!await this.mayWorkOnSession(record.harness, record.sessionId, record.cwd)) continue;
        const adapter = this.options.adapters.get(record.harness);
        if (!adapter?.resumeSession) continue;
        const key = sessionKey(record.harness, record.sessionId, record.workspaceIdentity || record.cwd);
        let session: AgentSession | null = null;
        try { session = await adapter.getSession(record.sessionId); } catch {
          // A transport/index failure is not evidence that the native session
          // disappeared. Preserve its durable recovery state and require fresh
          // successful reads before counting absence.
          this.watchdogObservations.delete(key);
          continue;
        }
        if (isSubagentSession(session)) {
          await this.options.store.excludeSession(record.harness, record.sessionId);
          continue;
        }
        if (session && await this.suppressIfHumanStopped(record.harness, record.sessionId, session.cwd, session)) continue;
        if (!session) {
          const previous = this.watchdogObservations.get(key);
          const misses = (previous?.misses ?? 0) + 1;
          this.watchdogObservations.set(key, { fingerprint: "missing", unchangedSince: previous?.unchangedSince ?? Date.now(), misses });
          // Even repeated successful null reads establish inventory absence,
          // not process death. Native failure/disconnect events own recovery
          // eligibility; leave the durable record unchanged until that proof.
          if (misses === 3) {
            console.error(`[agent-herder] watchdog: ${key} отсутствует в native inventory; ожидаю подтверждённое событие сбоя`);
          }
          continue;
        }
        const priorAssessment = inventory.get(sessionSourceKey(session));
        // An explicit opt-in remains after a task is completed. A later native
        // idle -> stopped transition is not new work, so leave it to normal
        // discovery (which invalidates the verdict when transcript evidence
        // actually changes) instead of manufacturing an urgent recovery.
        if (!record.durable
          && session.status === "stopped"
          && priorAssessment?.verdict?.verdict === "completed"
          && priorAssessment.verdict.confidence > 0
          && evidenceIsCurrent(priorAssessment)
          && inventoryRecordKey(priorAssessment) === sessionSourceKey(session)
          && priorAssessment.title === session.title
          && priorAssessment.lastActivity === session.lastActivity
          && priorAssessment.progressFingerprint === sessionInventoryProgressFingerprint(session)) continue;
        if (hasPendingNativePermission(session)) {
          this.watchdogObservations.delete(key);
          continue;
        }
        const hasActiveToolCall = session.meta?.hasActiveToolCall === true;
        const fingerprint = sessionProgressFingerprint(session);
        const previous = this.watchdogObservations.get(key);
        const observation = previous?.fingerprint === fingerprint
          ? {
              fingerprint,
              unchangedSince: previous.unchangedSince,
              misses: 0,
              ...(previous.urgentFingerprint ? { urgentFingerprint: previous.urgentFingerprint } : {}),
            }
          : { fingerprint, unchangedSince: Date.now(), misses: 0 };
        this.watchdogObservations.set(key, observation);
        const lastActivity = Date.parse(session.lastActivity);
        const stalled = session.status === "running"
          && !hasActiveToolCall
          && Number.isFinite(lastActivity)
          && Date.now() - lastActivity >= stallMs
          && Date.now() - observation.unchangedSince >= stallMs;
        if (record.acceptedAt && record.acceptedFingerprint && fingerprint !== record.acceptedFingerprint) {
          await this.options.store.observeAcceptedProgress(
            record.harness,
            record.sessionId,
            record.workspaceIdentity || record.cwd,
            record.acceptedAt,
            fingerprint,
          );
        }
        // Once a prompt crossed the native admission boundary, stale idle/error
        // snapshots and ordinary progress are never terminal proof. Native
        // turn events (persisted by handleEvent) or the independent admission
        // deadline own the next semantic decision.
        if (record.acceptedAt && record.admissionPhase !== "terminal_observed") continue;
        if (session.status !== "error" && session.status !== "stopped" && !stalled) continue;
        if (observation.urgentFingerprint === fingerprint) continue;
        this.watchdogObservations.set(key, { ...observation, urgentFingerprint: fingerprint });
        if (stalled) {
          const activeIdentity = this.activeNativeTurns.get(sessionKey(record.harness, record.sessionId))
            ?? await this.options.store.activeNativeTurn(record.harness, record.sessionId, sessionWorkspaceIdentity(session));
          if (!activeIdentity) continue;
          await this.options.store.markRecoveryEligible(
            { ...session, status: "error" },
            "stalled",
            activeIdentity,
            this.generationId,
          );
        } else {
          continue;
        }
        this.queueUrgentSession(key);
        urgent = true;
        const reason = stalled
          ? "зависла без прогресса"
          : `перешла в ${session.status}`;
        console.error(`[agent-herder] watchdog: ${key} ${reason}; запускаю срочную проверку`);
      }
      if (urgent) this.scheduleUrgentRecovery(0);
    } finally {
      this.watchdogRunning = false;
    }
  }

  recoverPending(): Promise<void> {
    if (this.recovering) return this.recovering;
    this.recovering = this.runRecovery().finally(() => {
      this.recovering = null;
      if (this.started) void this.scheduleNextRecovery();
    });
    return this.recovering;
  }

  async auditInventory(): Promise<void> {
    const outcome = await this.discoverUnfinishedSessions(this.lifecycleEpoch);
    if (outcome === "blocked") throw new Error("semantic inventory audit was blocked");
  }

  private async scheduleNextRecovery(): Promise<void> {
    if (!this.started) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    let pending: UnfinishedSessionRecord[] = [];
    try {
      pending = (await this.options.store.list()).filter((record) => record.quotaRecovery
        ? record.quotaRecovery.state === "waiting" || record.quotaRecovery.state === "dispatching"
        : record.state !== "exhausted" && Boolean(record.nextAttemptAt));
    } catch (error) {
      console.error(`[agent-herder] не удалось прочитать реестр перед следующей сверкой: ${errorText(error)}`);
    }
    const now = Date.now();
    const retryDelay = pending.length === 0
      ? this.reconcileIntervalMs
      : Math.max(1, Math.min(...pending.map((record) => record.quotaRecovery?.state === "dispatching"
        ? this.reconcileIntervalMs
        : record.nextAttemptAt ? Date.parse(record.nextAttemptAt) - now : this.reconcileIntervalMs)));
    const delay = Math.max(1, Math.min(this.reconcileIntervalMs, retryDelay));
    if (!this.started) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.recoverPending().catch((error) => {
        console.error(`[agent-herder] повторный автозапуск завершился ошибкой: ${errorText(error)}`);
      });
      this.scheduleAutopilotCycle();
    }, delay);
    this.retryTimer.unref?.();
  }

  private async runRecovery(): Promise<void> {
    this.fenceUsers += 1;
    try {
      await this.runRecoveryWithFences();
    } finally {
      this.releaseTurnFences();
    }
  }

  private async runRecoveryWithFences(): Promise<void> {
    const lifecycleEpoch = this.lifecycleEpoch;
    this.continuedThisRecovery.clear();
    const runtimeSettings = await this.options.settingsStore.getSettings();
    if (!this.lifecycleActive(lifecycleEpoch)) return;
    const inventoryWindowMs = this.options.inventoryWindowMs
      ?? runtimeSettings.inventoryWindowHours * 60 * 60 * 1_000;
    const pruned = await this.options.store.pruneAutocontinueScope(new Date(Date.now() - inventoryWindowMs));
    if (!this.lifecycleActive(lifecycleEpoch)) return;
    if (pruned.sessions > 0 || pruned.inventory > 0) {
      console.error(`[agent-herder] очищен реестр автопродолжения: ${pruned.sessions} чужих turn-записей, ${pruned.inventory} записей вне окна`);
    }
    await this.ingestColdZcodeFailures(runtimeSettings, lifecycleEpoch);
    if (!this.lifecycleActive(lifecycleEpoch)) return;
    await this.reconcileQuotaRecoveryStartup(lifecycleEpoch);
    if (!this.lifecycleActive(lifecycleEpoch)) return;
    // Crash recovery consumes only durable native evidence. Semantic inventory
    // has a separate explicit audit path and is never scanned from this loop.
    // Deliberately sequential: a restart must not multiply the host's agent workload.
    let resumedThisCycle = 0;
    const launches: Array<Promise<void>> = [];
    const records = await this.options.store.list();
    if (!this.lifecycleActive(lifecycleEpoch)) return;
    records.sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
    for (const snapshot of records) {
      let record = snapshot;
      if (!this.lifecycleActive(lifecycleEpoch)) break;
      if (record.quotaRecovery) {
        await this.processQuotaRecovery(record, lifecycleEpoch);
        continue;
      }
      if (!isAutocontinueInventoryHarness(record.harness)) continue;
      const recordKey = unfinishedRecordKey(record);
      let recoveryFence = nativeTurnFenceKey(record.harness, record.sessionId, { turnId: record.recoveryTurnId, inputId: record.recoveryInputId });
      let observedTurnGeneration = recoveryFence ? this.turnGenerations.get(recoveryFence) ?? 0 : 0;
      if (recoveryFence) this.turnGenerations.set(recoveryFence, observedTurnGeneration);
      if (this.continuedThisRecovery.has(recordKey)) continue;
      if (!await this.isEnabled(record.harness, record.sessionId, record.cwd)) {
        await this.options.store.remove(record.harness, record.sessionId, record.workspaceIdentity || record.cwd);
        continue;
      }
      // An unanswered question defers recovery; it must never discard the
      // accepted turn or its recovery record.
      if (await this.pendingQuestionBlocks(record.harness, record.sessionId, record.cwd)) continue;
      // A parent SIGKILL has no shutdown event. Only an exact automatically
      // persisted pre-loss owner observation may bridge the generation change.
      if(record.harness==='zcode'&&record.activeNativeOwner&&record.activeTurnId&&record.activeInputId
        &&record.generationId!==this.generationId){
        const proof=record.activeNativeOwner,adapter=this.options.adapters.get('zcode') as (HarnessAdapter&WorkspaceLifecycleAdapter)|undefined;
        const target:AgentSession={id:record.sessionId,harness:'zcode',cwd:record.cwd,hostId:localSessionHostId(),title:record.title??record.sessionId,model:record.model,status:'error',lastActivity:record.updatedAt,needsPermission:false};
        if(!this.lifecycleActive(lifecycleEpoch)||!await this.admissionAllowed(target,'attempt')
          ||await this.options.humanStopStore?.isHeld('zcode',record.sessionId))continue;
        this.pendingQuestions?.invalidate();
        if(await this.pendingQuestionBlocks('zcode',record.sessionId,record.cwd)
          ||await this.options.humanStopStore?.isHeld('zcode',record.sessionId))continue;
        if(!adapter?.restoreParentRuntimeLoss?.(record.sessionId,proof,target))continue;
        const qualified=await this.options.store.markPersistedActiveTurnFailed('zcode',record.sessionId,'process.disconnected',
          {turnId:record.activeTurnId,inputId:record.activeInputId},new Date(),proof,
          ()=>this.lifecycleActive(lifecycleEpoch)&&adapter.workspaceCrashRecoveryAllowed?.(record.sessionId,proof.turnId,proof.inputId)===true);
        if(!qualified)continue;Object.assign(record,qualified);
        recoveryFence=nativeTurnFenceKey('zcode',record.sessionId,{turnId:record.recoveryTurnId,inputId:record.recoveryInputId});
        observedTurnGeneration=recoveryFence?this.turnGenerations.get(recoveryFence)??0:0;
        if(recoveryFence)this.turnGenerations.set(recoveryFence,observedTurnGeneration);
      }
      if (!record.recoveryCause) {
        if ((record.activeTurnStartedAt && (record.activeTurnId || record.activeInputId))
          || record.acceptedAt || record.deliveryPending || record.admissionPhase || record.nonRetryableAdmission) continue;
        await this.options.store.remove(record.harness, record.sessionId, record.workspaceIdentity || record.cwd);
        continue;
      }
      if (record.threadSource === "subagent") {
        await this.options.store.excludeSession(record.harness, record.sessionId);
        continue;
      }
      if (recoveryFence && this.eagerCompletions.has(recoveryFence)) {
        await this.options.store.remove(record.harness, record.sessionId, record.workspaceIdentity || record.cwd);
        continue;
      }
      if ((record.recoveryCause === "turn.failed" && !runtimeSettings.recoverOnFailure)
        || (record.recoveryCause === "process.disconnected" && !runtimeSettings.recoverOnDisconnect)
        || (record.recoveryCause === "stalled" && !runtimeSettings.watchdogEnabled)) {
        await this.options.store.remove(record.harness, record.sessionId, record.workspaceIdentity || record.cwd);
        continue;
      }
      if (record.recoveryBlockedReason) continue;
      // Check durable owner authority before an adapter read can initialize a
      // workspace runtime during startup reconciliation.
      const admissionTarget: AgentSession = { id: record.sessionId, harness: record.harness,
        cwd: record.cwd, hostId: localSessionHostId(), title: record.title ?? record.sessionId, status: "idle", lastActivity: record.updatedAt, needsPermission: false };
      if (!await this.admissionAllowed(admissionTarget, "attempt")) continue;
      if (!this.lifecycleActive(lifecycleEpoch)) break;
      if (await this.suppressIfHumanStopped(record.harness, record.sessionId, record.workspaceIdentity || record.cwd)) continue;
      const adapter = this.options.adapters.get(record.harness);
      if (!adapter?.resumeSession) {
        continue;
      }
      if((adapter as WorkspaceLifecycleAdapter).workspaceCrashRecoveryAllowed?.(record.sessionId,record.recoveryTurnId,record.recoveryInputId)===false)continue;
      let session: AgentSession | null = null;
      try {
        session = await adapter.getSession(record.sessionId);
      } catch {
        continue;
      }
      if (!session) continue;
      if (session && await this.suppressIfHumanStopped(record.harness, record.sessionId, session.cwd, session)) continue;
      if (isSubagentSession(session)) {
        await this.options.store.excludeSession(record.harness, record.sessionId);
        continue;
      }
      const lastTurn = nativeLastTurn(session);
      if (record.recoveryTurnId && lastTurn?.turnId) {
        const terminal = lastTurn.status?.toLowerCase();
        if (lastTurn.turnId !== record.recoveryTurnId
          || terminal === "completed" || terminal === "succeeded" || terminal === "success"
          || (terminal === "interrupted" && record.recoveryCause !== "process.disconnected")
          || (terminal === "cancelled" && lastTurn.transportLost !== true)) {
          await this.options.store.remove(record.harness, record.sessionId, record.workspaceIdentity || record.cwd);
          continue;
        }
      }
      if (record.state === "exhausted") {
        // Exhausted is not a dead end: the archived refusal that exhausted the
        // record is reversible, so a restored thread re-arms the record and the
        // interrupted turn continues instead of being stranded.
        const rearmed = await this.rearmExhaustedArchivedRecord(adapter, record, session);
        if (!rearmed) {
          await this.notifyExhausted(record);
          continue;
        }
        record = rearmed;
      }
      const urgent = this.urgentSessions.has(recordKey) || this.urgentSessions.has(sessionKey(record.harness, record.sessionId));
      if (record.nonRetryableAdmission) {
        // The exact prompt crossed the native idempotency boundary and its turn
        // failed terminally. Keep ownership/diagnostics durable, but never
        // submit that prompt again from watchdog or reconciliation.
        await this.pinActiveSession(adapter, record.sessionId, runtimeSettings);
        continue;
      }
      if (!session || session.status === "needs_input" || session.needsPermission) {
        await this.options.store.remove(record.harness, record.sessionId, record.workspaceIdentity || record.cwd);
        continue;
      }
      if (session.status === "running" && record.recoveryCause !== "stalled") {
        await this.pinActiveSession(adapter, record.sessionId, runtimeSettings);
        continue;
      }
      const admissionPhase = record.admissionPhase
        ?? (record.acceptedAt || record.deliveryPending ? "accepted_pending" : undefined);
      if (admissionPhase === "accepted_pending" || admissionPhase === "in_progress") {
        // A prompt already crossed the native admission boundary. Idle/error
        // supervisor snapshots alone are not permission to submit it again;
        // watchdog progress/terminal evidence must first mark the record urgent.
        await this.pinActiveSession(adapter, record.sessionId, runtimeSettings);
        continue;
      }
      if (admissionPhase === "terminal_observed" && (record.terminalRetryCount ?? 0) >= 1) {
        // A terminal event authorizes at most one bounded re-admission if the
        // native turn produced no durable assistant response.
        await this.pinActiveSession(adapter, record.sessionId, runtimeSettings);
        continue;
      }
      if (!urgent && record.deliveryPending) {
        // sendPrompt admission is the idempotency boundary. Until native state
        // proves progress, watchdog owns observation and no recovery cycle may
        // repeat the prompt merely because turn.started is still unconfirmed.
        await this.pinActiveSession(adapter, record.sessionId, runtimeSettings);
        continue;
      }
      if (session && hasPendingNativePermission(session)) {
        await this.pinActiveSession(adapter, record.sessionId, runtimeSettings);
        await this.options.store.markStarted(session, this.generationId);
        continue;
      }
      if (!urgent && session?.status === "running") {
        await this.pinActiveSession(adapter, record.sessionId, runtimeSettings);
        await this.options.store.markStarted(session, this.generationId);
        continue;
      }
      if (!urgent && record.generationId === this.generationId && Date.now() - Date.parse(record.updatedAt) < this.discoveryIdleMs) {
        await this.pinActiveSession(adapter, record.sessionId, runtimeSettings);
        continue;
      }
      if (resumedThisCycle >= this.maxResumesPerCycle) continue;
      if (!this.lifecycleActive(lifecycleEpoch)) break;
      if (!await this.admissionAllowed(session, "attempt")) continue;
      if (!this.lifecycleActive(lifecycleEpoch)) break;
      const attempt = await this.options.store.beginAttempt(
        record.harness,
        record.sessionId,
        this.maxAttempts,
        this.retryDelayMs,
        new Date(),
        record.workspaceIdentity || record.cwd,
      );
      if (!this.lifecycleActive(lifecycleEpoch)) {
        if (attempt) await this.options.store.cancelAttempt(attempt);
        break;
      }
      if (!attempt) continue;
      if (recoveryFence && (this.turnGenerations.get(recoveryFence) ?? 0) !== observedTurnGeneration) {
        await this.options.store.cancelAttempt(attempt);
        continue;
      }
      resumedThisCycle += 1;
      launches.push(this.launchContinuation(adapter, record, attempt, session, lifecycleEpoch, recoveryFence, observedTurnGeneration));
    }
    await Promise.all(launches);
    if (!this.lifecycleActive(lifecycleEpoch)) return;
  }

  private async reconcileQuotaRecoveryStartup(epoch: number): Promise<void> {
    if (!this.options.fallbackModelsForHarness) return;
    const runtime = await this.options.settingsStore.getSettings();
    if (!runtime.recoverOnFailure) return;
    for (const harness of ["opencode", "zcode"] as const) {
      const hasOptIn = runtime.waitForQuota
        || runtime.waitForQuotaHarnesses.some((record) => record.harness === harness && record.waitForQuota)
        || runtime.waitForQuotaSessions.some((record) => record.harness === harness && record.waitForQuota);
      if (!hasOptIn) continue;
      const adapter = this.options.adapters.get(harness);
      if (!adapter?.listSessions || !adapter.getSession) continue;
      let sessions: AgentSession[];
      try { sessions = await adapter.listSessions(); } catch { continue; }
      for (const listed of sessions) {
        if (!this.lifecycleActive(epoch) || listed.harness !== harness || isSubagentSession(listed)) continue;
        const effective = await this.options.settingsStore.getEffective(harness, listed.id, listed.cwd);
        if (!effective.enabled || !effective.waitForQuota || !await this.mayWorkOnSession(harness, listed.id, listed.cwd)) continue;
        let fresh: AgentSession | null;
        try { fresh = await adapter.getSession(listed.id); } catch { continue; }
        const evidence = nativeLastTurn(fresh)?.quotaFailure;
        if (!evidence || !quotaModelId(evidence) || !exactTerminalQuotaSnapshot(fresh, evidence) || fresh?.needsPermission
          || fresh?.status === "needs_input" || await this.suppressIfHumanStopped(harness, listed.id, listed.cwd, fresh)) continue;
        const fallbacks = await this.options.fallbackModelsForHarness(harness);
        await this.options.store.markQuotaRecoveryEligible(fresh!, evidence, fallbacks, this.generationId);
      }
    }
  }

  private async operatorContinuationSnapshotMatches(
    session: AgentSession | null | undefined,
    evidence: OperatorContinuationEvidence,
    expectedSessionId: string,
    expectedCwd: string,
  ): Promise<boolean> {
    if (!session || session.id !== expectedSessionId || session.harness !== "opencode"
      || normalize(session.cwd) !== normalize(expectedCwd) || session.status !== "error"
      || session.needsPermission || isSubagentSession(session) || session.model !== evidence.priorSelectedModel) return false;
    const reader = this.options.operatorContinuationSnapshotReader ?? readOpenCodeOperatorContinuationSnapshot;
    let current: OpenCodeOperatorContinuationSnapshot | null;
    try { current = await reader(expectedSessionId, expectedCwd); } catch { return false; }
    return Boolean(current && current.sessionId === expectedSessionId && normalize(current.cwd) === normalize(expectedCwd)
      && current.modelId === evidence.priorSelectedModel && current.outcome === "failed"
      && (current.active === "absent" || current.active === "idle") && current.permissionCount === 0 && current.inboxIds.length === 0
      && current.latestUserMessageId === evidence.priorNativeInputMessageId
      && current.latestUserInputId === evidence.priorDispatchInputId
      && current.latestTerminalEventId === evidence.latestTerminalEventId
      && current.terminalAt === evidence.terminalAt && current.snapshotToken === evidence.snapshotToken);
  }

  private async processQuotaRecovery(snapshot: UnfinishedSessionRecord, epoch: number): Promise<void> {
    const quota = snapshot.quotaRecovery;
    if (!quota || snapshot.harness !== "opencode" && snapshot.harness !== "zcode") return;
    const harness = snapshot.harness;
    const operatorIntent = isOperatorRecoveryEvidence(quota.evidence);
    const operatorContinuation = quota.evidence.classification === "operator_continuation" ? quota.evidence : undefined;
    if (operatorContinuation && (!this.options.humanStopStore || !this.pendingQuestions || !this.options.admissionGate)) {
      await this.options.store.holdQuotaRecovery(snapshot, "native_snapshot_changed");
      return;
    }
    if (quota.state === "dispatching") {
      const claimedAt = quota.claimedAt ? Date.parse(quota.claimedAt) : Number.NaN;
      if (!Number.isFinite(claimedAt) || Date.now() - claimedAt < QUOTA_DISPATCH_CLAIM_LEASE_MS) return;
      const adapter = this.options.adapters.get(harness);
      if (!quota.dispatchInputId) return;
      if (!adapter?.getMessageAdmission) {
        await this.options.store.markQuotaDeliveryUnconfirmed(snapshot);
        return;
      }
      let receipt;
      try { receipt = await adapter.getMessageAdmission(snapshot.sessionId, quota.dispatchInputId, snapshot.cwd); }
      catch { return; }
      if (receipt.state === "admitted") await this.options.store.settleQuotaRecoveryAttempt(snapshot, "accepted", {
        ...(typeof (receipt as typeof receipt & { nativeInputMessageId?: unknown }).nativeInputMessageId === "string"
          ? { nativeInputMessageId: (receipt as typeof receipt & { nativeInputMessageId: string }).nativeInputMessageId } : {}),
      });
      else await this.options.store.markQuotaDeliveryUnconfirmed(snapshot);
      return;
    }
    if (quota.state !== "waiting") return;
    const enabled = async (): Promise<boolean> => {
      const [effective, runtime] = await Promise.all([
        this.options.settingsStore.getEffective(harness, snapshot.sessionId, snapshot.workspaceIdentity || snapshot.cwd),
        this.options.settingsStore.getSettings(),
      ]);
      // This is a one-shot operator authorization, not persistent auto-wait
      // enrollment; do not mutate or require the independent waitForQuota flag.
      return Boolean(operatorContinuation) || effective.waitForQuota && (operatorIntent || effective.enabled && runtime.recoverOnFailure);
    };
    if (!await enabled()) {
      if (operatorContinuation) {
        await this.options.store.holdQuotaRecovery(snapshot, "recovery_disabled");
        return;
      }
      await this.options.store.clearWaitingQuotaRecovery(snapshot);
      return;
    }
    if (Date.parse(quota.nextAttemptAt) > Date.now()) return;
    const adapter = this.options.adapters.get(harness);
    if (!adapter?.getSession || !adapter.changeModel || !adapter.listModels || !this.options.fallbackModelsForHarness) return;
    if (!this.lifecycleActive(epoch)) return;
    if (operatorContinuation
      ? await this.operatorContinuationPendingQuestionBlocks(snapshot.sessionId, snapshot.cwd)
      : await this.pendingQuestionBlocks(harness, snapshot.sessionId, snapshot.cwd)) {
      if (operatorContinuation) await this.options.store.holdQuotaRecovery(snapshot, "native_snapshot_changed");
      return;
    }
    let session: AgentSession | null;
    try { session = await adapter.getSession(snapshot.sessionId); } catch { return; }
    if (!session) return;
    const observedLast = nativeLastTurn(session);
    const workspaceChanged = session.harness !== harness || normalize(session.cwd) !== normalize(snapshot.workspaceIdentity || snapshot.cwd);
    const expectedInputId = recoveryEvidenceInputId(quota.evidence);
    const expectedTurnId = recoveryEvidenceTurnId(quota.evidence);
    const newTurnObserved = session.status === "running"
      || Boolean(observedLast?.turnId && expectedTurnId && observedLast.turnId !== expectedTurnId)
      || Boolean(expectedInputId && observedLast?.inputId && observedLast.inputId !== expectedInputId);
    if (workspaceChanged || newTurnObserved) {
      if (operatorContinuation) {
        await this.options.store.holdQuotaRecovery(snapshot, "native_snapshot_changed");
        return;
      }
      await this.options.store.clearWaitingQuotaRecovery(snapshot);
      return;
    }
    const terminalSnapshotMatches = operatorContinuation
      ? await this.operatorContinuationSnapshotMatches(session, operatorContinuation, snapshot.sessionId, snapshot.cwd)
      : exactTerminalRecoverySnapshot(session, quota.evidence);
    if (session.needsPermission || session.status === "needs_input" || !terminalSnapshotMatches) {
      if (operatorContinuation) await this.options.store.holdQuotaRecovery(snapshot, "native_snapshot_changed");
      return;
    }
    if (operatorContinuation && await this.options.humanStopStore?.isHeld(harness, session.id)) {
      await this.options.store.holdQuotaRecovery(snapshot, "human_stop_active");
      return;
    }
    if (!operatorContinuation && await this.suppressIfHumanStopped(harness, session.id, session.cwd, session)) return;
    if (!await this.admissionAllowed(session, "resume")) return;
    const models = await adapter.listModels();
    const selectedModel = quota.candidateModels[quota.candidateIndex]!;
    const currentPolicyModels = await this.options.fallbackModelsForHarness(harness);
    if (!currentPolicyModels.includes(selectedModel) || !models.includes(selectedModel)
      || operatorIntent && !await this.operatorProjectModelAllowed(session, selectedModel)) {
      await this.options.store.holdQuotaRecovery(snapshot, "model_unavailable");
      return;
    }
    if (session.model !== selectedModel) {
      if (operatorContinuation) {
        await this.options.store.holdQuotaRecovery(snapshot, "native_snapshot_changed");
        return;
      }
      const changed = await adapter.changeModel(session.id, selectedModel);
      if (!changed.ok) {
        await this.options.store.holdQuotaRecovery(snapshot, "model_unavailable");
        return;
      }
    }
    let verified: AgentSession | null;
    try { verified = await adapter.getSession(snapshot.sessionId); } catch { return; }
    const verifiedLast = nativeLastTurn(verified);
    if (verified && (verified.status === "running"
      || Boolean(verifiedLast?.turnId && expectedTurnId && verifiedLast.turnId !== expectedTurnId)
      || Boolean(expectedInputId && verifiedLast?.inputId && verifiedLast.inputId !== expectedInputId))) {
      if (operatorContinuation) {
        await this.options.store.holdQuotaRecovery(snapshot, "native_snapshot_changed");
        return;
      }
      await this.options.store.clearWaitingQuotaRecovery(snapshot);
      return;
    }
    const verifiedTerminalSnapshotMatches = operatorContinuation
      ? await this.operatorContinuationSnapshotMatches(verified, operatorContinuation, snapshot.sessionId, snapshot.cwd)
      : exactTerminalRecoverySnapshot(verified, quota.evidence);
    if (!verified || verified.model !== selectedModel || !verifiedTerminalSnapshotMatches
      || verified.needsPermission
      || (!operatorContinuation && await this.suppressIfHumanStopped(harness, verified.id, verified.cwd, verified))
      || !await enabled() || !this.lifecycleActive(epoch) || !await this.admissionAllowed(verified, "resume")) {
      if (operatorContinuation) await this.options.store.holdQuotaRecovery(snapshot, "native_snapshot_changed");
      return;
    }
    if (operatorContinuation
      ? await this.operatorContinuationPendingQuestionBlocks(verified.id, verified.cwd)
      : await this.pendingQuestionBlocks(harness, verified.id, verified.cwd)) {
      if (operatorContinuation) await this.options.store.holdQuotaRecovery(snapshot, "native_snapshot_changed");
      return;
    }
    if (operatorContinuation && await this.options.humanStopStore?.isHeld(harness, verified.id)) {
      await this.options.store.holdQuotaRecovery(snapshot, "human_stop_active");
      return;
    }
    const last = nativeLastTurn(verified);
    if ((!operatorContinuation && (!last || !last.completedAt))
      || (quota.evidence.classification === "quota_exhausted" && (!last || !last.userMessageId))
      || operatorContinuation && (!operatorContinuation.terminalAt || operatorContinuation.providerExecution !== "unknown")) {
      await this.options.store.holdQuotaRecovery(snapshot, "model_unavailable");
      return;
    }
    if (!(await this.options.fallbackModelsForHarness(harness)).includes(selectedModel)
      || operatorIntent && !await this.operatorProjectModelAllowed(verified, selectedModel)) {
      await this.options.store.holdQuotaRecovery(snapshot, "model_unavailable");
      return;
    }
    const claimed = await this.options.store.claimQuotaRecoveryAttempt(snapshot, selectedModel);
    const claimedQuota = claimed?.quotaRecovery;
    if (!claimed || !claimedQuota?.dispatchInputId) return;
    // Claim is durable before send. Re-read all mutable gates after the claim;
    // any uncertainty becomes held and can only be reconciled by receipt.
    let current: AgentSession | null;
    try { current = await adapter.getSession(snapshot.sessionId); } catch { current = null; }
    const currentTerminalSnapshotMatches = operatorContinuation
      ? await this.operatorContinuationSnapshotMatches(current, operatorContinuation, snapshot.sessionId, snapshot.cwd)
      : exactTerminalRecoverySnapshot(current, quota.evidence);
    if (!current || current.model !== selectedModel || !currentTerminalSnapshotMatches
      || current.status === "running" || current.needsPermission
      || !(await this.options.fallbackModelsForHarness(harness)).includes(selectedModel)
      || operatorIntent && !await this.operatorProjectModelAllowed(current, selectedModel)
      || !await enabled() || (!operatorContinuation && await this.suppressIfHumanStopped(harness, snapshot.sessionId, snapshot.cwd, current))
      || (operatorContinuation
        ? await this.operatorContinuationPendingQuestionBlocks(snapshot.sessionId, snapshot.cwd)
        : await this.pendingQuestionBlocks(harness, snapshot.sessionId, snapshot.cwd))
      || !this.lifecycleActive(epoch) || !await this.admissionAllowed(current, "resume")) {
      await this.options.store.holdQuotaRecovery(claimed, operatorContinuation ? "native_snapshot_changed" : "recovery_disabled");
      return;
    }
    if (operatorContinuation
      ? await this.operatorContinuationPendingQuestionBlocks(snapshot.sessionId, snapshot.cwd)
      : await this.pendingQuestionBlocks(harness, snapshot.sessionId, snapshot.cwd)) {
      await this.options.store.holdQuotaRecovery(claimed, operatorContinuation ? "native_snapshot_changed" : "recovery_disabled");
      return;
    }
    if (operatorContinuation && await this.options.humanStopStore?.isHeld(harness, snapshot.sessionId)) {
      await this.options.store.holdQuotaRecovery(claimed, "human_stop_active");
      return;
    }
    let result;
    try {
      result = await adapter.sendMessage(snapshot.sessionId, {
        message: this.continuationMessage,
        queue: true,
        model: selectedModel,
        inputId: claimedQuota.dispatchInputId,
        origin: "automation",
        ...(last?.userMessageId && last.completedAt && recoveryEvidenceTurnId(quota.evidence)
          ? { recoveryBoundary: { turnId: recoveryEvidenceTurnId(quota.evidence)!, userMessageId: last.userMessageId, completedAt: Date.parse(last.completedAt) } } : {}),
      });
    } catch {
      await this.options.store.settleQuotaRecoveryAttempt(claimed, "unknown");
      return;
    }
    if (result.admitted || result.pending) {
      await this.options.store.settleQuotaRecoveryAttempt(claimed, "accepted", {
        ...(result.turnId ? { turnId: result.turnId } : {}),
        ...(result.nativeInputMessageId ? { nativeInputMessageId: result.nativeInputMessageId } : {}),
      });
    } else if (result.admissionUnknown || result.nonRetryable || (!result.notSubmitted && result.ok)) {
      await this.options.store.settleQuotaRecoveryAttempt(claimed, "unknown");
    } else if (confirmedQuotaFailureText(result.error)) {
      await this.options.store.settleQuotaRecoveryAttempt(claimed, "quota_pre_admission");
    } else {
      await this.options.store.settleQuotaRecoveryAttempt(claimed, "rejected");
    }
  }

  private async reconcileSurvivingCodexTurn(record: UnfinishedSessionRecord, epoch: number): Promise<void> {
    const providerGeneration = this.providerTurnGenerations.get("codex") ?? 0;
    const current = () => this.lifecycleActive(epoch)
      && (this.providerTurnGenerations.get("codex") ?? 0) === providerGeneration;
    const adapter = this.options.adapters.get("codex") as (HarnessAdapter & {
      readTrackedTurnCompletion?: (id: string, turnId: string, cwd: string) => Promise<CodexTrackedTurnCompletion | null>;
    }) | undefined;
    if (!adapter?.readTrackedTurnCompletion || !record.activeTurnId || !this.options.judge) return;
    const allowed = async (session: AgentSession): Promise<boolean> => {
      if (!current() || !await this.isEnabled("codex", record.sessionId, record.cwd)
        || await this.options.humanStopStore?.isHeld("codex", record.sessionId)) return false;
      const policy = await this.semanticAutopilotPolicy();
      if (!policy || !await this.semanticAutopilotAllows(session, policy)) return false;
      this.pendingQuestions?.invalidate();
      if (await this.pendingQuestionBlocks("codex", record.sessionId, record.cwd)) return false;
      const held = await this.options.humanStopStore?.isHeld("codex", record.sessionId);
      return current() && !held;
    };
    const target: AgentSession = {id: record.sessionId, harness: "codex", cwd: record.cwd, hostId: localSessionHostId(), title: record.title ?? record.sessionId,
      status: "idle", needsPermission: false, lastActivity: record.updatedAt};
    if (!await allowed(target)) return;
    let proof: CodexTrackedTurnCompletion | null;
    try { proof = await adapter.readTrackedTurnCompletion(record.sessionId, record.activeTurnId, record.cwd); }
    catch { return; } // Unknown/transport timeout never means success or failure.
    if (!proof || !await allowed(proof.session)) return;
    const expectedInventory = (await this.options.store.listInventory())
      .find(candidate => inventoryRecordKey(candidate) === sessionSourceKey(proof.session));
    let verdict: Omit<SessionInventoryVerdict, "judgedAt">;
    try { verdict = normalizeVerdict(await this.options.judge.decide({session: proof.session, transcriptTail: proof.transcriptTail})); }
    catch { return; }
    // No synthetic Stop. Completion of the model turn alone is not task
    // success, and a human question/unfinished result retains its active row.
    if (verdict.verdict !== "completed" || verdict.confidence <= 0 || !await allowed(proof.session)) return;
    let fresh: CodexTrackedTurnCompletion | null;
    try { fresh = await adapter.readTrackedTurnCompletion(record.sessionId, record.activeTurnId, record.cwd); }
    catch { return; }
    if (!fresh || fresh.fingerprint !== proof.fingerprint || !await allowed(fresh.session)) return;
    const inventory = inventoryFromAssessment({adapter, session: fresh.session, sourceKey: sessionSourceKey(fresh.session),
      autoResumeEnabled: true, urgentSignalVersions: new Map(), transcriptTail: fresh.transcriptTail},
      {...verdict, judgedAt: new Date().toISOString()});
    const settled = await this.options.store.settleTrackedCodexCompletion(record, inventory, expectedInventory, async () => {
      if (!await allowed(fresh.session)) return false;
      let final: CodexTrackedTurnCompletion | null;
      try { final = await adapter.readTrackedTurnCompletion!(record.sessionId, record.activeTurnId!, record.cwd); }
      catch { return false; }
      if (!final || final.fingerprint !== proof.fingerprint) return false;
      this.pendingQuestions?.invalidate();
      if (await this.pendingQuestionBlocks("codex", record.sessionId, record.cwd)) return false;
      const held = await this.options.humanStopStore?.isHeld("codex", record.sessionId);
      return current() && !held;
    }, current);
    if (settled) {
      const key = sessionKey("codex", record.sessionId);
      if (sameNativeRecoveryIdentity(this.activeNativeTurns.get(key) ?? {}, {turnId: record.activeTurnId, inputId: record.activeInputId})) {
        this.activeNativeTurns.delete(key);
      }
      this.clearUrgentSession(unfinishedRecordKey(record));
    }
  }

  /** LLM task planning is a separate owner from deterministic crash recovery. */
  runAutopilotCycle(): Promise<void> {
    if (this.autopiloting) return this.autopiloting;
    const lifecycleEpoch = this.lifecycleEpoch;
    this.autopiloting = (async () => {
      if (!this.lifecycleActive(lifecycleEpoch)) return;
      const policy = await this.semanticAutopilotPolicy();
      if (!policy || !this.lifecycleActive(lifecycleEpoch)) return;
      // Business classification belongs to this existing semantic lifecycle,
      // never to the no-LLM recovery loop. Shared native writers can finish an
      // old exact turn after we reconnect without delivering its notification.
      let checked = 0;
      for (const record of await this.options.store.list()) {
        if (!this.lifecycleActive(lifecycleEpoch)) return;
        if (record.harness !== "codex" || !record.activeTurnId || record.recoveryCause
          || record.generationId === this.generationId || record.threadSource === "subagent") continue;
        if (checked++ >= this.maxJudgementsPerCycle) break;
        await this.reconcileSurvivingCodexTurn(record, lifecycleEpoch);
      }
      const outcome = await this.discoverUnfinishedSessions(lifecycleEpoch, policy);
      if (outcome === "blocked") {
        console.error("[agent-herder] LLM-автопилот не построил безопасный план; повтор будет выполнен по backoff");
      }
    })().finally(() => { this.autopiloting = null; });
    return this.autopiloting;
  }

  private scheduleAutopilotCycle(): void {
    if (!this.started) return;
    // Reuse the existing lifecycle clock, but never await the provider from
    // the recovery promise. A hung/offline LLM cannot hold native retries.
    void this.runAutopilotCycle().catch((error) => {
      console.error(`[agent-herder] LLM-автопилот завершился ошибкой: ${errorText(error)}`);
    });
  }

  private async ingestColdZcodeFailures(runtimeSettings: SessionAutostartFile, lifecycleEpoch: number): Promise<void> {
    if (!runtimeSettings.recoverOnFailure) return;
    const adapter = this.options.adapters.get("zcode");
    if (!adapter) return;
    let sessions: AgentSession[];
    try {
      // ZCode listSessions reads the local native indexes. Cold discovery must
      // never initialize an app-server merely to manufacture recovery proof.
      sessions = await adapter.listSessions();
    } catch {
      return;
    }
    const now = Date.now();
    const cutoff = now - 48 * 60 * 60 * 1_000;
    for (const session of sessions) {
      if (!this.lifecycleActive(lifecycleEpoch)) return;
      const turn = nativeLastTurn(session);
      if (session.harness !== "zcode" || isSubagentSession(session) || turn?.rootSession !== true) continue;
      if (session.status === "running" || session.status === "needs_input" || session.needsPermission || hasPendingNativePermission(session)) continue;
      const terminalStatus = turn.status?.toLowerCase();
      const transportLost = terminalStatus === "cancelled" && turn.transportLost === true;
      if (!turn.turnId || (terminalStatus !== "error" && !transportLost) || !turn.startedAt || !turn.completedAt || !turn.userMessageId) continue;
      const startedAt = Date.parse(turn.startedAt);
      const completedAt = Date.parse(turn.completedAt);
      if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)
        || startedAt > completedAt || completedAt < cutoff || completedAt > now) continue;
      if (turn.pendingInput !== false) continue;
      if (!transportLost && (turn.cancelledByUser !== false || turn.userMessageMatchesLatest !== true
        || turn.assistantSucceeded !== false || turn.progressedAfterFailure !== false)) continue;
      if (!await this.mayWorkOnSession("zcode", session.id, session.cwd)) continue;
      if (this.options.humanStopStore && await this.options.humanStopStore.isHeld("zcode", session.id)) continue;
      await this.options.store.ingestColdFailure(session, {
        turnId: turn.turnId,
        completedAt: turn.completedAt,
        userMessageId: turn.userMessageId,
      }, coldFailureBlockReason(turn));
    }
  }

  private async recoveryNativeStateStillEligible(adapter: HarnessAdapter, record: UnfinishedSessionRecord): Promise<boolean> {
    if((adapter as WorkspaceLifecycleAdapter).workspaceCrashRecoveryAllowed?.(record.sessionId,record.recoveryTurnId,record.recoveryInputId)===false)return false;
    const key = sessionKey(record.harness, record.sessionId);
    if (this.completedSessions.has(key) || this.completedSessions.has(unfinishedRecordKey(record))) return false;
    let current: AgentSession | null;
    try { current = await adapter.getSession(record.sessionId); } catch { return false; }
    if (this.completedSessions.has(key) || this.completedSessions.has(unfinishedRecordKey(record))) return false;
    if (!current || current.id !== record.sessionId || current.harness !== record.harness
      || sessionWorkspaceIdentity(current) !== (record.workspaceIdentity || normalize(record.cwd))
      || current.status === "needs_input" || current.needsPermission || hasPendingNativePermission(current)
      || isSubagentSession(current)) return false;
    // The fresh read can reveal a human stop after the earlier owner checks.
    // Persisted stop fences are authoritative; standalone recovery without a
    // configured stop store conservatively holds native stop metadata too.
    if (this.options.humanStopStore) {
      if (await this.options.humanStopStore.observe(current)) return false;
    } else if (current.meta?.automationStop) return false;
    if (record.recoveryCause !== "stalled"
      && (current.status === "running" || nonEmptyText(current.meta?.activeTurnId))) return false;
    const last = nativeLastTurn(current);
    if (record.recoveryTurnId && last?.turnId) {
      const status = last.status?.toLowerCase();
      if (last.turnId !== record.recoveryTurnId
        || status === "completed" || status === "succeeded" || status === "success"
        || (status === "interrupted" && record.recoveryCause !== "process.disconnected")
        || (status === "cancelled" && last.transportLost !== true)) return false;
    }
    return !this.completedSessions.has(key) && !this.completedSessions.has(unfinishedRecordKey(record));
  }

  private async launchContinuation(
    adapter: HarnessAdapter,
    record: UnfinishedSessionRecord,
    attempt: UnfinishedSessionRecord,
    session: AgentSession | null,
    lifecycleEpoch: number,
    recoveryFence: string | undefined,
    turnGeneration: number,
  ): Promise<void> {
    const trackedSession = session ?? {
      id: record.sessionId,
      harness: record.harness,
      status: "running" as const,
      title: record.title || "Незавершённая задача",
      cwd: record.cwd,
      hostId: localSessionHostId(),
      lastActivity: new Date().toISOString(),
      model: record.model,
      needsPermission: false,
    };
    let promptAccepted = false;
    let promptPending = false;
    let promptAdmissionFailure: string | undefined;
    try {
      if (!this.lifecycleActive(lifecycleEpoch)) {
        await this.options.store.cancelAttempt(attempt);
        return;
      }
      if (recoveryFence && (this.turnGenerations.get(recoveryFence) ?? 0) !== turnGeneration) {
        await this.options.store.cancelAttempt(attempt);
        return;
      }
      const runtimeSettings = await this.options.settingsStore.getSettings();
      if (!this.lifecycleActive(lifecycleEpoch)) {
        await this.options.store.cancelAttempt(attempt);
        return;
      }
      if (await this.suppressIfHumanStopped(record.harness, record.sessionId, record.workspaceIdentity || record.cwd, session ?? undefined)) return;
      if (recoveryFence && (this.turnGenerations.get(recoveryFence) ?? 0) !== turnGeneration) {
        await this.options.store.cancelAttempt(attempt);
        return;
      }
      if (!record.recoveryCause && runtimeSettings.rolloverExpiredCache && session && this.options.cacheHandoff) {
        if (!await this.admissionAllowed(session, "rollover")) {
          await this.options.store.cancelAttempt(attempt);
          return;
        }
        const handoff = await this.options.cacheHandoff.maybeRollover(session, new Date(), {
          movePinned: runtimeSettings.movePinnedOnRollover,
        });
        if (handoff.kind === "held") {
          await this.suppressIfHumanStopped(record.harness, record.sessionId, record.workspaceIdentity || record.cwd, session);
          return;
        }
        if ((handoff.kind === "rolled_over" || handoff.kind === "admitted_failed") && handoff.session) {
          const handoffFailure = handoff.kind === "admitted_failed"
            ? handoff.admittedFailure || "Native cache handoff turn failed after admission"
            : undefined;
          // maybeRollover already created and handed off the replacement. Even
          // if stop arrived during that await, settle durable registry state;
          // do not repeat the rollover on the next process generation.
          if (!this.lifecycleActive(lifecycleEpoch)) {
            await this.options.settingsStore.setSession({ harness: record.harness, sessionId: record.sessionId, cwd: record.cwd }, false);
            await this.options.store.remove(record.harness, record.sessionId, record.workspaceIdentity || record.cwd);
            await this.options.store.markStarted(handoff.session, this.generationId, new Date(), true, true, handoff.deliveryPending === true, handoffFailure);
            return;
          }
          if (!runtimeSettings.movePinnedOnRollover) await this.pinActiveSession(adapter, handoff.session.id, runtimeSettings);
          if (!this.lifecycleActive(lifecycleEpoch)) {
            await this.options.settingsStore.setSession({ harness: record.harness, sessionId: record.sessionId, cwd: record.cwd }, false);
            await this.options.store.remove(record.harness, record.sessionId, record.workspaceIdentity || record.cwd);
            await this.options.store.markStarted(handoff.session, this.generationId, new Date(), true, true, handoff.deliveryPending === true, handoffFailure);
            return;
          }
          await this.options.settingsStore.setSession({ harness: record.harness, sessionId: record.sessionId, cwd: record.cwd }, false);
          await this.options.store.remove(record.harness, record.sessionId, record.workspaceIdentity || record.cwd);
          await this.options.store.markStarted(handoff.session, this.generationId, new Date(), true, true, handoff.deliveryPending === true, handoffFailure);
          this.clearUrgentSession(unfinishedRecordKey(record));
          console.error(handoffFailure
            ? `[agent-herder] новая cache-handoff сессия ${handoff.session.id} приняла prompt, но native turn failed без безопасного retry: ${handoffFailure}`
            : `[agent-herder] протухшая сессия ${record.harness}:${record.sessionId} продолжена в новой ${handoff.session.id}`);
          return;
        }
        if (!this.lifecycleActive(lifecycleEpoch)) {
          await this.options.store.cancelAttempt(attempt);
          return;
        }
      }
      if (!this.lifecycleActive(lifecycleEpoch)) {
        await this.options.store.cancelAttempt(attempt);
        return;
      }
      if (await this.suppressIfHumanStopped(record.harness, record.sessionId, record.workspaceIdentity || record.cwd)) return;
      const admissionSettings = await this.options.settingsStore.getSettings();
      if (!await this.isEnabled(record.harness, record.sessionId, record.workspaceIdentity || record.cwd)
        || (record.recoveryCause === "turn.failed" && !admissionSettings.recoverOnFailure)
        || (record.recoveryCause === "process.disconnected" && !admissionSettings.recoverOnDisconnect)
        || (record.recoveryCause === "stalled" && !admissionSettings.watchdogEnabled)) {
        await this.options.store.cancelAttempt(attempt);
        await this.options.store.remove(record.harness, record.sessionId, record.workspaceIdentity || record.cwd);
        return;
      }
      if (await this.pendingQuestionBlocks(record.harness, record.sessionId, record.workspaceIdentity || record.cwd)) {
        await this.options.store.cancelAttempt(attempt);
        return;
      }
      if (recoveryFence && (this.turnGenerations.get(recoveryFence) ?? 0) !== turnGeneration) {
        await this.options.store.cancelAttempt(attempt);
        return;
      }
      if (!await this.admissionAllowed(trackedSession, "resume")) {
        await this.options.store.cancelAttempt(attempt);
        return;
      }
      if (!this.lifecycleActive(lifecycleEpoch) || (recoveryFence && (this.turnGenerations.get(recoveryFence) ?? 0) !== turnGeneration)) {
        await this.options.store.cancelAttempt(attempt);
        return;
      }
      if (!await this.recoveryNativeStateStillEligible(adapter, record)) {
        await this.options.store.cancelAttempt(attempt);
        return;
      }
      if(record.activeNativeOwner){
        this.pendingQuestions?.invalidate();
        if(await this.pendingQuestionBlocks(record.harness,record.sessionId,record.cwd)
          ||await this.options.humanStopStore?.isHeld(record.harness,record.sessionId)){await this.options.store.cancelAttempt(attempt);return;}
      }
      const resumed = await this.resumeRestorableSession(adapter, record);
      if (!resumed.ok) throw new Error(resumed.error);
      if (!this.lifecycleActive(lifecycleEpoch)) {
        await this.options.store.cancelAttempt(attempt);
        return;
      }
      if (recoveryFence && (this.turnGenerations.get(recoveryFence) ?? 0) !== turnGeneration) {
        await this.options.store.cancelAttempt(attempt);
        return;
      }
      await this.pinActiveSession(adapter, record.sessionId, runtimeSettings);
      if (!this.lifecycleActive(lifecycleEpoch)) {
        await this.options.store.cancelAttempt(attempt);
        return;
      }
      if (await this.suppressIfHumanStopped(record.harness, record.sessionId, record.workspaceIdentity || record.cwd)) return;
      if (recoveryFence && (this.turnGenerations.get(recoveryFence) ?? 0) !== turnGeneration) {
        await this.options.store.cancelAttempt(attempt);
        return;
      }
      if (!await this.admissionAllowed(trackedSession, "send")) {
        await this.options.store.cancelAttempt(attempt);
        return;
      }
      if (!this.lifecycleActive(lifecycleEpoch) || (recoveryFence && (this.turnGenerations.get(recoveryFence) ?? 0) !== turnGeneration)) {
        await this.options.store.cancelAttempt(attempt);
        return;
      }
      if (!await this.recoveryNativeStateStillEligible(adapter, record)) {
        await this.options.store.cancelAttempt(attempt);
        return;
      }
      if(record.activeNativeOwner){
        this.pendingQuestions?.invalidate();
        if(await this.pendingQuestionBlocks(record.harness,record.sessionId,record.cwd)
          ||await this.options.humanStopStore?.isHeld(record.harness,record.sessionId)){await this.options.store.cancelAttempt(attempt);return;}
      }
      const boundary = session?.harness === 'zcode' ? nativeLastTurn(session) : undefined;
      const lifecycle=adapter as WorkspaceLifecycleAdapter;
      const workspaceCrash=lifecycle.getWorkspaceCrashBoundary?.(record.sessionId);
      if(lifecycle.workspaceCrashRecoveryAllowed?.(record.sessionId,record.recoveryTurnId,record.recoveryInputId)===false){
        await this.options.store.cancelAttempt(attempt);return;
      }
      const sent = await adapter.sendMessage(record.sessionId, { message: this.continuationMessage, queue: true,
        ...(workspaceCrash?{workspaceCrashBoundary:workspaceCrash}:{}),
        ...(boundary?.turnId && boundary.userMessageId && boundary.completedAt ? { recoveryBoundary: {
          turnId: boundary.turnId, userMessageId: boundary.userMessageId, completedAt: Date.parse(boundary.completedAt),
        } } : {}),
      });
      const terminalAdmission = admittedNonRetryableFailure(sent);
      if (terminalAdmission) {
        promptAccepted = true;
        promptAdmissionFailure = terminalAdmission;
        await this.options.store.markStarted(trackedSession, this.generationId, new Date(), true, true, false, terminalAdmission);
        this.clearUrgentSession(unfinishedRecordKey(record));
        console.error(`[agent-herder] ${record.harness}:${record.sessionId} приняла prompt, но native turn завершился без безопасного retry: ${terminalAdmission}`);
        return;
      }
      if (!sent.ok) throw new Error(sent.error || "команда продолжения отклонена");
      promptAccepted = true;
      promptPending = sent.pending === true;
      // The prompt is now accepted by the native harness. Always settle the
      // durable record even if stop arrived during sendMessage; rolling the
      // attempt back here could enqueue the same continuation after restart.
      await this.options.store.markStarted(trackedSession, this.generationId, new Date(), true, true, promptPending);
      this.clearUrgentSession(unfinishedRecordKey(record));
      console.error(`[agent-herder] автоматически продолжена незавершённая сессия ${record.harness}:${record.sessionId}`);
    } catch (error) {
      if (promptAccepted) {
        try {
          await this.options.store.markStarted(trackedSession, this.generationId, new Date(), true, true, promptPending, promptAdmissionFailure);
        } catch (settleError) {
          console.error(`[agent-herder] ZCode/Codex prompt accepted but durable settle failed for ${record.sessionId}: ${errorText(settleError)}`);
        }
        return;
      }
      if (!this.lifecycleActive(lifecycleEpoch)) {
        await this.options.store.cancelAttempt(attempt);
        return;
      }
      const failure = errorText(error);
      if (isBusyCodexWriter(record.harness, failure)) {
        if (!this.lifecycleActive(lifecycleEpoch)) {
          await this.options.store.cancelAttempt(attempt);
          return;
        }
        const inbox = this.options.deferredStore ?? deferredMessages;
        const pending = await inbox.list(record.sessionId);
        if (!this.lifecycleActive(lifecycleEpoch)) {
          await this.options.store.cancelAttempt(attempt);
          return;
        }
        let deferredAccepted = pending.some((message) => isAutocontinueRequest(message.message));
        if (!deferredAccepted) {
          if (!await this.admissionAllowed(trackedSession, "send")) {
            await this.options.store.cancelAttempt(attempt);
            return;
          }
          if (!this.lifecycleActive(lifecycleEpoch)) { await this.options.store.cancelAttempt(attempt); return; }
          await inbox.add(record.sessionId, this.continuationMessage);
          deferredAccepted = true;
        }
        if (!this.lifecycleActive(lifecycleEpoch) && !deferredAccepted) {
          await this.options.store.cancelAttempt(attempt);
          return;
        }
        // Existing or newly-added deferred work is already durable. Settle it
        // even if stop arrived after the inbox write so restart cannot add a
        // duplicate continuation.
        await this.options.store.markStarted(trackedSession, this.generationId, new Date(), false, true, true);
        console.error(`[agent-herder] продолжение Codex отложено до безопасной границы хода ${record.sessionId}`);
        return;
      }
      await this.fail(attempt, failure);
    }
  }

  private async discoverUnfinishedSessions(lifecycleEpoch: number, semanticAutopilot?: EffectivePolicy): Promise<DiscoveryOutcome> {
    const runtimeSettings = await this.options.settingsStore.getSettings();
    const inventoryWindowMs = this.options.inventoryWindowMs
      ?? runtimeSettings.inventoryWindowHours * 60 * 60 * 1_000;
    const listedCandidates: Array<{ adapter: HarnessAdapter; session: AgentSession }> = [];
    const inventoryBatch: UnfinishedSessionInventoryRecord[] = [];
    const exhaustiveHarnesses = new Set<"codex" | "zcode">();
    const observedSourceKeys = new Set<string>();
    for (const [provider, adapter] of this.options.adapters) {
      if (!isAutocontinueInventoryHarness(provider) || !adapter.resumeSession) continue;
      if (semanticAutopilot && !semanticAutopilot.policy.harnesses.includes(provider)) continue;
      if ((provider === "codex" || provider === "zcode") && adapter.isReady && !adapter.isReady()) {
        try {
          await adapter.init();
        } catch (error) {
          console.error(`[agent-herder] не удалось подключить live-status ${displayHarness(provider)}: ${errorText(error)}`);
        }
      }
      let sessions: AgentSession[];
      try {
        sessions = await adapter.listSessions();
      } catch (error) {
        console.error(`[agent-herder] не удалось сверить ${displayHarness(provider)} сессии: ${errorText(error)}`);
        continue;
      }
      let receipt = null;
      try { receipt = adapter.getSessionSnapshotReceipt?.() ?? null; } catch { /* unknown snapshot: preserve inventory */ }
      if (receipt?.exhaustive === true) exhaustiveHarnesses.add(provider);
      for (const session of sessions) {
        const lastActivity = Date.parse(session.lastActivity);
      if (!Number.isFinite(lastActivity) || Date.now() - lastActivity > inventoryWindowMs) continue;
      const sourceKey = sessionSourceKey(session);
      if (isSubagentSession(session)) {
        await this.options.store.excludeSession(session.harness, session.id);
        continue;
      }
      observedSourceKeys.add(sourceKey);
      if (await this.suppressIfHumanStopped(session.harness, session.id, session.cwd, session)) continue;
      listedCandidates.push({ adapter, session });
      }
    }
    // Migration and dedupe must finish in one store transaction before known
    // keys or recovery records are read. Otherwise a legacy cwd key and the
    // same native session's canonical workspace key can each admit a prompt.
    const listedSessions = listedCandidates.map(({ session }) => session);
    await this.options.settingsStore.migrateWorkspaceIdentities(listedSessions);
    await this.options.store.migrateWorkspaceIdentities(listedSessions);
    const durableRecords = await this.options.store.list();
    const durableBySourceKey = new Map(durableRecords.map((record) => [unfinishedRecordKey(record), record]));
    const known = new Set(durableRecords.map(unfinishedRecordKey));
    const nonRetryableAdmissions = new Set(durableRecords
      .filter((record) => record.nonRetryableAdmission)
      .map(unfinishedRecordKey));
    const priorInventory = new Map((await this.options.store.listInventory()).map((record) => [inventoryRecordKey(record), record]));
    // A terminal native admission remains visible in the exact 48h snapshot,
    // but must never be replanned into another prompt.
    const candidates = listedCandidates.filter(({ session }) => !nonRetryableAdmissions.has(sessionSourceKey(session)));
    candidates.sort((left, right) => Date.parse(right.session.lastActivity) - Date.parse(left.session.lastActivity));
    await this.options.store.reconcileInventorySnapshot(
      exhaustiveHarnesses,
      observedSourceKeys,
    );
    if (this.options.judge?.plan) {
      const cohortEvidence = new Map<string, { messages: SessionMessageView[]; transcriptTail: string }>();
      const cohortWakeRequested = new Map<string, boolean>();
      const cohortAllMembersSafe = new Map<string, boolean>();
      const cohortExplicitUrgent = new Map<string, boolean>();
      const activeFailedCohorts = new Set([...priorInventory.values()].flatMap((record) => record.assessmentFailure
        ? [record.assessmentFailure.cohortId] : []));
      for (const { adapter, session } of candidates) {
        const sourceKey = sessionSourceKey(session);
        const cohortId = assessmentCohortId(session);
        if (!activeFailedCohorts.has(cohortId)) continue;
        const previous = priorInventory.get(sourceKey);
        const failure = previous?.assessmentFailure;
        const messages = await sessionEvidenceMessages(adapter, session.id, runtimeSettings.evidenceMessageCount);
        const transcriptTail = completionEvidence(messages, runtimeSettings.evidenceMessageCount);
        cohortEvidence.set(sourceKey, { messages, transcriptTail });
        let urgent = this.urgentSessions.has(sourceKey) || this.urgentSessions.has(sessionKey(session.harness, session.id));
        const candidateDelayMs = this.candidateDelayOverrideMs
          ?? Math.max(this.discoveryIdleMs, unfinishedProbeDelayMs(session));
        const oldEnough = Date.now() - Date.parse(session.lastActivity) >= candidateDelayMs;
        const nativeSafe = urgent || (session.status !== "running" && oldEnough);
        cohortAllMembersSafe.set(cohortId, (cohortAllMembersSafe.get(cohortId) ?? true) && nativeSafe);
        cohortExplicitUrgent.set(cohortId, cohortExplicitUrgent.get(cohortId) === true || urgent);
        const fingerprint = evidenceFingerprint(transcriptTail);
        const metadataChanged = !previous
          || previous.lastActivity !== session.lastActivity
          || previous.status !== session.status
          || (previous.workspaceIdentity || previous.cwd) !== sessionWorkspaceIdentity(session)
          || previous.title !== session.title
          || previous.progressFingerprint !== sessionInventoryProgressFingerprint(session);
        const evidenceChanged = failure
          ? failure.pipelineVersion !== CURRENT_ASSESSMENT_PIPELINE_VERSION
            || failure.evidenceFingerprint !== fingerprint
          : !previous || previous.transcriptTail !== transcriptTail;
        const deadlineExpired = Boolean(failure && (!failure.nextAttemptAt || Date.parse(failure.nextAttemptAt) <= Date.now()));
        const independentlyActionable = !failure && (!previous?.verdict
          || previous.verdict.confidence === 0
          || previous.verdict.verdict === "unfinished"
          || metadataChanged
          || evidenceChanged);
        cohortWakeRequested.set(cohortId, cohortWakeRequested.get(cohortId) === true
          || evidenceChanged || deadlineExpired || independentlyActionable);
      }
      const cohortWake = new Map<string, boolean>();
      for (const cohortId of activeFailedCohorts) {
        const explicitUrgent = cohortExplicitUrgent.get(cohortId) === true;
        cohortWake.set(cohortId, explicitUrgent
          || (cohortWakeRequested.get(cohortId) === true && cohortAllMembersSafe.get(cohortId) === true));
      }
      const assessed: AssessedSession[] = [];
      for (const { adapter, session } of candidates) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (!this.lifecycleActive(lifecycleEpoch)) return "idle";
        const nativeTurn = nativeLastTurn(session);
        const nativeHumanGate = nativeTurn?.cancelledByUser === true
          || nativeTurn?.requiresHuman === true
          || nativeTurn?.pendingInput === true;
        const autoResumeEnabled = !nativeHumanGate
          && !await this.pendingQuestionBlocks(session.harness, session.id, session.cwd)
          && (semanticAutopilot ? await this.semanticAutopilotAllows(session, semanticAutopilot)
            : await this.isEnabled(session.harness, session.id, session.cwd));
        const sourceKey = sessionSourceKey(session);
        let urgent = this.urgentSessions.has(sourceKey) || this.urgentSessions.has(sessionKey(session.harness, session.id));
        const urgentSignalVersions = new Map([sourceKey, sessionKey(session.harness, session.id)]
          .map((key) => [key, this.urgentSessionVersions.get(key) ?? 0] as const));
        const durableAdmission = durableBySourceKey.get(sourceKey);
        let admissionPhase = durableAdmission?.admissionPhase
          ?? (durableAdmission?.acceptedAt || durableAdmission?.deliveryPending ? "accepted_pending" : undefined);
        // markAdmissionTerminal discharges the retry budget of an answered
        // admission. The assessment below must read that updated count, not the
        // pre-terminal snapshot, or it re-decides the session as exhausted in
        // the very cycle where the assistant answer was proven.
        let acceptedTerminalRetryCount = durableAdmission?.terminalRetryCount ?? 0;
        let admissionMessages: SessionMessageView[] | null | undefined;
        if ((admissionPhase === "accepted_pending" || admissionPhase === "in_progress" || admissionPhase === "terminal_observed")
          && durableAdmission?.acceptedAt) {
          admissionMessages = await sessionEvidenceMessages(adapter, session.id, runtimeSettings.evidenceMessageCount);
          if (hasPersistedAssistantAfterAdmission(admissionMessages ?? [], durableAdmission.acceptedAt)) {
            const terminal = await this.options.store.markAdmissionTerminal(
              session.harness,
              session.id,
              sessionWorkspaceIdentity(session),
              "turn.completed",
              sessionProgressFingerprint(session),
              true,
            );
            if (terminal) acceptedTerminalRetryCount = terminal.terminalRetryCount ?? 0;
            admissionPhase = "terminal_observed";
            const snapshotVersion = urgentSignalVersions.get(sourceKey) ?? 0;
            const versionBeforeQueue = this.urgentSessionVersions.get(sourceKey) ?? 0;
            const queuedVersion = this.queueUrgentSession(sourceKey);
            if (versionBeforeQueue === snapshotVersion) urgentSignalVersions.set(sourceKey, queuedVersion);
            urgent = true;
          } else if (acceptedTurnStoppedByHuman(nativeTurn, durableAdmission.acceptedAt)) {
            // The accepted turn is over and produced no answer because a human
            // stopped it. Nothing can ever confirm that turn, and re-sending it
            // would fight the human, so reconcile it here instead of leaving an
            // impossible admission to age into a critical timeout alarm.
            await this.options.store.markAdmissionStoppedByHuman(
              session.harness,
              session.id,
              sessionWorkspaceIdentity(session),
              sessionProgressFingerprint(session),
            );
            const stoppedVerdict: SessionInventoryVerdict = {
              verdict: "needs_human",
              reason: "Принятое продолжение остановлено человеком до появления ответа агента; подтверждать завершение нечего, повторная отправка не выполняется.",
              confidence: 1,
              judgedAt: new Date().toISOString(),
            };
            await this.options.store.upsertInventoryBatch([
              inventoryFromAssessment({
                adapter, session, sourceKey, autoResumeEnabled, urgentSignalVersions,
                transcriptTail: completionEvidence(admissionMessages ?? [], runtimeSettings.evidenceMessageCount),
              }, stoppedVerdict),
            ]);
            this.clearUrgentSession(sourceKey);
            continue;
          }
        }
        const admissionProgressAt = Date.parse(durableAdmission?.lastNativeProgressAt || durableAdmission?.acceptedAt || "");
        const nativeWorkStillActive = session.status === "running"
          && (session.meta?.hasActiveToolCall === true
            || Date.now() - Date.parse(session.lastActivity) < (this.stalledTurnOverrideMs ?? runtimeSettings.stalledTurnMinutes * 60_000));
        const admissionTimedOut = (admissionPhase === "accepted_pending" || admissionPhase === "in_progress")
          && Number.isFinite(admissionProgressAt)
          && !nativeWorkStillActive
          && Date.now() - admissionProgressAt >= this.acceptedAdmissionTimeoutMs;
        // Generic urgent signals cannot cross the native idempotency boundary.
        // Only a durable terminal proof makes an accepted turn semantically
        // assessable for completion or its one bounded re-admission.
        if ((admissionPhase === "accepted_pending" || admissionPhase === "in_progress") && !admissionTimedOut) continue;
        const previous = priorInventory.get(sourceKey);
        const cohortId = assessmentCohortId(session);
        const cohortManaged = activeFailedCohorts.has(cohortId);
        const cohortAwake = cohortManaged && cohortWake.get(cohortId) === true;
        if (cohortManaged && !cohortAwake) continue;
        let previouslyCompletedMessages: SessionMessageView[] | undefined;
        if (previous?.verdict?.verdict === "completed"
          && previous.verdict.confidence > 0
          && evidenceIsCurrent(previous)
          && !durableAdmission?.recoveryCause
          && !durableAdmission?.acceptedAt
          && !durableAdmission?.deliveryPending) {
          const cached = cohortEvidence.get(sourceKey);
          previouslyCompletedMessages = cached?.messages
            ?? await sessionEvidenceMessages(adapter, session.id, runtimeSettings.evidenceMessageCount);
          const currentTranscriptTail = cached?.transcriptTail
            ?? completionEvidence(previouslyCompletedMessages, runtimeSettings.evidenceMessageCount);
          if (previouslyCompletedMessages.length === 0 || currentTranscriptTail === previous.transcriptTail) {
            const unchanged = await this.options.store.discardUnchangedNonaccepted(
              durableAdmission,
              session.harness,
              session.id,
              sessionWorkspaceIdentity(session),
              () => [...urgentSignalVersions].every(([key, assessedVersion]) =>
                (this.urgentSessionVersions.get(key) ?? 0) === assessedVersion),
            );
            if (!unchanged) continue;
            for (const [key, assessedVersion] of urgentSignalVersions) {
              if ((this.urgentSessionVersions.get(key) ?? 0) === assessedVersion) this.clearUrgentSession(key);
            }
            continue;
          }
        }
        const progressUnchanged = previous?.progressFingerprint === sessionInventoryProgressFingerprint(session);
        const metadataUnchanged = previous?.lastActivity === session.lastActivity
          && previous.status === session.status
          && (previous.workspaceIdentity || previous.cwd) === sessionWorkspaceIdentity(session)
          && previous.title === session.title;
        const settledAndUnchanged = metadataUnchanged && progressUnchanged && evidenceIsCurrent(previous)
          && previous?.verdict && previous.verdict.confidence > 0
          && (previous.verdict.verdict === "completed"
            || previous.verdict.verdict === "needs_human"
            || (previous.verdict.verdict === "unfinished"
              && (!autoResumeEnabled || session.status === "running")));
        if (!cohortAwake && settledAndUnchanged && !urgent) continue;
        const candidateDelayMs = this.candidateDelayOverrideMs
          ?? Math.max(this.discoveryIdleMs, unfinishedProbeDelayMs(session));
        const oldEnough = urgent || Date.now() - Date.parse(session.lastActivity) >= candidateDelayMs;
        if (!cohortAwake && ((session.status === "running" && !urgent) || !oldEnough)) continue;
        const cachedEvidence = cohortEvidence.get(sourceKey);
        const messages = admissionMessages ?? cachedEvidence?.messages ?? previouslyCompletedMessages
          ?? await sessionEvidenceMessages(adapter, session.id, runtimeSettings.evidenceMessageCount);
        const transcriptTail = admissionMessages
          ? completionEvidence(admissionMessages, runtimeSettings.evidenceMessageCount)
          : cachedEvidence?.transcriptTail
          ?? completionEvidence(messages, runtimeSettings.evidenceMessageCount);
        const unchanged = metadataUnchanged && progressUnchanged && evidenceIsCurrent(previous)
          && previous?.transcriptTail === transcriptTail;
        const actionable = urgent
          || !previous?.verdict
          || previous.verdict.confidence === 0
          || !unchanged
          || previous.verdict.verdict === "unfinished";
        const latestSemanticMessage = [...messages].reverse().find((message) =>
          (message.role === "user" || message.role === "assistant") && Boolean(message.text?.trim()));
        if (cohortAwake || actionable) assessed.push({
          adapter, session, sourceKey, autoResumeEnabled, urgentSignalVersions, transcriptTail,
          humanMessages: styleObservations(session, messages),
          ...(latestSemanticMessage ? {
            latestSemanticMessage: { role: latestSemanticMessage.role, text: latestSemanticMessage.text },
          } : {}),
          ...(admissionPhase === "terminal_observed" ? {
            acceptedTerminalRetryCount,
            ...(durableAdmission?.terminalReason ? { acceptedTerminalReason: durableAdmission.terminalReason } : {}),
          } : {}),
          ...(admissionTimedOut ? { acceptedAdmissionTimedOut: true } : {}),
        });
      }
      if (assessed.length > 0) {
        // Persist the refreshed native snapshot before the remote plan. A
        // failed/timeout plan must not leave a new or changed 48h source absent
        // from the authoritative inventory, nor preserve a stale verdict.
        await this.options.store.upsertInventoryBatch(assessed.map((candidate) => {
          const failure = priorInventory.get(candidate.sourceKey)?.assessmentFailure;
          return {
            ...inventoryFromAssessment(candidate),
            ...(failure ? { assessmentFailure: { ...failure } } : {}),
          };
        }));
        let plan: SessionBatchPlan;
        let plannedWindow: AssessedSession[];
        try {
          ({ plan, window: plannedWindow } = await this.planAssessedSessions(assessed));
        } catch (error) {
          if (!this.lifecycleActive(lifecycleEpoch)) return "idle";
          await this.recordAssessmentFailure(assessed, priorInventory, errorText(error));
          console.error(`[agent-herder] единый план ${plannerRouteLabel(errorText(error))} не построен; посессионный fallback запрещён: ${errorText(error)}`);
          return "blocked";
        }
        if (!this.lifecycleActive(lifecycleEpoch)) return "idle";
        // Sessions outside the planned window keep the refreshed snapshot
        // written above and stay verdict-free, so the next cycle assesses them.
        if (semanticAutopilot) await this.applyBatchPlan(plan, plannedWindow, lifecycleEpoch);
        else await this.recordBatchAudit(plan, plannedWindow);
        return "ready";
      }
      // Empty fresh inventory is not an unsafe planner failure. Persisted
      // turn.started records may still be recoverable by exact session ID even
      // when ZCode's cross-workspace task index is temporarily incomplete.
      if (assessed.length === 0) return "idle";
    }
    let judgements = 0;
    for (const { adapter, session } of candidates) {
      // SQLite transcript reads and JSON parsing are local, but a large
      // 48-hour inventory must still yield so the control-plane HTTP server
      // remains responsive throughout reconciliation.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (!this.lifecycleActive(lifecycleEpoch)) return "idle";
      if (!isAutocontinueInventoryHarness(session.harness)) continue;
      const harness = session.harness;
      const key = sessionSourceKey(session);
      const messages = await sessionEvidenceMessages(adapter, session.id, runtimeSettings.evidenceMessageCount);
      const transcriptTail = completionEvidence(messages ?? [], runtimeSettings.evidenceMessageCount);
      const previous = priorInventory.get(key);
      const unchanged = previous?.lastActivity === session.lastActivity
        && previous.progressFingerprint === sessionInventoryProgressFingerprint(session)
        && previous.transcriptTail === transcriptTail
        && evidenceIsCurrent(previous);
      // Session aliases and lifecycle exclusion are delivery controls, not
      // evidence that the original user's task reached its consumer result.
      let verdict = unchanged ? previous?.verdict : undefined;
      if (this.completedSessions.has(key) || this.completedSessions.has(sessionKey(harness, session.id))) {
        verdict = { verdict: "needs_human", reason: "Session is paused, deleted or explicitly forgotten; task completion is unverified", confidence: 1, judgedAt: new Date().toISOString() };
      } else if (!verdict && Date.now() - Date.parse(session.lastActivity) < this.discoveryIdleMs && session.status !== "running") {
        // Keep it visible in inventory, but do not classify a session which may
        // still be receiving events from another harness process.
      } else if (!verdict && transcriptTail && this.options.judge && judgements < this.maxJudgementsPerCycle) {
        judgements += 1;
        try {
          const judged = await this.options.judge.decide({ session, transcriptTail });
          verdict = { ...normalizeVerdict(judged), judgedAt: new Date().toISOString() };
        } catch (error) {
          console.error(`[agent-herder] MiniMax не классифицировал ${harness}:${session.id}: ${errorText(error)}`);
        }
      } else if (!verdict && !transcriptTail) {
        verdict = { verdict: "needs_human", reason: "Нет доступного хвоста диалога для безопасной классификации", confidence: 1, judgedAt: new Date().toISOString() };
      }
      if (!verdict && messages && (session.status === "running" || Date.now() - Date.parse(session.lastActivity) >= this.discoveryIdleMs)) {
        verdict = { ...heuristicVerdict(session, messages), judgedAt: new Date().toISOString() };
      }
      const inventory: UnfinishedSessionInventoryRecord = {
        harness,
        sessionId: session.id,
        cwd: session.cwd,
        workspaceIdentity: sessionWorkspaceIdentity(session),
        title: session.title,
        status: session.status,
        lastActivity: session.lastActivity,
        transcriptTail,
        evidenceVersion: CURRENT_EVIDENCE_VERSION,
        evidenceFingerprint: evidenceFingerprint(transcriptTail),
        progressFingerprint: sessionInventoryProgressFingerprint(session),
        observedAt: new Date().toISOString(),
        ...(verdict ? { verdict } : {}),
      };
      inventoryBatch.push(inventory);
      if (verdict?.verdict !== "unfinished") {
        if (verdict && !durableBySourceKey.get(key)?.recoveryCause) {
          await this.options.store.remove(harness, session.id, sessionWorkspaceIdentity(session));
        }
        known.delete(key);
        continue;
      }
      // Semantic unfinishedness is Autopilot's concern. Keep the verdict in
      // the read-only inventory, but never create a recovery record from it.
    }
    await this.options.store.upsertInventoryBatch(inventoryBatch);
    return "ready";
  }

  private async recordBatchAudit(plan: SessionBatchPlan, assessed: AssessedSession[]): Promise<void> {
    const byId = new Map(assessed.map((candidate) => [candidate.sourceKey, candidate]));
    plan = canonicalizePlanSourceKeys(plan, assessed);
    assertBatchPlanCoverage(plan, assessed);
    plan = enforcePlanWorkspaceBoundaries(plan, byId);
    const now = new Date();
    const records: UnfinishedSessionInventoryRecord[] = [];
    for (const group of plan.groups) {
      const verdict = {
        verdict: group.verdict,
        reason: group.reason,
        confidence: group.confidence,
        judgedAt: now.toISOString(),
      } satisfies SessionInventoryVerdict;
      for (const sourceKey of group.sourceSessionIds) records.push(inventoryFromAssessment(byId.get(sourceKey)!, verdict, now));
    }
    await this.options.store.upsertInventoryBatch(records);
  }

  private async applyBatchPlan(plan: SessionBatchPlan, assessed: AssessedSession[], lifecycleEpoch: number): Promise<void> {
    const runtimeSettings = await this.options.settingsStore.getSettings();
    if (!this.lifecycleActive(lifecycleEpoch)) return;
    const byId = new Map(assessed.map((candidate) => [candidate.sourceKey, candidate]));
    plan = canonicalizePlanSourceKeys(plan, assessed);
    assertBatchPlanCoverage(plan, assessed);
    plan = enforcePlanWorkspaceBoundaries(plan, byId);
    // A global backlog sweep must finish each native chat in place. Splitting
    // planner clusters prevents one primary session from absorbing and
    // disabling other ZCode chats which still have their own user-visible IDs.
    plan = {
      groups: plan.groups.flatMap((group) => group.sourceSessionIds.map((sourceSessionId) => ({
        ...group,
        sourceSessionIds: [sourceSessionId],
        primarySessionId: sourceSessionId,
      }))),
    };
    const latestActivity = (group: SessionBatchPlanGroup): number => Math.max(...group.sourceSessionIds.map((id) => Date.parse(byId.get(id)!.session.lastActivity)));
    const groups = [...plan.groups].sort((left, right) => latestActivity(right) - latestActivity(left));
    const inventoryBatch: UnfinishedSessionInventoryRecord[] = [];
    let launched = 0;
    for (const group of groups) {
      if (!this.lifecycleActive(lifecycleEpoch)) return;
      const sources = group.sourceSessionIds.map((id) => byId.get(id)!);
      // A plan may combine sessions; every source keeps its own authority.
      // Holding one source must not move its work into an admitted neighbor.
      let admissionHeld = false;
      for (const source of sources) {
        if (!await this.admissionAllowed(source.session, "attempt")) { admissionHeld = true; break; }
      }
      if (!this.lifecycleActive(lifecycleEpoch)) return;
      if (admissionHeld) {
        // A plan that produced a verdict but whose group the admission gate
        // refused must never look like a success. The record stays untouched so
        // the next cycle assesses it again, but the drop is named: a gate that
        // refuses everything otherwise silences the whole planner with no trace.
        console.error(`[agent-herder] единый план построен, но допуск отклонил группу из ${sources.length} сесс. (${sources[0]!.session.harness}); вердикт не применён, сессии ждут следующего цикла`);
        continue;
      }
      let humanStoppedSource = false;
      for (const source of sources) {
        if (await this.suppressIfHumanStopped(source.session.harness, source.session.id, sessionWorkspaceIdentity(source.session), source.session)) {
          humanStoppedSource = true;
        }
      }
      if (humanStoppedSource) continue;
      const plannedPrimary = byId.get(group.primarySessionId)!;
      const humanGatedSources = sources.filter(({ session }) => session.status === "needs_input" || session.needsPermission);
      const exhaustedAcceptedSources = group.verdict === "unfinished"
        ? sources.filter(({ acceptedTerminalRetryCount }) => (acceptedTerminalRetryCount ?? -1) >= 1)
        : [];
      const resumableSources = sources.filter((candidate) => candidate.autoResumeEnabled
        && !humanGatedSources.includes(candidate));
      const running = resumableSources.filter(({ session, sourceKey }) => session.status === "running"
          && !this.urgentSessions.has(sourceKey))
        .sort((left, right) => Date.parse(right.session.lastActivity) - Date.parse(left.session.lastActivity))[0];
      const primary = running
        ?? (plannedPrimary.autoResumeEnabled ? plannedPrimary : undefined)
        ?? [...resumableSources].sort((left, right) => Date.parse(right.session.lastActivity) - Date.parse(left.session.lastActivity))[0]
        ?? plannedPrimary;
      const judgedAt = new Date().toISOString();
      const verdict = { verdict: group.verdict, reason: group.reason, confidence: group.confidence, judgedAt } satisfies SessionInventoryVerdict;
      const pushInventory = (candidate: AssessedSession, override = verdict): void => {
        inventoryBatch.push(inventoryFromAssessment(candidate, override));
      };

      const timedOutAcceptedSources = sources.filter(({ acceptedAdmissionTimedOut }) => acceptedAdmissionTimedOut);
      if (timedOutAcceptedSources.length > 0) {
        const timeoutVerdict = {
          verdict: "needs_human",
          reason: "Сессия не подтвердила завершение принятого запроса до установленного срока. Повторная отправка остановлена.",
          confidence: 1,
          judgedAt,
        } satisfies SessionInventoryVerdict;
        for (const source of sources) {
          pushInventory(source, timeoutVerdict);
          this.clearUrgentSession(source.sourceKey);
          await this.options.store.remove(source.session.harness, source.session.id, sessionWorkspaceIdentity(source.session));
        }
        if (this.options.notify) {
          const correlation = createHash("sha256").update(sources.map(({ sourceKey }) => sourceKey).sort().join("\n")).digest("hex").slice(0, 24);
          await this.options.notify({
            title: "Agent Herder не получил завершение принятого запроса",
            body: "Харнес принял продолжение, но не подтвердил завершение до безопасного срока. Повторная отправка не выполнялась; откройте закреплённую сессию и проверьте её состояние.",
            dedupKey: `agent-herder:accepted-timeout:${correlation}`,
            correlationId: `accepted-timeout-${correlation}`,
            sourceId: "agent-herder-autocontinue-admission",
            signalType: "accepted-admission-timeout",
          });
        }
        continue;
      }

      if (exhaustedAcceptedSources.length > 0) {
        const exhaustedVerdict = {
          verdict: "needs_human",
          reason: "Сессия дважды завершила запрос без ответа на задачу. Автоматическая повторная отправка остановлена.",
          confidence: 1,
          judgedAt,
        } satisfies SessionInventoryVerdict;
        for (const source of sources) {
          pushInventory(source, exhaustedVerdict);
          this.clearUrgentSession(source.sourceKey);
          await this.options.store.remove(source.session.harness, source.session.id, sessionWorkspaceIdentity(source.session));
        }
        if (this.options.notify) {
          const correlation = createHash("sha256").update(sources.map(({ sourceKey }) => sourceKey).sort().join("\n")).digest("hex").slice(0, 24);
          await this.options.notify({
            title: "Agent Herder остановил повторную отправку",
            body: "Сессия дважды завершила запрос без ответа на задачу. Нужна проверка человеком; откройте закреплённую сессию и проверьте причину ошибки.",
            dedupKey: `agent-herder:accepted-terminal-exhausted:${correlation}`,
            correlationId: `accepted-terminal-${correlation}`,
            sourceId: "agent-herder-autocontinue-admission",
            signalType: "accepted-admission-exhausted",
          });
        }
        continue;
      }

      // A semantic planner cannot answer a native input/permission request on
      // the user's behalf. Keep the whole task group stopped and make the gate
      // explicit in inventory; a later transcript/status change will cause a
      // fresh audit and can then make the group eligible again.
      if (humanGatedSources.length > 0) {
        const humanGateVerdict = {
          verdict: "needs_human",
          reason: "Объединённая задача ожидает ответа или разрешения человека",
          confidence: 1,
          judgedAt,
        } satisfies SessionInventoryVerdict;
        for (const source of sources) {
          pushInventory(source, humanGateVerdict);
          this.clearUrgentSession(source.sourceKey);
          await this.options.store.remove(source.session.harness, source.session.id, sessionWorkspaceIdentity(source.session));
        }
        continue;
      }

      // Workspace splits and missing handoffs use needs_human/confidence=0 as
      // an inconclusive result, not a terminal human blocker. Preserve the
      // record for the next batch without inventing a continuation.
      if (group.verdict === "needs_human" && group.confidence === 0) {
        for (const source of sources) {
          pushInventory(source);
          if (source.autoResumeEnabled) {
            await this.options.store.markStarted(source.session, `judge-retry-${this.generationId}`);
            this.continuedThisRecovery.add(source.sourceKey);
          }
        }
        continue;
      }

      if (group.verdict !== "unfinished") {
        for (const source of sources) {
          pushInventory(source);
          this.clearUrgentSession(source.sourceKey);
          await this.options.store.remove(source.session.harness, source.session.id, sessionWorkspaceIdentity(source.session));
        }
        continue;
      }

      // A session-level opt-out disables autonomous continuation only. Its
      // evidence is still audited and refreshed above, but no prompt may be
      // delivered unless this group has an explicitly resumable source.
      if (resumableSources.length === 0) {
        for (const source of sources) {
          pushInventory(source);
          this.clearUrgentSession(source.sourceKey);
          await this.options.store.remove(source.session.harness, source.session.id, sessionWorkspaceIdentity(source.session));
        }
        continue;
      }

      // A queued Herder prompt is already durable in the native transcript.
      // Until the harness produces an assistant message after it, another
      // resume cycle must not enqueue a near-identical prompt again.
      const boundedAcceptedReadmission = sources.some(({ acceptedTerminalRetryCount }) => acceptedTerminalRetryCount === 0);
      if (!boundedAcceptedReadmission
        && primary.latestSemanticMessage?.role === "user"
        && isAutocontinueRequest(primary.latestSemanticMessage.text)) {
        await this.options.store.markStarted(primary.session, this.generationId);
        this.continuedThisRecovery.add(primary.sourceKey);
        for (const source of sources) {
          pushInventory(source);
          this.clearUrgentSession(source.sourceKey);
        }
        console.error(`[agent-herder] ${primary.session.harness}:${primary.session.id} уже ожидает ответ на автопродолжение; повтор не ставлю`);
        continue;
      }

      const handoff = batchContinuationPrompt(group, sources);
      if (running) {
        if (await this.suppressIfHumanStopped(running.session.harness, running.session.id, sessionWorkspaceIdentity(running.session), running.session)) continue;
        if (!this.lifecycleActive(lifecycleEpoch)) return;
        await this.pinActiveSession(running.adapter, running.session.id, runtimeSettings);
        if (!this.lifecycleActive(lifecycleEpoch)) return;
        if (sources.length > 1) {
          const inbox = this.options.deferredStore ?? deferredMessages;
          const pending = await inbox.list(running.session.id);
          if (!this.lifecycleActive(lifecycleEpoch)) return;
          if (await this.suppressIfHumanStopped(running.session.harness, running.session.id, sessionWorkspaceIdentity(running.session))) continue;
          if (!pending.some((message) => isAutocontinueRequest(message.message))) {
            if (!await this.groupAdmissionAllowed(sources.map((source) => source.session), "send")) continue;
            if (!this.lifecycleActive(lifecycleEpoch)) return;
            await inbox.add(running.session.id, handoff);
          }
          if (!this.lifecycleActive(lifecycleEpoch)) return;
        }
        if (await this.suppressIfHumanStopped(running.session.harness, running.session.id, sessionWorkspaceIdentity(running.session))) continue;
        await this.options.store.markStarted(running.session, this.generationId);
        for (const source of sources) {
          if (source.sourceKey === running.sourceKey) pushInventory(source);
          else {
            pushInventory(source, {
              verdict: "completed",
              reason: `Объединена с работающей сессией «${group.topic}»: ${running.session.id}`,
              confidence: group.confidence,
              judgedAt,
            });
            await this.options.settingsStore.setSession({ harness: source.session.harness, sessionId: source.session.id, cwd: source.session.cwd }, false);
            await this.options.store.remove(source.session.harness, source.session.id, sessionWorkspaceIdentity(source.session));
          }
        }
        continue;
      }

      const groupUrgent = sources.some(({ sourceKey, session }) => this.urgentSessions.has(sourceKey)
        || this.urgentSessions.has(sessionKey(session.harness, session.id)));
      const oldEnough = groupUrgent || Date.now() - Date.parse(primary.session.lastActivity) >= this.discoveryIdleMs;
      if (!oldEnough || launched >= this.maxResumesPerCycle) {
        for (const source of sources) {
          pushInventory(source);
          await this.options.store.remove(source.session.harness, source.session.id, sessionWorkspaceIdentity(source.session));
        }
        continue;
      }

      const cache = cacheWindowFor(primary.session);
      const cacheAgeMs = Math.max(0, Date.now() - Date.parse(primary.session.lastActivity));
      const reuseExisting = !runtimeSettings.rolloverExpiredCache || !cache.ttlMs || cacheAgeMs < cache.ttlMs;
      if (reuseExisting && primary.adapter.resumeSession) {
        launched += 1;
        try {
          if (!this.lifecycleActive(lifecycleEpoch)) return;
          if (await this.suppressIfHumanStopped(primary.session.harness, primary.session.id, sessionWorkspaceIdentity(primary.session))) {
            launched = Math.max(0, launched - 1);
            continue;
          }
          if (!await this.groupAdmissionAllowed(sources.map((source) => source.session), "resume")) { launched -= 1; continue; }
          if (!this.lifecycleActive(lifecycleEpoch)) return;
          const resumed = await primary.adapter.resumeSession(primary.session.id);
          if (!resumed.ok) throw new Error(resumed.error || "возобновление исходной сессии отклонено");
          if (!this.lifecycleActive(lifecycleEpoch)) return;
          await this.pinActiveSession(primary.adapter, primary.session.id, runtimeSettings);
          if (!this.lifecycleActive(lifecycleEpoch)) return;
          if (await this.suppressIfHumanStopped(primary.session.harness, primary.session.id, sessionWorkspaceIdentity(primary.session))) {
            launched = Math.max(0, launched - 1);
            continue;
          }
          if (!await this.groupAdmissionAllowed(sources.map((source) => source.session), "send")) { launched -= 1; continue; }
          if (!this.lifecycleActive(lifecycleEpoch)) return;
          const sent = await primary.adapter.sendMessage(primary.session.id, { message: handoff, queue: true });
          const terminalAdmission = admittedNonRetryableFailure(sent);
          if (terminalAdmission) {
            await this.options.store.markStarted(primary.session, this.generationId, new Date(), true, true, false, terminalAdmission);
            this.continuedThisRecovery.add(primary.sourceKey);
            this.clearUrgentSession(primary.sourceKey);
            for (const source of sources) pushInventory(source);
            console.error(`[agent-herder] единый plan prompt принят ${primary.session.harness}:${primary.session.id}, но native turn failed без безопасного retry: ${terminalAdmission}`);
            continue;
          }
          if (!sent.ok) throw new Error(sent.error || "исходная сессия не приняла объединённый handoff");
          if (!this.lifecycleActive(lifecycleEpoch)) return;
          await this.options.store.markStarted(primary.session, this.generationId, new Date(), true, true, sent.pending === true);
          this.continuedThisRecovery.add(primary.sourceKey);
          this.clearUrgentSession(primary.sourceKey);
          for (const source of sources) {
            this.clearUrgentSession(source.sourceKey);
            if (source.sourceKey === primary.sourceKey) pushInventory(source);
            else {
              pushInventory(source, {
                verdict: "completed",
                reason: `Объединена с возобновлённой сессией «${group.topic}»: ${primary.session.id}`,
                confidence: group.confidence,
                judgedAt,
              });
              await this.options.settingsStore.setSession({ harness: source.session.harness, sessionId: source.session.id, cwd: source.session.cwd }, false);
              await this.options.store.remove(source.session.harness, source.session.id, sessionWorkspaceIdentity(source.session));
            }
          }
          console.error(`[agent-herder] единый план возобновил ${sources.length} сесс. в ${primary.session.harness}:${primary.session.id} «${continuationTitle(group.topic)}»`);
          continue;
        } catch (error) {
          launched = Math.max(0, launched - 1);
          const failure = errorText(error);
          if (isBusyCodexWriter(primary.session.harness, failure)) {
            if (!this.lifecycleActive(lifecycleEpoch)) return;
            const inbox = this.options.deferredStore ?? deferredMessages;
            const pending = await inbox.list(primary.session.id);
            if (!this.lifecycleActive(lifecycleEpoch)) return;
            if (!pending.some((message) => isAutocontinueRequest(message.message))) await inbox.add(primary.session.id, handoff);
            await this.options.store.markStarted(primary.session, this.generationId, new Date(), false, true, true);
            this.continuedThisRecovery.add(primary.sourceKey);
            for (const source of sources) pushInventory(source);
            console.error(`[agent-herder] единый план Codex отложен до безопасной границы хода ${primary.session.id}`);
            continue;
          }
          // A fresh cache window (or an explicit rollover opt-out) promises
          // same-ID continuation. A transient attach/send failure must remain
          // retryable on that session instead of silently creating a fork.
          await this.options.store.markStarted(primary.session, this.generationId);
          this.continuedThisRecovery.add(primary.sourceKey);
          for (const source of sources) pushInventory(source);
          console.error(`[agent-herder] исходная сессия ${primary.session.harness}:${primary.session.id} не возобновилась; новая сессия до TTL не создаётся: ${failure}`);
          continue;
        }
      }

      // With rollover disabled (or while the provider cache is still fresh),
      // keeping the same native session is the contract. Missing resume
      // support must not silently turn into a replacement session.
      if (reuseExisting) {
        for (const source of sources) {
          pushInventory(source);
          await this.options.store.markStarted(source.session, this.generationId);
        }
        continue;
      }

      if (!primary.adapter.createSession) {
        for (const source of sources) {
          pushInventory(source);
          await this.options.store.remove(source.session.harness, source.session.id, sessionWorkspaceIdentity(source.session));
        }
        continue;
      }

      try {
        launched += 1;
        const continuationModel = continuationModelFor(primary.session);
        if (!this.lifecycleActive(lifecycleEpoch)) return;
        if (await this.suppressIfHumanStopped(primary.session.harness, primary.session.id, sessionWorkspaceIdentity(primary.session))) {
          launched = Math.max(0, launched - 1);
          continue;
        }
        if (!await this.groupAdmissionAllowed(sources.map((source) => source.session), "create")) { launched -= 1; continue; }
        if (!this.lifecycleActive(lifecycleEpoch)) return;
        // The owner-level automation lever: the launcher starts new work on
        // its own, so it is refused while the owner forbade automation.
        const disarm = await automationDisarmDecision(
          AutomationDisarmStore.forRuntime(),
          [sessionWorkKey(primary.adapter.type, continuationTitle(group.topic), primary.session.cwd)],
          "automation",
        );
        if (!disarm.allowed) {
          launched = Math.max(0, launched - 1);
          for (const source of sources) pushInventory(source);
          console.error(`[agent-herder] автоматический запуск запрещён владельцем: ${disarm.reason ?? ""}`);
          continue;
        }
        const created = await primary.adapter.createSession({
          name: continuationTitle(group.topic),
          cwd: primary.session.cwd,
          model: continuationModel,
          fullAccess: true,
        });
        if (!this.lifecycleActive(lifecycleEpoch)) return;
        if (!runtimeSettings.movePinnedOnRollover) await this.pinActiveSession(primary.adapter, created.id, runtimeSettings);
        if (!this.lifecycleActive(lifecycleEpoch)) return;
        if (continuationModel && created.model !== continuationModel && primary.adapter.changeModel) {
          const selected = await primary.adapter.changeModel(created.id, continuationModel);
          if (!selected.ok) throw new Error(selected.error || `не удалось выбрать модель ${continuationModel}`);
          if (!this.lifecycleActive(lifecycleEpoch)) return;
        }
        if (await this.suppressIfHumanStopped(primary.session.harness, primary.session.id, sessionWorkspaceIdentity(primary.session))) {
          launched = Math.max(0, launched - 1);
          continue;
        }
        if (!await this.groupAdmissionAllowed(sources.map((source) => source.session), "send")) {
          // The newly created native identity remains owned and visible, but
          // no handoff is sent while its source authority is held.
          await this.options.settingsStore.setSession({ harness: created.harness, sessionId: created.id, cwd: created.cwd }, false);
          launched -= 1;
          continue;
        }
        if (!this.lifecycleActive(lifecycleEpoch)) return;
        const sent = await primary.adapter.sendMessage(created.id, { message: handoff, queue: true });
        const terminalAdmission = admittedNonRetryableFailure(sent);
        if (terminalAdmission) {
          await this.options.store.markStarted(created, this.generationId, new Date(), true, true, false, terminalAdmission);
          this.continuedThisRecovery.add(sessionSourceKey(created));
          for (const source of sources) {
            this.clearUrgentSession(source.sourceKey);
            pushInventory(source, {
              verdict: "needs_human",
              reason: `Передана в новую сессию ${created.id}; native turn failed после admission без безопасного retry`,
              confidence: 1,
              judgedAt,
            });
            await this.options.settingsStore.setSession({ harness: source.session.harness, sessionId: source.session.id, cwd: source.session.cwd }, false);
            await this.options.store.remove(source.session.harness, source.session.id, sessionWorkspaceIdentity(source.session));
          }
          console.error(`[agent-herder] новая сессия ${created.harness}:${created.id} приняла handoff, но native turn failed без безопасного retry: ${terminalAdmission}`);
          continue;
        }
        if (!sent.ok) throw new Error(sent.error || "новая объединённая сессия не приняла handoff");
        if (!this.lifecycleActive(lifecycleEpoch)) return;
        if (runtimeSettings.movePinnedOnRollover) {
          await movePinnedContinuation(primary.adapter, sources.map((source) => ({
            adapter: source.adapter,
            sessionId: source.session.id,
          })), created.id);
          if (!this.lifecycleActive(lifecycleEpoch)) return;
        }
        await this.options.store.markStarted(created, this.generationId, new Date(), true, true, sent.pending === true);
        this.continuedThisRecovery.add(sessionSourceKey(created));
        for (const source of sources) {
          this.clearUrgentSession(source.sourceKey);
          pushInventory(source, {
            verdict: "completed",
            reason: `Объединена в новую сессию «${continuationTitle(group.topic)}»: ${created.id}`,
            confidence: group.confidence,
            judgedAt,
          });
          await this.options.settingsStore.setSession({ harness: source.session.harness, sessionId: source.session.id, cwd: source.session.cwd }, false);
          await this.options.store.remove(source.session.harness, source.session.id, sessionWorkspaceIdentity(source.session));
        }
        console.error(`[agent-herder] единый план продолжил ${sources.length} сесс. как ${created.harness}:${created.id} «${continuationTitle(group.topic)}»`);
      } catch (error) {
        launched = Math.max(0, launched - 1);
        console.error(`[agent-herder] единый план не запустил «${group.topic}»: ${errorText(error)}`);
        for (const source of sources) {
          pushInventory(source);
          await this.options.store.remove(source.session.harness, source.session.id, sessionWorkspaceIdentity(source.session));
        }
      }
    }
    if (this.lifecycleActive(lifecycleEpoch)) await this.options.store.upsertInventoryBatch(inventoryBatch);
  }

  private async semanticAutopilotPolicy(): Promise<EffectivePolicy | null> {
    if (!this.options.judge?.plan || !this.options.autopilotPolicyStore) return null;
    const effective = await this.options.autopilotPolicyStore.readEffective();
    if (effective.source === "error" || !effective.policy.enabled) return null;
    return effective.policy.harnesses.some((harness) => harness === "codex" || harness === "zcode")
      ? effective
      : null;
  }

  private async semanticAutopilotAllows(session: AgentSession, effective: EffectivePolicy): Promise<boolean> {
    if (session.harness !== "codex" && session.harness !== "zcode") return false;
    if (!effective.policy.enabled) return false;
    const override = await this.options.autopilotSessionStore?.get(session.harness, session.id);
    if (override?.enabled !== undefined) return override.enabled;
    return effectivePolicyAllowsTarget(effective, {
      harness: session.harness,
      sessionId: session.id,
      cwd: session.cwd,
    });
  }

  /**
   * One cycle plans a bounded priority window instead of refusing the whole
   * inventory. Candidates arrive in priority order, and a backlog wider than
   * the chunk budget or the shared serialized context ceiling is a capacity
   * fact, not a semantic failure: refusing it stranded every session behind a
   * growing assessment backoff and left none of them planned. The window keeps
   * the unified planner, the workspace-homogeneous chunking and the reserved
   * repair/omission envelope exactly as they were; only the amount of work per
   * cycle is bounded. Sessions outside the window keep their refreshed native
   * snapshot without a verdict, so the next cycle assesses them again.
   */
  private boundedBatchPlanWindow(
    assessed: AssessedSession[],
    contextBudget: number,
    outputTokenBudget: number,
  ): AssessedSession[] {
    const chunkSize = batchPlanChunkSize(outputTokenBudget);
    const maxChunks = this.batchPlanChunkBudget();
    const fits = (candidates: AssessedSession[]): boolean => {
      if (partitionBatchCandidates(candidates, chunkSize).length > maxChunks) return false;
      const metadataOnly = candidates.map(({ session, transcriptTail, humanMessages }) => ({ session, transcriptTail: "", humanMessages }));
      try {
        // Measure the exact envelope the real fit below reserves, including the
        // repair, omission and reconciliation passes. Measuring only the first
        // pass understates the wire budget and lets an oversized window through.
        const { estimatedTokens } = fitBatchContextForSerializedRequest(
          metadataOnly,
          contextBudget,
          (sessions) => batchPlannerBudgetRequests(sessions, chunkSize, outputTokenBudget),
        );
        return estimatedTokens <= contextBudget;
      } catch {
        // Even with no evidence left the envelope does not fit, and a longer
        // window only grows it.
        return false;
      }
    };
    if (fits(assessed)) return assessed;
    // Both measures only grow with more candidates, so the longest fitting
    // prefix is found without serializing the whole inventory at every step.
    let low = 0;
    let high = assessed.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(assessed.slice(0, middle))) low = middle;
      else high = middle - 1;
    }
    const single = assessed[0]!;
    if (low === 0) {
      // Not a backlog problem: one session's own metadata does not fit. Keep
      // the honest refusal so it is recorded and retried instead of planned blind.
      throw new BatchPlanValidationError(`MiniMax batch metadata for a single session ${single.sourceKey} exceeds the ${contextBudget} token ceiling`);
    }
    console.error(`[agent-herder] очередь оценки шире окна планировщика: ${assessed.length} сесс., в этом цикле планируются первые ${low}`);
    return assessed.slice(0, low);
  }

  /**
   * Chunks one planning phase may request. The reserved wire-input budget only
   * bounds size; a phase is also bounded by wall clock, and every chunk is one
   * sequential provider round at the configured concurrency. A window that fits
   * the tokens can still overrun the phase deadline — the live cycle planned 60
   * chunks, ran past ten minutes, and never applied a single verdict, because
   * the inventory is only written when the whole phase finishes. Rounds keep a
   * cycle short enough to finish, apply and be seen, and the rest of the
   * priority-ordered backlog is assessed on the following cycles.
   */
  private batchPlanChunkBudget(): number {
    const concurrency = Math.min(DEFAULT_BATCH_PLAN_CONCURRENCY, positiveInteger(
      Number(process.env.AGENT_HERDER_UNFINISHED_BATCH_CONCURRENCY || DEFAULT_BATCH_PLAN_CONCURRENCY),
      DEFAULT_BATCH_PLAN_CONCURRENCY,
    ));
    return Math.min(MAX_BATCH_PLAN_CHUNKS, concurrency * MAX_BATCH_PLAN_ROUNDS);
  }

  private async planAssessedSessions(assessed: AssessedSession[]): Promise<{ plan: SessionBatchPlan; window: AssessedSession[] }> {
    const planner = this.options.judge?.plan;
    if (!planner) throw new Error("MiniMax batch planner is unavailable");
    const contextBudget = Math.min(
      positiveInteger(
        Number(process.env.AGENT_HERDER_UNFINISHED_BATCH_CONTEXT_TOKENS || DEFAULT_BATCH_CONTEXT_TOKEN_BUDGET),
        DEFAULT_BATCH_CONTEXT_TOKEN_BUDGET,
      ),
      DEFAULT_BATCH_CONTEXT_TOKEN_BUDGET,
    );
    const outputTokenBudget = configuredBatchOutputTokens();
    const window = this.boundedBatchPlanWindow(assessed, contextBudget, outputTokenBudget);
    const rawCandidates = window.map(({ session, transcriptTail, humanMessages }) => ({ session, transcriptTail, humanMessages }));
    const globallyPacked = fitBatchContextForSerializedRequest(
      rawCandidates,
      contextBudget,
      (sessions) => batchPlannerBudgetRequests(sessions, batchPlanChunkSize(outputTokenBudget), outputTokenBudget),
    ).sessions;
    const packedAssessed = window.map((candidate, index) => ({
      ...candidate,
      transcriptTail: globallyPacked[index]!.transcriptTail,
    }));
    const plannerPhaseController = new AbortController();
    const plannerPhaseDeadline = Date.now() + positiveInteger(
      Number(process.env.AGENT_HERDER_UNFINISHED_BATCH_TIMEOUT_MS || 600_000),
      600_000,
    );
    this.activePlannerController = plannerPhaseController;
    try {
    const plannerChunks = partitionBatchCandidates(packedAssessed, batchPlanChunkSize(outputTokenBudget));
    const plannerConcurrency = Math.min(DEFAULT_BATCH_PLAN_CONCURRENCY, positiveInteger(
      Number(process.env.AGENT_HERDER_UNFINISHED_BATCH_CONCURRENCY || DEFAULT_BATCH_PLAN_CONCURRENCY),
      DEFAULT_BATCH_PLAN_CONCURRENCY,
    ));
    const requestPlan = async (candidates: AssessedSession[]): Promise<SessionBatchPlan> => canonicalizePlanSourceKeys(
        await withAbortDeadline(planner({
          sessions: candidates.map(({ session, transcriptTail, humanMessages }) => ({ session, transcriptTail, humanMessages })),
          signal: plannerPhaseController.signal,
        }), plannerPhaseDeadline, plannerPhaseController),
        candidates,
      );
    let phaseOne: Array<{ plan?: SessionBatchPlan; validationError?: BatchPlanValidationError }>;
    try {
      phaseOne = await mapConcurrentOrdered(
        plannerChunks,
        plannerConcurrency,
        async (chunk) => {
          // A transport blip (ETIMEDOUT, reset, 429, 5xx) says nothing about the
          // cohort's safety, so retry the whole chunk once here. Without this the
          // first timeout aborts plannerPhaseController, silences the sibling
          // chunks and fails every assessed session for a one-off network error.
          const requestChunk = async (): Promise<SessionBatchPlan> => {
            const plan = await requestPlan(chunk);
            assertBatchPlanCoverage(plan, chunk);
            return plan;
          };
          try {
            return { plan: await requestChunk() };
          } catch (error) {
            if (error instanceof BatchPlanValidationError) return { validationError: error };
            if (!isTransientPlannerFailure(error)) throw error;
            // A dead keep-alive connection fails again inside the same window, so an
            // immediate repeat spends the only safe retry and still aborts the phase.
            // Space one bounded retry instead; planning stays read-only, the phase
            // deadline still bounds the wait, and no session action is repeated.
            await transientPlannerRetryDelay(this.plannerTransportRetryDelayMs, plannerPhaseDeadline, plannerPhaseController);
            console.error(`[agent-herder] транспорт планировщика упал на chunk; повторяю chunk целиком один раз: ${errorText(error)}`);
            return { plan: await requestChunk() };
          }
        },
        plannerPhaseController,
      );
    } catch (error) {
      plannerPhaseController.abort(error);
      throw error;
    }
    const invalidChunkIndices = phaseOne.flatMap((result, index) => result.validationError ? [index] : []);
    if (invalidChunkIndices.length > MAX_REPAIRED_CHUNKS) {
      throw new BatchPlanValidationError(`MiniMax returned ${invalidChunkIndices.length} invalid chunks, above the safe repair limit ${MAX_REPAIRED_CHUNKS}`);
    }
    let repairedChunks: Array<{ index: number; plan: SessionBatchPlan; omissions: AssessedSession[] }> = [];
    if (invalidChunkIndices.length > 0) {
      try {
        repairedChunks = await mapConcurrentOrdered(
          invalidChunkIndices,
          plannerConcurrency,
          async (index) => {
            const chunk = plannerChunks[index]!;
            console.error(`[agent-herder] MiniMax вернул некорректный chunk; повторяю весь chunk один раз: ${errorText(phaseOne[index]!.validationError)}`);
            const plan = await requestPlan(chunk);
            const omissions = missingBatchPlanCandidates(plan, chunk);
            return { index, plan, omissions };
          },
          plannerPhaseController,
        );
      } catch (error) {
        plannerPhaseController.abort(error);
        throw error;
      }
    }
    const repairsByIndex = new Map(repairedChunks.map((result) => [result.index, result]));
    const chunkResults = phaseOne.map((result, index) => {
      const repairedChunk = repairsByIndex.get(index);
      if (repairedChunk) return { groups: repairedChunk.plan.groups, omissions: repairedChunk.omissions };
      return { groups: result.plan!.groups, omissions: [] as AssessedSession[] };
    });
    const groups = chunkResults.flatMap((result) => result.groups);
    const persistentOmissions = chunkResults.flatMap((result) => result.omissions);
    if (persistentOmissions.length > MAX_PERSISTENT_OMISSION_DECISIONS) {
      throw new BatchPlanValidationError(`MiniMax full retries omitted ${persistentOmissions.length} sessions, above the safe fallback limit ${MAX_PERSISTENT_OMISSION_DECISIONS}`);
    }
    if (persistentOmissions.length > 0) {
      const decide = this.options.judge?.decide;
      if (!decide) throw new Error("MiniMax per-session omission judge is unavailable");
      let decisions: Array<{ candidate: AssessedSession; verdict: Omit<SessionInventoryVerdict, "judgedAt">; handoff: string }> = [];
      try {
        decisions = await withAbortDeadline(mapConcurrentOrdered(
          persistentOmissions,
          MAX_OMISSION_DECISION_CONCURRENCY,
          async (candidate) => {
            if (plannerPhaseController.signal.aborted) throw new Error("MiniMax omission decision phase was aborted");
            const verdict = normalizeVerdict(await decide({
              session: candidate.session,
              transcriptTail: candidate.transcriptTail,
              signal: plannerPhaseController.signal,
            }));
            if (verdict.confidence <= 0) throw new Error(`MiniMax omission judge returned zero confidence for ${candidate.sourceKey}`);
            const handoff = verdict.verdict === "unfinished"
              ? trimEvidenceChars(candidate.transcriptTail, 32_000)
              : "";
            if (verdict.verdict === "unfinished" && !handoff.trim()) {
              throw new Error(`MiniMax omission judge returned unfinished without evidence for ${candidate.sourceKey}`);
            }
            return { candidate, verdict, handoff };
          },
          plannerPhaseController,
        ), plannerPhaseDeadline, plannerPhaseController);
      } catch (error) {
        plannerPhaseController.abort(error);
        throw error;
      }
      for (const { candidate, verdict, handoff } of decisions) {
        groups.push({
          sourceSessionIds: [candidate.sourceKey],
          primarySessionId: candidate.sourceKey,
          ...verdict,
          topic: candidate.session.title.slice(0, 120) || "Неопределённая задача",
          handoff,
        });
      }
    }
    let plan = { groups };
    assertBatchPlanCoverage(plan, packedAssessed);
    const bySourceKey = new Map(packedAssessed.map((candidate) => [candidate.sourceKey, candidate]));
    const workspaceOrder = [...new Set(packedAssessed.map(({ session }) => sessionWorkspaceIdentity(session)))];
    const chunkCountByWorkspace = new Map<string, number>();
    for (const chunk of plannerChunks) {
      const workspace = sessionWorkspaceIdentity(chunk[0]!.session);
      chunkCountByWorkspace.set(workspace, (chunkCountByWorkspace.get(workspace) || 0) + 1);
    }
    const repairedWorkspaces = new Set(invalidChunkIndices.map((index) => sessionWorkspaceIdentity(plannerChunks[index]![0]!.session)));
    const omissionWorkspaces = new Set(persistentOmissions.map(({ session }) => sessionWorkspaceIdentity(session)));
    const groupsByWorkspace = new Map(workspaceOrder.map((workspace) => [workspace, [] as SessionBatchPlanGroup[]]));
    for (const group of plan.groups) {
      const workspaces = new Set(group.sourceSessionIds.map((sourceKey) => sessionWorkspaceIdentity(bySourceKey.get(sourceKey)!.session)));
      if (workspaces.size !== 1) throw new Error("MiniMax planner group crossed workspace before reconciliation");
      groupsByWorkspace.get([...workspaces][0]!)!.push(group);
    }
    const reconciliationWorkspaces = workspaceOrder.filter((workspace) => (chunkCountByWorkspace.get(workspace) || 0) > 1
      || repairedWorkspaces.has(workspace)
      || omissionWorkspaces.has(workspace));
    if (reconciliationWorkspaces.length > 0) {
      const reconcile = this.options.judge?.reconcile;
      if (!reconcile) throw new Error("MiniMax workspace reconciliation is unavailable");
      let reconciledWorkspaces: SessionBatchPlan[];
      try {
        reconciledWorkspaces = await mapConcurrentOrdered(
          reconciliationWorkspaces,
          plannerConcurrency,
          async (workspace) => {
            const candidates = packedAssessed.filter(({ session }) => sessionWorkspaceIdentity(session) === workspace);
            const unreconciledPlan = { groups: groupsByWorkspace.get(workspace)! };
            const summaries = batchReconciliationCandidates(unreconciledPlan, candidates);
            const requestReconciliation = async (): Promise<SessionBatchPlan> => {
              const reconciliation = await withAbortDeadline(reconcile({
                groups: summaries,
                signal: plannerPhaseController.signal,
              }), plannerPhaseDeadline, plannerPhaseController);
              try {
                const reconciled = applyBatchReconciliation(unreconciledPlan, summaries, reconciliation);
                assertBatchPlanCoverage(reconciled, candidates);
                return reconciled;
              } catch (error) {
                if (error instanceof BatchReconciliationValidationError) throw error;
                throw new BatchReconciliationValidationError(errorText(error));
              }
            };
            try {
              return await requestReconciliation();
            } catch (error) {
              if (!(error instanceof BatchReconciliationValidationError)) throw error;
              console.error(`[agent-herder] MiniMax вернул некорректную reconciliation workspace; повторяю её целиком один раз: ${errorText(error)}`);
              return requestReconciliation();
            }
          },
          plannerPhaseController,
        );
      } catch (error) {
        plannerPhaseController.abort(error);
        throw error;
      }
      const reconciledByWorkspace = new Map(reconciliationWorkspaces.map((workspace, index) => [workspace, reconciledWorkspaces[index]!]));
      plan = {
        groups: workspaceOrder.flatMap((workspace) => reconciledByWorkspace.get(workspace)?.groups ?? groupsByWorkspace.get(workspace)!),
      };
      assertBatchPlanCoverage(plan, packedAssessed);
    }
    return { plan, window };
    } finally {
      if (this.activePlannerController === plannerPhaseController) this.activePlannerController = undefined;
    }
  }

  private lifecycleActive(epoch: number): boolean {
    return !this.stopped && epoch === this.lifecycleEpoch;
  }

  private async pinActiveSession(
    adapter: HarnessAdapter,
    sessionId: string,
    settings?: SessionAutostartFile,
  ): Promise<void> {
    if ((adapter.type !== "codex" && adapter.type !== "zcode") || !adapter.setSessionPinned) return;
    const runtimeSettings = settings ?? await this.options.settingsStore.getSettings();
    if (!runtimeSettings.pinActiveSessions) return;
    try {
      const pinned = await adapter.setSessionPinned(sessionId, true);
      if (!pinned.ok) console.error(`[agent-herder] не удалось закрепить активную сессию ${adapter.type}:${sessionId}: ${pinned.error || "операция отклонена"}`);
    } catch (error) {
      console.error(`[agent-herder] не удалось закрепить активную сессию ${adapter.type}:${sessionId}: ${errorText(error)}`);
    }
  }

  private async recordAssessmentFailure(
    assessed: AssessedSession[],
    priorInventory: ReadonlyMap<string, UnfinishedSessionInventoryRecord>,
    error: string,
  ): Promise<void> {
    const now = new Date();
    const baseDelayMs = Math.max(60_000, this.reconcileIntervalMs, this.retryDelayMs);
    const capDelayMs = 30 * 60_000;
    const records = assessed.map((candidate) => {
      const fingerprint = evidenceFingerprint(candidate.transcriptTail);
      const previous = priorInventory.get(candidate.sourceKey)?.assessmentFailure;
      const repeated = previous?.pipelineVersion === CURRENT_ASSESSMENT_PIPELINE_VERSION
        && previous.evidenceFingerprint === fingerprint;
      const count = repeated ? previous.count + 1 : 1;
      const delayMs = count <= 1 ? 0 : Math.min(capDelayMs, baseDelayMs * (2 ** Math.min(10, count - 2)));
      return {
        ...inventoryFromAssessment(candidate),
        assessmentFailure: {
          pipelineVersion: CURRENT_ASSESSMENT_PIPELINE_VERSION,
          cohortId: assessmentCohortId(candidate.session),
          evidenceFingerprint: fingerprint,
          count,
          lastError: error.slice(0, MAX_TEXT),
          failedAt: now.toISOString(),
          ...(delayMs > 0 ? { nextAttemptAt: new Date(now.getTime() + delayMs).toISOString() } : {}),
          ...(repeated && previous?.notifiedAt ? { notifiedAt: previous.notifiedAt } : {}),
        },
      } satisfies UnfinishedSessionInventoryRecord;
    });
    await this.options.store.upsertInventoryBatch(records);
    for (const candidate of assessed) {
      for (const [key, assessedVersion] of candidate.urgentSignalVersions) {
        if ((this.urgentSessionVersions.get(key) ?? 0) === assessedVersion) this.clearUrgentSession(key);
      }
    }

    const newlyRepeated = records.filter((record) => record.assessmentFailure!.count >= 2
      && !record.assessmentFailure!.notifiedAt);
    if (!this.options.notify || newlyRepeated.length === 0) return;
    const overloadStatus = transientPlannerHttpStatus(error);
    const overloaded = overloadStatus !== null;
    // The planner route is an explicit deployment choice (env, service drop-in), so an
    // operator alarm must name the route that actually failed instead of a hardcoded vendor.
    const routeLabel = plannerRouteLabel(error);
    const correlation = createHash("sha256")
      .update(`pipeline:${CURRENT_ASSESSMENT_PIPELINE_VERSION}\n${newlyRepeated.map((record) => `${inventoryRecordKey(record)}:${record.assessmentFailure!.evidenceFingerprint}`).sort().join("\n")}`)
      .digest("hex").slice(0, 24);
    try {
      await this.options.notify({
        ...(overloaded ? { severity: "notice" as const } : { severity: "critical" as const }),
        title: overloaded ? `${routeLabel} временно перегружен` : "Agent Herder повторно не смог разобрать сессии",
        body: overloaded
          ? `Agent Herder пока не может безопасно проверить незавершённые задачи из-за временной перегрузки модели ${routeLabel}. Повторная проверка отложена с увеличивающимся интервалом и возобновится автоматически; действий от вас не требуется.`
          : `Модель ${routeLabel} повторно не построила безопасный план для ${newlyRepeated.length} сесс. Автопродолжение временно отложено с увеличивающимся интервалом; новые сообщения сбросят задержку автоматически.`,
        dedupKey: overloaded
          ? "agent-herder:minimax-batch-planner-overload"
          : `agent-herder:assessment-failed:${correlation}`,
        correlationId: overloaded
          ? `minimax-batch-planner-http-${overloadStatus === 429 ? "429" : "5xx"}`
          : `assessment-${correlation}`,
        sourceId: "agent-herder-autocontinue-assessment",
        signalType: overloaded ? "minimax-planner-overloaded" : "autocontinue-assessment-failed",
      });
      const notifiedAt = new Date().toISOString();
      for (const record of newlyRepeated) record.assessmentFailure!.notifiedAt = notifiedAt;
      await this.options.store.upsertInventoryBatch(newlyRepeated);
    } catch (noticeError) {
      console.error(`[agent-herder] не удалось отправить уведомление о повторном сбое планировщика ${routeLabel}: ${errorText(noticeError)}`);
    }
  }

  private async fail(record: UnfinishedSessionRecord, error: string): Promise<void> {
    if (isArchivedSessionFailure(error)) {
      await this.failDeterministically(record, error);
      return;
    }
    let attempted = record;
    if (record.state !== "recovering") {
      const begun = await this.options.store.beginAttempt(
        record.harness, record.sessionId, this.maxAttempts, this.retryDelayMs, new Date(), record.workspaceIdentity || record.cwd,
      );
      if (!begun) return;
      attempted = begun;
    }
    const failed = await this.options.store.markFailure(
      record.harness, record.sessionId, error, this.maxAttempts, new Date(), record.workspaceIdentity || record.cwd,
    );
    console.error(`[agent-herder] автозапуск ${attempted.attempts}/${this.maxAttempts} не удался для ${record.harness}:${record.sessionId}: ${error}`);
    if (failed?.state === "exhausted") await this.notifyExhausted(failed);
  }

  /**
   * A deterministic refusal is not a retry: the same attempt repeats the same
   * answer. The record stays armed, the operator gets one actionable notice
   * naming the exact repair, and no critical alarm hides that repair.
   */
  private async failDeterministically(record: UnfinishedSessionRecord, error: string): Promise<void> {
    const blocked = await this.options.store.markDeterministicFailure(
      record.harness,
      record.sessionId,
      error,
      new Date(Date.now() + this.deterministicRetryDelayMs),
      new Date(),
      record.workspaceIdentity || record.cwd,
    );
    console.error(`[agent-herder] восстановление ${record.harness}:${record.sessionId} остановлено детерминированной ошибкой: ${error}`);
    if (blocked) await this.notifyDeterministicBlock(blocked);
  }

  private async notifyDeterministicBlock(record: UnfinishedSessionRecord): Promise<void> {
    if (!this.options.notify || record.notifiedAt) return;
    const harness = displayHarness(record.harness);
    await this.options.notify({
      severity: "notice",
      title: `${harness}: восстановление прерванного хода ждёт оператора`,
      body: `Сессия ${record.sessionId} (${record.title || record.cwd}) архивирована, поэтому Agent Herder не может продолжить прерванный ход. Данные сессии сохранены, автопродолжение приостановлено и не расходует попытки. Требуется действие: выполните \`codex unarchive ${record.sessionId}\` — после этого Agent Herder сам продолжит ход.`,
      dedupKey: `agent-herder:unfinished-session:blocked:${unfinishedRecordKey(record)}`,
      correlationId: `unfinished-${unfinishedRecordKey(record)}-${record.startedAt}`,
      sourceId: "agent-herder-autostart",
      signalType: "unfinished-session-archived",
    });
    await this.options.store.markNotified(record.harness, record.sessionId, new Date(), record.workspaceIdentity || record.cwd);
  }

  private async notifyExhausted(record: UnfinishedSessionRecord): Promise<void> {
    if (!this.options.notify || record.notifiedAt) return;
    const harness = displayHarness(record.harness);
    await this.options.notify({
      title: "Agent Herder не смог восстановить аварийно завершённый ход",
      body: `${harness}: подтверждённый сбой нативного хода не восстановлен после ${record.attempts} попыток. Автовосстановление остановлено; откройте исходную сессию и проверьте её состояние.`,
      dedupKey: `agent-herder:unfinished-session:${unfinishedRecordKey(record)}`,
      correlationId: `unfinished-${unfinishedRecordKey(record)}-${record.startedAt}`,
      sourceId: "agent-herder-autostart",
      signalType: "unfinished-session-autostart-failed",
    });
    await this.options.store.markNotified(record.harness, record.sessionId, new Date(), record.workspaceIdentity || record.cwd);
  }

  /**
   * Resume a native thread and repair an archived store when the native
   * refusal names it.
   *
   * Archiving keeps the thread and its rollout, so the refusal is reversible
   * without operator input. A thread that is already restored resumes directly
   * and is never touched by the archive repair.
   */
  private async resumeRestorableSession(
    adapter: HarnessAdapter,
    record: UnfinishedSessionRecord,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const resume = async () => (adapter.resumeSession ? await adapter.resumeSession(record.sessionId) : { ok: true });
    const resumed = await resume();
    if (resumed.ok) return { ok: true };
    const refusal = resumed.error || "";
    if (!isArchivedSessionFailure(refusal)) return { ok: false, error: refusal || "возобновление отклонено" };
    const unarchive = adapter.unarchiveSession;
    if (!unarchive) return { ok: false, error: refusal };
    const restored = await unarchive.call(adapter, record.sessionId).catch((cause: unknown) => ({ ok: false, error: errorText(cause) }));
    if (!restored.ok) {
      console.error(`[agent-herder] восстановление архива ${record.harness}:${record.sessionId} не выполнено: ${restored.error}`);
      return { ok: false, error: refusal };
    }
    const retried = await resume();
    if (!retried.ok) return { ok: false, error: retried.error || refusal };
    console.error(`[agent-herder] архивированная сессия ${record.harness}:${record.sessionId} восстановлена и возобновлена`);
    return { ok: true };
  }

  /**
   * Re-arm an exhausted record whose only cause was a reversible native refusal.
   *
   * Exhausting the retry budget must not strand unfinished work: when the
   * thread becomes resumable again, the durable record returns to the armed
   * state and the ordinary recovery continues the interrupted turn.
   */
  private async rearmExhaustedArchivedRecord(
    adapter: HarnessAdapter,
    record: UnfinishedSessionRecord,
    session: AgentSession,
  ): Promise<UnfinishedSessionRecord | null> {
    if (!isArchivedSessionFailure(record.lastError ?? "")) return null;
    const resumed = await this.resumeRestorableSession(adapter, record);
    if (!resumed.ok) return null;
    const rearmed = await this.options.store.markStarted(session, this.generationId, new Date(), true);
    console.error(`[agent-herder] запись ${record.harness}:${record.sessionId} перевзведена: архив восстановлен, прерванный ход продолжится`);
    return rearmed;
  }

  private async groupAdmissionAllowed(sessions: AgentSession[], operation: RecoveryOperation): Promise<boolean> {
    for (const session of sessions) if (this.options.semanticAdmissionHeld?.(session) || !await this.admissionAllowed(session, operation)) return false;
    // Batch assessment can precede a slow planner/attach. Read the existing
    // semantic switches again after the awaited admission gate, before each
    // native action; a cached autoResumeEnabled must not override a new opt-out.
    // Recovery's independent switch must not disable an enabled Autopilot.
    try {
      const effective = await this.semanticAutopilotPolicy();
      if (!effective) return false;
      for (const session of sessions) if (!await this.semanticAutopilotAllows(session, effective)) return false;
      // A manual Stop may arrive during either semantic read. Check the
      // existing durable source holds last, without another native RPC or
      // clearing accepted work, before creating or controlling any identity.
      for (const session of sessions) {
        if (await this.options.humanStopStore?.isHeld(session.harness, session.id)) return false;
      }
      return true;
    } catch {
      // An unreadable permission is a deferral, not a reason to deliver a prompt.
      return false;
    }
  }

  private async admissionAllowed(session: AgentSession, operation: RecoveryOperation): Promise<boolean> {
    if (!this.options.admissionGate) return true;
    try {
      return (await this.options.admissionGate(session, operation)).allowed;
    } catch {
      // Gate failure is a deferral, never a native failure or consumed retry.
      return false;
    }
  }

  private async operatorProjectModelAllowed(session: AgentSession, model: string): Promise<boolean> {
    if (session.harness !== "opencode") return false;
    try {
      const loaded = await this.projectLaunchPolicyStore.load();
      if (loaded.kind !== "valid") return false;
      const route = findProjectRoute(loaded.policy, session.cwd);
      if (route && (!route.harnesses.includes("opencode") || route.operatorCohortRecovery === "deny")) return false;
      if (!loaded.policy.fallbackModels?.opencode?.includes(model)) return false;
      if (!isCodexClaudeRestrictedCohortProject(session.cwd)) {
        return operatorCohortRecoveryAllowed(loaded.policy, session.cwd);
      }
      const adapter = this.options.adapters.get("opencode") as (HarnessAdapter & {
        resolveModelProviderLeaves?: (nativeModelId: string) => Promise<OpenCodeModelProviderResolution | null>;
      }) | undefined;
      if (!adapter?.resolveModelProviderLeaves) return false;
      const resolved = await adapter.resolveModelProviderLeaves(model);
      return isAllowedRestrictedProviderResolution(resolved, model);
    } catch {
      return false;
    }
  }

  /** The durable switch only. A pending question is a deferral, never a disable. */
  private async isEnabled(harness: HarnessType, sessionId: string, cwd: string): Promise<boolean> {
    return (await this.options.settingsStore.getEffective(harness, sessionId, cwd)).enabled;
  }

  /** True while this exact session still owes a human an answer. */
  private async pendingQuestionBlocks(harness: HarnessType, sessionId: string, cwd: string): Promise<boolean> {
    if (!this.pendingQuestions) return false;
    return await this.pendingQuestions.blocks(harness, sessionId, cwd);
  }

  /** Operator continuations must bypass the ordinary TTL cache at each send fence. */
  private async operatorContinuationPendingQuestionBlocks(sessionId: string, cwd: string): Promise<boolean> {
    if (!this.pendingQuestions) return true;
    this.pendingQuestions.invalidate();
    try { return await this.pendingQuestions.blocks("opencode", sessionId, cwd); }
    catch { return true; }
  }

  /**
   * Whether Herder may work on this session right now.
   *
   * An unanswered question blocks automatic work even when the native status no
   * longer reports it. It defers: durable accepted and recovery state stays.
   */
  private async mayWorkOnSession(harness: HarnessType, sessionId: string, cwd: string): Promise<boolean> {
    if (!await this.isEnabled(harness, sessionId, cwd)) return false;
    return !(await this.pendingQuestionBlocks(harness, sessionId, cwd));
  }
}

function parseAutostartFile(value: unknown, env: NodeJS.ProcessEnv = process.env): SessionAutostartFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("session autostart settings must be an object");
  const object = value as Record<string, unknown>;
  if ((object.version !== 1 && object.version !== 2 && object.version !== 3 && object.version !== 4 && object.version !== 5 && object.version !== 6 && object.version !== 7 && object.version !== 8) || typeof object.enabled !== "boolean" || !Array.isArray(object.sessions)) throw new Error("invalid session autostart settings");
  const harnesses = object.version >= 2 ? object.harnesses : [];
  if (!Array.isArray(harnesses)) throw new Error("invalid session autostart harness overrides");
  const waitForQuotaHarnesses = object.version === 8 ? (object.waitForQuotaHarnesses ?? []) : [];
  const waitForQuotaSessions = object.version === 8 ? (object.waitForQuotaSessions ?? []) : [];
  if (!Array.isArray(waitForQuotaHarnesses) || !Array.isArray(waitForQuotaSessions)) throw new Error("invalid waitForQuota overrides");
  const defaults = defaultAutostartFile(env);
  return {
    version: 8,
    enabled: object.enabled,
    waitForQuota: object.version === 8 && object.waitForQuota !== undefined ? booleanSetting(object.waitForQuota, "waitForQuota") : false,
    pinActiveSessions: object.version === 8 && object.pinActiveSessions !== undefined ? booleanSetting(object.pinActiveSessions, "pinActiveSessions") : defaults.pinActiveSessions,
    rolloverExpiredCache: object.version >= 4 ? booleanSetting(object.rolloverExpiredCache, "rolloverExpiredCache") : defaults.rolloverExpiredCache,
    movePinnedOnRollover: object.version >= 5 ? booleanSetting(object.movePinnedOnRollover, "movePinnedOnRollover") : defaults.movePinnedOnRollover,
    inventoryWindowHours: object.version >= 3 ? runtimeHours(object.inventoryWindowHours) : defaults.inventoryWindowHours,
    evidenceMessageCount: object.version >= 6 && object.evidenceMessageCount !== undefined ? evidenceCount(object.evidenceMessageCount) : defaults.evidenceMessageCount,
    recoverOnFailure: object.recoverOnFailure === undefined ? defaults.recoverOnFailure : booleanSetting(object.recoverOnFailure, "recoverOnFailure"),
    recoverOnDisconnect: object.recoverOnDisconnect === undefined ? defaults.recoverOnDisconnect : booleanSetting(object.recoverOnDisconnect, "recoverOnDisconnect"),
    watchdogEnabled: object.version >= 6 && object.watchdogEnabled !== undefined ? booleanSetting(object.watchdogEnabled, "watchdogEnabled") : defaults.watchdogEnabled,
    watchdogIntervalSeconds: object.version >= 6 && object.watchdogIntervalSeconds !== undefined ? boundedInteger(object.watchdogIntervalSeconds, 5, 300, "watchdogIntervalSeconds") : defaults.watchdogIntervalSeconds,
    stalledTurnMinutes: object.version >= 6 && object.stalledTurnMinutes !== undefined ? boundedInteger(object.stalledTurnMinutes, 1, 120, "stalledTurnMinutes") : defaults.stalledTurnMinutes,
    judgeModel: object.version >= 3 ? runtimeModel(object.judgeModel, "judgeModel") : defaults.judgeModel,
    autopilotJudgeModel: object.version >= 3 ? runtimeModel(object.autopilotJudgeModel, "autopilotJudgeModel") : defaults.autopilotJudgeModel,
    harnesses: harnesses.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid session autostart harness override");
      const record = value as Record<string, unknown>;
      if (typeof record.enabled !== "boolean") throw new Error("invalid session autostart harness override enabled flag");
      return {
        harness: harnessType(record.harness),
        enabled: record.enabled,
        updatedAt: isoDate(record.updatedAt, "updatedAt"),
      };
    }),
    sessions: object.sessions.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid session autostart override");
      const record = value as Record<string, unknown>;
      if (typeof record.enabled !== "boolean") throw new Error("invalid session autostart override enabled flag");
      return {
        harness: harnessType(record.harness),
        sessionId: bounded(record.sessionId, "sessionId"),
        cwd: normalize(bounded(record.cwd, "cwd")),
        enabled: record.enabled,
        updatedAt: isoDate(record.updatedAt, "updatedAt"),
      };
    }),
    waitForQuotaHarnesses: waitForQuotaHarnesses.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid waitForQuota harness override");
      const record = value as Record<string, unknown>;
      return { harness: harnessType(record.harness), waitForQuota: booleanSetting(record.waitForQuota, "waitForQuota"), updatedAt: isoDate(record.updatedAt, "updatedAt") };
    }),
    waitForQuotaSessions: waitForQuotaSessions.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid waitForQuota session override");
      const record = value as Record<string, unknown>;
      return { harness: harnessType(record.harness), sessionId: bounded(record.sessionId, "sessionId"), cwd: normalize(bounded(record.cwd, "cwd")),
        waitForQuota: booleanSetting(record.waitForQuota, "waitForQuota"), updatedAt: isoDate(record.updatedAt, "updatedAt") };
    }),
  };
}

function defaultAutostartFile(env: NodeJS.ProcessEnv): SessionAutostartFile {
  return {
    version: 8,
    enabled: env.AGENT_HERDER_UNFINISHED_AUTOSTART !== "false",
    waitForQuota: false,
    pinActiveSessions: env.AGENT_HERDER_UNFINISHED_PIN_ACTIVE_SESSIONS !== "false",
    rolloverExpiredCache: false,
    movePinnedOnRollover: false,
    inventoryWindowHours: positiveInteger(Number(env.AGENT_HERDER_UNFINISHED_INVENTORY_HOURS || 48), 48),
    evidenceMessageCount: evidenceCount(Number(env.AGENT_HERDER_UNFINISHED_EVIDENCE_MESSAGES || DEFAULT_EVIDENCE_MESSAGE_COUNT)),
    recoverOnFailure: env.AGENT_HERDER_UNFINISHED_RECOVER_ON_FAILURE !== "false",
    recoverOnDisconnect: env.AGENT_HERDER_UNFINISHED_RECOVER_ON_DISCONNECT !== "false",
    watchdogEnabled: env.AGENT_HERDER_UNFINISHED_WATCHDOG === "true",
    watchdogIntervalSeconds: boundedInteger(Number(env.AGENT_HERDER_UNFINISHED_WATCHDOG_INTERVAL_SECONDS || 10), 5, 300, "watchdogIntervalSeconds"),
    stalledTurnMinutes: boundedInteger(Number(env.AGENT_HERDER_UNFINISHED_STALLED_TURN_MINUTES || 2), 1, 120, "stalledTurnMinutes"),
    judgeModel: env.AGENT_HERDER_UNFINISHED_JUDGE_MODEL?.trim() || "MiniMax-M3.1-Flash",
    autopilotJudgeModel: env.AGENT_HERDER_AUTOPILOT_JUDGE_MODEL?.trim() || "MiniMax-M3",
    harnesses: [],
    sessions: [],
    waitForQuotaHarnesses: [],
    waitForQuotaSessions: [],
  };
}

function booleanSetting(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`invalid ${field}`);
  return value;
}

function runtimeHours(value: unknown): number {
  const hours = positiveInteger(value, -1);
  if (hours < 1 || hours > 24 * 90) throw new Error("invalid inventoryWindowHours");
  return hours;
}

function runtimeModel(value: unknown, field: string): string {
  const model = boundedText(value, field, 256).trim();
  if (!model) throw new Error(`invalid ${field}`);
  return model;
}

function evidenceCount(value: unknown): number {
  const count = positiveInteger(value, -1);
  if (count < 2 || count > MAX_EVIDENCE_MESSAGE_COUNT) throw new Error("invalid evidenceMessageCount");
  return count;
}

function cloneAutostartFile(file: SessionAutostartFile): SessionAutostartFile {
  return {
    ...file,
    harnesses: file.harnesses.map((record) => ({ ...record })),
    sessions: file.sessions.map((record) => ({ ...record })),
    waitForQuotaHarnesses: file.waitForQuotaHarnesses.map((record) => ({ ...record })),
    waitForQuotaSessions: file.waitForQuotaSessions.map((record) => ({ ...record })),
  };
}

function resolveWaitForQuota(
  settings: SessionAutostartFile & { source?: "persisted" | "default" },
  harness: HarnessType,
  sessionId: string,
  cwd: string,
): { waitForQuota: boolean; waitForQuotaSource: WaitForQuotaSource; waitForQuotaOverride?: boolean } {
  const session = settings.waitForQuotaSessions.find((record) => sessionKey(record.harness, record.sessionId, record.cwd) === sessionKey(harness, sessionId, cwd));
  if (session) return { waitForQuota: session.waitForQuota, waitForQuotaSource: "session", waitForQuotaOverride: session.waitForQuota };
  const byHarness = settings.waitForQuotaHarnesses.find((record) => record.harness === harness);
  if (byHarness) return { waitForQuota: byHarness.waitForQuota, waitForQuotaSource: "harness", waitForQuotaOverride: byHarness.waitForQuota };
  return { waitForQuota: settings.waitForQuota, waitForQuotaSource: settings.source === "persisted" ? "global" : "default" };
}

function parseFile(value: unknown): UnfinishedSessionFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("unfinished session state must be an object");
  const object = value as Record<string, unknown>;
  if (object.version !== 1 || !Array.isArray(object.sessions)) throw new Error("invalid unfinished session state");
  if (object.inventory !== undefined && !Array.isArray(object.inventory)) throw new Error("invalid unfinished session inventory");
  return {
    version: 1,
    sessions: object.sessions.map(parseRecord),
    ...(Array.isArray(object.inventory) ? { inventory: object.inventory.map(parseInventoryRecord) } : {}),
  };
}

function parseInventoryRecord(value: unknown): UnfinishedSessionInventoryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid unfinished session inventory entry");
  const record = value as Record<string, unknown>;
  const harness = record.harness;
  if (!isInventoryHarness(harness)) throw new Error("invalid inventory harness");
  const status = record.status;
  if (status !== "running" && status !== "idle" && status !== "needs_input" && status !== "stopped" && status !== "error") {
    throw new Error("invalid inventory session status");
  }
  return {
    harness,
    sessionId: bounded(record.sessionId, "sessionId"),
    cwd: normalize(bounded(record.cwd, "cwd")),
    ...(record.workspaceIdentity ? { workspaceIdentity: normalize(bounded(record.workspaceIdentity, "workspaceIdentity")) } : {}),
    title: boundedText(record.title, "title", MAX_TEXT),
    status,
    lastActivity: isoDate(record.lastActivity, "lastActivity"),
    transcriptTail: boundedText(record.transcriptTail, "transcriptTail", 2_000_000, true),
    ...(record.evidenceVersion === undefined ? {} : { evidenceVersion: positiveInteger(record.evidenceVersion, -1) }),
    ...(record.evidenceFingerprint === undefined ? {} : { evidenceFingerprint: bounded(record.evidenceFingerprint, "evidenceFingerprint") }),
    ...(record.progressFingerprint === undefined ? {} : { progressFingerprint: bounded(record.progressFingerprint, "progressFingerprint") }),
    observedAt: isoDate(record.observedAt, "observedAt"),
    ...(record.verdict ? { verdict: normalizePersistedVerdict(record.verdict) } : {}),
    ...(record.assessmentFailure ? {
      assessmentFailure: parseAssessmentFailure(
        record.assessmentFailure,
        assessmentCohortId({
          harness,
          cwd: bounded(record.cwd, "cwd"),
          ...(record.workspaceIdentity ? {
            meta: { workspaceIdentity: normalize(bounded(record.workspaceIdentity, "workspaceIdentity")) },
          } : {}),
        }),
      ),
    } : {}),
  };
}

function parseAssessmentFailure(
  value: unknown,
  legacyCohortId: string,
): NonNullable<UnfinishedSessionInventoryRecord["assessmentFailure"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid inventory assessment failure");
  const record = value as Record<string, unknown>;
  return {
    pipelineVersion: typeof record.pipelineVersion === "number"
      && Number.isInteger(record.pipelineVersion)
      && record.pipelineVersion >= 0
      && record.pipelineVersion <= 1_000_000
      ? record.pipelineVersion : 0,
    cohortId: record.cohortId === undefined ? legacyCohortId : bounded(record.cohortId, "assessmentFailure.cohortId"),
    evidenceFingerprint: bounded(record.evidenceFingerprint, "assessmentFailure.evidenceFingerprint"),
    count: boundedInteger(record.count, 1, 1_000_000, "assessmentFailure.count"),
    lastError: boundedText(record.lastError, "assessmentFailure.lastError", MAX_TEXT),
    failedAt: isoDate(record.failedAt, "assessmentFailure.failedAt"),
    ...(record.nextAttemptAt ? { nextAttemptAt: isoDate(record.nextAttemptAt, "assessmentFailure.nextAttemptAt") } : {}),
    ...(record.notifiedAt ? { notifiedAt: isoDate(record.notifiedAt, "assessmentFailure.notifiedAt") } : {}),
  };
}

function normalizePersistedVerdict(value: unknown): SessionInventoryVerdict {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid inventory verdict");
  const record = value as Record<string, unknown>;
  return { ...normalizeVerdict(record), judgedAt: isoDate(record.judgedAt, "judgedAt") };
}

function heuristicVerdict(session: AgentSession, messages: SessionMessageView[]): Omit<SessionInventoryVerdict, "judgedAt"> {
  if (session.status === "needs_input" || session.needsPermission) {
    return { verdict: "needs_human", reason: "Сессия ожидает решения или разрешения человека", confidence: 1 };
  }
  if (session.status === "running") {
    return { verdict: "unfinished", reason: "Харнес всё ещё считает сессию работающей", confidence: 1 };
  }
  const last = [...messages].reverse().find((message) => message.role !== "system");
  if (!last) return { verdict: "needs_human", reason: "Нет сообщений для безопасной классификации", confidence: 1 };
  if (last.role === "user" || last.role === "tool") {
    return { verdict: "unfinished", reason: last.role === "user" ? "Последний запрос пользователя остался без ответа" : "Сессия оборвалась после вызова инструмента", confidence: 0.9 };
  }
  const hasToolCall = last.parts.some((part) => part.type === "tool_call");
  const hasToolResult = last.parts.some((part) => part.type === "tool_result");
  if (hasToolCall && !hasToolResult) return { verdict: "unfinished", reason: "Последний вызов инструмента не завершён", confidence: 0.9 };
  if ((last.text || last.parts.find((part) => part.type === "text")?.text || "").trim()) {
    return { verdict: "completed", reason: "Последним сохранён полный ответ агента", confidence: 0.75 };
  }
  return { verdict: "needs_human", reason: "Финальное состояние диалога неоднозначно", confidence: 0.5 };
}

function cloneInventoryRecord(record: UnfinishedSessionInventoryRecord): UnfinishedSessionInventoryRecord {
  return {
    ...record,
    ...(record.verdict ? { verdict: { ...record.verdict } } : {}),
    ...(record.assessmentFailure ? { assessmentFailure: { ...record.assessmentFailure } } : {}),
  };
}

async function sessionEvidenceMessages(adapter: HarnessAdapter, sessionId: string, limit: number): Promise<SessionMessageView[]> {
  const [tail, firstUser] = await Promise.all([
    adapter.getSessionMessages?.(sessionId, limit).catch(() => null) ?? Promise.resolve(null),
    adapter.getFirstUserMessage
      ? adapter.getFirstUserMessage(sessionId).catch(() => null)
      : Promise.resolve(null),
  ]);
  const messages = tail ?? [];
  if (!firstUser) return messages;
  const duplicate = (message: SessionMessageView) => message.role === "user"
    && message.text === firstUser.text
    && (!message.timestamp || !firstUser.timestamp || message.timestamp === firstUser.timestamp);
  return [firstUser, ...messages.filter((message) => !duplicate(message))];
}

/** Keep the first user goal plus the configured latest semantic messages. */
export function completionEvidence(messages: SessionMessageView[], messageCount = DEFAULT_EVIDENCE_MESSAGE_COUNT): string {
  const targetCount = Math.max(3, messageCount);
  const semantic = messages.map((message, index) => ({
    index,
    role: message.role,
    text: message.role === "user" || message.role === "assistant" ? semanticTranscript([message]) : "",
  })).filter((item) => item.text);
  const firstUser = semantic.find((item) => item.role === "user");
  const selected = [
    firstUser,
    ...semantic.slice(-Math.max(1, targetCount - (firstUser ? 1 : 0))),
    [...semantic].reverse().find((item) => item.role === "user"),
    [...semantic].reverse().find((item) => item.role === "assistant"),
  ].filter((item): item is (typeof semantic)[number] => Boolean(item));
  const unique = [...new Map(selected.map((item) => [item.index, item])).values()].sort((left, right) => left.index - right.index);
  const recent = unique.filter((item) => item.index !== firstUser?.index).slice(-Math.max(1, targetCount - (firstUser ? 1 : 0)));
  const bounded = firstUser ? [firstUser, ...recent] : recent;
  for (const role of ["user", "assistant"] as const) {
    if (bounded.some((item) => item.role === role)) continue;
    const required = [...unique].reverse().find((item) => item.role === role);
    if (required) bounded.splice(firstUser ? 1 : 0, 1, required);
  }
  bounded.sort((left, right) => left.index - right.index);
  const deduplicated = [...new Map(bounded.map((item) => [item.index, item])).values()];
  if (deduplicated.length === 0) return "";
  const first = firstUser?.text ?? deduplicated[0]!.text;
  const tail = deduplicated.filter((item) => item.index !== firstUser?.index).map((item) => item.text).join("\n\n") || first;
  return trimEvidenceChars([
    "ПЕРВЫЙ ПОЛЬЗОВАТЕЛЬСКИЙ ЗАПРОС:",
    first,
    "\nПОСЛЕДНИЙ СМЫСЛОВОЙ КОНТЕКСТ:",
    tail,
  ].join("\n"), MAX_SESSION_EVIDENCE_CHARS);
}

function evidenceFingerprint(value: string): string {
  return createHash("sha256").update(`${CURRENT_EVIDENCE_VERSION}\0${value}`).digest("hex");
}

function evidenceIsCurrent(record: UnfinishedSessionInventoryRecord | undefined): boolean {
  return record?.evidenceVersion === CURRENT_EVIDENCE_VERSION
    && record.evidenceFingerprint === evidenceFingerprint(record.transcriptTail);
}

function inventoryFromAssessment(
  candidate: AssessedSession,
  verdict?: SessionInventoryVerdict,
  now = new Date(),
): UnfinishedSessionInventoryRecord {
  return {
    harness: candidate.session.harness as "codex" | "zcode",
    sessionId: candidate.session.id,
    cwd: candidate.session.cwd,
    workspaceIdentity: sessionWorkspaceIdentity(candidate.session),
    title: candidate.session.title,
    status: candidate.session.status,
    lastActivity: candidate.session.lastActivity,
    transcriptTail: candidate.transcriptTail,
    evidenceVersion: CURRENT_EVIDENCE_VERSION,
    evidenceFingerprint: evidenceFingerprint(candidate.transcriptTail),
    progressFingerprint: sessionInventoryProgressFingerprint(candidate.session),
    observedAt: now.toISOString(),
    ...(verdict ? { verdict } : {}),
  };
}

function trimEvidenceChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 0) return "";
  const divider = "\nПОСЛЕДНИЙ СМЫСЛОВОЙ КОНТЕКСТ:\n";
  const split = value.indexOf(divider);
  if (split < 0) return value.slice(-maxChars);
  const prefix = value.slice(0, split + divider.length);
  const prefixBudget = Math.min(prefix.length, Math.min(maxChars, Math.max(1, Math.floor(maxChars * 0.2))));
  const suffixBudget = Math.max(0, maxChars - prefixBudget);
  return `${prefix.slice(0, prefixBudget)}${value.slice(-suffixBudget)}`;
}

function cleanPlanTopic(topic: string): string {
  const cleaned = topic
    .replace(/^авто(?:матическое)?\s*продолжение\s*[—:.-]*\s*/iu, "")
    .replace(/^(?:устранение\s+)?(?:дубл\p{L}*|повтор\p{L}*)(?:\s+(?:задач\p{L}*|сесси\p{L}*))?\s*[—:.-]*\s*/iu, "")
    .replace(/^аудита(?=\s|$)/iu, "Аудит")
    .replace(/^проверки(?=\s|$)/iu, "Проверка")
    .replace(/^задачи(?=\s|$)/iu, "Задача")
    .trim();
  const fallback = cleaned || "Незавершённая задача";
  return `${fallback.charAt(0).toLocaleUpperCase("ru-RU")}${fallback.slice(1)}`;
}

function continuationTitle(topic: string): string {
  return `Автопродолжение — ${cleanPlanTopic(topic).slice(0, 96)}`;
}

function transientPlannerHttpStatus(error: string): number | null {
  const status = error.match(/\b(?:MiniMax|LLM).{0,120}\bHTTP\s*(429|5\d{2})\b/i)?.[1];
  return status ? Number(status) : null;
}

/** True only for a transport/provider blip that a single identical retry can heal.
 *
 * A safe plan is never worth guessing at, so an invalid plan keeps failing the
 * cohort. A dropped connection, a rate limit or a provider overload is a fact
 * about the network, not about the sessions: JudgeRequestError already tags it
 * in its diagnostic, and an untagged transport error is still retried only when
 * it is not a local cancellation or a budget exhaustion. */
function isTransientPlannerFailure(error: unknown): boolean {
  if (error instanceof BatchPlanValidationError || error instanceof BatchReconciliationValidationError) return false;
  if (error instanceof SyntaxError) return false;
  const kind = error instanceof JudgeRequestError
    ? error.diagnostic.kind
    : plannerFailureRoute(errorText(error)) && /"kind"\s*:\s*"(\w+)"/.exec(errorText(error))?.[1];
  return kind === "timeout"
    || kind === "network"
    || kind === "rate_limited"
    || kind === "overloaded";
}

/** Bounded pause before the single safe planner transport retry.
 *
 * Observed on server-100: a long-running planner process can lose its pooled
 * connection to the judge endpoint for a short window, and both an immediate
 * repeat and the whole phase then fail with the same transport error. One
 * spaced retry stays inside the phase deadline and still never repeats a
 * session action, because the batch planner only produces a plan. */
async function transientPlannerRetryDelay(delayMs: number, deadline: number, controller: AbortController): Promise<void> {
  const remainingMs = Math.min(delayMs, deadline - Date.now());
  if (remainingMs <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { controller.signal.removeEventListener("abort", onAbort); resolve(); }, remainingMs);
    timer.unref?.();
    function onAbort() { clearTimeout(timer); resolve(); }
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The planner model and endpoint host actually observed in the judge diagnostic.
 *
 * The batch planner runs on an explicitly configured route that differs per deployment,
 * so an alarm may never blame a hardcoded vendor. JudgeRequestError already embeds the
 * redacted diagnostic; read the route from it and never fail the caller on a bad shape. */
function plannerFailureRoute(error: string): { model: string; host: string } | null {
  const start = error.lastIndexOf("{");
  if (start < 0) return null;
  let diagnostic: Record<string, unknown>;
  try { diagnostic = JSON.parse(error.slice(start)) as Record<string, unknown>; }
  catch { return null; }
  const model = typeof diagnostic.model === "string" ? diagnostic.model.trim().slice(0, 96) : "";
  if (!model) return null;
  let host = "";
  if (typeof diagnostic.endpoint === "string" && diagnostic.endpoint) {
    try { host = new URL(diagnostic.endpoint).hostname.slice(0, 96); } catch { host = ""; }
  }
  return { model, host };
}

function plannerRouteLabel(error: string): string {
  const route = plannerFailureRoute(error);
  if (!route) return "планировщик";
  return route.host ? `${route.model} (${route.host})` : route.model;
}

function isAutocontinueRequest(text: string | undefined): boolean {
  const normalized = text?.trim() || "";
  return normalized.startsWith("Автопродолжение —")
    || normalized.startsWith("Продолжи незавершённую задачу с того места, где выполнение было прервано.");
}

function hasPersistedAssistantAfterAdmission(messages: SessionMessageView[], acceptedAt: string): boolean {
  const boundary = Date.parse(acceptedAt);
  let acceptedPrompt = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" && isAutocontinueRequest(message.text)) {
      acceptedPrompt = index;
      break;
    }
  }
  if (acceptedPrompt >= 0) {
    return messages.slice(acceptedPrompt + 1).some((message) => {
      if (message.role !== "assistant" || !message.text?.trim()) return false;
      if (message.timestamp === undefined) return true;
      const timestamp = Date.parse(message.timestamp);
      return Number.isFinite(boundary) && Number.isFinite(timestamp) && timestamp >= boundary;
    });
  }
  // Old transcripts may omit the accepted prompt. Only a strictly newer
  // timestamp can prove a response in that case; equality can be a stale
  // pre-admission snapshot rounded to the same native timestamp.
  return Number.isFinite(boundary) && messages.some((message) => {
    if (message.role !== "assistant" || !message.text?.trim() || message.timestamp === undefined) return false;
    const timestamp = Date.parse(message.timestamp);
    return Number.isFinite(timestamp) && timestamp > boundary;
  });
}

/**
 * True when the native turn behind an accepted prompt is definitively over
 * because a human stopped it. Only a cancelled turn that already completed
 * counts: a live turn may still be aborted later, and a transport abort is
 * deliberately excluded because the harness adapter already owns that case.
 */
function acceptedTurnStoppedByHuman(turn: NativeLastTurn | undefined, acceptedAt: string | undefined): boolean {
  if (!turn || turn.cancelledByUser !== true || turn.transportLost === true) return false;
  if (turn.status?.toLowerCase() !== "cancelled") return false;
  const completedAt = Date.parse(turn.completedAt ?? "");
  if (!Number.isFinite(completedAt) || completedAt > Date.now()) return false;
  const boundary = Date.parse(acceptedAt ?? "");
  // The cancel must belong to the accepted prompt, not to an earlier turn.
  return !Number.isFinite(boundary) || completedAt >= boundary;
}

export function enforcePlanWorkspaceBoundaries(
  plan: SessionBatchPlan,
  candidates: ReadonlyMap<string, SessionBatchCandidate>,
): SessionBatchPlan {
  return {
    groups: plan.groups.flatMap((group) => {
      const partitions = new Map<string, string[]>();
      for (const id of group.sourceSessionIds) {
        const workspaceIdentity = sessionWorkspaceIdentity(candidates.get(id)!.session);
        const ids = partitions.get(workspaceIdentity) ?? [];
        ids.push(id);
        partitions.set(workspaceIdentity, ids);
      }
      if (partitions.size <= 1) return [group];
      // Similar titles/topics are not task identity. A canary or unrelated
      // checkout must never supersede an active/pinned session in another
      // workspace, even when MiniMax grouped them together. Preserve genuine
      // same-workspace duplicates as one subgroup, but force each workspace to
      // be replanned independently before any completion or resume action.
      return [...partitions.values()].map((sourceSessionIds): SessionBatchPlanGroup => {
        const primarySessionId = sourceSessionIds.includes(group.primarySessionId)
          ? group.primarySessionId
          : sourceSessionIds[0]!;
        return {
          sourceSessionIds,
          primarySessionId,
          verdict: "needs_human",
          reason: "MiniMax попытался объединить разные рабочие каталоги; эта подгруппа сохранена для отдельной проверки",
          confidence: 0,
          topic: group.topic,
          handoff: "",
        };
      });
    }),
  };
}

function batchContinuationPrompt(group: SessionBatchPlanGroup, sources: AssessedSession[]): string {
  return [
    continuationTitle(group.topic),
    "",
    `Это единое продолжение задачи «${group.topic}», собранное оркестратором из ${sources.length} сесс. Codex/ZCode.`,
    `Исходные сессии: ${sources.map(({ session }) => `${session.harness}:${session.id} (${session.title})`).join("; ")}.`,
    "MiniMax прочитал первый пользовательский запрос и свежий смысловой хвост каждой сессии, убрал дубли и подготовил общий handoff.",
    "\n--- ОБЪЕДИНЁННЫЙ HANDOFF ---\n",
    group.handoff,
    "\nПроверь текущее состояние файлов и сервисов, затем продолжи с незавершённого шага. Не повторяй уже подтверждённое.",
  ].join("\n");
}

function parseRecord(value: unknown): UnfinishedSessionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid unfinished session entry");
  const record = value as Record<string, unknown>;
  const target = normalizeRecordTarget({
    harness: harnessType(record.harness),
    sessionId: bounded(record.sessionId, "sessionId"),
    cwd: bounded(record.cwd, "cwd"),
    model: optionalBounded(record.model, "model"),
    title: optionalBounded(record.title, "title"),
    threadSource: optionalBounded(record.threadSource, "threadSource"),
  });
  const state = record.state;
  if (state !== "active" && state !== "recovering" && state !== "exhausted") throw new Error("invalid unfinished session state");
  const attempts = nonNegativeInteger(record.attempts, -1);
  if (attempts < 0) throw new Error("invalid unfinished session attempts");
  return {
    ...target,
    ...(record.workspaceIdentity ? { workspaceIdentity: normalize(bounded(record.workspaceIdentity, "workspaceIdentity")) } : {}),
    startedAt: isoDate(record.startedAt, "startedAt"),
    updatedAt: isoDate(record.updatedAt, "updatedAt"),
    ...(record.acceptedAt ? { acceptedAt: isoDate(record.acceptedAt, "acceptedAt") } : {}),
    ...(record.acceptedFingerprint ? { acceptedFingerprint: bounded(record.acceptedFingerprint, "acceptedFingerprint") } : {}),
    ...(record.progressObservedAt ? { progressObservedAt: isoDate(record.progressObservedAt, "progressObservedAt") } : {}),
    ...(record.deliveryPending === true ? { deliveryPending: true } : {}),
    ...(record.admissionPhase === "accepted_pending" || record.admissionPhase === "in_progress" || record.admissionPhase === "terminal_observed"
      ? { admissionPhase: record.admissionPhase } : {}),
    ...(record.lastProgressFingerprint ? { lastProgressFingerprint: bounded(record.lastProgressFingerprint, "lastProgressFingerprint") } : {}),
    ...(record.lastNativeProgressAt ? { lastNativeProgressAt: isoDate(record.lastNativeProgressAt, "lastNativeProgressAt") } : {}),
    ...(record.terminalReason === "turn.completed" || record.terminalReason === "turn.failed"
      ? { terminalReason: record.terminalReason } : {}),
    ...(record.terminalObservedAt ? { terminalObservedAt: isoDate(record.terminalObservedAt, "terminalObservedAt") } : {}),
    ...(record.terminalRetryCount === undefined ? {} : { terminalRetryCount: nonNegativeInteger(record.terminalRetryCount, 0) }),
    ...(record.terminalAssistantObserved === true ? { terminalAssistantObserved: true } : {}),
    ...(record.nonRetryableAdmission === true ? { nonRetryableAdmission: true } : {}),
    ...(record.recoveryCause === "turn.failed" || record.recoveryCause === "process.disconnected" || record.recoveryCause === "stalled" || record.recoveryCause === "quota_exhausted"
      ? { recoveryCause: record.recoveryCause } : {}),
    ...(parseQuotaRecovery(record.quotaRecovery) ? { quotaRecovery: parseQuotaRecovery(record.quotaRecovery)! } : {}),
    ...(Array.isArray(record.quotaRecoveryHistory)
      ? { quotaRecoveryHistory: record.quotaRecoveryHistory.map(parseQuotaRecoveryHistoryEntry).filter((entry): entry is QuotaRecoveryHistoryEntry => Boolean(entry)).slice(-16) }
      : {}),
    ...(record.recoveryBlockedReason ? { recoveryBlockedReason: bounded(record.recoveryBlockedReason, "recoveryBlockedReason") } : {}),
    ...(record.recoveryObservedAt ? { recoveryObservedAt: isoDate(record.recoveryObservedAt, "recoveryObservedAt") } : {}),
    ...(record.recoveryTurnId ? { recoveryTurnId: bounded(record.recoveryTurnId, "recoveryTurnId") } : {}),
    ...(record.recoveryInputId ? { recoveryInputId: bounded(record.recoveryInputId, "recoveryInputId") } : {}),
    ...(parseNativeOwnerProof(record.activeNativeOwner) ? {activeNativeOwner:parseNativeOwnerProof(record.activeNativeOwner)} : {}),
    ...(record.activeTurnStartedAt ? { activeTurnStartedAt: isoDate(record.activeTurnStartedAt, "activeTurnStartedAt") } : {}),
    ...(record.activeTurnId ? { activeTurnId: bounded(record.activeTurnId, "activeTurnId") } : {}),
    ...(record.activeInputId ? { activeInputId: bounded(record.activeInputId, "activeInputId") } : {}),
    generationId: record.generationId === undefined ? "legacy" : bounded(record.generationId, "generationId"),
    attempts,
    state,
    ...(record.nextAttemptAt ? { nextAttemptAt: isoDate(record.nextAttemptAt, "nextAttemptAt") } : {}),
    ...(record.lastError ? { lastError: bounded(record.lastError, "lastError") } : {}),
    ...(record.notifiedAt ? { notifiedAt: isoDate(record.notifiedAt, "notifiedAt") } : {}),
  };
}

function parseQuotaRecovery(value: unknown): QuotaRecoveryRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const evidence = normalizeQuotaRecoveryEvidence(record.evidence);
  if (!evidence || !["waiting", "dispatching", "accepted", "held", "exhausted"].includes(String(record.state))) return undefined;
  if (!Array.isArray(record.candidateModels) || !record.candidateModels.length || record.candidateModels.length > 9
    || !record.candidateModels.every((item) => typeof item === "string" && item.startsWith("omniroute/"))) return undefined;
  const candidateIndex = nonNegativeInteger(record.candidateIndex, -1);
  const attempts = nonNegativeInteger(record.attempts, -1);
  const revision = positiveInteger(record.revision, -1);
  if (candidateIndex < 0 || candidateIndex >= record.candidateModels.length || attempts < 0 || revision < 1) return undefined;
  const reasonCode = ["quota_waiting", "quota_probe_due", "dispatching", "delivery_unknown", "model_unavailable", "candidate_exhausted", "recovery_disabled", "native_snapshot_changed", "human_stop_active"].includes(String(record.reasonCode))
    ? record.reasonCode as QuotaRecoveryRecord["reasonCode"] : undefined;
  return {
    evidence,
    state: record.state as QuotaRecoveryState,
    nextAttemptAt: isoDate(record.nextAttemptAt, "quotaRecovery.nextAttemptAt"),
    candidateModels: record.candidateModels.map((item) => bounded(item as string, "quotaRecovery.candidateModel")),
    candidateIndex,
    attempts,
    revision,
    ...(typeof record.selectedModel === "string" ? { selectedModel: bounded(record.selectedModel, "quotaRecovery.selectedModel") } : {}),
    ...(typeof record.dispatchInputId === "string" ? { dispatchInputId: bounded(record.dispatchInputId, "quotaRecovery.dispatchInputId") } : {}),
    ...(typeof record.dispatchNativeInputId === "string" ? { dispatchNativeInputId: bounded(record.dispatchNativeInputId, "quotaRecovery.dispatchNativeInputId") } : {}),
    ...(typeof record.dispatchTurnId === "string" ? { dispatchTurnId: bounded(record.dispatchTurnId, "quotaRecovery.dispatchTurnId") } : {}),
    ...(typeof record.claimedAt === "string" ? { claimedAt: isoDate(record.claimedAt, "quotaRecovery.claimedAt") } : {}),
    updatedAt: isoDate(record.updatedAt, "quotaRecovery.updatedAt"),
    ...(reasonCode ? { reasonCode } : {}),
  };
}

function parseQuotaRecoveryHistoryEntry(value: unknown): QuotaRecoveryHistoryEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const quotaRecovery = parseQuotaRecovery(item.quotaRecovery);
  if (!quotaRecovery) return undefined;
  const admissionPhase = item.admissionPhase === "accepted_pending" || item.admissionPhase === "in_progress" || item.admissionPhase === "terminal_observed"
    ? item.admissionPhase : undefined;
  const terminalReason = item.terminalReason === "turn.completed" || item.terminalReason === "turn.failed" ? item.terminalReason : undefined;
  return {
    quotaRecovery,
    ...(item.acceptedAt ? { acceptedAt: isoDate(item.acceptedAt, "quotaRecoveryHistory.acceptedAt") } : {}),
    ...(admissionPhase ? { admissionPhase } : {}),
    ...(terminalReason ? { terminalReason } : {}),
    ...(item.terminalObservedAt ? { terminalObservedAt: isoDate(item.terminalObservedAt, "quotaRecoveryHistory.terminalObservedAt") } : {}),
  };
}

function cloneQuotaRecovery(record: QuotaRecoveryRecord): QuotaRecoveryRecord {
  return { ...record, evidence: { ...record.evidence }, candidateModels: [...record.candidateModels] };
}

function cloneUnfinishedSessionRecord(record: UnfinishedSessionRecord): UnfinishedSessionRecord {
  return {
    ...record,
    ...(record.quotaRecovery ? { quotaRecovery: cloneQuotaRecovery(record.quotaRecovery) } : {}),
    ...(record.quotaRecoveryHistory ? { quotaRecoveryHistory: record.quotaRecoveryHistory.map((entry) => ({ ...entry, quotaRecovery: cloneQuotaRecovery(entry.quotaRecovery) })) } : {}),
  };
}

function normalizeRecordTarget(input: { harness: HarnessType; sessionId: string; cwd: string; model?: string; title?: string; threadSource?: string }) {
  return {
    harness: input.harness,
    sessionId: bounded(input.sessionId, "sessionId"),
    cwd: normalize(bounded(input.cwd, "cwd")),
    ...(input.model ? { model: bounded(input.model, "model") } : {}),
    ...(input.title ? { title: bounded(input.title, "title") } : {}),
    ...(input.threadSource ? { threadSource: bounded(input.threadSource, "threadSource") } : {}),
  };
}

function isSupportedHarness(value: string): value is HarnessType {
  return (SUPPORTED_HARNESSES as readonly string[]).includes(value);
}

function isInventoryHarness(value: unknown): value is UnfinishedSessionInventoryRecord["harness"] {
  return value === "codex" || value === "zcode" || value === "opencode" || value === "fast-agent";
}

function isAutocontinueInventoryHarness(value: unknown): value is "codex" | "zcode" {
  return value === "codex" || value === "zcode";
}

function harnessType(value: unknown): HarnessType {
  if (typeof value !== "string" || !isSupportedHarness(value)) throw new Error("unsupported unfinished-session harness");
  return value;
}

function sessionKey(harness: HarnessType, sessionId: string, workspaceIdentity?: string): string {
  const base = `${harness}:${bounded(sessionId, "sessionId")}`;
  return workspaceIdentity ? `${base}:${normalize(bounded(workspaceIdentity, "workspaceIdentity"))}` : base;
}

function resolveSessionOverride(
  records: SessionAutostartOverride[],
  canonicalCwd: string,
): SessionAutostartOverride | undefined {
  if (records.length === 0) return undefined;
  const newestTimestamp = Math.max(...records.map((record) => Date.parse(record.updatedAt)));
  const newest = records.filter((record) => Date.parse(record.updatedAt) === newestTimestamp);
  // Recency is authoritative. At an exact timestamp tie, opt-out is the safe
  // fallback; otherwise prefer the canonical row over a stale cwd alias.
  return newest.find((record) => !record.enabled)
    ?? newest.find((record) => normalize(record.cwd) === normalize(canonicalCwd))
    ?? newest[0];
}

function sessionWorkspaceIdentity(session: Pick<AgentSession, "cwd" | "meta">): string {
  const configured = session.meta?.workspaceIdentity;
  return normalize(typeof configured === "string" && configured.trim() ? configured : session.cwd);
}

function hasPendingNativePermission(session: AgentSession | null): boolean {
  return Boolean(session && (session.needsPermission
    || (Array.isArray(session.meta?.pendingRequestIds)
      && session.meta.pendingRequestIds.some((value) => typeof value === "string" && value.trim().length > 0))));
}

function sessionSourceKey(session: Pick<AgentSession, "harness" | "id" | "cwd" | "meta">): string {
  return sessionKey(harnessType(session.harness), session.id, sessionWorkspaceIdentity(session));
}

function assessmentCohortId(session: Pick<AgentSession, "harness" | "cwd" | "meta">): string {
  return createHash("sha256")
    .update(`${harnessType(session.harness)}:${sessionWorkspaceIdentity(session)}`)
    .digest("hex")
    .slice(0, 32);
}

function unfinishedRecordKey(record: Pick<UnfinishedSessionRecord, "harness" | "sessionId" | "cwd" | "workspaceIdentity">): string {
  return sessionKey(record.harness, record.sessionId, record.workspaceIdentity || record.cwd);
}

function inventoryRecordKey(record: Pick<UnfinishedSessionInventoryRecord, "harness" | "sessionId" | "cwd" | "workspaceIdentity">): string {
  return sessionKey(harnessType(record.harness), record.sessionId, record.workspaceIdentity || record.cwd);
}

function findUnfinishedRecord(
  records: UnfinishedSessionRecord[],
  harness: HarnessType,
  sessionId: string,
  workspaceIdentity?: string,
): UnfinishedSessionRecord | undefined {
  if (workspaceIdentity) {
    const key = sessionKey(harness, sessionId, workspaceIdentity);
    return records.find((candidate) => unfinishedRecordKey(candidate) === key);
  }
  return records.find((candidate) => candidate.harness === harness && candidate.sessionId === sessionId);
}

function mergeUnfinishedIdentityRecords(
  records: UnfinishedSessionRecord[],
  session: AgentSession,
  workspaceIdentity: string,
): UnfinishedSessionRecord {
  const safetyRank = (record: UnfinishedSessionRecord): number => record.nonRetryableAdmission ? 5
    : record.deliveryPending ? 4
      : record.acceptedAt ? 3
        : record.state === "exhausted" ? 2
          : record.state === "recovering" ? 1 : 0;
  const winner = [...records].sort((left, right) => safetyRank(right) - safetyRank(left)
    || Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0]!;
  const admission = [...records].filter((record) => record.acceptedAt)
    .sort((left, right) => Date.parse(right.acceptedAt!) - Date.parse(left.acceptedAt!))[0];
  const latest = [...records].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0]!;
  const state: UnfinishedSessionState = records.some((record) => record.nonRetryableAdmission)
    ? "active"
    : records.some((record) => record.state === "exhausted") ? "exhausted"
      : records.some((record) => record.state === "recovering") ? "recovering" : "active";
  return {
    ...winner,
    harness: harnessType(session.harness),
    sessionId: session.id,
    cwd: normalize(session.cwd),
    workspaceIdentity,
    model: session.model || winner.model,
    title: session.title || winner.title,
    startedAt: new Date(Math.min(...records.map((record) => Date.parse(record.startedAt)))).toISOString(),
    updatedAt: latest.updatedAt,
    generationId: latest.generationId,
    attempts: Math.max(...records.map((record) => record.attempts)),
    state,
    ...(admission?.acceptedAt ? {
      acceptedAt: admission.acceptedAt,
      ...(admission.acceptedFingerprint ? { acceptedFingerprint: admission.acceptedFingerprint } : {}),
      ...(admission.progressObservedAt ? { progressObservedAt: admission.progressObservedAt } : {}),
      ...(admission.deliveryPending ? { deliveryPending: true } : {}),
      ...(admission.admissionPhase ? { admissionPhase: admission.admissionPhase } : {}),
      ...(admission.lastProgressFingerprint ? { lastProgressFingerprint: admission.lastProgressFingerprint } : {}),
      ...(admission.lastNativeProgressAt ? { lastNativeProgressAt: admission.lastNativeProgressAt } : {}),
      ...(admission.terminalReason ? { terminalReason: admission.terminalReason } : {}),
      ...(admission.terminalObservedAt ? { terminalObservedAt: admission.terminalObservedAt } : {}),
      ...(admission.terminalRetryCount !== undefined ? { terminalRetryCount: admission.terminalRetryCount } : {}),
      ...(admission.terminalAssistantObserved ? { terminalAssistantObserved: true } : {}),
    } : {}),
  };
}

function mergeInventoryIdentityRecords(
  records: UnfinishedSessionInventoryRecord[],
  session: AgentSession,
  workspaceIdentity: string,
): UnfinishedSessionInventoryRecord {
  const winner = [...records].sort((left, right) => Number(evidenceIsCurrent(right)) - Number(evidenceIsCurrent(left))
    || Date.parse(right.observedAt) - Date.parse(left.observedAt))[0]!;
  const rewritten: UnfinishedSessionInventoryRecord = {
    ...winner,
    harness: session.harness as "codex" | "zcode",
    sessionId: session.id,
    cwd: normalize(session.cwd),
    workspaceIdentity,
    title: session.title,
    status: session.status,
    lastActivity: session.lastActivity,
    progressFingerprint: sessionInventoryProgressFingerprint(session),
    // Evidence and verdict describe the old identity. Carrying them across a
    // cwd/workspace rewrite could settle a canonical unfinished task as the
    // completed ghost, so force one canonical transcript read and replan.
    transcriptTail: "",
    observedAt: new Date().toISOString(),
  };
  delete rewritten.evidenceVersion;
  delete rewritten.evidenceFingerprint;
  delete rewritten.verdict;
  return rewritten;
}

function sortRecords(records: UnfinishedSessionRecord[]): void {
  records.sort((left, right) => unfinishedRecordKey(left).localeCompare(unfinishedRecordKey(right)));
}

function bounded(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT) throw new Error(`${label} must be bounded non-empty text`);
  return value.trim();
}

function boundedText(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > max) {
    throw new Error(`${label} must be bounded text`);
  }
  return value.trim();
}

function normalizeVerdict(value: unknown): Omit<SessionInventoryVerdict, "judgedAt"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MiniMax returned an invalid verdict");
  const record = value as Record<string, unknown>;
  if (record.verdict !== "completed" && record.verdict !== "unfinished" && record.verdict !== "needs_human") {
    throw new Error("MiniMax returned an unknown verdict");
  }
  if (typeof record.confidence !== "number" || !Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) {
    throw new Error("MiniMax returned an invalid confidence");
  }
  return {
    verdict: record.verdict,
    reason: boundedText(record.reason, "reason", MAX_TEXT),
    confidence: record.confidence,
  };
}

function mergePlanGroups(groups: SessionBatchPlanGroup[]): SessionBatchPlanGroup[] {
  const merged = new Map<string, SessionBatchPlanGroup>();
  // A human requirement is a hard safety gate for the whole semantic task.
  // Reconciliation may join it with an unfinished sibling; that cluster must
  // remain blocked rather than inheriting the runnable verdict. A zero-
  // confidence needs_human result is only an inconclusive retry marker and
  // must not block a positive unfinished assessment.
  const verdictRank = (group: SessionBatchPlanGroup): number => group.verdict === "needs_human"
    ? group.confidence > 0 ? 3 : 1
    : group.verdict === "unfinished" ? 2 : 0;
  const combineText = (left: string, right: string, separator: string, max: number): string => {
    if (!right || left === right || left.includes(right)) return left.slice(0, max);
    if (!left || right.includes(left)) return right.slice(0, max);
    return `${left}${separator}${right}`.slice(0, max);
  };

  for (const group of groups) {
    const topic = cleanPlanTopic(group.topic).slice(0, 120);
    const key = topic.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...group, topic, sourceSessionIds: [...group.sourceSessionIds] });
      continue;
    }
    const sourceSessionIds = [...new Set([...current.sourceSessionIds, ...group.sourceSessionIds])];
    const stronger = verdictRank(group) > verdictRank(current) ? group : current;
    const supportingChosenVerdict = [current, group].filter((candidate) => candidate.verdict === stronger.verdict
      && (stronger.verdict !== "needs_human"
        || (candidate.confidence > 0) === (stronger.confidence > 0)));
    merged.set(key, {
      ...current,
      sourceSessionIds,
      primarySessionId: sourceSessionIds.includes(stronger.primarySessionId) ? stronger.primarySessionId : sourceSessionIds[0],
      verdict: stronger.verdict,
      reason: combineText(current.reason, group.reason, "; ", MAX_TEXT),
      confidence: Math.max(...supportingChosenVerdict.map(({ confidence }) => confidence)),
      topic,
      handoff: combineText(current.handoff, group.handoff, "\n\n--- ДОПОЛНЕНИЕ ИЗ ДУБЛЯ ---\n\n", 32_000),
    });
  }
  return [...merged.values()];
}

/** Normalize injected/test judges and legacy judge implementations to the same workspace-qualified keys. */
function canonicalizePlanSourceKeys(plan: SessionBatchPlan, candidates: AssessedSession[]): SessionBatchPlan {
  const known = new Set(candidates.map((candidate) => candidate.sourceKey));
  const byNativeId = new Map<string, string[]>();
  for (const candidate of candidates) {
    const keys = byNativeId.get(candidate.session.id) ?? [];
    keys.push(candidate.sourceKey);
    byNativeId.set(candidate.session.id, keys);
  }
  const resolve = (value: string): string => {
    if (known.has(value)) return value;
    const matches = byNativeId.get(value) ?? [];
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new BatchPlanValidationError(`planner returned ambiguous workspace-free session ${value}`);
    throw new BatchPlanValidationError(`planner returned unknown session ${value}`);
  };
  return {
    groups: plan.groups.map((group) => {
      const sourceSessionIds = group.sourceSessionIds.map(resolve);
      if (new Set(sourceSessionIds).size !== sourceSessionIds.length) {
        throw new BatchPlanValidationError("planner assigned the same session more than once inside a group");
      }
      const requestedPrimary = resolve(group.primarySessionId);
      if (!sourceSessionIds.includes(requestedPrimary)) throw new BatchPlanValidationError("planner primary is outside its group sources");
      return {
        ...group,
        sourceSessionIds,
        primarySessionId: requestedPrimary,
      };
    }),
  };
}

function missingBatchPlanCandidates(plan: SessionBatchPlan, candidates: AssessedSession[]): AssessedSession[] {
  const expected = new Set(candidates.map((candidate) => candidate.sourceKey));
  const seen = new Set<string>();
  for (const [index, group] of plan.groups.entries()) {
    if (group.sourceSessionIds.length === 0) throw new BatchPlanValidationError(`MiniMax batch group ${index} has no sessions`);
    if (!group.sourceSessionIds.includes(group.primarySessionId)) {
      throw new BatchPlanValidationError(`MiniMax batch group ${index} primary is outside its sources`);
    }
    for (const sourceKey of group.sourceSessionIds) {
      if (!expected.has(sourceKey)) throw new BatchPlanValidationError(`MiniMax batch plan contains unknown session ${sourceKey}`);
      if (seen.has(sourceKey)) throw new BatchPlanValidationError(`MiniMax batch plan assigned session more than once: ${sourceKey}`);
      seen.add(sourceKey);
    }
  }
  return candidates.filter((candidate) => !seen.has(candidate.sourceKey));
}

function assertBatchPlanCoverage(plan: SessionBatchPlan, candidates: AssessedSession[]): void {
  const missing = missingBatchPlanCandidates(plan, candidates);
  if (missing.length > 0) {
    throw new BatchPlanValidationError(`MiniMax batch plan omitted ${missing.length} assessed session(s): ${missing.slice(0, 3).map((candidate) => candidate.sourceKey).join(", ")}`);
  }
}

function batchReconciliationCandidates(
  plan: SessionBatchPlan,
  candidates: AssessedSession[],
): SessionBatchReconciliationCandidate[] {
  const byId = new Map(candidates.map((candidate) => [candidate.sourceKey, candidate]));
  return plan.groups.map((group, index) => {
    const members = group.sourceSessionIds.map((sourceKey) => byId.get(sourceKey)!);
    const workspaces = [...new Set(members.map(({ session }) => sessionWorkspaceIdentity(session)))];
    if (workspaces.length !== 1) throw new Error(`MiniMax chunk group ${index} crosses workspace boundaries`);
    return {
      groupRef: `G${index + 1}`,
      workspaceIdentity: workspaces[0]!,
      topic: group.topic.slice(0, 96),
      verdict: group.verdict,
      reason: group.reason.slice(0, 64),
      handoff: group.handoff.slice(0, 128),
      sourceSessionIds: [...group.sourceSessionIds],
      memberTitles: members.map(({ session }) => session.title.slice(0, 80)),
      humanGate: members.some(({ session }) => session.status === "needs_input" || session.needsPermission),
    };
  });
}

function applyBatchReconciliation(
  plan: SessionBatchPlan,
  candidates: SessionBatchReconciliationCandidate[],
  reconciliation: SessionBatchReconciliation,
): SessionBatchPlan {
  const byRef = new Map(candidates.map((candidate, index) => [candidate.groupRef, { candidate, group: plan.groups[index]! }]));
  const seen = new Set<string>();
  const groups = reconciliation.clusters.map((cluster, index): SessionBatchPlanGroup => {
    if (!Array.isArray(cluster) || cluster.length === 0) throw new Error(`MiniMax reconciliation cluster ${index} is empty`);
    const entries = cluster.map((groupRef) => {
      const entry = byRef.get(groupRef);
      if (!entry) throw new Error(`MiniMax reconciliation returned unknown group ${groupRef}`);
      if (seen.has(groupRef)) throw new Error(`MiniMax reconciliation repeated group ${groupRef}`);
      seen.add(groupRef);
      return entry;
    });
    const workspaces = new Set(entries.map(({ candidate }) => candidate.workspaceIdentity));
    if (workspaces.size !== 1) throw new Error(`MiniMax reconciliation cluster ${index} crosses workspace boundaries`);
    const topic = entries[0]!.group.topic;
    return mergePlanGroups(entries.map(({ group }) => ({ ...group, topic })))[0]!;
  });
  const missing = candidates.filter(({ groupRef }) => !seen.has(groupRef));
  if (missing.length > 0) throw new Error(`MiniMax reconciliation omitted ${missing.length} chunk group(s)`);
  return { groups };
}

function normalizeBatchPlan(value: unknown, candidates: SessionBatchCandidate[]): SessionBatchPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MiniMax returned an invalid batch plan");
  const rawGroups = (value as Record<string, unknown>).groups;
  if (!Array.isArray(rawGroups)) throw new Error("MiniMax batch plan has no groups");
  const known = new Set(candidates.map(({ session }) => sessionSourceKey(session)));
  const aliases = new Map(candidates.map(({ session }, index) => [`S${index + 1}`, sessionSourceKey(session)]));
  const idAliases = new Map<string, string[]>();
  for (const { session } of candidates) {
    const ids = idAliases.get(session.id) ?? [];
    ids.push(sessionSourceKey(session));
    idAliases.set(session.id, ids);
  }
  const resolveId = (value: unknown, field: string): string => {
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      if (value >= 1 && value <= candidates.length) return sessionSourceKey(candidates[value - 1]!.session);
      throw new Error(`MiniMax returned out-of-range numeric session ${value}`);
    }
    const raw = boundedText(value, field, 128);
    const alias = aliases.get(raw);
    if (alias) return alias;
    const matches = idAliases.get(raw) ?? [];
    if (/^[1-9]\d*$/.test(raw)) {
      const numericPosition = Number(raw);
      if (Number.isSafeInteger(numericPosition) && numericPosition >= 1 && numericPosition <= candidates.length) {
        const positionalTarget = sessionSourceKey(candidates[numericPosition - 1]!.session);
        const nativeMatches = [...(known.has(raw) ? [raw] : []), ...matches];
        if (nativeMatches.length === 0 || nativeMatches.every((match) => match === positionalTarget)) return positionalTarget;
        throw new Error(`MiniMax returned ambiguous numeric session ${raw}`);
      }
    }
    if (known.has(raw)) return raw;
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new Error(`MiniMax returned ambiguous workspace-free session ${raw}`);
    return raw;
  };
  const preliminary = rawGroups.flatMap((value, index): SessionBatchPlanGroup[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`MiniMax returned invalid group ${index}`);
    const record = value as Record<string, unknown>;
    if (!Array.isArray(record.source_session_ids)) throw new Error(`MiniMax group ${index} has invalid sources`);
    if (record.source_session_ids.length === 0) return [];
    const sourceSessionIds = record.source_session_ids.map((id) => resolveId(id, "source_session_id"));
    if (new Set(sourceSessionIds).size !== sourceSessionIds.length) {
      throw new Error(`MiniMax group ${index} repeats a session`);
    }
    for (const id of sourceSessionIds) {
      if (!known.has(id)) throw new Error(`MiniMax grouped unknown session ${id}`);
    }
    const requestedPrimarySessionId = resolveId(record.primary_session_id, "primary_session_id");
    if (!sourceSessionIds.includes(requestedPrimarySessionId)) throw new Error(`MiniMax group ${index} primary is outside its sources`);
    const primarySessionId = requestedPrimarySessionId;
    let verdict = normalizeVerdict(record);
    const handoff = typeof record.handoff === "string" ? boundedText(record.handoff, "handoff", 32_000, true) : "";
    if (verdict.verdict === "unfinished" && !handoff) {
      verdict = {
        verdict: "needs_human",
        reason: "MiniMax не вернул объединённый handoff; группа будет повторно проверена в следующем цикле",
        confidence: 0,
      };
    }
    return [{
      sourceSessionIds,
      primarySessionId,
      ...verdict,
      topic: boundedText(record.topic, "topic", 120),
      handoff,
    }];
  });
  const assignment = new Set<string>();
  preliminary.forEach((group) => {
    for (const id of group.sourceSessionIds) {
      if (assignment.has(id)) throw new Error(`MiniMax assigned session more than once: ${id}`);
      assignment.add(id);
    }
  });
  return { groups: mergePlanGroups(preliminary) };
}

function normalizeBatchPlanText(content: string, candidates: SessionBatchCandidate[]): SessionBatchPlan {
  try {
    const json = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    return normalizeBatchPlan(JSON.parse(json) as unknown, candidates);
  } catch (error) {
    if (error instanceof BatchPlanValidationError) throw error;
    throw new BatchPlanValidationError(errorText(error));
  }
}

function batchReconciliationPrompt(): string {
  return [
    "Ты финальный дедупликатор уже проверенных групп Agent Herder.",
    "Сгруппируй group_ref одной и той же пользовательской задачи, даже если они пришли из разных batch chunks.",
    "Все группы этого запроса уже относятся к одному workspace; не изобретай внешние группы.",
    "human_gate — свойство участника задачи, а не отдельная задача: сохрани его в одном кластере с sibling той же работы.",
    "Каждый входной group_ref должен встретиться ровно один раз.",
    "Верни только компактный JSON {clusters:[[\"G1\",\"G2\"],[\"G3\"]]}; не повторяй summaries, handoff или причины.",
  ].join(" ");
}

function batchReconciliationPayload(groups: SessionBatchReconciliationCandidate[]): unknown {
  return {
    groups: groups.map((group) => ({
      group_ref: group.groupRef,
      topic: group.topic,
      verdict: group.verdict,
      reason: group.reason,
      handoff: group.handoff,
      member_titles: group.memberTitles,
      human_gate: group.humanGate,
    })),
  };
}

function partitionBatchCandidates<T extends SessionBatchCandidate>(
  sessions: T[],
  maxSessions = batchPlanChunkSize(),
): T[][] {
  const byWorkspace = new Map<string, T[]>();
  for (const candidate of sessions) {
    const workspace = sessionWorkspaceIdentity(candidate.session);
    const grouped = byWorkspace.get(workspace) ?? [];
    grouped.push(candidate);
    byWorkspace.set(workspace, grouped);
  }
  const chunks: T[][] = [];
  for (const grouped of byWorkspace.values()) {
    for (let offset = 0; offset < grouped.length; offset += maxSessions) {
      chunks.push(grouped.slice(offset, offset + maxSessions));
    }
  }
  return chunks;
}

function configuredBatchOutputTokens(): number {
  return Math.min(
    positiveInteger(
      Number(process.env.AGENT_HERDER_UNFINISHED_BATCH_MAX_TOKENS || DEFAULT_BATCH_OUTPUT_TOKENS),
      DEFAULT_BATCH_OUTPUT_TOKENS,
    ),
    DEFAULT_BATCH_OUTPUT_TOKENS,
  );
}

export function batchPlanChunkSize(outputTokens = configuredBatchOutputTokens()): number {
  const configuredSessionCap = positiveInteger(
    Number(process.env.AGENT_HERDER_UNFINISHED_BATCH_SESSIONS_PER_REQUEST || MAX_BATCH_PLAN_SESSIONS_PER_REQUEST),
    MAX_BATCH_PLAN_SESSIONS_PER_REQUEST,
  );
  return Math.max(1, Math.min(
    MAX_BATCH_PLAN_SESSIONS_PER_REQUEST,
    configuredSessionCap,
    Math.floor(outputTokens / 512),
  ));
}

/** Conservative common envelope used only to reserve the shared wire-input budget. */
function buildBatchPlannerBudgetRequest(
  sessions: SessionBatchCandidate[],
  maxTokens = configuredBatchOutputTokens(),
): unknown {
  return {
    model: "m".repeat(256),
    max_tokens: maxTokens,
    temperature: 0,
    stream: true,
    response_format: { type: "json_object" },
    output_config: { effort: "low" },
    system: [{ type: "text", text: batchPlannerPrompt(), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: JSON.stringify({
      ...batchPlannerPayload(sessions) as object,
      user_style: { revision: Number.MAX_SAFE_INTEGER, summary: "я".repeat(2400) },
      style_learning_messages: sessions.flatMap(s => s.humanMessages ?? []).slice(-8).map(m => m.text.slice(0, 1200)),
    }) }],
  };
}

/**
 * The single reserved wire-input envelope for one planning phase. Both the
 * per-cycle window bound and the real context fit must measure exactly this
 * object, otherwise the bound reserves less than the phase actually spends.
 */
function batchPlannerBudgetRequests(
  sessions: SessionBatchCandidate[],
  chunkSize: number,
  outputTokenBudget: number,
): unknown {
  const chunks = partitionBatchCandidates(sessions, chunkSize);
  return {
    chunkRequests: chunks.map((chunk) => buildBatchPlannerBudgetRequest(chunk, outputTokenBudget)),
    // Reserve one bounded repair pass for every chunk before the first fetch.
    // A malformed or incomplete result retries the entire chunk and discards
    // the first result, so the repair envelope must be the same full request.
    repairRequests: largestBatchPlannerBudgetRequests(chunks, MAX_REPAIRED_CHUNKS, outputTokenBudget),
    // Persistent omissions are globally capped. Reserve exactly the four
    // largest possible decide envelopes rather than multiplying evidence by
    // every source in a large 48-hour inventory.
    decisionRequests: largestSessionDecisionBudgetRequests(sessions, MAX_PERSISTENT_OMISSION_DECISIONS),
    reconciliationRequests: worstCaseWorkspaceReconciliationBudgetRequests(sessions),
  };
}

function largestBatchPlannerBudgetRequests(
  chunks: SessionBatchCandidate[][],
  limit: number,
  maxTokens = configuredBatchOutputTokens(),
): unknown[] {
  return chunks
    .map((chunk) => {
      const request = buildBatchPlannerBudgetRequest(chunk, maxTokens);
      return { request, tokens: estimateContextTokens(JSON.stringify(request)) };
    })
    .sort((left, right) => right.tokens - left.tokens)
    .slice(0, limit)
    .map(({ request }) => request);
}

/** Superset of the OpenAI and Anthropic per-session judge wire envelopes. */
function buildSessionDecisionBudgetRequest({ session, transcriptTail }: SessionBatchCandidate): unknown {
  const conservativeSystem = "я".repeat(1_000);
  const payload = JSON.stringify({
    session: {
      harness: session.harness,
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      status_signal: session.status,
      last_activity: session.lastActivity,
      needs_permission: session.needsPermission,
    },
    transcript_tail: transcriptTail,
  });
  return {
    model: "m".repeat(256),
    max_tokens: 512,
    temperature: 0,
    stream: false,
    response_format: { type: "json_object" },
    output_config: { effort: "low" },
    system: [{ type: "text", text: conservativeSystem, cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "system", content: conservativeSystem },
      { role: "user", content: payload },
    ],
  };
}

function largestSessionDecisionBudgetRequests(sessions: SessionBatchCandidate[], limit: number): unknown[] {
  return sessions
    .map((candidate) => {
      const request = buildSessionDecisionBudgetRequest(candidate);
      return { request, tokens: estimateContextTokens(JSON.stringify(request)) };
    })
    .sort((left, right) => right.tokens - left.tokens)
    .slice(0, limit)
    .map(({ request }) => request);
}

function worstCaseReconciliationCandidates(sessions: SessionBatchCandidate[]): SessionBatchReconciliationCandidate[] {
  return sessions.map(({ session }, index) => ({
    groupRef: `G${index + 1}`,
    workspaceIdentity: sessionWorkspaceIdentity(session),
    topic: "я".repeat(96),
    verdict: "unfinished",
    reason: "я".repeat(64),
    handoff: "я".repeat(128),
    sourceSessionIds: [sessionSourceKey(session)],
    memberTitles: [session.title.slice(0, 80)],
    humanGate: session.status === "needs_input" || session.needsPermission,
  }));
}

function buildBatchReconciliationBudgetRequest(
  groups: SessionBatchReconciliationCandidate[],
  maxTokens = configuredBatchOutputTokens(),
): unknown {
  return {
    model: "m".repeat(256),
    max_tokens: maxTokens,
    temperature: 0,
    stream: true,
    response_format: { type: "json_object" },
    output_config: { effort: "low" },
    system: [{ type: "text", text: batchReconciliationPrompt(), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: JSON.stringify(batchReconciliationPayload(groups)) }],
  };
}

function worstCaseWorkspaceReconciliationBudgetRequests(sessions: SessionBatchCandidate[]): unknown[] {
  const byWorkspace = new Map<string, SessionBatchCandidate[]>();
  for (const candidate of sessions) {
    const workspace = sessionWorkspaceIdentity(candidate.session);
    const grouped = byWorkspace.get(workspace) ?? [];
    grouped.push(candidate);
    byWorkspace.set(workspace, grouped);
  }
  const mandatory: unknown[] = [];
  const optional: Array<{ request: unknown; tokens: number }> = [];
  for (const grouped of byWorkspace.values()) {
    const request = buildBatchReconciliationBudgetRequest(
      worstCaseReconciliationCandidates(grouped),
      configuredBatchOutputTokens(),
    );
    if (partitionBatchCandidates(grouped).length > 1) {
      mandatory.push(request, request);
    } else {
      optional.push({ request, tokens: estimateContextTokens(JSON.stringify(request)) });
    }
  }
  const repairEligible = optional
    .sort((left, right) => right.tokens - left.tokens)
    .slice(0, MAX_REPAIRED_CHUNKS)
    .flatMap(({ request }) => [request, request]);
  return [...mandatory, ...repairEligible];
}

function normalizeBatchReconciliation(
  value: unknown,
  candidates: SessionBatchReconciliationCandidate[],
): SessionBatchReconciliation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MiniMax returned an invalid reconciliation");
  const rawClusters = (value as Record<string, unknown>).clusters;
  if (!Array.isArray(rawClusters)) throw new Error("MiniMax reconciliation has no clusters");
  const known = new Map(candidates.map((candidate) => [candidate.groupRef, candidate]));
  const seen = new Set<string>();
  const clusters = rawClusters.map((rawCluster, index): string[] => {
    if (!Array.isArray(rawCluster) || rawCluster.length === 0) throw new Error(`MiniMax reconciliation cluster ${index} is empty`);
    const cluster = rawCluster.map((value) => boundedText(value, "group_ref", 32));
    const workspaces = new Set(cluster.map((groupRef) => {
      const candidate = known.get(groupRef);
      if (!candidate) throw new Error(`MiniMax reconciliation returned unknown group ${groupRef}`);
      if (seen.has(groupRef)) throw new Error(`MiniMax reconciliation repeated group ${groupRef}`);
      seen.add(groupRef);
      return candidate.workspaceIdentity;
    }));
    if (workspaces.size !== 1) throw new Error(`MiniMax reconciliation cluster ${index} crosses workspace boundaries`);
    return cluster;
  });
  const missing = candidates.filter(({ groupRef }) => !seen.has(groupRef));
  if (missing.length > 0) throw new Error(`MiniMax reconciliation omitted ${missing.length} group(s)`);
  return { clusters };
}

function normalizeBatchReconciliationText(
  content: string,
  candidates: SessionBatchReconciliationCandidate[],
): SessionBatchReconciliation {
  try {
    const json = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    return normalizeBatchReconciliation(JSON.parse(json) as unknown, candidates);
  } catch (error) {
    if (error instanceof BatchReconciliationValidationError) throw error;
    throw new BatchReconciliationValidationError(errorText(error));
  }
}

function styleObservations(session: AgentSession, messages: SessionMessageView[]): StyleObservation[] {
  return messages.filter(message => message.role === "user").slice(-8).map(message => ({
    text: message.parts.filter(p => p.type === "text").map(p => p.text || "").join("\n") || message.text || "", harness: session.harness, sessionId: session.id,
  }));
}

function batchPlannerPrompt(): string {
  return [
    USER_STYLE_PROMPT,
    "Ты автопилот Agent Herder: доводи разрешённые задачи до проверенного результата в исходных сессиях.",
    "Если человек не выбрал следующий шаг, выбери сам наиболее полезный разрешённый шаг и выполни работу. Несколько разумных способов, обычные проверки или желание перестраховаться не означают needs_human. Наблюдение и отчёт не заменяют исправление, выполнение и проверку результата.",
    "needs_human допустим только для конкретного отсутствующего решения, доступа или полномочий, без которых полезная работа невозможна. Существующее поручение и полномочия действуют до результата; не требуй повторного согласования.",
    "Получаешь все доступные сессии 48-часового окна в одном общем пакете до безопасного потолка контекста.",
    "У каждой сессии обязательно сохранён первый пользовательский запрос как исходная цель и максимально полный свежий смысловой хвост без tool noise и скрытых рассуждений.",
    "Сгруппируй сессии одной и той же пользовательской задачи, даже если названия различаются; не объединяй просто похожие задачи.",
    "Никогда не объединяй session_ref из разных cwd: рабочий каталог — жёсткая граница задачи, даже если тема и заголовок одинаковы.",
    "Каждый входной session_ref должен встретиться ровно один раз в source_session_ids одной группы; возвращай короткие S1, S2 и т.д., не переписывай UUID.",
    "Для группы выбери primary_session_id из session_ref: работающую сессию, иначе самую новую и содержательную.",
    "verdict: completed, unfinished или needs_human. Если хотя бы одна сессия группы ещё реально выполняется, verdict=unfinished.",
    "confidence — обязательное JSON-число от 0 до 1 включительно (например 0.95), не процент и не строка; reason, topic и handoff — строки.",
    "completed допустим только когда исходная пользовательская цель явно достигнута и финальный ответ содержит проверяемый результат; обещание продолжить, незавершённые пункты или ошибки инструментов означают unfinished.",
    REQUESTED_ARTIFACT_COMPLETION_RULE,
    "topic — понятная русская тема из 3-8 слов без UUID, Auto Continue и технического мусора.",
    "handoff для unfinished — единая краткая сводка всех сессий группы: цель, уже сделано, решения, файлы/проверки, осталось, риски, следующий шаг.",
    "Не выполняй задачи и не добавляй факты. Верни только JSON {groups:[{source_session_ids,primary_session_id,verdict,reason,confidence,topic,handoff}],predicted_user_request:string,user_style_update?:string}. Прогноз и обновление стиля относятся ко всему ответу; handoff каждой группы сохраняет только её собственную задачу.",
  ].join(" ");
}

function batchPlannerPayload(sessions: SessionBatchCandidate[]): unknown {
  return {
    sessions: sessions.map(({ session, transcriptTail }, index) => ({
      session_ref: `S${index + 1}`,
      harness: session.harness,
      title: session.title,
      cwd: session.cwd,
      workspace_identity: sessionWorkspaceIdentity(session),
      model: session.model,
      status_signal: session.status,
      last_activity: session.lastActivity,
      needs_permission: session.needsPermission,
      semantic_context: transcriptTail,
    })),
  };
}

/** Conservative MiniMax-oriented estimate: non-ASCII text is budgeted as one token per character. */
export function estimateContextTokens(value: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of value) {
    if (char.charCodeAt(0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 3) + nonAscii;
}

/** Includes the system prompt, serialized payload, and a conservative request-format reserve. */
export function estimateBatchPlannerInputTokens(sessions: SessionBatchCandidate[]): number {
  return estimateContextTokens(batchPlannerPrompt())
    + estimateContextTokens(JSON.stringify(batchPlannerPayload(sessions)))
    + 512;
}

/** Fairly pack every candidate under one shared context ceiling while preserving goal + recent tail. */
export function fitBatchContext(
  sessions: SessionBatchCandidate[],
  tokenBudget = DEFAULT_BATCH_CONTEXT_TOKEN_BUDGET,
): SessionBatchCandidate[] {
  if (sessions.length === 0) return [];
  const metadataOnly = sessions.map((candidate) => ({ ...candidate, transcriptTail: "" }));
  const fixedTokens = estimateBatchPlannerInputTokens(metadataOnly);
  if (fixedTokens > tokenBudget) {
    throw new Error(`MiniMax batch metadata needs ${fixedTokens} input tokens, above the ${tokenBudget} token ceiling`);
  }
  const available = tokenBudget - fixedTokens;
  const sizes = sessions.map((candidate) => estimateContextTokens(candidate.transcriptTail));
  let low = 0;
  let high = Math.max(...sizes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const total = sizes.reduce((sum, size) => sum + Math.min(size, middle), 0);
    if (total <= available) low = middle;
    else high = middle - 1;
  }
  const perSessionCap = low;
  return sessions.map((candidate, index) => ({
    ...candidate,
    transcriptTail: sizes[index]! <= perSessionCap
      ? candidate.transcriptTail
      : trimEvidenceTokens(candidate.transcriptTail, perSessionCap),
  }));
}

/** Fit against the exact JSON body sent on the wire, including nested escaping. */
export function fitBatchContextForSerializedRequest<T>(
  sessions: SessionBatchCandidate[],
  tokenBudget: number,
  buildRequest: (packed: SessionBatchCandidate[]) => T,
): { sessions: SessionBatchCandidate[]; request: T; estimatedTokens: number } {
  if (sessions.length === 0) {
    const request = buildRequest([]);
    return { sessions: [], request, estimatedTokens: estimateContextTokens(JSON.stringify(request)) };
  }
  const metadataOnly = sessions.map((candidate) => ({ ...candidate, transcriptTail: "" }));
  const fixedRequest = buildRequest(metadataOnly);
  const fixedTokens = estimateContextTokens(JSON.stringify(fixedRequest));
  if (fixedTokens > tokenBudget) {
    throw new Error(`MiniMax serialized batch metadata needs ${fixedTokens} input tokens, above the ${tokenBudget} token ceiling`);
  }
  const sizes = sessions.map((candidate) => estimateContextTokens(candidate.transcriptTail));
  const pack = (cap: number): SessionBatchCandidate[] => sessions.map((candidate, index) => ({
    ...candidate,
    transcriptTail: sizes[index]! <= cap ? candidate.transcriptTail : trimEvidenceTokens(candidate.transcriptTail, cap),
  }));
  const available = tokenBudget - fixedTokens;
  let low = 0;
  let high = Math.max(...sizes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const evidenceTokens = sizes.reduce((sum, size) => sum + Math.min(size, middle), 0);
    if (evidenceTokens <= available) low = middle;
    else high = middle - 1;
  }
  let cap = low;
  // Escaping overhead is measured from the real request, then corrected
  // proportionally. This converges in a few full serializations instead of
  // rebuilding every multi-megabyte candidate at each binary-search step.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const packed = pack(cap);
    const request = buildRequest(packed);
    const estimatedTokens = estimateContextTokens(JSON.stringify(request));
    if (estimatedTokens <= tokenBudget) return { sessions: packed, request, estimatedTokens };
    const actualEvidenceTokens = Math.max(1, estimatedTokens - fixedTokens);
    const nextCap = Math.max(0, Math.floor(cap * available / actualEvidenceTokens * 0.98));
    cap = nextCap < cap ? nextCap : Math.max(0, cap - 1);
  }
  const packed = pack(0);
  const request = buildRequest(packed);
  const estimatedTokens = estimateContextTokens(JSON.stringify(request));
  if (estimatedTokens > tokenBudget) throw new Error(`MiniMax serialized request exceeds the ${tokenBudget} token ceiling`);
  return { sessions: packed, request, estimatedTokens };
}

function trimEvidenceTokens(value: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (estimateContextTokens(value) <= maxTokens) return value;
  let maxChars = Math.max(1, Math.floor(value.length * maxTokens / estimateContextTokens(value)));
  let trimmed = trimEvidenceChars(value, maxChars);
  while (estimateContextTokens(trimmed) > maxTokens && maxChars > 1) {
    maxChars = Math.max(1, Math.floor(maxChars * 0.9));
    trimmed = trimEvidenceChars(value, maxChars);
  }
  while (estimateContextTokens(trimmed) > maxTokens && trimmed.length > 0) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

async function anthropicText(response: Response, request: JudgeRequestTrace): Promise<string> {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    const body = await request.json(response);
    const blocks = Array.isArray(body.content) ? body.content : [];
    const content = blocks.flatMap((block) => block && typeof block === "object"
      && (block as Record<string, unknown>).type === "text"
      && typeof (block as Record<string, unknown>).text === "string"
      ? [(block as Record<string, unknown>).text as string]
      : []).join("\n");
    if (content) return content;
    const stopReason = typeof body.stop_reason === "string" ? body.stop_reason : "unknown";
    const blockTypes = [...new Set(blocks.flatMap((block) => block && typeof block === "object" && typeof (block as Record<string, unknown>).type === "string"
      ? [(block as Record<string, unknown>).type as string] : []))].join(",") || "none";
    throw new BatchPlanValidationError(`MiniMax Anthropic batch planner returned no text content (stop=${stopReason}, blocks=${blockTypes})`);
  }
  if (!response.body) throw new BatchPlanValidationError("MiniMax Anthropic batch planner returned an empty stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const consume = (line: string): void => {
    if (!line.startsWith("data:")) return;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") return;
    let event: Record<string, unknown>;
    try { event = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (event.type === "error") throw request.providerFailure({ error: event.error || event });
    if (event.type === "content_block_start" && event.content_block && typeof event.content_block === "object") {
      const block = event.content_block as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") content += block.text;
    }
    if (event.type === "content_block_delta" && event.delta && typeof event.delta === "object") {
      const delta = event.delta as Record<string, unknown>;
      if (delta.type === "text_delta" && typeof delta.text === "string") content += delta.text;
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) consume(line);
    if (done) break;
  }
  if (buffer) consume(buffer);
  if (!content.trim()) throw new BatchPlanValidationError("MiniMax Anthropic batch planner returned no streamed text");
  return content;
}

async function mapConcurrentOrdered<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
  failureController?: AbortController,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (true) {
      if (failure !== undefined || failureController?.signal.aborted) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        results[index] = await mapper(values[index]!, index);
      } catch (error) {
        if (failure === undefined) {
          failure = error;
          failureController?.abort(error);
        }
        return;
      }
    }
  };
  await Promise.allSettled(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, () => worker()));
  if (failure !== undefined) throw failure;
  if (failureController?.signal.aborted) {
    throw failureController.signal.reason instanceof Error
      ? failureController.signal.reason
      : new Error("Concurrent operation aborted");
  }
  return results;
}

async function withAbortDeadline<T>(promise: Promise<T>, deadline: number, controller: AbortController): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    const error = new Error("MiniMax planner phase timed out");
    controller.abort(error);
    throw error;
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("MiniMax planner phase timed out");
      controller.abort(error);
      reject(error);
    }, remainingMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function judgeAbortSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function optionalBounded(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : bounded(value, label);
}

function isoDate(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function boundedInteger(value: unknown, min: number, max: number, field: string): number {
  const parsed = positiveInteger(value, -1);
  if (parsed < min || parsed > max) throw new Error(`${field} must be an integer from ${min} to ${max}`);
  return parsed;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function displayHarness(harness: HarnessType): string {
  return harness === "zcode" ? "ZCode"
    : harness === "codex" ? "Codex"
      : harness === "opencode" ? "OpenCode"
        : harness === "claude" ? "Claude"
          : harness === "qoder" ? "Qoder"
            : harness === "fast-agent" ? "Fast Agent"
              : harness === "chatgpt" ? "ChatGPT" : "Hermes";
}

export function createOpenAICompatibleSessionCompletionJudge(config: {
  styleStore?: UserStyleStore;
  baseUrl: string;
  model: string;
  token?: string;
  reasoningEffort?: "low" | "high" | "max";
  fetchImpl?: typeof fetch;
}): SessionCompletionJudge {
  const fetchImpl = config.fetchImpl ?? fetch;
  const styleStore = config.styleStore ?? new UserStyleStore();
  const endpoint = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  return {
    async decide({ session, transcriptTail, signal }) {
      const request = new JudgeRequestTrace({ model: config.model, endpoint, operation: "completion" });
      const response = await request.fetch(fetchImpl, endpoint, {
        method: "POST",
        headers: {
          ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
          "content-type": "application/json",
        },
        signal: judgeAbortSignal(signal, 35_000),
        body: JSON.stringify({
          model: config.model,
          max_tokens: 512,
          ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
          temperature: 0,
          stream: false,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: [
                "Ты классификатор незавершённых Codex и ZCode задач Agent Herder.",
                "Верни только JSON: {verdict:completed|unfinished|needs_human,reason:string,confidence:number}.",
                "completed — цель явно выполнена; unfinished — работа оборвана, идёт или остались конкретные действия; needs_human — нужен выбор, секрет или содержательный ответ человека.",
                REQUESTED_ARTIFACT_COMPLETION_RULE,
                "Статус БД — только слабый сигнал. Главный источник — первый пользовательский запрос и свежий смысловой хвост. При сомнении не выбирай completed.",
                "reason — одно короткое русское предложение, confidence — число от 0 до 1.",
              ].join(" "),
            },
            {
              role: "user",
              content: JSON.stringify({
                session: {
                  harness: session.harness,
                  id: session.id,
                  title: session.title,
                  cwd: session.cwd,
                  status_signal: session.status,
                  last_activity: session.lastActivity,
                  needs_permission: session.needsPermission,
                },
                transcript_tail: transcriptTail,
              }),
            },
          ],
        }),
      });
      if (!response.ok) throw new Error(`MiniMax judge rejected with HTTP ${response.status}`);
      const body = await request.json(response);
      const choices = Array.isArray(body.choices) ? body.choices : [];
      const message = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>).message : undefined;
      const content = message && typeof message === "object" ? (message as Record<string, unknown>).content : undefined;
      if (typeof content !== "string") throw new Error("MiniMax judge returned no content");
      const json = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      return normalizeVerdict(JSON.parse(json) as unknown);
    },
    async plan({ sessions, signal }) {
      const request = new JudgeRequestTrace({ model: config.model, endpoint, operation: "batch-plan" });
      const style = await styleStore.prepare(sessions.flatMap(s => s.humanMessages ?? []));
      const contextBudget = positiveInteger(
        Number(process.env.AGENT_HERDER_UNFINISHED_BATCH_CONTEXT_TOKENS || DEFAULT_BATCH_CONTEXT_TOKEN_BUDGET),
        DEFAULT_BATCH_CONTEXT_TOKEN_BUDGET,
      );
      const inputCeiling = Math.min(contextBudget, DEFAULT_BATCH_CONTEXT_TOKEN_BUDGET);
      const maxTokens = configuredBatchOutputTokens();
      const buildRequest = (packedSessions: SessionBatchCandidate[]) => ({
        model: config.model,
        max_tokens: maxTokens,
        ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
        temperature: 0,
        stream: false,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: batchPlannerPrompt() },
          { role: "user", content: JSON.stringify({ ...batchPlannerPayload(packedSessions) as object, ...styleStore.payload(style) }) },
        ],
      });
      const fitted = fitBatchContextForSerializedRequest(sessions, inputCeiling, buildRequest);
      const response = await request.fetch(fetchImpl, endpoint, {
        method: "POST",
        headers: {
          ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
          "content-type": "application/json",
        },
        signal: judgeAbortSignal(signal, positiveInteger(Number(process.env.AGENT_HERDER_UNFINISHED_BATCH_TIMEOUT_MS || 600_000), 600_000)),
        body: JSON.stringify(fitted.request),
      });
      if (!response.ok) throw new Error(`MiniMax batch planner rejected with HTTP ${response.status}`);
      const body = await request.json(response);
      const choices = Array.isArray(body.choices) ? body.choices : [];
      const message = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>).message : undefined;
      const content = message && typeof message === "object" ? (message as Record<string, unknown>).content : undefined;
      if (typeof content !== "string") throw new BatchPlanValidationError("MiniMax batch planner returned no content");
      const result = normalizeBatchPlanText(content, sessions);
      await styleStore.remember(style, JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")));
      return result;
    },
    async reconcile({ groups, signal }) {
      const request = new JudgeRequestTrace({ model: config.model, endpoint, operation: "batch-reconcile" });
      const response = await request.fetch(fetchImpl, endpoint, {
        method: "POST",
        headers: {
          ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
          "content-type": "application/json",
        },
        signal: judgeAbortSignal(signal, positiveInteger(Number(process.env.AGENT_HERDER_UNFINISHED_BATCH_TIMEOUT_MS || 600_000), 600_000)),
        body: JSON.stringify({
          model: config.model,
          max_tokens: configuredBatchOutputTokens(),
          ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
          temperature: 0,
          stream: false,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: batchReconciliationPrompt() },
            { role: "user", content: JSON.stringify(batchReconciliationPayload(groups)) },
          ],
        }),
      });
      if (!response.ok) throw new Error(`MiniMax reconciliation rejected with HTTP ${response.status}`);
      let body: Record<string, unknown>;
      try {
        body = await request.json(response);
      } catch (error) {
        if (error instanceof SyntaxError || (error instanceof JudgeRequestError && error.diagnostic.kind === "invalid_json")) throw new BatchReconciliationValidationError(`MiniMax reconciliation returned invalid JSON: ${error.message}`);
        throw error;
      }
      const choices = Array.isArray(body.choices) ? body.choices : [];
      const message = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>).message : undefined;
      const content = message && typeof message === "object" ? (message as Record<string, unknown>).content : undefined;
      if (typeof content !== "string") throw new BatchReconciliationValidationError("MiniMax reconciliation returned no content");
      return normalizeBatchReconciliationText(content, groups);
    },
  };
}

/** Direct MiniMax Anthropic-compatible judge with an explicit cached system prefix. */
export function createAnthropicCompatibleSessionCompletionJudge(config: {
  styleStore?: UserStyleStore;
  baseUrl: string;
  model: string;
  token: string;
  fetchImpl?: typeof fetch;
}): SessionCompletionJudge {
  const fetchImpl = config.fetchImpl ?? fetch;
  const styleStore = config.styleStore ?? new UserStyleStore();
  const endpoint = `${config.baseUrl.replace(/\/$/, "")}/v1/messages`;
  return {
    async decide({ session, transcriptTail, signal }) {
      const request = new JudgeRequestTrace({ model: config.model, endpoint, operation: "completion" });
      const response = await request.fetch(fetchImpl, endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        signal: judgeAbortSignal(signal, 35_000),
        body: JSON.stringify({
          model: config.model,
          max_tokens: 512,
          temperature: 0,
          system: [{
            type: "text",
            text: [
              "Ты классификатор незавершённых Codex и ZCode задач Agent Herder.",
              "Верни только JSON: {verdict:completed|unfinished|needs_human,reason:string,confidence:number}.",
              "completed — цель явно выполнена; unfinished — работа оборвана, идёт или остались конкретные действия; needs_human — нужен выбор, секрет или содержательный ответ человека.",
              REQUESTED_ARTIFACT_COMPLETION_RULE,
              "Статус БД — только слабый сигнал. Главный источник — первый пользовательский запрос и максимально полный свежий смысловой хвост. При сомнении не выбирай completed.",
              "reason — одно короткое русское предложение, confidence — число от 0 до 1.",
            ].join(" "),
            cache_control: { type: "ephemeral" },
          }],
          messages: [{
            role: "user",
            content: JSON.stringify({
              session: {
                harness: session.harness,
                id: session.id,
                title: session.title,
                cwd: session.cwd,
                status_signal: session.status,
                last_activity: session.lastActivity,
                needs_permission: session.needsPermission,
              },
              transcript_tail: transcriptTail,
            }),
          }],
        }),
      });
      if (!response.ok) throw new Error(`MiniMax Anthropic judge rejected with HTTP ${response.status}`);
      const body = await request.json(response);
      const blocks = Array.isArray(body.content) ? body.content : [];
      const content = blocks.flatMap((block) => block && typeof block === "object"
        && (block as Record<string, unknown>).type === "text"
        && typeof (block as Record<string, unknown>).text === "string"
        ? [(block as Record<string, unknown>).text as string]
        : []).join("\n");
      if (!content) throw new Error("MiniMax Anthropic judge returned no text content");
      const json = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      return normalizeVerdict(JSON.parse(json) as unknown);
    },
    async plan({ sessions, signal }) {
      const request = new JudgeRequestTrace({ model: config.model, endpoint, operation: "batch-plan" });
      const style = await styleStore.prepare(sessions.flatMap(s => s.humanMessages ?? []));
      const contextBudget = positiveInteger(
        Number(process.env.AGENT_HERDER_UNFINISHED_BATCH_CONTEXT_TOKENS || DEFAULT_BATCH_CONTEXT_TOKEN_BUDGET),
        DEFAULT_BATCH_CONTEXT_TOKEN_BUDGET,
      );
      const inputCeiling = Math.min(contextBudget, DEFAULT_BATCH_CONTEXT_TOKEN_BUDGET);
      const maxTokens = configuredBatchOutputTokens();
      const buildRequest = (packedSessions: SessionBatchCandidate[]) => ({
        model: config.model,
        max_tokens: maxTokens,
        temperature: 0,
        stream: true,
        output_config: { effort: "low" },
        system: [{ type: "text", text: batchPlannerPrompt(), cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: JSON.stringify({ ...batchPlannerPayload(packedSessions) as object, ...styleStore.payload(style) }) }],
      });
      const fitted = fitBatchContextForSerializedRequest(sessions, inputCeiling, buildRequest);
      const response = await request.fetch(fetchImpl, endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        signal: judgeAbortSignal(signal, positiveInteger(Number(process.env.AGENT_HERDER_UNFINISHED_BATCH_TIMEOUT_MS || 600_000), 600_000)),
        body: JSON.stringify(fitted.request),
      });
      if (!response.ok) throw new Error(`MiniMax Anthropic batch planner rejected with HTTP ${response.status}`);
      const content = await request.read(() => anthropicText(response, request));
      const result = normalizeBatchPlanText(content, sessions);
      await styleStore.remember(style, JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")));
      return result;
    },
    async reconcile({ groups, signal }) {
      const request = new JudgeRequestTrace({ model: config.model, endpoint, operation: "batch-reconcile" });
      const response = await request.fetch(fetchImpl, endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        signal: judgeAbortSignal(signal, positiveInteger(Number(process.env.AGENT_HERDER_UNFINISHED_BATCH_TIMEOUT_MS || 600_000), 600_000)),
        body: JSON.stringify({
          model: config.model,
          max_tokens: configuredBatchOutputTokens(),
          temperature: 0,
          stream: true,
          output_config: { effort: "low" },
          system: [{ type: "text", text: batchReconciliationPrompt(), cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: JSON.stringify(batchReconciliationPayload(groups)) }],
        }),
      });
      if (!response.ok) throw new Error(`MiniMax Anthropic reconciliation rejected with HTTP ${response.status}`);
      let content: string;
      try {
        content = await request.read(() => anthropicText(response, request));
      } catch (error) {
        if (error instanceof BatchPlanValidationError) throw new BatchReconciliationValidationError(errorText(error));
        if (error instanceof SyntaxError || (error instanceof JudgeRequestError && error.diagnostic.kind === "invalid_json")) throw new BatchReconciliationValidationError(`MiniMax reconciliation returned invalid JSON: ${error.message}`);
        throw error;
      }
      return normalizeBatchReconciliationText(content, groups);
    },
  };
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}
