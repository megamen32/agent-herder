/**
 * The last known state of every node of the fleet, as the owner reads it.
 *
 * The owner asks the nodes what they hold, and a node that does not answer
 * costs the owner the whole round: the answer of the panel waits for the
 * slowest node, and a node that is down costs its full timeout every time.
 * The owner therefore keeps the last answer of every node and serves it while
 * it is fresh; the round that refreshes it happens in the background and never
 * holds the answer of the panel.
 *
 * The truth is not lost in the keeping: the answer names when the state of
 * every node was really read, and it says that the answer is old. A node that
 * did not answer stays a node that did not answer — it is never counted as a
 * node that holds the document.
 */

import type { CommonSettingsNodeStatus } from "./node-state.js";

/** What the owner knows about one node of the fleet. */
export interface CommonSettingsPeerEntry {
  /** The state of the node, or null when the node did not answer. */
  status: CommonSettingsNodeStatus | null;
  /** Why the node did not answer, in words. */
  reason: string | null;
  /** When the state was really read, in milliseconds since the epoch. */
  polledAt: number;
}

/**
 * How long an answer of a node is served without asking the node again.
 *
 * The panel asks the fleet many times a minute; the state of a node does not
 * move that fast, and a node that is down must not be paid for on every ask.
 */
export const COMMON_SETTINGS_PEER_FRESH_TTL_MS = 10_000;

/**
 * How long the owner waits for a node that has no answer yet.
 *
 * The wait is a budget, not a promise: a node that answers in time is named
 * with the truth, and a node that does not answer in time is named as a node
 * that did not answer — the round finishes in the background.
 */
export const COMMON_SETTINGS_PEER_BUDGET_MS = 800;

/**
 * The memory of the owner about the nodes of the fleet.
 *
 * One round at a time: a second ask that comes while the first one is still
 * on its way waits for the first one instead of asking the node twice. The
 * round never rejects — a node that does not answer is an answer of its own,
 * and the reason of the failure is kept beside it.
 */
export class CommonSettingsPeerCache {
  private readonly entries = new Map<string, CommonSettingsPeerEntry>();
  private readonly inflight = new Map<string, Promise<CommonSettingsPeerEntry>>();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  /** The last answer of the node, when there is one. */
  read(hostId: string): CommonSettingsPeerEntry | undefined {
    return this.entries.get(hostId);
  }

  /** How old the last answer of the node is, in milliseconds. */
  age(hostId: string): number | null {
    const entry = this.entries.get(hostId);
    return entry ? this.clock() - entry.polledAt : null;
  }

  /** The answer of the node is fresh: it may be served without asking again. */
  isFresh(hostId: string, freshTtlMs: number): boolean {
    const age = this.age(hostId);
    return age !== null && age <= freshTtlMs;
  }

  /**
   * Ask the node what it holds, and remember the answer.
   *
   * The round never rejects: the caller always learns what the node answered,
   * or why it did not answer.
   */
  async refresh(
    hostId: string,
    read: () => Promise<CommonSettingsNodeStatus | null>,
  ): Promise<CommonSettingsPeerEntry> {
    const running = this.inflight.get(hostId);
    if (running) return await running;
    const round = (async (): Promise<CommonSettingsPeerEntry> => {
      let status: CommonSettingsNodeStatus | null = null;
      let reason: string | null = null;
      try {
        status = await read();
        if (!status) reason = "Нода не отдала своё состояние.";
      } catch (error) {
        status = null;
        reason = (error as Error).message;
      }
      const entry: CommonSettingsPeerEntry = { status, reason, polledAt: this.clock() };
      this.entries.set(hostId, entry);
      return entry;
    })();
    this.inflight.set(hostId, round);
    try {
      return await round;
    } finally {
      this.inflight.delete(hostId);
    }
  }
}

/**
 * The answer of a round that did not arrive in time.
 *
 * The node is named as a node that did not answer: the owner knows nothing
 * about it, and unknown is never agreement.
 */
export function unansweredPeerEntry(reason: string, polledAt: number): CommonSettingsPeerEntry {
  return { status: null, reason, polledAt };
}
