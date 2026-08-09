import * as React from "react";
import { createRoot } from "react-dom/client";
import { Box, Button, Chip, Switch, Tooltip, Typography } from "@mui/material";
import { ChatBox } from "@mui/x-chat";
import type { ChatAdapter, ChatConversation, ChatMessage, ChatMessageChunk } from "@mui/x-chat/headless";
import "./styles.css";

type HerderSession = {
  id: string;
  harness: string;
  title: string;
  cwd: string;
  status: string;
  lastActivity: string;
  model?: string;
  needsPermission?: boolean;
};
type SessionPart = { type: "text" | "thinking" | "tool_call" | "tool_result"; text?: string; name?: string; input?: unknown; output?: string; error?: boolean };
type SessionMessage = { id: string; role: "user" | "assistant" | "tool" | "system"; timestamp?: string; parts: SessionPart[] };
type SessionDetails = { session: HerderSession; messages: SessionMessage[] };

const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
};
const keyOf = (harness: string, id: string) => `${harness}:${id}`;
const splitKey = (conversationId: string) => {
  const separator = conversationId.indexOf(":");
  return { harness: conversationId.slice(0, separator), id: conversationId.slice(separator + 1) };
};
const toConversation = (session: HerderSession): ChatConversation => ({
  id: keyOf(session.harness, session.id), title: session.title || session.id,
  subtitle: `${session.harness} · ${session.status} · ${session.cwd}`, lastMessageAt: session.lastActivity,
  metadata: { harness: session.harness, cwd: session.cwd, status: session.status },
});

function toMessages(details: SessionDetails, conversationId: string): ChatMessage[] {
  return details.messages.map((message) => ({
    id: message.id, conversationId, role: message.role === "user" ? "user" : "assistant", status: "sent", createdAt: message.timestamp,
    parts: message.parts.flatMap((part): any[] => {
      if (part.type === "text") return [{ type: "text" as const, text: part.text || "" }];
      if (part.type === "thinking") return [{ type: "reasoning" as const, text: part.text || "" }];
      return [{ type: "dynamic-tool" as const, toolInvocation: {
        toolCallId: `${message.id}:${part.name || part.type}`, toolName: part.name || part.type,
        state: part.error ? "output-error" as const : "output-available" as const, input: part.input, output: part.output,
        errorText: part.error ? part.output : undefined,
      } }];
    }),
  }));
}

function streamForMessage(messageId: string, text: string): ReadableStream<ChatMessageChunk> {
  return new ReadableStream({
    start(controller) {
      const textId = `${messageId}:text`;
      controller.enqueue({ type: "start", messageId });
      controller.enqueue({ type: "text-start", id: textId });
      if (text) controller.enqueue({ type: "text-delta", id: textId, delta: text });
      controller.enqueue({ type: "text-end", id: textId });
      controller.enqueue({ type: "finish", messageId, finishReason: "stop" });
      controller.close();
    },
  });
}

function createAdapter(): ChatAdapter {
  return {
    async listConversations() {
      const result = await api<{ sessions: HerderSession[] }>("/api/sessions");
      return { conversations: result.sessions.slice(0, 200).map(toConversation) };
    },
    async listMessages({ conversationId }) {
      const { harness, id } = splitKey(conversationId);
      const details = await api<SessionDetails>(`/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(id)}/details?limit=100`);
      return { messages: toMessages(details, conversationId) };
    },
    async sendMessage({ conversationId, message }) {
      if (!conversationId) throw new Error("A session must be selected first");
      const { harness, id } = splitKey(conversationId);
      const text = message.parts.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n").trim();
      if (!text) throw new Error("Message is empty");
      await api(`/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(id)}/message`, { method: "POST", body: JSON.stringify({ message: text, mode: "queue" }) });
      return streamForMessage(`local-${Date.now()}`, "Message queued");
    },
    subscribe({ onEvent }) {
      let active = true;
      let inFlight = false;
      const refresh = async () => {
        if (!active || inFlight) return;
        inFlight = true;
        try {
          const result = await api<{ sessions: HerderSession[] }>("/api/sessions");
          for (const session of result.sessions.slice(0, 200)) {
            if (active) onEvent({ type: "conversation-updated", conversation: toConversation(session) });
          }
        } finally {
          inFlight = false;
        }
      };
      void refresh();
      const timer = window.setInterval(() => void refresh(), 3000);
      return () => { active = false; window.clearInterval(timer); };
    },
  };
}

function HeaderActions({ showReasoning, showTools, setShowReasoning, setShowTools }: { showReasoning: boolean; showTools: boolean; setShowReasoning: (value: boolean) => void; setShowTools: (value: boolean) => void }) {
  return <Box className="view-settings" sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
    <Tooltip title="Показывать reasoning"><label><Switch size="small" checked={showReasoning} onChange={(event) => setShowReasoning(event.target.checked)} /><span>Reasoning</span></label></Tooltip>
    <Tooltip title="Показывать tool calls"><label><Switch size="small" checked={showTools} onChange={(event) => setShowTools(event.target.checked)} /><span>Tools</span></label></Tooltip>
  </Box>;
}

function SessionActions({ session, onAction }: { session?: HerderSession; onAction: (action: "resume" | "stop" | "recover") => void }) {
  if (!session) return null;
  return <Box className="session-actions" sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
    {(session.status === "stopped" || session.status === "error") && <Button size="small" variant="contained" onClick={() => onAction("resume")}>Resume</Button>}
    {session.status === "running" && <Button size="small" variant="outlined" color="error" onClick={() => onAction("stop")}>Stop</Button>}
    {session.status === "error" && <Button size="small" variant="outlined" onClick={() => onAction("recover")}>Recover</Button>}
  </Box>;
}

function App() {
  const adapter = React.useMemo(createAdapter, []);
  const [showReasoning, setShowReasoning] = React.useState(false);
  const [showTools, setShowTools] = React.useState(false);
  const [conversations, setConversations] = React.useState<ChatConversation[] | null>(null);
  const [activeConversationId, setActiveConversationId] = React.useState<string | undefined>();
  const initialConversationSet = React.useRef(false);
  React.useEffect(() => { adapter.listConversations?.().then(({ conversations: loaded }) => setConversations(loaded)).catch(() => setConversations([])); }, [adapter]);
  const partRenderers = React.useMemo(() => ({
    reasoning: ({ part }: { part: { text: string } }) => showReasoning ? <details className="reasoning"><summary>Reasoning</summary><Box component="pre">{part.text}</Box></details> : null,
    "dynamic-tool": ({ part }: { part: { toolInvocation: { toolName?: string; input?: unknown; output?: unknown } } }) => showTools ? <details className="tool-part"><summary>{part.toolInvocation.toolName || "Tool"}</summary><Box component="pre">{JSON.stringify(part.toolInvocation.output ?? part.toolInvocation.input ?? {}, null, 2)}</Box></details> : null,
  }), [showReasoning, showTools]);
  React.useEffect(() => {
    if (conversations?.length && !initialConversationSet.current) {
      initialConversationSet.current = true;
      setActiveConversationId(conversations[0].id);
    }
  }, [conversations]);
  const activeSession = conversations?.find((conversation) => conversation.id === activeConversationId);
  const activeKey = activeConversationId ? splitKey(activeConversationId) : undefined;
  const runAction = async (action: "resume" | "stop" | "recover") => {
    if (!activeConversationId) return;
    const { harness, id } = splitKey(activeConversationId);
    await api(`/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(id)}/${action}`, { method: "POST", body: JSON.stringify({}) });
  };
  const header = <Box className="herder-header"><Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}><Typography component="strong" variant="subtitle1">Agent Herder</Typography><Chip size="small" label="live sessions" /></Box><Box sx={{ display: "flex", alignItems: "center", gap: 1 }}><SessionActions session={activeSession ? { id: activeKey?.id || "", harness: activeKey?.harness || "", title: activeSession.title || "", cwd: "", status: String((activeSession.metadata as Record<string, unknown> | undefined)?.status || ""), lastActivity: activeSession.lastMessageAt || "" } : undefined} onAction={(action) => void runAction(action)} /><HeaderActions {...{ showReasoning, showTools, setShowReasoning, setShowTools }} /></Box></Box>;
  if (conversations === null) return <main className="herder-shell">{header}<Box className="loading">Loading sessions…</Box></main>;
  return <main className="herder-shell">{header}<ChatBox adapter={adapter} initialConversations={conversations} initialActiveConversationId={conversations[0]?.id} activeConversationId={activeConversationId} onActiveConversationChange={setActiveConversationId} variant="compact" density="compact" layoutModeBreakpoints={{ overlay: 760, split: 460 }} features={{ conversationList: true, attachments: false, helperText: false, suggestions: false, autoScroll: { buffer: 180 }, scrollToBottom: true, conversationHeader: true }} partRenderers={partRenderers} sx={{ height: "calc(100dvh - 58px)" }} slotProps={{ root: { sx: { height: "100%" } }, messageList: { sx: { minHeight: 0 } }, messageMeta: { sx: { display: "none" } }, conversationList: { sx: { minWidth: 0 } } }} /></main>;
}

createRoot(document.getElementById("root")!).render(<App />);
