import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserChatInventoryCache } from "../src/adapters/browser-chat-inventory-cache.js";

const SCOPE = "a".repeat(64);
let dir: string;

describe("BrowserChatInventoryCache", () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "inv-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("loads empty when no file exists", async () => {
    const c = new BrowserChatInventoryCache("chatgpt", dir);
    c.setAccountScope(SCOPE);
    await c.load();
    expect(c.empty).toBe(true);
    expect(c.size).toBe(0);
    expect(c.lastScannedAt).toBe(0);
  });

  it("merges incremental updates and keeps newest titles", () => {
    const c = new BrowserChatInventoryCache("chatgpt", dir);
    c.setAccountScope(SCOPE);
    c.merge([{ id: "a", title: "Alpha", updatedAt: 1000, seenAt: Date.now() }]);
    c.merge([{ id: "a", title: "Alpha v2", updatedAt: 2000, seenAt: Date.now() }, { id: "b", title: "Beta", updatedAt: 1500, seenAt: Date.now() }]);
    expect(c.size).toBe(2);
    const list = c.list();
    expect(list[0].id).toBe("a");
    expect(list[0].title).toBe("Alpha v2");
    expect(list[1].id).toBe("b");
  });

  it("mergeFull replaces the inventory and stamps scannedAt", () => {
    const c = new BrowserChatInventoryCache("chatgpt", dir);
    c.setAccountScope(SCOPE);
    c.merge([{ id: "a", title: "Alpha", seenAt: 1 }, { id: "b", title: "Beta", seenAt: 1 }]);
    c.mergeFull([{ id: "a", title: "Alpha", seenAt: 1 }, { id: "c", title: "Gamma", seenAt: 1 }]);
    expect(c.size).toBe(2);
    expect(c.list().map(e => e.id).sort()).toEqual(["a", "c"]);
    expect(c.lastScannedAt).toBeGreaterThan(0);
  });

  it("persists and reloads across instances", async () => {
    const c1 = new BrowserChatInventoryCache("chatgpt", dir);
    c1.setAccountScope(SCOPE);
    c1.mergeFull([{ id: "a", title: "Alpha", updatedAt: 5000, seenAt: 1 }, { id: "b", title: "Beta", updatedAt: 4000, seenAt: 1 }]);
    await c1.save();
    expect(existsSync(join(dir, "chatgpt", SCOPE, "inventory.json"))).toBe(true);

    const c2 = new BrowserChatInventoryCache("chatgpt", dir);
    c2.setAccountScope(SCOPE);
    await c2.load();
    expect(c2.size).toBe(2);
    expect(c2.lastScannedAt).toBeGreaterThan(0);
    expect(c2.list().map(e => e.title).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("refuses an unverified scope", () => {
    const c = new BrowserChatInventoryCache("chatgpt", dir);
    c.setAccountScope("not-a-hex");
    expect(c.available).toBe(false);
  });
});
