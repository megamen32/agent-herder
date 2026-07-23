import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const file = JSON.parse(await readFile(this.filePath, "utf8")) as LineageFile;
      for (const record of file.records || []) this.records.set(record.sessionKey, record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async record(record: LineageRecord): Promise<void> {
    await this.load();
    this.records.set(record.sessionKey, record);
    await this.persist();
  }

  async get(sessionKey: string): Promise<LineageRecord | undefined> {
    await this.load();
    return this.records.get(sessionKey);
  }

  async children(parentKey: string): Promise<LineageRecord[]> {
    await this.load();
    return [...this.records.values()].filter((record) => record.parentKey === parentKey);
  }

  /** Merge a transport checkpoint into an existing lineage record atomically. */
  async recordRecovery(sessionKey: string, checkpoint: RecoveryCheckpoint): Promise<void> {
    await this.load();
    const current = this.records.get(sessionKey);
    if (!current) throw new Error(`Cannot checkpoint unknown lineage session '${sessionKey}'`);
    this.records.set(sessionKey, {
      ...current,
      ...checkpoint,
      updatedAt: new Date().toISOString(),
    });
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    const data: LineageFile = { version: 1, records: [...this.records.values()] };
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}
