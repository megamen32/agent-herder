import type { McpServer } from "@modelcontextprotocol/server";
import { hostname } from "node:os";
import { z } from "zod";
import type { HarnessAdapter } from "../types/index.js";
import { sessionIdentity } from "../session-identity.js";
import type { HerderEventBus } from "../herder-events.js";
import type { HerderJobRegistry } from "../herder-jobs.js";
import {
  SendMessageSchema,
  CreateSessionSchema,
  NewOrResumeSchema,
  DeliverSchema,
  ResumeAgentSchema,
} from "../mcp-tools/definitions.js";
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
  handleDeliver,
  handleStopAgent,
  handleRespondPermission,
  handleSetPermissions,
  handleResumeAgent,
  handleChangeModel,
  handleListModels,
  handleAuditWorktrees,
} from "../mcp-tools/handlers.js";
import { startJobResult } from "./results.js";
import { readModelQuotas } from "../model-quota.js";
import type { IntegratorFleetRuntime } from "../integrator-fleet-runtime.js";

const harnessSchema = z.enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt", "minimax-code"]);

const sessionSchema = z.object({
  id: z.string(), harness: harnessSchema, status: z.enum(["running", "idle", "needs_input", "stopped", "error"]), title: z.string(), cwd: z.string(), lastActivity: z.string(),
  model: z.string().optional(), needsPermission: z.boolean(), permissionDetails: z.object({ id: z.string(), type: z.string(), description: z.string(), toolName: z.string().optional(), details: z.string().optional() }).optional(),
  messageCount: z.number().optional(), costUsd: z.number().optional(), durationSec: z.number().optional(), lastMessage: z.string().optional(), meta: z.record(z.string(), z.unknown()).optional(),
});

export function registerSessionTools(server: McpServer, deps: {
  adapters: Map<string, HarnessAdapter>;
  jobs: HerderJobRegistry;
  events: HerderEventBus;
  integratorRuntime?: Pick<IntegratorFleetRuntime, "adapterForSession">;
}): void {
  const { adapters, jobs, events } = deps;
  async function sessionRoute<T extends { sessionId?: string; harness?: string }>(args: T) {
    if (!args.sessionId || !deps.integratorRuntime) return { adapters, args, denied: false };
    const resolution = await deps.integratorRuntime.adapterForSession({ hostId: hostname(), harness: "codex", nativeSessionId: args.sessionId });
    if (resolution.kind === "deny") return { adapters, args, denied: true };
    if (resolution.kind === "ordinary") return { adapters, args, denied: false };
    if (args.harness && args.harness !== "codex") return { adapters, args, denied: true };
    const routed = new Map(adapters);
    routed.set("codex", resolution.adapter);
    return { adapters: routed, args: { ...args, harness: "codex" } as T, denied: false };
  }
  const publishSessionsChanged = () => events.publish({ kind: "sessions", uri: "herder://sessions", action: "changed" });

  server.registerTool("list_agents", { description: "List all coding agent sessions, including ZCode. Filter by harness, status, age (maxAge seconds), or folder (CWD prefix like ~/apps). Can show last message preview.", inputSchema: z.object({
    harness: z.enum(["all", "opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt", "minimax-code"]).optional().default("all"),
    status: z.enum(["all", "running", "idle", "needs_input", "stopped", "error"]).optional().default("all"),
    limit: z.number().int().min(1).max(100).optional().default(20), maxAge: z.number().int().min(0).optional(), folder: z.string().optional(), includeLastMessage: z.boolean().optional().default(false),
  }), outputSchema: z.object({
    complete: z.boolean(), unavailable: z.array(z.object({harness:z.string(),error:z.string()})),
    sessions: z.array(sessionSchema), total: z.number().int().min(0), limited: z.boolean(),
    filters: z.object({ harness: z.string(), status: z.string(), maxAge: z.number().optional(), folder: z.string().optional(), includeLastMessage: z.boolean() }),
  }) }, async (args) => {
    const result = await listAgentsResult(adapters, args);
    return { content: [{ type: "text" as const, text: formatListAgentsResult(result) }], structuredContent: result };
  });

  server.registerTool("audit_worktrees", { description: "Read-only Git worktree audit: dirty files, lock/PID state, and Claude/Codex/OpenCode/ZCode processes whose cwd is inside each worktree.", inputSchema: z.object({ repoPath: z.string(), includeClean: z.boolean().optional().default(false) }) }, async (args) => ({ content: [{ type: "text" as const, text: await handleAuditWorktrees(args) }] }));
  server.registerTool("model_quotas", {
    description: "Read current GLM Coding Plan, MiniMax Token Plan and local Codex usage allowances. Returns unknown when credentials or official account usage are unavailable; never guesses quota values.",
    inputSchema: z.object({}),
  }, async () => {
    const result = await readModelQuotas();
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
  });
  server.registerTool("agent_info", { description: "Get detailed info about a specific session. Always shows model and last message.", inputSchema: z.object({ sessionId: z.string(), harness: harnessSchema.optional() }), outputSchema: z.object({ session: sessionSchema.nullable() }) }, async (args) => {
    const route = await sessionRoute(args);
    if (route.denied) throw new Error("project_session_scope_unavailable");
    const session = await agentInfoResult(route.adapters, route.args);
    return { content: [{ type: "text" as const, text: session ? formatSession(session, true) : `Session '${args.sessionId}' not found.` }], structuredContent: { session } };
  });
  server.registerTool("session_identity", {
    description:
      "Read the identity of a session (its name, native id, harness and workspace). " +
      "With announce=true the identity is published into the session's own instructions so an OpenCode 2 agent can answer 'who am I' from its next turn.",
    inputSchema: z.object({
      sessionId: z.string().trim().min(1),
      harness: harnessSchema.optional(),
      name: z.string().trim().min(1).max(128).optional().describe("Name to publish; defaults to the native title."),
      announce: z.boolean().optional().default(false).describe("Publish the identity into the session itself."),
    }),
    outputSchema: z.object({
      sessionId: z.string(), harness: z.string(), name: z.string(), cwd: z.string(),
      status: z.string().optional(), announced: z.boolean().optional(), reason: z.string().optional(),
    }).nullable(),
  }, async (args) => {
    const route = await sessionRoute(args);
    if (route.denied) throw new Error("project_session_scope_unavailable");
    const harness = route.args.harness ? [route.args.harness] : [...route.adapters.keys()];
    let owned: HarnessAdapter | undefined;
    for (const name of harness) {
      const adapter = route.adapters.get(name);
      if (!adapter) continue;
      if (await adapter.getSession(args.sessionId).catch(() => null)) { owned = adapter; break; }
    }
    if (!owned) return { content: [{ type: "text" as const, text: `Session '${args.sessionId}' not found.` }], structuredContent: null };
    const identity = await sessionIdentity(owned, {
      sessionId: args.sessionId,
      ...(args.name ? { name: args.name } : {}),
      announce: args.announce === true,
    });
    const text = identity
      ? [
          `Session ${identity.sessionId} [${identity.harness}] is named "${identity.name}" and works in ${identity.cwd}.`,
          ...(identity.announced === true ? ["The identity was published into the session's own instructions."] : []),
          ...(identity.reason ? [`Not published: ${identity.reason}`] : []),
        ].join("\n")
      : `Session '${args.sessionId}' not found.`;
    return { content: [{ type: "text" as const, text }], structuredContent: identity };
  });

  server.registerTool("find_parent", { description: "Find the native parent session of an agent session.", inputSchema: z.object({ sessionId: z.string(), harness: harnessSchema.optional() }), outputSchema: z.object({ session: sessionSchema.nullable(), parent: sessionSchema.nullable(), supported: z.boolean() }) }, async (args) => {
    const result = await findParentResult(adapters, args);
    return { content: [{ type: "text" as const, text: formatFindParentResult(args.sessionId, result) }], structuredContent: result };
  });
  server.registerTool("list_children", { description: "List the native child sessions of an agent session.", inputSchema: z.object({ sessionId: z.string(), harness: harnessSchema.optional() }), outputSchema: z.object({ session: sessionSchema.nullable(), children: z.array(sessionSchema), supported: z.boolean() }) }, async (args) => {
    const route = await sessionRoute(args);
    if (route.denied) throw new Error("project_session_scope_unavailable");
    const result = await listChildrenResult(route.adapters, route.args);
    return { content: [{ type: "text" as const, text: formatListChildrenResult(args.sessionId, result) }], structuredContent: result };
  });

  server.registerTool("export_transcript", { description: "Export the raw adapter-owned transcript and return a filesystem navigation card.", inputSchema: z.object({ sessionId: z.string(), harness: harnessSchema.optional() }) }, async (args) => {
    const route = await sessionRoute(args);
    if (route.denied) throw new Error("project_session_scope_unavailable");
    return { content: [{ type: "text" as const, text: await handleExportTranscript(route.adapters, route.args) }] };
  });
  server.registerTool("export_transcript_async", { description: "Export a raw adapter-owned transcript as a Herder background job.", inputSchema: z.object({ sessionId: z.string(), harness: harnessSchema.optional(), ownerSessionId: z.string().optional() }) }, async (args) => {
    const route = await sessionRoute(args);
    if (route.denied) throw new Error("project_session_scope_unavailable");
    return startJobResult(jobs, "transcript-export", async (signal, progress) => {
      progress(0.1, "Exporting transcript");
      return handleExportTranscript(route.adapters, route.args, undefined, signal);
    }, args.ownerSessionId);
  });

  server.registerTool("send_message", { description: "Send a message to an agent. Ordinary coordination is active-turn-only, including queue mode: inactive/completed targets return skipped_inactive without new turns or deferred debt. Explicit humanRequested=true permits a human new task/send/resume. inputId deduplicates retries for 24 hours. Active coordination notes are injected automatically. fromSessionId/fromHarness add verified reply attribution, do not authenticate the caller. Modes: sync (wait), queue (fire-and-forget), steer (redirect).", inputSchema: SendMessageSchema }, async (args) => {
    const route = await sessionRoute(args);
    if (route.denied) throw new Error("project_session_scope_unavailable");
    const result = await handleSendMessage(route.adapters, route.args); publishSessionsChanged();
    return { content: [{ type: "text" as const, text: result }] };
  });
  server.registerTool("create_session", { description: "Create one named OpenCode, Codex, ZCode, or Fast Agent session in an absolute canonical working directory.", inputSchema: CreateSessionSchema }, async (args) => {
    const result = await handleCreateSession(adapters, args); publishSessionsChanged();
    return { content: [{ type: "text" as const, text: result }] };
  });
  server.registerTool("new_or_resume", { description: "Reuse the exact named session for harness+CWD or create it, then deliver one message. OpenCode GLM 5.3 Flash uses MiniMax M3.1 Flash as its default fallback after a pre-admission HTTP 429 or provider quota rejection; fallbackModels overrides that route. Unknown/accepted delivery and manual stops never trigger fallback. Call model_quotas to inspect current provider allowances.", inputSchema: NewOrResumeSchema }, async (args) => {
    const result = await handleNewOrResume(adapters, args); publishSessionsChanged();
    return { content: [{ type: "text" as const, text: result }] };
  });
  server.registerTool("deliver", { description: "Deliver a message to an agent. Existing targets default to current-turn-only delivery; idle/completed targets are skipped without deferred debt. Newly created named targets receive their initial task. inputId deduplicates retries for 24 hours. Target by sessionId or harness+name+cwd. create=if_missing creates a missing named session; create=never does not. activation=always may wake/start; if_running returns skipped_inactive for inactive threads; defer stores deduplicated input without waking an inactive thread. Herder checks native activity at delivery time; no list_agents pre-check is needed.", inputSchema: DeliverSchema }, async(args)=>{ const route=await sessionRoute(args);if(route.denied)throw new Error("project_session_scope_unavailable");const result=await handleDeliver(route.adapters,route.args);publishSessionsChanged();return {content:[{type:"text" as const,text:result}]}; });
  server.registerTool("stop_agent", { description: "Stop / abort a running agent session.", inputSchema: z.object({ sessionId: z.string(), harness: harnessSchema.optional() }) }, async (args) => {
    const route = await sessionRoute(args);
    if (route.denied) throw new Error("project_session_scope_unavailable");
    const result = await handleStopAgent(route.adapters, route.args); publishSessionsChanged();
    return { content: [{ type: "text" as const, text: result }] };
  });
  server.registerTool("respond_permission", { description: "Respond to a pending permission request (allow/deny). OpenCode, Claude SDK, and ZCode support this.", inputSchema: z.object({ sessionId: z.string(), harness: harnessSchema.optional(), permissionId: z.string(), response: z.enum(["allow", "deny"]), remember: z.boolean().optional() }) }, async (args) => {
    const route = await sessionRoute(args);
    if (route.denied) throw new Error("project_session_scope_unavailable");
    return { content: [{ type: "text" as const, text: await handleRespondPermission(route.adapters, route.args) }] };
  });
  server.registerTool("set_permissions", { description: "Set permissions for an agent. Claude/Codex set these at launch time.", inputSchema: z.object({ sessionId: z.string(), harness: harnessSchema.optional(), allowedTools: z.string().optional(), mode: z.string().optional() }) }, async (args) => {
    const route = await sessionRoute(args);
    if (route.denied) throw new Error("project_session_scope_unavailable");
    return { content: [{ type: "text" as const, text: await handleSetPermissions(route.adapters, route.args) }] };
  });
  server.registerTool("resume_agent", { description: "Resume a stopped agent session. Optionally provide a message.", inputSchema: ResumeAgentSchema }, async (args) => {
    const route = await sessionRoute(args);
    if (route.denied) throw new Error("project_session_scope_unavailable");
    const result = await handleResumeAgent(route.adapters, route.args); publishSessionsChanged();
    return { content: [{ type: "text" as const, text: result }] };
  });
  server.registerTool("change_model", { description: "Change the AI model for a harness. For OpenCode: per-session or global. For Claude/Codex/Qoder/ZCode: per-session where supported by the harness.", inputSchema: z.object({ sessionId: z.string().optional(), harness: harnessSchema, model: z.string() }) }, async (args) => {
    const route = await sessionRoute(args);
    if (route.denied) throw new Error("project_session_scope_unavailable");
    const result = await handleChangeModel(route.adapters, route.args); publishSessionsChanged();
    return { content: [{ type: "text" as const, text: result }] };
  });
  server.registerTool("list_models", { description: "List available AI models for each harness.", inputSchema: z.object({ harness: harnessSchema.optional() }), outputSchema: z.object({ harnesses: z.array(z.object({ harness: z.string(), name: z.string(), models: z.array(z.string()), defaultModel: z.string().optional() })) }) }, async (args) => {
    const harnesses = await listModelsResult(adapters, args);
    return { content: [{ type: "text" as const, text: formatListModelsResult(harnesses) }], structuredContent: { harnesses } };
  });
}
