// ===== Shared types for all agent harness adapters =====

export type HarnessType = "opencode" | "claude" | "codex";

export type AgentStatus =
  | "running"      // actively processing
  | "idle"         // waiting, no prompt pending
  | "needs_input"  // blocked on permission prompt or question
  | "stopped"      // finished or aborted
  | "error";       // crashed

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

export interface SetPermissionsOptions {
  /** Comma-separated list of allowed tools, e.g. "Read,Edit,Bash" */
  allowedTools?: string;
  /** Permission mode: "default" | "plan" | "autoEdit" | "fullAuto" */
  mode?: string;
}

export interface HarnessAdapter {
  /** Harness type identifier */
  readonly type: HarnessType;
  /** Human-readable name */
  readonly name: string;

  /** Initialize the adapter (check connectivity, etc.) */
  init(): Promise<void>;

  /** List all agent sessions */
  listSessions(): Promise<AgentSession[]>;

  /** Get detailed info about a specific session */
  getSession(id: string): Promise<AgentSession | null>;

  /** Send a message to an agent session */
  sendMessage(id: string, options: SendMessageOptions): Promise<{ ok: boolean; error?: string }>;

  /** Abort / stop a running session */
  stopSession(id: string): Promise<{ ok: boolean; error?: string }>;

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

  /** List available models for this harness */
  listModels?(): Promise<string[]>;
}