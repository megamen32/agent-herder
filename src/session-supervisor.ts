import type { ContentPart, Conversation, ConversionResult, HarnessType, Message } from "session-convert";
import type {
  AgentSession,
  ControlResult,
  HarnessAdapter,
  SendMessageOptions,
  SessionDetails,
  SessionHistoryInfo,
  SessionLineage,
  SessionMessagePart,
  SessionMessageView,
} from "./types/index.js";
import { createNamedSession, newOrResumeNamedSession, type NamedSessionRequest, type NamedSessionResult, type NewOrResumeNamedSessionRequest } from "./named-session.js";
import { getHarnessCapabilities } from "./types/index.js";
import type { AgentHerderSessionConverter, ConvertSessionInput } from "./session-convert.js";
import { LineageStore, type LineageRecord } from "./lineage-store.js";

export interface SessionFilters {
  harness?: string;
  status?: string;
  cwd?: string;
}

export interface SessionDetailOptions {
  limit?: number;
  history?: "auto" | "acp" | "files";
}

export interface SpawnRecordInput {
  provider: string;
  sessionId: string;
  nativeSessionId?: string;
  parentProvider?: string;
  parentSessionId?: string;
  parentNativeSessionId?: string;
  role?: string;
  task?: string;
  source?: LineageRecord["source"];
}

export interface SessionSupervisorOptions {
  /** How long a snapshot may be served before a background refresh starts. */
  sessionCacheTtlMs?: number;
}

interface SessionSnapshot {
  sessions: AgentSession[];
  refreshedAt: number;
}

export class SessionNotFoundError extends Error {
  constructor(provider: string, id: string) {
    super(`Session '${provider}:${id}' not found`);
    this.name = "SessionNotFoundError";
  }
}

/** Coordinates adapters without taking ownership away from the adapter that created a session. */
export class SessionSupervisor {
  private readonly sessionCacheTtlMs: number;
  private sessionSnapshot: SessionSnapshot | null = null;
  private sessionRefresh: Promise<void> | null = null;

  constructor(
    private readonly adapters: Map<string, HarnessAdapter>,
    private readonly converter: Pick<AgentHerderSessionConverter, "convert"> & Partial<Pick<AgentHerderSessionConverter, "read">>,
    private readonly lineage = new LineageStore(defaultLineagePath()),
    options: SessionSupervisorOptions = {},
  ) {
    this.sessionCacheTtlMs = Math.max(0, options.sessionCacheTtlMs ?? 1_500);
  }

  async createNamedSession(request: NamedSessionRequest): Promise<NamedSessionResult> {
    return createNamedSession(this.adapters, request);
  }

  async newOrResumeNamedSession(request: NewOrResumeNamedSessionRequest): Promise<NamedSessionResult> {
    return newOrResumeNamedSession(this.adapters, request);
  }

  getExecutionProfile(harness: string): Record<string, string> | undefined {
    return this.adapters.get(harness)?.getExecutionProfile?.();
  }

  async listSessions(filters: SessionFilters = {}): Promise<AgentSession[]> {
    if (this.sessionSnapshot) {
      if (Date.now() - this.sessionSnapshot.refreshedAt >= this.sessionCacheTtlMs) {
        // Keep serving the last known snapshot while one shared refresh runs.
        // A failed background refresh leaves the last good snapshot intact.
        void this.refreshSessionSnapshot().catch(() => undefined);
      }
      return this.filterSessions(this.sessionSnapshot.sessions, filters);
    }

    // The first request is cold and must establish a usable snapshot. All
    // subsequent requests are cache-first and never wait for adapter discovery.
    await this.refreshSessionSnapshot();
    return this.filterSessions(this.sessionSnapshot!.sessions, filters);
  }

  private filterSessions(sessions: AgentSession[], filters: SessionFilters): AgentSession[] {
    return sessions
      .filter((session) => !filters.harness || session.harness === filters.harness)
      .filter((session) => !filters.status || session.status === filters.status)
      .filter((session) => !filters.cwd || session.cwd.startsWith(filters.cwd));
  }

  private refreshSessionSnapshot(): Promise<void> {
    if (this.sessionRefresh) return this.sessionRefresh;
    this.sessionRefresh = this.readSessionSnapshot()
      .then((sessions) => {
        this.sessionSnapshot = { sessions, refreshedAt: Date.now() };
      })
      .finally(() => {
        this.sessionRefresh = null;
      });
    return this.sessionRefresh;
  }

  private async readSessionSnapshot(): Promise<AgentSession[]> {
    const adapters = [...this.adapters.entries()].filter(([, adapter]) =>
      !adapter.lazyStart || adapter.lazyDiscovery || !adapter.isReady || adapter.isReady()
    );
    const sessionGroups = await Promise.all(adapters.map(async ([provider, adapter]) => {
      const sessions = await adapter.listSessions();
      return Promise.all(sessions.map(async (session) => {
        const record = await this.lineage.get(sessionKey(provider, nativeSessionId(session)));
        const nativeParentId = typeof session.meta?.parentThreadId === "string" && session.meta.parentThreadId !== nativeSessionId(session) ? session.meta.parentThreadId : undefined;
        const nativeRole = typeof session.meta?.agentRole === "string" ? session.meta.agentRole : undefined;
        const parentKey = record?.parentKey || (provider === "codex" && nativeParentId ? sessionKey(provider, nativeParentId) : undefined);
        return {
          ...session,
          meta: {
            ...session.meta,
            provider,
            controlCapabilities: getHarnessCapabilities(adapter),
            lineage: parentKey
              ? { kind: "subagent", role: record?.role || nativeRole, task: record?.task }
              : record ? { kind: "root", role: record.role, task: record.task } : { kind: "external" },
            parentSessionKey: parentKey,
          },
        };
      }));
    }));
    return sessionGroups.flat();
  }

  async getSession(harness: string, id: string): Promise<AgentSession | null> {
    const direct = this.adapters.get(harness);
    if (direct) {
      const session = await direct.getSession(id);
      const modelOptions = direct.listModels ? await direct.listModels() : [];
      return session
        ? { ...session, meta: { ...session.meta, provider: harness, controlCapabilities: getHarnessCapabilities(direct), modelOptions } }
        : null;
    }
    for (const adapter of this.adapters.values()) {
      if (adapter.type !== harness) continue;
      const session = await adapter.getSession(id);
      if (session) {
        const modelOptions = adapter.listModels ? await adapter.listModels() : [];
        return { ...session, meta: { ...session.meta, provider: harness, controlCapabilities: getHarnessCapabilities(adapter), modelOptions } };
      }
    }
    return null;
  }

  async sendMessage(harness: string, id: string, options: SendMessageOptions): Promise<{ ok: boolean; error?: string }> {
    const adapter = this.requireAdapter(harness);
    return adapter.sendMessage(id, options);
  }

  async changeModel(harness: string, id: string, model: string): Promise<ControlResult> {
    const adapter = this.requireAdapter(harness);
    return adapter.changeModel
      ? adapter.changeModel(id, model)
      : { ok: false, error: `${adapter.name} does not expose model switching` };
  }

  async stopSession(harness: string, id: string): Promise<{ ok: boolean; error?: string }> {
    return this.requireAdapter(harness).stopSession(id);
  }

  async cancelTurn(harness: string, id: string): Promise<{ ok: boolean; error?: string }> {
    const adapter = this.requireAdapter(harness);
    return adapter.cancelTurn
      ? adapter.cancelTurn(id)
      : { ok: false, error: `${adapter.name} does not expose native turn cancellation` };
  }

  async recoverSession(harness: string, id: string, message?: string): Promise<{ ok: boolean; error?: string; sessionId?: string }> {
    const adapter = this.requireAdapter(harness);
    const result: ControlResult = await (adapter.recover
      ? adapter.recover(id, message)
      : Promise.resolve({ ok: false, error: `${adapter.name} does not expose native recovery` }));
    if (adapter.recover) {
      const key = sessionKey(harness, id);
      const existing = await this.lineage.get(key);
      if (existing) {
        await this.lineage.recordRecovery(key, {
          nativeSessionId: id,
          transport: adapter.name,
          transportGeneration: (existing.transportGeneration || 0) + 1,
          recoveryAttempts: (existing.recoveryAttempts || 0) + 1,
          recoveredFrom: result.sessionId,
          lastError: result.ok ? undefined : result.error,
        });
      }
      if (result.ok && result.sessionId) {
        await this.recordSpawn({
          provider: harness,
          sessionId: result.sessionId,
          parentProvider: harness,
          parentSessionId: id,
          role: "recovery-child",
          task: message,
          source: "supervisor",
        });
      }
    }
    return result;
  }

  async forkSession(harness: string, id: string, message?: string): Promise<{ ok: boolean; error?: string; sessionId?: string }> {
    const adapter = this.requireAdapter(harness);
    const result: Promise<ControlResult> = adapter.forkSession
      ? adapter.forkSession(id, message)
      : Promise.resolve({ ok: false, error: `${adapter.name} does not expose native session forking` });
    const resolved = await result;
    if (resolved.ok && resolved.sessionId) {
      await this.recordSpawn({
        provider: harness,
        sessionId: resolved.sessionId,
        parentProvider: harness,
        parentSessionId: id,
        role: "fork",
        task: message,
        source: "supervisor",
      });
    }
    return resolved;
  }

  async respondPermission(
    harness: string,
    id: string,
    permissionId: string,
    response: "allow" | "deny",
  ): Promise<{ ok: boolean; error?: string }> {
    return this.requireAdapter(harness).respondPermission(id, permissionId, response);
  }

  async resumeSession(harness: string, id: string, message?: string): Promise<{ ok: boolean; error?: string }> {
    const adapter = this.requireAdapter(harness);
    if (adapter.resumeSession) {
      const resumed = await adapter.resumeSession(id);
      if (!resumed.ok || !message) return resumed;
    }
    if (!message) return { ok: false, error: `${adapter.name} does not expose a native resume operation` };
    return adapter.sendMessage(id, { message });
  }

  async convertSession(input: ConvertSessionInput): Promise<ConversionResult> {
    return this.converter.convert(input);
  }

  async recordSpawn(input: SpawnRecordInput): Promise<void> {
    await this.lineage.record({
      sessionKey: sessionKey(input.provider, input.nativeSessionId || input.sessionId),
      parentKey: input.parentProvider && input.parentSessionId
        ? sessionKey(input.parentProvider, input.parentNativeSessionId || input.parentSessionId)
        : undefined,
      role: input.role,
      task: input.task,
      provider: input.provider,
      createdAt: new Date().toISOString(),
      source: input.source || "supervisor",
    });
  }

  async getSessionDetails(provider: string, id: string, options: SessionDetailOptions = {}): Promise<SessionDetails> {
    const cachedSessions = provider === "codex" ? await this.listSessions({ harness: provider }) : undefined;
    const session = cachedSessions?.find((candidate) => candidate.id === id || nativeSessionId(candidate) === id)
      || await this.getSession(provider, id);
    if (!session) throw new SessionNotFoundError(provider, id);
    const limit = Math.max(1, Math.min(options.limit || 3, 50));
    const record = await this.lineage.get(sessionKey(provider, nativeSessionId(session)));
    const nativeParentId = typeof session.meta?.parentThreadId === "string" && session.meta.parentThreadId !== nativeSessionId(session) ? session.meta.parentThreadId : undefined;
    const nativeRole = typeof session.meta?.agentRole === "string" ? session.meta.agentRole : undefined;
    const parentKey = record?.parentKey || (provider === "codex" && nativeParentId ? sessionKey(provider, nativeParentId) : undefined);
    const lineage: SessionLineage = record
      ? { kind: parentKey ? "subagent" : "root", parentId: parentKey, role: record.role, task: record.task }
      : parentKey ? { kind: "subagent", parentId: parentKey, role: nativeRole } : { kind: "external" };
    const childRecords = await this.lineage.children(sessionKey(provider, id));
    const nativeChildren = provider === "codex"
      ? (cachedSessions || []).filter((candidate) => nativeSessionId(candidate) !== nativeSessionId(session) && candidate.meta?.parentSessionKey === sessionKey(provider, nativeSessionId(session)))
      : [];
    const childKeys = new Map(childRecords.map((child) => [child.sessionKey, child]));
    const nativeChildSessions = new Map(nativeChildren.map((child) => [sessionKey(provider, nativeSessionId(child)), child]));
    for (const child of nativeChildren) childKeys.set(sessionKey(provider, nativeSessionId(child)), {
      sessionKey: sessionKey(provider, nativeSessionId(child)), provider, nativeSessionId: nativeSessionId(child), createdAt: new Date().toISOString(), source: "acp-meta",
    });
    const resolvedChildren = await Promise.all([...childKeys.values()].map(async (child) => {
      const childId = child.sessionKey.startsWith(`${child.provider}:`)
        ? child.sessionKey.slice(child.provider.length + 1) : undefined;
      if (!childId) return null;
      const childSession = nativeChildSessions.get(child.sessionKey) || await this.getSession(child.provider, childId);
      return childSession
        ? { ...childSession, meta: { ...childSession.meta, provider: child.provider } }
        : null;
    }));
    const children: AgentSession[] = resolvedChildren.filter((child) => child !== null);

    const history = await this.readHistory(provider, id, session, limit, options.history || "auto");
    return { session, lineage, children, messages: history.messages, history: history.info };
  }

  private async readHistory(
    provider: string,
    id: string,
    session: AgentSession,
    limit: number,
    mode: SessionDetailOptions["history"],
  ): Promise<{ messages: SessionMessageView[]; info: SessionHistoryInfo }> {
    const adapter = this.requireAdapter(provider);
    const nativeId = typeof session.meta?.nativeSessionId === "string" ? session.meta.nativeSessionId : id;
    const warnings: string[] = [];

    if (mode !== "files" && adapter.getSessionMessages) {
      try {
        const liveMessages = await adapter.getSessionMessages(id, limit);
        if (liveMessages && liveMessages.length > 0) {
          return {
            messages: tailLogicalTurns(liveMessages, limit),
            info: { source: provider === "hermes" ? "observed-cli-output" : "acp-load", complete: false },
          };
        }
      } catch (error) {
        warnings.push(`ACP history unavailable: ${(error as Error).message}`);
      }
    }

    if (session.harness !== "qoder" && session.harness !== "hermes" && session.harness !== "zcode" && session.harness !== "fast-agent" && mode !== "acp" && this.converter.read) {
      try {
        const conversation = await this.converter.read({
          sessionId: nativeId,
          from: session.harness,
        });
        if (conversation && conversation.messages.length > 0) {
          return {
            messages: tailLogicalTurns(conversation.messages.map(toMessageView), limit),
            info: { source: "session-convert", complete: true, warning: warnings.join(" ") || undefined },
          };
        }
      } catch (error) {
        warnings.push(`Session reader unavailable: ${(error as Error).message}`);
      }
    }

    if (adapter.getTranscript && mode !== "files") {
      try {
        const transcript = await adapter.getTranscript(id);
        if (transcript) {
          return {
            messages: [{ id: `${id}:live`, role: "assistant", text: transcript, parts: [{ type: "text", text: transcript }] }],
            info: { source: "live-cache", complete: false, warning: warnings.join(" ") || undefined },
          };
        }
      } catch (error) {
        warnings.push(`Live transcript unavailable: ${(error as Error).message}`);
      }
    }

    return {
      messages: [],
      info: {
        source: "unavailable",
        complete: false,
        warning: [...warnings, `No readable history is available for ${provider}:${nativeId}`].join(" "),
      },
    };
  }

  private requireAdapter(harness: string): HarnessAdapter {
    const adapter = this.adapters.get(harness);
    if (!adapter) throw new Error(`Harness '${harness}' is not configured`);
    return adapter;
  }
}

function sessionKey(provider: string, id: string): string {
  return `${provider}:${id}`;
}

function nativeSessionId(session: AgentSession): string {
  return typeof session.meta?.nativeSessionId === "string" ? session.meta.nativeSessionId : session.id;
}

function defaultLineagePath(): string {
  const dataHome = process.env.XDG_DATA_HOME || `${process.env.HOME || process.cwd()}/.local/share`;
  return `${dataHome}/agent-herder/lineage.json`;
}

function tailLogicalTurns(messages: SessionMessageView[], limit: number): SessionMessageView[] {
  const turns: SessionMessageView[][] = [];
  let current: SessionMessageView[] = [];
  for (const message of messages) {
    if (message.role === "user" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) turns.push(current);
  return turns.slice(-limit).flat();
}

function toMessageView(message: Message): SessionMessageView {
  const parts = message.parts.map(toPartView);
  const text = parts.filter((part) => part.type === "text").map((part) => part.text || "").join("\n").trim() || undefined;
  const toolOnly = parts.length > 0 && parts.every((part) => part.type === "tool_result");
  return {
    id: message.id,
    role: toolOnly ? "tool" : message.role,
    timestamp: message.timestamp,
    text,
    parts,
  };
}

function toPartView(part: ContentPart): SessionMessagePart {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "thinking":
      return { type: "thinking", text: part.text };
    case "tool_call":
      return { type: "tool_call", name: part.name, input: part.input };
    case "tool_result":
      return { type: "tool_result", name: part.name, output: part.content, error: part.isError };
    case "image":
      return { type: "text", text: "[image]" };
  }
}

export type { ConvertSessionInput, HarnessType };
