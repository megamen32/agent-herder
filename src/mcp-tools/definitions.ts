import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// ===== Schemas for tool inputs =====

export const ListAgentsSchema = z.object({
  harness: z
    .enum(["all", "opencode", "claude", "codex"])
    .optional()
    .default("all")
    .describe("Filter by harness. 'all' lists from every connected harness."),
  status: z
    .enum(["all", "running", "idle", "needs_input", "stopped", "error"])
    .optional()
    .default("all")
    .describe("Filter by agent status."),
  limit: z.number().int().min(1).max(100).optional().default(50).describe("Max sessions to return."),
  maxAge: z.number().int().min(0).optional().describe(
    "Maximum session age in seconds. Only return sessions active within this window. " +
    "Examples: 3600 = last hour, 86400 = last 24h, 604800 = last week. 0 or omit = no limit."
  ),
  folder: z.string().optional().describe(
    "Filter sessions by working directory prefix. " +
    "For example, '~/apps' will show only sessions whose CWD starts with that path. " +
    "Useful for finding all agent sessions working within a specific project tree."
  ),
  includeLastMessage: z.boolean().optional().default(false).describe(
    "If true, include a preview of the last message in each session."
  ),
});

export const AuditWorktreesSchema = z.object({
  repoPath: z.string().describe("Absolute or home-relative path to a Git repository."),
  includeClean: z.boolean().optional().default(false).describe(
    "Include clean and unlocked worktrees. By default, only dirty, locked, or actively owned worktrees are returned."
  ),
});

export const AgentInfoSchema = z.object({
  sessionId: z.string().describe("The session ID to inspect."),
  harness: z
    .enum(["opencode", "claude", "codex"])
    .optional()
    .describe("Which harness the session belongs to. If omitted, searches all."),
});

export const SendMessageSchema = z.object({
  sessionId: z.string().describe("Target session ID."),
  harness: z.enum(["opencode", "claude", "codex"]).optional().describe("Harness (optional if ID is unique)."),
  message: z.string().describe("Message to send to the agent."),
  mode: z.enum(["queue", "steer", "sync"]).optional().default("sync").describe(
    "queue = fire-and-forget, steer = redirect agent, sync = wait for response"
  ),
});

export const StopAgentSchema = z.object({
  sessionId: z.string().describe("Session ID to stop."),
  harness: z.enum(["opencode", "claude", "codex"]).optional().describe("Harness (optional if ID is unique)."),
});

export const RespondPermissionSchema = z.object({
  sessionId: z.string().describe("Session with pending permission."),
  harness: z.enum(["opencode", "claude", "codex"]).optional(),
  permissionId: z.string().describe("The permission request ID."),
  response: z.enum(["allow", "deny"]).describe("Whether to allow or deny."),
  remember: z.boolean().optional().describe("Remember this decision for future requests."),
});

export const SetPermissionsSchema = z.object({
  sessionId: z.string().describe("Target session ID."),
  harness: z.enum(["opencode", "claude", "codex"]).optional(),
  allowedTools: z.string().optional().describe("Comma-separated list of allowed tools (e.g. 'Read,Edit,Bash')."),
  mode: z.string().optional().describe("Permission mode (e.g. 'fullAuto', 'plan', 'default')."),
});

export const ResumeAgentSchema = z.object({
  sessionId: z.string().describe("Session ID to resume."),
  harness: z.enum(["opencode", "claude", "codex"]).optional(),
  message: z.string().optional().describe("Optional message to send when resuming."),
});

export const SummarizeSessionSchema = z.object({
  sessionId: z.string().describe("The session ID to summarize."),
  harness: z.enum(["opencode", "claude", "codex"]).optional().describe("Harness (optional if ID is unique)."),
  quick: z.boolean().optional().default(false).describe(
    "If true, produce a 1-3 sentence quick summary (cheaper). If false, produce a detailed structured summary."
  ),
});

export const ChangeModelSchema = z.object({
  sessionId: z.string().optional().describe(
    "Session ID to change model for. If omitted, changes the global default for the harness."
  ),
  harness: z.enum(["opencode", "claude", "codex"]).describe("Which harness to change model for."),
  model: z.string().describe("The model name to use (e.g. 'claude-sonnet-4-20250514', 'gpt-4o', 'o4-mini')."),
});

export const ListModelsSchema = z.object({
  harness: z.enum(["opencode", "claude", "codex"]).optional().describe(
    "Which harness to list models for. If omitted, lists models from all harnesses."
  ),
});

// ===== Tool definitions (static metadata) =====

export const toolDefinitions: Tool[] = [
  {
    name: "list_agents",
    description:
      "List all coding agent sessions across connected harnesses (OpenCode, Claude Code, Codex CLI). " +
      "Shows which agents are running, idle, need input, or stopped. Filter by harness, status, age, or folder. " +
      "Can include last message previews for quick context.",
    inputSchema: {
      type: "object" as const,
      properties: {
        harness: { type: "string", enum: ["all", "opencode", "claude", "codex"], default: "all", description: "Filter by harness" },
        status: { type: "string", enum: ["all", "running", "idle", "needs_input", "stopped", "error"], default: "all", description: "Filter by status" },
        limit: { type: "number", default: 50, description: "Max sessions to return" },
        maxAge: { type: "number", description: "Max session age in seconds (e.g. 3600 for 1h, 86400 for 24h)" },
        folder: { type: "string", description: "Filter by CWD prefix (e.g. '~/apps' for sessions in that tree)" },
        includeLastMessage: { type: "boolean", default: false, description: "Include last message preview" },
      },
    },
  },
  {
    name: "audit_worktrees",
    description:
      "Read-only audit of Git worktrees. Reports dirty files, lock reasons and PIDs, whether lock PIDs are still running, " +
      "and Claude/Codex/OpenCode processes whose cwd is inside each worktree.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repoPath: { type: "string", description: "Absolute or home-relative Git repository path" },
        includeClean: { type: "boolean", default: false, description: "Include clean and unlocked worktrees" },
      },
      required: ["repoPath"],
    },
  },
  {
    name: "agent_info",
    description:
      "Get detailed information about a specific agent session including status, model, " +
      "cost, duration, last message, and any pending permission requests. " +
      "Always shows the last message for quick context.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID to inspect" },
        harness: { type: "string", enum: ["opencode", "claude", "codex"], description: "Harness (optional)" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to an agent session. Supports three modes: " +
      "'sync' (wait for response), 'queue' (fire-and-forget), 'steer' (redirect agent's direction).",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Target session ID" },
        harness: { type: "string", enum: ["opencode", "claude", "codex"], description: "Harness (optional)" },
        message: { type: "string", description: "Message to send" },
        mode: { type: "string", enum: ["queue", "steer", "sync"], default: "sync", description: "Delivery mode" },
      },
      required: ["sessionId", "message"],
    },
  },
  {
    name: "stop_agent",
    description: "Stop / abort a running agent session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID to stop" },
        harness: { type: "string", enum: ["opencode", "claude", "codex"], description: "Harness (optional)" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "respond_permission",
    description:
      "Respond to a pending permission request from an agent (e.g. allow or deny a tool call). " +
      "Note: only OpenCode and Claude SDK support remote permission response.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session with pending permission" },
        harness: { type: "string", enum: ["opencode", "claude", "codex"], description: "Harness (optional)" },
        permissionId: { type: "string", description: "Permission request ID" },
        response: { type: "string", enum: ["allow", "deny"], description: "Allow or deny" },
        remember: { type: "boolean", description: "Remember this decision" },
      },
      required: ["sessionId", "permissionId", "response"],
    },
  },
  {
    name: "set_permissions",
    description:
      "Set permissions for an agent session. Controls which tools the agent can use. " +
      "Note: Claude Code and Codex set permissions at launch time, not per-session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Target session ID" },
        harness: { type: "string", enum: ["opencode", "claude", "codex"], description: "Harness (optional)" },
        allowedTools: { type: "string", description: "Comma-separated allowed tools, e.g. 'Read,Edit,Bash'" },
        mode: { type: "string", description: "Permission mode, e.g. 'fullAuto', 'plan', 'default'" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "resume_agent",
    description:
      "Resume a stopped or paused agent session. Optionally send a message to give it a new task.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID to resume" },
        harness: { type: "string", enum: ["opencode", "claude", "codex"], description: "Harness (optional)" },
        message: { type: "string", description: "Optional message to send when resuming" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "summarize_session",
    description:
      "Summarize a session's transcript using a built-in LLM (gemma4). " +
      "Produces a structured summary with Task, Progress, Current State, and Issues/Next Steps. " +
      "Use this instead of reading the full transcript to save tokens and context. " +
      "Supports 'quick' mode for a 1-3 sentence summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID to summarize" },
        harness: { type: "string", enum: ["opencode", "claude", "codex"], description: "Harness (optional)" },
        quick: { type: "boolean", default: false, description: "Quick 1-3 sentence summary instead of detailed" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "change_model",
    description:
      "Change the AI model for a harness. For OpenCode, changes model per-session or globally. " +
      "For Claude and Codex, model is set at session creation time — this updates the default " +
      "for future sessions or the next message sent via agent-herder.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID (optional, changes global default if omitted)" },
        harness: { type: "string", enum: ["opencode", "claude", "codex"], description: "Target harness" },
        model: { type: "string", description: "Model name (e.g. 'claude-sonnet-4-20250514', 'gpt-4o', 'o4-mini')" },
      },
      required: ["harness", "model"],
    },
  },
  {
    name: "list_models",
    description:
      "List available AI models for a harness. Shows model names that can be used with change_model.",
    inputSchema: {
      type: "object" as const,
      properties: {
        harness: { type: "string", enum: ["opencode", "claude", "codex"], description: "Harness to list models for (omit = all)" },
      },
    },
  },
];
