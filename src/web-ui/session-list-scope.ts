import * as React from "react";

/**
 * Срез списка сессий: что именно показывает панель и каким числом это измеряется.
 *
 * Панель спрашивает сервер не одним окном, а по кускам: список сессий среды
 * может быть больше окна ответа, поэтому окно — это часть выборки. Числа на
 * чипах берутся с сервера целиком (`total` при `limit=1`), а строки списка —
 * из той же выборки. Поэтому число на чипе и число показанных строк описывают
 * одно и то же множество, а не два разных.
 */

/** Срезы статуса, которые панель показывает как чипы. */
export type SessionStatusSlice = "working" | "waiting" | "all";

/** Статусы, которые значат «работает сейчас». */
export const WORKING_STATUSES: readonly string[] = ["running", "needs_input"];

/** Статусы, которые значат «стоит и ждёт задачи». */
export const WAITING_STATUSES: readonly string[] = ["idle"];

/** Статусы, которые сервер считает по отдельности ради честных чисел. */
export const COUNTED_STATUSES: readonly string[] = ["running", "needs_input", "idle"];

/**
 * Подходит ли статус под срез панели.
 *
 * «Все» — это все статусы, включая остановленные и ошибочные: владелец
 * спросил «показать все», и он должен увидеть все.
 */
export function statusInSlice(status: string | undefined, slice: SessionStatusSlice): boolean {
  if (slice === "all") return true;
  if (slice === "working") return typeof status === "string" && WORKING_STATUSES.includes(status);
  return typeof status === "string" && WAITING_STATUSES.includes(status);
}

/**
 * Статусы среза: пустой список означает «любой статус».
 *
 * Сервер фильтрует по одному статусу за раз, поэтому «работают» — это два
 * запроса, а «все» — запрос без фильтра.
 */
export function sliceStatuses(slice: SessionStatusSlice): string[] {
  if (slice === "working") return [...WORKING_STATUSES];
  if (slice === "waiting") return [...WAITING_STATUSES];
  return [];
}

/** Короткая подпись среза. */
export function sessionSliceLabel(slice: SessionStatusSlice): string {
  if (slice === "working") return "Работают";
  if (slice === "waiting") return "Ждут задачи";
  return "Все";
}

/** Запрос сервера: окно сессий по среде и статусу. */
export function sessionScopeQuery(filter: { harness?: string; status?: string }, limit: number): string {
  const params = new URLSearchParams({ quick: "1", limit: String(Math.max(1, limit)) });
  if (filter.harness) params.set("harness", filter.harness);
  if (filter.status) params.set("status", filter.status);
  return `/api/sessions?${params.toString()}`;
}

/**
 * Запросы, из которых собирается список выбранного среза.
 *
 * Поиск идёт мимо среза: он отвечает на вопрос «где эта сессия», и ответ
 * обязан находить её в любом статусе. Поэтому при запросе поиска статус не
 * ограничивается, а окно расширяется до всего доступного.
 */
export function sliceScopeQueries(slice: SessionStatusSlice, harness: string, searching = false): { harness?: string; status?: string }[] {
  const base = { harness: harness || undefined };
  if (searching) return [base];
  const statuses = sliceStatuses(slice);
  if (!statuses.length) return [base];
  return statuses.map((status) => ({ ...base, status }));
}

/** Ответ сервера на запрос списка: окно сессий и счётчик всей выборки. */
export type SessionScopeAnswer<T = unknown> = { sessions: T[]; total?: number };

/**
 * Склеивает ответы нескольких запросов в один список.
 *
 * Один и тот же сессия может прийти из двух запросов (например, когда статус
 * меняется между ними), поэтому список собирается по ключу, а не склейкой.
 */
export function mergeScopeAnswers<T>(answers: SessionScopeAnswer<T>[], keyOf: (session: T) => string): { sessions: T[]; total: number } {
  const sessions = new Map<string, T>();
  let total = 0;
  for (const answer of answers) {
    total += typeof answer.total === "number" ? answer.total : 0;
    for (const session of answer.sessions || []) {
      const key = keyOf(session);
      if (!sessions.has(key)) sessions.set(key, session);
    }
  }
  return { sessions: [...sessions.values()], total };
}

/**
 * Счётчики среза: сколько сессий во всей флоте у каждого статуса и сколько
 * всего сессий у среды.
 */
export type SessionScopeCounts = {
  /** Сколько сессий у каждого статуса (считается сервером по всей флоте). */
  byStatus: Record<string, number>;
  /** Сколько сессий у каждой среды внутри текущего среза. */
  byHarness: { harness: string; count: number }[];
  /** Сколько сессий всего в выбранной среде (пустая среда — вся флота). */
  total: number;
  /** Идут ли сейчас счётчики. */
  loading: boolean;
};

/** Пустой счётчик — до первого ответа сервера. */
export function emptySessionScopeCounts(): SessionScopeCounts {
  return { byStatus: {}, byHarness: [], total: 0, loading: true };
}

/**
 * Счётчик среза по статусам, посчитанным сервером.
 */
export function sliceCount(counts: SessionScopeCounts, slice: SessionStatusSlice): number {
  if (slice === "all") return counts.total;
  if (slice === "working") return WORKING_STATUSES.reduce((sum, status) => sum + (counts.byStatus[status] ?? 0), 0);
  return WAITING_STATUSES.reduce((sum, status) => sum + (counts.byStatus[status] ?? 0), 0);
}

/** Запрос сервера: одна сессия и счётчик всей выборки по фильтру. */
export function scopeProbeQuery(filter: { harness?: string; status?: string }): string {
  const params = new URLSearchParams({ quick: "1", limit: "1", inventory: "1" });
  if (filter.harness) params.set("harness", filter.harness);
  if (filter.status) params.set("status", filter.status);
  return `/api/sessions?${params.toString()}`;
}

/**
 * Все запросы, которые нужны для честных чисел выбранной среды.
 *
 * Числа нужны и по срезу (сколько работает, сколько ждёт, сколько всего), и
 * по каждой среде внутри среза. Ответы приходят по одному на статус и на
 * среду: сервер считает по всей флоте и отдаёт в ответе и окно, и число всей
 * выборки. Окно тут — одна сессия: нужны числа, а не тела.
 */
export function scopeProbeQueries(scope: { slice: SessionStatusSlice; harness?: string; harnesses: string[] }): { status?: string; harness?: string }[] {
  const queries: { status?: string; harness?: string }[] = [];
  for (const status of COUNTED_STATUSES) queries.push({ harness: scope.harness, status });
  queries.push({ harness: scope.harness });
  const statuses = sliceStatuses(scope.slice);
  for (const harness of scope.harnesses) {
    if (!statuses.length) queries.push({ harness });
    else for (const status of statuses) queries.push({ harness, status });
  }
  return queries;
}

/**
 * Собирает счётчики из ответов сервера.
 */
export function scopeCountsFromAnswers(
  answers: { status?: string; harness?: string; total?: number }[],
  scope: { slice: SessionStatusSlice; harness?: string; harnesses: string[] },
): SessionScopeCounts {
  const raw = new Map<string, number>();
  const key = (harness: string, status: string) => `${harness}|${status}`;
  for (const answer of answers) {
    raw.set(key(answer.harness ?? "", answer.status ?? ""), typeof answer.total === "number" ? answer.total : 0);
  }
  const byStatus: Record<string, number> = {};
  for (const status of COUNTED_STATUSES) byStatus[status] = raw.get(key(scope.harness ?? "", status)) ?? 0;
  const total = raw.get(key(scope.harness ?? "", "")) ?? 0;
  const statuses = sliceStatuses(scope.slice);
  const byHarness = scope.harnesses.map((harness) => {
    const count = statuses.length
      ? statuses.reduce((sum, status) => sum + (raw.get(key(harness, status)) ?? 0), 0)
      : raw.get(key(harness, "")) ?? 0;
    return { harness, count };
  });
  return { byStatus, byHarness, total, loading: false };
}

/**
 * Живые счётчики панели: сколько сессий работает, сколько ждёт задачи и
 * сколько у каждой среды.
 *
 * Числа считает сервер по всей флоте, поэтому чип «Работают 4» и список из
 * четырёх работающих сессий говорят одно и то же. Клиентский пересчёт по
 * загруженному окну такого обещания не даёт: окно — это часть выборки.
 */
export function useSessionScope(scope: { slice: SessionStatusSlice; harness: string; harnesses: string[]; refreshMs?: number }): SessionScopeCounts {
  const { slice, harness, harnesses } = scope;
  const refreshMs = scope.refreshMs ?? 60_000;
  const harnessKey = harnesses.join(",");
  const [counts, setCounts] = React.useState<SessionScopeCounts>(() => emptySessionScopeCounts());
  React.useEffect(() => {
    let cancelled = false;
    const read = async () => {
      const probes = scopeProbeQueries({ slice, harness, harnesses });
      const answers = await Promise.all(probes.map(async (probe) => {
        try {
          const response = await fetch(scopeProbeQuery(probe), { headers: { accept: "application/json" } });
          if (!response.ok) return { ...probe, total: 0 };
          const body = (await response.json()) as { total?: number };
          return { ...probe, total: typeof body.total === "number" ? body.total : 0 };
        } catch {
          return { ...probe, total: 0 };
        }
      }));
      if (cancelled) return;
      setCounts(scopeCountsFromAnswers(answers, { slice, harness, harnesses }));
    };
    void read();
    const timer = window.setInterval(() => { void read(); }, refreshMs);
    return () => { cancelled = true; window.clearInterval(timer); };
    // harnessKey — стабильный список сред; сам массив меняется каждый рендер.
  }, [slice, harness, harnessKey, refreshMs]);
  return counts;
}
