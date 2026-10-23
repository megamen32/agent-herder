import type { BackgroundAutopilotStop } from "../autopilot/background-stop.js";
import type { AutopilotRunnerInput } from "../autopilot-runner.js";
import { projectSessionInventory } from "./session-inventory.js";
import { SessionImageStore } from "../session-images.js";
import { homedir, hostname, userInfo } from "node:os";
import { UserMessageDelivery, type UserMessageRoute } from "../user-message-delivery.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { HarnessType } from "session-convert";
import { LineageStore } from "../lineage-store.js";
import { SessionNotFoundError, SessionSupervisor } from "../session-supervisor.js";
import type { AgentSession, HarnessAdapter, SessionDetails } from "../types/index.js";
import type { AgentHerderSessionConverter, ConvertSessionInput } from "../session-convert.js";
import { askHuman, HumanRequestLockUnavailableError, HumanRequestRegistry, resumeHumanRequestOnce } from "../human-request/index.js";
import type { ProjectLaunchDispatcher } from "../automation/project-launch-dispatch.js";
import type { IntegratorFleetRuntime } from "../integrator-fleet-runtime.js";
import { NOTICEPLACE_HEALTH_AUTHORIZED, NOTICEPLACE_HEALTH_PURPOSE, hasNoticeplaceHealthBearer, qualifyNoticeplaceHealthModel, validateNoticeplaceHealthLaunch } from "../automation/noticeplace-health-launch.js";
import { buildSessionProgress } from "../health-progress.js";
import { buildIntegratorProgress } from "../integrator-progress.js";
import { deliverStaleRunningQuestion } from "../human-request/notice-question.js";
import { loadAskHumanProducer, type AskHumanProducer } from "../human-request/ask-human-producer.js";
import { NoticeplaceHealthObserver } from "../automation/noticeplace-health-observer.js";
import { appendHealthRefusalAudit, healthRefusalAuditPath, type HealthReasonRefusal } from "../automation/health-reason-codes.js";
import { NOTICEPLACE_HEALTH_MODELS, resolveLaunchHealthPlan } from "../automation/noticeplace-health-policy.js";
import { readArmedHealthCandidates, recoverNoticeplaceHealthObservation } from "../automation/noticeplace-health-recovery.js";
import { createMiniMaxQuotaPreflight } from "../automation/minimax-quota-preflight.js";
import { healthModelForHarness, normalizeHealthExecution } from "../health-remediation.js";
import { convertHermesExport } from "../hermes-conversion.js";
import { AgentResumeClient, type ResumeReceipt, type ResumeTransportRequest } from "../resume-transport.js";
import { ChoiceRegistry, ChoiceRegistryLockUnavailableError, type PendingChoice } from "../autopilot/choice-registry.js";
import { AutopilotPolicyRevisionConflictError, AutopilotPolicyStore } from "../autopilot/policy-store.js";
import { parseNoticeIncident, readIncidentBinding, NoticeIncidentBindingError, isHealthPlanId, HEALTH_PLAN_IDS, type HealthPlanId } from "../autopilot/notice-incident.js";
import { resolveAutopilotStateDir } from "../autopilot/state-dir.js";
import { AutopilotSessionStore, type AutopilotHarness } from "../autopilot/session-store.js";
import { codexSelectorKey, createCodexSelectorFromStopSession, effectivePolicyAllowsTarget } from "../autopilot/policy.js";
import type { AutoCompactService, AutoCompactStore } from "../autocontinue/auto-compact.js";
import type { OperatorCohortEnrollmentTarget, OperatorContinuationEnrollmentTarget, SessionAutostartStore } from "../autopilot/unfinished-session-launcher.js";
import { AutomationLaunchPolicyStore, LaunchPolicyConflictError, MAX_MODEL_LENGTH, appendLaunchPolicyAudit, findProjectRoute, launchPolicyAuditRecord, validateAutomationLaunchPolicy } from "../automation-launch-policy.js";
import { bearerToken, sameSecret } from "../secret-compare.js";
import {
  ALL_SCOPES,
  AutomationDisarmStore,
  AUTOMATION_CANNOT_CHANGE_DISARM_REASON,
  automationDisarmEtag,
  buildAutomationDisarmStateSummary,
  buildAutomationDisarmSummary,
  humanWorkKeys,
  readFleetDisarmState,
  setAutomationDisarm,
  setAutomationDisarmRecord,
} from "../automation-disarm/index.js";
import { DirectFleetDisarmTransport } from "../automation-disarm/direct-transport.js";
import { AUTOMATION_CANNOT_CHANGE_PROHIBITIONS_REASON, HOOK_KINDS, HooksService, isHookKind, type HookKind } from "../hooks/index.js";
import type { FleetDisarmNodeResult, FleetDisarmTransport } from "../automation-disarm/service.js";
import type { AutomationDisarmDocument } from "../automation-disarm/state.js";
import { renderSessionGraph } from "../session-visualization.js";
import { boundedCoordinationContext, coordinationNotes, type CoordinationConflict, type CoordinationNote } from "../coordination-notes.js";
import { sessionTargetRequest } from "../session-target.js";
import { lifecycleEntryFor, markLifecycleEvent, type SessionLifecycleEvent } from "../session-lifecycle.js";
import { getAgentActivityStatistics, withSessionPortfolioStatistics } from "../session-statistics.js";
import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import { toNodeHandler, type NodeMcpRequestHandler } from "@modelcontextprotocol/node";
import type { AdapterRegistry } from "../adapter-registry.js";
import { publishHealthRefusal, type HerderEventBus } from "../herder-events.js";
import type { HerderJobRegistry } from "../herder-jobs.js";
import { checkCodexQuota, saveCodexQuotaPolicy } from "../codex-quota-guard.js";
import { handleQuotaLensRequest } from "./quota-lens.js";
import { createSettingsApi } from "./settings-api.js";
import { SettingsStore } from "./settings-store.js";
import {
  CommonSettingsStateStore,
  DirectCommonSettingsTransport,
  hooksLeverFromStore,
  readCommonSettingsConfig,
  readOwnerDocument,
  restoreCommonSettingsLocalValues,
  type HooksProhibitionsStoreLike,
} from "../common-settings/index.js";
import { defaultFleetConfirmationPeers } from "./settings-fleet-confirmation.js";
import { getS21Ownership } from "../s21-resource-ownership.js";
import { getHumanStopStore } from "../human-stop-store.js";
import { deferredMessages, renderDeferredMessages } from "../deferred-messages.js";
import { agentHerderRag } from "../rag-search.js";
import { handleIntegratorSessionTranscript } from "../integrator-session-route.js";

/** How many skipped sessions of one recovery are named in the operator's log. */
const MAX_LOGGED_SKIP_REASONS = 50;

export interface WebDependencies {
  sessionImageStore?: SessionImageStore;
  adapters: Map<string, HarnessAdapter>;
  converter: Pick<AgentHerderSessionConverter, "convert"> & Partial<Pick<AgentHerderSessionConverter, "read">>;
  lineageStore?: LineageStore;
  humanRequests?: HumanRequestRegistry;
  adapterRegistry?: AdapterRegistry;
  mcpServerFactory?: () => McpServer;
  mcpAuthToken?: string;
  herderEvents?: HerderEventBus;
  choiceRegistry?: ChoiceRegistry;
  choiceResume?: (request: ResumeTransportRequest) => Promise<ResumeReceipt>;
  /** Canonical human-answer resume shared with the native MCP resolve surface. */
  humanResume?: (request: ResumeTransportRequest) => Promise<ResumeReceipt>;
  /** Ordered per-project harness routes with their durable attempt log. */
  projectLaunchDispatch?: ProjectLaunchDispatcher;
  choiceQuery?: (request: ResumeTransportRequest) => Promise<ResumeReceipt>;
  autopilotPolicyStore?: AutopilotPolicyStore;
  autopilotSessionStore?: AutopilotSessionStore;
  sessionAutostartStore?: SessionAutostartStore;
  autoCompactService?: AutoCompactService;
  autoCompactStore?: AutoCompactStore;
  automationLaunchPolicyStore?: AutomationLaunchPolicyStore;
  /** The settings of the product: a test names its own store, the runtime keeps its own files. */
  settingsStore?: SettingsStore;
  /**
   * The store of the lever of the prohibitions of the hooks.
   *
   * The lever belongs to the hooks and is not rewritten here: the store is
   * passed as it is, and the common settings read it and write it through it.
   * A node without the lever has no common lever either.
   */
  hooksProhibitionsStore?: HooksProhibitionsStoreLike;
  backgroundAutopilotStop?: BackgroundAutopilotStop;
  autopilotSweepIntervalMs?: number;
  sessionVisualizer?: (details: SessionDetails) => Promise<string>;
  sessionObservationIntervalMs?: number;
  jobs?: HerderJobRegistry;
  /** Reuse the process-owned supervisor when the daemon starts observation before HTTP. */
  supervisor?: SessionSupervisor;
  /** Resolve exact H34-bound native addresses before owner-HTTP session access. */
  integratorRuntime?: Pick<IntegratorFleetRuntime, "adapterForSession">;
  /** Build an ordinary supervisor facade over a request-owned adapter map. */
  scopedSupervisorFactory?: (adapters: Map<string, HarnessAdapter>) => SessionSupervisor;
  /** Disable local observer lifecycle when a process-owned supervisor already manages it. */
  sessionObservationManagedExternally?: boolean;
  /** The durable owner state of the automation lever; the runtime store by default. */
  automationDisarmStore?: AutomationDisarmStore;
  /** The port that carries one owner decision to the other fleet nodes. */
  automationDisarmTransport?: FleetDisarmTransport;
  /** Optional profile-scoped fleet API; its handler authenticates each request. */
  fleetHttpGuard?: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
  fleetApiHandler?: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
}

export type AutopilotSweepOutcome = {
  requestId?: string;
  status: "resumed" | "failed" | "human-required";
  reason?: string;
};

/**
 * The selected health plan of a launch, remembered between the launch call
 * and the arming call of the same session.
 *
 * The center states the plan in the launch message and the arming call carries
 * only the incident id, so the plan of a launch has to outlive the process
 * that stated it: it is written into the durable session state.
 */
type LaunchHealthPlans = {
  /** Remember the plan of one launch. */
  remember: (harness: string, sessionId: string, planId: HealthPlanId) => Promise<void>;
  /** The plan of one launch, when it is known. */
  recall: (harness: string, sessionId: string) => Promise<HealthPlanId | undefined>;
};

/** Build the immutable Agent Resume request from the saved timeout choice. */
export function buildChoiceResumeRequest(choice: Pick<PendingChoice, "harness" | "sessionId" | "cwd" | "nextGoal" | "requestId" | "idempotencyKey" | "resultRef">): ResumeTransportRequest {
  if (!choice.nextGoal || !choice.idempotencyKey) throw new Error("choice has no saved resume goal or idempotency key");
  const harness = choice.harness ?? "codex";
  if (harness === "hermes") throw new Error("Hermes choices are delivered by the Hermes plugin");
  const selector = createCodexSelectorFromStopSession({ sessionId: choice.sessionId, cwd: choice.cwd });
  return {
    target: { agent: harness, session_id: selector.sessionId, cwd: selector.cwd },
    goal: choice.nextGoal,
    prompt: choice.nextGoal,
    result_ref: choice.resultRef || `agent-herder://autopilot/choice/${choice.requestId}`,
    idempotency_key: choice.idempotencyKey,
  };
}

/** Backwards-compatible name retained for timeout callers and tests. */
export const buildTimeoutResumeRequest = buildChoiceResumeRequest;

/** Acknowledge Hermes locally; its plugin observes the durable resumed record and injects the goal. */
function localHookTimeoutReceipt(choice: PendingChoice): ResumeReceipt {
  if (!choice.idempotencyKey) throw new Error("local hook timeout has no saved idempotency key");
  const agent = choice.harness === "zcode" ? "zcode" : "hermes";
  if (agent === "zcode") {
    return {
      status: "accepted",
      target: { agent: "zcode", session_id: choice.sessionId, cwd: choice.cwd },
      result_ref: choice.resultRef,
      idempotency_key: choice.idempotencyKey,
      receipt_ref: `agent-herder://zcode/choice/${choice.requestId}`,
    };
  }
  return {
    status: "accepted",
    target: { agent: "hermes", locator: { schema: "hermes.locator.v2", session_key: choice.sessionId, platform: "local", chat_id: choice.sessionId, chat_type: "dm" } },
    result_ref: choice.resultRef,
    idempotency_key: choice.idempotencyKey,
    receipt_ref: `agent-herder://hermes/choice/${choice.requestId}`,
  };
}

/** Deterministic native input identity for one bound resume attempt. */
function resumeInputId(request: ResumeTransportRequest): string {
  const key = request.idempotency_key ?? request.result_ref;
  return `herder-resume-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

/**
 * Read-only admission lookup for an already delivered bound answer.
 *
 * Delivery happens through the process-owned native writer, so the duplicate
 * path must reconcile against that same native state, never against an
 * external ledger that never saw the delivery.
 */
export async function nativeResumeReceiptQuery(
  request: ResumeTransportRequest,
  adapters: Map<string, HarnessAdapter>,
): Promise<ResumeReceipt> {
  const target = request.target;
  if (target.agent === "hermes" || !target.session_id) return ambiguousNativeReceipt(request, "no_native_admission_query");
  const adapter = adapters.get(target.agent);
  if (!adapter?.getMessageAdmission) return ambiguousNativeReceipt(request, "no_native_admission_query");
  let native: Awaited<ReturnType<NonNullable<HarnessAdapter["getMessageAdmission"]>>>;
  try {
    native = await adapter.getMessageAdmission(target.session_id, resumeInputId(request), target.cwd);
  } catch (error) {
    return ambiguousNativeReceipt(request, error instanceof Error ? error.message : String(error));
  }
  if (native.state !== "admitted") {
    return ambiguousNativeReceipt(request, native.error ?? `native_admission_${native.state}`);
  }
  return {
    status: "accepted",
    target: request.target,
    result_ref: request.result_ref,
    receipt_ref: `agent-herder://${target.agent}/${target.session_id}/${request.idempotency_key ?? request.result_ref}`,
    ...(request.idempotency_key ? { idempotency_key: request.idempotency_key } : {}),
  };
}

/**
 * Read back the receipt of an already delivered bound answer.
 *
 * The lookup follows the delivery route: Codex and ZCode are delivered by the
 * process-owned native writer, so their admission is read from native state; the
 * remaining harnesses are delivered by Agent Resume, so only they consult that
 * external ledger.
 */
export async function boundResumeReceiptQuery(
  request: ResumeTransportRequest,
  adapters: Map<string, HarnessAdapter>,
): Promise<ResumeReceipt> {
  if (request.target.agent === "codex" || request.target.agent === "zcode") {
    return nativeResumeReceiptQuery(request, adapters);
  }
  return new AgentResumeClient().queryReceipt(request);
}

function ambiguousNativeReceipt(request: ResumeTransportRequest, reason: string): ResumeReceipt {
  return {
    status: "ambiguous",
    target: request.target,
    result_ref: request.result_ref,
    reason,
    ...(request.idempotency_key ? { idempotency_key: request.idempotency_key } : {}),
  };
}

/** Route Codex and ZCode through Herder's process-owned native writers so an
 * accepted human-gate delivery also arms durable Autocontinue tracking. */
export async function resumeSelectedTarget(
  request: ResumeTransportRequest,
  supervisor: SessionSupervisor,
  origin: "human" | "automation" = "automation",
  /** A replayed stored answer, not a live human action in this call. */
  answerReplay = false,
  automationPurpose?: "autopilot",
): Promise<ResumeReceipt> {
  if (request.target.agent !== "codex" && request.target.agent !== "zcode") return new AgentResumeClient().resume(request);
  const harness = request.target.agent;
  const prompt = request.prompt ?? request.goal ?? `Human Request resolved: ${request.result_ref}`;
  // A replayed stored answer carries its own admission instant. Without one
  // there is no evidence that the human acted before the current stop, so a
  // held session keeps its hold instead of being released by a late retry.
  if (answerReplay && origin === "human" && request.human_requested_at === undefined
    && await supervisor.isAutomationHeld(harness, request.target.session_id)) {
    return {
      status: "failed",
      target: request.target,
      result_ref: request.result_ref,
      reason: "human stop is held and this answer has no verifiable admission time",
      ...(request.idempotency_key ? { idempotency_key: request.idempotency_key } : {}),
    };
  }
  try {
    const current = await supervisor.getSession(harness, request.target.session_id, harness === "zcode" ? request.target.cwd : undefined);
    if (!liveAutopilotTargetMatchesChoice({ harness, sessionId: request.target.session_id, cwd: request.target.cwd }, current)) {
      return {
        status: "failed",
        target: request.target,
        result_ref: request.result_ref,
        reason: `${harness} target no longer matches the saved native session and working directory`,
        ...(request.idempotency_key ? { idempotency_key: request.idempotency_key } : {}),
      };
    }
    const result = await supervisor.sendMessage(
      harness,
      request.target.session_id,
      {
        message: prompt,
        // Both native writers acknowledge admission before the LLM finishes.
        // Codex must steer a verified active turn rather than start a writer.
        queue: true,
        ...(harness === "codex" && current?.status === "running" ? { steer: true } : {}),
        origin,
        ...(origin === "automation" && automationPurpose ? { automationPurpose } : {}),
        // The stable key reaches the deduplicating ingress, so a crash or lease
        // takeover cannot deliver the same answer to the native session twice.
        ...(request.idempotency_key ? { inputId: resumeInputId(request) } : {}),
        ...(origin === "human" && request.human_requested_at !== undefined
          ? { humanRequestedAt: request.human_requested_at }
          : {}),
      },
      harness === "zcode" ? request.target.cwd : undefined,
    );
    if (!result.ok) {
      return {
        status: "failed",
        target: request.target,
        result_ref: request.result_ref,
        reason: result.error || `${harness} native resume failed`,
        ...(request.idempotency_key ? { idempotency_key: request.idempotency_key } : {}),
      };
    }
    return {
      status: "accepted",
      target: request.target,
      result_ref: request.result_ref,
      receipt_ref: `agent-herder://${harness}/${request.target.session_id}/${request.idempotency_key ?? request.result_ref}`,
      ...(request.idempotency_key ? { idempotency_key: request.idempotency_key } : {}),
    };
  } catch (error) {
    return {
      status: "failed",
      target: request.target,
      result_ref: request.result_ref,
      reason: error instanceof Error ? error.message : String(error),
      ...(request.idempotency_key ? { idempotency_key: request.idempotency_key } : {}),
    };
  }
}

/** Require an exact existing native session before a question is bound to it. */
async function verifiedQuestionTarget(
  body: Record<string, unknown>,
  adapters: Map<string, HarnessAdapter>,
): Promise<{ agent: string; sessionId: string; cwd: string }> {
  const harness = typeof body.harness === "string" ? body.harness : typeof body.agent === "string" ? body.agent : "";
  const sessionId = typeof body.session_id === "string" ? body.session_id : typeof body.sessionId === "string" ? body.sessionId : "";
  if (!harness || !sessionId) throw new Error("harness and session_id are required");
  const adapter = adapters.get(harness);
  if (!adapter) throw new Error(`harness '${harness}' is not available`);
  const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
  const session = await adapter.getSession(sessionId).catch(() => null);
  const live = cwd ? (await adapter.listSessions({ cwd: resolve(cwd) }).catch(() => [])).find((candidate) => candidate.id === sessionId) ?? null : session;
  if (!live || live.harness !== harness || live.id !== sessionId) {
    throw new Error(`session '${harness}:${sessionId}' not found`);
  }
  if (cwd && normalize(live.cwd) !== normalize(cwd)) {
    throw new Error(`session '${harness}:${sessionId}' is not in '${cwd}'`);
  }
  return { agent: harness, sessionId, cwd: live.cwd };
}

async function completeManualChoiceResume(
  response: ServerResponse,
  choiceRegistry: ChoiceRegistry,
  pending: PendingChoice,
  receipt: ResumeReceipt,
  recovered: boolean,
): Promise<void> {
  const expectedKey = pending.idempotencyKey;
  if (
    !pending.choiceId ||
    !expectedKey ||
    receipt.idempotency_key !== expectedKey ||
    receipt.result_ref !== pending.resultRef
  ) {
    return sendJson(response, 502, {
      request_id: pending.requestId,
      status: pending.status,
      choice_id: pending.choiceId,
      session_id: pending.sessionId,
      resumed: false,
      error: "Agent Resume receipt does not match the saved choice",
    });
  }
  const stored = {
    status: receipt.status,
    resultRef: receipt.result_ref,
    idempotencyKey: receipt.idempotency_key,
    ...(("receipt_ref" in receipt && receipt.receipt_ref) ? { receiptRef: receipt.receipt_ref } : {}),
    ...(("reason" in receipt && receipt.reason) ? { reason: receipt.reason } : {}),
  } as PendingChoice["resumeReceipt"];
  await choiceRegistry.persistManualResumeReceipt(pending.requestId, pending.choiceId, stored);
  if (receipt.status !== "accepted") {
    return sendJson(response, 502, {
      request_id: pending.requestId,
      status: pending.status,
      choice_id: pending.choiceId,
      session_id: pending.sessionId,
      resumed: false,
      error: receipt.reason,
    });
  }
  const resumed = await choiceRegistry.markResumed(pending.requestId, pending.choiceId);
  const transport = "receipt_ref" in receipt && receipt.receipt_ref?.startsWith("agent-herder://codex/")
    ? "codex-app-server"
    : "agent-resume";
  return sendJson(response, 202, {
    request_id: resumed.requestId,
    status: resumed.status,
    choice_id: resumed.choiceId,
    session_id: resumed.sessionId,
    resumed: true,
    ...(recovered ? { recovered: true } : {}),
    transport,
  });
}

const autopilotSweepLocks = new Map<string, Promise<void>>();

/** Sweep durable timeout choices and resume only a still-authorized Codex target once. */
export async function sweepAutopilotChoices(input: {
  choiceRegistry: ChoiceRegistry;
  policyStore: AutopilotPolicyStore;
  sessionStore?: AutopilotSessionStore;
  now?: Date;
  targetAvailable?: (choice: PendingChoice) => Promise<boolean>;
  validateSavedTarget?: (choice: PendingChoice) => Promise<boolean>;
  resume: (choice: PendingChoice) => Promise<ResumeReceipt>;
  query?: (choice: PendingChoice) => Promise<ResumeReceipt>;
}): Promise<AutopilotSweepOutcome[]> {
  const key = input.choiceRegistry.coordinationKey;
  const previous = autopilotSweepLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  autopilotSweepLocks.set(key, current);
  await previous;
  try {
    return await sweepAutopilotChoicesUnlocked(input);
  } finally {
    release();
    if (autopilotSweepLocks.get(key) === current) autopilotSweepLocks.delete(key);
  }
}

/** Execute one timeout sweep after the per-registry overlap fence has been acquired. */
async function sweepAutopilotChoicesUnlocked(input: {
  choiceRegistry: ChoiceRegistry;
  policyStore: AutopilotPolicyStore;
  sessionStore?: AutopilotSessionStore;
  now?: Date;
  targetAvailable?: (choice: PendingChoice) => Promise<boolean>;
  validateSavedTarget?: (choice: PendingChoice) => Promise<boolean>;
  resume: (choice: PendingChoice) => Promise<ResumeReceipt>;
  query?: (choice: PendingChoice) => Promise<ResumeReceipt>;
}): Promise<AutopilotSweepOutcome[]> {
  const now = input.now ?? new Date();
  let claimed: PendingChoice[];
  try {
    claimed = await input.choiceRegistry.claimExpired(now);
  } catch (error) {
    if (error instanceof ChoiceRegistryLockUnavailableError) {
      return [{ status: "human-required", reason: error.message }];
    }
    throw error;
  }

  const outcomes: AutopilotSweepOutcome[] = [];
  const freshClaims = new Set(claimed.filter((choice) => choice.status === "claimed" && choice.claimToken).map((choice) => choice.requestId));
  let inFlight: PendingChoice[];
  try {
    inFlight = await input.choiceRegistry.listInFlightTimeoutClaims();
  } catch (error) {
    if (error instanceof ChoiceRegistryLockUnavailableError) {
      return claimed.length > 0
        ? claimed.map((choice) => ({
            requestId: choice.requestId,
            status: "human-required" as const,
            reason: choice.status === "claimed" && choice.claimToken ? error.message : choice.failureReason ?? error.message,
          }))
        : [{ status: "human-required", reason: error.message }];
    }
    throw error;
  }
  const recoveryClaims = inFlight.filter((choice) => !freshClaims.has(choice.requestId));
  for (const choice of [...claimed, ...recoveryClaims]) {
    const isRecovery = !freshClaims.has(choice.requestId);
    if ((!isRecovery && choice.status !== "claimed") || !choice.claimToken) {
      outcomes.push({
        requestId: choice.requestId,
        status: "human-required",
        reason: choice.failureReason ?? "Timeout claim cannot be dispatched safely",
      });
      continue;
    }
    const humanRequired = async (reason: string): Promise<void> => {
      try {
        await input.choiceRegistry.markHumanRequired(choice.requestId, choice.claimToken!, reason);
      } catch (error) {
        if (!(error instanceof ChoiceRegistryLockUnavailableError)) throw error;
      }
      outcomes.push({ requestId: choice.requestId, status: "human-required", reason });
    };

    const completeReceipt = async (receipt: ResumeReceipt): Promise<boolean> => {
      const expectedKey = choice.idempotencyKey;
      const expectedRef = choice.resultRef || `agent-herder://autopilot/choice/${choice.requestId}`;
      if (!expectedKey || receipt.idempotency_key !== expectedKey || receipt.result_ref !== expectedRef) {
        await humanRequired("Agent Resume receipt does not match the saved timeout request");
        return false;
      }
      const stored = {
        status: receipt.status,
        resultRef: receipt.result_ref,
        idempotencyKey: receipt.idempotency_key,
        ...(("receipt_ref" in receipt && receipt.receipt_ref) ? { receiptRef: receipt.receipt_ref } : {}),
        ...(("reason" in receipt && receipt.reason) ? { reason: receipt.reason } : {}),
      } as PendingChoice["resumeReceipt"];
      try {
        await input.choiceRegistry.persistResumeReceipt(choice.requestId, choice.claimToken!, stored);
        if (receipt.status === "accepted") {
          await input.choiceRegistry.markResumed(choice.requestId, choice.claimToken!);
          outcomes.push({ requestId: choice.requestId, status: "resumed" });
          return true;
        }
        if (receipt.status === "failed" || receipt.status === "rejected") {
          await input.choiceRegistry.markFailed(choice.requestId, choice.claimToken!, receipt.reason);
          outcomes.push({ requestId: choice.requestId, status: "failed", reason: receipt.reason });
          return false;
        }
        await humanRequired(`Agent Resume returned ${receipt.status}: ${receipt.reason}`);
        return false;
      } catch (error) {
        if (error instanceof ChoiceRegistryLockUnavailableError) {
          await humanRequired(error.message);
          return false;
        }
        throw error;
      }
    };

    if (isRecovery) {
      if (!input.query) {
        await humanRequired("Timeout recovery requires a durable Agent Resume receipt query");
        continue;
      }
      try {
        const receipt = await input.query(choice);
        if (choice.status === "claimed") {
          const dispatching = await input.choiceRegistry.markDispatching(choice.requestId, choice.claimToken!, now);
          if (!dispatching) {
            await humanRequired("Timeout recovery claim is no longer dispatchable");
            continue;
          }
        }
        await completeReceipt(receipt);
      } catch (error) {
        await humanRequired(`Timeout receipt query failed: ${(error as Error).message}`);
      }
      continue;
    }

    try {
      if (input.targetAvailable && !(await input.targetAvailable(choice))) {
        await humanRequired("Codex session is no longer available for timeout continuation");
        continue;
      }
    } catch (error) {
      await humanRequired(`Timeout target revalidation failed: ${(error as Error).message}`);
      continue;
    }

    let preparation: { kind: "dispatching"; choice: PendingChoice } | { kind: "human-required"; reason: string };
    try {
      preparation = await input.policyStore.withMutationFence(async () => {
        const effective = await input.policyStore.readEffective();
        const sessionOverride = await input.sessionStore?.get(choice.harness ?? "codex", choice.sessionId);
        const targetEnabled = effective.policy.enabled && (sessionOverride?.enabled ?? effectivePolicyAllowsTarget(effective, {
          harness: choice.harness ?? "codex",
          sessionId: choice.sessionId,
          cwd: choice.cwd,
        }));
        if (effective.source !== "persisted" || effective.revision !== choice.policyRevision ||
          effective.policy.timeout.mode !== "auto_continue" || !targetEnabled) {
          return { kind: "human-required", reason: "Autopilot policy or selector changed before timeout dispatch" };
        }
        if (!hasSavedTimeoutTarget(choice) || input.validateSavedTarget && !(await input.validateSavedTarget(choice))) {
          return { kind: "human-required", reason: "Saved timeout target is no longer valid" };
        }
        const dispatching = await input.choiceRegistry.markDispatching(
          choice.requestId,
          choice.claimToken!,
          now,
          effective.policy.maxContinuationsPerSession,
        );
        if (dispatching && !hasSavedTimeoutTarget(dispatching)) {
          return { kind: "human-required", reason: "Saved timeout target is no longer valid" };
        }
        return dispatching
          ? { kind: "dispatching", choice: dispatching }
          : { kind: "human-required", reason: "Timeout claim could not be dispatched safely" };
      });
    } catch (error) {
      if (error instanceof ChoiceRegistryLockUnavailableError) {
        await humanRequired(error.message);
        continue;
      }
      await humanRequired(`Timeout dispatch revalidation failed: ${(error as Error).message}`);
      continue;
    }
    if (preparation.kind === "human-required") {
      await humanRequired(preparation.reason);
      continue;
    }
    const dispatching = preparation.choice;

    let result: ResumeReceipt;
    try {
      result = await input.resume(dispatching);
    } catch (error) {
      await humanRequired(`Agent Resume invocation failed: ${(error as Error).message}`);
      continue;
    }
    await completeReceipt(result);
  }
  return outcomes;
}

/** Verify that dispatch still uses exactly the immutable timeout candidate saved with the choice. */
function hasSavedTimeoutTarget(choice: PendingChoice): boolean {
  if (!choice.timeoutChoiceId || choice.choiceId !== choice.timeoutChoiceId || !choice.nextGoal) return false;
  const saved = choice.choices.find((candidate) => candidate.choiceId === choice.timeoutChoiceId);
  return Boolean(saved && saved.nextGoal === choice.nextGoal);
}

/** Require the live Codex identity to remain in the same canonical project scope as its timeout choice. */
export function liveCodexTargetMatchesChoice(
  choice: Pick<PendingChoice, "sessionId" | "cwd">,
  session: AgentSession | null,
): boolean {
  if (!session || session.harness !== "codex" || session.id !== choice.sessionId) return false;
  try {
    return codexSelectorKey(createCodexSelectorFromStopSession({
      sessionId: choice.sessionId,
      cwd: choice.cwd,
    })) === codexSelectorKey(createCodexSelectorFromStopSession({
      sessionId: session.id,
      cwd: session.cwd,
    }));
  } catch {
    return false;
  }
}

/** Require the live session to match the timeout's actual harness, id and canonical CWD. */
export function liveAutopilotTargetMatchesChoice(
  choice: Pick<PendingChoice, "harness" | "sessionId" | "cwd">,
  session: AgentSession | null,
): boolean {
  const harness = choice.harness ?? "codex";
  if (!session || session.harness !== harness || session.id !== choice.sessionId) return false;
  if (harness === "codex") return liveCodexTargetMatchesChoice(choice, session);
  try {
    return normalize(session.cwd) === normalize(choice.cwd);
  } catch {
    return false;
  }
}

const htmlPath = join(dirname(fileURLToPath(import.meta.url)), "index.html");
const webRoot = dirname(htmlPath);

/**
 * The model catalog of a harness, refreshed when the cache is stale.
 *
 * A stale cache is not a refusal: the background refresh is awaited and the
 * catalog is read again, so only a model that is missing from the fresh
 * catalog is refused.
 */
async function freshModelCatalog(supervisor: SessionSupervisor, harness: string, timeoutMs = 5_000): Promise<{ models: string[]; stale: boolean }> {
  let catalog = await supervisor.getModels(harness);
  if (!catalog.stale) return catalog;
  const deadline = Date.now() + timeoutMs;
  while (catalog.stale && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 100).unref?.(); });
    catalog = await supervisor.getModels(harness);
  }
  return catalog;
}

let healthQuotaPreflight: ReturnType<typeof createMiniMaxQuotaPreflight> | undefined;

/** The MiniMax subscription quota check of one health launch. */
function noticeplaceHealthQuotaPreflight(): ReturnType<typeof createMiniMaxQuotaPreflight> {
  healthQuotaPreflight ??= createMiniMaxQuotaPreflight({ token: process.env.MINIMAX_API_KEY });
  return healthQuotaPreflight;
}

/** Compare two secrets without leaking their length or prefix through time. */
/**
 * The owner lever moves only for a caller that proves it holds the owner
 * secret. The token is configured per node, and a node without it fails
 * closed rather than moving the lever on the word of an unauthenticated
 * caller.
 */
function configuredDisarmToken(): string | undefined {
  return process.env.AGENT_HERDER_DISARM_TOKEN?.trim() || undefined;
}

/**
 * The revision of the live launch policy at this moment.
 *
 * The revision travels with every owner decision, so the audit trail of the
 * lever says which launch policy was in force when the owner decided. The
 * policy is the sibling of the lever state, so it is read from there when the
 * runtime does not hold a configured store.
 */
async function currentLaunchPolicyRevision(
  store: AutomationLaunchPolicyStore | undefined,
  disarmStore: AutomationDisarmStore,
): Promise<string | undefined> {
  try {
    const policyStore = store ?? new AutomationLaunchPolicyStore(
      join(dirname(disarmStore.path), "automation-launch-policy.json"),
    );
    const document = await policyStore.readDocument();
    return document.etag;
  } catch {
    return undefined;
  }
}

/**
 * The window of the list of the sessions.
 *
 * The window is asked for by the panel: the whole list of the mesh is
 * megabytes of JSON, and a browser cannot parse it on the first paint. The
 * window is bounded, so a request cannot ask for the whole list by accident,
 * and a request without a window keeps the whole list as before.
 */
const MAX_SESSION_LIST_WINDOW = 500;

/**
 * The budget of the answer of the list, in bytes.
 *
 * The size of a session is not uniform: a session with a long history is
 * much heavier than a fresh one. The window is bounded by the bytes as well
 * as by the count, so the answer of the panel stays inside the budget
 * whatever the data of the node looks like.
 */
const SESSION_LIST_BYTE_BUDGET = 300 * 1024;

function sessionListLimit(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(Math.floor(value), MAX_SESSION_LIST_WINDOW);
}

/**
 * The window of the list that the panel receives.
 *
 * The window is at most the asked count of sessions and at most the byte
 * budget: a session that does not fit ends the window, and the rest of the
 * list is loaded by the next request.
 */
function sessionListWindow<T>(sessions: T[], limit: number): T[] {
  const visible: T[] = [];
  let bytes = 0;
  for (const session of sessions) {
    if (visible.length >= limit) break;
    const size = Buffer.byteLength(JSON.stringify(session) ?? "");
    if (visible.length > 0 && bytes + size > SESSION_LIST_BYTE_BUDGET) break;
    visible.push(session);
    bytes += size;
  }
  return visible;
}

/** How a native session is reached: ordinary, project-scoped or refused. */
type SessionRoute =
  | { kind: "ordinary"; adapters: Map<string, HarnessAdapter> }
  | { kind: "deny"; reason: string }
  | { kind: "scoped"; adapter: HarnessAdapter; adapters: Map<string, HarnessAdapter>; supervisor?: SessionSupervisor };

/**
 * The one project-scope guard of a native session read.
 *
 * Every reader of a native session passes this guard, including the detached
 * health observer: a revoked or rotated project binding must stop the read
 * exactly as it stops an HTTP route.
 */
async function resolveSessionRouteFor(
  integratorRuntime: Pick<IntegratorFleetRuntime, "adapterForSession"> | undefined,
  adapters: Map<string, HarnessAdapter>,
  scopedSupervisorFactory: ((adapters: Map<string, HarnessAdapter>) => SessionSupervisor) | undefined,
  harness: string,
  sessionId: string,
): Promise<SessionRoute> {
  if (!integratorRuntime) return { kind: "ordinary", adapters };
  let resolution: Awaited<ReturnType<IntegratorFleetRuntime["adapterForSession"]>>;
  try { resolution = await integratorRuntime.adapterForSession({ hostId: hostname(), harness: harness as "codex" | "zcode" | "opencode", nativeSessionId: sessionId }); }
  catch { return { kind: "deny", reason: "binding_lookup_failed" }; }
  if (resolution.kind === "ordinary") return { kind: "ordinary", adapters };
  if (resolution.kind === "deny") return { kind: "deny", reason: resolution.reason };
  const scopedAdapters = new Map(adapters);
  scopedAdapters.set(harness, resolution.adapter);
  return { kind: "scoped", adapter: resolution.adapter, adapters: scopedAdapters, supervisor: scopedSupervisorFactory?.(scopedAdapters) };
}

export function createWebServer(dependencies: WebDependencies): Server {
  const supervisor = dependencies.supervisor ?? new SessionSupervisor(dependencies.adapters, dependencies.converter, dependencies.lineageStore, { events: dependencies.herderEvents });
  const stopSessionObservation = dependencies.herderEvents && !dependencies.sessionObservationManagedExternally
    ? supervisor.startObservation(dependencies.sessionObservationIntervalMs ?? 5_000)
    : undefined;
  const sessionVisualizer = dependencies.sessionVisualizer || ((details: SessionDetails) => Promise.resolve(renderSessionGraph(details)));
  const mcpHttp = dependencies.mcpServerFactory
    ? createMcpHandler(dependencies.mcpServerFactory, { legacy: "stateless" })
    : undefined;
  const mcpNodeHandler = mcpHttp ? toNodeHandler(mcpHttp) : undefined;
  const unsubscribeMcpEvents = mcpHttp && dependencies.herderEvents
    ? dependencies.herderEvents.subscribe((event) => { mcpHttp.notify.resourceUpdated(event.uri); })
    : undefined;
  const mcpAuthToken = dependencies.mcpAuthToken?.trim() || undefined;
  const selectedResume = dependencies.choiceResume ?? ((request: ResumeTransportRequest) => resumeSelectedTarget(request, supervisor, "automation"));
  const manualChoiceResume = dependencies.choiceResume ?? ((request: ResumeTransportRequest) => resumeSelectedTarget(request, supervisor, "human"));
  const userMessageDelivery = dependencies.jobs ? new UserMessageDelivery(dependencies.adapters, supervisor, dependencies.jobs) : undefined;
  const sessionImages = dependencies.sessionImageStore ?? new SessionImageStore(join(homedir(), ".local/state/agent-herder/session-images"));
  const rag = agentHerderRag();
  // The health plan of a launch, remembered between the launch call and the
  // arming call of the same session: the center states the selected plan in
  // the launch message, while the arming call carries only the incident id.
  // The plan is remembered durably, so a restart of herder between the two
  // calls does not lose the plan of a live incident.
  const launchHealthPlanMemory = new Map<string, HealthPlanId>();
  const rememberLaunchHealthPlan = async (harness: string, sessionId: string, planId: HealthPlanId): Promise<void> => {
    launchHealthPlanMemory.set(`${harness}:${sessionId}`, planId);
    if (!dependencies.autopilotSessionStore || !isAutopilotHarness(harness)) return;
    try {
      await dependencies.autopilotSessionStore.setLaunchPlan(harness, sessionId, planId);
    } catch (error) {
      // The launch itself already happened: a plan that could not be written
      // down must not fail it. The observer refuses to publish without a
      // known plan, so nothing is published under a wrong one.
      console.error(`Notice health plan of ${harness}:${sessionId} could not be remembered: ${(error as Error).message}`);
    }
  };
  const recallLaunchHealthPlan = async (harness: string, sessionId: string): Promise<HealthPlanId | undefined> => {
    if (dependencies.autopilotSessionStore && isAutopilotHarness(harness)) {
      const stored = await dependencies.autopilotSessionStore.getLaunchPlan(harness, sessionId);
      if (stored) return stored;
    }
    return launchHealthPlanMemory.get(`${harness}:${sessionId}`);
  };
  const launchHealthPlans: LaunchHealthPlans = { remember: rememberLaunchHealthPlan, recall: recallLaunchHealthPlan };
  // The machine-readable trail of the refusals of the health contour. A reader
  // counts the refusals by their code in this file and never parses a wording.
  const healthRefusalAudit = healthRefusalAuditPath(resolveAutopilotStateDir());
  /**
   * The refusal of the health contour travels into the journal of the events.
   *
   * A reader of the events reads the class of the refusal and not its
   * wording, so the class travels in the `reason_code` of the event and
   * the incident in its uri. The bus of the runtime is used only when it
   * is there: a herder without a bus has no journal of the runtime to
   * publish into, and the refusal stays in the durable trail.
   */
  const publishHealthRefusalEvent = (refusal: HealthReasonRefusal): void => {
    const bus = dependencies.herderEvents;
    // The bus of the runtime is passed explicitly. The module bus of the
    // events is a different journal, and a silent publication into it
    // would hide the refusal from the reader of the runtime.
    if (!bus) return;
    try {
      publishHealthRefusal({
        incidentId: refusal.incidentId,
        reasonCode: refusal.code,
        source: refusal.detail ?? refusal.workKey,
      }, bus);
    } catch (error) {
      // A refusal whose class is unknown has no machine-readable meaning,
      // so the journal refuses it. The failure is loud: a refusal that was
      // not published must never look like a published one.
      console.error(`Health refusal for incident ${refusal.incidentId} was not published into the event journal: ${(error as Error).message}`);
    }
  };
  // The center's observer is bounded so the incident card is never held back.
  // This one keeps the same native session under observation until it ends.
  const noticeplaceHealthObserver = new NoticeplaceHealthObserver({
    readDetails: async (harness, sessionId) => {
      // The observer reads the same native session as the HTTP routes, so it
      // passes the same project-scope guard before it reads anything.
      const route = await resolveSessionRouteFor(dependencies.integratorRuntime, dependencies.adapters, dependencies.scopedSupervisorFactory, harness, sessionId);
      if (route.kind === "deny") throw new Error("Project-scoped session binding could not be verified.");
      const reader = route.kind === "scoped" ? route.supervisor : supervisor;
      if (!reader) throw new Error("Scoped session read port is unavailable.");
      return await reader.getSessionDetails(harness, sessionId, { limit: 5, history: "auto" });
    },
    readActiveTurn: async (harness, sessionId) => {
      const adapter = dependencies.adapters.get(harness);
      if (!adapter?.getCoordinationActiveTurnId) return null;
      return await adapter.getCoordinationActiveTurnId(sessionId);
    },
    validateTarget: async (target) => {
      try {
        await readIncidentBinding(target.binding);
        return undefined;
      } catch (error) {
        // An unreachable center proves nothing about the binding; only a
        // definite refusal stops the observation.
        if (error instanceof NoticeIncidentBindingError && error.kind === "rejected") return error.message;
        console.error(`Notice health observer could not confirm the incident ${target.binding.incidentId}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    },
    // The refusal of the observer reaches the consumer as a machine-readable
    // record: the class of the refusal is a field of the record, not a part of
    // the wording of the log line.
    onRefused: (refusal) => {
      void appendHealthRefusalAudit(healthRefusalAudit, refusal);
      publishHealthRefusalEvent(refusal);
    },
    onPublished: (update) => console.log(`Notice health observer published ${update.fingerprint} for ${update.binding.incidentId} plan ${update.planId}`),
    onError: (message) => console.error(message),
  });
  // The settings of the herder product, managed by the owner from one
  // form. The store touches the environment file of the product and the
  // configuration of this node, and nothing else: the files of the other
  // products of the contour are never opened here.
  const settingsStore = dependencies.settingsStore ?? new SettingsStore({ actor: userInfo().username, hostId: hostname() });
  // The common settings of the fleet: the document of the owner and the nodes
  // that take it. A node without the owner named in its environment has no
  // common settings and claims nothing about the fleet.
  const commonSettingsConfig = readCommonSettingsConfig(process.env, hostname());
  const commonSettingsState = new CommonSettingsStateStore();
  const commonSettingsPeers = defaultFleetConfirmationPeers(hostname());
  const commonSettingsHooks = dependencies.hooksProhibitionsStore
    ? hooksLeverFromStore(dependencies.hooksProhibitionsStore)
    : undefined;
  const settingsApi = createSettingsApi({
    store: settingsStore,
    actor: userInfo().username,
    hostId: hostname(),
    // The launch policy keeps its own endpoint and its own version
    // check: the settings API reads it and never writes it twice.
    ...(dependencies.automationLaunchPolicyStore
      ? {
        launchPolicy: {
          endpoint: "/api/automation/launch-policy",
          read: async () => await dependencies.automationLaunchPolicyStore!.readDocument(),
        },
      }
      : {}),
    ...(commonSettingsConfig.role === "none"
      ? {}
      : {
        commonSettings: {
          role: commonSettingsConfig.role,
          ownerHostId: commonSettingsConfig.ownerHostId,
          // The document of the owner is read from the files of this node: the
          // common settings are never a second copy of the settings. A member
          // answers with the document it holds: it has no document of its own.
          readDocument: async () => {
            if (commonSettingsConfig.role === "member") {
              return (await commonSettingsState.read()).document;
            }
            return await readOwnerDocument({
              owner: hostname(),
              store: {
                readEnvironment: async () => await settingsStore.readEnvironment(),
                readSecretValue: async (key: string) => await settingsStore.readSecretValue(key),
              },
              ...(dependencies.automationLaunchPolicyStore
                ? {
                  launchPolicy: {
                    read: async () => {
                      const document = await dependencies.automationLaunchPolicyStore!.readDocument();
                      return document.kind === "valid"
                        ? { kind: "valid" as const, policy: document.policy }
                        : { kind: document.kind };
                    },
                  },
                }
                : {}),
              ...(commonSettingsHooks ? { hooks: commonSettingsHooks } : {}),
            });
          },
          peers: commonSettingsPeers,
          transport: new DirectCommonSettingsTransport(),
          state: async () => await commonSettingsState.read(),
          setLocalOptIn: async (enabled: boolean) => { await commonSettingsState.setOptIn(enabled); },
          restoreLocal: async () => await restoreCommonSettingsLocalValues({
            target: settingsStore,
            state: await commonSettingsState.read(),
            hostId: hostname(),
          }),
        },
      }),
  });
  const server = createServer(async (request, response) => {
    try {
      if (dependencies.fleetHttpGuard && await dependencies.fleetHttpGuard(request, response)) return;
      if (dependencies.fleetApiHandler && await dependencies.fleetApiHandler(request, response)) return;
      // The settings of the owner keep the order of the checks of the
      // panel: the guard of the fleet runs before them, and the API
      // checks the owner of the request itself.
      if (await settingsApi(request, response)) return;
      if (await rag.handleHttp(request, response, async (harness, id) => (await dependencies.adapters.get(harness)?.getSession(id)) || undefined)) return;
      await route(request, response, supervisor, dependencies.adapters, dependencies.humanRequests, dependencies.projectLaunchDispatch, mcpNodeHandler, dependencies.adapterRegistry, mcpAuthToken, dependencies.choiceRegistry, selectedResume, dependencies.humanResume, manualChoiceResume, dependencies.choiceQuery, dependencies.autopilotSessionStore, dependencies.autopilotPolicyStore, dependencies.sessionAutostartStore, dependencies.automationLaunchPolicyStore, sessionVisualizer, dependencies.jobs, dependencies.herderEvents, userMessageDelivery, dependencies.autoCompactService, dependencies.autoCompactStore, sessionImages, dependencies.backgroundAutopilotStop, dependencies.integratorRuntime, dependencies.scopedSupervisorFactory, noticeplaceHealthObserver, launchHealthPlans, dependencies.automationDisarmStore, dependencies.automationDisarmTransport);
    } catch (err) {
      // A cancelled/streaming response cannot receive a second JSON status.
      // Re-throwing from this async listener would terminate the singleton.
      if (request.aborted || response.destroyed || response.writableEnded || response.headersSent) {
        if (!response.destroyed && !response.writableEnded) response.destroy();
        return;
      }
      if (err instanceof SessionNotFoundError) {
        sendJson(response, 404, { error: "Session not found" });
        return;
      }
      sendJson(response, 502, { error: (err as Error).message });
    }
  });
  server.once("close", () => {
    userMessageDelivery?.close();
    stopSessionObservation?.();
    // The detached observers publish into the incident cards: they must stop
    // with the server instead of running on into the next process.
    noticeplaceHealthObserver.stop();
    unsubscribeMcpEvents?.();
    if (mcpHttp) void mcpHttp.close();
  });
  /**
   * A restart of herder must not leave the incident cards of the live
   * executors silent: the armed sessions of the durable store are observed
   * again, in small batches, as soon as the server starts listening.
   */
  const recoverHealthObservation = async (): Promise<void> => {
    try {
      const candidates = await readArmedHealthCandidates(join(resolveAutopilotStateDir(), "sessions.json"));
      if (!candidates.length) return;
      const result = await recoverNoticeplaceHealthObservation({
        candidates,
        isAlive: async (candidate) => {
          const session = await supervisor.getSession(candidate.harness, candidate.sessionId).catch(() => null);
          if (!session) return false;
          return session.status !== "stopped" && session.status !== "error";
        },
        resolvePlan: async (candidate) => {
          // The plan of a launch is remembered durably: a record written
          // without a plan is repaired here, so the next restart observes the
          // session without asking the center again.
          const planId = await recallLaunchHealthPlan(candidate.harness, candidate.sessionId);
          if (!planId) return undefined;
          if (dependencies.autopilotSessionStore && isAutopilotHarness(candidate.harness)) {
            try {
              await dependencies.autopilotSessionStore.set({
                harness: candidate.harness,
                sessionId: candidate.sessionId,
                cwd: candidate.cwd,
                noticeIncident: { ...candidate.binding, planId },
              }, true);
            } catch (error) {
              // The observation is armed with the known plan anyway: a record
              // that could not be repaired is repaired by the next arming.
              console.error(`Notice health plan of ${candidate.harness}:${candidate.sessionId} could not be repaired: ${(error as Error).message}`);
            }
          }
          return planId;
        },
        arm: async (candidate) => await noticeplaceHealthObserver.start({
          harness: candidate.harness,
          sessionId: candidate.sessionId,
          cwd: candidate.cwd,
          binding: candidate.binding,
        }),
      });
      console.log(`Notice health observer recovered ${result.armed} armed sessions after the restart (${result.skipped} skipped)`);
      // The refusals of the repair reach the consumer in the same trail the
      // live observer writes into.
      for (const refusal of result.refusals) {
        await appendHealthRefusalAudit(healthRefusalAudit, refusal);
        publishHealthRefusalEvent(refusal);
      }
      // The reason of every skipped session is the operator's evidence: the
      // counters alone do not say why a session was not observed. The reasons
      // name a session and a cause, never a secret of the incident.
      for (const reason of result.reasons.slice(0, MAX_LOGGED_SKIP_REASONS)) {
        console.log(`Notice health observer skipped a session: ${reason}`);
      }
      if (result.reasons.length > MAX_LOGGED_SKIP_REASONS) {
        console.log(`Notice health observer skipped a session: ... and ${result.reasons.length - MAX_LOGGED_SKIP_REASONS} more`);
      }
    } catch (error) {
      console.error(`Notice health observer recovery failed: ${(error as Error).message}`);
    }
  };
  server.once("listening", () => { void recoverHealthObservation(); });
  if (dependencies.choiceRegistry && dependencies.autopilotPolicyStore) {
    const sweep = () => sweepAutopilotChoices({
      choiceRegistry: dependencies.choiceRegistry!,
      policyStore: dependencies.autopilotPolicyStore!,
      sessionStore: dependencies.autopilotSessionStore,
      targetAvailable: async (choice) => choice.harness === "hermes" || liveAutopilotTargetMatchesChoice(
        choice,
        await supervisor.getSession(choice.harness ?? "codex", choice.sessionId, choice.harness === "zcode" ? choice.cwd : undefined),
      ),
      resume: async (choice) => {
        if (choice.harness === "hermes") return localHookTimeoutReceipt(choice);
        return selectedResume(buildTimeoutResumeRequest(choice));
      },
      query: async (choice) => {
        if (choice.harness === "hermes") return localHookTimeoutReceipt(choice);
        // The timeout dispatch also follows the delivery route, so its recovery
        // query reads native admission for Codex and ZCode.
        return boundResumeReceiptQuery(buildTimeoutResumeRequest(choice), dependencies.adapters);
      },
    }).catch((error) => console.error(`[agent-herder] autopilot sweep failed: ${(error as Error).message}`));
    const intervalMs = Math.max(100, dependencies.autopilotSweepIntervalMs ?? 30_000);
    const timer = setInterval(sweep, intervalMs);
    timer.unref?.();
    server.once("close", () => clearInterval(timer));
  }
  return server;
}

/** Edited files are attributed to the git repo that actually owns them, so
 * each repo's coordination board sees the sessions touching it — a session
 * working across several repos appears on several boards. Non-repo paths
 * (dotfiles, home config) fall back to the session's launch directory. */
const repoToplevelCache = new Map<string, { top: string | null; at: number }>();
const execFileAsync = promisify(execFile);

async function boardForPath(path: string, fallback: string): Promise<string> {
  let dir: string;
  try { dir = dirname(path); } catch { return fallback; }
  if (!path.trim() || !isAbsolute(dir)) return fallback;
  const cached = repoToplevelCache.get(dir);
  if (cached && Date.now() - cached.at < 300_000) return cached.top ?? fallback;
  let top: string | null = null;
  try {
    const result = await execFileAsync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { timeout: 2000 });
    const out = result.stdout.trim();
    top = out && isAbsolute(out) ? resolve(out) : null;
  } catch { top = null; }
  repoToplevelCache.set(dir, { top, at: Date.now() });
  return top ?? fallback;
}

async function route(request: IncomingMessage, response: ServerResponse, supervisor: SessionSupervisor, adapters: Map<string, HarnessAdapter>, humanRequests?: HumanRequestRegistry, projectLaunchDispatch?: ProjectLaunchDispatcher, mcpNodeHandler?: NodeMcpRequestHandler, adapterRegistry?: AdapterRegistry, mcpAuthToken?: string, choiceRegistry?: ChoiceRegistry, choiceResume?: (request: ResumeTransportRequest) => Promise<ResumeReceipt>, humanResume?: (request: ResumeTransportRequest) => Promise<ResumeReceipt>, choiceManualResume?: (request: ResumeTransportRequest) => Promise<ResumeReceipt>, choiceQuery?: (request: ResumeTransportRequest) => Promise<ResumeReceipt>, autopilotSessionStore?: AutopilotSessionStore, autopilotPolicyStore?: AutopilotPolicyStore, sessionAutostartStore?: SessionAutostartStore, automationLaunchPolicyStore?: AutomationLaunchPolicyStore, sessionVisualizer?: (details: SessionDetails) => Promise<string>, jobs?: HerderJobRegistry, events?: HerderEventBus, userMessageDelivery?: UserMessageDelivery, autoCompactService?: AutoCompactService, autoCompactStore?: AutoCompactStore, sessionImages?: SessionImageStore, backgroundAutopilotStop?: BackgroundAutopilotStop, integratorRuntime?: Pick<IntegratorFleetRuntime, "adapterForSession">, scopedSupervisorFactory?: (adapters: Map<string, HarnessAdapter>) => SessionSupervisor, noticeplaceHealthObserver?: NoticeplaceHealthObserver, launchHealthPlans?: LaunchHealthPlans, automationDisarmStore?: AutomationDisarmStore, automationDisarmTransport?: FleetDisarmTransport): Promise<void> {
  const url = new URL(request.url || "/", "http://localhost");
  const resolveSessionRoute = async (harness: string, sessionId: string) => await resolveSessionRouteFor(integratorRuntime, adapters, scopedSupervisorFactory, harness, sessionId);
  if (url.pathname === "/api/resources/s21-lease" && request.method === "GET") {
    response.setHeader("cache-control", "no-store");
    return sendJson(response, 200, await getS21Ownership());
  }
  if (url.pathname === "/api/codex-quota-guard") {
    response.setHeader("cache-control", "no-store");
    const adapter = adapters.get("codex") as (HarnessAdapter & {readQuota?:()=>Promise<unknown>}) | undefined;
    const readQuota = () => adapter?.readQuota ? adapter.readQuota() : Promise.resolve({error:"codex_adapter_unavailable"});
    if (request.method === "GET") return sendJson(response,200,await checkCodexQuota(readQuota));
    if (request.method === "PUT") {
      const origin = request.headers.origin;
      if (request.headers["sec-fetch-site"] === "cross-site") return sendJson(response,403,{error:"cross-site settings write refused"});
      if (origin) {try {if(new URL(origin).host!==request.headers.host)return sendJson(response,403,{error:"origin mismatch"});} catch {return sendJson(response,403,{error:"invalid origin"});}}
      try {
        const body=await readJson(request);
        if(Object.keys(body).some(k=>k!=="policy"&&k!=="revision"))return sendJson(response,400,{error:"Unknown quota settings field"});
        await saveCodexQuotaPolicy(body.policy,typeof body.revision==="string"?body.revision:"");
        return sendJson(response,200,await checkCodexQuota(readQuota));
      } catch(error) {const message=(error as Error).message;return sendJson(response,message.startsWith("quota_policy_conflict")?409:400,{error:message});}
    }
    return sendJson(response,405,{error:"GET or PUT required"});
  }
  if (url.pathname.startsWith("/api/quota-lens") && request.method === "GET") {
    const body = await handleQuotaLensRequest(url.pathname, url.searchParams);
    if (body !== null) return sendJson(response, 200, body);
  }
  if (url.pathname === "/api/coordination/context" && request.method === "GET") {
    const harness = url.searchParams.get("harness")?.trim();
    const sessionId = url.searchParams.get("sessionId")?.trim();
    const cwd = url.searchParams.get("cwd")?.trim();
    if (!harness || !sessionId || !cwd) return sendJson(response, 400, { error: "harness, sessionId, and cwd are required" });
    const coordinationHeld=async()=>await getHumanStopStore().isHeld(harness,sessionId)||await supervisor.isAutomationHeld(harness,sessionId);
    let humanStopHeld = await coordinationHeld();
    if (url.searchParams.get("touch") === "1" && !coordinationNotes.activeWorkspaceForSession(sessionId)) await coordinationNotes.heartbeatSession({ sessionId, cwd });
    const coordinationContext = await coordinationNotes.renderForSession({ harness, id: sessionId, cwd });
    if (response.destroyed) return;
    humanStopHeld = humanStopHeld || await coordinationHeld();
    if(humanStopHeld)await deferredMessages.discardActive(harness,sessionId);
    const inboxMessages = humanStopHeld ? [] : await deferredMessages.list(sessionId);
    const activeTurnId=url.searchParams.get('activeTurnId')?.trim();
    const currentAdapter=adapters.get(harness);
    const contextConnected=()=>!response.destroyed&&!request.aborted&&!request.socket.destroyed;
    const activeMessages=!humanStopHeld&&activeTurnId&&url.searchParams.get('consumeActive')==='1'
      ?await deferredMessages.offerActive(harness,sessionId,activeTurnId,async()=>{
        if(!currentAdapter?.getCoordinationActiveTurnId)return false;
        try{return await currentAdapter.getCoordinationActiveTurnId(sessionId)===activeTurnId;}
        catch{return false;}
      },async()=>{
        if(!contextConnected())return false;
        if(await coordinationHeld()){humanStopHeld=true;return false;}
        return contextConnected();
      }):[];
    // The hook may have waited for store/native reads. A late Stop suppresses output.
    if(humanStopHeld||activeMessages.length&&await coordinationHeld()){activeMessages.length=0;humanStopHeld=true;await deferredMessages.discardActive(harness,sessionId);}
    if(!contextConnected())return;
    const inboxContext = humanStopHeld ? null : renderDeferredMessages(inboxMessages);
    const context = [inboxContext, coordinationContext].filter(Boolean).join("\n\n") || null;
    return sendJson(response, 200, { context, inboxContext, inboxCount: inboxMessages.length, inboxIds:inboxMessages.map(message=>message.id), activeInboxContext:renderDeferredMessages(activeMessages), activeInboxIds:activeMessages.map(message=>message.id), active: Boolean(context), humanStopHeld });
  }
  if (url.pathname === "/api/coordination/inbox-ack" && request.method === "POST") {
    const body = await readJson(request);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (!sessionId || !Array.isArray(body.ids)) return sendJson(response,400,{error:"sessionId and ids required"});
    const requested = new Set(body.ids.filter((id):id is string=>typeof id === "string"));
    await deferredMessages.acknowledgeActive(sessionId,[...requested]);
    const pending = await deferredMessages.list(sessionId);
    const acknowledged = pending.filter(message=>requested.has(message.id)).map(message=>message.id);
    await deferredMessages.remove(acknowledged);
    return sendJson(response,200,{acknowledged:acknowledged.length});
  }
  if (url.pathname === "/api/coordination/activity" && request.method === "POST") {
    const body = await readJson(request);
    const harness = typeof body.harness === "string" ? body.harness.trim() : "";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const paths = Array.isArray(body.paths) ? body.paths.filter((value): value is string => typeof value === "string") : [];
    if (!harness || !sessionId || !cwd) return sendJson(response, 400, { error: "harness, sessionId, and cwd are required" });
    // Tool activity means a turn is executing: refresh the observed running
    // state so listings keep reporting "running" through long turns even when
    // neither the tasks-index row nor the native session DB has been written.
    markLifecycleEvent(harness, sessionId, "turn-start", cwd, events);
    const ttlSeconds = typeof body.ttlSeconds === "number" ? body.ttlSeconds : undefined;
    // Attribute each edited path to the git repo that owns it: a session
    // working across several repos reserves on several boards at once.
    const groups = new Map<string, string[]>();
    for (const path of paths) {
      const board = await boardForPath(path, cwd);
      const bucket = groups.get(board) ?? [];
      bucket.push(path);
      groups.set(board, bucket);
    }
    if (groups.size === 0) groups.set(cwd, []);

    // The tool-call hooks fired: the panel shows when they ran last.
    const activityHook = typeof body.hook === "string" ? body.hook : "";
    if (activityHook === "PreToolUse" || activityHook === "PostToolUse") {
      await hooksServiceOf().recordActivity({ hook: activityHook, outcome: "fired", sessionId, harness });
    }
    const blocks: string[] = [];
    const reservations: CoordinationNote[] = [];
    const conflicts: CoordinationConflict[] = [];
    for (const [board, boardPaths] of groups) {
      try {
        await coordinationNotes.heartbeatSession({ sessionId, cwd: board, ttlSeconds });
        if (boardPaths.length === 0) continue;
        const result = await coordinationNotes.reservePaths({ harness, sessionId, cwd: board, paths: boardPaths, ttlSeconds });
        reservations.push(...result.reservations);
        conflicts.push(...result.conflicts);
        if (result.conflicts.length) {
          blocks.push([
            "<agent-herder-path-conflict>",
            "Another agent recently worked on an overlapping path. Treat this as a soft lock: coordinate before editing if the work may overlap.",
            ...result.conflicts.map(({ path, note }) => `- path=${path} owner=${note.authorHarness || "agent"}:${note.authorSessionId} until=${note.expiresAt} note=${note.id} :: ${note.message}`),
            "</agent-herder-path-conflict>",
          ].join("\n"));
        }
      } catch (error) {
        console.error(`[agent-herder] coordination activity failed for board ${board}: ${(error as Error).message}`);
      }
    }
    // Peer rosters per touched board share per-board dedup slots: a session
    // sees a board's roster only when that board's roster changed.
    for (const board of groups.keys()) {
      const peersBlock = await coordinationNotes.renderWorkspacePeers({ harness, id: sessionId, cwd: board }).catch(() => null);
      if (peersBlock) blocks.push(peersBlock);
    }
    const context = blocks.length > 0 ? boundedCoordinationContext(blocks.join("\n\n")) : null;
    return sendJson(response, 200, { reservations, conflicts, context });
  }
  if (url.pathname === "/api/autopilot/stop" && request.method === "POST") {
    if (!backgroundAutopilotStop) return sendJson(response, 503, { error: "Background Autopilot is not active" });
    const body = await readJson(request);
    try {
      const job = backgroundAutopilotStop.submit(body as unknown as AutopilotRunnerInput);
      return sendJson(response, 202, { jobId: job.id, state: job.state });
    } catch (error) { return sendJson(response, 400, { error: (error as Error).message }); }
  }
  if (url.pathname === "/api/coordination/session-end" && request.method === "POST") {
    const body = await readJson(request);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (!sessionId) return sendJson(response, 400, { error: "sessionId is required" });
    const harness = typeof body.harness === "string" && body.harness.trim() ? body.harness.trim() : "zcode";
    markLifecycleEvent(harness, sessionId, "end", typeof body.cwd === "string" ? body.cwd : undefined, events);
    return sendJson(response, 200, await coordinationNotes.endSession(sessionId));
  }
  if (url.pathname === "/api/coordination/lifecycle" && request.method === "POST") {
    const body = await readJson(request);
    const harness = typeof body.harness === "string" ? body.harness.trim() : "";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const event = typeof body.event === "string" ? body.event.trim() : "";
    if(harness==='zcode'&&sessionId&&['user-prompt','tool-progress','turn-end'].includes(event)){
      const result=await supervisor.recordZcodeLifecycle(sessionId,typeof body.cwd==='string'?body.cwd:'',typeof body.turnId==='string'?body.turnId:'',event,typeof body.outcome==='string'?body.outcome:undefined);
      if((event==='user-prompt'&&result.origin!=='unknown')||(event==='turn-end'&&result.recorded))markLifecycleEvent(harness,sessionId,event==='user-prompt'?'turn-start':'turn-end',typeof body.cwd==='string'?body.cwd:undefined,events);
      return sendJson(response,200,{ok:true,...result});
    }
    if (harness && sessionId && event === "user-prompt") {
      const inputId = typeof body.inputId === "string" ? body.inputId : "";
      if (inputId.startsWith("agent-herder:auto:")) return sendJson(response, 200, { ok: true, released: false });
      const id = typeof body.promptId === "string" ? body.promptId : inputId || (typeof body.turnId === "string" ? body.turnId : "");
      const at = typeof body.at === "string" ? body.at : "";
      if (!id || !Number.isFinite(Date.parse(at))) return sendJson(response, 400, { error: "user-prompt requires promptId/inputId/turnId and valid at" });
      // A submitted user prompt starts a turn: mark it before anything else so
      // session listings report "running" for the whole turn, not only until
      // the tasks-index recency window expires.
      markLifecycleEvent(harness, sessionId, "turn-start", typeof body.cwd === "string" ? body.cwd : undefined, events);
      const released = await supervisor.releaseHumanStop(harness, sessionId, {
        id, at, ...(typeof body.turnId === "string" ? { turnId: body.turnId } : {}),
        ...(typeof body.text === "string" ? { text: body.text } : {}),
      });
      return sendJson(response, 200, { ok: true, released });
    }
    const allowed: SessionLifecycleEvent[] = ["start", "turn-start", "turn-end", "end"];
    if (!harness || !sessionId || !allowed.includes(event as SessionLifecycleEvent)) {
      return sendJson(response, 400, { error: "harness, sessionId, and event (start|turn-start|turn-end|end) are required" });
    }
    markLifecycleEvent(harness, sessionId, event as SessionLifecycleEvent, typeof body.cwd === "string" ? body.cwd : undefined, events);
    if (event === "end") await coordinationNotes.endSession(sessionId);
    return sendJson(response, 200, { ok: true });
  }
  // The hooks of the product: the lever of the owner and what the hooks did.
  // The lever belongs to the hooks alone: it never touches the automation
  // lever, the emergency pause or the policy of the projects.
  if (url.pathname === "/api/hooks" && request.method === "GET") {
    const view = await hooksServiceOf().readView();
    response.setHeader("etag", view.etag);
    response.setHeader("cache-control", "no-store");
    return sendJson(response, 200, view);
  }
  if (url.pathname === "/api/hooks/prohibitions" && request.method === "GET") {
    // The light answer the hook scripts ask for before they forbid anything.
    const read = await hooksServiceOf().readProhibitions();
    response.setHeader("etag", read.etag);
    response.setHeader("cache-control", "no-store");
    return sendJson(response, 200, read);
  }
  if (url.pathname === "/api/hooks/prohibitions" && request.method === "POST") {
    // Only an explicit action of the owner moves the lever.
    if (!isHooksOwnerRequest(request)) {
      return sendJson(response, 403, {
        ok: false,
        error: "Запреты хуков меняет только владелец панели.",
      });
    }
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendJson(response, 400, { ok: false, error: `Некорректное тело запроса: ${(error as Error).message}` });
    }
    if (body.source !== "owner") {
      return sendJson(response, 403, { ok: false, error: AUTOMATION_CANNOT_CHANGE_PROHIBITIONS_REASON });
    }
    const disabled = body.disabledHooks;
    if (disabled !== undefined && (!Array.isArray(disabled) || disabled.some((kind) => !isHookKind(kind)))) {
      return sendJson(response, 400, {
        ok: false,
        error: `Такого хука нет. Доступны: ${HOOK_KINDS.join(", ")}.`,
      });
    }
    // The revision of the state the owner read: a state that moved on is a
    // conflict, and nothing is written over it.
    const ifMatchHeader = request.headers["if-match"];
    const ifMatch = (Array.isArray(ifMatchHeader) ? ifMatchHeader[0] : ifMatchHeader)?.trim();
    if (ifMatch) {
      const current = await hooksServiceOf().prohibitions.readState();
      const expected = ifMatch.replace(/^W\//, "").replace(/^"|"$/g, "");
      const actual = current.etag.replace(/^"|"$/g, "");
      if (expected !== actual) {
        return sendJson(response, 412, {
          ok: false,
          error: "Состояние запретов хуков изменилось в другой вкладке. Обновите раздел и повторите.",
          current: { etag: current.etag },
        });
      }
    }
    const result = await hooksServiceOf().applyProhibitions({
      source: "owner",
      actor: typeof body.actor === "string" && body.actor.trim() ? body.actor.trim() : "owner",
      ...(typeof body.prohibitionsEnabled === "boolean" ? { prohibitionsEnabled: body.prohibitionsEnabled } : {}),
      ...(Array.isArray(disabled) ? { disabledHooks: disabled as HookKind[] } : {}),
      ...(typeof body.reason === "string" && body.reason.trim() ? { reason: body.reason.trim() } : {}),
    });
    if (!result.ok) {
      return sendJson(response, 400, { ok: false, code: result.code, error: result.reason });
    }
    response.setHeader("etag", result.view.etag);
    response.setHeader("cache-control", "no-store");
    return sendJson(response, 200, { ...result.view, ok: true, changed: result.changed });
  }
  if (url.pathname === "/api/hooks/activity" && request.method === "POST") {
    // What a hook did: the panel shows the last firing and the last refusal.
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch {
      return sendJson(response, 400, { ok: false, error: "Некорректное тело запроса" });
    }
    const recorded = await hooksServiceOf().recordActivity({
      hook: typeof body.hook === "string" ? body.hook : "",
      outcome: body.outcome === "refused" ? "refused" : "fired",
      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
      ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
      ...(typeof body.harness === "string" ? { harness: body.harness } : {}),
      ...(typeof body.at === "string" ? { at: body.at } : {}),
    });
    return sendJson(response, recorded ? 200 : 400, { ok: recorded });
  }
  if (url.pathname === "/api/autopilot/policy" && (request.method === "GET" || request.method === "PUT")) {
    if (!autopilotPolicyStore) return sendJson(response, 503, { error: "Autopilot policy store is disabled" });
    if (request.method === "GET") return sendJson(response, 200, await autopilotPolicyStore.readEffective());
    const body = await readJson(request);
    if (!body.policy || !(body.expectedRevision === null || typeof body.expectedRevision === "string")) {
      return sendJson(response, 400, { error: "policy and expectedRevision are required" });
    }
    try {
      return sendJson(response, 200, await autopilotPolicyStore.replacePolicy(body.policy as never, body.expectedRevision));
    } catch (error) {
      if (error instanceof AutopilotPolicyRevisionConflictError) {
        return sendJson(response, 409, { error: error.message, current: await autopilotPolicyStore.readEffective() });
      }
      return sendJson(response, 400, { error: (error as Error).message });
    }
  }
  const autopilotSessionMatch = url.pathname.match(/^\/api\/autopilot\/sessions\/([^/]+)\/([^/]+)$/);
  if (autopilotSessionMatch && (request.method === "GET" || request.method === "PUT" || request.method === "DELETE")) {
    if (!autopilotSessionStore) return sendJson(response, 503, { error: "Autopilot session store is disabled" });
    const harness = decodeURIComponent(autopilotSessionMatch[1]);
    const sessionId = decodeURIComponent(autopilotSessionMatch[2]);
    if (!isAutopilotHarness(harness) || sessionId.trim().length === 0) return sendJson(response, 400, { error: "unsupported harness or empty session id" });
    if (request.method === "GET") {
      const record = await autopilotSessionStore.get(harness, sessionId);
      const effective = autopilotPolicyStore ? await autopilotPolicyStore.readEffective() : undefined;
      const cwd = url.searchParams.get("cwd") || record?.cwd || "/";
      const inheritedEnabled = effective
        ? effectivePolicyAllowsTarget(effective, { harness, sessionId, cwd })
        : harness === "codex";
      return sendJson(response, 200, {
        harness,
        sessionId,
        enabled: record?.enabled ?? inheritedEnabled,
        source: record?.enabled !== undefined ? "session" : effective ? "policy" : harness === "codex" ? "plugin-default" : "default",
        ...(record ? { cwd: record.cwd, updatedAt: record.updatedAt } : {}),
      });
    }
    if (request.method === "DELETE") {
      await autopilotSessionStore.delete(harness, sessionId);
      // The incident binding of this session is gone: its card must not keep
      // receiving progress from this session.
      noticeplaceHealthObserver?.stopTarget({ harness, sessionId });
      const retained = await autopilotSessionStore.get(harness, sessionId);
      const effective = autopilotPolicyStore ? await autopilotPolicyStore.readEffective() : undefined;
      const cwd = url.searchParams.get("cwd") || retained?.cwd || "/";
      return sendJson(response, 200, {
        harness,
        sessionId,
        enabled: effective ? effectivePolicyAllowsTarget(effective, { harness, sessionId, cwd }) : harness === "codex",
        source: effective ? "policy" : harness === "codex" ? "plugin-default" : "default",
      });
    }
    const body = await readJson(request);
    if (typeof body.enabled !== "boolean" || typeof body.cwd !== "string" || body.cwd.trim().length === 0) {
      return sendJson(response, 400, { error: "enabled and cwd are required" });
    }
    try {
      const previous = await autopilotSessionStore.get(harness, sessionId);
      const requested = body.noticeIncident === undefined ? undefined : parseNoticeIncident(body.noticeIncident);
      // The center states the incident binding; the selected plan of that
      // binding comes from the launch request of the same session and is
      // remembered by the store. The observer never publishes a guessed plan:
      // the center only accepts progress for the selected plan.
      const planId = requested?.planId
        ?? previous?.noticeIncident?.planId
        ?? (requested ? await launchHealthPlans?.recall(harness, sessionId) : undefined);
      const noticeIncident = requested === undefined ? undefined : { ...requested, ...(planId ? { planId } : {}) };
      const record = await autopilotSessionStore.set({ harness, sessionId, cwd: body.cwd, ...(noticeIncident === undefined ? {} : { noticeIncident }) }, body.enabled);
      if (body.enabled && record.noticeIncident) {
        // The center armed this session for one original incident: watch it
        // until it ends and keep that incident's card truthful meanwhile.
        await noticeplaceHealthObserver?.start({ harness, sessionId, cwd: body.cwd, binding: record.noticeIncident });
      } else {
        // The session is not armed any more: stop watching it.
        noticeplaceHealthObserver?.stopTarget({ harness, sessionId });
      }
      return sendJson(response, 200, { ...record, source: "session" });
    } catch (error) {
      return sendJson(response, 400, { error: (error as Error).message });
    }
  }
  if (url.pathname === "/api/automation/launch-policy" && (request.method === "GET" || request.method === "PUT")) {
    if (request.method === "PUT" && hasNoticeplaceHealthBearer(request.headers.authorization)) {
      return sendJson(response, 403, { error: "Токен анализа инцидентов не разрешает менять политику запуска." });
    }
    if (!automationLaunchPolicyStore) return sendJson(response, 503, { error: "Launch policy is not configured", state: "unavailable" });
    if (request.method === "GET") {
      const loaded = await automationLaunchPolicyStore.readDocument();
      // The document identity travels with every read, so a later full write
      // can be rejected instead of overwriting a newer policy.
      response.setHeader("etag", loaded.etag);
      response.setHeader("cache-control", "no-store");
      if (loaded.kind === "valid") return sendJson(response, 200, loaded.policy);
      if (loaded.kind === "absent") return sendJson(response, 503, { error: "Launch policy is not configured", state: "absent" });
      return sendJson(response, 503, { error: "Launch policy is invalid", state: "invalid", detail: loaded.error });
    }
    try {
      const body = await readJson(request);
      validateAutomationLaunchPolicy(body);
      const header = request.headers["if-match"];
      const expected = (Array.isArray(header) ? header[0] : header)?.trim();
      if (!expected) {
        return sendJson(response, 428, {
          error: "Полное сохранение требует заголовок If-Match с версией политики, полученной при чтении.",
          state: "precondition_required",
        });
      }
      const previous = await automationLaunchPolicyStore.readDocument();
      const saved = await automationLaunchPolicyStore.replace(body, { ifMatch: expected });
      // The trail of the change is appended next to the policy. It is written
      // after the save and never blocks it.
      await appendLaunchPolicyAudit(automationLaunchPolicyStore.filePath,
        launchPolicyAuditRecord(previous.kind === "valid" ? previous.policy : undefined, saved.policy));
      response.setHeader("etag", saved.etag);
      response.setHeader("cache-control", "no-store");
      return sendJson(response, 200, saved.policy);
    } catch (error) {
      if (error instanceof LaunchPolicyConflictError) {
        return sendJson(response, 412, {
          error: "Политика запуска изменилась в другой вкладке. Ваши правки сохранены в форме и не отправлены.",
          state: "conflict",
        });
      }
      return sendJson(response, 400, { error: (error as Error).message });
    }
  }
  if (url.pathname === "/api/automation/disarm" && (request.method === "GET" || request.method === "POST")) {
    // The owner-level automation lever. The state is durable, survives a
    // restart and is confirmed across the fleet nodes, so the answer always
    // names every node and what it reported.
    const disarmStore = automationDisarmStore ?? AutomationDisarmStore.forRuntime();
    const disarmTransport = automationDisarmTransport ?? new DirectFleetDisarmTransport();
    // The state names the areas of the projects, so it is not public: the
    // read needs the same owner secret as the write. A node without a
    // configured secret fails closed for both.
    const expectedToken = configuredDisarmToken();
    if (!expectedToken) {
      return sendJson(response, 503, {
        ok: false, applied: false, records: [],
        nodes: [],
        summary: "the disarm token is not configured on this node — the lever was not moved",
        error: "AGENT_HERDER_DISARM_TOKEN is not configured on this node",
        reason: "AGENT_HERDER_DISARM_TOKEN is not configured on this node",
      });
    }
    const presented = bearerToken(request.headers.authorization);
    if (!presented || !sameSecret(presented, expectedToken)) {
      return sendJson(response, 401, {
        ok: false, applied: false, records: [],
        nodes: [],
        summary: "the disarm token is missing or wrong — the lever was not moved",
        error: "unauthorized",
        reason: "unauthorized",
      });
    }
    const stateView = (state: AutomationDisarmDocument) => ({
      ...state,
      blockedWorkKeysHuman: humanWorkKeys(state.blockedWorkKeys),
    });
    const nodeView = (nodes: FleetDisarmNodeResult[]) => nodes.map((node) => ({
      hostId: node.hostId, status: node.status, reason: node.reason ?? null,
    }));
    if (request.method === "GET") {
      // The read names the state, its revision and every node of the fleet.
      const state = await disarmStore.read();
      const etag = automationDisarmEtag(state);
      const nodes = await readFleetDisarmState({ transport: disarmTransport, state });
      response.setHeader("etag", etag);
      response.setHeader("cache-control", "no-store");
      return sendJson(response, 200, {
        ok: true,
        records: state.records,
        state: stateView(state),
        nodes: nodeView(nodes),
        summary: buildAutomationDisarmStateSummary({ records: state.records, nodes }),
        etag,
      });
    }
    let body: Record<string, unknown>;
    try {
      body = await readJson(request) as Record<string, unknown>;
    } catch (error) {
      return sendJson(response, 400, { ok: false, applied: false, error: `Некорректное тело запроса: ${(error as Error).message}`, nodes: [] });
    }
    // The secret proves who asks. The intent marker says what is asked: the
    // lever moves only for an explicit owner action.
    if (body.source !== "owner") {
      return sendJson(response, 403, {
        ok: false, applied: false, records: [],
        nodes: [],
        summary: "the request is not an explicit owner action — the lever was not moved",
        error: AUTOMATION_CANNOT_CHANGE_DISARM_REASON,
        reason: AUTOMATION_CANNOT_CHANGE_DISARM_REASON,
      });
    }
    // The revision of the state the caller read. Without it the write is
    // allowed, and the answer always carries the new revision.
    const ifMatchHeader = request.headers["if-match"];
    const ifMatch = (Array.isArray(ifMatchHeader) ? ifMatchHeader[0] : ifMatchHeader)?.trim();
    const policyRevision = await currentLaunchPolicyRevision(automationLaunchPolicyStore, disarmStore);
    let workKeys: string[] | undefined;
    if (body.workKeys !== undefined) {
      if (!Array.isArray(body.workKeys) || body.workKeys.some((key: unknown) => typeof key !== "string")) {
        return sendJson(response, 400, { ok: false, applied: false, error: "workKeys must be a list of strings", nodes: [] });
      }
      workKeys = body.workKeys as string[];
    }
    const answer = (result: {
      ok: boolean; applied: boolean; scope: string; forbidden: boolean;
      state: AutomationDisarmDocument; nodes: FleetDisarmNodeResult[]; summary: string;
    }) => {
      const etag = automationDisarmEtag(result.state);
      response.setHeader("etag", etag);
      response.setHeader("cache-control", "no-store");
      return sendJson(response, 200, {
        ok: result.ok, applied: result.applied,
        scope: result.scope, forbidden: result.forbidden,
        disarmed: result.state.disarmed,
        state: stateView(result.state),
        records: result.state.records,
        nodes: nodeView(result.nodes),
        summary: result.summary,
        etag,
      });
    };
    // The scope shape: one record per scope, and the same interface lifts a
    // prohibition as it sets one.
    if (body.scope !== undefined) {
      if (typeof body.scope !== "string" || !body.scope.trim()) {
        return sendJson(response, 400, { ok: false, applied: false, error: "scope must be * or an absolute project path", nodes: [] });
      }
      const scope = body.scope.trim();
      if (scope !== ALL_SCOPES && !isAbsolute(scope)) {
        return sendJson(response, 400, { ok: false, applied: false, error: "scope must be * or an absolute project path", nodes: [] });
      }
      if (typeof body.forbidden !== "boolean") {
        return sendJson(response, 400, { ok: false, applied: false, error: "forbidden must be a boolean", nodes: [] });
      }
      const result = await setAutomationDisarmRecord({
        scope,
        forbidden: body.forbidden,
        ...(typeof body.owner === "string" && body.owner.trim() ? { owner: body.owner.trim().slice(0, 200) } : {}),
        ...(typeof body.reason === "string" && body.reason.trim() ? { reason: body.reason.trim().slice(0, 500) } : {}),
        ...(workKeys === undefined ? {} : { workKeys }),
        ...(ifMatch ? { ifMatch } : {}),
        ...(policyRevision ? { policyRevision } : {}),
        reach: "fleet",
        source: "owner",
        store: disarmStore,
        transport: disarmTransport,
      });
      if (!result.applied && result.code === "state_conflict") {
        // The state moved under the caller: nothing was written.
        const etag = automationDisarmEtag(result.state);
        response.setHeader("etag", etag);
        response.setHeader("cache-control", "no-store");
        return sendJson(response, 412, {
          ok: false, applied: false, scope, forbidden: body.forbidden,
          records: result.state.records,
          state: stateView(result.state),
          nodes: [],
          summary: "the state changed since it was read — nothing was written",
          error: "state_conflict",
          reason: result.reason,
          etag,
        });
      }
      return answer({
        ok: result.ok, applied: result.applied, scope: result.scope, forbidden: result.forbidden,
        state: result.state, nodes: result.nodes,
        summary: buildAutomationDisarmSummary({
          applied: result.applied, disarmed: result.forbidden, nodes: result.nodes, scope: result.scope,
        }),
      });
    }
    // The earlier flat shape: the catch-all scope and the flat list of works.
    if (typeof body.disarmed !== "boolean") return sendJson(response, 400, { ok: false, applied: false, error: "disarmed must be a boolean", nodes: [] });
    const result = await setAutomationDisarm({
      disarmed: body.disarmed,
      ...(workKeys === undefined ? {} : { workKeys }),
      ...(typeof body.reason === "string" && body.reason.trim() ? { reason: body.reason.trim().slice(0, 500) } : {}),
      ...(policyRevision ? { policyRevision } : {}),
      scope: "fleet",
      source: "owner",
      store: disarmStore,
      transport: disarmTransport,
    });
    return answer({
      ok: result.ok, applied: result.applied,
      scope: ALL_SCOPES, forbidden: result.disarmed,
      state: result.state, nodes: result.nodes,
      summary: buildAutomationDisarmSummary(result),
    });
  }
  if (url.pathname === "/api/session-images" && request.method === "POST") {
    if (!sessionImages) return sendJson(response, 503, { error: "Прикрепление изображений недоступно." });
    try {
      const body = await readJson(request, 8 * 1024 * 1024);
      for (const key of ["harness", "sessionId", "fileName", "mimeType", "dataBase64"]) if (typeof body[key] !== "string") throw new Error("Некорректное изображение.");
      const harness = body.harness as string, sessionId = body.sessionId as string;
      if (!adapters.get(harness)?.controlCapabilities?.imageInput) throw new Error("Эта среда пока не принимает изображения.");
      if (!await supervisor.getSession(harness, sessionId)) return sendJson(response, 404, { error: "Чат не найден." });
      return sendJson(response, 200, await sessionImages.upload(body as unknown as Parameters<SessionImageStore["upload"]>[0]));
    } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
  }
  const imageMatch = url.pathname.match(/^\/api\/session-images\/([a-f0-9]{64})$/);
  if (imageMatch && request.method === "GET") {
    try {
      const image = await sessionImages!.content(imageMatch[1]);
      response.writeHead(200, { "content-type": image.mimeType, "content-length": image.bytes.length, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" });
      response.end(image.bytes); return;
    } catch { return sendJson(response, 404, { error: "Изображение не найдено." }); }
  }
  if (url.pathname === "/api/session-autocompact" && (request.method === "GET" || request.method === "PUT")) {
    if (!autoCompactStore || !autoCompactService) return sendJson(response, 503, { error: "Автокомпакт недоступен." });
    if (request.method === "PUT") {
      const body = await readJson(request);
      try { await autoCompactStore.updateSettings(body.settings as import("../autocontinue/auto-compact.js").AutoCompactSettings); }
      catch (error) { return sendJson(response, 400, { error: (error as Error).message }); }
    }
    const state = await autoCompactStore.read();
    return sendJson(response, 200, { settings: state.settings, supportedHarnesses: autoCompactService.supportedHarnesses(), operations: state.operations.slice(-10) });
  }
  if (url.pathname === "/api/automation/project-launch" && request.method === "POST") {
    if (!projectLaunchDispatch) return sendJson(response, 503, { error: "Project launch routing is not configured" });
    const body = await readJson(request);
    const healthAnalysis = body.purpose === NOTICEPLACE_HEALTH_PURPOSE;
    const healthBearer = hasNoticeplaceHealthBearer(request.headers.authorization);
    if (healthAnalysis && !healthBearer) return sendJson(response, 401, { error: "Для анализа инцидента нужен отдельный токен Notice Place." });
    if (healthBearer && !healthAnalysis) return sendJson(response, 403, { error: "Токен Notice Place разрешает только анализ инцидента." });
    // The center states the model of the incident execution bare (the modelID
    // alone); a route is stated as provider/model. The analysis path accepts
    // both spellings, exactly like the repair path does.
    const launchModel = healthAnalysis ? qualifyNoticeplaceHealthModel(body.model) : body.model;
    if (healthAnalysis) {
      const error = validateNoticeplaceHealthLaunch({ harness: body.harness, model: launchModel, operationId: body.operation_id });
      if (error) return sendJson(response, 400, { error });
    }
    if (!validSourceSessions(body.sourceSessions) || !validProjectLaunchSourceSessions(body.sourceSessions)) {
      return sendJson(response, 400, { error: "source session references are invalid or lack host identity" });
    }
    try {
      const result = await projectLaunchDispatch({
        ...(healthAnalysis ? { [NOTICEPLACE_HEALTH_AUTHORIZED]: true as const } : {}),
        project: typeof body.project === "string" ? body.project : "",
        cwd: typeof body.cwd === "string" ? body.cwd : "",
        message: typeof body.message === "string" ? body.message : "",
        ...(typeof body.harness === "string" ? { harness: body.harness as HarnessType } : {}),
        ...(typeof launchModel === "string" ? { model: launchModel } : {}),
        ...(body.mode === "queue" ? { mode: "queue" as const } : {}),
        ...(typeof body.operation_id === "string" ? { operationId: body.operation_id } : {}),
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(Array.isArray(body.sourceSessions) ? { sourceSessions: body.sourceSessions as Array<{ harness: HarnessType; sessionId: string; hostId: string }> } : {}),
      });
      // The center states the selected health plan in the launch message; the
      // arming call of the same session carries only the incident id, so the
      // plan of that launch is remembered here.
      if (result.outcome !== "no_harness") {
        const plan = resolveLaunchHealthPlan(typeof body.message === "string" ? body.message : "")?.planId;
        if (plan && result.sessionId) await launchHealthPlans?.remember(result.harness ?? (typeof body.harness === "string" ? body.harness : ""), result.sessionId, plan);
      }
      return sendJson(response, result.outcome === "no_harness" ? 409 : 200, result);
    } catch (error) {
      return sendJson(response, 400, { error: (error as Error).message });
    }
  }
  if (url.pathname === "/api/quota-recovery/waits" && request.method === "GET") {
    const harness = url.searchParams.get("harness")?.trim();
    const sessionId = url.searchParams.get("sessionId")?.trim();
    const cwd = url.searchParams.get("cwd")?.trim();
    if (!harness || !sessionId || !cwd) return sendJson(response, 400, { error: "harness, sessionId, and cwd are required" });
    try {
      const wait = await supervisor.getQuotaRecoveryWaitStatus(harness, sessionId, cwd);
      return sendJson(response, 200, { wait });
    } catch (error) {
      return sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (url.pathname === "/api/native-model-route-proof" && request.method === "GET") {
    response.setHeader("cache-control", "no-store");
    const remoteAddress = request.socket.remoteAddress;
    if (remoteAddress !== "127.0.0.1" && remoteAddress !== "::1" && remoteAddress !== "::ffff:127.0.0.1") {
      return sendJson(response, 403, { error: "Route proof is available only to local harness plugins" });
    }
    const nativeModelId = url.searchParams.get("modelId")?.trim() ?? "";
    if (!nativeModelId.startsWith("omniroute/") || nativeModelId.length > 512 || /[\u0000-\u001f\u007f]/u.test(nativeModelId)) {
      return sendJson(response, 400, { error: "A fully qualified OmniRoute modelId is required" });
    }
    const adapter = adapters.get("opencode") as (HarnessAdapter & {
      resolveModelProviderLeaves?: (modelId: string) => Promise<{
        nativeHarness: string;
        nativeModelId: string;
        resolvedProviderLeaves: Array<{ providerId: string; modelId: string }>;
      } | null>;
    }) | undefined;
    if (!adapter?.resolveModelProviderLeaves) return sendJson(response, 503, { error: "OpenCode route resolver is unavailable" });
    try {
      const proof = await adapter.resolveModelProviderLeaves(nativeModelId);
      const leaves = proof?.resolvedProviderLeaves;
      if (!proof || proof.nativeHarness !== "opencode" || proof.nativeModelId !== nativeModelId
        || !Array.isArray(leaves) || leaves.length === 0 || leaves.length > 64
        || leaves.some((leaf) => !leaf || typeof leaf.providerId !== "string" || !leaf.providerId.trim()
          || typeof leaf.modelId !== "string" || !leaf.modelId.trim())) {
        return sendJson(response, 409, { error: "The complete native provider route could not be verified" });
      }
      return sendJson(response, 200, {
        nativeHarness: "opencode",
        nativeModelId,
        resolvedProviderLeaves: leaves.map(({ providerId, modelId }) => ({ providerId, modelId })),
      });
    } catch {
      return sendJson(response, 503, { error: "The complete native provider route could not be verified" });
    }
  }
  if (url.pathname === "/api/human-stop/status" && request.method === "GET") {
    response.setHeader("cache-control", "no-store");
    const harness = url.searchParams.get("harness")?.trim();
    const sessionId = url.searchParams.get("sessionId")?.trim();
    if (!harness || !sessionId) return sendJson(response, 400, { error: "harness and sessionId are required" });
    if (!["opencode", "zcode", "codex", "claude", "qoder", "hermes", "fast-agent", "chatgpt", "minimax-code"].includes(harness)) return sendJson(response, 400, { error: "unknown harness" });
    return sendJson(response, 200, { harness, sessionId, held: await getHumanStopStore().isHeld(harness, sessionId) });
  }
  if (url.pathname === "/api/quota-recovery/operator-cohort/enroll" && request.method === "POST") {
    if (!automationLaunchPolicyStore) return sendJson(response, 503, { error: "Project launch policy is unavailable" });
    const loadedLaunchPolicy = await automationLaunchPolicyStore.load();
    if (loadedLaunchPolicy.kind !== "valid") return sendJson(response, 503, { error: "Project launch policy is not valid" });
    const body = await readJson(request);
    const authorizationId = typeof body.authorizationId === "string" ? body.authorizationId.trim() : "";
    const operatorContinuation = body.intent === "new_operator_continuation";
    if (body.intent !== undefined && !operatorContinuation) return sendJson(response, 400, { error: "unknown operator enrollment intent" });
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/u.test(authorizationId)) {
      return sendJson(response, 400, { error: "authorizationId must be a stable operator enrollment ID" });
    }
    if (!Array.isArray(body.entries) || body.entries.length === 0 || body.entries.length > 64) {
      return sendJson(response, 400, { error: "entries must contain 1 to 64 exact OpenCode session selections" });
    }
    const entries: Array<OperatorCohortEnrollmentTarget | OperatorContinuationEnrollmentTarget> = [];
    const keys = new Set<string>();
    for (const value of body.entries) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return sendJson(response, 400, { error: "invalid cohort entry" });
      const item = value as Record<string, unknown>;
      const sessionId = typeof item.sessionId === "string" ? item.sessionId.trim() : "";
      const cwd = typeof item.cwd === "string" ? item.cwd.trim() : "";
      if (!sessionId || sessionId.length > 512 || !cwd || cwd.length > 4096) return sendJson(response, 400, { error: "invalid exact OpenCode session selection" });
      const key = `${sessionId}\u0000${cwd}`;
      if (keys.has(key)) return sendJson(response, 400, { error: "duplicate session selection" });
      keys.add(key);
      if (operatorContinuation) {
        const prior = item.priorAccepted;
        if (!prior || typeof prior !== "object" || Array.isArray(prior)) return sendJson(response, 400, { error: "new operator continuation requires the exact prior accepted receipt" });
        const receipt = prior as Record<string, unknown>;
        if ([receipt.dispatchInputId, receipt.nativeInputMessageId].some((part) => typeof part !== "string" || !part.trim() || part.length > 512)) {
          return sendJson(response, 400, { error: "invalid prior accepted input receipt" });
        }
        entries.push({ sessionId, cwd, priorAccepted: {
          dispatchInputId: (receipt.dispatchInputId as string).trim(),
          nativeInputMessageId: (receipt.nativeInputMessageId as string).trim(),
        } });
      } else {
        const expected = item.expected;
        if (!expected || typeof expected !== "object" || Array.isArray(expected)) return sendJson(response, 400, { error: "each entry requires exact expected native terminal identity" });
        const identity = expected as Record<string, unknown>;
        if ([identity.nativeTurnId, identity.assistantMessageId, identity.providerId, identity.modelId].some((part) => typeof part !== "string" || !part.trim() || part.length > 512)
          || !(typeof identity.completedAt === "string" || typeof identity.completedAt === "number")) {
          return sendJson(response, 400, { error: "invalid exact terminal identity in cohort entry" });
        }
        const completedAtDate = new Date(identity.completedAt as string | number);
        if (!Number.isFinite(completedAtDate.getTime())) return sendJson(response, 400, { error: "invalid terminal completion time" });
        entries.push({ sessionId, cwd, expected: {
          nativeTurnId: (identity.nativeTurnId as string).trim(),
          assistantMessageId: (identity.assistantMessageId as string).trim(),
          providerId: (identity.providerId as string).trim(),
          modelId: (identity.modelId as string).trim(),
          completedAt: completedAtDate.toISOString(),
        } });
      }
    }
    const results = [];
    for (const entry of entries) {
      const route = findProjectRoute(loadedLaunchPolicy.policy, entry.cwd);
      const configuredFallbacks = loadedLaunchPolicy.policy.fallbackModels?.opencode ?? [];
      if (route && !route.harnesses.includes("opencode")) {
        results.push({ sessionId: entry.sessionId, outcome: "ineligible" as const, reason: "project_policy_disallows_opencode" });
        continue;
      }
      if (!configuredFallbacks.length) {
        results.push({ sessionId: entry.sessionId, outcome: "ineligible" as const, reason: "project_policy_has_no_configured_fallback" });
        continue;
      }
      results.push(operatorContinuation
        ? await supervisor.enrollOperatorContinuationEntry(authorizationId, entry as OperatorContinuationEnrollmentTarget)
        : await supervisor.enrollOperatorCohortEntry(authorizationId, entry as OperatorCohortEnrollmentTarget));
    }
    const enrolled = results.filter((result) => result.outcome === "enrolled" || result.outcome === "already_enrolled").length;
    return sendJson(response, enrolled === results.length ? 200 : 207, {
      authorizationId,
      ...(operatorContinuation ? { intent: "new_operator_continuation" } : {}),
      selected: results.length,
      enrolled,
      results,
    });
  }
  if (url.pathname === "/api/session-autostart" && (request.method === "GET" || request.method === "PUT")) {
    if (!sessionAutostartStore) return sendJson(response, 503, { error: "Session autostart settings are disabled" });
    if (request.method === "GET") return sendJson(response, 200, await sessionAutostartStore.getSettings());
    const body = await readJson(request);
    if (body.pinActiveSessions !== undefined || body.rolloverExpiredCache !== undefined || body.movePinnedOnRollover !== undefined || body.inventoryWindowHours !== undefined || body.evidenceMessageCount !== undefined || body.watchdogEnabled !== undefined || body.watchdogIntervalSeconds !== undefined || body.stalledTurnMinutes !== undefined || body.judgeModel !== undefined || body.autopilotJudgeModel !== undefined || body.recoverOnFailure !== undefined || body.recoverOnDisconnect !== undefined) {
      if (typeof body.enabled !== "boolean" || typeof body.pinActiveSessions !== "boolean" || typeof body.rolloverExpiredCache !== "boolean" || typeof body.movePinnedOnRollover !== "boolean" || typeof body.inventoryWindowHours !== "number" || typeof body.evidenceMessageCount !== "number" || typeof body.watchdogEnabled !== "boolean" || typeof body.watchdogIntervalSeconds !== "number" || typeof body.stalledTurnMinutes !== "number" || typeof body.judgeModel !== "string" || typeof body.autopilotJudgeModel !== "string") {
        return sendJson(response, 400, { error: "all autocontinue runtime settings are required" });
      }
      if ((body.recoverOnFailure !== undefined && typeof body.recoverOnFailure !== "boolean") || (body.recoverOnDisconnect !== undefined && typeof body.recoverOnDisconnect !== "boolean")) {
        return sendJson(response, 400, { error: "autocontinue recovery settings must be boolean" });
      }
      if (body.waitForQuota !== undefined && typeof body.waitForQuota !== "boolean") return sendJson(response, 400, { error: "waitForQuota must be a boolean" });
      if (body.fallbackForQuota !== undefined && typeof body.fallbackForQuota !== "boolean") return sendJson(response, 400, { error: "fallbackForQuota must be a boolean" });
      try {
        const saved = await sessionAutostartStore.setRuntimeSettings({
          enabled: body.enabled,
          waitForQuota: body.waitForQuota,
          fallbackForQuota: body.fallbackForQuota,
          pinActiveSessions: body.pinActiveSessions,
          rolloverExpiredCache: body.rolloverExpiredCache,
          movePinnedOnRollover: body.movePinnedOnRollover,
          inventoryWindowHours: body.inventoryWindowHours,
          evidenceMessageCount: body.evidenceMessageCount,
          watchdogEnabled: body.watchdogEnabled,
          watchdogIntervalSeconds: body.watchdogIntervalSeconds,
          stalledTurnMinutes: body.stalledTurnMinutes,
          judgeModel: body.judgeModel,
          autopilotJudgeModel: body.autopilotJudgeModel,
          recoverOnFailure: body.recoverOnFailure,
          recoverOnDisconnect: body.recoverOnDisconnect,
        });
        await supervisor.reconcileQuotaRecoverySettings();
        return sendJson(response, 200, { ...saved, source: "persisted" });
      } catch (error) {
        return sendJson(response, 400, { error: (error as Error).message });
      }
    }
    if ((body.enabled !== undefined && typeof body.enabled !== "boolean")
      || (body.waitForQuota !== undefined && typeof body.waitForQuota !== "boolean")
      || (body.fallbackForQuota !== undefined && typeof body.fallbackForQuota !== "boolean")) {
      return sendJson(response, 400, { error: "enabled and waitForQuota must be booleans" });
    }
    if (body.enabled === undefined && body.waitForQuota === undefined && body.fallbackForQuota === undefined) return sendJson(response, 400, { error: "enabled or waitForQuota is required" });
    const saved = await sessionAutostartStore.setGlobalOptions({ enabled: body.enabled, waitForQuota: body.waitForQuota, fallbackForQuota: body.fallbackForQuota });
    await supervisor.reconcileQuotaRecoverySettings();
    return sendJson(response, 200, { ...saved, source: "persisted" });
  }
  const autostartHarnessMatch = url.pathname.match(/^\/api\/session-autostart\/harnesses\/([^/]+)$/);
  if (autostartHarnessMatch && (request.method === "GET" || request.method === "PUT" || request.method === "DELETE")) {
    if (!sessionAutostartStore) return sendJson(response, 503, { error: "Session autostart settings are disabled" });
    const harness = decodeURIComponent(autostartHarnessMatch[1]);
    try {
      if (request.method === "GET") return sendJson(response, 200, { harness, ...await sessionAutostartStore.getHarnessEffective(harness) });
      if (request.method === "DELETE") {
        await sessionAutostartStore.deleteHarness(harness);
        await supervisor.reconcileQuotaRecoverySettings();
        return sendJson(response, 200, { harness, ...await sessionAutostartStore.getHarnessEffective(harness) });
      }
      const body = await readJson(request);
      const hasEnabled = body.enabled !== undefined;
      const hasQuota = Object.hasOwn(body, "waitForQuota");
      const hasFallback = Object.hasOwn(body, "fallbackForQuota");
      if (hasFallback && body.fallbackForQuota !== null && typeof body.fallbackForQuota !== "boolean") return sendJson(response, 400, {error: "fallbackForQuota must be a boolean or null"});
      if (hasFallback && !hasQuota) return sendJson(response, 400, {error: "waitForQuota is required with fallbackForQuota"});
      if (!hasEnabled && !hasQuota) return sendJson(response, 400, { error: "enabled or waitForQuota is required" });
      if (hasEnabled && typeof body.enabled !== "boolean") return sendJson(response, 400, { error: "enabled must be a boolean" });
      if (hasQuota && body.waitForQuota !== null && typeof body.waitForQuota !== "boolean") return sendJson(response, 400, { error: "waitForQuota must be a boolean or null" });
      if (hasEnabled) await sessionAutostartStore.setHarness(harness, body.enabled as boolean);
      if (hasQuota) await sessionAutostartStore.setHarnessWaitForQuota(harness, body.waitForQuota as boolean | null, new Date(), body.fallbackForQuota as boolean | null | undefined);
      await supervisor.reconcileQuotaRecoverySettings();
      return sendJson(response, 200, { harness, ...await sessionAutostartStore.getHarnessEffective(harness) });
    } catch (error) {
      return sendJson(response, 400, { error: (error as Error).message });
    }
  }
  const autostartSessionMatch = url.pathname.match(/^\/api\/session-autostart\/sessions\/([^/]+)\/([^/]+)$/);
  if (autostartSessionMatch && (request.method === "GET" || request.method === "PUT" || request.method === "DELETE")) {
    if (!sessionAutostartStore) return sendJson(response, 503, { error: "Session autostart settings are disabled" });
    const harness = decodeURIComponent(autostartSessionMatch[1]);
    const sessionId = decodeURIComponent(autostartSessionMatch[2]);
    const cwd = url.searchParams.get("cwd") || "/";
    try {
      if (request.method === "GET") return sendJson(response, 200, { harness, sessionId, ...await sessionAutostartStore.getEffective(harness, sessionId, cwd) });
      if (request.method === "DELETE") {
        await sessionAutostartStore.deleteSession(harness, sessionId);
        await supervisor.reconcileQuotaRecoverySettings();
        return sendJson(response, 200, { harness, sessionId, ...await sessionAutostartStore.getEffective(harness, sessionId, cwd) });
      }
      const body = await readJson(request);
      const hasEnabled = body.enabled !== undefined;
      const hasQuota = Object.hasOwn(body, "waitForQuota");
      const hasFallback = Object.hasOwn(body, "fallbackForQuota");
      if (hasFallback && body.fallbackForQuota !== null && typeof body.fallbackForQuota !== "boolean") return sendJson(response, 400, {error: "fallbackForQuota must be a boolean or null"});
      if (hasFallback && !hasQuota) return sendJson(response, 400, {error: "waitForQuota is required with fallbackForQuota"});
      if ((!hasEnabled && !hasQuota) || typeof body.cwd !== "string" || !body.cwd.trim()) return sendJson(response, 400, { error: "enabled or waitForQuota and cwd are required" });
      if (hasEnabled && typeof body.enabled !== "boolean") return sendJson(response, 400, { error: "enabled must be a boolean" });
      if (hasQuota && body.waitForQuota !== null && typeof body.waitForQuota !== "boolean") return sendJson(response, 400, { error: "waitForQuota must be a boolean or null" });
      if (hasEnabled) await sessionAutostartStore.setSession({ harness, sessionId, cwd: body.cwd, ...(body.noticeIncident === undefined ? {} : { noticeIncident: body.noticeIncident }) }, body.enabled as boolean);
      if (hasQuota) await sessionAutostartStore.setSessionWaitForQuota({ harness, sessionId, cwd: body.cwd }, body.waitForQuota as boolean | null, new Date(), body.fallbackForQuota as boolean | null | undefined);
      await supervisor.reconcileQuotaRecoverySettings();
      return sendJson(response, 200, { harness, sessionId, ...await sessionAutostartStore.getEffective(harness, sessionId, body.cwd) });
    } catch (error) {
      return sendJson(response, 400, { error: (error as Error).message });
    }
  }
  if (request.method === "GET" && url.pathname === "/api/autopilot/choices") {
    if (!choiceRegistry) return sendJson(response, 503, { error: "Choice registry is disabled" });
    const status = url.searchParams.get("status") || "pending";
    if (status !== "pending") return sendJson(response, 400, { error: "status must be pending" });
    const records = await choiceRegistry.list({ status: "pending" });
    // A forgotten manual choice must not keep a stopped session pinned in the
    // active dashboard forever. Keep the durable registry intact, but only
    // project recent pending choices into the web UI.
    const staleChoiceCutoffMs = Date.now() - 24 * 60 * 60 * 1000;
    const visibleRecords = records.filter((record) => {
      const createdAt = Date.parse(record.createdAt);
      return Number.isFinite(createdAt) && createdAt >= staleChoiceCutoffMs;
    });
    return sendJson(response, 200, {
      choices: visibleRecords.map((record) => ({
        requestId: record.requestId,
        sessionId: record.sessionId,
        harness: record.harness ?? "codex",
        cwd: record.cwd,
        status: record.status,
        createdAt: record.createdAt,
        choices: record.choices.map(({ choiceId, label }) => ({ choiceId, label })),
      })),
    });
  }
  const internalChoiceSelection = url.pathname === "/internal/autopilot/choices/select";
  const webChoiceSelection = url.pathname === "/api/autopilot/choices/select";
  if (request.method === "POST" && (internalChoiceSelection || webChoiceSelection)) {
    if (!choiceRegistry) return sendJson(response, 503, { error: "Choice registry is disabled" });
    if (internalChoiceSelection && mcpAuthToken && !sameSecret(request.headers.authorization, `Bearer ${mcpAuthToken}`)) return sendJson(response, 401, { error: "unauthorized" });
    const body = await readJson(request);
    if (!isUuid(body.request_id) || typeof body.choice_id !== "string" || body.choice_id.trim() === "") return sendJson(response, 400, { error: "request_id and choice_id are required" });
    const claimed = await choiceRegistry.claimForResume(body.request_id, body.choice_id);
    const pending = claimed.record;
    if (pending.harness === "hermes" && pending.choiceId === body.choice_id) {
      if (pending.status === "claimed") {
        const resumed = await choiceRegistry.markResumed(pending.requestId, pending.choiceId);
        return sendJson(response, 202, { request_id: resumed.requestId, status: resumed.status, choice_id: resumed.choiceId, session_id: resumed.sessionId, resumed: true, transport: "hermes-plugin" });
      }
      return sendJson(response, 202, { request_id: pending.requestId, status: pending.status, choice_id: pending.choiceId, session_id: pending.sessionId, resumed: pending.status === "resumed", duplicate: !claimed.claimed, transport: "hermes-plugin" });
    }
    if (!claimed.claimed) {
      if (
        pending.status === "claimed" &&
        pending.choiceId === body.choice_id &&
        pending.nextGoal &&
        pending.idempotencyKey
      ) {
        const resumeRequest = buildChoiceResumeRequest(pending);
        if (pending.resumeReceipt?.status === "accepted") {
          const resumed = await choiceRegistry.markResumed(pending.requestId, pending.choiceId);
          return sendJson(response, 202, { request_id: resumed.requestId, status: resumed.status, choice_id: resumed.choiceId, session_id: resumed.sessionId, resumed: true, recovered: true, transport: "agent-resume" });
        }
        try {
          const client = new AgentResumeClient();
          const receipt = await (choiceQuery ?? ((input) => client.queryReceipt(input)))(resumeRequest);
          return completeManualChoiceResume(response, choiceRegistry, pending, receipt, true);
        } catch (error) {
          return sendJson(response, 502, { request_id: pending.requestId, status: pending.status, choice_id: pending.choiceId, session_id: pending.sessionId, resumed: false, duplicate: true, error: `Agent Resume receipt query failed: ${(error as Error).message}` });
        }
      }
      return sendJson(response, 202, {
        request_id: pending.requestId,
        status: pending.status,
        choice_id: pending.choiceId,
        session_id: pending.sessionId,
        resumed: false,
        duplicate: true,
      });
    }
    if (pending.sessionId.length === 0 || !pending.nextGoal) return sendJson(response, 409, { error: "choice has no resumable goal" });
    const resumeRequest = buildChoiceResumeRequest(pending);
    try {
      const receipt = await (choiceManualResume ?? ((input) => resumeSelectedTarget(input, supervisor, "human")))(resumeRequest);
      return completeManualChoiceResume(response, choiceRegistry, pending, receipt, false);
    } catch (error) {
      return sendJson(response, 502, { request_id: pending.requestId, status: pending.status, choice_id: pending.choiceId, session_id: pending.sessionId, resumed: false, error: `Agent Resume invocation failed: ${(error as Error).message}` });
    }
  }
  if (url.pathname === "/api/models" && request.method === "GET") {
    const harness = url.searchParams.get("harness")?.trim();
    if (!harness) return sendJson(response, 400, { error: "harness is required" });
    try {
      return sendJson(response, 200, await supervisor.getModels(harness));
    } catch (error) {
      return sendJson(response, 404, { error: (error as Error).message });
    }
  }
  if (url.pathname === "/api/adapters" && request.method === "GET") {
    if (!adapterRegistry) return sendJson(response, 503, { error: "Adapter registry is disabled" });
    return sendJson(response, 200, { adapters: adapterRegistry.list(), eventSources: supervisor.getEventSources() });
  }
  if (url.pathname === "/api/adapters/events" && request.method === "GET") {
    return sendJson(response, 200, { eventSources: supervisor.getEventSources() });
  }
  const adapterMatch = url.pathname.match(/^\/api\/adapters\/([^/]+)$/);
  if (adapterMatch && request.method === "POST") {
    if (!adapterRegistry) return sendJson(response, 503, { error: "Adapter registry is disabled" });
    const body = await readJson(request);
    if (typeof body.enabled !== "boolean") return sendJson(response, 400, { error: "enabled must be boolean" });
    try {
      const adapter = await adapterRegistry.setEnabled(decodeURIComponent(adapterMatch[1]), body.enabled);
      return sendJson(response, 200, { adapter });
    } catch (error) {
      return sendJson(response, 404, { error: (error as Error).message });
    }
  }
  if (url.pathname === "/mcp" && (request.method === "POST" || request.method === "GET" || request.method === "DELETE")) {
    if (mcpAuthToken && !sameSecret(request.headers.authorization, `Bearer ${mcpAuthToken}`)) {
      return sendJson(response, 401, { error: "unauthorized" });
    }
    if (!mcpNodeHandler) return sendJson(response, 503, { error: "MCP HTTP transport is disabled" });
    await mcpNodeHandler(request, response);
    return;
  }
  if (request.method === "POST" && url.pathname === "/internal/human-requests") {
    if (!humanRequests) return sendJson(response, 503, { error: "Human Request registry is disabled" });
    const body = await readJson(request);
    try {
      // One question binding for exactly one Notice Ask card. Herder never sends
      // a second card of its own.
      const binding = await askHuman(humanRequests, {
        kind: body.kind === "secret" ? "secret" : "user",
        target: await verifiedQuestionTarget(body, adapters),
        ...(typeof body.message === "string" ? { message: body.message } : {}),
        ...(Array.isArray(body.choices) ? { choices: body.choices as Array<{ choiceId: string; label: string }> } : {}),
        ...(typeof body.context_ref === "string" ? { contextRef: body.context_ref } : {}),
      });
      const { record, ...question } = binding;
      return sendJson(response, 201, {
        ...question,
        status: record.status,
        continuation: record.continuation,
      });
    } catch (error) {
      const reason = (error as Error).message;
      if (/not found|is not in/.test(reason)) return sendJson(response, 404, { error: reason });
      // The native session exists; a malformed question is a bad request.
      return sendJson(response, 400, { error: reason });
    }
  }
  if (request.method === "POST" && url.pathname === "/internal/human-requests/cancel") {
    if (!humanRequests) return sendJson(response, 503, { error: "Human Request registry is disabled" });
    const body = await readJson(request);
    if (typeof body.request_id !== "string" || body.request_id.length === 0) {
      return sendJson(response, 400, { error: "request_id is required" });
    }
    // An explicit reason is required: a bound question must not be withdrawn
    // casually, and the reason is the audit record of why it went away.
    if (typeof body.reason !== "string" || body.reason.trim().length === 0) {
      return sendJson(response, 400, { error: "reason is required to cancel a bound question" });
    }
    try {
      // An expired or withdrawn question must not hold its session behind the
      // pending-question gate forever. Cancelling resumes nothing.
      const record = await humanRequests.cancel(body.request_id, body.reason);
      return sendJson(response, 200, { request_id: record.requestId, status: record.status, continuation: record.continuation });
    } catch (error) {
      const reason = (error as Error).message;
      return sendJson(response, /not found/.test(reason) ? 404 : 409, { error: reason });
    }
  }
  if (request.method === "POST" && (url.pathname === "/internal/human-requests/sss-completion" || url.pathname === "/internal/human-requests/ask-user-completion")) {
    if (!humanRequests) return sendJson(response, 503, { error: "Human Request registry is disabled" });
    const body = await readJson(request);
    const expectedKind = url.pathname.endsWith("sss-completion") ? "secret" : "user";
    const expectedEvent = expectedKind === "secret" ? "sss.secret_input.completed" : "ask.user.completed";
    if (body.event !== expectedEvent || body.event_version !== 1 || body.status !== "completed" ||
      !isUuid(body.request_id) || !isOpaqueHumanResultRef(body.result_ref)) {
      return sendJson(response, 400, { error: "invalid opaque human-request completion event" });
    }
    const pending = await humanRequests.get(body.request_id);
    if (!pending || pending.kind !== expectedKind) {
      return sendJson(response, 409, { error: "completion does not match the pending human request kind" });
    }
    // One durable admission owns the only native resume of this answer. A repeated
    // provider callback, a concurrent duplicate and a service restart all read the
    // same attempt and idempotency key instead of launching the session again.
    let outcome: Awaited<ReturnType<typeof resumeHumanRequestOnce>>;
    try {
      outcome = await resumeHumanRequestOnce({
        registry: humanRequests,
        requestId: body.request_id,
        resultRef: body.result_ref,
        // The same canonical human transport as the native MCP resolve: one
        // answer, one bound session, one explicit-stop fence.
        resume: humanResume ?? ((input) => resumeSelectedTarget(input, supervisor, "human", true)),
        queryReceipt: choiceQuery ?? ((input) => boundResumeReceiptQuery(input, adapters)),
      });
    } catch (error) {
      // A busy lock is a deferral, not a failed answer: the provider may retry.
      if (error instanceof HumanRequestLockUnavailableError) {
        return sendJson(response, 409, { request_id: body.request_id, status: "pending", retry: true, error: error.message });
      }
      throw error;
    }
    if (outcome.status === "unsupported_target") {
      return sendJson(response, 422, { request_id: outcome.record.requestId, status: outcome.record.status });
    }
    if (outcome.status === "resume_failed") {
      return sendJson(response, 502, { request_id: outcome.record.requestId, status: outcome.record.status, continuation: outcome.record.continuation, reason: outcome.receipt, retry: outcome.retry });
    }
    return sendJson(response, 202, {
      request_id: outcome.record.requestId,
      status: outcome.record.status,
      continuation: outcome.record.continuation,
      ...(outcome.status === "in_flight" ? { in_flight: true, idempotency_key: outcome.idempotencyKey } : {}),
    });
  }
  if (request.method === "GET" && url.pathname === "/") {
    const html = await readFile(htmlPath, "utf8");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
    const assetPath = normalize(join(webRoot, url.pathname));
    if (!assetPath.startsWith(`${webRoot}/`)) {
      sendJson(response, 400, { error: "invalid asset path" });
      return;
    }
    try {
      const asset = await readFile(assetPath);
      response.writeHead(200, { "content-type": contentTypeFor(assetPath), "cache-control": "public, max-age=31536000, immutable" });
      response.end(asset);
    } catch {
      sendJson(response, 404, { error: "asset not found" });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/fs/dirs") {
    const raw = url.searchParams.get("path") ?? "";
    if (raw.length > 4096 || raw.includes("\0")) return sendJson(response, 400, { error: "invalid path" });
    const expanded = raw === "~" || raw.startsWith("~/") ? `/home/roomhacker${raw.slice(1)}` : raw;
    const candidate = expanded || "/home/roomhacker";
    if (!isAbsolute(candidate)) return sendJson(response, 400, { error: "path must be absolute" });
    const endsWithSlash = candidate.endsWith(sep);
    const parent = resolve(endsWithSlash ? candidate : dirname(candidate));
    const prefix = endsWithSlash ? "" : basename(candidate).toLowerCase();
    try {
      const entries = await readdir(parent, { withFileTypes: true });
      const dirs = entries
        .filter((entry) => entry.isDirectory())
        .filter((entry) => prefix.startsWith(".") || !entry.name.startsWith("."))
        .filter((entry) => entry.name.toLowerCase().startsWith(prefix))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))
        .slice(0, 60)
        .map((entry) => ({ name: entry.name, path: join(parent, entry.name) }));
      return sendJson(response, 200, { parent, prefix, dirs });
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code || "") : "";
      if (code === "ENOENT" || code === "ENOTDIR") return sendJson(response, 200, { parent, prefix, dirs: [] });
      if (code === "EACCES") return sendJson(response, 403, { error: "directory is not readable", parent });
      throw error;
    }
  }

  if (request.method === "GET" && url.pathname === "/api/statistics/activity") {
    const days = Number(url.searchParams.get("days") || "30");
    const refresh = url.searchParams.get("refresh") === "1";
    const normalizedDays = Number.isFinite(days) ? days : 30;
    const statistics = await getAgentActivityStatistics({ days: normalizedDays, refresh });
    const snapshot = supervisor.listSessionsFast();
    return sendJson(response, 200, snapshot.sessions.length > 0
      ? withSessionPortfolioStatistics(statistics, snapshot.sessions, normalizedDays)
      : statistics);
  }
  if (request.method === "GET" && url.pathname === "/api/events/stream") {
    if (!events) return sendJson(response, 503, { error: "Event journal is disabled" });
    const headerCursor = typeof request.headers["last-event-id"] === "string" ? Number.parseInt(request.headers["last-event-id"], 10) : NaN;
    const queryCursor = Number.parseInt(url.searchParams.get("after") || "0", 10);
    const afterSequence = Number.isFinite(headerCursor) ? Math.max(0, headerCursor) : Math.max(0, Number.isFinite(queryCursor) ? queryCursor : 0);
    const oldestSequence = events.oldestSequence();
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write(`retry: 1500\n\n`);
    const writeEvent = (event: ReturnType<HerderEventBus["listAfter"]>[number]) => {
      response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    if (oldestSequence !== null && afterSequence < oldestSequence - 1) {
      response.write(`data: ${JSON.stringify({ control: "reset", latestSequence: events.latestSequence(), oldestSequence })}\n\n`);
    } else {
      for (const event of events.listAfter(afterSequence, 2000)) writeEvent(event);
    }
    const unsubscribe = events.subscribe(writeEvent);
    const heartbeat = setInterval(() => { try { response.write(`: heartbeat ${Date.now()}\n\n`); } catch { /* socket closed */ } }, 15_000);
    heartbeat.unref?.();
    const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
    request.once("close", cleanup);
    response.once("close", cleanup);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    if (!events) return sendJson(response, 503, { error: "Event journal is disabled" });
    const afterSequence = Math.max(0, Number.parseInt(url.searchParams.get("after") || "0", 10) || 0);
    const limit = Math.max(1, Math.min(2000, Number.parseInt(url.searchParams.get("limit") || "500", 10) || 500));
    const uriPrefix = url.searchParams.get("uriPrefix") || undefined;
    const oldestSequence = events.oldestSequence();
    return sendJson(response, 200, {
      afterSequence,
      latestSequence: events.latestSequence(),
      oldestSequence,
      truncated: oldestSequence !== null && afterSequence < oldestSequence - 1,
      events: events.listAfter(afterSequence, limit, uriPrefix),
    });
  }

  if (request.method === "GET" && url.pathname === "/api/jobs") {
    if (!jobs) return sendJson(response, 503, { error: "Job registry is disabled" });
    const limit = Number(url.searchParams.get("limit") || "100");
    return sendJson(response, 200, { jobs: jobs.list(Number.isFinite(limit) ? limit : 100) });
  }
  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobMatch && request.method === "GET") {
    if (!jobs) return sendJson(response, 503, { error: "Job registry is disabled" });
    const job = jobs.get(decodeURIComponent(jobMatch[1]));
    return job ? sendJson(response, 200, { job }) : sendJson(response, 404, { error: "Job not found" });
  }
  const jobCancelMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
  if (jobCancelMatch && request.method === "POST") {
    if (!jobs) return sendJson(response, 503, { error: "Job registry is disabled" });
    const job = jobs.cancel(decodeURIComponent(jobCancelMatch[1]));
    return job ? sendJson(response, 200, { job }) : sendJson(response, 404, { error: "Job not found" });
  }

  if (url.pathname === "/api/session-target" && (request.method === "GET" || request.method === "POST")) {
    const body = request.method === "POST"
      ? await readJson(request).catch(() => undefined)
      : { sessionId: url.searchParams.get("sessionId") ?? "", harness: url.searchParams.get("harness") ?? undefined };
    const outcome = await sessionTargetRequest({
      adapters,
      coordination: coordinationNotes,
      resolveSession: async (harness, sessionId) => {
        const sessionRoute = await resolveSessionRoute(harness, sessionId);
        if (sessionRoute.kind === "deny") return undefined;
        return sessionRoute.kind === "scoped" ? await sessionRoute.adapter.getSession(sessionId) : await supervisor.getSession(harness, sessionId);
      },
    }, { method: request.method === "POST" ? "POST" : "GET", body });
    if (outcome.status === 200 && request.method === "POST") events?.publish({ kind: "sessions", uri: "herder://sessions", action: "changed" });
    return sendJson(response, outcome.status, outcome.body);
  }
  if (request.method === "GET" && url.pathname === "/api/sessions") {
    const filters = {
      harness: url.searchParams.get("harness") || undefined,
      status: url.searchParams.get("status") || undefined,
      cwd: url.searchParams.get("cwd") || undefined,
    };
    // The window of the list. The panel asks for a window and the answer
    // carries the window and the counter of the whole list, so the panel
    // knows that the list is longer than it shows. A request without a
    // window keeps the old answer: the whole list, as before.
    const asked = sessionListLimit(url.searchParams.get("limit"));
    if (url.searchParams.get("quick") === "1") {
      const snapshot = supervisor.listSessionsFast(filters);
      const total = snapshot.sessions.length;
      // The window of the list applies when the caller names it: a caller
      // that asks for the whole list gets the whole list, and the answer
      // carries the counter of the list either way. The panel of the herder
      // names its window, and the answer says that it is a window:
      // `truncated`, `total` and `limit` travel with it.
      const visible = asked === undefined ? snapshot.sessions : sessionListWindow(snapshot.sessions, asked);
      const truncated = visible.length < total;
      return sendJson(response, 200, url.searchParams.get("inventory") === "1"
        ? { sessions: projectSessionInventory(visible), warming: snapshot.warming, total, ...(asked === undefined ? {} : { limit: asked, truncated }) }
        : { ...snapshot, sessions: visible, total, ...(asked === undefined ? {} : { limit: asked, truncated }) });
    }
    const sessions = await supervisor.listSessions(filters);
    const total = sessions.length;
    const visible = asked === undefined ? sessions : sessionListWindow(sessions, asked);
    sendJson(response, 200, {
      sessions: url.searchParams.get("inventory") === "1" ? projectSessionInventory(visible) : visible,
      warming: false,
      total,
      ...(asked === undefined ? {} : { limit: asked, truncated: visible.length < total }),
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/health/remediation") {
    return sendJson(response, 405, { error: "method_not_allowed", route: "/api/health/remediation" });
  }
  if (request.method === "POST" && url.pathname === "/api/health/remediation") {
    // The authorization of this endpoint is off by default: the center calls
    // herder without a bearer today. It becomes mandatory with one
    // environment variable, once the center sends the dedicated token.
    if (process.env.NOTICEPLACE_HEALTH_REMEDIATION_REQUIRE_BEARER === "1" && !hasNoticeplaceHealthBearer(request.headers.authorization)) {
      return sendJson(response, 401, { error: "Для починки инцидента нужен отдельный токен Notice Place." });
    }
    const body = await readJson(request);
    let incidentId: string;
    let planId: string;
    try {
      incidentId = boundedHealthIdentifier(body.incident_id, "incident_id");
      planId = boundedHealthIdentifier(body.plan_id, "plan_id");
    } catch (error) {
      return sendJson(response, 400, { error: (error as Error).message });
    }
    // The center accepts progress only for the selected plan, so the plan of
    // the launch is a validated contract value and never a free string.
    if (!isHealthPlanId(planId)) {
      return sendJson(response, 400, { error: `health remediation plan_id must be one of ${HEALTH_PLAN_IDS.join(", ")}` });
    }
    // The incident of the launch is confirmed at the center when the caller
    // names its project; the read is project-scoped and never resolves.
    if (typeof body.project === "string" && body.project.trim()) {
      try {
        await readIncidentBinding({ incidentId, project: body.project.trim() });
      } catch (error) {
        return sendJson(response, 409, { error: `health remediation incident is not confirmed: ${(error as Error).message}` });
      }
    }
    const harness = body.harness === undefined ? "zcode" : body.harness;
    if (harness !== "opencode" && harness !== "codex" && harness !== "hermes" && harness !== "zcode" && harness !== "fast-agent") {
      return sendJson(response, 400, { error: "health remediation harness must be opencode, codex, hermes, zcode, or fast-agent" });
    }
    if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.length > 128 ||
      typeof body.cwd !== "string" || !body.cwd.startsWith("/") ||
      typeof body.message !== "string" || body.message.trim().length === 0 || body.message.length > 32_000) {
      return sendJson(response, 400, { error: "health remediation requires bounded name, absolute cwd, and message" });
    }
    if (!validSourceSessionFields(body) || !validSourceSessions(body.sourceSessions)) {
      return sendJson(response, 400, { error: "health remediation source session references are invalid" });
    }
    let execution;
    try {
      execution = normalizeHealthExecution(body.execution);
    } catch (error) {
      return sendJson(response, 400, { error: (error as Error).message });
    }
    if (harness === "hermes") {
      const configured = supervisor.getExecutionProfile("hermes");
      if (!configured || configured.provider !== execution.provider || configured.reasoning !== execution.reasoning || configured.toolsets !== "terminal") {
        return sendJson(response, 409, { error: "Hermes health execution profile is not the approved provider/reasoning/toolset" });
      }
    }
    if (harness !== execution.runtime) {
      return sendJson(response, 409, { error: `health remediation harness must match execution runtime (${execution.runtime})` });
    }
    // One model allowlist for the analysis and the repair of an incident: the
    // approved MiniMax routes only, no other provider and no fallback.
    const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
    if (requestedModel && !NOTICEPLACE_HEALTH_MODELS.includes(requestedModel)) {
      return sendJson(response, 409, { error: "Noticeplace incidents allow only the approved MiniMax models; no provider fallback" });
    }
    const model = requestedModel || healthModelForHarness(harness, execution);
    if (harness === "opencode") {
      if (!NOTICEPLACE_HEALTH_MODELS.includes(model)) {
        return sendJson(response, 409, { error: "Noticeplace incidents require an approved MiniMax model; no provider fallback" });
      }
      // A stale catalog is not a refusal: the cache is refreshed and read
      // again, and only a model that is missing from the fresh catalog is
      // refused.
      const catalog = await freshModelCatalog(supervisor, "opencode");
      if (!catalog.models.includes(model)) {
        return sendJson(response, 409, { error: `OpenCode model unavailable: ${model}; no provider fallback` });
      }
      // An exhausted MiniMax subscription quota is an explicit reason to
      // refuse, not a random 429 in the middle of the repair.
      const quota = await noticeplaceHealthQuotaPreflight()(model);
      if (quota === "quota_exhausted") {
        return sendJson(response, 409, { error: `Квота модели ${model} исчерпана; починка не запускается.` });
      }
    }
    const message = [
      `Health remediation incident=${incidentId} plan=${planId}`,
      `Execution profile: runtime=${execution.runtime} provider=${execution.provider} model=${execution.model} reasoning=${execution.reasoning} topic=${execution.topic}`,
      body.message.trim(),
    ].join("\n\n");
    const result = await supervisor.newOrResumeNamedSession({
      harness,
      healthRecovery: harness === "fast-agent",
      name: body.name,
      cwd: body.cwd,
      message,
      mode: "queue",
      model,
      sourceSessionId: typeof body.sourceSessionId === "string" ? body.sourceSessionId : undefined,
      sourceHarness: typeof body.sourceHarness === "string" ? body.sourceHarness : undefined,
      sourceSessions: body.sourceSessions as Array<{ harness: string; sessionId: string }> | undefined,
    });
    // The plan of this launch belongs to the launched executor: the arming
    // call of the same session carries only the incident id.
    if (result.ok && result.sessionId) await launchHealthPlans?.remember(harness, result.sessionId, planId);
    return sendJson(response, result.ok ? 200 : 502, { ...result, incident_id: incidentId, plan_id: planId, execution, model });
  }
  if (request.method === "POST" && url.pathname === "/api/sessions") {
    const body = await readJson(request);
    if (!validSourceSessionFields(body) || !validSourceSessions(body.sourceSessions)) return sendJson(response, 400, { error: "source session references are invalid" });
    if (typeof body.harness !== "string" || typeof body.name !== "string" || typeof body.cwd !== "string") {
      return sendJson(response, 400, { error: "harness, name, and cwd are required" });
    }
    if (body.model !== undefined && (typeof body.model !== "string" || body.model.length > MAX_MODEL_LENGTH || hasControlCharacters(body.model))) return sendJson(response, 400, { error: "model must be a bounded string without control characters" });
    const result = await supervisor.createNamedSession({ harness: body.harness, name: body.name, cwd: body.cwd, model: typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined,
      sourceSessionId: typeof body.sourceSessionId === "string" ? body.sourceSessionId : undefined,
      sourceHarness: typeof body.sourceHarness === "string" ? body.sourceHarness : undefined,
      sourceSessions: body.sourceSessions as Array<{ harness: string; sessionId: string }> | undefined,
    });
    return sendNamedSessionResult(response, result);
  }
  if (request.method === "POST" && url.pathname === "/api/sessions/new-or-resume") {
    const body = await readJson(request);
    if (!validSourceSessionFields(body) || !validSourceSessions(body.sourceSessions)) return sendJson(response, 400, { error: "source session references are invalid" });
    if (body.humanRequested !== undefined && typeof body.humanRequested !== "boolean") return sendJson(response, 400, { error: "humanRequested must be boolean" });
    if (typeof body.harness !== "string" || typeof body.name !== "string" || typeof body.cwd !== "string" || typeof body.message !== "string") {
      return sendJson(response, 400, { error: "harness, name, cwd, and message are required" });
    }
    if (body.mode !== undefined && body.mode !== "queue" && body.mode !== "sync") {
      return sendJson(response, 400, { error: "mode must be queue or sync" });
    }
    if (body.model !== undefined && (typeof body.model !== "string" || body.model.trim().length === 0 || body.model.length > MAX_MODEL_LENGTH || hasControlCharacters(body.model))) {
      return sendJson(response, 400, { error: "model must be a bounded non-empty string without control characters" });
    }
    const result = await supervisor.newOrResumeNamedSession({
      harness: body.harness,
      name: body.name,
      cwd: body.cwd,
      message: body.message,
      mode: body.mode as "queue" | "sync" | undefined,
      model: body.model as string | undefined,
      humanRequested: body.humanRequested === true,
      sourceSessionId: typeof body.sourceSessionId === "string" ? body.sourceSessionId : undefined,
      sourceHarness: typeof body.sourceHarness === "string" ? body.sourceHarness : undefined,
      sourceSessions: body.sourceSessions as Array<{ harness: string; sessionId: string }> | undefined,
    });
    return sendNamedSessionResult(response, result);
  }

  const messageStatusMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/message-status$/);
  if (messageStatusMatch && request.method === "GET") {
    const inputId = url.searchParams.get("inputId");
    if (!inputId || inputId.length > 512) return sendJson(response, 400, { error: "inputId is required" });
    const harness = decodeURIComponent(messageStatusMatch[1]), sessionId = decodeURIComponent(messageStatusMatch[2]);
    const route = await resolveSessionRoute(harness, sessionId);
    if (route.kind === "deny") return sendJson(response, 409, { error: "Project-scoped session binding could not be verified." });
    const receipt = await userMessageDelivery?.reconcile(harness, sessionId, inputId, route.kind === "scoped" ? route.adapter : undefined);
    return sendJson(response, receipt ? 200 : 404, receipt || { error: "Доставка сообщения не найдена; автоматический повтор запрещён" });
  }
  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)$/);
  if (sessionMatch && request.method === "GET") {
    const harness = decodeURIComponent(sessionMatch[1]), sessionId = decodeURIComponent(sessionMatch[2]);
    const route = await resolveSessionRoute(harness, sessionId);
    if (route.kind === "deny") return sendJson(response, 409, { error: "Project-scoped session binding could not be verified." });
    const session = route.kind === "scoped" ? await route.adapter.getSession(sessionId) : await supervisor.getSession(harness, sessionId);
    if (session && (session.id !== sessionId || session.harness !== harness)) return sendJson(response, 409, { error: "Exact native session identity mismatch." });
    if (!session) return sendJson(response, 404, { error: "Session not found" });
    return sendJson(response, 200, { session });
  }
  const transcriptMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/transcript$/u);
  if (transcriptMatch && request.method === "GET") {
    let harness: string, sessionId: string;
    try { harness = decodeURIComponent(transcriptMatch[1]); sessionId = decodeURIComponent(transcriptMatch[2]); }
    catch { return void await handleIntegratorSessionTranscript(request, response, url, adapters); }
    const route = await resolveSessionRoute(harness, sessionId);
    if (route.kind === "deny") return sendJson(response, 409, { error: "Project-scoped session binding could not be verified." });
    return void await handleIntegratorSessionTranscript(request, response, url, route.adapters);
  }
  const detailsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/details$/);
  if (detailsMatch && request.method === "GET") {
    const harness = decodeURIComponent(detailsMatch[1]), sessionId = decodeURIComponent(detailsMatch[2]);
    const limitValue = Number(url.searchParams.get("limit") || "3");
    const history = url.searchParams.get("history") as "auto" | "acp" | "files" | null;
    const quick = url.searchParams.get("quick") === "1" || url.searchParams.get("quick") === "true";
    const route = await resolveSessionRoute(harness, sessionId);
    if (route.kind === "deny") return sendJson(response, 409, { error: "Project-scoped session binding could not be verified." });
    if (route.kind === "scoped" && !route.supervisor) return sendJson(response, 503, { error: "Scoped session read port is unavailable." });
    if (route.kind === "scoped") {
      const details = await route.supervisor!.getSessionDetails(
        harness, sessionId,
        { limit: Number.isFinite(limitValue) ? limitValue : 3, history: history || "auto", quick },
      );
      if (details.session.id !== sessionId || details.session.harness !== harness) return sendJson(response, 409, { error: "Exact native session identity mismatch." });
      return sendJson(response, 200, details);
    }
    const details = await supervisor.getSessionDetails(
      harness,
      sessionId,
      { limit: Number.isFinite(limitValue) ? limitValue : 3, history: history || "auto", quick },
    );
    return sendJson(response, 200, details);
  }
  const visualizationMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/visualization$/);
  if (visualizationMatch && request.method === "GET") {
    const harness = decodeURIComponent(visualizationMatch[1]);
    const sessionId = decodeURIComponent(visualizationMatch[2]);
    if (!sessionVisualizer) return sendJson(response, 503, { error: "session visualization is disabled" });
    const route = await resolveSessionRoute(harness, sessionId);
    if (route.kind === "deny") return sendJson(response, 409, { error: "Project-scoped session binding could not be verified." });
    if (route.kind === "scoped" && !route.supervisor) return sendJson(response, 503, { error: "Scoped session read port is unavailable." });
    const details = route.kind === "scoped" ? await route.supervisor!.getSessionDetails(harness, sessionId, { limit: 50, history: "auto" })
      : await supervisor.getSessionDetails(harness, sessionId, { limit: 50, history: "auto" });
    const html = await sessionVisualizer(details);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(html);
    return;
  }
  const progressMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/progress$/);
  if (progressMatch && request.method === "GET") {
    const harness = decodeURIComponent(progressMatch[1]);
    const sessionId = decodeURIComponent(progressMatch[2]);
    const limitValue = Number(url.searchParams.get("limit") || "5");
    const history = url.searchParams.get("history") as "auto" | "acp" | "files" | null;
    const route = await resolveSessionRoute(harness, sessionId);
    if (route.kind === "deny") return sendJson(response, 409, { error: "Project-scoped session binding could not be verified." });
    if (route.kind === "scoped" && !route.supervisor) return sendJson(response, 503, { error: "Scoped session read port is unavailable." });
    const details = route.kind === "scoped" ? await route.supervisor!.getSessionDetails(harness, sessionId,
      { limit: Number.isFinite(limitValue) ? limitValue : 5, history: history || "auto" })
      : await supervisor.getSessionDetails(harness, sessionId, { limit: Number.isFinite(limitValue) ? limitValue : 5, history: history || "auto" });
    // A stale running session asks the operator exactly one question. The stale
    // fact is the only trigger, and the delivery is the existing Notice
    // producer, so no second channel and no second card appear.
    void reportStaleRunningSession(harness, sessionId, details).catch(() => undefined);
    return sendJson(response, 200, buildSessionProgress(details, Number.isFinite(limitValue) ? limitValue : 5));
  }
  const actionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/(resume|message|stop|terminate|cancel|recover|fork|archive|compact|model|permissions\/([^/]+))$/);
  if (actionMatch && request.method === "POST") {
    const body = await readJson(request);
    const harness = decodeURIComponent(actionMatch[1]);
    const id = decodeURIComponent(actionMatch[2]);
    const action = actionMatch[3];
    if (body.humanRequested !== undefined && typeof body.humanRequested !== "boolean") return sendJson(response, 400, { error: "humanRequested must be boolean" });
    const route = await resolveSessionRoute(harness, id);
    if (route.kind === "deny") return sendJson(response, 409, { ok: false, state: "not_attempted", nonRetryable: true, error: "Project-scoped session binding could not be verified." });
    if (route.kind === "scoped" && !route.supervisor) return sendJson(response, 503, { ok: false, state: "not_attempted", nonRetryable: true, error: "Scoped session control port is unavailable." });
    if (route.kind === "scoped" && !["message", "resume", "stop"].includes(action)) return sendJson(response, 409, { ok: false, state: "not_attempted", nonRetryable: true, error: "This project-scoped control is not supported." });
    const sessionSupervisor = route.kind === "scoped" ? route.supervisor! : supervisor;
    if (["stop", "cancel", "terminate"].includes(action)) userMessageDelivery?.cancelSession(harness, id);
    if (action === "resume") {
      if (body.inputId !== undefined && (typeof body.inputId !== "string" || !body.inputId.trim() || body.inputId.length > 512)) {
        return sendJson(response, 400, { error: "inputId must be a non-empty string of at most 512 characters" });
      }
      if (route.kind === "scoped" && (!body.inputId || body.humanRequested !== true)) return sendJson(response, 400, { error: "Scoped resume requires explicit human intent and a stable inputId." });
      return sendOperationResult(response, await sessionSupervisor.resumeSession(harness, id, optionalString(body.message), body.humanRequested === true, optionalString(body.inputId)));
    }
    if (action === "stop") {
      return sendOperationResult(response, await sessionSupervisor.stopSession(harness, id));
    }
    if (action === "terminate") {
      return sendOperationResult(response, await supervisor.terminateSession(harness, id));
    }
    if (action === "cancel") {
      return sendOperationResult(response, await supervisor.cancelTurn(harness, id));
    }
    if (action === "compact") {
      if (typeof body.inputId !== "string" || !body.inputId.trim() || body.inputId.length > 512) return sendJson(response, 400, { error: "compact requires a stable inputId" });
      if (!autoCompactService) return sendJson(response, 503, { error: "Автокомпакт недоступен." });
      return sendOperationResult(response, await autoCompactService.compact(harness, id, body.inputId));
    }
    if (action === "archive") {
      return sendOperationResult(response, await supervisor.archiveSession(harness, id));
    }
    if (action === "recover") {
      if (!jobs) return sendOperationResult(response, await supervisor.recoverSession(harness, id, optionalString(body.message), undefined, body.humanRequested === true));
      const job = jobs.start({
        kind: "session-recover",
        ownerSessionId: id,
        run: async ({ signal, progress }) => {
          progress(0.1, `Recovering ${harness}:${id}`);
          if (signal.aborted) throw new Error("cancelled");
          const result = await supervisor.recoverSession(harness, id, optionalString(body.message), signal, body.humanRequested === true);
          if (!result.ok) throw new Error(result.error || "session recovery failed");
          return result;
        },
      });
      return sendJson(response, 202, { job });
    }
    if (action === "fork") {
      return sendOperationResult(response, await supervisor.forkSession(harness, id, optionalString(body.message), body.humanRequested === true));
    }
    if (action === "model") {
      if (typeof body.model !== "string" || body.model.trim().length === 0) {
        return sendJson(response, 400, { error: "model must be a non-empty string" });
      }
      return sendOperationResult(response, await supervisor.changeModel(harness, id, body.model));
    }
    if (action.startsWith("permissions/")) {
      if (body.response !== "allow" && body.response !== "deny") {
        return sendJson(response, 400, { error: "response must be allow or deny" });
      }
      return sendOperationResult(response, await supervisor.respondPermission(
        harness,
        id,
        decodeURIComponent(actionMatch[4]),
        body.response,
        body.remember === true,
      ));
    }
    if (typeof body.message !== "string" || body.message.trim().length === 0) {
      return sendJson(response, 400, { error: "message must be a non-empty string" });
    }
    if (body.mode !== undefined && (typeof body.mode !== "string" || !["queue", "steer", "sync"].includes(body.mode))) return sendJson(response, 400, { error: "invalid delivery mode" });
    if (body.inputId !== undefined && (typeof body.inputId !== "string" || !body.inputId.trim() || body.inputId.length > 512)) return sendJson(response, 400, { error: "invalid inputId" });
    if (route.kind === "scoped" && (body.humanRequested !== true || typeof body.inputId !== "string" || !["queue", "steer"].includes(String(body.mode)))) {
      return sendJson(response, 400, { error: "Project-scoped message requires explicit human intent, stable inputId, and queue or steer mode." });
    }
    let images: import("../types/index.js").MessageImage[];
    try {
      if (body.imageIds !== undefined && !(route.kind === "scoped" ? route.adapter : adapters.get(harness))?.controlCapabilities?.imageInput) throw new Error("Эта среда пока не принимает изображения.");
      images = await sessionImages!.resolve(harness, id, body.imageIds);
    } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
    if (route.kind === "scoped" || (body.humanRequested === true && (body.mode === "queue" || body.mode === "steer") && body.inputId !== undefined)) {
      if (!userMessageDelivery) return sendJson(response, 503, { error: "Надёжная очередь сообщений недоступна" });
      const deliveryRoute: UserMessageRoute | undefined = route.kind === "scoped" ? { adapter: route.adapter, supervisor: sessionSupervisor } : undefined;
      try {
        const receipt = userMessageDelivery.submit({ harness, sessionId: id, inputId: body.inputId as string, message: body.message, mode: body.mode as "queue" | "steer", images }, deliveryRoute);
        return sendJson(response, receipt.pending ? 202 : receipt.ok ? 200 : 502, receipt);
      } catch (error) {
        return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    return sendOperationResult(response, await sessionSupervisor.sendMessage(harness, id, {
      message: body.message,
      origin: body.humanRequested === true ? "human" : "automation",
      images,
      queue: body.mode === "queue",
      steer: body.mode === "steer",
      inputId: typeof body.inputId === "string" ? body.inputId : undefined,
    }));
  }

  if (request.method === "POST" && url.pathname === "/api/conversions") {
    const body = await readJson(request);
    if (typeof body.sessionId !== "string" || typeof body.from !== "string" || typeof body.to !== "string") {
      return sendJson(response, 400, { error: "sessionId, from, and to are required" });
    }
    const input: ConvertSessionInput = {
      sessionId: body.sessionId,
      from: body.from as HarnessType,
      to: body.to as HarnessType,
      projectPath: optionalString(body.projectPath),
      searchPaths: Array.isArray(body.searchPaths) ? body.searchPaths.filter((path): path is string => typeof path === "string") : undefined,
    };
    if (jobs) {
      const job = jobs.start({
        kind: "session-convert",
        ownerSessionId: body.ownerSessionId && typeof body.ownerSessionId === "string" ? body.ownerSessionId : undefined,
        run: async ({ signal, progress }) => {
          progress(0.05, "Reading source session");
          if (signal.aborted) throw new Error("cancelled");
          const result = await supervisor.convertSession(input);
          if (!result.success) throw new Error(result.error || "session conversion failed");
          return result;
        },
      });
      return sendJson(response, 202, { job });
    }
    const result = await supervisor.convertSession(input);
    return sendJson(response, result.success ? 200 : 502, result);
  }
  if (request.method === "POST" && url.pathname === "/api/conversions/hermes-export") {
    const body = await readJson(request);
    if ((body.target !== "codex" && body.target !== "opencode" && body.target !== "claude") || body.export === undefined) {
      return sendJson(response, 400, { error: "target (codex, opencode, or claude) and export are required" });
    }
    const result = convertHermesExport({ target: body.target, export: body.export });
    return sendJson(response, result.conversation ? 200 : 422, result);
  }

  sendJson(response, 404, { error: "Not found" });
}

function validSourceSessions(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length <= 32 && value.every((ref) => ref && typeof ref === "object" && !Array.isArray(ref)
    && ["codex", "zcode", "opencode", "fast-agent"].includes(ref.harness) && typeof ref.sessionId === "string" && ref.sessionId.trim().length > 0 && ref.sessionId.length <= 512 && !hasControlCharacters(ref.sessionId)
    && (ref.hostId === undefined || (typeof ref.hostId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(ref.hostId)))));
}

function validProjectLaunchSourceSessions(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((ref) =>
    typeof ref.hostId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(ref.hostId)));
}

function validSourceSessionFields(value: Record<string, unknown>): boolean {
  const sourceSessionId = value.sourceSessionId;
  const sourceHarness = value.sourceHarness;
  return (sourceSessionId === undefined || (typeof sourceSessionId === "string" && sourceSessionId.trim().length > 0 && sourceSessionId.length <= 512 && !hasControlCharacters(sourceSessionId)))
    && (sourceHarness === undefined || (typeof sourceHarness === "string" && ["codex", "zcode", "opencode", "fast-agent"].includes(sourceHarness)));
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function isAutopilotHarness(value: string): value is AutopilotHarness {
  return value === "codex" || value === "opencode" || value === "claude" || value === "hermes" || value === "zcode";
}

/**
 * The service of the hooks of the product.
 *
 * One service per process, so the cache of the state of the lever is shared
 * by every request instead of being rebuilt for each of them.
 */
let hooksService: HooksService | undefined;
let hooksServiceDirectory = "";

function hooksServiceOf(): HooksService {
  // The service follows the runtime state directory: a node that moves its
  // state must not keep a lever of another directory.
  const directory = resolveAutopilotStateDir();
  if (!hooksService || hooksServiceDirectory !== directory) {
    hooksService = HooksService.forRuntime();
    hooksServiceDirectory = directory;
  }
  return hooksService;
}

/**
 * Whether the request may change the lever of the owner.
 *
 * The panel is served by the same origin it is addressed to, and the loopback
 * of the node carries no credential of another site. A change from another
 * origin is refused: the lever of the owner must not be movable from a page
 * of somebody else.
 */
function isHooksOwnerRequest(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !origin) {
    return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "");
  }
  try {
    return new URL(origin).host.toLowerCase() === (request.headers.host ?? "").toLowerCase();
  } catch {
    return false;
  }
}

async function readJson(request: IncomingMessage, maxBytes = 1_000_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON body must be an object");
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boundedHealthIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new Error(`health remediation ${field} must be a bounded identifier`);
  }
  return value;
}

function contentTypeFor(path: string): string {
  switch (extname(path)) {
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".map": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** Notice's historical selection hashes have UUID shape but non-RFC variant bits.
 * Result references are opaque: validate their exact shape, never rewrite them.
 * Request identities continue to use the strict UUID check above.
 */
function isOpaqueHumanResultRef(value: unknown): value is string {
  return typeof value === "string" && value.length === 36
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendOperationResult(response: ServerResponse, result: { ok: boolean; error?: string; sessionId?: string }): void {
  sendJson(response, result.ok ? 200 : 502, result);
}

function sendNamedSessionResult(
  response: ServerResponse,
  result: { ok: boolean; error?: string },
): void {
  const conflict = result.error?.startsWith("Ambiguous named session") || result.error?.includes("already exists");
  sendJson(response, result.ok ? 200 : conflict ? 409 : 502, result);
}

/** The age of the running evidence that makes a session stale for the operator. */
const STALE_RUNNING_AFTER_MS = 15 * 60_000;

/** The sessions already asked about: one question per stale session per process. */
const staleRunningAsked = new Set<string>();
let staleRunningProducer: Promise<AskHumanProducer | undefined> | undefined;

/**
 * Ask the operator about one stale-running session.
 *
 * The stale fact is the only trigger, and the same session is never asked
 * twice from one process. The delivery goes through the existing Notice
 * producer, so the question lands in the same scope as every other human
 * question and the answer returns through the existing completion path.
 */
async function reportStaleRunningSession(harness: string, sessionId: string, details: SessionDetails): Promise<void> {
  const key = `${harness}:${sessionId}`;
  if (staleRunningAsked.has(key)) return;
  const lifecycle = lifecycleEntryFor(harness, sessionId);
  const progress = buildIntegratorProgress({
    now: Date.now(),
    staleAfterMs: STALE_RUNNING_AFTER_MS,
    details,
    ...(lifecycle ? { lifecycle } : {}),
  });
  if (progress.state !== "stale_running") return;
  staleRunningAsked.add(key);
  try {
    staleRunningProducer ??= loadAskHumanProducer(process.env);
    const producer = await staleRunningProducer;
    if (!producer) { staleRunningAsked.delete(key); return; }
    await deliverStaleRunningQuestion(progress, {
      harness,
      session_id: sessionId,
      ...(details.session.cwd ? { cwd: details.session.cwd } : {}),
    }, {
      endpoint: producer.endpoint,
      token: producer.token,
      project: producer.project,
      recipient: producer.recipient,
      ...(producer.allowedActors ? { allowedActors: producer.allowedActors } : {}),
    });
  } catch (error) {
    staleRunningAsked.delete(key);
    console.error(`[agent-herder] the stale running question for ${key} was not delivered: ${error instanceof Error ? error.message : String(error)}`);
  }
}
