#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCdpChatServer } from "./cdp-chat-mcp.js";
import { createCdpChatDriver } from "./browserclaw-cdp-chat.js";

/** Start one long-lived CDP chat MCP process and retain its BrowserClaw page/session. */
async function main(): Promise<void> {
  const driver = await createCdpChatDriver();
  const server = createCdpChatServer(driver, { mediaRoot: process.env.CDP_CHAT_MEDIA_ROOT });
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(`[cdp-chat-browserclaw] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
