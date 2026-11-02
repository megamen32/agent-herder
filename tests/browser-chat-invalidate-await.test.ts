
import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserChatAdapter } from "../src/adapters/browser-chat.js";
import type { BrowserChat, BrowserChatDriver } from "../src/adapters/browser-chat.js";
import type { SessionMessageView } from "../src/types/index.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });

describe("invalidateHistory awaits the fresh read (turn fingerprint freshness)", () => {
  it("returns NEW messages right after invalidateHistory, not the stale copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "browser-history-cache-")); roots.push(root);
    vi.stubEnv("AGENT_HERDER_BROWSER_CHAT_CACHE_ROOT", root);
    const id = "route:6aa1dd0e-4f11-4fc9-a633-94fa95566c2f";
    let served: SessionMessageView[] = [
      { id: "m1", role: "user", text: "turn один", parts: [{ type: "text", text: "turn один" }] },
    ];
    const driver: BrowserChatDriver = {
      listChats: async () => [{ id, title: "T", unread: false, working: false, updatedAt: "2026-11-02T21:52:33.000Z", updatedAtSemantics: "remote-update-time" } as BrowserChat],
      getMessages: async () => served,
      getAccountScope: () => "a".repeat(64),
      sendMessage: async () => ({}),
    };
    const adapter = new BrowserChatAdapter(driver, { id: "zai", name: "Z.ai", harness: "zai", cwd: "/b" }, "/b", true);
    await adapter.init();
    const scoped = "zai::" + encodeURIComponent(id);
    await vi.waitFor(async () => {
      expect(await adapter.getSessionMessages(scoped, 8)).toEqual(served);
    }, { timeout: 20_000 });

    // The turn finished: the site now serves one more message.
    served = [
      ...served,
      { id: "m2", role: "assistant", text: "новый ответ turn два", parts: [{ type: "text", text: "новый ответ turn два" }] },
    ];

    // What the observer does at the running->idle transition:
    await adapter.invalidateHistory(scoped);

    // The fingerprint read right after invalidation must see the NEW tail.
    expect(await adapter.getSessionMessages(scoped, 8)).toEqual(served);
  }, 60_000);
});
