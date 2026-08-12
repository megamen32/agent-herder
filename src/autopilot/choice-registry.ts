import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";

export type AutopilotChoice = {
  choiceId: string;
  label: string;
  nextGoal: string;
};

export type AutopilotChoiceDecision = {
  kind: "choice";
  choices: AutopilotChoice[];
};

export type TimeoutChoiceState = "pending" | "claimed" | "dispatching" | "resumed" | "failed" | "expired-needs-human";

export type ChoiceInput = {
  harness?: "codex" | "opencode" | "hermes";
  sessionId: string;
  turnId: string;
  cwd: string;
  choices: AutopilotChoice[];
  expiresAt?: string;
  timeoutChoiceId?: string;
  policyRevision?: string;
  maxContinuationsPerSession?: number;
};

export type PendingChoice = {
  harness?: "codex" | "opencode" | "hermes";
  requestId: string;
  sessionId: string;
  turnId: string;
  cwd: string;
  choices: AutopilotChoice[];
  status: TimeoutChoiceState;
  choiceId?: string;
  nextGoal?: string;
  createdAt: string;
  expiresAt?: string;
  timeoutChoiceId?: string;
  policyRevision?: string;
  maxContinuationsPerSession?: number;
  resultRef: string;
  claimedAt?: string;
  claimToken?: string;
  leaseExpiresAt?: string;
  idempotencyKey?: string;
  failureReason?: string;
  resumeReceipt?: {
    status: "accepted" | "failed" | "rejected" | "ambiguous";
    resultRef: string;
    idempotencyKey: string;
    receiptRef?: string;
    reason?: string;
  };
};

type ChoiceFile = { version: 1; requests: PendingChoice[] };

const MAX = 4;
const MIN = 2;
const MAX_TEXT = 512;
const CHOICE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const TIMEOUT_LEASE_MS = 5 * 60 * 1000;

/** Signals that automatic timeout work must fail closed until an operator can intervene. */
export class ChoiceRegistryLockUnavailableError extends Error {
  readonly code = "AUTOPILOT_CHOICE_LOCK_UNAVAILABLE";

  constructor(readonly lockPath: string, cause: unknown) {
    super(`Choice registry lock is unavailable; automatic timeout work requires human action (${lockPath})`, { cause });
    this.name = "ChoiceRegistryLockUnavailableError";
  }
}

export class ChoiceRegistry {
  private operation: Promise<unknown> = Promise.resolve();
  private readonly lockTarget: string;

  constructor(private readonly path: string) {
    this.lockTarget = `${path}.lock`;
  }

  /** Return the durable registry identity used to serialize overlapping sweeps in one service. */
  get coordinationKey(): string {
    return this.path;
  }

  async create(input: ChoiceInput): Promise<PendingChoice> {
    validateInput(input);
    return this.mutate(async () => {
      const file = await this.read();
      const requestId = randomUUID();
      const record: PendingChoice = {
        ...input,
        choices: input.choices.map((choice) => ({ ...choice })),
        requestId,
        resultRef: `agent-herder://autopilot/choice/${requestId}`,
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      file.requests.push(record);
      await this.write(file);
      return clone(record);
    });
  }

  async get(requestId: string): Promise<PendingChoice | null> {
    const record = (await this.read()).requests.find((item) => item.requestId === requestId);
    return record ? clone(record) : null;
  }

  /** Return recent durable choice records for internal projections and operations. */
  async list(options: { status?: TimeoutChoiceState; limit?: number } = {}): Promise<PendingChoice[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 200));
    return (await this.read()).requests
      .filter((record) => !options.status || record.status === options.status)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, limit)
      .map(clone);
  }

  async claim(requestId: string, choiceId: string): Promise<PendingChoice> {
    if (!isText(choiceId)) throw new Error("choiceId is required");
    return (await this.claimForResume(requestId, choiceId)).record;
  }

  async claimForResume(requestId: string, choiceId: string): Promise<{ record: PendingChoice; claimed: boolean }> {
    if (!isText(choiceId)) throw new Error("choiceId is required");
    return this.mutate(async () => {
      const file = await this.read();
      const record = file.requests.find((item) => item.requestId === requestId);
      if (!record) throw new Error("choice request not found");
      if (record.status !== "pending") return { record: clone(record), claimed: false };
      const choice = record.choices.find((item) => item.choiceId === choiceId);
      if (!choice) throw new Error("choice does not belong to request");
      record.status = "claimed";
      record.choiceId = choice.choiceId;
      record.nextGoal = choice.nextGoal;
      record.claimedAt = new Date().toISOString();
      record.idempotencyKey = `${record.requestId}:${choice.choiceId}`;
      delete record.failureReason;
      delete record.resumeReceipt;
      await this.write(file);
      return { record: clone(record), claimed: true };
    });
  }

  /**
   * Atomically claims each overdue timeout candidate once.
   *
   * The claim token and lease are persisted before a caller may dispatch. A
   * A timeout-owned claimed or dispatching record is never reclaimed; an
   * expired lease is moved to the human-required terminal state instead.
   */
  async claimExpired(now = new Date()): Promise<PendingChoice[]> {
    assertValidInstant(now, "now");
    return this.mutate(async () => {
      const file = await this.read();
      const claimed: PendingChoice[] = [];
      const humanRequired: PendingChoice[] = [];
      let changed = false;
      for (const record of file.requests) {
        const timeoutOwned = isText(record.claimToken) && typeof record.leaseExpiresAt === "string";
        if (timeoutOwned && (record.status === "claimed" || record.status === "dispatching") && leaseExpired(record.leaseExpiresAt, now)) {
          const wasClaimed = record.status === "claimed";
          record.status = "expired-needs-human";
          record.failureReason = wasClaimed
            ? "claim lease expired before dispatch"
            : "dispatch lease expired without an acknowledged outcome";
          changed = true;
          continue;
        }
        if (record.status !== "pending" || !record.expiresAt || !instantExpired(record.expiresAt, now)) continue;
        const timeoutChoice = record.choices.find((choice) => choice.choiceId === record.timeoutChoiceId);
        if (!timeoutChoice) {
          record.status = "expired-needs-human";
          record.failureReason = "saved timeout target is missing or invalid";
          changed = true;
          humanRequired.push(clone(record));
          continue;
        }
        if (!hasValidContinuationBudget(record.maxContinuationsPerSession)) {
          record.status = "expired-needs-human";
          record.failureReason = "saved timeout continuation budget is unavailable";
          changed = true;
          humanRequired.push(clone(record));
          continue;
        }
        if (countTimeoutReservations(file, record) >= record.maxContinuationsPerSession) {
          record.status = "expired-needs-human";
          record.failureReason = "Timeout continuation budget is exhausted";
          changed = true;
          humanRequired.push(clone(record));
          continue;
        }
        record.status = "claimed";
        record.choiceId = timeoutChoice.choiceId;
        record.nextGoal = timeoutChoice.nextGoal;
        record.claimedAt = now.toISOString();
        record.claimToken = randomUUID();
        record.leaseExpiresAt = new Date(now.getTime() + TIMEOUT_LEASE_MS).toISOString();
        record.idempotencyKey = `${record.requestId}:${timeoutChoice.choiceId}`;
        delete record.failureReason;
        claimed.push(clone(record));
        changed = true;
      }
      if (changed) await this.write(file);
      const acknowledged = claimed.length > 0 ? await this.acknowledgeClaims(claimed) : claimed;
      return [...acknowledged, ...humanRequired];
    });
  }

  /**
   * Durably advances a timeout claim to dispatching using its stable token.
   * Returns null when the claim was already consumed or is no longer valid.
   */
  async markDispatching(
    requestId: string,
    token: string,
    now = new Date(),
    maxContinuationsPerSession?: number,
  ): Promise<PendingChoice | null> {
    if (!isText(token)) throw new Error("claim token is required");
    assertValidInstant(now, "now");
    return this.mutate(async () => {
      const file = await this.read();
      const record = file.requests.find((item) => item.requestId === requestId);
      if (!record || record.status !== "claimed" || record.claimToken !== token) return null;
      if (leaseExpired(record.leaseExpiresAt, now)) {
        record.status = "expired-needs-human";
        record.failureReason = "dispatch lease expired before dispatch";
        await this.write(file);
        return null;
      }
      const budget = maxContinuationsPerSession ?? record.maxContinuationsPerSession;
      if (!hasValidContinuationBudget(budget) || countTimeoutReservations(file, record) > budget) {
        record.status = "expired-needs-human";
        record.failureReason = !hasValidContinuationBudget(budget)
          ? "saved timeout continuation budget is unavailable"
          : "Timeout continuation budget is exhausted";
        await this.write(file);
        return null;
      }
      record.status = "dispatching";
      await this.write(file);
      return this.acknowledgeTimeoutState(requestId, token, "dispatching");
    });
  }

  async markResumed(requestId: string, choiceIdOrToken: string): Promise<PendingChoice> {
    return this.mutate(async () => {
      const file = await this.read();
      const record = file.requests.find((item) => item.requestId === requestId);
      if (!record) throw new Error("choice request does not match the claimed selection");
      if (record.status === "resumed") return clone(record);
      const timeoutClaim = record.claimToken === choiceIdOrToken;
      const manualClaim = record.choiceId === choiceIdOrToken && record.status === "claimed";
      if ((!timeoutClaim || record.status !== "dispatching") && !manualClaim) {
        throw new Error("choice request does not match the claimed selection");
      }
      record.status = "resumed";
      await this.write(file);
      return clone(record);
    });
  }

  /**
   * Records an explicit dispatch failure for a timeout claim.
   */
  async markFailed(requestId: string, token: string, reason: string): Promise<PendingChoice> {
    if (!isText(token) || !isText(reason)) throw new Error("claim token and failure reason are required");
    return this.mutate(async () => {
      const file = await this.read();
      const record = file.requests.find((item) => item.requestId === requestId);
      if (!record || record.claimToken !== token || record.status !== "dispatching") throw new Error("choice request does not match the dispatch claim");
      record.status = "failed";
      record.failureReason = reason;
      await this.write(file);
      return clone(record);
    });
  }

  /** Persist and read back the provider receipt before a terminal transition. */
  async persistResumeReceipt(requestId: string, token: string, receipt: PendingChoice["resumeReceipt"]): Promise<PendingChoice> {
    if (!receipt || !isText(receipt.idempotencyKey) || !isText(receipt.resultRef)) throw new Error("a bound resume receipt is required");
    return this.mutate(async () => {
      const file = await this.read();
      const record = file.requests.find((item) => item.requestId === requestId);
      if (!record || record.claimToken !== token || record.status !== "dispatching") throw new Error("choice request does not match the dispatch claim");
      record.resumeReceipt = { ...receipt };
      await this.write(file);
      return this.acknowledgeTimeoutState(requestId, token, "dispatching");
    });
  }

  /** Persist a manual button resume receipt before acknowledging the selection. */
  async persistManualResumeReceipt(
    requestId: string,
    choiceId: string,
    receipt: PendingChoice["resumeReceipt"],
  ): Promise<PendingChoice> {
    if (!receipt || !isText(receipt.idempotencyKey) || !isText(receipt.resultRef)) {
      throw new Error("a bound resume receipt is required");
    }
    return this.mutate(async () => {
      const file = await this.read();
      const record = file.requests.find((item) => item.requestId === requestId);
      if (
        !record ||
        record.status !== "claimed" ||
        record.choiceId !== choiceId ||
        record.idempotencyKey !== receipt.idempotencyKey ||
        record.resultRef !== receipt.resultRef
      ) {
        throw new Error("choice request does not match the manual resume receipt");
      }
      record.resumeReceipt = { ...receipt };
      await this.write(file);
      const persisted = (await this.read()).requests.find((item) => item.requestId === requestId);
      if (!persisted?.resumeReceipt || persisted.resumeReceipt.idempotencyKey !== receipt.idempotencyKey) {
        throw new Error("manual resume receipt was not acknowledged by durable read-back");
      }
      return clone(persisted);
    });
  }

  /** Return in-flight timeout claims for restart recovery without reclaiming them. */
  async listInFlightTimeoutClaims(): Promise<PendingChoice[]> {
    return this.mutate(async () => (await this.read()).requests
      .filter((record) => (record.status === "claimed" || record.status === "dispatching") && isText(record.claimToken) && isText(record.idempotencyKey))
      .map(clone));
  }

  /**
   * Fails closed when a timeout claim needs operator intervention.
   */
  async markHumanRequired(requestId: string, token: string, reason: string): Promise<PendingChoice> {
    if (!isText(token) || !isText(reason)) throw new Error("claim token and reason are required");
    return this.mutate(async () => {
      const file = await this.read();
      const record = file.requests.find((item) => item.requestId === requestId);
      if (!record || record.claimToken !== token || (record.status !== "claimed" && record.status !== "dispatching")) {
        throw new Error("choice request does not match the timeout claim");
      }
      record.status = "expired-needs-human";
      record.failureReason = reason;
      await this.write(file);
      return clone(record);
    });
  }

  async releaseFailed(requestId: string, choiceId: string): Promise<PendingChoice> {
    return this.mutate(async () => {
      const file = await this.read();
      const record = file.requests.find((item) => item.requestId === requestId);
      if (!record || record.choiceId !== choiceId) throw new Error("choice request does not match the claimed selection");
      record.status = "pending";
      clearClaim(record);
      await this.write(file);
      return clone(record);
    });
  }

  private async read(): Promise<ChoiceFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as ChoiceFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.requests)) throw new Error("invalid choice registry");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, requests: [] };
      throw error;
    }
  }

  private async write(file: ChoiceFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = join(dirname(this.path), `.${this.path.slice(this.path.lastIndexOf("/") + 1)}.${randomUUID()}.tmp`);
    await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.path);
  }

  /** Read the file back before acknowledging a timeout winner to its caller. */
  private async acknowledgeClaims(claims: PendingChoice[]): Promise<PendingChoice[]> {
    const readBack = await this.read();
    return claims.map((claim) => {
      const persisted = readBack.requests.find((record) => record.requestId === claim.requestId);
      if (!persisted || persisted.status !== "claimed" || persisted.claimToken !== claim.claimToken || persisted.leaseExpiresAt !== claim.leaseExpiresAt || persisted.idempotencyKey !== claim.idempotencyKey) {
        throw new Error("choice timeout claim was not acknowledged by durable read-back");
      }
      return clone(persisted);
    });
  }

  /** Read the durable dispatch state back before allowing a caller to invoke a consumer. */
  private async acknowledgeTimeoutState(requestId: string, token: string, status: TimeoutChoiceState): Promise<PendingChoice> {
    const persisted = (await this.read()).requests.find((record) => record.requestId === requestId);
    if (!persisted || persisted.status !== status || persisted.claimToken !== token) {
      throw new Error("choice timeout state was not acknowledged by durable read-back");
    }
    return clone(persisted);
  }

  /** Serialize mutations in this process and across registries that share the same durable state file. */
  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    return this.serial(() => this.withFileLock(operation));
  }

  /** Acquire a bounded interprocess lock or fail closed before automatic timeout work can continue. */
  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.lockTarget, "", { flag: "a", mode: 0o600 });
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(this.lockTarget, {
        realpath: false,
        stale: 30_000,
        update: 10_000,
        retries: { retries: 4, minTimeout: 10, maxTimeout: 25, factor: 1 },
      });
    } catch (error) {
      throw new ChoiceRegistryLockUnavailableError(this.lockTarget, error);
    }
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

function validateInput(input: ChoiceInput): void {
  if (!isText(input.sessionId) || !isText(input.turnId) || !isText(input.cwd)) throw new Error("sessionId, turnId, and cwd are required");
  if (input.choices.length < MIN || input.choices.length > MAX) throw new Error("2 to 4 choices are required");
  const ids = new Set<string>();
  for (const choice of input.choices) {
    if (!isText(choice.choiceId) || !CHOICE_ID_PATTERN.test(choice.choiceId)) throw new Error("choiceId must match callback identifier format");
    if (!isText(choice.label) || !isText(choice.nextGoal)) throw new Error("choice fields are required");
    if (ids.has(choice.choiceId)) throw new Error("choice ids must be unique");
    ids.add(choice.choiceId);
  }
  if (input.expiresAt !== undefined) assertValidInstant(input.expiresAt, "expiresAt");
  if (input.timeoutChoiceId !== undefined && !input.choices.some((choice) => choice.choiceId === input.timeoutChoiceId)) {
    throw new Error("timeoutChoiceId must belong to request choices");
  }
  if (input.policyRevision !== undefined && !isText(input.policyRevision)) throw new Error("policyRevision is required when provided");
  if (input.maxContinuationsPerSession !== undefined && !hasValidContinuationBudget(input.maxContinuationsPerSession)) {
    throw new Error("maxContinuationsPerSession must be an integer from 0 to 100");
  }
  if (input.timeoutChoiceId !== undefined && input.maxContinuationsPerSession === undefined) {
    throw new Error("maxContinuationsPerSession is required for a timeout choice");
  }
}

function isText(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TEXT; }
function assertValidInstant(value: string | Date, name: string): void {
  const parsed = typeof value === "string" ? Date.parse(value) : value.getTime();
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a valid timestamp`);
}
function instantExpired(value: string, now: Date): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= now.getTime();
}
function leaseExpired(value: string | undefined, now: Date): boolean {
  return !value || !Number.isFinite(Date.parse(value)) || instantExpired(value, now);
}
function hasValidContinuationBudget(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;
}
function countTimeoutReservations(file: ChoiceFile, candidate: PendingChoice): number {
  return file.requests.filter((record) =>
    canonicalSessionKey(record) === canonicalSessionKey(candidate) &&
    isText(record.claimToken) &&
    isText(record.idempotencyKey) &&
    (record.status === "claimed" || record.status === "dispatching" || record.status === "resumed"),
  ).length;
}
function canonicalSessionKey(record: Pick<PendingChoice, "sessionId" | "cwd">): string {
  const cwd = normalize(record.cwd);
  const canonicalCwd = cwd.length > 1 && cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  return `${record.sessionId}\u0000${canonicalCwd}`;
}
function clearClaim(record: PendingChoice): void {
  delete record.choiceId;
  delete record.nextGoal;
  delete record.claimedAt;
  delete record.claimToken;
  delete record.leaseExpiresAt;
  delete record.idempotencyKey;
  delete record.failureReason;
  delete record.resumeReceipt;
}
function clone(record: PendingChoice): PendingChoice { return { ...record, choices: record.choices.map((choice) => ({ ...choice })) }; }
