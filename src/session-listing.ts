/**
 * The order of the session list that the panel receives.
 *
 * The panel does not receive the whole list: the answer of `/api/sessions` is a
 * window, bounded by a count and by a byte budget, and the window is a prefix
 * of the list. A prefix of the raw aggregation order is a prefix of the order
 * in which the harnesses were registered, so a harness that is registered late
 * never reaches the window, however many sessions it has.
 *
 * The window must carry what the person is doing now, and it must not hide a
 * whole harness because another one was busier. The order therefore is:
 *
 * 1. the live sessions first — the ones a runtime proves work right now;
 * 2. then the rest, by the time of the last activity, taken in rounds: the
 *    newest session of every harness, then the second newest of every harness,
 *    and so on. A busy harness fills its own rounds and cannot push the other
 *    harnesses out of the window.
 *
 * The order is honest: a session is "live" only when its own status says so,
 * and the time of the last activity is the time the session carries. Nothing is
 * invented for a session whose data is missing — a session without a readable
 * time keeps its place at the end of its harness.
 */

/** The statuses that mean the session works right now. */
const LIVE_STATUSES: readonly string[] = ["running", "needs_input"];

/** What the order needs to know about a session. */
export interface ListedSession {
  harness?: string;
  status?: string;
  lastActivity?: string;
}

/** True when the session works right now. */
export function isLiveListedSession(session: ListedSession): boolean {
  return typeof session.status === "string" && LIVE_STATUSES.includes(session.status);
}

/** The time of the last activity of the session, or 0 when it is unreadable. */
export function listedActivityTime(session: ListedSession): number {
  const parsed = Date.parse(String(session.lastActivity ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The newest first, and the order of the list kept for equal times. */
function byActivity<T extends ListedSession>(sessions: T[]): T[] {
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((left, right) => {
      const timeLeft = listedActivityTime(left.session);
      const timeRight = listedActivityTime(right.session);
      if (timeLeft !== timeRight) return timeRight - timeLeft;
      return left.index - right.index;
    })
    .map((entry) => entry.session);
}

/**
 * The order of the list for the panel: live sessions first, then the newest
 * session of every harness, then the second newest of every harness, and so on.
 *
 * The order is total and stable: two requests over the same list answer the
 * same way, and a session that belongs to no harness keeps its place in the
 * round it shares with the others.
 */
export function orderSessionListForPanel<T extends ListedSession>(sessions: T[]): T[] {
  const live: T[] = [];
  const rest: T[] = [];
  for (const session of sessions) (isLiveListedSession(session) ? live : rest).push(session);

  // The rounds keep the harnesses together: each harness answers with its
  // newest sessions first, and the window takes one session of every harness
  // per round.
  const collected = new Map<string, T[]>();
  for (const session of rest) {
    const key = typeof session.harness === "string" ? session.harness : "";
    const group = collected.get(key);
    if (group) group.push(session);
    else collected.set(key, [session]);
  }
  // The rounds follow the freshest harness: the harness that worked last leads
  // the rounds, and the order of the rest is the order of the list.
  const groups = [...collected.values()]
    .map((group, index) => ({ group: byActivity(group), index }))
    .sort((left, right) => {
      const timeLeft = listedActivityTime(left.group[0]);
      const timeRight = listedActivityTime(right.group[0]);
      if (timeLeft !== timeRight) return timeRight - timeLeft;
      return left.index - right.index;
    })
    .map((entry) => entry.group);

  const result: T[] = [...byActivity(live)];
  let round = 0;
  let more = true;
  while (more) {
    more = false;
    for (const group of groups) {
      const session = group[round];
      if (!session) continue;
      result.push(session);
      more = true;
    }
    round += 1;
  }
  return result;
}
