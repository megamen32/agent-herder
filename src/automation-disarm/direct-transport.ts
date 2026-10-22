import { FleetDirectTransport } from "../mesh/fleet-direct-transport.js";
import type { FleetDisarmRequest, FleetDisarmTransport } from "./service.js";
import type { AutomationDisarmDocument } from "./state.js";

/**
 * Carries one owner decision to another fleet node over the existing direct
 * fleet transport.
 *
 * The transport reaches a node over owner-authorized SSH and calls one MCP
 * tool there, so the decision only lands on a node whose native owner
 * identity was verified. An unreachable node raises, and the caller records it
 * as unconfirmed rather than pretending the fleet agreed.
 */
export class DirectFleetDisarmTransport implements FleetDisarmTransport {
  constructor(private readonly transport: FleetDirectTransport = new FleetDirectTransport()) {}

  async apply(nodeId: string, request: FleetDisarmRequest): Promise<{
    ok: boolean;
    state?: AutomationDisarmDocument;
    reason?: string;
  }> {
    const result = await this.transport.call(`mcp:shell:${nodeId}:AgentHerder`, "automation_disarm", {
      disarmed: request.disarmed,
      workKeys: request.workKeys,
      ...(request.reason ? { reason: request.reason } : {}),
      decisionId: request.decisionId,
    });
    const payload = readToolPayload(result);
    if (!payload) return { ok: false, reason: "Нода не вернула подтверждение состояния." };
    if (payload.ok !== true) {
      return { ok: false, reason: typeof payload.reason === "string" ? payload.reason : "Нода отклонила состояние." };
    }
    const state = payload.state;
    return {
      ok: true,
      ...(state && typeof state === "object" ? { state: state as AutomationDisarmDocument } : {}),
    };
  }
}

/** Read the payload of one MCP tool result, from its structured or text form. */
function readToolPayload(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, unknown>;
  if (record.structuredContent && typeof record.structuredContent === "object") {
    return record.structuredContent as Record<string, unknown>;
  }
  const content = record.content;
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const text = (item as Record<string, unknown>).text;
    if (typeof text !== "string") continue;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return undefined;
}
