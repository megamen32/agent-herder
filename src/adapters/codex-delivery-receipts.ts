import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  constructor(codexDir?: string) {
    this.file = codexDir ? join(codexDir, "herder-delivery-receipts.json")
      : join(homedir(), ".local/state/agent-herder/codex-delivery-receipts.json");
  }

  async once(threadId: string, inputId: string, operation: () => Promise<ControlResult>): Promise<ControlResult> {
    const key = createHash("sha256").update(`${threadId}\0${inputId}`).digest("hex");
    const inflight = this.inflight.get(key);
    if (inflight) return inflight;
    const delivery = (async () => {
      const prior = await this.serial(async () => {
        const receipts = await this.read();
        if (receipts[key]) return receipts[key]!.result;
        receipts[key] = { at: Date.now(), result: uncertain };
        await this.write(receipts);
        return undefined;
      });
      if (prior) return prior;
      let result: ControlResult;
      try { result = await operation(); }
      catch (error) { result = { ...uncertain, error: (error as Error).message }; }
      await this.serial(async () => {
        const receipts = await this.read();
        if (result.ok || result.nonRetryable || result.admitted) receipts[key] = { at: Date.now(), result };
        else delete receipts[key]; // Proven pre-admission rejection may be retried.
        await this.write(receipts);
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
  private async read(): Promise<Record<string, Receipt>> {
    try {
      const data = JSON.parse(await readFile(this.file, "utf8")) as Record<string, Receipt>;
      // Bounded retry window: one day, at most 2048 receipts, no message bodies.
      return Object.fromEntries(Object.entries(data).filter(([, r]) => Date.now() - r.at < 86400_000).sort((a, b) => b[1].at - a[1].at).slice(0, 2048));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }
  private async write(receipts: Record<string, Receipt>): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(receipts), { mode: 0o600 });
    await rename(temporary, this.file);
  }
}
