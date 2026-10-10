import { createHash } from "node:crypto";
import { mkdir, open, rename, writeFile, lstat, opendir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ControlResult } from "../types/index.js";

type Receipt = { at: number; result: ControlResult };
const uncertain: ControlResult = { ok: false, admissionUnknown: true, nonRetryable: true, error: "Native Codex delivery was attempted without a confirmed receipt; do not replay it" };

/** Singleton Herder owns native delivery. Persist intent before RPC so reconnects
 * and process restarts cannot replay input after a lost admission receipt. */
export class CodexDeliveryReceipts {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly inflight = new Map<string, Promise<ControlResult>>();
  private readonly file: string;
  private readonly buckets: string;
  constructor(codexDir?: string) {
    this.file = codexDir ? join(codexDir, "herder-delivery-receipts.json")
      : join(homedir(), ".local/state/agent-herder/codex-delivery-receipts.json");
    this.buckets = join(dirname(this.file), basename(this.file) + ".buckets");
  }

  async once(threadId: string, inputId: string, operation: () => Promise<ControlResult>): Promise<ControlResult> {
    const key = createHash("sha256").update(`${threadId}\0${inputId}`).digest("hex");
    const file = join(this.buckets, key.slice(0, 2) + ".json");
    const inflight = this.inflight.get(key);
    if (inflight) return inflight;
    const delivery = (async () => {
      const prior = await this.serial(async () => {
        // Preserve the old permanent evidence byte-for-byte. New receipts are
        // hash-partitioned so 2048 unrelated inputs cannot disable every thread.
        const legacy = await this.read(this.file);
        if (legacy[key]) return legacy[key]!.result;
        const receipts = await this.read(file);
        if (receipts[key]) return receipts[key]!.result;
        if (Object.keys(receipts).length >= 2048) {
          return { ok: false, nonRetryable: true,
            error: "Native Codex receipt storage is full; no delivery was attempted and no accepted input was evicted" };
        }
        receipts[key] = { at: Date.now(), result: uncertain };
        if (!await this.fitsBudget(file, receipts)) return { ok: false, nonRetryable: true,
          error: "Native Codex receipt disk budget is full; no delivery was attempted and no accepted input was evicted" };
        await this.write(file, receipts);
        return undefined;
      });
      if (prior) return prior;
      let result: ControlResult;
      try { result = await operation(); }
      catch (error) { result = { ...uncertain, error: (error as Error).message }; }
      await this.serial(async () => {
        const receipts = await this.read(file);
        if (result.ok || result.nonRetryable || result.admitted) receipts[key] = { at: Date.now(), result };
        else delete receipts[key]; // Proven pre-admission rejection may be retried.
        await this.write(file, receipts);
      });
      return result;
    })();
    this.inflight.set(key, delivery);
    try { return await delivery; }
    finally { this.inflight.delete(key); }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }
  private async read(file: string): Promise<Record<string, Receipt>> {
    try {
      const handle = await open(file, "r");
      let text: string;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 1024 * 1024) throw new Error("Native Codex receipt file exceeds its bounded read budget");
        const buffer = Buffer.alloc(1024 * 1024 + 1); let length = 0;
        while (length < buffer.length) {
          const {bytesRead} = await handle.read(buffer, length, buffer.length - length, length);
          if (!bytesRead) break; length += bytesRead;
        }
        if (length > 1024 * 1024) throw new Error("Native Codex receipt file exceeds its bounded read budget");
        text = buffer.subarray(0, length).toString("utf8");
      } finally { await handle.close(); }
      const data = JSON.parse(text) as Record<string, Receipt>;
      // Accepted/uncertain input IDs are permanent anti-replay evidence. Keep
      // the existing finite capacity; reject new admission instead of eviction.
      if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).length > 2048
          || Object.values(data).some(receipt => !receipt || typeof receipt !== "object"
            || !Number.isFinite(receipt.at) || !receipt.result || typeof receipt.result !== "object"
            || Array.isArray(receipt.result) || typeof receipt.result.ok !== "boolean")) {
        throw new Error("Native Codex receipt storage requires review; no delivery attempted");
      }
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }
  private async fitsBudget(file: string, receipts: Record<string, Receipt>): Promise<boolean> {
    const next = Buffer.byteLength(JSON.stringify(receipts));
    if (next > 1024 * 1024) return false;
    await mkdir(this.buckets, { recursive: true, mode: 0o700 });
    let bytes = 0, old = 0, count = 0;
    try { bytes = (await lstat(this.file)).size; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for await (const entry of await opendir(this.buckets)) {
      if (++count > 1024 || !entry.isFile() || !/^[a-f0-9]{2}\.json(?:\.[0-9]+\.tmp)?$/.test(entry.name)) return false;
      const path = join(this.buckets, entry.name), size = (await lstat(path)).size;
      bytes += size; if (path === file) old = size;
      if (bytes > 16 * 1024 * 1024) return false;
    }
    // Permanent state<=16MiB; one atomic temporary<=1MiB, inside the existing
    // 64MiB project state budget. Reads still hold at most2048 records per file.
    return bytes - old + next <= 16 * 1024 * 1024;
  }
  private async write(file: string, receipts: Record<string, Receipt>): Promise<void> {
    if (!await this.fitsBudget(file, receipts)) throw new Error("Native Codex receipt budget exhausted; persisted intent remains UNKNOWN and must not replay");
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(receipts), { mode: 0o600 });
    await rename(temporary, file);
  }
}
