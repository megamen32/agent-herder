export type SessionListSort = "activity" | "status" | "harness" | "title" | "cwd";

const STATUS_RU: Record<string, string> = {
  running: "Работает",
  needs_input: "Ждёт ответа",
  error: "Ошибка",
  idle: "Простой",
  stopped: "Остановлена",
  completed: "Остановлена",
};

const MONTHS_RU = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

/** Человекочитаемый статус сессии по-русски. */
export function statusRu(status: string): string {
  return STATUS_RU[status] ?? status;
}

/** Относительное время по-русски: «только что», «5 мин», «3 ч», «вчера», «6 окт». */
export function relativeTimeRu(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const deltaMinutes = Math.round((Date.now() - time) / 60_000);
  const absolute = Math.abs(deltaMinutes);
  if (absolute < 1) return "только что";
  if (absolute < 60) return deltaMinutes > 0 ? `${deltaMinutes} мин` : `через ${-deltaMinutes} мин`;
  const hours = Math.floor(absolute / 60);
  if (hours < 24) return deltaMinutes > 0 ? `${hours} ч` : `через ${hours} ч`;
  if (hours < 48) return deltaMinutes > 0 ? "вчера" : "завтра";
  const date = new Date(time);
  const year = date.getFullYear() === new Date().getFullYear() ? "" : ` ${date.getFullYear()}`;
  return `${date.getDate()} ${MONTHS_RU[date.getMonth()] ?? ""}${year}`;
}

/** Однострочное превью сообщения: пробелы схлопнуты, обрезка до max символов с многоточием. */
export function truncatePreview(text: string, max = 120): string {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

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
  showAll: boolean;
};

export type SessionListEntry = {
  session: SessionListSession;
  depth: number;
  hasChildren: boolean;
};

export const sessionKey = (session: Pick<SessionListSession, "harness" | "id">) => `${session.harness}:${session.id}`;

export function sessionKeyFromHash(hash: string): string | undefined {
  try {
    const canonical = hash.match(/^#\/session\/(.+)$/);
    if (canonical) return decodeURIComponent(canonical[1]);
    // Keep previously delivered Notice Place links useful after the React UI
    // replaced the older #<harness>/<session> route.
    const legacy = hash.match(/^#([^/]+)\/(.+)$/);
    return legacy ? `${decodeURIComponent(legacy[1])}:${decodeURIComponent(legacy[2])}` : undefined;
  } catch {
    return undefined;
  }
}

export function selectionAfterSessionRefresh(current: string | undefined, linked: string | undefined, sessions: Array<Pick<SessionListSession, "harness" | "id">>): string | undefined {
  // A quick active list is not evidence that an explicitly linked historical
  // session disappeared. Its details are fetched independently by the chat.
  return current && (current === linked || sessions.some((session) => sessionKey(session) === current)) ? current : undefined;
}

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
  return current.cwd || "(папка не указана)";
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
  choiceSessionKeys: ReadonlySet<string> = new Set(),
): SessionListEntry[] {
  const byKey = new Map(sessions.map((session) => [sessionKey(session), session]));
  const filtered = sessions.filter((session) => {
    if (!settings.showAll && !["running", "needs_input"].includes(session.status) && !choiceSessionKeys.has(sessionKey(session))) return false;
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
