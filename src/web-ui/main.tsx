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
};
type SessionPart = { type: "text" | "thinking" | "tool_call" | "tool_result"; text?: string; name?: string; input?: unknown; output?: string; error?: boolean };
type SessionMessage = { id: string; role: "user" | "assistant" | "tool" | "system"; timestamp?: string; text?: string; parts: SessionPart[] };
type SessionDetails = { session: HerderSession; messages: SessionMessage[] };

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
const displayStatus = (status: string) => status.replace("needs_input", "needs input");

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

function SessionList({ entries, activeKey, settings, settingsOpen, searchOpen, searchQuery, options, collapsedChildren, onSearchChange, onSearchToggle, onSettingsChange, onSettingsToggle, onToggleChildren, onSelect }: {
  entries: SessionListEntry[];
  activeKey?: string;
  settings: SessionListSettings;
  settingsOpen: boolean;
  searchOpen: boolean;
  searchQuery: string;
  options: { cwds: string[]; projects: string[]; harnesses: string[] };
  collapsedChildren: ReadonlySet<string>;
  onSearchChange: (query: string) => void;
  onSearchToggle: () => void;
  onSettingsChange: (patch: Partial<SessionListSettings>) => void;
  onSettingsToggle: () => void;
  onToggleChildren: (key: string) => void;
  onSelect: (key: string) => void;
}) {
  return <aside className="sessions-pane">
    <div className="sessions-heading"><div><span className="eyebrow">AGENT HERDER</span><h1>Sessions</h1></div><div className="sessions-heading-actions"><button className={`icon-button ${searchOpen ? "selected-icon" : ""}`} aria-label="Search sessions" aria-expanded={searchOpen} onClick={onSearchToggle}>⌕</button><button className={`icon-button ${settingsOpen ? "selected-icon" : ""}`} aria-label="Session settings" aria-expanded={settingsOpen} onClick={onSettingsToggle}>⚙</button></div></div>
    {searchOpen && <div className="session-search"><input autoFocus value={searchQuery} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search title, harness, CWD…" aria-label="Search session text" /></div>}
    {settingsOpen && <div className="session-settings" aria-label="Session list settings">
      <label>CWD<select value={settings.cwd} onChange={(event) => onSettingsChange({ cwd: event.target.value })}><option value="">All CWDs</option>{options.cwds.map((cwd) => <option value={cwd} key={cwd}>{cwd}</option>)}</select></label>
      <label>Project<select value={settings.project} onChange={(event) => onSettingsChange({ project: event.target.value })}><option value="">All projects</option>{options.projects.map((project) => <option value={project} key={project}>{project}</option>)}</select></label>
      <label>Harness<select value={settings.harness} onChange={(event) => onSettingsChange({ harness: event.target.value })}><option value="">All harnesses</option>{options.harnesses.map((harness) => <option value={harness} key={harness}>{harness}</option>)}</select></label>
      <label>Sort by<select value={settings.sort} onChange={(event) => onSettingsChange({ sort: event.target.value as SessionListSort })}><option value="activity">Recent activity</option><option value="status">Status</option><option value="harness">Harness</option><option value="title">Title</option><option value="cwd">CWD</option></select></label>
    </div>}
    <div className="session-list" aria-label="Sessions">
      {entries.map(({ session, depth, hasChildren }) => {
        const key = keyOf(session);
        return <div className="session-row-wrap" style={{ marginLeft: `${depth * 14}px` }} key={key}>
          {hasChildren ? <button className="session-fold" aria-label={`Toggle child sessions for ${session.title || session.id}`} onClick={() => onToggleChildren(key)}>{collapsedChildren.has(key) ? "›" : "⌄"}</button> : <span className="session-fold-placeholder" />}
          <button className={`session-row ${key === activeKey ? "selected" : ""}`} onClick={() => onSelect(key)}>
            <span className={`status-dot status-${session.status}`} aria-hidden="true" />
            <span className="session-copy"><strong>{session.title || session.id}</strong><small>{session.harness} · {displayStatus(session.status)}</small><small className="session-preview">{session.lastMessage || session.cwd}</small></span>
            <time>{formatTime(session.lastActivity)}</time>
          </button>
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
  const [listSettings, setListSettings] = React.useState<SessionListSettings>({ cwd: "", project: "", harness: "", sort: "activity" });
  const [collapsedChildren, setCollapsedChildren] = React.useState<Set<string>>(new Set());
  const foldedInitialized = React.useRef(false);
  const [composer, setComposer] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [sending, setSending] = React.useState(false);
  const [chatMenuOpen, setChatMenuOpen] = React.useState(false);
  const [showScrollToLatest, setShowScrollToLatest] = React.useState(false);
  const chatScrollRef = React.useRef<HTMLDivElement>(null);
  const shouldFollowRef = React.useRef(true);

  const loadSessions = React.useCallback(async () => {
    const result = await api<{ sessions: HerderSession[] }>("/api/sessions");
    setSessions(result.sessions.slice(0, 300));
    if (!foldedInitialized.current && result.sessions.length > 0) {
      const keys = new Set(result.sessions.flatMap((session) => session.meta?.parentSessionKey ? [session.meta.parentSessionKey] : []));
      setCollapsedChildren(keys);
      foldedInitialized.current = true;
    }
    setActiveKey((current) => current && result.sessions.some((session) => keyOf(session) === current) ? current : result.sessions[0] ? keyOf(result.sessions[0]) : undefined);
  }, []);
  React.useEffect(() => { void loadSessions().finally(() => setLoading(false)); const timer = window.setInterval(() => void loadSessions(), 3000); return () => window.clearInterval(timer); }, [loadSessions]);

  const loadDetails = React.useCallback(async (key: string) => {
    const { harness, id } = splitKey(key);
    const next = await api<SessionDetails>(`/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(id)}/details?limit=100`);
    setDetails(next);
  }, []);
  React.useEffect(() => { if (!activeKey) { setDetails(null); return; } void loadDetails(activeKey); }, [activeKey, loadDetails]);
  React.useLayoutEffect(() => {
    const element = chatScrollRef.current;
    if (!element || !shouldFollowRef.current) return;
    const frame = requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
      setShowScrollToLatest(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [activeKey, details?.messages.length]);

  const activeSession = sessions.find((session) => keyOf(session) === activeKey) || details?.session;
  const sessionMap = React.useMemo(() => new Map(sessions.map((session) => [keyOf(session), session])), [sessions]);
  const listOptions = React.useMemo(() => ({
    cwds: [...new Set(sessions.map((session) => session.cwd).filter(Boolean))].sort(),
    projects: [...new Set(sessions.map((session) => projectFor(session, sessionMap)).filter(Boolean))].sort(),
    harnesses: [...new Set(sessions.map((session) => session.harness).filter(Boolean))].sort(),
  }), [sessions, sessionMap]);
  const sessionEntries = React.useMemo(() => filterAndArrangeSessions(sessions, listSettings, collapsedChildren), [sessions, listSettings, collapsedChildren]);
  const visibleSessionEntries = React.useMemo(() => sessionEntries.filter(({ session }) => matchesSessionQuery(session, sessionSearch)), [sessionEntries, sessionSearch]);
  const runAction = async (action: "resume" | "stop" | "recover") => {
    if (!activeKey) return;
    const { harness, id } = splitKey(activeKey);
    await api(`/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(id)}/${action}`, { method: "POST", body: JSON.stringify({}) });
    await loadSessions();
    await loadDetails(activeKey);
  };
  const sendMessage = async () => {
    if (!activeKey || !composer.trim() || sending) return;
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
    <SessionList entries={visibleSessionEntries} activeKey={activeKey} settings={listSettings} settingsOpen={showSessionSettings} searchOpen={showSessionSearch} searchQuery={sessionSearch} options={listOptions} collapsedChildren={collapsedChildren} onSearchChange={setSessionSearch} onSearchToggle={() => setShowSessionSearch((value) => !value)} onSettingsToggle={() => setShowSessionSettings((value) => !value)} onSettingsChange={(patch) => setListSettings((current) => ({ ...current, ...patch }))} onToggleChildren={(key) => setCollapsedChildren((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })} onSelect={(key) => { setActiveKey(key); setMobileView("chat"); }} />
    <section className="chat-pane">
      <header className="chat-header">
        <button className="mobile-back" onClick={() => setMobileView("sessions")} aria-label="Back to sessions">← <span>Sessions</span></button>
        <div className="chat-heading"><span className="eyebrow">{activeSession?.harness || "HERDER"}</span><h2>{activeSession?.title || "Select a session"}</h2><small>{activeSession?.cwd || ""}</small></div>
        <div className="header-actions"><button className="quiet-button" onClick={() => setShowInspector((value) => !value)}>{showInspector ? "Hide" : "Info"}</button><button className={`icon-button ${chatMenuOpen ? "selected-icon" : ""}`} aria-label="Chat menu" aria-expanded={chatMenuOpen} onClick={() => setChatMenuOpen((value) => !value)}>···</button></div>
        {chatMenuOpen && <div className="chat-menu" role="menu"><label><input type="checkbox" checked={showReasoning} onChange={(event) => setShowReasoning(event.target.checked)} /> Reasoning</label><label><input type="checkbox" checked={showTools} onChange={(event) => setShowTools(event.target.checked)} /> Tools</label><button className="quiet-button" onClick={() => { setShowInspector(true); setChatMenuOpen(false); }}>Session info</button></div>}
      </header>
      <div className="chat-scroll" ref={chatScrollRef} onScroll={handleChatScroll}>
        <div className="message-column">
          {!details && <div className="empty-chat">Choose a session to open its conversation.</div>}
          {details?.messages.map((message) => hasVisibleMessage(message, showReasoning, showTools) && <article className={`message ${message.role}`} key={message.id}><div className="message-meta"><span>{message.role === "user" ? "You" : message.role === "tool" ? "Tool" : "Agent"}</span><time>{formatTime(message.timestamp || "")}</time></div><MessageParts message={message} showReasoning={showReasoning} showTools={showTools} /></article>)}
        </div>
      </div>
      {showScrollToLatest && <button className="scroll-latest" aria-label="Scroll to latest" onClick={scrollToBottom}>↓ <span>Latest</span></button>}
      <form className="composer" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}><button type="button" className="composer-plus" aria-label="Add context">+</button><textarea value={composer} onChange={(event) => setComposer(event.target.value)} placeholder={activeKey ? "Message the agent…" : "Choose a session first"} disabled={!activeKey || sending} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} /><span className="composer-hint">{sending ? "Waiting for agent…" : "Enter to send · Shift+Enter for a new line"}</span><button className="send-button" type="submit" disabled={!composer.trim() || sending} aria-label="Send message">↑</button></form>
    </section>
    {showInspector && <aside className="inspector-pane"><div className="inspector-heading"><span className="eyebrow">SESSION</span><button className="icon-button" onClick={() => setShowInspector(false)} aria-label="Close inspector">×</button></div>{activeSession ? <><div className="inspector-title">{activeSession.title}</div><div className="inspector-status"><span className={`status-dot status-${activeSession.status}`} />{displayStatus(activeSession.status)}</div><dl><dt>Harness</dt><dd>{activeSession.harness}</dd><dt>Working directory</dt><dd>{activeSession.cwd}</dd><dt>Model</dt><dd>{activeSession.model || "—"}</dd></dl><div className="inspector-actions">{activeSession.status === "running" && <button className="danger-button" onClick={() => void runAction("stop")}>Stop</button>}{(activeSession.status === "stopped" || activeSession.status === "error") && <button className="primary-button" onClick={() => void runAction("resume")}>Resume</button>}{activeSession.status === "error" && <button className="quiet-button" onClick={() => void runAction("recover")}>Recover</button>}</div><div className="settings-block"><span className="eyebrow">VIEW</span><label><input type="checkbox" checked={showReasoning} onChange={(event) => setShowReasoning(event.target.checked)} /> Reasoning</label><label><input type="checkbox" checked={showTools} onChange={(event) => setShowTools(event.target.checked)} /> Tools</label></div></> : <div className="empty-inspector">No session selected.</div>}</aside>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
