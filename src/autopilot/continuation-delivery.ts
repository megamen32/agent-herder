import { resolve } from "node:path";
import { OpenCodeAdapter } from "../adapters/opencode.js";
import { AgentResumeClient } from "../resume-transport.js";
import type { AutopilotRunnerInput } from "../autopilot-runner.js";

export interface AutopilotDeliveryResult {
  status: "delivered" | "accepted" | "failed";
  transport: "opencode-inbox" | "agent-resume";
  inputId: string;
  goal: string;
  sessionId: string;
  harness: string;
  /** Present when the durable fallback transport was used. */
  receipt?: Record<string, unknown>;
  error?: string;
}

/**
 * Autopilot continuation delivery.
 *
 * OpenCode 2 keeps its session history in a storage layout the standalone
 * `opencode --session …` CLI cannot resolve (`Session not found`), so the
 * continuation goes through the harness' own inbox, which is the same native
 * admission Herder uses everywhere else. Harnesses that are CLI-only keep the
 * durable agent-resume transport, and any OpenCode failure falls back to it so
 * a continuation is never silently dropped.
 */
export async function deliverAutopilotGoal(
  input: AutopilotRunnerInput,
  goal: string,
  inputId: string,
  options: {
    adapter?: OpenCodeAdapter;
    env?: NodeJS.ProcessEnv;
    resume?: (request: Parameters<AgentResumeClient["resume"]>[0]) => Promise<Record<string, unknown>>;
  } = {},
): Promise<AutopilotDeliveryResult> {
  const env = options.env ?? process.env;
  const base = {
    inputId,
    goal,
    sessionId: input.sessionId,
    harness: input.harness,
  };
  if (input.harness === "opencode") {
    const adapter = options.adapter
      ?? (env.OPENCODE_URL ? new OpenCodeAdapter({ baseUrl: env.OPENCODE_URL, password: env.OPENCODE_SERVER_PASSWORD }) : undefined);
    if (adapter) {
      try {
        const delivered = await adapter.sendMessage(input.sessionId, {
          message: goal,
          queue: true,
          origin: "automation",
          inputId,
        });
        if (delivered.ok) {
          return { status: "delivered", transport: "opencode-inbox", ...base };
        }
        const fallback = await deliverThroughResume(input, goal, inputId, options);
        return { ...fallback, error: `OpenCode inbox refused the goal (${delivered.error ?? "unknown"}); resumed through agent-resume` };
      } catch (error) {
        const fallback = await deliverThroughResume(input, goal, inputId, options);
        return { ...fallback, error: `OpenCode inbox delivery failed (${error instanceof Error ? error.message : String(error)}); resumed through agent-resume` };
      }
    }
  }
  return deliverThroughResume(input, goal, inputId, options);
}

async function deliverThroughResume(
  input: AutopilotRunnerInput,
  goal: string,
  inputId: string,
  options: { resume?: (request: Parameters<AgentResumeClient["resume"]>[0]) => Promise<Record<string, unknown>> } = {},
): Promise<AutopilotDeliveryResult> {
  const request = {
    target: { agent: input.harness as "codex", session_id: input.sessionId, cwd: resolve(input.cwd) },
    goal,
    prompt: goal,
    result_ref: `agent-herder://autopilot/stop/${inputId}`,
    idempotency_key: inputId,
  };
  try {
    const client = new AgentResumeClient();
    const receipt = await (options.resume ? options.resume(request) : client.resume(request)) as Record<string, unknown>;
    return {
      status: receipt?.status === "accepted" ? "accepted" : "failed",
      transport: "agent-resume",
      inputId,
      goal,
      sessionId: input.sessionId,
      harness: input.harness,
      receipt,
      ...(receipt?.status === "accepted" ? {} : { error: typeof receipt?.reason === "string" ? receipt.reason : "agent-resume rejected the continuation" }),
    };
  } catch (error) {
    return {
      status: "failed",
      transport: "agent-resume",
      inputId,
      goal,
      sessionId: input.sessionId,
      harness: input.harness,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}