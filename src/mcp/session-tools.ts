import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { HarnessAdapter } from "../types/index.js";
import type { HerderEventBus } from "../herder-events.js";
import type { HerderJobRegistry } from "../herder-jobs.js";
import {
  listAgentsResult,
  formatListAgentsResult,
  agentInfoResult,
  findParentResult,
  listChildrenResult,
  listModelsResult,
  formatSession,
  formatFindParentResult,
  formatListChildrenResult,
  formatListModelsResult,
  handleExportTranscript,
  handleSendMessage,
  handleCreateSession,
  handleNewOrResume,
  handleStopAgent,
  handleRespondPermission,
  handleSetPermissions,
  handleResumeAgent,
  handleChangeModel,
  handleListModels,
  handleAuditWorktrees,
} from "../mcp-tools/handlers.js";
import { startJobResult } from "./results.js";

const harnessSchema = z.enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent"]);

const sessionSchema = z.object({
  id: z.string(), harness: harnessSchema, status: z.enum(["running", "idle", "needs_input", "stopped", "error"]), title: z.string(), cwd: z.string(), lastActivity: z.string(),
  model: z.string().optional(), needsPermission: z.boolean(), permissionDetails: z.object({ id: z.string(), type: z.string(), description: z.string(), toolName: z.string().optional(), details: z.string().optional() }).optional(),
  messageCount: z.number().optional(), costUsd: z.number().optional(), durationSec: z.number().optional(), lastMessage: z.string().optional(), meta: z.record(z.string(), z.unknown()).optional(),
});

export function registerSessionTools(server: McpServer, deps: {
  adapters: Map<string, HarnessAdapter>;
  jobs: HerderJobRegistry;
  events: HerderEventBus;
}): void {
  const { adapters, jobs, events } = deps;
  const publishSessionsChanged = () => events.publish({ kind: "sessions", uri: "herder://sessions", action: "changed" });

  server.registerTool("list_agents", { description: "List all coding agent sessions, including ZCode. Filter by harness, status, age (maxAge seconds), or folder (CWD prefix like ~/apps). Can show last message preview.", inputSchema: z.object({
    harness: z.enum(["all", "opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent"]).optional().default("all"),
    status: z.enum(["all", "running", "idle", "needs_input", "stopped", "error"]).optional().default("all"),
    limit: z.number().int().min(1).max(100).optional().default(50), maxAge: z.number().int().min(0).optional(), folder: z.string().optional(), includeLastMessage: z.boolean().optional().default(false),
  }), outputSchema: z.object({
    sessions: z.array(sessionSchema), total: z.number().int().min(0), limited: z.boolean(),
    filters: z.object({ harness: z.string(), status: z.string(), maxAge: z.number().optional(), folder: z.string().optional(), includeLastMessage: z.boolean() }),
  }) }, async (args) => {
    const result = await listAgentsResult(adapters, args);
    return { content: [{ type: "text" as const, text: formatListAgentsResult(result) }], structuredContent: result };
  });

  server.registerTool("audit_worktrees", { description: "Read-only Git worktree audit: dirty files, lock/PID state, and Claude/Codex/OpenCode/ZCode processes whose cwd is inside each worktree.", inputSchema: z.object({ repoPath: z.string(), includeClean: z.boolean().optional().default(false) }) }, async (args) => ({ content: [{ type: "text" as const, text: await handleAuditWorktrees(args) }] }));
  server.registerTool("agent_info", { description: "Get detailed info about a specific session. Always shows model and last message.", inputSchema: z.object({ sessionId: z.string(), harness: harnessSchema.optional() }), outputSchema: z.object({ session: sessionSchema.nullable() }) }, async (args) => {
    const session = await agentInfoResult(adapters, args);
    return { content: [{ type: "text" as const, text: session ? formatSession(session, true) : `Session '${args.sessionId}' not found.` }], structuredContent: { session } };
  });
  server.registerTool("find_parent", { description: "Find the native parent session of an agent session.", inputSchema: z.object({ sessionId: z.string(), harness: harnessSchema.optional() }), outputSchema: z.object({ session: sessionSchema.nullable(), parent: sessionSchema.nullable(), supported: z.boolean() }) }, async (args) => {
    const result = await findParentResult(adapters, args);
    return { content: [{ type: "text" as const, text: formatFindParentResult(args.sessionId, result) }], structuredContent: result };
  });
  server.registerTool("list_children", { description: "List the native child sessions of an agent session.", inputSchema: z.object({ sessionId: z.string(), harness: harnessSchema.optional() }), outputSchema: z.object({ session: sessionSchema.nullable(), children: z.array(sessionSchema), supported: z.boolean() }) }, async (args) => {
    const result = await listChildrenResult(adapters, args);
    return { content: [{ type: "text" as const, text: formatListChildrenResult(args.sessionId, result) }], structuredContent: result };
  });

  server.registerTool("export_transcript", { description: "Export the raw adapter-owned transcript and return a filesystem navigation card.", inputSchema: z.object({ sessionId: z.string(), harness: harnessSchema.optional() }) }, async (args) => ({ content: [{ type: "text" as const, text: await handleExportTranscript(adapters, args) }] }));
  server.registerTool("export_transcript_async", { description: "Export a raw adapter-owned transcript as a Herder background job.", inputSchema: z.object({ sessionId: z.string(), harness: harnessSchema.optional(), ownerSessionId: z.string().optional() }) }, async (args) => startJobResult(jobs, "transcript-export", async (_signal, progress) => {
    progress(0.1, "Exporting transcript");
    return handleExportTranscript(adapters, args);
  }, args.ownerSessionId));

  server.registerTool("send_message", { description: "Send a message to an agent. Active coordination notes for the target workspace are injected automatically before delivery. Modes: sync (wait), queue (fire-and-forget), steer (redirect).", inputSchema: z.object({ sessionId: z.string(), harness: harnessSchema.optional(), message: z.string(), mode: z.enum(["queue", "steer", "sync"]).optional().default("sync") }) }, async (args) => {
    const result = await handleSendMessage(adapters, args); publishSessionsChanged();
    return { content: [{ type: "text" as const, text: result }] };
  });
  server.registerTool("create_session", { description: "Create one named OpenCode, Codex, or ZCode session in an absolute canonical working directory.", inputSchema: z.object({ harness: z.enum(["opencode", "codex", "zcode"]), name: z.string().min(1).max(128), cwd: z.string().min(1) }) }, async (args) => {
    const result = await handleCreateSession(adapters, args); publishSessionsChanged();
    return { content: [{ type: "text" as const, text: result }] };
  });
  server.registerTool("new_or_resume", { description: "Reuse the exact named session for harness+CWD or create it, then deliver one message.", inputSchema: z.object({ harness: z.enum(["opencode", "codex", "zcode"]), name: z.string().min(1).max(128), cwd: z.string().min(1), message: z.string().min(1), mode: z.enum(["queue", "sync"]).optional().default("sync"), model: z.string().min(1).max(128).optional() }) }, async (args) => {
    const result = await handleNewOrResume(adapters, args); publishSessionsChanged();
    return { content: [{ type: "text" as const, text: result }] };
  });
  server.registerTool("stop_agent", { description: "Stop / abort a running agent session.", inputSchema: z.object({ sessionId: z.string(), harness: harnessSchema.optional() }) }, async (args) => {
    const result = await handleStopAgent(adapters, args); publishSessionsChanged();
    return { content: [{ type: "text" as const, text: result }] };
  });
  server.registerTool("respond_permission", { description: "Respond to a pending permission request (allow/deny). OpenCode, Claude SDK, and ZCode support this.", inputSchema: z.object({ sessionId: z.string(), harness: harnessSchema.optional(), permissionId: z.string(), response: z.enum(["allow", "deny"]), remember: z.boolean().optional() }) }, async (args) => ({ content: [{ type: "text" as const, text: await handleRespondPermission(adapters, args) }] }));
  server.registerTool("set_permissions", { description: "Set permissions for an agent. Claude/Codex set these at launch time.", inputSchema: z.object({ sessionId: z.string(), harness: harnessSchema.optional(), allowedTools: z.string().optional(), mode: z.string().optional() }) }, async (args) => ({ content: [{ type: "text" as const, text: await handleSetPermissions(adapters, args) }] }));
  server.registerTool("resume_agent", { description: "Resume a stopped agent session. Optionally provide a message.", inputSchema: z.object({ sessionId: z.string(), harness: harnessSchema.optional(), message: z.string().optional() }) }, async (args) => {
    const result = await handleResumeAgent(adapters, args); publishSessionsChanged();
    return { content: [{ type: "text" as const, text: result }] };
  });
  server.registerTool("change_model", { description: "Change the AI model for a harness. For OpenCode: per-session or global. For Claude/Codex/Qoder/ZCode: per-session where supported by the harness.", inputSchema: z.object({ sessionId: z.string().optional(), harness: harnessSchema, model: z.string() }) }, async (args) => {
    const result = await handleChangeModel(adapters, args); publishSessionsChanged();
    return { content: [{ type: "text" as const, text: result }] };
  });
  server.registerTool("list_models", { description: "List available AI models for each harness.", inputSchema: z.object({ harness: harnessSchema.optional() }), outputSchema: z.object({ harnesses: z.array(z.object({ harness: z.string(), name: z.string(), models: z.array(z.string()), defaultModel: z.string().optional() })) }) }, async (args) => {
    const harnesses = await listModelsResult(adapters, args);
    return { content: [{ type: "text" as const, text: formatListModelsResult(harnesses) }], structuredContent: { harnesses } };
  });
}
