#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { McpServer } from "@modelcontextprotocol/server";
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
import { SessionSupervisor } from "./session-supervisor.js";
import { acquireAgentHerderSingleton } from "./singleton.js";
import { AdapterRegistry, type AdapterFactory } from "./adapter-registry.js";
import { createWebServer } from "./web/server.js";
import { createConfiguredBrowserWakeService } from "./browser-wake.js";
import { coordinationNotes } from "./coordination-notes.js";
import { herderEvents, type HerderEventBus } from "./herder-events.js";
import { herderJobs, type HerderJobRegistry } from "./herder-jobs.js";
import { harnessEventHealth } from "./harness-event-health.js";
import { registerHerderResources } from "./mcp/resources.js";
import { registerControlPlaneTools } from "./mcp/control-plane-tools.js";
import { registerHumanRequestTools } from "./mcp/human-request-tools.js";
import { registerCdpTools } from "./mcp/cdp-tools.js";
import { registerSessionTools } from "./mcp/session-tools.js";
import { registerBackgroundTools } from "./mcp/background-tools.js";
import { loadCdpChatDriver } from "./cdp-chat-mcp.js";
import type { CdpChatCapabilities, CdpChatDriver } from "./cdp-chat.js";
import { ALL_CDP_CHAT_CAPABILITIES, CdpChatClient } from "./cdp-chat.js";
import { ChatGptAccountArchive } from "./chatgpt-account-archive.js";
import { ChatGptHistoryArchive } from "./chatgpt-history-archive.js";
import { isQuotaLensEnabled, startQuotaLensSampler } from "./web/quota-lens.js";

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

// ===== Register MCP tools =====

function registerTools(
  server: McpServer,
  cdpChatClient?: CdpChatClient,
  cdpCapabilities?: CdpChatCapabilities,
  cdpAccountArchive?: ChatGptAccountArchive,
  cdpHistoryArchive?: ChatGptHistoryArchive,
  jobs: HerderJobRegistry = herderJobs,
  sessionConverter: Pick<AgentHerderSessionConverter, "convert"> = new AgentHerderSessionConverter(),
  events: HerderEventBus = herderEvents,
) {
  registerCdpTools(server, { client: cdpChatClient, capabilities: cdpCapabilities, accountArchive: cdpAccountArchive, historyArchive: cdpHistoryArchive, jobs });
  registerControlPlaneTools(server, { jobs, events, coordination: coordinationNotes });

  registerHumanRequestTools(server, humanRequests);
  registerBackgroundTools(server, { browserWakeService, jobs, sessionConverter });
  registerSessionTools(server, { adapters, jobs, events });
}

// ===== Main =====

export interface AgentHerderMcpServerOptions {
  /** Shared domain events; transport sessions are never used as durable state. */
  events?: HerderEventBus;
  /** Enable direct resource notifications for long-lived transports such as stdio. */
  notifyDomainEvents?: boolean;
  /** Shared by HTTP MCP sessions so a list binding survives a client reconnect. */
  cdpHistoryArchive?: ChatGptHistoryArchive;
  /** Shared alongside the history archive when native ZIP import is enabled. */
  cdpAccountArchive?: ChatGptAccountArchive;
  /** Process-owned long-running job registry; never scoped to an MCP transport. */
  jobs?: HerderJobRegistry;
  /** Converter used by background conversion jobs. */
  sessionConverter?: Pick<AgentHerderSessionConverter, "convert">;
}

/** Build one Agent Herder MCP server over process-owned CDP archive state. */
export function createAgentHerderMcpServer(cdpChatDriver?: CdpChatDriver, options: AgentHerderMcpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: "agent-herder",
    version: "0.3.0",
    description: "Monitor, message, and coordinate coding agents across OpenCode, Claude, Codex, Qoder, Hermes, ZCode, and Fast Agent",
  }, {
    capabilities: { resources: { subscribe: true, listChanged: true } },
    instructions: [
      "Use Agent Herder whenever you need to inspect or communicate with another coding-agent session.",
      "For direct agent-to-agent communication use send_message; list_agents finds the target session.",
      "Before editing files that another agent may also touch, publish a coordination_note_create with your session ID, workspace CWD, relevant paths, and a bounded TTL (30 minutes is a good default).",
      "Active coordination notes are automatically injected into new turns delivered through Agent Herder, so agents do not need to poll coordination_note_list on every turn.",
      "Use coordination_note_list/get for explicit inspection. Update or delete your own note when scope/TTL changes or work finishes.",
      "If an injected note conflicts with your task, avoid the noted paths and use send_message to coordinate with the author before modifying them.",
    ].join("\n"),
  });
  const events = options.events ?? herderEvents;
  const jobs = options.jobs ?? herderJobs;
  const sessionConverter = options.sessionConverter ?? new AgentHerderSessionConverter();
  registerHerderResources(server, {
    adapters, coordination: coordinationNotes, humanRequests, jobs, events, eventHealth: harnessEventHealth,
  });
  if (options.notifyDomainEvents) {
    const unsubscribe = events.subscribe((event) => { void server.server.sendResourceUpdated({ uri: event.uri }); });
    server.server.onclose = () => { unsubscribe(); };
  }

  registerTools(
    server,
    cdpChatDriver ? new CdpChatClient(cdpChatDriver, { mediaRoot: process.env.CDP_CHAT_MEDIA_ROOT }) : undefined,
    cdpChatDriver?.capabilities ?? (cdpChatDriver ? ALL_CDP_CHAT_CAPABILITIES : undefined),
    options.cdpAccountArchive ?? (cdpChatDriver ? new ChatGptAccountArchive(cdpChatDriver.accountExportDriver, { archiveRoot: process.env.CHATGPT_ACCOUNT_ARCHIVE_ROOT }) : undefined),
    options.cdpHistoryArchive ?? (cdpChatDriver?.historyArchiveDriver
      ? new ChatGptHistoryArchive(cdpChatDriver.historyArchiveDriver, { archiveRoot: process.env.CHATGPT_HISTORY_ARCHIVE_ROOT })
      : undefined),
    jobs,
    sessionConverter,
    events,
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
  const processSessionConverter = new AgentHerderSessionConverter();
  const processSupervisor = new SessionSupervisor(adapters, processSessionConverter, undefined, { events: herderEvents });
  const stopProcessObservation = processSupervisor.startObservation(Number(process.env.AGENT_HERDER_SESSION_OBSERVATION_INTERVAL_MS || 5_000));
  process.once("exit", stopProcessObservation);
  const createHttpMcpServer = () => createAgentHerderMcpServer(cdpChatDriver, { cdpAccountArchive, cdpHistoryArchive, events: herderEvents });
  const createStdioMcpServer = () => createAgentHerderMcpServer(cdpChatDriver, { cdpAccountArchive, cdpHistoryArchive, events: herderEvents, notifyDomainEvents: true });
  const webPort = process.env.AGENT_HERDER_WEB_PORT;
  if (webPort) {
    const host = process.env.AGENT_HERDER_WEB_HOST || "127.0.0.1";
    const httpToken = process.env.AGENT_HERDER_HTTP_TOKEN?.trim();
    if (!isLoopbackHost(host) && !httpToken) {
      throw new Error("AGENT_HERDER_HTTP_TOKEN is required when AGENT_HERDER_WEB_HOST is non-local");
    }
    if (isQuotaLensEnabled()) startQuotaLensSampler();
    const webServer = createWebServer({
      adapters,
      converter: processSessionConverter,
      humanRequests,
      choiceRegistry,
      adapterRegistry,
      mcpServerFactory: createHttpMcpServer,
      herderEvents,
      jobs: herderJobs,
      supervisor: processSupervisor,
      sessionObservationManagedExternally: true,
      mcpAuthToken: httpToken,
      autopilotPolicyStore,
      autopilotSessionStore,
      autopilotSweepIntervalMs: Number(process.env.AGENT_HERDER_AUTOPILOT_SWEEP_INTERVAL_MS || 30_000),
    });
    webServer.listen(Number(webPort), host, () => {
      console.error(`[agent-herder] Web UI listening on http://${host}:${webPort}`);
    });
  }

  serveStdio(createStdioMcpServer, { onerror: (error) => console.error(`[agent-herder] MCP stdio error: ${error.message}`) });
  console.error("[agent-herder] MCP v2 server running on stdio (2026-07-28 + legacy fallback)");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[agent-herder] Fatal:", err);
    process.exit(1);
  });
}
