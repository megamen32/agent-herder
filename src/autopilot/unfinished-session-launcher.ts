import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, normalize } from "node:path";

import type { AgentSession, HarnessAdapter, HarnessEvent, HarnessType, SessionMessageView } from "../types/index.js";
import { semanticTranscript, type CacheHandoffService } from "../cache-handoff.js";

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

type SessionAutostartFile = {
  version: 2;
  enabled: boolean;
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
      : { version: 2, enabled: this.env.AGENT_HERDER_UNFINISHED_AUTOSTART !== "false", harnesses: [], sessions: [], source: "default" };
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
      return parseAutostartFile(JSON.parse(await readFile(this.path, "utf8")) as unknown);
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
      const file = await this.readOptional() ?? {
        version: 2 as const,
        enabled: this.env.AGENT_HERDER_UNFINISHED_AUTOSTART !== "false",
        harnesses: [],
        sessions: [],
      };
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
}

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
    await this.mutate((file) => {
      const inventory = file.inventory ??= [];
      const key = sessionKey(record.harness, record.sessionId);
      const index = inventory.findIndex((candidate) => sessionKey(candidate.harness, candidate.sessionId) === key);
      if (index < 0) inventory.push(cloneInventoryRecord(record));
      else inventory[index] = cloneInventoryRecord(record);
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
    });
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
    });
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
    });
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

  private async mutate<T>(operation: (file: UnfinishedSessionFile) => T | Promise<T>): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const file = await this.read();
      const result = await operation(file);
      await mkdir(dirname(this.path), { recursive: true });
      await atomicWrite(this.path, file);
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
  private readonly inventoryWindowMs: number;
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
      options.reconcileIntervalMs ?? Number(process.env.AGENT_HERDER_UNFINISHED_RECONCILE_INTERVAL_MS || 600_000),
      600_000,
    );
    this.inventoryWindowMs = positiveInteger(options.inventoryWindowMs ?? 48 * 60 * 60 * 1_000, 48 * 60 * 60 * 1_000);
    this.discoveryIdleMs = positiveInteger(
      options.discoveryIdleMs ?? Number(process.env.AGENT_HERDER_UNFINISHED_DISCOVERY_IDLE_MS || 600_000),
      600_000,
    );
    this.maxJudgementsPerCycle = positiveInteger(
      options.maxJudgementsPerCycle ?? Number(process.env.AGENT_HERDER_UNFINISHED_JUDGEMENTS_PER_CYCLE || 20),
      20,
    );
    this.maxResumesPerCycle = positiveInteger(
      options.maxResumesPerCycle ?? Number(process.env.AGENT_HERDER_UNFINISHED_RESUMES_PER_CYCLE || 4),
      4,
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
    await this.discoverUnfinishedSessions();
    // Deliberately sequential: a restart must not multiply the host's agent workload.
    let resumedThisCycle = 0;
    const records = await this.options.store.list();
    records.sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
    for (const record of records) {
      if (record.state === "exhausted") {
        await this.notifyExhausted(record);
        continue;
      }
      if (!await this.isEnabled(record.harness, record.sessionId, record.cwd)) {
        await this.options.store.remove(record.harness, record.sessionId);
        continue;
      }
      const adapter = this.options.adapters.get(record.harness);
      if (!adapter || (!adapter.resumeSession && record.harness !== "opencode")) {
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
      if (record.generationId === this.generationId) continue;
      if (session?.status === "running") {
        await this.options.store.markStarted(session, this.generationId);
        continue;
      }
      if (resumedThisCycle >= this.maxResumesPerCycle) continue;
      const attempt = await this.options.store.beginAttempt(record.harness, record.sessionId, this.maxAttempts, this.retryDelayMs);
      if (!attempt) continue;
      resumedThisCycle += 1;
      try {
        if (session && this.options.cacheHandoff) {
          const handoff = await this.options.cacheHandoff.maybeRollover(session);
          if (handoff.kind === "rolled_over" && handoff.session) {
            await this.options.store.remove(record.harness, record.sessionId);
            await this.options.store.markStarted(handoff.session, this.generationId);
            console.error(`[agent-herder] протухшая сессия ${record.harness}:${record.sessionId} продолжена в новой ${handoff.session.id}`);
            continue;
          }
        }
        const resumed = adapter.resumeSession ? await adapter.resumeSession(record.sessionId) : { ok: true };
        if (!resumed.ok) throw new Error(resumed.error || "возобновление отклонено");
        const sent = await adapter.sendMessage(record.sessionId, { message: this.continuationMessage, queue: false });
        if (!sent.ok) throw new Error(sent.error || "команда продолжения отклонена");
        await this.options.store.markStarted(session ?? {
          id: record.sessionId,
          harness: record.harness,
          status: "running",
          title: record.title || "Незавершённая задача",
          cwd: record.cwd,
          lastActivity: new Date().toISOString(),
          model: record.model,
          needsPermission: false,
        }, this.generationId);
        console.error(`[agent-herder] автоматически продолжена незавершённая сессия ${record.harness}:${record.sessionId}`);
      } catch (error) {
        await this.fail(attempt, errorText(error));
      }
    }
  }

  private async discoverUnfinishedSessions(): Promise<void> {
    const known = new Set((await this.options.store.list()).map((record) => sessionKey(record.harness, record.sessionId)));
    const priorInventory = new Map((await this.options.store.listInventory()).map((record) => [sessionKey(record.harness, record.sessionId), record]));
    const candidates: Array<{ adapter: HarnessAdapter; session: AgentSession }> = [];
    for (const [provider, adapter] of this.options.adapters) {
      if (!isInventoryHarness(provider) || (!adapter.resumeSession && provider !== "opencode")) continue;
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
        if (!Number.isFinite(lastActivity) || Date.now() - lastActivity > this.inventoryWindowMs) continue;
        candidates.push({ adapter, session });
      }
    }
    candidates.sort((left, right) => Date.parse(right.session.lastActivity) - Date.parse(left.session.lastActivity));
    let judgements = 0;
    const equivalentSessions = new Map<string, string>();
    for (const { adapter, session } of candidates) {
      if (!isInventoryHarness(session.harness)) continue;
      const harness = session.harness;
      const key = sessionKey(harness, session.id);
      const messages = await adapter.getSessionMessages?.(session.id, 200).catch(() => null);
      const transcriptTail = semanticTranscript(messages ?? []).slice(-2_000);
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
        try {
          const judged = await this.options.judge.decide({ session, transcriptTail });
          verdict = { ...normalizeVerdict(judged), judgedAt: new Date().toISOString() };
          judgements += 1;
        } catch (error) {
          console.error(`[agent-herder] MiniMax не классифицировал ${harness}:${session.id}: ${errorText(error)}`);
        }
      } else if (!verdict && messages) {
        verdict = { ...heuristicVerdict(session, messages), judgedAt: new Date().toISOString() };
      } else if (!verdict && !transcriptTail) {
        verdict = { verdict: "needs_human", reason: "Нет доступного хвоста диалога для безопасной классификации", confidence: 1, judgedAt: new Date().toISOString() };
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
      await this.options.store.upsertInventory(inventory);
      if (verdict?.verdict !== "unfinished") {
        if (verdict) await this.options.store.remove(harness, session.id);
        known.delete(key);
        continue;
      }
      if (known.has(key) || !await this.isEnabled(harness, session.id, session.cwd)) continue;
      await this.options.store.markStarted(session, `judged-${this.generationId}`);
      known.add(key);
    }
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

function parseAutostartFile(value: unknown): SessionAutostartFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("session autostart settings must be an object");
  const object = value as Record<string, unknown>;
  if ((object.version !== 1 && object.version !== 2) || typeof object.enabled !== "boolean" || !Array.isArray(object.sessions)) throw new Error("invalid session autostart settings");
  const harnesses = object.version === 2 ? object.harnesses : [];
  if (!Array.isArray(harnesses)) throw new Error("invalid session autostart harness overrides");
  return {
    version: 2,
    enabled: object.enabled,
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
    transcriptTail: boundedText(record.transcriptTail, "transcriptTail", 2_000, true),
    observedAt: isoDate(record.observedAt, "observedAt"),
    ...(record.verdict ? { verdict: normalizePersistedVerdict(record.verdict) } : {}),
  };
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

function normalizePersistedVerdict(value: unknown): SessionInventoryVerdict {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid inventory verdict");
  const record = value as Record<string, unknown>;
  return { ...normalizeVerdict(record), judgedAt: isoDate(record.judgedAt, "judgedAt") };
}

function cloneInventoryRecord(record: UnfinishedSessionInventoryRecord): UnfinishedSessionInventoryRecord {
  return { ...record, ...(record.verdict ? { verdict: { ...record.verdict } } : {}) };
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
                "Статус БД — только слабый сигнал. Главный источник — последние 2000 символов диалога. При сомнении не выбирай completed.",
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
  };
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}
