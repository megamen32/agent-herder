import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentHerderMcpServer } from "../src/index.js";
import type { ChatRecord, CdpChatDriver, CdpChatPage, MessageRecord, PageIdentity } from "../src/cdp-chat.js";
import type { ChatGptAccountExportDriver } from "../src/chatgpt-account-archive.js";
import { ChatGptHistoryArchive, type ChatGptHistoryArchiveDriver, type ChatGptHistorySegment } from "../src/chatgpt-history-archive.js";

const connected: Array<{ client: Client; server: { close(): Promise<void> } }> = [];

// Catalog contract fixtures must not inherit the host-specific production
// hide file: assert the advertised surface, not a tuned discovery set.
beforeEach(() => vi.stubEnv("AGENT_HERDER_CATALOG_POLICY_FILE", "/dev/null"));
afterEach(async () => {
  await Promise.all(connected.splice(0).map(async ({ client, server }) => {
    await client.close();
    await server.close();
  }));
});

function pageIdentity(): PageIdentity {
  return {
    origin: "https://chat.example.test",
    accountRef: "account-opaque-1",
    pageRef: "page-opaque-1",
    leaseRef: "lease-opaque-1",
  };
}

function chat(id: string, title: string): ChatRecord {
  return {
    id,
    title,
    unread: false,
    working: false,
    updatedAt: "2026-08-12T00:00:00.000Z",
    messages: [],
  };
}

class FakeCdpPage implements CdpChatPage {
  private readonly identityValue = pageIdentity();
  private readonly chats: ChatRecord[] = [chat("existing", "Existing chat")];
  private nextFixture = 0;

  async identity(): Promise<PageIdentity> {
    return this.identityValue;
  }

  async snapshot(): Promise<{ chats: ChatRecord[] }> {
    return { chats: structuredClone(this.chats) };
  }

  async createChat(input: { title?: string }): Promise<ChatRecord> {
    const fixture = chat(`fixture-${++this.nextFixture}`, input.title ?? "Disposable fixture");
    this.chats.push(fixture);
    return structuredClone(fixture);
  }

  async sendMessage(input: { chatId: string; text: string }): Promise<MessageRecord> {
    const result: MessageRecord = {
      id: `${input.chatId}-message`,
      role: "user",
      text: input.text,
      version: 1,
      createdAt: "2026-08-12T00:00:00.000Z",
      media: [],
    };
    const target = this.chats.find((entry) => entry.id === input.chatId);
    if (!target) throw new Error("chat not found");
    target.messages.push(result);
    return structuredClone(result);
  }

  async editMessage(): Promise<MessageRecord> {
    throw new Error("not used by this test");
  }

  async downloadMedia(): Promise<never> {
    throw new Error("not used by this test");
  }
}

function fakeDriver(): CdpChatDriver {
  const page = new FakeCdpPage();
  const accountExportDriver: ChatGptAccountExportDriver = {
    async requestAccountExport() {
      return { requestedAt: "2026-08-12T00:00:00.000Z", delivery: "email_or_sms", status: "requested" };
    },
  };
  return { async acquirePage() { return page; }, accountExportDriver };
}

function historyOnlyDriver(): CdpChatDriver {
  const historyArchiveDriver: ChatGptHistoryArchiveDriver = {
    async listChats() {
      return [{ id: "history", title: "History canary", unread: false, working: false, updatedAt: "2026-08-12T00:00:00.000Z" }];
    },
    async openChat() {
      return historySegment("bottom");
    },
    async scrollBack() {
      return { segment: historySegment("top"), atStart: true };
    },
  };
  return {
    async acquirePage() { return new FakeCdpPage(); },
    capabilities: {
      new_chat: false, list_chats: false, search_chat: false, export_chat: false,
      send_message: false, edit_message: false, download_media: false,
    },
    historyArchiveDriver,
  };
}

function historySegment(label: string): ChatGptHistorySegment {
  return {
    capturedAt: "2026-08-12T00:00:00.000Z",
    page: { url: "https://chatgpt.com/c/history" },
    content: { label, transcript: `private ${label}` },
  };
}

function archiveOnlyDriver(): CdpChatDriver {
  return {
    ...fakeDriver(),
    capabilities: {
      new_chat: false,
      list_chats: false,
      search_chat: false,
      export_chat: false,
      send_message: false,
      edit_message: false,
      download_media: false,
    },
  };
}

async function connect(driver: CdpChatDriver, options?: { cdpHistoryArchive?: ChatGptHistoryArchive }): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createAgentHerderMcpServer(driver, options);
  const client = new Client({ name: "cdp-chat-agent-herder-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connected.push({ client, server });
  return client;
}

describe("Agent Herder CDP chat capability", () => {
  it("advertises the original CDP operations with their handlers callable", async () => {
    const client = await connect(fakeDriver());
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["deliver", "cdp_list_chats", "cdp_edit_message", "cdp_download_media"]));
    for (const facade of ["cdp_chat", "cdp_archive", "cdp_account", "cdp_send"]) {
      expect(names).not.toContain(facade);
    }
    const listed = await client.callTool({ name: "cdp_list_chats", arguments: { view: "recent" } });
    expect(listed.isError).not.toBe(true);
    expect(names.filter((name) => name === "deliver")).toHaveLength(1);
  });

  it("does not advertise unsupported chat actions for a partial driver", async () => {
    const client = await connect(archiveOnlyDriver());
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("deliver");
    expect(names).toContain("cdp_request_account_export");
    expect(names).not.toContain("cdp_chat");
    expect(names).not.toContain("cdp_archive");
    expect(names).not.toContain("cdp_new_chat");
    await expect(client.callTool({ name: "cdp_new_chat", arguments: { confirmation: "NEW_CHAT", idempotencyKey: "absent" } }))
      .rejects.toThrow(/not found/i);
  });

  it("advertises history archive actions without fixture send", async () => {
    const client = await connect(historyOnlyDriver());
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["cdp_list_chats"]));
    expect(names).not.toContain("cdp_chat");
    expect(names).not.toContain("cdp_archive");
    expect(names).not.toContain("cdp_send_message");
    expect(names).not.toContain("cdp_new_chat");
    const listed = await client.callTool({ name: "cdp_list_chats", arguments: { view: "recent" } });
    const body = JSON.parse(String(listed.content[0]?.type === "text" ? listed.content[0].text : "{}")) as { chats: Array<{ chatRef: string }> };
    expect(body.chats).toHaveLength(1);
    expect(body.chats[0]?.chatRef).toBeTruthy();
  });

  it("keeps history bindings when an HTTP-style MCP reconnect gets the process archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-shared-history-"));
    try {
      const driver = historyOnlyDriver();
      const sharedHistory = new ChatGptHistoryArchive(driver.historyArchiveDriver!, { archiveRoot: root });
      const first = await connect(driver, { cdpHistoryArchive: sharedHistory });
      const listed = await first.callTool({ name: "cdp_list_chats", arguments: { view: "recent" } });
      const listedBody = JSON.parse(String(listed.content[0]?.type === "text" ? listed.content[0].text : "{}")) as { chats: Array<{ chatRef: string }> };

      // A second HTTP transport gets a new MCP server, but the BrowserClaw page
      // and history archive belong to the long-lived Agent Herder process.
      const second = await connect(driver, { cdpHistoryArchive: sharedHistory });

      const exported = await second.callTool({ name: "cdp_export_chat", arguments: { chatRef: listedBody.chats[0]!.chatRef, maxSegments: 2 } });
      expect(exported.isError).not.toBe(true);
      expect(JSON.parse(String(exported.content[0]?.type === "text" ? exported.content[0].text : "{}"))).toMatchObject({ status: "complete" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps fixture references isolated between MCP sessions", async () => {
    const driver = fakeDriver();
    const first = await connect(driver);
    const second = await connect(driver);

    const created = await first.callTool({
      name: "cdp_new_chat",
      arguments: { confirmation: "NEW_CHAT", idempotencyKey: "fixture-1", title: "Session one" },
    });
    const fixture = JSON.parse(String(created.content[0]?.type === "text" ? created.content[0].text : "{}")) as { chatRef: string };
    expect(fixture.chatRef).toMatch(/^cdpchat:v1:chat:/);

    const rejected = await second.callTool({
      name: "cdp_export_chat",
      arguments: { chatRef: fixture.chatRef, format: "json" },
    });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected)).toMatch(/invalid_chat_ref|unknown|page lease/i);
  });

  it("starts the Agent Herder MCP server without the live BrowserClaw tools when the adapter is unavailable", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createAgentHerderMcpServer();
    const client = new Client({ name: "agent-herder-no-cdp-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    connected.push({ client, server });

    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("list_agents");
    expect(names).not.toContain("cdp_chat");
    expect(names).not.toContain("cdp_archive");
    expect(names).not.toContain("cdp_reconcile_visible_chats");
  });
});
