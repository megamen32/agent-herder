import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { BrowserWakeService } from "../browser-wake.js";
import type { HerderJobRegistry } from "../herder-jobs.js";
import type { AgentHerderSessionConverter } from "../session-convert.js";
import { handleBrowserWake } from "../mcp-tools/handlers.js";
import { startJobResult, structuredResult } from "./results.js";

export function registerBackgroundTools(server: McpServer, deps: {
  browserWakeService: BrowserWakeService;
  jobs: HerderJobRegistry;
  sessionConverter: Pick<AgentHerderSessionConverter, "convert">;
}): void {
  const { browserWakeService, jobs, sessionConverter } = deps;

  const browserInput = {
    schema: z.literal("agent-herder.browser-worker.v1"), worker: z.literal("mac-mini-browserclaw"), target: z.literal("E-Frontier"),
    templateId: z.enum(["secretary.inbox.v1", "secretary.browser-canary.v1"]), sourceRefs: z.array(z.string().min(1)).min(1).max(8),
    runId: z.string().min(1).max(128), idempotencyId: z.string().min(1).max(128), deadlineMs: z.number().int().min(1).max(10 * 60 * 1000),
  } as const;

  server.registerTool("browser_wake", {
    description: "Wake the allowlisted BrowserWorker for the fixed E-Frontier target using a fixed secretary template, opaque refs, run/idempotency IDs, and a bounded deadline.",
    inputSchema: z.object(browserInput),
  }, async (args) => ({ content: [{ type: "text" as const, text: await handleBrowserWake(browserWakeService, args) }] }));

  server.registerTool("browser_wake_async", {
    description: "Run BrowserWorker wake as a Herder background job so long browser deadlines do not pin the MCP request.",
    inputSchema: z.object({ ...browserInput, ownerSessionId: z.string().optional() }),
  }, async (args) => startJobResult(jobs, "browser-wake", async (_signal, progress) => {
    progress(0.05, "Dispatching BrowserWorker");
    return handleBrowserWake(browserWakeService, args);
  }, args.ownerSessionId));

  server.registerTool("session_convert_async", {
    description: "Start a Herder-owned background session conversion and return immediately with a pollable job resource.",
    inputSchema: z.object({
      sessionId: z.string().min(1), from: z.enum(["claude", "codex", "opencode"]), to: z.enum(["claude", "codex", "opencode"]),
      projectPath: z.string().optional(), searchPaths: z.array(z.string()).max(32).optional(), ownerSessionId: z.string().optional(),
    }),
  }, async (args) => {
    const job = jobs.start({
      kind: "session-convert", ownerSessionId: args.ownerSessionId,
      run: async ({ signal, progress }) => {
        progress(0.05, "Reading source session");
        if (signal.aborted) throw new Error("cancelled");
        const result = await sessionConverter.convert({ sessionId: args.sessionId, from: args.from, to: args.to, projectPath: args.projectPath, searchPaths: args.searchPaths });
        if (signal.aborted) throw new Error("cancelled");
        progress(1, "Conversion finished");
        return result;
      },
    });
    return structuredResult({ job });
  });
}
