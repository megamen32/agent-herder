export type SessionListSort = "activity" | "status" | "harness" | "title" | "cwd";

export type SessionListSession = {
  id: string;
  harness: string;
  title: string;
  cwd: string;
  status: string;
  lastActivity: string;
  lastMessage?: string;
  model?: string;
  needsPermission?: boolean;
  meta?: { parentSessionKey?: string; [key: string]: unknown };
};

export type SessionListSettings = {
  cwd: string;
  project: string;
  harness: string;
  sort: SessionListSort;
};

export type SessionListEntry = {
  session: SessionListSession;
  depth: number;
  hasChildren: boolean;
};

export const sessionKey = (session: Pick<SessionListSession, "harness" | "id">) => `${session.harness}:${session.id}`;

export function matchesSessionQuery(session: Pick<SessionListSession, "id" | "harness" | "title" | "cwd" | "lastMessage">, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return [session.id, session.harness, session.title, session.cwd, session.lastMessage || ""]
    .some((value) => value.toLocaleLowerCase().includes(normalized));
}

export function projectFor(session: SessionListSession, byKey: Map<string, SessionListSession>): string {
  const visited = new Set<string>();
  let current = session;
  while (current.meta?.parentSessionKey && !visited.has(current.meta.parentSessionKey)) {
    visited.add(current.meta.parentSessionKey);
    const parent = byKey.get(current.meta.parentSessionKey);
    if (!parent) break;
    current = parent;
  }
  return current.cwd || "(unknown cwd)";
}

const statusOrder = new Map([["running", 0], ["needs_input", 1], ["error", 2], ["idle", 3], ["stopped", 4]]);

function compareSessions(left: SessionListSession, right: SessionListSession, sort: SessionListSort): number {
  if (sort === "status") {
    const delta = (statusOrder.get(left.status) ?? 99) - (statusOrder.get(right.status) ?? 99);
    if (delta) return delta;
  } else if (sort === "harness") {
    const delta = left.harness.localeCompare(right.harness);
    if (delta) return delta;
  } else if (sort === "title") {
    const delta = (left.title || left.id).localeCompare(right.title || right.id);
    if (delta) return delta;
  } else if (sort === "cwd") {
    const delta = left.cwd.localeCompare(right.cwd);
    if (delta) return delta;
  } else {
    const delta = Date.parse(right.lastActivity || "") - Date.parse(left.lastActivity || "");
    if (Number.isFinite(delta) && delta) return delta;
  }
  return sessionKey(left).localeCompare(sessionKey(right));
}

export function filterAndArrangeSessions(
  sessions: SessionListSession[],
  settings: SessionListSettings,
  collapsed: ReadonlySet<string>,
): SessionListEntry[] {
  const byKey = new Map(sessions.map((session) => [sessionKey(session), session]));
  const filtered = sessions.filter((session) => {
    if (settings.harness && session.harness !== settings.harness) return false;
    if (settings.cwd && !session.cwd.startsWith(settings.cwd)) return false;
    if (settings.project && projectFor(session, byKey) !== settings.project) return false;
    return true;
  });
  const children = new Map<string, SessionListSession[]>();
  for (const session of filtered) {
    const parentKey = session.meta?.parentSessionKey;
    if (parentKey && byKey.has(parentKey)) {
      const group = children.get(parentKey) || [];
      group.push(session);
      children.set(parentKey, group);
    }
  }
  const roots = filtered
    .filter((session) => !session.meta?.parentSessionKey || !byKey.has(session.meta.parentSessionKey))
    .sort((left, right) => compareSessions(left, right, settings.sort));
  const result: SessionListEntry[] = [];
  const visited = new Set<string>();
  const hideDescendants = (session: SessionListSession) => {
    const key = sessionKey(session);
    if (visited.has(key)) return;
    visited.add(key);
    for (const child of children.get(key) || []) hideDescendants(child);
  };
  const walk = (session: SessionListSession, depth: number) => {
    const key = sessionKey(session);
    if (visited.has(key)) return;
    visited.add(key);
    const nested = (children.get(key) || []).sort((left, right) => compareSessions(left, right, settings.sort));
    result.push({ session, depth, hasChildren: nested.length > 0 });
    if (!collapsed.has(key)) for (const child of nested) walk(child, depth + 1);
    else for (const child of nested) hideDescendants(child);
  };
  for (const root of roots) walk(root, 0);
  for (const session of filtered) walk(session, 0);
  return result;
}
