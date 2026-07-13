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

// ===== Tool definitions (static metadata) =====

export const toolDefinitions: Tool[] = [
  {
    name: "list_agents",
    description:
      "List all coding agent sessions across connected harnesses (OpenCode, Claude Code, Codex CLI). " +
      "Shows which agents are running, idle, need input, or stopped. Filter by harness or status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        harness: { type: "string", enum: ["all", "opencode", "claude", "codex"], default: "all", description: "Filter by harness" },
        status: { type: "string", enum: ["all", "running", "idle", "needs_input", "stopped", "error"], default: "all", description: "Filter by status" },
        limit: { type: "number", default: 50, description: "Max sessions to return" },
      },
    },
  },
  {
    name: "agent_info",
    description:
      "Get detailed information about a specific agent session including status, model, " +
      "cost, duration, and any pending permission requests.",
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
      "Note: only OpenCode supports remote permission response. Claude Code and Codex handle permissions at launch time.",
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
];