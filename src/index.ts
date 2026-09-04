#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HarnessAdapter } from "./types/index.js";
import { OpenCodeAdapter, ClaudeCodeAdapter, ClaudeSDKAdapter, CodexAdapter, CodexAppServerAdapter, AcpAdapter, HermesAdapter, ZcodeAdapter, FastAgentFileAdapter } from "./adapters/index.js";
import { HumanRequestRegistry } from "./human-request/index.js";
import { ChoiceRegistry } from "./autopilot/choice-registry.js";
import { AutopilotPolicyStore, resolveAutopilotPolicyStorePath } from "./autopilot/policy-store.js";
import { AutopilotSessionStore } from "./autopilot/session-store.js";
import { AgentHerderSessionConverter } from "./session-convert.js";
import { acquireAgentHerderSingleton } from "./singleton.js";
import { AdapterRegistry, type AdapterFactory } from "./adapter-registry.js";
import { createWebServer } from "./web/server.js";
import { createConfiguredBrowserWakeService } from "./browser-wake.js";
import { coordinationNotes } from "./coordination-notes.js";
import { loadCdpChatDriver } from "./cdp-chat-mcp.js";
import type {
  CdpChatCapabilities,
  CdpChatDriver,
  DownloadMediaInput,
  EditMessageInput,
  ExportChatInput,
  ListChatsInput,
  NewChatInput,
  SearchChatInput,
  SendMessageInput,
} from "./cdp-chat.js";
import { ALL_CDP_CHAT_CAPABILITIES, CdpChatClient } from "./cdp-chat.js";
import { ChatGptAccountArchive, type ImportAccountExportInput, type RequestAccountExportInput } from "./chatgpt-account-archive.js";
import { ChatGptHistoryArchive, type ExportChatHistoryInput, type ExportVisibleChatHistoryInput, type ListChatHistoryInput, type ReconcileVisibleChatHistoryInput } from "./chatgpt-history-archive.js";
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
  handleBrowserWake,
} from "./mcp-tools/handlers.js";

// ===== Configuration from environment =====

const ENABLE_OPENCODE = parseEnvBool(process.env.ENABLE_OPENCODE, true);
const ENABLE_CLAUDE = parseEnvBool(process.env.ENABLE_CLAUDE, true);
const ENABLE_CLAUDE_SDK = parseEnvBool(process.env.ENABLE_CLAUDE_SDK, true);
const ENABLE_CODEX = parseEnvBool(process.env.ENABLE_CODEX, true);
const CODEX_TRANSPORT = process.env.CODEX_TRANSPORT || "app-server";
const ENABLE_QODER = parseEnvBool(process.env.ENABLE_QODER, true);
const ENABLE_HERMES = parseEnvBool(process.env.ENABLE_HERMES, true);
const ENABLE_ZCODE = parseEnvBool(process.env.ENABLE_ZCODE, true);
const ENABLE_FAST_AGENT = parseEnvBool(process.env.ENABLE_FAST_AGENT, false);
const ACP_AGENT_COMMAND = process.env.ACP_AGENT_COMMAND;
const LAZY_ADAPTERS = new Set(["codex", "hermes", "zcode"]);

function parseEnvBool(val: string | undefined, fallback: boolean): boolean {
  if (!val) return fallback;
  return val === "1" || val === "true" || val === "yes";
}

// ===== Create adapters =====

const adapters = new Map<string, HarnessAdapter>();
const humanRequests = new HumanRequestRegistry(process.env.AGENT_HERDER_HUMAN_REQUEST_STORE || ".agent-herder/human-requests.json");
const autopilotStateDir = process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR || join(homedir(), ".local", "state", "agent-herder", "autopilot");
const choiceRegistry = new ChoiceRegistry(process.env.AGENT_HERDER_AUTOPILOT_CHOICE_STORE || join(autopilotStateDir, "choices.json"));
const autopilotPolicyStore = new AutopilotPolicyStore(resolveAutopilotPolicyStorePath(autopilotStateDir));
const autopilotSessionStore = new AutopilotSessionStore(join(autopilotStateDir, "sessions.json"));
const browserWakeService = createConfiguredBrowserWakeService(process.env);
const adapterFactories = new Map<string, AdapterFactory>();
const adapterRegistry = new AdapterRegistry(
  adapters,
  process.env.AGENT_HERDER_ADAPTER_REGISTRY || ".agent-herder/adapters.json",
);

function configureAdapterRegistry(): void {
  adapterFactories.set("opencode", () => new OpenCodeAdapter({
    baseUrl: process.env.OPENCODE_URL,
    password: process.env.OPENCODE_SERVER_PASSWORD,
  }));
  adapterFactories.set("claude", () => ENABLE_CLAUDE_SDK ? new ClaudeSDKAdapter() : new ClaudeCodeAdapter({ claudeBin: process.env.CLAUDE_BIN }));
  adapterFactories.set("codex", () => CODEX_TRANSPORT === "cli"
    ? new CodexAdapter({ codexBin: process.env.CODEX_BIN, codexDir: process.env.CODEX_DATA_DIR })
    : new CodexAppServerAdapter({ codexBin: process.env.CODEX_BIN, cwd: process.env.CODEX_CWD, modelIds: parseCsv(process.env.CODEX_MODELS, ["o4-mini", "o3", "gpt-4.1", "gpt-4o"]) }));
  adapterFactories.set("qoder", () => new AcpAdapter({
    profile: "qoder", harness: "qoder", command: process.env.QODER_BIN || "qodercli",
    args: [...parseArgs(process.env.QODER_ARGS, "QODER_ARGS"), "--acp", ...(process.env.QODER_MODEL ? ["--model", process.env.QODER_MODEL] : [])],
    cwd: process.env.QODER_CWD || process.cwd(), modelIds: parseCsv(process.env.QODER_MODELS, ["Ultimate", "Lite"]),
  }));
  adapterFactories.set("hermes", () => new HermesAdapter({
    hermesBin: process.env.HERMES_BIN,
    cwd: process.env.HERMES_CWD,
    jobProvider: process.env.HERMES_HEALTH_PROVIDER || "openai-codex",
    jobReasoning: process.env.HERMES_HEALTH_REASONING || "high",
    jobToolsets: process.env.HERMES_HEALTH_TOOLSETS || "terminal",
  }));
  adapterFactories.set("zcode", () => new ZcodeAdapter({
    command: process.env.ZCODE_SERVER_NODE,
    args: process.env.ZCODE_SERVER_ENTRY ? [process.env.ZCODE_SERVER_ENTRY] : undefined,
    cwd: process.env.ZCODE_CWD, modelIds: parseCsv(process.env.ZCODE_MODELS, []),
  }));
  adapterFactories.set("fast-agent", () => new FastAgentFileAdapter({
    home: process.env.FAST_AGENT_HOME || join(homedir(), ".fast-agent"),
    cwd: process.env.FAST_AGENT_CWD || process.cwd(),
  }));
  for (const definition of [
    ["opencode", "OpenCode", "OpenCode HTTP control adapter", ENABLE_OPENCODE],
    ["claude", "Claude", "Claude SDK or CLI adapter", ENABLE_CLAUDE],
    ["codex", "Codex", "Codex app-server or CLI adapter", ENABLE_CODEX],
    ["qoder", "Qoder", "Qoder ACP adapter", ENABLE_QODER],
    ["hermes", "Hermes", "Hermes MCP adapter", ENABLE_HERMES],
    ["zcode", "ZCode", "ZCode app-server adapter", ENABLE_ZCODE],
    ["fast-agent", "Fast Agent", "Fast Agent persisted session observer and launcher", ENABLE_FAST_AGENT],
  ] as const) {
    const [id, name, description, defaultEnabled] = definition;
    adapterRegistry.register({ id, name, description, defaultEnabled, factory: adapterFactories.get(id) });
  }
}

function queueAdapterInit(inits: Promise<void>[], id: string, adapter: HarnessAdapter, onError: (error: unknown) => void): void {
  if (LAZY_ADAPTERS.has(id)) return;
  inits.push(adapter.init().catch(onError));
}

async function initAdapters() {
  const inits: Promise<void>[] = [];

  if (adapterRegistry.shouldEnable("opencode", ENABLE_OPENCODE)) {
    const adapter = new OpenCodeAdapter({
      baseUrl: process.env.OPENCODE_URL,
      password: process.env.OPENCODE_SERVER_PASSWORD,
    });
    adapters.set("opencode", adapter);
    adapterRegistry.registerActive(adapter);
    queueAdapterInit(inits, "opencode", adapter, (err) => {
      console.error(`[agent-herder] OpenCode adapter failed to init: ${(err as Error).message}`);
      adapters.delete("opencode");
    });
  }

  if (adapterRegistry.shouldEnable("claude", ENABLE_CLAUDE)) {
    if (ENABLE_CLAUDE_SDK) {
      const sdkAdapter = new ClaudeSDKAdapter();
      inits.push(
        sdkAdapter.init()
          .then(() => {
            adapters.set("claude", sdkAdapter);
            adapterRegistry.registerActive(sdkAdapter);
            console.error("[agent-herder] Claude Agent SDK adapter initialized");
          })
          .catch((err) => {
            console.error(`[agent-herder] Claude SDK adapter failed, trying CLI fallback: ${(err as Error).message}`);
            const cliAdapter = new ClaudeCodeAdapter({
              claudeBin: process.env.CLAUDE_BIN,
            });
            cliAdapter.init()
              .then(() => { adapters.set("claude", cliAdapter); adapterRegistry.registerActive(cliAdapter); })
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
      adapterRegistry.registerActive(adapter);
      inits.push(
        adapter.init().catch((err) => {
          console.error(`[agent-herder] Claude Code adapter failed to init: ${(err as Error).message}`);
          adapters.delete("claude");
        })
      );
    }
  }

  if (adapterRegistry.shouldEnable("codex", ENABLE_CODEX)) {
    if (CODEX_TRANSPORT === "cli") {
      const adapter = new CodexAdapter({
        codexBin: process.env.CODEX_BIN,
        codexDir: process.env.CODEX_DATA_DIR,
      });
      adapters.set("codex", adapter);
      adapterRegistry.registerActive(adapter);
      queueAdapterInit(inits, "codex", adapter, (err) => {
        console.error(`[agent-herder] Codex CLI adapter failed to init: ${(err as Error).message}`);
        adapters.delete("codex");
      });
    } else {
      const nativeAdapter = new CodexAppServerAdapter({
        codexBin: process.env.CODEX_BIN,
        cwd: process.env.CODEX_CWD,
        modelIds: parseCsv(process.env.CODEX_MODELS, ["o4-mini", "o3", "gpt-4.1", "gpt-4o"]),
      });
      adapters.set("codex", nativeAdapter);
      adapterRegistry.registerActive(nativeAdapter);
      if (!LAZY_ADAPTERS.has("codex")) inits.push(nativeAdapter.init().catch(async (err) => {
          console.error(`[agent-herder] Codex app-server failed, trying CLI fallback: ${(err as Error).message}`);
          const fallback = new CodexAdapter({
            codexBin: process.env.CODEX_BIN,
            codexDir: process.env.CODEX_DATA_DIR,
          });
          try {
            await fallback.init();
            adapters.set("codex", fallback);
            adapterRegistry.registerActive(fallback);
          } catch (fallbackError) {
            console.error(`[agent-herder] Codex CLI fallback also failed: ${(fallbackError as Error).message}`);
            adapters.delete("codex");
          }
        }));
    }
  }

  if (adapterRegistry.shouldEnable("qoder", ENABLE_QODER)) {
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
    adapterRegistry.registerActive(adapter);
    inits.push(
      adapter.init().catch((err) => {
        console.error(`[agent-herder] Qoder adapter failed to init: ${(err as Error).message}`);
        adapters.delete("qoder");
      })
    );
  }

  if (adapterRegistry.shouldEnable("hermes", ENABLE_HERMES)) {
    const adapter = new HermesAdapter({
      hermesBin: process.env.HERMES_BIN,
      cwd: process.env.HERMES_CWD,
      jobProvider: process.env.HERMES_HEALTH_PROVIDER || "openai-codex",
      jobReasoning: process.env.HERMES_HEALTH_REASONING || "high",
      jobToolsets: process.env.HERMES_HEALTH_TOOLSETS || "terminal",
    });
    adapters.set("hermes", adapter);
    adapterRegistry.registerActive(adapter);
    queueAdapterInit(inits, "hermes", adapter, (err) => {
      console.error(`[agent-herder] Hermes adapter failed to init: ${(err as Error).message}`);
      adapters.delete("hermes");
    });
  }

  if (adapterRegistry.shouldEnable("zcode", ENABLE_ZCODE)) {
    const adapter = new ZcodeAdapter({
      command: process.env.ZCODE_SERVER_NODE,
      args: process.env.ZCODE_SERVER_ENTRY ? [process.env.ZCODE_SERVER_ENTRY] : undefined,
      cwd: process.env.ZCODE_CWD,
      modelIds: parseCsv(process.env.ZCODE_MODELS, []),
    });
    adapters.set("zcode", adapter);
    adapterRegistry.registerActive(adapter);
    queueAdapterInit(inits, "zcode", adapter, (err) => {
      console.error(`[agent-herder] ZCode adapter failed to init: ${(err as Error).message}`);
      adapters.delete("zcode");
    });
  }

  if (adapterRegistry.shouldEnable("fast-agent", ENABLE_FAST_AGENT)) {
    const adapter = new FastAgentFileAdapter({
      home: process.env.FAST_AGENT_HOME || join(homedir(), ".fast-agent"),
      cwd: process.env.FAST_AGENT_CWD || process.cwd(),
    });
    adapters.set("fast-agent", adapter);
    adapterRegistry.registerActive(adapter);
    inits.push(adapter.init().catch((err) => {
      console.error(`[agent-herder] Fast Agent persisted observer failed to init: ${(err as Error).message}`);
      adapters.delete("fast-agent");
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

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/** Return one bounded JSON text result for a namespaced CDP chat tool. */
function cdpTextResult(value: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** Register the standalone CDP chat capability without colliding with send_message. */
function registerCdpChatTools(server: McpServer, client: CdpChatClient, capabilities: CdpChatCapabilities): void {
  if (capabilities.new_chat) server.tool(
    "cdp_new_chat",
    "Create exactly one disposable chat on the owned authenticated page without submitting a prompt.",
    {
      confirmation: z.literal("NEW_CHAT"),
      idempotencyKey: z.string().min(1).max(128),
      title: z.string().min(1).max(256).optional(),
    },
    async (args) => cdpTextResult(await client.newChat(args as NewChatInput)),
  );
  if (capabilities.list_chats) server.tool(
    "cdp_list_chats",
    "List page-visible chats by explicit unread, observable working, or UTC-recent semantics with bounded pagination.",
    {
      view: z.enum(["unread", "working", "recent"]),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().max(128).optional(),
    },
    async (args) => cdpTextResult(await client.listChats(args as ListChatsInput)),
  );
  if (capabilities.search_chat) server.tool(
    "cdp_search_chat",
    "Search page-visible chat titles and message text using one fresh owned-page snapshot.",
    {
      query: z.string().trim().min(1).max(256),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async (args) => cdpTextResult(await client.searchChat(args as SearchChatInput)),
  );
  if (capabilities.export_chat) server.tool(
    "cdp_export_chat",
    "Export only a fixture-bound chat with bounded message count and UTF-8 byte output.",
    {
      chatRef: z.string().min(1).max(256),
      format: z.enum(["json", "markdown"]),
      maxMessages: z.number().int().min(1).max(100).optional(),
    },
    async (args) => cdpTextResult(await client.exportChat(args as ExportChatInput)),
  );
  if (capabilities.send_message) server.tool(
    "cdp_send_message",
    "Send one fixture message only with exact confirmation SEND_MESSAGE and a one-shot idempotency gate.",
    {
      chatRef: z.string().min(1).max(256),
      text: z.string().min(1).max(100_000),
      confirmation: z.literal("SEND_MESSAGE"),
      idempotencyKey: z.string().min(1).max(128),
    },
    async (args) => cdpTextResult(await client.sendMessage(args as SendMessageInput)),
  );
  if (capabilities.edit_message) server.tool(
    "cdp_edit_message",
    "Edit one fixture message only with exact confirmation EDIT_MESSAGE, one-shot idempotency, and an expected version or old-text guard.",
    {
      chatRef: z.string().min(1).max(256),
      messageRef: z.string().min(1).max(256),
      text: z.string().min(1).max(100_000),
      confirmation: z.literal("EDIT_MESSAGE"),
      idempotencyKey: z.string().min(1).max(128),
      expectedVersion: z.number().int().min(1).optional(),
      expectedText: z.string().max(100_000).optional(),
    },
    async (args) => cdpTextResult(await client.editMessage(args as EditMessageInput)),
  );
  if (capabilities.download_media) server.tool(
    "cdp_download_media",
    "Download one fixture attachment of an allowlisted MIME and size into the confined media root.",
    {
      chatRef: z.string().min(1).max(256),
      messageRef: z.string().min(1).max(256),
      mediaRef: z.string().min(1).max(256),
      outputDir: z.string().max(4096).optional(),
    },
    async (args) => cdpTextResult(await client.downloadMedia(args as DownloadMediaInput)),
  );
}

/** Register account-wide ChatGPT archive tools under a distinct namespace. */
function registerChatGptAccountArchiveTools(server: McpServer, archive: ChatGptAccountArchive): void {
  server.tool(
    "cdp_request_account_export",
    "Request ChatGPT's official account-data ZIP. The link arrives by email or SMS; no chat prompt is sent.",
    { confirmation: z.literal("REQUEST_ACCOUNT_EXPORT") },
    async (args) => cdpTextResult(await archive.requestAccountExport(args as RequestAccountExportInput)),
  );
  server.tool(
    "cdp_import_account_export",
    "Copy a downloaded ChatGPT account-export ZIP into the local archive and create a source-format manifest without converting chat content.",
    { sourcePath: z.string().min(1).max(4096) },
    async (args) => cdpTextResult(await archive.importAccountExport(args as ImportAccountExportInput)),
  );
  server.tool(
    "cdp_list_account_exports",
    "List imported ChatGPT account-export ZIP archives and aggregate entry categories without exposing chat text.",
    { limit: z.number().int().min(1).max(100).optional() },
    async (args) => cdpTextResult(await archive.listAccountExports(args.limit)),
  );
}

/** Register the read-only, checkpointed ChatGPT history archive without colliding with fixture chat tools. */
function registerChatGptHistoryArchiveTools(server: McpServer, archive?: ChatGptHistoryArchive): void {
  if (!archive) return;
  server.tool(
    "cdp_reconcile_known_routes",
    "Materialize local Markdown and HTML from all already captured ChatGPT /c/... snapshots. This never opens, scrolls, or alters ChatGPT and works while BrowserClaw is unavailable.",
    {},
    async () => cdpTextResult(await archive.reconcileKnownRoutes()),
  );
  server.tool(
    "cdp_list_chats",
    "List the currently visible ChatGPT sidebar chats from the one owned page. No chat content is returned.",
    { view: z.enum(["unread", "working", "recent"]), limit: z.number().int().min(1).max(100).optional() },
    async (args) => cdpTextResult(await archive.listChats(args as ListChatHistoryInput)),
  );
  server.tool(
    "cdp_export_chat",
    "Read one listed ChatGPT chat in the same owned page, scroll backward, and save raw snapshots locally. Returns only a checkpoint receipt.",
    { chatRef: z.string().min(1).max(256), maxSegments: z.number().int().min(1).max(100).optional() },
    async (args) => cdpTextResult(await archive.exportChat(args as ExportChatHistoryInput)),
  );
  server.tool(
    "cdp_export_visible_chats",
    "Best-effort export of all currently visible non-protected ChatGPT conversations. Completed archives include local Markdown and HTML renderings beside raw snapshots.",
    { maxChats: z.number().int().min(1).max(100).optional(), maxSegmentsPerChat: z.number().int().min(1).max(100).optional() },
    async (args) => cdpTextResult(await archive.exportVisibleChats(args as ExportVisibleChatHistoryInput)),
  );
  server.tool(
    "cdp_reconcile_visible_chats",
    "Materialize local Markdown and HTML from already captured ChatGPT history snapshots for the currently visible chats. This does not open, scroll, or alter ChatGPT.",
    { maxChats: z.number().int().min(1).max(100).optional() },
    async (args) => cdpTextResult(await archive.reconcileVisibleChats(args as ReconcileVisibleChatHistoryInput)),
  );
}

// ===== Register MCP tools =====

function registerTools(
  server: McpServer,
  cdpChatClient?: CdpChatClient,
  cdpCapabilities?: CdpChatCapabilities,
  cdpAccountArchive?: ChatGptAccountArchive,
  cdpHistoryArchive?: ChatGptHistoryArchive,
) {
  if (cdpChatClient && cdpCapabilities) registerCdpChatTools(server, cdpChatClient, cdpCapabilities);
  registerChatGptHistoryArchiveTools(server, cdpHistoryArchive);
  if (cdpAccountArchive) registerChatGptAccountArchiveTools(server, cdpAccountArchive);

  server.tool(
    "browser_wake",
    "Wake the allowlisted BrowserWorker for the fixed E-Frontier target using a fixed secretary template, opaque refs, run/idempotency IDs, and a bounded deadline. secretary.browser-canary.v1 is a safe no-external-tools liveness check; secretary.inbox.v1 remains the future Telegram-backed business action.",
    {
      schema: z.literal("agent-herder.browser-worker.v1"),
      worker: z.literal("mac-mini-browserclaw"),
      target: z.literal("E-Frontier"),
      templateId: z.enum(["secretary.inbox.v1", "secretary.browser-canary.v1"]),
      sourceRefs: z.array(z.string().min(1)).min(1).max(8),
      runId: z.string().min(1).max(128),
      idempotencyId: z.string().min(1).max(128),
      deadlineMs: z.number().int().min(1).max(10 * 60 * 1000),
    },
    async (args) => {
      const result = await handleBrowserWake(browserWakeService, args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

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
    "List all coding agent sessions, including ZCode. Filter by harness, status, age (maxAge seconds), or folder (CWD prefix like ~/apps). Can show last message preview.",
    {
      harness: z.enum(["all", "opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent"]).optional().default("all").describe("Filter by harness"),
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
    "Read-only Git worktree audit: dirty files, lock/PID state, and Claude/Codex/OpenCode/ZCode processes whose cwd is inside each worktree.",
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
      harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent"]).optional().describe("Harness type"),
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
      harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent"]).optional().describe("Harness type"),
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
      harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent"]).optional().describe("Harness type"),
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
      harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent"]).optional().describe("Harness type"),
    },
    async (args) => {
      const result = await handleExportTranscript(adapters, args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "coordination_note_create",
    "Publish a TTL coordination note for agents in the same workspace. Use it before editing shared files, e.g. 'I am changing src/parser.ts; do not touch for 30m'. Active notes are injected automatically into later Agent Herder-delivered turns.",
    {
      authorSessionId: z.string().trim().min(1).max(256),
      authorHarness: z.string().trim().min(1).max(64).optional(),
      cwd: z.string().min(1),
      paths: z.array(z.string().min(1).max(4096)).max(64).optional().default([]),
      kind: z.enum(["working", "avoid", "handoff", "info"]).optional().default("working"),
      message: z.string().trim().min(1).max(4000),
      ttlSeconds: z.number().int().min(60).max(604800).optional().default(1800),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await coordinationNotes.create(args), null, 2) }] }),
  );
  server.tool(
    "coordination_note_list",
    "List active coordination notes explicitly. You normally do not need to poll: Agent Herder injects matching notes into new turns automatically.",
    { cwd: z.string().optional(), path: z.string().optional(), authorSessionId: z.string().optional() },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await coordinationNotes.list(args), null, 2) }] }),
  );
  server.tool(
    "coordination_note_get",
    "Read one active coordination note by ID.",
    { noteId: z.string().uuid() },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await coordinationNotes.get(args.noteId), null, 2) }] }),
  );
  server.tool(
    "coordination_note_update",
    "Edit your own coordination note (message, kind, paths, TTL). authorSessionId must match the creator.",
    { noteId: z.string().uuid(), authorSessionId: z.string().trim().min(1).max(256), kind: z.enum(["working", "avoid", "handoff", "info"]).optional(), message: z.string().trim().min(1).max(4000).optional(), paths: z.array(z.string().min(1).max(4096)).max(64).optional(), ttlSeconds: z.number().int().min(60).max(604800).optional() },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await coordinationNotes.update(args.noteId, args.authorSessionId, args), null, 2) }] }),
  );
  server.tool(
    "coordination_note_delete",
    "Delete your own coordination note before TTL expiry. authorSessionId must match the creator.",
    { noteId: z.string().uuid(), authorSessionId: z.string().trim().min(1).max(256) },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify({ deleted: await coordinationNotes.delete(args.noteId, args.authorSessionId) }) }] }),
  );

  server.tool(
    "send_message",
    "Send a message to an agent. Active coordination notes for the target workspace are injected automatically before delivery. Modes: sync (wait), queue (fire-and-forget), steer (redirect).",
    {
      sessionId: z.string().describe("Target session ID"),
      harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent"]).optional().describe("Harness type"),
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
    "Create one named OpenCode, Codex, or ZCode session in an absolute canonical working directory.",
    {
      harness: z.enum(["opencode", "codex", "zcode"]).describe("Target harness"),
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
      harness: z.enum(["opencode", "codex", "zcode"]).describe("Target harness"),
      name: z.string().min(1).max(128).describe("Stable session name"),
      cwd: z.string().min(1).describe("Absolute working directory"),
      message: z.string().min(1).describe("Message to deliver"),
      mode: z.enum(["queue", "sync"]).optional().default("sync").describe("Delivery mode"),
      model: z.string().min(1).max(128).optional().describe("Optional model selected before the first message"),
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
      harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent"]).optional().describe("Harness type"),
    },
    async (args) => {
      const result = await handleStopAgent(adapters, args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "respond_permission",
    "Respond to a pending permission request (allow/deny). OpenCode, Claude SDK, and ZCode support this.",
    {
      sessionId: z.string().describe("Session with pending permission"),
      harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent"]).optional(),
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
      harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent"]).optional(),
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
      harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent"]).optional(),
      message: z.string().optional().describe("Message to send when resuming"),
    },
    async (args) => {
      const result = await handleResumeAgent(adapters, args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );

  server.tool(
    "change_model",
    "Change the AI model for a harness. For OpenCode: per-session or global. For Claude/Codex/Qoder/ZCode: per-session where supported by the harness.",
    {
      sessionId: z.string().optional().describe("Session ID (omit for global default)"),
      harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent"]).describe("Target harness"),
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
      harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent"]).optional().describe("Harness (omit for all)"),
    },
    async (args) => {
      const result = await handleListModels(adapters, args);
      return { content: [{ type: "text" as const, text: result }] };
    }
  );
}

// ===== Main =====

export interface AgentHerderMcpServerOptions {
  /** Shared by HTTP MCP sessions so a list binding survives a client reconnect. */
  cdpHistoryArchive?: ChatGptHistoryArchive;
  /** Shared alongside the history archive when native ZIP import is enabled. */
  cdpAccountArchive?: ChatGptAccountArchive;
}

/** Build one Agent Herder MCP server over process-owned CDP archive state. */
export function createAgentHerderMcpServer(cdpChatDriver?: CdpChatDriver, options: AgentHerderMcpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: "agent-herder",
    version: "0.3.0",
    description: "Monitor, message, and coordinate coding agents across OpenCode, Claude, Codex, Qoder, Hermes, ZCode, and Fast Agent",
  }, {
    instructions: [
      "Use Agent Herder whenever you need to inspect or communicate with another coding-agent session.",
      "For direct agent-to-agent communication use send_message; list_agents finds the target session.",
      "Before editing files that another agent may also touch, publish a coordination_note_create with your session ID, workspace CWD, relevant paths, and a bounded TTL (30 minutes is a good default).",
      "Active coordination notes are automatically injected into new turns delivered through Agent Herder, so agents do not need to poll coordination_note_list on every turn.",
      "Use coordination_note_list/get for explicit inspection. Update or delete your own note when scope/TTL changes or work finishes.",
      "If an injected note conflicts with your task, avoid the noted paths and use send_message to coordinate with the author before modifying them.",
    ].join("\n"),
  });
  registerTools(
    server,
    cdpChatDriver ? new CdpChatClient(cdpChatDriver, { mediaRoot: process.env.CDP_CHAT_MEDIA_ROOT }) : undefined,
    cdpChatDriver?.capabilities ?? (cdpChatDriver ? ALL_CDP_CHAT_CAPABILITIES : undefined),
    options.cdpAccountArchive ?? (cdpChatDriver ? new ChatGptAccountArchive(cdpChatDriver.accountExportDriver, { archiveRoot: process.env.CHATGPT_ACCOUNT_ARCHIVE_ROOT }) : undefined),
    options.cdpHistoryArchive ?? (cdpChatDriver?.historyArchiveDriver
      ? new ChatGptHistoryArchive(cdpChatDriver.historyArchiveDriver, { archiveRoot: process.env.CHATGPT_HISTORY_ARCHIVE_ROOT })
      : undefined),
  );
  return server;
}

async function main() {
  const releaseSingleton = acquireAgentHerderSingleton();
  process.once("exit", releaseSingleton);

  configureAdapterRegistry();
  await adapterRegistry.load();
  await initAdapters();
  let cdpChatDriver: CdpChatDriver | undefined;
  if (process.env.CDP_CHAT_DRIVER_MODULE) {
    try {
      cdpChatDriver = await loadCdpChatDriver();
    } catch (error) {
      // An expired BrowserClaw lease must not take down the monitoring/control
      // plane or silently acquire a new ChatGPT tab during service restart.
      console.error(`[agent-herder] CDP chat adapter unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  const cdpAccountArchive = cdpChatDriver
    ? new ChatGptAccountArchive(cdpChatDriver.accountExportDriver, { archiveRoot: process.env.CHATGPT_ACCOUNT_ARCHIVE_ROOT })
    : undefined;
  const cdpHistoryArchive = new ChatGptHistoryArchive(cdpChatDriver?.historyArchiveDriver, {
    archiveRoot: process.env.CHATGPT_HISTORY_ARCHIVE_ROOT,
  });
  const createMcpServer = () => createAgentHerderMcpServer(cdpChatDriver, { cdpAccountArchive, cdpHistoryArchive });
  const server = createMcpServer();

  const webPort = process.env.AGENT_HERDER_WEB_PORT;
  if (webPort) {
    const host = process.env.AGENT_HERDER_WEB_HOST || "127.0.0.1";
    const httpToken = process.env.AGENT_HERDER_HTTP_TOKEN?.trim();
    if (!isLoopbackHost(host) && !httpToken) {
      throw new Error("AGENT_HERDER_HTTP_TOKEN is required when AGENT_HERDER_WEB_HOST is non-local");
    }
    const webServer = createWebServer({
      adapters,
      converter: new AgentHerderSessionConverter(),
      humanRequests,
      choiceRegistry,
      adapterRegistry,
      mcpServerFactory: createMcpServer,
      mcpAuthToken: httpToken,
      autopilotPolicyStore,
      autopilotSessionStore,
      autopilotSweepIntervalMs: Number(process.env.AGENT_HERDER_AUTOPILOT_SWEEP_INTERVAL_MS || 30_000),
    });
    webServer.listen(Number(webPort), host, () => {
      console.error(`[agent-herder] Web UI listening on http://${host}:${webPort}`);
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[agent-herder] MCP server running on stdio");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[agent-herder] Fatal:", err);
    process.exit(1);
  });
}
