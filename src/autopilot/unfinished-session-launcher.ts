import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, normalize } from "node:path";

import type { AgentSession, HarnessAdapter, HarnessEvent, HarnessType, SessionMessageView } from "../types/index.js";
import { continuationModelFor, semanticTranscript, type CacheHandoffService } from "../cache-handoff.js";
import { deferredMessages, isBusyCodexWriter, type DeferredMessageStore } from "../deferred-messages.js";

const SUPPORTED_HARNESSES: readonly HarnessType[] = ["codex", "opencode", "claude", "qoder", "hermes", "zcode", "fast-agent", "chatgpt"];
const DEFAULT_CONTINUATION = "Продолжи незавершённую задачу с того места, где выполнение было прервано. Сначала проверь текущее состояние и не повторяй уже завершённые действия.";
const MAX_TEXT = 1_024;

export type UnfinishedSessionState = "active" | "recovering" | "exhausted";

export type SessionAutostartOverride = {
  harness: HarnessType;
  sessionId: string;
  cwd: string;
  enabled: boolean;
  updatedAt: string;
};

export type SessionAutostartHarnessOverride = {
  harness: HarnessType;
  enabled: boolean;
  updatedAt: string;
};

export type SessionAutostartFile = {
  version: 3;
  enabled: boolean;
  inventoryWindowHours: number;
  evidenceMessageCount: number;
  judgeModel: string;
  autopilotJudgeModel: string;
  harnesses: SessionAutostartHarnessOverride[];
  sessions: SessionAutostartOverride[];
};

/** Independent opt-out setting for restart continuation; it does not read autopilot policy. */
export class SessionAutostartStore {
  private operation: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string, private readonly env: NodeJS.ProcessEnv = process.env) {}

  async getSettings(): Promise<SessionAutostartFile & { source: "persisted" | "default" }> {
    const loaded = await this.readOptional();
    return loaded
      ? { ...cloneAutostartFile(loaded), source: "persisted" }
      : { ...defaultAutostartFile(this.env), source: "default" };
  }

  async getEffective(harness: string, sessionId: string, cwd: string): Promise<{ enabled: boolean; source: "session" | "harness" | "global" | "default"; cwd: string; updatedAt?: string }> {
    const normalizedHarness = harnessType(harness);
    const settings = await this.getSettings();
    const override = settings.sessions.find((record) => record.harness === normalizedHarness && record.sessionId === bounded(sessionId, "sessionId"));
    if (override) return { enabled: override.enabled, source: "session", cwd: override.cwd, updatedAt: override.updatedAt };
    const harnessOverride = settings.harnesses.find((record) => record.harness === normalizedHarness);
    return harnessOverride
      ? { enabled: harnessOverride.enabled, source: "harness", cwd: normalize(bounded(cwd, "cwd")), updatedAt: harnessOverride.updatedAt }
      : { enabled: settings.enabled, source: settings.source === "persisted" ? "global" : "default", cwd: normalize(bounded(cwd, "cwd")) };
  }

  async setGlobal(enabled: boolean): Promise<SessionAutostartFile> {
    return this.mutate((file) => { file.enabled = enabled; return cloneAutostartFile(file); });
  }

  async setRuntimeSettings(input: { inventoryWindowHours: number; evidenceMessageCount: number; judgeModel: string; autopilotJudgeModel: string }): Promise<SessionAutostartFile> {
    const inventoryWindowHours = positiveInteger(input.inventoryWindowHours, -1);
    if (inventoryWindowHours < 1 || inventoryWindowHours > 24 * 90) throw new Error("inventoryWindowHours must be an integer from 1 to 2160");
    const evidenceMessageCount = positiveInteger(input.evidenceMessageCount, -1);
    if (evidenceMessageCount < 2 || evidenceMessageCount > 50) throw new Error("evidenceMessageCount must be an integer from 2 to 50");
    const judgeModel = boundedText(input.judgeModel, "judgeModel", 256).trim();
    const autopilotJudgeModel = boundedText(input.autopilotJudgeModel, "autopilotJudgeModel", 256).trim();
    if (!judgeModel || !autopilotJudgeModel) throw new Error("judge models must not be empty");
    return this.mutate((file) => {
      file.inventoryWindowHours = inventoryWindowHours;
      file.evidenceMessageCount = evidenceMessageCount;
      file.judgeModel = judgeModel;
      file.autopilotJudgeModel = autopilotJudgeModel;
      return cloneAutostartFile(file);
    });
  }

  async getHarnessEffective(harness: string): Promise<{ enabled: boolean; source: "harness" | "global" | "default"; updatedAt?: string }> {
    const normalizedHarness = harnessType(harness);
    const settings = await this.getSettings();
    const override = settings.harnesses.find((record) => record.harness === normalizedHarness);
    return override
      ? { enabled: override.enabled, source: "harness", updatedAt: override.updatedAt }
      : { enabled: settings.enabled, source: settings.source === "persisted" ? "global" : "default" };
  }

  async setHarness(harness: string, enabled: boolean, now = new Date()): Promise<SessionAutostartHarnessOverride> {
    const normalized: SessionAutostartHarnessOverride = {
      harness: harnessType(harness),
      enabled,
      updatedAt: now.toISOString(),
    };
    return this.mutate((file) => {
      const index = file.harnesses.findIndex((record) => record.harness === normalized.harness);
      if (index < 0) file.harnesses.push(normalized);
      else file.harnesses[index] = normalized;
      file.harnesses.sort((left, right) => left.harness.localeCompare(right.harness));
      return { ...normalized };
    });
  }

  async deleteHarness(harness: string): Promise<boolean> {
    return this.mutate((file) => {
      const normalizedHarness = harnessType(harness);
      const before = file.harnesses.length;
      file.harnesses = file.harnesses.filter((record) => record.harness !== normalizedHarness);
      return file.harnesses.length !== before;
    });
  }

  async setSession(target: { harness: string; sessionId: string; cwd: string }, enabled: boolean, now = new Date()): Promise<SessionAutostartOverride> {
    const normalized: SessionAutostartOverride = {
      harness: harnessType(target.harness),
      sessionId: bounded(target.sessionId, "sessionId"),
      cwd: normalize(bounded(target.cwd, "cwd")),
      enabled,
      updatedAt: now.toISOString(),
    };
    return this.mutate((file) => {
      const key = sessionKey(normalized.harness, normalized.sessionId);
      const index = file.sessions.findIndex((record) => sessionKey(record.harness, record.sessionId) === key);
      if (index < 0) file.sessions.push(normalized);
      else file.sessions[index] = normalized;
      file.sessions.sort((left, right) => sessionKey(left.harness, left.sessionId).localeCompare(sessionKey(right.harness, right.sessionId)));
      return { ...normalized };
    });
  }

  async deleteSession(harness: string, sessionId: string): Promise<boolean> {
    return this.mutate((file) => {
      const key = sessionKey(harnessType(harness), sessionId);
      const before = file.sessions.length;
      file.sessions = file.sessions.filter((record) => sessionKey(record.harness, record.sessionId) !== key);
      return file.sessions.length !== before;
    });
  }

  private async readOptional(): Promise<SessionAutostartFile | null> {
    try {
      return parseAutostartFile(JSON.parse(await readFile(this.path, "utf8")) as unknown, this.env);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async mutate<T>(operation: (file: SessionAutostartFile) => T | Promise<T>): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const file = await this.readOptional() ?? defaultAutostartFile(this.env);
      const result = await operation(file);
      await atomicWrite(this.path, file);
      return result;
    } finally {
      release();
    }
  }
}

export interface UnfinishedSessionRecord {
  harness: HarnessType;
  sessionId: string;
  cwd: string;
  model?: string;
  title?: string;
  startedAt: string;
  updatedAt: string;
  generationId: string;
  attempts: number;
  state: UnfinishedSessionState;
  nextAttemptAt?: string;
  lastError?: string;
  notifiedAt?: string;
}

export type SessionCompletionVerdict = "completed" | "unfinished" | "needs_human";

export interface SessionInventoryVerdict {
  verdict: SessionCompletionVerdict;
  reason: string;
  confidence: number;
  judgedAt: string;
}

export interface UnfinishedSessionInventoryRecord {
  harness: "codex" | "zcode" | "opencode" | "fast-agent";
  sessionId: string;
  cwd: string;
  title: string;
  status: AgentSession["status"];
  lastActivity: string;
  transcriptTail: string;
  observedAt: string;
  verdict?: SessionInventoryVerdict;
}

export interface SessionCompletionJudge {
  decide(input: { session: AgentSession; transcriptTail: string }): Promise<Omit<SessionInventoryVerdict, "judgedAt">>;
  plan?(input: { sessions: SessionBatchCandidate[] }): Promise<SessionBatchPlan>;
}

export interface SessionBatchCandidate {
  session: AgentSession;
  transcriptTail: string;
}

export interface SessionBatchPlanGroup {
  sourceSessionIds: string[];
  primarySessionId: string;
  verdict: SessionCompletionVerdict;
  reason: string;
  confidence: number;
  topic: string;
  handoff: string;
}

export interface SessionBatchPlan {
  groups: SessionBatchPlanGroup[];
}

type AssessedSession = SessionBatchCandidate & { adapter: HarnessAdapter };

type UnfinishedSessionFile = {
  version: 1;
  sessions: UnfinishedSessionRecord[];
  inventory?: UnfinishedSessionInventoryRecord[];
};

export interface UnfinishedSessionNotice {
  title: string;
  body: string;
  dedupKey: string;
  correlationId: string;
  sourceId: string;
  signalType: string;
}

/** Durable, process-independent list of autopilot turns that have not completed. */
export class UnfinishedSessionStore {
  private operation: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  async list(): Promise<UnfinishedSessionRecord[]> {
    return (await this.read()).sessions.map((record) => ({ ...record }));
  }

  async listInventory(): Promise<UnfinishedSessionInventoryRecord[]> {
    return (await this.read()).inventory?.map(cloneInventoryRecord) ?? [];
  }

  async upsertInventory(record: UnfinishedSessionInventoryRecord): Promise<void> {
    await this.upsertInventoryBatch([record]);
  }

  async upsertInventoryBatch(records: UnfinishedSessionInventoryRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.mutate((file) => {
      const inventory = file.inventory ??= [];
      const positions = new Map(inventory.map((candidate, index) => [sessionKey(candidate.harness, candidate.sessionId), index]));
      for (const record of records) {
        const key = sessionKey(record.harness, record.sessionId);
        const index = positions.get(key);
        if (index === undefined) {
          positions.set(key, inventory.length);
          inventory.push(cloneInventoryRecord(record));
        } else inventory[index] = cloneInventoryRecord(record);
      }
      inventory.sort((left, right) => Date.parse(right.lastActivity) - Date.parse(left.lastActivity));
    });
  }

  async markStarted(session: AgentSession, generationId = "external", now = new Date()): Promise<UnfinishedSessionRecord> {
    const harness = harnessType(session.harness);
    const normalized = normalizeRecordTarget({
      harness,
      sessionId: session.id,
      cwd: session.cwd,
      model: session.model,
      title: session.title,
    });
    return this.mutate((file) => {
      const key = sessionKey(harness, session.id);
      const index = file.sessions.findIndex((record) => sessionKey(record.harness, record.sessionId) === key);
      const existing = index >= 0 ? file.sessions[index] : undefined;
      const reset = existing?.state === "exhausted";
      const record: UnfinishedSessionRecord = {
        ...normalized,
        startedAt: reset || !existing ? now.toISOString() : existing.startedAt,
        updatedAt: now.toISOString(),
        generationId: bounded(generationId, "generationId"),
        attempts: reset ? 0 : existing?.attempts ?? 0,
        state: "active",
      };
      if (index < 0) file.sessions.push(record);
      else file.sessions[index] = record;
      sortRecords(file.sessions);
      return { ...record };
    });
  }

  async remove(harness: string, sessionId: string): Promise<boolean> {
    return this.mutate((file) => {
      const key = sessionKey(harnessType(harness), sessionId);
      const before = file.sessions.length;
      file.sessions = file.sessions.filter((record) => sessionKey(record.harness, record.sessionId) !== key);
      return file.sessions.length !== before;
    }, (changed) => changed);
  }

  async beginAttempt(
    harness: HarnessType,
    sessionId: string,
    maxAttempts: number,
    retryDelayMs: number,
    now = new Date(),
  ): Promise<UnfinishedSessionRecord | null> {
    return this.mutate((file) => {
      const record = file.sessions.find((candidate) => candidate.harness === harness && candidate.sessionId === sessionId);
      if (!record || record.state === "exhausted" || record.attempts >= maxAttempts) return null;
      if (record.nextAttemptAt && Date.parse(record.nextAttemptAt) > now.getTime()) return null;
      record.attempts += 1;
      record.state = "recovering";
      record.updatedAt = now.toISOString();
      record.nextAttemptAt = new Date(now.getTime() + retryDelayMs * (2 ** (record.attempts - 1))).toISOString();
      delete record.lastError;
      return { ...record };
    }, (record) => record !== null);
  }

  async markFailure(
    harness: HarnessType,
    sessionId: string,
    error: string,
    maxAttempts: number,
    now = new Date(),
  ): Promise<UnfinishedSessionRecord | null> {
    return this.mutate((file) => {
      const record = file.sessions.find((candidate) => candidate.harness === harness && candidate.sessionId === sessionId);
      if (!record) return null;
      record.state = record.attempts >= maxAttempts ? "exhausted" : "active";
      record.lastError = bounded(error, "error");
      record.updatedAt = now.toISOString();
      return { ...record };
    }, (record) => record !== null);
  }

  async markNotified(harness: HarnessType, sessionId: string, now = new Date()): Promise<void> {
    await this.mutate((file) => {
      const record = file.sessions.find((candidate) => candidate.harness === harness && candidate.sessionId === sessionId);
      if (record) {
        record.notifiedAt = now.toISOString();
        record.updatedAt = now.toISOString();
      }
    });
  }

  private async read(): Promise<UnfinishedSessionFile> {
    try {
      return parseFile(JSON.parse(await readFile(this.path, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, sessions: [] };
      throw error;
    }
  }

  private async mutate<T>(operation: (file: UnfinishedSessionFile) => T | Promise<T>, shouldWrite: (result: T) => boolean = () => true): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const file = await this.read();
      const result = await operation(file);
      if (shouldWrite(result)) {
        await mkdir(dirname(this.path), { recursive: true });
        await atomicWrite(this.path, file);
      }
      return result;
    } finally {
      release();
    }
  }
}

export interface UnfinishedSessionLauncherOptions {
  adapters: Map<string, HarnessAdapter>;
  store: UnfinishedSessionStore;
  settingsStore: SessionAutostartStore;
  maxAttempts?: number;
  retryDelayMs?: number;
  reconcileIntervalMs?: number;
  inventoryWindowMs?: number;
  discoveryIdleMs?: number;
  maxJudgementsPerCycle?: number;
  maxResumesPerCycle?: number;
  judge?: SessionCompletionJudge;
  continuationMessage?: string;
  notify?: (notice: UnfinishedSessionNotice) => Promise<void>;
  /** Durable safe-boundary inbox used when a Codex Desktop writer still owns the thread. */
  deferredStore?: Pick<DeferredMessageStore, "add" | "list">;
  /** Replaces a stale provider-cache session with a compact same-harness continuation. */
  cacheHandoff?: Pick<CacheHandoffService, "maybeRollover">;
  /** Stable only for one Agent Herder process; tests may inject it. */
  generationId?: string;
}

/** Reconciles durable unfinished turns for the lifetime of the Agent Herder process. */
export class UnfinishedSessionLauncher {
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly reconcileIntervalMs: number;
  private readonly discoveryIdleMs: number;
  private readonly maxJudgementsPerCycle: number;
  private readonly maxResumesPerCycle: number;
  private readonly continuationMessage: string;
  private readonly generationId: string;
  private recovering: Promise<void> | null = null;
  private retryTimer?: NodeJS.Timeout;
  private started = false;
  private readonly completedSessions = new Set<string>();

  constructor(private readonly options: UnfinishedSessionLauncherOptions) {
    this.maxAttempts = positiveInteger(options.maxAttempts ?? Number(process.env.AGENT_HERDER_AUTOSTART_MAX_ATTEMPTS || 3), 3);
    this.retryDelayMs = nonNegativeInteger(options.retryDelayMs ?? Number(process.env.AGENT_HERDER_AUTOSTART_RETRY_DELAY_MS || 5_000), 5_000);
    this.reconcileIntervalMs = positiveInteger(
      options.reconcileIntervalMs ?? Number(process.env.AGENT_HERDER_UNFINISHED_RECONCILE_INTERVAL_MS || 240_000),
      240_000,
    );
    this.discoveryIdleMs = positiveInteger(
      options.discoveryIdleMs ?? Number(process.env.AGENT_HERDER_UNFINISHED_DISCOVERY_IDLE_MS || 60_000),
      60_000,
    );
    this.maxJudgementsPerCycle = positiveInteger(
      options.maxJudgementsPerCycle ?? Number(process.env.AGENT_HERDER_UNFINISHED_JUDGEMENTS_PER_CYCLE || 20),
      20,
    );
    this.maxResumesPerCycle = positiveInteger(
      options.maxResumesPerCycle ?? Number(process.env.AGENT_HERDER_UNFINISHED_RESUMES_PER_CYCLE || 8),
      8,
    );
    this.continuationMessage = options.continuationMessage?.trim() || DEFAULT_CONTINUATION;
    this.generationId = options.generationId?.trim() || `process-${process.pid}-${randomUUID()}`;
  }

  async handleEvent(provider: string, event: HarnessEvent): Promise<void> {
    if (!event.sessionId || !isSupportedHarness(provider)) return;
    if (event.kind === "turn.completed" || event.kind === "session.deleted") {
      this.completedSessions.add(sessionKey(provider, event.sessionId));
      await this.options.store.remove(provider, event.sessionId);
      return;
    }
    if (event.kind !== "turn.started") return;
    const adapter = this.options.adapters.get(provider);
    const session = await adapter?.getSession(event.sessionId);
    if (session) await this.armSession(session);
  }

  async armSession(session: AgentSession): Promise<boolean> {
    if (!isSupportedHarness(session.harness)) return false;
    const adapter = this.options.adapters.get(session.harness);
    if (!adapter || (!adapter.resumeSession && session.harness !== "opencode")) return false;
    if (!await this.isEnabled(session.harness, session.id, session.cwd)) return false;
    this.completedSessions.delete(sessionKey(session.harness, session.id));
    await this.options.store.markStarted(session, this.generationId);
    return true;
  }

  async forget(harness: string, sessionId: string): Promise<void> {
    if (!isSupportedHarness(harness)) return;
    this.completedSessions.add(sessionKey(harness, sessionId));
    await this.options.store.remove(harness, sessionId);
  }

  /** Start process-lifetime recovery without delaying the HTTP/MCP control plane. */
  start(): () => void {
    this.started = true;
    void this.recoverPending().catch((error) => {
      console.error(`[agent-herder] автозапуск незавершённых сессий завершился ошибкой: ${errorText(error)}`);
    });
    return () => this.stop();
  }

  stop(): void {
    this.started = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  recoverPending(): Promise<void> {
    if (this.recovering) return this.recovering;
    this.recovering = this.runRecovery().finally(() => {
      this.recovering = null;
      if (this.started) void this.scheduleNextRecovery();
    });
    return this.recovering;
  }

  private async scheduleNextRecovery(): Promise<void> {
    if (!this.started) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    let pending: UnfinishedSessionRecord[] = [];
    try {
      pending = (await this.options.store.list()).filter((record) => record.state !== "exhausted" && record.nextAttemptAt);
    } catch (error) {
      console.error(`[agent-herder] не удалось прочитать реестр перед следующей сверкой: ${errorText(error)}`);
    }
    const now = Date.now();
    const retryDelay = pending.length === 0
      ? this.reconcileIntervalMs
      : Math.max(1, Math.min(...pending.map((record) => record.nextAttemptAt ? Date.parse(record.nextAttemptAt) - now : 0)));
    const delay = Math.max(1, Math.min(this.reconcileIntervalMs, retryDelay));
    if (!this.started) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.recoverPending().catch((error) => {
        console.error(`[agent-herder] повторный автозапуск завершился ошибкой: ${errorText(error)}`);
      });
    }, delay);
    this.retryTimer.unref?.();
  }

  private async runRecovery(): Promise<void> {
    if (!await this.discoverUnfinishedSessions()) return;
    // Deliberately sequential: a restart must not multiply the host's agent workload.
    let resumedThisCycle = 0;
    const launches: Array<Promise<void>> = [];
    const records = await this.options.store.list();
    records.sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
    for (const record of records) {
      if (!isAutocontinueInventoryHarness(record.harness)) continue;
      if (record.state === "exhausted") {
        await this.notifyExhausted(record);
        continue;
      }
      if (!await this.isEnabled(record.harness, record.sessionId, record.cwd)) {
        await this.options.store.remove(record.harness, record.sessionId);
        continue;
      }
      const adapter = this.options.adapters.get(record.harness);
      if (!adapter?.resumeSession) {
        await this.fail(record, `${displayHarness(record.harness)} не поддерживает возобновление сессии`);
        continue;
      }
      let session: AgentSession | null = null;
      try {
        session = await adapter.getSession(record.sessionId);
      } catch (error) {
        await this.fail(record, errorText(error));
        continue;
      }
      if (session?.status === "needs_input" || session?.needsPermission) {
        await this.options.store.markStarted(session, this.generationId);
        continue;
      }
      if (session?.status === "running") {
        await this.options.store.markStarted(session, this.generationId);
        continue;
      }
      if (record.generationId === this.generationId && Date.now() - Date.parse(record.updatedAt) < this.discoveryIdleMs) continue;
      if (resumedThisCycle >= this.maxResumesPerCycle) continue;
      const attempt = await this.options.store.beginAttempt(record.harness, record.sessionId, this.maxAttempts, this.retryDelayMs);
      if (!attempt) continue;
      resumedThisCycle += 1;
      launches.push(this.launchContinuation(adapter, record, attempt, session));
    }
    await Promise.all(launches);
  }

  private async launchContinuation(
    adapter: HarnessAdapter,
    record: UnfinishedSessionRecord,
    attempt: UnfinishedSessionRecord,
    session: AgentSession | null,
  ): Promise<void> {
    const trackedSession = session ?? {
      id: record.sessionId,
      harness: record.harness,
      status: "running" as const,
      title: record.title || "Незавершённая задача",
      cwd: record.cwd,
      lastActivity: new Date().toISOString(),
      model: record.model,
      needsPermission: false,
    };
    try {
      if (session && this.options.cacheHandoff) {
        const handoff = await this.options.cacheHandoff.maybeRollover(session);
        if (handoff.kind === "rolled_over" && handoff.session) {
          await this.options.store.remove(record.harness, record.sessionId);
          await this.options.store.markStarted(handoff.session, this.generationId);
          console.error(`[agent-herder] протухшая сессия ${record.harness}:${record.sessionId} продолжена в новой ${handoff.session.id}`);
          return;
        }
      }
      const resumed = adapter.resumeSession ? await adapter.resumeSession(record.sessionId) : { ok: true };
      if (!resumed.ok) throw new Error(resumed.error || "возобновление отклонено");
      const sent = await adapter.sendMessage(record.sessionId, { message: this.continuationMessage, queue: true });
      if (!sent.ok) throw new Error(sent.error || "команда продолжения отклонена");
      await this.options.store.markStarted(trackedSession, this.generationId);
      console.error(`[agent-herder] автоматически продолжена незавершённая сессия ${record.harness}:${record.sessionId}`);
    } catch (error) {
      const failure = errorText(error);
      if (isBusyCodexWriter(record.harness, failure)) {
        const inbox = this.options.deferredStore ?? deferredMessages;
        const pending = await inbox.list(record.sessionId);
        if (!pending.some((message) => message.message === this.continuationMessage)) {
          await inbox.add(record.sessionId, this.continuationMessage);
        }
        await this.options.store.markStarted(trackedSession, this.generationId);
        console.error(`[agent-herder] продолжение Codex отложено до безопасной границы хода ${record.sessionId}`);
        return;
      }
      await this.fail(attempt, failure);
    }
  }

  private async discoverUnfinishedSessions(): Promise<boolean> {
    const runtimeSettings = await this.options.settingsStore.getSettings();
    const inventoryWindowMs = this.options.inventoryWindowMs
      ?? runtimeSettings.inventoryWindowHours * 60 * 60 * 1_000;
    const known = new Set((await this.options.store.list()).map((record) => sessionKey(record.harness, record.sessionId)));
    const priorInventory = new Map((await this.options.store.listInventory()).map((record) => [sessionKey(record.harness, record.sessionId), record]));
    const candidates: Array<{ adapter: HarnessAdapter; session: AgentSession }> = [];
    const inventoryBatch: UnfinishedSessionInventoryRecord[] = [];
    for (const [provider, adapter] of this.options.adapters) {
      if (!isAutocontinueInventoryHarness(provider) || !adapter.resumeSession) continue;
      if ((provider === "codex" || provider === "zcode") && adapter.isReady && !adapter.isReady()) {
        try {
          await adapter.init();
        } catch (error) {
          console.error(`[agent-herder] не удалось подключить live-status ${displayHarness(provider)}: ${errorText(error)}`);
        }
      }
      let sessions: AgentSession[];
      try {
        sessions = await adapter.listSessions();
      } catch (error) {
        console.error(`[agent-herder] не удалось сверить ${displayHarness(provider)} сессии: ${errorText(error)}`);
        continue;
      }
      for (const session of sessions) {
        const lastActivity = Date.parse(session.lastActivity);
        if (!Number.isFinite(lastActivity) || Date.now() - lastActivity > inventoryWindowMs) continue;
        candidates.push({ adapter, session });
      }
    }
    candidates.sort((left, right) => Date.parse(right.session.lastActivity) - Date.parse(left.session.lastActivity));
    if (this.options.judge?.plan) {
      const assessed: AssessedSession[] = [];
      for (const { adapter, session } of candidates) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (!await this.isEnabled(session.harness, session.id, session.cwd)) continue;
        const previous = priorInventory.get(sessionKey(session.harness, session.id));
        const metadataUnchanged = previous?.lastActivity === session.lastActivity
          && previous.status === session.status
          && previous.cwd === session.cwd
          && previous.title === session.title;
        const settledAndUnchanged = metadataUnchanged && previous?.verdict && previous.verdict.confidence > 0
          && (previous.verdict.verdict === "completed"
            || previous.verdict.verdict === "needs_human"
            || (previous.verdict.verdict === "unfinished" && session.status === "running"));
        if (settledAndUnchanged) continue;
        const oldEnough = Date.now() - Date.parse(session.lastActivity) >= this.discoveryIdleMs;
        if (session.status === "running" || !oldEnough) continue;
        const messages = await adapter.getSessionMessages?.(session.id, Math.max(50, runtimeSettings.evidenceMessageCount * 3)).catch(() => null);
        const transcriptTail = completionEvidence(messages ?? [], runtimeSettings.evidenceMessageCount);
        const unchanged = metadataUnchanged && previous?.transcriptTail === transcriptTail;
        const actionable = !previous?.verdict
          || previous.verdict.confidence === 0
          || !unchanged
          || previous.verdict.verdict === "unfinished";
        if (actionable) assessed.push({ adapter, session, transcriptTail });
      }
      if (assessed.length > 0) {
        try {
          const plan = await this.options.judge.plan({ sessions: assessed.map(({ session, transcriptTail }) => ({ session, transcriptTail })) });
          await this.applyBatchPlan(plan, assessed);
          return true;
        } catch (error) {
          console.error(`[agent-herder] единый план MiniMax не построен; посессионный fallback запрещён: ${errorText(error)}`);
          return false;
        }
      }
      if (assessed.length === 0) return false;
    }
    let judgements = 0;
    const equivalentSessions = new Map<string, string>();
    for (const { adapter, session } of candidates) {
      // SQLite transcript reads and JSON parsing are local, but a large
      // 48-hour inventory must still yield so the control-plane HTTP server
      // remains responsive throughout reconciliation.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (!isAutocontinueInventoryHarness(session.harness)) continue;
      const harness = session.harness;
      const key = sessionKey(harness, session.id);
      const messages = await adapter.getSessionMessages?.(session.id, Math.max(50, runtimeSettings.evidenceMessageCount * 3)).catch(() => null);
      const transcriptTail = completionEvidence(messages ?? [], runtimeSettings.evidenceMessageCount);
      const previous = priorInventory.get(key);
      const unchanged = previous?.lastActivity === session.lastActivity && previous.transcriptTail === transcriptTail;
      const equivalentKey = `${harness}:${normalize(session.cwd)}:${session.title.trim().toLowerCase()}`;
      const newerEquivalent = equivalentSessions.get(equivalentKey);
      equivalentSessions.set(equivalentKey, newerEquivalent || session.id);
      let verdict = newerEquivalent
        ? { verdict: "completed" as const, reason: `Заменена более новой сессией с той же задачей: ${newerEquivalent}`, confidence: 0.95, judgedAt: new Date().toISOString() }
        : unchanged ? previous?.verdict : undefined;
      if (!newerEquivalent && this.completedSessions.has(key)) {
        verdict = { verdict: "completed", reason: "Harness reported turn completion", confidence: 1, judgedAt: new Date().toISOString() };
      } else if (!verdict && Date.now() - Date.parse(session.lastActivity) < this.discoveryIdleMs && session.status !== "running") {
        // Keep it visible in inventory, but do not classify a session which may
        // still be receiving events from another harness process.
      } else if (!verdict && transcriptTail && this.options.judge && judgements < this.maxJudgementsPerCycle) {
        judgements += 1;
        try {
          const judged = await this.options.judge.decide({ session, transcriptTail });
          verdict = { ...normalizeVerdict(judged), judgedAt: new Date().toISOString() };
        } catch (error) {
          console.error(`[agent-herder] MiniMax не классифицировал ${harness}:${session.id}: ${errorText(error)}`);
        }
      } else if (!verdict && !transcriptTail) {
        verdict = { verdict: "needs_human", reason: "Нет доступного хвоста диалога для безопасной классификации", confidence: 1, judgedAt: new Date().toISOString() };
      }
      if (!verdict && messages && (session.status === "running" || Date.now() - Date.parse(session.lastActivity) >= this.discoveryIdleMs)) {
        verdict = { ...heuristicVerdict(session, messages), judgedAt: new Date().toISOString() };
      }
      const inventory: UnfinishedSessionInventoryRecord = {
        harness,
        sessionId: session.id,
        cwd: session.cwd,
        title: session.title,
        status: session.status,
        lastActivity: session.lastActivity,
        transcriptTail,
        observedAt: new Date().toISOString(),
        ...(verdict ? { verdict } : {}),
      };
      inventoryBatch.push(inventory);
      if (verdict?.verdict !== "unfinished") {
        if (verdict) await this.options.store.remove(harness, session.id);
        known.delete(key);
        continue;
      }
      if (known.has(key) || !await this.isEnabled(harness, session.id, session.cwd)) continue;
      await this.options.store.markStarted(session, `judged-${this.generationId}`);
      known.add(key);
    }
    await this.options.store.upsertInventoryBatch(inventoryBatch);
    return true;
  }

  private async applyBatchPlan(plan: SessionBatchPlan, assessed: AssessedSession[]): Promise<void> {
    const byId = new Map(assessed.map((candidate) => [candidate.session.id, candidate]));
    const latestActivity = (group: SessionBatchPlanGroup): number => Math.max(...group.sourceSessionIds.map((id) => Date.parse(byId.get(id)!.session.lastActivity)));
    const groups = [...plan.groups].sort((left, right) => latestActivity(right) - latestActivity(left));
    const inventoryBatch: UnfinishedSessionInventoryRecord[] = [];
    let launched = 0;
    for (const group of groups) {
      const sources = group.sourceSessionIds.map((id) => byId.get(id)!);
      const plannedPrimary = byId.get(group.primarySessionId)!;
      const running = sources.filter(({ session }) => session.status === "running")
        .sort((left, right) => Date.parse(right.session.lastActivity) - Date.parse(left.session.lastActivity))[0];
      const primary = running ?? plannedPrimary;
      const judgedAt = new Date().toISOString();
      const verdict = { verdict: group.verdict, reason: group.reason, confidence: group.confidence, judgedAt } satisfies SessionInventoryVerdict;
      const pushInventory = (candidate: AssessedSession, override = verdict): void => {
        inventoryBatch.push({
          harness: candidate.session.harness as "codex" | "zcode",
          sessionId: candidate.session.id,
          cwd: candidate.session.cwd,
          title: candidate.session.title,
          status: candidate.session.status,
          lastActivity: candidate.session.lastActivity,
          transcriptTail: candidate.transcriptTail,
          observedAt: new Date().toISOString(),
          verdict: override,
        });
      };

      if (group.verdict !== "unfinished") {
        for (const source of sources) {
          pushInventory(source);
          await this.options.store.remove(source.session.harness, source.session.id);
        }
        continue;
      }

      const handoff = batchContinuationPrompt(group, sources);
      if (running) {
        if (sources.length > 1) {
          const pending = await deferredMessages.list(running.session.id);
          if (!pending.some((message) => message.message === handoff)) await deferredMessages.add(running.session.id, handoff);
        }
        await this.options.store.markStarted(running.session, this.generationId);
        for (const source of sources) {
          if (source.session.id === running.session.id) pushInventory(source);
          else {
            pushInventory(source, {
              verdict: "completed",
              reason: `Объединена с работающей сессией «${group.topic}»: ${running.session.id}`,
              confidence: group.confidence,
              judgedAt,
            });
            await this.options.settingsStore.setSession({ harness: source.session.harness, sessionId: source.session.id, cwd: source.session.cwd }, false);
            await this.options.store.remove(source.session.harness, source.session.id);
          }
        }
        continue;
      }

      const oldEnough = Date.now() - Date.parse(primary.session.lastActivity) >= this.discoveryIdleMs;
      if (!oldEnough || launched >= this.maxResumesPerCycle || !primary.adapter.createSession) {
        for (const source of sources) {
          pushInventory(source);
          await this.options.store.remove(source.session.harness, source.session.id);
        }
        continue;
      }

      try {
        launched += 1;
        const continuationModel = continuationModelFor(primary.session);
        const created = await primary.adapter.createSession({
          name: continuationTitle(group.topic),
          cwd: primary.session.cwd,
          model: continuationModel,
        });
        if (continuationModel && created.model !== continuationModel && primary.adapter.changeModel) {
          const selected = await primary.adapter.changeModel(created.id, continuationModel);
          if (!selected.ok) throw new Error(selected.error || `не удалось выбрать модель ${continuationModel}`);
        }
        const sent = await primary.adapter.sendMessage(created.id, { message: handoff, queue: true });
        if (!sent.ok) throw new Error(sent.error || "новая объединённая сессия не приняла handoff");
        await this.options.store.markStarted(created, this.generationId);
        for (const source of sources) {
          pushInventory(source, {
            verdict: "completed",
            reason: `Объединена в новую сессию «${continuationTitle(group.topic)}»: ${created.id}`,
            confidence: group.confidence,
            judgedAt,
          });
          await this.options.settingsStore.setSession({ harness: source.session.harness, sessionId: source.session.id, cwd: source.session.cwd }, false);
          await this.options.store.remove(source.session.harness, source.session.id);
        }
        console.error(`[agent-herder] единый план продолжил ${sources.length} сесс. как ${created.harness}:${created.id} «${continuationTitle(group.topic)}»`);
      } catch (error) {
        launched = Math.max(0, launched - 1);
        console.error(`[agent-herder] единый план не запустил «${group.topic}»: ${errorText(error)}`);
        for (const source of sources) {
          pushInventory(source);
          await this.options.store.remove(source.session.harness, source.session.id);
        }
      }
    }
    await this.options.store.upsertInventoryBatch(inventoryBatch);
  }

  private async fail(record: UnfinishedSessionRecord, error: string): Promise<void> {
    let attempted = record;
    if (record.state !== "recovering") {
      const begun = await this.options.store.beginAttempt(record.harness, record.sessionId, this.maxAttempts, this.retryDelayMs);
      if (!begun) return;
      attempted = begun;
    }
    const failed = await this.options.store.markFailure(record.harness, record.sessionId, error, this.maxAttempts);
    console.error(`[agent-herder] автозапуск ${attempted.attempts}/${this.maxAttempts} не удался для ${record.harness}:${record.sessionId}: ${error}`);
    if (failed?.state === "exhausted") await this.notifyExhausted(failed);
  }

  private async notifyExhausted(record: UnfinishedSessionRecord): Promise<void> {
    if (!this.options.notify || record.notifiedAt) return;
    const harness = displayHarness(record.harness);
    await this.options.notify({
      title: "Agent Herder не смог продолжить задачу",
      body: `${harness}: незавершённая сессия не запущена после ${record.attempts} попыток. Работа остановлена; откройте сессию и запустите продолжение вручную.`,
      dedupKey: `agent-herder:unfinished-session:${record.harness}:${record.sessionId}`,
      correlationId: `unfinished-${record.harness}-${record.sessionId}-${record.startedAt}`,
      sourceId: "agent-herder-autostart",
      signalType: "unfinished-session-autostart-failed",
    });
    await this.options.store.markNotified(record.harness, record.sessionId);
  }

  private async isEnabled(harness: HarnessType, sessionId: string, cwd: string): Promise<boolean> {
    return (await this.options.settingsStore.getEffective(harness, sessionId, cwd)).enabled;
  }
}

function parseAutostartFile(value: unknown, env: NodeJS.ProcessEnv = process.env): SessionAutostartFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("session autostart settings must be an object");
  const object = value as Record<string, unknown>;
  if ((object.version !== 1 && object.version !== 2 && object.version !== 3) || typeof object.enabled !== "boolean" || !Array.isArray(object.sessions)) throw new Error("invalid session autostart settings");
  const harnesses = object.version === 2 || object.version === 3 ? object.harnesses : [];
  if (!Array.isArray(harnesses)) throw new Error("invalid session autostart harness overrides");
  const defaults = defaultAutostartFile(env);
  return {
    version: 3,
    enabled: object.enabled,
    inventoryWindowHours: object.version === 3 ? runtimeHours(object.inventoryWindowHours) : defaults.inventoryWindowHours,
    evidenceMessageCount: object.version === 3 && object.evidenceMessageCount !== undefined ? evidenceCount(object.evidenceMessageCount) : defaults.evidenceMessageCount,
    judgeModel: object.version === 3 ? runtimeModel(object.judgeModel, "judgeModel") : defaults.judgeModel,
    autopilotJudgeModel: object.version === 3 ? runtimeModel(object.autopilotJudgeModel, "autopilotJudgeModel") : defaults.autopilotJudgeModel,
    harnesses: harnesses.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid session autostart harness override");
      const record = value as Record<string, unknown>;
      if (typeof record.enabled !== "boolean") throw new Error("invalid session autostart harness override enabled flag");
      return {
        harness: harnessType(record.harness),
        enabled: record.enabled,
        updatedAt: isoDate(record.updatedAt, "updatedAt"),
      };
    }),
    sessions: object.sessions.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid session autostart override");
      const record = value as Record<string, unknown>;
      if (typeof record.enabled !== "boolean") throw new Error("invalid session autostart override enabled flag");
      return {
        harness: harnessType(record.harness),
        sessionId: bounded(record.sessionId, "sessionId"),
        cwd: normalize(bounded(record.cwd, "cwd")),
        enabled: record.enabled,
        updatedAt: isoDate(record.updatedAt, "updatedAt"),
      };
    }),
  };
}

function defaultAutostartFile(env: NodeJS.ProcessEnv): SessionAutostartFile {
  return {
    version: 3,
    enabled: env.AGENT_HERDER_UNFINISHED_AUTOSTART !== "false",
    inventoryWindowHours: positiveInteger(Number(env.AGENT_HERDER_UNFINISHED_INVENTORY_HOURS || 48), 48),
    evidenceMessageCount: positiveInteger(Number(env.AGENT_HERDER_UNFINISHED_EVIDENCE_MESSAGES || 4), 4),
    judgeModel: env.AGENT_HERDER_UNFINISHED_JUDGE_MODEL?.trim() || "MiniMax-M3.1-Flash-Preview",
    autopilotJudgeModel: env.AGENT_HERDER_AUTOPILOT_JUDGE_MODEL?.trim() || "MiniMax-M3",
    harnesses: [],
    sessions: [],
  };
}

function runtimeHours(value: unknown): number {
  const hours = positiveInteger(value, -1);
  if (hours < 1 || hours > 24 * 90) throw new Error("invalid inventoryWindowHours");
  return hours;
}

function runtimeModel(value: unknown, field: string): string {
  const model = boundedText(value, field, 256).trim();
  if (!model) throw new Error(`invalid ${field}`);
  return model;
}

function evidenceCount(value: unknown): number {
  const count = positiveInteger(value, -1);
  if (count < 2 || count > 50) throw new Error("invalid evidenceMessageCount");
  return count;
}

function cloneAutostartFile(file: SessionAutostartFile): SessionAutostartFile {
  return {
    ...file,
    harnesses: file.harnesses.map((record) => ({ ...record })),
    sessions: file.sessions.map((record) => ({ ...record })),
  };
}

function parseFile(value: unknown): UnfinishedSessionFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("unfinished session state must be an object");
  const object = value as Record<string, unknown>;
  if (object.version !== 1 || !Array.isArray(object.sessions)) throw new Error("invalid unfinished session state");
  if (object.inventory !== undefined && !Array.isArray(object.inventory)) throw new Error("invalid unfinished session inventory");
  return {
    version: 1,
    sessions: object.sessions.map(parseRecord),
    ...(Array.isArray(object.inventory) ? { inventory: object.inventory.map(parseInventoryRecord) } : {}),
  };
}

function parseInventoryRecord(value: unknown): UnfinishedSessionInventoryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid unfinished session inventory entry");
  const record = value as Record<string, unknown>;
  const harness = record.harness;
  if (!isInventoryHarness(harness)) throw new Error("invalid inventory harness");
  const status = record.status;
  if (status !== "running" && status !== "idle" && status !== "needs_input" && status !== "stopped" && status !== "error") {
    throw new Error("invalid inventory session status");
  }
  return {
    harness,
    sessionId: bounded(record.sessionId, "sessionId"),
    cwd: normalize(bounded(record.cwd, "cwd")),
    title: boundedText(record.title, "title", MAX_TEXT),
    status,
    lastActivity: isoDate(record.lastActivity, "lastActivity"),
    transcriptTail: boundedText(record.transcriptTail, "transcriptTail", 2_000_000, true),
    observedAt: isoDate(record.observedAt, "observedAt"),
    ...(record.verdict ? { verdict: normalizePersistedVerdict(record.verdict) } : {}),
  };
}

function normalizePersistedVerdict(value: unknown): SessionInventoryVerdict {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid inventory verdict");
  const record = value as Record<string, unknown>;
  return { ...normalizeVerdict(record), judgedAt: isoDate(record.judgedAt, "judgedAt") };
}

function heuristicVerdict(session: AgentSession, messages: SessionMessageView[]): Omit<SessionInventoryVerdict, "judgedAt"> {
  if (session.status === "needs_input" || session.needsPermission) {
    return { verdict: "needs_human", reason: "Сессия ожидает решения или разрешения человека", confidence: 1 };
  }
  if (session.status === "running") {
    return { verdict: "unfinished", reason: "Харнес всё ещё считает сессию работающей", confidence: 1 };
  }
  const last = [...messages].reverse().find((message) => message.role !== "system");
  if (!last) return { verdict: "needs_human", reason: "Нет сообщений для безопасной классификации", confidence: 1 };
  if (last.role === "user" || last.role === "tool") {
    return { verdict: "unfinished", reason: last.role === "user" ? "Последний запрос пользователя остался без ответа" : "Сессия оборвалась после вызова инструмента", confidence: 0.9 };
  }
  const hasToolCall = last.parts.some((part) => part.type === "tool_call");
  const hasToolResult = last.parts.some((part) => part.type === "tool_result");
  if (hasToolCall && !hasToolResult) return { verdict: "unfinished", reason: "Последний вызов инструмента не завершён", confidence: 0.9 };
  if ((last.text || last.parts.find((part) => part.type === "text")?.text || "").trim()) {
    return { verdict: "completed", reason: "Последним сохранён полный ответ агента", confidence: 0.75 };
  }
  return { verdict: "needs_human", reason: "Финальное состояние диалога неоднозначно", confidence: 0.5 };
}

function cloneInventoryRecord(record: UnfinishedSessionInventoryRecord): UnfinishedSessionInventoryRecord {
  return { ...record, ...(record.verdict ? { verdict: { ...record.verdict } } : {}) };
}

/** Keep the configured latest semantic messages in full and retain both sides when present. */
export function completionEvidence(messages: SessionMessageView[], messageCount = 4): string {
  const semantic = messages.map((message, index) => ({
    index,
    role: message.role,
    text: message.role === "user" || message.role === "assistant" ? semanticTranscript([message]) : "",
  })).filter((item) => item.text);
  const selected = [
    ...semantic.slice(-Math.max(2, messageCount)),
    [...semantic].reverse().find((item) => item.role === "user"),
    [...semantic].reverse().find((item) => item.role === "assistant"),
  ].filter((item): item is (typeof semantic)[number] => Boolean(item));
  const unique = [...new Map(selected.map((item) => [item.index, item])).values()].sort((left, right) => left.index - right.index);
  const bounded = unique.slice(-Math.max(2, messageCount));
  for (const role of ["user", "assistant"] as const) {
    if (bounded.some((item) => item.role === role)) continue;
    const required = [...unique].reverse().find((item) => item.role === role);
    if (required) bounded.splice(0, 1, required);
  }
  bounded.sort((left, right) => left.index - right.index);
  return [...new Map(bounded.map((item) => [item.index, item])).values()].map((item) => item.text).join("\n\n");
}

function cleanPlanTopic(topic: string): string {
  const cleaned = topic
    .replace(/^авто(?:матическое)?\s*продолжение\s*[—:.-]*\s*/iu, "")
    .replace(/^(?:устранение\s+)?(?:дубл\p{L}*|повтор\p{L}*)(?:\s+(?:задач\p{L}*|сесси\p{L}*))?\s*[—:.-]*\s*/iu, "")
    .replace(/^аудита(?=\s|$)/iu, "Аудит")
    .replace(/^проверки(?=\s|$)/iu, "Проверка")
    .replace(/^задачи(?=\s|$)/iu, "Задача")
    .trim();
  const fallback = cleaned || "Незавершённая задача";
  return `${fallback.charAt(0).toLocaleUpperCase("ru-RU")}${fallback.slice(1)}`;
}

function continuationTitle(topic: string): string {
  return `Автопродолжение — ${cleanPlanTopic(topic).slice(0, 96)}`;
}

function batchContinuationPrompt(group: SessionBatchPlanGroup, sources: AssessedSession[]): string {
  return [
    continuationTitle(group.topic),
    "",
    `Это единое продолжение задачи «${group.topic}», собранное оркестратором из ${sources.length} сесс. Codex/ZCode.`,
    `Исходные сессии: ${sources.map(({ session }) => `${session.harness}:${session.id} (${session.title})`).join("; ")}.`,
    "MiniMax прочитал по четыре последних полных смысловых сообщения каждой сессии, убрал дубли и подготовил общий handoff.",
    "\n--- ОБЪЕДИНЁННЫЙ HANDOFF ---\n",
    group.handoff,
    "\nПроверь текущее состояние файлов и сервисов, затем продолжи с незавершённого шага. Не повторяй уже подтверждённое.",
  ].join("\n");
}

function parseRecord(value: unknown): UnfinishedSessionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid unfinished session entry");
  const record = value as Record<string, unknown>;
  const target = normalizeRecordTarget({
    harness: harnessType(record.harness),
    sessionId: bounded(record.sessionId, "sessionId"),
    cwd: bounded(record.cwd, "cwd"),
    model: optionalBounded(record.model, "model"),
    title: optionalBounded(record.title, "title"),
  });
  const state = record.state;
  if (state !== "active" && state !== "recovering" && state !== "exhausted") throw new Error("invalid unfinished session state");
  const attempts = nonNegativeInteger(record.attempts, -1);
  if (attempts < 0) throw new Error("invalid unfinished session attempts");
  return {
    ...target,
    startedAt: isoDate(record.startedAt, "startedAt"),
    updatedAt: isoDate(record.updatedAt, "updatedAt"),
    generationId: record.generationId === undefined ? "legacy" : bounded(record.generationId, "generationId"),
    attempts,
    state,
    ...(record.nextAttemptAt ? { nextAttemptAt: isoDate(record.nextAttemptAt, "nextAttemptAt") } : {}),
    ...(record.lastError ? { lastError: bounded(record.lastError, "lastError") } : {}),
    ...(record.notifiedAt ? { notifiedAt: isoDate(record.notifiedAt, "notifiedAt") } : {}),
  };
}

function normalizeRecordTarget(input: { harness: HarnessType; sessionId: string; cwd: string; model?: string; title?: string }) {
  return {
    harness: input.harness,
    sessionId: bounded(input.sessionId, "sessionId"),
    cwd: normalize(bounded(input.cwd, "cwd")),
    ...(input.model ? { model: bounded(input.model, "model") } : {}),
    ...(input.title ? { title: bounded(input.title, "title") } : {}),
  };
}

function isSupportedHarness(value: string): value is HarnessType {
  return (SUPPORTED_HARNESSES as readonly string[]).includes(value);
}

function isInventoryHarness(value: unknown): value is UnfinishedSessionInventoryRecord["harness"] {
  return value === "codex" || value === "zcode" || value === "opencode" || value === "fast-agent";
}

function isAutocontinueInventoryHarness(value: unknown): value is "codex" | "zcode" {
  return value === "codex" || value === "zcode";
}

function harnessType(value: unknown): HarnessType {
  if (typeof value !== "string" || !isSupportedHarness(value)) throw new Error("unsupported unfinished-session harness");
  return value;
}

function sessionKey(harness: HarnessType, sessionId: string): string {
  return `${harness}:${bounded(sessionId, "sessionId")}`;
}

function sortRecords(records: UnfinishedSessionRecord[]): void {
  records.sort((left, right) => sessionKey(left.harness, left.sessionId).localeCompare(sessionKey(right.harness, right.sessionId)));
}

function bounded(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT) throw new Error(`${label} must be bounded non-empty text`);
  return value.trim();
}

function boundedText(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > max) {
    throw new Error(`${label} must be bounded text`);
  }
  return value.trim();
}

function normalizeVerdict(value: unknown): Omit<SessionInventoryVerdict, "judgedAt"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MiniMax returned an invalid verdict");
  const record = value as Record<string, unknown>;
  if (record.verdict !== "completed" && record.verdict !== "unfinished" && record.verdict !== "needs_human") {
    throw new Error("MiniMax returned an unknown verdict");
  }
  if (typeof record.confidence !== "number" || !Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) {
    throw new Error("MiniMax returned an invalid confidence");
  }
  return {
    verdict: record.verdict,
    reason: boundedText(record.reason, "reason", MAX_TEXT),
    confidence: record.confidence,
  };
}

function mergePlanGroups(groups: SessionBatchPlanGroup[]): SessionBatchPlanGroup[] {
  const merged = new Map<string, SessionBatchPlanGroup>();
  const verdictRank = { completed: 0, needs_human: 1, unfinished: 2 } as const;
  const combineText = (left: string, right: string, separator: string, max: number): string => {
    if (!right || left === right || left.includes(right)) return left.slice(0, max);
    if (!left || right.includes(left)) return right.slice(0, max);
    return `${left}${separator}${right}`.slice(0, max);
  };

  for (const group of groups) {
    const topic = cleanPlanTopic(group.topic).slice(0, 120);
    const key = topic.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...group, topic, sourceSessionIds: [...group.sourceSessionIds] });
      continue;
    }
    const sourceSessionIds = [...new Set([...current.sourceSessionIds, ...group.sourceSessionIds])];
    const stronger = verdictRank[group.verdict] > verdictRank[current.verdict] ? group : current;
    merged.set(key, {
      ...current,
      sourceSessionIds,
      primarySessionId: sourceSessionIds.includes(stronger.primarySessionId) ? stronger.primarySessionId : sourceSessionIds[0],
      verdict: stronger.verdict,
      reason: combineText(current.reason, group.reason, "; ", MAX_TEXT),
      confidence: Math.max(current.confidence, group.confidence),
      topic,
      handoff: combineText(current.handoff, group.handoff, "\n\n--- ДОПОЛНЕНИЕ ИЗ ДУБЛЯ ---\n\n", 32_000),
    });
  }
  return [...merged.values()];
}

function normalizeBatchPlan(value: unknown, candidates: SessionBatchCandidate[]): SessionBatchPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MiniMax returned an invalid batch plan");
  const rawGroups = (value as Record<string, unknown>).groups;
  if (!Array.isArray(rawGroups)) throw new Error("MiniMax batch plan has no groups");
  const known = new Set(candidates.map(({ session }) => session.id));
  const aliases = new Map(candidates.map(({ session }, index) => [`S${index + 1}`, session.id]));
  const resolveId = (value: unknown, field: string): string => {
    const raw = boundedText(value, field, 128);
    return aliases.get(raw) ?? raw;
  };
  const preliminary = rawGroups.flatMap((value, index): SessionBatchPlanGroup[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`MiniMax returned invalid group ${index}`);
    const record = value as Record<string, unknown>;
    if (!Array.isArray(record.source_session_ids)) throw new Error(`MiniMax group ${index} has invalid sources`);
    if (record.source_session_ids.length === 0) return [];
    const sourceSessionIds = [...new Set(record.source_session_ids.map((id) => resolveId(id, "source_session_id")))];
    for (const id of sourceSessionIds) {
      if (!known.has(id)) throw new Error(`MiniMax grouped unknown session ${id}`);
    }
    const requestedPrimarySessionId = resolveId(record.primary_session_id, "primary_session_id");
    const primarySessionId = sourceSessionIds.includes(requestedPrimarySessionId) ? requestedPrimarySessionId : sourceSessionIds[0];
    let verdict = normalizeVerdict(record);
    const handoff = typeof record.handoff === "string" ? boundedText(record.handoff, "handoff", 32_000, true) : "";
    if (verdict.verdict === "unfinished" && !handoff) {
      verdict = {
        verdict: "needs_human",
        reason: "MiniMax не вернул объединённый handoff; группа будет повторно проверена в следующем цикле",
        confidence: 0,
      };
    }
    return [{
      sourceSessionIds,
      primarySessionId,
      ...verdict,
      topic: boundedText(record.topic, "topic", 120),
      handoff,
    }];
  });
  const assignment = new Map<string, { group: number; score: number }>();
  preliminary.forEach((group, index) => {
    for (const id of group.sourceSessionIds) {
      const score = (group.primarySessionId === id ? 10 : 0) + group.confidence;
      const previous = assignment.get(id);
      if (!previous || score > previous.score) assignment.set(id, { group: index, score });
    }
  });
  const groups = preliminary.flatMap((group, index): SessionBatchPlanGroup[] => {
    const sourceSessionIds = group.sourceSessionIds.filter((id) => assignment.get(id)?.group === index);
    if (sourceSessionIds.length === 0) return [];
    return [{ ...group, sourceSessionIds, primarySessionId: sourceSessionIds.includes(group.primarySessionId) ? group.primarySessionId : sourceSessionIds[0] }];
  });
  for (const { session } of candidates) {
    if (assignment.has(session.id)) continue;
    groups.push({
      sourceSessionIds: [session.id],
      primarySessionId: session.id,
      verdict: "needs_human",
      reason: "MiniMax не включил сессию в общий план; она будет повторно проверена в следующем цикле",
      confidence: 0,
      topic: session.title.slice(0, 120) || "Неопределённая задача",
      handoff: "",
    });
  }
  return { groups: mergePlanGroups(groups) };
}

function batchPlannerPrompt(): string {
  return [
    "Ты единый оркестратор автопродолжения Agent Herder для Codex и ZCode.",
    "Получаешь все доступные сессии окна, у каждой ровно последние четыре полных смысловых сообщения без tool noise.",
    "Сгруппируй сессии одной и той же пользовательской задачи, даже если названия различаются; не объединяй просто похожие задачи.",
    "Каждый входной session_ref должен встретиться ровно один раз в source_session_ids одной группы; возвращай короткие S1, S2 и т.д., не переписывай UUID.",
    "Для группы выбери primary_session_id из session_ref: работающую сессию, иначе самую новую и содержательную.",
    "verdict: completed, unfinished или needs_human. Если хотя бы одна сессия группы ещё реально выполняется, verdict=unfinished.",
    "topic — понятная русская тема из 3-8 слов без UUID, Auto Continue и технического мусора.",
    "handoff для unfinished — единая краткая сводка всех сессий группы: цель, уже сделано, решения, файлы/проверки, осталось, риски, следующий шаг.",
    "Не выполняй задачи и не добавляй факты. Верни только JSON {groups:[{source_session_ids,primary_session_id,verdict,reason,confidence,topic,handoff}]}",
  ].join(" ");
}

function batchPlannerPayload(sessions: SessionBatchCandidate[]): unknown {
  return {
    sessions: sessions.map(({ session, transcriptTail }, index) => ({
      session_ref: `S${index + 1}`,
      harness: session.harness,
      title: session.title,
      cwd: session.cwd,
      model: session.model,
      status_signal: session.status,
      last_activity: session.lastActivity,
      needs_permission: session.needsPermission,
      last_four_semantic_messages: transcriptTail,
    })),
  };
}

async function anthropicText(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    const body = await response.json() as Record<string, unknown>;
    const blocks = Array.isArray(body.content) ? body.content : [];
    const content = blocks.flatMap((block) => block && typeof block === "object"
      && (block as Record<string, unknown>).type === "text"
      && typeof (block as Record<string, unknown>).text === "string"
      ? [(block as Record<string, unknown>).text as string]
      : []).join("\n");
    if (content) return content;
    const stopReason = typeof body.stop_reason === "string" ? body.stop_reason : "unknown";
    const blockTypes = [...new Set(blocks.flatMap((block) => block && typeof block === "object" && typeof (block as Record<string, unknown>).type === "string"
      ? [(block as Record<string, unknown>).type as string] : []))].join(",") || "none";
    throw new Error(`MiniMax Anthropic batch planner returned no text content (stop=${stopReason}, blocks=${blockTypes})`);
  }
  if (!response.body) throw new Error("MiniMax Anthropic batch planner returned an empty stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const consume = (line: string): void => {
    if (!line.startsWith("data:")) return;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") return;
    let event: Record<string, unknown>;
    try { event = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (event.type === "error") throw new Error(`MiniMax Anthropic stream error: ${JSON.stringify(event.error || event)}`);
    if (event.type === "content_block_start" && event.content_block && typeof event.content_block === "object") {
      const block = event.content_block as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") content += block.text;
    }
    if (event.type === "content_block_delta" && event.delta && typeof event.delta === "object") {
      const delta = event.delta as Record<string, unknown>;
      if (delta.type === "text_delta" && typeof delta.text === "string") content += delta.text;
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) consume(line);
    if (done) break;
  }
  if (buffer) consume(buffer);
  if (!content.trim()) throw new Error("MiniMax Anthropic batch planner returned no streamed text");
  return content;
}

function optionalBounded(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : bounded(value, label);
}

function isoDate(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function displayHarness(harness: HarnessType): string {
  return harness === "zcode" ? "ZCode"
    : harness === "codex" ? "Codex"
      : harness === "opencode" ? "OpenCode"
        : harness === "claude" ? "Claude"
          : harness === "qoder" ? "Qoder"
            : harness === "fast-agent" ? "Fast Agent"
              : harness === "chatgpt" ? "ChatGPT" : "Hermes";
}

export function createOpenAICompatibleSessionCompletionJudge(config: {
  baseUrl: string;
  model: string;
  token?: string;
  fetchImpl?: typeof fetch;
}): SessionCompletionJudge {
  const fetchImpl = config.fetchImpl ?? fetch;
  const endpoint = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  return {
    async decide({ session, transcriptTail }) {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(35_000),
        body: JSON.stringify({
          model: config.model,
          temperature: 0,
          stream: false,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: [
                "Ты классификатор незавершённых Codex и ZCode задач Agent Herder.",
                "Верни только JSON: {verdict:completed|unfinished|needs_human,reason:string,confidence:number}.",
                "completed — цель явно выполнена; unfinished — работа оборвана, идёт или остались конкретные действия; needs_human — нужен выбор, секрет или содержательный ответ человека.",
                "Статус БД — только слабый сигнал. Главный источник — четыре последних полных смысловых сообщения. При сомнении не выбирай completed.",
                "reason — одно короткое русское предложение, confidence — число от 0 до 1.",
              ].join(" "),
            },
            {
              role: "user",
              content: JSON.stringify({
                session: {
                  harness: session.harness,
                  id: session.id,
                  title: session.title,
                  cwd: session.cwd,
                  status_signal: session.status,
                  last_activity: session.lastActivity,
                  needs_permission: session.needsPermission,
                },
                transcript_tail: transcriptTail,
              }),
            },
          ],
        }),
      });
      if (!response.ok) throw new Error(`MiniMax judge rejected with HTTP ${response.status}`);
      const body = await response.json() as Record<string, unknown>;
      const choices = Array.isArray(body.choices) ? body.choices : [];
      const message = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>).message : undefined;
      const content = message && typeof message === "object" ? (message as Record<string, unknown>).content : undefined;
      if (typeof content !== "string") throw new Error("MiniMax judge returned no content");
      const json = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      return normalizeVerdict(JSON.parse(json) as unknown);
    },
    async plan({ sessions }) {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(positiveInteger(Number(process.env.AGENT_HERDER_UNFINISHED_BATCH_TIMEOUT_MS || 600_000), 600_000)),
        body: JSON.stringify({
          model: config.model,
          temperature: 0,
          stream: false,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: batchPlannerPrompt() },
            { role: "user", content: JSON.stringify(batchPlannerPayload(sessions)) },
          ],
        }),
      });
      if (!response.ok) throw new Error(`MiniMax batch planner rejected with HTTP ${response.status}`);
      const body = await response.json() as Record<string, unknown>;
      const choices = Array.isArray(body.choices) ? body.choices : [];
      const message = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>).message : undefined;
      const content = message && typeof message === "object" ? (message as Record<string, unknown>).content : undefined;
      if (typeof content !== "string") throw new Error("MiniMax batch planner returned no content");
      const json = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      return normalizeBatchPlan(JSON.parse(json) as unknown, sessions);
    },
  };
}

/** Direct MiniMax Anthropic-compatible judge with an explicit cached system prefix. */
export function createAnthropicCompatibleSessionCompletionJudge(config: {
  baseUrl: string;
  model: string;
  token: string;
  fetchImpl?: typeof fetch;
}): SessionCompletionJudge {
  const fetchImpl = config.fetchImpl ?? fetch;
  const endpoint = `${config.baseUrl.replace(/\/$/, "")}/v1/messages`;
  return {
    async decide({ session, transcriptTail }) {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(35_000),
        body: JSON.stringify({
          model: config.model,
          max_tokens: 512,
          temperature: 0,
          system: [{
            type: "text",
            text: [
              "Ты классификатор незавершённых Codex и ZCode задач Agent Herder.",
              "Верни только JSON: {verdict:completed|unfinished|needs_human,reason:string,confidence:number}.",
              "completed — цель явно выполнена; unfinished — работа оборвана, идёт или остались конкретные действия; needs_human — нужен выбор, секрет или содержательный ответ человека.",
              "Статус БД — только слабый сигнал. Главный источник — четыре последних полных смысловых сообщения. При сомнении не выбирай completed.",
              "reason — одно короткое русское предложение, confidence — число от 0 до 1.",
            ].join(" "),
            cache_control: { type: "ephemeral" },
          }],
          messages: [{
            role: "user",
            content: JSON.stringify({
              session: {
                harness: session.harness,
                id: session.id,
                title: session.title,
                cwd: session.cwd,
                status_signal: session.status,
                last_activity: session.lastActivity,
                needs_permission: session.needsPermission,
              },
              transcript_tail: transcriptTail,
            }),
          }],
        }),
      });
      if (!response.ok) throw new Error(`MiniMax Anthropic judge rejected with HTTP ${response.status}`);
      const body = await response.json() as Record<string, unknown>;
      const blocks = Array.isArray(body.content) ? body.content : [];
      const content = blocks.flatMap((block) => block && typeof block === "object"
        && (block as Record<string, unknown>).type === "text"
        && typeof (block as Record<string, unknown>).text === "string"
        ? [(block as Record<string, unknown>).text as string]
        : []).join("\n");
      if (!content) throw new Error("MiniMax Anthropic judge returned no text content");
      const json = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      return normalizeVerdict(JSON.parse(json) as unknown);
    },
    async plan({ sessions }) {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(positiveInteger(Number(process.env.AGENT_HERDER_UNFINISHED_BATCH_TIMEOUT_MS || 600_000), 600_000)),
        body: JSON.stringify({
          model: config.model,
          max_tokens: positiveInteger(Number(process.env.AGENT_HERDER_UNFINISHED_BATCH_MAX_TOKENS || 131_072), 131_072),
          temperature: 0,
          stream: true,
          output_config: { effort: "low" },
          system: [{ type: "text", text: batchPlannerPrompt(), cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: JSON.stringify(batchPlannerPayload(sessions)) }],
        }),
      });
      if (!response.ok) throw new Error(`MiniMax Anthropic batch planner rejected with HTTP ${response.status}`);
      const content = await anthropicText(response);
      const json = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      return normalizeBatchPlan(JSON.parse(json) as unknown, sessions);
    },
  };
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}
