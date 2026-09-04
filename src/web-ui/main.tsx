import * as React from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { filterAndArrangeSessions, matchesSessionQuery, projectFor, sessionKey, type SessionListEntry, type SessionListSession, type SessionListSettings, type SessionListSort } from "./session-list.js";
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
const formatTime = (value: string) => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(timestamp) : "";
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

function AutopilotSettings({ state, draft, saving, error, saved, onChange, onSave }: {
  state?: WebAutopilotPolicyState;
  draft?: WebAutopilotPolicy;
  saving: boolean;
  error?: string;
  saved: boolean;
  onChange: (next: WebAutopilotPolicy) => void;
  onSave: () => void;
}) {
  if (!draft) return <section className="global-autopilot-card"><span className="settings-loading">Загрузка runtime-настроек…</span></section>;
  const timeoutMinutes = Math.max(1, Math.round(draft.timeout.delayMs / 60_000));
  const setHarness = (harness: AutopilotHarness, enabled: boolean) => onChange({
    ...draft,
    harnesses: enabled ? [...new Set([...draft.harnesses, harness])] : draft.harnesses.filter((item) => item !== harness),
  });
  const setCard = (key: keyof WebAutopilotPolicy["card"], enabled: boolean) => onChange({ ...draft, card: { ...draft.card, [key]: enabled } });
  return <section className="global-autopilot-card" aria-label="Глобальные настройки автопилота">
    <div className="global-autopilot-head">
      <div><span className="eyebrow">RUNTIME</span><h3>Глобальный автопилот</h3><p>Judge решает: продолжить работу, завершить её или показать вам варианты.</p></div>
      <button className={`switch-control large ${draft.enabled ? "enabled" : ""}`} role="switch" aria-checked={draft.enabled} aria-label="Глобальный автопилот" onClick={() => onChange({ ...draft, enabled: !draft.enabled })}><span /></button>
    </div>
    <div className={`autopilot-state-banner ${draft.enabled ? "enabled" : ""}`}><strong>{draft.enabled ? "Автопилот включён" : "Автопилот выключен"}</strong><span>{draft.enabled ? "Работает в выбранных harness’ах; настройки отдельных сессий могут переопределить режим." : "Новые завершения не оцениваются, кроме явно включённых сессий."}</span></div>

    <fieldset className="settings-group"><legend>Где работает</legend><div className="harness-grid">
      {(Object.keys(AUTOPILOT_HARNESS_LABELS) as AutopilotHarness[]).map((harness) => <label className={`harness-option ${draft.harnesses.includes(harness) ? "selected" : ""}`} key={harness}><input type="checkbox" checked={draft.harnesses.includes(harness)} onChange={(event) => setHarness(harness, event.target.checked)} /><span><strong>{AUTOPILOT_HARNESS_LABELS[harness]}</strong><small>{harness === "codex" ? "Codex Stop hook" : harness === "claude" ? "Claude Code plugin" : harness === "opencode" ? "OpenCode plugin" : harness === "zcode" ? "ZCode native plugin" : "Hermes plugin"}</small></span></label>)}
    </div><p className="settings-help">Для одной сессии режим можно переопределить в её карточке справа.</p></fieldset>

    <fieldset className="settings-group"><legend>Если вы не ответили</legend><label className="timeout-setting"><input type="checkbox" checked={draft.timeout.mode === "auto_continue"} onChange={(event) => onChange({ ...draft, timeout: { ...draft.timeout, mode: event.target.checked ? "auto_continue" : "hold" } })} /><span><strong><span className="default-timeout-copy">30 минут без ответа</span>{timeoutMinutes !== 30 ? ` (сейчас ${timeoutMinutes})` : ""} → выбрать следующий шаг автоматически</strong><small>Будет выбран первый рекомендованный Judge вариант. Если выключить — сессия ждёт вас без таймера.</small></span></label><label className="minutes-control">Через <input type="number" min="1" max="10080" value={timeoutMinutes} disabled={draft.timeout.mode === "hold"} onChange={(event) => onChange({ ...draft, timeout: { ...draft.timeout, delayMs: Math.max(1, Number(event.target.value) || 1) * 60_000 } })} /> минут</label></fieldset>

    <fieldset className="settings-group"><legend>Что показывать в сообщении</legend><div className="context-options">
      <label><input type="checkbox" checked={draft.card.includeUserMessage} onChange={(event) => setCard("includeUserMessage", event.target.checked)} /> Последний запрос пользователя</label>
      <label><input type="checkbox" checked={draft.card.includeAssistantMessage} onChange={(event) => setCard("includeAssistantMessage", event.target.checked)} /> Последний ответ агента</label>
      <label><input type="checkbox" checked={draft.card.includeReason} onChange={(event) => setCard("includeReason", event.target.checked)} /> Почему нужен выбор</label>
    </div></fieldset>

    <div className="settings-save-row"><span>{error ? <small className="autopilot-error">{error}</small> : saved ? <small className="settings-saved">Настройки сохранены</small> : <small>{state?.source === "persisted" ? "Изменения ещё не сохранены" : "Будет создана runtime policy"}</small>}</span><button className="primary-button" disabled={saving} onClick={onSave}>{saving ? "Сохраняю…" : "Сохранить"}</button></div>
  </section>;
}

function SessionList({ entries, activeKey, settings, settingsOpen, searchOpen, searchQuery, options, choicesBySession, choosingRequestId, choiceError, collapsedChildren, onSearchChange, onSearchToggle, onSettingsChange, onSettingsToggle, onToggleChildren, onSelect, onChoose }: {
  entries: SessionListEntry[];
  activeKey?: string;
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
  return <aside className="sessions-pane">
    <div className="sessions-heading"><div><span className="eyebrow">AGENT HERDER</span><h1>Sessions</h1></div><div className="sessions-heading-actions"><button className={`icon-button ${searchOpen ? "selected-icon" : ""}`} aria-label="Search sessions" aria-expanded={searchOpen} onClick={onSearchToggle}>⌕</button><button className={`icon-button ${settingsOpen ? "selected-icon" : ""}`} aria-label="Session settings" aria-expanded={settingsOpen} onClick={onSettingsToggle}>⚙</button></div></div>
    {searchOpen && <div className="session-search"><input autoFocus value={searchQuery} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search title, harness, CWD…" aria-label="Search session text" /></div>}
    {settingsOpen && <div className="session-settings" aria-label="Session list settings">
      <label>CWD<select value={settings.cwd} onChange={(event) => onSettingsChange({ cwd: event.target.value })}><option value="">All CWDs</option>{options.cwds.map((cwd) => <option value={cwd} key={cwd}>{cwd}</option>)}</select></label>
      <label>Project<select value={settings.project} onChange={(event) => onSettingsChange({ project: event.target.value })}><option value="">All projects</option>{options.projects.map((project) => <option value={project} key={project}>{project}</option>)}</select></label>
      <label>Harness<select value={settings.harness} onChange={(event) => onSettingsChange({ harness: event.target.value })}><option value="">All harnesses</option>{options.harnesses.map((harness) => <option value={harness} key={harness}>{harness}</option>)}</select></label>
      <label>Sort by<select value={settings.sort} onChange={(event) => onSettingsChange({ sort: event.target.value as SessionListSort })}><option value="activity">Recent activity</option><option value="status">Status</option><option value="harness">Harness</option><option value="title">Title</option><option value="cwd">CWD</option></select></label>
      <label className="session-toggle"><input type="checkbox" aria-label="Show all sessions" checked={settings.showAll} onChange={(event) => onSettingsChange({ showAll: event.target.checked })} /> Show completed sessions</label>
    </div>}
    <div className="session-list" aria-label="Sessions">
      {entries.map(({ session, depth, hasChildren }) => {
        const key = keyOf(session);
        const decision = choicesBySession.get(key);
        return <div className="session-row-wrap" style={{ marginLeft: `${depth * 14}px` }} key={key}>
          {hasChildren ? <button className="session-fold" aria-label={`Toggle child sessions for ${session.title || session.id}`} onClick={() => onToggleChildren(key)}>{collapsedChildren.has(key) ? "›" : "⌄"}</button> : <span className="session-fold-placeholder" />}
          <div className="session-card">
            <button className={`session-row ${key === activeKey ? "selected" : ""}`} onClick={() => onSelect(key)}>
              <span className={`status-dot ${decision ? "status-needs_input" : `status-${session.status}`}`} aria-hidden="true" />
              <span className="session-copy"><strong>{session.title || session.id}</strong><small>{session.harness} · {decision ? "нужен выбор" : displayStatus(session.status)}</small><small className="session-preview">{session.lastMessage || session.cwd}</small></span>
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
      {entries.length === 0 && <div className="empty-list">No sessions match these settings.</div>}
    </div>
  </aside>;
}

function App() {
  const [sessions, setSessions] = React.useState<HerderSession[]>([]);
  const [activeKey, setActiveKey] = React.useState<string>();
  const [details, setDetails] = React.useState<SessionDetails | null>(null);
  const [mobileView, setMobileView] = React.useState<"sessions" | "chat">("sessions");
  const [showReasoning, setShowReasoning] = React.useState(false);
  const [showTools, setShowTools] = React.useState(false);
  const [showInspector, setShowInspector] = React.useState(true);
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
  const [autopilotPolicy, setAutopilotPolicy] = React.useState<WebAutopilotPolicyState>();
  const [autopilotPolicyDraft, setAutopilotPolicyDraft] = React.useState<WebAutopilotPolicy>();
  const [autopilotPolicySaving, setAutopilotPolicySaving] = React.useState(false);
  const [autopilotPolicyError, setAutopilotPolicyError] = React.useState<string>();
  const [autopilotPolicySaved, setAutopilotPolicySaved] = React.useState(false);
  const [showAutopilotSettings, setShowAutopilotSettings] = React.useState(false);
  const [collapsedChildren, setCollapsedChildren] = React.useState<Set<string>>(new Set());
  const foldedInitialized = React.useRef(false);
  const [composer, setComposer] = React.useState("");
  const [loading, setLoading] = React.useState(true);
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

  const loadSessions = React.useCallback(async () => {
    const [result, choiceResult] = await Promise.all([
      api<{ sessions: HerderSession[] }>("/api/sessions"),
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
    setActiveKey((current) => current && nextSessions.some((session) => keyOf(session) === current) ? current : undefined);
  }, []);
  React.useEffect(() => { void loadSessions().finally(() => setLoading(false)); const timer = window.setInterval(() => void loadSessions(), 3000); return () => window.clearInterval(timer); }, [loadSessions]);
  const loadAutopilotPolicy = React.useCallback(async () => {
    const state = await api<WebAutopilotPolicyState>("/api/autopilot/policy");
    setAutopilotPolicy(state);
    setAutopilotPolicyDraft(state.policy);
    setAutopilotPolicyError(state.error);
  }, []);
  React.useEffect(() => { void loadAutopilotPolicy().catch((error) => setAutopilotPolicyError((error as Error).message)); }, [loadAutopilotPolicy]);

  const loadDetails = React.useCallback(async (key: string) => {
    const { harness, id } = splitKey(key);
    const next = await api<SessionDetails>(`/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(id)}/details?limit=100`);
    setDetails(next);
  }, []);
  React.useEffect(() => { if (!activeKey) { setDetails(null); return; } void loadDetails(activeKey); }, [activeKey, loadDetails]);
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

  const activeSession = sessions.find((session) => keyOf(session) === activeKey) || details?.session;
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
    if (activeKey && visibleSessionEntries.some(({ session }) => keyOf(session) === activeKey)) return;
    setActiveKey(visibleSessionEntries[0] ? keyOf(visibleSessionEntries[0].session) : undefined);
  }, [activeKey, visibleSessionEntries]);
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

  const runAction = async (action: "resume" | "stop" | "recover") => {
    if (!activeKey) return;
    const { harness, id } = splitKey(activeKey);
    await api(`/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(id)}/${action}`, { method: "POST", body: JSON.stringify({}) });
    await loadSessions();
    await loadDetails(activeKey);
  };
  const isResumeMode = activeSession?.status === "stopped" || activeSession?.status === "error";
  const readOnlySession = activeSession?.meta?.readOnly === true;
  const visualizationUrl = activeSession
    ? `/api/sessions/${encodeURIComponent(activeSession.harness)}/${encodeURIComponent(activeSession.id)}/visualization`
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

  if (loading) return <main className="oc-app"><div className="oc-loading">Loading sessions…</div></main>;
  return <main className={`oc-app ${mobileView === "chat" ? "mobile-chat-active" : "mobile-sessions-active"}`}>
    <SessionList entries={visibleSessionEntries} activeKey={activeKey} settings={listSettings} settingsOpen={showSessionSettings} searchOpen={showSessionSearch} searchQuery={sessionSearch} options={listOptions} choicesBySession={choicesBySession} choosingRequestId={choosingRequestId} choiceError={choiceError} collapsedChildren={collapsedChildren} onSearchChange={setSessionSearch} onSearchToggle={() => setShowSessionSearch((value) => !value)} onSettingsToggle={() => setShowSessionSettings((value) => !value)} onSettingsChange={(patch) => setListSettings((current) => ({ ...current, ...patch }))} onToggleChildren={(key) => setCollapsedChildren((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })} onChoose={(requestId, choiceId) => void chooseAutopilot(requestId, choiceId)} onSelect={(key) => { shouldFollowRef.current = true; setShowScrollToLatest(false); setActiveKey(key); setMobileView("chat"); }} />
    <section className="chat-pane">
      <header className="chat-header">
        <button className="mobile-back" onClick={() => setMobileView("sessions")} aria-label="Back to sessions">← <span>Sessions</span></button>
        <div className="chat-heading"><span className="eyebrow">{activeSession?.harness || "HERDER"}</span><h2>{activeSession?.title || "Select a session"}</h2><small>{activeSession?.cwd || ""}</small></div>
        <div className="header-actions"><button className={`quiet-button ${showAutopilotSettings ? "selected-icon" : ""}`} onClick={() => { setShowAutopilotSettings((value) => !value); setChatMenuOpen(false); }}>Autopilot</button><button className="quiet-button" onClick={() => setShowInspector((value) => !value)}>{showInspector ? "Hide" : "Info"}</button><button className={`icon-button ${chatMenuOpen ? "selected-icon" : ""}`} aria-label="Chat menu" aria-expanded={chatMenuOpen} onClick={() => setChatMenuOpen((value) => !value)}>···</button></div>
        {chatMenuOpen && <div className="chat-menu" role="menu"><label><input type="checkbox" checked={showReasoning} onChange={(event) => setShowReasoning(event.target.checked)} /> Reasoning</label><label><input type="checkbox" checked={showTools} onChange={(event) => setShowTools(event.target.checked)} /> Tools</label><button className="quiet-button" onClick={() => { setShowAutopilotSettings(true); setChatMenuOpen(false); }}>Настройки автопилота</button><button className="quiet-button" onClick={() => { setShowInspector(true); setChatMenuOpen(false); }}>Session info</button></div>}
      </header>
      {showAutopilotSettings && <div className="autopilot-settings-overlay"><div className="autopilot-settings-shell"><button className="settings-close" aria-label="Закрыть настройки автопилота" onClick={() => setShowAutopilotSettings(false)}>×</button><AutopilotSettings state={autopilotPolicy} draft={autopilotPolicyDraft} saving={autopilotPolicySaving} error={autopilotPolicyError} saved={autopilotPolicySaved} onChange={(next) => { setAutopilotPolicyDraft(next); setAutopilotPolicySaved(false); }} onSave={() => void saveAutopilotPolicy()} /></div></div>}
      {!!details?.children?.length && <details className="subagents-panel"><summary>Subagents <span>{details.children.length}</span></summary><div className="subagents-list">{details.children.map((child) => <button className="subagent-row" key={keyOf(child)} onClick={() => { setActiveKey(keyOf(child)); setMobileView("chat"); }}><span className={`status-dot status-${child.status}`} /><span><strong>{child.title || child.id}</strong><small>{typeof child.meta?.agentRole === "string" ? child.meta.agentRole : child.status} · {child.id}</small></span></button>)}</div></details>}
      <div className="chat-scroll" ref={chatScrollRef} onScroll={handleChatScroll}>
        <div className="message-column">
          {!details && <div className="empty-chat">Choose a session to open its conversation.</div>}
          {details?.messages.map((message) => hasVisibleMessage(message, showReasoning, showTools) && <article className={`message ${message.role}`} key={message.id}><div className="message-meta"><span>{message.role === "user" ? "You" : message.role === "tool" ? "Tool" : "Agent"}</span><time>{formatTime(message.timestamp || "")}</time></div><MessageParts message={message} showReasoning={showReasoning} showTools={showTools} /></article>)}
        </div>
      </div>
      {showScrollToLatest && <button className="scroll-latest" aria-label="Scroll to latest" onClick={scrollToBottom}>↓</button>}
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
        <textarea value={composer} onChange={(event) => setComposer(event.target.value)} placeholder={readOnlySession ? "Read-only persisted session" : isResumeMode ? "Resume the agent…" : activeKey ? "Message the agent…" : "Choose a session first"} disabled={!activeKey || readOnlySession || sending || isResumeMode} onKeyDown={(event) => { if (!isResumeMode && event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} />
        <span className="composer-hint">{sending ? "Waiting for agent…" : readOnlySession ? "Viewing persisted transcript · controls stay with fast-agent" : isResumeMode ? "Resume this session" : "Enter to send · Shift+Enter for a new line"}</span>
        <button className="send-button" type={isResumeMode ? "button" : "submit"} onClick={isResumeMode ? () => void runAction("resume") : undefined} disabled={!activeKey || readOnlySession || sending || (!isResumeMode && !composer.trim())} aria-label={isResumeMode ? "Resume session" : "Send message"}>{isResumeMode ? "▶" : "↑"}</button>
      </form>
    </section>
    {showInspector && <aside className="inspector-pane"><div className="inspector-heading"><span className="eyebrow">SESSION</span><button className="icon-button" onClick={() => setShowInspector(false)} aria-label="Close inspector">×</button></div>{activeSession ? <><div className="inspector-title">{activeSession.title}</div><div className="inspector-status"><span className={`status-dot status-${activeSession.status}`} />{displayStatus(activeSession.status)}</div>{autopilotSession && <div className="autopilot-control"><div><span className="eyebrow">AUTOPILOT</span><strong>{autopilotSession.enabled ? "Включён" : "Выключен"}</strong><small>{autopilotSession.source === "session" ? "Переопределено для этой сессии" : autopilotSession.source === "policy" ? "Наследуется от harness policy" : autopilotSession.source === "plugin-default" ? "По умолчанию плагина" : "По умолчанию выключен"}</small>{autopilotSession.source === "session" && <button className="inherit-button" disabled={autopilotSessionSaving} onClick={() => void inheritAutopilotSession()}>Наследовать policy</button>}</div><button className={`switch-control ${autopilotSession.enabled ? "enabled" : ""}`} role="switch" aria-checked={autopilotSession.enabled} aria-label={`Autopilot for ${activeSession.id}`} disabled={autopilotSessionSaving} onClick={() => void toggleAutopilotSession()}><span /></button></div>}{autopilotSessionError && <small className="autopilot-error">{autopilotSessionError}</small>}<dl><dt>Harness</dt><dd>{activeSession.harness}</dd><dt>Working directory</dt><dd>{activeSession.cwd}</dd><dt>Model</dt><dd>{activeSession.model || "—"}</dd><dt>Messages</dt><dd>{activeSession.messageCount ?? "—"}</dd><dt>Duration</dt><dd>{formatDuration(activeSession.durationSec)}</dd><dt>Cost</dt><dd>{activeSession.costUsd === undefined ? "—" : `$${activeSession.costUsd.toFixed(4)}`}</dd><dt>Tokens</dt><dd>{metaNumber(activeSession, ["total_tokens", "totalTokens", "tokens"]) ?? "—"}</dd><dt>Subagents</dt><dd>{details?.children?.length || 0}</dd></dl><div className="inspector-actions">{visualizationUrl && <a className="quiet-button" href={visualizationUrl} target="_blank" rel="noreferrer">Visualize</a>}{activeSession.status === "running" && <button className="danger-button" onClick={() => void runAction("stop")}>Stop</button>}{(activeSession.status === "stopped" || activeSession.status === "error") && <button className="primary-button" onClick={() => void runAction("resume")}>Resume</button>}{activeSession.status === "error" && <button className="quiet-button" onClick={() => void runAction("recover")}>Recover</button>}</div><div className="settings-block"><span className="eyebrow">VIEW</span><label><input type="checkbox" checked={showReasoning} onChange={(event) => setShowReasoning(event.target.checked)} /> Reasoning</label><label><input type="checkbox" checked={showTools} onChange={(event) => setShowTools(event.target.checked)} /> Tools</label></div></> : <div className="empty-inspector">No session selected.</div>}</aside>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
