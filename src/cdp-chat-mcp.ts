#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";
import {
  CdpChatClient,
  ALL_CDP_CHAT_CAPABILITIES,
  type CdpChatCapabilities,
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
import {
  ChatGptHistoryArchive,
  type ExportChatHistoryInput,
  type ExportVisibleChatHistoryInput,
  type ListChatHistoryInput,
  type ReconcileVisibleChatHistoryInput,
} from "./chatgpt-history-archive.js";

/** Return an MCP text result containing only bounded JSON data. */
function textResult(value: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** Register all standalone CDP website chat tools on one MCP server. */
export function registerCdpChatTools(
  server: McpServer,
  client: CdpChatClient,
  capabilities: CdpChatCapabilities = ALL_CDP_CHAT_CAPABILITIES,
): void {
  if (capabilities.new_chat) server.registerTool("new_chat", { description: "Create exactly one disposable chat on the owned authenticated page without submitting a prompt.", inputSchema: z.object({
            confirmation: z.literal("NEW_CHAT"),
            idempotencyKey: z.string().min(1).max(128),
            title: z.string().min(1).max(256).optional(),
          }) }, async (args) => textResult(await client.newChat(args as NewChatInput)));
  if (capabilities.list_chats) server.registerTool("list_chats", { description: "List page-visible chats by explicit unread, observable working, or UTC-recent semantics with bounded pagination.", inputSchema: z.object({
            view: z.enum(["unread", "working", "recent"]),
            limit: z.number().int().min(1).max(100).optional(),
            cursor: z.string().max(128).optional(),
          }) }, async (args) => textResult(await client.listChats(args as ListChatsInput)));
  if (capabilities.search_chat) server.registerTool("search_chat", { description: "Search page-visible chat titles and message text using one fresh owned-page snapshot.", inputSchema: z.object({
            query: z.string().trim().min(1).max(256),
            limit: z.number().int().min(1).max(100).optional(),
          }) }, async (args) => textResult(await client.searchChat(args as SearchChatInput)));
  if (capabilities.export_chat) server.registerTool("export_chat", { description: "Export only a fixture-bound chat with bounded message count and UTF-8 byte output.", inputSchema: z.object({
            chatRef: z.string().min(1).max(256),
            format: z.enum(["json", "markdown"]),
            maxMessages: z.number().int().min(1).max(100).optional(),
          }) }, async (args) => textResult(await client.exportChat(args as ExportChatInput)));
  if (capabilities.send_message) server.registerTool("send_message", { description: "Send one fixture message only with exact confirmation SEND_MESSAGE and a one-shot idempotency gate.", inputSchema: z.object({
            chatRef: z.string().min(1).max(256),
            text: z.string().min(1).max(100_000),
            confirmation: z.literal("SEND_MESSAGE"),
            idempotencyKey: z.string().min(1).max(128),
          }) }, async (args) => textResult(await client.sendMessage(args as SendMessageInput)));
  if (capabilities.edit_message) server.registerTool("edit_message", { description: "Edit one fixture message only with exact confirmation EDIT_MESSAGE, one-shot idempotency, and an expected version or old-text guard.", inputSchema: z.object({
            chatRef: z.string().min(1).max(256),
            messageRef: z.string().min(1).max(256),
            text: z.string().min(1).max(100_000),
            confirmation: z.literal("EDIT_MESSAGE"),
            idempotencyKey: z.string().min(1).max(128),
            expectedVersion: z.number().int().min(1).optional(),
            expectedText: z.string().max(100_000).optional(),
          }) }, async (args) => textResult(await client.editMessage(args as EditMessageInput)));
  if (capabilities.download_media) server.registerTool("download_media", { description: "Download one fixture attachment of an allowlisted MIME and size into the confined media root.", inputSchema: z.object({
            chatRef: z.string().min(1).max(256),
            messageRef: z.string().min(1).max(256),
            mediaRef: z.string().min(1).max(256),
            outputDir: z.string().max(4096).optional(),
          }) }, async (args) => textResult(await client.downloadMedia(args as DownloadMediaInput)));
}

/** Register the account-wide native-export archive operations. */
export function registerChatGptAccountArchiveTools(server: McpServer, archive: ChatGptAccountArchive): void {
  server.registerTool("request_account_export", { description: "Request ChatGPT's official account-data ZIP. It includes chat history and related account data; the link arrives by email or SMS.", inputSchema: z.object({ confirmation: z.literal("REQUEST_ACCOUNT_EXPORT") }) }, async (args) => textResult(await archive.requestAccountExport(args as RequestAccountExportInput)));
  server.registerTool("import_account_export", { description: "Copy a downloaded ChatGPT account-export ZIP into the local archive and create a source-format manifest without converting chat content.", inputSchema: z.object({ sourcePath: z.string().min(1).max(4096) }) }, async (args) => textResult(await archive.importAccountExport(args as ImportAccountExportInput)));
  server.registerTool("list_account_exports", { description: "List imported ChatGPT account-export ZIP archives and aggregate entry categories without exposing chat text.", inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }) }, async (args) => textResult(await archive.listAccountExports(args.limit)));
}

/** Register the read-only, checkpointed history archive surface. */
export function registerChatGptHistoryArchiveTools(server: McpServer, archive?: ChatGptHistoryArchive): void {
  if (!archive) return;
  server.registerTool("reconcile_known_routes", { description: "Materialize local Markdown and HTML from all already captured ChatGPT /c/... snapshots. This never opens, scrolls, or alters ChatGPT and works while BrowserClaw is unavailable.", inputSchema: z.object({}) }, async () => textResult(await archive.reconcileKnownRoutes()));
  server.registerTool("list_chats", { description: "List the currently visible ChatGPT sidebar chats from the one owned page. No chat content is returned.", inputSchema: z.object({ view: z.enum(["unread", "working", "recent"]), limit: z.number().int().min(1).max(100).optional() }) }, async (args) => textResult(await archive.listChats(args as ListChatHistoryInput)));
  server.registerTool("export_chat", { description: "Read one listed ChatGPT chat in the same owned page, scroll backward, and save raw snapshots locally. Returns only a checkpoint receipt.", inputSchema: z.object({ chatRef: z.string().min(1).max(256), maxSegments: z.number().int().min(1).max(100).optional() }) }, async (args) => textResult(await archive.exportChat(args as ExportChatHistoryInput)));
  server.registerTool("export_visible_chats", { description: "Best-effort export of all currently visible non-protected ChatGPT conversations. Each completed archive includes local Markdown and HTML renderings beside raw snapshots.", inputSchema: z.object({ maxChats: z.number().int().min(1).max(100).optional(), maxSegmentsPerChat: z.number().int().min(1).max(100).optional() }) }, async (args) => textResult(await archive.exportVisibleChats(args as ExportVisibleChatHistoryInput)));
  server.registerTool("reconcile_visible_chats", { description: "Materialize local Markdown and HTML from already captured ChatGPT history snapshots for the currently visible chats. This does not open, scroll, or alter ChatGPT.", inputSchema: z.object({ maxChats: z.number().int().min(1).max(100).optional() }) }, async (args) => textResult(await archive.reconcileVisibleChats(args as ReconcileVisibleChatHistoryInput)));
}

/** Create the standalone MCP server around an already configured page driver. */
export function createCdpChatServer(driver: CdpChatDriver, options: ConstructorParameters<typeof CdpChatClient>[1] = {}): McpServer {
  const server = new McpServer({
    name: "cdp-website-chat",
    version: "0.1.0",
    description: "Bounded ChatGPT/E-Frontier chat operations over one owned CDP page",
  });
  registerCdpChatTools(server, new CdpChatClient(driver, options), driver.capabilities);
  registerChatGptHistoryArchiveTools(server, driver.historyArchiveDriver
    ? new ChatGptHistoryArchive(driver.historyArchiveDriver, { archiveRoot: process.env.CHATGPT_HISTORY_ARCHIVE_ROOT })
    : undefined);
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
  serveStdio(() => createCdpChatServer(driver, {
    mediaRoot: process.env.CDP_CHAT_MEDIA_ROOT,
  }), { onerror: (error) => console.error(`[cdp-website-chat] MCP stdio error: ${error.message}`) });
  console.error("[cdp-website-chat] MCP v2 server running on stdio (2026-07-28 + legacy fallback)");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`[cdp-website-chat] Fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
