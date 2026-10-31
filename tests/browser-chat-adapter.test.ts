import { describe, it, expect } from "vitest";
import { BrowserChatAdapter, type BrowserChatDriver } from "../src/adapters/browser-chat.js";

describe("BrowserChatAdapter", () => {
  it("maps browser chats into Herder sessions and sends messages independently of ChatGPT", async () => {
    const sent: string[] = [];
    const driver: BrowserChatDriver = {
      listChats: async () => [{ id: "c1", title: "Example", unread: false, working: false, updatedAt: "2026-10-31T10:00:00Z" }],
      sendMessage: async ({ text }) => { sent.push(text); return {}; },
    };
    const adapter = new BrowserChatAdapter(driver, { id: "fixture", name: "Browser fixture", harness: "chatgpt", cwd: "/tmp/browser" });
    expect((await adapter.listSessions())[0]).toMatchObject({ id: "c1", cwd: "/tmp/browser", meta: { browserProvider: "fixture" } });
    expect(await adapter.resumeSession("c1")).toMatchObject({ ok: true });
    expect(await adapter.sendMessage("c1", { message: "hello" })).toEqual({ ok: true });
    expect(sent).toEqual(["hello"]);
  });
});
