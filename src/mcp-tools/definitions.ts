import { Tool } from "@modelcontextprotocol/server";
import { z } from "zod";
import { MAX_MODEL_LENGTH } from "../automation-launch-policy.js";

// ===== Schemas for tool inputs =====

/** Machine identity of the work machine. One spelling per machine. */
const hostIdentity = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !/[\s\x00-\x1f\x7f/\\]/u.test(value), "hostId contains invalid characters");

/** Target machine of an operation. Absent means the local host (localhost). */
export const HOST_TARGET_DESCRIPTION =
  "Machine the work runs on; defaults to localhost (this Agent Herder host).";
/** Machine filter. Absent keeps every machine, which is the current behaviour. */
export const HOST_FILTER_DESCRIPTION =
  "Filter by machine. Omitted lists sessions of every machine.";

const hostTarget = (description: string) => hostIdentity.optional().describe(description);

export const ListAgentsSchema = z.object({
  harness: z
    .enum(["all", "opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt", "minimax-code", "browser-chat"])
    .optional()
    .default("all")
    .describe("Filter by harness. 'all' lists from every connected harness."),
  status: z
    .enum(["all", "running", "idle", "needs_input", "stopped", "error"])
    .optional()
    .default("all")
    .describe("Filter by agent status."),
  limit: z.number().int().min(1).max(100).optional().default(20).describe("Max sessions to return."),
  maxAge: z.number().int().min(0).optional().describe(
    "Maximum session age in seconds. Only return sessions active within this window. " +
    "Examples: 3600 = last hour, 86400 = last 24h, 604800 = last week. 0 or omit = no limit."
  ),
  folder: z.string().optional().describe(
    "Filter sessions by working directory prefix. " +
    "For example, '~/apps' will show only sessions whose CWD starts with that path. " +
    "Useful for finding all agent sessions working within a specific project tree."
  ),
  hostId: hostTarget(HOST_FILTER_DESCRIPTION),
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
    .enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt", "minimax-code", "browser-chat"])
    .optional()
    .describe("Which harness the session belongs to. If omitted, searches all."),
  hostId: hostTarget(HOST_TARGET_DESCRIPTION),
});

export const FindParentSchema = z.object({
  sessionId: z.string().describe("The child session ID whose parent should be found."),
  harness: z
    .enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt", "minimax-code", "browser-chat"])
    .optional()
    .describe("Which harness owns the session. If omitted, searches all."),
});

export const ListChildrenSchema = z.object({
  sessionId: z.string().describe("The parent session ID whose children should be listed."),
  harness: z
    .enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt", "minimax-code", "browser-chat"])
    .optional()
    .describe("Which harness owns the session. If omitted, searches all."),
});

export const ExportTranscriptSchema = z.object({
  sessionId: z.string().describe("The session ID whose raw source should be exported."),
  harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt", "minimax-code", "browser-chat"]).optional().describe("Which harness owns the session. If omitted, searches all."),
});

const meshIdentity = (max:number) => z.string().min(1).max(max).regex(/^[^\x00-\x1f\x7f]*$/);
export const MeshSenderSchema = z.object({
  hostId: meshIdentity(512),
  harness: meshIdentity(64),
  nativeSessionId: meshIdentity(512),
}).strict();

export const SendMessageSchema = z.object({
  inputId: z.string().min(1).max(256).optional().describe("Stable delivery ID. Retry with the same ID; Codex deduplicates native admission for 24 hours."),
  humanRequested: z.boolean().optional().describe("True only for an explicit human new task/send/resume. Otherwise coordination is active-turn-only and never wakes or defers to an inactive chat."),
  sessionId: z.string().describe("Target session ID."),
  harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt", "minimax-code", "browser-chat"]).optional().describe("Harness (optional if ID is unique)."),
  hostId: hostTarget(HOST_TARGET_DESCRIPTION),
  message: z.string().describe("Message to send to the agent."),
  fromSessionId: z.string().optional().describe("Supply your full native sender session ID for AI messages. Herder checks that session for reply attribution; this does not authenticate the caller. Omitted/unverified sources are labelled unknown."),
  fromHarness: z.enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt", "minimax-code", "browser-chat"]).optional().describe("Declared sender harness for checked reply attribution, not caller authentication."),
  meshSender: MeshSenderSchema.optional().describe("Declared remote mesh sender for the full-address automatic budget and attribution; not authentication. Takes precedence over legacy sender fields without local sender lookup. Cannot claim humanRequested."),
  mode: z.enum(["queue", "steer", "sync"]).optional().default("steer").describe(
    "For ordinary inter-agent exchange use explicit mode:\"steer\" (default): redirect the current active turn. queue is only intentional deferred work after current work finishes; it may wait hours and is not immediate exchange. sync waits for a response."
  ),
});

const NamedSessionBaseSchema = z.object({
  sourceSessions: z.array(z.object({ harness: z.enum(["codex", "zcode", "opencode", "fast-agent"]), sessionId: z.string().min(1).max(512) })).max(32).optional().describe("All verified native source/ancestor receipts for an automatic continuation. Any stopped source prohibits launch."),
  sourceSessionId: z.string().min(1).optional().describe("Original session ID when this creation is a continuation/replacement; a stopped source prohibits automatic creation."),
  sourceHarness: z.enum(["codex", "zcode", "opencode", "fast-agent"]).optional(),
  harness: z.enum(["opencode", "codex", "zcode", "fast-agent", "chatgpt", "browser-chat"]).describe("Harness that owns the named session."),
  name: z.string().trim().min(1).max(128).describe("Stable session name, for example repair_100."),
  cwd: z.string().min(1).describe("Absolute working directory. It is canonicalized before identity matching."),
  hostId: hostTarget(HOST_TARGET_DESCRIPTION),
  model: z.string().trim().min(1).max(MAX_MODEL_LENGTH).regex(/^[^\u0000-\u001f\u007f]*$/).optional().describe("Optional model selected before the first message is delivered."),
  serviceTier: z.enum(["normal", "fast"]).optional().describe("Codex only. Applies only if a new session is created; defaults to normal and never changes an existing named session."),
});

export const CreateSessionSchema = NamedSessionBaseSchema;

export const NewOrResumeSchema = NamedSessionBaseSchema.extend({
  inputId: z.string().min(1).max(256).optional(),
  fallbackModels: z.array(z.string().trim().min(1).max(MAX_MODEL_LENGTH).regex(/^[^\u0000-\u001f\u007f]*$/)).max(8).optional()
    .describe("Optional ordered same-harness fallback models. When omitted, OpenCode GLM 5.3 Flash defaults to MiniMax M3.1 Flash. Used only after a definite pre-admission HTTP 429 or provider quota rejection."),
  humanRequested: z.boolean().optional().describe("True only for an explicit human continuation request; never inferred by an automated planner."),
  message: z.string().min(1).refine((message) => message.trim().length > 0, "Message cannot be blank").describe("Message delivered to the created or reused session."),
  mode: z.enum(["queue", "sync"]).optional().default("sync").describe(
    "queue returns after a bounded launcher handoff and may be accepted_unconfirmed; sync waits for the adapter's completed response."
  ),
});

export const DeliverSchema = z.object({
  inputId: z.string().min(1).max(256).optional().describe("Stable delivery ID. Retry with the same ID; Codex deduplicates native admission for 24 hours."),
  sourceSessions: z.array(z.object({ harness: z.enum(["codex", "zcode", "opencode", "fast-agent"]), sessionId: z.string().min(1).max(512) })).max(32).optional(),
  sourceSessionId: z.string().min(1).max(512).optional().describe("Original native ID for an automatic continuation/replacement; stopped sources prohibit it."),
  sourceHarness: z.enum(["codex", "zcode", "opencode", "fast-agent"]).optional(),
  sessionId: z.string().optional().describe("Exact target session ID. Use either sessionId or harness+name+cwd."),
  harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt", "minimax-code", "browser-chat"]).optional(),
  hostId: hostTarget(HOST_TARGET_DESCRIPTION),
  name: z.string().trim().min(1).max(128).optional(),
  cwd: z.string().min(1).optional(),
  message: z.string().min(1).refine((message) => message.trim().length > 0, "Message cannot be blank"),
  create: z.enum(["if_missing", "never"]).optional().default("if_missing").describe("Named targets only: create the session if it does not exist, or fail with never."),
  activation: z.enum(["always", "if_running", "defer"]).optional().describe("Omitted: active-turn-only for existing targets; initial task starts a newly created named target. Explicit always starts/wakes a task; if_running never wakes/defers; defer explicitly retains input for later."),
  mode: z.enum(["queue", "sync"]).optional().default("queue"),
  model: z.string().trim().min(1).max(MAX_MODEL_LENGTH).regex(/^[^\u0000-\u001f\u007f]*$/).optional(),
}).superRefine((v,ctx)=>{
  const named=Boolean(v.harness && v.name && v.cwd);
  if (!v.sessionId && !named) ctx.addIssue({code:z.ZodIssueCode.custom,message:"Provide sessionId or harness+name+cwd"});
  if (v.sessionId && (v.name || v.cwd)) ctx.addIssue({code:z.ZodIssueCode.custom,message:"Use either sessionId or named target fields, not both"});
});

/** Override the work machine and/or work directory of an already live session. */
export const SetSessionTargetSchema = z.object({
  sessionId: z.string().trim().min(1).max(512).describe("Exact native session ID whose work target is overridden."),
  harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt", "minimax-code", "browser-chat"]).optional().describe("Harness (optional if the ID is unique)."),
  hostId: hostTarget("Work machine the session runs on; defaults to the current machine of that session."),
  cwd: z.string().trim().min(1).max(4096).optional().describe("Work directory on the target machine."),
}).superRefine((v,ctx)=>{
  if (v.hostId === undefined && v.cwd === undefined) ctx.addIssue({code:z.ZodIssueCode.custom,message:"Provide hostId or cwd"});
});

/** Receipt of one work-target override. Never claims success for an unreachable machine. */
export const SetSessionTargetResultSchema = z.object({
  sessionId: z.string(),
  harness: z.string(),
  hostId: z.string(),
  cwd: z.string(),
  previous: z.object({ hostId: z.string(), cwd: z.string() }),
  state: z.enum(["updated", "unchanged", "unreachable", "unsupported"]),
  reason: z.string().optional(),
});

export const StopAgentSchema = z.object({
  sessionId: z.string().describe("Session ID to stop."),
  harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt", "minimax-code", "browser-chat"]).optional().describe("Harness (optional if ID is unique)."),
  hostId: z.string().trim().min(1).max(512).optional().describe("Machine that owns the session. Omitted stops a session of this machine; another machine is stopped through its own native session."),
});

export const RespondPermissionSchema = z.object({
  sessionId: z.string().describe("Session with pending permission."),
  harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt", "browser-chat"]).optional(),
  permissionId: z.string().describe("The permission request ID."),
  response: z.enum(["allow", "deny"]).describe("Whether to allow or deny."),
  remember: z.boolean().optional().describe("Remember this decision for future requests."),
});

export const SetPermissionsSchema = z.object({
  sessionId: z.string().describe("Target session ID."),
  harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt", "browser-chat"]).optional(),
  allowedTools: z.string().optional().describe("Comma-separated list of allowed tools (e.g. 'Read,Edit,Bash')."),
  mode: z.string().optional().describe("Permission mode (e.g. 'fullAuto', 'plan', 'default')."),
});

export const ResumeAgentSchema = z.object({
  humanRequested: z.boolean().optional().describe("Required true to release an explicit stop, only when the human explicitly requested it. Automatic recovery must omit it."),
  sessionId: z.string().describe("Session ID to resume."),
  harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt", "browser-chat"]).optional(),
  message: z.string().optional().describe("Optional message to send when resuming."),
});

export const ChangeModelSchema = z.object({
  sessionId: z.string().optional().describe(
    "Session ID to change model for. If omitted, changes the global default for the harness."
  ),
  harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt", "browser-chat"]).describe("Which harness to change model for."),
  model: z.string().describe("The model name to use (e.g. 'claude-sonnet-4-20250514', 'gpt-4o', 'o4-mini')."),
});

export const ListModelsSchema = z.object({
  harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt", "browser-chat"]).optional().describe(
    "Which harness to list models for. If omitted, lists models from all harnesses."
  ),
});

export const CoordinationNoteCreateSchema = z.object({
  authorSessionId: z.string().trim().min(1).max(256), authorHarness: z.string().trim().min(1).max(64).optional(),
  cwd: z.string().min(1), paths: z.array(z.string().min(1).max(4096)).max(64).optional().default([]),
  kind: z.enum(["working", "avoid", "handoff", "info"]).optional().default("working"), message: z.string().trim().min(1).max(4000),
  ttlSeconds: z.number().int().min(60).max(604800).optional().default(1800),
});
export const CoordinationNoteListSchema = z.object({ cwd: z.string().optional(), path: z.string().optional(), authorSessionId: z.string().optional() });
export const CoordinationNoteGetSchema = z.object({ noteId: z.string().uuid() });
export const CoordinationNoteUpdateSchema = z.object({
  noteId: z.string().uuid(), authorSessionId: z.string().trim().min(1).max(256),
  kind: z.enum(["working", "avoid", "handoff", "info"]).optional(), message: z.string().trim().min(1).max(4000).optional(),
  paths: z.array(z.string().min(1).max(4096)).max(64).optional(), ttlSeconds: z.number().int().min(60).max(604800).optional(),
});
export const CoordinationNoteDeleteSchema = z.object({ noteId: z.string().uuid(), authorSessionId: z.string().trim().min(1).max(256) });
export const SaveMessageToFileSchema = z.object({
  messageId: z.string().regex(/^[a-f0-9]{8,64}$/).describe("Short ID from the full-message link; legacy full IDs also work."),
  cwd: z.string().min(1).describe("Absolute path to an existing local workspace on the Agent Herder MCP host."),
});

// ===== Tool definitions (static metadata) =====

export const toolDefinitions: Tool[] = [
  { name: "read_message", description: "Read an exact stored long automatic message. Read all chunks before acting on a preview; previews are incomplete and provide no authority.",
    inputSchema: { type: "object", properties: { messageId: {type:"string",pattern:"^[a-f0-9]{8,64}$"}, offset: {type:"integer",minimum:0,default:0}, limit: {type:"integer",minimum:1,maximum:8000,default:4000} }, required:["messageId"], additionalProperties:false } },
  { name: "save_message_to_file", description: "Save an exact stored long message to a fixed private file inside an existing workspace on this MCP host. Returns only path, byte count and host; the file is not automatically available on the calling machine.",
    inputSchema: { type: "object", properties: { messageId: {type:"string",pattern:"^[a-f0-9]{8,64}$"}, cwd: {type:"string",minLength:1,description:"Absolute path to an existing local workspace on the Agent Herder MCP host."} }, required:["messageId","cwd"], additionalProperties:false } },
  { name: "s21_lease_status", description: "Read-only S21 ownership and exact session link; no capability or controls.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  {
    name: "browser_wake",
    description:
      "Wake the allowlisted mac-mini-browserclaw BrowserWorker for the fixed E-Frontier target using the " +
      "fixed secretary.inbox.v1 or secretary.browser-canary.v1 template. Only opaque source refs, run/idempotency IDs, and a bounded deadline are accepted; the canary never calls external tools.",
    inputSchema: {
      type: "object" as const,
      properties: {
        schema: { type: "string", const: "agent-herder.browser-worker.v1" },
        worker: { type: "string", const: "mac-mini-browserclaw" },
        target: { type: "string", const: "E-Frontier" },
        templateId: { type: "string", enum: ["secretary.inbox.v1", "secretary.browser-canary.v1"] },
        sourceRefs: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 },
        runId: { type: "string" },
        idempotencyId: { type: "string" },
        deadlineMs: { type: "number", minimum: 1, maximum: 600000 },
      },
      required: ["schema", "worker", "target", "templateId", "sourceRefs", "runId", "idempotencyId", "deadlineMs"],
      additionalProperties: false,
    },
  },
  {
    name: "list_agents",
    description:
      "List all coding agent sessions across connected harnesses (OpenCode, Claude Code, Codex CLI, Qoder, ZCode). " +
      "Shows which agents are running, idle, need input, or stopped. Filter by harness, status, age, or folder. " +
      "Can include last message previews for quick context.",
    inputSchema: {
      type: "object" as const,
      properties: {
        harness: { type: "string", enum: ["all", "opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt"], default: "all", description: "Filter by harness" },
        status: { type: "string", enum: ["all", "running", "idle", "needs_input", "stopped", "error"], default: "all", description: "Filter by status" },
        limit: { type: "number", default: 20, description: "Max sessions to return" },
        maxAge: { type: "number", description: "Max session age in seconds (e.g. 3600 for 1h, 86400 for 24h)" },
        folder: { type: "string", description: "Filter by CWD prefix (e.g. '~/apps' for sessions in that tree)" },
        hostId: { type: "string", description: "Filter by machine; omitted lists sessions of every machine" },
        includeLastMessage: { type: "boolean", default: false, description: "Include last message preview" },
      },
    },
  },
  {
    name: "audit_worktrees",
    description:
      "Read-only audit of Git worktrees. Reports dirty files, lock reasons and PIDs, whether lock PIDs are still running, " +
      "and Claude/Codex/OpenCode/ZCode processes whose cwd is inside each worktree.",
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
    name: "create_session",
    description: "Create one named OpenCode, Codex, ZCode, or Fast Agent session in an absolute canonical working directory.",
    inputSchema: {
      type: "object" as const,
      properties: {
        harness: { type: "string", enum: ["opencode", "codex", "zcode", "fast-agent"], description: "Target harness" },
        name: { type: "string", description: "Stable session name, for example repair_100" },
        cwd: { type: "string", description: "Absolute working directory" },
        hostId: { type: "string", description: "Machine the work runs on; defaults to localhost (this Agent Herder host)" },
        model: { type: "string", maxLength: MAX_MODEL_LENGTH, description: "Optional model selected before first delivery" },
      },
      required: ["harness", "name", "cwd"],
    },
  },
  {
    name: "new_or_resume",
    description: "Reuse the exact named session for harness+CWD or create it, then deliver one message. OpenCode GLM 5.3 Flash uses MiniMax M3.1 Flash as its default fallback after a pre-admission HTTP 429 or provider quota rejection; fallbackModels overrides that route. Unknown/accepted delivery and manual stops never trigger fallback. Call model_quotas to inspect current provider allowances.",
    inputSchema: {
      type: "object" as const,
      properties: {
        harness: { type: "string", enum: ["opencode", "codex", "zcode", "fast-agent"], description: "Target harness" },
        name: { type: "string", description: "Stable session name, for example repair_100" },
        cwd: { type: "string", description: "Absolute working directory" },
        hostId: { type: "string", description: "Machine the work runs on; defaults to localhost (this Agent Herder host)" },
        message: { type: "string", description: "Message to deliver" },
        mode: { type: "string", enum: ["queue", "sync"], default: "sync", description: "Delivery mode" },
        model: { type: "string", maxLength: MAX_MODEL_LENGTH, description: "Optional model selected before first delivery" },
        fallbackModels: { type: "array", maxItems: 8, items: { type: "string", maxLength: MAX_MODEL_LENGTH }, description: "Optional ordered same-harness fallbacks; if omitted, OpenCode GLM 5.3 Flash defaults to MiniMax M3.1 Flash. Used only after a definite pre-admission HTTP 429 or provider quota rejection." },
      },
      required: ["harness", "name", "cwd", "message"],
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
        harness: { type: "string", enum: ["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt", "minimax-code", "browser-chat"], description: "Harness (required for a remote host)" },
        hostId: { type: "string", description: "Machine the work runs on; defaults to localhost (this Agent Herder host)" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "find_parent",
    description: "Find the native parent session of an agent session when the harness exposes session lineage.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Child session ID" },
        harness: { type: "string", enum: ["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt"], description: "Harness (optional)" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "list_children",
    description: "List the native child sessions of an agent session when the harness exposes session lineage.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Parent session ID" },
        harness: { type: "string", enum: ["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt"], description: "Harness (optional)" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "export_transcript",
    description: "Export raw transcript material and return its filesystem navigation card.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID" },
        harness: { type: "string", enum: ["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt"], description: "Harness (optional)" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "coordination_note_create",
    description: "Publish a TTL coordination note for other agents in the same workspace. Use paths for files/directories you are actively changing or want others to avoid.",
    inputSchema: { type: "object" as const, properties: { authorSessionId: { type: "string" }, authorHarness: { type: "string" }, cwd: { type: "string" }, paths: { type: "array", items: { type: "string" } }, kind: { type: "string", enum: ["working", "avoid", "handoff", "info"] }, message: { type: "string" }, ttlSeconds: { type: "number", minimum: 60, maximum: 604800, default: 1800 } }, required: ["authorSessionId", "cwd", "message"] },
  },
  { name: "coordination_note_list", description: "List active TTL coordination notes. Notes are also injected automatically into new Agent Herder-delivered turns; use this tool for explicit inspection.", inputSchema: { type: "object" as const, properties: { cwd: { type: "string" }, path: { type: "string" }, authorSessionId: { type: "string" } } } },
  { name: "coordination_note_get", description: "Read one active coordination note by ID.", inputSchema: { type: "object" as const, properties: { noteId: { type: "string" } }, required: ["noteId"] } },
  { name: "coordination_note_update", description: "Edit your own coordination note: text, kind, paths, or TTL. authorSessionId must match the note owner.", inputSchema: { type: "object" as const, properties: { noteId: { type: "string" }, authorSessionId: { type: "string" }, kind: { type: "string", enum: ["working", "avoid", "handoff", "info"] }, message: { type: "string" }, paths: { type: "array", items: { type: "string" } }, ttlSeconds: { type: "number", minimum: 60, maximum: 604800 } }, required: ["noteId", "authorSessionId"] } },
  { name: "coordination_note_delete", description: "Delete your own coordination note before its TTL expires. authorSessionId must match the note owner.", inputSchema: { type: "object" as const, properties: { noteId: { type: "string" }, authorSessionId: { type: "string" } }, required: ["noteId", "authorSessionId"] } },
  {
    name: "send_message",
    description:
      "Ordinary coordination sends only to an active native turn; it never wakes an inactive/completed target or stores deferred debt. humanRequested=true is for an explicit human new task/send/resume. Agent Herder automatically injects active coordination notes for the target workspace before delivery. Supports three modes: " +
      "Use explicit mode:\"steer\" for ordinary inter-agent exchange; steer is the default and redirects the current active turn. 'queue' is only intentional deferred work after current work finishes, may wait hours, and is not immediate exchange. 'sync' waits for response.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Target session ID" },
        hostId: { type: "string", description: "Machine the work runs on; defaults to localhost (this Agent Herder host)" },
        humanRequested: {type:"boolean",description:"True only for an explicit human new task/send/resume; automatic coordination must omit it."},
        inputId: { type: "string", description: "Stable idempotent delivery ID (Codex: 24 hour retry window)" },
        harness: { type: "string", enum: ["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt"], description: "Harness (optional)" },
        message: { type: "string", description: "Message to send" },
        fromSessionId: { type: "string", description: "Supply your full native sender session ID for AI messages. Herder checks that session for reply attribution; this does not authenticate the caller. Omitted/unverified sources are labelled unknown." },
        fromHarness: { type: "string", enum: ["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt"], description: "Declared sender harness for checked reply attribution, not caller authentication (optional)" },
        meshSender: { type: "object", additionalProperties: false, properties: {
          hostId: { type: "string", minLength: 1, maxLength: 512, pattern: "^[^\\x00-\\x1f\\x7f]*$" },
          harness: { type: "string", minLength: 1, maxLength: 64, pattern: "^[^\\x00-\\x1f\\x7f]*$" },
          nativeSessionId: { type: "string", minLength: 1, maxLength: 512, pattern: "^[^\\x00-\\x1f\\x7f]*$" },
        }, required: ["hostId", "harness", "nativeSessionId"], description: "Declared automatic mesh sender; full-address budget, no local lookup, not authentication or human origin. Overrides legacy sender attribution when supplied." },
        mode: { type: "string", enum: ["queue", "steer", "sync"], default: "steer", description: "Use explicit steer for ordinary exchange (default). queue intentionally waits until current work finishes and may wait hours; sync waits for response." },
      },
      required: ["sessionId", "message"],
    },
  },
  {
    name: "deliver",
    description: "High-level agent delivery. Target by sessionId or harness+name+cwd. create controls whether a missing named session is created. Omitted activation is active-turn-only for existing targets (idle targets answer skipped_inactive with a nextAction hint); a newly created named target receives its initial task. Explicit activation=always may wake/start the agent; if_running only delivers while currently running; defer stores for the next Agent Herder-delivered turn without waking an inactive target. Deliveries that may wake a target park durably first, and a background sweeper delivers parked messages once the target is idle, so interrupted jobs do not lose them. Herder evaluates activity at delivery time, so callers should not pre-check with list_agents.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" }, harness: { type: "string", enum: ["opencode","claude","codex","qoder","hermes","zcode","fast-agent", "chatgpt"] },
        hostId: { type: "string", description: "Machine the work runs on; defaults to localhost (this Agent Herder host)" },
        name: { type: "string" }, cwd: { type: "string" }, message: { type: "string" },
        inputId: { type: "string", description: "Stable idempotent delivery ID (Codex: 24 hour retry window)" },
        create: { type: "string", enum: ["if_missing","never"], default: "if_missing" },
        activation: { type: "string", enum: ["always","if_running","defer"] },
        mode: { type: "string", enum: ["queue","sync"], default: "queue" }, model: { type: "string" },
      },
      required: ["message"],
    },
  },
  {
    name: "set_session_target",
    description:
      "Override the work machine and/or work directory of an already live session. " +
      "The machine defaults to the current machine of that session and the directory defaults to its current one; " +
      "at least one of hostId and cwd must be given. An unreachable machine is reported as unreachable, never as applied.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Exact native session ID" },
        harness: { type: "string", enum: ["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt", "minimax-code", "browser-chat"], description: "Harness (optional if the ID is unique)" },
        hostId: { type: "string", description: "Work machine the session runs on; defaults to the current machine of that session" },
        cwd: { type: "string", description: "Work directory on the target machine" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "stop_agent",
    description: "Stop / abort a running agent session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session ID to stop" },
        harness: { type: "string", enum: ["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt"], description: "Harness (optional)" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "respond_permission",
    description:
      "Respond to a pending permission request from an agent (e.g. allow or deny a tool call). " +
      "OpenCode, Claude SDK, and ZCode support remote permission response.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "Session with pending permission" },
        harness: { type: "string", enum: ["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt"], description: "Harness (optional)" },
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
        harness: { type: "string", enum: ["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt"], description: "Harness (optional)" },
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
        harness: { type: "string", enum: ["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt"], description: "Harness (optional)" },
        message: { type: "string", description: "Optional message to send when resuming" },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "get_service_tier",
    description: "Read the observed Fast/Normal tier of one exact existing Codex session. Unknown is not Normal; no turn starts.",
    inputSchema: { type: "object" as const, properties: {
      sessionId: { type: "string", description: "Exact existing Codex session ID" },
      harness: { type: "string", enum: ["codex"] },
      hostId: { type: "string", description: "Owning host; omitted uses this host" },
    }, required: ["sessionId"] },
  },
  {
    name: "set_service_tier",
    description: "Set Fast/Normal for subsequent turns of one existing Codex session, preserving model and reasoning. No resume or interrupt; requires native confirmation.",
    inputSchema: { type: "object" as const, properties: {
      sessionId: { type: "string", description: "Exact existing Codex session ID" },
      harness: { type: "string", enum: ["codex"] },
      hostId: { type: "string", description: "Owning host; omitted uses this host" },
      serviceTier: { type: "string", enum: ["normal", "fast"] },
    }, required: ["sessionId", "serviceTier"] },
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
        harness: { type: "string", enum: ["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt"], description: "Target harness" },
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
        harness: { type: "string", enum: ["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "chatgpt"], description: "Harness to list models for (omit = all)" },
      },
    },
  },
  {
    name: "model_quotas",
    description: "Read the current GLM Coding Plan, MiniMax Token Plan, and local Codex usage allowances. Missing credentials or unsupported account plans are reported as unknown; values are never inferred.",
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
  },
];
