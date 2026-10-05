import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentSession } from "./types/index.js";

export interface CacheHandoffAdmissionCheckpoint {
  state: "prepared" | "pending" | "failed" | "confirmed";
  session: AgentSession;
  operationId: string;
  prompt: string;
  error?: string;
}

export interface LineageRecord {
  sessionKey: string;
  parentKey?: string;
  role?: string;
  task?: string;
  provider: string;
  createdAt: string;
  source: "supervisor" | "acp-meta";
  nativeSessionId?: string;
  transport?: string;
  transportGeneration?: number;
  lastAcknowledgedEvent?: string;
  lastTurnId?: string;
  recoveryAttempts?: number;
  lastError?: string;
  recoveredFrom?: string;
  updatedAt?: string;
  cacheHandoffAdmission?: CacheHandoffAdmissionCheckpoint;
}

export interface RecoveryCheckpoint {
  nativeSessionId?: string;
  transport?: string;
  transportGeneration?: number;
  lastAcknowledgedEvent?: string;
  lastTurnId?: string;
  recoveryAttempts?: number;
  lastError?: string;
  recoveredFrom?: string;
}

interface LineageFile {
  version: 1;
  records: LineageRecord[];
}

/** Persists parent/child relationships without requiring a database. */
export class LineageStore {
  private records = new Map<string, LineageRecord>();
  private loaded = false;
  private loadPromise?: Promise<void>;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    await this.mutationQueue;
    await this.ensureLoaded();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const file = JSON.parse(await readFile(this.filePath, "utf8")) as LineageFile;
          for (const record of file.records || []) this.records.set(record.sessionKey, record);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        this.loaded = true;
      })().finally(() => { this.loadPromise = undefined; });
    }
    await this.loadPromise;
  }

  async record(record: LineageRecord): Promise<void> {
    await this.enqueueMutation(async () => {
      await this.ensureLoaded();
      this.records.set(record.sessionKey, record);
      await this.persist();
    });
  }

  async get(sessionKey: string): Promise<LineageRecord | undefined> {
    await this.mutationQueue;
    await this.ensureLoaded();
    return this.records.get(sessionKey);
  }

  async children(parentKey: string): Promise<LineageRecord[]> {
    await this.mutationQueue;
    await this.ensureLoaded();
    return [...this.records.values()].filter((record) => record.parentKey === parentKey);
  }

  /** Merge a transport checkpoint into an existing lineage record atomically. */
  async recordRecovery(sessionKey: string, checkpoint: RecoveryCheckpoint): Promise<void> {
    await this.enqueueMutation(async () => {
      await this.ensureLoaded();
      const current = this.records.get(sessionKey);
      if (!current) throw new Error(`Cannot checkpoint unknown lineage session '${sessionKey}'`);
      this.records.set(sessionKey, {
        ...current,
        ...checkpoint,
        updatedAt: new Date().toISOString(),
      });
      await this.persist();
    });
  }

  private async enqueueMutation(operation: () => Promise<void>): Promise<void> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.catch(() => undefined);
    return run;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const data: LineageFile = { version: 1, records: [...this.records.values()] };
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}
