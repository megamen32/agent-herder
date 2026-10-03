import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, normalize } from "node:path";

import type { AgentSession, HarnessAdapter, HarnessEvent, HarnessType } from "../types/index.js";

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

type SessionAutostartFile = { version: 1; enabled: boolean; sessions: SessionAutostartOverride[] };

/** Independent opt-out setting for restart continuation; it does not read autopilot policy. */
export class SessionAutostartStore {
  private operation: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string, private readonly env: NodeJS.ProcessEnv = process.env) {}

  async getSettings(): Promise<SessionAutostartFile & { source: "persisted" | "default" }> {
    const loaded = await this.readOptional();
    return loaded
      ? { ...loaded, sessions: loaded.sessions.map((record) => ({ ...record })), source: "persisted" }
      : { version: 1, enabled: this.env.AGENT_HERDER_UNFINISHED_AUTOSTART !== "false", sessions: [], source: "default" };
  }

  async getEffective(harness: string, sessionId: string, cwd: string): Promise<{ enabled: boolean; source: "session" | "global" | "default"; cwd: string; updatedAt?: string }> {
    const normalizedHarness = harnessType(harness);
    const settings = await this.getSettings();
    const override = settings.sessions.find((record) => record.harness === normalizedHarness && record.sessionId === bounded(sessionId, "sessionId"));
    return override
      ? { enabled: override.enabled, source: "session", cwd: override.cwd, updatedAt: override.updatedAt }
      : { enabled: settings.enabled, source: settings.source === "persisted" ? "global" : "default", cwd: normalize(bounded(cwd, "cwd")) };
  }

  async setGlobal(enabled: boolean): Promise<SessionAutostartFile> {
    return this.mutate((file) => { file.enabled = enabled; return cloneAutostartFile(file); });
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
        version: 1 as const,
        enabled: this.env.AGENT_HERDER_UNFINISHED_AUTOSTART !== "false",
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

type UnfinishedSessionFile = { version: 1; sessions: UnfinishedSessionRecord[] };

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
  continuationMessage?: string;
  notify?: (notice: UnfinishedSessionNotice) => Promise<void>;
  /** Stable only for one Agent Herder process; tests may inject it. */
  generationId?: string;
}

/** Restarts only durable unfinished turns allowed by the independent opt-out setting. */
export class UnfinishedSessionLauncher {
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly continuationMessage: string;
  private readonly generationId: string;
  private recovering: Promise<void> | null = null;
  private retryTimer?: NodeJS.Timeout;
  private started = false;

  constructor(private readonly options: UnfinishedSessionLauncherOptions) {
    this.maxAttempts = positiveInteger(options.maxAttempts ?? Number(process.env.AGENT_HERDER_AUTOSTART_MAX_ATTEMPTS || 3), 3);
    this.retryDelayMs = nonNegativeInteger(options.retryDelayMs ?? Number(process.env.AGENT_HERDER_AUTOSTART_RETRY_DELAY_MS || 5_000), 5_000);
    this.continuationMessage = options.continuationMessage?.trim() || DEFAULT_CONTINUATION;
    this.generationId = options.generationId?.trim() || `process-${process.pid}-${randomUUID()}`;
  }

  async handleEvent(provider: string, event: HarnessEvent): Promise<void> {
    if (!event.sessionId || !isSupportedHarness(provider)) return;
    if (event.kind === "turn.completed" || event.kind === "session.deleted") {
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
    if (!adapter?.resumeSession) return false;
    if (!await this.isEnabled(session.harness, session.id, session.cwd)) return false;
    await this.options.store.markStarted(session, this.generationId);
    return true;
  }

  async forget(harness: string, sessionId: string): Promise<void> {
    if (!isSupportedHarness(harness)) return;
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
    const pending = (await this.options.store.list()).filter((record) => record.state !== "exhausted" && record.nextAttemptAt);
    if (pending.length === 0) return;
    const now = Date.now();
    const nextAt = Math.min(...pending.map((record) => record.nextAttemptAt ? Date.parse(record.nextAttemptAt) : now));
    const delay = Math.max(100, nextAt - now);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.recoverPending().catch((error) => {
        console.error(`[agent-herder] повторный автозапуск завершился ошибкой: ${errorText(error)}`);
      });
    }, delay);
    this.retryTimer.unref?.();
  }

  private async runRecovery(): Promise<void> {
    // Deliberately sequential: a restart must not multiply the host's agent workload.
    for (const record of await this.options.store.list()) {
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
      if (session?.status === "running" && record.generationId === this.generationId) {
        await this.options.store.markStarted(session, this.generationId);
        continue;
      }
      const attempt = await this.options.store.beginAttempt(record.harness, record.sessionId, this.maxAttempts, this.retryDelayMs);
      if (!attempt) continue;
      try {
        const resumed = await adapter.resumeSession(record.sessionId);
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
  if (object.version !== 1 || typeof object.enabled !== "boolean" || !Array.isArray(object.sessions)) throw new Error("invalid session autostart settings");
  return {
    version: 1,
    enabled: object.enabled,
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
  return { ...file, sessions: file.sessions.map((record) => ({ ...record })) };
}

function parseFile(value: unknown): UnfinishedSessionFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("unfinished session state must be an object");
  const object = value as Record<string, unknown>;
  if (object.version !== 1 || !Array.isArray(object.sessions)) throw new Error("invalid unfinished session state");
  return { version: 1, sessions: object.sessions.map(parseRecord) };
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

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}
