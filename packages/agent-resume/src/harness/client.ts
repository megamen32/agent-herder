/**
 * The core's harness contract.
 *
 * The core owns protocol knowledge: how to enumerate a native session, read its
 * messages and admit an input into a live turn. Agent Herder owns what happens
 * around that — board, autopilot policy and judge, fleet, web, MCP surfaces —
 * and implements its own orchestration-facing adapter on top of this interface.
 */
export type HarnessKind = "opencode" | "codex" | "claude" | "hermes" | "fast-agent";

export interface HarnessSessionSummary {
  id: string;
  harness: HarnessKind;
  title: string;
  cwd: string;
  lastActivity?: string;
  model?: string;
  status?: "running" | "idle" | "needs_input" | "error" | "stopped";
  parentId?: string;
  costUsd?: number;
}

export interface HarnessMessagePart {
  type: "text" | "thinking" | "tool_call" | "tool_result";
  text?: string;
  name?: string;
  input?: unknown;
  output?: string;
  error?: boolean;
}

export interface HarnessMessage {
  id: string;
  /** Exact native record identity; absent for synthesized display ids. */
  nativeMessageId?: string;
  /** Verified native synthetic input, distinct from a human user message. */
  nativeInputType?: "synthetic";
  /** Native session identity observed in the record, never inferred from the query. */
  sessionId?: string;
  role: "user" | "assistant" | "system" | "tool";
  /** Native turn identity when the harness includes it in message history. */
  turnId?: string;
  /** Native message phase/finish, preserved without reinterpretation. */
  phase?: string;
  /** Native input→result parent linkage, preserved exactly as the harness reports it. */
  nativeParentMessageId?: string;
  /**
   * The admitted input identity of a user message. It names the exact input
   * that was accepted for this message, so a consumer can bind one native
   * message to the delivery that caused it.
   */
  inputId?: string;
  text?: string;
  timestamp?: string;
  model?: string;
  parts: HarnessMessagePart[];
}

export type HarnessDelivery = "queue" | "steer" | "start";

export interface HarnessSendRequest {
  message: string;
  /** `steer` targets a live turn, `queue` waits for a later turn, `start` opens a fresh initial turn. */
  delivery: HarnessDelivery;
  /** Optional explicit provider/model for native start operations. */
  model?: string;
  /** Stable identity of this input, used for durable deduplication. */
  inputId?: string;
}

export interface HarnessSendResult {
  ok: boolean;
  admitted?: boolean;
  /** Native OpenCode user-message ID, returned directly or verified by readback. */
  nativeInputMessageId?: string;
  error?: string;
}

export interface HarnessClient {
  readonly kind: HarnessKind;
  init(): Promise<void>;
  listSessions(options?: { cwd?: string; limit?: number }): Promise<HarnessSessionSummary[]>;
  getSession(id: string): Promise<HarnessSessionSummary | null>;
  getMessages(id: string, limit?: number): Promise<HarnessMessage[] | null>;
  send(id: string, request: HarnessSendRequest): Promise<HarnessSendResult>;
  /** Wait for the current turn to finish; resolves when the session is idle. */
  waitForIdle(id: string, signal?: AbortSignal): Promise<void>;
  interrupt(id: string): Promise<{ ok: boolean; error?: string }>;
  listModels(): Promise<string[]>;
  subscribe?(onEvent: (event: { kind: string; sessionId?: string; data?: Record<string, unknown> }) => void): () => void;
}

export interface HarnessClientOptions {
  baseUrl?: string;
  password?: string;
  /** Pin the native protocol instead of probing it (tests, legacy servers). */
  protocol?: "auto" | "v1" | "v2" | "v22";
}
