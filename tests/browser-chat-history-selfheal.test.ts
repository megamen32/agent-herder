import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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
  { id: "m1", role: "user", text: "turn один", parts: [{ type: "text", text: "turn один" }] },
  { id: "m2", role: "assistant", text: "ответ один", parts: [{ type: "text", text: "ответ один" }] },
];
const newMessages: SessionMessageView[] = [
  ...oldMessages,
  { id: "m3", role: "user", text: "turn два", parts: [{ type: "text", text: "turn два" }] },
];

/**
 * Regression: AGENT_HERDER_BROWSER_CHAT_PREWARM_LIMIT=0 ("emergency pause")
 * silently stops ALL cache refreshes: prewarm() returns early, so the
 * revisions map stays empty, so messages() never enqueues a refresh, so the
 * browser-turn-observer fingerprint of every later turn is IDENTICAL to the
 * first one, so BackgroundAutopilotStop deduplicates every new turn as the
 * already-judged identity and the autopilot never continues the chat.
 *
 * A read must not rely on prewarm having run: a cache whose saved entry is
 * stale by wall-clock time has to re-fetch on read, with or without revision
 * metadata and with prewarm fully disabled.
 */
describe("self-healing stale cache read (prewarm disabled)", () => {
  it("re-fetches a wall-clock stale cache on read even with prewarm disabled and no revisions", async () => {
    const root = await dir();
    vi.stubEnv("AGENT_HERDER_BROWSER_CHAT_PREWARM_LIMIT", "0");
    const id = "route:6aa1dd0e-4f11-4fc9-a633-94fa95566c2f";
    let fetched: SessionMessageView[] = oldMessages;
    let fetchCount = 0;
    const cache = new BrowserChatHistoryCache("zai", async () => {
      fetchCount += 1;
      return fetched;
    }, root);
    cache.setAccountScope(ACCOUNT);

    // Prime the cache once (the cold-miss path performs the initial fetch).
    await vi.waitFor(async () => {
      expect(await cache.messages(id)).toEqual(oldMessages);
    }, { timeout: 20_000 });
    expect(fetchCount).toBe(1);

    // Turn two happened; the site now returns newMessages.
    fetched = newMessages;
    // NO prewarm call at all: the emergency pause left revisions empty.

    // Simulate the passage of wall-clock time: the saved entry is now hours old.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 6 * 60 * 60 * 1000));

    const staleRead = await cache.messages(id);
    expect(staleRead).toEqual(oldMessages); // fast path still serves the saved copy

    // The stale read must schedule a background re-fetch even without revisions.
    vi.useRealTimers();
    await vi.waitFor(async () => {
      expect(await cache.messages(id)).toEqual(newMessages);
    }, { timeout: 30_000 });
    expect(fetchCount).toBeGreaterThanOrEqual(2);
  }, 90_000);
});
