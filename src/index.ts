#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { HarnessAdapter } from "./types/index.js";
import { OpenCodeAdapter, ClaudeCodeAdapter, ClaudeSDKAdapter, CodexAdapter } from "./adapters/index.js";
import {
  handleListAgents,
  handleAgentInfo,
  handleSendMessage,
  handleStopAgent,
  handleRespondPermission,
  handleSetPermissions,
  handleResumeAgent,
  handleSummarizeSession,
  handleChangeModel,
  handleListModels,
} from "./mcp-tools/handlers.js";

// ===== Configuration from environment =====

const ENABLE_OPENCODE = parseEnvBool(process.env.ENABLE_OPENCODE, true);
const ENABLE_CLAUDE = parseEnvBool(process.env.ENABLE_CLAUDE, true);
const ENABLE_CLAUDE_SDK = parseEnvBool(process.env.ENABLE_CLAUDE_SDK, true);
const ENABLE_CODEX = parseEnvBool(process.env.ENABLE_CODEX, true);

// Summarizer config (defaults to gemma4 at llm.bezrabotnyi.com)
process.env.SUMMARIZER_API_BASE = process.env.SUMMARIZER_API_BASE || "https://llm.bezrabotnyi.com/v1";
process.env.SUMMARIZER_MODEL = process.env.SUMMARIZER_MODEL || "gemma4";
process.env.SUMMARIZER_API_KEY = process.env.SUMMARIZER_API_KEY || "sk-305630";

function parseEnvBool(val: string | undefined, fallback: boolean): boolean {
  if (!val) return fallback;
  return val === "1" || val === "true" || val === "yes";
}

// ===== Create adapters =====

const adapters = new Map<string, HarnessAdapter>();

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
    const adapter = new CodexAdapter({
      codexBin: process.env.CODEX_BIN,
      codexDir: process.env.CODEX_DATA_DIR,
    });
    adapters.set("codex", adapter);
    inits.push(
      adapter.init().catch((err) => {
        console.error(`[agent-herder] Codex adapter failed to init: ${(err as Error).message}`);
        adapters.delete("codex");
      })
    );
  }

  await Promise.allSettled(inits);

  const names = [...adapters.keys()].join(", ");
  console.error(`[agent-herder] Ready with harnesses: ${names || "none"}`);
}

// ===== Register MCP tools =====

function registerTools(server: McpServer) {
  server.tool(
    "list_agents",
    "List all coding agent sessions. Filter by harness, status, age (maxAge seconds), or folder (CWD prefix like ~/apps). Can show last message preview.",
    {
      harness: z.enum(["all", "opencode", "claude", "codex"]).optional().default("all").describe("Filter by harness"),
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
    "agent_info",
    "Get detailed info about a specific session. Always shows model and last message.",
    {
      sessionId: z.string().describe("Session ID to inspect"),
      harness: z.enum(["opencode", "claude", "codex"]).optional().describe("Harness type"),
    },
    async (args) => {
      const result = await handleAgentInfo(adapters, args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "send_message",
    "Send a message to an agent. Modes: sync (wait), queue (fire-and-forget), steer (redirect).",
    {
      sessionId: z.string().describe("Target session ID"),
      harness: z.enum(["opencode", "claude", "codex"]).optional().describe("Harness type"),
      message: z.string().describe("Message to send"),
      mode: z.enum(["queue", "steer", "sync"]).optional().default("sync").describe("Delivery mode"),
    },
    async (args) => {
      const result = await handleSendMessage(adapters, args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "stop_agent",
    "Stop / abort a running agent session.",
    {
      sessionId: z.string().describe("Session ID to stop"),
      harness: z.enum(["opencode", "claude", "codex"]).optional().describe("Harness type"),
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
      harness: z.enum(["opencode", "claude", "codex"]).optional(),
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
      harness: z.enum(["opencode", "claude", "codex"]).optional(),
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
      harness: z.enum(["opencode", "claude", "codex"]).optional(),
      message: z.string().optional().describe("Message to send when resuming"),
    },
    async (args) => {
      const result = await handleResumeAgent(adapters, args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "summarize_session",
    "Summarize a session transcript using built-in gemma4 LLM. Returns structured summary (Task, Progress, Current State, Issues). Use quick=true for 1-3 sentences.",
    {
      sessionId: z.string().describe("Session ID to summarize"),
      harness: z.enum(["opencode", "claude", "codex"]).optional().describe("Harness (optional)"),
      quick: z.boolean().optional().default(false).describe("Quick 1-3 sentence summary"),
    },
    async (args) => {
      const result = await handleSummarizeSession(adapters, args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "change_model",
    "Change the AI model for a harness. For OpenCode: per-session or global. For Claude/Codex: updates default for future sessions.",
    {
      sessionId: z.string().optional().describe("Session ID (omit for global default)"),
      harness: z.enum(["opencode", "claude", "codex"]).describe("Target harness"),
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
      harness: z.enum(["opencode", "claude", "codex"]).optional().describe("Harness (omit for all)"),
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
    description: "Monitor and control coding agents (OpenCode, Claude Code SDK, Codex CLI) with summarization and model management",
  });

  await initAdapters();
  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[agent-herder] MCP server running on stdio");
}

main().catch((err) => {
  console.error("[agent-herder] Fatal:", err);
  process.exit(1);
});