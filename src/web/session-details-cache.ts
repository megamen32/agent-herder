import {createHash} from "node:crypto";
import {mkdir, readdir, readFile, rename, rm, stat, writeFile} from "node:fs/promises";
import {homedir} from "node:os";
import {dirname, join} from "node:path";

/**
 * The durable quick-view cache of one local session.
 *
 * A click on a session must open from the last known state on disk, not from a
 * multi-second adapter read (a large opencode session measures 16-19s per
 * read). The cache stores only display data — the quick details view the web
 * panel renders — plus its own save time; permission states, admission
 * receipts and every mutation keep reading the live path exactly as before.
 * The first-ever read stays blocking; every later read answers instantly and
 * one rate-limited background refresh keeps the record fresh.
 */
export interface SessionQuickDetailsCacheOptions {
  root?: string;
  maxRecordBytes?: number;
  maxAgeMs?: number;
  maxFiles?: number;
  /** One background refresh per key at most this often. */
  minRefreshMs?: number;
  /** Never more than this many background refreshes at once. */
  maxBackgroundRefreshes?: number;
  now?: () => number;
}

interface StoredRecord {version: 1; savedAt: number; payload: unknown}

const safeSegment = (value: string) => /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : createHash("sha256").update(value).digest("hex");

export class SessionQuickDetailsCache {
  private writes = 0;
  private readonly lastTriggered = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  constructor(private readonly options: SessionQuickDetailsCacheOptions = {}) {}
  private now() {return (this.options.now ?? Date.now)();}
  private get maxRecordBytes() {return this.options.maxRecordBytes ?? 1024 * 1024;}
  private get maxAgeMs() {return this.options.maxAgeMs ?? 24 * 60 * 60 * 1000;}
  private get maxFiles() {return this.options.maxFiles ?? 512;}
  private get minRefreshMs() {return this.options.minRefreshMs ?? 30_000;}
  private get maxBackgroundRefreshes() {return this.options.maxBackgroundRefreshes ?? 2;}

  private fileFor(harness: string, sessionId: string, limit: number, history: string): string {
    const digest = createHash("sha256").update(JSON.stringify([harness, sessionId, limit, history])).digest("hex");
    return join(this.options.root ?? join(homedir(), ".local", "state", "agent-herder", "web-cache", "session-details"), safeSegment(harness), `${digest}.json`);
  }

  /** Serve the quick view: the saved record answers instantly while one fresh
   * read runs in the background; a missing record waits for the live read. */
  async serve(harness: string, sessionId: string, limit: number, history: string, load: () => Promise<unknown>): Promise<unknown> {
    const cached = await this.read(harness, sessionId, limit, history);
    if (cached) {
      this.refreshInBackground(harness, sessionId, limit, history, load);
      return cached.payload && typeof cached.payload === "object"
        ? {...(cached.payload as Record<string, unknown>), servedFromCacheAt: cached.savedAt}
        : cached.payload;
    }
    const payload = await load();
    void this.write(harness, sessionId, limit, history, payload);
    return payload;
  }

  private async read(harness: string, sessionId: string, limit: number, history: string): Promise<StoredRecord | undefined> {
    try {
      const text = await readFile(this.fileFor(harness, sessionId, limit, history), "utf8");
      if (text.length > this.maxRecordBytes * 2) return undefined;
      const parsed = JSON.parse(text) as StoredRecord;
      if (parsed?.version !== 1 || !Number.isFinite(parsed.savedAt) || !("payload" in parsed)) return undefined;
      if (this.now() - parsed.savedAt >= this.maxAgeMs) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private async write(harness: string, sessionId: string, limit: number, history: string, payload: unknown): Promise<void> {
    try {
      const text = JSON.stringify({version: 1, savedAt: this.now(), payload} satisfies StoredRecord);
      if (typeof text !== "string" || Buffer.byteLength(text) > this.maxRecordBytes) return;
      const path = this.fileFor(harness, sessionId, limit, history);
      await mkdir(dirname(path), {recursive: true});
      const temporary = `${path}.${createHash("sha256").update(text).digest("hex").slice(0, 16)}.tmp`;
      await writeFile(temporary, text, {mode: 0o600});
      await rename(temporary, path);
      this.writes++;
      if (this.writes % 32 === 0) await this.prune();
    } catch {
      /* a failed cache write must never fail the read that produced it */
    }
  }

  private refreshInBackground(harness: string, sessionId: string, limit: number, history: string, load: () => Promise<unknown>): void {
    const key = JSON.stringify([harness, sessionId, limit, history]);
    const now = this.now();
    if (this.inFlight.has(key) || this.inFlight.size >= this.maxBackgroundRefreshes) return;
    if (now - (this.lastTriggered.get(key) ?? 0) < this.minRefreshMs) return;
    this.lastTriggered.set(key, now);
    this.inFlight.add(key);
    void (async () => {
      try {
        const payload = await load();
        await this.write(harness, sessionId, limit, history, payload);
      } catch {
        /* the saved record stays served; the next request retries */
      } finally {
        this.inFlight.delete(key);
      }
    })();
  }

  /** Bounded cleanup: drop records older than maxAgeMs and the oldest files
   * beyond the count cap. Only ever touches this cache's own root. */
  private async prune(): Promise<void> {
    try {
      const root = this.options.root ?? join(homedir(), ".local", "state", "agent-herder", "web-cache", "session-details");
      const cutoff = this.now() - this.maxAgeMs;
      const directories = (await readdir(root, {withFileTypes: true})).filter(entry => entry.isDirectory()).map(entry => join(root, entry.name));
      for (const directory of directories) {
        const files: Array<{name: string; path: string; mtimeMs: number}> = [];
        try {
          for (const entry of await readdir(directory, {withFileTypes: true})) {
            if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
            const path = join(directory, entry.name);
            const info = await stat(path);
            files.push({name: entry.name, path, mtimeMs: info.mtimeMs});
          }
        } catch {
          continue;
        }
        const expired = files.filter(file => file.mtimeMs < cutoff).map(file => file.path);
        const survivors = files.filter(file => file.mtimeMs >= cutoff).sort((a, b) => b.mtimeMs - a.mtimeMs);
        const overflow = survivors.length > this.maxFiles ? survivors.slice(this.maxFiles).map(file => file.path) : [];
        for (const path of [...expired, ...overflow]) await rm(path, {force: true}).catch(() => undefined);
      }
    } catch {
      /* pruning is best effort */
    }
  }
}

/** The one shared cache of the web control plane. */
export const sessionQuickDetailsCache = new SessionQuickDetailsCache();
