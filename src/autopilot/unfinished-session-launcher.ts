import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, normalize } from "node:path";

import type { AgentSession, HarnessAdapter, HarnessEvent, HarnessType, SendMessageResult, SessionMessageView } from "../types/index.js";
import { cacheWindowFor, continuationModelFor, movePinnedContinuation, semanticTranscript, unfinishedProbeDelayMs, type CacheHandoffService } from "../cache-handoff.js";
import { deferredMessages, isBusyCodexWriter, type DeferredMessageStore } from "../deferred-messages.js";

const SUPPORTED_HARNESSES: readonly HarnessType[] = ["codex", "opencode", "claude", "qoder", "hermes", "zcode", "fast-agent", "chatgpt"];
const DEFAULT_CONTINUATION = "Продолжи незавершённую задачу с того места, где выполнение было прервано. Сначала проверь текущее состояние и не повторяй уже завершённые действия.";
const MAX_TEXT = 1_024;
const DEFAULT_EVIDENCE_MESSAGE_COUNT = 200;
const MAX_EVIDENCE_MESSAGE_COUNT = 200;
const DEFAULT_BATCH_CONTEXT_TOKEN_BUDGET = 480_000;
const DEFAULT_BATCH_OUTPUT_TOKENS = 16_384;
// Bound group count against the 16k response ceiling. Any still-truncated
// chunk is rejected by exact coverage before a verdict or continuation applies.
const MAX_BATCH_PLAN_SESSIONS_PER_REQUEST = 64;
const MAX_SESSION_EVIDENCE_CHARS = 120_000;
const CURRENT_EVIDENCE_VERSION = 1;

function sessionProgressFingerprint(session: AgentSession): string {
  return [
    session.status,
    session.lastActivity,
    session.messageCount ?? "",
    session.lastMessage?.slice(-256) ?? "",
    session.meta?.hasActiveToolCall === true ? "tool-active" : "tool-idle",
  ].join("|");
}

function admittedNonRetryableFailure(result: SendMessageResult): string | undefined {
  return !result.ok && result.admitted === true && result.nonRetryable === true
    ? result.error || "Native harness admitted the prompt, then failed the exact turn"
    : undefined;
}

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
  version: 7;
  enabled: boolean;
  /** Keep Codex/ZCode sessions visible while Autocontinue is responsible for them. */
  pinActiveSessions: boolean;
  /** Start a compact replacement after the provider cache window expires. */
  rolloverExpiredCache: boolean;
  /** Pin the replacement, then unpin the stale source sessions after a successful handoff. */
  movePinnedOnRollover: boolean;
  inventoryWindowHours: number;
  evidenceMessageCount: number;
  watchdogEnabled: boolean;
  watchdogIntervalSeconds: number;
  stalledTurnMinutes: number;
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
    const normalizedCwd = normalize(bounded(cwd, "cwd"));
    const normalizedSessionId = bounded(sessionId, "sessionId");
    const settings = await this.getSettings();
    const aliases = settings.sessions.filter((record) => record.harness === normalizedHarness && record.sessionId === normalizedSessionId);
    const override = resolveSessionOverride(aliases, normalizedCwd);
    if (override) return { enabled: override.enabled, source: "session", cwd: override.cwd, updatedAt: override.updatedAt };
    const harnessOverride = settings.harnesses.find((record) => record.harness === normalizedHarness);
    return harnessOverride
      ? { enabled: harnessOverride.enabled, source: "harness", cwd: normalize(bounded(cwd, "cwd")), updatedAt: harnessOverride.updatedAt }
      : { enabled: settings.enabled, source: settings.source === "persisted" ? "global" : "default", cwd: normalizedCwd };
  }

  async setGlobal(enabled: boolean): Promise<SessionAutostartFile> {
    return this.mutate((file) => { file.enabled = enabled; return cloneAutostartFile(file); });
  }

  async setRuntimeSettings(input: { enabled?: boolean; pinActiveSessions?: boolean; inventoryWindowHours: number; evidenceMessageCount: number; judgeModel: string; autopilotJudgeModel: string; rolloverExpiredCache?: boolean; movePinnedOnRollover?: boolean; watchdogEnabled?: boolean; watchdogIntervalSeconds?: number; stalledTurnMinutes?: number }): Promise<SessionAutostartFile> {
    const inventoryWindowHours = positiveInteger(input.inventoryWindowHours, -1);
    if (inventoryWindowHours < 1 || inventoryWindowHours > 24 * 90) throw new Error("inventoryWindowHours must be an integer from 1 to 2160");
    const evidenceMessageCount = positiveInteger(input.evidenceMessageCount, -1);
    if (evidenceMessageCount < 2 || evidenceMessageCount > MAX_EVIDENCE_MESSAGE_COUNT) throw new Error(`evidenceMessageCount must be an integer from 2 to ${MAX_EVIDENCE_MESSAGE_COUNT}`);
    const judgeModel = boundedText(input.judgeModel, "judgeModel", 256).trim();
    const autopilotJudgeModel = boundedText(input.autopilotJudgeModel, "autopilotJudgeModel", 256).trim();
    if (!judgeModel || !autopilotJudgeModel) throw new Error("judge models must not be empty");
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("enabled must be a boolean");
    if (input.pinActiveSessions !== undefined && typeof input.pinActiveSessions !== "boolean") throw new Error("pinActiveSessions must be a boolean");
    if (input.rolloverExpiredCache !== undefined && typeof input.rolloverExpiredCache !== "boolean") throw new Error("rolloverExpiredCache must be a boolean");
    if (input.movePinnedOnRollover !== undefined && typeof input.movePinnedOnRollover !== "boolean") throw new Error("movePinnedOnRollover must be a boolean");
    if (input.watchdogEnabled !== undefined && typeof input.watchdogEnabled !== "boolean") throw new Error("watchdogEnabled must be a boolean");
    const watchdogIntervalSeconds = boundedInteger(input.watchdogIntervalSeconds ?? 10, 5, 300, "watchdogIntervalSeconds");
    const stalledTurnMinutes = boundedInteger(input.stalledTurnMinutes ?? 2, 1, 120, "stalledTurnMinutes");
    return this.mutate((file) => {
      if (input.enabled !== undefined) file.enabled = input.enabled;
      if (input.pinActiveSessions !== undefined) file.pinActiveSessions = input.pinActiveSessions;
      file.inventoryWindowHours = inventoryWindowHours;
      file.evidenceMessageCount = evidenceMessageCount;
      file.judgeModel = judgeModel;
      file.autopilotJudgeModel = autopilotJudgeModel;
      if (input.rolloverExpiredCache !== undefined) file.rolloverExpiredCache = input.rolloverExpiredCache;
      if (input.movePinnedOnRollover !== undefined) file.movePinnedOnRollover = input.movePinnedOnRollover;
      if (input.watchdogEnabled !== undefined) file.watchdogEnabled = input.watchdogEnabled;
      file.watchdogIntervalSeconds = watchdogIntervalSeconds;
      file.stalledTurnMinutes = stalledTurnMinutes;
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
      const key = sessionKey(normalized.harness, normalized.sessionId, normalized.cwd);
      const index = file.sessions.findIndex((record) => sessionKey(record.harness, record.sessionId, record.cwd) === key);
      if (index < 0) file.sessions.push(normalized);
      else file.sessions[index] = normalized;
      file.sessions.sort((left, right) => sessionKey(left.harness, left.sessionId, left.cwd).localeCompare(sessionKey(right.harness, right.sessionId, right.cwd)));
      return { ...normalized };
    });
  }

  async deleteSession(harness: string, sessionId: string): Promise<boolean> {
    return this.mutate((file) => {
      const normalizedHarness = harnessType(harness);
      const normalizedSessionId = bounded(sessionId, "sessionId");
      const before = file.sessions.length;
      file.sessions = file.sessions.filter((record) => record.harness !== normalizedHarness || record.sessionId !== normalizedSessionId);
      return file.sessions.length !== before;
    });
  }

  /** Atomically rewrite every legacy session override to the canonical cwd. */
  async migrateWorkspaceIdentities(sessions: AgentSession[]): Promise<number> {
    if (sessions.length === 0) return 0;
    return this.mutate((file) => {
      let migrated = 0;
      for (const session of sessions) {
        const harness = harnessType(session.harness);
        const matches = file.sessions.filter((record) => record.harness === harness && record.sessionId === session.id);
        if (matches.length === 0) continue;
        const canonicalCwd = normalize(session.cwd);
        if (matches.length === 1 && matches[0]!.cwd === canonicalCwd) continue;
        const selected = resolveSessionOverride(matches, canonicalCwd)!;
        file.sessions = file.sessions.filter((record) => record.harness !== harness || record.sessionId !== session.id);
        file.sessions.push({ ...selected, cwd: canonicalCwd });
        migrated += matches.length;
      }
      file.sessions.sort((left, right) => sessionKey(left.harness, left.sessionId, left.cwd).localeCompare(sessionKey(right.harness, right.sessionId, right.cwd)));
      return migrated;
    }, (migrated) => migrated > 0);
  }

  private async readOptional(): Promise<SessionAutostartFile | null> {
    try {
      return parseAutostartFile(JSON.parse(await readFile(this.path, "utf8")) as unknown, this.env);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async mutate<T>(
    operation: (file: SessionAutostartFile) => T | Promise<T>,
    shouldWrite: (result: T) => boolean = () => true,
  ): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const file = await this.readOptional() ?? defaultAutostartFile(this.env);
      const result = await operation(file);
      if (shouldWrite(result)) await atomicWrite(this.path, file);
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
  workspaceIdentity?: string;
  model?: string;
  title?: string;
  startedAt: string;
  updatedAt: string;
  /** Stable boundary for the most recent prompt accepted by the native harness. */
  acceptedAt?: string;
  /** Native status/message fingerprint captured at that acceptance boundary. */
  acceptedFingerprint?: string;
  /** Durable proof that native state changed after the accepted prompt. */
  progressObservedAt?: string;
  /** Admission was acknowledged, but the exact native turn has not started yet. */
  deliveryPending?: boolean;
  /** Native admission crossed the idempotency boundary and then failed terminally. */
  nonRetryableAdmission?: boolean;
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
  /** Stable adapter-owned workspace identity; cwd is the compatibility fallback. */
  workspaceIdentity?: string;
  title: string;
  status: AgentSession["status"];
  lastActivity: string;
  transcriptTail: string;
  /** Version/fingerprint prove that legacy evidence was rebuilt by the current packer. */
  evidenceVersion?: number;
  evidenceFingerprint?: string;
  observedAt: string;
  verdict?: SessionInventoryVerdict;
}

export interface SessionCompletionJudge {
  decide(input: { session: AgentSession; transcriptTail: string }): Promise<Omit<SessionInventoryVerdict, "judgedAt">>;
  plan?(input: { sessions: SessionBatchCandidate[] }): Promise<SessionBatchPlan>;
  reconcile?(input: { groups: SessionBatchReconciliationCandidate[] }): Promise<SessionBatchReconciliation>;
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

export interface SessionBatchReconciliationCandidate {
  groupRef: string;
  workspaceIdentity: string;
  topic: string;
  verdict: SessionCompletionVerdict;
  reason: string;
  handoff: string;
  sourceSessionIds: string[];
  memberTitles: string[];
  humanGate: boolean;
}

export interface SessionBatchReconciliation {
  clusters: string[][];
}

type AssessedSession = SessionBatchCandidate & {
  adapter: HarnessAdapter;
  sourceKey: string;
  autoResumeEnabled: boolean;
  latestSemanticMessage?: Pick<SessionMessageView, "role" | "text">;
};
type DiscoveryOutcome = "ready" | "idle" | "blocked";

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
      const positions = new Map(inventory.map((candidate, index) => [inventoryRecordKey(candidate), index]));
      for (const record of records) {
        const key = inventoryRecordKey(record);
        const index = positions.get(key);
        if (index === undefined) {
          positions.set(key, inventory.length);
          inventory.push(cloneInventoryRecord(record));
        } else inventory[index] = cloneInventoryRecord(record);
      }
      inventory.sort((left, right) => Date.parse(right.lastActivity) - Date.parse(left.lastActivity));
    });
  }

  /** Keep inventory equal to the latest successful native snapshots for the selected harnesses. */
  async reconcileInventorySnapshot(harnesses: ReadonlySet<"codex" | "zcode">, sourceKeys: ReadonlySet<string>): Promise<number> {
    if (harnesses.size === 0) return 0;
    return this.mutate((file) => {
      if (!file.inventory) return 0;
      const before = file.inventory.length;
      file.inventory = file.inventory.filter((record) => !harnesses.has(record.harness as "codex" | "zcode")
        || sourceKeys.has(inventoryRecordKey(record)));
      return before - file.inventory.length;
    }, (removed) => removed > 0);
  }

  /** Atomically migrate legacy cwd-only keys before recovery can observe both identities. */
  async migrateWorkspaceIdentities(sessions: AgentSession[]): Promise<{ sessions: number; inventory: number }> {
    if (sessions.length === 0) return { sessions: 0, inventory: 0 };
    return this.mutate((file) => {
      let migratedSessions = 0;
      let migratedInventory = 0;
      for (const session of sessions) {
        const harness = harnessType(session.harness);
        const identity = sessionWorkspaceIdentity(session);
        const matchingRecords = file.sessions.filter((record) => record.harness === harness && record.sessionId === session.id);
        if (matchingRecords.length > 0 && (matchingRecords.length > 1
          || matchingRecords[0]!.workspaceIdentity !== identity
          || matchingRecords[0]!.cwd !== normalize(session.cwd))) {
          const merged = mergeUnfinishedIdentityRecords(matchingRecords, session, identity);
          file.sessions = file.sessions.filter((record) => record.harness !== harness || record.sessionId !== session.id);
          file.sessions.push(merged);
          migratedSessions += matchingRecords.length;
        }
        const matchingInventory = (file.inventory ?? []).filter((record) => record.harness === harness && record.sessionId === session.id);
        if (matchingInventory.length > 0 && (matchingInventory.length > 1
          || matchingInventory[0]!.workspaceIdentity !== identity
          || matchingInventory[0]!.cwd !== normalize(session.cwd))) {
          const merged = mergeInventoryIdentityRecords(matchingInventory, session, identity);
          file.inventory = (file.inventory ?? []).filter((record) => record.harness !== harness || record.sessionId !== session.id);
          file.inventory.push(merged);
          migratedInventory += matchingInventory.length;
        }
      }
      sortRecords(file.sessions);
      file.inventory?.sort((left, right) => Date.parse(right.lastActivity) - Date.parse(left.lastActivity));
      return { sessions: migratedSessions, inventory: migratedInventory };
    }, ({ sessions: migratedSessions, inventory }) => migratedSessions > 0 || inventory > 0);
  }

  /** Remove legacy non-Codex/ZCode turn records and inventory outside the configured audit window. */
  async pruneAutocontinueScope(inventoryCutoff: Date): Promise<{ sessions: number; inventory: number }> {
    return this.mutate((file) => {
      const beforeSessions = file.sessions.length;
      const beforeInventory = file.inventory?.length ?? 0;
      file.sessions = file.sessions.filter((record) => isAutocontinueInventoryHarness(record.harness));
      if (file.inventory) {
        const cutoff = inventoryCutoff.getTime();
        file.inventory = file.inventory.filter((record) => {
          const lastActivity = Date.parse(record.lastActivity);
          return isAutocontinueInventoryHarness(record.harness)
            && Number.isFinite(lastActivity)
            && lastActivity >= cutoff;
        });
      }
      return {
        sessions: beforeSessions - file.sessions.length,
        inventory: beforeInventory - (file.inventory?.length ?? 0),
      };
    }, (removed) => removed.sessions > 0 || removed.inventory > 0);
  }

  async markStarted(
    session: AgentSession,
    generationId = "external",
    now = new Date(),
    resetAttempts = false,
    acceptedDelivery = false,
    deliveryPending = false,
    admittedFailure?: string,
  ): Promise<UnfinishedSessionRecord> {
    const harness = harnessType(session.harness);
    const normalized = normalizeRecordTarget({
      harness,
      sessionId: session.id,
      cwd: session.cwd,
      model: session.model,
      title: session.title,
    });
    return this.mutate((file) => {
      const workspaceIdentity = sessionWorkspaceIdentity(session);
      const key = sessionKey(harness, session.id, workspaceIdentity);
      const index = file.sessions.findIndex((record) => unfinishedRecordKey(record) === key);
      const existing = index >= 0 ? file.sessions[index] : undefined;
      const reset = existing?.state === "exhausted";
      const record: UnfinishedSessionRecord = {
        ...normalized,
        workspaceIdentity,
        startedAt: reset || !existing ? now.toISOString() : existing.startedAt,
        updatedAt: now.toISOString(),
        generationId: bounded(generationId, "generationId"),
        attempts: reset || resetAttempts ? 0 : existing?.attempts ?? 0,
        state: "active",
        ...(acceptedDelivery
          ? {
              acceptedAt: now.toISOString(),
              acceptedFingerprint: sessionProgressFingerprint(session),
              ...(deliveryPending ? { deliveryPending: true } : {}),
              ...(admittedFailure ? { lastError: bounded(admittedFailure, "admittedFailure"), nonRetryableAdmission: true } : {}),
            }
          : existing?.acceptedAt
            ? {
                acceptedAt: existing.acceptedAt,
                ...(existing.acceptedFingerprint ? { acceptedFingerprint: existing.acceptedFingerprint } : {}),
                ...(existing.progressObservedAt ? { progressObservedAt: existing.progressObservedAt } : {}),
                ...(existing.deliveryPending ? { deliveryPending: true } : {}),
                ...(existing.nonRetryableAdmission ? {
                  nonRetryableAdmission: true,
                  ...(existing.lastError ? { lastError: existing.lastError } : {}),
                } : {}),
              }
            : {}),
      };
      if (index < 0) file.sessions.push(record);
      else file.sessions[index] = record;
      sortRecords(file.sessions);
      return { ...record };
    });
  }

  async observeAcceptedProgress(
    harness: HarnessType,
    sessionId: string,
    cwd: string,
    acceptedAt: string,
    fingerprint: string,
    now = new Date(),
  ): Promise<UnfinishedSessionRecord | null> {
    return this.mutate((file) => {
      const key = sessionKey(harness, sessionId, cwd);
      const record = file.sessions.find((candidate) => unfinishedRecordKey(candidate) === key);
      if (!record || record.acceptedAt !== acceptedAt || !record.acceptedFingerprint || record.acceptedFingerprint === fingerprint) return null;
      let changed = false;
      if (!record.progressObservedAt) {
        record.progressObservedAt = now.toISOString();
        changed = true;
      }
      if (record.deliveryPending) {
        delete record.deliveryPending;
        changed = true;
      }
      return changed ? { ...record } : null;
    }, (record) => record !== null);
  }

  async remove(harness: string, sessionId: string, cwd?: string): Promise<boolean> {
    return this.mutate((file) => {
      const normalizedHarness = harnessType(harness);
      const normalizedSessionId = bounded(sessionId, "sessionId");
      const key = cwd ? sessionKey(normalizedHarness, normalizedSessionId, cwd) : undefined;
      const before = file.sessions.length;
      file.sessions = file.sessions.filter((record) => key
        ? unfinishedRecordKey(record) !== key
        : record.harness !== normalizedHarness || record.sessionId !== normalizedSessionId);
      return file.sessions.length !== before;
    }, (changed) => changed);
  }

  async beginAttempt(
    harness: HarnessType,
    sessionId: string,
    maxAttempts: number,
    retryDelayMs: number,
    now = new Date(),
    cwd?: string,
  ): Promise<UnfinishedSessionRecord | null> {
    return this.mutate((file) => {
      const record = findUnfinishedRecord(file.sessions, harness, sessionId, cwd);
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

  async cancelAttempt(attempt: UnfinishedSessionRecord, now = new Date()): Promise<boolean> {
    return this.mutate((file) => {
      const record = file.sessions.find((candidate) => unfinishedRecordKey(candidate) === unfinishedRecordKey(attempt));
      if (!record || record.state !== "recovering" || record.attempts !== attempt.attempts || record.updatedAt !== attempt.updatedAt) return false;
      record.attempts = Math.max(0, record.attempts - 1);
      record.state = "active";
      record.updatedAt = now.toISOString();
      delete record.nextAttemptAt;
      delete record.lastError;
      return true;
    }, (changed) => changed);
  }

  async markFailure(
    harness: HarnessType,
    sessionId: string,
    error: string,
    maxAttempts: number,
    now = new Date(),
    cwd?: string,
  ): Promise<UnfinishedSessionRecord | null> {
    return this.mutate((file) => {
      const record = findUnfinishedRecord(file.sessions, harness, sessionId, cwd);
      if (!record) return null;
      record.state = record.attempts >= maxAttempts ? "exhausted" : "active";
      record.lastError = bounded(error, "error");
      record.updatedAt = now.toISOString();
      return { ...record };
    }, (record) => record !== null);
  }

  async markNotified(harness: HarnessType, sessionId: string, now = new Date(), cwd?: string): Promise<void> {
    await this.mutate((file) => {
      const record = findUnfinishedRecord(file.sessions, harness, sessionId, cwd);
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
  watchdogIntervalMs?: number;
  stalledTurnMs?: number;
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
  private readonly candidateDelayOverrideMs?: number;
  private readonly watchdogIntervalOverrideMs?: number;
  private readonly stalledTurnOverrideMs?: number;
  private recovering: Promise<void> | null = null;
  private retryTimer?: NodeJS.Timeout;
  private watchdogTimer?: NodeJS.Timeout;
  private urgentTimer?: NodeJS.Timeout;
  private watchdogRunning = false;
  private started = false;
  /** Explicit lifecycle cancellation; unlike `started`, false before a manual one-shot recovery is valid. */
  private stopped = false;
  /** Invalidates recovery work that was already awaiting I/O when stop/restart happens. */
  private lifecycleEpoch = 0;
  private readonly completedSessions = new Set<string>();
  private readonly urgentSessions = new Set<string>();
  private readonly watchdogObservations = new Map<string, { fingerprint: string; unchangedSince: number; misses: number }>();
  /** Sessions already continued by the batch planner in the current recovery pass. */
  private readonly continuedThisRecovery = new Set<string>();

  constructor(private readonly options: UnfinishedSessionLauncherOptions) {
    this.maxAttempts = positiveInteger(options.maxAttempts ?? Number(process.env.AGENT_HERDER_AUTOSTART_MAX_ATTEMPTS || 3), 3);
    this.retryDelayMs = nonNegativeInteger(options.retryDelayMs ?? Number(process.env.AGENT_HERDER_AUTOSTART_RETRY_DELAY_MS || 5_000), 5_000);
    this.reconcileIntervalMs = positiveInteger(
      options.reconcileIntervalMs ?? Number(process.env.AGENT_HERDER_UNFINISHED_RECONCILE_INTERVAL_MS || 60_000),
      60_000,
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
    this.candidateDelayOverrideMs = options.discoveryIdleMs;
    this.watchdogIntervalOverrideMs = options.watchdogIntervalMs;
    this.stalledTurnOverrideMs = options.stalledTurnMs;
  }

  async handleEvent(provider: string, event: HarnessEvent): Promise<void> {
    if (!event.sessionId || !isAutocontinueInventoryHarness(provider)) return;
    if (event.kind === "session.deleted") {
      this.completedSessions.add(sessionKey(provider, event.sessionId));
      this.urgentSessions.delete(sessionKey(provider, event.sessionId));
      await this.options.store.remove(provider, event.sessionId);
      return;
    }
    if (event.kind === "turn.completed" || event.kind === "turn.failed") {
      // A finished model turn is not proof that the user's task is complete.
      // Keep it eligible for semantic re-evaluation after the quiet window.
      const adapter = this.options.adapters.get(provider);
      const session = await adapter?.getSession(event.sessionId);
      const key = session ? sessionSourceKey(session) : sessionKey(provider, event.sessionId);
      this.completedSessions.delete(key);
      this.urgentSessions.add(key);
      if (session && await this.isEnabled(session.harness, session.id, session.cwd)) {
        await this.options.store.markStarted({ ...session, status: "idle" }, this.generationId, new Date(), event.kind === "turn.completed");
      }
      this.scheduleUrgentRecovery();
      return;
    }
    if (event.kind !== "turn.started") return;
    const adapter = this.options.adapters.get(provider);
    const session = await adapter?.getSession(event.sessionId);
    if (session) await this.armSession(session);
  }

  async armSession(session: AgentSession, deliveryPending = false, admittedFailure?: string): Promise<boolean> {
    if (!isAutocontinueInventoryHarness(session.harness)) return false;
    const adapter = this.options.adapters.get(session.harness);
    if (!adapter?.resumeSession) return false;
    if (!await this.isEnabled(session.harness, session.id, session.cwd)) return false;
    await this.pinActiveSession(adapter, session.id);
    this.completedSessions.delete(sessionSourceKey(session));
    this.urgentSessions.delete(sessionSourceKey(session));
    await this.options.store.markStarted(session, this.generationId, new Date(), true, true, deliveryPending, admittedFailure);
    return true;
  }

  async forget(harness: string, sessionId: string): Promise<void> {
    if (!isSupportedHarness(harness)) return;
    this.completedSessions.add(sessionKey(harness, sessionId));
    await this.options.store.remove(harness, sessionId);
  }

  /** Start process-lifetime recovery without delaying the HTTP/MCP control plane. */
  start(): () => void {
    this.lifecycleEpoch += 1;
    this.started = true;
    this.stopped = false;
    void this.recoverPending().catch((error) => {
      console.error(`[agent-herder] автозапуск незавершённых сессий завершился ошибкой: ${errorText(error)}`);
    });
    void this.scheduleWatchdog(0);
    return () => this.stop();
  }

  stop(): void {
    this.lifecycleEpoch += 1;
    this.started = false;
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = undefined;
    if (this.urgentTimer) clearTimeout(this.urgentTimer);
    this.urgentTimer = undefined;
  }

  private scheduleUrgentRecovery(delayMs = 250): void {
    if (!this.started) return;
    if (this.urgentTimer) clearTimeout(this.urgentTimer);
    this.urgentTimer = setTimeout(() => {
      this.urgentTimer = undefined;
      if (!this.started) return;
      void this.recoverPending().catch((error) => {
        console.error(`[agent-herder] срочное автопродолжение завершилось ошибкой: ${errorText(error)}`);
      });
    }, delayMs);
    this.urgentTimer.unref?.();
  }

  private async scheduleWatchdog(delayMs?: number): Promise<void> {
    if (!this.started) return;
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    const settings = await this.options.settingsStore.getSettings().catch(() => null);
    const configured = this.watchdogIntervalOverrideMs
      ?? Math.max(5_000, (settings?.watchdogIntervalSeconds ?? 10) * 1_000);
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = undefined;
      void this.runWatchdog().finally(() => { void this.scheduleWatchdog(); });
    }, delayMs ?? configured);
    this.watchdogTimer.unref?.();
  }

  private async runWatchdog(): Promise<void> {
    if (!this.started || this.watchdogRunning) return;
    this.watchdogRunning = true;
    try {
      const settings = await this.options.settingsStore.getSettings();
      if (!settings.watchdogEnabled || !settings.enabled) return;
      const stallMs = this.stalledTurnOverrideMs ?? settings.stalledTurnMinutes * 60_000;
      const records = (await this.options.store.list())
        .filter((record) => isAutocontinueInventoryHarness(record.harness) && record.state !== "exhausted" && !record.nonRetryableAdmission)
        .map((record) => ({
          durable: true,
          harness: record.harness,
          sessionId: record.sessionId,
          cwd: record.cwd,
          workspaceIdentity: record.workspaceIdentity,
          updatedAt: record.updatedAt,
          acceptedAt: record.acceptedAt,
          acceptedFingerprint: record.acceptedFingerprint,
          progressObservedAt: record.progressObservedAt,
          deliveryPending: record.deliveryPending,
        }));
      const explicit = settings.sessions
        .filter((record) => record.enabled && isAutocontinueInventoryHarness(record.harness))
        .map((record) => ({
          durable: false,
          harness: record.harness,
          sessionId: record.sessionId,
          cwd: record.cwd,
          workspaceIdentity: record.cwd,
          updatedAt: record.updatedAt,
          acceptedAt: undefined,
          acceptedFingerprint: undefined,
          progressObservedAt: undefined,
          deliveryPending: undefined,
        }));
      const inventory = new Map((await this.options.store.listInventory())
        .map((record) => [inventoryRecordKey(record), record]));
      // Durable records carry accepted-delivery progress. Let them override a
      // matching explicit setting while still adding explicitly enabled
      // sessions which have not emitted a turn-start event yet.
      const targets = [...new Map([...explicit, ...records]
        .map((record) => [sessionKey(record.harness, record.sessionId, record.workspaceIdentity || record.cwd), record])).values()]
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
      let urgent = false;
      for (const record of targets) {
        if (!await this.isEnabled(record.harness, record.sessionId, record.cwd)) continue;
        const adapter = this.options.adapters.get(record.harness);
        if (!adapter?.resumeSession) continue;
        const key = sessionKey(record.harness, record.sessionId, record.workspaceIdentity || record.cwd);
        let session: AgentSession | null = null;
        try { session = await adapter.getSession(record.sessionId); } catch { /* counted as a miss below */ }
        if (!session) {
          const previous = this.watchdogObservations.get(key);
          const misses = (previous?.misses ?? 0) + 1;
          this.watchdogObservations.set(key, { fingerprint: "missing", unchangedSince: previous?.unchangedSince ?? Date.now(), misses });
          // Native indexes can disappear briefly while a harness persists a
          // turn. Require three consecutive observations and enqueue exactly
          // once; the recovery retry loop owns subsequent attempts.
          if (misses !== 3) continue;
          await this.options.store.markStarted({
            id: record.sessionId,
            harness: record.harness,
            status: "error",
            title: "Сессия исчезла из native state",
            cwd: record.cwd,
            lastActivity: record.updatedAt,
            needsPermission: false,
          }, this.generationId);
          this.urgentSessions.add(key);
          urgent = true;
          console.error(`[agent-herder] watchdog: ${key} исчезла из native state; запускаю срочное возобновление`);
          continue;
        }
        const priorAssessment = inventory.get(sessionSourceKey(session));
        // An explicit opt-in remains after a task is completed. A later native
        // idle -> stopped transition is not new work, so leave it to normal
        // discovery (which invalidates the verdict when transcript evidence
        // actually changes) instead of manufacturing an urgent recovery.
        if (!record.durable
          && session.status === "stopped"
          && priorAssessment?.verdict?.verdict === "completed"
          && priorAssessment.verdict.confidence > 0
          && evidenceIsCurrent(priorAssessment)
          && inventoryRecordKey(priorAssessment) === sessionSourceKey(session)
          && priorAssessment.title === session.title
          && priorAssessment.lastActivity === session.lastActivity) continue;
        const pendingPermissionIds = session.harness === "zcode"
          && session.title.trim().startsWith("Автопродолжение —")
          && Array.isArray(session.meta?.pendingRequestIds)
          ? session.meta.pendingRequestIds.filter((value): value is string => typeof value === "string" && value.length > 0)
          : [];
        for (const permissionId of pendingPermissionIds) {
          const approved = await adapter.respondPermission(session.id, permissionId, "allow", true);
          if (approved.ok) {
            console.error(`[agent-herder] watchdog: разрешён запрос ${permissionId} для автономного продолжения zcode:${session.id}`);
          } else {
            console.error(`[agent-herder] watchdog: не удалось разрешить запрос ${permissionId} для zcode:${session.id}: ${approved.error || "операция отклонена"}`);
          }
        }
        const hasActiveToolCall = session.meta?.hasActiveToolCall === true;
        const fingerprint = sessionProgressFingerprint(session);
        const previous = this.watchdogObservations.get(key);
        const observation = previous?.fingerprint === fingerprint
          ? { fingerprint, unchangedSince: previous.unchangedSince, misses: 0 }
          : { fingerprint, unchangedSince: Date.now(), misses: 0 };
        this.watchdogObservations.set(key, observation);
        const lastActivity = Date.parse(session.lastActivity);
        const stalled = session.status === "running"
          && !hasActiveToolCall
          && Number.isFinite(lastActivity)
          && Date.now() - lastActivity >= stallMs
          && Date.now() - observation.unchangedSince >= stallMs;
        let progressObservedAt = record.progressObservedAt;
        if (record.acceptedAt && record.acceptedFingerprint && fingerprint !== record.acceptedFingerprint) {
          const progressed = await this.options.store.observeAcceptedProgress(
            record.harness,
            record.sessionId,
            record.workspaceIdentity || record.cwd,
            record.acceptedAt,
            fingerprint,
          );
          progressObservedAt = progressed?.progressObservedAt ?? progressObservedAt;
        }
        // Native completion events are best-effort. If a prompt accepted by
        // Herder later becomes idle with newer native activity, re-run the
        // semantic completion check once for that fingerprint instead of
        // leaving the durable turn active forever (or blindly prompting it).
        const idleAfterAcceptedDelivery = session.status === "idle"
          && Boolean(record.acceptedAt)
          && Boolean(progressObservedAt || record.acceptedFingerprint !== fingerprint)
          && previous?.fingerprint !== fingerprint;
        if (session.status !== "error" && session.status !== "stopped" && !stalled && !idleAfterAcceptedDelivery) continue;
        await this.options.store.markStarted({ ...session, status: session.status === "running" ? "error" : session.status }, this.generationId);
        this.urgentSessions.add(key);
        urgent = true;
        const reason = stalled
          ? "зависла без прогресса"
          : idleAfterAcceptedDelivery
            ? "завершила принятый ход без native completion event"
            : `перешла в ${session.status}`;
        console.error(`[agent-herder] watchdog: ${key} ${reason}; запускаю срочную проверку`);
      }
      if (urgent) this.scheduleUrgentRecovery(0);
    } finally {
      this.watchdogRunning = false;
    }
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
    const lifecycleEpoch = this.lifecycleEpoch;
    this.continuedThisRecovery.clear();
    const runtimeSettings = await this.options.settingsStore.getSettings();
    if (!this.lifecycleActive(lifecycleEpoch)) return;
    const inventoryWindowMs = this.options.inventoryWindowMs
      ?? runtimeSettings.inventoryWindowHours * 60 * 60 * 1_000;
    const pruned = await this.options.store.pruneAutocontinueScope(new Date(Date.now() - inventoryWindowMs));
    if (!this.lifecycleActive(lifecycleEpoch)) return;
    if (pruned.sessions > 0 || pruned.inventory > 0) {
      console.error(`[agent-herder] очищен реестр автопродолжения: ${pruned.sessions} чужих turn-записей, ${pruned.inventory} записей вне окна`);
    }
    const discovery = await this.discoverUnfinishedSessions(lifecycleEpoch);
    if (!this.lifecycleActive(lifecycleEpoch) || discovery === "blocked") return;
    // Deliberately sequential: a restart must not multiply the host's agent workload.
    let resumedThisCycle = 0;
    const launches: Array<Promise<void>> = [];
    const records = await this.options.store.list();
    if (!this.lifecycleActive(lifecycleEpoch)) return;
    records.sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
    for (const record of records) {
      if (!this.lifecycleActive(lifecycleEpoch)) break;
      if (!isAutocontinueInventoryHarness(record.harness)) continue;
      const recordKey = unfinishedRecordKey(record);
      if (this.continuedThisRecovery.has(recordKey)) continue;
      if (!await this.isEnabled(record.harness, record.sessionId, record.cwd)) {
        await this.options.store.remove(record.harness, record.sessionId, record.workspaceIdentity || record.cwd);
        continue;
      }
      if (record.state === "exhausted") {
        await this.notifyExhausted(record);
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
      const urgent = this.urgentSessions.has(recordKey) || this.urgentSessions.has(sessionKey(record.harness, record.sessionId));
      if (record.nonRetryableAdmission) {
        // The exact prompt crossed the native idempotency boundary and its turn
        // failed terminally. Keep ownership/diagnostics durable, but never
        // submit that prompt again from watchdog or reconciliation.
        await this.pinActiveSession(adapter, record.sessionId, runtimeSettings);
        continue;
      }
      if (!urgent && record.deliveryPending) {
        // sendPrompt admission is the idempotency boundary. Until native state
        // proves progress, watchdog owns observation and no recovery cycle may
        // repeat the prompt merely because turn.started is still unconfirmed.
        await this.pinActiveSession(adapter, record.sessionId, runtimeSettings);
        continue;
      }
      if (!urgent && (session?.status === "needs_input" || session?.needsPermission)) {
        await this.pinActiveSession(adapter, record.sessionId, runtimeSettings);
        await this.options.store.markStarted(session, this.generationId);
        continue;
      }
      if (!urgent && session?.status === "running") {
        await this.pinActiveSession(adapter, record.sessionId, runtimeSettings);
        await this.options.store.markStarted(session, this.generationId);
        continue;
      }
      if (!urgent && record.generationId === this.generationId && Date.now() - Date.parse(record.updatedAt) < this.discoveryIdleMs) {
        await this.pinActiveSession(adapter, record.sessionId, runtimeSettings);
        continue;
      }
      if (resumedThisCycle >= this.maxResumesPerCycle) continue;
      if (!this.lifecycleActive(lifecycleEpoch)) break;
      const attempt = await this.options.store.beginAttempt(
        record.harness,
        record.sessionId,
        this.maxAttempts,
        this.retryDelayMs,
        new Date(),
        record.workspaceIdentity || record.cwd,
      );
      if (!this.lifecycleActive(lifecycleEpoch)) {
        if (attempt) await this.options.store.cancelAttempt(attempt);
        break;
      }
      if (!attempt) continue;
      resumedThisCycle += 1;
      launches.push(this.launchContinuation(adapter, record, attempt, session, lifecycleEpoch));
    }
    await Promise.all(launches);
  }

  private async launchContinuation(
    adapter: HarnessAdapter,
    record: UnfinishedSessionRecord,
    attempt: UnfinishedSessionRecord,
    session: AgentSession | null,
    lifecycleEpoch: number,
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
    let promptAccepted = false;
    let promptPending = false;
    let promptAdmissionFailure: string | undefined;
    try {
      if (!this.lifecycleActive(lifecycleEpoch)) {
        await this.options.store.cancelAttempt(attempt);
        return;
      }
      const runtimeSettings = await this.options.settingsStore.getSettings();
      if (!this.lifecycleActive(lifecycleEpoch)) {
        await this.options.store.cancelAttempt(attempt);
        return;
      }
      if (runtimeSettings.rolloverExpiredCache && session && this.options.cacheHandoff) {
        const handoff = await this.options.cacheHandoff.maybeRollover(session, new Date(), {
          movePinned: runtimeSettings.movePinnedOnRollover,
        });
        if ((handoff.kind === "rolled_over" || handoff.kind === "admitted_failed") && handoff.session) {
          const handoffFailure = handoff.kind === "admitted_failed"
            ? handoff.admittedFailure || "Native cache handoff turn failed after admission"
            : undefined;
          // maybeRollover already created and handed off the replacement. Even
          // if stop arrived during that await, settle durable registry state;
          // do not repeat the rollover on the next process generation.
          if (!this.lifecycleActive(lifecycleEpoch)) {
            await this.options.settingsStore.setSession({ harness: record.harness, sessionId: record.sessionId, cwd: record.cwd }, false);
            await this.options.store.remove(record.harness, record.sessionId, record.workspaceIdentity || record.cwd);
            await this.options.store.markStarted(handoff.session, this.generationId, new Date(), true, true, handoff.deliveryPending === true, handoffFailure);
            return;
          }
          if (!runtimeSettings.movePinnedOnRollover) await this.pinActiveSession(adapter, handoff.session.id, runtimeSettings);
          if (!this.lifecycleActive(lifecycleEpoch)) {
            await this.options.settingsStore.setSession({ harness: record.harness, sessionId: record.sessionId, cwd: record.cwd }, false);
            await this.options.store.remove(record.harness, record.sessionId, record.workspaceIdentity || record.cwd);
            await this.options.store.markStarted(handoff.session, this.generationId, new Date(), true, true, handoff.deliveryPending === true, handoffFailure);
            return;
          }
          await this.options.settingsStore.setSession({ harness: record.harness, sessionId: record.sessionId, cwd: record.cwd }, false);
          await this.options.store.remove(record.harness, record.sessionId, record.workspaceIdentity || record.cwd);
          await this.options.store.markStarted(handoff.session, this.generationId, new Date(), true, true, handoff.deliveryPending === true, handoffFailure);
          this.urgentSessions.delete(unfinishedRecordKey(record));
          console.error(handoffFailure
            ? `[agent-herder] новая cache-handoff сессия ${handoff.session.id} приняла prompt, но native turn failed без безопасного retry: ${handoffFailure}`
            : `[agent-herder] протухшая сессия ${record.harness}:${record.sessionId} продолжена в новой ${handoff.session.id}`);
          return;
        }
        if (!this.lifecycleActive(lifecycleEpoch)) {
          await this.options.store.cancelAttempt(attempt);
          return;
        }
      }
      if (!this.lifecycleActive(lifecycleEpoch)) {
        await this.options.store.cancelAttempt(attempt);
        return;
      }
      const resumed = adapter.resumeSession ? await adapter.resumeSession(record.sessionId) : { ok: true };
      if (!resumed.ok) throw new Error(resumed.error || "возобновление отклонено");
      if (!this.lifecycleActive(lifecycleEpoch)) {
        await this.options.store.cancelAttempt(attempt);
        return;
      }
      await this.pinActiveSession(adapter, record.sessionId, runtimeSettings);
      if (!this.lifecycleActive(lifecycleEpoch)) {
        await this.options.store.cancelAttempt(attempt);
        return;
      }
      const sent = await adapter.sendMessage(record.sessionId, { message: this.continuationMessage, queue: true });
      const terminalAdmission = admittedNonRetryableFailure(sent);
      if (terminalAdmission) {
        promptAccepted = true;
        promptAdmissionFailure = terminalAdmission;
        await this.options.store.markStarted(trackedSession, this.generationId, new Date(), true, true, false, terminalAdmission);
        this.urgentSessions.delete(unfinishedRecordKey(record));
        console.error(`[agent-herder] ${record.harness}:${record.sessionId} приняла prompt, но native turn завершился без безопасного retry: ${terminalAdmission}`);
        return;
      }
      if (!sent.ok) throw new Error(sent.error || "команда продолжения отклонена");
      promptAccepted = true;
      promptPending = sent.pending === true;
      // The prompt is now accepted by the native harness. Always settle the
      // durable record even if stop arrived during sendMessage; rolling the
      // attempt back here could enqueue the same continuation after restart.
      await this.options.store.markStarted(trackedSession, this.generationId, new Date(), true, true, promptPending);
      this.urgentSessions.delete(unfinishedRecordKey(record));
      console.error(`[agent-herder] автоматически продолжена незавершённая сессия ${record.harness}:${record.sessionId}`);
    } catch (error) {
      if (promptAccepted) {
        try {
          await this.options.store.markStarted(trackedSession, this.generationId, new Date(), true, true, promptPending, promptAdmissionFailure);
        } catch (settleError) {
          console.error(`[agent-herder] ZCode/Codex prompt accepted but durable settle failed for ${record.sessionId}: ${errorText(settleError)}`);
        }
        return;
      }
      if (!this.lifecycleActive(lifecycleEpoch)) {
        await this.options.store.cancelAttempt(attempt);
        return;
      }
      const failure = errorText(error);
      if (isBusyCodexWriter(record.harness, failure)) {
        if (!this.lifecycleActive(lifecycleEpoch)) {
          await this.options.store.cancelAttempt(attempt);
          return;
        }
        const inbox = this.options.deferredStore ?? deferredMessages;
        const pending = await inbox.list(record.sessionId);
        if (!this.lifecycleActive(lifecycleEpoch)) {
          await this.options.store.cancelAttempt(attempt);
          return;
        }
        let deferredAccepted = pending.some((message) => isAutocontinueRequest(message.message));
        if (!deferredAccepted) {
          await inbox.add(record.sessionId, this.continuationMessage);
          deferredAccepted = true;
        }
        if (!this.lifecycleActive(lifecycleEpoch) && !deferredAccepted) {
          await this.options.store.cancelAttempt(attempt);
          return;
        }
        // Existing or newly-added deferred work is already durable. Settle it
        // even if stop arrived after the inbox write so restart cannot add a
        // duplicate continuation.
        await this.options.store.markStarted(trackedSession, this.generationId, new Date(), false, true, true);
        console.error(`[agent-herder] продолжение Codex отложено до безопасной границы хода ${record.sessionId}`);
        return;
      }
      await this.fail(attempt, failure);
    }
  }

  private async discoverUnfinishedSessions(lifecycleEpoch: number): Promise<DiscoveryOutcome> {
    const runtimeSettings = await this.options.settingsStore.getSettings();
    const inventoryWindowMs = this.options.inventoryWindowMs
      ?? runtimeSettings.inventoryWindowHours * 60 * 60 * 1_000;
    const listedCandidates: Array<{ adapter: HarnessAdapter; session: AgentSession }> = [];
    const inventoryBatch: UnfinishedSessionInventoryRecord[] = [];
    const exhaustiveHarnesses = new Set<"codex" | "zcode">();
    const observedSourceKeys = new Set<string>();
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
      let receipt = null;
      try { receipt = adapter.getSessionSnapshotReceipt?.() ?? null; } catch { /* unknown snapshot: preserve inventory */ }
      if (receipt?.exhaustive === true) exhaustiveHarnesses.add(provider);
      for (const session of sessions) {
        const lastActivity = Date.parse(session.lastActivity);
        if (!Number.isFinite(lastActivity) || Date.now() - lastActivity > inventoryWindowMs) continue;
        const sourceKey = sessionSourceKey(session);
        observedSourceKeys.add(sourceKey);
        listedCandidates.push({ adapter, session });
      }
    }
    // Migration and dedupe must finish in one store transaction before known
    // keys or recovery records are read. Otherwise a legacy cwd key and the
    // same native session's canonical workspace key can each admit a prompt.
    const listedSessions = listedCandidates.map(({ session }) => session);
    await this.options.settingsStore.migrateWorkspaceIdentities(listedSessions);
    await this.options.store.migrateWorkspaceIdentities(listedSessions);
    const durableRecords = await this.options.store.list();
    const known = new Set(durableRecords.map(unfinishedRecordKey));
    const nonRetryableAdmissions = new Set(durableRecords
      .filter((record) => record.nonRetryableAdmission)
      .map(unfinishedRecordKey));
    const priorInventory = new Map((await this.options.store.listInventory()).map((record) => [inventoryRecordKey(record), record]));
    // A terminal native admission remains visible in the exact 48h snapshot,
    // but must never be replanned into another prompt.
    const candidates = listedCandidates.filter(({ session }) => !nonRetryableAdmissions.has(sessionSourceKey(session)));
    candidates.sort((left, right) => Date.parse(right.session.lastActivity) - Date.parse(left.session.lastActivity));
    await this.options.store.reconcileInventorySnapshot(
      exhaustiveHarnesses,
      observedSourceKeys,
    );
    if (this.options.judge?.plan) {
      const assessed: AssessedSession[] = [];
      for (const { adapter, session } of candidates) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (!this.lifecycleActive(lifecycleEpoch)) return "idle";
        const autoResumeEnabled = await this.isEnabled(session.harness, session.id, session.cwd);
        const sourceKey = sessionSourceKey(session);
        const urgent = this.urgentSessions.has(sourceKey) || this.urgentSessions.has(sessionKey(session.harness, session.id));
        const previous = priorInventory.get(sourceKey);
        const metadataUnchanged = previous?.lastActivity === session.lastActivity
          && previous.status === session.status
          && (previous.workspaceIdentity || previous.cwd) === sessionWorkspaceIdentity(session)
          && previous.title === session.title;
        const settledAndUnchanged = metadataUnchanged && evidenceIsCurrent(previous)
          && previous?.verdict && previous.verdict.confidence > 0
          && (previous.verdict.verdict === "completed"
            || previous.verdict.verdict === "needs_human"
            || (previous.verdict.verdict === "unfinished" && session.status === "running"));
        if (settledAndUnchanged && !urgent) continue;
        const candidateDelayMs = this.candidateDelayOverrideMs
          ?? Math.max(this.discoveryIdleMs, unfinishedProbeDelayMs(session));
        const oldEnough = urgent || Date.now() - Date.parse(session.lastActivity) >= candidateDelayMs;
        if ((session.status === "running" && !urgent) || !oldEnough) continue;
        const messages = await sessionEvidenceMessages(adapter, session.id, runtimeSettings.evidenceMessageCount);
        const transcriptTail = completionEvidence(messages ?? [], runtimeSettings.evidenceMessageCount);
        const unchanged = metadataUnchanged && previous?.transcriptTail === transcriptTail;
        const actionable = urgent
          || !previous?.verdict
          || previous.verdict.confidence === 0
          || !unchanged
          || previous.verdict.verdict === "unfinished";
        const latestSemanticMessage = [...messages].reverse().find((message) =>
          (message.role === "user" || message.role === "assistant") && Boolean(message.text?.trim()));
        if (actionable) assessed.push({ adapter, session, sourceKey, autoResumeEnabled, transcriptTail, ...(latestSemanticMessage ? {
          latestSemanticMessage: { role: latestSemanticMessage.role, text: latestSemanticMessage.text },
        } : {}) });
      }
      if (assessed.length > 0) {
        // Persist the refreshed native snapshot before the remote plan. A
        // failed/timeout plan must not leave a new or changed 48h source absent
        // from the authoritative inventory, nor preserve a stale verdict.
        await this.options.store.upsertInventoryBatch(assessed.map((candidate) => inventoryFromAssessment(candidate)));
        try {
          const plan = await this.planAssessedSessions(assessed);
          if (!this.lifecycleActive(lifecycleEpoch)) return "idle";
          await this.applyBatchPlan(plan, assessed, lifecycleEpoch);
          return "ready";
        } catch (error) {
          console.error(`[agent-herder] единый план MiniMax не построен; посессионный fallback запрещён: ${errorText(error)}`);
          return "blocked";
        }
      }
      // Empty fresh inventory is not an unsafe planner failure. Persisted
      // turn.started records may still be recoverable by exact session ID even
      // when ZCode's cross-workspace task index is temporarily incomplete.
      if (assessed.length === 0) return "idle";
    }
    let judgements = 0;
    const equivalentSessions = new Map<string, string>();
    for (const { adapter, session } of candidates) {
      // SQLite transcript reads and JSON parsing are local, but a large
      // 48-hour inventory must still yield so the control-plane HTTP server
      // remains responsive throughout reconciliation.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (!this.lifecycleActive(lifecycleEpoch)) return "idle";
      if (!isAutocontinueInventoryHarness(session.harness)) continue;
      const harness = session.harness;
      const key = sessionSourceKey(session);
      const messages = await sessionEvidenceMessages(adapter, session.id, runtimeSettings.evidenceMessageCount);
      const transcriptTail = completionEvidence(messages ?? [], runtimeSettings.evidenceMessageCount);
      const previous = priorInventory.get(key);
      const unchanged = previous?.lastActivity === session.lastActivity
        && previous.transcriptTail === transcriptTail
        && evidenceIsCurrent(previous);
      const equivalentKey = `${harness}:${normalize(session.cwd)}:${session.title.trim().toLowerCase()}`;
      const newerEquivalent = equivalentSessions.get(equivalentKey);
      equivalentSessions.set(equivalentKey, newerEquivalent || session.id);
      let verdict = newerEquivalent
        ? { verdict: "completed" as const, reason: `Заменена более новой сессией с той же задачей: ${newerEquivalent}`, confidence: 0.95, judgedAt: new Date().toISOString() }
        : unchanged ? previous?.verdict : undefined;
      if (!newerEquivalent && this.completedSessions.has(key)) {
        verdict = { verdict: "completed", reason: "Session was deleted or explicitly forgotten", confidence: 1, judgedAt: new Date().toISOString() };
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
        workspaceIdentity: sessionWorkspaceIdentity(session),
        title: session.title,
        status: session.status,
        lastActivity: session.lastActivity,
        transcriptTail,
        evidenceVersion: CURRENT_EVIDENCE_VERSION,
        evidenceFingerprint: evidenceFingerprint(transcriptTail),
        observedAt: new Date().toISOString(),
        ...(verdict ? { verdict } : {}),
      };
      inventoryBatch.push(inventory);
      if (verdict?.verdict !== "unfinished") {
        if (verdict) await this.options.store.remove(harness, session.id, sessionWorkspaceIdentity(session));
        known.delete(key);
        continue;
      }
      if (known.has(key) || !await this.isEnabled(harness, session.id, session.cwd)) continue;
      await this.options.store.markStarted(session, `judged-${this.generationId}`);
      known.add(key);
    }
    await this.options.store.upsertInventoryBatch(inventoryBatch);
    return "ready";
  }

  private async applyBatchPlan(plan: SessionBatchPlan, assessed: AssessedSession[], lifecycleEpoch: number): Promise<void> {
    const runtimeSettings = await this.options.settingsStore.getSettings();
    if (!this.lifecycleActive(lifecycleEpoch)) return;
    const byId = new Map(assessed.map((candidate) => [candidate.sourceKey, candidate]));
    plan = canonicalizePlanSourceKeys(plan, assessed);
    assertBatchPlanCoverage(plan, assessed);
    plan = enforcePlanWorkspaceBoundaries(plan, byId);
    const latestActivity = (group: SessionBatchPlanGroup): number => Math.max(...group.sourceSessionIds.map((id) => Date.parse(byId.get(id)!.session.lastActivity)));
    const groups = [...plan.groups].sort((left, right) => latestActivity(right) - latestActivity(left));
    const inventoryBatch: UnfinishedSessionInventoryRecord[] = [];
    let launched = 0;
    for (const group of groups) {
      if (!this.lifecycleActive(lifecycleEpoch)) return;
      const sources = group.sourceSessionIds.map((id) => byId.get(id)!);
      const plannedPrimary = byId.get(group.primarySessionId)!;
      const humanGatedSources = sources.filter(({ session }) => session.status === "needs_input" || session.needsPermission);
      const resumableSources = sources.filter((candidate) => candidate.autoResumeEnabled
        && !humanGatedSources.includes(candidate));
      const running = resumableSources.filter(({ session, sourceKey }) => session.status === "running"
          && !this.urgentSessions.has(sourceKey))
        .sort((left, right) => Date.parse(right.session.lastActivity) - Date.parse(left.session.lastActivity))[0];
      const primary = running
        ?? (plannedPrimary.autoResumeEnabled ? plannedPrimary : undefined)
        ?? [...resumableSources].sort((left, right) => Date.parse(right.session.lastActivity) - Date.parse(left.session.lastActivity))[0]
        ?? plannedPrimary;
      const judgedAt = new Date().toISOString();
      const verdict = { verdict: group.verdict, reason: group.reason, confidence: group.confidence, judgedAt } satisfies SessionInventoryVerdict;
      const pushInventory = (candidate: AssessedSession, override = verdict): void => {
        inventoryBatch.push(inventoryFromAssessment(candidate, override));
      };

      // A semantic planner cannot answer a native input/permission request on
      // the user's behalf. Keep the whole task group stopped and make the gate
      // explicit in inventory; a later transcript/status change will cause a
      // fresh audit and can then make the group eligible again.
      if (humanGatedSources.length > 0) {
        const humanGateVerdict = {
          verdict: "needs_human",
          reason: "Объединённая задача ожидает ответа или разрешения человека",
          confidence: 1,
          judgedAt,
        } satisfies SessionInventoryVerdict;
        for (const source of sources) {
          pushInventory(source, humanGateVerdict);
          this.urgentSessions.delete(source.sourceKey);
          await this.options.store.remove(source.session.harness, source.session.id, sessionWorkspaceIdentity(source.session));
        }
        continue;
      }

      // Workspace splits and missing handoffs use needs_human/confidence=0 as
      // an inconclusive result, not a terminal human blocker. Preserve the
      // record for the next batch without inventing a continuation.
      if (group.verdict === "needs_human" && group.confidence === 0) {
        for (const source of sources) {
          pushInventory(source);
          if (source.autoResumeEnabled) {
            await this.options.store.markStarted(source.session, `judge-retry-${this.generationId}`);
            this.continuedThisRecovery.add(source.sourceKey);
          }
        }
        continue;
      }

      if (group.verdict !== "unfinished") {
        for (const source of sources) {
          pushInventory(source);
          this.urgentSessions.delete(source.sourceKey);
          await this.options.store.remove(source.session.harness, source.session.id, sessionWorkspaceIdentity(source.session));
        }
        continue;
      }

      // A session-level opt-out disables autonomous continuation only. Its
      // evidence is still audited and refreshed above, but no prompt may be
      // delivered unless this group has an explicitly resumable source.
      if (resumableSources.length === 0) {
        for (const source of sources) {
          pushInventory(source);
          this.urgentSessions.delete(source.sourceKey);
          await this.options.store.remove(source.session.harness, source.session.id, sessionWorkspaceIdentity(source.session));
        }
        continue;
      }

      // A queued Herder prompt is already durable in the native transcript.
      // Until the harness produces an assistant message after it, another
      // resume cycle must not enqueue a near-identical prompt again.
      if (primary.latestSemanticMessage?.role === "user" && isAutocontinueRequest(primary.latestSemanticMessage.text)) {
        await this.options.store.markStarted(primary.session, this.generationId);
        this.continuedThisRecovery.add(primary.sourceKey);
        for (const source of sources) {
          pushInventory(source);
          this.urgentSessions.delete(source.sourceKey);
        }
        console.error(`[agent-herder] ${primary.session.harness}:${primary.session.id} уже ожидает ответ на автопродолжение; повтор не ставлю`);
        continue;
      }

      const handoff = batchContinuationPrompt(group, sources);
      if (running) {
        if (!this.lifecycleActive(lifecycleEpoch)) return;
        await this.pinActiveSession(running.adapter, running.session.id, runtimeSettings);
        if (!this.lifecycleActive(lifecycleEpoch)) return;
        if (sources.length > 1) {
          const inbox = this.options.deferredStore ?? deferredMessages;
          const pending = await inbox.list(running.session.id);
          if (!this.lifecycleActive(lifecycleEpoch)) return;
          if (!pending.some((message) => isAutocontinueRequest(message.message))) await inbox.add(running.session.id, handoff);
          if (!this.lifecycleActive(lifecycleEpoch)) return;
        }
        await this.options.store.markStarted(running.session, this.generationId);
        for (const source of sources) {
          if (source.sourceKey === running.sourceKey) pushInventory(source);
          else {
            pushInventory(source, {
              verdict: "completed",
              reason: `Объединена с работающей сессией «${group.topic}»: ${running.session.id}`,
              confidence: group.confidence,
              judgedAt,
            });
            await this.options.settingsStore.setSession({ harness: source.session.harness, sessionId: source.session.id, cwd: source.session.cwd }, false);
            await this.options.store.remove(source.session.harness, source.session.id, sessionWorkspaceIdentity(source.session));
          }
        }
        continue;
      }

      const groupUrgent = sources.some(({ sourceKey, session }) => this.urgentSessions.has(sourceKey)
        || this.urgentSessions.has(sessionKey(session.harness, session.id)));
      const oldEnough = groupUrgent || Date.now() - Date.parse(primary.session.lastActivity) >= this.discoveryIdleMs;
      if (!oldEnough || launched >= this.maxResumesPerCycle) {
        for (const source of sources) {
          pushInventory(source);
          await this.options.store.remove(source.session.harness, source.session.id, sessionWorkspaceIdentity(source.session));
        }
        continue;
      }

      const cache = cacheWindowFor(primary.session);
      const cacheAgeMs = Math.max(0, Date.now() - Date.parse(primary.session.lastActivity));
      const reuseExisting = !runtimeSettings.rolloverExpiredCache || !cache.ttlMs || cacheAgeMs < cache.ttlMs;
      if (reuseExisting && primary.adapter.resumeSession) {
        launched += 1;
        try {
          if (!this.lifecycleActive(lifecycleEpoch)) return;
          const resumed = await primary.adapter.resumeSession(primary.session.id);
          if (!resumed.ok) throw new Error(resumed.error || "возобновление исходной сессии отклонено");
          if (!this.lifecycleActive(lifecycleEpoch)) return;
          await this.pinActiveSession(primary.adapter, primary.session.id, runtimeSettings);
          if (!this.lifecycleActive(lifecycleEpoch)) return;
          const sent = await primary.adapter.sendMessage(primary.session.id, { message: handoff, queue: true });
          const terminalAdmission = admittedNonRetryableFailure(sent);
          if (terminalAdmission) {
            await this.options.store.markStarted(primary.session, this.generationId, new Date(), true, true, false, terminalAdmission);
            this.continuedThisRecovery.add(primary.sourceKey);
            this.urgentSessions.delete(primary.sourceKey);
            for (const source of sources) pushInventory(source);
            console.error(`[agent-herder] единый plan prompt принят ${primary.session.harness}:${primary.session.id}, но native turn failed без безопасного retry: ${terminalAdmission}`);
            continue;
          }
          if (!sent.ok) throw new Error(sent.error || "исходная сессия не приняла объединённый handoff");
          if (!this.lifecycleActive(lifecycleEpoch)) return;
          await this.options.store.markStarted(primary.session, this.generationId, new Date(), true, true, sent.pending === true);
          this.continuedThisRecovery.add(primary.sourceKey);
          this.urgentSessions.delete(primary.sourceKey);
          for (const source of sources) {
            this.urgentSessions.delete(source.sourceKey);
            if (source.sourceKey === primary.sourceKey) pushInventory(source);
            else {
              pushInventory(source, {
                verdict: "completed",
                reason: `Объединена с возобновлённой сессией «${group.topic}»: ${primary.session.id}`,
                confidence: group.confidence,
                judgedAt,
              });
              await this.options.settingsStore.setSession({ harness: source.session.harness, sessionId: source.session.id, cwd: source.session.cwd }, false);
              await this.options.store.remove(source.session.harness, source.session.id, sessionWorkspaceIdentity(source.session));
            }
          }
          console.error(`[agent-herder] единый план возобновил ${sources.length} сесс. в ${primary.session.harness}:${primary.session.id} «${continuationTitle(group.topic)}»`);
          continue;
        } catch (error) {
          launched = Math.max(0, launched - 1);
          const failure = errorText(error);
          if (isBusyCodexWriter(primary.session.harness, failure)) {
            if (!this.lifecycleActive(lifecycleEpoch)) return;
            const inbox = this.options.deferredStore ?? deferredMessages;
            const pending = await inbox.list(primary.session.id);
            if (!this.lifecycleActive(lifecycleEpoch)) return;
            if (!pending.some((message) => isAutocontinueRequest(message.message))) await inbox.add(primary.session.id, handoff);
            await this.options.store.markStarted(primary.session, this.generationId, new Date(), false, true, true);
            this.continuedThisRecovery.add(primary.sourceKey);
            for (const source of sources) pushInventory(source);
            console.error(`[agent-herder] единый план Codex отложен до безопасной границы хода ${primary.session.id}`);
            continue;
          }
          // A fresh cache window (or an explicit rollover opt-out) promises
          // same-ID continuation. A transient attach/send failure must remain
          // retryable on that session instead of silently creating a fork.
          await this.options.store.markStarted(primary.session, this.generationId);
          this.continuedThisRecovery.add(primary.sourceKey);
          for (const source of sources) pushInventory(source);
          console.error(`[agent-herder] исходная сессия ${primary.session.harness}:${primary.session.id} не возобновилась; новая сессия до TTL не создаётся: ${failure}`);
          continue;
        }
      }

      if (!primary.adapter.createSession) {
        for (const source of sources) {
          pushInventory(source);
          await this.options.store.remove(source.session.harness, source.session.id, sessionWorkspaceIdentity(source.session));
        }
        continue;
      }

      try {
        launched += 1;
        const continuationModel = continuationModelFor(primary.session);
        if (!this.lifecycleActive(lifecycleEpoch)) return;
        const created = await primary.adapter.createSession({
          name: continuationTitle(group.topic),
          cwd: primary.session.cwd,
          model: continuationModel,
          ...(primary.session.harness === "zcode" ? { mode: "yolo" } : {}),
        });
        if (!this.lifecycleActive(lifecycleEpoch)) return;
        if (!runtimeSettings.movePinnedOnRollover) await this.pinActiveSession(primary.adapter, created.id, runtimeSettings);
        if (!this.lifecycleActive(lifecycleEpoch)) return;
        if (continuationModel && created.model !== continuationModel && primary.adapter.changeModel) {
          const selected = await primary.adapter.changeModel(created.id, continuationModel);
          if (!selected.ok) throw new Error(selected.error || `не удалось выбрать модель ${continuationModel}`);
          if (!this.lifecycleActive(lifecycleEpoch)) return;
        }
        const sent = await primary.adapter.sendMessage(created.id, { message: handoff, queue: true });
        const terminalAdmission = admittedNonRetryableFailure(sent);
        if (terminalAdmission) {
          await this.options.store.markStarted(created, this.generationId, new Date(), true, true, false, terminalAdmission);
          this.continuedThisRecovery.add(sessionSourceKey(created));
          for (const source of sources) {
            this.urgentSessions.delete(source.sourceKey);
            pushInventory(source, {
              verdict: "needs_human",
              reason: `Передана в новую сессию ${created.id}; native turn failed после admission без безопасного retry`,
              confidence: 1,
              judgedAt,
            });
            await this.options.settingsStore.setSession({ harness: source.session.harness, sessionId: source.session.id, cwd: source.session.cwd }, false);
            await this.options.store.remove(source.session.harness, source.session.id, sessionWorkspaceIdentity(source.session));
          }
          console.error(`[agent-herder] новая сессия ${created.harness}:${created.id} приняла handoff, но native turn failed без безопасного retry: ${terminalAdmission}`);
          continue;
        }
        if (!sent.ok) throw new Error(sent.error || "новая объединённая сессия не приняла handoff");
        if (!this.lifecycleActive(lifecycleEpoch)) return;
        if (runtimeSettings.movePinnedOnRollover) {
          await movePinnedContinuation(primary.adapter, sources.map((source) => ({
            adapter: source.adapter,
            sessionId: source.session.id,
          })), created.id);
          if (!this.lifecycleActive(lifecycleEpoch)) return;
        }
        await this.options.store.markStarted(created, this.generationId, new Date(), true, true, sent.pending === true);
        this.continuedThisRecovery.add(sessionSourceKey(created));
        for (const source of sources) {
          this.urgentSessions.delete(source.sourceKey);
          pushInventory(source, {
            verdict: "completed",
            reason: `Объединена в новую сессию «${continuationTitle(group.topic)}»: ${created.id}`,
            confidence: group.confidence,
            judgedAt,
          });
          await this.options.settingsStore.setSession({ harness: source.session.harness, sessionId: source.session.id, cwd: source.session.cwd }, false);
          await this.options.store.remove(source.session.harness, source.session.id, sessionWorkspaceIdentity(source.session));
        }
        console.error(`[agent-herder] единый план продолжил ${sources.length} сесс. как ${created.harness}:${created.id} «${continuationTitle(group.topic)}»`);
      } catch (error) {
        launched = Math.max(0, launched - 1);
        console.error(`[agent-herder] единый план не запустил «${group.topic}»: ${errorText(error)}`);
        for (const source of sources) {
          pushInventory(source);
          await this.options.store.remove(source.session.harness, source.session.id, sessionWorkspaceIdentity(source.session));
        }
      }
    }
    if (this.lifecycleActive(lifecycleEpoch)) await this.options.store.upsertInventoryBatch(inventoryBatch);
  }

  private async planAssessedSessions(assessed: AssessedSession[]): Promise<SessionBatchPlan> {
    const planner = this.options.judge?.plan;
    if (!planner) throw new Error("MiniMax batch planner is unavailable");
    const contextBudget = Math.min(
      positiveInteger(
        Number(process.env.AGENT_HERDER_UNFINISHED_BATCH_CONTEXT_TOKENS || DEFAULT_BATCH_CONTEXT_TOKEN_BUDGET),
        DEFAULT_BATCH_CONTEXT_TOKEN_BUDGET,
      ),
      DEFAULT_BATCH_CONTEXT_TOKEN_BUDGET,
    );
    const rawCandidates = assessed.map(({ session, transcriptTail }) => ({ session, transcriptTail }));
    const globallyPacked = fitBatchContextForSerializedRequest(rawCandidates, contextBudget, (sessions) => ({
      model: "MiniMax-batch-budget",
      max_tokens: DEFAULT_BATCH_OUTPUT_TOKENS,
      temperature: 0,
      stream: true,
      output_config: { effort: "low" },
      system: [{ type: "text", text: batchPlannerPrompt(), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: JSON.stringify(batchPlannerPayload(sessions)) }],
    })).sessions;
    const packedAssessed = assessed.map((candidate, index) => ({
      ...candidate,
      transcriptTail: globallyPacked[index]!.transcriptTail,
    }));
    const groups: SessionBatchPlanGroup[] = [];
    for (let offset = 0; offset < packedAssessed.length; offset += MAX_BATCH_PLAN_SESSIONS_PER_REQUEST) {
      const chunk = packedAssessed.slice(offset, offset + MAX_BATCH_PLAN_SESSIONS_PER_REQUEST);
      const plan = canonicalizePlanSourceKeys(await planner({
        sessions: chunk.map(({ session, transcriptTail }) => ({ session, transcriptTail })),
      }), chunk);
      assertBatchPlanCoverage(plan, chunk);
      groups.push(...plan.groups);
    }
    let plan = { groups };
    assertBatchPlanCoverage(plan, packedAssessed);
    if (packedAssessed.length > MAX_BATCH_PLAN_SESSIONS_PER_REQUEST) {
      const reconcile = this.options.judge?.reconcile;
      if (!reconcile) throw new Error("MiniMax cross-chunk reconciliation is unavailable");
      const summaries = batchReconciliationCandidates(plan, packedAssessed);
      const reconciliation = await reconcile({ groups: summaries });
      plan = applyBatchReconciliation(plan, summaries, reconciliation);
      assertBatchPlanCoverage(plan, packedAssessed);
    }
    return plan;
  }

  private lifecycleActive(epoch: number): boolean {
    return !this.stopped && epoch === this.lifecycleEpoch;
  }

  private async pinActiveSession(
    adapter: HarnessAdapter,
    sessionId: string,
    settings?: SessionAutostartFile,
  ): Promise<void> {
    if ((adapter.type !== "codex" && adapter.type !== "zcode") || !adapter.setSessionPinned) return;
    const runtimeSettings = settings ?? await this.options.settingsStore.getSettings();
    if (!runtimeSettings.pinActiveSessions) return;
    try {
      const pinned = await adapter.setSessionPinned(sessionId, true);
      if (!pinned.ok) console.error(`[agent-herder] не удалось закрепить активную сессию ${adapter.type}:${sessionId}: ${pinned.error || "операция отклонена"}`);
    } catch (error) {
      console.error(`[agent-herder] не удалось закрепить активную сессию ${adapter.type}:${sessionId}: ${errorText(error)}`);
    }
  }

  private async fail(record: UnfinishedSessionRecord, error: string): Promise<void> {
    let attempted = record;
    if (record.state !== "recovering") {
      const begun = await this.options.store.beginAttempt(
        record.harness, record.sessionId, this.maxAttempts, this.retryDelayMs, new Date(), record.workspaceIdentity || record.cwd,
      );
      if (!begun) return;
      attempted = begun;
    }
    const failed = await this.options.store.markFailure(
      record.harness, record.sessionId, error, this.maxAttempts, new Date(), record.workspaceIdentity || record.cwd,
    );
    console.error(`[agent-herder] автозапуск ${attempted.attempts}/${this.maxAttempts} не удался для ${record.harness}:${record.sessionId}: ${error}`);
    if (failed?.state === "exhausted") await this.notifyExhausted(failed);
  }

  private async notifyExhausted(record: UnfinishedSessionRecord): Promise<void> {
    if (!this.options.notify || record.notifiedAt) return;
    const harness = displayHarness(record.harness);
    await this.options.notify({
      title: "Agent Herder не смог продолжить задачу",
      body: `${harness}: незавершённая сессия не запущена после ${record.attempts} попыток. Работа остановлена; откройте сессию и запустите продолжение вручную.`,
      dedupKey: `agent-herder:unfinished-session:${unfinishedRecordKey(record)}`,
      correlationId: `unfinished-${unfinishedRecordKey(record)}-${record.startedAt}`,
      sourceId: "agent-herder-autostart",
      signalType: "unfinished-session-autostart-failed",
    });
    await this.options.store.markNotified(record.harness, record.sessionId, new Date(), record.workspaceIdentity || record.cwd);
  }

  private async isEnabled(harness: HarnessType, sessionId: string, cwd: string): Promise<boolean> {
    return (await this.options.settingsStore.getEffective(harness, sessionId, cwd)).enabled;
  }
}

function parseAutostartFile(value: unknown, env: NodeJS.ProcessEnv = process.env): SessionAutostartFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("session autostart settings must be an object");
  const object = value as Record<string, unknown>;
  if ((object.version !== 1 && object.version !== 2 && object.version !== 3 && object.version !== 4 && object.version !== 5 && object.version !== 6 && object.version !== 7) || typeof object.enabled !== "boolean" || !Array.isArray(object.sessions)) throw new Error("invalid session autostart settings");
  const harnesses = object.version === 2 || object.version === 3 || object.version === 4 || object.version === 5 || object.version === 6 || object.version === 7 ? object.harnesses : [];
  if (!Array.isArray(harnesses)) throw new Error("invalid session autostart harness overrides");
  const defaults = defaultAutostartFile(env);
  return {
    version: 7,
    enabled: object.enabled,
    pinActiveSessions: object.version === 7 && object.pinActiveSessions !== undefined ? booleanSetting(object.pinActiveSessions, "pinActiveSessions") : defaults.pinActiveSessions,
    rolloverExpiredCache: object.version === 4 || object.version === 5 || object.version === 6 || object.version === 7 ? booleanSetting(object.rolloverExpiredCache, "rolloverExpiredCache") : defaults.rolloverExpiredCache,
    movePinnedOnRollover: object.version === 5 || object.version === 6 || object.version === 7 ? booleanSetting(object.movePinnedOnRollover, "movePinnedOnRollover") : defaults.movePinnedOnRollover,
    inventoryWindowHours: object.version === 3 || object.version === 4 || object.version === 5 || object.version === 6 || object.version === 7 ? runtimeHours(object.inventoryWindowHours) : defaults.inventoryWindowHours,
    evidenceMessageCount: (object.version === 6 || object.version === 7) && object.evidenceMessageCount !== undefined ? evidenceCount(object.evidenceMessageCount) : defaults.evidenceMessageCount,
    watchdogEnabled: (object.version === 6 || object.version === 7) && object.watchdogEnabled !== undefined ? booleanSetting(object.watchdogEnabled, "watchdogEnabled") : defaults.watchdogEnabled,
    watchdogIntervalSeconds: (object.version === 6 || object.version === 7) && object.watchdogIntervalSeconds !== undefined ? boundedInteger(object.watchdogIntervalSeconds, 5, 300, "watchdogIntervalSeconds") : defaults.watchdogIntervalSeconds,
    stalledTurnMinutes: (object.version === 6 || object.version === 7) && object.stalledTurnMinutes !== undefined ? boundedInteger(object.stalledTurnMinutes, 1, 120, "stalledTurnMinutes") : defaults.stalledTurnMinutes,
    judgeModel: object.version === 3 || object.version === 4 || object.version === 5 || object.version === 6 || object.version === 7 ? runtimeModel(object.judgeModel, "judgeModel") : defaults.judgeModel,
    autopilotJudgeModel: object.version === 3 || object.version === 4 || object.version === 5 || object.version === 6 || object.version === 7 ? runtimeModel(object.autopilotJudgeModel, "autopilotJudgeModel") : defaults.autopilotJudgeModel,
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
    version: 7,
    enabled: env.AGENT_HERDER_UNFINISHED_AUTOSTART !== "false",
    pinActiveSessions: env.AGENT_HERDER_UNFINISHED_PIN_ACTIVE_SESSIONS !== "false",
    rolloverExpiredCache: true,
    movePinnedOnRollover: true,
    inventoryWindowHours: positiveInteger(Number(env.AGENT_HERDER_UNFINISHED_INVENTORY_HOURS || 48), 48),
    evidenceMessageCount: evidenceCount(Number(env.AGENT_HERDER_UNFINISHED_EVIDENCE_MESSAGES || DEFAULT_EVIDENCE_MESSAGE_COUNT)),
    watchdogEnabled: env.AGENT_HERDER_UNFINISHED_WATCHDOG !== "false",
    watchdogIntervalSeconds: boundedInteger(Number(env.AGENT_HERDER_UNFINISHED_WATCHDOG_INTERVAL_SECONDS || 10), 5, 300, "watchdogIntervalSeconds"),
    stalledTurnMinutes: boundedInteger(Number(env.AGENT_HERDER_UNFINISHED_STALLED_TURN_MINUTES || 2), 1, 120, "stalledTurnMinutes"),
    judgeModel: env.AGENT_HERDER_UNFINISHED_JUDGE_MODEL?.trim() || "MiniMax-M3.1-Flash-Preview",
    autopilotJudgeModel: env.AGENT_HERDER_AUTOPILOT_JUDGE_MODEL?.trim() || "MiniMax-M3",
    harnesses: [],
    sessions: [],
  };
}

function booleanSetting(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`invalid ${field}`);
  return value;
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
  if (count < 2 || count > MAX_EVIDENCE_MESSAGE_COUNT) throw new Error("invalid evidenceMessageCount");
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
    ...(record.workspaceIdentity ? { workspaceIdentity: normalize(bounded(record.workspaceIdentity, "workspaceIdentity")) } : {}),
    title: boundedText(record.title, "title", MAX_TEXT),
    status,
    lastActivity: isoDate(record.lastActivity, "lastActivity"),
    transcriptTail: boundedText(record.transcriptTail, "transcriptTail", 2_000_000, true),
    ...(record.evidenceVersion === undefined ? {} : { evidenceVersion: positiveInteger(record.evidenceVersion, -1) }),
    ...(record.evidenceFingerprint === undefined ? {} : { evidenceFingerprint: bounded(record.evidenceFingerprint, "evidenceFingerprint") }),
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

async function sessionEvidenceMessages(adapter: HarnessAdapter, sessionId: string, limit: number): Promise<SessionMessageView[]> {
  const [tail, firstUser] = await Promise.all([
    adapter.getSessionMessages?.(sessionId, limit).catch(() => null) ?? Promise.resolve(null),
    adapter.getFirstUserMessage
      ? adapter.getFirstUserMessage(sessionId).catch(() => null)
      : Promise.resolve(null),
  ]);
  const messages = tail ?? [];
  if (!firstUser) return messages;
  const duplicate = (message: SessionMessageView) => message.role === "user"
    && message.text === firstUser.text
    && (!message.timestamp || !firstUser.timestamp || message.timestamp === firstUser.timestamp);
  return [firstUser, ...messages.filter((message) => !duplicate(message))];
}

/** Keep the first user goal plus the configured latest semantic messages. */
export function completionEvidence(messages: SessionMessageView[], messageCount = DEFAULT_EVIDENCE_MESSAGE_COUNT): string {
  const targetCount = Math.max(3, messageCount);
  const semantic = messages.map((message, index) => ({
    index,
    role: message.role,
    text: message.role === "user" || message.role === "assistant" ? semanticTranscript([message]) : "",
  })).filter((item) => item.text);
  const firstUser = semantic.find((item) => item.role === "user");
  const selected = [
    firstUser,
    ...semantic.slice(-Math.max(1, targetCount - (firstUser ? 1 : 0))),
    [...semantic].reverse().find((item) => item.role === "user"),
    [...semantic].reverse().find((item) => item.role === "assistant"),
  ].filter((item): item is (typeof semantic)[number] => Boolean(item));
  const unique = [...new Map(selected.map((item) => [item.index, item])).values()].sort((left, right) => left.index - right.index);
  const recent = unique.filter((item) => item.index !== firstUser?.index).slice(-Math.max(1, targetCount - (firstUser ? 1 : 0)));
  const bounded = firstUser ? [firstUser, ...recent] : recent;
  for (const role of ["user", "assistant"] as const) {
    if (bounded.some((item) => item.role === role)) continue;
    const required = [...unique].reverse().find((item) => item.role === role);
    if (required) bounded.splice(firstUser ? 1 : 0, 1, required);
  }
  bounded.sort((left, right) => left.index - right.index);
  const deduplicated = [...new Map(bounded.map((item) => [item.index, item])).values()];
  if (deduplicated.length === 0) return "";
  const first = firstUser?.text ?? deduplicated[0]!.text;
  const tail = deduplicated.filter((item) => item.index !== firstUser?.index).map((item) => item.text).join("\n\n") || first;
  return trimEvidenceChars([
    "ПЕРВЫЙ ПОЛЬЗОВАТЕЛЬСКИЙ ЗАПРОС:",
    first,
    "\nПОСЛЕДНИЙ СМЫСЛОВОЙ КОНТЕКСТ:",
    tail,
  ].join("\n"), MAX_SESSION_EVIDENCE_CHARS);
}

function evidenceFingerprint(value: string): string {
  return createHash("sha256").update(`${CURRENT_EVIDENCE_VERSION}\0${value}`).digest("hex");
}

function evidenceIsCurrent(record: UnfinishedSessionInventoryRecord | undefined): boolean {
  return record?.evidenceVersion === CURRENT_EVIDENCE_VERSION
    && record.evidenceFingerprint === evidenceFingerprint(record.transcriptTail);
}

function inventoryFromAssessment(
  candidate: AssessedSession,
  verdict?: SessionInventoryVerdict,
  now = new Date(),
): UnfinishedSessionInventoryRecord {
  return {
    harness: candidate.session.harness as "codex" | "zcode",
    sessionId: candidate.session.id,
    cwd: candidate.session.cwd,
    workspaceIdentity: sessionWorkspaceIdentity(candidate.session),
    title: candidate.session.title,
    status: candidate.session.status,
    lastActivity: candidate.session.lastActivity,
    transcriptTail: candidate.transcriptTail,
    evidenceVersion: CURRENT_EVIDENCE_VERSION,
    evidenceFingerprint: evidenceFingerprint(candidate.transcriptTail),
    observedAt: now.toISOString(),
    ...(verdict ? { verdict } : {}),
  };
}

function trimEvidenceChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 0) return "";
  const divider = "\nПОСЛЕДНИЙ СМЫСЛОВОЙ КОНТЕКСТ:\n";
  const split = value.indexOf(divider);
  if (split < 0) return value.slice(-maxChars);
  const prefix = value.slice(0, split + divider.length);
  const prefixBudget = Math.min(prefix.length, Math.min(maxChars, Math.max(1, Math.floor(maxChars * 0.2))));
  const suffixBudget = Math.max(0, maxChars - prefixBudget);
  return `${prefix.slice(0, prefixBudget)}${value.slice(-suffixBudget)}`;
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

function isAutocontinueRequest(text: string | undefined): boolean {
  const normalized = text?.trim() || "";
  return normalized.startsWith("Автопродолжение —")
    || normalized.startsWith("Продолжи незавершённую задачу с того места, где выполнение было прервано.");
}

export function enforcePlanWorkspaceBoundaries(
  plan: SessionBatchPlan,
  candidates: ReadonlyMap<string, SessionBatchCandidate>,
): SessionBatchPlan {
  return {
    groups: plan.groups.flatMap((group) => {
      const partitions = new Map<string, string[]>();
      for (const id of group.sourceSessionIds) {
        const workspaceIdentity = sessionWorkspaceIdentity(candidates.get(id)!.session);
        const ids = partitions.get(workspaceIdentity) ?? [];
        ids.push(id);
        partitions.set(workspaceIdentity, ids);
      }
      if (partitions.size <= 1) return [group];
      // Similar titles/topics are not task identity. A canary or unrelated
      // checkout must never supersede an active/pinned session in another
      // workspace, even when MiniMax grouped them together. Preserve genuine
      // same-workspace duplicates as one subgroup, but force each workspace to
      // be replanned independently before any completion or resume action.
      return [...partitions.values()].map((sourceSessionIds): SessionBatchPlanGroup => {
        const primarySessionId = sourceSessionIds.includes(group.primarySessionId)
          ? group.primarySessionId
          : sourceSessionIds[0]!;
        return {
          sourceSessionIds,
          primarySessionId,
          verdict: "needs_human",
          reason: "MiniMax попытался объединить разные рабочие каталоги; эта подгруппа сохранена для отдельной проверки",
          confidence: 0,
          topic: group.topic,
          handoff: "",
        };
      });
    }),
  };
}

function batchContinuationPrompt(group: SessionBatchPlanGroup, sources: AssessedSession[]): string {
  return [
    continuationTitle(group.topic),
    "",
    `Это единое продолжение задачи «${group.topic}», собранное оркестратором из ${sources.length} сесс. Codex/ZCode.`,
    `Исходные сессии: ${sources.map(({ session }) => `${session.harness}:${session.id} (${session.title})`).join("; ")}.`,
    "MiniMax прочитал первый пользовательский запрос и свежий смысловой хвост каждой сессии, убрал дубли и подготовил общий handoff.",
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
    ...(record.workspaceIdentity ? { workspaceIdentity: normalize(bounded(record.workspaceIdentity, "workspaceIdentity")) } : {}),
    startedAt: isoDate(record.startedAt, "startedAt"),
    updatedAt: isoDate(record.updatedAt, "updatedAt"),
    ...(record.acceptedAt ? { acceptedAt: isoDate(record.acceptedAt, "acceptedAt") } : {}),
    ...(record.acceptedFingerprint ? { acceptedFingerprint: bounded(record.acceptedFingerprint, "acceptedFingerprint") } : {}),
    ...(record.progressObservedAt ? { progressObservedAt: isoDate(record.progressObservedAt, "progressObservedAt") } : {}),
    ...(record.deliveryPending === true ? { deliveryPending: true } : {}),
    ...(record.nonRetryableAdmission === true ? { nonRetryableAdmission: true } : {}),
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

function sessionKey(harness: HarnessType, sessionId: string, workspaceIdentity?: string): string {
  const base = `${harness}:${bounded(sessionId, "sessionId")}`;
  return workspaceIdentity ? `${base}:${normalize(bounded(workspaceIdentity, "workspaceIdentity"))}` : base;
}

function resolveSessionOverride(
  records: SessionAutostartOverride[],
  canonicalCwd: string,
): SessionAutostartOverride | undefined {
  if (records.length === 0) return undefined;
  const newestTimestamp = Math.max(...records.map((record) => Date.parse(record.updatedAt)));
  const newest = records.filter((record) => Date.parse(record.updatedAt) === newestTimestamp);
  // Recency is authoritative. At an exact timestamp tie, opt-out is the safe
  // fallback; otherwise prefer the canonical row over a stale cwd alias.
  return newest.find((record) => !record.enabled)
    ?? newest.find((record) => normalize(record.cwd) === normalize(canonicalCwd))
    ?? newest[0];
}

function sessionWorkspaceIdentity(session: Pick<AgentSession, "cwd" | "meta">): string {
  const configured = session.meta?.workspaceIdentity;
  return normalize(typeof configured === "string" && configured.trim() ? configured : session.cwd);
}

function sessionSourceKey(session: Pick<AgentSession, "harness" | "id" | "cwd" | "meta">): string {
  return sessionKey(harnessType(session.harness), session.id, sessionWorkspaceIdentity(session));
}

function unfinishedRecordKey(record: Pick<UnfinishedSessionRecord, "harness" | "sessionId" | "cwd" | "workspaceIdentity">): string {
  return sessionKey(record.harness, record.sessionId, record.workspaceIdentity || record.cwd);
}

function inventoryRecordKey(record: Pick<UnfinishedSessionInventoryRecord, "harness" | "sessionId" | "cwd" | "workspaceIdentity">): string {
  return sessionKey(harnessType(record.harness), record.sessionId, record.workspaceIdentity || record.cwd);
}

function findUnfinishedRecord(
  records: UnfinishedSessionRecord[],
  harness: HarnessType,
  sessionId: string,
  workspaceIdentity?: string,
): UnfinishedSessionRecord | undefined {
  if (workspaceIdentity) {
    const key = sessionKey(harness, sessionId, workspaceIdentity);
    return records.find((candidate) => unfinishedRecordKey(candidate) === key);
  }
  return records.find((candidate) => candidate.harness === harness && candidate.sessionId === sessionId);
}

function mergeUnfinishedIdentityRecords(
  records: UnfinishedSessionRecord[],
  session: AgentSession,
  workspaceIdentity: string,
): UnfinishedSessionRecord {
  const safetyRank = (record: UnfinishedSessionRecord): number => record.nonRetryableAdmission ? 5
    : record.deliveryPending ? 4
      : record.acceptedAt ? 3
        : record.state === "exhausted" ? 2
          : record.state === "recovering" ? 1 : 0;
  const winner = [...records].sort((left, right) => safetyRank(right) - safetyRank(left)
    || Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0]!;
  const admission = [...records].filter((record) => record.acceptedAt)
    .sort((left, right) => Date.parse(right.acceptedAt!) - Date.parse(left.acceptedAt!))[0];
  const latest = [...records].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0]!;
  const state: UnfinishedSessionState = records.some((record) => record.nonRetryableAdmission)
    ? "active"
    : records.some((record) => record.state === "exhausted") ? "exhausted"
      : records.some((record) => record.state === "recovering") ? "recovering" : "active";
  return {
    ...winner,
    harness: harnessType(session.harness),
    sessionId: session.id,
    cwd: normalize(session.cwd),
    workspaceIdentity,
    model: session.model || winner.model,
    title: session.title || winner.title,
    startedAt: new Date(Math.min(...records.map((record) => Date.parse(record.startedAt)))).toISOString(),
    updatedAt: latest.updatedAt,
    generationId: latest.generationId,
    attempts: Math.max(...records.map((record) => record.attempts)),
    state,
    ...(admission?.acceptedAt ? {
      acceptedAt: admission.acceptedAt,
      ...(admission.acceptedFingerprint ? { acceptedFingerprint: admission.acceptedFingerprint } : {}),
      ...(admission.progressObservedAt ? { progressObservedAt: admission.progressObservedAt } : {}),
      ...(admission.deliveryPending ? { deliveryPending: true } : {}),
    } : {}),
  };
}

function mergeInventoryIdentityRecords(
  records: UnfinishedSessionInventoryRecord[],
  session: AgentSession,
  workspaceIdentity: string,
): UnfinishedSessionInventoryRecord {
  const winner = [...records].sort((left, right) => Number(evidenceIsCurrent(right)) - Number(evidenceIsCurrent(left))
    || Date.parse(right.observedAt) - Date.parse(left.observedAt))[0]!;
  const rewritten: UnfinishedSessionInventoryRecord = {
    ...winner,
    harness: session.harness as "codex" | "zcode",
    sessionId: session.id,
    cwd: normalize(session.cwd),
    workspaceIdentity,
    title: session.title,
    status: session.status,
    lastActivity: session.lastActivity,
    // Evidence and verdict describe the old identity. Carrying them across a
    // cwd/workspace rewrite could settle a canonical unfinished task as the
    // completed ghost, so force one canonical transcript read and replan.
    transcriptTail: "",
    observedAt: new Date().toISOString(),
  };
  delete rewritten.evidenceVersion;
  delete rewritten.evidenceFingerprint;
  delete rewritten.verdict;
  return rewritten;
}

function sortRecords(records: UnfinishedSessionRecord[]): void {
  records.sort((left, right) => unfinishedRecordKey(left).localeCompare(unfinishedRecordKey(right)));
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

/** Normalize injected/test judges and legacy judge implementations to the same workspace-qualified keys. */
function canonicalizePlanSourceKeys(plan: SessionBatchPlan, candidates: AssessedSession[]): SessionBatchPlan {
  const known = new Set(candidates.map((candidate) => candidate.sourceKey));
  const byNativeId = new Map<string, string[]>();
  for (const candidate of candidates) {
    const keys = byNativeId.get(candidate.session.id) ?? [];
    keys.push(candidate.sourceKey);
    byNativeId.set(candidate.session.id, keys);
  }
  const resolve = (value: string): string => {
    if (known.has(value)) return value;
    const matches = byNativeId.get(value) ?? [];
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new Error(`planner returned ambiguous workspace-free session ${value}`);
    throw new Error(`planner returned unknown session ${value}`);
  };
  return {
    groups: plan.groups.map((group) => {
      const sourceSessionIds = [...new Set(group.sourceSessionIds.map(resolve))];
      const requestedPrimary = resolve(group.primarySessionId);
      return {
        ...group,
        sourceSessionIds,
        primarySessionId: sourceSessionIds.includes(requestedPrimary) ? requestedPrimary : sourceSessionIds[0]!,
      };
    }),
  };
}

function assertBatchPlanCoverage(plan: SessionBatchPlan, candidates: AssessedSession[]): void {
  const expected = new Set(candidates.map((candidate) => candidate.sourceKey));
  const seen = new Set<string>();
  for (const [index, group] of plan.groups.entries()) {
    if (group.sourceSessionIds.length === 0) throw new Error(`MiniMax batch group ${index} has no sessions`);
    if (!group.sourceSessionIds.includes(group.primarySessionId)) {
      throw new Error(`MiniMax batch group ${index} primary is outside its sources`);
    }
    for (const sourceKey of group.sourceSessionIds) {
      if (!expected.has(sourceKey)) throw new Error(`MiniMax batch plan contains unknown session ${sourceKey}`);
      if (seen.has(sourceKey)) throw new Error(`MiniMax batch plan assigned session more than once: ${sourceKey}`);
      seen.add(sourceKey);
    }
  }
  const missing = [...expected].filter((sourceKey) => !seen.has(sourceKey));
  if (missing.length > 0) {
    throw new Error(`MiniMax batch plan omitted ${missing.length} assessed session(s): ${missing.slice(0, 3).join(", ")}`);
  }
}

function batchReconciliationCandidates(
  plan: SessionBatchPlan,
  candidates: AssessedSession[],
): SessionBatchReconciliationCandidate[] {
  const byId = new Map(candidates.map((candidate) => [candidate.sourceKey, candidate]));
  return plan.groups.map((group, index) => {
    const members = group.sourceSessionIds.map((sourceKey) => byId.get(sourceKey)!);
    const workspaces = [...new Set(members.map(({ session }) => sessionWorkspaceIdentity(session)))];
    if (workspaces.length !== 1) throw new Error(`MiniMax chunk group ${index} crosses workspace boundaries`);
    return {
      groupRef: `G${index + 1}`,
      workspaceIdentity: workspaces[0]!,
      topic: group.topic,
      verdict: group.verdict,
      reason: group.reason.slice(0, 512),
      handoff: group.handoff.slice(0, 1_000),
      sourceSessionIds: [...group.sourceSessionIds],
      memberTitles: members.map(({ session }) => session.title.slice(0, 160)),
      humanGate: members.some(({ session }) => session.status === "needs_input" || session.needsPermission),
    };
  });
}

function applyBatchReconciliation(
  plan: SessionBatchPlan,
  candidates: SessionBatchReconciliationCandidate[],
  reconciliation: SessionBatchReconciliation,
): SessionBatchPlan {
  const byRef = new Map(candidates.map((candidate, index) => [candidate.groupRef, { candidate, group: plan.groups[index]! }]));
  const seen = new Set<string>();
  const groups = reconciliation.clusters.map((cluster, index): SessionBatchPlanGroup => {
    if (!Array.isArray(cluster) || cluster.length === 0) throw new Error(`MiniMax reconciliation cluster ${index} is empty`);
    const entries = cluster.map((groupRef) => {
      const entry = byRef.get(groupRef);
      if (!entry) throw new Error(`MiniMax reconciliation returned unknown group ${groupRef}`);
      if (seen.has(groupRef)) throw new Error(`MiniMax reconciliation repeated group ${groupRef}`);
      seen.add(groupRef);
      return entry;
    });
    const workspaces = new Set(entries.map(({ candidate }) => candidate.workspaceIdentity));
    if (workspaces.size !== 1) throw new Error(`MiniMax reconciliation cluster ${index} crosses workspace boundaries`);
    const topic = entries[0]!.group.topic;
    return mergePlanGroups(entries.map(({ group }) => ({ ...group, topic })))[0]!;
  });
  const missing = candidates.filter(({ groupRef }) => !seen.has(groupRef));
  if (missing.length > 0) throw new Error(`MiniMax reconciliation omitted ${missing.length} chunk group(s)`);
  return { groups };
}

function normalizeBatchPlan(value: unknown, candidates: SessionBatchCandidate[]): SessionBatchPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MiniMax returned an invalid batch plan");
  const rawGroups = (value as Record<string, unknown>).groups;
  if (!Array.isArray(rawGroups)) throw new Error("MiniMax batch plan has no groups");
  const known = new Set(candidates.map(({ session }) => sessionSourceKey(session)));
  const aliases = new Map(candidates.map(({ session }, index) => [`S${index + 1}`, sessionSourceKey(session)]));
  const idAliases = new Map<string, string[]>();
  for (const { session } of candidates) {
    const ids = idAliases.get(session.id) ?? [];
    ids.push(sessionSourceKey(session));
    idAliases.set(session.id, ids);
  }
  const resolveId = (value: unknown, field: string): string => {
    const raw = boundedText(value, field, 128);
    const alias = aliases.get(raw);
    if (alias) return alias;
    if (known.has(raw)) return raw;
    const matches = idAliases.get(raw) ?? [];
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new Error(`MiniMax returned ambiguous workspace-free session ${raw}`);
    return raw;
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
  const omitted = candidates
    .map(({ session }) => sessionSourceKey(session))
    .filter((sourceKey) => !assignment.has(sourceKey));
  if (omitted.length > 0) throw new Error(`MiniMax batch plan omitted ${omitted.length} session(s)`);
  return { groups: mergePlanGroups(groups) };
}

function batchReconciliationPrompt(): string {
  return [
    "Ты финальный дедупликатор уже проверенных групп Agent Herder.",
    "Сгруппируй group_ref одной и той же пользовательской задачи, даже если они пришли из разных batch chunks.",
    "Никогда не объединяй разные workspace_identity.",
    "human_gate — свойство участника задачи, а не отдельная задача: сохрани его в одном кластере с sibling той же работы.",
    "Каждый входной group_ref должен встретиться ровно один раз.",
    "Верни только компактный JSON {clusters:[[\"G1\",\"G2\"],[\"G3\"]]}; не повторяй summaries, handoff или причины.",
  ].join(" ");
}

function batchReconciliationPayload(groups: SessionBatchReconciliationCandidate[]): unknown {
  return {
    groups: groups.map((group) => ({
      group_ref: group.groupRef,
      workspace_identity: group.workspaceIdentity,
      topic: group.topic,
      verdict: group.verdict,
      reason: group.reason,
      handoff: group.handoff,
      source_session_refs: group.sourceSessionIds,
      member_titles: group.memberTitles,
      human_gate: group.humanGate,
    })),
  };
}

function normalizeBatchReconciliation(
  value: unknown,
  candidates: SessionBatchReconciliationCandidate[],
): SessionBatchReconciliation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MiniMax returned an invalid reconciliation");
  const rawClusters = (value as Record<string, unknown>).clusters;
  if (!Array.isArray(rawClusters)) throw new Error("MiniMax reconciliation has no clusters");
  const known = new Map(candidates.map((candidate) => [candidate.groupRef, candidate]));
  const seen = new Set<string>();
  const clusters = rawClusters.map((rawCluster, index): string[] => {
    if (!Array.isArray(rawCluster) || rawCluster.length === 0) throw new Error(`MiniMax reconciliation cluster ${index} is empty`);
    const cluster = rawCluster.map((value) => boundedText(value, "group_ref", 32));
    const workspaces = new Set(cluster.map((groupRef) => {
      const candidate = known.get(groupRef);
      if (!candidate) throw new Error(`MiniMax reconciliation returned unknown group ${groupRef}`);
      if (seen.has(groupRef)) throw new Error(`MiniMax reconciliation repeated group ${groupRef}`);
      seen.add(groupRef);
      return candidate.workspaceIdentity;
    }));
    if (workspaces.size !== 1) throw new Error(`MiniMax reconciliation cluster ${index} crosses workspace boundaries`);
    return cluster;
  });
  const missing = candidates.filter(({ groupRef }) => !seen.has(groupRef));
  if (missing.length > 0) throw new Error(`MiniMax reconciliation omitted ${missing.length} group(s)`);
  return { clusters };
}

function batchPlannerPrompt(): string {
  return [
    "Ты единый оркестратор автопродолжения Agent Herder для Codex и ZCode.",
    "Получаешь все доступные сессии 48-часового окна в одном общем пакете до безопасного потолка контекста.",
    "У каждой сессии обязательно сохранён первый пользовательский запрос как исходная цель и максимально полный свежий смысловой хвост без tool noise и скрытых рассуждений.",
    "Сгруппируй сессии одной и той же пользовательской задачи, даже если названия различаются; не объединяй просто похожие задачи.",
    "Никогда не объединяй session_ref из разных cwd: рабочий каталог — жёсткая граница задачи, даже если тема и заголовок одинаковы.",
    "Каждый входной session_ref должен встретиться ровно один раз в source_session_ids одной группы; возвращай короткие S1, S2 и т.д., не переписывай UUID.",
    "Для группы выбери primary_session_id из session_ref: работающую сессию, иначе самую новую и содержательную.",
    "verdict: completed, unfinished или needs_human. Если хотя бы одна сессия группы ещё реально выполняется, verdict=unfinished.",
    "completed допустим только когда исходная пользовательская цель явно достигнута и финальный ответ содержит проверяемый результат; план, обещание продолжить, незавершённые пункты или ошибки инструментов означают unfinished.",
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
      workspace_identity: sessionWorkspaceIdentity(session),
      model: session.model,
      status_signal: session.status,
      last_activity: session.lastActivity,
      needs_permission: session.needsPermission,
      semantic_context: transcriptTail,
    })),
  };
}

/** Conservative MiniMax-oriented estimate: non-ASCII text is budgeted as one token per character. */
export function estimateContextTokens(value: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of value) {
    if (char.charCodeAt(0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 3) + nonAscii;
}

/** Includes the system prompt, serialized payload, and a conservative request-format reserve. */
export function estimateBatchPlannerInputTokens(sessions: SessionBatchCandidate[]): number {
  return estimateContextTokens(batchPlannerPrompt())
    + estimateContextTokens(JSON.stringify(batchPlannerPayload(sessions)))
    + 512;
}

/** Fairly pack every candidate under one shared context ceiling while preserving goal + recent tail. */
export function fitBatchContext(
  sessions: SessionBatchCandidate[],
  tokenBudget = DEFAULT_BATCH_CONTEXT_TOKEN_BUDGET,
): SessionBatchCandidate[] {
  if (sessions.length === 0) return [];
  const metadataOnly = sessions.map((candidate) => ({ ...candidate, transcriptTail: "" }));
  const fixedTokens = estimateBatchPlannerInputTokens(metadataOnly);
  if (fixedTokens > tokenBudget) {
    throw new Error(`MiniMax batch metadata needs ${fixedTokens} input tokens, above the ${tokenBudget} token ceiling`);
  }
  const available = tokenBudget - fixedTokens;
  const sizes = sessions.map((candidate) => estimateContextTokens(candidate.transcriptTail));
  let low = 0;
  let high = Math.max(...sizes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const total = sizes.reduce((sum, size) => sum + Math.min(size, middle), 0);
    if (total <= available) low = middle;
    else high = middle - 1;
  }
  const perSessionCap = low;
  return sessions.map((candidate, index) => ({
    ...candidate,
    transcriptTail: sizes[index]! <= perSessionCap
      ? candidate.transcriptTail
      : trimEvidenceTokens(candidate.transcriptTail, perSessionCap),
  }));
}

/** Fit against the exact JSON body sent on the wire, including nested escaping. */
export function fitBatchContextForSerializedRequest<T>(
  sessions: SessionBatchCandidate[],
  tokenBudget: number,
  buildRequest: (packed: SessionBatchCandidate[]) => T,
): { sessions: SessionBatchCandidate[]; request: T; estimatedTokens: number } {
  if (sessions.length === 0) {
    const request = buildRequest([]);
    return { sessions: [], request, estimatedTokens: estimateContextTokens(JSON.stringify(request)) };
  }
  const metadataOnly = sessions.map((candidate) => ({ ...candidate, transcriptTail: "" }));
  const fixedRequest = buildRequest(metadataOnly);
  const fixedTokens = estimateContextTokens(JSON.stringify(fixedRequest));
  if (fixedTokens > tokenBudget) {
    throw new Error(`MiniMax serialized batch metadata needs ${fixedTokens} input tokens, above the ${tokenBudget} token ceiling`);
  }
  const sizes = sessions.map((candidate) => estimateContextTokens(candidate.transcriptTail));
  const pack = (cap: number): SessionBatchCandidate[] => sessions.map((candidate, index) => ({
    ...candidate,
    transcriptTail: sizes[index]! <= cap ? candidate.transcriptTail : trimEvidenceTokens(candidate.transcriptTail, cap),
  }));
  const available = tokenBudget - fixedTokens;
  let low = 0;
  let high = Math.max(...sizes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const evidenceTokens = sizes.reduce((sum, size) => sum + Math.min(size, middle), 0);
    if (evidenceTokens <= available) low = middle;
    else high = middle - 1;
  }
  let cap = low;
  // Escaping overhead is measured from the real request, then corrected
  // proportionally. This converges in a few full serializations instead of
  // rebuilding every multi-megabyte candidate at each binary-search step.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const packed = pack(cap);
    const request = buildRequest(packed);
    const estimatedTokens = estimateContextTokens(JSON.stringify(request));
    if (estimatedTokens <= tokenBudget) return { sessions: packed, request, estimatedTokens };
    const actualEvidenceTokens = Math.max(1, estimatedTokens - fixedTokens);
    const nextCap = Math.max(0, Math.floor(cap * available / actualEvidenceTokens * 0.98));
    cap = nextCap < cap ? nextCap : Math.max(0, cap - 1);
  }
  const packed = pack(0);
  const request = buildRequest(packed);
  const estimatedTokens = estimateContextTokens(JSON.stringify(request));
  if (estimatedTokens > tokenBudget) throw new Error(`MiniMax serialized request exceeds the ${tokenBudget} token ceiling`);
  return { sessions: packed, request, estimatedTokens };
}

function trimEvidenceTokens(value: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (estimateContextTokens(value) <= maxTokens) return value;
  let maxChars = Math.max(1, Math.floor(value.length * maxTokens / estimateContextTokens(value)));
  let trimmed = trimEvidenceChars(value, maxChars);
  while (estimateContextTokens(trimmed) > maxTokens && maxChars > 1) {
    maxChars = Math.max(1, Math.floor(maxChars * 0.9));
    trimmed = trimEvidenceChars(value, maxChars);
  }
  while (estimateContextTokens(trimmed) > maxTokens && trimmed.length > 0) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
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

function boundedInteger(value: unknown, min: number, max: number, field: string): number {
  const parsed = positiveInteger(value, -1);
  if (parsed < min || parsed > max) throw new Error(`${field} must be an integer from ${min} to ${max}`);
  return parsed;
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
          max_tokens: 512,
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
                "Статус БД — только слабый сигнал. Главный источник — первый пользовательский запрос и свежий смысловой хвост. При сомнении не выбирай completed.",
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
      const contextBudget = positiveInteger(
        Number(process.env.AGENT_HERDER_UNFINISHED_BATCH_CONTEXT_TOKENS || DEFAULT_BATCH_CONTEXT_TOKEN_BUDGET),
        DEFAULT_BATCH_CONTEXT_TOKEN_BUDGET,
      );
      const inputCeiling = Math.min(contextBudget, DEFAULT_BATCH_CONTEXT_TOKEN_BUDGET);
      const maxTokens = Math.min(
        positiveInteger(Number(process.env.AGENT_HERDER_UNFINISHED_BATCH_MAX_TOKENS || DEFAULT_BATCH_OUTPUT_TOKENS), DEFAULT_BATCH_OUTPUT_TOKENS),
        DEFAULT_BATCH_OUTPUT_TOKENS,
      );
      const buildRequest = (packedSessions: SessionBatchCandidate[]) => ({
        model: config.model,
        max_tokens: maxTokens,
        temperature: 0,
        stream: false,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: batchPlannerPrompt() },
          { role: "user", content: JSON.stringify(batchPlannerPayload(packedSessions)) },
        ],
      });
      const fitted = fitBatchContextForSerializedRequest(sessions, inputCeiling, buildRequest);
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(positiveInteger(Number(process.env.AGENT_HERDER_UNFINISHED_BATCH_TIMEOUT_MS || 600_000), 600_000)),
        body: JSON.stringify(fitted.request),
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
    async reconcile({ groups }) {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(positiveInteger(Number(process.env.AGENT_HERDER_UNFINISHED_BATCH_TIMEOUT_MS || 600_000), 600_000)),
        body: JSON.stringify({
          model: config.model,
          max_tokens: DEFAULT_BATCH_OUTPUT_TOKENS,
          temperature: 0,
          stream: false,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: batchReconciliationPrompt() },
            { role: "user", content: JSON.stringify(batchReconciliationPayload(groups)) },
          ],
        }),
      });
      if (!response.ok) throw new Error(`MiniMax reconciliation rejected with HTTP ${response.status}`);
      const body = await response.json() as Record<string, unknown>;
      const choices = Array.isArray(body.choices) ? body.choices : [];
      const message = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>).message : undefined;
      const content = message && typeof message === "object" ? (message as Record<string, unknown>).content : undefined;
      if (typeof content !== "string") throw new Error("MiniMax reconciliation returned no content");
      const json = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      return normalizeBatchReconciliation(JSON.parse(json) as unknown, groups);
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
              "Статус БД — только слабый сигнал. Главный источник — первый пользовательский запрос и максимально полный свежий смысловой хвост. При сомнении не выбирай completed.",
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
      const contextBudget = positiveInteger(
        Number(process.env.AGENT_HERDER_UNFINISHED_BATCH_CONTEXT_TOKENS || DEFAULT_BATCH_CONTEXT_TOKEN_BUDGET),
        DEFAULT_BATCH_CONTEXT_TOKEN_BUDGET,
      );
      const inputCeiling = Math.min(contextBudget, DEFAULT_BATCH_CONTEXT_TOKEN_BUDGET);
      const maxTokens = Math.min(
        positiveInteger(Number(process.env.AGENT_HERDER_UNFINISHED_BATCH_MAX_TOKENS || DEFAULT_BATCH_OUTPUT_TOKENS), DEFAULT_BATCH_OUTPUT_TOKENS),
        DEFAULT_BATCH_OUTPUT_TOKENS,
      );
      const buildRequest = (packedSessions: SessionBatchCandidate[]) => ({
        model: config.model,
        max_tokens: maxTokens,
        temperature: 0,
        stream: true,
        output_config: { effort: "low" },
        system: [{ type: "text", text: batchPlannerPrompt(), cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: JSON.stringify(batchPlannerPayload(packedSessions)) }],
      });
      const fitted = fitBatchContextForSerializedRequest(sessions, inputCeiling, buildRequest);
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(positiveInteger(Number(process.env.AGENT_HERDER_UNFINISHED_BATCH_TIMEOUT_MS || 600_000), 600_000)),
        body: JSON.stringify(fitted.request),
      });
      if (!response.ok) throw new Error(`MiniMax Anthropic batch planner rejected with HTTP ${response.status}`);
      const content = await anthropicText(response);
      const json = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      return normalizeBatchPlan(JSON.parse(json) as unknown, sessions);
    },
    async reconcile({ groups }) {
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
          max_tokens: DEFAULT_BATCH_OUTPUT_TOKENS,
          temperature: 0,
          stream: true,
          output_config: { effort: "low" },
          system: [{ type: "text", text: batchReconciliationPrompt(), cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: JSON.stringify(batchReconciliationPayload(groups)) }],
        }),
      });
      if (!response.ok) throw new Error(`MiniMax Anthropic reconciliation rejected with HTTP ${response.status}`);
      const content = await anthropicText(response);
      const json = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      return normalizeBatchReconciliation(JSON.parse(json) as unknown, groups);
    },
  };
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}
