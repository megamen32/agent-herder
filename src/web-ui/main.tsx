import * as React from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { filterAndArrangeSessions, matchesSessionQuery, projectFor, sessionKey, sessionKeyFromHash, selectionAfterSessionRefresh, type SessionListEntry, type SessionListSession, type SessionListSettings, type SessionListSort } from "./session-list.js";
import { QuotaPanel } from "./quota-panel.js";
import { LaunchPolicySettings } from "./launch-policy-settings.js";
import "./styles.css";
import "./codex-theme.css";
import { CodexNavigation } from "./codex-navigation.js";
import { FleetCabinet } from "./fleet/FleetCabinet.js";
import { creationModels } from "./creation-models.js";
import { groupSessionMessages } from "./message-groups.js";
import { MessageAdmissionDispatcher, appendOutboxEntry, beginOutboxAttempt, canDeleteOutboxEntry, canSteerOutboxEntry, cancelOutcomeOfJobState, classifyMessageDelivery, deliveryConnectionFailure, deliveryModeLabel, isOutboxUnfinished, isTerminalJobState, newInputId, outboxStatusLabel, readOutboxJobId, readStoredOutbox, reconcileMessageStatus, removeOutboxEntry, updateOutboxEntry, withOutboxJobId, writeStoredOutbox, type CancelOutcome, type DeliveryMode, type OutboxEntry } from "./composer-delivery.js";
import { formatJsonPayload, readJsonRenderingOptOut, splitSystemBlocks, writeJsonRenderingOptOut } from "./json-rendering.js";
import { applyTheme, readTheme, writeTheme, type HerderTheme } from "./theme.js";
import { currentModelOption, modelSwitchSupported, requestModelChange, shortModelLabel } from "./model-chip.js";
import type { SessionMessageView } from "../types/index.js";

type HerderSession = SessionListSession & {
  lastMessage?: string;
  model?: string;
  needsPermission?: boolean;
  messageCount?: number;
  durationSec?: number;
  costUsd?: number;
};
type SessionMessage = SessionMessageView;
type SessionDetails = { session: HerderSession; lineage?: { kind?: string; parentId?: string; role?: string; task?: string }; children?: HerderSession[]; messages: SessionMessage[] };
type StatisticsDistribution = { count: number; percentilesSec: { p50: number; p75: number; p90: number; p95: number; p99: number }; coverage: Array<{ seconds: number; count: number; percent: number }>; histogram: Array<{ label: string; minSec: number; maxSec?: number; count: number; percent: number }> };
type NumericSummary = { count: number; mean: number; median: number; p75: number; p90: number; p95: number; p99: number; min: number; max: number };
type RankedCount = { name: string; count: number; percent: number };
type SessionPortfolioStatistics = { observedSessions: number; tokenCoveragePercent: number; durationCoveragePercent: number; modelCoveragePercent: number; harnesses: RankedCount[]; models: RankedCount[]; tokens: NumericSummary; durationSec: NumericSummary; sessionsByDay: Array<{ day: string; count: number }>; caveat: string };
type CodexDeepStatistics = { sessions: number; tokenCoveragePercent: number; modelCoveragePercent: number; durationCoveragePercent: number; tokens: NumericSummary; durationSec: NumericSummary; models: RankedCount[]; sessionsByDay: Array<{ day: string; count: number }> };
type AgentActivityStatistics = {
  schemaVersion: 2; generatedAt: string; windowDays: number;
  source: { harness: string; writeSignal: string; confidence: string; caveat: string };
  sample: { sessionFiles: number; sessionsWithPatches: number; toolCalls: number; toolIntervals: number; patchCalls: number; pathWriteEvents: number; sameFileSeries: number; repeatedFileSeries: number };
  activityGaps: StatisticsDistribution; sameFileRevisits: StatisticsDistribution; sameDirectoryRevisits: StatisticsDistribution;
  recommendation: { inactivityLeaseSec: number; basis: string; sameFileCoverageAtLeasePercent: number };
  codexDeep: CodexDeepStatistics;
  portfolio?: SessionPortfolioStatistics;
};
type WebAutopilotChoice = { choiceId: string; label: string };
type WebAutopilotChoiceCard = { requestId: string; sessionId: string; harness: string; cwd: string; status: "pending"; createdAt: string; choices: WebAutopilotChoice[] };
type AutopilotHarness = "codex" | "opencode" | "claude" | "hermes" | "zcode";
type WebAutopilotPolicy = {
  schemaVersion: 1;
  enabled: boolean;
  harnesses: AutopilotHarness[];
  scope: { mode: "all_ingress" } | { mode: "allowlist"; selectors: unknown[] };
  maxContinuationsPerSession: number;
  timeout: { mode: "hold" | "auto_continue"; delayMs: number };
  card: { includeUserMessage: boolean; includeAssistantMessage: boolean; includeReason: boolean };
};
type WebAutopilotPolicyState = { policy: WebAutopilotPolicy; source: "persisted" | "legacy" | "default" | "error"; revision: string; coverage: string; error?: string };
type WebAutopilotSession = { harness: string; sessionId: string; enabled: boolean; source: "session" | "policy" | "plugin-default" | "default"; cwd?: string; updatedAt?: string };
type WebSessionAutostart = { harness: string; sessionId: string; enabled: boolean; source: "session" | "harness" | "global" | "default"; cwd?: string; updatedAt?: string };
type WebSessionAutostartHarness = { harness: "codex" | "zcode"; enabled: boolean; source: "harness" | "global" | "default"; updatedAt?: string };
type WebSessionRuntimeSettings = { version: number; enabled: boolean; pinActiveSessions?: boolean; rolloverExpiredCache?: boolean; movePinnedOnRollover?: boolean; inventoryWindowHours: number; evidenceMessageCount: number; recoverOnFailure?: boolean; recoverOnDisconnect?: boolean; watchdogEnabled?: boolean; watchdogIntervalSeconds?: number; stalledTurnMinutes?: number; judgeModel: string; autopilotJudgeModel: string; source: "persisted" | "default" };
type WebModelOption = { model: string; harness: string };
type HerderJobState = "queued" | "running" | "waiting" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted";
type HerderJob = { id: string; kind: string; state: HerderJobState; createdAt: string; updatedAt: string; ownerSessionId?: string; progress?: number; statusMessage?: string; result?: unknown; error?: string; resultRef: string };

const AUTOPILOT_HARNESS_LABELS: Record<AutopilotHarness, string> = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
  hermes: "Hermes",
  zcode: "ZCode",
};
const AUTOCONTINUE_HARNESSES = new Set(["codex", "zcode"]);

const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) } });
  if (!response.ok) {
    const failure = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(failure?.error || `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
};
const keyOf = sessionKey;
const splitKey = (key: string) => {
  const separator = key.indexOf(":");
  return { harness: key.slice(0, separator), id: key.slice(separator + 1) };
};

// deep link: #/session/<harness>:<id> — восстанавливает выбор сессии из URL
const readSessionFromHash = (): string | undefined => {
  return sessionKeyFromHash(window.location.hash);
};
const writeSessionToHash = (key?: string) => {
  const target = key ? `#/session/${encodeURIComponent(key)}` : `${window.location.pathname}${window.location.search}`;
  if (window.location.hash !== (key ? target : "")) {
    history.replaceState(null, "", key ? target : target || window.location.pathname);
  }
};
const formatTime = (value: string) => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(timestamp) : "";
};
const formatLoadTiming = (value?: number) => {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
};

const formatSessionAge = (value: string, now = Date.now()) => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const ageMs = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (ageMs < minute) return "только что";
  if (ageMs < hour) return `${Math.floor(ageMs / minute)} мин`;
  if (ageMs < day) return `${Math.floor(ageMs / hour)} ч`;
  if (ageMs < 2 * day) return "вчера";
  return `${Math.max(1, Math.floor(ageMs / (30 * day)))} мес`;
};
const statusLabel = (status: string) => {
  switch (status) {
    case "running": return "Работает";
    case "needs_input": return "Ждёт ответа";
    case "waiting": return "Ожидает выбора";
    case "error": return "Ошибка";
    case "idle": return "Ожидает запуска";
    case "stopped":
    case "completed": return "Остановлена";
    case "archived": return "В архиве";
    default: return status;
  }
};
const statusClass = (status: string) => {
  switch (status) {
    case "running": return "running";
    case "waiting":
    case "needs_input": return "waiting";
    case "error": return "error";
    case "idle": return "idle";
    default: return "stopped";
  }
};
const jobStateLabel = (state: HerderJobState) => ({
  queued: "В очереди",
  running: "Выполняется",
  waiting: "Ожидание",
  cancelling: "Отмена",
  completed: "Завершена",
  failed: "Ошибка",
  cancelled: "Отменена",
  interrupted: "Прервана",
}[state] ?? state);
const SHOW_DEBUG_TIMINGS = new URLSearchParams(window.location.search).has("debug");

const stripServiceMarkers = (raw: string): { text: string; attachments: number } => {
  let text = raw;
  let attachments = 0;
  const requestMatch = text.match(/##\s*My\s+request:\s*/i);
  if (requestMatch && requestMatch.index !== undefined) text = text.slice(requestMatch.index + requestMatch[0].length);
  const filesMatch = text.match(/#\s*Files\s+(?:mentioned|pasted)\s+by\s+the\s+user[^\n]*\n?/i);
  if (filesMatch && filesMatch.index !== undefined) {
    const after = text.slice(filesMatch.index + filesMatch[0].length);
    const listBlock = after.match(/^[ \t]*[-*][ \t]+[^\n]*\n?/m);
    if (listBlock) {
      const listEnd = after.indexOf(listBlock[0]) + (after.slice(after.indexOf(listBlock[0])).match(/^(?:[ \t]*[-*][ \t]+[^\n]*\n?)+/)?.[0].length ?? listBlock[0].length);
      attachments = (after.slice(after.indexOf(listBlock[0]), listEnd).match(/[-*]/g) || []).length;
      text = text.slice(0, filesMatch.index) + after.slice(listEnd);
    } else text = text.slice(0, filesMatch.index) + after;
  }
  text = text
    .replace(/##\s*codex-clipboard-\S*/gi, "")
    .replace(/Image\s+attachment:\s*(?:true|false)/gi, "")
    .replace(/Distinguish\s+instructions\s+in\s+attached\s+documents[^\n]*/gi, "");
  text = text.replace(/^#{1,6}[ \t]*/gm, "").replace(/<agent-herder-[^>]*>/g, " ");
  return { text, attachments };
};
const cleanSessionTitle = (raw?: string): string => {
  if (!raw) return "";
  const { text, attachments } = stripServiceMarkers(raw);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const chosen = lines.find((line) => !/^[-*+]\s/.test(line) && !/^</.test(line)) || lines[0] || "";
  const clean = chosen.replace(/^[-*+]\s*/, "").trim();
  return `${attachments > 0 ? `📎 ${attachments} ф. ` : ""}${clean}`.trim();
};
const cleanPreview = (raw?: string): string => {
  if (!raw) return "";
  const { text } = stripServiceMarkers(raw);
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
};
const lastSegment = (value?: string) => {
  if (!value) return "";
  const parts = value.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : value;
};
const shortModel = (value?: string) => (value ? value.split("/").pop() || value : "");

const SERVICE_NOTE_PATTERNS: Array<[RegExp, string]> = [
  [/^<agent-herder-coordination/, "Заметка координации"],
  [/^<agent-herder-deferred/, "Отложенные сообщения"],
  [/^<oai-mem-citation/, "Цитата памяти"],
  [/^<system-reminder/, "Системное напоминание"],
  [/^<context_/, "Служебный контекст"],
];
const serviceNoteLabel = (message: SessionMessage): string | undefined => {
  const text = (message.parts.find((part) => part.type === "text")?.text || message.text || "").trimStart();
  return SERVICE_NOTE_PATTERNS.find(([pattern]) => pattern.test(text))?.[1];
};

const formatDuration = (seconds?: number) => {
  if (!Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds as number));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours ? `${hours} ч ${minutes} мин` : `${minutes} мин ${total % 60} с`;
};
const metaNumber = (session: HerderSession, keys: string[]) => {
  for (const key of keys) {
    const value = session.meta?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
};

const formatStatDuration = (seconds: number) => {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} с`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(seconds < 600 ? 1 : 0)} мин`;
  return `${(seconds / 3600).toFixed(1)} ч`;
};
const formatStatCount = (value: number) => new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
const formatPercent = (value: number) => `${value.toFixed(value >= 10 ? 0 : 1)}%`;
const coverageFor = (distribution: StatisticsDistribution, seconds: number) => distribution.coverage.find((item) => item.seconds === seconds)?.percent || 0;

function StatisticsView({ statistics, loading, error, days, onDays, onRefresh }: {
  statistics?: AgentActivityStatistics; loading: boolean; error?: string; days: number; onDays: (days: number) => void; onRefresh: () => void;
}) {
  if (loading && !statistics) return <div className="statistics-loading"><div className="session-loading-orbit"><span /><span /><span /></div><strong>Анализирую активность агентов…</strong><small>Свежие транскрипты Codex сканируются один раз; результаты кэшируются на диске на час.</small></div>;
  if (!statistics) return <div className="statistics-loading"><strong>Статистика недоступна</strong><small>{error || "Данных об активности пока нет."}</small><button className="quiet-button" onClick={onRefresh}>Повторить</button></div>;
  const thresholds = [30, 60, 120, 180, 300];
  const maxHistogram = Math.max(1, ...statistics.sameFileRevisits.histogram.map((item) => item.percent));
  const p = statistics.sameFileRevisits.percentilesSec;
  const ap = statistics.activityGaps.percentilesSec;
  const portfolio = statistics.portfolio;
  const deep = statistics.codexDeep;
  const topHarnessMax = Math.max(1, ...(portfolio?.harnesses || []).map((item) => item.count));
  const topModelMax = Math.max(1, ...(portfolio?.models.slice(0, 8) || []).map((item) => item.count));
  const dayMax = Math.max(1, ...(deep.sessionsByDay || []).map((item) => item.count));
  return <div className="statistics-scroll"><div className="statistics-page">
    <div className="statistics-hero">
      <div><span className="eyebrow">АКТИВНОСТЬ АГЕНТОВ</span><h2>Статистика</h2><p>Замеры по реальным рабочим сессиям, а не синтетическим бенчмаркам. Учитываются подтверждённые изменения файлов в сессиях Codex.</p></div>
      <div className="statistics-controls"><div className="statistics-range">{[7, 30, 90].map((value) => <button className={days === value ? "active" : ""} aria-pressed={days === value} disabled={loading} key={value} onClick={() => onDays(value)}>{value} дн.</button>)}</div><button className="quiet-button" disabled={loading} onClick={onRefresh}>{loading ? `Обновляю ${days} дн.…` : "Обновить"}</button></div>
     </div>
     {error && <div className="statistics-warning">Последнее обновление не удалось: {error}</div>}
     {loading && <div className="history-loading-banner" role="status"><span className="inline-loading-dot" /> Пересчитываю статистику за {days} дней…</div>}
    <div className="statistics-cards">
      <article><span>Выборка сессий</span><strong>{formatStatCount(statistics.sample.sessionFiles)}</strong><small>{formatStatCount(statistics.sample.sessionsWithPatches)} с патчами · {statistics.windowDays} дн.</small></article>
      <article><span>События записи</span><strong>{formatStatCount(statistics.sample.pathWriteEvents)}</strong><small>{formatStatCount(statistics.sample.patchCalls)} подтверждённых серий изменений</small></article>
      <article><span>Возвраты к тому же файлу</span><strong>{formatStatCount(statistics.sameFileRevisits.count)}</strong><small>медиана {formatStatDuration(p.p50)} · p95 {formatStatDuration(p.p95)}</small></article>
      <article className="recommendation"><span>Рекомендуемый таймаут неактивности</span><strong>~{formatStatDuration(statistics.recommendation.inactivityLeaseSec)}</strong><small>p95 активности инструментов {formatStatDuration(ap.p95)} · продлевается, пока сессия активна</small></article>
    </div>

    {portfolio && <div className="statistics-grid landscape-grid">
      <section className="statistics-panel">
        <div className="statistics-panel-head"><div><span className="eyebrow">СМЕСЬ АГЕНТОВ</span><h3>Что реально используется</h3></div><small>{formatStatCount(portfolio.observedSessions)} сессий активны в этом окне</small></div>
        <div className="ranked-bars">{portfolio.harnesses.map((item) => <div className="ranked-row" key={item.name}><b>{item.name}</b><div><span style={{ width: `${item.count / topHarnessMax * 100}%` }} /></div><em>{item.count} · {formatPercent(item.percent)}</em></div>)}</div>
      </section>
      <section className="statistics-panel">
        <div className="statistics-panel-head"><div><span className="eyebrow">ПОПУЛЯРНЫЕ МОДЕЛИ</span><h3>Самые используемые модели</h3></div><small>известны для {formatPercent(portfolio.modelCoveragePercent)} недавних сессий</small></div>
        <div className="ranked-bars model-bars">{portfolio.models.slice(0, 8).map((item) => <div className="ranked-row" key={item.name}><b title={item.name}>{item.name}</b><div><span style={{ width: `${item.count / topModelMax * 100}%` }} /></div><em>{item.count}</em></div>)}</div>
      </section>
    </div>}

    <div className="statistics-cards session-metric-cards">
      <article><span>Длительность сессии Codex</span><strong>{formatStatDuration(deep.durationSec.median)}</strong><small>медиана · среднее {formatStatDuration(deep.durationSec.mean)} · p95 {formatStatDuration(deep.durationSec.p95)}</small></article>
      <article><span>Токены Codex за сессию</span><strong>{formatStatCount(deep.tokens.median)}</strong><small>медиана · среднее {formatStatCount(deep.tokens.mean)} · p95 {formatStatCount(deep.tokens.p95)}</small></article>
      <article><span>Покрытие токенами</span><strong>{formatPercent(deep.tokenCoveragePercent)}</strong><small>{formatStatCount(deep.tokens.count)} из {formatStatCount(deep.sessions)} сессий Codex отдают данные о токенах</small></article>
      <article><span>Покрытие токенами по портфелю</span><strong>{formatPercent(portfolio?.tokenCoveragePercent || 0)}</strong><small>все агенты · пустые поля исключены из средних</small></article>
    </div>

    <section className="statistics-panel">
      <div className="statistics-panel-head"><div><span className="eyebrow">ОБЪЁМ СЕССИЙ</span><h3>Сессии Codex по дням</h3></div><small>глубокая выборка за {statistics.windowDays} дн.</small></div>
      <div className="daily-chart">{deep.sessionsByDay.map((item) => <div className="daily-column" key={item.day} title={`${item.day}: ${item.count} сессий`}><span style={{ height: `${Math.max(3, item.count / dayMax * 100)}%` }} /><b>{item.day.slice(5)}</b></div>)}</div>
    </section>

    <section className="statistics-panel">
      <div className="statistics-panel-head"><div><span className="eyebrow">ПОКРЫТИЕ ТАЙМАУТА</span><h3>Что реально покрывают разные таймауты</h3></div><small>Разрыв активности = следующее действие инструмента. Возврат к файлу = следующая запись в тот же путь.</small></div>
      <div className="coverage-legend"><span><i className="activity" />Следующая активность агента</span><span><i className="revisit" />Возврат к тому же файлу</span></div>
      <div className="coverage-chart">{thresholds.map((seconds) => { const activity = coverageFor(statistics.activityGaps, seconds); const revisit = coverageFor(statistics.sameFileRevisits, seconds); return <div className="coverage-row" key={seconds}><b>{formatStatDuration(seconds)}</b><div className="coverage-bars"><div className="coverage-bar activity" style={{ width: `${activity}%` }}><span>{activity.toFixed(1)}%</span></div><div className="coverage-bar revisit" style={{ width: `${revisit}%` }}><span>{revisit.toFixed(1)}%</span></div></div></div>; })}</div>
      <p className="statistics-explainer">Короткий таймаут может быть корректен, даже если агенты часто возвращаются к тому же файлу гораздо позже: резервации должны жить на сигналах активности сессии, а не только на повторных записях в этот файл.</p>
    </section>

    <div className="statistics-grid">
      <section className="statistics-panel">
        <div className="statistics-panel-head"><div><span className="eyebrow">ТОТ ЖЕ ФАЙЛ</span><h3>Распределение возвратов к записи</h3></div><small>{formatStatCount(statistics.sameFileRevisits.count)} интервалов</small></div>
        <div className="histogram">{statistics.sameFileRevisits.histogram.map((item) => <div className="histogram-column" key={item.label}><div className="histogram-value">{item.percent.toFixed(1)}%</div><div className="histogram-track"><span style={{ height: `${Math.max(3, item.percent / maxHistogram * 100)}%` }} /></div><b>{item.label}</b></div>)}</div>
      </section>
      <section className="statistics-panel">
        <div className="statistics-panel-head"><div><span className="eyebrow">ПЕРЦЕНТИЛИ</span><h3>Насколько длинными бывают паузы</h3></div></div>
        <div className="percentile-table"><div className="percentile-head"><span>Перцентиль</span><span>Любая активность</span><span>Тот же файл</span></div>{(["p50","p75","p90","p95","p99"] as const).map((key) => <div className="percentile-row" key={key}><b>{key.toUpperCase()}</b><span>{formatStatDuration(ap[key])}</span><span>{formatStatDuration(p[key])}</span></div>)}</div>
      </section>
    </div>

    <section className="statistics-panel statistics-method">
      <div><span className="eyebrow">МЕТОДИКА</span><h3>Что именно измеряется</h3></div>
      <p>{statistics.source.caveat} {portfolio?.caveat || ""}</p>
      <div className="method-facts"><span><b>{formatStatCount(statistics.sample.toolCalls)}</b> вызовов инструментов</span><span><b>{formatStatCount(statistics.activityGaps.count)}</b> интервалов активности</span><span><b>{formatStatCount(statistics.sample.repeatedFileSeries)}</b> многократно правленных файлов</span><span><b>{new Date(statistics.generatedAt).toLocaleTimeString()}</b> сформировано</span></div>
    </section>
  </div></div>;
}

function JobsView({ jobs, loading, error, cancellingJobId, onRefresh, onCancel }: {
  jobs: HerderJob[]; loading: boolean; error?: string; cancellingJobId?: string; onRefresh: () => void; onCancel: (jobId: string) => void;
}) {
  const active = jobs.filter((job) => job.state === "queued" || job.state === "running" || job.state === "waiting" || job.state === "cancelling").length;
  const failed = jobs.filter((job) => job.state === "failed" || job.state === "interrupted").length;
  return <div className="jobs-scroll"><div className="jobs-page">
    <div className="jobs-hero">
      <div><span className="eyebrow">УПРАВЛЕНИЕ</span><h2>Задачи</h2><p>Долгие операции Agent Herder переживают переподключение MCP. История завершённых задач сохраняется между перезапусками сервиса.</p></div>
      <div className="jobs-summary"><span><b>{active}</b> активных</span><span><b>{jobs.length}</b> в истории</span>{failed > 0 && <span className="jobs-failed-count"><b>{failed}</b> с ошибками</span>}<button className="quiet-button" disabled={loading} onClick={onRefresh}>{loading ? "Обновляю…" : "Обновить"}</button></div>
    </div>
    {error && <div className="statistics-warning">Не удалось обновить задачи: {error}</div>}
    {loading && jobs.length === 0 && <div className="statistics-loading"><div className="session-loading-orbit"><span /><span /><span /></div><strong>Загружаю задачи…</strong></div>}
    {!loading && jobs.length === 0 && <div className="jobs-empty">Задач пока нет. Здесь появятся фоновые экспорты, конвертации, браузерная работа и сверка.</div>}
    <div className="jobs-list">{jobs.map((job) => {
      const cancellable = job.state === "queued" || job.state === "running" || job.state === "waiting";
      const progress = Math.max(0, Math.min(1, job.progress ?? (job.state === "completed" ? 1 : 0)));
      return <article className={`job-card job-${job.state}`} key={job.id}>
        <div className="job-head"><div><span className={`job-state job-state-${job.state}`}>{jobStateLabel(job.state)}</span><strong>{job.kind}</strong></div><time title={new Date(job.updatedAt).toLocaleString()}>{formatSessionAge(job.updatedAt)}</time></div>
        <div className="job-progress"><span style={{ width: `${progress * 100}%` }} /></div>
        <div className="job-meta"><code>{job.id}</code>{job.ownerSessionId && <span>владелец · <code>{job.ownerSessionId}</code></span>}<span>обновлено · {new Date(job.updatedAt).toLocaleString()}</span></div>
        {job.statusMessage && <p className="job-status-message">{job.statusMessage}</p>}
        {job.error && <div className="job-error">{job.error}</div>}
        {job.result !== undefined && <details className="job-result"><summary>Результат</summary><pre>{JSON.stringify(job.result, null, 2)}</pre></details>}
        <div className="job-actions"><code>{job.resultRef}</code>{cancellable && <button className="danger-button" disabled={cancellingJobId === job.id} onClick={() => onCancel(job.id)}>{cancellingJobId === job.id ? "Отменяю…" : "Отмена"}</button>}</div>
      </article>;
    })}</div>
  </div></div>;
}

function Markdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>;
}

const SERVICE_BLOCK_BODY_LIMIT = 4000;

const TOOL_ACTION_LABELS: Array<[RegExp, string]> = [
  [/read|view|cat|open|glob|grep|search|find|list|ls/i, "Прочитал файлы"],
  [/shell|bash|exec|command|terminal|run/i, "Выполнил команды"],
  [/patch|edit|apply|write|update|create_file/i, "Изменил файлы"],
  [/plan|todo/i, "Обновил план"],
  [/fetch|http|web|browse/i, "Искал в интернете"],
];
/** Человекочитаемая строка действия инструмента вместо технического имени. */
const toolActionLabel = (name?: string) => {
  if (!name) return "Работа с инструментами";
  return TOOL_ACTION_LABELS.find(([pattern]) => pattern.test(name))?.[1] || name;
};
/** Несколько имён инструментов сворачиваются в одну короткую строку действий. */
const toolActionsSummary = (names: string[]) => {
  const labels: string[] = [];
  for (const name of names) {
    const label = toolActionLabel(name);
    if (!labels.includes(label)) labels.push(label);
  }
  const head = labels.slice(0, 3).join(" ");
  return labels.length > 3 ? `${head} и ещё ${labels.length - 3}` : head;
};
/** «12 мин 26 с» — длительность без секундной каши. */
const formatElapsed = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours ? `${hours} ч ${minutes} мин ${seconds} с` : `${minutes} мин ${seconds} с`;
};
/** Момент, с которого сессия работает: из meta сессии, иначе — с момента наблюдения. */
const runningSinceMs = (session?: HerderSession) => {
  for (const key of ["running_since", "runningSince", "started_at", "startedAt"]) {
    const value = session?.meta?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value > 1e11 ? value : value * 1000;
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
};
/** Живой счётчик длительности: обновляет только себя, а не всю ленту переписки. */
function ActivityElapsed({ sinceMs, prefix = "Работает уже " }: { sinceMs?: number; prefix?: string }) {
  const [now, setNow] = React.useState(() => Date.now());
  const observedRef = React.useRef<number | undefined>(undefined);
  React.useEffect(() => {
    if (sinceMs) observedRef.current = undefined;
    else if (observedRef.current === undefined) observedRef.current = Date.now();
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [sinceMs]);
  const start = sinceMs ?? observedRef.current;
  return <>{prefix}{start === undefined ? "…" : formatElapsed(now - start)}</>;
}

function JsonMessageBlock({ json }: { json: string }) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return <div className="json-message">
    <div className="json-message-head">
      <span className="json-message-label">JSON</span>
      <span className="json-message-hint">агент ответил данными — показан машиночитаемым видом</span>
      <button type="button" className="json-message-copy" onClick={() => void copy()}>{copied ? "Скопировано" : "Копировать"}</button>
    </div>
    <pre className="json-message-body">{json}</pre>
  </div>;
}

type MessagePartItem = { kind: "single"; part: SessionMessage["parts"][number]; key: string } | { kind: "tools"; parts: SessionMessage["parts"]; key: string };

/** Подряд идущие действия инструментов — одна приглушённая строка с маленькой иконкой;
    каждый вызов и его вывод остаются внутри, раскрываются по клику. */
function ToolActionsGroup({ parts, groupKey }: { parts: SessionMessage["parts"]; groupKey: string }) {
  return <details className="tool-actions" key={groupKey}>
    <summary><span className="tool-actions-icon" aria-hidden="true">⌘</span><span>{toolActionsSummary(parts.map((part) => part.name || ""))}</span></summary>
    <div className="tool-actions-body">{parts.map((part, index) => <div className="tool-actions-item" key={`${groupKey}:tool:${index}`}>
      <b>{part.name || (part.type === "tool_call" ? "Вызов инструмента" : "Результат инструмента")}{part.error === true ? " · ошибка" : ""}</b>
      <pre>{part.output || (part.input ? JSON.stringify(part.input, null, 2) : "")}</pre>
    </div>)}</div>
  </details>;
}

function MessageParts({ message, showReasoning, showTools, jsonRendering }: { message: SessionMessage; showReasoning: boolean; showTools: boolean; jsonRendering: boolean }) {
  const parts: SessionMessage["parts"] = message.parts.length > 0 ? message.parts : message.text ? [{ type: "text", text: message.text }] : [];
  const items: MessagePartItem[] = [];
  parts.forEach((part, index) => {
    const partKey = `${message.id}:${index}`;
    if (part.type === "tool_call" || part.type === "tool_result") {
      if (!showTools) return;
      const previous = items[items.length - 1];
      if (previous && previous.kind === "tools") { previous.parts.push(part); return; }
      items.push({ kind: "tools", parts: [part], key: partKey });
      return;
    }
    if (part.type === "thinking" && !showReasoning) return;
    items.push({ kind: "single", part, key: partKey });
  });
  return <>
    {items.map((item) => {
      if (item.kind === "tools") return <ToolActionsGroup groupKey={item.key} parts={item.parts} />;
      const part = item.part;
      if (part.type === "text") {
        const { text, blocks } = splitSystemBlocks(part.text || "");
        const jsonText = jsonRendering ? formatJsonPayload(text) : undefined;
        return <div className="markdown-content" key={item.key}>
          {jsonText ? <JsonMessageBlock json={jsonText} /> : text && <Markdown>{text}</Markdown>}
          {blocks.map((block, blockIndex) => (
            <details className="service-note part-service-note" key={`${item.key}:sys:${blockIndex}`}>
              <summary className="service-note-head"><span className="service-note-label">{block.label}</span></summary>
              <pre className="service-note-body">{block.body.length > SERVICE_BLOCK_BODY_LIMIT ? `${block.body.slice(0, SERVICE_BLOCK_BODY_LIMIT)}\n… ещё ${block.body.length - SERVICE_BLOCK_BODY_LIMIT} символов` : block.body}</pre>
            </details>
          ))}
        </div>;
      }
      return <details className="oc-disclosure" key={item.key}><summary>Размышления</summary><pre>{part.text}</pre></details>;
    })}
  </>;
}

function hasVisibleMessage(message: SessionMessage, showReasoning: boolean, showTools: boolean): boolean {
  const parts = message.parts.length > 0 ? message.parts : message.text ? [{ type: "text" as const, text: message.text }] : [];
  return parts.some((part) => part.type === "text" && Boolean(part.text?.trim())
    || part.type === "thinking" && showReasoning && Boolean(part.text?.trim())
    || (part.type === "tool_call" || part.type === "tool_result") && showTools);
}

function CollapsibleMessage({ message, showReasoning, showTools, jsonRendering, forceExpanded }: { message: SessionMessage; showReasoning: boolean; showTools: boolean; jsonRendering: boolean; forceExpanded?: boolean }) {
  const [expanded, setExpanded] = React.useState(false);
  // Считаем видимую длину: служебные блоки свёрнуты, а JSON показан с форматированием.
  const bodyText = (message.parts.length > 0 ? message.parts : message.text ? [{ type: "text" as const, text: message.text }] : [])
    .map((part) => {
      if (part.type !== "text") return [part.text, part.output].filter((value): value is string => Boolean(value)).join("\n");
      const visible = splitSystemBlocks(part.text || "").text;
      return formatJsonPayload(visible) ?? visible;
    }).join("\n");
  const lineCount = bodyText.split("\n").length;
  const isLong = lineCount > 24 || bodyText.length > 1500;
  const collapsed = isLong && !expanded && !forceExpanded;
  return <div className={`message-body ${collapsed ? "message-collapsed" : ""}`}>
    <MessageParts message={message} showReasoning={showReasoning} showTools={showTools} jsonRendering={jsonRendering} />
    {collapsed && <button type="button" className="message-expand" onClick={() => setExpanded(true)}>Показать полностью</button>}
    {!collapsed && isLong && !forceExpanded && <button type="button" className="message-expand" onClick={() => setExpanded(false)}>Свернуть</button>}
  </div>;
}

function ServiceNote({ label, message }: { label: string; message: SessionMessage }) {
  const [open, setOpen] = React.useState(false);
  const text = (message.parts.find((part) => part.type === "text")?.text || message.text || "").replace(/\s+/g, " ").trim();
  const preview = text.length > 140 ? `${text.slice(0, 140)}…` : text;
  return <div className={`service-note ${open ? "service-note-open" : ""}`}>
    <button type="button" className="service-note-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}><span className="service-note-label">{label}</span><small>{preview}</small></button>
    {open && <div className="service-note-body"><pre>{text}</pre></div>}
  </div>;
}

function AutomationSettings({ section, state, draft, saving, error, saved, continuation, continuationSaving, continuationError, runtimeState, runtimeDraft, runtimeSaving, runtimeSaved, runtimeError, modelOptions, sessionControlAvailable, sessionControlStatus, capabilityNote, onChange, onSave, onGlobalContinuationToggle, onContinuationToggle, onRuntimeChange, onRuntimeSave, onOpenSessionControl }: {
  section: "autocontinue" | "autopilot";
  state?: WebAutopilotPolicyState;
  draft?: WebAutopilotPolicy;
  saving: boolean;
  error?: string;
  saved: boolean;
  continuation: Partial<Record<"codex" | "zcode", WebSessionAutostartHarness>>;
  continuationSaving?: "codex" | "zcode";
  continuationError?: string;
  runtimeState?: WebSessionRuntimeSettings;
  runtimeDraft?: WebSessionRuntimeSettings;
  runtimeSaving: boolean;
  runtimeSaved: boolean;
  runtimeError?: string;
  modelOptions: WebModelOption[];
  sessionControlAvailable: boolean;
  sessionControlStatus?: string;
  capabilityNote?: string;
  onChange: (next: WebAutopilotPolicy) => void;
  onSave: () => void;
  onGlobalContinuationToggle: () => void;
  onContinuationToggle: (harness: "codex" | "zcode") => void;
  onRuntimeChange: (next: WebSessionRuntimeSettings) => void;
  onRuntimeSave: () => void;
  onOpenSessionControl: () => void;
}) {
  if (section === "autocontinue") return <section className="global-autopilot-card" aria-label="Общие настройки автопродолжения">
    <div className="global-autopilot-head">
      <div><span className="eyebrow">АВТОПРОДОЛЖЕНИЕ</span><h3>Общее автопродолжение</h3><p>Восстанавливает ту же сессию после подтверждённой ошибки, обрыва связи или зависания. Незавершённые задачи оценивает и продолжает автопилот.</p></div>
      {runtimeDraft && <button className={`switch-control large ${runtimeDraft.enabled ? "enabled" : ""}`} role="switch" aria-checked={runtimeDraft.enabled} aria-label="Общее автопродолжение" disabled={runtimeSaving} onClick={onGlobalContinuationToggle}><span /></button>}
    </div>
    {runtimeDraft && <div className={`autopilot-state-banner ${runtimeDraft.enabled ? "enabled" : ""}`}><strong>{runtimeDraft.enabled ? "Автопродолжение включено" : "Автопродолжение выключено"}</strong><span>Это общий переключатель. Настройки для Codex, ZCode и активной сессии могут его переопределить; автопилот не изменяется.</span></div>}
    {sessionControlAvailable && <div className="settings-save-row session-settings-link"><span><strong>{sessionControlStatus || "Только для текущей сессии"}</strong><small>Отдельная настройка применяется сразу и переопределяет общую только для этой сессии.</small></span><button className="quiet-button" onClick={onOpenSessionControl}>Настроить текущую сессию</button></div>}
    {runtimeDraft && <details className="settings-advanced"><summary>Дополнительно: закрепление сессий</summary><fieldset className="settings-group"><legend>Закрепление сессий</legend><label className="runtime-toggle-setting timeout-setting"><span><strong>Сразу закреплять активные сессии</strong><small>Сессия Codex или ZCode закрепляется при начале работы или успешном автопродолжении. Herder не снимает закрепление после завершения — снимите его сами после проверки результата.</small></span><input type="checkbox" checked={runtimeDraft.pinActiveSessions ?? true} onChange={(event) => onRuntimeChange({ ...runtimeDraft, pinActiveSessions: event.target.checked })} /></label></fieldset></details>}
    <fieldset className="settings-group"><legend>Где разрешено восстановление</legend><div className="harness-grid">
      {(["codex", "zcode"] as const).map((harness) => {
        const setting = continuation[harness];
        const enabled = setting?.enabled ?? true;
        return <label className={`harness-option ${enabled ? "selected" : ""}`} key={`continuation-${harness}`}><input type="checkbox" checked={enabled} disabled={!setting || continuationSaving === harness} onChange={() => onContinuationToggle(harness)} /><span><strong>{AUTOPILOT_HARNESS_LABELS[harness]}</strong><small>{enabled ? "Продолжение исходной сессии разрешено" : "Автопродолжение выключено"}</small></span></label>;
      })}
    </div><p className="settings-help">Приоритет: отдельная настройка сессии → настройка среды → общий переключатель. Автопродолжение восстанавливает аварийно прерванную работу. Если автопилот выключен, восстановление после сбоя всё равно работает, но обычные незавершённые задачи не запускаются.</p>{continuationError && <small className="autopilot-error">{continuationError}</small>}</fieldset>

    {runtimeDraft && <><fieldset className="settings-group"><legend>Восстановление после сбоя</legend><label className="runtime-toggle-setting timeout-setting"><span><strong>После ошибки выполнения</strong><small>Herder повторно запускает работу только в той же сессии после подтверждённой ошибки агента.</small></span><input type="checkbox" checked={runtimeDraft.recoverOnFailure ?? true} onChange={(event) => onRuntimeChange({ ...runtimeDraft, recoverOnFailure: event.target.checked })} /></label><label className="runtime-toggle-setting timeout-setting"><span><strong>После разрыва соединения</strong><small>Herder восстанавливает ту же сессию, если связь с её процессом аварийно оборвалась.</small></span><input type="checkbox" checked={runtimeDraft.recoverOnDisconnect ?? true} onChange={(event) => onRuntimeChange({ ...runtimeDraft, recoverOnDisconnect: event.target.checked })} /></label><p className="settings-help">Завершённые и работающие сессии, ожидание ответа или разрешения человека и сессии, явно остановленные человеком, исключены. Незавершённые задачи разбирает автопилот.</p></fieldset><fieldset className="settings-group"><legend>Контроль зависания</legend><label className="runtime-toggle-setting timeout-setting"><span><strong>Восстанавливать зависшую работу по таймауту</strong><small>Дополнительная проверка включается отдельно и продолжает ту же сессию только после заданного времени без прогресса.</small></span><input type="checkbox" checked={runtimeDraft.watchdogEnabled ?? false} onChange={(event) => onRuntimeChange({ ...runtimeDraft, watchdogEnabled: event.target.checked })} /></label><div className="context-options runtime-settings-grid"><label><span><strong>Интервал проверки, секунд</strong></span><input type="number" min="5" max="300" disabled={!(runtimeDraft.watchdogEnabled ?? false)} value={runtimeDraft.watchdogIntervalSeconds ?? 10} onChange={(event) => onRuntimeChange({ ...runtimeDraft, watchdogIntervalSeconds: Math.min(300, Math.max(5, Number(event.target.value) || 10)) })} /></label><label><span><strong>Без прогресса, минут</strong></span><input type="number" min="1" max="120" disabled={!(runtimeDraft.watchdogEnabled ?? false)} value={runtimeDraft.stalledTurnMinutes ?? 2} onChange={(event) => onRuntimeChange({ ...runtimeDraft, stalledTurnMinutes: Math.min(120, Math.max(1, Number(event.target.value) || 2)) })} /></label></div></fieldset><div className="settings-save-row settings-footer"><span>{runtimeError ? <small className="autopilot-error">{runtimeError}</small> : runtimeSaved ? <small className="settings-saved">Настройки автопродолжения сохранены</small> : runtimeState && JSON.stringify(runtimeDraft) !== JSON.stringify(runtimeState) ? <small>Изменения ещё не применены. Закрытие оставит их в форме до сохранения или перезагрузки страницы.</small> : <small>Текущие настройки загружены</small>}</span><button className="primary-button" disabled={runtimeSaving || !runtimeDraft.judgeModel.trim()} onClick={onRuntimeSave}>{runtimeSaving ? "Сохраняю…" : "Сохранить автопродолжение"}</button></div></>}
  </section>;

  if (!draft) return <section className="global-autopilot-card"><span className="settings-loading">Загрузка настроек автопилота…</span></section>;
  const policyDirty = Boolean(state && JSON.stringify(draft) !== JSON.stringify(state.policy));
  const modelDirty = Boolean(runtimeState && runtimeDraft && runtimeDraft.autopilotJudgeModel !== runtimeState.autopilotJudgeModel);
  const timeoutMinutes = Math.max(1, Math.round(draft.timeout.delayMs / 60_000));
  const setHarness = (harness: AutopilotHarness, enabled: boolean) => onChange({
    ...draft,
    harnesses: enabled ? [...new Set([...draft.harnesses, harness])] : draft.harnesses.filter((item) => item !== harness),
  });
  const setCard = (key: keyof WebAutopilotPolicy["card"], enabled: boolean) => onChange({ ...draft, card: { ...draft.card, [key]: enabled } });
  return <section className="global-autopilot-card" aria-label="Общие настройки автопилота">
    <div className="global-autopilot-head">
      <div><span className="eyebrow">АВТОПИЛОТ</span><h3>Общий автопилот</h3><p>Автопилот решает: продолжить работу, завершить её или показать вам варианты. Эта настройка не включает автопродолжение.</p></div>
      <button className={`switch-control large ${draft.enabled ? "enabled" : ""}`} role="switch" aria-checked={draft.enabled} aria-label="Общий автопилот" onClick={() => onChange({ ...draft, enabled: !draft.enabled })}><span /></button>
    </div>
    <div className={`autopilot-state-banner ${draft.enabled ? "enabled" : ""}`}><strong>{draft.enabled ? "Автопилот включён" : "Автопилот выключен"}</strong><span>{draft.enabled ? "Работает в выбранных средах; настройки отдельных сессий могут переопределить режим." : "Новые завершения не оцениваются, кроме явно включённых сессий."}</span></div>
    {sessionControlAvailable && <div className="settings-save-row session-settings-link"><span><strong>{sessionControlStatus || "Только для текущей сессии"}</strong><small>Отдельная настройка применяется сразу и переопределяет общую только для этой сессии.</small></span><button className="quiet-button" onClick={onOpenSessionControl}>Настроить текущую сессию</button></div>}
    {capabilityNote && <div className="autopilot-state-banner"><strong>Доступные функции этой среды</strong><span>{capabilityNote}</span></div>}

    {runtimeDraft && <details className="settings-advanced"><summary>Дополнительно: модель автопилота</summary><fieldset className="settings-group"><legend>Модель автопилота</legend><div className="context-options runtime-settings-grid">
      <label><span><strong>Модель автопилота</strong><small>Можно выбрать модель из списка или ввести её идентификатор. Если не знаете, оставьте текущее значение.</small></span><input list="all-herder-models" value={runtimeDraft.autopilotJudgeModel} onChange={(event) => onRuntimeChange({ ...runtimeDraft, autopilotJudgeModel: event.target.value })} /></label>
      <datalist id="all-herder-models">{[...new Set([runtimeDraft.autopilotJudgeModel, ...modelOptions.map((item) => item.model)])].map((model) => <option value={model} key={`autopilot-${model}`} />)}</datalist>
    </div><p className="settings-help">Модель сохранится общей кнопкой «Сохранить настройки автопилота» ниже.</p></fieldset></details>}

    <fieldset className="settings-group"><legend>Где работает</legend><div className="harness-grid">
      {(Object.keys(AUTOPILOT_HARNESS_LABELS) as AutopilotHarness[]).map((harness) => <label className={`harness-option ${draft.harnesses.includes(harness) ? "selected" : ""}`} key={harness}><input type="checkbox" checked={draft.harnesses.includes(harness)} onChange={(event) => setHarness(harness, event.target.checked)} /><span><strong>{AUTOPILOT_HARNESS_LABELS[harness]}</strong><small>{harness === "codex" ? "Контроль завершения Codex" : harness === "claude" ? "Интеграция Claude Code" : harness === "opencode" ? "Интеграция OpenCode" : harness === "zcode" ? "Встроенная интеграция ZCode" : "Интеграция Hermes"}</small></span></label>)}
    </div><p className="settings-help">Приоритет: отдельная настройка сессии → выбор среды здесь → общий переключатель. Для одной сессии режим можно переопределить кнопкой «Настроить текущую сессию» выше.</p></fieldset>

    <fieldset className="settings-group"><legend>Если вы не ответили</legend><label className="timeout-setting"><input type="checkbox" checked={draft.timeout.mode === "auto_continue"} onChange={(event) => onChange({ ...draft, timeout: { ...draft.timeout, mode: event.target.checked ? "auto_continue" : "hold" } })} /><span><strong>{timeoutMinutes} минут без ответа → выбрать следующий шаг автоматически</strong><small>Карточка заранее покажет варианты и рекомендацию. После таймера будет выбран первый рекомендованный вариант. Если выключить — сессия ждёт вас без таймера.</small></span></label><label className="minutes-control">Через <input type="number" min="1" max="10080" value={timeoutMinutes} disabled={draft.timeout.mode === "hold"} onChange={(event) => onChange({ ...draft, timeout: { ...draft.timeout, delayMs: Math.max(1, Number(event.target.value) || 1) * 60_000 } })} /> минут</label></fieldset>

    <details className="settings-advanced"><summary>Дополнительно: содержимое сообщения</summary><fieldset className="settings-group"><legend>Что показывать вам в сообщении автопилота</legend><div className="context-options">
      <label><input type="checkbox" checked={draft.card.includeUserMessage} onChange={(event) => setCard("includeUserMessage", event.target.checked)} /> Последний запрос пользователя</label>
      <label><input type="checkbox" checked={draft.card.includeAssistantMessage} onChange={(event) => setCard("includeAssistantMessage", event.target.checked)} /> Последний ответ агента</label>
      <label><input type="checkbox" checked={draft.card.includeReason} onChange={(event) => setCard("includeReason", event.target.checked)} /> Почему нужен выбор</label>
    </div></fieldset></details>

    <div className="settings-save-row settings-footer"><span>{error || runtimeError ? <small className="autopilot-error">{error || runtimeError}</small> : saved && runtimeSaved ? <small className="settings-saved">Настройки сохранены</small> : policyDirty || modelDirty ? <small>Изменения ещё не применены. Закрытие оставит их в форме до сохранения или перезагрузки страницы.</small> : <small>Текущие настройки загружены</small>}</span><button className="primary-button" disabled={saving || runtimeSaving || !runtimeDraft?.autopilotJudgeModel.trim()} onClick={() => { onRuntimeSave(); onSave(); }}>{saving || runtimeSaving ? "Сохраняю…" : "Сохранить настройки автопилота"}</button></div>
  </section>;
}

function SessionList({ entries, activeKey, loading, refreshing, settings, settingsOpen, searchOpen, searchQuery, options, choicesBySession, choosingRequestId, choiceError, collapsedChildren, onSearchChange, onSearchToggle, onSettingsChange, onSettingsToggle, onToggleChildren, onSelect, onChoose, onNewSession }: {
  entries: SessionListEntry[];
  activeKey?: string;
  loading: boolean;
  refreshing: boolean;
  settings: SessionListSettings;
  settingsOpen: boolean;
  searchOpen: boolean;
  searchQuery: string;
  options: { cwds: string[]; projects: string[]; harnesses: string[] };
  choicesBySession: ReadonlyMap<string, WebAutopilotChoiceCard>;
  choosingRequestId?: string;
  choiceError?: { requestId: string; message: string };
  collapsedChildren: ReadonlySet<string>;
  onSearchChange: (query: string) => void;
  onSearchToggle: () => void;
  onSettingsChange: (patch: Partial<SessionListSettings>) => void;
  onSettingsToggle: () => void;
  onToggleChildren: (key: string) => void;
  onSelect: (key: string) => void;
  onChoose: (requestId: string, choiceId: string) => void;
  onNewSession: () => void;
}) {
  return <nav className="sessions-pane" aria-label="Сессии">
    <div className="sessions-heading"><div><span className="eyebrow">AGENT HERDER</span><h1>Сессии {refreshing && <span className="inline-loading-dot" role="status" aria-label="Обновление сессий" />}</h1></div><div className="sessions-heading-actions"><button type="button" className="icon-button" aria-label="Новая сессия" title="Новая сессия" onClick={onNewSession}>+</button><button className={`icon-button ${searchOpen ? "selected-icon" : ""}`} aria-label="Поиск сессий" aria-expanded={searchOpen} onClick={onSearchToggle}>⌕</button><button className={`icon-button ${settingsOpen ? "selected-icon" : ""}`} aria-label="Настройки списка" aria-expanded={settingsOpen} onClick={onSettingsToggle}>⚙</button></div></div>
    {searchOpen && <div className="session-search"><input autoFocus value={searchQuery} onChange={(event) => onSearchChange(event.target.value)} placeholder="Поиск: название, агент, проект…" aria-label="Поиск по сессиям" /></div>}
    {settingsOpen && <div className="session-settings" aria-label="Настройки списка сессий">
      <label>Папка<select value={settings.cwd} onChange={(event) => onSettingsChange({ cwd: event.target.value })}><option value="">Все папки</option>{options.cwds.map((cwd) => <option value={cwd} key={cwd}>{cwd}</option>)}</select></label>
      <label>Проект<select value={settings.project} onChange={(event) => onSettingsChange({ project: event.target.value })}><option value="">Все проекты</option>{options.projects.map((project) => <option value={project} key={project}>{project}</option>)}</select></label>
      <label>Агент<select value={settings.harness} onChange={(event) => onSettingsChange({ harness: event.target.value })}><option value="">Все агенты</option>{options.harnesses.map((harness) => <option value={harness} key={harness}>{harness}</option>)}</select></label>
      <label>Сортировка<select value={settings.sort} onChange={(event) => onSettingsChange({ sort: event.target.value as SessionListSort })}><option value="activity">По активности</option><option value="status">По статусу</option><option value="harness">По агенту</option><option value="title">По названию</option><option value="cwd">По папке</option></select></label>
      <label className="session-toggle"><input type="checkbox" aria-label="Показывать все сессии" checked={settings.showAll} onChange={(event) => onSettingsChange({ showAll: event.target.checked })} /> Показывать завершённые сессии</label>
    </div>}
    <div className="session-list" role="list" aria-label="Сессии">
      {entries.map(({ session, depth, hasChildren }) => {
        const key = keyOf(session);
        const decision = choicesBySession.get(key);
        const title = cleanSessionTitle(session.title) || session.title || session.id;
        const awaitingPermission = decision === undefined && session.needsPermission === true;
        const label = decision ? "Ожидает выбора" : awaitingPermission ? "Ждёт вашего решения" : statusLabel(session.status);
        const statusClassValue = decision || awaitingPermission ? "waiting" : statusClass(session.status);
        return <div className="session-row-wrap" role="listitem" style={{ "--depth": depth } as React.CSSProperties} key={key}>
          {hasChildren ? <button className="session-fold" aria-label={`Дочерние сессии: ${title}`} onClick={() => onToggleChildren(key)}>{collapsedChildren.has(key) ? "›" : "⌄"}</button> : <span className="session-fold-placeholder" />}
          <div className="session-card">
            <button className={`session-row ${key === activeKey ? "selected" : ""}`} aria-label={`${title}, ${session.harness}, ${label}`} onClick={() => onSelect(key)}>
              <span className={`status-dot status-${statusClassValue}`} aria-hidden="true" />
              <span className="session-copy"><strong title={session.title || session.id}>{title}</strong><small>{session.harness} · <span className={`status-label status-${statusClassValue}`}>{label}</span></small><small className="session-preview">{cleanPreview(session.lastMessage) || session.cwd}</small></span>
              <time title={new Date(session.lastActivity).toLocaleString()}>{formatSessionAge(session.lastActivity)}</time>
            </button>
            {decision && <div className="choice-card" aria-label={`Варианты автопилота для ${title}`}>
              <strong>Что делать дальше?</strong>
              {decision.choices.map((choice) => <button className="choice-button" aria-label={`Выбрать: ${choice.label}`} disabled={choosingRequestId === decision.requestId} key={choice.choiceId} onClick={() => onChoose(decision.requestId, choice.choiceId)}>{choice.label}</button>)}
              {choiceError?.requestId === decision.requestId && <small className="choice-error">{choiceError.message}</small>}
            </div>}
          </div>
        </div>;
      })}
      {loading && entries.length === 0 && <div className="session-skeletons" aria-label="Загрузка сессий">{Array.from({ length: 8 }, (_, index) => <div className="session-skeleton" key={index}><span /><div><b /><i /><i /></div></div>)}</div>}
      {!loading && entries.length === 0 && <div className="empty-list">Нет сессий по этим настройкам.</div>}
    </div>
  </nav>;
}

function App() {
  const [sessions, setSessions] = React.useState<HerderSession[]>([]);
  const [activeKey, setActiveKey] = React.useState<string | undefined>(() => readSessionFromHash() ?? window.localStorage.getItem("agent-herder.active-session") ?? undefined);
  const activeKeyRef = React.useRef(activeKey);
  React.useLayoutEffect(() => { activeKeyRef.current = activeKey; }, [activeKey]);
  // сессия, выбранная через deep link (#/session/...) — не сбрасывается фильтром списка
  const [deepLinkKey, setDeepLinkKey] = React.useState<string | undefined>(() => readSessionFromHash());
  const selectSession = React.useCallback((key: string | undefined) => { setDeepLinkKey(key); setActiveKey(key); }, []);
  const [details, setDetails] = React.useState<SessionDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = React.useState(false);
  const [detailsHydrating, setDetailsHydrating] = React.useState(false);
  const [detailsError, setDetailsError] = React.useState<string>();
  const detailsRequestRef = React.useRef(0);
  const [mobileView, setMobileView] = React.useState<"sessions" | "chat">(() => readSessionFromHash() ? "chat" : "sessions");
  const [showReasoning, setShowReasoning] = React.useState(false);
  const [showTools, setShowTools] = React.useState(false);
  const [jsonRendering, setJsonRendering] = React.useState(() => !readJsonRenderingOptOut(window.localStorage));
  // Тёмная тема — по умолчанию. Значение уже выставлено инлайн-скриптом в index.html,
  // здесь только синхронизируем состояние с тем, что реально применено к документу.
  const [theme, setTheme] = React.useState<HerderTheme>(() => readTheme(window.localStorage));
  const [showInspector, setShowInspector] = React.useState(() => window.innerWidth > 900);
  const [sessionSettingsReturn, setSessionSettingsReturn] = React.useState<"autocontinue" | "autopilot">();
  const automationDialogRef = React.useRef<HTMLDivElement>(null);
  const [showStatistics, setShowStatistics] = React.useState(false);
  const [showJobs, setShowJobs] = React.useState(false);
  const [showQuota, setShowQuota] = React.useState(false);
  const [showFleet, setShowFleet] = React.useState(false);
  const [jobs, setJobs] = React.useState<HerderJob[]>([]);
  const [jobsLoading, setJobsLoading] = React.useState(false);
  const [jobsError, setJobsError] = React.useState<string>();
  const [cancellingJobId, setCancellingJobId] = React.useState<string>();
  const [statistics, setStatistics] = React.useState<AgentActivityStatistics>();
  const [statisticsLoading, setStatisticsLoading] = React.useState(false);
  const [statisticsError, setStatisticsError] = React.useState<string>();
  const [statisticsDays, setStatisticsDays] = React.useState(30);
  const [showSessionSettings, setShowSessionSettings] = React.useState(false);
  const [showSessionSearch, setShowSessionSearch] = React.useState(false);
  const [sessionSearch, setSessionSearch] = React.useState("");
  const [listSettings, setListSettings] = React.useState<SessionListSettings>({ cwd: "", project: "", harness: "", sort: "activity", showAll: false });
  const [autopilotChoices, setAutopilotChoices] = React.useState<WebAutopilotChoiceCard[]>([]);
  const [choosingRequestId, setChoosingRequestId] = React.useState<string>();
  const [choiceError, setChoiceError] = React.useState<{ requestId: string; message: string }>();
  const [autopilotSession, setAutopilotSession] = React.useState<WebAutopilotSession>();
  const [autopilotSessionSaving, setAutopilotSessionSaving] = React.useState(false);
  const [autopilotSessionError, setAutopilotSessionError] = React.useState<string>();
  const [sessionAutostart, setSessionAutostart] = React.useState<WebSessionAutostart>();
  const [sessionAutostartSaving, setSessionAutostartSaving] = React.useState(false);
  const [sessionAutostartError, setSessionAutostartError] = React.useState<string>();
  const [continuationHarnesses, setContinuationHarnesses] = React.useState<Partial<Record<"codex" | "zcode", WebSessionAutostartHarness>>>({});
  const [continuationHarnessSaving, setContinuationHarnessSaving] = React.useState<"codex" | "zcode">();
  const [continuationHarnessError, setContinuationHarnessError] = React.useState<string>();
  const [runtimeSettingsState, setRuntimeSettingsState] = React.useState<WebSessionRuntimeSettings>();
  const [runtimeSettingsDraft, setRuntimeSettingsDraft] = React.useState<WebSessionRuntimeSettings>();
  const [runtimeSettingsSaving, setRuntimeSettingsSaving] = React.useState(false);
  const [runtimeSettingsSaved, setRuntimeSettingsSaved] = React.useState(false);
  const [runtimeSettingsError, setRuntimeSettingsError] = React.useState<string>();
  const [runtimeModelOptions, setRuntimeModelOptions] = React.useState<WebModelOption[]>([]);
  const [autopilotPolicy, setAutopilotPolicy] = React.useState<WebAutopilotPolicyState>();
  const [autopilotPolicyDraft, setAutopilotPolicyDraft] = React.useState<WebAutopilotPolicy>();
  const [autopilotPolicySaving, setAutopilotPolicySaving] = React.useState(false);
  const [autopilotPolicyError, setAutopilotPolicyError] = React.useState<string>();
  const [autopilotPolicySaved, setAutopilotPolicySaved] = React.useState(false);
  const [automationSettings, setAutomationSettings] = React.useState<"autocontinue" | "autopilot" | "launch-policy">();
  const [collapsedChildren, setCollapsedChildren] = React.useState<Set<string>>(new Set());
  const foldedInitialized = React.useRef(false);
  const [composer, setComposer] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [sessionsRefreshing, setSessionsRefreshing] = React.useState(false);
  const [sessionsTimingMs, setSessionsTimingMs] = React.useState<number>();
  const [latestTimingMs, setLatestTimingMs] = React.useState<number>();
  const [hydrateTimingMs, setHydrateTimingMs] = React.useState<number>();
  const initialSessionsStartedRef = React.useRef(performance.now());
  // очередь отправленных сообщений; режим доставки определяется автоматически по харнессу
  const [outbox, setOutboxState] = React.useState<OutboxEntry[]>(() => readStoredOutbox(window.localStorage));
  const outboxRef = React.useRef(outbox);
  const messageDispatcherRef = React.useRef(new MessageAdmissionDispatcher());
  const setOutbox = React.useCallback((update: React.SetStateAction<OutboxEntry[]>) => {
    const next = typeof update === "function" ? update(outboxRef.current) : update;
    outboxRef.current = next;
    setOutboxState(next);
  }, []);
  const statusMissesRef = React.useRef<Map<string, number>>(new Map());
  React.useEffect(() => { writeStoredOutbox(window.localStorage, outboxRef.current); }, [outbox]);
  React.useEffect(() => { writeJsonRenderingOptOut(window.localStorage, !jsonRendering); }, [jsonRendering]);
  const cancellingOutboxRef = React.useRef(new Set<string>());
  const [cancellingOutbox, setCancellingOutbox] = React.useState<Set<string>>(() => new Set<string>());
  // bounded-опрос статуса незавершённых сообщений активной сессии: только GET message-status,
  // повторные POST автоматически не отправляются никогда
  React.useEffect(() => {
    if (!activeKey) return;
    const { harness, id } = splitKey(activeKey);
    const controller = new AbortController();
    let polling = false;
    const pollEntry = async (item: OutboxEntry) => {
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(id)}/message-status?inputId=${encodeURIComponent(item.inputId)}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
        if (!response.ok) throw new Error(`status ${response.status}`);
        const payload: unknown = await response.json().catch(() => undefined);
        const patch = reconcileMessageStatus(payload, response.ok);
        statusMissesRef.current.delete(item.inputId);
        if (patch.status !== item.status || (patch.error !== undefined && patch.error !== item.error) || (patch.note !== undefined && patch.note !== item.note)) {
          setOutbox((current) => updateOutboxEntry(current, item.inputId, patch));
        }
        const polledJobId = readOutboxJobId(payload);
        if (polledJobId) setOutbox((current) => withOutboxJobId(current, item.inputId, polledJobId));
      } catch {
        if (controller.signal.aborted) return;
        // 404/502 статус-запроса не доказывает ни доставку, ни безопасность повторной отправки
        const misses = (statusMissesRef.current.get(item.inputId) || 0) + 1;
        statusMissesRef.current.set(item.inputId, misses);
        if (misses >= 3 && item.status !== "unknown") {
          statusMissesRef.current.delete(item.inputId);
          setOutbox((current) => updateOutboxEntry(current, item.inputId, { status: "unknown", note: "Сервер не подтверждает состояние этого сообщения. Исход доставки неизвестен — не повторяйте отправку без проверки." }));
        }
      }
    };
    const poll = async () => {
      if (polling || controller.signal.aborted) return;
      polling = true;
      try {
        const entries = (outboxRef.current || []).filter((entry) => entry.sessionKey === activeKey && isOutboxUnfinished(entry) && entry.status !== "ready" && entry.status !== "sending" && entry.status !== "unknown");
        for (const entry of entries) {
          if (controller.signal.aborted) break;
          await pollEntry(entry);
        }
      } finally { polling = false; }
    };
    poll();
    const timer = window.setInterval(poll, 2000);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [activeKey]);
  // отдельный флаг полёта для кнопки «Продолжить» (resume), не связанный с очередью отправки
  const [resumeSending, setResumeSending] = React.useState(false);
  const [showCreateSession, setShowCreateSession] = React.useState(false);
  const [createHarness, setCreateHarness] = React.useState("fast-agent");
  const [createAdapters, setCreateAdapters] = React.useState<Array<{ id: string; name: string; active: boolean; ready: boolean; status: string }>>([]);
  const [createCwd, setCreateCwd] = React.useState("/home/roomhacker");
  const [cwdSuggestions, setCwdSuggestions] = React.useState<Array<{ name: string; path: string }>>([]);
  const [cwdSuggestionsOpen, setCwdSuggestionsOpen] = React.useState(false);
  const [createModel, setCreateModel] = React.useState("anthropic.MiniMax-M3.1-Flash-Preview");
  const [createModels, setCreateModels] = React.useState<string[]>([]);
  const [createModelsRefreshing, setCreateModelsRefreshing] = React.useState(false);
  const createModelRequestRef = React.useRef(0);
  const [creatingSession, setCreatingSession] = React.useState(false);
  const [createSessionError, setCreateSessionError] = React.useState<string>();
  // чип модели в композере: список моделей харнесса и результат смены
  const [harnessAdapters, setHarnessAdapters] = React.useState<Array<{ id: string; active?: boolean; capabilities?: { modelSwitch?: boolean } | null }>>([]);
  const [modelMenuOpen, setModelMenuOpen] = React.useState(false);
  const [modelOptions, setModelOptions] = React.useState<string[]>([]);
  const [modelOptionsLoading, setModelOptionsLoading] = React.useState(false);
  const [modelOptionsHarness, setModelOptionsHarness] = React.useState<string>();
  const [modelSwitching, setModelSwitching] = React.useState(false);
  const [modelSwitchError, setModelSwitchError] = React.useState<string>();
  const [chatMenuOpen, setChatMenuOpen] = React.useState(false);
  const [showScrollToLatest, setShowScrollToLatest] = React.useState(false);
  const chatScrollRef = React.useRef<HTMLDivElement>(null);
  const shouldFollowRef = React.useRef(true);

  const loadSessions = React.useCallback(async (): Promise<boolean> => {
    setSessionsRefreshing(true);
    try {
    const [result, choiceResult] = await Promise.all([
      api<{ sessions: HerderSession[]; warming?: boolean }>("/api/sessions?quick=1"),
      api<{ choices: WebAutopilotChoiceCard[] }>("/api/autopilot/choices?status=pending").catch(() => ({ choices: [] })),
    ]);
    const sessionKeys = new Set(result.sessions.map(keyOf));
    const decisionSessions: HerderSession[] = choiceResult.choices
      .filter((choice) => !sessionKeys.has(`${choice.harness}:${choice.sessionId}`))
      .map((choice) => ({
        id: choice.sessionId,
        harness: choice.harness,
        title: `Автопилот · ${choice.sessionId.slice(0, 12)}`,
        cwd: choice.cwd,
        status: "needs_input",
        lastActivity: choice.createdAt,
        lastMessage: "Нужен выбор следующего шага",
        needsPermission: true,
        meta: { decisionOnly: true },
      }));
    const nextSessions = [...result.sessions, ...decisionSessions];
    setSessions(nextSessions);
    setAutopilotChoices(choiceResult.choices);
    if (!foldedInitialized.current && result.sessions.length > 0) {
      const keys = new Set(result.sessions.flatMap((session) => session.meta?.parentSessionKey ? [session.meta.parentSessionKey] : []));
      setCollapsedChildren(keys);
      foldedInitialized.current = true;
    }
    if (!result.warming || nextSessions.length > 0) {
      setActiveKey((current) => selectionAfterSessionRefresh(current, readSessionFromHash(), nextSessions));
    }
    return !result.warming;
    } finally {
      setSessionsRefreshing(false);
    }
  }, []);
  React.useEffect(() => {
    let cancelled = false;
    const initial = async () => {
      for (let attempt = 0; attempt < 30 && !cancelled; attempt++) {
        const ready = await loadSessions().catch(() => false);
        if (ready) {
          setSessionsTimingMs(performance.now() - initialSessionsStartedRef.current);
          setLoading(false);
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
      if (!cancelled) {
        setSessionsTimingMs(performance.now() - initialSessionsStartedRef.current);
        setLoading(false);
      }
    };
    void initial();
    const timer = window.setInterval(() => void loadSessions(), 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [loadSessions]);
  const loadJobs = React.useCallback(async () => {
    setJobsLoading(true);
    try {
      const result = await api<{ jobs: HerderJob[] }>("/api/jobs?limit=100");
      setJobs(result.jobs);
      setJobsError(undefined);
    } catch (error) {
      setJobsError(error instanceof Error ? error.message : String(error));
    } finally {
      setJobsLoading(false);
    }
  }, []);
  React.useEffect(() => {
    void loadJobs();
    const timer = window.setInterval(() => void loadJobs(), 30_000);
    return () => window.clearInterval(timer);
  }, [loadJobs]);
  const cancelJob = async (jobId: string) => {
    setCancellingJobId(jobId);
    try { await api(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST", body: JSON.stringify({}) }); await loadJobs(); }
    finally { setCancellingJobId(undefined); }
  };

  const loadAutopilotPolicy = React.useCallback(async () => {
    const [autopilotResult, continuationResult, runtimeResult] = await Promise.allSettled([
      api<WebAutopilotPolicyState>("/api/autopilot/policy"),
      Promise.all([
        api<WebSessionAutostartHarness>("/api/session-autostart/harnesses/codex"),
        api<WebSessionAutostartHarness>("/api/session-autostart/harnesses/zcode"),
      ]),
      api<WebSessionRuntimeSettings>("/api/session-autostart"),
    ]);
    if (autopilotResult.status === "fulfilled") {
      setAutopilotPolicy(autopilotResult.value);
      setAutopilotPolicyDraft(autopilotResult.value.policy);
      setAutopilotPolicyError(autopilotResult.value.error);
    } else setAutopilotPolicyError(autopilotResult.reason instanceof Error ? autopilotResult.reason.message : String(autopilotResult.reason));
    if (continuationResult.status === "fulfilled") {
      const [codex, zcode] = continuationResult.value;
      setContinuationHarnesses({ codex, zcode });
      setContinuationHarnessError(undefined);
    } else setContinuationHarnessError(continuationResult.reason instanceof Error ? continuationResult.reason.message : String(continuationResult.reason));
    if (runtimeResult.status === "fulfilled") {
      setRuntimeSettingsState(runtimeResult.value);
      setRuntimeSettingsDraft(runtimeResult.value);
      setRuntimeSettingsError(undefined);
    } else setRuntimeSettingsError(runtimeResult.reason instanceof Error ? runtimeResult.reason.message : String(runtimeResult.reason));
  }, []);
  React.useEffect(() => { void loadAutopilotPolicy(); }, [loadAutopilotPolicy]);

  React.useEffect(() => {
    if (activeKey) window.localStorage.setItem("agent-herder.active-session", activeKey);
    else window.localStorage.removeItem("agent-herder.active-session");
    writeSessionToHash(activeKey);
  }, [activeKey]);
  React.useEffect(() => {
    const followHash = () => {
      const key = readSessionFromHash();
      setDeepLinkKey(key);
      setActiveKey(key);
      setMobileView(key ? "chat" : "sessions");
    };
    window.addEventListener("hashchange", followHash);
    return () => window.removeEventListener("hashchange", followHash);
  }, []);

  const loadDetails = React.useCallback(async (key: string, hydrateFull = true) => {
    const requestId = ++detailsRequestRef.current;
    const { harness, id } = splitKey(key);
    const base = `/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(id)}/details`;
    setDetailsError(undefined);
    // Фоновое обновление по событию (hydrateFull=false) приходит постоянно, пока
    // активны сессии. Раньше оно гасило details и включало detailsLoading, поэтому
    // на всё время запроса переписка подменялась заглушкой «Загружаю свежие
    // сообщения». Полное состояние сбрасываем только при полной загрузке сессии.
    if (hydrateFull) {
      setDetailsLoading(true);
      setDetailsHydrating(false);
      setLatestTimingMs(undefined);
      setHydrateTimingMs(undefined);
      setDetails((current) => current && keyOf(current.session) === key ? current : null);
    }
    try {
      const latestStartedAt = performance.now();
      const latest = await api<SessionDetails>(`${base}?limit=12&quick=1`);
      if (requestId !== detailsRequestRef.current) return;
      setLatestTimingMs(performance.now() - latestStartedAt);
      setDetails((current) => {
        if (hydrateFull || !current || keyOf(current.session) !== key) return latest;
        const messages = new Map(current.messages.map((message) => [message.id, message]));
        for (const message of latest.messages) messages.set(message.id, message);
        return { ...current, ...latest, children: latest.children ?? current.children, messages: [...messages.values()].slice(-50) };
      });
      setDetailsLoading(false);
      if (!hydrateFull) return;
      setDetailsHydrating(true);
      await new Promise((resolve) => window.setTimeout(resolve, 40));
      const hydrateStartedAt = performance.now();
      const full = await api<SessionDetails>(`${base}?limit=50`);
      if (requestId !== detailsRequestRef.current) return;
      setHydrateTimingMs(performance.now() - hydrateStartedAt);
      setDetails(full);
    } catch (error) {
      if (requestId !== detailsRequestRef.current) return;
      setDetailsError((error as Error).message);
    } finally {
      if (requestId === detailsRequestRef.current) { setDetailsLoading(false); setDetailsHydrating(false); }
    }
  }, []);
  React.useEffect(() => {
    if (!activeKey) { detailsRequestRef.current += 1; setDetails(null); setDetailsLoading(false); setDetailsHydrating(false); setLatestTimingMs(undefined); setHydrateTimingMs(undefined); return; }
    void loadDetails(activeKey);
  }, [activeKey, loadDetails]);
  React.useEffect(() => {
    let sessionTimer = 0;
    let jobTimer = 0;
    let detailTimer = 0;
    const scheduleSessions = () => {
      if (sessionTimer) return;
      sessionTimer = window.setTimeout(() => { sessionTimer = 0; void loadSessions(); }, 120);
    };
    const scheduleJobs = () => {
      if (jobTimer) return;
      jobTimer = window.setTimeout(() => { jobTimer = 0; void loadJobs(); }, 120);
    };
    const scheduleDetails = () => {
      if (!activeKey || detailTimer) return;
      detailTimer = window.setTimeout(() => { detailTimer = 0; void loadDetails(activeKey, false); }, 90);
    };
    const storedCursor = Number.parseInt(window.localStorage.getItem("agent-herder.event-cursor") || "0", 10);
    const cursor = Number.isFinite(storedCursor) && storedCursor > 0 ? storedCursor : 0;
    const stream = new EventSource(`/api/events/stream?after=${cursor}`);
    stream.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as { control?: string; latestSequence?: number; sequence?: number; uri?: string };
        if (event.control === "reset") {
          if (typeof event.latestSequence === "number") window.localStorage.setItem("agent-herder.event-cursor", String(event.latestSequence));
          scheduleSessions(); scheduleJobs(); scheduleDetails();
          return;
        }
        if (typeof event.sequence === "number") window.localStorage.setItem("agent-herder.event-cursor", String(event.sequence));
        const uri = event.uri || "";
        if (uri.startsWith("herder://jobs")) scheduleJobs();
        if (uri.startsWith("herder://sessions") || uri.startsWith("herder://coordination") || uri.startsWith("herder://human-requests")) {
          scheduleSessions();
          scheduleDetails();
        }
      } catch { /* malformed event; fallback refresh still runs */ }
    };
    return () => {
      stream.close();
      if (sessionTimer) window.clearTimeout(sessionTimer);
      if (jobTimer) window.clearTimeout(jobTimer);
      if (detailTimer) window.clearTimeout(detailTimer);
    };
  }, [activeKey, loadDetails, loadJobs, loadSessions]);
  React.useLayoutEffect(() => {
    const element = chatScrollRef.current;
    if (!element || !shouldFollowRef.current) return;
    let secondFrame = 0;
    const frame = requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
      secondFrame = requestAnimationFrame(() => {
        if (shouldFollowRef.current) element.scrollTop = element.scrollHeight;
        setShowScrollToLatest(false);
      });
    });
    return () => { cancelAnimationFrame(frame); if (secondFrame) cancelAnimationFrame(secondFrame); };
  }, [activeKey, details?.messages.length, details?.children?.length, showReasoning, showTools, jsonRendering]);

  const activeSession = details?.session && keyOf(details.session) === activeKey ? details.session : sessions.find((session) => keyOf(session) === activeKey);
  React.useEffect(() => {
    if (!activeSession || !["codex", "opencode", "claude", "hermes", "zcode"].includes(activeSession.harness)) {
      setAutopilotSession(undefined);
      return;
    }
    let cancelled = false;
    setAutopilotSession(undefined);
    const path = `/api/autopilot/sessions/${encodeURIComponent(activeSession.harness)}/${encodeURIComponent(activeSession.id)}?cwd=${encodeURIComponent(activeSession.cwd)}`;
    void api<WebAutopilotSession>(path).then((state) => {
      if (cancelled) return;
      setAutopilotSession(state);
      setAutopilotSessionError(undefined);
    }).catch((error) => {
      if (cancelled) return;
      setAutopilotSession(undefined);
      setAutopilotSessionError((error as Error).message);
    });
    return () => { cancelled = true; };
  }, [activeSession?.harness, activeSession?.id]);
  React.useEffect(() => {
    if (!activeSession || !["codex", "zcode"].includes(activeSession.harness)) {
      setSessionAutostart(undefined);
      setSessionAutostartError(undefined);
      return;
    }
    let cancelled = false;
    setSessionAutostart(undefined);
    const path = `/api/session-autostart/sessions/${encodeURIComponent(activeSession.harness)}/${encodeURIComponent(activeSession.id)}?cwd=${encodeURIComponent(activeSession.cwd)}`;
    void api<WebSessionAutostart>(path).then((state) => {
      if (cancelled) return;
      setSessionAutostart(state);
      setSessionAutostartError(undefined);
    }).catch((error) => {
      if (cancelled) return;
      setSessionAutostart(undefined);
      setSessionAutostartError((error as Error).message);
    });
    return () => { cancelled = true; };
  }, [activeSession?.harness, activeSession?.id]);
  const sessionMap = React.useMemo(() => new Map(sessions.map((session) => [keyOf(session), session])), [sessions]);
  const listOptions = React.useMemo(() => ({
    cwds: [...new Set(sessions.map((session) => session.cwd).filter(Boolean))].sort(),
    projects: [...new Set(sessions.map((session) => projectFor(session, sessionMap)).filter(Boolean))].sort(),
    harnesses: [...new Set(sessions.map((session) => session.harness).filter(Boolean))].sort(),
  }), [sessions, sessionMap]);
  const choicesBySession = React.useMemo(() => {
    const result = new Map<string, WebAutopilotChoiceCard>();
    for (const choice of autopilotChoices) {
      const key = `${choice.harness}:${choice.sessionId}`;
      if (!result.has(key)) result.set(key, choice);
    }
    return result;
  }, [autopilotChoices]);
  const choiceSessionKeys = React.useMemo(() => new Set(choicesBySession.keys()), [choicesBySession]);
  const sessionEntries = React.useMemo(() => filterAndArrangeSessions(sessions, listSettings, collapsedChildren, choiceSessionKeys), [sessions, listSettings, collapsedChildren, choiceSessionKeys]);
  const visibleSessionEntries = React.useMemo(() => sessionEntries.filter(({ session }) => matchesSessionQuery(session, sessionSearch)), [sessionEntries, sessionSearch]);
  React.useEffect(() => {
    if (activeKey && (activeKey === deepLinkKey || visibleSessionEntries.some(({ session }) => keyOf(session) === activeKey))) return;
    selectSession(visibleSessionEntries[0] ? keyOf(visibleSessionEntries[0].session) : undefined);
  }, [activeKey, visibleSessionEntries, deepLinkKey, selectSession]);
  const chooseAutopilot = async (requestId: string, choiceId: string) => {
    if (choosingRequestId) return;
    setChoosingRequestId(requestId);
    setChoiceError(undefined);
    try {
      await api("/api/autopilot/choices/select", { method: "POST", body: JSON.stringify({ request_id: requestId, choice_id: choiceId }) });
      setAutopilotChoices((current) => current.filter((choice) => choice.requestId !== requestId));
      await loadSessions();
    } catch (error) {
      setChoiceError({ requestId, message: (error as Error).message });
    } finally {
      setChoosingRequestId(undefined);
    }
  };
  const toggleAutopilotSession = async () => {
    if (!activeSession || !autopilotSession || autopilotSessionSaving) return;
    setAutopilotSessionSaving(true);
    setAutopilotSessionError(undefined);
    try {
      const state = await api<WebAutopilotSession>(`/api/autopilot/sessions/${encodeURIComponent(activeSession.harness)}/${encodeURIComponent(activeSession.id)}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: !autopilotSession.enabled, cwd: activeSession.cwd }),
      });
      setAutopilotSession(state);
    } catch (error) {
      setAutopilotSessionError((error as Error).message);
    } finally {
      setAutopilotSessionSaving(false);
    }
  };
  const inheritAutopilotSession = async () => {
    if (!activeSession || autopilotSessionSaving) return;
    setAutopilotSessionSaving(true);
    setAutopilotSessionError(undefined);
    try {
      const state = await api<WebAutopilotSession>(`/api/autopilot/sessions/${encodeURIComponent(activeSession.harness)}/${encodeURIComponent(activeSession.id)}?cwd=${encodeURIComponent(activeSession.cwd)}`, { method: "DELETE" });
      setAutopilotSession(state);
    } catch (error) {
      setAutopilotSessionError((error as Error).message);
    } finally {
      setAutopilotSessionSaving(false);
    }
  };
  const toggleSessionAutostart = async () => {
    if (!activeSession || !sessionAutostart || sessionAutostartSaving) return;
    setSessionAutostartSaving(true);
    setSessionAutostartError(undefined);
    try {
      const state = await api<WebSessionAutostart>(`/api/session-autostart/sessions/${encodeURIComponent(activeSession.harness)}/${encodeURIComponent(activeSession.id)}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: !sessionAutostart.enabled, cwd: activeSession.cwd }),
      });
      setSessionAutostart(state);
    } catch (error) {
      setSessionAutostartError((error as Error).message);
    } finally {
      setSessionAutostartSaving(false);
    }
  };
  const inheritSessionAutostart = async () => {
    if (!activeSession || sessionAutostartSaving) return;
    setSessionAutostartSaving(true);
    setSessionAutostartError(undefined);
    try {
      const state = await api<WebSessionAutostart>(`/api/session-autostart/sessions/${encodeURIComponent(activeSession.harness)}/${encodeURIComponent(activeSession.id)}?cwd=${encodeURIComponent(activeSession.cwd)}`, { method: "DELETE" });
      setSessionAutostart(state);
    } catch (error) {
      setSessionAutostartError((error as Error).message);
    } finally {
      setSessionAutostartSaving(false);
    }
  };
  const saveAutopilotPolicy = async () => {
    if (!autopilotPolicy || !autopilotPolicyDraft || autopilotPolicySaving) return;
    setAutopilotPolicySaving(true);
    setAutopilotPolicyError(undefined);
    setAutopilotPolicySaved(false);
    try {
      const saved = await api<WebAutopilotPolicyState>("/api/autopilot/policy", {
        method: "PUT",
        body: JSON.stringify({ expectedRevision: autopilotPolicy.source === "persisted" ? autopilotPolicy.revision : null, policy: autopilotPolicyDraft }),
      });
      setAutopilotPolicy(saved);
      setAutopilotPolicyDraft(saved.policy);
      setAutopilotPolicySaved(true);
      if (activeSession) {
        const state = await api<WebAutopilotSession>(`/api/autopilot/sessions/${encodeURIComponent(activeSession.harness)}/${encodeURIComponent(activeSession.id)}?cwd=${encodeURIComponent(activeSession.cwd)}`);
        setAutopilotSession(state);
      }
    } catch (error) {
      setAutopilotPolicyError((error as Error).message.includes("409") ? "Настройки изменились в другом окне. Обновите страницу и повторите." : (error as Error).message);
    } finally {
      setAutopilotPolicySaving(false);
    }
  };
  const toggleContinuationHarness = async (harness: "codex" | "zcode") => {
    const current = continuationHarnesses[harness];
    if (!current || continuationHarnessSaving) return;
    setContinuationHarnessSaving(harness);
    setContinuationHarnessError(undefined);
    try {
      const saved = await api<WebSessionAutostartHarness>(`/api/session-autostart/harnesses/${harness}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: !current.enabled }),
      });
      setContinuationHarnesses((values) => ({ ...values, [harness]: saved }));
      if (activeSession?.harness === harness) {
        setSessionAutostart(await api<WebSessionAutostart>(`/api/session-autostart/sessions/${encodeURIComponent(activeSession.harness)}/${encodeURIComponent(activeSession.id)}?cwd=${encodeURIComponent(activeSession.cwd)}`));
      }
    } catch (error) {
      setContinuationHarnessError((error as Error).message);
    } finally {
      setContinuationHarnessSaving(undefined);
    }
  };
  const loadRuntimeModels = React.useCallback(async () => {
    const registry = await api<{ adapters: Array<{ id: string; active: boolean }> }>("/api/adapters");
    const catalogs = await Promise.all(registry.adapters.filter((adapter) => adapter.active).map(async (adapter) => {
      const result = await api<{ models?: string[] }>(`/api/models?harness=${encodeURIComponent(adapter.id)}`).catch(() => ({ models: [] as string[] }));
      return (result.models || []).map((model) => ({ model, harness: adapter.id }));
    }));
    setRuntimeModelOptions([...new Map(catalogs.flat().map((item) => [item.model, item])).values()].sort((left, right) => left.model.localeCompare(right.model)));
  }, []);
  React.useEffect(() => { if (automationSettings) void loadRuntimeModels(); }, [automationSettings, loadRuntimeModels]);
  const toggleGlobalContinuation = async () => {
    if (!runtimeSettingsDraft || runtimeSettingsSaving) return;
    setRuntimeSettingsSaving(true);
    setRuntimeSettingsError(undefined);
    setRuntimeSettingsSaved(false);
    try {
      const saved = await api<WebSessionRuntimeSettings>("/api/session-autostart", {
        method: "PUT",
        body: JSON.stringify({ enabled: !runtimeSettingsDraft.enabled }),
      });
      setRuntimeSettingsState(saved);
      setRuntimeSettingsDraft(saved);
      const [codex, zcode] = await Promise.all([
        api<WebSessionAutostartHarness>("/api/session-autostart/harnesses/codex"),
        api<WebSessionAutostartHarness>("/api/session-autostart/harnesses/zcode"),
      ]);
      setContinuationHarnesses({ codex, zcode });
      if (activeSession && ["codex", "zcode"].includes(activeSession.harness)) {
        setSessionAutostart(await api<WebSessionAutostart>(`/api/session-autostart/sessions/${encodeURIComponent(activeSession.harness)}/${encodeURIComponent(activeSession.id)}?cwd=${encodeURIComponent(activeSession.cwd)}`));
      }
      setRuntimeSettingsSaved(true);
    } catch (error) {
      setRuntimeSettingsError((error as Error).message);
    } finally {
      setRuntimeSettingsSaving(false);
    }
  };
  const saveRuntimeSettings = async () => {
    if (!runtimeSettingsDraft || runtimeSettingsSaving) return;
    setRuntimeSettingsSaving(true);
    setRuntimeSettingsError(undefined);
    setRuntimeSettingsSaved(false);
    try {
      const saved = await api<WebSessionRuntimeSettings>("/api/session-autostart", {
        method: "PUT",
        body: JSON.stringify({
          enabled: runtimeSettingsDraft.enabled,
          pinActiveSessions: runtimeSettingsDraft.pinActiveSessions ?? true,
          rolloverExpiredCache: runtimeSettingsDraft.rolloverExpiredCache ?? false,
          movePinnedOnRollover: runtimeSettingsDraft.movePinnedOnRollover ?? false,
          inventoryWindowHours: runtimeSettingsDraft.inventoryWindowHours,
          evidenceMessageCount: runtimeSettingsDraft.evidenceMessageCount,
          recoverOnFailure: runtimeSettingsDraft.recoverOnFailure ?? true,
          recoverOnDisconnect: runtimeSettingsDraft.recoverOnDisconnect ?? true,
          watchdogEnabled: runtimeSettingsDraft.watchdogEnabled ?? false,
          watchdogIntervalSeconds: runtimeSettingsDraft.watchdogIntervalSeconds ?? 10,
          stalledTurnMinutes: runtimeSettingsDraft.stalledTurnMinutes ?? 2,
          judgeModel: runtimeSettingsDraft.judgeModel.trim(),
          autopilotJudgeModel: runtimeSettingsDraft.autopilotJudgeModel.trim(),
        }),
      });
      setRuntimeSettingsState(saved);
      setRuntimeSettingsDraft(saved);
      setRuntimeSettingsSaved(true);
    } catch (error) {
      setRuntimeSettingsError((error as Error).message);
    } finally {
      setRuntimeSettingsSaving(false);
    }
  };
  const loadCreateModels = async (harness: string, preferCurrent = false, pollAttempt = 0) => {
    const requestId = ++createModelRequestRef.current;
    try {
      const result = await api<{ models?: string[]; refreshing?: boolean }>(`/api/models?harness=${encodeURIComponent(harness)}`);
      if (requestId !== createModelRequestRef.current) return;
      const models = creationModels(harness, Array.isArray(result.models) ? result.models : []);
      setCreateModels(models);
      setCreateModelsRefreshing(Boolean(result.refreshing));
      const preferredModel = harness === "fast-agent" && models.includes("anthropic.MiniMax-M3.1-Flash-Preview") ? "anthropic.MiniMax-M3.1-Flash-Preview" : (models[0] || "");
      setCreateModel((current) => preferCurrent && current && models.includes(current) ? current : preferredModel);
      if (result.refreshing && pollAttempt < 5) {
        window.setTimeout(() => {
          if (requestId === createModelRequestRef.current) void loadCreateModels(harness, true, pollAttempt + 1);
        }, 700);
      }
    } catch {
      if (requestId !== createModelRequestRef.current) return;
      setCreateModels([]);
      setCreateModelsRefreshing(false);
      setCreateModel("");
    }
  };
  const loadCreateAdapters = async () => {
    try {
      const result = await api<{ adapters?: Array<{ id: string; name: string; active: boolean; ready: boolean; status: string }> }>("/api/adapters");
      setCreateAdapters(Array.isArray(result.adapters) ? result.adapters : []);
    } catch {
      setCreateAdapters([
        { id: "opencode", name: "OpenCode", active: true, ready: true, status: "active" },
        { id: "claude", name: "Claude", active: true, ready: true, status: "active" },
        { id: "codex", name: "Codex", active: true, ready: true, status: "active" },
        { id: "qoder", name: "Qoder", active: false, ready: false, status: "disabled" },
        { id: "hermes", name: "Hermes", active: true, ready: true, status: "active" },
        { id: "zcode", name: "ZCode", active: true, ready: true, status: "active" },
        { id: "fast-agent", name: "Fast Agent", active: true, ready: true, status: "active" },
      ]);
    }
  };
  const loadCwdSuggestions = async (value: string) => {
    if (!value.trim().startsWith("/") && !value.trim().startsWith("~")) { setCwdSuggestions([]); return; }
    try {
      const result = await api<{ dirs?: Array<{ name: string; path: string }> }>(`/api/fs/dirs?path=${encodeURIComponent(value.trim())}`);
      setCwdSuggestions(Array.isArray(result.dirs) ? result.dirs : []);
      setCwdSuggestionsOpen(true);
    } catch {
      setCwdSuggestions([]);
    }
  };
  const openCreateSession = () => {
    const cwd = listSettings.cwd || activeSession?.cwd || "/home/roomhacker";
    setCreateCwd(cwd);
    setCreateSessionError(undefined);
    setShowJobs(false);
    setShowStatistics(false);
    setShowQuota(false);
    setAutomationSettings(undefined);
    setMobileView("chat");
    setShowCreateSession(true);
    void loadCreateAdapters();
    void loadCreateModels(createHarness);
    void loadCwdSuggestions(cwd.endsWith("/") ? cwd : `${cwd}/`);
  };
  const createNewSession = async () => {
    if (!createCwd.trim() || creatingSession) return;
    setCreatingSession(true);
    setCreateSessionError(undefined);
    const generatedName = `${createHarness.replace(/[^a-z0-9-]/gi, "-")}-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
    try {
      const created = await api<{ sessionId?: string }>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ harness: createHarness, name: generatedName, cwd: createCwd.trim(), model: createModel.trim() || undefined }),
      });
      if (!created.sessionId) throw new Error("Сервер не вернул созданную сессию");
      setShowCreateSession(false);
      setListSettings((current) => ({ ...current, harness: createHarness, cwd: "", sort: "activity", showAll: true }));
      const key = `${createHarness}:${created.sessionId}`;
      selectSession(key);
      setMobileView("chat");
      // The active-key effect loads this exact chat while the list refreshes.
      // A slow unrelated adapter must not leave the user in the old chat.
      void loadSessions();
    } catch (error) { setCreateSessionError((error as Error).message); }
    finally { setCreatingSession(false); }
  };

  const loadStatistics = React.useCallback(async (days = statisticsDays, refresh = false) => {
    setStatisticsLoading(true); setStatisticsError(undefined);
    try {
      let result = await api<AgentActivityStatistics>(`/api/statistics/activity?days=${days}${refresh ? "&refresh=1" : ""}`);
      setStatistics(result);
      if (!result.portfolio && !refresh) {
        for (let attempt = 0; attempt < 8 && !result.portfolio; attempt++) {
          await new Promise((resolve) => window.setTimeout(resolve, 500));
          result = await api<AgentActivityStatistics>(`/api/statistics/activity?days=${days}`);
          setStatistics(result);
        }
      }
    } catch (error) { setStatisticsError((error as Error).message); }
    finally { setStatisticsLoading(false); }
  }, [statisticsDays]);
  const openStatistics = () => { setShowStatistics(true); setChatMenuOpen(false); void loadStatistics(statisticsDays); };
  const changeStatisticsDays = (days: number) => { setStatisticsDays(days); void loadStatistics(days); };

  const runAction = async (action: "resume" | "stop" | "recover") => {
    if (!activeKey || (action === "resume" && resumeSending)) return;
    if (action === "resume") setResumeSending(true);
    if (action === "stop") messageDispatcherRef.current.cancelPending(activeKey);
    const { harness, id } = splitKey(activeKey);
    try {
      const result = await api<{ job?: HerderJob }>(`/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(id)}/${action}`, { method: "POST", body: JSON.stringify({ humanRequested: action !== "stop", ...(action === "resume" && (harness === "codex" || harness === "zcode" || harness === "fast-agent") ? { message: "Продолжи текущую задачу в этой же сессии. Если задача уже завершена, кратко сообщи результат." } : {}) }) });
      if (action === "recover" && result.job) {
        setShowJobs(true);
        setShowStatistics(false);
        await loadJobs();
        return;
      }
      await loadSessions();
      await loadDetails(activeKey);
    } finally {
      if (action === "resume") setResumeSending(false);
    }
  };
  // Тема применяется мгновенно: меняется только атрибут темы у документа, данные не перезапрашиваются.
  const selectTheme = (next: HerderTheme) => {
    applyTheme(document.documentElement, next);
    writeTheme(window.localStorage, next);
    setTheme(next);
  };
  // capabilities.modelSwitch решает, показывать ли чип вообще: неподдерживаемый харнесс прячем.
  React.useEffect(() => {
    let cancelled = false;
    void api<{ adapters?: Array<{ id: string; active?: boolean; capabilities?: { modelSwitch?: boolean } | null }> }>("/api/adapters")
      .then((result) => { if (!cancelled) setHarnessAdapters(Array.isArray(result.adapters) ? result.adapters : []); })
      .catch(() => { if (!cancelled) setHarnessAdapters([]); });
    return () => { cancelled = true; };
  }, []);
  const modelSwitchHarness = activeSession?.harness && modelSwitchSupported(harnessAdapters, activeSession.harness) ? activeSession.harness : undefined;
  const loadModelOptions = React.useCallback(async (harness: string) => {
    setModelOptionsLoading(true);
    setModelSwitchError(undefined);
    try {
      const result = await api<{ models?: string[] }>(`/api/models?harness=${encodeURIComponent(harness)}`);
      setModelOptions(Array.isArray(result.models) ? result.models : []);
      setModelOptionsHarness(harness);
    } catch (error) {
      setModelOptions([]);
      setModelSwitchError(`Не удалось загрузить список моделей: ${(error as Error).message}`);
    } finally {
      setModelOptionsLoading(false);
    }
  }, []);
  const toggleModelMenu = () => {
    if (modelMenuOpen) { setModelMenuOpen(false); return; }
    if (!modelSwitchHarness) return;
    setModelMenuOpen(true);
    setModelSwitchError(undefined);
    void loadModelOptions(modelSwitchHarness);
  };
  const changeSessionModel = async (model: string) => {
    if (!activeKey || !modelSwitchHarness || modelSwitching) return;
    setModelSwitching(true);
    setModelSwitchError(undefined);
    try {
      const outcome = await requestModelChange(fetch, splitKey(activeKey).harness, splitKey(activeKey).id, model);
      if (!outcome.ok) { setModelSwitchError(outcome.message); return; }
      setModelMenuOpen(false);
      await loadDetails(activeKey);
    } catch (error) {
      setModelSwitchError(`Не удалось сменить модель: ${(error as Error).message}`);
    } finally {
      setModelSwitching(false);
    }
  };
  React.useEffect(() => { setModelMenuOpen(false); setModelSwitchError(undefined); }, [activeKey]);
  const isResumeMode = !composer.trim() && (activeSession?.status === "stopped" || activeSession?.status === "error" || activeSession?.meta?.humanStopHeld === true);
  const activeJobsCount = jobs.filter((job) => job.state === "queued" || job.state === "running" || job.state === "waiting" || job.state === "cancelling").length;
  const readOnlySession = activeSession?.meta?.readOnly === true;
  const archivedSession = activeSession?.status === "archived" || activeSession?.meta?.archived === true;
  const visualizationUrl = activeSession
    ? `/api/sessions/${encodeURIComponent(activeSession.harness)}/${encodeURIComponent(activeSession.id)}/visualization`
    : undefined;
  const latestMessage = details?.messages[details.messages.length - 1];
  const latestToolPart = [...(latestMessage?.parts || [])].reverse().find((part) => part.type === "tool_call" || part.type === "tool_result");
  // очередь отправленных сообщений активной сессии; композер остаётся свободным, пока сообщения в полёте
  const activeOutbox = activeKey ? outbox.filter((entry) => entry.sessionKey === activeKey).slice().sort((left, right) => right.createdAt - left.createdAt) : [];
  const supportsSteer = activeSession?.harness === "codex";
  // режима выбора у пользователя нет: steer там, где харнесс его понимает (codex), иначе очередь
  const autoDeliveryMode: DeliveryMode = supportsSteer ? "steer" : "queue";
  const sending = activeOutbox.some((entry) => entry.status === "sending");
  const runningSince = activeSession?.status === "running" ? runningSinceMs(activeSession) : undefined;
  const latestToolAction = activeSession?.status === "running" && latestToolPart ? toolActionLabel(latestToolPart.name) : undefined;
  const sessionActivity = sending
    ? { kind: "thinking", label: "Отправляю сообщения…" }
    : activeSession?.status === "running"
      ? { kind: latestToolAction ? "tool" : "thinking", label: latestToolAction || "" }
      : activeSession?.status === "needs_input"
        ? { kind: "waiting", label: "Ждёт вашего ответа" }
        : detailsLoading && activeSession
          ? { kind: "loading", label: "Обновляю состояние сессии…" }
          : undefined;
  const submitOutboxEntry = async (sessionKey: string, text: string, mode: DeliveryMode, inputId: string) => {
    const { harness, id } = splitKey(sessionKey);
    const next = appendOutboxEntry(outboxRef.current, { inputId, sessionKey, text, mode, createdAt: Date.now(), status: "ready" });
    outboxRef.current = next;
    setOutbox(next);
    if (!writeStoredOutbox(window.localStorage, next)) {
      setOutbox((current) => updateOutboxEntry(current, inputId, { status: "failed", error: "Не удалось сохранить предпросмотр. Сообщение не отправлено; освободите место в истории отправки." }));
      return;
    }
    shouldFollowRef.current = true; setShowScrollToLatest(false);
    await messageDispatcherRef.current.run(sessionKey, async () => {
    const attempted = beginOutboxAttempt(window.localStorage, outboxRef.current, inputId);
    if (!attempted) {
      setOutbox((current) => updateOutboxEntry(current, inputId, { status: "ready", note: "Не удалось сохранить состояние отправки. Сообщение не отправлено; повторите после освобождения места." }));
      return;
    }
    setOutbox(attempted);
    let responded = false;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(id)}/message`, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(30_000), body: JSON.stringify({ message: text, mode, humanRequested: true, inputId }) });
      responded = true;
      const payload: unknown = await response.json().catch(() => undefined);
      setOutbox((current) => updateOutboxEntry(current, inputId, classifyMessageDelivery(payload, response.ok)));
      const queuedJobId = readOutboxJobId(payload);
      if (queuedJobId) setOutbox((current) => withOutboxJobId(current, inputId, queuedJobId));
    } catch (error) {
      setOutbox((current) => updateOutboxEntry(current, inputId, responded
        ? { status: "failed", error: error instanceof Error ? error.message : String(error) }
        : deliveryConnectionFailure(error)));
    }
    if (responded && activeKeyRef.current === sessionKey) void loadDetails(sessionKey).catch(() => undefined);
    }, { inputId, onCancelled: () => setOutbox((current) => updateOutboxEntry(current, inputId, { status: "ready", note: "Чат остановлен. Это сообщение не отправлено; отправьте его явно, если хотите продолжить." })) });
  };
  const sendMessage = async () => {
    if (!activeKey || readOnlySession || !composer.trim()) return;
    const draft = composer;
    const text = draft.trim();
    setComposer((current) => current === draft ? "" : current);
    await submitOutboxEntry(activeKey, text, autoDeliveryMode, newInputId());
  };
  const retryOutboxEntry = async (inputId: string) => {
    const entry = outbox.find((item) => item.inputId === inputId);
    if (!entry || messageDispatcherRef.current.hasPending(inputId) || (entry.status !== "ready" && (entry.status !== "failed" || entry.nonRetryable === true))) return;
    await submitOutboxEntry(entry.sessionKey, entry.text, entry.mode, entry.inputId);
  };
  const dismissOutboxEntry = (inputId: string) => setOutbox((current) => removeOutboxEntry(current, inputId));
  // jobId строки достаётся и из ответа POST, и из message-status: после перезагрузки отмена
  // работает без повторной отправки сообщения.
  const resolveOutboxJobId = async (entry: OutboxEntry): Promise<string | undefined> => {
    if (entry.jobId) return entry.jobId;
    const { harness, id } = splitKey(entry.sessionKey);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(id)}/message-status?inputId=${encodeURIComponent(entry.inputId)}`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return undefined;
      const jobId = readOutboxJobId(await response.json());
      if (jobId) setOutbox((current) => withOutboxJobId(current, entry.inputId, jobId));
      return jobId;
    } catch {
      return undefined;
    }
  };
  // Отмена задачи доставки не гарантирует, что сообщение не ушло: задача может успеть передать
  // его агенту. Поэтому ждём терминального состояния и удаляем строку только при реальной отмене.
  const cancelQueuedDelivery = async (entry: OutboxEntry): Promise<CancelOutcome | "no-job"> => {
    const jobId = await resolveOutboxJobId(entry);
    if (!jobId) return "no-job";
    try {
      await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST", signal: AbortSignal.timeout(15_000) });
      for (let attempt = 0; attempt < 12; attempt++) {
        const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) return "failed";
        const job = await response.json().catch(() => undefined) as { state?: unknown } | undefined;
        if (isTerminalJobState(job?.state)) return cancelOutcomeOfJobState(job?.state);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return "failed";
    } catch {
      return "failed";
    }
  };
  const beginOutboxCancel = (inputId: string) => {
    if (cancellingOutboxRef.current.has(inputId)) return false;
    cancellingOutboxRef.current.add(inputId);
    setCancellingOutbox(new Set(cancellingOutboxRef.current));
    return true;
  };
  const endOutboxCancel = (inputId: string) => {
    cancellingOutboxRef.current.delete(inputId);
    setCancellingOutbox(new Set(cancellingOutboxRef.current));
  };
  const deleteOutboxEntry = async (inputId: string) => {
    const entry = outboxRef.current.find((item) => item.inputId === inputId);
    if (!entry || !canDeleteOutboxEntry(entry) || !beginOutboxCancel(inputId)) return;
    messageDispatcherRef.current.cancelInput(entry.sessionKey, inputId);
    try {
      const outcome = await cancelQueuedDelivery(entry);
      if (outcome === "cancelled" || (outcome === "no-job" && entry.status === "ready")) dismissOutboxEntry(inputId);
      else if (outcome === "delivered") setOutbox((current) => updateOutboxEntry(current, inputId, { status: "delivered", note: "Сообщение уже доставлено агенту — удалить его нельзя." }));
      else if (outcome === "no-job") setOutbox((current) => updateOutboxEntry(current, inputId, { status: "failed", error: "Задача доставки не найдена на сервере. Сообщение не отправлено." }));
      else setOutbox((current) => updateOutboxEntry(current, inputId, { status: entry.status, note: "Не удалось отменить доставку. Сообщение осталось в очереди." }));
    } finally {
      endOutboxCancel(inputId);
    }
  };
  // «Отправить сейчас»: сначала отменяем ожидание в очереди, и только если сообщение
  // фактически не ушло — отправляем его повторно как steer с новым inputId.
  const steerOutboxEntry = async (inputId: string) => {
    const entry = outboxRef.current.find((item) => item.inputId === inputId);
    if (!entry || !canSteerOutboxEntry(entry, splitKey(entry.sessionKey).harness) || !beginOutboxCancel(inputId)) return;
    messageDispatcherRef.current.cancelInput(entry.sessionKey, inputId);
    try {
      const outcome = await cancelQueuedDelivery(entry);
      if (outcome === "delivered") {
        setOutbox((current) => updateOutboxEntry(current, inputId, { status: "delivered", note: "Сообщение уже доставлено — отправлять повторно нельзя." }));
        return;
      }
      if (outcome !== "cancelled") {
        setOutbox((current) => updateOutboxEntry(current, inputId, outcome === "no-job" && entry.status === "ready" ? { status: entry.status, note: "Сообщение ещё не отправлялось — просто отправляю его в текущий ход." } : { status: entry.status, note: "Не удалось отменить очередь — режим доставки не изменён." }));
        if (outcome !== "no-job" || entry.status !== "ready") return;
      }
      dismissOutboxEntry(inputId);
      await submitOutboxEntry(entry.sessionKey, entry.text, "steer", newInputId());
    } finally {
      endOutboxCancel(inputId);
    }
  };
  const checkOutboxEntry = async (entry: OutboxEntry) => {
    const { harness, id } = splitKey(entry.sessionKey);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(id)}/message-status?inputId=${encodeURIComponent(entry.inputId)}`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return;
      const payload: unknown = await response.json();
      const patch = reconcileMessageStatus(payload, response.ok);
      setOutbox((current) => updateOutboxEntry(current, entry.inputId, patch));
      const checkedJobId = readOutboxJobId(payload);
      if (checkedJobId) setOutbox((current) => withOutboxJobId(current, entry.inputId, checkedJobId));
    } catch { /* Keep the known outcome; checking never resubmits input. */ }
  };
  const scrollToBottom = () => {
    const element = chatScrollRef.current;
    if (!element) return;
    shouldFollowRef.current = true;
    setShowScrollToLatest(false);
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  };
  const handleChatScroll = () => {
    const element = chatScrollRef.current;
    if (!element) return;
    const following = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
    shouldFollowRef.current = following;
    setShowScrollToLatest(!following && element.scrollHeight > element.clientHeight);
  };
  React.useEffect(() => {
    if (!chatMenuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Закрывается самый верхний открытый слой: меню чата, диалог настроек, поиск, инспектор.
      if (chatMenuOpen) { setChatMenuOpen(false); return; }
      if (automationSettings !== undefined) { setAutomationSettings(undefined); setShowQuota(false); return; }
      if (showSessionSearch) { setShowSessionSearch(false); return; }
      if (showInspector) closeSessionInspector();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (!target.closest(".chat-menu") && !target.closest(".desktop-chat-menu") && !target.closest(".mobile-automation-button")) setChatMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [chatMenuOpen]);

  React.useEffect(() => {
    const dialog = automationDialogRef.current;
    if (!automationSettings || !dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])')].filter((element) => element.getClientRects().length > 0);
    focusable()[0]?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const index = items.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey ? (index <= 0 ? items.length - 1 : index - 1) : (index < 0 || index === items.length - 1 ? 0 : index + 1);
      event.preventDefault();
      items[next]?.focus();
    };
    dialog.addEventListener("keydown", trapFocus);
    return () => { dialog.removeEventListener("keydown", trapFocus); previous?.focus(); };
  }, [automationSettings]);

  const openSessionInspector = (returnTo?: "autocontinue" | "autopilot") => {
    setSessionSettingsReturn(returnTo);
    setAutomationSettings(undefined);
    setShowInspector(true);
    setChatMenuOpen(false);
  };
  const closeSessionInspector = () => {
    setShowInspector(false);
    if (sessionSettingsReturn) setAutomationSettings(sessionSettingsReturn);
    setSessionSettingsReturn(undefined);
  };

  const activeHarnessSupportsAutopilot = !activeSession || activeSession.harness in AUTOPILOT_HARNESS_LABELS;
  const activeHarnessSupportsAutocontinue = !activeSession || AUTOCONTINUE_HARNESSES.has(activeSession.harness);
  const activeAutopilotEnabled = activeSession
    ? (autopilotSession?.enabled ?? false)
    : Boolean(autopilotPolicyDraft?.enabled);
  const activeAutocontinueEnabled = activeSession
    ? (sessionAutostart?.enabled ?? false)
    : Boolean(runtimeSettingsDraft?.enabled);

  return <main className={`oc-app ${mobileView === "chat" ? "mobile-chat-active" : "mobile-sessions-active"} ${(!showInspector || showStatistics || showJobs || showQuota || automationSettings) ? "no-inspector" : ""}`}>
    <CodexNavigation active={showJobs ? "jobs" : showStatistics ? "statistics" : "chat"} onChat={() => { setShowJobs(false); setShowStatistics(false); setShowQuota(false); setAutomationSettings(undefined); }} onNew={() => { setShowJobs(false); setShowStatistics(false); setShowQuota(false); setAutomationSettings(undefined); void openCreateSession(); }} onJobs={() => { setShowJobs(true); setShowStatistics(false); setShowQuota(false); setAutomationSettings(undefined); }} onStatistics={() => { setShowJobs(false); setShowQuota(false); setAutomationSettings(undefined); openStatistics(); }} />
    <SessionList onNewSession={openCreateSession} entries={visibleSessionEntries} activeKey={activeKey} loading={loading} refreshing={sessionsRefreshing && !loading} settings={listSettings} settingsOpen={showSessionSettings} searchOpen={showSessionSearch} searchQuery={sessionSearch} options={listOptions} choicesBySession={choicesBySession} choosingRequestId={choosingRequestId} choiceError={choiceError} collapsedChildren={collapsedChildren} onSearchChange={setSessionSearch} onSearchToggle={() => setShowSessionSearch((value) => !value)} onSettingsToggle={() => setShowSessionSettings((value) => !value)} onSettingsChange={(patch) => setListSettings((current) => ({ ...current, ...patch }))} onToggleChildren={(key) => setCollapsedChildren((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })} onChoose={(requestId, choiceId) => void chooseAutopilot(requestId, choiceId)} onSelect={(key) => { shouldFollowRef.current = true; setShowScrollToLatest(false); setShowStatistics(false); setShowJobs(false); selectSession(key); setMobileView("chat"); }} />
    <section className="chat-pane">
      <header className="chat-header">
        <button className="mobile-back" onClick={() => setMobileView("sessions")} aria-label="К списку сессий">← <span>Сессии</span></button>
        <div className="chat-heading">{showJobs ? <><span className="eyebrow">AGENT HERDER</span><h2>Задачи</h2><small>Фоновые задачи и их прогресс</small></> : showStatistics ? <><span className="eyebrow">AGENT HERDER</span><h2>Статистика</h2><small>Реальные паттерны активности недавних сессий</small></> : showQuota ? <><span className="eyebrow">AGENT HERDER</span><h2>Квота</h2><small>Окна Codex, расход моделей, потребители</small></> : <><span className="eyebrow">{activeSession?.harness || "HERDER"}</span><h2>{activeSession ? (cleanSessionTitle(activeSession.title) || activeSession.id) : loading ? "Загрузка сессий…" : "Выберите сессию"}{(detailsLoading || detailsHydrating) && <span className="inline-loading-dot chat-loading-dot" role="status" aria-label="Загрузка сессии" />}</h2><small>{activeSession?.cwd || ""}</small>{SHOW_DEBUG_TIMINGS && <div className="load-timings" role="status" aria-label="Тайминги загрузки в браузере"><span title="Страница → список сессий готов">sessions <b>{formatLoadTiming(sessionsTimingMs)}</b></span>{activeKey && <><span title="Запрос свежих ходов">latest <b>{detailsLoading ? "…" : formatLoadTiming(latestTimingMs)}</b></span><span title="Фоновая история и метрики">hydrate <b>{detailsHydrating ? "…" : formatLoadTiming(hydrateTimingMs)}</b></span></>}</div>}</>}</div>
        <div className="header-actions"><button className="quiet-button" aria-label="Машины флота" onClick={() => setShowFleet(true)}>Машины</button><button className={`quiet-button ${showJobs ? "selected-icon" : ""}`} aria-pressed={showJobs} aria-label={activeJobsCount > 0 ? `Задачи, активных: ${activeJobsCount}` : "Задачи"} title={activeJobsCount > 0 ? `Активных задач: ${activeJobsCount}` : undefined} onClick={() => { setShowJobs((value) => !value); setShowStatistics(false); setAutomationSettings(undefined); setShowQuota(false); }}>Задачи</button><button className={`quiet-button ${showStatistics ? "selected-icon" : ""}`} aria-pressed={showStatistics} onClick={() => { setShowJobs(false); setShowQuota(false); showStatistics ? setShowStatistics(false) : openStatistics(); }}>Статистика</button>{!showStatistics && !showJobs && !showQuota && <>{activeHarnessSupportsAutocontinue && <button className={`quiet-button automation-setting-button ${automationSettings === "autocontinue" ? "selected-icon" : ""}`} aria-label={`Автопродолжение ${activeAutocontinueEnabled ? "включено" : "выключено"} — открыть настройки`} aria-pressed={automationSettings === "autocontinue"} title={`Автопродолжение ${activeAutocontinueEnabled ? "включено" : "выключено"}`} onClick={() => { setAutomationSettings((value) => value === "autocontinue" ? undefined : "autocontinue"); setChatMenuOpen(false); }}>Автопродолжение<span className={`toggle-dot ${activeAutocontinueEnabled ? "on" : "off"}`} aria-hidden="true" /></button>}{activeHarnessSupportsAutopilot && <button className={`quiet-button automation-setting-button ${automationSettings === "autopilot" ? "selected-icon" : ""}`} aria-label={`Автопилот ${activeAutopilotEnabled ? "включён" : "выключен"} — открыть настройки`} aria-pressed={automationSettings === "autopilot"} title={`Автопилот ${activeAutopilotEnabled ? "включён" : "выключен"}`} onClick={() => { setAutomationSettings((value) => value === "autopilot" ? undefined : "autopilot"); setChatMenuOpen(false); }}>Автопилот<span className={`toggle-dot ${activeAutopilotEnabled ? "on" : "off"}`} aria-hidden="true" /></button>}<button className={`quiet-button automation-setting-button ${automationSettings === "launch-policy" ? "selected-icon" : ""}`} aria-label="Настройки запуска новых сессий" title="Настройки запуска новых сессий" onClick={() => { setAutomationSettings((value) => value === "launch-policy" ? undefined : "launch-policy"); setChatMenuOpen(false); }}>+</button><button className="quiet-button" aria-label="Информация о сессии" title="Информация о сессии" aria-pressed={showInspector} onClick={() => { setSessionSettingsReturn(undefined); setShowInspector((value) => !value); }}>Настройки сессии</button></>}<button className={`quiet-button mobile-automation-button ${chatMenuOpen ? "selected-icon" : ""}`} aria-label="Открыть настройки автоматизации" aria-expanded={chatMenuOpen} onClick={() => setChatMenuOpen((value) => !value)}>Автоматизация</button><button className={`icon-button desktop-chat-menu ${chatMenuOpen ? "selected-icon" : ""}`} aria-label="Меню чата" aria-expanded={chatMenuOpen} onClick={() => setChatMenuOpen((value) => !value)}>···</button></div>
        {chatMenuOpen && <div className="chat-menu" aria-label="Меню чата"><span className="chat-menu-section">Вид переписки</span><label><input type="checkbox" checked={showReasoning} onChange={(event) => setShowReasoning(event.target.checked)} /> Размышления</label><label><input type="checkbox" checked={showTools} onChange={(event) => setShowTools(event.target.checked)} /> Инструменты</label><label><input type="checkbox" checked={jsonRendering} onChange={(event) => setJsonRendering(event.target.checked)} /> JSON-ответы как JSON</label><span className="chat-menu-section">Тема</span><div className="theme-choice" role="group" aria-label="Тема оформления"><button type="button" className={theme === "dark" ? "active" : ""} aria-pressed={theme === "dark"} onClick={() => selectTheme("dark")}>Тёмная</button><button type="button" className={theme === "light" ? "active" : ""} aria-pressed={theme === "light"} onClick={() => selectTheme("light")}>Светлая</button></div><span className="chat-menu-section">Автоматизация</span>{activeHarnessSupportsAutocontinue && <button className="quiet-button" onClick={() => { setShowJobs(false); setShowStatistics(false); setShowQuota(false); setAutomationSettings("autocontinue"); setChatMenuOpen(false); }}>{`Автопродолжение · восстановление после сбоев: ${activeAutocontinueEnabled ? "включено" : "выключено"}`}</button>}{activeHarnessSupportsAutopilot && <button className="quiet-button" onClick={() => { setShowJobs(false); setShowStatistics(false); setShowQuota(false); setAutomationSettings("autopilot"); setChatMenuOpen(false); }}>{`Автопилот · завершение задач: ${activeAutopilotEnabled ? "включён" : "выключен"}`}</button>}<span className="chat-menu-section">Разделы</span><button className="quiet-button" onClick={() => { setShowJobs(false); setShowStatistics(false); setShowQuota(false); setAutomationSettings("launch-policy"); setChatMenuOpen(false); }}>Настройки запуска новых сессий</button><button className="quiet-button" onClick={() => { setShowJobs(false); setShowStatistics(false); setShowQuota(false); openSessionInspector(); }}>Настройки текущей сессии</button><button className="quiet-button" onClick={() => { setShowJobs(true); setShowStatistics(false); setChatMenuOpen(false); }}>Задачи</button><button className="quiet-button" onClick={() => { setShowJobs(false); openStatistics(); }}>Статистика</button><button className="quiet-button" onClick={() => { setShowJobs(false); setShowStatistics(false); setAutomationSettings(undefined); setShowQuota(true); setChatMenuOpen(false); }}>Квота</button></div>}
      </header>
      {showFleet && <div className="fleet-overlay" role="dialog" aria-modal="true" aria-label="Машины флота"><div className="fleet-overlay-panel"><button className="fleet-overlay-close quiet-button" aria-label="Закрыть машины флота" onClick={() => setShowFleet(false)}>Закрыть</button><FleetCabinet /></div></div>}
      {showJobs && <JobsView jobs={jobs} loading={jobsLoading} error={jobsError} cancellingJobId={cancellingJobId} onRefresh={() => void loadJobs()} onCancel={(jobId) => void cancelJob(jobId)} />}
      {showQuota && <QuotaPanel />}
      {showStatistics && <StatisticsView statistics={statistics} loading={statisticsLoading} error={statisticsError} days={statisticsDays} onDays={changeStatisticsDays} onRefresh={() => void loadStatistics(statisticsDays, true)} />}
      {!showStatistics && !showJobs && !showQuota && automationSettings && <div className="autopilot-settings-overlay" ref={automationDialogRef} role="dialog" aria-modal="true" aria-label="Настройки автоматизации"><div className="autopilot-settings-shell"><button className="settings-close" aria-label={`Закрыть настройки ${automationSettings === "launch-policy" ? "запуска новых сессий" : automationSettings === "autocontinue" ? "автопродолжения" : "автопилота"}`} onClick={() => setAutomationSettings(undefined)}>×</button>{automationSettings === "launch-policy" ? <LaunchPolicySettings /> : <AutomationSettings section={automationSettings} state={autopilotPolicy} draft={autopilotPolicyDraft} saving={autopilotPolicySaving} error={autopilotPolicyError} saved={autopilotPolicySaved} continuation={continuationHarnesses} continuationSaving={continuationHarnessSaving} continuationError={continuationHarnessError} runtimeState={runtimeSettingsState} runtimeDraft={runtimeSettingsDraft} runtimeSaving={runtimeSettingsSaving} runtimeSaved={runtimeSettingsSaved} runtimeError={runtimeSettingsError} modelOptions={runtimeModelOptions} sessionControlAvailable={automationSettings === "autocontinue" ? Boolean(sessionAutostart) : Boolean(autopilotSession)} sessionControlStatus={automationSettings === "autocontinue" ? `Текущая сессия: автопродолжение ${sessionAutostart?.enabled ? "включено" : "выключено"}` : `Текущая сессия: автопилот ${autopilotSession?.enabled ? "включён" : "выключен"}`} capabilityNote={activeSession && !activeHarnessSupportsAutocontinue ? `Автопродолжение после сбоя для ${AUTOPILOT_HARNESS_LABELS[activeSession.harness as AutopilotHarness]} пока недоступно. Автопилот может оценивать завершение задач и продолжать их по своей политике.` : undefined} onChange={(next) => { setAutopilotPolicyDraft(next); setAutopilotPolicySaved(false); }} onSave={() => void saveAutopilotPolicy()} onGlobalContinuationToggle={() => void toggleGlobalContinuation()} onContinuationToggle={(harness) => void toggleContinuationHarness(harness)} onRuntimeChange={(next) => { setRuntimeSettingsDraft(next); setRuntimeSettingsSaved(false); }} onRuntimeSave={() => void saveRuntimeSettings()} onOpenSessionControl={() => openSessionInspector(automationSettings === "autocontinue" ? "autocontinue" : "autopilot")} />}</div></div>}
      {!showStatistics && !showJobs && !showQuota && !!details?.children?.length && <details className="subagents-panel"><summary>Субагенты <span>{details.children.length}</span></summary><div className="subagents-list">{details.children.map((child) => <button className="subagent-row" key={keyOf(child)} onClick={() => { selectSession(keyOf(child)); setMobileView("chat"); }}><span className={`status-dot status-${statusClass(child.status)}`} /><span><strong>{child.title || child.id}</strong><small>{typeof child.meta?.agentRole === "string" ? child.meta.agentRole : statusLabel(child.status)} · {child.id}</small></span></button>)}</div></details>}
      {!showStatistics && !showJobs && !showQuota && <div className="chat-scroll" ref={chatScrollRef} onScroll={handleChatScroll}>
        <div className="message-column" role="log" aria-live="polite" aria-relevant="additions text" aria-label="Переписка">
          {detailsLoading && !details && <div className="session-loading-chat" aria-live="polite"><div className="session-loading-orbit"><span /><span /><span /></div><strong>Загружаю свежие сообщения</strong><small>Начинаем с последних ходов; остальным Agent Herder можно пользоваться дальше.</small></div>}
          {!detailsLoading && !details && <div className="empty-chat">{detailsError || "Выберите сессию, чтобы открыть переписку."}</div>}
          {detailsHydrating && details && <div className="history-loading-banner"><span className="inline-loading-dot" /> Последние {formatLoadTiming(latestTimingMs)} · подгружаю историю и метрики…</div>}
          {groupSessionMessages(details?.messages || []).map((group, groupIndex, groups) => {
            const visible = group.messages.filter((message) => hasVisibleMessage(message, showReasoning, showTools));
            if (visible.length === 0) return null;
            const isLastAssistant = group.role === "assistant" && groupIndex === groups.length - 1;
            return <article className={`message ${group.role}`} key={group.id}><div className="message-meta"><span>{group.role === "user" ? "Вы" : group.role === "tool" ? "Инструмент" : "Агент"}</span><time>{formatTime(group.timestamp || "")}</time></div>{visible.map((message, index) => {
              const noteLabel = serviceNoteLabel(message);
              return noteLabel ? <ServiceNote key={message.id} label={noteLabel} message={message} /> : <CollapsibleMessage key={message.id} message={message} showReasoning={showReasoning} showTools={showTools} jsonRendering={jsonRendering} forceExpanded={isLastAssistant && index === visible.length - 1} />;
            })}</article>;
          })}
        </div>
      </div>}
      {!showStatistics && !showJobs && !showQuota && showScrollToLatest && <button className="scroll-latest" aria-label="Прокрутить к последним" onClick={scrollToBottom}>↓</button>}
      {!showStatistics && !showJobs && !showQuota && <div className="composer-stack">
      <div className="activity-slot">{sessionActivity && <div className={`activity-line activity-${sessionActivity.kind}`} role="status" aria-live="polite"><span className="pulse-dot" aria-hidden="true" />{activeSession?.status === "running" && !sending ? <span><ActivityElapsed sinceMs={runningSince} />{sessionActivity.label ? <em className="activity-detail"> · {sessionActivity.label}</em> : null}</span> : <span>{sessionActivity.label}</span>}</div>}</div>
      {activeOutbox.length > 0 && <div className="composer-outbox" aria-label="Отправленные сообщения и их состояние">
        {activeOutbox.map((entry) => <div className={`composer-outbox-entry status-${entry.status}`} key={entry.inputId}>
          <div className="composer-outbox-meta">
            <span className="composer-outbox-mode">{deliveryModeLabel(entry.mode)}</span>
            <span className="composer-outbox-status">{outboxStatusLabel(entry.status)}</span>
            {entry.status === "unknown" && <button type="button" className="composer-outbox-retry" onClick={() => void checkOutboxEntry(entry)}>Проверить доставку</button>}
            {entry.status === "ready" && <button type="button" className="composer-outbox-retry" disabled={messageDispatcherRef.current.hasPending(entry.inputId)} onClick={() => void retryOutboxEntry(entry.inputId)}>Отправить</button>}
            {entry.status === "failed" && entry.nonRetryable !== true && <button type="button" className="composer-outbox-retry" onClick={() => void retryOutboxEntry(entry.inputId)} title="Повторить отправку">Повторить</button>}
            {canSteerOutboxEntry(entry, splitKey(entry.sessionKey).harness) && <button type="button" className="composer-outbox-retry" disabled={cancellingOutbox.has(entry.inputId)} onClick={() => void steerOutboxEntry(entry.inputId)} title="Убрать из очереди и вставить в текущий ход агента">Отправить сейчас</button>}
            {canDeleteOutboxEntry(entry) && <button type="button" className="composer-outbox-delete" disabled={cancellingOutbox.has(entry.inputId)} aria-label="Удалить сообщение из очереди" onClick={() => void deleteOutboxEntry(entry.inputId)}>Удалить</button>}
            {(entry.status === "delivered" || entry.status === "accepted" || entry.status === "failed" || entry.status === "unknown") && <button type="button" className="composer-outbox-dismiss" aria-label="Убрать сообщение из списка" onClick={() => dismissOutboxEntry(entry.inputId)}>×</button>}
          </div>
          <div className="composer-outbox-text">{entry.text}</div>
          {entry.error && <div className="composer-outbox-error">Детали: {entry.error}</div>}
          {entry.note && <div className="composer-outbox-note">{entry.note}</div>}
        </div>)}
      </div>}
      <form className="composer" onSubmit={(event) => { event.preventDefault(); if (isResumeMode) void runAction("resume"); else void sendMessage(); }}>
        {showCreateSession && <div className="composer-create-panel">
          <div className="composer-create-row">
            <label>Агент<select value={createHarness} onChange={(event) => { const harness = event.target.value; setCreateHarness(harness); setCreateModel(""); setCreateModels([]); void loadCreateModels(harness); }}>{(createAdapters.length ? createAdapters : [{ id: "fast-agent", name: "Fast Agent", active: true, ready: true, status: "active" }]).map((adapter) => <option key={adapter.id} value={adapter.id} disabled={!adapter.active}>{adapter.name}{adapter.active ? "" : ` · ${adapter.status}`}</option>)}</select></label>
            <label className="cwd-picker">Папка<input value={createCwd} onChange={(event) => { const value = event.target.value; setCreateCwd(value); void loadCwdSuggestions(value); }} onFocus={() => void loadCwdSuggestions(createCwd.endsWith("/") ? createCwd : `${createCwd}/`)} onBlur={() => window.setTimeout(() => setCwdSuggestionsOpen(false), 120)} placeholder="/home/roomhacker/project" autoComplete="off" />{cwdSuggestionsOpen && cwdSuggestions.length > 0 && <div className="cwd-suggestions">{cwdSuggestions.map((item) => <button type="button" key={item.path} onMouseDown={(event) => event.preventDefault()} onClick={() => { setCreateCwd(`${item.path}/`); void loadCwdSuggestions(`${item.path}/`); }}><span className="cwd-folder">▱</span><span>{item.name}</span><small>{item.path}</small></button>)}</div>}</label>
            <label>Модель{createModels.length > 0 ? <select value={createModel} onChange={(event) => setCreateModel(event.target.value)}>{createModels.map((model) => <option key={model} value={model}>{model === "anthropic.MiniMax-M3.1-Flash-Preview" ? "MiniMax M3.1 Flash" : model}</option>)}</select> : createModelsRefreshing ? <select disabled><option>загрузка моделей…</option></select> : <input value={createModel} onChange={(event) => setCreateModel(event.target.value)} placeholder="модель (кэш пуст)" />}</label>
            <button type="button" className="primary-button composer-create-submit" disabled={creatingSession || !createCwd.trim()} onClick={() => void createNewSession()}>{creatingSession ? "…" : "Создать"}</button>
          </div>
          {createSessionError && <div className="create-session-error">{createSessionError}</div>}
        </div>}
        <button type="button" className={`composer-plus ${showCreateSession ? "active" : ""}`} aria-label="Новая сессия" title="Новая сессия агента" onClick={() => { if (showCreateSession) setShowCreateSession(false); else void openCreateSession(); }}>+</button>
        {readOnlySession ? <div className="composer-readonly"><strong>{archivedSession ? "Архивная сессия" : "Только просмотр"}</strong><span>{archivedSession ? "Сохранённая история сессии доступна для просмотра." : "Эта сессия пока не поддерживает отправку сообщений."}</span></div> : <>
          <textarea value={composer} onChange={(event) => setComposer(event.target.value)} placeholder={isResumeMode ? "Продолжите работу…" : activeKey ? "Работайте с агентом" : "Сначала выберите сессию"} disabled={!activeKey || readOnlySession} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && composer.trim()) { event.preventDefault(); void sendMessage(); } }} />
          <span className="composer-hint">{sending ? "Отправляю сообщения…" : isResumeMode ? "Продолжить" : "Enter — отправить · Shift+Enter — новая строка"}</span>
          {modelSwitchHarness && <button type="button" className={`composer-model ${modelMenuOpen ? "open" : ""}`} aria-label="Выбрать модель" aria-expanded={modelMenuOpen} aria-haspopup="listbox" disabled={modelSwitching} onClick={toggleModelMenu}>
            <span className="composer-model-name">{shortModelLabel(activeSession?.model)}</span>
            {!activeSession?.model && <span className="composer-model-default">по умолчанию</span>}
            <span className="composer-model-chevron" aria-hidden="true">▾</span>
          </button>}
          {modelMenuOpen && modelSwitchHarness && <div className="composer-model-menu" role="listbox" aria-label="Модели {modelSwitchHarness}">
            {modelSwitchError && <div className="composer-model-note error" role="alert">{modelSwitchError}</div>}
            {modelOptionsLoading && <div className="composer-model-note">Загружаю модели…</div>}
            {!modelOptionsLoading && modelOptionsHarness === modelSwitchHarness && modelOptions.length === 0 && <div className="composer-model-note">Сервер не вернул моделей для {modelSwitchHarness}.</div>}
            {modelOptions.map((model) => <button type="button" role="option" aria-selected={model === currentModelOption(activeSession?.model, modelOptions)} className={model === currentModelOption(activeSession?.model, modelOptions) ? "current" : ""} key={model} onClick={() => void changeSessionModel(model)}>{shortModelLabel(model)}</button>)}
          </div>}
          <button className="send-button" type={isResumeMode ? "button" : "submit"} onClick={isResumeMode ? () => void runAction("resume") : undefined} disabled={!activeKey || (!isResumeMode && !composer.trim())} aria-label={isResumeMode ? "Продолжить сессию" : "Отправить сообщение"}>{isResumeMode ? "▶" : "↑"}</button>
        </>}
      </form></div>}
    </section>
    {showInspector && !showStatistics && !showJobs && <aside className="inspector-pane"><div className="inspector-heading"><span className="eyebrow">СЕССИЯ</span><button className="icon-button" onClick={closeSessionInspector} aria-label={sessionSettingsReturn ? "Вернуться к общим настройкам" : "Закрыть настройки сессии"}>×</button></div>{activeSession ? <><div className="inspector-title">{cleanSessionTitle(activeSession.title) || activeSession.title || activeSession.id}</div><div className="inspector-status"><span className={`status-dot status-${statusClass(activeSession.status)}`} /><span className={`status-label status-${statusClass(activeSession.status)}`}>{activeSession.meta?.humanStopHeld === true ? "Явная остановка — автоматика приостановлена" : statusLabel(activeSession.status)}</span></div>{sessionAutostart && <div className="autopilot-control session-autostart-control"><div><span className="eyebrow">АВТОПРОДОЛЖЕНИЕ</span><strong>{sessionAutostart.enabled ? "Включено" : "Выключено"}</strong><small>{sessionAutostart.source === "session" ? "Отдельная настройка этой сессии. Переключатель применяется сразу только здесь." : sessionAutostart.source === "harness" ? `Сейчас наследуется общая настройка для ${activeSession.harness}. Нажатие создаст исключение только для этой сессии и применится сразу.` : sessionAutostart.source === "global" ? "Сейчас наследуется общий переключатель. Нажатие создаст исключение только для этой сессии и применится сразу." : "Используется значение по умолчанию. Нажатие создаст отдельную настройку только для этой сессии и применится сразу."}</small>{sessionAutostart.source === "session" && <button className="inherit-button" disabled={sessionAutostartSaving} onClick={() => void inheritSessionAutostart()}>Использовать общую настройку {activeSession.harness}</button>}</div><button className={`switch-control ${sessionAutostart.enabled ? "enabled" : ""}`} role="switch" aria-checked={sessionAutostart.enabled} aria-label="Автопродолжение для текущей сессии" disabled={sessionAutostartSaving} onClick={() => void toggleSessionAutostart()}><span /></button></div>}{sessionAutostartError && <small className="autopilot-error">{sessionAutostartError}</small>}{autopilotSession && <div className="autopilot-control"><div><span className="eyebrow">АВТОПИЛОТ</span><strong>{autopilotSession.enabled ? "Включён" : "Выключен"}</strong><small>{autopilotSession.source === "session" ? "Отдельная настройка этой сессии. Переключатель применяется сразу только здесь." : autopilotSession.source === "policy" ? (autopilotPolicyDraft?.enabled && !autopilotPolicyDraft.harnesses.includes(activeSession.harness as AutopilotHarness) ? `${AUTOPILOT_HARNESS_LABELS[activeSession.harness as AutopilotHarness]} выключен в общих настройках сред. Нажатие включит автопилот только для этой сессии и применится сразу.` : "Сейчас наследуется общая настройка автопилота. Нажатие создаст исключение только для этой сессии и применится сразу.") : autopilotSession.source === "plugin-default" ? "Сейчас наследуется настройка среды. Нажатие создаст исключение только для этой сессии и применится сразу." : "По умолчанию выключен. Нажатие включит автопилот только для этой сессии и применится сразу."}</small>{autopilotSession.source === "session" && <button className="inherit-button" disabled={autopilotSessionSaving} onClick={() => void inheritAutopilotSession()}>Использовать общую настройку</button>}</div><button className={`switch-control ${autopilotSession.enabled ? "enabled" : ""}`} role="switch" aria-checked={autopilotSession.enabled} aria-label="Автопилот для текущей сессии" disabled={autopilotSessionSaving} onClick={() => void toggleAutopilotSession()}><span /></button></div>}{autopilotSessionError && <small className="autopilot-error">{autopilotSessionError}</small>}<dl><dt>Агент</dt><dd>{activeSession.harness}</dd><dt>Папка</dt><dd title={activeSession.cwd}>{lastSegment(activeSession.cwd)}</dd>{activeSession.model && <><dt>Модель</dt><dd title={activeSession.model}>{shortModel(activeSession.model)}</dd></>}{activeSession.messageCount !== undefined && <><dt>Сообщения</dt><dd>{activeSession.messageCount}</dd></>}{activeSession.durationSec !== undefined && <><dt>Длительность</dt><dd>{formatDuration(activeSession.durationSec)}</dd></>}{activeSession.costUsd !== undefined && <><dt>Стоимость</dt><dd title={activeSession.meta?.pricing_source === "models.dev" ? `Оценка по models.dev · ${String(activeSession.meta?.pricing_provider || "")}/${String(activeSession.meta?.pricing_model || "")}` : undefined}>{`${activeSession.meta?.pricing_kind === "estimate" ? "~" : ""}$${activeSession.costUsd.toFixed(4)}`}</dd></>}{metaNumber(activeSession, ["total_tokens", "totalTokens", "tokens"]) !== undefined && <><dt>Токены</dt><dd>{metaNumber(activeSession, ["total_tokens", "totalTokens", "tokens"])}</dd></>}{(details?.children?.length || 0) > 0 && <><dt>Субагенты</dt><dd>{details?.children?.length}</dd></>}</dl>{activeSession.messageCount === 0 && <div className="inspector-empty-metrics">Пока нет сообщений. Отправьте сообщение или продолжите сессию.</div>}<div className="inspector-actions">{visualizationUrl && <a className="quiet-button" href={visualizationUrl} target="_blank" rel="noreferrer" title="Откроется в новой вкладке">Визуализация ↗</a>}{(activeSession.status === "running" || sending) && <button className="stop-button" onClick={() => void runAction("stop")}>Остановить</button>}{(activeSession.status === "stopped" || activeSession.status === "error" || activeSession.meta?.humanStopHeld === true) && <button className="primary-button" onClick={() => void runAction("resume")}>Возобновить работу</button>}{activeSession.status === "error" && <button className="quiet-button" onClick={() => void runAction("recover")}>Восстановить</button>}</div><div className="settings-block"><span className="eyebrow">ВИД</span><small className="settings-hint">Что показывать в переписке</small><label><input type="checkbox" checked={showReasoning} onChange={(event) => setShowReasoning(event.target.checked)} /> Размышления</label><label><input type="checkbox" checked={showTools} onChange={(event) => setShowTools(event.target.checked)} /> Инструменты</label><label><input type="checkbox" checked={jsonRendering} onChange={(event) => setJsonRendering(event.target.checked)} /> JSON-ответы как JSON</label><span className="eyebrow theme-choice-label">ТЕМА</span><div className="theme-choice" role="group" aria-label="Тема оформления"><button type="button" className={theme === "dark" ? "active" : ""} aria-pressed={theme === "dark"} onClick={() => selectTheme("dark")}>Тёмная</button><button type="button" className={theme === "light" ? "active" : ""} aria-pressed={theme === "light"} onClick={() => selectTheme("light")}>Светлая</button></div></div></> : <div className="empty-inspector">Сессия не выбрана.</div>}</aside>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
