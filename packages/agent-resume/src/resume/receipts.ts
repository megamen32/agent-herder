import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Durable admission receipts and idempotency for a bound delivery.
 *
 * A receipt answers one question after any restart: "was this exact input, for
 * this exact target, already admitted?" The ledger is a small file guarded by an
 * exclusive lock and replaced atomically, so two concurrent orchestrators cannot
 * both admit the same idempotency key.
 *
 * The fingerprint is computed over the same canonical payload the previous
 * Agent Resume service used, so a receipt written by that service is read back
 * by this core unchanged, and vice versa.
 */
export type ReceiptStatus = "accepted" | "rejected" | "ambiguous" | "failed";

export interface BoundTarget {
  agent: string;
  session_id: string;
  cwd: string;
  marker?: string | null;
  model?: string | null;
}

export interface ResumeReceiptRecord {
  receipt_id: string;
  receipt_ref: string;
  idempotency_key?: string;
  fingerprint?: string;
  result_ref?: string;
  status: ReceiptStatus;
  reason?: string;
  target?: BoundTarget | null;
  error?: string;
  command?: string[];
  log_file?: string;
  pid?: number | null;
  executed?: boolean;
  admitted_at?: string;
  [key: string]: unknown;
}

export interface ReceiptLedgerOptions {
  /** Ledger file; defaults to `<stateDir>/receipts.json`. */
  path: string;
}

export class ReceiptLedger {
  private readonly path: string;

  constructor(options: ReceiptLedgerOptions) {
    this.path = options.path;
  }

  /** Read-only lookup. Returns null when the key was never admitted. */
  read(idempotencyKey: string): ResumeReceiptRecord | null {
    const records = this.readRecords();
    return records[idempotencyKey] ?? null;
  }

  /**
   * Admit one input exactly once.
   *
   * `execute` runs only for a key that has never been admitted. A replay with the
   * same fingerprint returns the stored receipt untouched; the same key with a
   * different fingerprint is refused, because it means two different inputs are
   * claiming one identity.
   */
  async admit(request: {
    idempotencyKey: string;
    fingerprint: string;
    target: BoundTarget | null;
    resultRef?: string;
    execute: () => Promise<ResumeReceiptRecord>;
  }): Promise<ResumeReceiptRecord> {
    const key = validateIdempotencyKey(request.idempotencyKey, { required: true });
    return this.withLock<ResumeReceiptRecord>(async (records) => {
      const previous = records[key];
      if (previous) {
        if (previous.fingerprint === request.fingerprint) return previous;
        return {
          receipt_id: `resume-${randomUUID().replace(/-/g, "")}`,
          receipt_ref: "",
          idempotency_key: key,
          status: "rejected",
          reason: "idempotency_conflict",
          target: request.target,
          existing_receipt_id: previous.receipt_id,
        };
      }
      const produced = await request.execute();
      const record: ResumeReceiptRecord = {
        ...produced,
        receipt_ref: produced.receipt_ref || produced.receipt_id,
        idempotency_key: key,
        fingerprint: request.fingerprint,
        ...(request.resultRef !== undefined && produced.result_ref === undefined ? { result_ref: request.resultRef } : {}),
      };
      records[key] = record;
      return record;
    });
  }

  /**
   * Promote an ambiguous admission once a native proof confirms it. A receipt in
   * any other state, or a proof for a different agent or session, is left alone.
   */
  async promoteAmbiguous(
    idempotencyKey: string,
    expected: { fingerprint: string; target: BoundTarget; reason: string },
    proof: unknown,
    options: { promoteFor?: string[] } = {},
  ): Promise<ResumeReceiptRecord | null> {
    const key = validateIdempotencyKey(idempotencyKey, { required: true });
    return this.withLock<ResumeReceiptRecord | null>((records) => {
      const previous = records[key];
      if (!previous) return null;
      if (previous.status !== "ambiguous" || previous.reason !== expected.reason) return previous;
      if (previous.fingerprint !== expected.fingerprint) return previous;
      const agent = previous.target?.agent;
      if (!agent || (options.promoteFor && !options.promoteFor.includes(agent))) return previous;
      if (!nativeAdmissionVerified(proof, expected.target)) return previous;
      const promoted: ResumeReceiptRecord = {
        ...previous,
        status: "accepted",
        reason: "native_admission_verified",
        admitted_at: new Date().toISOString(),
      };
      records[key] = promoted;
      return promoted;
    });
  }

  /**
   * Run `mutate` against the ledger under the exclusive lock and persist the
   * result. The executor runs while the lock is held on purpose: two processes
   * racing on one key must not both deliver.
   */
  async withLock<T>(mutate: (records: Record<string, ResumeReceiptRecord>) => T | Promise<T>): Promise<T> {
    mkdirSync(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    const release = await acquireLock(lockPath);
    try {
      const records = this.readRecords();
      const value = await mutate(records);
      this.writeRecords(records);
      return value;
    } finally {
      release();
    }
  }

  private readRecords(): Record<string, ResumeReceiptRecord> {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`receipt ledger is unreadable: ${this.path}`);
    }
    const receipts = (parsed as { receipts?: unknown } | null)?.receipts;
    if (receipts && typeof receipts !== "object") throw new Error(`receipt ledger has invalid records: ${this.path}`);
    const entries = (receipts ?? {}) as Record<string, unknown>;
    const records: Record<string, ResumeReceiptRecord> = {};
    for (const [key, value] of Object.entries(entries)) {
      if (value && typeof value === "object") records[key] = value as ResumeReceiptRecord;
    }
    return records;
  }

  private writeRecords(records: Record<string, ResumeReceiptRecord>): void {
    const temporary = join(dirname(this.path), `.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`);
    const payload = `${JSON.stringify({ version: 1, receipts: records }, null, 2)}\n`;
    try {
      writeFileSync(temporary, payload, "utf8");
      renameSync(temporary, this.path);
    } finally {
      try { unlinkSync(temporary); } catch { /* already replaced */ }
    }
  }
}

/** Stable identity of one bound delivery: same input, same target, same digest. */
export function receiptFingerprint(input: {
  target: BoundTarget;
  prompt: string;
  goal?: string | null;
  idempotencyKey: string;
  resultRef?: string | null;
}): string {
  const payload: Record<string, unknown> = {
    harness: input.target.agent,
    agent: input.target.agent,
    sessionId: input.target.session_id,
    cwd: input.target.cwd,
    target: input.target,
    prompt: input.prompt,
    goal: input.goal ?? input.prompt,
    idempotency_key: input.idempotencyKey,
  };
  if (input.resultRef !== undefined && input.resultRef !== null) payload.result_ref = input.resultRef;
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

/** JSON with sorted keys and no whitespace, matching Python's canonical form. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function validateIdempotencyKey(value: unknown, options: { required?: boolean } = {}): string {
  if (value === undefined || value === null || String(value).trim() === "") {
    if (options.required) throw new Error("idempotency_key is required");
    return "";
  }
  const key = String(value).trim();
  if (key.length > 512) throw new Error("idempotency_key must be at most 512 characters");
  return key;
}

/**
 * Accept a late native-admission proof only when it is bound to the same agent
 * and the same session as the receipt it would promote.
 */
export function nativeAdmissionVerified(proof: unknown, target: BoundTarget): boolean {
  if (!proof || typeof proof !== "object" || (proof as { verified?: unknown }).verified !== true) return false;
  const record = proof as Record<string, unknown>;
  for (const alias of ["agent", "harness"]) {
    if (!(alias in record)) continue;
    const value = record[alias];
    if (typeof value !== "string" || !value.trim() || value.trim() !== target.agent) return false;
  }
  let hasSessionIdentity = false;
  for (const alias of ["session_id", "sessionId", "thread_id", "threadId"]) {
    if (!(alias in record)) continue;
    const value = record[alias];
    if (typeof value !== "string" || !value.trim() || value.trim() !== target.session_id) return false;
    hasSessionIdentity = true;
  }
  return hasSessionIdentity;
}

/**
 * Cross-process exclusive lock on the ledger.
 *
 * `mkdir` is atomic on POSIX and is released by the owner only, which keeps the
 * ledger single-writer without a native flock binding.
 */
async function acquireLock(lockPath: string): Promise<() => void> {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      mkdirSync(lockPath);
      const owner = join(lockPath, "owner");
      writeFileSync(owner, String(process.pid), "utf8");
      return () => {
        try { unlinkSync(owner); } catch { /* lock may already be gone */ }
        try { rmdirSync(lockPath); } catch { /* another owner may have taken over */ }
      };
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      if (Date.now() > deadline) throw new Error(`receipt ledger is locked: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}