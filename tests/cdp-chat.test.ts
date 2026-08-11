import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CdpChatClient,
  type ChatRecord,
  type CdpChatDriver,
  type CdpChatPage,
  type DownloadedMedia,
  type MessageRecord,
  type PageIdentity,
} from "../src/cdp-chat.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function identity(leaseRef = "lease-1"): PageIdentity {
  return {
    origin: "https://chat.example.test",
    accountRef: "account-opaque-1",
    pageRef: "page-opaque-1",
    leaseRef,
  };
}

function message(id: string, text: string, media: MessageRecord["media"] = []): MessageRecord {
  return { id, role: "assistant", text, version: 1, createdAt: "2026-08-11T12:00:00.000Z", media };
}

function chat(id: string, title: string, overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    id,
    title,
    unread: false,
    working: false,
    updatedAt: "2026-08-11T12:00:00.000Z",
    messages: [],
    ...overrides,
  };
}

class FakePage implements CdpChatPage {
  readonly identityState: PageIdentity = identity();
  readonly chats: ChatRecord[] = [
    chat("production-chat", "Existing production", {
      unread: true,
      messages: [message("production-message", "do not target this")],
    }),
    chat("working-chat", "Existing working", { working: true }),
  ];
  sendCalls = 0;
  editCalls = 0;
  identityOverride: PageIdentity | undefined;

  async identity(): Promise<PageIdentity> {
    return this.identityOverride ?? this.identityState;
  }

  async snapshot() {
    return { chats: structuredClone(this.chats) };
  }

  async createChat(input: { title?: string }): Promise<ChatRecord> {
    const fixture = chat("fixture-chat", input.title ?? "Disposable fixture", {
      updatedAt: "2026-08-11T12:01:00.000Z",
      messages: [
        message("fixture-message", "fixture body with enough text to exercise export bounds ".repeat(200), [
          { id: "fixture-media", filename: "fixture.png", mimeType: "image/png", size: 4 },
        ]),
      ],
    });
    this.chats.push(fixture);
    return structuredClone(fixture);
  }

  async sendMessage(input: { chatId: string; text: string }): Promise<MessageRecord> {
    this.sendCalls += 1;
    const target = this.chats.find((entry) => entry.id === input.chatId);
    if (!target) throw new Error("chat not found");
    const result = message(`sent-${this.sendCalls}`, input.text);
    target.messages.push(result);
    return structuredClone(result);
  }

  async editMessage(input: { chatId: string; messageId: string; text: string; expectedVersion?: number; expectedText?: string }): Promise<MessageRecord> {
    this.editCalls += 1;
    const target = this.chats.find((entry) => entry.id === input.chatId)?.messages.find((entry) => entry.id === input.messageId);
    if (!target) throw new Error("message not found");
    if (input.expectedVersion !== undefined && target.version !== input.expectedVersion) throw new Error("version mismatch");
    if (input.expectedText !== undefined && target.text !== input.expectedText) throw new Error("text mismatch");
    target.text = input.text;
    target.version += 1;
    return structuredClone(target);
  }

  async downloadMedia(input: { chatId: string; messageId: string; mediaId: string }): Promise<DownloadedMedia> {
    if (input.chatId !== "fixture-chat" || input.messageId !== "fixture-message" || input.mediaId !== "fixture-media") {
      throw new Error("media not found");
    }
    return { bytes: new Uint8Array([1, 2, 3, 4]), filename: "fixture.png", mimeType: "image/png" };
  }
}

class ExistingIdPage extends FakePage {
  override async createChat(_input: { title?: string }): Promise<ChatRecord> {
    const existing = this.chats.find((entry) => entry.id === "production-chat");
    if (!existing) throw new Error("production fixture row missing");
    return structuredClone(existing);
  }
}

class DeferredCreatePage extends FakePage {
  createCalls = 0;
  readonly firstCreateEntered: Promise<void>;
  private resolveFirstCreateEntered!: () => void;
  private readonly firstCreateRelease: Promise<void>;
  private releaseFirstCreate!: () => void;

  constructor() {
    super();
    this.firstCreateEntered = new Promise<void>((resolve) => {
      this.resolveFirstCreateEntered = resolve;
    });
    this.firstCreateRelease = new Promise<void>((resolve) => {
      this.releaseFirstCreate = resolve;
    });
  }

  releaseCreate(): void {
    this.releaseFirstCreate();
  }

  override async createChat(input: { title?: string }): Promise<ChatRecord> {
    this.createCalls += 1;
    if (this.createCalls === 1) {
      this.resolveFirstCreateEntered();
      await this.firstCreateRelease;
    }
    return super.createChat(input);
  }
}

function driverFor(page: FakePage): CdpChatDriver {
  return { async acquirePage() { return page; } };
}

async function createFixture(options: ConstructorParameters<typeof CdpChatClient>[1] = {}) {
  const page = new FakePage();
  const root = await mkdtemp(join(tmpdir(), "cdp-chat-test-"));
  roots.push(root);
  const client = new CdpChatClient(driverFor(page), { mediaRoot: root, ...options });
  const fixture = await client.newChat({ confirmation: "NEW_CHAT", idempotencyKey: "new-fixture", title: "Disposable fixture" });
  const exported = await client.exportChat({ chatRef: fixture.chatRef, format: "json" });
  return { client, page, root, fixture, exported };
}

describe("standalone CDP website chat MCP", () => {
  it("creates one bound fixture and implements unread, working, recent, and search semantics", async () => {
    const { client, fixture } = await createFixture();
    const unread = await client.listChats({ view: "unread", limit: 10 });
    const working = await client.listChats({ view: "working", limit: 10 });
    const recent = await client.listChats({ view: "recent", limit: 10 });
    const search = await client.searchChat({ query: "fixture body", limit: 10 });

    expect(fixture.receipt).toMatchObject({ origin: "https://chat.example.test", accountRef: "account-opaque-1" });
    expect(unread.chats.map((entry) => entry.title)).toContain("Existing production");
    expect(working.chats.map((entry) => entry.title)).toContain("Existing working");
    expect(recent.chats.map((entry) => entry.title)).toContain("Disposable fixture");
    expect(search.chats).toHaveLength(1);
    expect(search.chats[0].matchedMessageRefs).toHaveLength(1);
  });

  it("rejects unbound production targets and detects a lost page lease", async () => {
    const { client, page } = await createFixture();
    const production = (await client.listChats({ view: "unread" })).chats.find((entry) => entry.title === "Existing production");
    if (!production) throw new Error("production fixture row missing");
    await expect(client.exportChat({ chatRef: production.chatRef, format: "json" })).rejects.toThrow(/fixture/i);

    page.identityOverride = identity("different-lease");
    await expect(client.listChats({ view: "recent" })).rejects.toThrow(/lease|ownership/i);
  });

  it("rejects a createChat result that was already visible and never binds production as fixture", async () => {
    const page = new ExistingIdPage();
    const root = await mkdtemp(join(tmpdir(), "cdp-chat-test-"));
    roots.push(root);
    const client = new CdpChatClient(driverFor(page), { mediaRoot: root });

    await expect(client.newChat({ confirmation: "NEW_CHAT", idempotencyKey: "existing-id", title: "Disposable fixture" })).rejects.toThrow(/new|existing|fixture/i);

    const production = (await client.listChats({ view: "unread" })).chats.find((entry) => entry.title === "Existing production");
    if (!production) throw new Error("production fixture row missing");
    expect(production.fixtureBound).toBe(false);
    await expect(client.exportChat({ chatRef: production.chatRef, format: "json" })).rejects.toThrow(/fixture/i);
  });

  it("rejects a concurrent new_chat before creating a second fixture", async () => {
    const page = new DeferredCreatePage();
    const root = await mkdtemp(join(tmpdir(), "cdp-chat-test-"));
    roots.push(root);
    const client = new CdpChatClient(driverFor(page), { mediaRoot: root });

    const first = client.newChat({ confirmation: "NEW_CHAT", idempotencyKey: "concurrent-first", title: "First fixture" });
    await page.firstCreateEntered;
    const second = client.newChat({ confirmation: "NEW_CHAT", idempotencyKey: "concurrent-second", title: "Second fixture" });

    try {
      await expect(second).rejects.toMatchObject({ code: "new_chat_in_progress" });
    } finally {
      page.releaseCreate();
    }

    const fixture = await first;
    expect(page.createCalls).toBe(1);
    expect(fixture.fixture).toBe(true);
    await expect(client.exportChat({ chatRef: fixture.chatRef, format: "json" })).resolves.toMatchObject({ chatRef: fixture.chatRef });
  });

  it("bounds export and downloads only bound allowlisted media into the confined root", async () => {
    const { client, root, fixture } = await createFixture({ maxExportBytes: 1024 });
    const exported = await client.exportChat({ chatRef: fixture.chatRef, format: "json", maxMessages: 1 });
    expect(Buffer.byteLength(exported.content, "utf8")).toBeLessThanOrEqual(1024);
    expect(exported.truncated).toBe(true);
    const messageRef = exported.messages[0]?.messageRef;
    const mediaRef = exported.messages[0]?.media[0]?.mediaRef;
    if (!messageRef || !mediaRef) throw new Error("export did not expose bounded opaque media refs");
    const downloaded = await client.downloadMedia({ chatRef: fixture.chatRef, messageRef, mediaRef });
    expect(downloaded.path.startsWith(root)).toBe(true);
    expect(await readFile(downloaded.path)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("does not create a rejected traversal output directory", async () => {
    const { client, root, fixture, exported } = await createFixture();
    const messageRef = exported.messages[0]?.messageRef;
    const mediaRef = exported.messages[0]?.media[0]?.mediaRef;
    if (!messageRef || !mediaRef) throw new Error("export did not expose bounded opaque media refs");
    const outside = `${root}-outside`;
    roots.push(outside);
    await rm(outside, { recursive: true, force: true });

    await expect(client.downloadMedia({
      chatRef: fixture.chatRef,
      messageRef,
      mediaRef,
      outputDir: outside,
    })).rejects.toMatchObject({ code: "media_path_escape" });
    await expect(access(outside)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires an exact one-shot TTL gate bound to the operation and payload", async () => {
    let now = 1_000;
    const { client, page, fixture, exported } = await createFixture({ now: () => now, writeGateTtlMs: 100 });
    const messageRef = exported.messages[0]?.messageRef;
    if (!messageRef) throw new Error("fixture message ref missing");

    await expect(client.sendMessage({ chatRef: fixture.chatRef, text: "unsafe", confirmation: "", idempotencyKey: "send-1" })).rejects.toThrow(/confirmation/i);
    await expect(client.sendMessage({ chatRef: fixture.chatRef, text: "safe", confirmation: "SEND_MESSAGE", idempotencyKey: "send-1" })).resolves.toMatchObject({ message: { text: "safe" } });
    expect(page.sendCalls).toBe(1);
    await expect(client.sendMessage({ chatRef: fixture.chatRef, text: "safe", confirmation: "SEND_MESSAGE", idempotencyKey: "send-1" })).rejects.toThrow(/used|consumed|duplicate/i);
    await expect(client.sendMessage({ chatRef: fixture.chatRef, text: "different", confirmation: "SEND_MESSAGE", idempotencyKey: "send-1" })).rejects.toThrow(/idempotency|payload/i);

    await expect(client.editMessage({ chatRef: fixture.chatRef, messageRef, text: "edited", confirmation: "EDIT_MESSAGE", idempotencyKey: "edit-1", expectedVersion: 1 })).resolves.toMatchObject({ message: { text: "edited", version: 2 } });
    await expect(client.editMessage({ chatRef: fixture.chatRef, messageRef, text: "edited again", confirmation: "EDIT_MESSAGE", idempotencyKey: "edit-1", expectedVersion: 2 })).rejects.toThrow(/used|duplicate|idempotency|payload/i);
    now = 1_200;
    await expect(client.editMessage({ chatRef: fixture.chatRef, messageRef, text: "expired", confirmation: "EDIT_MESSAGE", idempotencyKey: "edit-1", expectedVersion: 2 })).rejects.toThrow(/expired|TTL/i);
    expect(page.editCalls).toBe(1);
  });

  it("projects write results without exposing raw page message or media IDs", async () => {
    const { client, fixture, exported } = await createFixture();
    const fixtureMessage = exported.messages[0];
    if (!fixtureMessage) throw new Error("fixture message missing");

    const sent = await client.sendMessage({
      chatRef: fixture.chatRef,
      text: "public result",
      confirmation: "SEND_MESSAGE",
      idempotencyKey: "send-public-result",
    });
    const edited = await client.editMessage({
      chatRef: fixture.chatRef,
      messageRef: fixtureMessage.messageRef,
      text: "public edit result",
      confirmation: "EDIT_MESSAGE",
      idempotencyKey: "edit-public-result",
      expectedVersion: 1,
    });

    const sentJson = JSON.stringify(sent);
    const editedJson = JSON.stringify(edited);
    expect(sentJson).not.toContain("sent-1");
    expect(editedJson).not.toContain("fixture-message");
    expect(editedJson).not.toContain("fixture-media");
    expect(sent.message).toMatchObject({
      messageRef: expect.any(String),
      text: "public result",
      media: [],
    });
    expect(edited.message).toMatchObject({
      messageRef: fixtureMessage.messageRef,
      text: "public edit result",
      media: [{ mediaRef: fixtureMessage.media[0]?.mediaRef }],
    });
    expect(sent.message).not.toHaveProperty("id");
    expect(edited.message).not.toHaveProperty("id");
    expect(edited.message.media[0]).not.toHaveProperty("id");
  });
});
