import { currentTurnContextReceipt, previousCoordinationReceipt, reserveCurrentTurnContext } from "../coordination-active-delivery.js";
import { deferredMessages } from "../deferred-messages.js";
import { getHumanStopStore } from "../human-stop-store.js";
import {
  OpenCodeClient,
  normalizeOpenCodeEvent,
  parseOpenCodeServerCommand,
  unwrapEnvelope,
  type OpenCodeEvent,
} from "agent-resume-mcp";
import { HarnessAdapter, AgentSession, ControlResult, CreateSessionOptions, HarnessCapabilities, HarnessEvent, ListSessionsOptions, RawTranscriptExport, SendMessageOptions, SendMessageResult, SetPermissionsOptions, SessionMessagePart, SessionMessageView } from "../types/index.js";
import { randomUUID } from "node:crypto";
import { throwIfAborted } from "../abort-utils.js";
import { terminalQuotaFailure } from "./quota-failure.js";

export { normalizeOpenCodeEvent, openCodeConnectedModels, openCodeMessageParts, openCodeModelCatalogEntries, parseOpenCodeServerCommand, unwrapEnvelope } from "agent-resume-mcp";
export type { OpenCodeEvent } from "agent-resume-mcp";

/**
 * Agent Herder's OpenCode adapter: orchestration on top of the shared core.
 *
 * The protocol — OpenCode 2's `/api` surface, its `{ data }` envelopes, session
 * enumeration, inbox delivery, permissions, models and events — is owned by the
 * core package. What stays here is what Agent Herder alone does: how a session
 * becomes an orchestration record, how a coordination message is admitted into a
 * *running* turn with a durable receipt, and how delivery interacts with the
 * human-stop fence.
 */
export class OpenCodeAdapter implements HarnessAdapter {
  readonly type = "opencode" as const;
  readonly name = "OpenCode";
  readonly controlCapabilities: HarnessCapabilities = {
    cancelTurn: true,
    detach: true,
    resume: false,
    terminate: false,
    recover: true,
    fork: true,
    modelSwitch: true,
    subagents: true,
    events: true,
  };

  private readonly client: OpenCodeClient;
  /** Native v2 emits the inbox delivery before execution.started, whose frame has no input ID. */
  private readonly deliveredInboxBySession = new Map<string, string | null>();

  constructor(config: { baseUrl?: string; password?: string; protocol?: "auto" | "v1" | "v2" } = {}) {
    this.client = new OpenCodeClient({
      baseUrl: config.baseUrl,
      ...(config.password ? { password: config.password } : {}),
      ...(config.protocol ? { protocol: config.protocol } : {}),
    });
  }

  /** True once the server answered as an OpenCode 2 (`/api`) instance. */
  get isV2(): boolean {
    return this.client.isV2;
  }

  async init(): Promise<void> {
    await this.client.init();
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<AgentSession[]> {
    const sessions = await this.client.listSessions({ cwd: options.cwd, limit: options.limit });
    return sessions.map((session) => this.toAgentSession(session));
  }

  async getSession(id: string): Promise<AgentSession | null> {
    const detail = await this.client.getSession(id);
    if (!detail) return null;
    const result = this.toAgentSession(detail);
    const last = (await this.getSessionMessages(id, 1))?.at(-1);
    if (last) {
      const tool = [...last.parts].reverse().find((part) => part.type === "tool_call" || part.type === "tool_result");
      // The session model endpoint is the supported readback for a just-issued
      // model switch. A historical assistant message can report the previous
      // model and must not mask that current native setting.
      if (last.model && !result.model) result.model = last.model;
      result.lastMessage = last.text || (tool ? `Инструмент: ${tool.name || "tool"}` : undefined);
      if (last.timestamp && last.timestamp > result.lastActivity) result.lastActivity = last.timestamp;
    }
    const nativeFailure = detail.status === "error" ? await this.client.getTerminalFailureContext(id) : null;
    if (nativeFailure) {
      const quotaFailure = terminalQuotaFailure({
        terminal: true,
        status: nativeFailure.status,
        nativeTurnId: nativeFailure.nativeTurnId,
        inputId: nativeFailure.inputId,
        providerId: nativeFailure.providerId,
        modelId: nativeFailure.modelId,
        errorType: nativeFailure.errorType,
        errorCode: nativeFailure.errorCode,
        errorMessage: nativeFailure.errorMessage,
        statusCode: nativeFailure.statusCode,
        resetAt: nativeFailure.resetAt,
      });
      if (quotaFailure) {
        const meta = result.meta ?? {};
        result.meta = {
          ...meta,
          nativeLastTurn: {
            ...((meta.nativeLastTurn && typeof meta.nativeLastTurn === "object") ? meta.nativeLastTurn as Record<string, unknown> : {}),
            turnId: quotaFailure.nativeTurnId,
            inputId: quotaFailure.inputId,
            status: quotaFailure.status,
            quotaFailure,
          },
        };
      }
    }
    return result;
  }

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    const created = await this.client.createSession({
      title: options.name,
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.fullAccess ? { fullAccess: true } : {}),
    });
    // A session Herder created knows who it is from its first turn: otherwise
    // an OpenCode agent cannot name itself, coordinate, or answer "who am I".
    await this.announceIdentity({
      name: options.name,
      sessionId: created.id,
      cwd: created.cwd || options.cwd,
    }).catch(() => false);
    return this.toAgentSession({ ...created, cwd: created.cwd || options.cwd });
  }

  /**
   * Tell one session its own identity. Best effort by design: an OpenCode 1
   * server has no instruction entries, and a failed announcement must never
   * block the session itself.
   */
  async announceIdentity(input: { name?: string; sessionId: string; cwd?: string; parentSessionId?: string }): Promise<boolean> {
    const cwd = input.cwd ?? (await this.client.resolveDirectory(input.sessionId)) ?? process.cwd();
    const name = input.name?.trim() || (await this.client.getSession(input.sessionId))?.title || input.sessionId;
    return this.client.announceIdentity(input.sessionId, {
      name,
      sessionId: input.sessionId,
      harness: "opencode",
      cwd,
      ...(process.env.AGENT_HERDER_URL ? { herderUrl: process.env.AGENT_HERDER_URL } : {}),
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
    });
  }

  /** Read the identity a session knows about itself, if herder ever announced one. */
  async identityOf(sessionId: string): Promise<{ name: string; sessionId: string; harness: string; cwd: string } | null> {
    const session = await this.client.getSession(sessionId).catch(() => null);
    if (!session) return null;
    return { name: session.title || sessionId, sessionId: session.id, harness: "opencode", cwd: session.cwd };
  }

  async getParent(id: string): Promise<AgentSession | null> {
    const session = await this.client.getSession(id);
    return session?.parentId ? this.getSession(session.parentId) : null;
  }

  /**
   * Native active-turn identity. The core owns the protocol read; Herder owns
   * the guarantee that a coordination message is only ever admitted into the
   * turn that is executing right now.
   */
  async getCoordinationActiveTurnId(id: string): Promise<string | null> {
    return this.client.getActiveTurnId(id);
  }

  /**
   * Active-turn delivery. OpenCode 2 steers the running turn natively, so the
   * message reaches the live turn instead of waiting for a plugin hook that only
   * older servers run.
   */
  async sendActiveMessage(id: string, options: SendMessageOptions): Promise<ControlResult> {
    // Legacy servers have no native steer; they keep the durable hook offer.
    if (!this.client.isV2) return reserveCurrentTurnContext(this, id, options);
    const prior = await previousCoordinationReceipt(this, id, options.inputId);
    if (prior) {
      const parsed = JSON.parse(prior) as {
        ok: boolean; admitted?: boolean; pending?: boolean; error?: string;
        admissionUnknown?: boolean; nonRetryable?: boolean;
      };
      return {
        ok: parsed.ok,
        admitted: parsed.admitted ?? parsed.ok,
        ...(parsed.pending ? { pending: true } : {}),
        ...(parsed.error ? { error: parsed.error } : {}),
        ...(parsed.admissionUnknown ? { admissionUnknown: true } : {}),
        ...(parsed.nonRetryable ? { nonRetryable: true } : {}),
        inputId: options.inputId,
      };
    }
    const identity = await this.client.getActiveTurnId(id);
    if (!identity) {
      return { ok: false, notSubmitted: true, nonRetryable: true, inputId: options.inputId, error: "skipped_inactive: точный активный native ход не установлен" };
    }
    if (await getHumanStopStore().isHeld(this.type, id)) {
      return { ok: false, notSubmitted: true, nonRetryable: true, inputId: options.inputId, error: "Чат явно остановлен." };
    }
    const delivered = await this.client.send(id, { message: options.message, delivery: "steer" });
    if (!delivered.ok) {
      return { ok: false, notSubmitted: true, nonRetryable: true, inputId: options.inputId, error: delivered.error ?? "steer delivery refused" };
    }
    await deferredMessages.addActive(this.type, id, identity, options.inputId || randomUUID(), options.message, options.retainedInboxIds);
    return { ok: true, admitted: true, pending: true, inputId: options.inputId };
  }

  async getCoordinationMessageAdmission(id: string, inputId: string) {
    return currentTurnContextReceipt(this, id, inputId);
  }

  async sendMessage(id: string, options: SendMessageOptions): Promise<SendMessageResult> {
    return this.client.send(id, { message: options.message, delivery: options.queue ? "queue" : "steer", ...(options.inputId ? { inputId: options.inputId } : {}) });
  }

  async stopSession(id: string): Promise<{ ok: boolean; error?: string }> {
    return this.cancelTurn(id);
  }

  async cancelTurn(id: string): Promise<ControlResult> {
    return this.client.interrupt(id);
  }

  async detach(_id: string): Promise<ControlResult> {
    return { ok: true };
  }

  async listChildren(id: string): Promise<AgentSession[]> {
    return (await this.client.listChildren(id)).map((child) => this.toAgentSession(child));
  }

  /** Subscribe to the native event stream the core owns and keep Herder's shapes. */
  subscribeEvents(onEvent: (event: HarnessEvent) => void): () => void {
    return this.client.subscribe(
      (event) => {
        const correlated = this.correlateInboxStart(event);
        void this.toQuotaAwareHarnessEvent(correlated).then((normalized) => {
          if (normalized) onEvent(normalized);
        }).catch(() => {
          const normalized = this.toHarnessEvent(event);
          if (normalized) onEvent(normalized);
        });
      },
      {
        onConnected: () => onEvent({ kind: "process.connected", harness: "opencode", data: { transport: "sse" } }),
        onDisconnected: (error) => onEvent({ kind: "process.disconnected", harness: "opencode", data: { transport: "sse", ...(error ? { error } : {}) } }),
      },
    );
  }

  /** Carry only the exact native Inbox.User ID across the adjacent delivery/start lifecycle. */
  private correlateInboxStart(event: OpenCodeEvent): OpenCodeEvent {
    const sessionId = event.sessionId;
    if (!sessionId) return event;
    const data = event.data ?? {};
    if (event.nativeType === "session.inbox.delivered") {
      const inboxId = typeof data.nativeInputMessageId === "string" ? data.nativeInputMessageId : undefined;
      const previous = this.deliveredInboxBySession.get(sessionId);
      this.deliveredInboxBySession.set(sessionId, inboxId && previous === undefined ? inboxId : null);
      return event;
    }
    if (event.kind === "turn.started") {
      const inboxId = this.deliveredInboxBySession.get(sessionId);
      this.deliveredInboxBySession.delete(sessionId);
      if (typeof data.inputId === "string" || !inboxId) return event;
      return { ...event, data: { ...data, inputId: inboxId, nativeInputMessageId: inboxId } };
    }
    if (event.kind === "turn.completed" || event.kind === "turn.failed") {
      this.deliveredInboxBySession.delete(sessionId);
    }
    return event;
  }

  private async toQuotaAwareHarnessEvent(event: OpenCodeEvent): Promise<HarnessEvent | null> {
    const normalized = this.toHarnessEvent(event);
    if (!normalized || normalized.kind !== "turn.failed" || !normalized.sessionId) return normalized;
    const data = normalized.data ?? {};
    const terminalEventId = typeof data.nativeEventId === "string" ? data.nativeEventId : undefined;
    if (!terminalEventId) return normalized;
    const observedTurnId = typeof data.turnId === "string" ? data.turnId : undefined;
    const observedInputId = typeof data.inputId === "string" ? data.inputId : undefined;
    const nativeFailure = await this.client.getTerminalFailureContext(
      normalized.sessionId,
      terminalEventId,
      observedTurnId,
      observedInputId,
    );
    if (!nativeFailure) return normalized;
    const quotaFailure = terminalQuotaFailure({
      terminal: true,
      status: nativeFailure.status,
      nativeTurnId: nativeFailure.nativeTurnId,
      inputId: nativeFailure.inputId,
      providerId: nativeFailure.providerId,
      modelId: nativeFailure.modelId,
      errorType: typeof data.nativeErrorType === "string" ? data.nativeErrorType : nativeFailure.errorType,
      errorCode: typeof data.nativeErrorCode === "string" ? data.nativeErrorCode : nativeFailure.errorCode,
      errorMessage: typeof data.nativeErrorMessage === "string" ? data.nativeErrorMessage : nativeFailure.errorMessage,
      statusCode: typeof data.nativeErrorStatus === "number" ? data.nativeErrorStatus : nativeFailure.statusCode,
      resetAt: data.nativeErrorResetAt ?? nativeFailure.resetAt,
    });
    if (!quotaFailure) return normalized;
    return {
      ...normalized,
      status: "error",
      data: {
        ...data,
        turnId: quotaFailure.nativeTurnId,
        inputId: quotaFailure.inputId,
        quotaFailure,
      },
    };
  }

  async forkSession(id: string, message?: string): Promise<ControlResult> {
    return this.client.forkSession(id, message);
  }

  async recover(id: string, message?: string, signal?: AbortSignal): Promise<ControlResult> {
    try {
      throwIfAborted(signal);
      await this.client.waitForIdle(id, signal);
      throwIfAborted(signal);
      if (!message) return { ok: true };
      const result = await this.sendMessage(id, { message, queue: true });
      if (result.ok) return result;
      throw new Error(result.error || "OpenCode recovery prompt failed");
    } catch (error) {
      if (signal?.aborted) throw error;
      const forked = await this.forkSession(id, message);
      return forked.ok
        ? { ...forked, error: `Recovery used a child session after transport error: ${(error as Error).message}` }
        : { ok: false, error: `${(error as Error).message}; fork failed: ${forked.error}` };
    }
  }

  async respondPermission(sessionId: string, permissionId: string, response: "allow" | "deny", remember?: boolean): Promise<{ ok: boolean; error?: string }> {
    return this.client.respondPermission(sessionId, permissionId, response, remember);
  }

  async setPermissions(sessionId: string, options: SetPermissionsOptions): Promise<{ ok: boolean; error?: string }> {
    return this.client.setPermissions(sessionId, {
      ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
    });
  }

  async changeModel(sessionId: string, model: string): Promise<{ ok: boolean; error?: string }> {
    return this.client.changeModel(sessionId, model);
  }

  async listModels(): Promise<string[]> {
    return this.client.listModels();
  }

  async getSessionMessages(id: string, limit = 3): Promise<SessionMessageView[] | null> {
    const messages = await this.client.getMessages(id, limit);
    if (!messages) return null;
    return messages.map((message) => {
      const toolNames = [...new Set(message.parts
        .filter((part) => part.type === "tool_call" && typeof part.name === "string" && part.name.length > 0)
        .map((part) => part.name as string))];
      // Text-less turns are usually tool rounds; keep them legible instead of
      // an empty bubble that hides what the session actually did.
      const text = message.text || (toolNames.length > 0 ? `Инструмент: ${toolNames.join(", ")}` : undefined);
      return {
        id: message.id,
        role: message.role,
        ...(message.model ? { model: message.model } : {}),
        ...(message.timestamp ? { timestamp: message.timestamp } : {}),
        ...(text ? { text } : {}),
        parts: message.parts as SessionMessagePart[],
      };
    });
  }

  async getTranscript(id: string): Promise<string | null> {
    const messages = await this.getSessionMessages(id, 50);
    if (!messages?.length) return null;
    const lines = messages.map((message) => {
      const text = message.text ?? (message.role === "assistant" ? "" : "");
      return `${message.role}: ${text.slice(0, 2000)}`;
    }).filter((line) => !line.endsWith(": "));
    return lines.join("\n\n") || null;
  }

  async getRawTranscript(id: string, signal?: AbortSignal): Promise<RawTranscriptExport | null> {
    const raw = await this.client.getRawTranscript(id, signal);
    if (!raw) return null;
    return {
      bytes: raw.bytes,
      complete: false,
      source: { kind: "native-api", location: raw.location, format: "json" },
      timestampCoverage: "partial",
      limitations: raw.limitations,
    };
  }

  // ---- orchestration mapping ----

  private toAgentSession(session: {
    id: string; title: string; cwd: string; lastActivity?: string; model?: string;
    status?: AgentSession["status"]; parentId?: string; costUsd?: number;
    needsPermission?: boolean; permissionDetails?: { id: string; type: string; description: string; toolName?: string; details?: string };
  }): AgentSession {
    return {
      id: session.id,
      harness: "opencode",
      status: session.status ?? "idle",
      title: session.title,
      cwd: session.cwd,
      lastActivity: session.lastActivity ?? new Date(0).toISOString(),
      ...(session.model ? { model: session.model } : {}),
      needsPermission: session.needsPermission === true,
      ...(session.permissionDetails ? { permissionDetails: session.permissionDetails } : {}),
      ...(session.costUsd !== undefined ? { costUsd: session.costUsd } : {}),
      ...(session.parentId ? { meta: { parentID: session.parentId } } : {}),
    };
  }

  private toHarnessEvent(event: OpenCodeEvent): HarnessEvent | null {
    if (!event || event.kind === "unknown") return null;
    return {
      kind: event.kind as HarnessEvent["kind"],
      harness: "opencode",
      sessionId: event.sessionId,
      nativeType: event.nativeType,
      messageId: event.messageId,
      permissionId: event.permissionId,
      status: event.status,
      at: new Date().toISOString(),
      data: event.data,
    };
  }
}
