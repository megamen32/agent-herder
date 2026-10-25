import { minimaxRuntimeStatePath } from "./minimax-code-runtime-activity.js";

/**
 * The business goal and the business result of a MiniMax Code session.
 *
 * The runtime of the desktop app keeps the goal of a thread it works on and
 * the outcome of that work in its own state. The panel may show them, but only
 * as they are written there: a session without a goal row has no business
 * result, and the panel says so instead of inventing one.
 */
export interface MinimaxThreadGoal {
  sessionId: string;
  /** The goal of the thread as the runtime recorded it. */
  objective: string;
  /** The state of the goal: running, paused, done and the like. */
  status: string;
  /** The outcome of the work, when the runtime recorded one. */
  result?: string;
  updatedAt: string;
}

const MAX_IDS = 50;
const MAX_TEXT = 2_000;

const usableId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);

const firstText = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (!text) continue;
    return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
  }
  return undefined;
};

/**
 * Read the goals of the given sessions from the runtime state of this host.
 *
 * The state file is opened read-only and never written. A missing table or an
 * unreadable file throws, so the caller can tell "no goals" from "no state".
 */
export async function readMinimaxThreadGoals(
  sessionIds: readonly string[],
  path: string = minimaxRuntimeStatePath(),
): Promise<MinimaxThreadGoal[]> {
  const ids = [...new Set(sessionIds.filter(usableId))].slice(0, MAX_IDS);
  if (!ids.length) return [];
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
      .prepare(
        `select session_id as session_id, objective as objective, status as status,
                last_verification as last_verification, last_worker_proposal as last_worker_proposal,
                status_reason as status_reason, updated_at_ms as updated_at_ms
           from local_runtime_thread_goals
          where session_id in (${placeholders})`,
      )
      .all(...ids) as unknown as Array<Record<string, unknown>>;
    const goals: MinimaxThreadGoal[] = [];
    for (const row of rows) {
      const sessionId = row.session_id;
      if (!usableId(sessionId)) continue;
      const result = firstText(row.last_verification, row.last_worker_proposal, row.status_reason);
      const updatedAt = typeof row.updated_at_ms === "number" ? new Date(row.updated_at_ms).toISOString() : new Date(0).toISOString();
      goals.push({
        sessionId,
        objective: firstText(row.objective) ?? "",
        status: firstText(row.status) ?? "",
        ...(result ? { result } : {}),
        updatedAt,
      });
    }
    return goals;
  } finally {
    db.close();
  }
}
