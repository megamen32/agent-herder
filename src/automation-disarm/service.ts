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

/** The outcome of one fleet node. */
export interface FleetDisarmNodeResult {
  hostId: string;
  /** `confirmed` means the node holds the requested state on disk. */
  status: "confirmed" | "unreachable" | "declined";
  /** Why the node is not confirmed. */
  reason?: string;
}

/** The port that carries one owner decision to one fleet node. */
export interface FleetDisarmTransport {
  apply(nodeId: string, request: FleetDisarmRequest): Promise<{
    ok: boolean;
    state?: AutomationDisarmDocument;
    reason?: string;
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
        if (!answer.ok) {
          return { hostId: peer, status: "declined" as const, reason: answer.reason ?? "Нода не подтвердила состояние." };
        }
        if (answer.state && answer.state.disarmed !== state.disarmed) {
          return { hostId: peer, status: "declined" as const, reason: "Нода подтвердила другое состояние." };
        }
        return { hostId: peer, status: "confirmed" as const };
      } catch (error) {
        return { hostId: peer, status: "unreachable" as const, reason: (error as Error).message };
      }
    }));
    nodes.push(...answers);
  }
  const complete = nodes.every((node) => node.status === "confirmed");
  const unreachable = nodes.filter((node) => node.status !== "confirmed");
  return {
    ok: complete,
    applied: true,
    disarmed: state.disarmed,
    state,
    localNode: { hostId: localNode.hostId, status: "confirmed" },
    nodes,
    complete,
    ...(unreachable.length
      ? { reason: `Состояние подтверждено не всеми нодами флота: ${unreachable.map((node) => `${node.hostId} (${node.status}${node.reason ? `: ${node.reason}` : ""})`).join(", ")}` }
      : {}),
  };
}

export { AUTOMATION_CANNOT_CHANGE_DISARM_REASON };
