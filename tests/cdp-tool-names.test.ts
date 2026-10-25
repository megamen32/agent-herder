import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { createAgentHerderMcpServer } from "../src/index.js";
import type { CdpChatCapabilities, CdpChatDriver, CdpChatPage } from "../src/cdp-chat.js";
import type { ChatGptHistoryArchiveDriver, ChatGptHistorySegment } from "../src/chatgpt-history-archive.js";

const ALL_ON: CdpChatCapabilities = {
  new_chat: true,
  list_chats: true,
  search_chat: true,
  export_chat: true,
  send_message: true,
  edit_message: false,
  download_media: false,
  research: false,
  search: false,
  draw: false,
};

function segment(label: string): ChatGptHistorySegment {
  return {
    capturedAt: "2026-08-12T00:00:00.000Z",
    page: { url: "https://chatgpt.com/c/history" },
    content: { label, transcript: `private ${label}` },
  };
}

const historyDriver: ChatGptHistoryArchiveDriver = {
  async listChats() {
    return [{ id: "history", title: "History canary", unread: false, working: false, updatedAt: "2026-08-12T00:00:00.000Z" }];
  },
  async openChat() { return segment("bottom"); },
  async scrollBack() { return { segment: segment("top"), atStart: true }; },
};

function driverWith(capabilities: CdpChatCapabilities, withArchive: boolean): CdpChatDriver {
  const page = {} as CdpChatPage;
  return {
    async acquirePage() { return page; },
    capabilities,
    ...(withArchive ? { historyArchiveDriver: historyDriver } : {}),
  };
}

async function connect(driver?: CdpChatDriver): Promise<{ client: Client; server: { close(): Promise<void> } }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createAgentHerderMcpServer(driver);
  const client = new Client({ name: "cdp-tool-ownership-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

async function toolNames(driver?: CdpChatDriver): Promise<string[]> {
  const { client, server } = await connect(driver);
  try {
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("the ChatGPT tools of the MCP server", () => {
  it("serves one owner per name when the live page and the archive are both present", async () => {
    const names = await toolNames(driverWith(ALL_ON, true));

    expect(names.filter((name) => name === "cdp_list_chats")).toHaveLength(1);
    expect(names.filter((name) => name === "cdp_export_chat")).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);
  });

  it("lets the local archive answer a name the live page cannot", async () => {
    const { client, server } = await connect(driverWith({ ...ALL_ON, list_chats: false, export_chat: false }, true));
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names.filter((name) => name === "cdp_list_chats")).toHaveLength(1);
      expect(names.filter((name) => name === "cdp_export_chat")).toHaveLength(1);
      expect(names).toContain("cdp_export_visible_chats");

      const listed = await client.callTool({ name: "cdp_list_chats", arguments: { view: "recent" } });
      const body = JSON.parse(String(listed.content[0]?.type === "text" ? listed.content[0].text : "{}")) as { chats: Array<{ chatRef: string }> };
      expect(body.chats).toHaveLength(1);
      expect(body.chats[0]?.chatRef).toBeTruthy();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("registers no ChatGPT tool when there is no driver at all", async () => {
    const names = await toolNames();

    expect(names).toContain("list_agents");
    expect(names).not.toContain("cdp_list_chats");
    expect(names).not.toContain("cdp_export_chat");
    expect(names).not.toContain("cdp_reconcile_visible_chats");
  });
});
