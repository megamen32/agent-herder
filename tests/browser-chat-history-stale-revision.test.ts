import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserChatHistoryCache } from "../src/adapters/browser-chat-history-cache.js";
import type { SessionMessageView } from "../src/types/index.js";

const ACCOUNT = "a".repeat(64);
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function dir() { const root = await mkdtemp(join(tmpdir(), "browser-history-cache-")); roots.push(root); return root; }

const oldMessages: SessionMessageView[] = [
  { id: "m1", role: "user", text: "Старое сообщение 1", parts: [{ type: "text", text: "Старое сообщение 1" }] },
  { id: "m2", role: "assistant", text: "Старый ответ", parts: [{ type: "text", text: "Старый ответ" }] },
];
const newMessages: SessionMessageView[] = [
  ...oldMessages,
  { id: "m3", role: "user", text: "Новый turn пользователя", parts: [{ type: "text", text: "Новый turn пользователя" }] },
  { id: "m4", role: "assistant", text: "Новый ответ автопилота", parts: [{ type: "text", text: "Новый ответ автопилота" }] },
];

describe("stale-revision refresh regression (zai autopilot fingerprint)", () => {
  it("refreshes the cached history when a later inventory reports a newer remote revision", async () => {
    const root = await dir();
    const id = "route:6aa1dd0e-4f11-4fc9-a633-94fa95566c2f";
    let fetched: SessionMessageView[] = oldMessages;
    let fetchCount = 0;
    const cache = new BrowserChatHistoryCache("zai", async () => {
      fetchCount += 1;
      return fetched;
    }, root);
    cache.setAccountScope(ACCOUNT);

    // Day 1: the inventory reports revision R1; the cache warms with oldMessages.
    cache.prewarm([{ id, revision: "2026-11-01T11:44:04.000Z" }]);
    await vi.waitFor(async () => {
      expect(await cache.messages(id)).toEqual(oldMessages);
    }, { timeout: 20_000 });
    expect(fetchCount).toBe(1);

    // Day 2: the remote chat advanced (new turn). The inventory reports revision R2
    // and the site now returns newMessages for the same conversation.
    fetched = newMessages;
    cache.prewarm([{ id, revision: "2026-11-02T21:52:33.000Z" }]);

    // The next history read must observe the newer revision and re-fetch, so the
    // browser-turn-observer fingerprint of the newest turn changes and autopilot
    // judging is not permanently deduplicated on the stale turn identity.
    const before = await cache.messages(id);
    await vi.waitFor(async () => {
      const current = await cache.messages(id);
      if (current === before) throw new Error("cache still holds the stale turn identity");
      expect(current).toEqual(newMessages);
    }, { timeout: 40_000 });
    expect(fetchCount).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it("the saved cache file carries the newest revision after a revision advance", async () => {
    const root = await dir();
    const id = "route:6aa1dd0e-4f11-4fc9-a633-94fa95566c2f";
    let fetched: SessionMessageView[] = oldMessages;
    const cache = new BrowserChatHistoryCache("zai", async () => fetched, root);
    cache.setAccountScope(ACCOUNT);
    cache.prewarm([{ id, revision: "2026-11-01T11:44:04.000Z" }]);
    await vi.waitFor(async () => {
      expect(await cache.messages(id)).toEqual(oldMessages);
    }, { timeout: 20_000 });
    fetched = newMessages;
    cache.prewarm([{ id, revision: "2026-11-02T21:52:33.000Z" }]);
    await cache.messages(id);
    await vi.waitFor(async () => {
      const { createHash } = await import("node:crypto");
      const file = join(root, "zai", ACCOUNT, createHash("sha256").update(id).digest("hex") + ".json.gz");
      const raw = JSON.parse(gunzipSync(await readFile(file)).toString("utf8"));
      expect(raw.revision).toBe("2026-11-02T21:52:33.000Z");
      expect(raw.messages).toEqual(newMessages);
    }, { timeout: 40_000 });
  }, 120_000);
});
