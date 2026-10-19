import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { agentHerderRag } from "../rag-search.js";
import type { HarnessAdapter } from "../types/index.js";

export function registerRagTools(server: McpServer, adapters?: Map<string, HarnessAdapter>): void {
  server.registerTool("agent_herder_search", {
    description: "Search opted-in Codex, ZCode, and OpenCode conversation history semantically in Agent Herder's Qdrant index.",
    inputSchema: z.object({
      query: z.string().trim().min(1).max(1000),
      harnesses: z.array(z.enum(["codex", "zcode", "opencode"])).max(3).optional(),
      from: z.string().date().optional(),
      to: z.string().date().optional(),
      project: z.string().max(256).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }),
  }, async (input) => {
    try {
      const result = await agentHerderRag().search(
        input.query,
        input,
        async (harness, id) => (await adapters?.get(harness)?.getSession(id)) || undefined,
        async () => (await adapters?.get("codex")?.listSessions({ limit: 100 }) || []).map(({ id, title, cwd, lastMessage }) => ({ id, title, cwd, lastMessage })),
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : "semantic search failed";
      return { isError: true, content: [{ type: "text", text: message.slice(0, 300) }] };
    }
  });
}
