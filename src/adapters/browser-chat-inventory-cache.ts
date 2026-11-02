import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type InventoryEntry = {
  id: string; title: string;
  updatedAt?: number; createdAt?: number; asyncStatus?: number;
  seenAt: number;
};
type Stored = { scope: string; scannedAt: number; chats: InventoryEntry[] };

/** Durable full-list cache for one verified browser account. Holds the FULL
 * inventory (paginated once at init or via the rescan button) so listChats
 * returns every chat without re-fetching. Intercepted top-N updates merge in. */
export class BrowserChatInventoryCache {
  private scope = "";
  private dir = "";
  private chats = new Map<string, InventoryEntry>();
  private scannedAt = 0;
  constructor(
    private readonly provider: string,
    private readonly root: string = process.env.AGENT_HERDER_BROWSER_CHAT_INVENTORY_ROOT
      || join(homedir() ?? "", ".local", "state", "agent-herder", "browser-chat-inventory"),
  ) {}
  setAccountScope(scope?: string): void {
    if (!scope || !/^[a-f0-9]{32,64}$/.test(scope)) { this.scope=""; this.dir=""; this.chats.clear(); this.scannedAt=0; return; }
    if (this.scope === scope) return;
    this.scope = scope; this.dir = join(this.root, this.provider, scope);
    this.chats.clear(); this.scannedAt = 0;
  }
  get available(): boolean { return this.dir.length > 0; }
  get accountScope(): string { return this.scope; }
  get size(): number { return this.chats.size; }
  get empty(): boolean { return this.chats.size === 0; }
  get lastScannedAt(): number { return this.scannedAt; }
  private path(): string { return join(this.dir, "inventory.json"); }
  async load(): Promise<void> {
    if (!this.dir) return;
    try { const raw = await readFile(this.path(), "utf8"); const d = JSON.parse(raw) as Partial<Stored>;
      this.scannedAt = d.scannedAt || 0; this.chats.clear();
      for (const e of (d.chats || [])) if (e && e.id) this.chats.set(e.id, { ...e, seenAt: e.seenAt || this.scannedAt || Date.now() });
    } catch {}
  }
  async save(): Promise<void> {
    if (!this.dir) return;
    try { await mkdir(this.dir, { recursive: true });
      const payload: Stored = { scope: this.scope, scannedAt: this.scannedAt, chats: [...this.chats.values()] };
      await writeFile(this.path(), JSON.stringify(payload), "utf8"); await chmod(this.path(), 0o600);
    } catch {}
  }
  list(): InventoryEntry[] { return [...this.chats.values()].sort((a,b) => (b.updatedAt ?? b.seenAt) - (a.updatedAt ?? a.seenAt)); }
  merge(entries: InventoryEntry[]): void {
    for (const e of entries) {
      if (!e || !e.id || !e.title) continue;
      const prev = this.chats.get(e.id);
      this.chats.set(e.id, { id: e.id, title: e.title, updatedAt: e.updatedAt ?? prev?.updatedAt,
        createdAt: e.createdAt ?? prev?.createdAt, asyncStatus: e.asyncStatus ?? prev?.asyncStatus, seenAt: Date.now() });
    }
  }
  mergeFull(entries: InventoryEntry[]): void {
    const next = new Map<string, InventoryEntry>();
    for (const e of entries) {
      if (!e || !e.id || !e.title) continue;
      const prev = this.chats.get(e.id);
      next.set(e.id, { id: e.id, title: e.title, updatedAt: e.updatedAt ?? prev?.updatedAt,
        createdAt: e.createdAt ?? prev?.createdAt, asyncStatus: e.asyncStatus ?? prev?.asyncStatus, seenAt: prev?.seenAt || Date.now() });
    }
    this.chats = next; this.scannedAt = Date.now();
  }
}
