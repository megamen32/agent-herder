import {AUTOCONTINUE_HARNESS_IDS,loadAutocontinueHarnesses,saveAutocontinueHarness,type AutocontinueHarness,type WebSessionAutostartHarness} from "./autocontinue-harnesses.js";
import * as React from "react";
import type { AgentActivityStatistics, DistributionSummary as StatisticsDistribution } from "../session-statistics.js";
import { createRoot } from "react-dom/client";
import {ComposerSendControl,QueueProcessingControl,VoiceComposerControl,isComposerSubmitShortcut} from "./composer-controls.js";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SESSION_LIST_REFRESH_MS, sessionListRefreshDelay, sampleSessionActivity, filterAndArrangeSessions, matchesSessionQuery, pluralRu, projectFor, sessionKey, sessionTurnLinkFromHash, selectionAfterSessionRefresh, sessionListCounts, sessionListCounterRu, sessionListEmptyReason, summarizeSessionSample, type SessionListEntry, type SessionListSession, type SessionListSettings, type SessionListSort, type SessionSampleCounts } from "./session-list.js";
import { CodexQuotaSettings } from "./codex-quota-settings.js";
import { QuotaPanel } from "./quota-panel.js";
import { QuotaRecoveryControls } from "./quota-recovery-controls.js";
import { AutoCompactSettingsPanel } from "./auto-compact-settings.js";
import { LaunchPolicySettings } from "./launch-policy-settings.js";
import { FallbackModelsSettings } from "./fallback-models-controls.js";
import { SettingsScreen } from "./settings/settings-screen.js";
import { SessionMetadata } from "./session-metadata.js";
import { NativePermissionStrip } from "./native-permission.js";
import { ComposerQueue,canEditQueuedEntry } from "./composer-queue.js";
import { emptyInspectorText, sessionDetailsErrorText } from "./session-error-text.js";
import { HarnessAutomationSettings, withAutopilotHarness } from "./harness-automation-settings.js";
import "./styles.css";
import "./codex-theme.css";
import "./interface-polish.css";
// The stylesheet of the Projects screen goes last so that the mobile
// navigation and the collapsed rows of the projects win the cascade.
import "./projects-screen.css";
import { CodexNavigation } from "./codex-navigation.js";
import {useFleetDirectory} from './fleet/use-directory.js';
import {mergeActiveActivity} from './active-activity.js';
import {useActiveActivity} from './use-active-activity.js';
import {SessionWorkTarget, SessionInspectBlock, type SessionInspectFacts} from './session-work-target.js';
import {SessionQuickFilters, type SessionStatusFilter, type SessionQuickFilterCounts} from './session-list-quick-filters.js';
import { mergeScopeAnswers, sessionScopeQuery, sliceScopeQueries, statusInSlice, useSessionScope } from './session-list-scope.js';
import {useSessionFacts} from './use-session-facts.js';
import {SessionActivityPanel} from './session-activity-panel.js';
import {readPanelLayout, writePanelLayout, type PanelLayout} from './ui-layout.js';
import {directorySession} from './fleet/session-directory.js';
import {RemoteSessionView,TranscriptRequestOwner,fetchIntegratorTranscriptPage,firstEventIndexForTurn,integratorEventDisplay,localTranscriptAddressFor,mergeTranscriptPageIfCurrent,readSessionQueueProcessing,submitSessionQueueProcessing,transcriptForAddress,transcriptValueIfCurrent,type TranscriptView} from './fleet/RemoteSessionView.js';
import {SessionViewCache,indexedViewCacheStore,readViewCacheSettings,writeViewCacheSettings,type ViewCacheSettings} from './fleet/view-cache.js';
import type {MeshAddress} from '../mesh/protocol.js';
import { FleetCabinet } from "./fleet/FleetCabinet.js";
import { RagSearchView } from "./rag-search-view.js";
import { creationModels } from "./creation-models.js";
import { isLongVisibleMessage, readCollapseLongMessages, writeCollapseLongMessages } from "./message-collapse.js";
import { groupSessionMessages } from "./message-groups.js";
import { projectDeliveredChat, resolveDeliveredImages } from "./delivered-chat.js";
import {sidebarEntries, sessionPinKey, projectLocalSessionHost} from './session-pins.js';
import {SessionSidebarRow, useSessionPins} from './session-sidebar.js';
import { DetailsReadGate } from "./details-read-gate.js";
import { MessageAdmissionDispatcher, appendOutboxEntry, beginOutboxAttempt, canDeleteOutboxEntry, canSteerOutboxEntry, cancelOutcomeOfJob, classifyMessageDelivery, deliveryConnectionFailure, deliveryModeLabel, isOutboxUnfinished, isTerminalJobState, newInputId, outboxStatusLabel, planContinuation, readDefaultDeliveryMode, readDeliveryModePinned, readOutboxJobId, readStoredOutbox, reconcileMessageStatus, removeOutboxEntry, updateOutboxEntry, withOutboxJobId, writeDefaultDeliveryMode, writeDeliveryModePinned, writeStoredOutbox, type CancelOutcome, type DeliveryMode, type OutboxEntry } from "./composer-delivery.js";
import { formatJsonPayload, readJsonRenderingOptOut, splitSystemBlocks, writeJsonRenderingOptOut } from "./json-rendering.js";
import { applyTheme, readTheme, writeTheme, type HerderTheme } from "./theme.js";
import { readSessionSearchPreferences, writeSessionSearchPreferences } from "./search-preferences.js";
import { readDisplayPreference, writeDisplayPreference, REASONING_DISPLAY_STORAGE_KEY, TOOLS_DISPLAY_STORAGE_KEY } from "./display-preferences.js";
import { currentModelOption, modelSwitchSupported, requestModelChange, shortModelLabel, modelOptionLabel, modelSourceLabel } from "./model-chip.js";
import { readSessionListSettings, writeSessionListSettings, SESSION_LIST_SHOW_COMPLETED_ARIA, SESSION_LIST_SHOW_COMPLETED_HINT, SESSION_LIST_SHOW_COMPLETED_LABEL } from "./session-list-preferences.js";
import { readModelTimeline, writeModelTimeline, recordModelAt, modelAt, latestModel, type ModelTimelineEntry } from "./session-model-timeline.js";
import type { UploadedImage } from "../session-images.js";
import type { HarnessPermissionState, SessionMessageView } from "../types/index.js";

type HerderSession = SessionListSession & {
  lastMessage?: string;
  model?: string;
  needsPermission?: boolean;
  permissionDetails?: {id:string;type:string;toolName?:string;description:string;details?:string};
  messageCount?: number;
  durationSec?: number;
  /** Траты сессии в долларах, если их сообщила среда. */
  costUsd?: number;
};
type SessionMessage = SessionMessageView;
type SessionDetails = { session: HerderSession; lineage?: { kind?: string; parentId?: string; role?: string; task?: string }; children?: HerderSession[]; messages: SessionMessage[] };
type PermissionModeRead = { available: boolean; permissionState?: HarnessPermissionState; reason?: string };
type PermissionModeAttempt = { inputId: string; expectedCurrentMode: string; mode: string; status: "unknown" | "accepted"; at: string };
type MinimaxExecPolicyMode = "unset" | "smart" | "full" | "off";
type MinimaxExecPolicy = { target: { hostId: string; harness: "minimax-code"; sessionId: string }; scope: "next_herder_cli_exec"; mode: MinimaxExecPolicyMode; revision: number; updatedAt: string };
type MinimaxExecPolicyRead = { available: boolean; policy?: MinimaxExecPolicy; nativeMode?: { state: "unknown"; reason: string }; error?: string };
function MinimaxExecPolicyPanel({ session }: { session: { hostId?: string; harness: string; id: string } }) {
  const [read, setRead] = React.useState<MinimaxExecPolicyRead>();
  const [choice, setChoice] = React.useState<MinimaxExecPolicyMode>("unset");
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/sessions/minimax-code/${encodeURIComponent(session.id)}/herder-exec-policy`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      const next = await response.json().catch(() => undefined) as MinimaxExecPolicyRead | undefined;
      if (!response.ok || !next?.available || !next.policy) throw new Error(next?.error || "Настройка политики недоступна.");
      setRead(next);
      setChoice(next.policy.mode);
      setError("");
    } catch (cause) { setRead(undefined); setError(cause instanceof Error ? cause.message : "Настройка политики недоступна."); }
    finally { setLoading(false); }
  }, [session.id]);
  React.useEffect(() => { void refresh(); }, [refresh, session.hostId]);
  const save = React.useCallback(async () => {
    if (!session.hostId || !read?.policy || saving) return;
    setSaving(true); setError("");
    try {
      const response = await fetch(`/api/sessions/minimax-code/${encodeURIComponent(session.id)}/herder-exec-policy`, {
        method: "PUT", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ hostId: session.hostId, expectedRevision: read.policy.revision, mode: choice }),
      });
      const receipt = await response.json().catch(() => undefined) as { state?: string; policy?: MinimaxExecPolicy; error?: string } | undefined;
      if (!response.ok || receipt?.state !== "configured" || !receipt.policy) throw new Error(receipt?.error || "Настройка не сохранена.");
      setRead((current) => current ? { ...current, policy: receipt.policy } : current);
      setChoice(receipt.policy.mode);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Настройка не сохранена.");
      await refresh();
    } finally { setSaving(false); }
  }, [session.hostId, session.id, read?.policy, choice, saving, refresh]);
  const label = (mode: MinimaxExecPolicyMode) => mode === "unset" ? "Как сейчас (без override)" : mode === "full" ? "Полный доступ" : mode === "off" ? "Без инструментов" : "Smart";
  return <section className="permission-mode-control" aria-label="Политика запусков MiniMax через Herder">
    <div className="permission-mode-heading"><span className="eyebrow">ЗАПУСКИ ЧЕРЕЗ HERDER</span><button className="quiet-button" disabled={loading || saving} onClick={() => void refresh()}>{loading ? "Читаю…" : "Обновить"}</button></div>
    <div className="permission-mode-facts"><span>Текущий native режим</span><strong>неизвестен</strong><span>Для новых запусков через Herder</span><strong>{read?.policy ? label(read.policy.mode) : "не загружено"}</strong></div>
    <small>Политика применяется только к точному MiniMax CLI fallback. Если доступен Desktop путь, отправка с ненулевой политикой будет остановлена; Herder не переключает транспорт молча. Native режим сессии это не меняет.</small>
    {read?.policy && <div className="permission-mode-editor"><label>Политика следующих запусков<select aria-label="Политика запусков MiniMax через Herder" value={choice} onChange={(event) => setChoice(event.target.value as MinimaxExecPolicyMode)} disabled={saving || loading}><option value="unset">{label("unset")}</option><option value="smart">{label("smart")}</option><option value="full">{label("full")}</option><option value="off">{label("off")}</option></select></label><button className="quiet-button" disabled={saving || loading || choice === read.policy.mode} onClick={() => void save()}>{saving ? "Сохраняю…" : "Сохранить для Herder"}</button><small>Версия настройки: {read.policy.revision}. Изменение блокируется, пока отправка в эту сессию уже принята.</small></div>}
    {error && <small className="permission-mode-error">{error}</small>}
  </section>;
}
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
const AUTOCONTINUE_HARNESSES = new Set<string>(AUTOCONTINUE_HARNESS_IDS);

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
  return sessionTurnLinkFromHash(window.location.hash)?.sessionKey;
};
const readTurnFromHash = (): string | undefined => sessionTurnLinkFromHash(window.location.hash)?.turnId;
const permissionModeAttemptsStorageKey = (hostId: string, harness: string, sessionId: string): string =>
  `agent-herder.permission-mode-attempts:${JSON.stringify([hostId, harness, sessionId])}`;
const readPermissionModeAttempts = (hostId: string, harness: string, sessionId: string): PermissionModeAttempt[] => {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(permissionModeAttemptsStorageKey(hostId, harness, sessionId)) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is PermissionModeAttempt => Boolean(entry && typeof entry === "object"
      && typeof entry.inputId === "string" && typeof entry.expectedCurrentMode === "string"
      && typeof entry.mode === "string" && (entry.status === "unknown" || entry.status === "accepted")
      && typeof entry.at === "string"));
  } catch { return []; }
};
const writePermissionModeAttempts = (hostId: string, harness: string, sessionId: string, attempts: PermissionModeAttempt[]): void => {
  try { window.localStorage.setItem(permissionModeAttemptsStorageKey(hostId, harness, sessionId), JSON.stringify(attempts.slice(-20))); }
  catch { /* The server ledger remains authoritative if browser storage is unavailable. */ }
};
const writeSessionToHash = (key?: string) => {
  const linked=sessionTurnLinkFromHash(window.location.hash);
  const focus=key&&linked?.sessionKey===key&&linked.turnId?`?turn=${encodeURIComponent(linked.turnId)}`:"";
  const target = key ? `#/session/${encodeURIComponent(key)}${focus}` : `${window.location.pathname}${window.location.search}`;
  if (window.location.hash !== (key ? target : "")) {
    history.replaceState(null, "", key ? target : target || window.location.pathname);
  }
};
const formatTime = (value: string) => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(timestamp) : "";
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
    case "idle": return "Ожидает ввода";
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
/**
 * The window of the list of the sessions that the panel asks for.
 *
 * The whole list of the mesh is megabytes of JSON, and a browser that
 * parses it on the first paint does not come alive. The panel asks for a
 * window and shows the counter of the whole list, so the owner knows that
 * the list is longer than the window and can load more.
 */
const SESSION_LIST_WINDOW = 100;

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
  const [harness, setHarness] = React.useState("all");
  const harnessName = (name: string) => (({ codex: "Codex", opencode: "OpenCode", zcode: "ZCode" } as Record<string, string>)[name] || name);
  const ranges = <div className="statistics-range" role="group" aria-label="Период статистики">{[7, 30, 90].map((value) => <button className={days === value ? "active" : ""} aria-pressed={days === value} key={value} onClick={() => onDays(value)}>{value} дн.</button>)}</div>;
  if (!statistics || (statistics.refreshing && statistics.sample.sessionFiles === 0)) return <div className="statistics-loading">
    {ranges}{loading && <div className="session-loading-orbit"><span /><span /><span /></div>}
    <strong>{loading ? "Подготавливаю статистику агентов…" : "Статистика недоступна"}</strong>
    <small>{error || statistics?.refreshError || "Первый расчёт идёт в фоне. Повторные открытия используют кеш неизменившихся историй Codex, OpenCode и ZCode."}</small>
    {statistics?.progress && <small role="status">{harnessName(statistics.progress.harness)}: {statistics.progress.total > 1 ? `${formatStatCount(statistics.progress.processed)} из ${formatStatCount(statistics.progress.total)} сессий` : "читаю источник…"}</small>}
    {!loading && <button className="quiet-button" onClick={onRefresh}>Повторить</button>}
  </div>;
  const sources = statistics.byHarness || [];
  const selected = harness === "all" ? undefined : sources.find((item) => item.harness === harness);
  const data = selected || statistics;
  const thresholds = [30, 60, 120, 180, 300];
  const maxHistogram = Math.max(1, ...data.sameFileRevisits.histogram.map((item) => item.percent));
  const p = data.sameFileRevisits.percentilesSec;
  const ap = data.activityGaps.percentilesSec;
  const deep = selected?.deep || statistics.deep || statistics.codexDeep;
  const totalSessions = sources.reduce((sum, item) => sum + item.deep.sessions, 0);
  const topHarnessMax = Math.max(1, ...sources.map((item) => item.deep.sessions));
  const topModelMax = Math.max(1, ...deep.models.slice(0, 8).map((item) => item.count));
  const dayMax = Math.max(1, ...(deep.sessionsByDay || []).map((item) => item.count));
  const leaseSec = ap.p95 > 0 ? Math.max(60, Math.min(180, Math.ceil(ap.p95 / 15) * 15)) : 60;
  return <div className="statistics-scroll"><div className="statistics-page">
    <div className="statistics-hero">
      <div><span className="eyebrow">АКТИВНОСТЬ АГЕНТОВ</span><h2>Статистика</h2><p>Общие показатели по сохранённым сессиям Codex, OpenCode и ZCode. Выберите среду, чтобы увидеть её вклад и покрытие данных.</p></div>
      <div className="statistics-controls">{ranges}<button className="quiet-button" disabled={loading} onClick={onRefresh}>{loading ? `Обновляю ${days} дн.…` : "Обновить"}</button></div>
     </div>
     <div className="statistics-controls" style={{ marginBottom: 14 }}><div className="statistics-range" role="group" aria-label="Среда статистики"><button className={harness === "all" ? "active" : ""} aria-pressed={harness === "all"} onClick={() => setHarness("all")}>Все среды</button>{sources.map((item) => <button key={item.harness} className={harness === item.harness ? "active" : ""} aria-pressed={harness === item.harness} onClick={() => setHarness(item.harness)}>{harnessName(item.harness)}</button>)}</div></div>
     {(error || statistics.refreshError) && <div className="statistics-warning">Последнее обновление не удалось: {error || statistics.refreshError}</div>}
     {loading && <div className="history-loading-banner" role="status"><span className="inline-loading-dot" /> Обновляю данные за {days} дней. Пока показан последний расчёт за {statistics.windowDays} дней.{statistics.progress && ` ${harnessName(statistics.progress.harness)}: ${formatStatCount(statistics.progress.processed)} из ${formatStatCount(statistics.progress.total)}.`}</div>}
     {sources.filter((item) => item.source.state !== "ready").map((item) => <div className="statistics-warning" key={item.harness}>{harnessName(item.harness)}: {item.source.state === "partial" ? "данные доступны частично" : "источник недоступен"}{item.source.reason ? `. ${item.source.reason}` : ""}</div>)}
    <div className="statistics-cards">
      <article><span>Выборка сессий</span><strong>{formatStatCount(deep.sessions)}</strong><small>{formatStatCount(data.sample.sessionsWithPatches)} с изменениями файлов · {statistics.windowDays} дн.</small></article>
      <article><span>События записи</span><strong>{formatStatCount(data.sample.pathWriteEvents)}</strong><small>{formatStatCount(data.sample.patchCalls)} серий изменений</small></article>
      <article><span>Возвраты к тому же файлу</span><strong>{formatStatCount(data.sameFileRevisits.count)}</strong><small>медиана {formatStatDuration(p.p50)} · p95 {formatStatDuration(p.p95)}</small></article>
      <article className="recommendation"><span>Рекомендуемый таймаут неактивности</span><strong>{data.activityGaps.count ? `~${formatStatDuration(leaseSec)}` : "Нет данных"}</strong><small>p95 активности инструментов {formatStatDuration(ap.p95)} · настройка не меняется автоматически</small></article>
    </div>

    <div className="statistics-grid landscape-grid">
      <section className="statistics-panel">
        <div className="statistics-panel-head"><div><span className="eyebrow">СМЕСЬ АГЕНТОВ</span><h3>Вклад каждой среды</h3></div><small>{formatStatCount(totalSessions)} сессий в сохранённых источниках</small></div>
        <div className="ranked-bars">{sources.map((item) => <div className="ranked-row" key={item.harness}><b>{harnessName(item.harness)}</b><div><span style={{ width: `${item.deep.sessions / topHarnessMax * 100}%` }} /></div><em>{formatStatCount(item.deep.sessions)} · {formatPercent(totalSessions ? item.deep.sessions / totalSessions * 100 : 0)}</em></div>)}</div>
      </section>
      <section className="statistics-panel">
        <div className="statistics-panel-head"><div><span className="eyebrow">ПОПУЛЯРНЫЕ МОДЕЛИ</span><h3>Самые используемые модели</h3></div><small>известны для {formatPercent(deep.modelCoveragePercent)} сессий выбранной среды</small></div>
        <div className="ranked-bars model-bars">{deep.models.slice(0, 8).map((item) => <div className="ranked-row" key={item.name}><b title={item.name}>{item.name}</b><div><span style={{ width: `${item.count / topModelMax * 100}%` }} /></div><em>{formatStatCount(item.count)}</em></div>)}</div>
      </section>
    </div>

    <div className="statistics-cards session-metric-cards">
      <article><span>Длительность сессии</span><strong>{deep.durationSec.count ? formatStatDuration(deep.durationSec.median) : "Нет данных"}</strong><small>медиана · среднее {formatStatDuration(deep.durationSec.mean)} · p95 {formatStatDuration(deep.durationSec.p95)}</small></article>
      <article><span>Токены за сессию</span><strong>{deep.tokens.count ? formatStatCount(deep.tokens.median) : "Нет данных"}</strong><small>за всю сессию · среднее {formatStatCount(deep.tokens.mean)} · p95 {formatStatCount(deep.tokens.p95)}</small></article>
      <article><span>Покрытие токенами</span><strong>{formatPercent(deep.tokenCoveragePercent)}</strong><small>{formatStatCount(deep.tokens.count)} из {formatStatCount(deep.sessions)} сессий; неизвестные значения исключены</small></article>
      <article><span>Покрытие длительностью</span><strong>{formatPercent(deep.durationCoveragePercent)}</strong><small>{formatStatCount(deep.durationSec.count)} сессий с известным временем начала и окончания</small></article>
    </div>

    <section className="statistics-panel">
      <div className="statistics-panel-head"><div><span className="eyebrow">ОБЪЁМ СЕССИЙ</span><h3>Сессии по дням последней активности</h3></div><small>{selected ? harnessName(selected.harness) : "Все среды"} · {statistics.windowDays} дн.</small></div>
      <div className="daily-chart">{deep.sessionsByDay.map((item) => <div className="daily-column" key={item.day} title={`${item.day}: ${item.count} сессий`}><span style={{ height: `${Math.max(3, item.count / dayMax * 100)}%` }} /><b>{item.day.slice(5)}</b></div>)}</div>
    </section>

    <section className="statistics-panel">
      <div className="statistics-panel-head"><div><span className="eyebrow">ПОКРЫТИЕ ТАЙМАУТА</span><h3>Что реально покрывают разные таймауты</h3></div><small>Разрыв активности = следующее действие инструмента. Возврат к файлу = следующая запись в тот же путь.</small></div>
      <div className="coverage-legend"><span><i className="activity" />Следующая активность агента</span><span><i className="revisit" />Возврат к тому же файлу</span></div>
      <div className="coverage-chart">{thresholds.map((seconds) => { const activity = coverageFor(data.activityGaps, seconds); const revisit = coverageFor(data.sameFileRevisits, seconds); return <div className="coverage-row" key={seconds}><b>{formatStatDuration(seconds)}</b><div className="coverage-bars"><div className="coverage-bar activity" style={{ width: `${activity}%` }}><span>{activity.toFixed(1)}%</span></div><div className="coverage-bar revisit" style={{ width: `${revisit}%` }}><span>{revisit.toFixed(1)}%</span></div></div></div>; })}</div>
      <p className="statistics-explainer">Короткий таймаут может быть корректен, даже если агенты часто возвращаются к тому же файлу гораздо позже: резервации должны жить на сигналах активности сессии, а не только на повторных записях в этот файл.</p>
    </section>

    <div className="statistics-grid">
      <section className="statistics-panel">
        <div className="statistics-panel-head"><div><span className="eyebrow">ТОТ ЖЕ ФАЙЛ</span><h3>Распределение возвратов к записи</h3></div><small>{formatStatCount(data.sameFileRevisits.count)} интервалов</small></div>
        <div className="histogram">{data.sameFileRevisits.histogram.map((item) => <div className="histogram-column" key={item.label}><div className="histogram-value">{item.percent.toFixed(1)}%</div><div className="histogram-track"><span style={{ height: `${Math.max(3, item.percent / maxHistogram * 100)}%` }} /></div><b>{item.label}</b></div>)}</div>
      </section>
      <section className="statistics-panel">
        <div className="statistics-panel-head"><div><span className="eyebrow">ПЕРЦЕНТИЛИ</span><h3>Насколько длинными бывают паузы</h3></div></div>
        <div className="percentile-table"><div className="percentile-head"><span>Перцентиль</span><span>Любая активность</span><span>Тот же файл</span></div>{(["p50","p75","p90","p95","p99"] as const).map((key) => <div className="percentile-row" key={key}><b>{key.toUpperCase()}</b><span>{formatStatDuration(ap[key])}</span><span>{formatStatDuration(p[key])}</span></div>)}</div>
      </section>
    </div>

    <section className="statistics-panel statistics-method">
      <div><span className="eyebrow">МЕТОДИКА</span><h3>Что именно измеряется</h3></div>
      <p>{statistics.source.caveatRu || statistics.source.caveat}</p>
      <p>Сводка рассчитана по доступным сохранённым источникам на этом сервере. Данные других сред и отсутствующие истории не считаются нулевым расходом.</p>
      <div className="method-facts"><span><b>{formatStatCount(data.sample.toolCalls)}</b> вызовов инструментов</span><span><b>{formatStatCount(data.activityGaps.count)}</b> интервалов активности</span><span><b>{formatStatCount(data.sample.repeatedFileSeries)}</b> многократно правленных файлов</span><span><b>{new Date(statistics.generatedAt).toLocaleTimeString()}</b> сформировано</span></div>
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
      if (part.type === "image" && part.imageUrl) return <a href={part.imageUrl} target="_blank" rel="noreferrer" key={item.key}><img className="message-image" src={part.imageUrl} alt={part.fileName || "Прикреплённое изображение"} /></a>;
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
  return parts.some((part) => part.type === "image" && Boolean(part.imageUrl) || part.type === "text" && Boolean(part.text?.trim())
    || part.type === "thinking" && showReasoning && Boolean(part.text?.trim())
    || (part.type === "tool_call" || part.type === "tool_result") && showTools);
}

function CollapsibleMessage({ message, showReasoning, showTools, jsonRendering, collapseLongMessages, forceExpanded }: { message: SessionMessage; showReasoning: boolean; showTools: boolean; jsonRendering: boolean; collapseLongMessages: boolean; forceExpanded?: boolean }) {
  const [expanded, setExpanded] = React.useState(!collapseLongMessages);
  React.useEffect(() => { setExpanded(!collapseLongMessages); }, [collapseLongMessages]);
  const isLong = isLongVisibleMessage(message, jsonRendering);
  const collapsed = isLong && !expanded && !forceExpanded;
  return <div className={`message-body ${collapsed ? "message-collapsed" : ""}`}>
    <MessageParts message={message} showReasoning={showReasoning} showTools={showTools} jsonRendering={jsonRendering} />
    {collapsed && <button type="button" className="message-expand" onClick={() => setExpanded(true)}>Показать полностью</button>}
    {collapseLongMessages && !collapsed && isLong && !forceExpanded && <button type="button" className="message-expand" onClick={() => setExpanded(false)}>Свернуть</button>}
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

function AutomationSettings({ section, state, draft, saving, error, saved, continuation, continuationSaving, continuationFailed, continuationError, runtimeState, runtimeDraft, runtimeSaving, runtimeSaved, runtimeError, modelOptions, sessionControlAvailable, sessionControlStatus, capabilityNote, onChange, onSave, onGlobalContinuationToggle, onContinuationToggle, onRuntimeChange, onRuntimeSave, onOpenSessionControl }: {
  section: "autocontinue" | "autopilot";
  state?: WebAutopilotPolicyState;
  draft?: WebAutopilotPolicy;
  saving: boolean;
  error?: string;
  saved: boolean;
  continuation: Partial<Record<AutocontinueHarness, WebSessionAutostartHarness>>;
  continuationSaving?: AutocontinueHarness;
  continuationFailed?: ReadonlySet<string>;
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
  onContinuationToggle: (harness: AutocontinueHarness) => void;
  onRuntimeChange: (next: WebSessionRuntimeSettings) => void;
  onRuntimeSave: () => void;
  onOpenSessionControl: () => void;
}) {
  const [recoveryTab, setRecoveryTab] = React.useState<"recovery" | "compact">("recovery");
  if (section === "autocontinue") return <section className="global-autopilot-card" aria-label="Общие настройки автопродолжения">
    <div className="settings-tabs" role="tablist" aria-label="Разделы автопродолжения"><button type="button" id="recovery-tab" role="tab" aria-selected={recoveryTab === "recovery"} aria-controls="recovery-panel" onClick={() => setRecoveryTab("recovery")}>Восстановление</button><button type="button" id="compact-tab" role="tab" aria-selected={recoveryTab === "compact"} aria-controls="compact-panel" onClick={() => setRecoveryTab("compact")}>Автокомпакт</button></div>
    <div className="settings-tab-panel" id="recovery-panel" role="tabpanel" aria-labelledby="recovery-tab" hidden={recoveryTab !== "recovery"}>
    <div className="global-autopilot-head">
      <div><span className="eyebrow">АВТОПРОДОЛЖЕНИЕ</span><h3>Восстановление сессий</h3><p>Восстанавливает ту же сессию после подтверждённой ошибки, обрыва связи или зависания. Незавершённые задачи оценивает и продолжает автопилот.</p></div>
      {runtimeDraft && <button className={`switch-control large ${runtimeDraft.enabled ? "enabled" : ""}`} role="switch" aria-checked={runtimeDraft.enabled} aria-label="Общее автопродолжение" disabled={runtimeSaving} onClick={onGlobalContinuationToggle}><span /></button>}
    </div>
    {runtimeDraft && <div className={`autopilot-state-banner ${runtimeDraft.enabled ? "enabled" : ""}`}><strong>{runtimeDraft.enabled ? "Автопродолжение включено" : "Автопродолжение выключено"}</strong><span>Это общий переключатель. Настройки каждой среды и активной сессии могут его переопределить; автопилот не изменяется.</span></div>}
    {sessionControlAvailable && <div className="settings-save-row session-settings-link"><span><strong>{sessionControlStatus || "Только для текущей сессии"}</strong><small>Отдельная настройка применяется сразу и переопределяет общую только для этой сессии.</small></span><button className="quiet-button" onClick={onOpenSessionControl}>Настроить текущую сессию</button></div>}
    {runtimeDraft && <details className="settings-advanced"><summary>Дополнительно: закрепление сессий</summary><fieldset className="settings-group"><legend>Закрепление сессий</legend><label className="runtime-toggle-setting timeout-setting"><span><strong>Сразу закреплять активные сессии</strong><small>Сессия Codex или ZCode закрепляется при начале работы или успешном автопродолжении. Herder не снимает закрепление после завершения — снимите его сами после проверки результата.</small></span><input type="checkbox" checked={runtimeDraft.pinActiveSessions ?? true} onChange={(event) => onRuntimeChange({ ...runtimeDraft, pinActiveSessions: event.target.checked })} /></label></fieldset></details>}
    <p className="settings-help">Общий переключатель и выбор агента применяются сразу. Параметры восстановления, проверки зависания и закрепления — после «Сохранить автопродолжение».</p>
    <fieldset className="settings-group"><legend>Где разрешено восстановление</legend><HarnessAutomationSettings mode="autocontinue" available={AUTOCONTINUE_HARNESSES} enabled={new Set(Object.values(continuation).filter((setting) => setting?.enabled).map((setting) => setting!.harness))} loaded={new Set(Object.keys(continuation))} failed={continuationFailed} saving={continuationSaving} onToggle={(harness) => onContinuationToggle(harness as AutocontinueHarness)} /><p className="settings-help">Сначала действует настройка конкретной сессии. Если её нет — настройка агента, затем общая. Автопродолжение восстанавливает аварийно прерванную работу. Если автопилот выключен, восстановление после сбоя всё равно работает, но обычные незавершённые задачи не запускаются.</p>{continuationError && <small className="autopilot-error">{continuationError}</small>}</fieldset>
    <QuotaRecoveryControls />

    {runtimeDraft && <><fieldset className="settings-group"><legend>Восстановление после сбоя</legend><label className="runtime-toggle-setting timeout-setting"><span><strong>После ошибки выполнения</strong><small>Herder повторно запускает работу только в той же сессии после подтверждённой ошибки агента.</small></span><input type="checkbox" checked={runtimeDraft.recoverOnFailure ?? true} onChange={(event) => onRuntimeChange({ ...runtimeDraft, recoverOnFailure: event.target.checked })} /></label><label className="runtime-toggle-setting timeout-setting"><span><strong>После разрыва соединения</strong><small>Herder восстанавливает ту же сессию, если связь с её процессом аварийно оборвалась.</small></span><input type="checkbox" checked={runtimeDraft.recoverOnDisconnect ?? true} onChange={(event) => onRuntimeChange({ ...runtimeDraft, recoverOnDisconnect: event.target.checked })} /></label><p className="settings-help">Завершённые и работающие сессии, ожидание ответа или разрешения человека и сессии, явно остановленные человеком, исключены. Незавершённые задачи разбирает автопилот.</p></fieldset><fieldset className="settings-group"><legend>Контроль зависания</legend><label className="runtime-toggle-setting timeout-setting"><span><strong>Восстанавливать зависшую работу по таймауту</strong><small>Дополнительная проверка включается отдельно и продолжает ту же сессию только после заданного времени без прогресса.</small></span><input type="checkbox" checked={runtimeDraft.watchdogEnabled ?? false} onChange={(event) => onRuntimeChange({ ...runtimeDraft, watchdogEnabled: event.target.checked })} /></label><div className="context-options runtime-settings-grid"><label><span><strong>Интервал проверки, секунд</strong></span><input type="number" min="5" max="300" disabled={!(runtimeDraft.watchdogEnabled ?? false)} value={runtimeDraft.watchdogIntervalSeconds ?? 10} onChange={(event) => onRuntimeChange({ ...runtimeDraft, watchdogIntervalSeconds: Math.min(300, Math.max(5, Number(event.target.value) || 10)) })} /></label><label><span><strong>Без прогресса, минут</strong></span><input type="number" min="1" max="120" disabled={!(runtimeDraft.watchdogEnabled ?? false)} value={runtimeDraft.stalledTurnMinutes ?? 2} onChange={(event) => onRuntimeChange({ ...runtimeDraft, stalledTurnMinutes: Math.min(120, Math.max(1, Number(event.target.value) || 2)) })} /></label></div></fieldset><div className="settings-save-row settings-footer"><span>{runtimeError ? <small className="autopilot-error">{runtimeError}</small> : runtimeSaved ? <small className="settings-saved">Настройки автопродолжения сохранены</small> : runtimeState && JSON.stringify(runtimeDraft) !== JSON.stringify(runtimeState) ? <small>Изменения ещё не применены. Закрытие оставит их в форме до сохранения или перезагрузки страницы.</small> : <small>Текущие настройки загружены. Здесь сохраняются восстановление, проверки зависания и закрепление; сжатие сохраняется отдельно.</small>}</span><button className="primary-button" disabled={runtimeSaving || !runtimeDraft.judgeModel.trim()} onClick={onRuntimeSave}>{runtimeSaving ? "Сохраняю…" : "Сохранить автопродолжение"}</button></div></>}
    </div><div className="compact-tab-panel" id="compact-panel" role="tabpanel" aria-labelledby="compact-tab" hidden={recoveryTab !== "compact"}><AutoCompactSettingsPanel /></div>
  </section>;

  if (!draft) return <section className="global-autopilot-card"><span className="settings-loading">Загрузка настроек автопилота…</span></section>;
  const policyDirty = Boolean(state && JSON.stringify(draft) !== JSON.stringify(state.policy));
  const modelDirty = Boolean(runtimeState && runtimeDraft && runtimeDraft.autopilotJudgeModel !== runtimeState.autopilotJudgeModel);
  const timeoutMinutes = Math.max(1, Math.round(draft.timeout.delayMs / 60_000));
  const setHarness = (harness: AutopilotHarness, enabled: boolean) => onChange(withAutopilotHarness(draft, harness, enabled));
  const setCard = (key: keyof WebAutopilotPolicy["card"], enabled: boolean) => onChange({ ...draft, card: { ...draft.card, [key]: enabled } });
  return <section className="global-autopilot-card" aria-label="Общие настройки автопилота">
    <div className="global-autopilot-head">
      <div><span className="eyebrow">АВТОПИЛОТ</span><h3>Работа до результата</h3><p>Автопилот решает: продолжить работу, завершить её или показать вам варианты. Эта настройка не включает автопродолжение.</p></div>
      <button className={`switch-control large ${draft.enabled ? "enabled" : ""}`} role="switch" aria-checked={draft.enabled} aria-label="Общий автопилот" onClick={() => onChange({ ...draft, enabled: !draft.enabled })}><span /></button>
    </div>
    <div className={`autopilot-state-banner ${draft.enabled ? "enabled" : ""}`}><strong>{draft.enabled ? "Автопилот включён" : "Автопилот выключен"}</strong><span>{draft.enabled ? "Работает в выбранных средах; настройки отдельных сессий могут переопределить режим." : "Новые завершения не оцениваются, кроме явно включённых сессий."}</span></div>
    {sessionControlAvailable && <div className="settings-save-row session-settings-link"><span><strong>{sessionControlStatus || "Только для текущей сессии"}</strong><small>Отдельная настройка применяется сразу и переопределяет общую только для этой сессии.</small></span><button className="quiet-button" onClick={onOpenSessionControl}>Настроить текущую сессию</button></div>}
    {capabilityNote && <div className="autopilot-state-banner"><strong>Доступные функции этой среды</strong><span>{capabilityNote}</span></div>}

    {runtimeDraft && <details className="settings-advanced"><summary>Дополнительно: модель автопилота</summary><fieldset className="settings-group"><legend>Модель автопилота</legend><div className="context-options runtime-settings-grid">
      <label><span><strong>Модель автопилота</strong><small>Можно выбрать модель из списка или ввести её идентификатор. Если не знаете, оставьте текущее значение.</small></span><input list="all-herder-models" value={runtimeDraft.autopilotJudgeModel} onChange={(event) => onRuntimeChange({ ...runtimeDraft, autopilotJudgeModel: event.target.value })} /></label>
      <datalist id="all-herder-models">{[...new Set([runtimeDraft.autopilotJudgeModel, ...modelOptions.map((item) => item.model)])].map((model) => <option value={model} key={`autopilot-${model}`} />)}</datalist>
    </div><p className="settings-help">Модель сохранится общей кнопкой «Сохранить настройки автопилота» ниже.</p></fieldset></details>}

    <fieldset className="settings-group"><legend>Где работает</legend><HarnessAutomationSettings mode="autopilot" available={new Set(Object.keys(AUTOPILOT_HARNESS_LABELS))} enabled={new Set(draft.harnesses)} onToggle={(harness) => setHarness(harness as AutopilotHarness, !draft.harnesses.includes(harness as AutopilotHarness))} /><p className="settings-help">Сначала действует настройка конкретной сессии. Если её нет — выбор агента, затем общая. Для одной сессии режим можно переопределить кнопкой «Настроить текущую сессию» выше.</p></fieldset>

    <fieldset className="settings-group"><legend>Если вы не ответили</legend><label className="timeout-setting"><input type="checkbox" checked={draft.timeout.mode === "auto_continue"} onChange={(event) => onChange({ ...draft, timeout: { ...draft.timeout, mode: event.target.checked ? "auto_continue" : "hold" } })} /><span><strong>{timeoutMinutes} мин без ответа → выбрать следующий шаг автоматически</strong><small>Карточка заранее покажет варианты и рекомендацию. Таймер начинается при показе вариантов. После него автопилот выполнит рекомендованный разрешённый шаг. Если выключить — сессия ждёт вас без таймера.</small></span></label><label className="minutes-control">Через <input type="number" min="1" max="10080" value={timeoutMinutes} disabled={draft.timeout.mode === "hold"} onChange={(event) => onChange({ ...draft, timeout: { ...draft.timeout, delayMs: Math.max(1, Number(event.target.value) || 1) * 60_000 } })} /> минут</label></fieldset>

    <details className="settings-advanced"><summary>Дополнительно: что показывать в вопросе автопилота</summary><fieldset className="settings-group"><legend>Что показывать вам в сообщении автопилота</legend><p className="settings-help">Это карточка следующего шага в этом чате Herder. Эти настройки меняют содержимое карточки.</p><div className="context-options">
      <label><input type="checkbox" checked={draft.card.includeUserMessage} onChange={(event) => setCard("includeUserMessage", event.target.checked)} /> Последний запрос пользователя</label>
      <label><input type="checkbox" checked={draft.card.includeAssistantMessage} onChange={(event) => setCard("includeAssistantMessage", event.target.checked)} /> Последний ответ агента</label>
      <label><input type="checkbox" checked={draft.card.includeReason} onChange={(event) => setCard("includeReason", event.target.checked)} /> Почему нужен выбор</label>
    </div></fieldset></details>

    <div className="settings-save-row settings-footer"><span>{error || runtimeError ? <small className="autopilot-error">{error || runtimeError}</small> : saved && runtimeSaved ? <small className="settings-saved">Настройки сохранены</small> : policyDirty || modelDirty ? <small>Изменения ещё не применены. Закрытие оставит их в форме до сохранения или перезагрузки страницы.</small> : <small>Текущие настройки загружены</small>}</span><button className="primary-button" disabled={saving || runtimeSaving || !runtimeDraft?.autopilotJudgeModel.trim()} onClick={() => { onRuntimeSave(); onSave(); }}>{saving || runtimeSaving ? "Сохраняю…" : "Сохранить настройки автопилота"}</button></div>
  </section>;
}

function SessionList({ entries, pins, pinScope, onPin, pinError, activeKey, loading, refreshing, settings, settingsOpen, searchOpen, searchQuery, options, choicesBySession, choosingRequestId, choiceError, collapsedChildren, onSearchChange, onSearchToggle, onSettingsChange, onSettingsToggle, onToggleChildren, onSelect, onChoose, onNewSession, onMachines, onAdvancedSearch, cacheSettings, onCacheSettings, onCacheClear, directoryStatus, onLoadMore, onAutomationSettings, loadedCount, total, sample, onLoadMoreSessions, onCollapse, quickCounts, quickStatus, onQuickStatusChange, }: {
  entries: SessionListEntry[];
  pins:readonly string[]; pinScope:string; onPin:(key:string)=>void; pinError:string;
  activeKey?: string;
  loading: boolean;
  refreshing: boolean;
  settings: SessionListSettings;
  settingsOpen: boolean;
  searchOpen: boolean;
  searchQuery: string;
  options: { cwds: string[]; projects: string[]; harnesses: string[]; hosts: {hostId:string;label:string}[] };
  cacheSettings:ViewCacheSettings; onCacheSettings:(s:ViewCacheSettings)=>void; onCacheClear:()=>void; directoryStatus:string; onLoadMore?:()=>void;
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
  onMachines: () => void;
  onAdvancedSearch: (query: string) => void;
  onAutomationSettings: (section: "autocontinue" | "autopilot" | "launch-policy") => void;
  /** How many sessions the local server window holds. */
  loadedCount: number;
  total?: number;
  /** Сводка загруженной выборки — нужна, чтобы объяснить пустой список. */
  sample: SessionSampleCounts;
  onLoadMoreSessions?: () => void;
  /** Свернуть список чатов: колонка слева уходит, чат остаётся во всю ширину. */
  onCollapse?: () => void;
  /** Быстрые фильтры: работают / ждут задачи / среда. */
  quickCounts?: SessionQuickFilterCounts;
  quickStatus?: SessionStatusFilter;
  onQuickStatusChange?: (status: SessionStatusFilter) => void;
}) {
  const [windowSize,setWindowSize]=React.useState(150);
  React.useEffect(()=>setWindowSize(150),[settings.hostId,settings.harness,settings.cwd,settings.project,settings.sort,settings.showAll,searchQuery]);
  // Счётчик и пустой список говорят ровно о том, что на экране.
  const counts=sessionListCounts(entries.length,windowSize,total);
  const counter=sessionListCounterRu(counts,searchQuery);
  const empty=sessionListEmptyReason({query:searchQuery,settings,sample,hostLabel:options.hosts.find((host)=>host.hostId===settings.hostId)?.label});
  return <nav className="sessions-pane" aria-label="Сессии">
    <div className="sessions-heading"><div><span className="eyebrow">AGENT HERDER</span><h1>Чаты {refreshing && <span className="inline-loading-dot" role="status" aria-label="Обновление сессий" />}</h1><button type="button" className="directory-status sessions-counter-button" title={searchQuery ? "Сбросить поиск" : "Показать все сессии"} onClick={() => { if (searchQuery) onSearchChange(""); else onQuickStatusChange?.("all"); }}>{counter}</button></div><div className="sessions-heading-actions"><button type="button" className="quiet-button sessions-machines-button" onClick={onMachines}>Машины</button><button type="button" className="icon-button" aria-label="Новая сессия" title="Новая сессия" onClick={onNewSession}>+</button><button className={`icon-button ${searchOpen ? "selected-icon" : ""}`} aria-label="Поиск сессий" aria-expanded={searchOpen} onClick={onSearchToggle}>⌕</button><button className={`icon-button ${settingsOpen ? "selected-icon" : ""}`} aria-label="Настройки списка" title="Фильтры и сортировка списка сессий" aria-expanded={settingsOpen} onClick={onSettingsToggle}>≡</button>{onCollapse && <button type="button" className="icon-button sessions-collapse-button" aria-label="Скрыть список чатов" title="Скрыть список чатов" onClick={onCollapse}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg></button>}</div></div>
    <div className="session-automation-links" aria-label="Общие настройки автоматизации"><button className="quiet-button" onClick={() => onAutomationSettings("autopilot")}>Автопилот</button><button className="quiet-button" onClick={() => onAutomationSettings("autocontinue")}>Автопродолжение</button><button className="quiet-button" onClick={() => onAutomationSettings("launch-policy")}>Запуск сессий</button></div>
    {searchQuery && <div className="session-search-chip"><span>Запрос: <b>{searchQuery}</b></span><button type="button" className="quiet-button" aria-label="Сбросить запрос поиска" onClick={() => onSearchChange("")}>✕</button></div>}
    {searchOpen && <div className="session-search"><input autoFocus value={searchQuery} onChange={(event) => onSearchChange(event.target.value)} placeholder="Название, агент, папка или текст…" aria-label="Поиск по сессиям" /><button type="button" className="rag-advanced-link" onClick={() => onAdvancedSearch(searchQuery)}>Расширенный поиск →</button><small>Поиск идёт по загруженному списку: {sample.total} {pluralRu(sample.total, "сессия", "сессии", "сессий")}. Поиск смотрит все статусы выбранной среды.</small></div>}
    {quickCounts && onQuickStatusChange && <SessionQuickFilters counts={quickCounts} status={quickStatus || "all"}
      onStatusChange={onQuickStatusChange} harness={settings.harness} onHarnessChange={(harness) => onSettingsChange({ harness })} />}
    {settings.harness && <small className="directory-status">Фильтр среды: {settings.harness}</small>}{settingsOpen && <div className="session-settings" aria-label="Настройки списка сессий">
      <small>Папка — текущий каталог сессии. Проект — каталог её родительской сессии, если она есть.</small><label>Папка<select value={settings.cwd} onChange={(event) => onSettingsChange({ cwd: event.target.value })}><option value="">Все папки</option>{options.cwds.map((cwd) => <option value={cwd} key={cwd}>{cwd}</option>)}</select></label>
      <label>Проект<select value={settings.project} onChange={(event) => onSettingsChange({ project: event.target.value })}><option value="">Все проекты</option>{options.projects.map((project) => <option value={project} key={project}>{project}</option>)}</select></label>
      <label>Машина<select aria-label="Машина" value={settings.hostId??""} onChange={event=>onSettingsChange({hostId:event.target.value})}><option value="">Все машины</option>{options.hosts.map(host=><option key={host.hostId} value={host.hostId}>{host.label}</option>)}</select></label>
      <label>Агент<select value={settings.harness} onChange={(event) => onSettingsChange({ harness: event.target.value })}><option value="">Все агенты</option>{options.harnesses.map((harness) => <option value={harness} key={harness}>{harness}</option>)}</select></label>
      <label>Сортировка<select value={settings.sort} onChange={(event) => onSettingsChange({ sort: event.target.value as SessionListSort })}><option value="created">По дате создания</option><option value="activity">По активности · раз в 30 с</option><option value="status">По статусу</option><option value="harness">По агенту</option><option value="title">По названию</option><option value="cwd">По папке</option></select></label>
      <label className="session-toggle"><input type="checkbox" aria-label={SESSION_LIST_SHOW_COMPLETED_ARIA} checked={settings.showAll} onChange={(event) => { const next = event.target.checked; if (onQuickStatusChange) onQuickStatusChange(next ? "all" : "working"); else onSettingsChange({ showAll: next }); }} /> {SESSION_LIST_SHOW_COMPLETED_LABEL}</label><small>{SESSION_LIST_SHOW_COMPLETED_HINT}</small>
    </div>}
    {settingsOpen&&<details className="session-cache-settings"><summary>Быстрое открытие сессий</summary><label>Хранить просмотр в этом браузере<select aria-label="Срок кэша сессий" value={cacheSettings.hours} onChange={e=>onCacheSettings({...cacheSettings,hours:Number(e.target.value)})}><option value={0}>Выключено</option><option value={24}>Сутки</option><option value={72}>3 дня</option><option value={168}>Неделя</option></select></label><label>Размер кэша<select aria-label="Размер кэша сессий" value={cacheSettings.maxMiB} onChange={e=>onCacheSettings({...cacheSettings,maxMiB:Number(e.target.value)})}>{[16,32,64].map(size=><option key={size} value={size}>{size} МБ</option>)}</select></label><small>Только открытые сессии. История остальных остаётся на их машине. При открытии сохранённый просмотр обновляется.</small><button className="quiet-button" onClick={onCacheClear}>Очистить сохранённый просмотр</button></details>}
    {directoryStatus&&<details className="directory-status"><summary>Подключение машин</summary><small role="status">{directoryStatus}</small>{onLoadMore&&<button className="quiet-button" onClick={onLoadMore}>Показать ещё сессии</button>}</details>}
    {pinError && <div className="session-pin-error" role="alert">{pinError}</div>}
    <div className="session-list" role="list" aria-label="Сессии">
      {entries.slice(0,windowSize).map(({ session, depth, hasChildren }) => {
        const key = keyOf(session);
        const decision = choicesBySession.get(key);
        const title = cleanSessionTitle(session.title) || session.title || session.id;
        const awaitingPermission = decision === undefined && session.needsPermission === true;
        const label = decision ? "Ожидает выбора" : awaitingPermission ? "Ждёт вашего решения" : statusLabel(session.status);
        const statusClassValue = decision || awaitingPermission ? "waiting" : statusClass(session.status);
        return <div className="session-row-wrap" role="listitem" style={{ "--depth": depth } as React.CSSProperties} key={key}>
          {hasChildren ? <button className="session-fold" aria-label={`Дочерние сессии: ${title}`} onClick={() => onToggleChildren(key)}>{collapsedChildren.has(key) ? "›" : "⌄"}</button> : <span className="session-fold-placeholder" />}
          <div className="session-card">
            <SessionSidebarRow session={session} title={title} selected={key === activeKey} pinned={pins.includes(sessionPinKey(session) ?? '')}
              canPin={!!pinScope && !!sessionPinKey(session)} statusClass={statusClassValue} statusOverride={decision || awaitingPermission ? label : undefined}
              onSelect={() => onSelect(key)} onPin={() => {const pin = sessionPinKey(session); if (pin) onPin(pin);}} />
            {decision && <div className="choice-card" aria-label={`Варианты автопилота для ${title}`}>
              <strong>Что делать дальше?</strong>
              {decision.choices.map((choice) => <button className="choice-button" aria-label={`Выбрать: ${choice.label}`} disabled={choosingRequestId === decision.requestId} key={choice.choiceId} onClick={() => onChoose(decision.requestId, choice.choiceId)}>{choice.label}</button>)}
              {choiceError?.requestId === decision.requestId && <small className="choice-error">{choiceError.message}</small>}
            </div>}
          </div>
        </div>;
      })}
      {entries.length>windowSize&&<button className="quiet-button" onClick={()=>setWindowSize(n=>n+150)}>Показать ещё · всего {entries.length}</button>}
      {total!==undefined&&total>loadedCount&&<button className="quiet-button" onClick={()=>{setWindowSize(n=>n+150);onLoadMoreSessions?.();}}>Догрузить ещё с сервера · всего {total}</button>}
      {loading && entries.length === 0 && <div className="session-skeletons" aria-label="Загрузка сессий">{Array.from({ length: 8 }, (_, index) => <div className="session-skeleton" key={index}><span /><div><b /><i /><i /></div></div>)}</div>}
      {!loading && entries.length === 0 && <div className="empty-list"><strong>{empty.title}</strong>{empty.hint&&<small>{empty.hint}</small>}{empty.showCompleted&&<button type="button" className="quiet-button" onClick={()=>{ if (onQuickStatusChange) onQuickStatusChange("all"); else onSettingsChange({ showAll: true }); }}>Показать завершённые сессии</button>}</div>}
    </div>
  </nav>;
}

function App() {
  const [listSettings, setListSettings] = React.useState<SessionListSettings>(() => readSessionListSettings(window.localStorage));
  React.useEffect(() => { writeSessionListSettings(window.localStorage, listSettings); }, [listSettings]);
  // Срез и среда живут в раскладке панели и в настройках списка. Здесь они
  // переносятся в ссылки, по которым сервер отбирает сессии: выбор владельца
  // должен менять запрос, а не только подсветку чипа.
  React.useEffect(() => { listHarnessRef.current = listSettings.harness; }, [listSettings.harness]);
  const directory=useFleetDirectory(listSettings.hostId);
  // The catalog of the sessions says which sessions exist; the inventory of the
  // activity says which of them are working right now.
  const activity=useActiveActivity();
  const sessionPins = useSessionPins(directory.scope);
  const [remoteSelection,setRemoteSelection]=React.useState<MeshAddress>();
  const [viewCacheSettings,setViewCacheSettings]=React.useState(()=>readViewCacheSettings(window.localStorage));
  const cacheSettingsRef=React.useRef(viewCacheSettings);cacheSettingsRef.current=viewCacheSettings;
  const viewCache=React.useRef(new SessionViewCache(indexedViewCacheStore(),()=>cacheSettingsRef.current)).current;
  const [cacheEpoch,setCacheEpoch]=React.useState(0);
  const [detailsVerified,setDetailsVerified]=React.useState(false);
  const scopeRef=React.useRef(directory.scope);
  React.useEffect(()=>{if(scopeRef.current!==directory.scope){scopeRef.current=directory.scope;detailsReadGateRef.current.invalidate();setDetails(null);setDetailsVerified(false);setCachedDetails(false);}},[directory.scope]);
  const [cachedDetails,setCachedDetails]=React.useState(false);
  React.useEffect(()=>{void viewCache.prune();},[viewCache]);
  const changeCacheSettings=(next:ViewCacheSettings)=>{setViewCacheSettings(next);try{writeViewCacheSettings(window.localStorage,next);}catch{}void viewCache.prune();};
  const [sessions, setSessions] = React.useState<HerderSession[]>([]);
  /** The window the panel asks the server for; the counter of the whole list. */
  const sessionLimitRef = React.useRef(SESSION_LIST_WINDOW);
  /** Срез статуса и среда, по которым сервер отбирает сессии для списка. */
  const listSliceRef = React.useRef<SessionStatusFilter>("working");
  const listHarnessRef = React.useRef("");
  const listSearchRef = React.useRef("");
  const [sessionsTotal, setSessionsTotal] = React.useState<number>();
  const [activeKey, setActiveKey] = React.useState<string | undefined>(() => readSessionFromHash() ?? window.localStorage.getItem("agent-herder.active-session") ?? undefined);
  const [linkedTurnId, setLinkedTurnId] = React.useState<string | undefined>(() => readTurnFromHash());
  const activeKeyRef = React.useRef(activeKey);
  React.useLayoutEffect(() => { activeKeyRef.current = activeKey; }, [activeKey]);
  // сессия, выбранная через deep link (#/session/...) — не сбрасывается фильтром списка
  const [deepLinkKey, setDeepLinkKey] = React.useState<string | undefined>(() => readSessionFromHash());
  const selectSession = React.useCallback((key: string | undefined) => {
    // Protect the explicit click before a pending list refresh can reconcile it.
    writeSessionToHash(key);
    setDeepLinkKey(key);
    setActiveKey(key);
  }, []);
  const [details, setDetails] = React.useState<SessionDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = React.useState(false);
  const [detailsHydrating, setDetailsHydrating] = React.useState(false);
  const [detailsError, setDetailsError] = React.useState<string>();
  const detailsReadGateRef = React.useRef(new DetailsReadGate());
  const [mobileView, setMobileView] = React.useState<"sessions" | "chat">(() => readSessionFromHash() ? "chat" : "sessions");
  // На телефоне панель открывается тем, чем владелец закончил: открытая
  // сессия — это чат, а не список, который пришлось бы искать заново.
  const mobileStartRef = React.useRef(false);
  React.useEffect(() => {
    if (mobileStartRef.current) return;
    mobileStartRef.current = true;
    if (mobileView === "chat") return;
    if (!window.localStorage.getItem("agent-herder.active-session")) return;
    if (!window.matchMedia("(max-width: 900px)").matches) return;
    setMobileView("chat");
  }, [mobileView]);
  const [showReasoning, setShowReasoning] = React.useState(() => readDisplayPreference(window.localStorage, REASONING_DISPLAY_STORAGE_KEY));
  const [showTools, setShowTools] = React.useState(() => readDisplayPreference(window.localStorage, TOOLS_DISPLAY_STORAGE_KEY));
  React.useEffect(() => { writeDisplayPreference(window.localStorage, REASONING_DISPLAY_STORAGE_KEY, showReasoning); }, [showReasoning]);
  React.useEffect(() => { writeDisplayPreference(window.localStorage, TOOLS_DISPLAY_STORAGE_KEY, showTools); }, [showTools]);
  const [jsonRendering, setJsonRendering] = React.useState(() => !readJsonRenderingOptOut(window.localStorage));
  const [collapseLongMessages, setCollapseLongMessages] = React.useState(() => readCollapseLongMessages(window.localStorage));
  React.useEffect(() => { writeCollapseLongMessages(window.localStorage, collapseLongMessages); }, [collapseLongMessages]);
  // Тёмная тема — по умолчанию. Значение уже выставлено инлайн-скриптом в index.html,
  // здесь только синхронизируем состояние с тем, что реально применено к документу.
  const [theme, setTheme] = React.useState<HerderTheme>(() => readTheme(window.localStorage));
  // выбор режима отправки запоминается сам по себе, отдельной галочки нет
  const [deliveryMode, setDeliveryMode] = React.useState<DeliveryMode>(() => readDefaultDeliveryMode(window.localStorage));
  const [deliveryModePinned, setDeliveryModePinned] = React.useState(() => readDeliveryModePinned(window.localStorage));
  // Раскладка панели: список чатов, шапка сессии и правая панель. Владелец
  // выбирает, что он видит, и выбор переживает перезагрузку страницы.
  const [layout, setLayout] = React.useState(() => readPanelLayout());
  const showInspector = layout.inspectorOpen;
  const setShowInspector = React.useCallback((next: boolean | ((current: boolean) => boolean)) => {
    setLayout((current) => ({ ...current, inspectorOpen: typeof next === "function" ? next(current.inspectorOpen) : next }));
  }, []);
  const setLayoutField = React.useCallback(<K extends keyof PanelLayout>(key: K, value: PanelLayout[K]) => {
    setLayout((current) => ({ ...current, [key]: value }));
  }, []);
  // Быстрый срез списка: работают / ждут задачи / все. По умолчанию список
  // показывает ровно то, о чём говорит счётчик, — работающие сессии; выбор
  // владельца помнится вместе с раскладкой панели.
  const listStatusFilter = layout.listFilter;
  const setListStatusFilter = (status: SessionStatusFilter) => setLayoutField("listFilter", status);
  React.useEffect(() => { listSliceRef.current = listStatusFilter; }, [listStatusFilter]);
  React.useEffect(() => { writePanelLayout(layout); }, [layout]);
  const [sessionSettingsReturn, setSessionSettingsReturn] = React.useState<"autocontinue" | "autopilot">();
  const automationDialogRef = React.useRef<HTMLDivElement>(null);
  const [showStatistics, setShowStatistics] = React.useState(false);
  const [showJobs, setShowJobs] = React.useState(false);
  const [showQuota, setShowQuota] = React.useState(false);
  const [showSearch, setShowSearch] = React.useState(false);
  const [showProjects, setShowProjects] = React.useState(false);
  // The screen of the settings has two tabs: the settings of the herder
  // and the models of the projects. The second tab belongs to the
  // Projects contour; the herder only gives it a place.
  const [settingsTab, setSettingsTab] = React.useState<"settings" | "projects" | "hooks">("settings");
  const [advancedSearchQuery, setAdvancedSearchQuery] = React.useState<string>();
  const consumeAdvancedSearchInitialQuery = React.useCallback(() => setAdvancedSearchQuery(undefined), []);
  const [showFleet, setShowFleet] = React.useState(false);
  const [selectedCreationHostId,setSelectedCreationHostId] = React.useState<string>();
  const [fleetCreationMode,setFleetCreationMode] = React.useState(false);
  const [jobs, setJobs] = React.useState<HerderJob[]>([]);
  const [jobsLoading, setJobsLoading] = React.useState(false);
  const [jobsError, setJobsError] = React.useState<string>();
  const [cancellingJobId, setCancellingJobId] = React.useState<string>();
  const [statistics, setStatistics] = React.useState<AgentActivityStatistics>();
  const [statisticsLoading, setStatisticsLoading] = React.useState(false);
  const [statisticsError, setStatisticsError] = React.useState<string>();
  const [statisticsDays, setStatisticsDays] = React.useState(30);
  const statisticsRequest = React.useRef<AbortController | undefined>(undefined);
  React.useEffect(() => () => statisticsRequest.current?.abort(), []);
  React.useEffect(() => { if (!showStatistics) statisticsRequest.current?.abort(); }, [showStatistics]);
  const [showSessionSettings, setShowSessionSettings] = React.useState(false);
  const [showSessionSearch, setShowSessionSearch] = React.useState(false);
  const [sessionSearch, setSessionSearch] = React.useState(() => readSessionSearchPreferences(window.localStorage).query);
  React.useEffect(() => { listSearchRef.current = sessionSearch; }, [sessionSearch]);
  React.useEffect(() => { writeSessionSearchPreferences(window.localStorage, { query: sessionSearch }); }, [sessionSearch]);
  const [autopilotChoices, setAutopilotChoices] = React.useState<WebAutopilotChoiceCard[]>([]);
  const [choosingRequestId, setChoosingRequestId] = React.useState<string>();
  const [choiceError, setChoiceError] = React.useState<{ requestId: string; message: string }>();
  const [autopilotSession, setAutopilotSession] = React.useState<WebAutopilotSession>();
  const [autopilotSessionSaving, setAutopilotSessionSaving] = React.useState(false);
  const [autopilotSessionError, setAutopilotSessionError] = React.useState<string>();
  const [sessionAutostart, setSessionAutostart] = React.useState<WebSessionAutostart>();
  const [sessionAutostartSaving, setSessionAutostartSaving] = React.useState(false);
  const [sessionAutostartError, setSessionAutostartError] = React.useState<string>();
  const [permissionModeRead, setPermissionModeRead] = React.useState<PermissionModeRead>();
  const [permissionModeLoading, setPermissionModeLoading] = React.useState(false);
  const [permissionModeChoice, setPermissionModeChoice] = React.useState("");
  const [permissionModeSaving, setPermissionModeSaving] = React.useState(false);
  const [permissionModeError, setPermissionModeError] = React.useState<string>();
  const [permissionModeAttempts, setPermissionModeAttempts] = React.useState<PermissionModeAttempt[]>([]);
  const permissionModeReadOwner = React.useRef<string | undefined>(undefined);
  const [continuationHarnesses, setContinuationHarnesses] = React.useState<Partial<Record<AutocontinueHarness, WebSessionAutostartHarness>>>({});
  const [continuationHarnessSaving, setContinuationHarnessSaving] = React.useState<AutocontinueHarness>();
  const [continuationHarnessError, setContinuationHarnessError] = React.useState<string>();
  const [continuationHarnessFailed, setContinuationHarnessFailed] = React.useState<ReadonlySet<string>>(new Set());
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
  const [composerImages, setComposerImages] = React.useState<UploadedImage[]>([]);
  const [queueEdit,setQueueEdit]=React.useState<{inputId:string;sessionKey:string;expectedText:string;draft:string;images:UploadedImage[];unknown?:boolean}>();
  const [queueEditError,setQueueEditError]=React.useState('');
  const [queueEditSaving,setQueueEditSaving]=React.useState(false);
  React.useEffect(()=>{
    if(queueEdit&&queueEdit.sessionKey!==activeKey){
      setComposer(queueEdit.draft);setQueueEdit(undefined);setQueueEditError('');
    }
  },[activeKey]);
  const [deliveryMenuOpen, setDeliveryMenuOpen] = React.useState(false);
  const [imageUploading, setImageUploading] = React.useState(false);
  const [imageError, setImageError] = React.useState<string>();
  const imageInputRef = React.useRef<HTMLInputElement>(null);
  const composerTextareaRef = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => { setComposerImages([]); setImageError(undefined); }, [activeKey]);
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
  const [createModel, setCreateModel] = React.useState("anthropic.MiniMax-M3.1-Flash");
  const [createModels, setCreateModels] = React.useState<string[]>([]);
  const [createModelsRefreshing, setCreateModelsRefreshing] = React.useState(false);
  const createModelRequestRef = React.useRef(0);
  const [creatingSession, setCreatingSession] = React.useState(false);
  const [createSessionError, setCreateSessionError] = React.useState<string>();
  // чип модели в композере: список моделей харнесса и результат смены
  const [harnessAdapters, setHarnessAdapters] = React.useState<Array<{ id: string; active?: boolean; capabilities?: { modelSwitch?: boolean; imageInput?: boolean; steer?: boolean } | null }>>([]);
  const [modelMenuOpen, setModelMenuOpen] = React.useState(false);
  const [modelOptions, setModelOptions] = React.useState<string[]>([]);
  const [modelOptionsLoading, setModelOptionsLoading] = React.useState(false);
  const [modelOptionsHarness, setModelOptionsHarness] = React.useState<string>();
  const [modelSwitching, setModelSwitching] = React.useState(false);
  const [modelSwitchError, setModelSwitchError] = React.useState<string>();
  // Таймлайн моделей: какую модель выбрал пользователь и когда. Нативная сессия
  // отдаёт только текущую модель, поэтому «с какой моделью отправлено
  // сообщение» без этого таймлайна не восстановить.
  const [modelTimeline, setModelTimeline] = React.useState<ModelTimelineEntry[]>([]);
  const modelTimelineRef = React.useRef<ModelTimelineEntry[]>(modelTimeline);
  modelTimelineRef.current = modelTimeline;
  React.useEffect(() => {
    setModelTimeline(activeKey ? readModelTimeline(window.localStorage, activeKey) : []);
  }, [activeKey]);
  const recordSessionModel = React.useCallback((model: string, at = Date.now()) => {
    if (!activeKey) return;
    const base = readModelTimeline(window.localStorage, activeKey);
    const next = recordModelAt(base, at, model);
    writeModelTimeline(window.localStorage, activeKey, next);
    setModelTimeline(next);
  }, [activeKey]);
  const selectedModel = latestModel(modelTimeline);
  // Микроподпись модели под сообщением: наблюдённая на сообщении модель важнее
  // выбранной, иначе смена модели переписывает подпись старых сообщений.
  const modelCaption = (message?: SessionMessage, fallbackTimestamp?: string): { short: string; full: string } | undefined => {
    const observed = message?.model?.trim();
    const stamp = message?.timestamp ?? fallbackTimestamp;
    const parsed = stamp ? Date.parse(stamp) : Number.NaN;
    const model = observed
      || (Number.isFinite(parsed) ? modelAt(modelTimelineRef.current, parsed) ?? latestModel(modelTimelineRef.current) : undefined)
      || latestModel(modelTimelineRef.current);
    if (!model) return undefined;
    return { short: shortModelLabel(model).replace(/\$(?:max|high|low|enabled)$/, ""), full: modelOptionLabel(model) };
  };
  const [chatMenuOpen, setChatMenuOpen] = React.useState(false);
  const [showScrollToLatest, setShowScrollToLatest] = React.useState(false);
  const chatScrollRef = React.useRef<HTMLDivElement>(null);
  const shouldFollowRef = React.useRef(true);

  const sessionsReadRef = React.useRef<Promise<boolean> | undefined>(undefined);
  const sessionsLastReadRef = React.useRef(0);
  const loadSessions = React.useCallback((): Promise<boolean> => {
    if (sessionsReadRef.current) return sessionsReadRef.current;
    sessionsLastReadRef.current = Date.now();
    const read = (async () => {
    setSessionsRefreshing(true);
    try {
    // Срез и среда выбираются на сервере: окно ответа тогда описывает ровно
    // то, что владелец просит увидеть, а не «всё, что попалось в первые 100».
    const slice = listSliceRef.current;
    const harness = listHarnessRef.current;
    const searching = listSearchRef.current.trim().length > 0;
    const limit = searching ? Math.max(sessionLimitRef.current, 500) : sessionLimitRef.current;
    const queries = sliceScopeQueries(slice, harness, searching);
    const [answers, choiceResult] = await Promise.all([
      Promise.all(queries.map((query) => api<{ sessions: HerderSession[]; warming?: boolean; total?: number }>(sessionScopeQuery(query, limit)))),
      api<{ choices: WebAutopilotChoiceCard[] }>("/api/autopilot/choices?status=pending").catch(() => ({ choices: [] })),
    ]);
    const merged = mergeScopeAnswers(answers, keyOf);
    const result = { sessions: merged.sessions, total: merged.total, warming: answers.every((answer) => answer.warming) };
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
    if (typeof result.total === "number") setSessionsTotal(result.total);
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
    })();
    sessionsReadRef.current = read;
    void read.finally(() => { if (sessionsReadRef.current === read) sessionsReadRef.current = undefined; }).catch(() => {});
    return read;
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
    const timer = window.setInterval(() => { if (!document.hidden && sessionListRefreshDelay(sessionsLastReadRef.current, Date.now()) === 0) void loadSessions().catch(() => {}); }, SESSION_LIST_REFRESH_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [loadSessions]);
  // Смена среза, среды или запроса — это новый вопрос к серверу: список
  // перечитывается по новым фильтрам, а не остаётся прежним окном.
  const listFilterReadyRef = React.useRef(false);
  React.useEffect(() => {
    if (!listFilterReadyRef.current) { listFilterReadyRef.current = true; return; }
    const timer = window.setTimeout(() => {
      // Текущее чтение относится к прежним фильтрам — оно не отвечает на
      // новый вопрос, поэтому следующее чтение начинается заново.
      sessionsReadRef.current = undefined;
      void loadSessions().catch(() => false);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [listStatusFilter, listSettings.harness, sessionSearch, loadSessions]);
  /** The load of a wider window of the list: the owner asks for more. */
  const loadMoreSessions = React.useCallback(async () => {
    sessionLimitRef.current = Math.min(sessionLimitRef.current + SESSION_LIST_WINDOW, 500);
    await loadSessions().catch(() => false);
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
      loadAutocontinueHarnesses(api),
      api<WebSessionRuntimeSettings>("/api/session-autostart"),
    ]);
    if (autopilotResult.status === "fulfilled") {
      setAutopilotPolicy(autopilotResult.value);
      setAutopilotPolicyDraft(autopilotResult.value.policy);
      setAutopilotPolicyError(autopilotResult.value.error);
    } else setAutopilotPolicyError(autopilotResult.reason instanceof Error ? autopilotResult.reason.message : String(autopilotResult.reason));
    if (continuationResult.status === "fulfilled") {
      setContinuationHarnesses(continuationResult.value.settings);
      setContinuationHarnessFailed(new Set(continuationResult.value.failed));
      setContinuationHarnessError(continuationResult.value.failed.length ? "Некоторые настройки не удалось загрузить. Обновите страницу, чтобы повторить проверку." : undefined);
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
      setLinkedTurnId(readTurnFromHash());
      setDeepLinkKey(key);
      setActiveKey(key);
      setMobileView(key ? "chat" : "sessions");
    };
    window.addEventListener("hashchange", followHash);
    return () => window.removeEventListener("hashchange", followHash);
  }, []);

  const loadDetails = React.useCallback(async (key: string, hydrateFull = true) => {
    const requestId = detailsReadGateRef.current.begin(key, hydrateFull);
    if (requestId === undefined) return;
    const { harness, id } = splitKey(key);
    const base = `/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(id)}/details`;
    setDetailsError(undefined);
    if(hydrateFull){setDetailsVerified(false);if(directory.scope&&directory.localHostId){void viewCache.get<SessionDetails>(directory.scope,{hostId:directory.localHostId,harness,nativeSessionId:id}).then(r=>{if(r&&r.value.session?.id===id&&r.value.session?.harness===harness&&detailsReadGateRef.current.isCurrent(requestId)&&!liveLoaded){setDetails(r.value);setCachedDetails(true);setDetailsLoading(false);}});}}
    let liveLoaded=false;
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
      if (!detailsReadGateRef.current.isCurrent(requestId)) return;
      if(latest.session?.id!==id||latest.session?.harness!==harness)throw new Error('Не удалось подтвердить выбранную сессию');
      liveLoaded=true;setCachedDetails(false);setDetailsVerified(true);
      if(directory.scope&&directory.localHostId)void viewCache.put(directory.scope,{hostId:directory.localHostId,harness,nativeSessionId:id},latest);
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
      if (!detailsReadGateRef.current.isCurrent(requestId)) return;
      setHydrateTimingMs(performance.now() - hydrateStartedAt);
      if(full.session?.id!==id||full.session?.harness!==harness)throw new Error('Не удалось подтвердить выбранную сессию');
      setDetails(full);
      if(directory.scope&&directory.localHostId)void viewCache.put(directory.scope,{hostId:directory.localHostId,harness,nativeSessionId:id},full);
    } catch (error) {
      if (!detailsReadGateRef.current.isCurrent(requestId)) return;
      setDetailsError((error as Error).message);
    } finally {
      if (detailsReadGateRef.current.isCurrent(requestId)) { setDetailsLoading(false); setDetailsHydrating(false); }
      detailsReadGateRef.current.finish(requestId);
    }
  }, [directory.scope,directory.localHostId,viewCache]);
  React.useEffect(() => {
    if (!activeKey) { detailsReadGateRef.current.invalidate(); setDetails(null); setDetailsLoading(false); setDetailsHydrating(false); setLatestTimingMs(undefined); setHydrateTimingMs(undefined); return; }
    void loadDetails(activeKey);
  }, [activeKey, loadDetails]);
  React.useEffect(() => {
    let sessionTimer = 0;
    let jobTimer = 0;
    let detailTimer = 0;
    const scheduleSessions = (immediate = false) => {
      if (sessionTimer && !immediate) return;
      if (sessionTimer) window.clearTimeout(sessionTimer);
      const refresh = () => {
        sessionTimer = 0;
        if (document.hidden) return;
        const delay = immediate ? 0 : sessionListRefreshDelay(sessionsLastReadRef.current, Date.now());
        if (delay > 0) { sessionTimer = window.setTimeout(refresh, delay); return; }
        void loadSessions().catch(() => {});
      };
      sessionTimer = window.setTimeout(refresh, immediate ? 120 : sessionListRefreshDelay(sessionsLastReadRef.current, Date.now()));
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
        const event = JSON.parse(message.data) as { control?: string; latestSequence?: number; sequence?: number; uri?: string; action?: string };
        if (event.control === "reset") {
          if (typeof event.latestSequence === "number") window.localStorage.setItem("agent-herder.event-cursor", String(event.latestSequence));
          scheduleSessions(); scheduleJobs(); scheduleDetails();
          return;
        }
        if (typeof event.sequence === "number") window.localStorage.setItem("agent-herder.event-cursor", String(event.sequence));
        const uri = event.uri || "";
        if (uri.startsWith("herder://jobs")) scheduleJobs();
        if (uri.startsWith("herder://sessions") || uri.startsWith("herder://coordination") || uri.startsWith("herder://human-requests")) {
          scheduleSessions(uri.startsWith("herder://sessions/") && (event.action === "created" || event.action === "deleted"));
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
  }, [activeKey, details?.messages.length, details?.children?.length, outbox, showReasoning, showTools, jsonRendering]);

  const activeSessionBase = details?.session && keyOf(details.session) === activeKey ? details.session : sessions.find((session) => keyOf(session) === activeKey);
  // The header of the chat shows the activity the inventory proves, not the
  // status of the catalog, so a working session is not read as idle.
  const activeSession = React.useMemo(()=>{
    if(!activeSessionBase) return activeSessionBase;
    const merged=mergeActiveActivity([activeSessionBase],activity.snapshot.confirmed,{hostId:directory.localHostId,goals:activity.goals})[0];
    return (merged??activeSessionBase) as HerderSession;
  },[activeSessionBase,activity.snapshot.confirmed,activity.goals,directory.localHostId]);
  const refreshPermissionModeState = React.useCallback(async () => {
    const session = activeSession;
    if (!showInspector || !session?.hostId) {
      permissionModeReadOwner.current = undefined;
      setPermissionModeRead(undefined);
      setPermissionModeAttempts([]);
      setPermissionModeChoice("");
      return;
    }
    const owner = JSON.stringify([session.hostId, session.harness, session.id]);
    permissionModeReadOwner.current = owner;
    setPermissionModeRead(undefined);
    setPermissionModeChoice("");
    setPermissionModeLoading(true);
    setPermissionModeError(undefined);
    setPermissionModeAttempts(readPermissionModeAttempts(session.hostId, session.harness, session.id));
    try {
      const result = await api<PermissionModeRead>(`/api/sessions/${encodeURIComponent(session.harness)}/${encodeURIComponent(session.id)}/permissions?hostId=${encodeURIComponent(session.hostId)}`);
      if (permissionModeReadOwner.current !== owner) return;
      if (result.available && result.permissionState
        && (result.permissionState.target.hostId !== session.hostId || result.permissionState.target.harness !== session.harness || result.permissionState.target.sessionId !== session.id)) {
        throw new Error("Состояние разрешений относится к другой сессии.");
      }
      setPermissionModeRead(result);
      setPermissionModeChoice(result.permissionState?.currentMode || "");
    } catch (error) {
      if (permissionModeReadOwner.current !== owner) return;
      setPermissionModeRead({ available: false, reason: (error as Error).message });
    } finally {
      if (permissionModeReadOwner.current === owner) setPermissionModeLoading(false);
    }
  }, [activeSession?.hostId, activeSession?.harness, activeSession?.id, showInspector]);
  React.useEffect(() => { void refreshPermissionModeState(); }, [refreshPermissionModeState]);
  const applyPermissionMode = React.useCallback(async () => {
    const session = activeSession;
    const state = permissionModeRead?.permissionState;
    const mode = permissionModeChoice;
    if (!session?.hostId || !state || !state.canSetMode || state.scope !== "session"
      || !state.supportedModes?.includes(mode) || state.pendingRequests.length > 0
      || !state.currentMode || mode === state.currentMode || permissionModeSaving) return;
    const prior = permissionModeAttempts.find((attempt) => attempt.status === "unknown"
      && attempt.mode === mode && attempt.expectedCurrentMode === state.currentMode);
    const attempt: PermissionModeAttempt = prior || { inputId: newInputId(), expectedCurrentMode: state.currentMode, mode, status: "unknown", at: new Date().toISOString() };
    const prepared = [...permissionModeAttempts.filter((item) => item.inputId !== attempt.inputId), attempt];
    setPermissionModeAttempts(prepared);
    writePermissionModeAttempts(session.hostId, session.harness, session.id, prepared);
    setPermissionModeSaving(true);
    setPermissionModeError(undefined);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.harness)}/${encodeURIComponent(session.id)}/permissions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ hostId: session.hostId, inputId: attempt.inputId, expectedCurrentMode: attempt.expectedCurrentMode, mode: attempt.mode }),
      });
      const receipt = await response.json().catch(() => undefined) as { ok?: boolean; state?: "accepted" | "unknown" | "not_attempted"; error?: string } | undefined;
      if (receipt?.ok && receipt.state === "accepted") {
        const completed = prepared.map((item) => item.inputId === attempt.inputId ? { ...item, status: "accepted" as const } : item);
        setPermissionModeAttempts(completed);
        writePermissionModeAttempts(session.hostId, session.harness, session.id, completed);
        await refreshPermissionModeState();
      } else if (receipt?.state === "not_attempted") {
        const remaining = prepared.filter((item) => item.inputId !== attempt.inputId);
        setPermissionModeAttempts(remaining);
        writePermissionModeAttempts(session.hostId, session.harness, session.id, remaining);
        setPermissionModeError(receipt.error || "Режим не изменён.");
        await refreshPermissionModeState();
      } else {
        setPermissionModeError(receipt?.error || "Исход смены режима неизвестен. Идентификатор попытки сохранён; автоматического повтора не будет.");
      }
    } catch (error) {
      setPermissionModeError(`Исход смены режима неизвестен. Идентификатор попытки сохранён: ${(error as Error).message}`);
    } finally { setPermissionModeSaving(false); }
  }, [activeSession?.hostId, activeSession?.harness, activeSession?.id, permissionModeRead?.permissionState, permissionModeChoice, permissionModeAttempts, permissionModeSaving, refreshPermissionModeState]);
  // Факты работы сессии нужны только правой панели: пока её нет, панель их не читает.
  const sessionFacts = useSessionFacts(activeSession, showInspector, details?.messages.length ?? 0);
  // Машины флота для блока рабочего места: подпись машины и её точный идентификатор.
  const workTargetHosts = React.useMemo(() => directory.hosts.map((host) => ({ hostId: host.hostId, label: host.label })), [directory.hosts]);
  // Модель, с которой уйдёт следующий ответ: выбранная пользователем иначе
  // текущая нативная. Пока выбранная не совпала с нативной, это видно по подписи.
  const composerModel = selectedModel ?? activeSession?.model;
  const composerModelPending = Boolean(selectedModel && activeSession?.model && selectedModel !== activeSession.model);
  const localTranscriptAddress=React.useMemo<MeshAddress|undefined>(()=>localTranscriptAddressFor(directory.localHostId,activeSession,remoteSelection),[activeSession?.harness,activeSession?.id,activeSession?.remote,directory.localHostId,remoteSelection]);
  const localTranscriptKey=localTranscriptAddress?JSON.stringify([localTranscriptAddress.hostId,localTranscriptAddress.harness,localTranscriptAddress.nativeSessionId]):"";
  const localTranscriptOwnerRef=React.useRef<TranscriptRequestOwner|null>(null);if(!localTranscriptOwnerRef.current)localTranscriptOwnerRef.current=new TranscriptRequestOwner(localTranscriptKey);localTranscriptOwnerRef.current.setSession(localTranscriptKey);
  const [localTranscript,setLocalTranscript]=React.useState<TranscriptView>(),[localTranscriptError,setLocalTranscriptError]=React.useState(""),[localTranscriptLoading,setLocalTranscriptLoading]=React.useState(false);
  const readLocalTranscript=React.useCallback(async(cursor?:string,reset=false)=>{
    const address=localTranscriptAddress;if(!address)return;
    const key=JSON.stringify([address.hostId,address.harness,address.nativeSessionId]),owner=localTranscriptOwnerRef.current!;
    if(reset)owner.cancel(key);
    const token=owner.begin(key);if(!token)return;
    const owns=()=>owner.isCurrent(token);
    setLocalTranscriptError("");setLocalTranscriptLoading(true);
    try{
      const response=await fetchIntegratorTranscriptPage({address,expectedHostId:address.hostId,cursor});
      if(!owns())return;
      setLocalTranscript(current=>mergeTranscriptPageIfCurrent(current,response.transcript,owner,token,reset));
    }catch(error){if(owns()){const message=error instanceof Error?error.message:"Свежая история сессии недоступна.";setLocalTranscriptError(current=>transcriptValueIfCurrent(current,message,owner,token));}}
    finally{if(owner.finish(token))setLocalTranscriptLoading(current=>transcriptValueIfCurrent(current,false,owner,token));}
  },[localTranscriptAddress]);
  React.useEffect(()=>{
    setLocalTranscript(undefined);setLocalTranscriptError("");
    if(!localTranscriptAddress)return;
    void readLocalTranscript(undefined,true);
    return()=>localTranscriptOwnerRef.current?.cancel(localTranscriptKey);
  },[localTranscriptKey,readLocalTranscript]);
  const currentLocalTranscript=localTranscriptAddress?transcriptForAddress(localTranscript,localTranscriptAddress):undefined;
  const turnFocusKey=linkedTurnId&&localTranscriptAddress?JSON.stringify([localTranscriptAddress.hostId,localTranscriptAddress.harness,localTranscriptAddress.nativeSessionId,linkedTurnId]):"";
  const turnFocusPagesRef=React.useRef<{key:string;pages:number}>({key:"",pages:0});
  const turnFocusExhausted=turnFocusKey!==""&&turnFocusPagesRef.current.key===turnFocusKey&&turnFocusPagesRef.current.pages>=20;
  React.useEffect(()=>{
    if(!turnFocusKey||!currentLocalTranscript||!linkedTurnId)return;
    if(turnFocusPagesRef.current.key!==turnFocusKey)turnFocusPagesRef.current={key:turnFocusKey,pages:0};
    const exactIndex=firstEventIndexForTurn(currentLocalTranscript.events,linkedTurnId);
    if(exactIndex!==undefined){
      const event=currentLocalTranscript.events[exactIndex];
      const target=Array.from(chatScrollRef.current?.querySelectorAll<HTMLElement>("[data-turn-id]")??[]).find(element=>element.dataset.turnId===event.turnId);
      target?.scrollIntoView({block:"center"});
      return;
    }
    if(currentLocalTranscript.nextCursor&&!localTranscriptLoading&&turnFocusPagesRef.current.pages<20){
      turnFocusPagesRef.current.pages++;
      void readLocalTranscript(currentLocalTranscript.nextCursor);
    }
  },[turnFocusKey,currentLocalTranscript,linkedTurnId,localTranscriptLoading,readLocalTranscript]);
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
    if (!activeSession || !AUTOCONTINUE_HARNESSES.has(activeSession.harness)) {
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
  const displaySessions=React.useMemo(()=>{
    const local=sessions.map(s=>projectLocalSessionHost(s,directory.localHostId,directory.hosts));
    const keys=new Set(local.map(keyOf));
    const rows=[...local,...directory.rows.flatMap(row=>{const host=directory.hosts.find(h=>h.hostId===row.address.hostId);if(!host)return [];const s=directorySession(row,host,directory.localHostId);return keys.has(keyOf(s))?[]:[s];})];
    // The panel draws the work the inventory proves, not the status the catalog
    // guesses. A session the inventory does not mention keeps the catalog status.
    return mergeActiveActivity(rows,activity.snapshot.confirmed,{hostId:directory.localHostId,goals:activity.goals});
  },[sessions,directory.rows,directory.hosts,directory.localHostId,activity.snapshot.confirmed,activity.goals]);
  const activitySessionsRef = React.useRef(displaySessions);
  activitySessionsRef.current = displaySessions;
  const [activityOrder, setActivityOrder] = React.useState<ReadonlyMap<string,string>>(() => new Map());
  React.useEffect(() => { setActivityOrder(previous => sampleSessionActivity(previous, displaySessions)); }, [displaySessions]);
  React.useEffect(() => {
    if (listSettings.sort !== 'activity') return;
    setActivityOrder(previous => sampleSessionActivity(previous, activitySessionsRef.current, true));
    const timer = window.setInterval(() => { if (!document.hidden) setActivityOrder(previous => sampleSessionActivity(previous, activitySessionsRef.current, true)); }, SESSION_LIST_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [listSettings.sort]);
  const sessionMap = React.useMemo(() => new Map(displaySessions.map((session) => [keyOf(session), session])), [displaySessions]);
  // Среды, которые панель знает: список не должен зависеть от того, какие
  // сессии попали в окно, — иначе среду нельзя выбрать, когда её сессий
  // в окне нет.
  const scopeHarnesses = React.useMemo(() => {
    const known = new Set<string>();
    for (const adapter of harnessAdapters) if (adapter.id) known.add(adapter.id);
    for (const session of displaySessions) if (session.harness) known.add(session.harness);
    return [...known].sort();
  }, [harnessAdapters, displaySessions]);
  const listOptions = React.useMemo(() => ({
    hosts:directory.hosts,
    cwds: [...new Set(displaySessions.map((session) => session.cwd).filter(Boolean))].sort(),
    projects: [...new Set(displaySessions.map((session) => projectFor(session, sessionMap)).filter(Boolean))].sort(),
    harnesses: scopeHarnesses,
  }), [displaySessions, sessionMap, directory.hosts, scopeHarnesses]);
  const choicesBySession = React.useMemo(() => {
    const result = new Map<string, WebAutopilotChoiceCard>();
    for (const choice of autopilotChoices) {
      const key = `${choice.harness}:${choice.sessionId}`;
      if (!result.has(key)) result.set(key, choice);
    }
    return result;
  }, [autopilotChoices]);
  const choiceSessionKeys = React.useMemo(() => new Set(choicesBySession.keys()), [choicesBySession]);
  // Быстрый фильтр режет список до того, как он устроен в дерево: иначе
  // родитель без детей остался бы с пустым заголовком.
  const quickFilteredSessions = React.useMemo(
    () => displaySessions.filter((session) => statusInSlice(session.status, listStatusFilter)),
    [displaySessions, listStatusFilter],
  );
  // Числа на чипах считает сервер по всей флоте: чип «Работают 4» и список
  // из четырёх работающих сессий говорят одно и то же. Пересчёт по
  // загруженному окну давал бы другое число и тот самый «мега-баг».
  const scopeCounts = useSessionScope({ slice: listStatusFilter, harness: listSettings.harness, harnesses: scopeHarnesses });
  // «Показывать завершённые» и чип «Все» — это один и тот же переключатель:
  // два источника правды расходились, и владелец не понимал, что нажал.
  const effectiveListSettings = React.useMemo<SessionListSettings>(
    () => ({ ...listSettings, showAll: listStatusFilter === "all" }),
    [listSettings, listStatusFilter],
  );
  const visibleSessionEntries = React.useMemo(() => sidebarEntries(quickFilteredSessions, effectiveListSettings, collapsedChildren, choiceSessionKeys, sessionSearch, sessionPins.pins, activityOrder), [quickFilteredSessions, effectiveListSettings, collapsedChildren, choiceSessionKeys, sessionSearch, sessionPins.pins, activityOrder]);
  // Число на чипе — это то, о чём говорит список. Сервер знает больше, чем его
  // окно, а меш знает свежее каталога: поэтому берётся большее из двух — и
  // чип, и список называют одно и то же множество.
  const shownByHarness = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of visibleSessionEntries) {
      counts.set(entry.session.harness, (counts.get(entry.session.harness) ?? 0) + 1);
    }
    return counts;
  }, [visibleSessionEntries]);
  const quickFilterCounts = React.useMemo<SessionQuickFilterCounts>(() => {
    // Считаются только те строки, которые список показывает: строки меша о
    // других статусов в список не попадают и в чипах считаться не должны.
    const serverWorking = (scopeCounts.byStatus.running ?? 0) + (scopeCounts.byStatus.needs_input ?? 0);
    const serverWaiting = scopeCounts.byStatus.idle ?? 0;
    const shown = visibleSessionEntries.length;
    return {
      working: listStatusFilter === "working" ? Math.max(serverWorking, shown) : serverWorking,
      waiting: listStatusFilter === "waiting" ? Math.max(serverWaiting, shown) : serverWaiting,
      total: Math.max(scopeCounts.total, listStatusFilter === "all" ? shown : 0),
      byHarness: scopeCounts.byHarness.map((entry) => ({
        harness: entry.harness,
        count: Math.max(entry.count, shownByHarness.get(entry.harness) ?? 0),
      })),
    };
  }, [scopeCounts, visibleSessionEntries, shownByHarness, listStatusFilter]);
  const sessionSample = React.useMemo(() => summarizeSessionSample(displaySessions), [displaySessions]);
  React.useEffect(() => {
    if (activeKey && (activeKey === deepLinkKey || visibleSessionEntries.some(({ session }) => keyOf(session) === activeKey))) return;
    const first=visibleSessionEntries.find(e=>!e.session.remote);selectSession(first ? keyOf(first.session) : undefined);
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
  const toggleContinuationHarness = async (harness: AutocontinueHarness) => {
    const current = continuationHarnesses[harness];
    if (!current || continuationHarnessSaving) return;
    setContinuationHarnessSaving(harness);
    setContinuationHarnessError(undefined);
    try {
      const saved = await saveAutocontinueHarness(api, harness, !current.enabled);
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
      setRuntimeSettingsDraft((current) => current ? { ...current, enabled: saved.enabled } : saved);
      const result = await loadAutocontinueHarnesses(api);
      setContinuationHarnesses(result.settings);
      setContinuationHarnessFailed(new Set(result.failed));
      setContinuationHarnessError(result.failed.length ? "Некоторые настройки не удалось загрузить. Обновите страницу, чтобы повторить проверку." : undefined);
      if (activeSession && AUTOCONTINUE_HARNESSES.has(activeSession.harness)) {
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
      const preferredModel = harness === "fast-agent" && models.includes("anthropic.MiniMax-M3.1-Flash") ? "anthropic.MiniMax-M3.1-Flash" : (models[0] || "");
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
    if(selectedCreationHostId && selectedCreationHostId !== directory.localHostId){setFleetCreationMode(true);setShowFleet(true);setAutomationSettings(undefined);return;}
    const cwd = listSettings.cwd || activeSession?.cwd || "/home/roomhacker";
    setCreateCwd(cwd);
    setCreateSessionError(undefined);
    setShowJobs(false);
    setShowStatistics(false);
    setShowQuota(false);
    setAutomationSettings(undefined);
    setMobileView("chat");
    setShowFleet(false);
    setRemoteSelection(undefined);
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
      setListSettings((current) => ({ ...current, harness: createHarness, cwd: "", sort: current.sort, showAll: true }));
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
    statisticsRequest.current?.abort();
    const controller = new AbortController();
    statisticsRequest.current = controller;
    setStatistics((previous) => previous?.windowDays === days ? previous : undefined);
    setStatisticsLoading(true); setStatisticsError(undefined);
    try {
      const get = (force = false) => api<AgentActivityStatistics>(`/api/statistics/activity?days=${days}${force ? "&refresh=1" : ""}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
      let result = await get(refresh);
      if (controller.signal.aborted) return;
      setStatistics(result);
      while (result.refreshing && !controller.signal.aborted) {
        await new Promise<void>((resolve) => {
          const done = () => { window.clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); };
          const timer = window.setTimeout(done, 1000);
          controller.signal.addEventListener("abort", done, { once: true });
        });
        if (controller.signal.aborted) return;
        result = await get();
        if (controller.signal.aborted) return;
        setStatistics(result);
      }
    } catch (error) { if (!controller.signal.aborted) setStatisticsError((error as Error).message); }
    finally { if (!controller.signal.aborted) setStatisticsLoading(false); }
  }, [statisticsDays]);
  const openStatistics = () => { setShowStatistics(true); setChatMenuOpen(false); void loadStatistics(statisticsDays); };
  const changeStatisticsDays = (days: number) => { setStatisticsDays(days); void loadStatistics(days); };

  const runAction = async (action: "resume" | "stop" | "recover") => {
    if(!detailsVerified||cachedDetails)return;
    if (!activeKey || (action === "resume" && resumeSending)) return;
    if (action === "resume") setResumeSending(true);
    if (action === "stop") messageDispatcherRef.current.cancelPending(activeKey);
    const { harness, id } = splitKey(activeKey);
    try {
      if (action === "resume" && ["codex", "zcode", "fast-agent"].includes(harness)) {
        const intent = planContinuation(outboxRef.current, activeKey);
        if (!intent.alreadyPending && !messageDispatcherRef.current.hasPending(intent.inputId)) {
          await submitOutboxEntry(activeKey, intent.text, "queue", intent.inputId);
        }
        return;
      }
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
    void api<{ adapters?: Array<{ id: string; active?: boolean; capabilities?: { modelSwitch?: boolean; imageInput?: boolean; steer?: boolean } | null }> }>("/api/adapters")
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
    if (!detailsVerified || cachedDetails || !activeKey || !modelSwitchHarness || modelSwitching) return;
    setModelSwitching(true);
    setModelSwitchError(undefined);
    try {
      const outcome = await requestModelChange(fetch, splitKey(activeKey).harness, splitKey(activeKey).id, model);
      if (!outcome.ok) { setModelSwitchError(outcome.message); return; }
      // Выбор пользователя фиксируем сами: нативная сессия обновит свою модель
      // не сразу, и без записи сообщение ушло бы со старой подписью.
      recordSessionModel(model);
      setModelMenuOpen(false);
      await loadDetails(activeKey);
    } catch (error) {
      setModelSwitchError(`Не удалось сменить модель: ${(error as Error).message}`);
    } finally {
      setModelSwitching(false);
    }
  };
  React.useEffect(() => { setModelMenuOpen(false); setModelSwitchError(undefined); }, [activeKey]);
  const isResumeMode = !composer.trim() && !composerImages.length && (activeSession?.status === "stopped" || activeSession?.status === "error" || activeSession?.meta?.humanStopHeld === true);
  const activeJobsCount = jobs.filter((job) => job.state === "queued" || job.state === "running" || job.state === "waiting" || job.state === "cancelling").length;
  const readOnlySession = !detailsVerified || cachedDetails || activeSession?.meta?.readOnly === true;
  const archivedSession = activeSession?.status === "archived" || activeSession?.meta?.archived === true;
  const visualizationUrl = activeSession
    ? `/api/sessions/${encodeURIComponent(activeSession.harness)}/${encodeURIComponent(activeSession.id)}/visualization`
    : undefined;
  const latestMessage = details?.messages[details.messages.length - 1];
  const latestToolPart = [...(latestMessage?.parts || [])].reverse().find((part) => part.type === "tool_call" || part.type === "tool_result");
  // очередь отправленных сообщений активной сессии; композер остаётся свободным, пока сообщения в полёте
  const [deliveredImageProof, setDeliveredImageProof] = React.useState<{sessionKey:string;messages:SessionMessage[];entries:OutboxEntry[];matches:Map<string,Set<string>>}>();
  React.useEffect(() => {
    if (!activeKey || !details?.session || keyOf(details.session) !== activeKey) return;
    const sessionKey=activeKey, messages=details.messages, entries=outbox;
    let cancelled=false;
    void resolveDeliveredImages(messages,entries,sessionKey).then(matches=>{
      if (!cancelled) setDeliveredImageProof({sessionKey,messages,entries,matches});
    });
    return ()=>{cancelled=true;};
  }, [activeKey,details?.messages,outbox]);
  const currentImageProof = deliveredImageProof && deliveredImageProof.sessionKey === activeKey && deliveredImageProof.messages === details?.messages && deliveredImageProof.entries === outbox ? deliveredImageProof.matches : undefined;
  const chatDelivery = projectDeliveredChat(details?.session && keyOf(details.session) === activeKey ? details.messages : [], outbox, activeKey || '', currentImageProof);
  const activeOutbox = chatDelivery.pending.slice().sort((left, right) => right.createdAt - left.createdAt);
  const nativeCapabilities = harnessAdapters.find(adapter => adapter.id === activeSession?.harness)?.capabilities;
  const supportsSteer = activeSession?.harness === "codex" || nativeCapabilities?.steer === true;
  const supportsImages = nativeCapabilities?.imageInput === true;
  const uploadImages = async (files: FileList | null) => {
    if (!files?.length || !activeKey || imageUploading) return;
    const targetKey = activeKey, { harness, id } = splitKey(targetKey);
    setImageUploading(true); setImageError(undefined);
    try {
      if (composerImages.length + files.length > 4) throw new Error("Можно прикрепить до четырёх изображений.");
      for (const file of Array.from(files)) {
        if (file.size > 5 * 1024 * 1024) throw new Error("Изображение должно быть не больше 5 МБ.");
        const dataBase64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = () => reject(new Error("Не удалось прочитать изображение.")); reader.readAsDataURL(file); });
        const image = await api<UploadedImage>("/api/session-images", { method: "POST", body: JSON.stringify({ harness, sessionId: id, fileName: file.name, mimeType: file.type, dataBase64 }) });
        if (activeKeyRef.current === targetKey) setComposerImages(current => current.some(item => item.id === image.id) ? current : [...current, image]);
      }
    } catch (error) { if (activeKeyRef.current === targetKey) setImageError((error as Error).message); }
    finally { setImageUploading(false); if (imageInputRef.current) imageInputRef.current.value = ""; }
  };
  // пока режим не выбран вручную — steer там, где харнесс его понимает (codex), иначе очередь
  const effectiveDeliveryMode: DeliveryMode = supportsSteer ? (deliveryModePinned ? deliveryMode : "steer") : "queue";
  const selectDeliveryMode = (mode: DeliveryMode) => {
    setDeliveryMode(mode);
    setDeliveryMenuOpen(false);
    setDeliveryModePinned(true);
    writeDefaultDeliveryMode(window.localStorage, mode);
    writeDeliveryModePinned(window.localStorage, true);
  };
  // один и тот же переключатель в меню чата и в инспекторе сессии, ровно как переключатель темы
  const deliveryModeChoice = (
    <div><div className="theme-choice" role="group" aria-label="Режим отправки сообщений">
      <button type="button" className={effectiveDeliveryMode === "steer" ? "active" : ""} aria-pressed={effectiveDeliveryMode === "steer"} disabled={!supportsSteer} title={supportsSteer ? "Вставить сообщение в текущий ход агента" : "Этот харнесс не умеет вставлять сообщения в текущий ход — сообщение уйдёт в очередь"} onClick={() => selectDeliveryMode("steer")}>{deliveryModeLabel("steer")}</button>
      <button type="button" className={effectiveDeliveryMode === "queue" ? "active" : ""} aria-pressed={effectiveDeliveryMode === "queue"} onClick={() => selectDeliveryMode("queue")}>{deliveryModeLabel("queue")}</button>
    </div><small className="settings-help">«В текущий ход» передаёт уточнение при ближайшей возможности работающего агента. «После ответа» запускает сообщение, когда текущая работа завершится.</small>{!supportsSteer && <small className="settings-help">Эта среда принимает сообщения после ответа агента; вставка в текущий ход недоступна.</small>}</div>
  );
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
  const submitOutboxEntry = async (sessionKey: string, text: string, mode: DeliveryMode, inputId: string, images?: UploadedImage[]) => {
    const { harness, id } = splitKey(sessionKey);
    const next = appendOutboxEntry(outboxRef.current, { inputId, sessionKey, text, images, mode, createdAt: Date.now(), status: "ready" });
    outboxRef.current = next;
    setOutbox(next);
    if (!writeStoredOutbox(window.localStorage, next)) {
      setOutbox((current) => updateOutboxEntry(current, inputId, { status: "failed", error: "Не удалось сохранить предпросмотр. Сообщение не отправлено; освободите место в истории отправки." }));
      return;
    }
    shouldFollowRef.current = true; setShowScrollToLatest(false);
    await messageDispatcherRef.current.run(sessionKey, async () => {
    const latestEntry=outboxRef.current.find(item=>item.inputId===inputId);
    if(latestEntry){text=latestEntry.text;images=latestEntry.images;}
    const attempted = beginOutboxAttempt(window.localStorage, outboxRef.current, inputId);
    if (!attempted) {
      setOutbox((current) => updateOutboxEntry(current, inputId, { status: "ready", note: "Не удалось сохранить состояние отправки. Сообщение не отправлено; повторите после освобождения места." }));
      return;
    }
    setOutbox(attempted);
    let responded = false;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(id)}/message`, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(30_000), body: JSON.stringify({ message: text, mode, humanRequested: true, inputId, ...(images?.length ? { imageIds: images.map(image => image.id) } : {}) }) });
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
  const sendMessage = async (mode: DeliveryMode = effectiveDeliveryMode) => {
    if (!activeKey || readOnlySession || imageUploading || (!composer.trim() && !composerImages.length)) return;
    if(queueEdit){await saveQueueEdit();return;}
    const draft = composer;
    const text = draft.trim() || "Посмотрите прикреплённое изображение.";
    const images = composerImages; setComposerImages([]);
    setComposer((current) => current === draft ? "" : current);
    // Модель, с которой уходит это сообщение: выбранная пользователем иначе
    // текущая нативная. Фиксируем до отправки, чтобы подпись не зависела от
    // того, как быстро сессия обновит свою модель.
    const sendingModel = selectedModel ?? currentModelOption(activeSession?.model, modelOptions) ?? activeSession?.model;
    if (sendingModel) recordSessionModel(sendingModel);
    await submitOutboxEntry(activeKey, text, mode, newInputId(), images);
  };
  const appendVoiceTranscript = (transcript: string, targetKey: string) => {
    if (activeKeyRef.current !== targetKey) return;
    setComposer((current) => current ? `${current}${current.endsWith("\n") ? "" : "\n"}${transcript}` : transcript);
    window.requestAnimationFrame(() => {
      const input = composerTextareaRef.current;
      if (input && activeKeyRef.current === targetKey) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    });
  };
  const canOfferSendMode = !queueEdit && !isResumeMode && Boolean(activeKey) && !readOnlySession && !imageUploading && Boolean(composer.trim() || composerImages.length);
  const chooseSendMode = (mode: DeliveryMode) => {
    selectDeliveryMode(mode);
    void sendMessage(mode);
  };
  const clickSendButton = (mode?: DeliveryMode) => {
    if (isResumeMode && !queueEdit) void runAction("resume");
    else if (mode) chooseSendMode(mode);
    else void sendMessage();
  };
  const retryOutboxEntry = async (inputId: string) => {
    const entry = outbox.find((item) => item.inputId === inputId);
    if (!entry || messageDispatcherRef.current.hasPending(inputId) || (entry.status !== "ready" && (entry.status !== "failed" || entry.nonRetryable === true))) return;
    await submitOutboxEntry(entry.sessionKey, entry.text, entry.mode, entry.inputId, entry.images);
  };
  const dismissOutboxEntry = (inputId: string) => setOutbox((current) => removeOutboxEntry(current, inputId));
  const cancelQueueEdit=()=>{
    if(!queueEdit||queueEditSaving)return;
    setComposer(queueEdit.draft);setComposerImages(queueEdit.images);setQueueEdit(undefined);setQueueEditError('');
  };
  const editOutboxEntry=async(inputId:string)=>{
    const entry=outboxRef.current.find(item=>item.inputId===inputId);
    if(!entry||!canEditQueuedEntry(entry)||queueEditSaving)return;
    setQueueEditError('');
    let text=entry.text;
    if(entry.jobId){
      try{const {harness,id}=splitKey(entry.sessionKey);const value=await api<{inputId:string;message:string;editable:boolean}>(`/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(id)}/message-queue/${encodeURIComponent(inputId)}`);
        if(!value.editable||value.inputId!==inputId)throw Error('Сообщение уже передаётся агенту — изменить его нельзя');text=value.message;
      }catch(error){setQueueEditError(error instanceof Error?error.message:'Не удалось прочитать очередь');return;}
    }
    if(activeKeyRef.current!==entry.sessionKey)return;
    const prior=queueEdit;
    setQueueEdit({inputId,sessionKey:entry.sessionKey,expectedText:text,draft:prior?.draft??composer,images:prior?.images??composerImages});
    setComposer(text);setComposerImages(entry.images??[]);
  };
  const saveQueueEdit=async()=>{
    const edit=queueEdit,entry=edit&&outboxRef.current.find(item=>item.inputId===edit.inputId);
    if(!edit||!entry||queueEditSaving||edit.unknown||edit.sessionKey!==activeKey||!composer.trim())return;
    if(!canEditQueuedEntry(entry)){setQueueEditError('Сообщение уже передаётся агенту — изменить его нельзя');return;}
    const text=composer.trim();setQueueEditSaving(true);setQueueEditError('');
    try{
      if(entry.jobId){
        const {harness,id}=splitKey(entry.sessionKey);
        let response:Response;
        try{response=await fetch(`/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(id)}/message-queue/${encodeURIComponent(entry.inputId)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedMessage:edit.expectedText,message:text}),signal:AbortSignal.timeout(15000)});}
        catch{setQueueEdit(current=>current?{...current,unknown:true}:current);throw Error('Ответ на изменение не получен. Нажмите «Проверить», повторной отправки не будет');}
        let result:{ok:boolean;inputId?:string;message?:string;error?:string};
        try{result=await response.json();}catch{setQueueEdit(current=>current?{...current,unknown:true}:current);throw Error('Ответ на изменение не удалось прочитать. Нажмите «Проверить»');}
        if(!response.ok||!result.ok||result.inputId!==entry.inputId||result.message!==text)throw Error(result.error||'Не удалось подтвердить изменение очереди');
      }else if(entry.status!=='ready'){throw Error('Состояние очереди изменилось; проверьте доставку');}
      setOutbox(current=>current.map(item=>item.inputId===entry.inputId?{...item,text}:item));
      setComposer(edit.draft);setComposerImages(edit.images);setQueueEdit(undefined);
      if(!entry.jobId&&!messageDispatcherRef.current.hasPending(entry.inputId))void retryOutboxEntry(entry.inputId);
    }catch(error){setQueueEditError(error instanceof Error?error.message:'Изменение очереди не подтверждено');}
    finally{setQueueEditSaving(false);}
  };
  const checkQueueEdit=async()=>{
    if(!queueEdit)return;const edit=queueEdit,{harness,id}=splitKey(edit.sessionKey);
    try{const value=await api<{inputId:string;message:string;editable:boolean}>(`/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(id)}/message-queue/${encodeURIComponent(edit.inputId)}`);
      if(value.inputId!==edit.inputId)throw Error('Не подтверждена запись очереди');
      setOutbox(current=>current.map(item=>item.inputId===edit.inputId?{...item,text:value.message}:item));
      if(value.message===composer.trim()){setComposer(edit.draft);setComposerImages(edit.images);setQueueEdit(undefined);setQueueEditError('');}
      else{setQueueEditError('В очереди пока другой текст. Черновик сохранён; автоматического повтора нет');}
    }catch(error){setQueueEditError(error instanceof Error?error.message:'Не удалось проверить очередь');}
  };
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
        const payload = await response.json().catch(() => undefined) as { job?: { state?: unknown; result?: unknown } } | undefined;
        const job = payload?.job;
        if (job && isTerminalJobState(job.state)) return cancelOutcomeOfJob(job);
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
      if (outcome === "cancelled" || (outcome === "no-job" && entry.status === "ready")) {
        dismissOutboxEntry(inputId);
        if(queueEdit?.inputId===inputId)cancelQueueEdit();
      }
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
    if (!entry || !canSteerOutboxEntry(entry, splitKey(entry.sessionKey).harness, harnessAdapters.find(adapter => adapter.id === splitKey(entry.sessionKey).harness)?.capabilities?.steer === true) || !beginOutboxCancel(inputId)) return;
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
      await submitOutboxEntry(entry.sessionKey, entry.text, "steer", newInputId(), entry.images);
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
    // Escape закрывает самый верхний открытый слой: меню чата, диалог
    // настроек, поиск, инспектор. Раньше слой слышал Escape только пока был
    // открыт меню чата — шторку инспектора было не закрыть с клавиатуры.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (chatMenuOpen) { setChatMenuOpen(false); return; }
      if (automationSettings !== undefined) { setAutomationSettings(undefined); setShowQuota(false); return; }
      if (showSessionSearch) { setShowSessionSearch(false); return; }
      if (showInspector) closeSessionInspector();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chatMenuOpen, automationSettings, showSessionSearch, showInspector]);
  React.useEffect(() => {
    if (!chatMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (!target.closest(".chat-menu") && !target.closest(".desktop-chat-menu") && !target.closest(".mobile-automation-button")) setChatMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [chatMenuOpen]);

  React.useEffect(() => {
    const dialog = automationDialogRef.current;
    if (!automationSettings || !dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])')].filter((element) => element.getClientRects().length > 0);
    focusable()[0]?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setAutomationSettings(undefined);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const index = items.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey ? (index <= 0 ? items.length - 1 : index - 1) : (index < 0 || index === items.length - 1 ? 0 : index + 1);
      event.preventDefault();
      items[next]?.focus();
    };
    dialog.addEventListener("keydown", trapFocus);
    return () => {
      dialog.removeEventListener("keydown", trapFocus);
      const returnTarget = previous && previous !== document.body && previous.isConnected && previous.getClientRects().length > 0
        ? previous
        : [...document.querySelectorAll<HTMLElement>(".header-actions .desktop-chat-menu, .header-actions .mobile-automation-button")].find((element) => element.getClientRects().length > 0);
      returnTarget?.focus();
    };
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

  // Один список настроек на весь экран: и меню чата, и шестерёнка в шапке
  // открывают один и тот же набор настроек.
  const chatMenuContent = (
    <>
      <span className="chat-menu-section">Автоматизация</span><button className="quiet-button" onClick={() => { setShowJobs(false); setShowStatistics(false); setShowQuota(false); setAutomationSettings("autocontinue"); setChatMenuOpen(false); }}>{`Автопродолжение · общие настройки (в этом чате ${activeAutocontinueEnabled ? "включено" : "выключено"})`}</button><button className="quiet-button" onClick={() => { setShowJobs(false); setShowStatistics(false); setShowQuota(false); setAutomationSettings("autopilot"); setChatMenuOpen(false); }}>{`Автопилот · общие настройки (в этом чате ${activeAutopilotEnabled ? "включён" : "выключен"})`}</button><span className="chat-menu-section">Вид переписки</span><label><input type="checkbox" checked={showReasoning} onChange={(event) => setShowReasoning(event.target.checked)} /> Размышления</label><label><input type="checkbox" checked={showTools} onChange={(event) => setShowTools(event.target.checked)} /> Инструменты</label><label><input type="checkbox" checked={jsonRendering} onChange={(event) => setJsonRendering(event.target.checked)} /> JSON-ответы как JSON</label><label><input type="checkbox" checked={collapseLongMessages} onChange={(event) => setCollapseLongMessages(event.target.checked)} /> Сворачивать длинные сообщения</label><span className="chat-menu-section">Тема</span><div className="theme-choice" role="group" aria-label="Тема оформления"><button type="button" className={theme === "dark" ? "active" : ""} aria-pressed={theme === "dark"} onClick={() => selectTheme("dark")}>Тёмная</button><button type="button" className={theme === "light" ? "active" : ""} aria-pressed={theme === "light"} onClick={() => selectTheme("light")}>Светлая</button></div><span className="chat-menu-section">Отправка</span>{deliveryModeChoice}<span className="chat-menu-section">Разделы</span><button className="quiet-button" onClick={() => { setShowSearch(false); setShowFleet(false); setShowJobs(false); setShowStatistics(false); setShowQuota(false); setAutomationSettings(undefined); setShowProjects(true); setSettingsTab("settings"); setChatMenuOpen(false); }}>Настройки</button><button className="quiet-button" onClick={() => { setShowSearch(false); setShowFleet(false); setShowJobs(false); setShowStatistics(false); setShowQuota(false); setAutomationSettings(undefined); setShowProjects(true); setSettingsTab("projects"); setChatMenuOpen(false); }}>Проекты</button><button className="quiet-button" onClick={() => { setFleetCreationMode(false);setShowFleet(true); setChatMenuOpen(false); }}>Машины</button><button className="quiet-button" onClick={() => { setShowJobs(false); setShowStatistics(false); setShowQuota(false); setAutomationSettings("launch-policy"); setChatMenuOpen(false); }}>Настройки запуска новых сессий</button><button className="quiet-button" onClick={() => { setShowJobs(false); setShowStatistics(false); setShowQuota(false); openSessionInspector(); }}>Настройки текущей сессии</button><button className="quiet-button" onClick={() => { setShowJobs(true); setShowStatistics(false); setChatMenuOpen(false); }}>Задачи</button><button className="quiet-button" onClick={() => { setShowJobs(false); openStatistics(); }}>Статистика</button><button className="quiet-button" onClick={() => { setShowJobs(false); setShowStatistics(false); setAutomationSettings(undefined); setShowQuota(true); setChatMenuOpen(false); }}>Квота</button>
    </>
  );

  return <main className={`oc-app ${mobileView === "chat" ? "mobile-chat-active" : "mobile-sessions-active"} ${(!showInspector || showStatistics || showJobs || showQuota || showSearch || showProjects || automationSettings || remoteSelection || showFleet || showCreateSession) ? "no-inspector" : ""} ${layout.chatListOpen ? "" : "no-sessions"}`}>
    <CodexNavigation onMachines={() => { setShowSearch(false); setFleetCreationMode(false);setShowFleet(true); setAutomationSettings(undefined); setShowProjects(false); }} onSearch={() => { setShowFleet(false); setShowJobs(false); setShowStatistics(false); setShowQuota(false); setAutomationSettings(undefined); setShowSessionSearch(false); setShowSearch(true); setShowProjects(false); setMobileView("chat"); }} active={showSearch ? "search" : showProjects ? "projects" : showFleet ? "machines" : showJobs ? "jobs" : showStatistics ? "statistics" : "chat"} onChat={() => { setShowSearch(false); setShowFleet(false); setShowJobs(false); setShowStatistics(false); setShowQuota(false); setAutomationSettings(undefined); setShowProjects(false); }} onNew={() => { setShowSearch(false); setShowFleet(false); setRemoteSelection(undefined); setShowJobs(false); setShowStatistics(false); setShowQuota(false); setAutomationSettings(undefined); setShowProjects(false); void openCreateSession(); }} onJobs={() => { setShowSearch(false); setShowFleet(false); setRemoteSelection(undefined); setShowJobs(true); setShowStatistics(false); setShowQuota(false); setAutomationSettings(undefined); setShowProjects(false); }} onStatistics={() => { setShowSearch(false); setShowFleet(false); setRemoteSelection(undefined); setShowJobs(false); setShowQuota(false); setAutomationSettings(undefined); setShowProjects(false); openStatistics(); }} onProjects={() => { setShowSearch(false); setShowFleet(false); setShowJobs(false); setShowStatistics(false); setShowQuota(false); setAutomationSettings(undefined); setSettingsTab("projects"); setShowProjects(true); setMobileView("chat"); }} />
    <SessionList pins={sessionPins.pins} pinScope={directory.scope} onPin={sessionPins.toggle} pinError={sessionPins.error} onAdvancedSearch={(query) => { setAdvancedSearchQuery(query || undefined); setShowSessionSearch(false); setShowSearch(true); setMobileView("chat"); }} onMachines={() => { setShowSearch(false); setFleetCreationMode(false); setShowFleet(true); setAutomationSettings(undefined); }} onAutomationSettings={(section) => { setShowProjects(false); setShowSearch(false); setShowFleet(false); setRemoteSelection(undefined); setShowJobs(false); setShowStatistics(false); setShowQuota(false); setAutomationSettings(section); }} cacheSettings={viewCacheSettings} onCacheSettings={changeCacheSettings} onCacheClear={()=>{void viewCache.clear();if(cachedDetails)setDetails(null);setCacheEpoch(n=>n+1);}} directoryStatus={directory.error||(directory.pending?"Обновляются названия сессий…":directory.partial?"Часть машин ещё не передала полный список.":"")} onLoadMore={directory.more&&!directory.pending?()=>void directory.load(true):undefined} onNewSession={openCreateSession} onCollapse={() => setLayoutField("chatListOpen", false)} entries={visibleSessionEntries} activeKey={remoteSelection?`mesh:${JSON.stringify([remoteSelection.hostId,remoteSelection.harness,remoteSelection.nativeSessionId])}`:activeKey} loading={loading} refreshing={sessionsRefreshing && !loading} settings={effectiveListSettings} settingsOpen={showSessionSettings} searchOpen={showSessionSearch} searchQuery={sessionSearch} options={listOptions} choicesBySession={choicesBySession} choosingRequestId={choosingRequestId} choiceError={choiceError} collapsedChildren={collapsedChildren} onSearchChange={setSessionSearch} onSearchToggle={() => setShowSessionSearch((value) => !value)} onSettingsToggle={() => setShowSessionSettings((value) => !value)} onSettingsChange={(patch) => setListSettings((current) => ({ ...current, ...patch }))} onToggleChildren={(key) => setCollapsedChildren((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })} loadedCount={sessions.length} total={sessionsTotal} sample={sessionSample} onLoadMoreSessions={() => { void loadMoreSessions(); }} quickCounts={quickFilterCounts} quickStatus={listStatusFilter} onQuickStatusChange={setListStatusFilter} onChoose={(requestId, choiceId) => void chooseAutopilot(requestId, choiceId)} onSelect={(key) => { setShowSearch(false); setShowFleet(false); const selected=displaySessions.find(s=>keyOf(s)===key);if(selected?.remote&&selected.hostId){setRemoteSelection({hostId:selected.hostId,harness:selected.harness,nativeSessionId:selected.id});setMobileView("chat");return;}setRemoteSelection(undefined);shouldFollowRef.current = true; setShowScrollToLatest(false); setShowStatistics(false); setShowJobs(false); selectSession(key); setMobileView("chat"); }} />
    {showProjects && <SettingsScreen tab={settingsTab} onTabChange={setSettingsTab} onOpenLaunchSettings={() => { setShowProjects(false); setAutomationSettings("launch-policy"); }} />}
    {showSearch && <RagSearchView initialQuery={advancedSearchQuery} onInitialQueryApplied={consumeAdvancedSearchInitialQuery} onOpenSession={(harness, id) => { setShowSearch(false); setShowFleet(false); setShowJobs(false); setShowStatistics(false); setShowQuota(false); selectSession(`${harness}:${id}`); setMobileView("chat"); }} />}
{showFleet && <div className="fleet-overlay" role="region" aria-label="Машины флота"><div className="fleet-overlay-panel"><button className="fleet-overlay-close quiet-button" aria-label="Закрыть машины флота" onClick={() => setShowFleet(false)}>Закрыть</button><FleetCabinet creationMode={fleetCreationMode} defaultHostId={selectedCreationHostId} onSelectedHostChange={setSelectedCreationHostId} activityRows={activity.snapshot.confirmed} /></div></div>}
    {remoteSelection&&directory.hosts.find(h=>h.hostId===remoteSelection.hostId)&&<RemoteSessionView key={JSON.stringify(remoteSelection)+cacheEpoch} renderMessage={message=>!hasVisibleMessage(message,showReasoning,showTools)?null:serviceNoteLabel(message)?<ServiceNote label={serviceNoteLabel(message)!} message={message}/>:<CollapsibleMessage message={message} showReasoning={showReasoning} showTools={showTools} jsonRendering={jsonRendering} collapseLongMessages={collapseLongMessages}/>} address={remoteSelection} host={directory.hosts.find(h=>h.hostId===remoteSelection.hostId)!} scope={directory.scope} cache={viewCache} onClose={()=>{setRemoteSelection(undefined);setMobileView("sessions");}}/>}
    <section className="chat-pane" style={remoteSelection||showSearch||showProjects?{display:'none'}:undefined}>
      {cachedDetails&&<p className="cached-view-notice" role="status">Сохранённый просмотр. Отправка станет доступна после загрузки свежих данных.</p>}
      <header className="chat-header">
        <button className="mobile-back" onClick={() => setMobileView("sessions")} aria-label="К списку сессий">← <span>Сессии</span></button>
        <div className="chat-heading">{showCreateSession ? <><h2>Новый чат</h2><small>Выберите среду, модель и каталог проекта.</small></> : showJobs ? <><span className="eyebrow">AGENT HERDER</span><h2>Задачи</h2><small>Фоновые задачи и их прогресс</small></> : showStatistics ? <><span className="eyebrow">AGENT HERDER</span><h2>Статистика</h2><small>Реальные паттерны активности недавних сессий</small></> : showQuota ? <><span className="eyebrow">AGENT HERDER</span><h2>Квота</h2><small>Окна Codex, расход моделей, потребители</small></> : <><span className="eyebrow">{activeSession?.harness || "HERDER"}</span><h2 title={activeSession ? `${activeSession.title || activeSession.id}\n${activeSession.cwd || ""}` : undefined}>{activeSession ? (cleanSessionTitle(activeSession.title) || activeSession.id) : loading ? "Загрузка сессий…" : "Выберите сессию"}{(detailsLoading || detailsHydrating) && <span className="inline-loading-dot chat-loading-dot" role="status" aria-label="Загрузка сессии" />}</h2><small className="chat-session-state"><span>{activeSession?.harness || ""}</span>{activeSession && <><span aria-hidden="true"> · </span><span className={`status-label status-${statusClass(activeSession.status)}`}>{statusLabel(activeSession.status)}</span></>}</small>{SHOW_DEBUG_TIMINGS && <div className="load-timings" role="status" aria-label="Тайминги загрузки в браузере"><span title="Страница → список сессий готов">sessions <b>{formatLoadTiming(sessionsTimingMs)}</b></span>{activeKey && <><span title="Запрос свежих ходов">latest <b>{detailsLoading ? "…" : formatLoadTiming(latestTimingMs)}</b></span><span title="Фоновая история и метрики">hydrate <b>{detailsHydrating ? "…" : formatLoadTiming(hydrateTimingMs)}</b></span></>}</div>}</>}</div>
        <div className="header-actions">
          <button className={`icon-button chat-list-toggle ${layout.chatListOpen ? "selected-icon" : ""}`} aria-label="Список чатов" title={layout.chatListOpen ? "Скрыть список чатов" : "Показать список чатов"} aria-pressed={layout.chatListOpen} onClick={() => setLayoutField("chatListOpen", !layout.chatListOpen)}>
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>
          </button>
          {!showStatistics && !showJobs && !showQuota && <button className={`icon-button session-inspector-button ${showInspector ? "selected-icon" : ""}`} aria-label="Панель сессии" title="Файлы, таймлайн и метаинформация сессии" aria-pressed={showInspector} onClick={() => { setSessionSettingsReturn(undefined); setShowInspector((value) => !value); }}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="9" cy="18" r="2"/></svg></button>}
          <button className={`icon-button desktop-chat-menu ${chatMenuOpen ? "selected-icon" : ""}`} aria-label="Меню чата" aria-expanded={chatMenuOpen} title="Все настройки" onClick={() => setChatMenuOpen((value) => !value)}>···</button>
        </div>
        {chatMenuOpen && <div className="chat-menu" aria-label="Меню чата"><button type="button" className="chat-menu-close" aria-label="Закрыть меню чата" title="Закрыть меню чата" onClick={() => setChatMenuOpen(false)}>×</button>{chatMenuContent}</div>}
      </header>
      {activeSession?.needsPermission && !remoteSelection && !showCreateSession && !showJobs && !showStatistics && !showQuota && <NativePermissionStrip key={`${activeSession.harness}:${activeSession.id}:${activeSession.permissionDetails?.id}`} session={activeSession} onRefresh={()=>{void loadSessions();if(activeKey)void loadDetails(activeKey,false);}}/>}
      {activeSession && !remoteSelection && !showCreateSession && !showJobs && !showStatistics && !showQuota && <SessionWorkTarget
        session={{ id: activeSession.id, harness: activeSession.harness, cwd: activeSession.cwd, hostId: activeSession.hostId }}
        hosts={workTargetHosts}
        localHostId={directory.localHostId}
        expanded={layout.headerOpen}
        onExpandedChange={(value) => setLayoutField("headerOpen", value)}
        settingsMenu={chatMenuContent}
        onApplied={() => { void loadSessions(); if (activeKey) void loadDetails(activeKey); }} />}
      {showJobs && <JobsView jobs={jobs} loading={jobsLoading} error={jobsError} cancellingJobId={cancellingJobId} onRefresh={() => void loadJobs()} onCancel={(jobId) => void cancelJob(jobId)} />}
      {showQuota && <><CodexQuotaSettings /><QuotaPanel /></>}
      {showStatistics && <StatisticsView statistics={statistics} loading={statisticsLoading} error={statisticsError} days={statisticsDays} onDays={changeStatisticsDays} onRefresh={() => void loadStatistics(statisticsDays, true)} />}
      {!showStatistics && !showJobs && !showQuota && automationSettings && <div className="autopilot-settings-overlay" ref={automationDialogRef} role="dialog" aria-modal="true" aria-label="Настройки автоматизации"><div className="autopilot-settings-shell"><header className="settings-dialog-header"><div className="settings-dialog-title"><span>Автоматизация</span><h2>{automationSettings === "autocontinue" ? "Автопродолжение" : automationSettings === "autopilot" ? "Автопилот" : "Запуск сессий"}</h2></div><button className="settings-close" aria-label={`Закрыть настройки ${automationSettings === "launch-policy" ? "запуска новых сессий" : automationSettings === "autocontinue" ? "автопродолжения" : "автопилота"}`} onClick={() => setAutomationSettings(undefined)}>×</button></header><div className="settings-dialog-body">{automationSettings === "launch-policy" ? <><CodexQuotaSettings /><LaunchPolicySettings onOpenProjects={() => { setAutomationSettings(undefined); setShowProjects(true); }} /><FallbackModelsSettings /></> : <AutomationSettings section={automationSettings} state={autopilotPolicy} draft={autopilotPolicyDraft} saving={autopilotPolicySaving} error={autopilotPolicyError} saved={autopilotPolicySaved} continuation={continuationHarnesses} continuationSaving={continuationHarnessSaving} continuationFailed={continuationHarnessFailed} continuationError={continuationHarnessError} runtimeState={runtimeSettingsState} runtimeDraft={runtimeSettingsDraft} runtimeSaving={runtimeSettingsSaving} runtimeSaved={runtimeSettingsSaved} runtimeError={runtimeSettingsError} modelOptions={runtimeModelOptions} sessionControlAvailable={automationSettings === "autocontinue" ? Boolean(sessionAutostart) : Boolean(autopilotSession)} sessionControlStatus={automationSettings === "autocontinue" ? `Текущая сессия: автопродолжение ${sessionAutostart?.enabled ? "включено" : "выключено"}` : `Текущая сессия: автопилот ${autopilotSession?.enabled ? "включён" : "выключен"}`} capabilityNote={activeSession && !activeHarnessSupportsAutocontinue ? `Автопродолжение после сбоя для ${AUTOPILOT_HARNESS_LABELS[activeSession.harness as AutopilotHarness]} пока недоступно. Автопилот может оценивать завершение задач и продолжать их по своей политике.` : undefined} onChange={(next) => { setAutopilotPolicyDraft(next); setAutopilotPolicySaved(false); }} onSave={() => void saveAutopilotPolicy()} onGlobalContinuationToggle={() => void toggleGlobalContinuation()} onContinuationToggle={(harness) => void toggleContinuationHarness(harness)} onRuntimeChange={(next) => { setRuntimeSettingsDraft(next); setRuntimeSettingsSaved(false); }} onRuntimeSave={() => void saveRuntimeSettings()} onOpenSessionControl={() => openSessionInspector(automationSettings === "autocontinue" ? "autocontinue" : "autopilot")} />}</div></div></div>}
      {!showStatistics && !showJobs && !showQuota && !!details?.children?.length && <details className="subagents-panel"><summary>Субагенты <span>{details.children.length}</span></summary><div className="subagents-list">{details.children.map((child) => <button className="subagent-row" key={keyOf(child)} onClick={() => { selectSession(keyOf(child)); setMobileView("chat"); }}><span className={`status-dot status-${statusClass(child.status)}`} /><span><strong>{child.title || child.id}</strong><small>{typeof child.meta?.agentRole === "string" ? child.meta.agentRole : statusLabel(child.status)} · {child.id}</small></span></button>)}</div></details>}
      {!showCreateSession && !showStatistics && !showJobs && !showQuota && <div className="chat-scroll" ref={chatScrollRef} onScroll={handleChatScroll}>
        <div className="message-column" role="log" aria-live="polite" aria-relevant="additions text" aria-label="Переписка">
          {detailsLoading && !details && <div className="session-loading-chat" aria-live="polite"><div className="session-loading-orbit"><span /><span /><span /></div><strong>Загружаю свежие сообщения</strong><small>Начинаем с последних ходов; остальным Agent Herder можно пользоваться дальше.</small></div>}
          {!detailsLoading && !details && <div className="empty-chat">{detailsError
            ? <><strong>{sessionDetailsErrorText(detailsError)?.reason}</strong><br />{sessionDetailsErrorText(detailsError)?.hint}</>
            : "Выберите сессию, чтобы открыть переписку."}</div>}
          {detailsHydrating && details && <div className="history-loading-banner"><span className="inline-loading-dot" /> Последние {formatLoadTiming(latestTimingMs)} · подгружаю историю и метрики…</div>}
          {localTranscriptAddress&&<div className="local-transcript-controls"><button type="button" className="quiet-button" disabled={localTranscriptLoading} onClick={()=>void readLocalTranscript(undefined,true)}>Обновить историю</button>{localTranscriptLoading&&<span role="status">Загружаю историю сессии…</span>}</div>}
          {localTranscriptError&&<p role="alert" className="remote-chat-error">{localTranscriptError}</p>}
          {linkedTurnId&&turnFocusKey&&currentLocalTranscript&&firstEventIndexForTurn(currentLocalTranscript.events,linkedTurnId)===undefined&&<p role="status">{currentLocalTranscript.nextCursor?(turnFocusExhausted?"Связанное сообщение пока не найдено. Загрузите следующую страницу истории.":"Ищу точное сообщение по ссылке…"):currentLocalTranscript.complete?"Связанное сообщение не найдено в истории этой сессии.":"История продолжается; точное сообщение пока не найдено. Загрузите следующую страницу истории."}</p>}
          {currentLocalTranscript ? currentLocalTranscript.events.map((event,index)=>{
            const {message,attribution,visualRole}=integratorEventDisplay(event);
            if(!hasVisibleMessage(message,showReasoning,showTools))return null;
            const noteLabel=serviceNoteLabel(message);
            const transcriptCaption = modelCaption(message);
            return <article className={`message ${visualRole}`} key={message.id??index} data-turn-id={event.turnId} data-event-id={event.eventId}><div className="message-meta"><span>{attribution}</span><time>{formatTime(message.timestamp||"")}</time>{transcriptCaption && <span className="message-model" title={transcriptCaption.full}>{transcriptCaption.short}</span>}</div>{noteLabel?<ServiceNote label={noteLabel} message={message}/>:<CollapsibleMessage message={message} showReasoning={showReasoning} showTools={showTools} jsonRendering={jsonRendering} collapseLongMessages={collapseLongMessages}/>}</article>;
          }) : groupSessionMessages(chatDelivery.messages).map((group, groupIndex, groups) => {
            const visible = group.messages.filter((message) => hasVisibleMessage(message, showReasoning, showTools));
            if (visible.length === 0) return null;
            const isLastAssistant = group.role === "assistant" && groupIndex === groups.length - 1;
            const groupCaption = modelCaption(visible[0], group.timestamp);
            return <article className={`message ${group.role}`} key={group.id}><div className="message-meta"><span>{group.role === "user" ? "Вы" : group.role === "tool" ? "Инструмент" : "Агент"}</span><time>{formatTime(group.timestamp || "")}</time>{groupCaption && <span className="message-model" title={groupCaption.full}>{groupCaption.short}</span>}</div>{visible.map((message, index) => {
              const noteLabel = serviceNoteLabel(message);
              return noteLabel ? <ServiceNote key={message.id} label={noteLabel} message={message} /> : <CollapsibleMessage key={message.id} message={message} showReasoning={showReasoning} showTools={showTools} jsonRendering={jsonRendering} collapseLongMessages={collapseLongMessages} forceExpanded={isLastAssistant && index === visible.length - 1} />;
            })}</article>;
          })}
          {currentLocalTranscript?.nextCursor&&<button type="button" className="quiet-button" disabled={localTranscriptLoading} onClick={()=>void readLocalTranscript(currentLocalTranscript.nextCursor??undefined)}>Загрузить следующую страницу истории</button>}
        </div>
      </div>}
      {!showCreateSession && !showStatistics && !showJobs && !showQuota && showScrollToLatest && <button className="scroll-latest" aria-label="Прокрутить к последним" onClick={scrollToBottom}>↓</button>}
      {!showStatistics && !showJobs && !showQuota && <div className="composer-stack">
      <div className="activity-slot">{!showCreateSession && sessionActivity && <div className={`activity-line activity-${sessionActivity.kind}`} role="status" aria-live="polite"><span className="pulse-dot" aria-hidden="true" />{activeSession?.status === "running" && !sending ? <span><ActivityElapsed sinceMs={runningSince} />{sessionActivity.label ? <em className="activity-detail"> · {sessionActivity.label}</em> : null}</span> : <span>{sessionActivity.label}</span>}</div>}</div>
      {!showCreateSession && activeSession?.harness === "zcode" && activeSession.hostId && <QueueProcessingControl target={{hostId:activeSession.hostId,harness:activeSession.harness,sessionId:activeSession.id}} readState={readSessionQueueProcessing} resume={submitSessionQueueProcessing}/>}
      {activeOutbox.length>0&&<ComposerQueue entries={activeOutbox} busy={cancellingOutbox} pending={id=>messageDispatcherRef.current.hasPending(id)} canSteer={entry=>canSteerOutboxEntry(entry,splitKey(entry.sessionKey).harness,harnessAdapters.find(adapter=>adapter.id===splitKey(entry.sessionKey).harness)?.capabilities?.steer===true)} onSteer={id=>void steerOutboxEntry(id)} onCancel={id=>void deleteOutboxEntry(id)} onEdit={id=>void editOutboxEntry(id)} onCheck={entry=>void checkOutboxEntry(entry)} onRetry={id=>void retryOutboxEntry(id)} onDismiss={dismissOutboxEntry}/>}
      {queueEdit&&<div className="composer-queue-edit"><span>Редактирование сообщения очереди</span><button type="button" disabled={queueEditSaving} onClick={cancelQueueEdit}>Отмена редактирования</button>{queueEdit.unknown&&<button type="button" onClick={()=>void checkQueueEdit()}>Проверить</button>}</div>}
      {queueEditError&&<div className="composer-queue-edit-error" role="status">{queueEditError}</div>}
      <form className="composer" data-creating={showCreateSession} onSubmit={(event) => { event.preventDefault(); if(showCreateSession){void createNewSession();return;} if (isResumeMode && !queueEdit) void runAction("resume"); else void sendMessage(); }}>
        {showCreateSession && <div className="composer-create-panel"><div className="composer-create-machine"><button type="button" className="quiet-button" onClick={() => setShowCreateSession(false)}>Отмена</button><span>Создание на машине: {directory.hosts.find(host => host.hostId === directory.localHostId)?.label || "Текущая машина"}</span><button type="button" className="quiet-button" onClick={() => {setFleetCreationMode(true);setShowFleet(true);}}>Выбрать другую машину</button></div>
          <div className="composer-create-row">
            <label>Агент<select value={createHarness} onChange={(event) => { const harness = event.target.value; setCreateHarness(harness); setCreateModel(""); setCreateModels([]); void loadCreateModels(harness); }}>{(createAdapters.length ? createAdapters : [{ id: "fast-agent", name: "Fast Agent", active: true, ready: true, status: "active" }]).map((adapter) => <option key={adapter.id} value={adapter.id} disabled={!adapter.active}>{adapter.name}{adapter.active ? "" : ` · ${adapter.status}`}</option>)}</select></label>
            <label className="cwd-picker">Папка<input value={createCwd} onChange={(event) => { const value = event.target.value; setCreateCwd(value); void loadCwdSuggestions(value); }} onFocus={() => void loadCwdSuggestions(createCwd.endsWith("/") ? createCwd : `${createCwd}/`)} onBlur={() => window.setTimeout(() => setCwdSuggestionsOpen(false), 120)} placeholder="/home/roomhacker/project" autoComplete="off" />{cwdSuggestionsOpen && cwdSuggestions.length > 0 && <div className="cwd-suggestions">{cwdSuggestions.map((item) => <button type="button" key={item.path} onMouseDown={(event) => event.preventDefault()} onClick={() => { setCreateCwd(`${item.path}/`); void loadCwdSuggestions(`${item.path}/`); }}><span className="cwd-folder">▱</span><span>{item.name}</span><small>{item.path}</small></button>)}</div>}</label>
            <label>Модель{createModels.length > 0 ? <select value={createModel} onChange={(event) => setCreateModel(event.target.value)}>{createModels.map((model) => <option key={model} value={model}>{model === "anthropic.MiniMax-M3.1-Flash" ? "MiniMax M3.1 Flash" : model}</option>)}</select> : createModelsRefreshing ? <select disabled><option>загрузка моделей…</option></select> : <input value={createModel} onChange={(event) => setCreateModel(event.target.value)} placeholder="модель (кэш пуст)" />}</label>
            <button type="button" className="primary-button composer-create-submit" disabled={creatingSession || !createCwd.trim()} onClick={() => void createNewSession()}>{creatingSession ? "…" : "Создать"}</button>
          </div>
          {createSessionError && <div className="create-session-error">{createSessionError}</div>}
        </div>}
        {!showCreateSession && <><div className="composer-left">{supportsImages && !readOnlySession ? <><input ref={imageInputRef} className="composer-file-input" type="file" disabled={Boolean(queueEdit)} accept="image/png,image/jpeg,image/webp" multiple aria-label="Файл изображения" onChange={event => void uploadImages(event.target.files)} /><button type="button" className="composer-plus" aria-label="Прикрепить изображение" title="Прикрепить изображение (до 5 МБ)" disabled={imageUploading || !activeKey || Boolean(queueEdit)} onClick={() => imageInputRef.current?.click()}>+</button></> : <button type="button" className={`composer-plus ${showCreateSession ? "active" : ""}`} aria-label="Новая сессия" title="Новая сессия агента" onClick={() => { if (showCreateSession) setShowCreateSession(false); else void openCreateSession(); }}>+</button>}{activeKey && !readOnlySession && <button type="button" className="composer-delivery-mode" aria-label="Режим отправки" aria-expanded={deliveryMenuOpen} onClick={() => setDeliveryMenuOpen(current => !current)}>{deliveryModeLabel(effectiveDeliveryMode)} ▾</button>}</div>
        {deliveryMenuOpen && <div className="composer-delivery-menu" role="dialog" aria-label="Когда отправлять сообщение">{deliveryModeChoice}</div>}
        {(composerImages.length > 0 || imageUploading || imageError) && <div className="composer-images">{composerImages.map(image => <div className="composer-image" key={image.id}><img src={image.url} alt={image.fileName} /><button type="button" disabled={Boolean(queueEdit)} aria-label={`Убрать ${image.fileName}`} onClick={() => setComposerImages(current => current.filter(item => item.id !== image.id))}>×</button></div>)}{imageUploading && <span>Загружаю изображение…</span>}{imageError && <span role="alert">{imageError}</span>}</div>}
        {readOnlySession ? <div className="composer-readonly"><strong>{archivedSession ? "Архивная сессия" : "Только просмотр"}</strong><span>{archivedSession ? "Сохранённая история сессии доступна для просмотра." : "Эта сессия пока не поддерживает отправку сообщений."}</span></div> : <>
          <textarea ref={composerTextareaRef} value={composer} onChange={(event) => setComposer(event.target.value)} placeholder={isResumeMode ? "Продолжите работу…" : activeKey ? "Работайте с агентом" : "Сначала выберите сессию"} disabled={!activeKey || readOnlySession} onKeyDown={(event) => {
            if (!isComposerSubmitShortcut(event)) return;
            event.preventDefault();
            if (isResumeMode && !queueEdit) void runAction("resume"); else void sendMessage();
          }} />
          {modelSwitchHarness && <button type="button" className={`composer-model ${modelMenuOpen ? "open" : ""}`} aria-label="Выбрать модель" aria-expanded={modelMenuOpen} aria-haspopup="listbox" disabled={modelSwitching} onClick={toggleModelMenu}>
            <span className="composer-model-name" title={composerModel ? modelOptionLabel(composerModel) : undefined}>{shortModelLabel(composerModel).replace(/\$(?:max|high|low|enabled)$/, "")}</span>
            {!activeSession?.model && <span className="composer-model-default">по умолчанию</span>}
            <span className="composer-model-chevron" aria-hidden="true">▾</span>
          </button>}
          {modelMenuOpen && modelSwitchHarness && <div className="composer-model-menu" role="listbox" aria-label={`Модели ${modelSwitchHarness}`}>
            <div className="composer-model-note">{composerModelPending ? "Выбранная модель применится со следующего ответа — нативная ещё не переключилась." : "Модель для следующих ответов в этой сессии. История сохраняется."}</div>
            {modelSwitchError && <div className="composer-model-note error" role="alert">{modelSwitchError}</div>}
            {modelOptionsLoading && <div className="composer-model-note">Загружаю модели…</div>}
            {!modelOptionsLoading && modelOptionsHarness === modelSwitchHarness && modelOptions.length === 0 && <div className="composer-model-note">Сервер не вернул моделей для {modelSwitchHarness}.</div>}
            {modelOptions.map((model) => <button type="button" role="option" aria-selected={model === currentModelOption(activeSession?.model, modelOptions)} className={model === currentModelOption(activeSession?.model, modelOptions) ? "current" : ""} key={model} onClick={() => void changeSessionModel(model)} title={model}>{modelOptionLabel(model)}{modelOptions.filter(option => shortModelLabel(option) === shortModelLabel(model)).length > 1 && <small className="model-provider">{modelSourceLabel(model)}</small>}</button>)}
          </div>}
          <VoiceComposerControl key={activeKey??"no-session"} sessionKey={activeKey??""} disabled={!activeKey||readOnlySession} onTranscript={appendVoiceTranscript} />
          <ComposerSendControl className={isResumeMode?"resume-button":""} disabled={queueEditSaving||Boolean(queueEdit?.unknown)||!activeKey||imageUploading||(!isResumeMode&&!composer.trim()&&!composerImages.length)} busy={false} supportsSteer={supportsSteer} allowModeChoice={canOfferSendMode} title={queueEdit?"Сохранить изменения в том же сообщении очереди":isResumeMode?"Возобновить работу в той же сессии":effectiveDeliveryMode==="queue"?"Отправить после ответа агента":"Передать в текущий ход агента"} label={queueEdit?"Сохранить сообщение очереди":isResumeMode?"Продолжить сессию":"Отправить сообщение"} icon={queueEdit?"↑":isResumeMode?<svg className="send-open-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H3v11h11V9M9 3h5v5M14 3 8 9" /></svg>:"↑"} onSend={clickSendButton} />
        </>}
        </>}
      </form></div>}
    </section>
    {showInspector && !showCreateSession && !showStatistics && !showJobs && <><div className="inspector-scrim" aria-hidden="true" onClick={closeSessionInspector} /><aside className="inspector-pane"><div className="inspector-heading"><span className="eyebrow">СЕССИЯ</span><button className={sessionSettingsReturn ? "quiet-button" : "icon-button"} onClick={closeSessionInspector} aria-label={sessionSettingsReturn ? "Вернуться к общим настройкам" : "Закрыть настройки сессии"}>{sessionSettingsReturn ? "← К общим настройкам" : "×"}</button></div>{activeSession ? <><div className="inspector-title">{cleanSessionTitle(activeSession.title) || activeSession.title || activeSession.id}</div><div className="inspector-status"><span className={`status-dot status-${statusClass(activeSession.status)}`} /><span className={`status-label status-${statusClass(activeSession.status)}`}>{activeSession.meta?.humanStopHeld === true ? "Явная остановка — автоматика приостановлена" : statusLabel(activeSession.status)}</span></div>{sessionAutostart && <div className="autopilot-control session-autostart-control"><div><span className="eyebrow">АВТОПРОДОЛЖЕНИЕ</span><strong>{sessionAutostart.enabled ? "Включено" : "Выключено"}</strong><small>{sessionAutostart.source === "session" ? "Отдельная настройка этой сессии. Переключатель применяется сразу только здесь." : sessionAutostart.source === "harness" ? `Сейчас наследуется общая настройка для ${activeSession.harness}. Нажатие создаст исключение только для этой сессии и применится сразу.` : sessionAutostart.source === "global" ? "Сейчас наследуется общий переключатель. Нажатие создаст исключение только для этой сессии и применится сразу." : "Используется значение по умолчанию. Нажатие создаст отдельную настройку только для этой сессии и применится сразу."}</small>{sessionAutostart.source === "session" && <button className="inherit-button" disabled={sessionAutostartSaving} onClick={() => void inheritSessionAutostart()}>Использовать общую настройку {activeSession.harness}</button>}</div><button className={`switch-control ${sessionAutostart.enabled ? "enabled" : ""}`} role="switch" aria-checked={sessionAutostart.enabled} aria-label="Автопродолжение для текущей сессии" disabled={sessionAutostartSaving} onClick={() => void toggleSessionAutostart()}><span /></button></div>}{sessionAutostartError && <small className="autopilot-error">{sessionAutostartError}</small>}{["opencode", "zcode"].includes(activeSession.harness) && <QuotaRecoveryControls session={{harness: activeSession.harness, id: activeSession.id, cwd: activeSession.cwd}} />}{autopilotSession && <div className="autopilot-control"><div><span className="eyebrow">АВТОПИЛОТ</span><strong>{autopilotSession.enabled ? "Включён" : "Выключен"}</strong><small>{autopilotSession.source === "session" ? "Отдельная настройка этой сессии. Переключатель применяется сразу только здесь." : autopilotSession.source === "policy" ? (autopilotPolicyDraft?.enabled && !autopilotPolicyDraft.harnesses.includes(activeSession.harness as AutopilotHarness) ? `${AUTOPILOT_HARNESS_LABELS[activeSession.harness as AutopilotHarness]} выключен в общих настройках сред. Нажатие включит автопилот только для этой сессии и применится сразу.` : "Сейчас наследуется общая настройка автопилота. Нажатие создаст исключение только для этой сессии и применится сразу.") : autopilotSession.source === "plugin-default" ? "Сейчас наследуется настройка среды. Нажатие создаст исключение только для этой сессии и применится сразу." : "По умолчанию выключен. Нажатие включит автопилот только для этой сессии и применится сразу."}</small>{autopilotSession.source === "session" && <button className="inherit-button" disabled={autopilotSessionSaving} onClick={() => void inheritAutopilotSession()}>Использовать общую настройку</button>}</div><button className={`switch-control ${autopilotSession.enabled ? "enabled" : ""}`} role="switch" aria-checked={autopilotSession.enabled} aria-label="Автопилот для текущей сессии" disabled={autopilotSessionSaving} onClick={() => void toggleAutopilotSession()}><span /></button></div>}{autopilotSessionError && <small className="autopilot-error">{autopilotSessionError}</small>}{!AUTOCONTINUE_HARNESSES.has(activeSession.harness) && <p className="settings-help">Автопродолжение после сбоя в этой среде пока недоступно. Можно продолжить сессию вручную.</p>}<dl><dt>Агент</dt><dd>{activeSession.harness}</dd><dt>Папка</dt><dd title={activeSession.cwd}>{lastSegment(activeSession.cwd)}</dd>{activeSession.messageCount !== undefined && <><dt>Сообщения</dt><dd>{activeSession.messageCount}</dd></>}{activeSession.durationSec !== undefined && <><dt>Длительность</dt><dd>{formatDuration(activeSession.durationSec)}</dd></>}{activeSession.model !== undefined && activeSession.model.includes("/") && <><dt>Источник</dt><dd title={activeSession.model}>{modelSourceLabel(activeSession.model)}</dd></>}{metaNumber(activeSession, ["total_tokens", "totalTokens", "tokens"]) !== undefined && <><dt>Токены</dt><dd>{metaNumber(activeSession, ["total_tokens", "totalTokens", "tokens"])}</dd></>}<><dt>Траты</dt><dd>{typeof activeSession.costUsd === "number" ? `$${activeSession.costUsd.toFixed(4)}` : "среда не сообщает"}</dd></></dl><section className="permission-mode-control" aria-label="Режим разрешений сессии"><div className="permission-mode-heading"><span className="eyebrow">РЕЖИМ РАЗРЕШЕНИЙ</span><button className="quiet-button" disabled={permissionModeLoading || permissionModeSaving} onClick={() => void refreshPermissionModeState()}>{permissionModeLoading ? "Читаю…" : "Обновить"}</button></div>{permissionModeLoading && !permissionModeRead ? <small>Читаю состояние выбранной сессии…</small> : permissionModeRead?.available && permissionModeRead.permissionState ? <><div className="permission-mode-facts"><span>Текущий режим</span><strong>{permissionModeRead.permissionState.currentMode || "не сообщён средой"}</strong><span>Область</span><strong>{permissionModeRead.permissionState.scope}</strong><span>Ожидают решения</span><strong>{permissionModeRead.permissionState.pendingRequests.length}</strong></div>{permissionModeRead.permissionState.pendingRequests.map((pending) => <small className="permission-mode-pending-reason" key={pending.id}>{pending.toolName || pending.reason || pending.unsupportedReason || "Ожидает решения"}{pending.canRespond === false ? " — среда не позволяет ответить через этот интерфейс." : ""}</small>)}{permissionModeRead.permissionState.scope === "session" && permissionModeRead.permissionState.canSetMode && (permissionModeRead.permissionState.supportedModes?.length ?? 0) > 0 ? <div className="permission-mode-editor"><label>Выбрать режим<select aria-label="Режим разрешений сессии" value={permissionModeChoice} onChange={(event) => setPermissionModeChoice(event.target.value)} disabled={permissionModeSaving || permissionModeRead.permissionState.pendingRequests.length > 0}><option value="" disabled>Выберите режим</option>{permissionModeRead.permissionState.supportedModes!.map((mode) => <option key={mode} value={mode}>{mode}</option>)}</select></label><button className="quiet-button" disabled={permissionModeSaving || permissionModeLoading || permissionModeRead.permissionState.pendingRequests.length > 0 || !permissionModeRead.permissionState.currentMode || permissionModeChoice === permissionModeRead.permissionState.currentMode} onClick={() => void applyPermissionMode()}>{permissionModeSaving ? "Применяю…" : "Применить к этой сессии"}</button>{permissionModeRead.permissionState.pendingRequests.length > 0 && <small>Сначала обработайте ожидающие запросы разрешений.</small>}</div> : <small>{permissionModeRead.permissionState.scope !== "session" ? `Среда сообщает область «${permissionModeRead.permissionState.scope}»; менять общий режим из панели сессии нельзя.` : permissionModeRead.permissionState.canSetMode ? "Среда не сообщила доступные режимы для этой сессии." : "Нативное управление режимом для этой сессии недоступно."}</small>}</> : <small>{permissionModeRead?.reason || "Нативное состояние режима недоступно для этой среды."}</small>}{permissionModeError && <small className="permission-mode-error">{permissionModeError}</small>}{permissionModeAttempts.some((attempt) => attempt.status === "unknown") && <small>Есть попытка с неизвестным исходом. Её inputId сохранён; автоматического повтора не будет.</small>}</section>{activeSession?.harness === "minimax-code" && activeSession.hostId && <MinimaxExecPolicyPanel key={`${activeSession.hostId}/${activeSession.id}`} session={activeSession} />}<SessionInspectBlock facts={sessionFacts} pendingModel={selectedModel} /><SessionActivityPanel messages={details?.messages} /><SessionMetadata sessionId={activeSession.id} harness={activeSession.harness} />{activeSession.messageCount === 0 && <div className="inspector-empty-metrics">Пока нет сообщений. Отправьте сообщение или продолжите сессию.</div>}<div className="inspector-actions">{visualizationUrl && <a className="quiet-button" href={visualizationUrl} target="_blank" rel="noreferrer" title="История сообщений и изменений файлов — в новой вкладке">Визуализация ↗</a>}{(activeSession.status === "running" || sending) && <button className="stop-button" onClick={() => void runAction("stop")}>Остановить</button>}{(!sending && activeSession.status !== "running" && (activeSession.status === "stopped" || activeSession.status === "error" || activeSession.meta?.humanStopHeld === true)) && <button className="primary-button" onClick={() => void runAction("resume")}>Возобновить работу</button>}{activeSession.status === "error" && <button className="quiet-button" onClick={() => void runAction("recover")}>Восстановить</button>}</div></> : <div className="empty-inspector">{emptyInspectorText(activeKey, detailsError)}</div>}</aside></>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
