import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { agentHerderRag } from "../rag-search.js";
import type { HarnessAdapter } from "../types/index.js";

export function registerRagTools(server: McpServer, adapters?: Map<string, HarnessAdapter>): void {
  server.registerTool("agent_herder_search", {
    description: "Search opted-in conversation history indexed locally on this Herder host. For an exact quote across computers, prefer session_search with the correct hostId; for a known native ID, use agent_info or fleet_session_view with hostId. Hybrid mode runs text matching then semantic embeddings; use mode=exact for fast local text-only results without waiting for embeddings, or mode=semantic for meaning similarity. This is not a complete fleet search: missing results do not prove a session is absent on other hosts. Results include stage timings and coverage.",
    inputSchema: z.object({
      query: z.string().trim().min(1).max(1000),
      mode: z.enum(["hybrid", "exact", "semantic"]).optional(),
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
