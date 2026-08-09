// ===== Shared types for all agent harness adapters =====

export type HarnessType = "opencode" | "claude" | "codex" | "qoder" | "hermes" | "zcode";

export type AgentStatus =
  | "running"      // actively processing
  | "idle"         // waiting, no prompt pending
  | "needs_input"  // blocked on permission prompt or question
  | "stopped"      // finished or aborted
  | "error";       // crashed

export type SessionLineageKind = "root" | "subagent" | "external" | "unknown";

export interface SessionLineage {
  kind: SessionLineageKind;
  parentId?: string;
  role?: string;
  task?: string;
}

export interface SessionMessagePart {
  type: "text" | "thinking" | "tool_call" | "tool_result";
  text?: string;
  name?: string;
  input?: unknown;
  output?: string;
  error?: boolean;
}

export interface SessionMessageView {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  timestamp?: string;
  text?: string;
  parts: SessionMessagePart[];
}

export type SessionHistorySource = "acp-load" | "session-convert" | "live-cache" | "unavailable";

export type AgentControlOperation =
  | "cancelTurn"
  | "detach"
  | "resume"
  | "terminate"
  | "recover"
  | "fork"
  | "modelSwitch"
  | "subagents"
  | "events";

export interface HarnessCapabilities {
  cancelTurn: boolean;
  detach: boolean;
  resume: boolean;
  terminate: boolean;
  recover: boolean;
  fork: boolean;
  modelSwitch: boolean;
  subagents: boolean;
  events: boolean;
}

export interface ControlResult {
  ok: boolean;
  error?: string;
  sessionId?: string;
}

export interface SessionHistoryInfo {
  source: SessionHistorySource;
  complete: boolean;
  warning?: string;
}

export interface SessionDetails {
  session: AgentSession;
  lineage: SessionLineage;
  children: AgentSession[];
  messages: SessionMessageView[];
  history: SessionHistoryInfo;
}

export interface AgentSession {
  /** Unique identifier within the harness */
  id: string;
  /** Which harness this session belongs to */
  harness: HarnessType;
  /** Current status */
  status: AgentStatus;
  /** Human-readable title or first prompt */
  title: string;
  /** Working directory / project path */
  cwd: string;
  /** Last activity timestamp (ISO 8601) */
  lastActivity: string;
  /** Current model being used */
  model?: string;
  /** Whether the agent has an outstanding permission request */
  needsPermission: boolean;
  /** Permission request details if needsPermission is true */
  permissionDetails?: PermissionRequest;
  /** Number of messages in the session */
  messageCount?: number;
  /** Cost / token usage so far (if available) */
  costUsd?: number;
  /** Duration in seconds since session start */
  durationSec?: number;
  /** Preview of the last message in the session (truncated) */
  lastMessage?: string;
  /** Harness-specific extra data */
  meta?: Record<string, unknown>;
}

export interface PermissionRequest {
  id: string;
  type: string;        // e.g. "tool_use", "bash", "file_write"
  description: string;  // human-readable description of what the agent wants to do
  toolName?: string;
  details?: string;     // full input or command
}

export interface SendMessageOptions {
  /** The message text to send */
  message: string;
  /** If true, queue the message without waiting (fire-and-forget) */
  queue?: boolean;
  /** If true, steer the agent's current direction */
  steer?: boolean;
}

export interface CreateSessionOptions {
  /** Stable human-readable identity within a harness and canonical CWD. */
  name: string;
  /** Absolute, canonical working directory. */
  cwd: string;
}

export interface ListSessionsOptions {
  /** Restrict native discovery to this working directory when supported. */
  cwd?: string;
}

export interface SetPermissionsOptions {
  /** Comma-separated list of allowed tools, e.g. "Read,Edit,Bash" */
  allowedTools?: string;
  /** Permission mode: "default" | "plan" | "autoEdit" | "fullAuto" */
  mode?: string;
}

/** Raw adapter-owned transcript material for archival, never a display summary. */
export type RawTranscriptExport = {
  bytes: Uint8Array;
  complete: boolean;
  source: {
    kind: "native-file" | "native-api" | "observed-acp-events" | "observed-gateway-messages";
    location: string;
    format: "jsonl" | "json" | "text" | "unknown";
  };
  timestampCoverage: "native" | "partial" | "none";
  limitations?: string[];
};

export interface HarnessAdapter {
  /** Harness type identifier */
  readonly type: HarnessType;
  /** Human-readable name */
  readonly name: string;
  /** Native controls exposed by this transport. */
  readonly controlCapabilities?: Partial<HarnessCapabilities>;

  /** Initialize the adapter (check connectivity, etc.) */
  init(): Promise<void>;

  /** List all agent sessions */
  listSessions(options?: ListSessionsOptions): Promise<AgentSession[]>;

  /** Get detailed info about a specific session */
  getSession(id: string): Promise<AgentSession | null>;

  /** Create a new named native session when supported by the harness. */
  createSession?(options: CreateSessionOptions): Promise<AgentSession>;

  /** Find the native parent session, when the transport exposes lineage. */
  getParent?(id: string): Promise<AgentSession | null>;

  /** List native child sessions, when the transport exposes lineage. */
  listChildren?(id: string): Promise<AgentSession[]>;

  /** Send a message to an agent session */
  sendMessage(id: string, options: SendMessageOptions): Promise<{ ok: boolean; error?: string }>;

  /** Abort / stop a running session */
  /** Legacy alias retained for callers that still mean terminate. */
  stopSession(id: string): Promise<ControlResult>;

  /** Cancel the active turn while keeping the native session resumable. */
  cancelTurn?(id: string): Promise<ControlResult>;

  /** Release this adapter's live transport without terminating the native session. */
  detach?(id: string): Promise<ControlResult>;

  /** Terminate the native session or its owning process. */
  terminate?(id: string): Promise<ControlResult>;

  /** Reconnect/resume a failed transport and optionally recover with a prompt. */
  recover?(id: string, message?: string): Promise<ControlResult>;

  /** Fork a native session, preserving a lineage edge for the caller. */
  forkSession?(id: string, message?: string): Promise<ControlResult>;

  /** Respond to a pending permission request */
  respondPermission(
    sessionId: string,
    permissionId: string,
    response: "allow" | "deny",
    remember?: boolean
  ): Promise<{ ok: boolean; error?: string }>;

  /** Set permissions for a session */
  setPermissions(sessionId: string, options: SetPermissionsOptions): Promise<{ ok: boolean; error?: string }>;

  /** Change the model used by a session or globally for this harness */
  changeModel?(sessionId: string, model: string): Promise<{ ok: boolean; error?: string }>;

  /** Get the full transcript of a session for summarization */
  getTranscript?(id: string): Promise<string | null>;

  /** Export adapter-owned source material for the canonical archive. */
  getRawTranscript?(id: string): Promise<RawTranscriptExport | null>;

  /** Get structured recent messages from the adapter-owned transport, when available. */
  getSessionMessages?(id: string, limit?: number): Promise<SessionMessageView[] | null>;

  /** Resume a session through its owning transport, when supported. */
  resumeSession?(id: string): Promise<{ ok: boolean; error?: string }>;

  /** List available models for this harness */
  listModels?(): Promise<string[]>;
}

const CONTROL_KEYS: Array<keyof HarnessCapabilities> = [
  "cancelTurn",
  "detach",
  "resume",
  "terminate",
  "recover",
  "fork",
  "modelSwitch",
  "subagents",
  "events",
];

/** Resolve the effective transport capabilities for API/UI feature gating. */
export function getHarnessCapabilities(adapter: HarnessAdapter): HarnessCapabilities {
  return Object.fromEntries(CONTROL_KEYS.map((key) => [
    key,
    adapter.controlCapabilities && key in adapter.controlCapabilities
      ? adapter.controlCapabilities[key] === true
      : (key === "resume" && typeof adapter.resumeSession === "function") ||
        (key === "modelSwitch" && typeof adapter.changeModel === "function") ||
        (key === "fork" && typeof adapter.forkSession === "function") ||
        (key === "recover" && typeof adapter.recover === "function") ||
        (key === "cancelTurn" && typeof adapter.cancelTurn === "function") ||
        (key === "detach" && typeof adapter.detach === "function") ||
        (key === "terminate" && (typeof adapter.terminate === "function" || typeof adapter.stopSession === "function")),
  ])) as unknown as HarnessCapabilities;
}
