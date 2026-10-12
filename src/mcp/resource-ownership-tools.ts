import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getS21Ownership } from "../s21-resource-ownership.js";
export function registerResourceOwnershipTools(server: McpServer): void {
  server.registerTool("s21_lease_status", {
    description: "Read-only S21 ownership on server-100: exact harness/session link, system origin, or honest legacy/unavailable state. Never acquires or controls the phone or returns the lease capability.",
    inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    const result = await getS21Ownership();
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
  });
}
