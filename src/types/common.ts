// ===== Shared types for all agent harness adapters =====

export type HarnessType = "opencode" | "claude" | "codex" | "qoder" | "hermes" | "zcode" | "fast-agent" | "chatgpt";

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
  type: "text" | "thinking" | "tool_call" | "tool_result" | "image";
  imageUrl?: string;
  fileName?: string;
  text?: string;
  name?: string;
  input?: unknown;
  output?: string;
  error?: boolean;
}

export interface SessionMessageView {
  /** Execution model observed on this native message. */
  model?: string;
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  /** Native turn identity; absent when the transcript does not prove it. */
  turnId?: string;
  phase?: string;
  timestamp?: string;
  text?: string;
  parts: SessionMessagePart[];
}

export type SessionHistorySource = "acp-load" | "observed-cli-output" | "session-convert" | "live-cache" | "unavailable";

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

export type HarnessEventKind =
  | "session.created"
  | "session.updated"
  | "session.deleted"
  | "turn.started"
  | "turn.completed"
  | "turn.failed"
  | "message.updated"
  | "permission.requested"
  | "permission.resolved"
  | "model.changed"
  | "process.connected"
  | "process.disconnected";

export interface HarnessEvent {
  kind: HarnessEventKind;
  harness: HarnessType;
  sessionId?: string;
  at?: string;
  nativeType?: string;
  status?: AgentStatus;
  messageId?: string;
  permissionId?: string;
  data?: Record<string, unknown>;
}

export interface HarnessEventSourceHealth {
  mode: "native" | "polling";
  connected: boolean;
  lastEventAt?: string;
  reconnects: number;
  lastError?: string;
}

export interface HarnessCapabilities {
  imageInput?: boolean;
  steer?: boolean;
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

export interface SendMessageResult {
  /** Scoped hook reservation, not a native input/turn-start or model receipt. */
  admissionKind?: "current_turn_context";
  /** Dispatch was cancelled before invoking any native writer. */
  notSubmitted?: boolean;
  ok: boolean;
  /** Exact native turn addressed/returned by admission, not task completion. */
  turnId?: string;
  /** Caller-supplied stable operation identity; distinct attempts need distinct IDs. */
  inputId?: string;
  error?: string;
  /** The native harness accepted this exact prompt, so callers must not submit it again. */
  admitted?: boolean;
  /** Native input may have been accepted, but its admission receipt is unknown. */
  admissionUnknown?: boolean;
  /** A failed result that crossed the native idempotency boundary and cannot be retried safely. */
  nonRetryable?: boolean;
  /** The native harness admitted the prompt, but its turn-start event is not confirmed yet. */
  pending?: boolean;
}

export interface ControlResult extends SendMessageResult {
  sessionId?: string;
}

export interface CompactSessionOptions {
  inputId: string;
  expectedUserMessageId?: string;
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
  /** Internal opted-in Stop judge delivery; separate from one-off fleet recovery. */
  automationPurpose?: "autopilot";
  /** Existing regular inbox IDs transferred only at durable hook offer. */
  retainedInboxIds?: string[];
  /** Internal active-turn-only delivery. Never resume/start or enqueue a future turn. */
  activeTurnOnly?: boolean;
  /** Exact failed input fence for recovery only; ordinary coordination is unchanged. */
  recoveryBoundary?: {turnId:string;userMessageId:string;completedAt:number};
  /** Exact named-task context resolved before delivery to a shared Hermes home lane. */
  expectedTaskBinding?: { name: string; cwd: string; generation: string };
  images?: MessageImage[];
  /** Server admission time of queued human intent; a later manual stop wins. */
  humanRequestedAt?: number;
  /** Explicit human input may release a manual stop; generated delivery must not. */
  origin?: "human" | "automation";
  /** The message text to send */
  message: string;
  /** If true, queue the message without waiting (fire-and-forget) */
  queue?: boolean;
  /** If true, steer the agent's current direction */
  steer?: boolean;
  /** Stable native operation identity for crash-safe delivery reconciliation. */
  inputId?: string;
}

export interface MessageImage { id: string; path: string; fileName: string; mimeType: string; bytes: number }

export interface MessageAdmissionResult {
  /** Technical admission is not model-observed delivery. */
  pending?: boolean;
  state: "not_found" | "admitted" | "failed" | "unknown";
  error?: string;
}

export interface CreateSessionOptions {
  /** Dedicated bounded health recovery worker, never a general chat. */
  healthRecovery?: boolean;
  /** Stable human-readable identity within a harness and canonical CWD. */
  name: string;
  /** Absolute, canonical working directory. */
  cwd: string;
  /** Optional model selected when creating the session. */
  model?: string;
  /** Enable full native tool access for explicitly unattended, Agent Herder-created sessions. */
  fullAccess?: boolean;
  /** Optional native session mode for harnesses that distinguish modes from permissions. */
  mode?: string;
}

export interface ListSessionsOptions {
  /** Bounded interactive discovery; omitted means exhaustive enumeration. */
  limit?: number;
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
    kind: "native-file" | "native-api" | "observed-acp-events" | "observed-cli-output" | "observed-gateway-messages";
    location: string;
    format: "jsonl" | "json" | "text" | "unknown";
  };
  timestampCoverage: "native" | "partial" | "none";
  limitations?: string[];
};

/** Evidence describing whether the latest native session enumeration was exhaustive. */
export interface SessionSnapshotReceipt {
  exhaustive: boolean;
  observedAt: string;
  source: string;
  reason?: string;
}

export interface HarnessAdapter {
  /** Harness type identifier */
  readonly type: HarnessType;
  /** Human-readable name */
  readonly name: string;
  /** Native controls exposed by this transport. */
  readonly controlCapabilities?: Partial<HarnessCapabilities>;
  /** If true, background discovery must not start a new child transport. */
  readonly lazyStart?: boolean;
  /** If true, listSessions() is read-only and safe while the transport sleeps. */
  readonly lazyDiscovery?: boolean;
  /** Whether this adapter currently owns or is attached to a live transport. */
  isReady?(): boolean;
  /** Native current-turn admission with no idle/start fallback. */
  sendActiveMessage?(id: string, options: SendMessageOptions): Promise<ControlResult>;
  /** Read exact live native turn/user-loop identity without load/start/resume. */
  getCoordinationActiveTurnId?(id: string): Promise<string | null>;
  /** Pure receipt lookup for coordination; must never load/resume a native session. */
  getCoordinationMessageAdmission?(id: string, inputId: string): Promise<MessageAdmissionResult>;

  /** Effective execution profile for request-bound health jobs, when exposed. */
  getExecutionProfile?(): Record<string, string>;

  /** Native harness event stream when available. Returns an unsubscribe function. */
  subscribeEvents?(handler: (event: HarnessEvent) => void): () => void;

  /** Initialize the adapter (check connectivity, etc.) */
  init(): Promise<void>;

  /** List all agent sessions */
  listSessions(options?: ListSessionsOptions): Promise<AgentSession[]>;

  /** Completeness evidence for the most recent listSessions() call, when supported. */
  getSessionSnapshotReceipt?(): SessionSnapshotReceipt;

  /** Find exact named sessions without forcing a full historical discovery, when supported. */
  findNamedSessions?(name: string, cwd: string): Promise<AgentSession[]>;

  /** Get detailed info about a specific session */
  getSession(id: string, options?: { includeMetrics?: boolean }): Promise<AgentSession | null>;

  /** Create a new named native session when supported by the harness. */
  createSession?(options: CreateSessionOptions): Promise<AgentSession>;

  /** Find the native parent session, when the transport exposes lineage. */
  getParent?(id: string): Promise<AgentSession | null>;

  /** List native child sessions, when the transport exposes lineage. */
  listChildren?(id: string): Promise<AgentSession[]>;

  /** Send a message to an agent session */
  sendMessage(id: string, options: SendMessageOptions): Promise<SendMessageResult>;

  /** Reconcile one stable send operation against native events or transcript state. */
  getMessageAdmission?(id: string, inputId: string, cwd?: string): Promise<MessageAdmissionResult>;

  /** Abort / stop a running session */
  /** Legacy alias retained for callers that still mean terminate. */
  stopSession(id: string): Promise<ControlResult>;

  /** Cancel the active turn while keeping the native session resumable. */
  cancelTurn?(id: string): Promise<ControlResult>;

  /** Release this adapter's live transport without terminating the native session. */
  detach?(id: string): Promise<ControlResult>;

  /** Terminate the native session or its owning process. */
  terminate?(id: string): Promise<ControlResult>;

  /** Archive a completed native session while preserving its history. */
  archiveSession?(id: string): Promise<ControlResult>;

  /** Compact native model context in place; never send a task prompt or replace the session. */
  compactSession?(id: string, options: CompactSessionOptions): Promise<ControlResult>;

  /** Reconnect/resume a failed transport and optionally recover with a prompt. */
  recover?(id: string, message?: string, signal?: AbortSignal): Promise<ControlResult>;

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

  /** Persist the session's native pinned state when the harness exposes one. */
  setSessionPinned?(sessionId: string, pinned: boolean): Promise<ControlResult>;

  /** Get the full transcript of a session for summarization */
  getTranscript?(id: string): Promise<string | null>;

  /** Export adapter-owned source material for the canonical archive. */
  getRawTranscript?(id: string, signal?: AbortSignal): Promise<RawTranscriptExport | null>;

  /** Get structured recent messages from the adapter-owned transport, when available. */
  getSessionMessages?(id: string, limit?: number): Promise<SessionMessageView[] | null>;

  /** Get the earliest user-authored message without relying on a bounded transcript tail. */
  getFirstUserMessage?(id: string): Promise<SessionMessageView | null>;

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
  const capabilities = Object.fromEntries(CONTROL_KEYS.map((key) => [
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
  if (adapter.controlCapabilities?.imageInput) capabilities.imageInput = true;
  if (adapter.controlCapabilities?.steer) capabilities.steer = true;
  return capabilities;
}
