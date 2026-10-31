import { describe, expect, it } from "vitest";
import { BrowserChatRouter } from "../src/adapters/browser-chat-router.js";
import { BrowserChatAdapter, type BrowserChatDriver } from "../src/adapters/browser-chat.js";

function fake(name: string, sends: string[]): BrowserChatDriver {
  return {
    listChats: async () => [{ id: "c/shared:1", title: name, unread: false, working: false, updatedAt: "2026-10-31T10:00:00Z" }],
    sendMessage: async ({ chatId, text }) => { sends.push(`${chatId}:${text}`); return {}; },
    listModels: async () => ["Medium"],
    changeModel: async ({ chatId, model }) => ({ ok: chatId === "c/shared:1" && model === "Medium" }),
  };
}

describe("BrowserChatRouter", () => {
  it("isolates identical native chat IDs between independent provider accounts", async () => {
    const zai: string[] = []; const deepseek: string[] = [];
    const router = new BrowserChatRouter([
      { id: "zai", name: "ZAI", cwd: "/browser/zai", driver: fake("ZAI chat", zai) },
      { id: "deepseek", name: "DeepSeek", cwd: "/browser/deepseek", driver: fake("DeepSeek chat", deepseek) },
    ]);
    const adapter = new BrowserChatAdapter(router, { id: "browser", name: "Browser chats", harness: "chatgpt", cwd: "/browser" });
    const chats = await adapter.listSessions();
    expect(chats).toHaveLength(2);
    expect(chats.map(c => c.id)).toEqual(["zai::c%2Fshared%3A1", "deepseek::c%2Fshared%3A1"]);
    expect(chats.map(c => c.meta?.browserProvider)).toEqual(["zai", "deepseek"]);
    expect(chats.map(c => c.cwd)).toEqual(["/browser/zai", "/browser/deepseek"]);
    expect((await adapter.getSession("deepseek::c%2Fshared%3A1"))?.title).toBe("DeepSeek chat");
    expect(await adapter.sendMessage(chats[0]!.id, { message: "test", queue: true })).toEqual({ ok: true });
    expect(zai).toEqual(["c/shared:1:test"]);
    expect(deepseek).toEqual([]);
    expect((await adapter.sendMessage("unknown::c", { message: "wrong" })).ok).toBe(false);
    expect(await router.listModels()).toEqual(["zai::Medium", "deepseek::Medium"]);
    expect(await router.changeModel({ chatId: chats[0]!.id, model: "deepseek::Medium" })).toMatchObject({ ok: false });
    expect(await router.changeModel({ chatId: chats[0]!.id, model: "zai::Medium" })).toMatchObject({ ok: true });
  });

  it("keeps a healthy browser provider available when another is down", async () => {
    const down: BrowserChatDriver = { listChats: async () => { throw new Error("unavailable"); }, sendMessage: async () => ({}) };
    const router = new BrowserChatRouter([
      { id: "zai", name: "ZAI", cwd: "/browser/zai", driver: down },
      { id: "deepseek", name: "DeepSeek", cwd: "/browser/deepseek", driver: fake("DeepSeek", []) },
    ]);
    expect(await router.listChats()).toHaveLength(1);
    expect(router.providerStates()).toEqual([
      { id: "zai", available: false, error: "unavailable" },
      { id: "deepseek", available: true },
    ]);
    await expect(router.getChat("zai::c")).rejects.toThrow("unavailable");
  });

  it("never accepts ambiguous provider names or silently falls back to another provider", async () => {
    const provider = { id: "zai", name: "ZAI", cwd: "/browser/zai", driver: fake("chat", []) };
    expect(() => new BrowserChatRouter([provider, provider])).toThrow(/Duplicate/);
    expect(() => new BrowserChatRouter([{ ...provider, id: "bad::id" }])).toThrow(/Invalid/);
    const router = new BrowserChatRouter([provider]);
    await expect(router.sendMessage({ chatId: "c/shared:1", text: "x" })).rejects.toThrow(/provider-scoped/);
  });
});
