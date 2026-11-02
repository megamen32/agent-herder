import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type { SessionMessageView } from "../types/index.js";

/** Durable local cache for the latest 100 chats of one VERIFIED browser account.
 * Reads are stale-while-revalidate; slow authenticated fetches never hide a
 * previously cached conversation. Text is never logged or put in job metadata.
 */
export class BrowserChatHistoryCache {
  private static readonly LIMIT = 100;
  private static readonly MAX_COMPRESSED_BYTES = 400_000;
  private static readonly MAX_JSON_BYTES = 500_000;
  private static readonly REQUEST_GAP_MS = 15_000;
  private revisions = new Map<string, string>();
  private dirty = new Set<string>();
  private invalidations = new Map<string, number>();
  private cooldownUntil = 0;
  private nextRequestAt = 0;
  private requestTail: Promise<void> = Promise.resolve();

  private scope = "";
  private dir = "";
  private cached = new Map<string, { messages: SessionMessageView[]; at: number; revision?: string }>();
  private inFlight = new Map<string, Promise<SessionMessageView[] | null>>();
  private readonly lastFailureAt = new Map<string, number>();
  private queue: string[] = [];
  private queued = new Set<string>();
  private running = false;

  constructor(
    private readonly provider: "chatgpt" | "zai",
    private readonly fetchMessages: (nativeId: string) => Promise<SessionMessageView[] | null>,
    private readonly root = process.env.AGENT_HERDER_BROWSER_CHAT_CACHE_ROOT ||
      join(homedir(), ".local", "state", "agent-herder", "browser-chat-history"),
  ) {}

  setAccountScope(scope?: string): void {
    // Scope is a SHA-256 digest calculated in the authenticated browser from
    // an account ID, not from the bearer token. Refuse unverified accounts.
    if (!scope || !/^[a-f0-9]{32,64}$/.test(scope)) {
      this.scope = "";
      this.dir = "";
      this.cached.clear();
      this.lastFailureAt.clear();
      this.revisions.clear();
      this.dirty.clear();
      this.invalidations.clear();
      this.queued.clear();
      this.queue.length = 0;
      return;
    }
    if (this.scope === scope) return;
    this.scope = scope;
    this.dir = join(this.root, this.provider, scope);
    this.cached.clear();
    this.lastFailureAt.clear();
      this.revisions.clear();
      this.dirty.clear();
      this.invalidations.clear();
    this.queued.clear();
    this.queue.length = 0;
  }

  get available(): boolean { return this.dir.length > 0; }
  get accountScope(): string { return this.scope; }

  private path(id: string): string {
    return join(this.dir, createHash("sha256").update(id).digest("hex") + ".json.gz");
  }

  /** Read only a matching account's verified cache, never guess another login. */
  private async load(id: string): Promise<{ messages: SessionMessageView[]; at: number; revision?: string } | null> {
    if (!this.dir) return null;
    const memory = this.cached.get(id);
    if (memory) return memory;
    try {
      const data = await readFile(this.path(id));
      if (data.length > BrowserChatHistoryCache.MAX_COMPRESSED_BYTES) return null;
      const plain = gunzipSync(data, { maxOutputLength: BrowserChatHistoryCache.MAX_JSON_BYTES });
      const decoded = JSON.parse(plain.toString("utf8")) as {
        id: string; at: number; revision?: string; messages: SessionMessageView[];
      };
      if (decoded.id !== id || !Number.isFinite(decoded.at) || !Array.isArray(decoded.messages)) return null;
      const entry = { messages: decoded.messages, at: decoded.at, revision: decoded.revision };
      this.cached.set(id, entry);
      return entry;
    } catch { return null; }
  }

  private async save(id: string, messages: SessionMessageView[], expectedScope: string, revision?: string): Promise<void> {
    if (this.scope !== expectedScope || !this.dir) return;
    const at = Date.now();
    const plain = Buffer.from(JSON.stringify({ id, at, messages, revision }));
    if (plain.length > BrowserChatHistoryCache.MAX_JSON_BYTES) return;
    const data = gzipSync(plain, { level: 6 });
    if (data.length > BrowserChatHistoryCache.MAX_COMPRESSED_BYTES) return;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = this.path(id);
    const temporary = target + ".tmp-" + process.pid;
    try {
      await writeFile(temporary, data, { mode: 0o600 });
      await chmod(temporary, 0o600);
      if (this.scope !== expectedScope) { await unlink(temporary); return; }
      await rename(temporary, target);
      this.cached.set(id, { at, messages, revision });
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async refresh(id: string): Promise<SessionMessageView[] | null> {
    const existing = this.inFlight.get(id);
    if (existing) return existing;
    const scope = this.scope;
    if (!scope) return null;
    const previous = this.requestTail;
    const task = (async () => {
      await previous;
      const delay = this.nextRequestAt - Date.now();
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      if (this.scope !== scope || Date.now() < this.cooldownUntil) return null;
      this.nextRequestAt = Date.now() + BrowserChatHistoryCache.REQUEST_GAP_MS;
      const revision = this.revisions.get(id);
      const invalidation = this.invalidations.get(id);
      try {
        const fresh = await this.fetchMessages(id);
        if (this.scope !== scope) return null;
        if (!fresh) {
          this.lastFailureAt.set(id, Date.now());
          this.cooldownUntil = Date.now() + 300_000;
          return null;
        }
        this.lastFailureAt.delete(id);
        await this.save(id, fresh, scope, revision);
        if (this.revisions.get(id) === revision && this.invalidations.get(id) === invalidation) this.dirty.delete(id);
        return fresh;
      } catch (error) {
        const is429 = /429/.test(String(error));
        const cooldownMs = is429 ? 60_000 : 300_000;
        this.cooldownUntil = Date.now() + cooldownMs;
        this.lastFailureAt.set(id, Date.now());
        console.warn("[browser-chat] history fetch " + (is429 ? "429 rate-limited" : "failed") + "; cooldown " + (cooldownMs / 1000) + "s");
        return null; // stale cache remains available after a network failure
      }
    })();
    this.requestTail = task.then(() => undefined, () => undefined);
    this.inFlight.set(id, task);
    try { return await task; }
    finally { this.inFlight.delete(id); }
  }

  private enqueue(id: string, priority: boolean): void {
    if (!this.dir || this.queued.has(id) || this.inFlight.has(id)) return;
    this.queued.add(id);
    if (priority) this.queue.unshift(id); else this.queue.push(id);
    if (!this.running) void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && this.dir) {
        if (Date.now() < this.cooldownUntil) {
          const dropped = this.queue.length;
          if (dropped) console.warn("[browser-chat] prewarm queue paused on cache cooldown; dropped " + dropped + " pending history fetches");
          this.queue.length = 0; this.queued.clear(); break;
        }
        const id = this.queue.shift()!;
        this.queued.delete(id);
        const scope = this.scope;
        const old = await this.load(id);
        if (this.scope !== scope) continue;
        if (!old || this.dirty.has(id) || (old.revision !== undefined && this.revisions.has(id) && old.revision !== this.revisions.get(id))) {
          await this.refresh(id);
        } else if (old.revision === undefined && this.revisions.has(id)) {
          // Migrate legacy cache metadata without downloading all histories.
          await this.save(id, old.messages, scope, this.revisions.get(id));
        }
        // Avoid hammering either site while warming up one hundred histories.
        await new Promise(resolve => setTimeout(resolve, BrowserChatHistoryCache.REQUEST_GAP_MS));
      }
    } finally {
      this.running = false;
    }
  }

  /** Mark a known successful foreground send as changed without a TTL sweep. */
  invalidate(id: string): void { this.dirty.add(id); this.invalidations.set(id, (this.invalidations.get(id) || 0) + 1); }

  prewarm(items: readonly (string | { id: string; revision?: string })[]): void {
    if (!this.dir || Date.now() < this.cooldownUntil) return;
    const configured = Number(process.env.AGENT_HERDER_BROWSER_CHAT_PREWARM_LIMIT);
    if (configured === 0) return; // Explicit emergency pause; never prune stored history.
    const limit = Number.isFinite(configured) && configured >= 1
      ? Math.min(BrowserChatHistoryCache.LIMIT, Math.floor(configured))
      : BrowserChatHistoryCache.LIMIT;
    for (const item of items.slice(0, limit)) {
      const id = typeof item === "string" ? item : item.id;
      const revision = typeof item === "string" ? undefined : item.revision;
      if (revision) {
        const previous = this.revisions.get(id);
        if (previous !== undefined && previous !== revision) this.invalidate(id);
        this.revisions.set(id, revision);
      }
      this.enqueue(id, false);
    }
  }

  /** Fast path returns previous messages immediately and refreshes in the
   * background. First uncached read gets priority over the warmup queue.
   */
  async messages(id: string, limit = 100): Promise<SessionMessageView[] | null> {
    if (!this.dir) return null;
    const saved = await this.load(id);
    if (saved) {
      if (this.dirty.has(id) || (saved.revision !== undefined && this.revisions.has(id) && saved.revision !== this.revisions.get(id))) this.enqueue(id,true);
      return saved.messages.slice(-Math.max(1,limit));
    }
    // Don't wait behind the whole 100-chat warmup when a user opens a chat.
    // A cold cache must never block an HTTP details request for 30+ seconds
    // when one site's authenticated API stalls. Start the fetch immediately,
    // return a recognizable empty loading state, and let the UI poll for data.
    // Concurrent callers are deduplicated by inFlight.
    if (Date.now() >= this.cooldownUntil && !this.inFlight.has(id) &&
      Date.now() - (this.lastFailureAt.get(id) || 0) > 30_000) void this.refresh(id);
    return [];
  }
}
