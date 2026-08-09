import * as React from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./styles.css";

type HerderSession = {
  id: string;
  harness: string;
  title: string;
  cwd: string;
  status: string;
  lastActivity: string;
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
const keyOf = (session: HerderSession) => `${session.harness}:${session.id}`;
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

function SessionList({ sessions, activeKey, onSelect }: { sessions: HerderSession[]; activeKey?: string; onSelect: (key: string) => void }) {
  return <aside className="sessions-pane">
    <div className="sessions-heading"><div><span className="eyebrow">AGENT HERDER</span><h1>Sessions</h1></div><button className="icon-button" aria-label="Search sessions">⌕</button></div>
    <div className="session-list" aria-label="Sessions">
      {sessions.map((session) => {
        const key = keyOf(session);
        return <button className={`session-row ${key === activeKey ? "selected" : ""}`} key={key} onClick={() => onSelect(key)}>
          <span className={`status-dot status-${session.status}`} aria-hidden="true" />
          <span className="session-copy"><strong>{session.title || session.id}</strong><small>{session.harness} · {displayStatus(session.status)}</small><small className="session-preview">{session.lastMessage || session.cwd}</small></span>
          <time>{formatTime(session.lastActivity)}</time>
        </button>;
      })}
      {sessions.length === 0 && <div className="empty-list">No sessions found.</div>}
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
  const [composer, setComposer] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [sending, setSending] = React.useState(false);
  const chatScrollRef = React.useRef<HTMLDivElement>(null);
  const shouldFollowRef = React.useRef(true);

  const loadSessions = React.useCallback(async () => {
    const result = await api<{ sessions: HerderSession[] }>("/api/sessions");
    setSessions(result.sessions.slice(0, 300));
    setActiveKey((current) => current && result.sessions.some((session) => keyOf(session) === current) ? current : result.sessions[0] ? keyOf(result.sessions[0]) : undefined);
  }, []);
  React.useEffect(() => { void loadSessions().finally(() => setLoading(false)); const timer = window.setInterval(() => void loadSessions(), 3000); return () => window.clearInterval(timer); }, [loadSessions]);

  const loadDetails = React.useCallback(async (key: string) => {
    const { harness, id } = splitKey(key);
    const next = await api<SessionDetails>(`/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(id)}/details?limit=100`);
    setDetails(next);
    requestAnimationFrame(() => { const element = chatScrollRef.current; if (element && shouldFollowRef.current) element.scrollTop = element.scrollHeight; });
  }, []);
  React.useEffect(() => { if (!activeKey) { setDetails(null); return; } void loadDetails(activeKey); }, [activeKey, loadDetails]);

  const activeSession = sessions.find((session) => keyOf(session) === activeKey) || details?.session;
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
    setComposer(""); setSending(true); shouldFollowRef.current = true;
    try { await api(`/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(id)}/message`, { method: "POST", body: JSON.stringify({ message: text, mode: "queue" }) }); await loadDetails(activeKey); } finally { setSending(false); }
  };
  const handleChatScroll = () => {
    const element = chatScrollRef.current;
    if (!element) return;
    shouldFollowRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
  };

  if (loading) return <main className="oc-app"><div className="oc-loading">Loading sessions…</div></main>;
  return <main className={`oc-app ${mobileView === "chat" ? "mobile-chat-active" : "mobile-sessions-active"}`}>
    <SessionList sessions={sessions} activeKey={activeKey} onSelect={(key) => { setActiveKey(key); setMobileView("chat"); }} />
    <section className="chat-pane">
      <header className="chat-header">
        <button className="mobile-back" onClick={() => setMobileView("sessions")} aria-label="Back to sessions">← <span>Sessions</span></button>
        <div className="chat-heading"><span className="eyebrow">{activeSession?.harness || "HERDER"}</span><h2>{activeSession?.title || "Select a session"}</h2><small>{activeSession?.cwd || ""}</small></div>
        <div className="header-actions"><button className="quiet-button" onClick={() => setShowInspector((value) => !value)}>{showInspector ? "Hide" : "Info"}</button><button className="icon-button" aria-label="Chat menu">···</button></div>
      </header>
      <div className="chat-scroll" ref={chatScrollRef} onScroll={handleChatScroll}>
        <div className="message-column">
          {!details && <div className="empty-chat">Choose a session to open its conversation.</div>}
          {details?.messages.map((message) => <article className={`message ${message.role}`} key={message.id}><div className="message-meta"><span>{message.role === "user" ? "You" : message.role === "tool" ? "Tool" : "Agent"}</span><time>{formatTime(message.timestamp || "")}</time></div><MessageParts message={message} showReasoning={showReasoning} showTools={showTools} /></article>)}
        </div>
      </div>
      <form className="composer" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}><button type="button" className="composer-plus" aria-label="Add context">+</button><textarea value={composer} onChange={(event) => setComposer(event.target.value)} placeholder={activeKey ? "Message the agent…" : "Choose a session first"} disabled={!activeKey || sending} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} /><span className="composer-hint">{sending ? "Waiting for agent…" : "Enter to send · Shift+Enter for a new line"}</span><button className="send-button" type="submit" disabled={!composer.trim() || sending} aria-label="Send message">↑</button></form>
    </section>
    {showInspector && <aside className="inspector-pane"><div className="inspector-heading"><span className="eyebrow">SESSION</span><button className="icon-button" onClick={() => setShowInspector(false)} aria-label="Close inspector">×</button></div>{activeSession ? <><div className="inspector-title">{activeSession.title}</div><div className="inspector-status"><span className={`status-dot status-${activeSession.status}`} />{displayStatus(activeSession.status)}</div><dl><dt>Harness</dt><dd>{activeSession.harness}</dd><dt>Working directory</dt><dd>{activeSession.cwd}</dd><dt>Model</dt><dd>{activeSession.model || "—"}</dd></dl><div className="inspector-actions">{activeSession.status === "running" && <button className="danger-button" onClick={() => void runAction("stop")}>Stop</button>}{(activeSession.status === "stopped" || activeSession.status === "error") && <button className="primary-button" onClick={() => void runAction("resume")}>Resume</button>}{activeSession.status === "error" && <button className="quiet-button" onClick={() => void runAction("recover")}>Recover</button>}</div><div className="settings-block"><span className="eyebrow">VIEW</span><label><input type="checkbox" checked={showReasoning} onChange={(event) => setShowReasoning(event.target.checked)} /> Reasoning</label><label><input type="checkbox" checked={showTools} onChange={(event) => setShowTools(event.target.checked)} /> Tools</label></div></> : <div className="empty-inspector">No session selected.</div>}</aside>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
