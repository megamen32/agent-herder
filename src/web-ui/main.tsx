import * as React from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { filterAndArrangeSessions, matchesSessionQuery, projectFor, sessionKey, type SessionListEntry, type SessionListSession, type SessionListSettings, type SessionListSort } from "./session-list.js";
import { QuotaPanel } from "./quota-panel.js";
import "./styles.css";

type HerderSession = SessionListSession & {
  lastMessage?: string;
  model?: string;
  needsPermission?: boolean;
  messageCount?: number;
  durationSec?: number;
  costUsd?: number;
};
type SessionPart = { type: "text" | "thinking" | "tool_call" | "tool_result"; text?: string; name?: string; input?: unknown; output?: string; error?: boolean };
type SessionMessage = { id: string; role: "user" | "assistant" | "tool" | "system"; timestamp?: string; text?: string; parts: SessionPart[] };
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
type WebSessionRuntimeSettings = { version: number; enabled: boolean; pinActiveSessions?: boolean; rolloverExpiredCache?: boolean; movePinnedOnRollover?: boolean; inventoryWindowHours: number; evidenceMessageCount: number; watchdogEnabled?: boolean; watchdogIntervalSeconds?: number; stalledTurnMinutes?: number; judgeModel: string; autopilotJudgeModel: string; source: "persisted" | "default" };
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

const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
};
const keyOf = sessionKey;
const splitKey = (key: string) => {
  const separator = key.indexOf(":");
  return { harness: key.slice(0, separator), id: key.slice(separator + 1) };
};

// deep link: #/session/<harness>:<id> — восстанавливает выбор сессии из URL
const readSessionFromHash = (): string | undefined => {
  const match = window.location.hash.match(/^#\/session\/(.+)$/);
  if (!match) return undefined;
  return decodeURIComponent(match[1]);
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
  if (ageMs < minute) return "now";
  if (ageMs < hour) return `${Math.floor(ageMs / minute)}m`;
  if (ageMs < day) return `${Math.floor(ageMs / hour)}h`;
  return `${Math.floor(ageMs / day)}d`;
};
const displayStatus = (status: string) => status.replace("needs_input", "needs input");
const formatDuration = (seconds?: number) => {
  if (!Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds as number));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m ${total % 60}s`;
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
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(seconds < 600 ? 1 : 0)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
};
const formatStatCount = (value: number) => new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
const formatPercent = (value: number) => `${value.toFixed(value >= 10 ? 0 : 1)}%`;
const coverageFor = (distribution: StatisticsDistribution, seconds: number) => distribution.coverage.find((item) => item.seconds === seconds)?.percent || 0;

function StatisticsView({ statistics, loading, error, days, onDays, onRefresh }: {
  statistics?: AgentActivityStatistics; loading: boolean; error?: string; days: number; onDays: (days: number) => void; onRefresh: () => void;
}) {
  if (loading && !statistics) return <div className="statistics-loading"><div className="session-loading-orbit"><span /><span /><span /></div><strong>Analyzing agent activity…</strong><small>Scanning recent Codex transcripts once; results are cached on disk for an hour.</small></div>;
  if (!statistics) return <div className="statistics-loading"><strong>Statistics unavailable</strong><small>{error || "No activity data yet."}</small><button className="quiet-button" onClick={onRefresh}>Retry</button></div>;
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
      <div><span className="eyebrow">AGENT ACTIVITY</span><h2>Statistics</h2><p>Measured from real coding sessions, not synthetic benchmarks. Current high-confidence write signal: explicit Codex <code>apply_patch</code> paths.</p></div>
      <div className="statistics-controls"><div className="statistics-range">{[7, 30, 90].map((value) => <button className={days === value ? "active" : ""} key={value} onClick={() => onDays(value)}>{value}d</button>)}</div><button className="quiet-button" disabled={loading} onClick={onRefresh}>{loading ? "Refreshing…" : "Refresh"}</button></div>
    </div>
    {error && <div className="statistics-warning">Last refresh failed: {error}</div>}
    <div className="statistics-cards">
      <article><span>Sessions sampled</span><strong>{formatStatCount(statistics.sample.sessionFiles)}</strong><small>{formatStatCount(statistics.sample.sessionsWithPatches)} with patches · {statistics.windowDays} days</small></article>
      <article><span>Write events</span><strong>{formatStatCount(statistics.sample.pathWriteEvents)}</strong><small>{formatStatCount(statistics.sample.patchCalls)} apply_patch calls</small></article>
      <article><span>Same-file revisits</span><strong>{formatStatCount(statistics.sameFileRevisits.count)}</strong><small>median {formatStatDuration(p.p50)} · p95 {formatStatDuration(p.p95)}</small></article>
      <article className="recommendation"><span>Suggested inactivity lease</span><strong>~{formatStatDuration(statistics.recommendation.inactivityLeaseSec)}</strong><small>tool-activity p95 {formatStatDuration(ap.p95)} · renewed while session stays active</small></article>
    </div>

    {portfolio && <div className="statistics-grid landscape-grid">
      <section className="statistics-panel">
        <div className="statistics-panel-head"><div><span className="eyebrow">HARNESS MIX</span><h3>What actually gets used</h3></div><small>{formatStatCount(portfolio.observedSessions)} sessions active in this window</small></div>
        <div className="ranked-bars">{portfolio.harnesses.map((item) => <div className="ranked-row" key={item.name}><b>{item.name}</b><div><span style={{ width: `${item.count / topHarnessMax * 100}%` }} /></div><em>{item.count} · {formatPercent(item.percent)}</em></div>)}</div>
      </section>
      <section className="statistics-panel">
        <div className="statistics-panel-head"><div><span className="eyebrow">MODEL MIX</span><h3>Most-used models</h3></div><small>known for {formatPercent(portfolio.modelCoveragePercent)} of recent sessions</small></div>
        <div className="ranked-bars model-bars">{portfolio.models.slice(0, 8).map((item) => <div className="ranked-row" key={item.name}><b title={item.name}>{item.name}</b><div><span style={{ width: `${item.count / topModelMax * 100}%` }} /></div><em>{item.count}</em></div>)}</div>
      </section>
    </div>}

    <div className="statistics-cards session-metric-cards">
      <article><span>Codex session span</span><strong>{formatStatDuration(deep.durationSec.median)}</strong><small>median · mean {formatStatDuration(deep.durationSec.mean)} · p95 {formatStatDuration(deep.durationSec.p95)}</small></article>
      <article><span>Codex tokens / session</span><strong>{formatStatCount(deep.tokens.median)}</strong><small>median · mean {formatStatCount(deep.tokens.mean)} · p95 {formatStatCount(deep.tokens.p95)}</small></article>
      <article><span>Token coverage</span><strong>{formatPercent(deep.tokenCoveragePercent)}</strong><small>{formatStatCount(deep.tokens.count)} of {formatStatCount(deep.sessions)} Codex sessions expose cumulative usage</small></article>
      <article><span>Portfolio token coverage</span><strong>{formatPercent(portfolio?.tokenCoveragePercent || 0)}</strong><small>all harnesses · sparse fields are excluded from averages</small></article>
    </div>

    <section className="statistics-panel">
      <div className="statistics-panel-head"><div><span className="eyebrow">SESSION VOLUME</span><h3>Codex sessions by day</h3></div><small>{statistics.windowDays}-day deep sample</small></div>
      <div className="daily-chart">{deep.sessionsByDay.map((item) => <div className="daily-column" key={item.day} title={`${item.day}: ${item.count} sessions`}><span style={{ height: `${Math.max(3, item.count / dayMax * 100)}%` }} /><b>{item.day.slice(5)}</b></div>)}</div>
    </section>

    <section className="statistics-panel">
      <div className="statistics-panel-head"><div><span className="eyebrow">LEASE COVERAGE</span><h3>What different TTLs actually cover</h3></div><small>Activity gap = next tool action. File revisit = next write to the same path.</small></div>
      <div className="coverage-legend"><span><i className="activity" />Next agent activity</span><span><i className="revisit" />Same-file revisit</span></div>
      <div className="coverage-chart">{thresholds.map((seconds) => { const activity = coverageFor(statistics.activityGaps, seconds); const revisit = coverageFor(statistics.sameFileRevisits, seconds); return <div className="coverage-row" key={seconds}><b>{formatStatDuration(seconds)}</b><div className="coverage-bars"><div className="coverage-bar activity" style={{ width: `${activity}%` }}><span>{activity.toFixed(1)}%</span></div><div className="coverage-bar revisit" style={{ width: `${revisit}%` }}><span>{revisit.toFixed(1)}%</span></div></div></div>; })}</div>
      <p className="statistics-explainer">A short lease can still be correct even though agents often return to the same file much later: reservations should stay alive from <em>session activity heartbeats</em>, not only from repeated writes to that file.</p>
    </section>

    <div className="statistics-grid">
      <section className="statistics-panel">
        <div className="statistics-panel-head"><div><span className="eyebrow">SAME FILE</span><h3>Write revisit distribution</h3></div><small>{formatStatCount(statistics.sameFileRevisits.count)} intervals</small></div>
        <div className="histogram">{statistics.sameFileRevisits.histogram.map((item) => <div className="histogram-column" key={item.label}><div className="histogram-value">{item.percent.toFixed(1)}%</div><div className="histogram-track"><span style={{ height: `${Math.max(3, item.percent / maxHistogram * 100)}%` }} /></div><b>{item.label}</b></div>)}</div>
      </section>
      <section className="statistics-panel">
        <div className="statistics-panel-head"><div><span className="eyebrow">PERCENTILES</span><h3>How long gaps get</h3></div></div>
        <div className="percentile-table"><div className="percentile-head"><span>Percentile</span><span>Any activity</span><span>Same file</span></div>{(["p50","p75","p90","p95","p99"] as const).map((key) => <div className="percentile-row" key={key}><b>{key.toUpperCase()}</b><span>{formatStatDuration(ap[key])}</span><span>{formatStatDuration(p[key])}</span></div>)}</div>
      </section>
    </div>

    <section className="statistics-panel statistics-method">
      <div><span className="eyebrow">METHOD</span><h3>What is being measured</h3></div>
      <p>{statistics.source.caveat} {portfolio?.caveat || ""}</p>
      <div className="method-facts"><span><b>{formatStatCount(statistics.sample.toolCalls)}</b> tool calls</span><span><b>{formatStatCount(statistics.activityGaps.count)}</b> activity intervals</span><span><b>{formatStatCount(statistics.sample.repeatedFileSeries)}</b> repeatedly edited files</span><span><b>{new Date(statistics.generatedAt).toLocaleTimeString()}</b> generated</span></div>
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
      <div><span className="eyebrow">CONTROL PLANE</span><h2>Jobs</h2><p>Long-running Agent Herder operations survive MCP reconnects. Completed history is persisted across service restarts.</p></div>
      <div className="jobs-summary"><span><b>{active}</b> active</span><span><b>{jobs.length}</b> retained</span>{failed > 0 && <span className="jobs-failed-count"><b>{failed}</b> failed/interrupted</span>}<button className="quiet-button" disabled={loading} onClick={onRefresh}>{loading ? "Refreshing…" : "Refresh"}</button></div>
    </div>
    {error && <div className="statistics-warning">Jobs refresh failed: {error}</div>}
    {loading && jobs.length === 0 && <div className="statistics-loading"><div className="session-loading-orbit"><span /><span /><span /></div><strong>Loading jobs…</strong></div>}
    {!loading && jobs.length === 0 && <div className="jobs-empty">No jobs yet. Background exports, conversions, browser work and reconciliation will appear here.</div>}
    <div className="jobs-list">{jobs.map((job) => {
      const cancellable = job.state === "queued" || job.state === "running" || job.state === "waiting";
      const progress = Math.max(0, Math.min(1, job.progress ?? (job.state === "completed" ? 1 : 0)));
      return <article className={`job-card job-${job.state}`} key={job.id}>
        <div className="job-head"><div><span className={`job-state job-state-${job.state}`}>{job.state}</span><strong>{job.kind}</strong></div><time title={new Date(job.updatedAt).toLocaleString()}>{formatSessionAge(job.updatedAt)}</time></div>
        <div className="job-progress"><span style={{ width: `${progress * 100}%` }} /></div>
        <div className="job-meta"><code>{job.id}</code>{job.ownerSessionId && <span>owner · <code>{job.ownerSessionId}</code></span>}<span>updated · {new Date(job.updatedAt).toLocaleString()}</span></div>
        {job.statusMessage && <p className="job-status-message">{job.statusMessage}</p>}
        {job.error && <div className="job-error">{job.error}</div>}
        {job.result !== undefined && <details className="job-result"><summary>Result</summary><pre>{JSON.stringify(job.result, null, 2)}</pre></details>}
        <div className="job-actions"><code>{job.resultRef}</code>{cancellable && <button className="danger-button" disabled={cancellingJobId === job.id} onClick={() => onCancel(job.id)}>{cancellingJobId === job.id ? "Cancelling…" : "Cancel"}</button>}</div>
      </article>;
    })}</div>
  </div></div>;
}

function Markdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>;
}

function MessageParts({ message, showReasoning, showTools }: { message: SessionMessage; showReasoning: boolean; showTools: boolean }) {
  const parts = message.parts.length > 0 ? message.parts : message.text ? [{ type: "text" as const, text: message.text }] : [];
  return <>
    {parts.map((part, index) => {
      const partKey = `${message.id}:${index}`;
      if (part.type === "text") return <div className="markdown-content" key={partKey}><Markdown>{part.text || ""}</Markdown></div>;
      if (part.type === "thinking") return showReasoning ? <details className="oc-disclosure" key={partKey}><summary>Reasoning</summary><pre>{part.text}</pre></details> : null;
      if (!showTools) return null;
      return <details className="oc-disclosure tool" key={partKey}><summary>{part.name || (part.type === "tool_call" ? "Tool call" : "Tool result")}</summary><pre>{part.output || (part.input ? JSON.stringify(part.input, null, 2) : "")}</pre></details>;
    })}
  </>;
}

function hasVisibleMessage(message: SessionMessage, showReasoning: boolean, showTools: boolean): boolean {
  const parts = message.parts.length > 0 ? message.parts : message.text ? [{ type: "text" as const, text: message.text }] : [];
  return parts.some((part) => part.type === "text" && Boolean(part.text?.trim())
    || part.type === "thinking" && showReasoning && Boolean(part.text?.trim())
    || (part.type === "tool_call" || part.type === "tool_result") && showTools);
}

function AutomationSettings({ section, state, draft, saving, error, saved, continuation, continuationSaving, continuationError, activeSession, sessionAutostart, sessionAutostartSaving, sessionAutostartError, runtimeDraft, runtimeSaving, runtimeSaved, runtimeError, modelOptions, onChange, onSave, onGlobalContinuationToggle, onContinuationToggle, onSessionAutostartToggle, onSessionAutostartInherit, onRuntimeChange, onRuntimeSave }: {
  section: "autocontinue" | "autopilot";
  state?: WebAutopilotPolicyState;
  draft?: WebAutopilotPolicy;
  saving: boolean;
  error?: string;
  saved: boolean;
  continuation: Partial<Record<"codex" | "zcode", WebSessionAutostartHarness>>;
  continuationSaving?: "codex" | "zcode";
  continuationError?: string;
  activeSession?: HerderSession;
  sessionAutostart?: WebSessionAutostart;
  sessionAutostartSaving: boolean;
  sessionAutostartError?: string;
  runtimeDraft?: WebSessionRuntimeSettings;
  runtimeSaving: boolean;
  runtimeSaved: boolean;
  runtimeError?: string;
  modelOptions: WebModelOption[];
  onChange: (next: WebAutopilotPolicy) => void;
  onSave: () => void;
  onGlobalContinuationToggle: () => void;
  onContinuationToggle: (harness: "codex" | "zcode") => void;
  onSessionAutostartToggle: () => void;
  onSessionAutostartInherit: () => void;
  onRuntimeChange: (next: WebSessionRuntimeSettings) => void;
  onRuntimeSave: () => void;
}) {
  if (section === "autocontinue") return <section className="global-autopilot-card" aria-label="Глобальные настройки автопродолжения">
    <div className="global-autopilot-head">
      <div><span className="eyebrow">АВТОПРОДОЛЖЕНИЕ</span><h3>Умное автопродолжение</h3><p>Находит оборванные задачи Codex и ZCode и продолжает их после отдельной проверки. Эта настройка не включает автопилот.</p></div>
      {runtimeDraft && <button className={`switch-control large ${runtimeDraft.enabled ? "enabled" : ""}`} role="switch" aria-checked={runtimeDraft.enabled} aria-label="Глобальное автопродолжение" disabled={runtimeSaving} onClick={onGlobalContinuationToggle}><span /></button>}
    </div>
    {runtimeDraft && <div className={`autopilot-state-banner ${runtimeDraft.enabled ? "enabled" : ""}`}><strong>{runtimeDraft.enabled ? "Автопродолжение включено" : "Автопродолжение выключено"}</strong><span>Это общий переключатель. Настройки для Codex, ZCode и активной сессии могут его переопределить; автопилот не изменяется.</span></div>}
    {runtimeDraft && <fieldset className="settings-group"><legend>Закрепление сессий</legend><label className="runtime-toggle-setting timeout-setting"><span><strong>Сразу закреплять активные сессии</strong><small>Сессия Codex или ZCode закрепляется при начале работы или успешном автопродолжении. Herder не снимает закрепление после завершения — снимите его сами после проверки результата.</small></span><input type="checkbox" checked={runtimeDraft.pinActiveSessions ?? true} onChange={(event) => onRuntimeChange({ ...runtimeDraft, pinActiveSessions: event.target.checked })} /></label></fieldset>}
    <fieldset className="settings-group"><legend>Умное автопродолжение каждые 10 минут</legend><div className="harness-grid">
      {(["codex", "zcode"] as const).map((harness) => {
        const setting = continuation[harness];
        const enabled = setting?.enabled ?? true;
        return <label className={`harness-option ${enabled ? "selected" : ""}`} key={`continuation-${harness}`}><input type="checkbox" checked={enabled} disabled={!setting || continuationSaving === harness} onChange={() => onContinuationToggle(harness)} /><span><strong>{AUTOPILOT_HARNESS_LABELS[harness]}</strong><small>{enabled ? "MiniMax проверяет оборванные задачи и продолжает их" : "Автопродолжение выключено"}</small></span></label>;
      })}
    </div><p className="settings-help">Автопродолжение работает независимо от автопилота: его настройки и состояние не изменяются.</p>{continuationError && <small className="autopilot-error">{continuationError}</small>}</fieldset>

    {activeSession && sessionAutostart && <fieldset className="settings-group session-autocontinue-setting"><legend>Активная сессия</legend><div className="autopilot-control"><div><span className="eyebrow">{activeSession.harness}</span><strong>{sessionAutostart.enabled ? "Автопродолжение включено" : "Автопродолжение выключено"}</strong><small>{sessionAutostart.source === "session" ? "Отдельная настройка этой сессии" : sessionAutostart.source === "harness" ? `Используется общая настройка для ${activeSession.harness}` : sessionAutostart.source === "global" ? "Используется общий переключатель" : "Значение по умолчанию"}</small>{sessionAutostart.source === "session" && <button className="inherit-button" disabled={sessionAutostartSaving} onClick={onSessionAutostartInherit}>Использовать общую настройку {activeSession.harness}</button>}</div><button className={`switch-control ${sessionAutostart.enabled ? "enabled" : ""}`} role="switch" aria-checked={sessionAutostart.enabled} aria-label={`Autocontinue unfinished session ${activeSession.id}`} disabled={sessionAutostartSaving} onClick={onSessionAutostartToggle}><span /></button></div>{sessionAutostartError && <small className="autopilot-error">{sessionAutostartError}</small>}</fieldset>}

    {runtimeDraft && <><fieldset className="settings-group"><legend>Если кэш продолжения устарел</legend><label className="runtime-toggle-setting timeout-setting"><span><strong>Продолжить задачу в новой сессии</strong><small>Herder подготовит краткое описание текущего состояния и сохранит ту же рабочую среду и модель. Переключение произойдёт, когда устареет кэш провайдера.</small></span><input type="checkbox" checked={runtimeDraft.rolloverExpiredCache ?? false} onChange={(event) => onRuntimeChange({ ...runtimeDraft, rolloverExpiredCache: event.target.checked })} /></label><label className="runtime-toggle-setting timeout-setting"><span><strong>Переносить закрепление на продолжение</strong><small>После успешной передачи задачи Herder сначала закрепит новую сессию Codex или ZCode, затем снимет закрепление со старых.</small></span><input type="checkbox" checked={runtimeDraft.movePinnedOnRollover ?? false} disabled={!(runtimeDraft.rolloverExpiredCache ?? false)} onChange={(event) => onRuntimeChange({ ...runtimeDraft, movePinnedOnRollover: event.target.checked })} /></label><details className="technical-note"><summary>Техническая подробность</summary><small>Срок жизни кэша провайдера также называют provider-cache TTL.</small></details></fieldset><fieldset className="settings-group"><legend>Контроль живости</legend><label className="runtime-toggle-setting timeout-setting"><span><strong>Срочно будить остановившиеся и зависшие сессии</strong><small>Фоновая проверка отдельно следит за процессом и текущим ответом. Если работа остановилась, задача сразу отправляется на смысловую перепроверку, не дожидаясь обычного срока кэша.</small></span><input type="checkbox" checked={runtimeDraft.watchdogEnabled ?? true} onChange={(event) => onRuntimeChange({ ...runtimeDraft, watchdogEnabled: event.target.checked })} /></label><div className="context-options runtime-settings-grid"><label><span><strong>Интервал проверки, секунд</strong></span><input type="number" min="5" max="300" value={runtimeDraft.watchdogIntervalSeconds ?? 10} onChange={(event) => onRuntimeChange({ ...runtimeDraft, watchdogIntervalSeconds: Math.min(300, Math.max(5, Number(event.target.value) || 10)) })} /></label><label><span><strong>Без прогресса, минут</strong></span><input type="number" min="1" max="120" value={runtimeDraft.stalledTurnMinutes ?? 2} onChange={(event) => onRuntimeChange({ ...runtimeDraft, stalledTurnMinutes: Math.min(120, Math.max(1, Number(event.target.value) || 2)) })} /></label></div></fieldset><details className="settings-group advanced-settings"><summary>Расширенные настройки поиска и модели</summary><div className="context-options runtime-settings-grid">
      <label><span><strong>Искать сессии за последние часы</strong><small>48 часов — текущий стандарт; применяется со следующей сверки без рестарта.</small></span><input type="number" min="1" max="2160" value={runtimeDraft.inventoryWindowHours} onChange={(event) => onRuntimeChange({ ...runtimeDraft, inventoryWindowHours: Math.max(1, Number(event.target.value) || 1) })} /></label>
      <label><span><strong>Сколько сообщений читать на сессию</strong><small>Первый запрос и свежий хвост сохраняются обязательно; общий пакет ограничен примерно 480 тыс. токенов, чтобы не упираться в потолок 512 тыс.</small></span><input type="number" min="2" max="200" value={runtimeDraft.evidenceMessageCount} onChange={(event) => onRuntimeChange({ ...runtimeDraft, evidenceMessageCount: Math.min(200, Math.max(2, Number(event.target.value) || 2)) })} /></label>
      <label><span><strong>Модель автопродолжения</strong><small>MiniMax подключён напрямую через совместимый API; выбранные смысловые сообщения передаются целиком.</small></span><input list="autocontinue-models" value={runtimeDraft.judgeModel} onChange={(event) => onRuntimeChange({ ...runtimeDraft, judgeModel: event.target.value })} /></label>
      <datalist id="autocontinue-models">{[...new Set([runtimeDraft.judgeModel, "MiniMax-M3.1-Flash-Preview", "MiniMax-M3", ...modelOptions.filter((item) => /minimax/i.test(item.model)).map((item) => item.model)])].map((model) => <option value={model} key={`continue-${model}`} />)}</datalist>
    </div></details><div className="settings-save-row"><span>{runtimeError ? <small className="autopilot-error">{runtimeError}</small> : runtimeSaved ? <small className="settings-saved">Настройки автопродолжения сохранены</small> : <small>Расширенные параметры скрыты выше</small>}</span><button className="primary-button" disabled={runtimeSaving || !runtimeDraft.judgeModel.trim()} onClick={onRuntimeSave}>{runtimeSaving ? "Сохраняю…" : "Сохранить автопродолжение"}</button></div></>}
  </section>;

  if (!draft) return <section className="global-autopilot-card"><span className="settings-loading">Загрузка настроек автопилота…</span></section>;
  const timeoutMinutes = Math.max(1, Math.round(draft.timeout.delayMs / 60_000));
  const setHarness = (harness: AutopilotHarness, enabled: boolean) => onChange({
    ...draft,
    harnesses: enabled ? [...new Set([...draft.harnesses, harness])] : draft.harnesses.filter((item) => item !== harness),
  });
  const setCard = (key: keyof WebAutopilotPolicy["card"], enabled: boolean) => onChange({ ...draft, card: { ...draft.card, [key]: enabled } });
  return <section className="global-autopilot-card" aria-label="Глобальные настройки автопилота">
    <div className="global-autopilot-head">
      <div><span className="eyebrow">АВТОПИЛОТ</span><h3>Глобальный автопилот</h3><p>Автопилот решает: продолжить работу, завершить её или показать вам варианты. Эта настройка не включает автопродолжение.</p></div>
      <button className={`switch-control large ${draft.enabled ? "enabled" : ""}`} role="switch" aria-checked={draft.enabled} aria-label="Глобальный автопилот" onClick={() => onChange({ ...draft, enabled: !draft.enabled })}><span /></button>
    </div>
    <div className={`autopilot-state-banner ${draft.enabled ? "enabled" : ""}`}><strong>{draft.enabled ? "Автопилот включён" : "Автопилот выключен"}</strong><span>{draft.enabled ? "Работает в выбранных средах; настройки отдельных сессий могут переопределить режим." : "Новые завершения не оцениваются, кроме явно включённых сессий."}</span></div>

    {runtimeDraft && <fieldset className="settings-group"><legend>Модель автопилота</legend><div className="context-options runtime-settings-grid">
      <label><span><strong>Модель автопилота</strong><small>Можно выбрать модель из доступного списка или ввести её идентификатор вручную.</small></span><input list="all-herder-models" value={runtimeDraft.autopilotJudgeModel} onChange={(event) => onRuntimeChange({ ...runtimeDraft, autopilotJudgeModel: event.target.value })} /></label>
      <datalist id="all-herder-models">{[...new Set([runtimeDraft.autopilotJudgeModel, ...modelOptions.map((item) => item.model)])].map((model) => <option value={model} key={`autopilot-${model}`} />)}</datalist>
    </div><div className="settings-save-row"><span>{runtimeError ? <small className="autopilot-error">{runtimeError}</small> : runtimeSaved ? <small className="settings-saved">Модель автопилота сохранена</small> : <small>Доступно моделей: {modelOptions.length}</small>}</span><button className="primary-button" disabled={runtimeSaving || !runtimeDraft.autopilotJudgeModel.trim()} onClick={onRuntimeSave}>{runtimeSaving ? "Сохраняю…" : "Сохранить модель"}</button></div></fieldset>}

    <fieldset className="settings-group"><legend>Где работает</legend><div className="harness-grid">
      {(Object.keys(AUTOPILOT_HARNESS_LABELS) as AutopilotHarness[]).map((harness) => <label className={`harness-option ${draft.harnesses.includes(harness) ? "selected" : ""}`} key={harness}><input type="checkbox" checked={draft.harnesses.includes(harness)} onChange={(event) => setHarness(harness, event.target.checked)} /><span><strong>{AUTOPILOT_HARNESS_LABELS[harness]}</strong><small>{harness === "codex" ? "Контроль завершения Codex" : harness === "claude" ? "Интеграция Claude Code" : harness === "opencode" ? "Интеграция OpenCode" : harness === "zcode" ? "Встроенная интеграция ZCode" : "Интеграция Hermes"}</small></span></label>)}
    </div><p className="settings-help">Для одной сессии режим можно переопределить в её карточке справа.</p></fieldset>

    <fieldset className="settings-group"><legend>Если вы не ответили</legend><label className="timeout-setting"><input type="checkbox" checked={draft.timeout.mode === "auto_continue"} onChange={(event) => onChange({ ...draft, timeout: { ...draft.timeout, mode: event.target.checked ? "auto_continue" : "hold" } })} /><span><strong><span className="default-timeout-copy">30 минут без ответа</span>{timeoutMinutes !== 30 ? ` (сейчас ${timeoutMinutes})` : ""} → выбрать следующий шаг автоматически</strong><small>Будет выбран первый рекомендованный автопилотом вариант. Если выключить — сессия ждёт вас без таймера.</small></span></label><label className="minutes-control">Через <input type="number" min="1" max="10080" value={timeoutMinutes} disabled={draft.timeout.mode === "hold"} onChange={(event) => onChange({ ...draft, timeout: { ...draft.timeout, delayMs: Math.max(1, Number(event.target.value) || 1) * 60_000 } })} /> минут</label></fieldset>

    <fieldset className="settings-group"><legend>Что показывать в сообщении</legend><div className="context-options">
      <label><input type="checkbox" checked={draft.card.includeUserMessage} onChange={(event) => setCard("includeUserMessage", event.target.checked)} /> Последний запрос пользователя</label>
      <label><input type="checkbox" checked={draft.card.includeAssistantMessage} onChange={(event) => setCard("includeAssistantMessage", event.target.checked)} /> Последний ответ агента</label>
      <label><input type="checkbox" checked={draft.card.includeReason} onChange={(event) => setCard("includeReason", event.target.checked)} /> Почему нужен выбор</label>
    </div></fieldset>

    <div className="settings-save-row"><span>{error ? <small className="autopilot-error">{error}</small> : saved ? <small className="settings-saved">Настройки сохранены</small> : <small>{state?.source === "persisted" ? "Изменения ещё не сохранены" : "Рабочие настройки будут созданы при сохранении"}</small>}</span><button className="primary-button" disabled={saving} onClick={onSave}>{saving ? "Сохраняю…" : "Сохранить"}</button></div>
  </section>;
}

function SessionList({ entries, activeKey, loading, refreshing, settings, settingsOpen, searchOpen, searchQuery, options, choicesBySession, choosingRequestId, choiceError, collapsedChildren, onSearchChange, onSearchToggle, onSettingsChange, onSettingsToggle, onToggleChildren, onSelect, onChoose }: {
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
}) {
  return <nav className="sessions-pane" aria-label="Sessions">
    <div className="sessions-heading"><div><span className="eyebrow">AGENT HERDER</span><h1>Sessions {refreshing && <span className="inline-loading-dot" role="status" aria-label="Refreshing sessions" />}</h1></div><div className="sessions-heading-actions"><button className={`icon-button ${searchOpen ? "selected-icon" : ""}`} aria-label="Search sessions" aria-expanded={searchOpen} onClick={onSearchToggle}>⌕</button><button className={`icon-button ${settingsOpen ? "selected-icon" : ""}`} aria-label="Session settings" aria-expanded={settingsOpen} onClick={onSettingsToggle}>⚙</button></div></div>
    {searchOpen && <div className="session-search"><input autoFocus value={searchQuery} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search title, harness, CWD…" aria-label="Search session text" /></div>}
    {settingsOpen && <div className="session-settings" aria-label="Session list settings">
      <label>CWD<select value={settings.cwd} onChange={(event) => onSettingsChange({ cwd: event.target.value })}><option value="">All CWDs</option>{options.cwds.map((cwd) => <option value={cwd} key={cwd}>{cwd}</option>)}</select></label>
      <label>Project<select value={settings.project} onChange={(event) => onSettingsChange({ project: event.target.value })}><option value="">All projects</option>{options.projects.map((project) => <option value={project} key={project}>{project}</option>)}</select></label>
      <label>Harness<select value={settings.harness} onChange={(event) => onSettingsChange({ harness: event.target.value })}><option value="">All harnesses</option>{options.harnesses.map((harness) => <option value={harness} key={harness}>{harness}</option>)}</select></label>
      <label>Sort by<select value={settings.sort} onChange={(event) => onSettingsChange({ sort: event.target.value as SessionListSort })}><option value="activity">Recent activity</option><option value="status">Status</option><option value="harness">Harness</option><option value="title">Title</option><option value="cwd">CWD</option></select></label>
      <label className="session-toggle"><input type="checkbox" aria-label="Show all sessions" checked={settings.showAll} onChange={(event) => onSettingsChange({ showAll: event.target.checked })} /> Show completed sessions</label>
    </div>}
    <div className="session-list" role="list" aria-label="Sessions">
      {entries.map(({ session, depth, hasChildren }) => {
        const key = keyOf(session);
        const decision = choicesBySession.get(key);
        return <div className="session-row-wrap" role="listitem" style={{ marginLeft: `${depth * 14}px` }} key={key}>
          {hasChildren ? <button className="session-fold" aria-label={`Toggle child sessions for ${session.title || session.id}`} onClick={() => onToggleChildren(key)}>{collapsedChildren.has(key) ? "›" : "⌄"}</button> : <span className="session-fold-placeholder" />}
          <div className="session-card">
            <button className={`session-row ${key === activeKey ? "selected" : ""}`} onClick={() => onSelect(key)}>
              <span className={`status-dot ${decision ? "status-needs_input" : `status-${session.status}`}`} aria-hidden="true" />
              <span className="session-copy"><strong title={session.title || session.id}>{session.title || session.id}</strong><small>{session.harness} · {decision ? "нужен выбор" : displayStatus(session.status)}</small><small className="session-preview">{session.lastMessage || session.cwd}</small></span>
              <time title={new Date(session.lastActivity).toLocaleString()}>{formatSessionAge(session.lastActivity)}</time>
            </button>
            {decision && <div className="choice-card" aria-label={`Autopilot choices for ${session.title || session.id}`}>
              <strong>Что делать дальше?</strong>
              {decision.choices.map((choice) => <button className="choice-button" aria-label={`Choose ${choice.label}`} disabled={choosingRequestId === decision.requestId} key={choice.choiceId} onClick={() => onChoose(decision.requestId, choice.choiceId)}>{choice.label}</button>)}
              {choiceError?.requestId === decision.requestId && <small className="choice-error">{choiceError.message}</small>}
            </div>}
          </div>
        </div>;
      })}
      {loading && entries.length === 0 && <div className="session-skeletons" aria-label="Loading sessions">{Array.from({ length: 8 }, (_, index) => <div className="session-skeleton" key={index}><span /><div><b /><i /><i /></div></div>)}</div>}
      {!loading && entries.length === 0 && <div className="empty-list">No sessions match these settings.</div>}
    </div>
  </nav>;
}

function App() {
  const [sessions, setSessions] = React.useState<HerderSession[]>([]);
  const [activeKey, setActiveKey] = React.useState<string | undefined>(() => readSessionFromHash() ?? window.localStorage.getItem("agent-herder.active-session") ?? undefined);
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
  const [showInspector, setShowInspector] = React.useState(true);
  const [showStatistics, setShowStatistics] = React.useState(false);
  const [showJobs, setShowJobs] = React.useState(false);
  const [showQuota, setShowQuota] = React.useState(false);
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
  const [automationSettings, setAutomationSettings] = React.useState<"autocontinue" | "autopilot">();
  const [collapsedChildren, setCollapsedChildren] = React.useState<Set<string>>(new Set());
  const foldedInitialized = React.useRef(false);
  const [composer, setComposer] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [sessionsRefreshing, setSessionsRefreshing] = React.useState(false);
  const [sessionsTimingMs, setSessionsTimingMs] = React.useState<number>();
  const [latestTimingMs, setLatestTimingMs] = React.useState<number>();
  const [hydrateTimingMs, setHydrateTimingMs] = React.useState<number>();
  const initialSessionsStartedRef = React.useRef(performance.now());
  const [sending, setSending] = React.useState(false);
  const [showCreateSession, setShowCreateSession] = React.useState(false);
  const [createHarness, setCreateHarness] = React.useState("fast-agent");
  const [createAdapters, setCreateAdapters] = React.useState<Array<{ id: string; name: string; active: boolean; ready: boolean; status: string }>>([]);
  const [createCwd, setCreateCwd] = React.useState("/home/roomhacker");
  const [cwdSuggestions, setCwdSuggestions] = React.useState<Array<{ name: string; path: string }>>([]);
  const [cwdSuggestionsOpen, setCwdSuggestionsOpen] = React.useState(false);
  const [createModel, setCreateModel] = React.useState("generic.MiniMax-M3");
  const [createModels, setCreateModels] = React.useState<string[]>([]);
  const [createModelsRefreshing, setCreateModelsRefreshing] = React.useState(false);
  const createModelRequestRef = React.useRef(0);
  const [creatingSession, setCreatingSession] = React.useState(false);
  const [createSessionError, setCreateSessionError] = React.useState<string>();
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
        title: `Autopilot · ${choice.sessionId.slice(0, 12)}`,
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
      setActiveKey((current) => current && nextSessions.some((session) => keyOf(session) === current) ? current : undefined);
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
    setDetailsLoading(true);
    setDetailsHydrating(false);
    setLatestTimingMs(undefined);
    setHydrateTimingMs(undefined);
    setDetails((current) => current && keyOf(current.session) === key ? current : null);
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
  }, [activeKey, details?.messages.length, details?.children?.length, showReasoning, showTools]);

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
          watchdogEnabled: runtimeSettingsDraft.watchdogEnabled ?? true,
          watchdogIntervalSeconds: runtimeSettingsDraft.watchdogIntervalSeconds ?? 10,
          stalledTurnMinutes: runtimeSettingsDraft.stalledTurnMinutes ?? 2,
          judgeModel: runtimeSettingsDraft.judgeModel.trim(),
          autopilotJudgeModel: runtimeSettingsDraft.autopilotJudgeModel.trim(),
        }),
      });
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
      const models = Array.isArray(result.models) ? result.models : [];
      setCreateModels(models);
      setCreateModelsRefreshing(Boolean(result.refreshing));
      setCreateModel((current) => preferCurrent && current && models.includes(current) ? current : (models[0] || ""));
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
  const openCreateSession = async () => {
    const cwd = listSettings.cwd || activeSession?.cwd || "/home/roomhacker";
    setCreateCwd(cwd);
    setCreateSessionError(undefined);
    await loadCreateAdapters();
    await loadCreateModels(createHarness);
    setShowCreateSession(true);
    void loadCwdSuggestions(cwd.endsWith("/") ? cwd : `${cwd}/`);
  };
  const createNewSession = async () => {
    if (!createCwd.trim() || creatingSession) return;
    setCreatingSession(true);
    setCreateSessionError(undefined);
    const generatedName = `${createHarness.replace(/[^a-z0-9-]/gi, "-")}-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 12)}`;
    try {
      await api("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ harness: createHarness, name: generatedName, cwd: createCwd.trim(), model: createModel.trim() || undefined }),
      });
      setShowCreateSession(false);
      await new Promise((resolve) => window.setTimeout(resolve, createHarness === "fast-agent" || createHarness === "claude" ? 1400 : 350));
      await loadSessions();
      setListSettings((current) => ({ ...current, harness: createHarness, cwd: "", sort: "activity", showAll: true }));
      setMobileView("sessions");
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
    if (!activeKey) return;
    const { harness, id } = splitKey(activeKey);
    const result = await api<{ job?: HerderJob }>(`/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(id)}/${action}`, { method: "POST", body: JSON.stringify({}) });
    if (action === "recover" && result.job) {
      setShowJobs(true);
      setShowStatistics(false);
      await loadJobs();
      return;
    }
    await loadSessions();
    await loadDetails(activeKey);
  };
  const isResumeMode = activeSession?.status === "stopped" || activeSession?.status === "error";
  const readOnlySession = activeSession?.meta?.readOnly === true;
  const visualizationUrl = activeSession
    ? `/api/sessions/${encodeURIComponent(activeSession.harness)}/${encodeURIComponent(activeSession.id)}/visualization`
    : undefined;
  const latestMessage = details?.messages[details.messages.length - 1];
  const latestToolPart = [...(latestMessage?.parts || [])].reverse().find((part) => part.type === "tool_call" || part.type === "tool_result");
  const sessionActivity = sending
    ? { kind: "thinking", label: "Сообщение отправлено — ИИ начинает работу…" }
    : activeSession?.status === "running" && latestToolPart
      ? { kind: "tool", label: latestToolPart.name ? `ИИ использует инструмент: ${latestToolPart.name}` : "ИИ использует инструмент…" }
      : activeSession?.status === "running"
        ? { kind: "thinking", label: "ИИ думает…" }
        : activeSession?.status === "needs_input"
          ? { kind: "waiting", label: "ИИ ждёт вашего ответа" }
          : detailsLoading && activeSession
            ? { kind: "loading", label: "Обновляю состояние сессии…" }
            : undefined;
  const sendMessage = async () => {
    if (!activeKey || readOnlySession || !composer.trim() || sending) return;
    const { harness, id } = splitKey(activeKey);
    const text = composer.trim();
    setComposer(""); setSending(true); shouldFollowRef.current = true; setShowScrollToLatest(false);
    try { await api(`/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(id)}/message`, { method: "POST", body: JSON.stringify({ message: text, mode: "queue" }) }); await loadDetails(activeKey); } finally { setSending(false); }
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

  return <main className={`oc-app ${mobileView === "chat" ? "mobile-chat-active" : "mobile-sessions-active"} ${(!showInspector || showStatistics || showJobs || showQuota || automationSettings) ? "no-inspector" : ""}`}>
    <SessionList entries={visibleSessionEntries} activeKey={activeKey} loading={loading} refreshing={sessionsRefreshing && !loading} settings={listSettings} settingsOpen={showSessionSettings} searchOpen={showSessionSearch} searchQuery={sessionSearch} options={listOptions} choicesBySession={choicesBySession} choosingRequestId={choosingRequestId} choiceError={choiceError} collapsedChildren={collapsedChildren} onSearchChange={setSessionSearch} onSearchToggle={() => setShowSessionSearch((value) => !value)} onSettingsToggle={() => setShowSessionSettings((value) => !value)} onSettingsChange={(patch) => setListSettings((current) => ({ ...current, ...patch }))} onToggleChildren={(key) => setCollapsedChildren((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })} onChoose={(requestId, choiceId) => void chooseAutopilot(requestId, choiceId)} onSelect={(key) => { shouldFollowRef.current = true; setShowScrollToLatest(false); setShowStatistics(false); setShowJobs(false); selectSession(key); setMobileView("chat"); }} />
    <section className="chat-pane">
      <header className="chat-header">
        <button className="mobile-back" onClick={() => setMobileView("sessions")} aria-label="Back to sessions">← <span>Sessions</span></button>
        <div className="chat-heading">{showJobs ? <><span className="eyebrow">AGENT HERDER</span><h2>Jobs</h2><small>Persistent background work and progress</small></> : showStatistics ? <><span className="eyebrow">AGENT HERDER</span><h2>Statistics</h2><small>Real activity patterns from recent coding sessions</small></> : showQuota ? <><span className="eyebrow">AGENT HERDER</span><h2>Quota</h2><small>Codex окна, расход моделей, потребители</small></> : <><span className="eyebrow">{activeSession?.harness || "HERDER"}</span><h2>{activeSession?.title || (loading ? "Loading sessions…" : "Select a session")}{(detailsLoading || detailsHydrating) && <span className="inline-loading-dot chat-loading-dot" role="status" aria-label="Loading session" />}</h2><small>{activeSession?.cwd || ""}</small><div className="load-timings" role="status" aria-label="Browser load timings"><span title="Page → session list ready">sessions <b>{formatLoadTiming(sessionsTimingMs)}</b></span>{activeKey && <><span title="Newest turns request">latest <b>{detailsLoading ? "…" : formatLoadTiming(latestTimingMs)}</b></span><span title="Background history + metrics request">hydrate <b>{detailsHydrating ? "…" : formatLoadTiming(hydrateTimingMs)}</b></span></>}</div></>}</div>
        <div className="header-actions"><button className={`quiet-button ${showJobs ? "selected-icon" : ""}`} onClick={() => { setShowJobs((value) => !value); setShowStatistics(false); setAutomationSettings(undefined); setShowQuota(false); }}>Jobs{jobs.some((job) => job.state === "queued" || job.state === "running" || job.state === "waiting" || job.state === "cancelling") ? ` · ${jobs.filter((job) => job.state === "queued" || job.state === "running" || job.state === "waiting" || job.state === "cancelling").length}` : ""}</button><button className={`quiet-button ${showStatistics ? "selected-icon" : ""}`} onClick={() => { setShowJobs(false); setShowQuota(false); showStatistics ? setShowStatistics(false) : openStatistics(); }}>Statistics</button><button className={`quiet-button ${showQuota ? "selected-icon" : ""}`} onClick={() => { setShowJobs(false); setShowStatistics(false); setAutomationSettings(undefined); setShowQuota((value) => !value); }}>Quota</button>{!showStatistics && !showJobs && !showQuota && <><button className={`quiet-button automation-setting-button ${automationSettings === "autocontinue" ? "selected-icon" : ""}`} aria-label="Открыть настройки автопродолжения" onClick={() => { setAutomationSettings((value) => value === "autocontinue" ? undefined : "autocontinue"); setChatMenuOpen(false); }}>{`Автопродолжение · ${runtimeSettingsDraft?.enabled ? "вкл." : "выкл."}`}</button><button className={`quiet-button automation-setting-button ${automationSettings === "autopilot" ? "selected-icon" : ""}`} aria-label="Открыть настройки автопилота" onClick={() => { setAutomationSettings((value) => value === "autopilot" ? undefined : "autopilot"); setChatMenuOpen(false); }}>{`Автопилот · ${autopilotPolicyDraft?.enabled ? "вкл." : "выкл."}`}</button><button className="quiet-button" onClick={() => setShowInspector((value) => !value)}>{showInspector ? "Hide" : "Info"}</button></>}<button className={`quiet-button mobile-automation-button ${chatMenuOpen ? "selected-icon" : ""}`} aria-label="Открыть настройки автоматизации" onClick={() => setChatMenuOpen((value) => !value)}>Автоматизация</button><button className={`icon-button desktop-chat-menu ${chatMenuOpen ? "selected-icon" : ""}`} aria-label="Chat menu" aria-expanded={chatMenuOpen} onClick={() => setChatMenuOpen((value) => !value)}>···</button></div>
        {chatMenuOpen && <div className="chat-menu" role="menu"><label><input type="checkbox" checked={showReasoning} onChange={(event) => setShowReasoning(event.target.checked)} /> Reasoning</label><label><input type="checkbox" checked={showTools} onChange={(event) => setShowTools(event.target.checked)} /> Tools</label><button className="quiet-button" onClick={() => { setAutomationSettings("autocontinue"); setChatMenuOpen(false); }}>{`Автопродолжение: ${runtimeSettingsDraft?.enabled ? "включено" : "выключено"}`}</button><button className="quiet-button" onClick={() => { setAutomationSettings("autopilot"); setChatMenuOpen(false); }}>{`Автопилот: ${(autopilotSession?.enabled ?? autopilotPolicyDraft?.enabled) ? "включён" : "выключен"}`}</button><button className="quiet-button" onClick={() => { setShowInspector(true); setChatMenuOpen(false); }}>Session info</button><button className="quiet-button" onClick={() => { setShowJobs(true); setShowStatistics(false); setChatMenuOpen(false); }}>Jobs</button><button className="quiet-button" onClick={() => { setShowJobs(false); openStatistics(); }}>Statistics</button></div>}
      </header>
      {showJobs && <JobsView jobs={jobs} loading={jobsLoading} error={jobsError} cancellingJobId={cancellingJobId} onRefresh={() => void loadJobs()} onCancel={(jobId) => void cancelJob(jobId)} />}
      {showQuota && <QuotaPanel />}
      {showStatistics && <StatisticsView statistics={statistics} loading={statisticsLoading} error={statisticsError} days={statisticsDays} onDays={changeStatisticsDays} onRefresh={() => void loadStatistics(statisticsDays, true)} />}
      {!showStatistics && !showJobs && !showQuota && automationSettings && <div className="autopilot-settings-overlay"><div className="autopilot-settings-shell"><button className="settings-close" aria-label={`Закрыть настройки ${automationSettings === "autocontinue" ? "автопродолжения" : "автопилота"}`} onClick={() => setAutomationSettings(undefined)}>×</button><AutomationSettings section={automationSettings} state={autopilotPolicy} draft={autopilotPolicyDraft} saving={autopilotPolicySaving} error={autopilotPolicyError} saved={autopilotPolicySaved} continuation={continuationHarnesses} continuationSaving={continuationHarnessSaving} continuationError={continuationHarnessError} activeSession={activeSession} sessionAutostart={sessionAutostart} sessionAutostartSaving={sessionAutostartSaving} sessionAutostartError={sessionAutostartError} runtimeDraft={runtimeSettingsDraft} runtimeSaving={runtimeSettingsSaving} runtimeSaved={runtimeSettingsSaved} runtimeError={runtimeSettingsError} modelOptions={runtimeModelOptions} onChange={(next) => { setAutopilotPolicyDraft(next); setAutopilotPolicySaved(false); }} onSave={() => void saveAutopilotPolicy()} onGlobalContinuationToggle={() => void toggleGlobalContinuation()} onContinuationToggle={(harness) => void toggleContinuationHarness(harness)} onSessionAutostartToggle={() => void toggleSessionAutostart()} onSessionAutostartInherit={() => void inheritSessionAutostart()} onRuntimeChange={(next) => { setRuntimeSettingsDraft(next); setRuntimeSettingsSaved(false); }} onRuntimeSave={() => void saveRuntimeSettings()} /></div></div>}
      {!showStatistics && !showJobs && !showQuota && !!details?.children?.length && <details className="subagents-panel"><summary>Subagents <span>{details.children.length}</span></summary><div className="subagents-list">{details.children.map((child) => <button className="subagent-row" key={keyOf(child)} onClick={() => { selectSession(keyOf(child)); setMobileView("chat"); }}><span className={`status-dot status-${child.status}`} /><span><strong>{child.title || child.id}</strong><small>{typeof child.meta?.agentRole === "string" ? child.meta.agentRole : child.status} · {child.id}</small></span></button>)}</div></details>}
      {!showStatistics && !showJobs && !showQuota && <div className="chat-scroll" ref={chatScrollRef} onScroll={handleChatScroll}>
        <div className="message-column">
          {detailsLoading && !details && <div className="session-loading-chat" aria-live="polite"><div className="session-loading-orbit"><span /><span /><span /></div><strong>Loading latest activity</strong><small>Starting from the newest turns. You can keep using the rest of Agent Herder.</small></div>}
          {!detailsLoading && !details && <div className="empty-chat">{detailsError || "Choose a session to open its conversation."}</div>}
          {detailsHydrating && details && <div className="history-loading-banner"><span className="inline-loading-dot" /> Latest {formatLoadTiming(latestTimingMs)} · loading older history and metrics…</div>}
          {details?.messages.map((message) => hasVisibleMessage(message, showReasoning, showTools) && <article className={`message ${message.role}`} key={message.id}><div className="message-meta"><span>{message.role === "user" ? "You" : message.role === "tool" ? "Tool" : "Agent"}</span><time>{formatTime(message.timestamp || "")}</time></div><MessageParts message={message} showReasoning={showReasoning} showTools={showTools} /></article>)}
        </div>
      </div>}
      {!showStatistics && !showJobs && !showQuota && showScrollToLatest && <button className="scroll-latest" aria-label="Scroll to latest" onClick={scrollToBottom}>↓</button>}
      {!showStatistics && !showJobs && !showQuota && <div className="composer-stack">
      {sessionActivity && <div className={`agent-activity-strip activity-${sessionActivity.kind}`} role="status" aria-live="polite"><span className="agent-activity-dot" /><strong>{sessionActivity.label}</strong></div>}
      <form className="composer" onSubmit={(event) => { event.preventDefault(); if (isResumeMode) void runAction("resume"); else void sendMessage(); }}>
        {showCreateSession && <div className="composer-create-panel">
          <div className="composer-create-row">
            <label>Harness<select value={createHarness} onChange={(event) => { const harness = event.target.value; setCreateHarness(harness); setCreateModel(""); setCreateModels([]); void loadCreateModels(harness); }}>{(createAdapters.length ? createAdapters : [{ id: "fast-agent", name: "Fast Agent", active: true, ready: true, status: "active" }]).map((adapter) => <option key={adapter.id} value={adapter.id} disabled={!adapter.active}>{adapter.name}{adapter.active ? "" : ` · ${adapter.status}`}</option>)}</select></label>
            <label className="cwd-picker">CWD<input value={createCwd} onChange={(event) => { const value = event.target.value; setCreateCwd(value); void loadCwdSuggestions(value); }} onFocus={() => void loadCwdSuggestions(createCwd.endsWith("/") ? createCwd : `${createCwd}/`)} onBlur={() => window.setTimeout(() => setCwdSuggestionsOpen(false), 120)} placeholder="/home/roomhacker/project" autoComplete="off" />{cwdSuggestionsOpen && cwdSuggestions.length > 0 && <div className="cwd-suggestions">{cwdSuggestions.map((item) => <button type="button" key={item.path} onMouseDown={(event) => event.preventDefault()} onClick={() => { setCreateCwd(`${item.path}/`); void loadCwdSuggestions(`${item.path}/`); }}><span className="cwd-folder">▱</span><span>{item.name}</span><small>{item.path}</small></button>)}</div>}</label>
            <label>Model{createModels.length > 0 ? <select value={createModel} onChange={(event) => setCreateModel(event.target.value)}>{createModels.map((model) => <option key={model} value={model}>{model}</option>)}</select> : createModelsRefreshing ? <select disabled><option>loading models…</option></select> : <input value={createModel} onChange={(event) => setCreateModel(event.target.value)} placeholder="model (cache empty)" />}</label>
            <button type="button" className="primary-button composer-create-submit" disabled={creatingSession || !createCwd.trim()} onClick={() => void createNewSession()}>{creatingSession ? "…" : "Create"}</button>
          </div>
          {createSessionError && <div className="create-session-error">{createSessionError}</div>}
        </div>}
        <button type="button" className={`composer-plus ${showCreateSession ? "active" : ""}`} aria-label="New session" title="New Fast Agent / ZCode session" onClick={() => { if (showCreateSession) setShowCreateSession(false); else void openCreateSession(); }}>+</button>
        {readOnlySession ? <div className="composer-readonly"><strong>Архивная сессия</strong><span>Здесь доступен только просмотр. Продолжение запускается через Fast Agent.</span></div> : <>
          <textarea value={composer} onChange={(event) => setComposer(event.target.value)} placeholder={isResumeMode ? "Resume the agent…" : activeKey ? "Message the agent…" : "Choose a session first"} disabled={!activeKey || sending || isResumeMode} onKeyDown={(event) => { if (!isResumeMode && event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} />
          <span className="composer-hint">{sending ? "Waiting for agent…" : isResumeMode ? "Resume this session" : "Enter to send · Shift+Enter for a new line"}</span>
          <button className="send-button" type={isResumeMode ? "button" : "submit"} onClick={isResumeMode ? () => void runAction("resume") : undefined} disabled={!activeKey || sending || (!isResumeMode && !composer.trim())} aria-label={isResumeMode ? "Resume session" : "Send message"}>{isResumeMode ? "▶" : "↑"}</button>
        </>}
      </form></div>}
    </section>
    {showInspector && !showStatistics && !showJobs && <aside className="inspector-pane"><div className="inspector-heading"><span className="eyebrow">SESSION</span><button className="icon-button" onClick={() => setShowInspector(false)} aria-label="Close inspector">×</button></div>{activeSession ? <><div className="inspector-title">{activeSession.title}</div><div className="inspector-status"><span className={`status-dot status-${activeSession.status}`} />{displayStatus(activeSession.status)}</div>{autopilotSession && <div className="autopilot-control"><div><span className="eyebrow">AUTOPILOT</span><strong>{autopilotSession.enabled ? "Включён" : "Выключен"}</strong><small>{autopilotSession.source === "session" ? "Отдельная настройка этой сессии" : autopilotSession.source === "policy" ? "Используется общая настройка автопилота" : autopilotSession.source === "plugin-default" ? "Настройка по умолчанию для этой среды" : "По умолчанию выключен"}</small>{autopilotSession.source === "session" && <button className="inherit-button" disabled={autopilotSessionSaving} onClick={() => void inheritAutopilotSession()}>Использовать общую настройку</button>}</div><button className={`switch-control ${autopilotSession.enabled ? "enabled" : ""}`} role="switch" aria-checked={autopilotSession.enabled} aria-label={`Autopilot for ${activeSession.id}`} disabled={autopilotSessionSaving} onClick={() => void toggleAutopilotSession()}><span /></button></div>}{autopilotSessionError && <small className="autopilot-error">{autopilotSessionError}</small>}<dl><dt>Harness</dt><dd>{activeSession.harness}</dd><dt>Working directory</dt><dd>{activeSession.cwd}</dd>{activeSession.model && <><dt>Model</dt><dd>{activeSession.model}</dd></>}{activeSession.messageCount !== undefined && <><dt>Messages</dt><dd>{activeSession.messageCount}</dd></>}{activeSession.durationSec !== undefined && <><dt>Duration</dt><dd>{formatDuration(activeSession.durationSec)}</dd></>}{activeSession.costUsd !== undefined && <><dt>Cost</dt><dd title={activeSession.meta?.pricing_source === "models.dev" ? `Estimated from models.dev · ${String(activeSession.meta?.pricing_provider || "")}/${String(activeSession.meta?.pricing_model || "")}` : undefined}>{`${activeSession.meta?.pricing_kind === "estimate" ? "~" : ""}$${activeSession.costUsd.toFixed(4)}`}</dd></>}{metaNumber(activeSession, ["total_tokens", "totalTokens", "tokens"]) !== undefined && <><dt>Tokens</dt><dd>{metaNumber(activeSession, ["total_tokens", "totalTokens", "tokens"])}</dd></>}<dt>Subagents</dt><dd>{details?.children?.length || 0}</dd></dl>{activeSession.messageCount === 0 && <div className="inspector-empty-metrics">No turns yet. Send a message or Resume to start this session.</div>}<div className="inspector-actions">{visualizationUrl && <a className="quiet-button" href={visualizationUrl} target="_blank" rel="noreferrer">Visualize</a>}{activeSession.status === "running" && <button className="danger-button" onClick={() => void runAction("stop")}>Stop</button>}{(activeSession.status === "stopped" || activeSession.status === "error") && <button className="primary-button" onClick={() => void runAction("resume")}>Resume</button>}{activeSession.status === "error" && <button className="quiet-button" onClick={() => void runAction("recover")}>Recover</button>}</div><div className="settings-block"><span className="eyebrow">VIEW</span><label><input type="checkbox" checked={showReasoning} onChange={(event) => setShowReasoning(event.target.checked)} /> Reasoning</label><label><input type="checkbox" checked={showTools} onChange={(event) => setShowTools(event.target.checked)} /> Tools</label></div></> : <div className="empty-inspector">No session selected.</div>}</aside>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
