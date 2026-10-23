/**
 * The service of the common settings: the owner reads it and the nodes take it.
 *
 * The owner of the document asks every node what it holds and names the state
 * of each one in the words of the owner: confirmed, diverged, unknown. A node
 * that did not answer is unknown, and unknown is never agreement.
 *
 * A node takes the document by itself: it pulls it from the owner over the
 * transport of the fleet and applies it. A node that was off catches up when it
 * comes back, without anybody doing anything by hand.
 */

import { computeConfirmationState, type SettingsConfirmationNode } from "../web/settings-fleet-confirmation.js";
import type { SettingsApplyState } from "../web/settings-catalog.js";
import {
  applyCommonSettingsDocument,
  restoreCommonSettingsLocalValues,
  type CommonSettingsApplyResult,
  type CommonSettingsLaunchPolicyTarget,
  type CommonSettingsTarget,
} from "./apply.js";
import type { CommonSettingsDocument, CommonSettingsHooksLever } from "./document.js";
import type { CommonSettingsConflict, CommonSettingsNodeState, CommonSettingsRole } from "./node-state.js";
import type { CommonSettingsTransport } from "./transport.js";

/** The environment variable that names the node that owns the document. */
export const COMMON_SETTINGS_OWNER_ENV = "AGENT_HERDER_COMMON_SETTINGS_OWNER";

/** The interval between two rounds of taking the document, in milliseconds. */
export const COMMON_SETTINGS_SYNC_INTERVAL_MS = 30_000;

/** One node of the fleet, as the owner reads it. */
export interface CommonSettingsNodeView {
  /** The name of the node. */
  hostId: string;
  /** Whether the node takes the common settings. */
  optIn: boolean;
  /** The state of the node: it confirmed, it diverged, or it is unknown. */
  status: "подтвердил" | "расходится" | "не подтвердил";
  /** The revision the node holds. */
  appliedRevision: string | null;
  /** When the node confirmed. */
  confirmedAt: string | null;
  /** Why the node did not confirm, in words. */
  reason: string | null;
  /** The deviations the node holds. */
  conflicts: CommonSettingsConflict[];
}

/** The fleet of the common settings, as the owner reads it. */
export interface CommonSettingsFleetView {
  /** The nodes that take the common settings. */
  nodes: CommonSettingsNodeView[];
  /** The nodes that did not take the common settings. */
  notParticipating: string[];
  /** The state of the application in the fleet. */
  state: SettingsApplyState;
  /** How many nodes hold the wanted revision. */
  confirmed: number;
  /** How many nodes take the common settings. */
  total: number;
  /** The nodes that did not confirm, by name. */
  unconfirmed: string[];
  /** Whether a round of asking was made. */
  attempted: boolean;
}

/**
 * The state of the fleet of the common settings.
 *
 * Every node is asked what it holds. A node that holds the wanted revision
 * confirmed. A node that holds another one diverged, and both revisions are
 * named. A node that did not answer did not confirm, and its state stays
 * unknown — it is never counted as synchronized.
 *
 * When the nodes are asked to take the document, the node that holds another
 * revision is told that the document moved: it takes the document and applies
 * it by itself.
 */
export async function readCommonSettingsFleet(input: {
  transport: CommonSettingsTransport;
  /** The peers of the fleet: the node and the address of its runtime. */
  peers: readonly { hostId: string; target: string }[];
  /** The revision the owner wants. */
  revision: string | null;
  /** Whether the nodes are asked to take the document now. */
  distribute?: boolean;
  now?: () => Date;
}): Promise<CommonSettingsFleetView> {
  const now = input.now ?? (() => new Date());
  const nodes: CommonSettingsNodeView[] = [];
  const notParticipating: string[] = [];

  await Promise.all(input.peers.map(async (peer) => {
    let status: Awaited<ReturnType<CommonSettingsTransport["status"]>> = null;
    let reason: string | null = null;
    try {
      status = await input.transport.status(peer.target);
      if (!status) reason = "Нода не отдала своё состояние.";
    } catch (error) {
      reason = (error as Error).message;
    }
    if (status && !status.optIn) {
      notParticipating.push(peer.hostId);
      return;
    }
    if (status && input.distribute && input.revision && status.appliedRevision !== input.revision) {
      // The document moved: the node takes it and applies it by itself. The
      // answer of the node is its state after the application.
      try {
        const applied = await input.transport.notify(peer.target, input.revision);
        if (applied) status = applied;
        else reason = "Нода не подтвердила применение документа.";
      } catch (error) {
        reason = (error as Error).message;
      }
    }
    const appliedRevision = status?.appliedRevision ?? null;
    const confirmedAt = status?.appliedAt ?? null;
    const holds = appliedRevision !== null && appliedRevision === input.revision;
    const view: CommonSettingsNodeView = {
      hostId: peer.hostId,
      optIn: status?.optIn ?? false,
      status: !status
        ? "не подтвердил"
        : holds
          ? "подтвердил"
          : appliedRevision === null
            ? "не подтвердил"
            : "расходится",
      appliedRevision,
      confirmedAt,
      reason: reason ?? (holds ? null : status?.appliedRevision === null
        ? "Нода не назвала ревизию, которую она держит."
        : `Нода держит другую ревизию (${appliedRevision}).`),
      conflicts: status?.conflicts ?? [],
    };
    nodes.push(view);
  }));

  nodes.sort((left, right) => (left.hostId < right.hostId ? -1 : left.hostId > right.hostId ? 1 : 0));
  notParticipating.sort();
  const confirmationNodes: SettingsConfirmationNode[] = nodes.map((node) => ({
    hostId: node.hostId,
    status: node.status,
    appliedRevision: node.appliedRevision,
    confirmedAt: node.confirmedAt,
    reason: node.reason,
  }));
  const summary = computeConfirmationState(confirmationNodes, true);
  return {
    nodes,
    notParticipating,
    state: summary.state,
    confirmed: summary.confirmed,
    total: summary.total,
    unconfirmed: summary.unconfirmed,
    attempted: true,
  };
}

/**
 * The node takes the document of the owner.
 *
 * The node pulls the document over the transport of the fleet and applies it.
 * A node that holds the wanted revision does nothing: the round of taking is
 * cheap and it leaves no trace when nothing moved.
 *
 * The document travels with the identity of the owner: its revision and the
 * time of its assembly. The node therefore keeps the revision of the owner it
 * took and never a revision of its own files.
 */
export async function catchUpCommonSettings(input: {
  transport: CommonSettingsTransport;
  /** The address of the node that owns the document. */
  ownerTarget: string;
  /** The settings of this node. */
  target: CommonSettingsTarget;
  /** The policy of the launch of this node. */
  launchPolicy?: CommonSettingsLaunchPolicyTarget;
  /** The lever of the prohibitions of the hooks of this node. */
  hooks?: CommonSettingsHooksLever;
  /** The state of this node. */
  state: CommonSettingsNodeState;
  /** The name of this node. */
  hostId: string;
  now?: () => Date;
}): Promise<CommonSettingsApplyResult> {
  let document: CommonSettingsDocument | null = null;
  try {
    document = await input.transport.read(input.ownerTarget);
  } catch (error) {
    return {
      ok: false,
      hostId: input.hostId,
      appliedRevision: input.state.appliedRevision,
      appliedAt: input.state.appliedAt,
      changed: [],
      conflicts: input.state.conflicts,
      reason: `Узел-владелец не ответил: ${(error as Error).message}`,
    };
  }
  if (!document) {
    return {
      ok: false,
      hostId: input.hostId,
      appliedRevision: input.state.appliedRevision,
      appliedAt: input.state.appliedAt,
      changed: [],
      conflicts: input.state.conflicts,
      reason: "Узел-владелец не отдал общий документ настроек.",
    };
  }
  if (document.revision === input.state.appliedRevision) {
    return {
      ok: true,
      hostId: input.hostId,
      appliedRevision: input.state.appliedRevision,
      appliedAt: input.state.appliedAt,
      changed: [],
      conflicts: input.state.conflicts,
    };
  }
  return await applyCommonSettingsDocument({
    document,
    target: input.target,
    ...(input.launchPolicy ? { launchPolicy: input.launchPolicy } : {}),
    ...(input.hooks ? { hooks: input.hooks } : {}),
    state: input.state,
    hostId: input.hostId,
    ...(input.now ? { now: input.now } : {}),
  });
}

/**
 * The local values of the node are put back.
 *
 * The values that the common document replaced are kept on the node, and the
 * owner of the node can put them back. The common value wins again at the
 * next round: the policy is the same on every node.
 */
export async function restoreLocalCommonSettings(input: {
  target: CommonSettingsTarget;
  state: CommonSettingsNodeState;
  hostId: string;
  now?: () => Date;
}): Promise<CommonSettingsApplyResult> {
  return await restoreCommonSettingsLocalValues(input);
}

/**
 * The configuration of the common settings of this node.
 *
 * The owner of the document is named by the environment: the node that names
 * itself is the owner of the document, and any other node is a member that
 * takes the document of the owner.
 */
export function readCommonSettingsConfig(
  env: NodeJS.ProcessEnv = process.env,
  localHostId: string = "",
): { ownerHostId: string | null; role: CommonSettingsRole } {
  const ownerHostId = env[COMMON_SETTINGS_OWNER_ENV]?.trim() || null;
  if (!ownerHostId) return { ownerHostId: null, role: "none" };
  if (localHostId && ownerHostId === localHostId) return { ownerHostId, role: "owner" };
  return { ownerHostId, role: "member" };
}
