import { describe, expect, it } from "vitest";
import { ChatGptAdapter, CHATGPT_HARNESS_CWD } from "../src/adapters/chatgpt.js";
import type { ChatGptHarnessChat, ChatGptHarnessDriver } from "../src/cdp-chat.js";

class FakeDriver implements ChatGptHarnessDriver {
  sends: Array<{ chatId: string; text: string; waitForCompletion?: boolean }> = [];
  created: Array<{ title?: string }> = [];
  models: string[] = ["Medium", "Power"];
  constructor(readonly chats: ChatGptHarnessChat[]) {}
  async listChats(): Promise<readonly ChatGptHarnessChat[]> { return this.chats; }
  async sendMessage(input: { chatId: string; text: string; waitForCompletion?: boolean }): Promise<{ assistantText?: string }> {
    this.sends.push(input); return {};
  }
  async createChat(input: { title?: string }): Promise<ChatGptHarnessChat> {
    this.created.push(input);
    const chat: ChatGptHarnessChat = { id: "route:new", title: input.title ?? "New chat", unread: false, working: false, updatedAt: "2026-09-08T10:02:00.000Z" };
    this.chats.push(chat);
    return chat;
  }
  async listModels(): Promise<string[]> { return this.models; }
  async changeModel(input: { chatId: string; model: string }): Promise<{ ok: boolean; error?: string }> {
    return this.models.includes(input.model) ? { ok: true } : { ok: false, error: `unknown model '${input.model}'` };
  }
}

const chats: ChatGptHarnessChat[] = [
  { id: "route:abc", title: "Research", unread: false, working: false, updatedAt: "2026-09-08T10:00:00.000Z", sourceRoute: "/c/abc" },
  { id: "route:def", title: "Busy", unread: true, working: true, updatedAt: "2026-09-08T10:01:00.000Z", sourceRoute: "/c/def" },
];

describe("ChatGptAdapter", () => {
  it("maps existing chats to resumable Herder sessions", async () => {
    const adapter = new ChatGptAdapter(new FakeDriver(chats));
    const sessions = await adapter.listSessions({ cwd: CHATGPT_HARNESS_CWD });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ id: "route:abc", harness: "chatgpt", status: "idle", title: "Research", cwd: CHATGPT_HARNESS_CWD });
    expect(sessions[1]).toMatchObject({ id: "route:def", harness: "chatgpt", status: "running", title: "Busy", cwd: CHATGPT_HARNESS_CWD });
  });

  it("finds an exact named existing chat without creating one", async () => {
    const adapter = new ChatGptAdapter(new FakeDriver(chats));
    await expect(adapter.findNamedSessions("Research", CHATGPT_HARNESS_CWD)).resolves.toMatchObject([{ id: "route:abc" }]);
    await expect(adapter.findNamedSessions("Missing", CHATGPT_HARNESS_CWD)).resolves.toEqual([]);
  });

  it("maps queue to nonblocking ChatGPT delivery and sync to completion wait", async () => {
    const driver = new FakeDriver(chats); const adapter = new ChatGptAdapter(driver);
    await expect(adapter.sendMessage("route:abc", { message: "one", queue: true })).resolves.toEqual({ ok: true });
    await expect(adapter.sendMessage("route:abc", { message: "two", queue: false })).resolves.toEqual({ ok: true });
    expect(driver.sends).toEqual([
      { chatId: "route:abc", text: "one", waitForCompletion: false },
      { chatId: "route:abc", text: "two", waitForCompletion: true },
    ]);
  });

  it("treats an existing ChatGPT conversation as resumable", async () => {
    const adapter = new ChatGptAdapter(new FakeDriver(chats));
    await expect(adapter.resumeSession("route:abc")).resolves.toEqual({ ok: true, sessionId: "route:abc" });
    await expect(adapter.resumeSession("route:missing")).resolves.toMatchObject({ ok: false });
  });

  it("launches a session as a new disposable chat", async () => {
    const driver = new FakeDriver([...chats]); const adapter = new ChatGptAdapter(driver);
    const session = await adapter.createSession({ name: "repair_100", cwd: CHATGPT_HARNESS_CWD });
    expect(driver.created).toEqual([{ title: "repair_100" }]);
    expect(session).toMatchObject({ id: "route:new", harness: "chatgpt", title: "repair_100", status: "idle" });
    await expect(adapter.listSessions()).resolves.toHaveLength(3);
  });

  it("lists the models the page offers and switches one model for one chat", async () => {
    const driver = new FakeDriver(chats); const adapter = new ChatGptAdapter(driver);
    await expect(adapter.listModels()).resolves.toEqual(["Medium", "Power"]);
    await expect(adapter.changeModel("route:abc", "Power")).resolves.toEqual({ ok: true });
    await expect(adapter.changeModel("route:abc", "Ghost")).resolves.toMatchObject({ ok: false });
    expect(adapter.controlCapabilities.modelSwitch).toBe(true);
  });

  it("keeps the chats visible from any working directory", async () => {
    const adapter = new ChatGptAdapter(new FakeDriver(chats));
    await expect(adapter.listSessions({ cwd: "/srv/other" })).resolves.toHaveLength(2);
    await expect(adapter.findNamedSessions("Research", "/srv/other")).resolves.toMatchObject([{ id: "route:abc" }]);
  });
});
