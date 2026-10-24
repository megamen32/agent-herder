import type {SessionListSession} from './session-list.js';

/**
 * Activity of the sessions the panel draws.
 *
 * The catalog of sessions knows that a session exists; it does not know that the
 * session is working right now. Only the activity inventory proves it, so the
 * panel reads that inventory separately and never derives a running status from
 * the catalog. A row without confirmed activity keeps the status of the catalog:
 * "idle" must never be dressed up as work.
 */
export type ActiveActivityRow = {
  id: string;
  harness: string;
  title?: string;
  runtimeHostId?: string;
  status?: string;
  activity?: {state?: string; observedAt?: string; evidence?: string; expiresAt?: string};
  workspaces?: Array<{hostId?: string; absolutePath?: string}>;
};

/** The business goal of a session, when the runtime of the host records one. */
export type ActiveGoal = {objective?: string; status?: string; result?: string};

export type ActiveActivitySnapshot = {
  /** Every row of the answer, confirmed or not. */
  rows: ActiveActivityRow[];
  /** Only the rows whose activity is confirmed. */
  confirmed: ActiveActivityRow[];
  activeCount: number;
  runningCount: number;
  waitingCount: number;
  /** The answer of the host was not complete. */
  partial: boolean;
  fetchedAt: string;
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Only a confirmed activity state is an activity. */
export function isConfirmedActive(row: ActiveActivityRow): boolean {
  return row.activity?.state === 'active';
}

/** The status of a working session: it runs, or it waits for the owner. */
export function activeStatus(row: ActiveActivityRow): 'running' | 'needs_input' {
  return row.status === 'needs_input' ? 'needs_input' : 'running';
}

/**
 * The goal of a session: the title of the session, cleaned of service marks.
 *
 * A system prompt of the runtime is not the task of the owner. It says who
 * the assistant is, and showing it as the goal of the work hides the task.
 */
export function activeGoal(row: ActiveActivityRow): string {
  const title = text(row.title).trim();
  if (!title) return "";
  // A system prompt of the runtime is not the task of the owner.
  if (/^\[system\]/i.test(title)) return "";
  // The native id stands in for a missing title. It names the session, not its task.
  if (title === row.id) return "";
  return title;
}

/** The business result of a session, when the runtime of the host recorded one. */
export function activeResult(goal: ActiveGoal | undefined): string {
  return text(goal?.result).trim();
}

/**
 * Read the answer of the activity inventory. An answer that does not look like
 * an inventory is an empty inventory, never a reason to invent activity.
 */
export function parseActiveActivity(payload: unknown): ActiveActivitySnapshot {
  const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const raw = Array.isArray(body.sessions) ? body.sessions : [];
  const rows: ActiveActivityRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = text(row.id);
    const harness = text(row.harness);
    if (!id || !harness) continue;
    const activity = row.activity && typeof row.activity === 'object' ? row.activity as Record<string, unknown> : {};
    const workspaces = Array.isArray(row.workspaces) ? row.workspaces : [];
    rows.push({
      id, harness,
      title: text(row.title) || undefined,
      runtimeHostId: text(row.runtimeHostId) || undefined,
      status: text(row.status) || undefined,
      activity: {
        state: text(activity.state) || undefined,
        observedAt: text(activity.observedAt) || undefined,
        evidence: text(activity.evidence) || undefined,
        expiresAt: text(activity.expiresAt) || undefined,
      },
      workspaces: workspaces.filter(item => item && typeof item === 'object').map(item => {
        const workspace = item as Record<string, unknown>;
        return {hostId: text(workspace.hostId) || undefined, absolutePath: text(workspace.absolutePath) || undefined};
      }),
    });
  }
  const confirmed = rows.filter(isConfirmedActive);
  return {
    rows, confirmed,
    activeCount: confirmed.length,
    runningCount: confirmed.filter(row => activeStatus(row) === 'running').length,
    waitingCount: confirmed.filter(row => activeStatus(row) === 'needs_input').length,
    partial: body.partial === true,
    fetchedAt: new Date().toISOString(),
  };
}

const nativeKey = (harness: string, id: string) => `${harness}|${id}`;
const hostedKey = (hostId: string, harness: string, id: string) => `${hostId.toLowerCase()}|${harness}|${id}`;

/**
 * The index of the confirmed activity, addressed the way the fleet addresses a
 * session: by the machine, the harness and the native session id.
 *
 * The native id is kept as a second address: a session of this host may reach
 * the panel without the machine it runs on, and the native id of a session is
 * unique enough to find it.
 */
export function activeActivityIndex(rows: readonly ActiveActivityRow[]): Map<string, ActiveActivityRow> {
  const index = new Map<string, ActiveActivityRow>();
  for (const row of rows.filter(isConfirmedActive)) {
    const host = text(row.runtimeHostId).toLowerCase();
    const hosted = hostedKey(host, row.harness, row.id);
    if (!index.has(hosted)) index.set(hosted, row);
    const native = nativeKey(row.harness, row.id);
    if (!index.has(native)) index.set(native, row);
  }
  return index;
}

/**
 * Put the confirmed activity onto the rows of the panel.
 *
 * A session that the inventory proves to be working becomes a working session:
 * the status says so, the goal of the session travels with it, and the business
 * result is shown when the runtime of the host recorded one. A session the
 * inventory does not mention keeps the status of the catalog.
 *
 * A working session that the window of the catalog does not hold is still work:
 * it is added to the list, otherwise the owner reads an empty list while the
 * fleet is busy.
 */
export function mergeActiveActivity(
  sessions: SessionListSession[],
  rows: readonly ActiveActivityRow[],
  options: {hostId?: string; goals?: ReadonlyMap<string, ActiveGoal>} = {},
): SessionListSession[] {
  const confirmed = rows.filter(isConfirmedActive);
  if (!confirmed.length) return sessions;
  const goals = options.goals ?? new Map<string, ActiveGoal>();
  const localHostId = text(options.hostId).toLowerCase();
  const index = activeActivityIndex(confirmed);
  const goalOf = (row: ActiveActivityRow): string => text(goals.get(row.id)?.objective).trim() || activeGoal(row);
  const resultOf = (row: ActiveActivityRow): string => activeResult(goals.get(row.id));
  const matched = new Set<ActiveActivityRow>();
  const merged = sessions.map(session => {
    const host = text(session.hostId).toLowerCase();
    const row = index.get(hostedKey(host, session.harness, session.id))
      ?? (session.remote ? undefined : index.get(nativeKey(session.harness, session.id)));
    if (!row) return session;
    matched.add(row);
    const goal = goalOf(row);
    const result = resultOf(row);
    return {
      ...session,
      status: activeStatus(row),
      meta: {
        ...session.meta,
        activityState: 'active',
        activityEvidence: row.activity?.evidence,
        activityObservedAt: row.activity?.observedAt,
        ...(goal ? {activityGoal: goal} : {}),
        ...(result ? {activityResult: result} : {}),
      },
    } satisfies SessionListSession;
  });
  const extra: SessionListSession[] = [];
  for (const row of confirmed) {
    if (matched.has(row)) continue;
    const host = text(row.runtimeHostId) || text(options.hostId);
    const goal = goalOf(row);
    const result = resultOf(row);
    extra.push({
      hostId: host || undefined,
      remote: Boolean(host) && host.toLowerCase() !== localHostId,
      id: row.id,
      harness: row.harness,
      title: goal || row.id,
      cwd: row.workspaces?.[0]?.absolutePath ?? '',
      status: activeStatus(row),
      lastActivity: row.activity?.observedAt ?? new Date().toISOString(),
      meta: {
        activityState: 'active',
        activityEvidence: row.activity?.evidence,
        activityObservedAt: row.activity?.observedAt,
        ...(goal ? {activityGoal: goal} : {}),
        ...(result ? {activityResult: result} : {}),
      },
    });
  }
  return [...merged, ...extra];
}
