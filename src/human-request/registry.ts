import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { herderEvents, type HerderEventBus } from "../herder-events.js";
import { humanRequestResourceUri } from "../herder-resource-uris.js";

export type HumanRequestKind = "user" | "secret";
export type HumanRequestStatus = "pending" | "resuming" | "resumed" | "resume_failed" | "cancelled";

/**
 * Where the human answer of a request comes from.
 *
 * A question created through the question-binding seam has a Notice question
 * row, so its continuation may point at it. Every other request (metadata-only,
 * secret, or an internal judge decision) has no such row: its answer arrives in
 * the human channel of the bound session, and a continuation must not claim a
 * card that does not exist.
 */
export type HumanRequestAnswerSource = "notice_question" | "human_channel";

export interface HumanRequestTarget {
  readonly agent?: string;
  readonly harness?: string;
  sessionId: string;
  readonly cwd?: string;
  readonly marker?: string;
  /** Immutable harness-owned locator; required for Hermes exact-session wake. */
  readonly locator?: Readonly<Record<string, unknown>>;
}

export interface CreateHumanRequestInput {
  kind: HumanRequestKind;
  target: HumanRequestTarget;
  /** Default `human_channel`; only the question-binding seam sets it explicitly. */
  answerSource?: HumanRequestAnswerSource;
  /** Provider-owned opaque correlation handle; never a prompt or secret. */
  contextRef?: string;
  /** Internal creation source for typed Notice permission questions. */
  noticeDeliveryMode?: "manual" | "automatic";
  /** Explicit Notify event tuple. Agent Herder does not choose any of these values. */
  notify?: NotifyRoutingTupleInput;
}

export interface NotifyRoutingTupleInput {
  project: string;
  recipient: string;
  kind: string;
  severity: string;
  title: string;
}

export interface NotifyRoutingTuple extends NotifyRoutingTupleInput {
  dedupKey: string;
  incidentId?: string;
}

export interface HumanRequestResolution {
  /** The existing harness transport should continue the bound session. */
  continuation: "resume";
  /** Provider-owned opaque handle, such as an SSS answer reference. */
  resolutionRef?: string;
}

export interface ResumeAttemptResult {
  /** Provider-owned opaque result or failure receipt; never a payload. */
  receipt?: string;
  /** Explicit proof that native transport rejected before admission. */
  retryable?: boolean;
}

export interface ResumeClaimInput {
  attemptId?: string;
  resultRef?: string;
  /** Opaque human-answer reference; also becomes the default resultRef. */
  resolutionRef?: string;
  /** Bounded in-flight lease for the one admitted transport invocation. */
  leaseMs?: number;
  now?: Date;
}

export interface ResumeCompletionInput {
  attemptId: string;
  receipt?: string;
  retryable?: boolean;
}

export interface NoticeDeliveryClaim {
  state: "claimed" | "accepted" | "unknown";
  claimId: string;
  payloadFingerprint: string;
  claimedAt: string;
  settledAt?: string;
  reconciledAt?: string;
  httpStatus?: number;
  noticeRequestId?: string;
  deliveryStatus?: "sent";
}

/** Single admission receipt. Only `admitted` may invoke the resume transport. */
export interface ResumeAdmissionReceipt {
  /** True only for the caller that owns the one transport invocation of this attempt. */
  admitted: boolean;
  /** True when an expired in-flight lease was taken over with the same attempt and key. */
  recovered: boolean;
  /** Stable provider retry key; identical for every replay of one attempt. */
  idempotencyKey: string;
  record: HumanRequestRecord;
}

export interface HumanRequestRecord {
  requestId: string;
  kind: HumanRequestKind;
  target: HumanRequestTarget;
  contextRef?: string;
  status: HumanRequestStatus;
  /** How the answer reaches the resumed session. Never guessed at resume time. */
  answerSource: HumanRequestAnswerSource;
  /** Whether a typed permission question is delivered by the user flow or observer. */
  noticeDeliveryMode?: "manual" | "automatic";
  /** Set only by the Notice completion POST; the answer is read from Notice, never stored here. */
  completionSource?: "notice";
  continuation: "resume";
  resolutionRef?: string;
  resultRef?: string;
  attemptId?: string;
  /** Stable provider retry key for the admitted attempt; never a payload. */
  idempotencyKey?: string;
  /** Deadline of the admitted in-flight resume attempt. */
  resumeLeaseExpiresAt?: string;
  /** Instant the human answer was admitted; binds later resume attempts to it. */
  admittedAt?: string;
  receipt?: string;
  /** False fences ambiguous/admitted failures even if their reason looks retryable. */
  resumeRetryable?: boolean;
  /** Durable resume_after wait that continues this request; an admitted answer invalidates it. */
  resumeWaitId?: string;
  /** Atomic answer-or-timeout winner; written once under the durable file lock. */
  resumeWaitWinner?: "answer" | "timeout";
  /** Write-ahead Notice card delivery metadata only; never stores the card text. */
  noticeDelivery?: NoticeDeliveryClaim;
  createdAt: string;
  resolvedAt?: string;
  notify?: NotifyRoutingTuple;
}

interface RegistryFile {
  version: 1;
  requests: HumanRequestRecord[];
}

const FORBIDDEN_FIELDS = new Set([
  "answer", "body", "content", "payload", "plaintext", "response", "result", "secret", "value",
]);

function rejectPayloadFields(value: unknown, path = "input"): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectPayloadFields(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_FIELDS.has(key.toLowerCase())) {
      throw new Error(`${path}.${key} is not accepted; store an opaque reference instead`);
    }
    rejectPayloadFields(child, `${path}.${key}`);
  }
}

function opaqueRef(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) {
    throw new Error(`${field} must be a non-empty opaque reference (max 512 characters)`);
  }
  return value;
}

function targetOf(target: HumanRequestTarget): HumanRequestTarget {
  if (!target || typeof target !== "object") throw new Error("target is required");
  const agent = target.agent || target.harness;
  if (typeof agent !== "string" || agent.trim().length === 0 || agent.length > 128) {
    throw new Error("target.agent must be a non-empty identifier");
  }
  if (typeof target.sessionId !== "string" || target.sessionId.trim().length === 0 || target.sessionId.length > 512) {
    throw new Error("target.sessionId must be a non-empty identifier");
  }
  if (target.cwd !== undefined && (typeof target.cwd !== "string" || target.cwd.trim().length === 0 || target.cwd.length > 4096)) {
    throw new Error("target.cwd must be a non-empty path");
  }
  if (target.marker !== undefined) opaqueRef(target.marker, "target.marker");
  if (target.locator !== undefined && (!target.locator || typeof target.locator !== "object" || Array.isArray(target.locator))) {
    throw new Error("target.locator must be an object");
  }
  const locator = target.locator ? Object.freeze({ ...target.locator }) : undefined;
  return Object.freeze({ agent, ...(target.harness ? { harness: target.harness } : {}), sessionId: target.sessionId, ...(target.cwd ? { cwd: target.cwd } : {}), ...(target.marker ? { marker: target.marker } : {}), ...(locator ? { locator } : {}) });
}

function notifyOf(input: NotifyRoutingTupleInput | undefined, requestId: string): NotifyRoutingTuple | undefined {
  if (input === undefined) return undefined;
  rejectPayloadFields(input);
  for (const field of ["project", "recipient", "kind", "severity", "title"] as const) {
    if (typeof input[field] !== "string" || input[field].trim().length === 0 || input[field].length > 512) {
      throw new Error(`notify.${field} must be supplied by the caller`);
    }
  }
  return { ...input, dedupKey: `human-request:${requestId}` };
}

function validateRecord(record: HumanRequestRecord): HumanRequestRecord {
  rejectPayloadFields(record);
  if (!record || typeof record.requestId !== "string" || record.requestId.length < 1) throw new Error("invalid request record");
  if (record.kind !== "user" && record.kind !== "secret") throw new Error("invalid request kind");
  if (record.status !== "pending" && record.status !== "resuming" && record.status !== "resumed" && record.status !== "resume_failed" && record.status !== "cancelled") throw new Error("invalid request status");
  if (record.answerSource !== "notice_question" && record.answerSource !== "human_channel") {
    // A record written before the discriminator existed had no Notice row.
    if (record.answerSource !== undefined) throw new Error("invalid request answer source");
  }
  if (record.noticeDeliveryMode !== undefined && (record.answerSource !== "notice_question"
    || (record.noticeDeliveryMode !== "manual" && record.noticeDeliveryMode !== "automatic"))) {
    throw new Error("invalid Notice delivery mode");
  }
  if (record.completionSource !== undefined && (record.completionSource !== "notice" || record.kind === "secret")) {
    throw new Error("invalid completion source");
  }
  targetOf(record.target);
  opaqueRef(record.contextRef, "contextRef");
  opaqueRef(record.resolutionRef, "resolutionRef");
  opaqueRef(record.resultRef, "resultRef");
  opaqueRef(record.attemptId, "attemptId");
  opaqueRef(record.idempotencyKey, "idempotencyKey");
  opaqueRef(record.receipt, "receipt");
  if (record.resumeRetryable !== undefined && typeof record.resumeRetryable !== "boolean") throw new Error("invalid resume retry evidence");
  if (record.resumeWaitId !== undefined) opaqueRef(record.resumeWaitId, "resumeWaitId");
  if (record.resumeWaitWinner !== undefined) {
    if (record.resumeWaitWinner !== "answer" && record.resumeWaitWinner !== "timeout") throw new Error("invalid resume wait winner");
    if (record.resumeWaitId === undefined) throw new Error("resume wait winner requires a bound resume wait");
  }
  if (record.noticeDelivery) {
    const delivery = record.noticeDelivery;
    if ((delivery.state !== "claimed" && delivery.state !== "accepted" && delivery.state !== "unknown")
      || !/^[a-f0-9]{64}$/.test(delivery.payloadFingerprint)
      || !delivery.claimId || delivery.claimId.length > 128 || !delivery.claimedAt) throw new Error("invalid Notice delivery claim");
    if (delivery.settledAt !== undefined && !Number.isFinite(Date.parse(delivery.settledAt))) throw new Error("invalid Notice delivery settlement time");
    if (delivery.reconciledAt !== undefined && !Number.isFinite(Date.parse(delivery.reconciledAt))) throw new Error("invalid Notice delivery reconciliation time");
    if (delivery.httpStatus !== undefined && (!Number.isInteger(delivery.httpStatus) || delivery.httpStatus < 100 || delivery.httpStatus > 599)) throw new Error("invalid Notice delivery HTTP status");
    if (delivery.noticeRequestId !== undefined && delivery.noticeRequestId !== record.requestId) throw new Error("Notice receipt request id does not match the Human Request");
    if (delivery.deliveryStatus !== undefined && delivery.deliveryStatus !== "sent") throw new Error("invalid Notice channel delivery status");
    if (delivery.state === "accepted" && (!delivery.settledAt || delivery.httpStatus === undefined
      || delivery.noticeRequestId !== record.requestId || delivery.deliveryStatus !== "sent")) throw new Error("accepted Notice delivery is missing its exact receipt");
    if (delivery.state === "unknown" && !delivery.settledAt) throw new Error("unknown Notice delivery is missing its terminal time");
    if (record.answerSource !== "notice_question") throw new Error("Notice delivery metadata requires a typed Notice question");
  }
  if (record.notify) {
    notifyOf(record.notify, record.requestId);
    if (record.notify.dedupKey !== `human-request:${record.requestId}`) throw new Error("invalid Notify dedupKey");
    if (record.notify.incidentId !== undefined) opaqueRef(record.notify.incidentId, "notify.incidentId");
  }
  if (record.status === "resuming" && !record.attemptId) throw new Error("resuming request is missing attemptId");
  if (record.status === "resumed" || record.status === "resume_failed") {
    if (!record.resolvedAt) throw new Error("terminal request is missing resolvedAt");
    if (!record.attemptId) throw new Error("terminal request is missing attemptId");
  }
  if (record.status === "cancelled" && !record.resolvedAt) throw new Error("cancelled request is missing resolvedAt");
  return record;
}

/** Signals that automatic work must wait for a human instead of guessing. */
export class HumanRequestLockUnavailableError extends Error {
  readonly code = "HUMAN_REQUEST_LOCK_UNAVAILABLE";

  constructor(readonly lockPath: string, cause: unknown) {
    super(`Human Request lock is unavailable; answering must wait for human action (${lockPath})`, { cause });
    this.name = "HumanRequestLockUnavailableError";
  }
}

/** One admitted resume attempt may hold this bounded lease before a replay may take it over. */
export const DEFAULT_RESUME_LEASE_MS = 5 * 60 * 1000;

/** Durable correlation registry. It stores routing metadata and opaque refs only. */
export class HumanRequestRegistry {
  private operation: Promise<unknown> = Promise.resolve();
  private readonly lockTarget: string;

  constructor(private readonly filePath: string, private readonly events: HerderEventBus = herderEvents) {
    this.lockTarget = `${filePath}.lock`;
  }

  /** Return the durable registry identity used to serialize overlapping admissions. */
  get coordinationKey(): string {
    return this.filePath;
  }

  private publishRequest(requestId: string, action: "created" | "updated"): void {
    this.events.publish({ kind: "human-request", uri: "herder://human-requests", action, id: requestId });
    this.events.publish({ kind: "human-request", uri: humanRequestResourceUri(requestId), action, id: requestId });
  }

  async create(input: CreateHumanRequestInput): Promise<HumanRequestRecord> {
    rejectPayloadFields(input);
    if (input.kind !== "user" && input.kind !== "secret") throw new Error("kind must be user or secret");
    const target = targetOf(input.target);
    const contextRef = opaqueRef(input.contextRef, "contextRef");
    return this.mutate(async () => {
      const file = await this.read();
      const record: HumanRequestRecord = {
        requestId: randomUUID(),
        kind: input.kind,
        target,
        answerSource: input.answerSource ?? "human_channel",
        ...(input.answerSource === "notice_question" ? { noticeDeliveryMode: input.noticeDeliveryMode ?? "manual" } : {}),
        ...(contextRef ? { contextRef } : {}),
        status: "pending",
        continuation: "resume",
        createdAt: new Date().toISOString(),
        ...(input.notify ? { notify: notifyOf(input.notify, "pending") } : {}),
      };
      if (record.notify) record.notify.dedupKey = `human-request:${record.requestId}`;
      file.requests.push(record);
      await this.write(file);
      this.publishRequest(record.requestId, "created");
      return record;
    });
  }

  async list(status?: HumanRequestStatus): Promise<HumanRequestRecord[]> {
    const records = (await this.read()).requests;
    return records.filter((record) => !status || record.status === status).map(cloneRecord);
  }

  async get(requestId: string): Promise<HumanRequestRecord | null> {
    if (typeof requestId !== "string" || requestId.trim().length === 0) throw new Error("requestId is required");
    const record = (await this.read()).requests.find((item) => item.requestId === requestId);
    return record ? cloneRecord(record) : null;
  }

  /** Atomically admit the only Notice POST for one typed question. Claims never expire or replay. */
  async claimNoticeDelivery(requestId: string, payloadFingerprint: string): Promise<{ admitted: boolean; claimId?: string; record: HumanRequestRecord }> {
    if (!/^[a-f0-9]{64}$/.test(payloadFingerprint)) throw new Error("payloadFingerprint must be a SHA-256 hex digest");
    return this.mutate(async () => {
      const file = await this.read();
      const record = file.requests.find((item) => item.requestId === requestId);
      if (!record) throw new Error(`Human request '${requestId}' not found`);
      if (record.status !== "pending" || record.answerSource !== "notice_question" || record.noticeDeliveryMode !== "automatic" || !record.notify) {
        return { admitted: false, record: cloneRecord(record) };
      }
      if (record.noticeDelivery) return { admitted: false, record: cloneRecord(record) };
      const claimId = randomUUID();
      record.noticeDelivery = { state: "claimed", claimId, payloadFingerprint, claimedAt: new Date().toISOString() };
      await this.write(file);
      this.publishRequest(record.requestId, "updated");
      return { admitted: true, claimId, record: cloneRecord(record) };
    });
  }

  /** Settle the single POST; ambiguous transport outcomes are terminal and never retried. */
  async completeNoticeDelivery(
    requestId: string,
    claimId: string,
    outcome: { state: "accepted"; httpStatus: number; noticeRequestId: string; deliveryStatus: "sent" }
      | { state: "unknown"; httpStatus?: number },
  ): Promise<HumanRequestRecord> {
    return this.mutate(async () => {
      const file = await this.read();
      const record = file.requests.find((item) => item.requestId === requestId);
      if (!record) throw new Error(`Human request '${requestId}' not found`);
      const current = record.noticeDelivery;
      if (!current || current.claimId !== claimId) throw new Error(`Notice delivery claim for '${requestId}' is not owned by this caller`);
      if (current.state !== "claimed") return cloneRecord(record);
      const settledAt = new Date().toISOString();
      if (outcome.state === "accepted") {
        if ((outcome.httpStatus !== 200 && outcome.httpStatus !== 201) || outcome.noticeRequestId !== requestId || outcome.deliveryStatus !== "sent") {
          throw new Error("accepted Notice delivery requires an exact sent receipt");
        }
        record.noticeDelivery = { ...current, state: "accepted", settledAt, httpStatus: outcome.httpStatus, noticeRequestId: outcome.noticeRequestId, deliveryStatus: outcome.deliveryStatus };
      } else {
        record.noticeDelivery = { ...current, state: "unknown", settledAt, ...(outcome.httpStatus ? { httpStatus: outcome.httpStatus } : {}) };
      }
      await this.write(file);
      this.publishRequest(record.requestId, "updated");
      return cloneRecord(record);
    });
  }

  /** Record a caller-verified canonical sent receipt without admitting another POST. */
  async reconcileNoticeDeliveryReceipt(
    requestId: string,
    claimId: string,
    payloadFingerprint: string,
    receipt: { httpStatus: 200 | 201; noticeRequestId: string; deliveryStatus: "sent" },
  ): Promise<HumanRequestRecord> {
    if (!/^[a-f0-9]{64}$/.test(payloadFingerprint)) throw new Error("payloadFingerprint must be a SHA-256 hex digest");
    if ((receipt.httpStatus !== 200 && receipt.httpStatus !== 201)
      || receipt.noticeRequestId !== requestId || receipt.deliveryStatus !== "sent") {
      throw new Error("Notice reconciliation requires an exact sent receipt");
    }
    return this.mutate(async () => {
      const file = await this.read();
      const record = file.requests.find((item) => item.requestId === requestId);
      if (!record) throw new Error(`Human request '${requestId}' not found`);
      const current = record.noticeDelivery;
      if (!current || current.claimId !== claimId || current.payloadFingerprint !== payloadFingerprint) {
        throw new Error(`Notice delivery claim and fingerprint for '${requestId}' do not match`);
      }
      if (current.state === "accepted") {
        if (current.httpStatus !== receipt.httpStatus || current.noticeRequestId !== receipt.noticeRequestId
          || current.deliveryStatus !== receipt.deliveryStatus) throw new Error("Notice reconciliation conflicts with the accepted receipt");
        return cloneRecord(record);
      }
      const reconciledAt = new Date().toISOString();
      record.noticeDelivery = { ...current, ...receipt, state: "accepted", settledAt: current.settledAt ?? reconciledAt, reconciledAt };
      await this.write(file);
      this.publishRequest(record.requestId, "updated");
      return cloneRecord(record);
    });
  }

  async resolve(requestId: string, resolution: HumanRequestResolution): Promise<HumanRequestRecord> {
    rejectPayloadFields(resolution);
    if (resolution.continuation !== "resume") throw new Error("continuation must be resume");
    const resolutionRef = opaqueRef(resolution.resolutionRef, "resolutionRef");
    return (await this.admitResume(requestId, resolutionRef ? { resolutionRef } : {})).record;
  }

  /** Atomically claim the one automatic resume attempt for a request. */
  async claimResume(requestId: string, input: string | ResumeClaimInput = {}): Promise<HumanRequestRecord> {
    return (await this.admitResume(requestId, typeof input === "string" ? { attemptId: input } : input)).record;
  }

  /**
   * Single admission for the one resume attempt of a request.
   *
   * Only the caller that receives `admitted: true` may invoke the resume
   * transport, and it must do so with the returned `idempotencyKey`. Every
   * replay returns the same durable record, attempt and key, so a conflicting
   * repeated answer can never overwrite the canonical admitted answer or
   * produce a second native resume. A crash between admission and completion
   * is observable: once the persisted lease expires a later answer takes the
   * same attempt and key over to read the provider ledger. Expiry does not
   * prove pre-admission failure or permit another native send.
   */
  async admitResume(requestId: string, input: ResumeClaimInput = {}): Promise<ResumeAdmissionReceipt> {
    const attemptId = opaqueRef(input.attemptId, "attemptId");
    const resolutionRef = opaqueRef(input.resolutionRef, "resolutionRef");
    const resultRef = opaqueRef(input.resultRef, "resultRef") ?? resolutionRef;
    const leaseMs = boundedLeaseMs(input.leaseMs ?? DEFAULT_RESUME_LEASE_MS);
    const now = input.now ?? new Date();
    if (Number.isNaN(now.getTime())) throw new Error("now must be a valid timestamp");
    return this.mutate(async () => {
      const file = await this.read();
      const record = file.requests.find((item) => item.requestId === requestId);
      if (!record) throw new Error(`Human request '${requestId}' not found`);
      const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
      if (record.status === "cancelled") throw new Error(`Human request '${requestId}' was cancelled`);
      // Only definite native-unavailable is a pre-admission failure. Retrying
      // the exact canonical answer reuses its attempt, key and original time.
      // Legacy receipts with this reserved reason remain recoverable; explicit
      // ambiguous/admitted failure evidence always takes precedence over it.
      if (record.status === "resume_failed" && record.receipt === "agent-resume:native-unavailable"
        && record.resumeRetryable !== false && resultRef !== undefined && resultRef === record.resultRef) {
        const existingKey = record.idempotencyKey ?? idempotencyKeyFor(record.requestId, record.attemptId!);
        record.status = "resuming";
        record.resumeLeaseExpiresAt = leaseExpiresAt;
        record.idempotencyKey = existingKey;
        delete record.receipt;
        delete record.resolvedAt;
        delete record.resumeRetryable;
        await this.write(file);
        const acknowledged = await this.acknowledge(requestId, record.attemptId!, existingKey, leaseExpiresAt);
        this.publishRequest(record.requestId, "updated");
        return { admitted: true, recovered: false, idempotencyKey: existingKey, record: acknowledged };
      }
      if (record.status === "resuming") {
        // The canonical admitted answer stays authoritative for a conflicting repeat.
        const existingKey = record.idempotencyKey ?? idempotencyKeyFor(record.requestId, record.attemptId!);
        if (record.resumeLeaseExpiresAt === undefined) {
          // An attempt admitted before leases existed starts its wait now instead
          // of staying unresumable forever.
          record.resumeLeaseExpiresAt = leaseExpiresAt;
          record.idempotencyKey = existingKey;
          await this.write(file);
          const backfilled = await this.acknowledge(requestId, record.attemptId!, existingKey, leaseExpiresAt);
          this.publishRequest(record.requestId, "updated");
          return { admitted: false, recovered: false, idempotencyKey: existingKey, record: backfilled };
        }
        if (!leaseExpired(record.resumeLeaseExpiresAt, now)) {
          return { admitted: false, recovered: false, idempotencyKey: existingKey, record: cloneRecord(record) };
        }
        record.resumeLeaseExpiresAt = leaseExpiresAt;
        record.idempotencyKey = existingKey;
        await this.write(file);
        const recovered = await this.acknowledge(requestId, record.attemptId!, existingKey, leaseExpiresAt);
        this.publishRequest(record.requestId, "updated");
        return { admitted: true, recovered: true, idempotencyKey: existingKey, record: recovered };
      }
      if (record.status !== "pending") {
        return {
          admitted: false,
          recovered: false,
          idempotencyKey: record.idempotencyKey ?? idempotencyKeyFor(record.requestId, record.attemptId ?? "none"),
          record: cloneRecord(record),
        };
      }
      if (record.answerSource === undefined) record.answerSource = "human_channel";
      const admittedAttemptId = attemptId ?? randomUUID();
      const idempotencyKey = idempotencyKeyFor(record.requestId, admittedAttemptId);
      record.status = "resuming";
      record.attemptId = admittedAttemptId;
      record.idempotencyKey = idempotencyKey;
      record.resumeLeaseExpiresAt = leaseExpiresAt;
      // The admission instant belongs to the first human answer. A later replay
      // or lease takeover keeps it, so an explicit stop that happened after the
      // answer still fences this resume.
      record.admittedAt = now.toISOString();
      // The admitted answer is the atomic winner over a concurrent question
      // timeout: the wait bound to this request is invalidated by the caller.
      if (record.resumeWaitId) record.resumeWaitWinner = "answer";
      if (resultRef) record.resultRef = resultRef;
      if (resolutionRef) record.resolutionRef = resolutionRef;
      await this.write(file);
      const acknowledged = await this.acknowledge(requestId, admittedAttemptId, idempotencyKey, leaseExpiresAt);
      this.publishRequest(record.requestId, "updated");
      return { admitted: true, recovered: false, idempotencyKey, record: acknowledged };
    });
  }

  /** Marks a pending non-secret request whose answer arrived through the Notice completion POST. */
  async markNoticeCompletion(requestId: string): Promise<HumanRequestRecord> {
    return this.mutate(async () => {
      const file = await this.read();
      const record = file.requests.find((item) => item.requestId === requestId);
      if (!record) throw new Error(`Human request '${requestId}' not found`);
      if (record.status === "pending" && record.kind !== "secret" && record.completionSource !== "notice") {
        record.completionSource = "notice";
        await this.write(file);
        this.publishRequest(record.requestId, "updated");
      }
      return cloneRecord(record);
    });
  }

  /** Complete the claimed resume. Replays return the existing terminal record. */
  async markResumed(requestId: string, attemptId: string, result?: ResumeAttemptResult): Promise<HumanRequestRecord> {
    return this.finishResume(requestId, attemptId, "resumed", result);
  }

  /** Record a failed resume. Replays return the existing terminal record. */
  async markResumeFailed(requestId: string, attemptId: string, result?: ResumeAttemptResult): Promise<HumanRequestRecord> {
    return this.finishResume(requestId, attemptId, "resume_failed", result);
  }

  async completeResume(requestId: string, input: ResumeCompletionInput): Promise<HumanRequestRecord> {
    return this.finishResume(requestId, input.attemptId, "resumed", input);
  }

  async failResume(requestId: string, input: ResumeCompletionInput): Promise<HumanRequestRecord> {
    return this.finishResume(requestId, input.attemptId, "resume_failed", input);
  }

  private async finishResume(requestId: string, attemptId: string, status: "resumed" | "resume_failed", result?: ResumeAttemptResult): Promise<HumanRequestRecord> {
    rejectPayloadFields(result);
    const checkedAttemptId = opaqueRef(attemptId, "attemptId");
    const receipt = opaqueRef(result?.receipt, "receipt");
    if (result?.retryable !== undefined && typeof result.retryable !== "boolean") throw new Error("retryable must be boolean");
    return this.mutate(async () => {
      const file = await this.read();
      const record = file.requests.find((item) => item.requestId === requestId);
      if (!record) throw new Error(`Human request '${requestId}' not found`);
      if (record.status === "resumed" || record.status === "resume_failed" || record.status === "cancelled") return cloneRecord(record);
      if (record.status !== "resuming" || record.attemptId !== checkedAttemptId) {
        throw new Error(`Human request '${requestId}' is not owned by attemptId '${attemptId}'`);
      }
      record.status = status;
      if (receipt) record.receipt = receipt;
      if (status === "resume_failed" && result?.retryable !== undefined) record.resumeRetryable = result.retryable;
      record.resolvedAt = new Date().toISOString();
      await this.write(file);
      this.publishRequest(record.requestId, "updated");
      return cloneRecord(record);
    });
  }

  /**
   * Cancel an unanswered request.
   *
   * A Notice question that expired or was withdrawn must not hold its session
   * behind the pending-question gate forever. Cancellation is terminal, resumes
   * nothing and never touches a native session.
   */
  async cancel(requestId: string, reason: string): Promise<HumanRequestRecord> {
    const checkedReason = opaqueRef(reason, "reason");
    if (!checkedReason) throw new Error("an explicit reason is required to cancel a request");
    return this.mutate(async () => {
      const file = await this.read();
      const record = file.requests.find((item) => item.requestId === requestId);
      if (!record) throw new Error(`Human request '${requestId}' not found`);
      if (record.status === "resumed" || record.status === "resume_failed" || record.status === "cancelled") {
        return cloneRecord(record);
      }
      if (record.status === "resuming") throw new Error(`Human request '${requestId}' is already being resumed`);
      record.status = "cancelled";
      record.resolvedAt = new Date().toISOString();
      if (checkedReason) record.receipt = `cancelled:${checkedReason}`;
      await this.write(file);
      this.publishRequest(record.requestId, "updated");
      return cloneRecord(record);
    });
  }

  /**
   * Bind this request to the durable resume_after wait that continues it.
   * One request owns one wait; a repeated identical bind is idempotent.
   */
  async bindResumeWait(requestId: string, waitId: string): Promise<HumanRequestRecord> {
    const checkedWaitId = opaqueRef(waitId, "resumeWaitId");
    return this.mutate(async () => {
      const file = await this.read();
      const record = file.requests.find((item) => item.requestId === requestId);
      if (!record) throw new Error(`Human request '${requestId}' not found`);
      if (record.resumeWaitId && record.resumeWaitId !== checkedWaitId) {
        throw new Error(`Human request '${requestId}' is already bound to resume wait '${record.resumeWaitId}'`);
      }
      if (!record.resumeWaitId) {
        record.resumeWaitId = checkedWaitId;
        await this.write(file);
        this.publishRequest(record.requestId, "updated");
      }
      return cloneRecord(record);
    });
  }

  /**
   * Atomically settle the single winner between the human answer and the
   * question timeout for one bound resume wait.
   *
   * The timeout wins only while the request is still pending; a request that
   * already admitted its answer (or reached any other terminal state) is
   * reported as `answer` and left untouched. Replays of a settled timeout are
   * idempotent. Both this method and the answer admission run under the same
   * durable file lock, so exactly one of them can be first.
   */
  async timeoutResumeWait(requestId: string, waitId: string, reason: string): Promise<{ settled: "timeout" | "answer"; duplicate: boolean; record: HumanRequestRecord }> {
    const checkedWaitId = opaqueRef(waitId, "resumeWaitId");
    const checkedReason = opaqueRef(reason, "reason");
    return this.mutate(async () => {
      const file = await this.read();
      const record = file.requests.find((item) => item.requestId === requestId);
      if (!record) throw new Error(`Human request '${requestId}' not found`);
      if (record.resumeWaitId !== checkedWaitId) {
        throw new Error(`Human request '${requestId}' is not bound to resume wait '${waitId}'`);
      }
      if (record.resumeWaitWinner === "timeout") {
        // This wait already closed the question; a replay stays idempotent.
        return { settled: "timeout" as const, duplicate: true, record: cloneRecord(record) };
      }
      if (record.status !== "pending" || record.resumeWaitWinner === "answer") {
        return { settled: "answer" as const, duplicate: false, record: cloneRecord(record) };
      }
      record.resumeWaitWinner = "timeout";
      record.status = "cancelled";
      record.resolvedAt = new Date().toISOString();
      record.receipt = `timeout:${checkedReason}`;
      await this.write(file);
      this.publishRequest(record.requestId, "updated");
      return { settled: "timeout" as const, duplicate: false, record: cloneRecord(record) };
    });
  }

  /** Persist the incident id returned by Notify after its event is accepted. */
  async bindNotifyIncident(requestId: string, incidentId: string): Promise<HumanRequestRecord> {
    const checkedIncidentId = opaqueRef(incidentId, "incidentId");
    return this.mutate(async () => {
      const file = await this.read();
      const record = file.requests.find((item) => item.requestId === requestId);
      if (!record) throw new Error(`Human request '${requestId}' not found`);
      if (!record.notify) throw new Error(`Human request '${requestId}' has no explicit Notify tuple`);
      record.notify.incidentId = checkedIncidentId;
      await this.write(file);
      this.publishRequest(record.requestId, "updated");
      return cloneRecord(record);
    });
  }

  private async read(): Promise<RegistryFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as RegistryFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.requests)) throw new Error("invalid registry version");
      parsed.requests.forEach(validateRecord);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, requests: [] };
      throw error;
    }
  }

  private async write(file: RegistryFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = join(dirname(this.filePath), `.${filePathName(this.filePath)}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  /** Read the admitted attempt back before acknowledging it to a transport caller. */
  private async acknowledge(requestId: string, attemptId: string, idempotencyKey: string, leaseExpiresAt: string): Promise<HumanRequestRecord> {
    const persisted = (await this.read()).requests.find((record) => record.requestId === requestId);
    if (
      !persisted
      || persisted.status !== "resuming"
      || persisted.attemptId !== attemptId
      || persisted.idempotencyKey !== idempotencyKey
      || persisted.resumeLeaseExpiresAt !== leaseExpiresAt
    ) {
      throw new Error(`Human request '${requestId}' admission was not acknowledged by durable read-back`);
    }
    return cloneRecord(persisted);
  }

  /** Serialize mutations in this process and across services that share the same durable state file. */
  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    return this.serial(() => this.withFileLock(operation));
  }

  /** Acquire a bounded interprocess lock or fail closed before an answer can resume a session twice. */
  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.filePath), { recursive: true });
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
      throw new HumanRequestLockUnavailableError(this.lockTarget, error);
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

function cloneRecord(record: HumanRequestRecord): HumanRequestRecord {
  return {
    ...record,
    // A record written before the discriminator existed had no Notice row.
    answerSource: record.answerSource ?? "human_channel",
    target: targetOf(record.target),
    ...(record.notify ? { notify: { ...record.notify } } : {}),
    ...(record.noticeDelivery ? { noticeDelivery: { ...record.noticeDelivery } } : {}),
  };
}

function idempotencyKeyFor(requestId: string, attemptId: string): string {
  return `human-request:${requestId}:${attemptId}`;
}

function boundedLeaseMs(value: number): number {
  if (!Number.isInteger(value) || value < 1_000 || value > 60 * 60 * 1000) {
    throw new Error("leaseMs must be an integer from 1000 to 3600000");
  }
  return value;
}

function leaseExpired(value: string, now: Date): boolean {
  const parsed = Date.parse(value);
  return !Number.isFinite(parsed) || parsed <= now.getTime();
}

function filePathName(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf("/") + 1) || "registry";
}
