#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { HarnessAdapter } from "./types/index.js";
import { OpenCodeAdapter, ClaudeCodeAdapter, ClaudeSDKAdapter, CodexAdapter, CodexAppServerAdapter, AcpAdapter, HermesAdapter } from "./adapters/index.js";
import { HumanRequestRegistry } from "./human-request/index.js";
import { AgentHerderSessionConverter } from "./session-convert.js";
import { createWebServer } from "./web/server.js";
import {
  handleListAgents,
  handleAgentInfo,
  handleFindParent,
  handleListChildren,
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
} from "./mcp-tools/handlers.js";

// ===== Configuration from environment =====

const ENABLE_OPENCODE = parseEnvBool(process.env.ENABLE_OPENCODE, true);
const ENABLE_CLAUDE = parseEnvBool(process.env.ENABLE_CLAUDE, true);
const ENABLE_CLAUDE_SDK = parseEnvBool(process.env.ENABLE_CLAUDE_SDK, true);
const ENABLE_CODEX = parseEnvBool(process.env.ENABLE_CODEX, true);
const CODEX_TRANSPORT = process.env.CODEX_TRANSPORT || "app-server";
const ENABLE_QODER = parseEnvBool(process.env.ENABLE_QODER, false);
const ENABLE_HERMES = parseEnvBool(process.env.ENABLE_HERMES, false);
const ACP_AGENT_COMMAND = process.env.ACP_AGENT_COMMAND;

function parseEnvBool(val: string | undefined, fallback: boolean): boolean {
  if (!val) return fallback;
  return val === "1" || val === "true" || val === "yes";
}

// ===== Create adapters =====

const adapters = new Map<string, HarnessAdapter>();
const humanRequests = new HumanRequestRegistry(process.env.AGENT_HERDER_HUMAN_REQUEST_STORE || ".agent-herder/human-requests.json");

async function initAdapters() {
  const inits: Promise<void>[] = [];

  if (ENABLE_OPENCODE) {
    const adapter = new OpenCodeAdapter({
      baseUrl: process.env.OPENCODE_URL,
      password: process.env.OPENCODE_SERVER_PASSWORD,
    });
    adapters.set("opencode", adapter);
    inits.push(
      adapter.init().catch((err) => {
        console.error(`[agent-herder] OpenCode adapter failed to init: ${(err as Error).message}`);
        adapters.delete("opencode");
      })
    );
  }

  if (ENABLE_CLAUDE) {
    if (ENABLE_CLAUDE_SDK) {
      const sdkAdapter = new ClaudeSDKAdapter();
      inits.push(
        sdkAdapter.init()
          .then(() => {
            adapters.set("claude", sdkAdapter);
            console.error("[agent-herder] Claude Agent SDK adapter initialized");
          })
          .catch((err) => {
            console.error(`[agent-herder] Claude SDK adapter failed, trying CLI fallback: ${(err as Error).message}`);
            const cliAdapter = new ClaudeCodeAdapter({
              claudeBin: process.env.CLAUDE_BIN,
            });
            cliAdapter.init()
              .then(() => adapters.set("claude", cliAdapter))
              .catch((err2) => {
                console.error(`[agent-herder] Claude CLI adapter also failed: ${(err2 as Error).message}`);
              });
          })
      );
    } else {
      const adapter = new ClaudeCodeAdapter({
        claudeBin: process.env.CLAUDE_BIN,
      });
      adapters.set("claude", adapter);
      inits.push(
        adapter.init().catch((err) => {
          console.error(`[agent-herder] Claude Code adapter failed to init: ${(err as Error).message}`);
          adapters.delete("claude");
        })
      );
    }
  }

  if (ENABLE_CODEX) {
    if (CODEX_TRANSPORT === "cli") {
      const adapter = new CodexAdapter({
        codexBin: process.env.CODEX_BIN,
        codexDir: process.env.CODEX_DATA_DIR,
      });
      adapters.set("codex", adapter);
      inits.push(
        adapter.init().catch((err) => {
          console.error(`[agent-herder] Codex CLI adapter failed to init: ${(err as Error).message}`);
          adapters.delete("codex");
        })
      );
    } else {
      const nativeAdapter = new CodexAppServerAdapter({
        codexBin: process.env.CODEX_BIN,
        cwd: process.env.CODEX_CWD,
        modelIds: parseCsv(process.env.CODEX_MODELS, ["o4-mini", "o3", "gpt-4.1", "gpt-4o"]),
      });
      adapters.set("codex", nativeAdapter);
      inits.push(
        nativeAdapter.init().catch(async (err) => {
          console.error(`[agent-herder] Codex app-server failed, trying CLI fallback: ${(err as Error).message}`);
          const fallback = new CodexAdapter({
            codexBin: process.env.CODEX_BIN,
            codexDir: process.env.CODEX_DATA_DIR,
          });
          try {
            await fallback.init();
            adapters.set("codex", fallback);
          } catch (fallbackError) {
            console.error(`[agent-herder] Codex CLI fallback also failed: ${(fallbackError as Error).message}`);
            adapters.delete("codex");
          }
        })
      );
    }
  }

  if (ENABLE_QODER) {
    const qoderArgs = parseArgs(process.env.QODER_ARGS, "QODER_ARGS");
    const model = process.env.QODER_MODEL;
    const adapter = new AcpAdapter({
      profile: "qoder",
      harness: "qoder",
      command: process.env.QODER_BIN || "qodercli",
      args: [...qoderArgs, "--acp", ...(model ? ["--model", model] : [])],
      cwd: process.env.QODER_CWD || process.cwd(),
      modelIds: parseCsv(process.env.QODER_MODELS, ["Ultimate", "Lite"]),
    });
    adapters.set("qoder", adapter);
    inits.push(
      adapter.init().catch((err) => {
        console.error(`[agent-herder] Qoder adapter failed to init: ${(err as Error).message}`);
        adapters.delete("qoder");
      })
    );
  }

  if (ENABLE_HERMES) {
    const adapter = new HermesAdapter({ hermesBin: process.env.HERMES_BIN, cwd: process.env.HERMES_CWD });
    adapters.set("hermes", adapter);
    inits.push(adapter.init().catch((err) => {
      console.error(`[agent-herder] Hermes adapter failed to init: ${(err as Error).message}`);
      adapters.delete("hermes");
    }));
  }

  if (ACP_AGENT_COMMAND) {
    const profile = process.env.ACP_AGENT_PROFILE || "claude-acp";
    const adapter = new AcpAdapter({
      profile,
      command: ACP_AGENT_COMMAND,
      args: parseArgs(process.env.ACP_AGENT_ARGS),
      cwd: process.env.ACP_AGENT_CWD || process.cwd(),
    });
    adapters.set(profile, adapter);
    inits.push(
      adapter.init().catch((err) => {
        console.error(`[agent-herder] ACP adapter '${profile}' failed to init: ${(err as Error).message}`);
        adapters.delete(profile);
      })
    );
  }

  await Promise.allSettled(inits);

  const names = [...adapters.keys()].join(", ");
  console.error(`[agent-herder] Ready with harnesses: ${names || "none"}`);
}

function parseArgs(value: string | undefined, variableName = "ACP_AGENT_ARGS"): string[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((arg) => typeof arg === "string")) {
    throw new Error(`${variableName} must be a JSON array of strings`);
  }
  return parsed;
}

function parseCsv(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  const models = value.split(",").map((model) => model.trim()).filter(Boolean);
  return models.length > 0 ? models : fallback;
}

// ===== Register MCP tools =====

function registerTools(server: McpServer) {
  server.tool(
    "human_request_create",
    "Create an opaque Ask User or Ask Secret request bound to an existing harness session. Hermes requires its immutable hermes.locator.v2 locator; Agent Herder never discovers a replacement session. Notification routing is explicit.",
    {
      kind: z.enum(["user", "secret"]),
      harness: z.string().min(1), sessionId: z.string().min(1), cwd: z.string().min(1).optional(), marker: z.string().min(1).optional(),
      locator: z.record(z.string(), z.unknown()).optional(), contextRef: z.string().optional(),
      notify: z.object({ project: z.string().min(1), recipient: z.string().min(1), kind: z.string().min(1), severity: z.string().min(1), title: z.string().min(1) }).optional(),
    },
    async (args) => {
      if (args.harness === "hermes" && !args.locator) throw new Error("Hermes human request requires an immutable hermes.locator.v2 locator");
      return { content: [{ type: "text" as const, text: JSON.stringify(await humanRequests.create({ kind: args.kind, target: { harness: args.harness, sessionId: args.sessionId, ...(args.cwd ? { cwd: args.cwd } : {}), ...(args.marker ? { marker: args.marker } : {}), ...(args.locator ? { locator: args.locator } : {}) }, contextRef: args.contextRef, notify: args.notify })) }] };
    }
  );
  server.tool(
    "human_request_resolve",
    "Resolve a Human Request with only an opaque provider result reference and return continuation intent.",
    { requestId: z.string().uuid(), resolutionRef: z.string().optional() },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await humanRequests.resolve(args.requestId, { continuation: "resume", resolutionRef: args.resolutionRef })) }] })
  );
  server.tool(
    "human_request_get",
    "Read opaque Human Request lifecycle and routing metadata.",
    { requestId: z.string().uuid() },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await humanRequests.get(args.requestId)) }] })
  );
  server.tool(
    "human_request_bind_notify_incident",
    "Persist the opaque incident identifier returned by Notify for a Human Request with explicit notification routing.",
    { requestId: z.string().uuid(), incidentId: z.string().min(1) },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await humanRequests.bindNotifyIncident(args.requestId, args.incidentId)) }] })
  );
  server.tool(
    "list_agents",
    "List all coding agent sessions. Filter by harness, status, age (maxAge seconds), or folder (CWD prefix like ~/apps). Can show last message preview.",
    {
      harness: z.enum(["all", "opencode", "claude", "codex", "qoder", "hermes"]).optional().default("all").describe("Filter by harness"),
      status: z.enum(["all", "running", "idle", "needs_input", "stopped", "error"]).optional().default("all").describe("Filter by status"),
      limit: z.number().int().min(1).max(100).optional().default(50).describe("Max sessions"),
      maxAge: z.number().int().min(0).optional().describe("Max session age in seconds (e.g. 3600=1h, 86400=24h)"),
      folder: z.string().optional().describe("Filter by CWD prefix (e.g. '~/apps')"),
      includeLastMessage: z.boolean().optional().default(false).describe("Include last message preview"),
    },
    async (args) => {
      const result = await handleListAgents(adapters, args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "audit_worktrees",
    "Read-only Git worktree audit: dirty files, lock/PID state, and Claude/Codex/OpenCode processes whose cwd is inside each worktree.",
    {
      repoPath: z.string().describe("Absolute or home-relative path to a Git repository"),
      includeClean: z.boolean().optional().default(false).describe("Include clean and unlocked worktrees"),
    },
    async (args) => {
      const result = await handleAuditWorktrees(args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "agent_info",
    "Get detailed info about a specific session. Always shows model and last message.",
    {
      sessionId: z.string().describe("Session ID to inspect"),
      harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes"]).optional().describe("Harness type"),
    },
    async (args) => {
      const result = await handleAgentInfo(adapters, args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "find_parent",
    "Find the native parent session of an agent session.",
    {
      sessionId: z.string().describe("Child session ID"),
      harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes"]).optional().describe("Harness type"),
    },
    async (args) => {
      const result = await handleFindParent(adapters, args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "list_children",
    "List the native child sessions of an agent session.",
    {
      sessionId: z.string().describe("Parent session ID"),
      harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes"]).optional().describe("Harness type"),
    },
    async (args) => {
      const result = await handleListChildren(adapters, args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "export_transcript",
    "Export the raw adapter-owned transcript and return a filesystem navigation card.",
    {
      sessionId: z.string().describe("Session ID"),
      harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes"]).optional().describe("Harness type"),
    },
    async (args) => {
      const result = await handleExportTranscript(adapters, args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "send_message",
    "Send a message to an agent. Modes: sync (wait), queue (fire-and-forget), steer (redirect).",
    {
      sessionId: z.string().describe("Target session ID"),
      harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes"]).optional().describe("Harness type"),
      message: z.string().describe("Message to send"),
      mode: z.enum(["queue", "steer", "sync"]).optional().default("sync").describe("Delivery mode"),
    },
    async (args) => {
      const result = await handleSendMessage(adapters, args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "create_session",
    "Create one named OpenCode or Codex session in an absolute canonical working directory.",
    {
      harness: z.enum(["opencode", "codex"]).describe("Target harness"),
      name: z.string().min(1).max(128).describe("Stable session name"),
      cwd: z.string().min(1).describe("Absolute working directory"),
    },
    async (args) => {
      const result = await handleCreateSession(adapters, args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "new_or_resume",
    "Reuse the exact named session for harness+CWD or create it, then deliver one message.",
    {
      harness: z.enum(["opencode", "codex"]).describe("Target harness"),
      name: z.string().min(1).max(128).describe("Stable session name"),
      cwd: z.string().min(1).describe("Absolute working directory"),
      message: z.string().min(1).describe("Message to deliver"),
      mode: z.enum(["queue", "sync"]).optional().default("sync").describe("Delivery mode"),
    },
    async (args) => {
      const result = await handleNewOrResume(adapters, args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "stop_agent",
    "Stop / abort a running agent session.",
    {
      sessionId: z.string().describe("Session ID to stop"),
      harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes"]).optional().describe("Harness type"),
    },
    async (args) => {
      const result = await handleStopAgent(adapters, args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "respond_permission",
    "Respond to a pending permission request (allow/deny). OpenCode and Claude SDK support this.",
    {
      sessionId: z.string().describe("Session with pending permission"),
      harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes"]).optional(),
      permissionId: z.string().describe("Permission request ID"),
      response: z.enum(["allow", "deny"]).describe("Allow or deny"),
      remember: z.boolean().optional().describe("Remember this decision"),
    },
    async (args) => {
      const result = await handleRespondPermission(adapters, args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "set_permissions",
    "Set permissions for an agent. Claude/Codex set these at launch time.",
    {
      sessionId: z.string().describe("Target session ID"),
      harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes"]).optional(),
      allowedTools: z.string().optional().describe("Comma-separated allowed tools"),
      mode: z.string().optional().describe("Permission mode"),
    },
    async (args) => {
      const result = await handleSetPermissions(adapters, args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "resume_agent",
    "Resume a stopped agent session. Optionally provide a message.",
    {
      sessionId: z.string().describe("Session ID to resume"),
      harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes"]).optional(),
      message: z.string().optional().describe("Message to send when resuming"),
    },
    async (args) => {
      const result = await handleResumeAgent(adapters, args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "change_model",
    "Change the AI model for a harness. For OpenCode: per-session or global. For Claude/Codex/Qoder: per-session where supported by the harness.",
    {
      sessionId: z.string().optional().describe("Session ID (omit for global default)"),
      harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes"]).describe("Target harness"),
      model: z.string().describe("Model name (e.g. 'claude-sonnet-4-20250514', 'gpt-4o', 'o4-mini')"),
    },
    async (args) => {
      const result = await handleChangeModel(adapters, args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "list_models",
    "List available AI models for each harness.",
    {
      harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes"]).optional().describe("Harness (omit for all)"),
    },
    async (args) => {
      const result = await handleListModels(adapters, args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );
}

// ===== Main =====

async function main() {
  const server = new McpServer({
    name: "agent-herder",
    version: "0.2.0",
    description: "Monitor and control coding agents (OpenCode, Claude Code SDK, Codex CLI, Qoder) with summarization and model management",
  });

  await initAdapters();
  registerTools(server);

  const webPort = process.env.AGENT_HERDER_WEB_PORT;
  if (webPort) {
    const webServer = createWebServer({
      adapters,
      converter: new AgentHerderSessionConverter(),
      humanRequests,
    });
    const host = process.env.AGENT_HERDER_WEB_HOST || "127.0.0.1";
    webServer.listen(Number(webPort), host, () => {
      console.error(`[agent-herder] Web UI listening on http://${host}:${webPort}`);
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[agent-herder] MCP server running on stdio");
}

main().catch((err) => {
  console.error("[agent-herder] Fatal:", err);
  process.exit(1);
});
