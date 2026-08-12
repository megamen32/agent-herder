import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentHerderMcpServer } from "../src/index.js";
import type { ChatRecord, CdpChatDriver, CdpChatPage, MessageRecord, PageIdentity } from "../src/cdp-chat.js";

const connected: Array<{ client: Client; server: { close(): Promise<void> } }> = [];

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
  return { async acquirePage() { return page; } };
}

async function connect(driver: CdpChatDriver): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createAgentHerderMcpServer(driver);
  const client = new Client({ name: "cdp-chat-agent-herder-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connected.push({ client, server });
  return client;
}

describe("Agent Herder CDP chat capability", () => {
  it("registers namespaced tools alongside the existing coding-agent send_message", async () => {
    const client = await connect(fakeDriver());
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    expect(names).toContain("send_message");
    expect(names).toEqual(expect.arrayContaining([
      "cdp_new_chat",
      "cdp_list_chats",
      "cdp_search_chat",
      "cdp_export_chat",
      "cdp_send_message",
      "cdp_edit_message",
      "cdp_download_media",
    ]));
    expect(names.filter((name) => name === "send_message")).toHaveLength(1);
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
});
