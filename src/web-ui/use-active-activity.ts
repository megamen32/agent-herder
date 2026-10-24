import {useEffect, useRef, useState} from 'react';
import {parseActiveActivity, type ActiveActivitySnapshot, type ActiveGoal} from './active-activity.js';

/** The answer of the activity inventory of the herder. */
export const ACTIVE_ACTIVITY_ENDPOINT = '/api/sessions/active';
/** The business goal and result of the sessions the runtime of this host records. */
export const ACTIVE_GOALS_ENDPOINT = '/api/sessions/activity/goals';
/** The inventory of the activity is refreshed as often as the list of sessions. */
export const ACTIVE_ACTIVITY_REFRESH_MS = 15_000;
/** One request never asks about more sessions than this. */
const MAX_GOAL_IDS = 50;

export type ActiveActivityState = {
  snapshot: ActiveActivitySnapshot;
  goals: ReadonlyMap<string, ActiveGoal>;
  error: string;
};

const emptySnapshot = (): ActiveActivitySnapshot => ({
  rows: [], confirmed: [], activeCount: 0, runningCount: 0, waitingCount: 0, partial: false, fetchedAt: '',
});

/** The business goal of the sessions the runtime of this host knows about. */
async function readGoals(ids: readonly string[], signal: AbortSignal): Promise<Map<string, ActiveGoal>> {
  const goals = new Map<string, ActiveGoal>();
  if (!ids.length) return goals;
  try {
    const response = await fetch(`${ACTIVE_GOALS_ENDPOINT}?ids=${encodeURIComponent(ids.join(','))}`, {
      credentials: 'same-origin', cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) return goals;
    const payload = await response.json() as {goals?: Array<{sessionId?: string; objective?: string; status?: string; result?: string}>};
    for (const goal of payload.goals ?? []) {
      if (!goal || typeof goal.sessionId !== 'string' || !goal.sessionId) continue;
      goals.set(goal.sessionId, {objective: goal.objective, status: goal.status, result: goal.result});
    }
  } catch {
    return goals;
  }
  return goals;
}

/**
 * Read the confirmed activity of the fleet while the panel is open.
 *
 * The answer is optional: when the inventory cannot be read, the panel keeps the
 * catalog it has and says that the activity is unavailable. A failed read never
 * turns a session into a working one.
 */
export function useActiveActivity(intervalMs: number = ACTIVE_ACTIVITY_REFRESH_MS): ActiveActivityState {
  const [state, setState] = useState<ActiveActivityState>({snapshot: emptySnapshot(), goals: new Map(), error: ''});
  const run = useRef(0);
  useEffect(() => {
    const abort = new AbortController();
    let stopped = false;
    const load = async () => {
      const id = ++run.current;
      try {
        const response = await fetch(ACTIVE_ACTIVITY_ENDPOINT, {
          credentials: 'same-origin', cache: 'no-store',
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
        });
        if (!response.ok) throw new Error('activity_unavailable');
        const snapshot = parseActiveActivity(await response.json());
        if (stopped || id !== run.current) return;
        setState(current => ({...current, snapshot, error: ''}));
        const ids = snapshot.confirmed.map(row => row.id).filter(value => value.length > 0).slice(0, MAX_GOAL_IDS);
        const goals = await readGoals(ids, abort.signal);
        if (stopped || id !== run.current) return;
        setState(current => ({...current, goals}));
      } catch {
        if (stopped) return;
        setState(current => ({...current, error: 'Активность сессий сейчас недоступна.'}));
      }
    };
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, intervalMs);
    return () => { stopped = true; abort.abort(); clearInterval(timer); };
  }, [intervalMs]);
  return state;
}
