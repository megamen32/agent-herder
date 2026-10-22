import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

import { directFleetPeers } from "../mesh/fleet-direct-transport.js";
import {
  AutomationDisarmStore,
  AUTOMATION_CANNOT_CHANGE_DISARM_REASON,
  type AutomationDisarmDocument,
  type AutomationDisarmSource,
} from "./state.js";

/** One owner decision, as it is carried to a fleet node. */
export interface FleetDisarmRequest {
  disarmed: boolean;
  workKeys: string[];
  reason?: string;
  /** The identity of one owner decision, so a node can tell decisions apart. */
  decisionId: string;
}

/**
 * The outcome of one fleet node.
 *
 * `confirmed` means the node holds the requested state on disk. `no_runtime`
 * means the node answered and has no herder runtime, so it cannot initiate a
 * launch at all and needs no copy of the state. `unreachable` means the state
 * of a node that may have a runtime is unknown. `declined` means the node
 * answered and holds a different state.
 */
export interface FleetDisarmNodeResult {
  hostId: string;
  status: "confirmed" | "no_runtime" | "unreachable" | "declined";
  /** Why the node is not confirmed. */
  reason?: string;
}

/** A node that blocks the fleet-wide success: its state is unknown or wrong. */
export function blocksFleetSuccess(node: FleetDisarmNodeResult): boolean {
  return node.status === "unreachable" || node.status === "declined";
}

/** The port that carries one owner decision to one fleet node. */
export interface FleetDisarmTransport {
  apply(nodeId: string, request: FleetDisarmRequest): Promise<{
    ok: boolean;
    state?: AutomationDisarmDocument;
    reason?: string;
    /**
     * The node answered and has no herder runtime, so it cannot initiate a
     * launch and needs no copy of the state.
     */
    noRuntime?: boolean;
  }>;
}

export interface SetAutomationDisarmRequest {
  /** The requested global lever position. */
  disarmed: boolean;
  /** Logical work keys to block in addition to the global lever. */
  workKeys?: string[];
  /** Owner-visible reason. */
  reason?: string;
  /** `fleet` also asks every other node to hold the same state. */
  scope?: "local" | "fleet";
  /** Only an explicit owner action may change the state. */
  source?: AutomationDisarmSource;
  /** The durable store of the local runtime. */
  store?: AutomationDisarmStore;
  /** The transport that reaches the other nodes. */
  transport?: FleetDisarmTransport;
  /** The nodes to ask; defaults to the configured direct fleet peers. */
  peers?: readonly string[];
}

export interface SetAutomationDisarmResult {
  /**
   * True only when every node of the fleet confirmed the state.
   *
   * A local success is never reported as fleet-wide success: the node list is
   * always present, and an unreachable node leaves this false.
   */
  ok: boolean;
  /** True when the local runtime holds the requested state. */
  applied: boolean;
  disarmed: boolean;
  state: AutomationDisarmDocument;
  /** The local node, which is always confirmed after a successful write. */
  localNode: { hostId: string; status: "confirmed" };
  /** Every node of the fleet: who confirmed and who did not. */
  nodes: FleetDisarmNodeResult[];
  /** True when every node confirmed the state. */
  complete: boolean;
  /** Why the operation did not complete. */
  reason?: string;
}

/**
 * The owner answer, in words.
 *
 * The answer says whether the lever was saved, how many nodes confirmed the
 * admission rule, and which node did not answer or declined. The count is
 * the number of nodes that confirmed, not the number of fleet nodes. The
 * executor side of the fleet is a different surface and is not claimed here.
 */
export function buildAutomationDisarmSummary(result: {
  applied: boolean;
  disarmed: boolean;
  nodes: readonly FleetDisarmNodeResult[];
}): string {
  const parts: string[] = [
    result.applied
      ? (result.disarmed ? "new launches forbidden (saved)" : "new launches allowed")
      : (result.disarmed ? "new launches forbidden (not saved)" : "new launches allowed (not saved)"),
  ];
  const confirmed = result.nodes.filter((node) => node.status === "confirmed").length;
  parts.push(result.disarmed
    ? `admission forbidden confirmed on ${confirmed} nodes`
    : `admission allowed confirmed on ${confirmed} nodes`);
  for (const node of result.nodes) {
    if (node.status === "unreachable") parts.push(`node ${node.hostId} did not answer — its state is unknown`);
    else if (node.status === "declined") parts.push(`node ${node.hostId} declined — its state differs`);
  }
  return parts.join("; ");
}

/** The fleet nodes the owner decision reaches by default. */
export function defaultFleetPeerIds(localHostId: string = hostname()): string[] {
  return directFleetPeers.map((peer) => peer.hostId).filter((hostId) => hostId !== localHostId);
}

/**
 * Move the owner-level automation lever and confirm it across the fleet.
 *
 * The local state is written durably first, so the local runtime is armed even
 * when the fleet is not reachable. Every other node is then asked to hold the
 * same state, and the answer always names the nodes that confirmed it and the
 * nodes that did not. The operation reports success only when every node
 * confirmed: a lever that is on one server is not a fleet-wide lever.
 */
export async function setAutomationDisarm(
  request: SetAutomationDisarmRequest,
): Promise<SetAutomationDisarmResult> {
  const store = request.store ?? AutomationDisarmStore.forRuntime();
  const source = request.source ?? "owner";
  const change = await store.apply({
    source,
    disarmed: request.disarmed,
    ...(request.reason ? { reason: request.reason } : {}),
    ...(request.workKeys === undefined ? {} : { workKeys: request.workKeys }),
  });
  if (!change.ok) {
    // An automatic attempt to move the lever changed nothing and says why.
    return {
      ok: false,
      applied: false,
      disarmed: change.state.disarmed,
      state: change.state,
      localNode: { hostId: hostname(), status: "confirmed" },
      nodes: [],
      complete: false,
      reason: change.reason,
    };
  }
  const state = change.state;
  const localNode: FleetDisarmNodeResult = { hostId: hostname(), status: "confirmed" };
  const nodes: FleetDisarmNodeResult[] = [localNode];
  if (request.scope === "fleet" && request.transport) {
    const peers = request.peers ?? defaultFleetPeerIds();
    const decision: FleetDisarmRequest = {
      disarmed: state.disarmed,
      workKeys: state.blockedWorkKeys,
      ...(state.reason ? { reason: state.reason } : {}),
      decisionId: randomUUID(),
    };
    const answers = await Promise.all(peers.map(async (peer) => {
      try {
        const answer = await request.transport!.apply(peer, decision);
        // A node without a herder runtime cannot start a launch, so the
        // single point of refusal is enough there. It is not a failure.
        if (answer.noRuntime) {
          return { hostId: peer, status: "no_runtime" as const, reason: answer.reason ?? "На ноде нет herder-рантайма: она не может инициировать запуск." };
        }
        if (!answer.ok) {
          return { hostId: peer, status: "declined" as const, reason: answer.reason ?? "Нода не подтвердила состояние." };
        }
        if (answer.state && answer.state.disarmed !== state.disarmed) {
          return { hostId: peer, status: "declined" as const, reason: "Нода подтвердила другое состояние." };
        }
        return { hostId: peer, status: "confirmed" as const };
      } catch (error) {
        // The node did not answer: whether it has a runtime is unknown, so the
        // state is unknown too and the fleet answer stays fail-closed.
        return { hostId: peer, status: "unreachable" as const, reason: (error as Error).message };
      }
    }));
    nodes.push(...answers);
  }
  // Success needs every node that can initiate a launch to have confirmed.
  // A node without a herder runtime cannot start one, so it never blocks the
  // answer. A node whose state is unknown, or that holds a different state,
  // always blocks it.
  const blocking = nodes.filter(blocksFleetSuccess);
  const withoutRuntime = nodes.filter((node) => node.status === "no_runtime");
  const complete = blocking.length === 0;
  return {
    ok: complete,
    applied: true,
    disarmed: state.disarmed,
    state,
    localNode: { hostId: localNode.hostId, status: "confirmed" },
    nodes,
    complete,
    ...(blocking.length
      ? { reason: `Состояние подтверждено не всеми нодами флота: ${blocking.map((node) => `${node.hostId} (${node.status}${node.reason ? `: ${node.reason}` : ""})`).join(", ")}` }
      : withoutRuntime.length
        ? { reason: `Ноды без herder-рантайма не могут инициировать запуск и не требуют копии состояния: ${withoutRuntime.map((node) => node.hostId).join(", ")}` }
        : {}),
  };
}

export { AUTOMATION_CANNOT_CHANGE_DISARM_REASON };
