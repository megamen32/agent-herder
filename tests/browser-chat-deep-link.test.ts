import { describe, it, expect } from "vitest";
import { BrowserChatAdapter } from "../src/adapters/browser-chat.js";
import type { BrowserChat, BrowserChatDriver, BrowserChatProvider } from "../src/adapters/browser-chat.js";
import type { AgentSession } from "../src/types/index.js";

const PROVIDER: BrowserChatProvider = {
  id: "zai",
  name: "Z.ai",
  harness: "zai",
  cwd: "/tmp/browser-zai",
};

function makeChat(id: string, title: string): BrowserChat {
  return { id, title, unread: false, working: false, updatedAt: "2026-11-02T10:00:00Z" };
}

function adapterWith(driver: Partial<BrowserChatDriver>): BrowserChatAdapter {
  const full: BrowserChatDriver = {
    listChats: async () => [],
    sendMessage: async () => ({}),
    browserFeatures: {
      nativeConversationIds: true,
      queueAfterGeneration: true,
      chatCreation: false,
      accountArchiveViaCdp: false,
    },
    ...driver,
  } as BrowserChatDriver;
  return new BrowserChatAdapter(full, PROVIDER, PROVIDER.cwd, true);
}

describe("BrowserChatAdapter deep-link routing", () => {
  it("getSession resolves a raw native id from the inventory and preserves the caller form", async () => {
    // The ZAI driver keys deep-link chats by `route:<uuid>` in listChats;
    // a raw native id from an HTTP caller is normalized to that form.
    const chat = makeChat("route:6aa1dd0e-4f11-4fc9-a633-94fa95566c2f", "Problems with Herder Agent Delivery");
    const adapter = adapterWith({ listChats: async () => [chat] });
    await adapter.init();
    const session = await adapter.getSession("6aa1dd0e-4f11-4fc9-a633-94fa95566c2f");
    expect(session).not.toBeNull();
    expect(session!.id).toBe("6aa1dd0e-4f11-4fc9-a633-94fa95566c2f");
    expect(session!.title).toBe("Problems with Herder Agent Delivery");
  });

  it("getSession still accepts the scoped form (no route: marker) and preserves it in the returned id", async () => {
    const chat = makeChat("abc-123", "Scoped chat");
    const adapter = adapterWith({ listChats: async () => [chat] });
    await adapter.init();
    const scoped = "zai::abc-123";
    const session = await adapter.getSession(scoped);
    expect(session).not.toBeNull();
    expect(session!.id).toBe(scoped);
  });

  it("getSession falls back to driver.getChat for a native id not in the inventory", async () => {
    // The driver stores deep-link chats under the `route:<uuid>` form, so
    // getChat receives the normalized id.
    const chat = makeChat("route:unknown-uuid", "Deep-linked chat");
    let getChatCalls = 0;
    let seenId = "";
    const adapter = adapterWith({
      listChats: async () => [],
      getChat: async (id: string) => { getChatCalls++; seenId = id; return chat; },
    });
    const session = await adapter.getSession("unknown-uuid");
    expect(getChatCalls).toBe(1);
    expect(seenId).toBe("route:unknown-uuid");
    expect(session).not.toBeNull();
    expect(session!.id).toBe("unknown-uuid");
    expect(session!.title).toBe("Deep-linked chat");
  });

  it("sendMessage and getSessionMessages accept a raw native id (no 'another provider' throw)", async () => {
    const chat = makeChat("native-1", "Send target");
    let sentText: string | undefined;
    const adapter = adapterWith({
      listChats: async () => [chat],
      sendMessage: async ({ chatId, text }) => { sentText = text; return {} as never; },
      getMessages: async () => [{ id: "m1", role: "user", text: "hi" }],
    });
    await adapter.init();
    const sendResult = await adapter.sendMessage("native-1", { message: "hello" } as never);
    expect(sendResult.ok).toBe(true);
    expect(sentText).toBe("hello");
    const messages = await adapter.getSessionMessages?.("native-1", 10);
    expect(messages).not.toBeNull();
    expect(messages!.length).toBeGreaterThan(0);
  });

  it("rejects an id scoped for a different provider when the scoped prefix is present", async () => {
    const adapter = adapterWith({});
    // The scoped prefix is present but for a different provider: this must
    // still be treated as "another provider" so cross-provider leaks cannot
    // happen via scoped ids crafted by a malicious caller.
    await expect(adapter.getSession("chatgpt::route%3Aabc").catch((e) => { throw e; })).rejects.toThrow(/Browser session belongs to another provider/);
  });
});
