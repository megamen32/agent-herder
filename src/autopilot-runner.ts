#!/usr/bin/env node
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
  persistReceiptStore,
  type StopHookInput,
  type AutopilotDecision,
} from "./autopilot/index.js";
import { ChoiceRegistry } from "./autopilot/choice-registry.js";
import { PendingQuestionGate } from "./autopilot/pending-question-gate.js";
import { HumanRequestRegistry } from "./human-request/index.js";
import { deliverNoticeQuestion, type NoticeQuestionConfig } from "./human-request/notice-question.js";
import { AutopilotPolicyStore, resolveAutopilotPolicyStorePath } from "./autopilot/policy-store.js";
import { adoptLegacyAutopilotState, resolveAutopilotStateDir, resolveHumanRequestStorePath } from "./autopilot/state-dir.js";
import { effectivePolicyAllowsTarget } from "./autopilot/policy.js";
import { AutopilotSessionStore, type AutopilotHarness } from "./autopilot/session-store.js";
import { acquireLock } from "./autopilot-hook.js";
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
};

const stateDir = resolveAutopilotStateDir();

/** The dedicated Notice human-request intake used by a human judge decision. */
function noticeQuestionConfig(): NoticeQuestionConfig {
  const token = process.env.NOTIFY_CENTER_TOKEN?.trim();
  const endpoint = process.env.NOTIFY_CENTER_HUMAN_REQUEST_URL?.trim()
    ?? process.env.NOTIFY_CENTER_EVENT_URL?.trim().replace(/\/v1\/events\/?$/, "/v1/human-requests");
  if (!token || !endpoint) {
    throw new Error("NOTIFY_CENTER_TOKEN and a human-request endpoint are required to ask a human a question");
  }
  const allowedActors = process.env.NOTIFY_CENTER_ALLOWED_ACTORS?.split(",").map((actor) => actor.trim()).filter(Boolean);
  return {
    endpoint,
    token,
    project: process.env.NOTIFY_CENTER_PROJECT?.trim() || process.env.AGENT_HERDER_AUTOPILOT_NOTIFY_PROJECT?.trim() || "agent-herder",
    recipient: process.env.AGENT_HERDER_AUTOPILOT_NOTIFY_RECIPIENT?.trim() || "me",
    ...(allowedActors && allowedActors.length > 0 ? { allowedActors } : {}),
  };
}

export async function runAutopilotCommand(input: AutopilotRunnerInput): Promise<Record<string, unknown>> {
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
    return { ok: true, command, harness: input.harness, session_id: input.sessionId, enabled, human_stop_held: await held(), source: record ? "session" : effectivePolicy.source };
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
  const receiptPath = join(stateDir, "receipts.json");
  const sessionLockPath = join(stateDir, "session-locks", `${createHash("sha256").update(`${input.harness}:${input.sessionId}`).digest("hex")}.lock`);
  const release = await acquireLock(sessionLockPath);
  if (!release) return { ok: false, command, reason: "session-lock-unavailable" };
  try {
    const choiceRegistry = new ChoiceRegistry(join(stateDir, "choices.json"));
    const humanRequests = new HumanRequestRegistry(resolveHumanRequestStorePath(stateDir));
    const pendingQuestions = new PendingQuestionGate({ humanRequests, choices: choiceRegistry });
    const receipts = await loadReceiptStore(receiptPath);
    let observedDecision: { decision: AutopilotDecision; choiceRequestId?: string } | undefined;
    const core = createAutopilotCore({
      judge: createOpenAICompatibleJudge({
        baseUrl: requiredEnv("AGENT_HERDER_AUTOPILOT_JUDGE_BASE_URL"),
        model: runtimeSettings.autopilotJudgeModel || requiredEnv("AGENT_HERDER_AUTOPILOT_JUDGE_MODEL"),
        token: process.env.AGENT_HERDER_AUTOPILOT_JUDGE_TOKEN || process.env.OPENAI_API_KEY,
      }),
      notify: createNoticePlaceSink({
        eventUrl: requiredEnv("NOTIFY_CENTER_EVENT_URL"),
        token: requiredEnv("NOTIFY_CENTER_TOKEN"),
      }),
      allowSessions: new Set([input.sessionId]),
      effectivePolicy,
      ...(sessionEnabled ? { policyBypassSessionId: input.sessionId } : {}),
      receiptStore: receipts,
      maxContinuationsPerSession: readInteger(process.env.AGENT_HERDER_AUTOPILOT_MAX_CONTINUATIONS, 3),
      notification: {
        project: process.env.AGENT_HERDER_AUTOPILOT_NOTIFY_PROJECT || "agent-herder",
        recipient: requiredEnv("AGENT_HERDER_AUTOPILOT_NOTIFY_RECIPIENT"),
        kind: process.env.AGENT_HERDER_AUTOPILOT_NOTIFY_KIND || "notification",
      },
      choiceRegistry,
      humanRequests,
      deliverHumanQuestion: (question) => deliverNoticeQuestion(question, noticeQuestionConfig()),
      // The same durable fence the launcher applies: an unanswered question is
      // never continued here, whatever turn id arrives.
      pendingQuestions,
      harness: input.harness,
      onDecision: (decision, metadata) => {
        observedDecision = { decision, ...(metadata?.choiceRequestId ? { choiceRequestId: metadata.choiceRequestId } : {}) };
      },
    });
    const result = await core.handleStop(hook);
    await persistReceiptStore(receiptPath, receipts);
    if (await held()) {
      return { ok: true, command, harness: input.harness, session_id: input.sessionId, decision: "human-stop-held" };
    }
    if ("decision" in result && result.decision === "block") {
      const nextGoal = result.reason;
      await humanStops.rememberGeneratedPrompt(input.harness, input.sessionId, nextGoal);
      if (await held()) return { ok: true, command, harness: input.harness, session_id: input.sessionId, decision: "human-stop-held" };
      if (input.harness === "codex" || input.harness === "claude" || input.harness === "zcode") {
        return { ok: true, command, harness: input.harness, session_id: input.sessionId, decision: "continue", next_goal: nextGoal };
      }
      if (input.harness === "hermes") {
        return { ok: true, command, harness: input.harness, session_id: input.sessionId, decision: "continue", next_goal: nextGoal, resume_status: "local-inject" };
      }
      const resultRef = randomUUID();
      if (await held()) return { ok: true, command, harness: input.harness, session_id: input.sessionId, decision: "human-stop-held" };
      const receipt = await new AgentResumeClient().resume({
        target: { agent: "opencode", session_id: input.sessionId, cwd: resolve(input.cwd) },
        goal: nextGoal,
        prompt: nextGoal,
        result_ref: resultRef,
        idempotency_key: `autopilot:${input.harness}:${input.sessionId}:${hook.turn_id}:${createHash("sha256").update(nextGoal).digest("hex").slice(0, 16)}`,
      });
      return { ok: receipt.status === "accepted", command, harness: input.harness, session_id: input.sessionId, decision: "continue", next_goal: nextGoal, resume_status: receipt.status, ...(receipt.status === "accepted" ? {} : { reason: receipt.reason }) };
    }
    if (observedDecision?.decision.kind === "choice") {
      return { ok: true, command, harness: input.harness, session_id: input.sessionId, decision: "choice", request_id: observedDecision.choiceRequestId };
    }
    return { ok: true, command, harness: input.harness, session_id: input.sessionId, decision: "terminal" };
  } finally {
    await release();
  }
}

async function buildStopInput(input: AutopilotRunnerInput): Promise<StopHookInput> {
  if (input.harness === "opencode" && input.lastAssistantMessage === undefined) {
    const adapter = new OpenCodeAdapter({ baseUrl: process.env.OPENCODE_URL, password: process.env.OPENCODE_SERVER_PASSWORD });
    const messages = await adapter.getSessionMessages(input.sessionId, 12);
    const lastAssistant = messages?.filter((message) => message.role === "assistant").at(-1)?.text ?? null;
    const lastUser = messages?.filter((message) => message.role === "user").at(-1)?.text ?? null;
    return stopInput(input, lastAssistant, lastUser);
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
