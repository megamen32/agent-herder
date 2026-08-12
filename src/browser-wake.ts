import lockfile from "proper-lockfile";
import { z } from "zod";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { BrowserWorkerClient, BrowserWorkerDispatchError, BrowserWorkerErrorClass, BrowserWorkerErrorClassSchema, BrowserWorkerReceipt, BrowserWorkerReceiptSchema, BrowserWorkerRequest, BrowserWorkerRequestSchema, createConfiguredBrowserWorkerClient } from "./browser-worker.js";

export const MAX_BROWSER_WAKE_ATTEMPTS = 3;

interface BrowserWakeFile {
  version: 1;
  records: BrowserWakeRecord[];
}

export interface BrowserWakeRecord {
  request: BrowserWorkerRequest;
  status: "claimed" | "completed" | "failed";
  attempts: number;
  requestedAt: string;
  updatedAt: string;
  receipt?: BrowserWorkerReceipt;
  errorClass?: BrowserWorkerErrorClass;
}

const browserWakeTimestamp = z.string().max(64).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
const browserWakeRecordSchema = z.object({
  request: BrowserWorkerRequestSchema,
  status: z.enum(["claimed", "completed", "failed"]),
  attempts: z.number().int().min(1).max(MAX_BROWSER_WAKE_ATTEMPTS),
  requestedAt: browserWakeTimestamp,
  updatedAt: browserWakeTimestamp,
  receipt: BrowserWorkerReceiptSchema.optional(),
  errorClass: BrowserWorkerErrorClassSchema.optional(),
}).strict().superRefine((record, context) => {
  if (record.status === "claimed" && (record.receipt || record.errorClass)) {
    context.addIssue({ code: "custom", path: ["status"], message: "claimed records cannot contain terminal fields" });
  }
  if (record.status === "completed" && (!record.receipt || record.receipt.status !== "completed" || record.errorClass)) {
    context.addIssue({ code: "custom", path: ["receipt"], message: "completed records require a completed receipt" });
  }
  if (record.status === "failed" && !record.receipt && !record.errorClass) {
    context.addIssue({ code: "custom", path: ["errorClass"], message: "failed records require a bounded failure class" });
  }
  if (record.status === "failed" && record.receipt && record.receipt.status !== "failed") {
    context.addIssue({ code: "custom", path: ["receipt"], message: "failed records require a failed receipt" });
  }
});
const browserWakeFileSchema = z.object({ version: z.literal(1), records: z.array(browserWakeRecordSchema) }).strict();

export class BrowserWakeLedger {
  private readonly lockTarget: string;

  constructor(private readonly filePath: string) {
    this.lockTarget = `${filePath}.lock`;
  }

  async get(idempotencyId: string): Promise<BrowserWakeRecord | null> {
    const file = await this.read();
    return file.records.find((record) => record.request.idempotencyId === idempotencyId) || null;
  }

  async put(record: BrowserWakeRecord): Promise<void> {
    const file = await this.read();
    const index = file.records.findIndex((item) => item.request.idempotencyId === record.request.idempotencyId);
    if (index >= 0) file.records[index] = record;
    else file.records.push(record);
    await this.write(file);
  }

  async withLock<T>(operation: () => Promise<T>, deadlineMs = 10 * 60 * 1000): Promise<T> {
    await this.ensureLockTarget();
    const release = await lockfile.lock(this.lockTarget, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: Math.max(0, Math.floor(deadlineMs / 25)), minTimeout: 25, maxTimeout: 25, factor: 1 },
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private async read(): Promise<BrowserWakeFile> {
    try {
      return browserWakeFileSchema.parse(JSON.parse(await readFile(this.filePath, "utf8"))) as BrowserWakeFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, records: [] };
      throw error;
    }
  }

  private async write(file: BrowserWakeFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }

  private async ensureLockTarget(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.lockTarget, "", { flag: "a" });
  }
}

export class BrowserWakeService {
  constructor(
    private readonly ledger: BrowserWakeLedger,
    private readonly client: BrowserWorkerClient | null,
  ) {}

  async wake(input: unknown): Promise<BrowserWakeRecord> {
    const request = BrowserWorkerRequestSchema.parse(input);
    const wakeDeadlineAt = Date.now() + request.deadlineMs;
    return this.ledger.withLock(async () => {
      const existing = await this.ledger.get(request.idempotencyId);
      if (existing) {
        if (!sameBrowserWakeRequest(existing.request, request)) {
          throw new Error("Browser wake idempotency conflict");
        }
        const attempts = existing.attempts || 1;
        if (existing.status === "completed") return existing;
        if (attempts >= MAX_BROWSER_WAKE_ATTEMPTS) return existing;
        if (existing.status === "claimed" && !isStaleClaim(existing)) return existing;
        if (existing.status === "failed" && !isRetryableErrorClass(existing.errorClass)) return existing;
      }
      if (!this.client) throw new Error("Browser worker unavailable");

      const claimedAt = new Date().toISOString();
      const attempts = (existing?.attempts || 0) + 1;
      const claimed: BrowserWakeRecord = { request, status: "claimed", attempts, requestedAt: claimedAt, updatedAt: claimedAt };
      await this.ledger.put(claimed);

      let receipt: BrowserWorkerReceipt | undefined;
      try {
        const remainingMs = wakeDeadlineAt - Date.now();
        if (remainingMs < 1) throw new BrowserWorkerDispatchError("worker_timeout");
        const dispatchRequest = remainingMs === request.deadlineMs
          ? request
          : { ...request, deadlineMs: Math.max(1, Math.min(request.deadlineMs, remainingMs)) };
        receipt = await this.client.dispatchWake(dispatchRequest);
        if (
          receipt.worker !== request.worker ||
          receipt.target !== request.target ||
          receipt.templateId !== request.templateId ||
          receipt.runId !== request.runId ||
          receipt.idempotencyId !== request.idempotencyId
        ) {
          throw new BrowserWorkerDispatchError("receipt_mismatch");
        }

        const finishedAt = new Date().toISOString();
        const finished: BrowserWakeRecord = {
          request,
          status: receipt.status,
          attempts,
          requestedAt: claimedAt,
          updatedAt: finishedAt,
          receipt,
          ...(receipt.status === "failed" && receipt.errorClass ? { errorClass: receipt.errorClass } : {}),
        };
        await this.ledger.put(finished);
        return finished;
      } catch (error) {
        const failedAt = new Date().toISOString();
        const errorClass = error instanceof BrowserWorkerDispatchError ? error.errorClass : "worker_unavailable";
        const failed: BrowserWakeRecord = {
          request,
          status: "failed",
          attempts,
          requestedAt: claimedAt,
          updatedAt: failedAt,
          ...(receipt ? { receipt } : {}),
          errorClass,
        };
        await this.ledger.put(failed);
        throw error;
      }
    }, request.deadlineMs);
  }
}

function sameBrowserWakeRequest(left: BrowserWorkerRequest, right: BrowserWorkerRequest): boolean {
  return (
    left.schema === right.schema &&
    left.worker === right.worker &&
    left.target === right.target &&
    left.templateId === right.templateId &&
    left.runId === right.runId &&
    left.idempotencyId === right.idempotencyId &&
    left.deadlineMs === right.deadlineMs &&
    left.sourceRefs.length === right.sourceRefs.length &&
    left.sourceRefs.every((ref, index) => ref === right.sourceRefs[index])
  );
}

function isStaleClaim(record: BrowserWakeRecord): boolean {
  const updatedAt = Date.parse(record.updatedAt);
  return !Number.isFinite(updatedAt) || Date.now() - updatedAt >= record.request.deadlineMs;
}

function isRetryableErrorClass(errorClass: BrowserWorkerErrorClass | undefined): boolean {
  return errorClass === "worker_unavailable" || errorClass === "worker_timeout" || errorClass === "browser_action_failed";
}

export function createConfiguredBrowserWakeService(environment: NodeJS.ProcessEnv = process.env): BrowserWakeService {
  return new BrowserWakeService(
    new BrowserWakeLedger(environment.AGENT_HERDER_BROWSER_WAKE_LEDGER || ".agent-herder/browser-wake-ledger.json"),
    createConfiguredBrowserWorkerClient(environment),
  );
}
