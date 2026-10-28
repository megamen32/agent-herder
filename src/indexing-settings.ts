import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type IndexingSettings = { enabled: boolean; updatedAt?: string; reason?: string };
/** One durable write gate for both indexes. Search opt-ins remain separate. */
export class BackgroundIndexingSettings {
  readonly path: string;
  private listeners = new Set<(enabled: boolean) => void | Promise<void>>();
  private writes: Promise<unknown> = Promise.resolve();
  private cached!: IndexingSettings;
  constructor(path = process.env.AGENT_HERDER_INDEXING_SETTINGS || join(homedir(), ".local/state/agent-herder/indexing-settings.json")) { this.path = path; this.reload(); }
  get(): IndexingSettings { return { ...this.cached }; }
  /** Only startup and an explicit control message reload the durable flag. */
  reload(): IndexingSettings {
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8"));
      if (typeof value.enabled !== "boolean") throw new Error("invalid_indexing_setting");
      return this.cached = { enabled: value.enabled, ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.cached = { enabled: true };
      return this.cached = { enabled: false, reason: "Настройка индексации недоступна; новые записи приостановлены." };
    }
  }
  subscribe(listener: (enabled: boolean) => void | Promise<void>): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async set(enabled: boolean): Promise<IndexingSettings> {
    if (typeof enabled !== "boolean") throw new Error("enabled must be boolean");
    const operation = this.writes.then(async () => {
      const next = { enabled, updatedAt: new Date().toISOString() };
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next) + "\n", { mode: 0o600 });
      await rename(temporary, this.path);
      this.cached = next;
      await Promise.all([...this.listeners].map(listener => listener(enabled)));
      return next;
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
}
let singleton: BackgroundIndexingSettings | undefined;
export function backgroundIndexingSettings(): BackgroundIndexingSettings { return singleton ??= new BackgroundIndexingSettings(); }
