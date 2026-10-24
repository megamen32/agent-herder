/**
 * The confirmation of the fleet: what every node did with the change.
 *
 * The owner changes one thing and wants to know what the fleet made of it:
 * which node holds the wanted revision, which node did not answer, and when
 * the last confirmation happened. The answer is the applied revision of the
 * policy of the launch: every node is asked what it holds, and the last
 * confirmation of every node is kept in the ledger beside the policy.
 *
 * A node that did not answer is unknown, and unknown is never agreement.
 */

import { readFile } from "node:fs/promises";
import { hostname } from "node:os";

import { resolveAutopilotStateDir } from "../autopilot/state-dir.js";
import { FleetDirectTransport, fleetPeers } from "../mesh/fleet-direct-transport.js";
import {
  fleetPolicyRevisionLedgerPath,
  readFleetPolicyRevisions,
  type FleetPolicyRevisionPeer,
  type FleetPolicyRevisionSummary,
  type FleetPolicyRevisionTransport,
} from "../mesh/fleet-policy-revision.js";

import type { SettingsApplyState } from "./settings-catalog.js";

/** The state of one node of the fleet, in the words of the owner. */
export type SettingsConfirmationStatus = "подтвердил" | "не подтвердил" | "расходится";

/** One node of the fleet, as the owner reads it. */
export interface SettingsConfirmationNode {
  /** The name of the node. */
  hostId: string;
  /** What the node said about the version it holds. */
  status: SettingsConfirmationStatus;
  /** The revision the node holds, when it named one. */
  appliedRevision: string | null;
  /** When the node confirmed the last time. */
  confirmedAt: string | null;
  /** Why the node did not confirm, in words. */
  reason: string | null;
}

/** The confirmation of the fleet, as the owner reads it. */
export interface SettingsFleetConfirmation {
  ok: boolean;
  /** The revision the owner wants. */
  desiredRevision: string | null;
  /** The state of the application in the fleet. */
  state: SettingsApplyState;
  /** How many nodes hold the wanted revision. */
  confirmed: number;
  /** How many nodes the fleet has. */
  total: number;
  /** The nodes that did not confirm, by name. */
  unconfirmed: string[];
  /** The nodes of the fleet, one by one. */
  nodes: SettingsConfirmationNode[];
  /** Where the data comes from. */
  source: "живой опрос флота" | "последнее известное подтверждение";
  /** When the data was read. */
  checkedAt: string;
  /** Why the data could not be read live, when it could not. */
  error?: string;
}

/** The numbers of the application: how many nodes and what state. */
export interface SettingsConfirmationSummary {
  state: SettingsApplyState;
  confirmed: number;
  total: number;
  unconfirmed: string[];
}

/**
 * The state of the application, from the answer of the nodes.
 *
 * Every node confirmed — «Применено». Some confirmed and some did not —
 * «Применено частично», and the names of the others are named. Nobody
 * confirmed after a round of asking — «Узел недоступен»: the nodes did not
 * answer at all. Nobody confirmed and no round was made — «Применяется»: the
 * change waits for its confirmation.
 */
export function computeConfirmationState(
  nodes: readonly SettingsConfirmationNode[],
  attempted: boolean,
): SettingsConfirmationSummary {
  const total = nodes.length;
  const confirmed = nodes.filter((node) => node.status === "подтвердил").length;
  const unconfirmed = nodes.filter((node) => node.status !== "подтвердил").map((node) => node.hostId);
  if (total === 0) return { state: "Записано", confirmed: 0, total: 0, unconfirmed: [] };
  if (confirmed === total) return { state: "Применено", confirmed, total, unconfirmed };
  if (confirmed > 0) return { state: "Применено частично", confirmed, total, unconfirmed };
  return { state: attempted ? "Узел недоступен" : "Применяется", confirmed, total, unconfirmed };
}

/** The last confirmation of every node, as the ledger keeps it. */
export interface SettingsConfirmationLedger {
  [hostId: string]: { appliedRevision: string; at: string };
}

/**
 * The last confirmation of every node, as the file keeps it.
 *
 * A ledger that cannot be read is an empty ledger: a node that did not
 * answer is unknown, and unknown is not agreement.
 */
export async function readConfirmationLedger(path: string): Promise<SettingsConfirmationLedger> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const entries: SettingsConfirmationLedger = {};
    for (const [hostId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as { appliedRevision?: unknown; at?: unknown };
      if (typeof entry.appliedRevision === "string" && typeof entry.at === "string") {
        entries[hostId] = { appliedRevision: entry.appliedRevision, at: entry.at };
      }
    }
    return entries;
  } catch {
    return {};
  }
}

/**
 * The nodes of the fleet, in the words of the owner.
 *
 * A node that holds the wanted revision confirmed. A node that holds another
 * revision diverged, and the versions are named. A node that did not answer
 * did not confirm, and the last confirmation that is known stays with its
 * time.
 */
export function toConfirmationNodes(
  summary: FleetPolicyRevisionSummary,
  ledger: SettingsConfirmationLedger,
  options: { localHostId?: string; checkedAt?: string } = {},
): SettingsConfirmationNode[] {
  return summary.nodes.map((node) => {
    const known = ledger[node.hostId];
    const status: SettingsConfirmationStatus = node.status === "synchronized"
      ? "подтвердил"
      : node.status === "diverged"
        ? "расходится"
        : "не подтвердил";
    const confirmedAt = node.hostId === options.localHostId
      ? options.checkedAt ?? known?.at ?? null
      : known?.at ?? node.lastKnown?.at ?? null;
    return {
      hostId: node.hostId,
      status,
      appliedRevision: node.appliedRevision ?? node.lastKnown?.appliedRevision ?? known?.appliedRevision ?? null,
      confirmedAt,
      reason: node.reason ?? null,
    };
  });
}

/** The nodes of the last confirmation, when no round of asking was made. */
function ledgerNodes(ledger: SettingsConfirmationLedger): SettingsConfirmationNode[] {
  return Object.entries(ledger).map(([hostId, entry]) => ({
    hostId,
    status: "не подтвердил" as const,
    appliedRevision: entry.appliedRevision,
    confirmedAt: entry.at,
    reason: "Версия, которую держит эта нода, сейчас неизвестна: последнее подтверждение известно только по журналу.",
  }));
}

/** The peers of the fleet, as the confirmation asks them. */
export function defaultFleetConfirmationPeers(localHostId?: string): FleetPolicyRevisionPeer[] {
  return fleetPeers()
    .filter((peer) => peer.hostId !== "MacBook-Pro-User.local")
    .filter((peer) => peer.hostId !== localHostId)
    .map((peer) => ({ hostId: peer.hostId, target: `mcp:shell:${peer.hostId}:AgentHerder` }));
}

/** The transport to the other nodes, as the confirmation asks them. */
function defaultFleetConfirmationTransport(localHostId?: string): FleetPolicyRevisionTransport {
  return new FleetDirectTransport(fleetPeers().filter((peer) => (
    peer.hostId !== "MacBook-Pro-User.local" && peer.hostId !== localHostId
  )));
}

/** What the reader of the confirmation needs to know. */
export interface ReadFleetConfirmationOptions {
  /** The revision the local node holds: it is the version the owner wants. */
  desiredRevision: string | null;
  /** The state of the local document of the policy. */
  localKind?: "valid" | "absent" | "invalid";
  /** The name of this node. */
  hostId?: string;
  /** The state directory of the runtime: the ledger lies beside the policy. */
  stateDir?: string;
  /** The transport to the other nodes; the real one by default. */
  transport?: FleetPolicyRevisionTransport;
  /** The peers of the fleet; the real ones by default. */
  peers?: readonly FleetPolicyRevisionPeer[];
  /** The clock. */
  now?: () => Date;
}

/**
 * The confirmation of the fleet, as the owner reads it.
 *
 * The nodes are asked what they hold, and the last confirmation of every node
 * is kept in the ledger beside the policy, so an answer that fails still
 * leaves a trace. The local node is the version the owner wants: the policy
 * lives in the file of this node, and every other node is compared with it.
 */
export async function readFleetConfirmation(
  options: ReadFleetConfirmationOptions,
): Promise<SettingsFleetConfirmation> {
  const now = options.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const hostId = options.hostId ?? hostname();
  const stateDir = options.stateDir ?? resolveAutopilotStateDir(process.env);
  const ledgerPath = fleetPolicyRevisionLedgerPath(stateDir);
  const desiredRevision = options.desiredRevision;

  if (!desiredRevision) {
    // Without a version of the owner there is nothing to compare with: the
    // last confirmation that is known is named, and nothing is claimed.
    const ledger = await readConfirmationLedger(ledgerPath);
    const nodes = ledgerNodes(ledger);
    return {
      ok: false,
      desiredRevision: null,
      ...computeConfirmationState(nodes, false),
      nodes,
      source: "последнее известное подтверждение",
      checkedAt,
      error: "Политика запуска на этой ноде недоступна: сверять версии нечего.",
    };
  }

  const peers = options.peers ?? defaultFleetConfirmationPeers(hostId);
  const transport = options.transport ?? defaultFleetConfirmationTransport(hostId);
  let summary: FleetPolicyRevisionSummary | null = null;
  let error: string | undefined;
  try {
    summary = await readFleetPolicyRevisions({
      transport,
      peers,
      desiredRevision,
      local: { hostId, answer: { kind: options.localKind ?? "valid", appliedRevision: desiredRevision } },
      ledgerPath,
      now,
    });
  } catch (failure) {
    error = (failure as Error).message;
  }

  // The poll writes the fresh confirmations into the ledger, so the ledger is
  // read after it: the times of the confirmation are the times of this round.
  const ledger = await readConfirmationLedger(ledgerPath);
  const nodes = summary
    ? toConfirmationNodes(summary, ledger, { localHostId: hostId, checkedAt })
    : ledgerNodes(ledger);
  return {
    ok: summary !== null,
    desiredRevision,
    ...computeConfirmationState(nodes, summary !== null),
    nodes,
    source: summary ? "живой опрос флота" : "последнее известное подтверждение",
    checkedAt,
    ...(error ? { error } : {}),
  };
}
