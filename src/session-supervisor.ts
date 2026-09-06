import type { ContentPart, Conversation, ConversionResult, HarnessType, Message } from "session-convert";
import type {
  AgentSession,
  ControlResult,
  HarnessAdapter,
  HarnessEvent,
  SendMessageOptions,
  SessionDetails,
  SessionHistoryInfo,
  SessionLineage,
  SessionMessagePart,
  SessionMessageView,
} from "./types/index.js";
import { throwIfAborted } from "./abort-utils.js";
import { createNamedSession, newOrResumeNamedSession, type NamedSessionRequest, type NamedSessionResult, type NewOrResumeNamedSessionRequest } from "./named-session.js";
import { getHarnessCapabilities } from "./types/index.js";
import type { AgentHerderSessionConverter, ConvertSessionInput } from "./session-convert.js";
import { LineageStore, type LineageRecord } from "./lineage-store.js";
import { ModelsDevPricing } from "./model-pricing.js";
import { coordinationNotes } from "./coordination-notes.js";
import { herderEvents, type HerderEventBus } from "./herder-events.js";
import { adapterResourceUri, sessionMessagesResourceUri, sessionResourceUri } from "./herder-resource-uris.js";
import { harnessEventHealth, type HarnessEventHealthRegistry } from "./harness-event-health.js";

export interface SessionFilters {
  harness?: string;
  status?: string;
  cwd?: string;
}

export interface SessionDetailOptions {
  limit?: number;
  history?: "auto" | "acp" | "files";
  /** Fast first paint: use the cached lightweight session and skip expensive enrichment/children. */
  quick?: boolean;
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
  /** Domain event sink used by MCP resources, Web UI and other observers. */
  events?: HerderEventBus;
  /** Shared native-event health registry. */
  eventHealth?: HarnessEventHealthRegistry;
}

interface SessionSnapshot {
  sessions: AgentSession[];
  refreshedAt: number;
}

export interface HarnessModelCache {
  harness: string;
  models: string[];
  refreshedAt: string | null;
  stale: boolean;
  refreshing: boolean;
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
  private readonly modelCacheTtlMs = 15 * 60_000;
  private readonly modelCache = new Map<string, { models: string[]; refreshedAt: number }>();
  private readonly modelRefreshes = new Map<string, Promise<void>>();
  private readonly pricing = new ModelsDevPricing();
  private readonly events: HerderEventBus;
  private readonly eventHealth: HarnessEventHealthRegistry;
  private observationTimer?: NodeJS.Timeout;
  private readonly nativeEventUnsubscribers = new Map<string, () => void>();
  private readonly recentNativeEvents = new Map<string, number>();

  constructor(
    private readonly adapters: Map<string, HarnessAdapter>,
    private readonly converter: Pick<AgentHerderSessionConverter, "convert"> & Partial<Pick<AgentHerderSessionConverter, "read">>,
    private readonly lineage = new LineageStore(defaultLineagePath()),
    options: SessionSupervisorOptions = {},
  ) {
    this.sessionCacheTtlMs = Math.max(0, options.sessionCacheTtlMs ?? 10_000);
    this.events = options.events ?? herderEvents;
    this.eventHealth = options.eventHealth ?? harnessEventHealth;
  }

  async createNamedSession(request: NamedSessionRequest): Promise<NamedSessionResult> {
    const result = await createNamedSession(this.adapters, request);
    if (result.ok && result.sessionId) this.publishSessionChanged(result.harness, result.sessionId, "created");
    return result;
  }

  async newOrResumeNamedSession(request: NewOrResumeNamedSessionRequest): Promise<NamedSessionResult> {
    const result = await newOrResumeNamedSession(this.adapters, request);
    if (result.ok && result.sessionId) this.publishSessionChanged(result.harness, result.sessionId, result.created ? "created" : "changed");
    return result;
  }

  /** Observe native harness events immediately while keeping snapshot polling as a correctness fallback. */
  startObservation(intervalMs = 5_000): () => void {
    this.stopObservation();
    this.ensureNativeSubscriptions();
    const bounded = Math.max(1_000, intervalMs);
    const tick = () => {
      this.ensureNativeSubscriptions();
      void this.refreshSessionSnapshot().catch(() => undefined);
    };
    this.observationTimer = setInterval(tick, bounded);
    this.observationTimer.unref?.();
    tick();
    return () => this.stopObservation();
  }

  stopObservation(): void {
    if (this.observationTimer) clearInterval(this.observationTimer);
    this.observationTimer = undefined;
    for (const unsubscribe of this.nativeEventUnsubscribers.values()) {
      try { unsubscribe(); } catch { /* best-effort adapter cleanup */ }
    }
    this.nativeEventUnsubscribers.clear();
  }

  getExecutionProfile(harness: string): Record<string, string> | undefined {
    return this.adapters.get(harness)?.getExecutionProfile?.();
  }

  getEventSources(): Array<{ harness: string; mode: "native" | "polling"; connected: boolean; lastEventAt?: string; reconnects: number; lastError?: string }> {
    return this.eventHealth.list();
  }

  listSessionsFast(filters: SessionFilters = {}): { sessions: AgentSession[]; warming: boolean } {
    if (this.sessionSnapshot) {
      if (Date.now() - this.sessionSnapshot.refreshedAt >= this.sessionCacheTtlMs) void this.refreshSessionSnapshot().catch(() => undefined);
      return { sessions: this.filterSessions(this.sessionSnapshot.sessions, filters), warming: Boolean(this.sessionRefresh) };
    }
    void this.refreshSessionSnapshot().catch(() => undefined);
    return { sessions: [], warming: true };
  }

  async refreshSessions(filters: SessionFilters = {}): Promise<AgentSession[]> {
    await this.refreshSessionSnapshot();
    return this.filterSessions(this.sessionSnapshot?.sessions ?? [], filters);
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
    const previous = this.sessionSnapshot?.sessions;
    this.sessionRefresh = this.readSessionSnapshot()
      .then((sessions) => {
        this.seedModelCacheFromSessions(sessions);
        this.sessionSnapshot = { sessions, refreshedAt: Date.now() };
        if (previous) this.publishSnapshotDiff(previous, sessions);
        this.refreshStaleModelCaches();
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

  async getModels(harness: string): Promise<HarnessModelCache> {
    if (!this.sessionSnapshot) await this.listSessions();
    const cached = this.modelCache.get(harness);
    const stale = !cached || Date.now() - cached.refreshedAt >= this.modelCacheTtlMs;
    if (stale) void this.refreshModels(harness).catch(() => undefined);
    const current = this.modelCache.get(harness);
    return {
      harness,
      models: current?.models ?? [],
      refreshedAt: current ? new Date(current.refreshedAt).toISOString() : null,
      stale,
      refreshing: this.modelRefreshes.has(harness),
    };
  }

  private refreshStaleModelCaches(): void {
    const now = Date.now();
    for (const [harness, adapter] of this.adapters) {
      if (!adapter.listModels) continue;
      const cached = this.modelCache.get(harness);
      if (!cached || now - cached.refreshedAt >= this.modelCacheTtlMs) {
        void this.refreshModels(harness).catch(() => undefined);
      }
    }
  }

  private refreshModels(harness: string): Promise<void> {
    const existing = this.modelRefreshes.get(harness);
    if (existing) return existing;
    const adapter = this.adapters.get(harness);
    if (!adapter?.listModels) return Promise.resolve();
    const refresh = adapter.listModels()
      .then((nativeModels) => {
        const cached = this.modelCache.get(harness)?.models ?? [];
        const models = [...new Set([...cached, ...nativeModels.filter(Boolean)])];
        this.modelCache.set(harness, { models, refreshedAt: Date.now() });
      })
      .finally(() => { this.modelRefreshes.delete(harness); });
    this.modelRefreshes.set(harness, refresh);
    return refresh;
  }

  private seedModelCacheFromSessions(sessions: AgentSession[]): void {
    const grouped = new Map<string, Array<{ model: string; at: number }>>();
    for (const session of sessions) {
      const model = session.model?.trim();
      if (!model || (model.startsWith("<") && model.endsWith(">"))) continue;
      const at = Date.parse(session.lastActivity);
      const rows = grouped.get(session.harness) ?? [];
      rows.push({ model, at: Number.isFinite(at) ? at : 0 });
      grouped.set(session.harness, rows);
    }
    for (const [harness, rows] of grouped) {
      rows.sort((a, b) => b.at - a.at);
      const historical = [...new Set(rows.map((row) => row.model))];
      const cached = this.modelCache.get(harness);
      this.modelCache.set(harness, {
        models: [...new Set([...historical, ...(cached?.models ?? [])])],
        refreshedAt: cached?.refreshedAt ?? 0,
      });
    }
  }

  async sendMessage(harness: string, id: string, options: SendMessageOptions): Promise<{ ok: boolean; error?: string }> {
    const adapter = this.requireAdapter(harness);
    const session = await adapter.getSession(id);
    const message = session ? await coordinationNotes.inject(session, options.message) : options.message;
    const result = await adapter.sendMessage(id, { ...options, message });
    if (result.ok) this.publishSessionChanged(harness, id, "changed");
    return result;
  }

  async changeModel(harness: string, id: string, model: string): Promise<ControlResult> {
    const adapter = this.requireAdapter(harness);
    const result = adapter.changeModel
      ? await adapter.changeModel(id, model)
      : { ok: false, error: `${adapter.name} does not expose model switching` };
    if (result.ok) this.publishSessionChanged(harness, id, "changed");
    return result;
  }

  async stopSession(harness: string, id: string): Promise<{ ok: boolean; error?: string }> {
    const result = await this.requireAdapter(harness).stopSession(id);
    if (result.ok) this.publishSessionChanged(harness, id, "changed");
    return result;
  }

  async cancelTurn(harness: string, id: string): Promise<{ ok: boolean; error?: string }> {
    const adapter = this.requireAdapter(harness);
    const result = adapter.cancelTurn
      ? await adapter.cancelTurn(id)
      : { ok: false, error: `${adapter.name} does not expose native turn cancellation` };
    if (result.ok) this.publishSessionChanged(harness, id, "changed");
    return result;
  }

  async recoverSession(harness: string, id: string, message?: string, signal?: AbortSignal): Promise<{ ok: boolean; error?: string; sessionId?: string }> {
    throwIfAborted(signal);
    const adapter = this.requireAdapter(harness);
    let cancelling = false;
    const cancelNative = async (sessionId: string) => {
      if (adapter.cancelTurn) await adapter.cancelTurn(sessionId);
      else await adapter.stopSession(sessionId);
    };
    const onAbort = () => {
      cancelling = true;
      void cancelNative(id).catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let result: ControlResult;
    try {
      result = await (adapter.recover
        ? adapter.recover(id, message, signal)
        : Promise.resolve({ ok: false, error: `${adapter.name} does not expose native recovery` }));
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    if (signal?.aborted || cancelling) {
      if (result?.sessionId && result.sessionId !== id) await cancelNative(result.sessionId).catch(() => undefined);
      throwIfAborted(signal);
    }
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
    if (result.ok) this.publishSessionChanged(harness, result.sessionId || id, result.sessionId ? "created" : "changed");
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
    if (resolved.ok) this.publishSessionChanged(harness, resolved.sessionId || id, resolved.sessionId ? "created" : "changed");
    return resolved;
  }

  async respondPermission(
    harness: string,
    id: string,
    permissionId: string,
    response: "allow" | "deny",
  ): Promise<{ ok: boolean; error?: string }> {
    const result = await this.requireAdapter(harness).respondPermission(id, permissionId, response);
    if (result.ok) this.publishSessionChanged(harness, id, "changed");
    return result;
  }

  async resumeSession(harness: string, id: string, message?: string): Promise<{ ok: boolean; error?: string }> {
    const adapter = this.requireAdapter(harness);
    if (adapter.resumeSession) {
      const resumed = await adapter.resumeSession(id);
      if (!resumed.ok || !message) {
        if (resumed.ok) this.publishSessionChanged(harness, id, "changed");
        return resumed;
      }
    }
    if (!message) return { ok: false, error: `${adapter.name} does not expose a native resume operation` };
    const session = await adapter.getSession(id);
    const injected = session ? await coordinationNotes.inject(session, message) : message;
    const result = await adapter.sendMessage(id, { message: injected });
    if (result.ok) this.publishSessionChanged(harness, id, "changed");
    return result;
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
    const cachedSessions = (provider === "codex" || options.quick) ? await this.listSessions({ harness: provider }) : undefined;
    const cachedSession = cachedSessions?.find((candidate) => candidate.id === id || nativeSessionId(candidate) === id);
    // Quick details deliberately start from the cached session snapshot. This
    // lets the UI paint the latest messages first while rich metrics hydrate later.
    const rawSession = options.quick
      ? cachedSession || await this.getSession(provider, id)
      : await this.getSession(provider, id) || cachedSession;
    if (!rawSession) throw new SessionNotFoundError(provider, id);
    const session = options.quick ? rawSession : await this.pricing.enrich(rawSession);
    const limit = Math.max(1, Math.min(options.limit || 3, 50));
    const record = await this.lineage.get(sessionKey(provider, nativeSessionId(session)));
    const nativeParentId = typeof session.meta?.parentThreadId === "string" && session.meta.parentThreadId !== nativeSessionId(session) ? session.meta.parentThreadId : undefined;
    const nativeRole = typeof session.meta?.agentRole === "string" ? session.meta.agentRole : undefined;
    const parentKey = record?.parentKey || (provider === "codex" && nativeParentId ? sessionKey(provider, nativeParentId) : undefined);
    const lineage: SessionLineage = record
      ? { kind: parentKey ? "subagent" : "root", parentId: parentKey, role: record.role, task: record.task }
      : parentKey ? { kind: "subagent", parentId: parentKey, role: nativeRole } : { kind: "external" };
    const childRecords = options.quick ? [] : await this.lineage.children(sessionKey(provider, id));
    const nativeChildren = !options.quick && provider === "codex"
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

  private publishSnapshotDiff(previous: AgentSession[], current: AgentSession[]): void {
    const before = new Map(previous.map((session) => [`${session.harness}:${session.id}`, session]));
    const after = new Map(current.map((session) => [`${session.harness}:${session.id}`, session]));
    let changed = false;
    for (const [key, session] of after) {
      const old = before.get(key);
      if (!old) {
        if (!this.wasRecentlyNative(session.harness, session.id)) { this.publishSessionChanged(session.harness, session.id, "created", false, "poll"); changed = true; }
        continue;
      }
      if (sessionFingerprint(old) !== sessionFingerprint(session)) {
        if (!this.wasRecentlyNative(session.harness, session.id)) { this.publishSessionChanged(session.harness, session.id, "changed", false, "poll"); changed = true; }
      }
    }
    for (const [key, session] of before) {
      if (after.has(key)) continue;
      if (!this.wasRecentlyNative(session.harness, session.id)) {
        this.publishSessionChanged(session.harness, session.id, "deleted", false, "poll");
        changed = true;
      }
    }
    if (changed) this.events.publish({ kind: "sessions", uri: "herder://sessions", action: "changed", source: "poll" });
  }

  private publishSessionChanged(harness: string, id: string, action: "created" | "changed" | "deleted", includeRoot = true, source = "supervisor"): void {
    if (this.sessionSnapshot) this.sessionSnapshot.refreshedAt = 0;
    if (includeRoot) this.events.publish({ kind: "sessions", uri: "herder://sessions", action: "changed", id, source });
    this.events.publish({ kind: "sessions", uri: sessionResourceUri(harness, id), action, id, source });
    this.events.publish({ kind: "sessions", uri: sessionMessagesResourceUri(harness, id), action: "changed", id, source });
  }

  private ensureNativeSubscriptions(): void {
    for (const [provider, unsubscribe] of [...this.nativeEventUnsubscribers.entries()]) {
      if (!this.adapters.has(provider) || !this.adapters.get(provider)?.subscribeEvents) {
        try { unsubscribe(); } catch { /* best effort */ }
        this.nativeEventUnsubscribers.delete(provider);
      }
    }
    for (const [provider, adapter] of this.adapters) {
      if (!adapter.subscribeEvents) { this.eventHealth.setMode(provider, "polling"); continue; }
      this.eventHealth.setMode(provider, "native");
      if (this.nativeEventUnsubscribers.has(provider)) continue;
      const unsubscribe = adapter.subscribeEvents((event) => this.handleHarnessEvent(provider, event));
      this.nativeEventUnsubscribers.set(provider, unsubscribe);
    }
  }

  private handleHarnessEvent(provider: string, event: HarnessEvent): void {
    const at = event.at ?? new Date().toISOString();
    if (event.kind === "process.disconnected") {
      this.eventHealth.disconnected(provider, typeof event.data?.error === "string" ? event.data.error : undefined);
    } else {
      this.eventHealth.connected(provider);
      this.eventHealth.event(provider, at);
    }
    this.events.publish({ kind: "adapters", uri: "herder://adapters", action: "changed", id: provider, source: `native:${provider}` });
    this.events.publish({ kind: "adapters", uri: adapterResourceUri(provider), action: "changed", id: provider, source: `native:${provider}` });
    if (!event.sessionId) return;

    this.recentNativeEvents.set(`${event.harness}:${event.sessionId}`, Date.now());
    const source = `native:${provider}:${event.nativeType || event.kind}`;
    const action = event.kind === "session.created" ? "created" : event.kind === "session.deleted" ? "deleted" : "changed";
    this.events.publish({ kind: "sessions", uri: "herder://sessions", action: "changed", id: event.sessionId, source });
    this.events.publish({ kind: "sessions", uri: sessionResourceUri(event.harness, event.sessionId), action, id: event.sessionId, source });
    if (event.kind === "message.updated" || event.kind === "turn.completed" || event.kind === "turn.failed") {
      this.events.publish({ kind: "sessions", uri: sessionMessagesResourceUri(event.harness, event.sessionId), action: "changed", id: event.sessionId, source });
    }
    if (this.sessionSnapshot) this.sessionSnapshot.refreshedAt = 0;
  }

  private wasRecentlyNative(harness: string, id: string): boolean {
    const key = `${harness}:${id}`;
    const at = this.recentNativeEvents.get(key);
    if (!at) return false;
    if (Date.now() - at > 7_500) { this.recentNativeEvents.delete(key); return false; }
    return true;
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

function sessionFingerprint(session: AgentSession): string {
  return JSON.stringify([
    session.status, session.title, session.cwd, session.lastActivity, session.model, session.needsPermission,
    session.messageCount, session.lastMessage, session.permissionDetails,
  ]);
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
