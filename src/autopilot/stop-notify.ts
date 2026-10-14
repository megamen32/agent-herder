import { createHash } from "node:crypto";
import type { AutopilotRunnerInput } from "../autopilot-runner.js";

/** Fast notification only: never evaluates a model or waits for a native turn. */
export async function notifyAutopilotStop(input: AutopilotRunnerInput): Promise<Record<string, unknown>> {
  const turnId = input.turnId || `stop-${createHash("sha256").update(JSON.stringify([input.sessionId, input.lastAssistantMessage, input.transcriptPath])).digest("hex")}`;
  try {
    const response = await fetch(`${process.env.AGENT_HERDER_URL || "http://127.0.0.1:18787"}/api/autopilot/stop`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(1200),
      body: JSON.stringify({ ...input, command: "stop", turnId }),
    });
    if (!response.ok) return { ok: false, decision: "unavailable", httpStatus: response.status };
    return { ok: true, decision: "queued", ...await response.json() as object };
  } catch { return { ok: false, decision: "unavailable" }; }
}
