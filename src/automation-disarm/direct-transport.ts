import { FleetDirectTransport } from "../mesh/fleet-direct-transport.js";
import type { FleetDisarmRequest, FleetDisarmTransport } from "./service.js";
import type { AutomationDisarmNodeState } from "./state.js";

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
  constructor(
    private readonly transport: FleetDirectTransport = new FleetDirectTransport(),
    /** The owner secret of this runtime, carried to the other nodes. */
    private readonly token: string | undefined = process.env.AGENT_HERDER_DISARM_TOKEN?.trim(),
  ) {}

  async apply(nodeId: string, request: FleetDisarmRequest): Promise<{
    ok: boolean;
    state?: AutomationDisarmNodeState;
    reason?: string;
    noRuntime?: boolean;
  }> {
    const target = `mcp:shell:${nodeId}:AgentHerder`;
    // A node that answers and runs no herder runtime cannot initiate a launch
    // at all, so the single point of refusal is enough there. A node that does
    // not answer throws, and its state stays unknown.
    const probe = await this.transport.probeRuntime(target);
    if (!probe.hasRuntime) {
      return {
        ok: false,
        noRuntime: true,
        reason: `На ноде нет herder-рантайма (${probe.reason ?? "ответа нет"}). Она не может инициировать запуск, поэтому запрет на ней не нужен.`,
      };
    }
    if (!probe.hasDisarmTool) {
      return {
        ok: false,
        reason: "На ноде herder-рантайм без инструмента automation_disarm: состояние этой ноды не подтверждено.",
      };
    }
    // The decision is carried with the owner secret of this runtime. A node
    // that does not hold the same secret refuses it, and the refusal is
    // reported instead of being taken for a confirmation.
    if (!this.token) throw new Error("AGENT_HERDER_DISARM_TOKEN is not configured here, so the owner decision cannot be carried to a fleet node.");
    const result = await this.transport.call(target, "automation_disarm", {
      disarmed: request.disarmed,
      workKeys: request.workKeys,
      ...(request.reason ? { reason: request.reason } : {}),
      decisionId: request.decisionId,
      source: "owner",
      token: this.token,
      // The records are the authority on the node: the flat mirrors travel
      // with them so that a node of the earlier format still reads the lever.
      ...(request.records ? { records: request.records } : {}),
    });
    const payload = readToolPayload(result);
    if (!payload) return { ok: false, reason: "Нода не вернула подтверждение состояния." };
    if (payload.ok !== true) {
      return { ok: false, reason: typeof payload.reason === "string" ? payload.reason : "Нода отклонила состояние." };
    }
    const state = payload.state;
    return {
      ok: true,
      ...(state && typeof state === "object" ? { state: state as AutomationDisarmNodeState } : {}),
    };
  }

  /**
   * Read the state of one node without changing it.
   *
   * The read carries the same owner secret as the decision, so the state of a
   * node is read by the same caller that may change it. A node that does not
   * answer throws, and its state stays unknown.
   */
  async read(nodeId: string): Promise<{
    ok: boolean;
    state?: AutomationDisarmNodeState;
    reason?: string;
    noRuntime?: boolean;
  }> {
    const target = `mcp:shell:${nodeId}:AgentHerder`;
    const probe = await this.transport.probeRuntime(target);
    if (!probe.hasRuntime) {
      return {
        ok: false,
        noRuntime: true,
        reason: `На ноде нет herder-рантайма (${probe.reason ?? "ответа нет"}). Она не может инициировать запуск, поэтому запрет на ней не нужен.`,
      };
    }
    if (!probe.hasDisarmTool) {
      return { ok: false, reason: "На ноде herder-рантайм без инструмента automation_disarm: состояние этой ноды не прочитано." };
    }
    if (!this.token) throw new Error("AGENT_HERDER_DISARM_TOKEN is not configured here, so the state of a fleet node cannot be read.");
    const result = await this.transport.call(target, "automation_disarm", {
      mode: "read",
      source: "owner",
      token: this.token,
    });
    const payload = readToolPayload(result);
    if (!payload) return { ok: false, reason: "Нода не вернула своё состояние." };
    if (payload.ok !== true) {
      return { ok: false, reason: typeof payload.reason === "string" ? payload.reason : "Нода не отдала своё состояние." };
    }
    const state = payload.state;
    return {
      ok: true,
      ...(state && typeof state === "object" ? { state: state as AutomationDisarmNodeState } : {}),
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
    const value = (item as Record<string, unknown>).text;
    if (typeof value !== "string") continue;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return undefined;
}
