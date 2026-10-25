import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

import { fleetPeers } from "../mesh/fleet-direct-transport.js";
import {
  AutomationDisarmStore,
  AUTOMATION_CANNOT_CHANGE_DISARM_REASON,
  type AutomationDisarmDocument,
  type AutomationDisarmNodeState,
  type AutomationDisarmRecord,
  type AutomationDisarmSource,
} from "./state.js";
import { ALL_SCOPES } from "./scope.js";

/** One owner decision, as it is carried to a fleet node. */
export interface FleetDisarmRequest {
  /** The flat mirror of the catch-all record. */
  disarmed: boolean;
  /** The flat mirror of every work key the records name. */
  workKeys: string[];
  reason?: string;
  /** The identity of one owner decision, so a node can tell decisions apart. */
  decisionId: string;
  /** The records of the owner decision: the authority on every node. */
  records?: AutomationDisarmRecord[];
  /** The scope of the decision, when the decision is about one scope. */
  scope?: string;
  /** Whether the decision forbids the scope or permits it. */
  forbidden?: boolean;
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
    state?: AutomationDisarmNodeState;
    reason?: string;
    /**
     * The node answered and has no herder runtime, so it cannot initiate a
     * launch and needs no copy of the state.
     */
    noRuntime?: boolean;
  }>;
  /**
   * Read the state of one node without changing it.
   *
   * A transport that cannot read a node state simply does not offer this:
   * the state of that node stays unknown instead of being guessed.
   */
  read?(nodeId: string): Promise<{
    ok: boolean;
    state?: AutomationDisarmNodeState;
    reason?: string;
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
  /** The revision of the live launch policy at the moment of the change. */
  policyRevision?: string;
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

/** One owner decision about one scope. */
export interface SetAutomationDisarmRecordRequest {
  /** `"*"` or the absolute path of the project. */
  scope: string;
  /** True forbids the automatic launches of the scope, false permits them. */
  forbidden: boolean;
  /** The identity of the owner who made the decision. */
  owner?: string;
  /** Owner-visible reason. */
  reason?: string;
  /** The finer boundary inside the scope. */
  workKeys?: string[];
  /** Only an explicit owner action may change the state. */
  source?: AutomationDisarmSource;
  /** The durable store of the local runtime. */
  store?: AutomationDisarmStore;
  /** The transport that reaches the other nodes. */
  transport?: FleetDisarmTransport;
  /** The nodes to ask; defaults to the configured direct fleet peers. */
  peers?: readonly string[];
  /** `fleet` also asks every other node to hold the same state. */
  reach?: "local" | "fleet";
  /** The expected revision of the state; a mismatch changes nothing. */
  ifMatch?: string;
  /** The revision of the live launch policy at the moment of the decision. */
  policyRevision?: string;
}

export interface SetAutomationDisarmRecordResult {
  /** True only when every node of the fleet confirmed the state. */
  ok: boolean;
  /** True when the local runtime holds the requested state. */
  applied: boolean;
  /** The scope of the decision. */
  scope: string;
  /** Whether the scope is forbidden or permitted. */
  forbidden: boolean;
  state: AutomationDisarmDocument;
  localNode: { hostId: string; status: "confirmed" };
  /** Every node of the fleet: who confirmed and who did not. */
  nodes: FleetDisarmNodeResult[];
  /** True when every node confirmed the state. */
  complete: boolean;
  /** Why the operation did not complete. */
  reason?: string;
  /** Why the decision itself was refused. */
  code?: "automation_cannot_change_disarm" | "invalid_work_key" | "state_conflict" | "invalid_scope";
}

/**
 * The owner answer, in words.
 *
 * The answer says whether the lever was saved, how many nodes confirmed the
 * admission rule, and which node did not answer or declined. The count is the
 * number of nodes that confirmed, not the number of fleet nodes. The
 * executor side of the fleet is a different surface and is not claimed here.
 */
export function buildAutomationDisarmSummary(result: {
  applied: boolean;
  disarmed: boolean;
  nodes: readonly FleetDisarmNodeResult[];
  /** The scope of the decision, when the decision is about one scope. */
  scope?: string;
}): string {
  const parts: string[] = [
    result.applied
      ? (result.disarmed ? "new launches forbidden (saved)" : "new launches allowed")
      : (result.disarmed ? "new launches forbidden (not saved)" : "new launches allowed (not saved)"),
  ];
  if (result.scope && result.scope !== ALL_SCOPES) parts.push(`scope ${result.scope}`);
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

/**
 * The answer of a read, in words.
 *
 * A read says what the state holds and which nodes hold the same state. It
 * never claims a fleet-wide success: a node that did not answer is named.
 */
export function buildAutomationDisarmStateSummary(result: {
  records: readonly AutomationDisarmRecord[];
  nodes: readonly FleetDisarmNodeResult[];
}): string {
  const forbidden = result.records.filter((record) => record.forbidden).length;
  const parts = [
    `the owner state holds ${result.records.length} records, ${forbidden} forbidden`,
  ];
  const confirmed = result.nodes.filter((node) => node.status === "confirmed").length;
  parts.push(`state confirmed on ${confirmed} nodes`);
  for (const node of result.nodes) {
    if (node.status === "unreachable") parts.push(`node ${node.hostId} did not answer — its state is unknown`);
    else if (node.status === "declined") parts.push(`node ${node.hostId} declined — its state differs`);
  }
  return parts.join("; ");
}

/** The fleet nodes the owner decision reaches by default. */
export function defaultFleetPeerIds(localHostId: string = hostname()): string[] {
  return fleetPeers().map((peer) => peer.hostId).filter((hostId) => hostId !== localHostId);
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
    ...(request.policyRevision ? { policyRevision: request.policyRevision } : {}),
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
      records: state.records,
    };
    nodes.push(...await confirmOnPeers(request.transport, peers, decision, state));
  }
  return fleetResult(state, nodes, request.disarmed);
}

/**
 * Move the lever of one scope and confirm it across the fleet.
 *
 * The decision is an upsert of one record, so the scope that the owner names
 * is replaced by the decision and every other scope keeps its own record. A
 * scope that the owner permits explicitly is permitted from then on, and only
 * another explicit owner action changes it again.
 */
export async function setAutomationDisarmRecord(
  request: SetAutomationDisarmRecordRequest,
): Promise<SetAutomationDisarmRecordResult> {
  const store = request.store ?? AutomationDisarmStore.forRuntime();
  const source = request.source ?? "owner";
  const change = await store.applyRecord({
    source,
    scope: request.scope,
    forbidden: request.forbidden,
    ...(request.owner ? { owner: request.owner } : {}),
    ...(request.reason ? { reason: request.reason } : {}),
    ...(request.workKeys === undefined ? {} : { workKeys: request.workKeys }),
    ...(request.policyRevision ? { policyRevision: request.policyRevision } : {}),
    ...(request.ifMatch === undefined ? {} : { ifMatch: request.ifMatch }),
  });
  if (!change.ok) {
    return {
      ok: false,
      applied: false,
      scope: request.scope,
      forbidden: request.forbidden,
      state: change.state,
      localNode: { hostId: hostname(), status: "confirmed" },
      nodes: [],
      complete: false,
      reason: change.reason,
      code: change.code,
    };
  }
  const state = change.state;
  const localNode: FleetDisarmNodeResult = { hostId: hostname(), status: "confirmed" };
  const nodes: FleetDisarmNodeResult[] = [localNode];
  if (request.reach === "fleet" && request.transport) {
    const peers = request.peers ?? defaultFleetPeerIds();
    const decision: FleetDisarmRequest = {
      disarmed: state.disarmed,
      workKeys: state.blockedWorkKeys,
      ...(state.reason ? { reason: state.reason } : {}),
      decisionId: randomUUID(),
      records: state.records,
      scope: request.scope,
      forbidden: request.forbidden,
    };
    nodes.push(...await confirmOnPeers(request.transport, peers, decision, state));
  }
  const result = fleetResult(state, nodes, request.forbidden);
  return {
    ok: result.ok,
    applied: result.applied,
    scope: request.scope,
    forbidden: request.forbidden,
    state: result.state,
    localNode: result.localNode,
    nodes: result.nodes,
    complete: result.complete,
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

/**
 * Read the state of every fleet node.
 *
 * A node that answers and holds the same records is confirmed, a node that
 * holds other records declined, and a node that does not answer is
 * unreachable: its state stays unknown instead of being assumed.
 */
export async function readFleetDisarmState(request: {
  transport?: FleetDisarmTransport;
  peers?: readonly string[];
  state: AutomationDisarmDocument;
}): Promise<FleetDisarmNodeResult[]> {
  const nodes: FleetDisarmNodeResult[] = [{ hostId: hostname(), status: "confirmed" }];
  const transport = request.transport;
  if (!transport) return nodes;
  const peers = request.peers ?? defaultFleetPeerIds();
  const answers = await Promise.all(peers.map(async (peer) => {
    if (!transport.read) {
      return { hostId: peer, status: "unreachable" as const, reason: "Нода не ответила: транспорт не умеет читать состояние ноды." };
    }
    try {
      const answer = await transport.read(peer);
      if (answer.noRuntime) {
        return { hostId: peer, status: "no_runtime" as const, reason: answer.reason ?? "На ноде нет herder-рантайма: она не может инициировать запуск." };
      }
      if (!answer.ok) {
        return { hostId: peer, status: "declined" as const, reason: answer.reason ?? "Нода не подтвердила состояние." };
      }
      if (!answer.state || !sameRecords(answer.state.records, request.state.records)) {
        return { hostId: peer, status: "declined" as const, reason: "Нода подтвердила другое состояние." };
      }
      return { hostId: peer, status: "confirmed" as const };
    } catch (error) {
      return { hostId: peer, status: "unreachable" as const, reason: (error as Error).message };
    }
  }));
  nodes.push(...answers);
  return nodes;
}

/** Ask every peer to hold the same records, and name who confirmed it. */
async function confirmOnPeers(
  transport: FleetDisarmTransport,
  peers: readonly string[],
  decision: FleetDisarmRequest,
  state: AutomationDisarmDocument,
): Promise<FleetDisarmNodeResult[]> {
  const answers = await Promise.all(peers.map(async (peer) => {
    try {
      const answer = await transport.apply(peer, decision);
      // A node without a herder runtime cannot start a launch, so the
      // single point of refusal is enough there. It is not a failure.
      if (answer.noRuntime) {
        return { hostId: peer, status: "no_runtime" as const, reason: answer.reason ?? "На ноде нет herder-рантайма: она не может инициировать запуск." };
      }
      if (!answer.ok) {
        return { hostId: peer, status: "declined" as const, reason: answer.reason ?? "Нода не подтвердила состояние." };
      }
      if (answer.state && !sameState(answer.state, state)) {
        return { hostId: peer, status: "declined" as const, reason: "Нода подтвердила другое состояние." };
      }
      return { hostId: peer, status: "confirmed" as const };
    } catch (error) {
      // The node did not answer: whether it has a runtime is unknown, so the
      // state is unknown too and the fleet answer stays fail-closed.
      return { hostId: peer, status: "unreachable" as const, reason: (error as Error).message };
    }
  }));
  return answers;
}

/**
 * Does one node hold the same records as this runtime?
 *
 * A node that answers without records knows only the earlier flat format,
 * so its flat mirror decides. A node that reports records is compared by the
 * records themselves.
 */
function sameState(answer: AutomationDisarmNodeState, state: AutomationDisarmDocument): boolean {
  if (answer.records?.length || state.records.length) {
    if (!answer.records) return answer.disarmed === state.disarmed;
    return sameRecords(answer.records, state.records);
  }
  return answer.disarmed === state.disarmed;
}

/** Do two record sets describe the same decision? */
function sameRecords(
  left: readonly AutomationDisarmRecord[] | undefined,
  right: readonly AutomationDisarmRecord[],
): boolean {
  if (!left) return false;
  const shape = (record: AutomationDisarmRecord) => JSON.stringify({
    scope: record.scope,
    forbidden: record.forbidden,
    workKeys: [...(record.workKeys ?? [])].sort(),
  });
  const leftShape = left.map(shape).sort();
  const rightShape = right.map(shape).sort();
  return leftShape.length === rightShape.length
    && leftShape.every((value, index) => value === rightShape[index]);
}

/** The fleet answer of one state. */
function fleetResult(
  state: AutomationDisarmDocument,
  nodes: FleetDisarmNodeResult[],
  forbidden: boolean,
): SetAutomationDisarmResult {
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
    disarmed: forbidden,
    state,
    localNode: { hostId: nodes[0]?.hostId ?? hostname(), status: "confirmed" },
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
