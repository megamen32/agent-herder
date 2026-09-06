#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createCdpChatServer } from "./cdp-chat-mcp.js";
import { createCdpChatDriver } from "./browserclaw-cdp-chat.js";

/** Start one long-lived CDP chat MCP process and retain its BrowserClaw page/session. */
async function main(): Promise<void> {
  const driver = await createCdpChatDriver();
  serveStdio(() => createCdpChatServer(driver, { mediaRoot: process.env.CDP_CHAT_MEDIA_ROOT }), {
    onerror: (error) => console.error(`[cdp-chat-browserclaw] MCP stdio error: ${error.message}`),
  });
}

main().catch((error: unknown) => {
  console.error(`[cdp-chat-browserclaw] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
