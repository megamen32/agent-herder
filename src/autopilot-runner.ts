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
};

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
  const policyStore = new AutopilotPolicyStore(resolveAutopilotPolicyStorePath(stateDir));
  if (command === "status") {
    const record = await store.get(input.harness, input.sessionId);
    const effectivePolicy = await policyStore.readEffective();
    const policyEnabled = effectivePolicyAllowsTarget(effectivePolicy, { harness: input.harness, sessionId: input.sessionId, cwd: resolve(input.cwd) });
    const sessionEnabled = record?.enabled === true && (effectivePolicy.source !== "persisted" || effectivePolicy.policy.enabled);
    const enabled = record?.enabled === false ? false : sessionEnabled || policyEnabled;
    return { ok: true, command, harness: input.harness, session_id: input.sessionId, enabled, human_stop_held: await held(), source: record?.enabled !== undefined ? "session" : effectivePolicy.source };
  }
  if (command === "on" || command === "off") {
    const record = await store.set({ harness: input.harness, sessionId: input.sessionId, cwd: resolve(input.cwd) }, command === "on");
    return { ok: true, command, harness: record.harness, session_id: record.sessionId, enabled: record.enabled };
  }

  const record = await store.get(input.harness, input.sessionId);
  const effectivePolicy = await policyStore.readEffective();
  const runtimeSettings = await new SessionAutostartStore(join(stateDir, "session-autostart.json")).getSettings();
  const policyEnabled = effectivePolicyAllowsTarget(effectivePolicy, { harness: input.harness, sessionId: input.sessionId, cwd: resolve(input.cwd) });
  const sessionEnabled = record?.enabled === true && (effectivePolicy.source !== "persisted" || effectivePolicy.policy.enabled);
  const enabled = record?.enabled === false ? false : sessionEnabled || policyEnabled;
  if (await held()) {
    return { ok: true, command, harness: input.harness, session_id: input.sessionId, enabled, decision: "human-stop-held" };
  }
  if (!enabled) {
    return { ok: true, command, harness: input.harness, session_id: input.sessionId, enabled: false, decision: "disabled" };
  }
  const hook = await buildStopInput(input);
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
