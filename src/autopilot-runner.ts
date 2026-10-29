#!/usr/bin/env node
import { notifyAutopilotStop } from "./autopilot/stop-notify.js";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { OpenCodeAdapter } from "./adapters/opencode.js";
import {
  createAutopilotCore,
  createNoticePlaceSink,
  createOpenAICompatibleJudge,
  loadReceiptStore,
  type StopHookInput,
  type AutopilotDecision,
} from "./autopilot/index.js";
import { createIncidentUpdateSink, deliverIncidentQuestion } from "./autopilot/notice-incident.js";
import { ChoiceRegistry } from "./autopilot/choice-registry.js";
import { PendingQuestionGate } from "./autopilot/pending-question-gate.js";
import { HumanRequestRegistry } from "./human-request/index.js";
import { deliverNoticeQuestion, type NoticeQuestionConfig } from "./human-request/notice-question.js";
import { loadAskHumanProducer } from "./human-request/ask-human-producer.js";
import type { PendingHumanQuestion } from "./autopilot/index.js";
import { AutopilotPolicyStore, resolveAutopilotPolicyStorePath } from "./autopilot/policy-store.js";
import { adoptLegacyAutopilotState, resolveAutopilotStateDir, resolveHumanRequestStorePath } from "./autopilot/state-dir.js";
import { effectivePolicyAllowsTarget } from "./autopilot/policy.js";
import { AutopilotSessionStore, type AutopilotHarness } from "./autopilot/session-store.js";
import { deliverAutopilotGoal } from "./autopilot/continuation-delivery.js";
import { acquireLock, checkpointAutopilotReceipts } from "./autopilot-hook.js";
import { SessionAutostartStore } from "./autopilot/unfinished-session-launcher.js";
import { AgentResumeClient } from "./resume-transport.js";
import { getHumanStopStore } from "./human-stop-store.js";
import { GoalStore, type ContinuationSubmission } from "./autopilot/goal-store.js";
import { evaluateGoal, makeNativeReportEvidence, type GoalNativeReport } from "./autopilot/goal-evaluation.js";
import { createConfiguredGoalModel, configuredJudgeRoute } from "./autopilot/judge-request.js";
import { collectGoalEvidence, type GoalEvidenceTargetRef } from "./autopilot/goal-evidence.js";
import { fileURLToPath } from "node:url";
import type { SessionMessageView } from "./types/index.js";
import { goalControllerAdmission } from "./autopilot/goal-controller-admission.js";

type Command = "on" | "off" | "status" | "stop";

export type AutopilotRunnerInput = {
  command?: Command;
  harness: AutopilotHarness;
  sessionId: string;
  cwd: string;
  turnId?: string;
  lastUserMessage?: string | null;
  lastAssistantMessage?: string | null;
  transcriptPath?: string | null;
  stopHookActive?: boolean;
  model?: string;
  nativeReportObservation?: NativeReportObservation;
  /** Internal native idle/history fingerprint gate supplied by BackgroundAutopilotStop. */
  nativeFence?: () => Promise<boolean | NativeFenceRead>;
};

export type NativeReportObservation =
  | { status: "observed"; nativeFingerprint: string; messageId: string; turnId?: string; text: string; version: string; observedAt: string; freshUntil: string }
  | { status: "unavailable"; nativeFingerprint: string; reason: string };
export type NativeFenceRead = { allowed: boolean; nativeReportObservation?: NativeReportObservation };

const stateDir = resolveAutopilotStateDir();

/** The protected AskHuman producer: the scope a human answers an ordinary question in. */
async function noticeQuestionProducer(): Promise<NoticeQuestionConfig | undefined> {
  const producer = await loadAskHumanProducer(process.env);
  if (!producer) return undefined;
  return {
    endpoint: producer.endpoint,
    token: producer.token,
    project: producer.project,
    recipient: producer.recipient,
    ...(producer.allowedActors ? { allowedActors: producer.allowedActors } : {}),
  };
}

export async function runAutopilotCommand(input: AutopilotRunnerInput): Promise<Record<string, unknown>> {
  if (input.command === "stop") {
    const status = await evaluateAutopilotCommand({ ...input, command: "status" });
    if (status.human_stop_held) return { ...status, command: "stop", decision: "human-stop-held" };
    if (!status.enabled) return { ...status, command: "stop", decision: "disabled" };
    return notifyAutopilotStop(input);
  }
  return evaluateAutopilotCommand(input);
}

/** Process-owned background consumer; hooks call notifyAutopilotStop instead. */
export async function evaluateAutopilotStop(input: AutopilotRunnerInput): Promise<Record<string, unknown>> {
  return evaluateAutopilotCommand({ ...input, command: "stop" }, true);
}

async function evaluateAutopilotCommand(input: AutopilotRunnerInput, background = false): Promise<Record<string, unknown>> {
  await adoptLegacyAutopilotState(stateDir);
  const command = input.command ?? "on";
  const humanStops = getHumanStopStore();
  const held = () => humanStops.isHeld(input.harness, input.sessionId);
  if (command === "on" && await held()) {
    return { ok: true, command, harness: input.harness, session_id: input.sessionId, enabled: false, human_stop_held: true };
  }
  const store = new AutopilotSessionStore(join(stateDir, "sessions.json"));
  const goalStore = new GoalStore(stateDir);
  const policyStore = new AutopilotPolicyStore(resolveAutopilotPolicyStorePath(stateDir));
  if (command === "status") {
    const record = await store.get(input.harness, input.sessionId);
    const goal = await readGoalSnapshot(goalStore, { harness: input.harness, sessionId: input.sessionId, cwd: resolve(input.cwd) });
    const effectivePolicy = await policyStore.readEffective();
    const policyEnabled = effectivePolicyAllowsTarget(effectivePolicy, { harness: input.harness, sessionId: input.sessionId, cwd: resolve(input.cwd) });
    // A per-session switch is the owner's explicit decision for one exact
    // session, so it decides that session on its own. The global policy only
    // decides the sessions that carry no switch of their own. ANDing the two
    // made `on` answer true and `status` answer false for the same session,
    // and every native turn of OpenCode reaches the bridge through this
    // status, so an armed session was never continued.
    const sessionEnabled = record?.enabled === true;
    const goalOptIn = record?.enabled !== false && goal?.armed === true;
    const enabled = record?.enabled === false ? false : goalOptIn || sessionEnabled || policyEnabled;
    return { ok: true, command, harness: input.harness, session_id: input.sessionId, enabled, goal_opt_in: goalOptIn,
      goal_revision: goal?.goalRevision, goal_completed: goal?.completed, human_stop_held: await held(), source: goalOptIn ? "goal-session" : record?.enabled !== undefined ? "session" : effectivePolicy.source };
  }
  if (command === "on" || command === "off") {
    const record = await store.set({ harness: input.harness, sessionId: input.sessionId, cwd: resolve(input.cwd) }, command === "on");
    const identity = { harness: input.harness, sessionId: input.sessionId, cwd: resolve(input.cwd) };
    if (command === "off") { if (await readGoalSnapshot(goalStore, identity)) await goalStore.stop(identity); }
    else if (await readGoalSnapshot(goalStore, identity)) await goalStore.resume(identity);
    return { ok: true, command, harness: record.harness, session_id: record.sessionId, enabled: record.enabled };
  }

  const record = await store.get(input.harness, input.sessionId);
  const effectivePolicy = await policyStore.readEffective();
  const runtimeSettings = await new SessionAutostartStore(join(stateDir, "session-autostart.json")).getSettings();
  const policyEnabled = effectivePolicyAllowsTarget(effectivePolicy, { harness: input.harness, sessionId: input.sessionId, cwd: resolve(input.cwd) });
  // The per-session switch decides that session on its own; the global policy
  // only decides the sessions that carry no switch of their own.
  const sessionEnabled = record?.enabled === true;
  const goalIdentity = { harness: input.harness, sessionId: input.sessionId, cwd: resolve(input.cwd) };
  const armedGoal = await readGoalSnapshot(goalStore, goalIdentity);
  const goalOptIn = record?.enabled !== false && armedGoal?.armed === true;
  const enabled = record?.enabled === false ? false : goalOptIn || sessionEnabled || policyEnabled;
  if (await held()) {
    return { ok: true, command, harness: input.harness, session_id: input.sessionId, enabled, decision: "human-stop-held" };
  }
  if (!enabled) {
    return { ok: true, command, harness: input.harness, session_id: input.sessionId, enabled: false, decision: "disabled" };
  }
  const hook = await buildStopInput(input);
  const goalSnapshot = armedGoal;
  if (goalSnapshot?.armed) {
    const canApply = async () => {
      if (await held()) return false;
      const latestRecord = await store.get(input.harness, input.sessionId);
      if (latestRecord?.enabled === false) return false;
      const latestPolicy = await policyStore.readEffective();
      const latestGoal = await readGoalSnapshot(goalStore, goalIdentity);
      if (!latestGoal?.armed || latestGoal.goalRevision !== goalSnapshot.goalRevision) return false;
      const latestSessionEnabled = latestRecord?.enabled === true && (latestPolicy.source !== "persisted" || latestPolicy.policy.enabled);
      const latestPolicyEnabled = effectivePolicyAllowsTarget(latestPolicy, { harness: input.harness, sessionId: input.sessionId, cwd: resolve(input.cwd) });
      return latestGoal.armed || latestSessionEnabled || latestPolicyEnabled;
    };
    return evaluateArmedGoal({ input, store: goalStore, snapshot: goalSnapshot,
      model: createConfiguredGoalModel({
        baseUrl: requiredEnv("AGENT_HERDER_AUTOPILOT_JUDGE_BASE_URL"),
        model: runtimeSettings.autopilotJudgeModel || requiredEnv("AGENT_HERDER_AUTOPILOT_JUDGE_MODEL"),
        token: process.env.AGENT_HERDER_AUTOPILOT_JUDGE_TOKEN || (process.env.AGENT_HERDER_AUTOPILOT_JUDGE_TOKEN_FILE ? (await readFile(process.env.AGENT_HERDER_AUTOPILOT_JUDGE_TOKEN_FILE, "utf8")).trim() : undefined) || process.env.OPENAI_API_KEY,
      }),
      route: configuredJudgeRoute({ baseUrl: requiredEnv("AGENT_HERDER_AUTOPILOT_JUDGE_BASE_URL"), model: runtimeSettings.autopilotJudgeModel || requiredEnv("AGENT_HERDER_AUTOPILOT_JUDGE_MODEL") }),
      isHeld: held,
      canApply,
    });
  }
  if (record?.noticeIncident && record.cwd !== hook.cwd) throw new Error("Notice incident native cwd no longer matches the saved binding");
  const receiptPath = join(stateDir, "receipts.json");
  const sessionLockPath = join(stateDir, "session-locks", `${createHash("sha256").update(`${input.harness}:${input.sessionId}`).digest("hex")}.lock`);
  const release = await acquireLock(sessionLockPath);
  if (!release) return { ok: false, command, reason: "session-lock-unavailable" };
  try {
    const choiceRegistry = new ChoiceRegistry(join(stateDir, "choices.json"));
    const humanRequests = new HumanRequestRegistry(resolveHumanRequestStorePath(stateDir));
    const pendingQuestions = new PendingQuestionGate({ humanRequests, choices: choiceRegistry });
    const questionProducer = await noticeQuestionProducer();
    const receipts = await loadReceiptStore(receiptPath);
    let observedDecision: { decision: AutopilotDecision; choiceRequestId?: string; humanRequestId?: string } | undefined;
    const core = createAutopilotCore({
      judge: createOpenAICompatibleJudge({
        // Background inference is independent of the short native-hook deadline.
        timeoutMs: background ? 90_000 : 35_000,
        baseUrl: requiredEnv("AGENT_HERDER_AUTOPILOT_JUDGE_BASE_URL"),
        model: runtimeSettings.autopilotJudgeModel || requiredEnv("AGENT_HERDER_AUTOPILOT_JUDGE_MODEL"),
        token: process.env.AGENT_HERDER_AUTOPILOT_JUDGE_TOKEN || (process.env.AGENT_HERDER_AUTOPILOT_JUDGE_TOKEN_FILE ? (await readFile(process.env.AGENT_HERDER_AUTOPILOT_JUDGE_TOKEN_FILE, "utf8")).trim() : undefined) || process.env.OPENAI_API_KEY,
      }),
      notify: createNoticePlaceSink({
        eventUrl: requiredEnv("NOTIFY_CENTER_EVENT_URL"),
        token: requiredEnv("NOTIFY_CENTER_TOKEN"),
      }),
      allowSessions: new Set([input.sessionId]),
      effectivePolicy,
      ...(sessionEnabled ? { policyBypassSessionId: input.sessionId } : {}),
      receiptStore: receipts,
      ...(record?.cwd === hook.cwd && record.noticeIncident ? { noticeIncident: record.noticeIncident } : {}),
      incidentUpdates: createIncidentUpdateSink(),
      checkpointReceipts: () => checkpointAutopilotReceipts(stateDir, receiptPath, receipts, input.sessionId),
      maxContinuationsPerSession: readInteger(process.env.AGENT_HERDER_AUTOPILOT_MAX_CONTINUATIONS, 3),
      notification: {
        project: process.env.AGENT_HERDER_AUTOPILOT_NOTIFY_PROJECT || "agent-herder",
        recipient: process.env.AGENT_HERDER_AUTOPILOT_NOTIFY_RECIPIENT || requiredEnv("NOTIFY_CENTER_RECIPIENT"),
        kind: process.env.AGENT_HERDER_AUTOPILOT_NOTIFY_KIND || "notification",
      },
      choiceRegistry,
      humanRequests,
      ...(questionProducer || record?.noticeIncident ? { deliverHumanQuestion: (question: PendingHumanQuestion) => question.noticeIncident ? deliverIncidentQuestion(question) : deliverNoticeQuestion(question, questionProducer!) } : {}),
      // The same durable fence the launcher applies: an unanswered question is
      // never continued here, whatever turn id arrives.
      pendingQuestions,
      harness: input.harness,
      onDecision: (decision, metadata) => {
        observedDecision = { decision, ...(metadata?.choiceRequestId ? { choiceRequestId: metadata.choiceRequestId } : {}), ...(metadata?.humanRequestId ? { humanRequestId: metadata.humanRequestId } : {}) };
      },
    });
    const result = await core.handleStop(hook);
    await checkpointAutopilotReceipts(stateDir, receiptPath, receipts, input.sessionId);
    if (await held()) {
      return { ok: true, command, harness: input.harness, session_id: input.sessionId, decision: "human-stop-held" };
    }
    if ("decision" in result && result.decision === "block") {
      const nextGoal = result.reason;
      await humanStops.rememberGeneratedPrompt(input.harness, input.sessionId, nextGoal);
      if (await held()) return { ok: true, command, harness: input.harness, session_id: input.sessionId, decision: "human-stop-held" };
      if (background || input.harness === "codex" || input.harness === "claude" || input.harness === "zcode") {
        return { ok: true, command, harness: input.harness, session_id: input.sessionId, decision: "continue", next_goal: nextGoal };
      }
      if (input.harness === "hermes") {
        return { ok: true, command, harness: input.harness, session_id: input.sessionId, decision: "continue", next_goal: nextGoal, resume_status: "local-inject" };
      }
      if (await held()) return { ok: true, command, harness: input.harness, session_id: input.sessionId, decision: "human-stop-held" };
      // OpenCode 2 sessions are not addressable by the standalone CLI, so the
      // continuation goes through the harness' own inbox and falls back to the
      // durable agent-resume transport only if that fails.
      const delivery = await deliverAutopilotGoal(input, nextGoal,
        `autopilot:${input.harness}:${input.sessionId}:${hook.turn_id}:${createHash("sha256").update(nextGoal).digest("hex").slice(0, 16)}`);
      return {
        ok: delivery.status !== "failed", command, harness: input.harness, session_id: input.sessionId,
        decision: "continue", next_goal: nextGoal, resume_status: delivery.status,
        delivery_transport: delivery.transport, ...(delivery.error ? { reason: delivery.error } : {}),
      };
    }
    if (observedDecision?.decision.kind === "choice") {
      return { ok: true, command, harness: input.harness, session_id: input.sessionId, decision: "choice", request_id: observedDecision.choiceRequestId ?? observedDecision.humanRequestId };
    }
    // The wire decision stays compatible; hooks must distinguish a confirmed
    // done verdict from human/unknown instead of treating {} as task success.
    return { ok: true, command, harness: input.harness, session_id: input.sessionId, decision: "terminal",
      terminalKind: observedDecision?.decision.kind === "done" ? "completed" : observedDecision?.decision.kind === "human" ? "needs-input" : "unknown" };
  } finally {
    await release();
  }
}

async function evaluateArmedGoal(args: {
  input: AutopilotRunnerInput; store: GoalStore;
  snapshot: import("./autopilot/goal-store.js").GoalSnapshot;
  model: import("./autopilot/goal-evaluation.js").GoalModel;
  route: { provider: string; model: string; subscription: false };
  isHeld: () => Promise<boolean>;
  canApply: () => Promise<boolean>;
}): Promise<Record<string, unknown>> {
  const { input, store, snapshot } = args;
  const stop = async () => ({ ok: true, command: input.command ?? "stop", harness: input.harness, session_id: input.sessionId, decision: "human-stop-held" });
  if (!input.nativeFence) return { ok: false, command: input.command ?? "stop", harness: input.harness, session_id: input.sessionId,
    decision: "unavailable", reason: "Full-goal control is available only through the existing background controller.",
    goal_status: "Для этой цели не подтверждён единственный безопасный контроллер продолжения.", goal_control: "opt-in", judge_route: args.route };
  if (await args.isHeld()) return stop();
  const events = snapshot.primaryEvents.map((event, index) => ({
    id: event.eventId, cursor: String(index + 1), kind: index === 0 ? "objective" as const : "amendment" as const, text: event.text,
  }));
  if (!events.length || events[0].text.length === 0) return { ok: false, decision: "unavailable", reason: "full-primary-goal-unavailable", goal_control: "opt-in" };
  const targetRefs = explicitGoalTargetRefs(snapshot.primaryEvents, snapshot.requirements);
  const collected = await collectGoalEvidence({ identity: snapshot.identity, requirements: snapshot.requirements, targetRefs });
  const evidenceById = new Map([...snapshot.evidence.filter(evidence => evidence.sourceKind !== "native-report"), ...collected.evidence].map(evidence => [evidence.id, evidence]));
  const result = await evaluateGoal({
    goalRevision: String(snapshot.goalRevision), fullObjective: events[0].text, userEvents: events,
    inputCursor: String(snapshot.inputCursor),
    requirements: snapshot.requirements.map(requirement => ({ ...requirement,
      status: "open" as const, evidenceIds: snapshot.evidence.filter(e => e.requirementId === requirement.id).map(e => e.id),
    })),
    ...(snapshot.evaluation?.requirementMemo ? { requirementMemo: snapshot.evaluation.requirementMemo } : {}),
    evidence: [...evidenceById.values()].map(evidence => ({ id: evidence.id, requirementId: evidence.requirementId, text: evidence.text ?? evidence.provenance,
      observedVersion: evidence.version, ...(evidence.freshUntil ? { validUntil: Date.parse(evidence.freshUntil) } : {}), source: evidence.provenance,
      sourceKind: evidence.sourceKind ?? "file", loaded: evidence.materialLoaded })),
    evidenceVersion: String(snapshot.evidenceVersion), controlEpoch: String(snapshot.controlEpoch),
    ...(input.nativeReportObservation?.status === "observed" ? { nativeReport: toGoalNativeReport(snapshot.identity, input.nativeReportObservation) } : {}),
    ...(input.nativeReportObservation?.status === "unavailable" ? { nativeReportUnavailable: input.nativeReportObservation.reason } : {}),
    materials: [
      ...collected.materials.map(material => ({ id: material.path, text: material.text, complete: material.complete, version: material.version, kind: "file" as const })),
      ...collected.evidence.filter(evidence => !evidence.materialLoaded).map(evidence => ({ id: evidence.provenance,
        text: `Материал недоступен: ${evidence.provenance}`, complete: false, version: evidence.version, kind: "file" as const })),
      ...explicitUnavailableMaterials(snapshot.primaryEvents, snapshot.requirements),
    ],
  }, args.model);
  const modelUsage = (args.model as typeof args.model & { getUsage?: () => import("./autopilot/goal-evaluation.js").GoalModelUsage | undefined }).getUsage?.();
  if (await args.isHeld()) return stop();
  const reportRequirements = result.requirements.filter(requirement => requirement.verificationKind === "native-report");
  const initialNativeEvidence = nativeReportEvidence(snapshot.identity, reportRequirements, input.nativeReportObservation);
  const evidenceFingerprint = createHash("sha256").update(JSON.stringify({
    evidence: collected.evidence.map(e => [e.requirementId, e.id, e.version, e.materialLoaded]).sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    materials: collected.materials.map(m => [m.requirementId, m.path, m.version]).sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    unavailable: [...collected.unavailable].sort(),
    nativeReport: initialNativeEvidence.map(e => [e.requirementId, e.version, e.materialLoaded]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  })).digest("hex");
  const requirements = result.requirements.map(({ id, text, sourceEventIds, verificationKind }) => ({ id, text, sourceEventIds, verificationKind }));
  // An empty memo is the evaluator's explicit fail-closed extraction/error
  // marker. Persist the reason without advancing the processed-input cursor or
  // replacing the durable requirement ledger with a fabricated projection.
  const extractionFailed = result.requirementMemo.requirements.length === 0;
  const projected = extractionFailed ? args.snapshot : await store.applyRequirements(args.snapshot.identity, args.snapshot, snapshot.inputCursor, requirements);
  if (!projected) return { ok: true, command: input.command ?? "stop", harness: input.harness, session_id: input.sessionId, decision: "unavailable", reason: "goal-input-changed-during-evaluation", goal_control: "opt-in" };
  const evaluated = await store.recordEvaluation(args.snapshot.identity, projected, {
    requirementMemo: result.requirementMemo,
    requirementsStatus: result.requirements.map(({ id, status, evidenceIds }) => ({ id, status, evidenceIds })),
    lastDecision: result.decision.kind,
    ...(result.decision.kind === "blocked" ? { lastReason: result.decision.reason } : {}),
    ...(modelUsage ? { usage: modelUsage } : {}),
  });
  if (!evaluated) return { ok: true, command: input.command ?? "stop", harness: input.harness, session_id: input.sessionId, decision: "unavailable", reason: "goal-changed-during-evaluation-record", goal_control: "opt-in" };
  if (await args.isHeld()) return stop();
  if (result.decision.kind === "blocked") return {
    ok: true, command: input.command ?? "stop", harness: input.harness, session_id: input.sessionId,
    decision: "unavailable", reason: result.decision.reason, goal_status: `Завершение цели пока не подтверждено: ${result.decision.reason}`, goal_revision: evaluated.goalRevision,
    goal_control: "opt-in", judge_route: args.route,
  };
  if (input.harness === "hermes") return {
    ok: true, command: input.command ?? "stop", harness: input.harness, session_id: input.sessionId,
    decision: "unavailable", reason: "Hermes has no verified equal-proof full-goal handoff", goal_status: "Автопилот не подтверждает продолжение и завершение цели в этой среде.",
    goal_control: "opt-in", judge_route: args.route,
  };
  if (result.decision.kind === "continue") {
    const actionFingerprint = createHash("sha256").update(result.decision.nextAction).digest("hex");
    const prior = snapshot.evaluation?.lastAdmission;
    if (prior?.actionFingerprint === actionFingerprint && prior.evidenceFingerprint === evidenceFingerprint
      && prior.goalRevision === snapshot.goalRevision && prior.inputCursor === snapshot.inputCursor
      && prior.evidenceVersion === snapshot.evidenceVersion) return {
      ok: true, command: input.command ?? "stop", harness: input.harness, session_id: input.sessionId,
      decision: "unavailable", reason: "no-progress-same-action-and-evidence", goal_control: "opt-in",
      goal_status: "Новое продолжение не отправлено: после предыдущей попытки цель и проверенные материалы не изменились.", judge_route: args.route,
    };
    return {
      ok: true, command: input.command ?? "stop", harness: input.harness, session_id: input.sessionId,
      decision: "continue", next_goal: result.decision.nextAction, goal_revision: evaluated.goalRevision,
      goal_fence: goalFenceView(evaluated), goal_evidence_fingerprint: evidenceFingerprint,
      goal_action_fingerprint: actionFingerprint,
      goal_control: "opt-in", goal_status: collected.unavailable.length
        ? `Цель не завершена: требуется продолжение; части материалов недоступны (${collected.unavailable.length}).`
        : "Цель не завершена: продолжается выполнение.",
      goal_evidence_unavailable: collected.unavailable, judge_route: args.route,
    };
  }
  const firstNativeFence = input.nativeFence ? normalizeNativeFence(await input.nativeFence()) : { allowed: false };
  if (!firstNativeFence.allowed || await args.isHeld() || !await args.canApply()) return {
    ok: true, command: input.command ?? "stop", harness: input.harness, session_id: input.sessionId,
    decision: "unavailable", reason: "native-session-fence-unavailable-or-stale", goal_control: "opt-in", judge_route: args.route,
  };
  const freshNativeObservation = firstNativeFence.nativeReportObservation;
  const freshNativeEvidence = nativeReportEvidence(args.snapshot.identity, reportRequirements, freshNativeObservation);
  if (reportRequirements.length && !sameNativeReportVersions(initialNativeEvidence, freshNativeEvidence)) return {
    ok: true, command: input.command ?? "stop", harness: input.harness, session_id: input.sessionId,
    decision: "unavailable", reason: "native-report-changed-or-unavailable-after-audit", goal_control: "opt-in", judge_route: args.route,
  };
  const fresh = await collectGoalEvidence({ identity: evaluated.identity, requirements: evaluated.requirements, targetRefs: explicitGoalTargetRefs(evaluated.primaryEvents, evaluated.requirements) });
  const auditedFileEvidence = collected.evidence.filter(evidence => evaluated.requirements.some(requirement => requirement.id === evidence.requirementId && (requirement.verificationKind ?? "file") === "file"));
  if (!sameEvidenceVersions(auditedFileEvidence, fresh.evidence)) return {
    ok: true, command: input.command ?? "stop", harness: input.harness, session_id: input.sessionId,
    decision: "unavailable", reason: "goal-evidence-changed-after-audit", goal_control: "opt-in", judge_route: args.route,
  };
  const activeEvidence = [...fresh.evidence, ...freshNativeEvidence].filter(evidence => evaluated.requirements.some(requirement => requirement.id === evidence.requirementId));
  const check = await store.checkCompletion(args.snapshot.identity, evaluated, activeEvidence);
  if (!check.ok || await args.isHeld() || !await args.canApply()) return {
    ok: true, command: input.command ?? "stop", harness: input.harness, session_id: input.sessionId,
    decision: "unavailable", reason: check.ok ? "human-stop-held" : check.reasons.join("; "), goal_control: "opt-in", judge_route: args.route,
  };
  const finalNativeFence = input.nativeFence ? normalizeNativeFence(await input.nativeFence()) : { allowed: false };
  if (!finalNativeFence.allowed || await args.isHeld() || !await args.canApply()
    || (reportRequirements.length && !sameNativeReportVersions(freshNativeEvidence, nativeReportEvidence(args.snapshot.identity, reportRequirements, finalNativeFence.nativeReportObservation)))) return {
    ok: true, command: input.command ?? "stop", harness: input.harness, session_id: input.sessionId,
    decision: "unavailable", reason: "native-session-fence-unavailable-or-stale", goal_control: "opt-in", judge_route: args.route,
  };
  return { ok: true, command: input.command ?? "stop", harness: input.harness, session_id: input.sessionId,
    decision: "done-candidate", summary: result.decision.summary, completion_ticket: check.ticket,
    goal_fence: goalFenceView(check.ticket), goal_control: "opt-in", judge_route: args.route };
}

function sameEvidenceVersions(before: Array<{ requirementId: string; version: string }>, after: Array<{ requirementId: string; version: string }>): boolean {
  const key = (items: typeof before) => items.map(item => `${item.requirementId}\0${item.version}`).sort().join("\n");
  return key(before) === key(after);
}

function normalizeNativeFence(value: boolean | NativeFenceRead): NativeFenceRead {
  return typeof value === "boolean" ? { allowed: value } : value;
}

function nativeReportEvidence(identity: import("./autopilot/goal-store.js").GoalIdentity, requirements: Array<{ id: string }>, observation?: NativeReportObservation): import("./autopilot/goal-store.js").GoalEvidence[] {
  if (observation?.status !== "observed" || Date.parse(observation.freshUntil) <= Date.now()
    || !observation.version || !observation.messageId || Buffer.byteLength(observation.text, "utf8") > 64 * 1024) return [];
  const report = toGoalNativeReport(identity, observation);
  return requirements.flatMap(requirement => {
    const proof = makeNativeReportEvidence(requirement.id, report);
    return proof ? [{ id: proof.id, requirementId: proof.requirementId, version: proof.observedVersion, provenance: proof.source,
      observedAt: observation.observedAt, freshUntil: observation.freshUntil, materialLoaded: true, sourceKind: "native-report" as const, text: proof.text }] : [];
  });
}

function toGoalNativeReport(identity: import("./autopilot/goal-store.js").GoalIdentity, observation: Extract<NativeReportObservation, { status: "observed" }>): GoalNativeReport {
  return { messageId: observation.messageId, text: observation.text, version: observation.version,
    source: `native-message:${identity.harness}:${identity.sessionId}:${observation.messageId}`,
    observedAt: observation.observedAt, validUntil: Date.parse(observation.freshUntil) };
}

function sameNativeReportVersions(before: Array<{ requirementId: string; version: string }>, after: Array<{ requirementId: string; version: string }>): boolean {
  const key = (items: typeof before) => items.map(item => `${item.requirementId}\0${item.version}`).sort().join("\n");
  return key(before) === key(after) && before.length === after.length;
}

function explicitGoalTargetRefs(events: Array<{ eventId: string; refs?: Array<{ uri: string }> }>, requirements: Array<{ id: string; sourceEventIds: string[]; verificationKind?: "file" | "native-report" }>): GoalEvidenceTargetRef[] {
  return requirements.filter(requirement => (requirement.verificationKind ?? "file") === "file").flatMap(requirement => requirement.sourceEventIds.flatMap(eventId => {
    const event = events.find(item => item.eventId === eventId);
    return (event?.refs ?? []).flatMap(ref => {
      try {
        if (ref.uri.startsWith("file://")) return [{ requirementId: requirement.id, path: fileURLToPath(ref.uri) }];
      } catch { return []; }
      return ref.uri.startsWith("/") ? [{ requirementId: requirement.id, path: ref.uri }] : [];
    });
  }));
}

function explicitUnavailableMaterials(events: Array<{ eventId: string; refs?: Array<{ uri: string; label?: string }> }>, requirements: Array<{ id: string; sourceEventIds: string[]; verificationKind?: "file" | "native-report" }>): Array<{ id: string; text: string; complete: false; version: string; kind: "file" }> {
  return requirements.filter(requirement => (requirement.verificationKind ?? "file") === "file").flatMap(requirement => requirement.sourceEventIds.flatMap(eventId => {
    const event = events.find(item => item.eventId === eventId);
    return (event?.refs ?? []).flatMap(ref => {
      if (ref.uri.startsWith("/")) return [];
      try { if (ref.uri.startsWith("file://")) { fileURLToPath(ref.uri); return []; } } catch { /* Keep malformed declared refs incomplete. */ }
      return [{ id: `${requirement.id}:${ref.uri}`, text: `Материал не поддерживается для проверки: ${ref.label ?? ref.uri}`, complete: false as const, version: "unavailable", kind: "file" as const }];
    });
  }));
}

async function readGoalSnapshot(store: GoalStore, identity: { harness: string; sessionId: string; cwd: string }) {
  try { return await store.snapshot(identity); }
  catch (error) {
    if (error instanceof Error && error.message === "goal is not armed for this session") return undefined;
    throw error;
  }
}

export async function autopilotGoalFenceCurrent(input: Pick<AutopilotRunnerInput, "harness" | "sessionId" | "cwd">, expected: Record<string, unknown>): Promise<boolean> {
  const snapshot = await readGoalSnapshot(new GoalStore(stateDir), { harness: input.harness, sessionId: input.sessionId, cwd: resolve(input.cwd) });
  return !!snapshot && snapshot.armed && snapshot.goalRevision === expected.goalRevision
    && snapshot.inputCursor === expected.inputCursor && snapshot.processedInputCursor === expected.processedInputCursor
    && snapshot.evidenceVersion === expected.evidenceVersion && snapshot.controlEpoch === expected.controlEpoch
    && snapshot.nativeCursor === expected.nativeCursor;
}

export async function withAutopilotGoalContinuationAdmission<T>(input: Pick<AutopilotRunnerInput, "harness" | "sessionId" | "cwd">, expected: Record<string, unknown>, admit: () => Promise<T>, submission?: ContinuationSubmission<T>) {
  const fields = ["goalRevision", "inputCursor", "processedInputCursor", "evidenceVersion", "controlEpoch"] as const;
  if (fields.some(key => !Number.isSafeInteger(expected[key]) || (expected[key] as number) < 0)) return { admitted: false as const, reason: "invalid-goal-fence" };
  if (expected.nativeCursor !== undefined && typeof expected.nativeCursor !== "string") return { admitted: false as const, reason: "invalid-native-cursor-fence" };
  const identity = { harness: input.harness, sessionId: input.sessionId, cwd: resolve(input.cwd) };
  const fence = { identity, goalRevision: expected.goalRevision as number, inputCursor: expected.inputCursor as number,
    processedInputCursor: expected.processedInputCursor as number, evidenceVersion: expected.evidenceVersion as number,
    controlEpoch: expected.controlEpoch as number, ...(typeof expected.nativeCursor === "string" ? { nativeCursor: expected.nativeCursor } : {}) };
  return new GoalStore(stateDir).withContinuationAdmission(identity, fence, admit, submission);
}

export async function autopilotGoalNativeInputsKnown(input: Pick<AutopilotRunnerInput, "harness" | "sessionId" | "cwd">, messages: SessionMessageView[]): Promise<boolean> {
  const identity = { harness: input.harness, sessionId: input.sessionId, cwd: resolve(input.cwd) };
  const store = new GoalStore(stateDir);
  const snapshot = await readGoalSnapshot(store, identity);
  if (!snapshot?.armed) return true;
  if (!messages.length) return snapshot.nativeCursor === undefined;
  const baselineIndex = snapshot.nativeCursor ? messages.findIndex(message => message.id === snapshot.nativeCursor) : -1;
  if (snapshot.nativeCursor && baselineIndex < 0) return false; // Missing anchor means the bounded native delta is incomplete.
  const delta = snapshot.nativeCursor ? messages.slice(baselineIndex + 1) : messages;
  for (const message of delta.filter(item => item.role === "user")) {
    if (snapshot.primaryEvents.some(event => event.text === message.text)) continue;
    if (await getHumanStopStore().isGeneratedPrompt(input.harness, input.sessionId, { text: message.text, turnId: message.turnId })) continue;
    return false;
  }
  const latestId = messages.at(-1)?.id;
  return latestId === snapshot.nativeCursor || !!latestId && await store.recordNativeCursor(identity, snapshot, latestId);
}

export async function autopilotGoalNativeReportAdmissible(
  input: Pick<AutopilotRunnerInput, "harness" | "sessionId" | "cwd">,
  messages: SessionMessageView[],
  observedMessageId: string,
): Promise<boolean> {
  const identity = { harness: input.harness, sessionId: input.sessionId, cwd: resolve(input.cwd) };
  const snapshot = await readGoalSnapshot(new GoalStore(stateDir), identity);
  const admission = snapshot?.evaluation?.lastAdmission;
  if (!snapshot?.armed || !admission || admission.goalRevision !== snapshot.goalRevision
    || admission.inputCursor !== snapshot.inputCursor
    || admission.nativeCursor === undefined) return false;
  const anchorIndex = admission.nativeCursor === null ? -1 : messages.findIndex(message => message.id === admission.nativeCursor);
  if (admission.nativeCursor !== null && anchorIndex < 0) return false;
  const promptIndex = messages.findIndex((message, index) => index > anchorIndex && message.role === "user"
    && createHash("sha256").update(visibleNativeText(message)).digest("hex") === admission.actionFingerprint);
  if (promptIndex < 0) return false;
  return messages.some((message, index) => index > promptIndex && message.id === observedMessageId && message.role === "assistant"
    && visibleNativeText(message).trim().length > 0);
}

function visibleNativeText(message: SessionMessageView): string {
  return message.parts.filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text!).join("\n");
}

export async function autopilotGoalArmed(input: Pick<AutopilotRunnerInput, "harness" | "sessionId" | "cwd">): Promise<boolean> {
  const snapshot = await readGoalSnapshot(new GoalStore(stateDir), { harness: input.harness, sessionId: input.sessionId, cwd: resolve(input.cwd) });
  return snapshot?.armed === true;
}

export async function autopilotGoalControllerAllowed(input: Pick<AutopilotRunnerInput, "harness" | "sessionId" | "cwd">, session: import("./types/index.js").AgentSession): Promise<{ allowed: boolean; reason?: string }> {
  const snapshot = await readGoalSnapshot(new GoalStore(stateDir), { harness: input.harness, sessionId: input.sessionId, cwd: resolve(input.cwd) });
  return !snapshot?.armed ? { allowed: true } : goalControllerAdmission(session);
}

export async function applyAutopilotGoalCompletion(input: Pick<AutopilotRunnerInput, "harness" | "sessionId" | "cwd">, ticket: unknown, nativeObservation?: NativeReportObservation): Promise<boolean> {
  if (!ticket || typeof ticket !== "object") return false;
  const identity = { harness: input.harness, sessionId: input.sessionId, cwd: resolve(input.cwd) };
  const store = new GoalStore(stateDir);
  const snapshot = await readGoalSnapshot(store, identity);
  if (!snapshot || snapshot.stopped || !snapshot.armed) return false;
  const expected = ticket as import("./autopilot/goal-store.js").CompletionTicket;
  if (expected.goalRevision !== snapshot.goalRevision || expected.inputCursor !== snapshot.inputCursor
    || expected.processedInputCursor !== snapshot.processedInputCursor || expected.evidenceVersion !== snapshot.evidenceVersion
    || expected.controlEpoch !== snapshot.controlEpoch || expected.nativeCursor !== snapshot.nativeCursor) return false;
  const fresh = await collectGoalEvidence({ identity, requirements: snapshot.requirements, targetRefs: explicitGoalTargetRefs(snapshot.primaryEvents, snapshot.requirements) });
  const fileEvidence = snapshot.evidence.filter(evidence => (evidence.sourceKind ?? "file") === "file");
  if (!sameEvidenceVersions(fileEvidence, fresh.evidence)) return false;
  const reportEvidence = snapshot.evidence.filter(evidence => evidence.sourceKind === "native-report");
  if (reportEvidence.length && (nativeObservation?.status !== "observed" || Date.parse(nativeObservation.freshUntil) <= Date.now()
    || reportEvidence.some(evidence => evidence.version !== `sha256:${nativeObservation.version}`))) return false;
  return store.applyCompletion(identity, expected);
}

function goalFenceView(snapshot: Pick<import("./autopilot/goal-store.js").GoalSnapshot, "goalRevision" | "inputCursor" | "processedInputCursor" | "evidenceVersion" | "controlEpoch" | "nativeCursor">): Record<string, unknown> {
  return { goalRevision: snapshot.goalRevision, inputCursor: snapshot.inputCursor, processedInputCursor: snapshot.processedInputCursor,
    evidenceVersion: snapshot.evidenceVersion, controlEpoch: snapshot.controlEpoch, nativeCursor: snapshot.nativeCursor };
}

async function buildStopInput(input: AutopilotRunnerInput): Promise<StopHookInput> {
  if (input.harness === "opencode" && input.lastAssistantMessage === undefined) {
    const adapter = new OpenCodeAdapter({ baseUrl: process.env.OPENCODE_URL, password: process.env.OPENCODE_SERVER_PASSWORD });
    const messages = await adapter.getSessionMessages(input.sessionId, 12);
    const assistant = messages?.filter((message) => message.role === "assistant").at(-1);
    const lastAssistant = assistant?.text ?? null;
    const lastUser = messages?.filter((message) => message.role === "user").at(-1)?.text ?? null;
    return stopInput({ ...input, model: assistant?.model ?? input.model }, lastAssistant, lastUser);
  }
  return stopInput(input, input.lastAssistantMessage ?? null, input.lastUserMessage);
}

function stopInput(input: AutopilotRunnerInput, lastAssistantMessage: string | null, lastUserMessage?: string | null): StopHookInput {
  return {
    hook_event_name: "Stop",
    session_id: input.sessionId,
    cwd: resolve(input.cwd),
    turn_id: input.turnId || `turn-${Date.now()}`,
    ...(lastUserMessage !== undefined ? { last_user_message: lastUserMessage } : {}),
    last_assistant_message: lastAssistantMessage,
    transcript_path: input.transcriptPath ?? null,
    stop_hook_active: input.stopHookActive ?? false,
    harness: input.harness,
    ...(input.model ? { model: input.model } : {}),
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

async function main() {
  const raw = process.argv[2];
  const input = raw ? JSON.parse(raw) as AutopilotRunnerInput : JSON.parse(await readStdin()) as AutopilotRunnerInput;
  process.stdout.write(`${JSON.stringify(await runAutopilotCommand(input))}\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
