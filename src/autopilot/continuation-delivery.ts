import { resolve } from "node:path";
import { OpenCodeAdapter } from "../adapters/opencode.js";
import { normalizeSendAdmission } from "../adapters/quota-failure.js";
import { AgentResumeClient } from "../resume-transport.js";
import type { AutopilotRunnerInput } from "../autopilot-runner.js";

export interface AutopilotDeliveryResult {
  status: "delivered" | "accepted" | "failed";
  transport: "opencode-inbox" | "agent-resume";
  inputId: string;
  goal: string;
  sessionId: string;
  harness: string;
  /** Exact native admission evidence or durable fallback transport receipt. */
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
 * durable agent-resume transport. OpenCode may fall back only after proof that
 * no input was admitted; unknown native outcomes require read-only reconciliation.
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
        const delivered = normalizeSendAdmission(await adapter.sendMessage(input.sessionId, {
          message: goal,
          queue: true,
          origin: "automation",
          inputId,
        }));
        if (delivered.admission === "accepted" || delivered.admission === "pending") {
          return { status: delivered.ok ? "delivered" : "accepted", transport: "opencode-inbox",
            ...base, receipt: { ...delivered } };
        }
        if (delivered.admission !== "not_submitted") {
          return { status: "failed", transport: "opencode-inbox", ...base, receipt: { ...delivered },
            error: `OpenCode native admission is unknown; reconcile before retry (${delivered.error ?? "receipt unavailable"})` };
        }
        const fallback = await deliverThroughResume(input, goal, inputId, options);
        return { ...fallback, error: `OpenCode proves no admission (${delivered.error ?? "not submitted"}); fallback transport returned ${fallback.status}` };
      } catch (error) {
        return { status: "failed", transport: "opencode-inbox", ...base,
          receipt: { admission: "unknown", admissionUnknown: true },
          error: `OpenCode native admission is unknown; reconcile before retry (${error instanceof Error ? error.message : String(error)})` };
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