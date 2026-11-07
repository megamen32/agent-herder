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

describe("browser native admission correlation", () => {
  const row = (id: string, text = "hello") => ({ id, role: "user" as const, text });
  function fixture(before: ReturnType<typeof row>[], after: ReturnType<typeof row>[] | Error) {
    let sent = 0;
    const driver: BrowserChatDriver = {
      listChats: async () => [],
      getMessages: async () => { if (!sent) return before; if (after instanceof Error) throw after; return after; },
      sendMessage: async () => { sent++; return {}; },
    };
    const adapter = new BrowserChatAdapter(driver, { id: "fixture", name: "fixture", harness: "chatgpt", cwd: "/tmp/browser" });
    return { adapter, sent: () => sent };
  }
  it("returns the new native user ID, never an older identical prompt", async () => {
    const f = fixture([row("old")], [row("old"), row("new")]);
    expect(await f.adapter.sendMessage("c1", { message: "hello", inputId: "request-1" }))
      .toMatchObject({ ok: true, admitted: true, nativeInputMessageId: "new", inputId: "request-1" });
    expect(f.sent()).toBe(1);
  });
  it.each([[[row("old")]], [[row("new-a"), row("new-b")]], [new Error("read failed")]])(
    "keeps missing, ambiguous or failed post-send evidence unknown", async (after) => {
      const f = fixture([row("old")], after);
      const result = await f.adapter.sendMessage("c1", { message: "hello", inputId: "request-1" });
      expect(result).toMatchObject({ ok: false, admissionUnknown: true, nonRetryable: true });
      expect(result.notSubmitted).not.toBe(true);
      expect(f.sent()).toBe(1);
    });
});
