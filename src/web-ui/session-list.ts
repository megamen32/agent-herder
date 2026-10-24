export type SessionListSort = "created" | "activity" | "status" | "harness" | "title" | "cwd";

const STATUS_RU: Record<string, string> = {
  running: "Работает",
  needs_input: "Ждёт ответа",
  error: "Ошибка",
  idle: "Простой",
  stopped: "Остановлена",
  completed: "Остановлена",
};

/**
 * Живая сессия — та, что может взять задачу: работает, ждёт ответа владельца
 * или ждёт задачи. Остальные (остановленные, завершённые, ошибочные) скрыты
 * переключателем «Показывать завершённые».
 */
export const LIVE_SESSION_STATUSES: readonly string[] = ["running", "needs_input", "idle"];

/** Живая сессия способна принять задачу; остановленная или завершённая — нет. */
export function isLiveSessionStatus(status: string | undefined): boolean {
  return typeof status === "string" && LIVE_SESSION_STATUSES.includes(status);
}

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
  hostId?: string;
  hostLabel?: string;
  project?: {launchCwd:string|null; currentCwd:string|null; source:string};
  remote?: boolean;
  id: string;
  harness: string;
  title: string;
  cwd: string;
  status: string;
  lastActivity: string;
  createdAt?: string;
  lastMessage?: string;
  model?: string;
  needsPermission?: boolean;
  meta?: { parentSessionKey?: string; [key: string]: unknown };
};

export type SessionListSettings = {
  hostId?: string;
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

export const sessionKey = (session: Pick<SessionListSession, "harness" | "id" | "hostId" | "remote">) => session.remote ? `mesh:${JSON.stringify([session.hostId,session.harness,session.id])}` : `${session.harness}:${session.id}`;

export function sessionKeyFromHash(hash: string): string | undefined {
  try {
    const canonical = hash.match(/^#\/session\/([^?]+)(?:\?.*)?$/);
    if (canonical) return decodeURIComponent(canonical[1]);
    // Keep previously delivered Notice Place links useful after the React UI
    // replaced the older #<harness>/<session> route.
    const legacy = hash.match(/^#([^/]+)\/(.+)$/);
    return legacy ? `${decodeURIComponent(legacy[1])}:${decodeURIComponent(legacy[2])}` : undefined;
  } catch {
    return undefined;
  }
}

export type SessionTurnLink = Readonly<{ sessionKey: string; turnId?: string }>;

/** A turn deep link is only a locator; it carries no author or access claim. */
export function sessionTurnLinkFromHash(hash: string): SessionTurnLink | undefined {
  const sessionKey = sessionKeyFromHash(hash);
  if (!sessionKey) return undefined;
  try {
    const queryAt = hash.indexOf("?");
    if (queryAt < 0) return { sessionKey };
    const turnId = new URLSearchParams(hash.slice(queryAt + 1)).get("turn");
    return turnId && turnId.length <= 512 && !/[\x00-\x1f\x7f]/.test(turnId)
      ? { sessionKey, turnId }
      : { sessionKey };
  } catch {
    return { sessionKey };
  }
}

export function selectionAfterSessionRefresh(current: string | undefined, linked: string | undefined, sessions: Array<Pick<SessionListSession, "harness" | "id">>): string | undefined {
  // A quick active list is not evidence that an explicitly linked historical
  // session disappeared. Its details are fetched independently by the chat.
  if (linked) return linked;
  return current && sessions.some((session) => sessionKey(session) === current) ? current : undefined;
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

export const SESSION_LIST_REFRESH_MS = 30_000;

/** Missing native creation evidence stays unknown; activity is never a substitute. */
export function sessionCreatedAt(session: SessionListSession): number {
  const value = session.createdAt ?? session.meta?.createdAt;
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : 0;
}

/** Keep existing sort times between samples; new rows appear without waiting for a sample. */
export function sampleSessionActivity(previous: ReadonlyMap<string, string>, sessions: SessionListSession[], refresh = false): ReadonlyMap<string, string> {
  const next = new Map(sessions.map(session => {
    const key = sessionKey(session);
    return [key, !refresh && previous.has(key) ? previous.get(key)! : session.lastActivity] as const;
  }));
  return next.size === previous.size && [...next].every(([key, value]) => previous.get(key) === value) ? previous : next;
}

export function sessionListRefreshDelay(lastStarted: number, now: number): number {
  return Math.max(0, SESSION_LIST_REFRESH_MS - (now - lastStarted));
}

function compareSessions(left: SessionListSession, right: SessionListSession, sort: SessionListSort, activity?: ReadonlyMap<string,string>): number {
  if (sort === "created") {
    const delta = sessionCreatedAt(right) - sessionCreatedAt(left);
    if (delta) return delta;
  } else if (sort === "status") {
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
    const delta = Date.parse(activity?.get(sessionKey(right)) ?? right.lastActivity ?? "") - Date.parse(activity?.get(sessionKey(left)) ?? left.lastActivity ?? "");
    if (Number.isFinite(delta) && delta) return delta;
  }
  return sessionKey(left).localeCompare(sessionKey(right));
}

export function filterAndArrangeSessions(
  sessions: SessionListSession[],
  settings: SessionListSettings,
  collapsed: ReadonlySet<string>,
  choiceSessionKeys: ReadonlySet<string> = new Set(),
  activity?: ReadonlyMap<string,string>,
): SessionListEntry[] {
  const byKey = new Map(sessions.map((session) => [sessionKey(session), session]));
  const filtered = sessions.filter((session) => {
    if (!settings.showAll && !isLiveSessionStatus(session.status) && !choiceSessionKeys.has(sessionKey(session))) return false;
    if (settings.hostId && session.hostId !== settings.hostId) return false;
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
    .sort((left, right) => compareSessions(left, right, settings.sort, activity));
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
    const nested = (children.get(key) || []).sort((left, right) => compareSessions(left, right, settings.sort, activity));
    result.push({ session, depth, hasChildren: nested.length > 0 });
    if (!collapsed.has(key)) for (const child of nested) walk(child, depth + 1);
    else for (const child of nested) hideDescendants(child);
  };
  for (const root of roots) walk(root, 0);
  for (const session of filtered) walk(session, 0);
  return result;
}

/** Русское склонение по числу: 1 сессия, 2 сессии, 5 сессий. */
export function pluralRu(count: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.trunc(count));
  if (abs > 10 && abs < 20) return many;
  const last = abs % 10;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

/** Счётчик списка: сколько строк на экране и сколько их в выборке. */
export type SessionListCounts = {
  /** Строк реально нарисовано на экране. */
  rendered: number;
  /** Строк в выборке после фильтров и поиска, до окна отрисовки. */
  available: number;
  /** Сколько сессий знает сервер. */
  total?: number;
};

export function sessionListCounts(available: number, windowSize: number, total?: number): SessionListCounts {
  const scope = Number.isFinite(available) ? Math.max(0, Math.floor(available)) : 0;
  const window = Number.isFinite(windowSize) ? Math.max(0, Math.floor(windowSize)) : scope;
  return {
    rendered: Math.min(scope, window),
    available: scope,
    total: typeof total === "number" && Number.isFinite(total) ? total : undefined,
  };
}

/**
 * Счётчик шапки говорит ровно то, что на экране: «показано N из M» — это
 * отрисованные строки и размер выборки, а не то, что панель догрузила.
 * С поиском счётчик говорит, сколько найдено, а не сколько загружено.
 */
export function sessionListCounterRu(counts: SessionListCounts, query = ""): string {
  const search = query.trim();
  if (search) {
    if (counts.available === 0) return "ничего не найдено";
    return counts.rendered < counts.available
      ? `найдено ${counts.available} · показано ${counts.rendered}`
      : `найдено ${counts.available}`;
  }
  return `показано ${counts.rendered} из ${counts.available}`;
}

/** Сводка загруженной выборки: сколько сессий, сколько живых, сколько по средам и машинам. */
export type SessionSampleCounts = {
  total: number;
  live: number;
  /** Неживые сессии — те, что показывает переключатель «Показывать завершённые». */
  completed: number;
  /** Сколько сессий выборки подходит под запрос поиска. */
  queryMatches: number;
  byHarness: Record<string, { total: number; live: number; completed: number }>;
  byHost: Record<string, { total: number; live: number; completed: number }>;
};

export function summarizeSessionSample(sessions: SessionListSession[], query = ""): SessionSampleCounts {
  const summary: SessionSampleCounts = { total: 0, live: 0, completed: 0, queryMatches: 0, byHarness: {}, byHost: {} };
  const search = query.trim();
  for (const session of sessions) {
    const live = isLiveSessionStatus(session.status);
    summary.total += 1;
    if (live) summary.live += 1; else summary.completed += 1;
    const harness = summary.byHarness[session.harness] ?? { total: 0, live: 0, completed: 0 };
    harness.total += 1;
    if (live) harness.live += 1; else harness.completed += 1;
    summary.byHarness[session.harness] = harness;
    const hostId = session.hostId ?? "";
    const host = summary.byHost[hostId] ?? { total: 0, live: 0, completed: 0 };
    host.total += 1;
    if (live) host.live += 1; else host.completed += 1;
    summary.byHost[hostId] = host;
    if (search && matchesSessionQuery(session, search)) summary.queryMatches += 1;
  }
  return summary;
}

/** Какие фильтры сейчас включены — одной строкой, по-русски. */
export function sessionListFiltersHint(settings: SessionListSettings, hostLabel = ""): string {
  const parts: string[] = [];
  if (settings.harness) parts.push(`агент ${settings.harness}`);
  if (settings.hostId) parts.push(`машина ${hostLabel || settings.hostId}`);
  if (settings.cwd) parts.push(`папка ${settings.cwd}`);
  if (settings.project) parts.push(`проект ${settings.project}`);
  if (!settings.showAll) parts.push("только живые сессии");
  return parts.length ? `Сейчас включены фильтры: ${parts.join(", ")}.` : "";
}

/** Почему список пуст: заголовок, подсказка и — если есть — кнопка «показать завершённые». */
export type SessionListEmptyReason = {
  title: string;
  hint?: string;
  showCompleted?: boolean;
};

/**
 * Пустой список обязан объяснять причину: иначе владелец читает его как
 * «сессий нет», хотя живая сессия может быть за другим фильтром.
 */
export function sessionListEmptyReason(input: {
  query: string;
  settings: SessionListSettings;
  sample: SessionSampleCounts;
  hostLabel?: string;
}): SessionListEmptyReason {
  const search = input.query.trim();
  const { settings, sample } = input;
  const filters = sessionListFiltersHint(settings, input.hostLabel);
  if (search) {
    if (sample.queryMatches > 0) {
      return {
        title: `По запросу «${search}» совпадений: ${sample.queryMatches} — их не видно из-за фильтров.`,
        hint: filters,
      };
    }
    return {
      title: `По запросу «${search}» ничего не найдено.`,
      hint: `Поиск идёт по загруженному списку: ${sample.total} ${pluralRu(sample.total, "сессия", "сессии", "сессий")}.`,
    };
  }
  if (settings.harness) {
    const counts = sample.byHarness[settings.harness] ?? { total: 0, live: 0, completed: 0 };
    if (!settings.showAll && counts.live === 0) {
      if (counts.completed > 0) {
        return {
          title: `Живых сессий ${settings.harness} сейчас нет.`,
          hint: `Завершённых сессий ${settings.harness} в загруженном списке: ${counts.completed}. Включите «Показывать завершённые», чтобы увидеть их.`,
          showCompleted: true,
        };
      }
      return {
        title: `Живых сессий ${settings.harness} сейчас нет.`,
        hint: `Сессий ${settings.harness} в загруженном списке нет.`,
      };
    }
    if (counts.total === 0) {
      return {
        title: `Сессий ${settings.harness} в загруженном списке нет.`,
        hint: `Всего в списке ${sample.total} ${pluralRu(sample.total, "сессия", "сессии", "сессий")}.`,
      };
    }
  }
  if (settings.hostId) {
    const counts = sample.byHost[settings.hostId] ?? { total: 0, live: 0, completed: 0 };
    const machine = input.hostLabel || settings.hostId;
    if (!settings.showAll && counts.live === 0) {
      if (counts.completed > 0) {
        return {
          title: `Живых сессий на машине ${machine} сейчас нет.`,
          hint: `Завершённых сессий на этой машине: ${counts.completed}. Включите «Показывать завершённые», чтобы увидеть их.`,
          showCompleted: true,
        };
      }
      return { title: `Живых сессий на машине ${machine} сейчас нет.`, hint: `Всего в списке ${sample.total} ${pluralRu(sample.total, "сессия", "сессии", "сессий")}.` };
    }
    if (counts.total === 0) {
      return { title: `Сессий на машине ${machine} в загруженном списке нет.`, hint: `Всего в списке ${sample.total} ${pluralRu(sample.total, "сессия", "сессии", "сессий")}.` };
    }
  }
  if (settings.cwd) {
    return { title: `В папке ${settings.cwd} сессий нет.`, hint: filters };
  }
  if (settings.project) {
    return { title: `В проекте ${settings.project} сессий нет.`, hint: filters };
  }
  return { title: "Нет сессий по этим настройкам.", hint: filters };
}
