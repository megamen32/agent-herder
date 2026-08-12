#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";
import {
  CdpChatClient,
  type CdpChatDriver,
  type EditMessageInput,
  type ExportChatInput,
  type ListChatsInput,
  type NewChatInput,
  type SearchChatInput,
  type SendMessageInput,
  type DownloadMediaInput,
} from "./cdp-chat.js";
import {
  ChatGptAccountArchive,
  type ImportAccountExportInput,
  type RequestAccountExportInput,
} from "./chatgpt-account-archive.js";

/** Return an MCP text result containing only bounded JSON data. */
function textResult(value: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** Register all standalone CDP website chat tools on one MCP server. */
export function registerCdpChatTools(server: McpServer, client: CdpChatClient): void {
  server.tool(
    "new_chat",
    "Create exactly one disposable chat on the owned authenticated page without submitting a prompt.",
    {
      confirmation: z.literal("NEW_CHAT"),
      idempotencyKey: z.string().min(1).max(128),
      title: z.string().min(1).max(256).optional(),
    },
    async (args) => textResult(await client.newChat(args as NewChatInput)),
  );
  server.tool(
    "list_chats",
    "List page-visible chats by explicit unread, observable working, or UTC-recent semantics with bounded pagination.",
    {
      view: z.enum(["unread", "working", "recent"]),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().max(128).optional(),
    },
    async (args) => textResult(await client.listChats(args as ListChatsInput)),
  );
  server.tool(
    "search_chat",
    "Search page-visible chat titles and message text using one fresh owned-page snapshot.",
    {
      query: z.string().trim().min(1).max(256),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async (args) => textResult(await client.searchChat(args as SearchChatInput)),
  );
  server.tool(
    "export_chat",
    "Export only a fixture-bound chat with bounded message count and UTF-8 byte output.",
    {
      chatRef: z.string().min(1).max(256),
      format: z.enum(["json", "markdown"]),
      maxMessages: z.number().int().min(1).max(100).optional(),
    },
    async (args) => textResult(await client.exportChat(args as ExportChatInput)),
  );
  server.tool(
    "send_message",
    "Send one fixture message only with exact confirmation SEND_MESSAGE and a one-shot idempotency gate.",
    {
      chatRef: z.string().min(1).max(256),
      text: z.string().min(1).max(100_000),
      confirmation: z.literal("SEND_MESSAGE"),
      idempotencyKey: z.string().min(1).max(128),
    },
    async (args) => textResult(await client.sendMessage(args as SendMessageInput)),
  );
  server.tool(
    "edit_message",
    "Edit one fixture message only with exact confirmation EDIT_MESSAGE, one-shot idempotency, and an expected version or old-text guard.",
    {
      chatRef: z.string().min(1).max(256),
      messageRef: z.string().min(1).max(256),
      text: z.string().min(1).max(100_000),
      confirmation: z.literal("EDIT_MESSAGE"),
      idempotencyKey: z.string().min(1).max(128),
      expectedVersion: z.number().int().min(1).optional(),
      expectedText: z.string().max(100_000).optional(),
    },
    async (args) => textResult(await client.editMessage(args as EditMessageInput)),
  );
  server.tool(
    "download_media",
    "Download one fixture attachment of an allowlisted MIME and size into the confined media root.",
    {
      chatRef: z.string().min(1).max(256),
      messageRef: z.string().min(1).max(256),
      mediaRef: z.string().min(1).max(256),
      outputDir: z.string().max(4096).optional(),
    },
    async (args) => textResult(await client.downloadMedia(args as DownloadMediaInput)),
  );
}

/** Register the account-wide native-export archive operations. */
export function registerChatGptAccountArchiveTools(server: McpServer, archive: ChatGptAccountArchive): void {
  server.tool(
    "request_account_export",
    "Request ChatGPT's official account-data ZIP. It includes chat history and related account data; the link arrives by email or SMS.",
    { confirmation: z.literal("REQUEST_ACCOUNT_EXPORT") },
    async (args) => textResult(await archive.requestAccountExport(args as RequestAccountExportInput)),
  );
  server.tool(
    "import_account_export",
    "Copy a downloaded ChatGPT account-export ZIP into the local archive and create a source-format manifest without converting chat content.",
    { sourcePath: z.string().min(1).max(4096) },
    async (args) => textResult(await archive.importAccountExport(args as ImportAccountExportInput)),
  );
  server.tool(
    "list_account_exports",
    "List imported ChatGPT account-export ZIP archives and aggregate entry categories without exposing chat text.",
    { limit: z.number().int().min(1).max(100).optional() },
    async (args) => textResult(await archive.listAccountExports(args.limit)),
  );
}

/** Create the standalone MCP server around an already configured page driver. */
export function createCdpChatServer(driver: CdpChatDriver, options: ConstructorParameters<typeof CdpChatClient>[1] = {}): McpServer {
  const server = new McpServer({
    name: "cdp-website-chat",
    version: "0.1.0",
    description: "Bounded ChatGPT/E-Frontier chat operations over one owned CDP page",
  });
  registerCdpChatTools(server, new CdpChatClient(driver, options));
  registerChatGptAccountArchiveTools(server, new ChatGptAccountArchive(driver.accountExportDriver, {
    archiveRoot: process.env.CHATGPT_ACCOUNT_ARCHIVE_ROOT,
  }));
  return server;
}

/** Load a BrowserClaw/CDP driver factory from an explicit local module path. */
export async function loadCdpChatDriver(modulePath = process.env.CDP_CHAT_DRIVER_MODULE): Promise<CdpChatDriver> {
  if (!modulePath) throw new Error("CDP_CHAT_DRIVER_MODULE must point to the BrowserClaw/CDP driver module");
  const resolved = isAbsolute(modulePath) ? modulePath : resolve(process.cwd(), modulePath);
  const loaded = await import(pathToFileURL(resolved).href) as { createCdpChatDriver?: () => CdpChatDriver | Promise<CdpChatDriver>; default?: () => CdpChatDriver | Promise<CdpChatDriver> };
  const factory = loaded.createCdpChatDriver ?? loaded.default;
  if (!factory) throw new Error("CDP driver module must export createCdpChatDriver or a default factory");
  const driver = await factory();
  if (!driver || typeof driver.acquirePage !== "function") throw new Error("CDP driver factory returned an invalid driver");
  return driver;
}

/** Start the stdio MCP process used by the standalone route. */
export async function main(): Promise<void> {
  const driver = await loadCdpChatDriver();
  const server = createCdpChatServer(driver, {
    mediaRoot: process.env.CDP_CHAT_MEDIA_ROOT,
  });
  await server.connect(new StdioServerTransport());
  console.error("[cdp-website-chat] MCP server running on stdio");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`[cdp-website-chat] Fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
