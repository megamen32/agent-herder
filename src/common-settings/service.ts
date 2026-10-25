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
import {
  redactCommonSettingsConflicts,
  type CommonSettingsConflictView,
  type CommonSettingsNodeState,
  type CommonSettingsNodeStatus,
  type CommonSettingsRole,
} from "./node-state.js";
import {
  COMMON_SETTINGS_PEER_BUDGET_MS,
  COMMON_SETTINGS_PEER_FRESH_TTL_MS,
  unansweredPeerEntry,
  type CommonSettingsPeerCache,
  type CommonSettingsPeerEntry,
} from "./peer-status-cache.js";
import type { CommonSettingsTransport } from "./transport.js";

/** The environment variable that names the node that owns the document. */
export const COMMON_SETTINGS_OWNER_ENV = "AGENT_HERDER_COMMON_SETTINGS_OWNER";

/** The interval between two rounds of taking the document, in milliseconds. */
export const COMMON_SETTINGS_SYNC_INTERVAL_MS = 30_000;

/**
 * What the owner knows about one node of the fleet.
 *
 * Four facts and not two: a node that holds the wanted revision applied it, a
 * node that holds another one diverged, a node that answered and applied
 * nothing has not applied it yet, and a node that did not answer is
 * unreachable — nothing at all is known about it.
 */
export type CommonSettingsNodeFact = "применена" | "расходится" | "не применена" | "недоступна";

/** One node of the fleet, as the owner reads it. */
export interface CommonSettingsNodeView {
  /** The name of the node. */
  hostId: string;
  /**
   * Whether the node takes the common settings.
   *
   * `null` — the node did not answer, and nothing is known about it. An
   * unknown fact is never written as `false`: a node that did not answer is not
   * a node that refuses the common settings.
   */
  optIn: boolean | null;
  /** Whether the node answered the round of asking. */
  reachable: boolean;
  /** What is known about the node: applied, diverged, not applied, unreachable. */
  fact: CommonSettingsNodeFact;
  /** The state of the node: it confirmed, it diverged, or it is unknown. */
  status: "подтвердил" | "расходится" | "не подтвердил";
  /** The revision the node holds. */
  appliedRevision: string | null;
  /** When the node confirmed. */
  confirmedAt: string | null;
  /** Why the node did not confirm, in words. */
  reason: string | null;
  /** The deviations the node holds, with the values of the secrets closed. */
  conflicts: CommonSettingsConflictView[];
  /**
   * When the owner really asked this node, in words of time.
   *
   * The answer of the panel is fast because the owner keeps the last answer of
   * the node; this is the moment that answer was really read, so the panel
   * never shows a fresh time for an old answer.
   */
  checkedAt: string | null;
  /**
   * Whether the answer of this node is older than the fresh window.
   *
   * A stale answer is the last known answer: the node is asked again in the
   * background, and the round that answers is not held by the panel.
   */
  stale: boolean;
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
  /** The nodes that did not answer the round of asking, by name. */
  unreachable: string[];
  /** Whether a round of asking was made. */
  attempted: boolean;
  /**
   * When the oldest answer of the fleet was really read.
   *
   * The owner answers fast because it keeps the answers; this is the moment
   * the oldest of them was read, so the age of the answer is never hidden.
   */
  polledAt: string | null;
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
  /**
   * The memory of the owner about the nodes.
   *
   * The transport keeps one when it can: the panel asks the fleet many times
   * a minute, and the state of a node does not move that fast.
   */
  cache?: CommonSettingsPeerCache;
  /** How long an answer of a node is served without asking the node again. */
  freshTtlMs?: number;
  /** How long the owner waits for a node that has no answer yet. */
  budgetMs?: number;
}): Promise<CommonSettingsFleetView> {
  const now = input.now ?? (() => new Date());
  const clock = (): number => now().getTime();
  const cache = input.cache ?? input.transport.cache;
  const freshTtlMs = input.freshTtlMs ?? COMMON_SETTINGS_PEER_FRESH_TTL_MS;
  const budgetMs = input.budgetMs ?? COMMON_SETTINGS_PEER_BUDGET_MS;
  const nodes: CommonSettingsNodeView[] = [];
  const notParticipating: string[] = [];

  await Promise.all(input.peers.map(async (peer) => {
    /**
     * The round that asks the node what it holds.
     *
     * One round at a time: an ask that comes while the first one is still on
     * its way waits for the first one instead of asking the node twice.
     */
    const round = async (): Promise<CommonSettingsPeerEntry> => {
      if (!cache) {
        let status: CommonSettingsNodeStatus | null = null;
        let reason: string | null = null;
        try {
          status = await input.transport.status(peer.target);
          if (!status) reason = "Нода не отдала своё состояние.";
        } catch (error) {
          reason = (error as Error).message;
        }
        return { status, reason, polledAt: clock() };
      }
      return await cache.refresh(peer.hostId, async () => await input.transport.status(peer.target));
    };

    const known = cache?.read(peer.hostId);
    const fresh = cache !== undefined && known !== undefined && cache.isFresh(peer.hostId, freshTtlMs);
    let entry: CommonSettingsPeerEntry;
    let stale = false;
    if (input.distribute) {
      // The round that moves the document is a live one: the owner tells the
      // nodes what they must take, and it needs the state they hold now.
      entry = await round();
    } else if (fresh) {
      // The answer of the node is fresh: nobody is asked, nobody waits.
      entry = known!;
    } else if (known) {
      // The last known answer is served and the node is asked again in the
      // background: the panel waits for nothing, and the answer says that it
      // is old.
      stale = true;
      entry = known;
      void round().catch(() => { /* the round keeps the reason of the failure */ });
    } else {
      // No answer at all yet: the owner waits for the round, but only for the
      // budget. A node that does not answer in time is named as a node that
      // did not answer, and the round finishes in the background.
      const answer = await withinBudget(round(), budgetMs);
      entry = answer ?? unansweredPeerEntry(`Нода не ответила за ${budgetMs} мс.`, clock());
    }

    let status = entry.status;
    let reason = entry.reason;
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
    // The fact of the node is what the answer of the node says: a node that
    // did not answer is unreachable and nothing is known about it, and a node
    // that answered and holds nothing has not applied the document yet. The
    // two are never one state.
    const reachable = status !== null;
    const view: CommonSettingsNodeView = {
      hostId: peer.hostId,
      optIn: status ? status.optIn : null,
      reachable,
      fact: !reachable
        ? "недоступна"
        : holds
          ? "применена"
          : appliedRevision === null
            ? "не применена"
            : "расходится",
      status: !status
        ? "не подтвердил"
        : holds
          ? "подтвердил"
          : appliedRevision === null
            ? "не подтвердил"
            : "расходится",
      appliedRevision,
      confirmedAt,
      reason: reason ?? (holds ? null : appliedRevision === null
        ? "Нода ответила и берёт общие настройки, но общий документ к ней ещё не доехал: ревизия не названа."
        : `Нода держит другую ревизию (${appliedRevision}).`),
      conflicts: redactCommonSettingsConflicts(status?.conflicts ?? []),
      // The moment the state of the node was really read: the answer of the
      // panel is fast because the owner keeps the answers, and it never shows
      // a fresh time for an old answer.
      checkedAt: new Date(entry.polledAt).toISOString(),
      stale,
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
    // The nodes that did not answer are named apart: a node that is down is
    // not a node that holds another revision.
    unreachable: nodes.filter((node) => !node.reachable).map((node) => node.hostId),
    attempted: true,
    // The oldest answer of the fleet: the age of the answer as a whole.
    polledAt: nodes.map((node) => node.checkedAt).filter((value): value is string => Boolean(value)).sort()[0] ?? null,
  };
}

/**
 * The answer of a round, or nothing when the round did not arrive in time.
 *
 * The round itself is not stopped: it finishes in the background and its
 * answer is kept. Only the waiting of the caller ends.
 */
async function withinBudget<T>(round: Promise<T>, budgetMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([round, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
