import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile, chmod } from "node:fs/promises";
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
  private static readonly REFRESH_AFTER_MS = 90_000;

  private scope = "";
  private dir = "";
  private cached = new Map<string, { messages: SessionMessageView[]; at: number }>();
  private inFlight = new Map<string, Promise<SessionMessageView[] | null>>();
  private queue: string[] = [];
  private queued = new Set<string>();
  private running = false;
  private pinned = new Set<string>();
  private lastPrewarmAt = 0;
  private lastPrewarmKey = "";

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
      this.queued.clear();
      this.queue.length = 0;
      return;
    }
    if (this.scope === scope) return;
    this.scope = scope;
    this.dir = join(this.root, this.provider, scope);
    this.cached.clear();
    this.queued.clear();
    this.queue.length = 0;
  }

  get available(): boolean { return this.dir.length > 0; }
  get accountScope(): string { return this.scope; }

  private path(id: string): string {
    return join(this.dir, createHash("sha256").update(id).digest("hex") + ".json.gz");
  }

  /** Read only a matching account's verified cache, never guess another login. */
  private async load(id: string): Promise<{ messages: SessionMessageView[]; at: number } | null> {
    if (!this.dir) return null;
    const memory = this.cached.get(id);
    if (memory) return memory;
    try {
      const data = await readFile(this.path(id));
      if (data.length > BrowserChatHistoryCache.MAX_COMPRESSED_BYTES) return null;
      const plain = gunzipSync(data, { maxOutputLength: BrowserChatHistoryCache.MAX_JSON_BYTES });
      const decoded = JSON.parse(plain.toString("utf8")) as {
        id: string; at: number; messages: SessionMessageView[];
      };
      if (decoded.id !== id || !Number.isFinite(decoded.at) || !Array.isArray(decoded.messages)) return null;
      const entry = { messages: decoded.messages, at: decoded.at };
      this.cached.set(id, entry);
      return entry;
    } catch { return null; }
  }

  private async save(id: string, messages: SessionMessageView[], expectedScope: string): Promise<void> {
    if (this.scope !== expectedScope || !this.dir) return;
    const at = Date.now();
    const plain = Buffer.from(JSON.stringify({ id, at, messages }));
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
      this.cached.set(id, { at, messages });
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async refresh(id: string): Promise<SessionMessageView[] | null> {
    const existing = this.inFlight.get(id);
    if (existing) return existing;
    const scope = this.scope;
    if (!scope) return null;
    const task = (async () => {
      try {
        const fresh = await this.fetchMessages(id);
        if (this.scope !== scope || !fresh) return null;
        await this.save(id, fresh, scope);
        return fresh;
      } catch {
        return null; // stale cache remains available after a network failure
      }
    })();
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
        const id = this.queue.shift()!;
        this.queued.delete(id);
        const old = await this.load(id);
        if (!old || Date.now() - old.at > BrowserChatHistoryCache.REFRESH_AFTER_MS)
          await this.refresh(id);
        // Avoid hammering either site while warming up one hundred histories.
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    } finally {
      this.running = false;
    }
  }

  /** Called when verified inventory is listed. Prime 100 recent chats, not the
   * entire account, and remove entries no longer inside this bounded window.
   */
  prewarm(nativeIds: readonly string[]): void {
    if (!this.dir) return;
    const configured = Number(process.env.AGENT_HERDER_BROWSER_CHAT_PREWARM_LIMIT);
    const limit = Number.isFinite(configured) && configured >= 1
      ? Math.min(BrowserChatHistoryCache.LIMIT, Math.floor(configured))
      : BrowserChatHistoryCache.LIMIT;
    const latest = [...new Set(nativeIds)].slice(0, limit);
    const key = this.scope + ":" + latest.join("|");
    if (key === this.lastPrewarmKey && Date.now() - this.lastPrewarmAt < 60_000) return;
    this.lastPrewarmKey = key;
    this.lastPrewarmAt = Date.now();
    this.pinned = new Set(latest);
    for (const id of latest) this.enqueue(id, false);
    void this.prune(latest);
  }

  private async prune(ids: readonly string[]): Promise<void> {
    if (!this.dir) return;
    const base = this.dir;
    try {
      const allowed = new Set(ids.map(id=>createHash("sha256").update(id).digest("hex")+".json.gz"));
      for (const file of await readdir(base)) {
        if (!/^[a-f0-9]{64}\.json\.gz$/.test(file) || allowed.has(file)) continue;
        if (base !== this.dir) break;
        await unlink(join(base,file)).catch(() => undefined);
      }
    } catch { /* no directory until first successful write */ }
  }

  /** Fast path returns previous messages immediately and refreshes in the
   * background. First uncached read gets priority over the warmup queue.
   */
  async messages(id: string, limit = 100): Promise<SessionMessageView[] | null> {
    if (!this.dir) return null;
    const saved = await this.load(id);
    if (saved) {
      if (Date.now() - saved.at > BrowserChatHistoryCache.REFRESH_AFTER_MS) this.enqueue(id,true);
      return saved.messages.slice(-Math.max(1,limit));
    }
    // Don't wait behind the whole 100-chat warmup when a user opens a chat.
    if (this.inFlight.has(id)) return (await this.inFlight.get(id)!)?.slice(-Math.max(1,limit)) ?? null;
    const fresh = await this.refresh(id);
    return fresh?.slice(-Math.max(1,limit)) ?? null;
  }
}
