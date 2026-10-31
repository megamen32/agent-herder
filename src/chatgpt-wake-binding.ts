import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Explicit, validated ChatGPT wake-binding registry.
 *
 * ChatGPT MCP hosts supply no native conversation identifier in request
 * metadata (the documented `openai/session` is an anonymous correlation id,
 * not a routable chat id), so automatic caller attribution and self-resume
 * for ChatGPT remain impossible and fail closed. This registry implements the
 * only honest alternative: an explicit opt-in binding. A caller registers a
 * binding id together with a shared secret and a validated owner session;
 * later calls that present the same binding id and secret receive that
 * validated owner back, to pass explicitly to session_identity or
 * resume_after. Secrets are stored only as salted SHA-256 digests and never
 * logged or returned.
 */

export interface WakeBindingOwner {
  harness: string;
  sessionId: string;
}

export interface WakeBindingRecord {
  bindingId: string;
  secretDigest: string;
  secretSalt: string;
  owner: WakeBindingOwner;
  provenance: { clientId?: string; subject?: string };
  createdAt: string;
  useCount: number;
  maxUses: number;
  /** Job ids already delivered to this binding: one delivery per job. */
  deliveredJobs: string[];
}

export interface WakeBindingStoreOptions {
  /** Bounded file path; the store keeps at most maxBindings records. */
  filePath: string;
  maxBindings?: number;
  maxUses?: number;
  /** Injectable clock and randomness for tests. */
  now?: () => Date;
}

interface WakeBindingFile {
  version: 1;
  bindings: WakeBindingRecord[];
}

const DEFAULT_MAX_BINDINGS = 64;
/**
 * A binding secret normally travels through a chat transcript, so its budget
 * is small by default: enough for one registration handshake and a handful of
 * verifications, not an open-ended credential.
 */
const DEFAULT_MAX_USES = 8;

function digestSecret(salt: string, secret: string): string {
  return createHash("sha256").update(`${salt}:${secret}`).digest("hex");
}

export class WakeBindingStore {
  private readonly maxBindings: number;
  private readonly maxUses: number;
  private readonly now: () => Date;
  private operation: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: WakeBindingStoreOptions) {
    this.maxBindings = options.maxBindings ?? DEFAULT_MAX_BINDINGS;
    this.maxUses = options.maxUses ?? DEFAULT_MAX_USES;
    this.now = options.now ?? (() => new Date());
  }

  private async read(): Promise<WakeBindingFile> {
    try {
      const raw = JSON.parse(await readFile(this.options.filePath, "utf8")) as WakeBindingFile;
      if (raw?.version === 1 && Array.isArray(raw.bindings)) return raw;
    } catch {
      // Missing or unreadable file means an empty registry.
    }
    return { version: 1, bindings: [] };
  }

  private async write(file: WakeBindingFile): Promise<void> {
    await mkdir(dirname(this.options.filePath), { recursive: true });
    const temp = `${this.options.filePath}.tmp`;
    await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await writeFile(this.options.filePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  }

  /**
   * Register (or replace) one binding. The caller supplies the secret; only
   * its digest is persisted. Ownership validation happens in the MCP tool
   * layer before this call.
   */
  async register(input: {
    bindingId: string;
    secret: string;
    owner: WakeBindingOwner;
    provenance?: { clientId?: string; subject?: string };
    maxUses?: number;
  }): Promise<{ bindingId: string; owner: WakeBindingOwner; createdAt: string; maxUses: number }> {
    const bindingId = input.bindingId.trim();
    if (!bindingId || bindingId.length > 128) throw new Error("binding_id_invalid");
    if (typeof input.secret !== "string" || input.secret.length < 16 || input.secret.length > 256) {
      throw new Error("binding_secret_invalid: secret must be 16..256 characters");
    }
    if (!input.owner?.harness || !input.owner?.sessionId) throw new Error("binding_owner_invalid");
    const maxUses = Math.min(Math.max(1, input.maxUses ?? this.maxUses), this.maxUses);
    const secretSalt = randomBytes(16).toString("hex");
    // A rejected operation must not poison the queue: the next call still runs.
    return this.operation = this.operation.catch(() => undefined).then(async () => {
      const file = await this.read();
      const kept = file.bindings.filter((b) => b.bindingId !== bindingId);
      const record: WakeBindingRecord = {
        bindingId,
        secretDigest: digestSecret(secretSalt, input.secret),
        secretSalt,
        owner: { harness: input.owner.harness, sessionId: input.owner.sessionId },
        provenance: input.provenance ?? {},
        createdAt: this.now().toISOString(),
        useCount: 0,
        maxUses,
        deliveredJobs: [],
      };
      kept.push(record);
      if (kept.length > this.maxBindings) kept.splice(0, kept.length - this.maxBindings);
      await this.write({ version: 1, bindings: kept });
      return { bindingId, owner: record.owner, createdAt: record.createdAt, maxUses };
    }) as Promise<{ bindingId: string; owner: WakeBindingOwner; createdAt: string; maxUses: number }>;
  }

  /**
   * Verify a presented secret and return the validated bound owner exactly
   * once per call against the use budget. Wrong id, wrong secret, or an
   * exhausted binding all fail closed with the same generic error.
   */
  async verify(input: { bindingId: string; secret: string }): Promise<WakeBindingOwner> {
    const bindingId = input.bindingId.trim();
    return this.operation = this.operation.catch(() => undefined).then(async () => {
      const file = await this.read();
      const record = file.bindings.find((b) => b.bindingId === bindingId);
      const presented = digestSecret(record?.secretSalt ?? "0", input.secret);
      const matches = record !== undefined
        && presented.length === record.secretDigest.length
        && timingSafeEqual(Buffer.from(presented), Buffer.from(record.secretDigest));
      if (!matches || record.useCount >= record.maxUses) {
        throw new Error("chatgpt_wake_binding_unverified");
      }
      record.useCount += 1;
      await this.write(file);
      return { ...record.owner };
    }) as Promise<WakeBindingOwner>;
  }

  /** Administrative status without secrets: whether a binding id exists. */
  async exists(bindingId: string): Promise<boolean> {
    const file = await this.read();
    return file.bindings.some((b) => b.bindingId === bindingId.trim());
  }

  /**
   * Verify a binding and mark one job as delivered to it, atomically. The
   * same job is never delivered twice through the same binding, so a callback
   * fires exactly once. The owner comes back with the delivery receipt.
   */
  async verifyOnceForJob(input: { bindingId: string; secret: string; jobId: string }): Promise<WakeBindingOwner> {
    const bindingId = input.bindingId.trim();
    const jobId = input.jobId.trim();
    return this.operation = this.operation.catch(() => undefined).then(async () => {
      const file = await this.read();
      const record = file.bindings.find((b) => b.bindingId === bindingId);
      const presented = digestSecret(record?.secretSalt ?? "0", input.secret);
      const matches = record !== undefined
        && presented.length === record.secretDigest.length
        && timingSafeEqual(Buffer.from(presented), Buffer.from(record.secretDigest));
      if (!matches || record.useCount >= record.maxUses) {
        throw new Error("chatgpt_wake_binding_unverified");
      }
      if (record.deliveredJobs.includes(jobId)) {
        throw new Error("chatgpt_wake_delivery_already_done");
      }
      record.useCount += 1;
      record.deliveredJobs.push(jobId);
      await this.write(file);
      return { ...record.owner };
    }) as Promise<WakeBindingOwner>;
  }
}
