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

describe("browser session activity", () => {
  it("settles a finished chat to idle before the follow-up delivery", async () => {
    let refreshed = 0;
    let working = true;
    const driver: BrowserChatDriver = {
      listChats: async () => [{ id: "draft:c1", title: "Chat", unread: false, working,
        updatedAt: "2026-11-08T06:00:00Z" }],
      getKnownChat: () => ({ id: "draft:c1", title: "Chat", unread: false, working,
        updatedAt: "2026-11-08T06:00:00Z" }),
      refreshTurnState: async () => { refreshed++; working = false; return true; },
      sendMessage: async () => ({}),
    };
    const adapter = new BrowserChatAdapter(driver, { id: "chatgpt", name: "chatgpt", harness: "chatgpt", cwd: "/tmp/browser" });
    const session = await adapter.getSession("draft:c1");
    expect(refreshed).toBe(1);
    expect(session?.status).toBe("idle");
  });

  it("keeps the running status when the provider cannot settle the turn", async () => {
    const driver: BrowserChatDriver = {
      listChats: async () => [{ id: "c1", title: "Chat", unread: false, working: true,
        updatedAt: "2026-11-08T06:00:00Z" }],
      refreshTurnState: async () => false,
      sendMessage: async () => ({}),
    };
    const adapter = new BrowserChatAdapter(driver, { id: "chatgpt", name: "chatgpt", harness: "chatgpt", cwd: "/tmp/browser" });
    const session = await adapter.getSession("c1");
    expect(session?.status).toBe("running");
  });
});

describe("bounded read-only receipt polling", () => {
  const row = (id: string, text = "hello") => ({ id, role: "user" as const, text });

  it("re-reads the history when the provider stores the message late", async () => {
    // The provider accepts the message first and stores it a moment later.
    // A single immediate read then finds nothing and the delivery would stay
    // permanently unknown even though the message is in the conversation.
    let reads = 0;
    const driver: BrowserChatDriver = {
      listChats: async () => [],
      getMessages: async () => { reads += 1; return reads < 3 ? [] : [row("new")]; },
      sendMessage: async () => ({}),
    };
    const adapter = new BrowserChatAdapter(driver, { id: "chatgpt", name: "chatgpt", harness: "chatgpt", cwd: "/tmp/browser" });
    const result = await adapter.sendMessage("c1", { message: "hello", inputId: "request-1" });
    expect(result).toMatchObject({ ok: true, admitted: true, nativeInputMessageId: "new" });
    expect(reads).toBeGreaterThan(1);
  });

  it("keeps the outcome unknown when no read ever proves the message", async () => {
    let reads = 0;
    const driver: BrowserChatDriver = {
      listChats: async () => [],
      getMessages: async () => { reads += 1; return []; },
      sendMessage: async () => ({}),
    };
    const adapter = new BrowserChatAdapter(driver, { id: "chatgpt", name: "chatgpt", harness: "chatgpt", cwd: "/tmp/browser" });
    const result = await adapter.sendMessage("c1", { message: "hello", inputId: "request-1" });
    expect(result).toMatchObject({ ok: false, admissionUnknown: true, nonRetryable: true });
    expect(result.notSubmitted).not.toBe(true);
    expect(reads).toBeGreaterThan(1);
  });

  it("never repeats the send while polling for the receipt", async () => {
    let sends = 0;
    let reads = 0;
    const driver: BrowserChatDriver = {
      listChats: async () => [],
      getMessages: async () => { reads += 1; return reads < 2 ? [] : [row("new")]; },
      sendMessage: async () => { sends += 1; return {}; },
    };
    const adapter = new BrowserChatAdapter(driver, { id: "chatgpt", name: "chatgpt", harness: "chatgpt", cwd: "/tmp/browser" });
    await adapter.sendMessage("c1", { message: "hello", inputId: "request-1" });
    expect(sends).toBe(1);
  });
});
