#!/usr/bin/env node
import { BackgroundAutopilotStop } from "./autopilot/background-stop.js";
import { NativeTurnAutopilotObserver } from "./autopilot/native-turn-observer.js";
import { deliverAutopilotGoal } from "./autopilot/continuation-delivery.js";
import { evaluateAutopilotStop, runAutopilotCommand } from "./autopilot-runner.js";
import { PendingQuestionGate } from "./autopilot/pending-question-gate.js";
import { AutoCompactStore, AutoCompactService } from "./autocontinue/auto-compact.js";
import { createHash,randomUUID } from "node:crypto";
import { createFleetRecoveryAdmissionGate } from "./autopilot/recovery-admission.js";
import { createMiniMaxQuotaPreflight } from "./automation/minimax-quota-preflight.js";

import { startSelectedStdio } from "./mcp/transport-selection.js";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

import { HarnessAdapter } from "./types/index.js";
import { OpenCodeAdapter, ClaudeCodeAdapter, ClaudeSDKAdapter, CodexAdapter, CodexAppServerAdapter, AcpAdapter, HermesAdapter, ZcodeAdapter, FastAgentFileAdapter, ChatGptAdapter, MinimaxCodeAdapter } from "./adapters/index.js";
import { HumanRequestRegistry } from "./human-request/index.js";
import { ChoiceRegistry } from "./autopilot/choice-registry.js";
import { AutopilotPolicyStore, resolveAutopilotPolicyStorePath } from "./autopilot/policy-store.js";
import { adoptLegacyAutopilotState, resolveAutopilotStateDir, resolveHumanRequestStorePath } from "./autopilot/state-dir.js";
import { AutopilotSessionStore, type AutopilotHarness } from "./autopilot/session-store.js";
import { AutomationLaunchPolicyStore } from "./automation-launch-policy.js";
import { IntegratorSessionBindingStore } from "./integrator-session-binding.js";
import { IntegratorFleetRuntime } from "./integrator-fleet-runtime.js";
import { dispatchProjectLaunch, namedSessionRunner, ProjectLaunchAttemptLog, type ProjectLaunchDispatcher } from "./automation/project-launch-dispatch.js";
import { createAnthropicCompatibleSessionCompletionJudge, createOpenAICompatibleSessionCompletionJudge, SessionAutostartStore, UnfinishedSessionLauncher, UnfinishedSessionStore, type SessionCompletionJudge, type UnfinishedSessionNotice } from "./autopilot/unfinished-session-launcher.js";
import { applyOutboundFamilyToProcess } from "./net/outbound-family.js";
import { createIncidentUpdateSink, deliverIncidentQuestion } from "./autopilot/notice-incident.js";
import { createNoticePlacePayload, createNoticePlaceSink, drainPendingNotices, loadReceiptStore, persistReceiptStore, type PendingHumanQuestion } from "./autopilot/index.js";
import { buildAskHumanRequest } from "./human-request/notice-question.js";
import { describeAskHumanProducer, loadAskHumanProducer, type AskHumanProducer } from "./human-request/ask-human-producer.js";
import { acquireLock } from "./autopilot-hook.js";
import { AgentHerderSessionConverter } from "./session-convert.js";
import { SessionSupervisor } from "./session-supervisor.js";
import { getHumanStopStore } from "./human-stop-store.js";
import { LineageStore } from "./lineage-store.js";
import { AnthropicMiniMaxSummarizer, CacheHandoffService, FastAgentMiniMaxSummarizer } from "./cache-handoff.js";
import { acquireAgentHerderSingleton } from "./singleton.js";
import { AdapterRegistry, type AdapterFactory } from "./adapter-registry.js";
import { boundResumeReceiptQuery, createWebServer, resumeSelectedTarget } from "./web/server.js";
import { AgentResumeClient, type ResumeReceipt, type ResumeTransportRequest } from "./resume-transport.js";
import { createConfiguredFleetApiHandler, createManagedFleetHttpGuard, isManagedFleetNode } from "./web/fleet-wiring.js";
import { registerFleetNodeTools } from "./mesh/fleet-node.js";
import {
  commonSettingsService,
  registerCommonSettingsTools,
  startCommonSettingsSyncLoop,
} from "./common-settings/index.js";
import { hooksLeverFromStore } from "./common-settings/index.js";
import { HooksProhibitionsStore, isHookKind, type HookKind } from "./hooks/index.js";
import { fleetPolicyRevisionLedgerPath } from "./mesh/fleet-policy-revision.js";
import type { ProjectModelPolicyState } from "./project-model-delivery-gate.js";
import { createConfiguredBrowserWakeService } from "./browser-wake.js";
import { coordinationNotes } from "./coordination-notes.js";
import { herderEvents, type HerderEventBus } from "./herder-events.js";
import { herderJobs, type HerderJobRegistry } from "./herder-jobs.js";
import { harnessEventHealth } from "./harness-event-health.js";
import { registerHerderResources } from "./mcp/resources.js";
import { registerControlPlaneTools } from "./mcp/control-plane-tools.js";
import { registerResumeAfterTools } from "./mcp/resume-after-tools.js";
import { createResumeAfterRuntime } from "./resume-after-runtime.js";
import type { ResumeAfterService } from "./resume-after.js";
import type { CadenceScheduler } from "./cadence-scheduler.js";
import { createCadenceRuntime } from "./cadence-runtime.js";
import { registerCadenceTools } from "./mcp/cadence-tools.js";
import { registerHumanRequestTools } from "./mcp/human-request-tools.js";
import { registerCdpTools } from "./mcp/cdp-tools.js";
import { registerSessionTools } from "./mcp/session-tools.js";
import { registerResourceOwnershipTools } from "./mcp/resource-ownership-tools.js";
import { registerHarnessMeshTools } from "./mesh/register-tools.js";
import { FleetDirectTransport, directFleetPeers } from "./mesh/fleet-direct-transport.js";
import { registerWorkspaceTools } from "./mesh/workspace-tools.js";
import { registerBackgroundTools } from "./mcp/background-tools.js";
import { registerRagTools } from "./mcp/rag-tools.js";
import { registerActiveSessionTools } from "./mcp/active-session-tools.js";
import { registerSessionWorkspaceTools } from "./session-workspaces-tools.js";
import { registerSessionSearchTools } from "./mcp/session-search-tools.js";
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
const ENABLE_MINIMAX_CODE = parseEnvBool(process.env.ENABLE_MINIMAX_CODE, true);
const ACP_AGENT_COMMAND = process.env.ACP_AGENT_COMMAND;
const LAZY_ADAPTERS = new Set(["codex", "hermes", "zcode"]);

function parseEnvBool(val: string | undefined, fallback: boolean): boolean {
  if (!val) return fallback;
  return val === "1" || val === "true" || val === "yes";
}

/** Resolve the currently configured task judge for every batch operation. */
export function createDynamicSessionCompletionJudge(
  getClient: (model?: string) => Promise<SessionCompletionJudge>,
  getModel?: () => Promise<string>,
): SessionCompletionJudge {
  const currentClient = async () => getClient(getModel ? await getModel() : undefined);
  return {
    async decide(input) {
      return (await currentClient()).decide(input);
    },
    async plan(input) {
      const plan = (await currentClient()).plan;
      if (!plan) throw new Error("Configured session judge does not support batch planning");
      return plan(input);
    },
    async reconcile(input) {
      const reconcile = (await currentClient()).reconcile;
      if (!reconcile) throw new Error("Configured session judge does not support batch reconciliation");
      return reconcile(input);
    },
  };
}

/** Read an operator-selected credential file without placing its value in config or argv. */
export async function readCredentialFile(path: string | undefined): Promise<string | undefined> {
  if (!path?.trim()) return undefined;
  const value = (await readFile(path.trim(), "utf8")).trim();
  if (!value) throw new Error(`Credential file is empty: ${path.trim()}`);
  return value;
}

function parseReasoningEffort(value: string | undefined): "low" | "high" | "max" | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "low" || normalized === "high" || normalized === "max") return normalized;
  throw new Error("AGENT_HERDER_UNFINISHED_JUDGE_REASONING_EFFORT must be low, high, or max");
}

// ===== Create adapters =====

const adapters = new Map<string, HarnessAdapter>();
// One Autopilot state seam for the daemon, the Stop hook and the runner. Legacy
// state is adopted once instead of being reset, so live sessions, pending
// questions and pending choices survive this unification.
const autopilotStateDir = resolveAutopilotStateDir();
const autopilotStateReady = adoptLegacyAutopilotState(autopilotStateDir);
const humanRequests = new HumanRequestRegistry(resolveHumanRequestStorePath(autopilotStateDir));
const choiceRegistry = new ChoiceRegistry(process.env.AGENT_HERDER_AUTOPILOT_CHOICE_STORE || join(autopilotStateDir, "choices.json"));
const autopilotPolicyStore = new AutopilotPolicyStore(resolveAutopilotPolicyStorePath(autopilotStateDir));
const autopilotSessionStore = new AutopilotSessionStore(join(autopilotStateDir, "sessions.json"));
const unfinishedSessionStore = new UnfinishedSessionStore(
  process.env.AGENT_HERDER_UNFINISHED_SESSION_STORE || join(autopilotStateDir, "unfinished-sessions.json"),
);
const sessionAutostartStore = new SessionAutostartStore(
  process.env.AGENT_HERDER_SESSION_AUTOSTART_SETTINGS || join(autopilotStateDir, "session-autostart.json"),
);
const autoCompactStore = new AutoCompactStore(join(autopilotStateDir, "auto-compact.json"));
const automationLaunchPolicyStore = new AutomationLaunchPolicyStore(join(autopilotStateDir, "automation-launch-policy.json"));
// The lever of the owner over the prohibitions of the hooks. It is the
// same durable state as the launch policy beside it, and it travels in
// the common document of the fleet — the lever of the automation is a
// different thing and is not touched here.
const hooksProhibitionsStore = HooksProhibitionsStore.at(autopilotStateDir);

/**
 * The lever of the hooks as the common document sees it.
 *
 * The store of the hooks accepts only the known kinds of hooks, while the
 * common document carries the names as strings: the names are checked here, so
 * an unknown name is dropped instead of written into the lever.
 */
const hooksLeverStore = {
  readState: () => hooksProhibitionsStore.readState(),
  apply: (change: {
    source: "owner";
    actor?: string;
    prohibitionsEnabled?: boolean;
    disabledHooks?: string[];
    reason?: string;
  }) =>
    hooksProhibitionsStore.apply({
      ...change,
      disabledHooks: change.disabledHooks?.filter((hook): hook is HookKind => isHookKind(hook)),
    }),
};
const integratorSessionBindingStore = new IntegratorSessionBindingStore({ persistencePath: join(autopilotStateDir, "integrator-session-bindings.json") });
const integratorFleetRuntime = new IntegratorFleetRuntime({ policyStore: automationLaunchPolicyStore, bindingStore: integratorSessionBindingStore, codexBin: process.env.CODEX_BIN });
// The per-project model gate reads the same stored document as the launcher,
// so a denied model is refused at every place a model can be applied.
const readLaunchPolicyForGate = async () => {
  const loaded = await automationLaunchPolicyStore.load();
  return loaded.kind === "valid" ? loaded.policy : undefined;
};
// The node says which version of the policy of the launch it holds right now,
// so the fleet can tell a node that applied the wanted version from a node
// that holds another one. The document is read at the moment of the answer,
// and no copy of it is kept.
const readLaunchPolicyRevision = async () => {
  const loaded = await automationLaunchPolicyStore.readDocument();
  return { kind: loaded.kind, appliedRevision: loaded.etag };
};
// A delivery may not start work in a project that restricts models, so the
// delivery gate needs the state of the document and not only its content: an
// unreadable policy is not a permission.
const readLaunchPolicyStateForGate = async (): Promise<ProjectModelPolicyState> => {
  const loaded = await automationLaunchPolicyStore.load().catch((error: unknown) => ({ kind: "invalid" as const, error: error instanceof Error ? error.message : String(error) }));
  if (loaded.kind === "valid") return { kind: "valid", policy: loaded.policy };
  if (loaded.kind === "absent") return { kind: "absent" };
  return { kind: "invalid", error: loaded.error };
};
const humanStopStore = getHumanStopStore();
const herderGenerationId=`process-${process.pid}-${randomUUID()}`;
const persistNativeOwner:NonNullable<import("./adapters/zcode.js").ZcodeAdapterOptions["persistNativeOwner"]>=async(id,proof,current)=>{
  if(await humanStopStore.isHeld("zcode",id))return false;
  return unfinishedSessionStore.recordNativeOwnerProof(id,proof,current);
};
const lineageStore = new LineageStore(join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "agent-herder", "lineage.json"));
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
    : new CodexAppServerAdapter({ codexBin: process.env.CODEX_BIN, cwd: process.env.CODEX_CWD, modelIds: parseCsv(process.env.CODEX_MODELS, []) }));
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
    controllerGenerationId:herderGenerationId,persistNativeOwner,
    command: process.env.ZCODE_SERVER_NODE,
    args: process.env.ZCODE_SERVER_ENTRY ? [process.env.ZCODE_SERVER_ENTRY] : undefined,
    cwd: process.env.ZCODE_CWD, modelIds: parseCsv(process.env.ZCODE_MODELS, []),
  }));
  adapterFactories.set("fast-agent", () => new FastAgentFileAdapter({
    home: process.env.FAST_AGENT_HOME || join(homedir(), ".fast-agent"),
    cwd: process.env.FAST_AGENT_CWD || process.cwd(),
  }));
  adapterFactories.set("minimax-code", () => new MinimaxCodeAdapter({
    sessionStore: process.env.MINIMAX_CODE_SESSION_STORE,
    cwd: process.env.MINIMAX_CODE_CWD,
  }));
  for (const definition of [
    ["opencode", "OpenCode", "OpenCode HTTP control adapter", ENABLE_OPENCODE],
    ["claude", "Claude", "Claude SDK or CLI adapter", ENABLE_CLAUDE],
    ["codex", "Codex", "Codex app-server or CLI adapter", ENABLE_CODEX],
    ["qoder", "Qoder", "Qoder ACP adapter", ENABLE_QODER],
    ["hermes", "Hermes", "Hermes MCP adapter", ENABLE_HERMES],
    ["zcode", "ZCode", "ZCode app-server adapter", ENABLE_ZCODE],
    ["fast-agent", "Fast Agent", "Fast Agent persisted session observer and launcher", ENABLE_FAST_AGENT],
    ["chatgpt", "ChatGPT", "Existing ChatGPT conversations on the one owned BrowserClaw page", true],
    ["minimax-code", "MiniMax Code", "MiniMax Code local-runtime session observer", ENABLE_MINIMAX_CODE],
  ] as const) {
    const [id, name, description, defaultEnabled] = definition;
    adapterRegistry.register({ id, name, description, defaultEnabled, factory: adapterFactories.get(id) });
  }
}

function queueAdapterInit(inits: Promise<void>[], id: string, adapter: HarnessAdapter, onError: (error: unknown) => void): void {
  if (LAZY_ADAPTERS.has(id)) return;
  inits.push(adapter.init().catch(onError));
}

async function initAdapterWithRetry(adapter: HarnessAdapter, attempts = 20, delayMs = 500): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await adapter.init();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
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
    inits.push(initAdapterWithRetry(adapter).catch((err) => {
      console.error(`[agent-herder] OpenCode adapter failed to init after retries: ${(err as Error).message}`);
      adapters.delete("opencode");
    }));
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
        modelIds: parseCsv(process.env.CODEX_MODELS, []),
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
    controllerGenerationId:herderGenerationId,persistNativeOwner,
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

  if (adapterRegistry.shouldEnable("minimax-code", ENABLE_MINIMAX_CODE)) {
    const adapter = new MinimaxCodeAdapter({
      sessionStore: process.env.MINIMAX_CODE_SESSION_STORE,
      cwd: process.env.MINIMAX_CODE_CWD,
    });
    adapters.set("minimax-code", adapter);
    adapterRegistry.registerActive(adapter);
    inits.push(adapter.init().catch((err) => {
      console.error(`[agent-herder] MiniMax Code observer failed to init: ${(err as Error).message}`);
      adapters.delete("minimax-code");
    }));
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

function createUnfinishedSessionNotifier(): ((notice: UnfinishedSessionNotice) => Promise<void>) | undefined {
  const eventUrl = process.env.NOTIFY_CENTER_EVENT_URL?.trim();
  const token = process.env.NOTIFY_CENTER_TOKEN?.trim();
  if (!eventUrl || !token) return undefined;
  const sink = createNoticePlaceSink({ eventUrl, token });
  return async (notice) => sink.send(createNoticePlacePayload({
    title: notice.title,
    body: notice.body,
    severity: notice.severity ?? "critical",
    project: process.env.NOTIFY_CENTER_PROJECT || "agent-herder",
    recipient: process.env.NOTIFY_CENTER_RECIPIENT || process.env.AGENT_HERDER_AUTOPILOT_NOTIFY_RECIPIENT || "me",
    kind: "incident",
    eventType: "health.degraded",
    dedupKey: notice.dedupKey,
    correlationId: notice.correlationId,
    idempotencyKey: `${notice.correlationId}:exhausted`,
    sourceId: notice.sourceId,
    hostId: hostname(),
    signalType: notice.signalType,
  }));
}

function startCompletionNoticeSweeper(): () => void {
  const eventUrl = process.env.NOTIFY_CENTER_EVENT_URL?.trim();
  const token = process.env.NOTIFY_CENTER_TOKEN?.trim();
  const receiptPath = join(autopilotStateDir, "receipts.json");
  const lockPath = join(autopilotStateDir, "state.lock");
  const sink = eventUrl && token ? createNoticePlaceSink({ eventUrl, token }) : { async send() { throw new Error("generic Notice producer is unavailable"); } };
  const incidentUpdates = createIncidentUpdateSink();
  const deliverQuestion = createNoticeQuestionDelivery(process.env);
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      const readRelease = await acquireLock(lockPath, { waitMs: 250 });
      if (!readRelease) return;
      let receipts: Awaited<ReturnType<typeof loadReceiptStore>>;
      try {
        receipts = await loadReceiptStore(receiptPath);
      } finally {
        await readRelease();
      }
      const before = new Map(receipts);
      if (await drainPendingNotices(receipts, sink, incidentUpdates, deliverQuestion) === 0) return;
      const delivered = [...before.entries()].flatMap(([key, receipt]) =>
        (["pendingNotice", "pendingIncidentUpdate", "pendingQuestion"] as const)
          .filter((field) => receipt[field] && !receipts.get(key)?.[field])
          .map((field) => ({ key, field, payload: receipt[field] })));
      const writeRelease = await acquireLock(lockPath, { waitMs: 250 });
      if (!writeRelease) return;
      try {
        const latest = await loadReceiptStore(receiptPath);
        let changed = false;
        for (const { key, field, payload } of delivered) {
          const current = latest.get(key);
          if (!current || JSON.stringify(current[field]) !== JSON.stringify(payload)) continue;
          const cleared = { ...current };
          delete cleared[field];
          latest.set(key, cleared);
          changed = true;
        }
        if (changed) await persistReceiptStore(receiptPath, latest);
      } finally {
        await writeRelease();
      }
    } catch (error) {
      console.error(`[agent-herder] не удалось повторить уведомление о завершении: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };
  void sweep();
  const timer = setInterval(() => { void sweep(); }, 30_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

function sameNotice(left: Parameters<ReturnType<typeof createNoticePlaceSink>["send"]>[0], right: Parameters<ReturnType<typeof createNoticePlaceSink>["send"]>[0]): boolean {
  return left.dedup_key === right.dedup_key
    && left.correlation_id === right.correlation_id
    && left.idempotency_key === right.idempotency_key
    && left.title === right.title
    && left.body === right.body;
}

// ===== Register MCP tools =====

/** Autopilot needs an absolute cwd; prefer the native session, then the store. */
async function autopilotSessionCommand(
  input: { command: "on" | "off" | "status"; harness: string; sessionId: string; cwd?: string },
): Promise<Record<string, unknown>> {
  const harness = input.harness as AutopilotHarness;
  const explicit = input.cwd?.trim();
  const stored = await autopilotSessionStore.get(harness, input.sessionId).catch(() => undefined);
  const cwd = explicit
    || (stored?.cwd && stored.cwd.startsWith("/") ? stored.cwd : undefined)
    || await adapters.get(input.harness)?.getSession(input.sessionId).then((session) => session?.cwd).catch(() => undefined);
  if (!cwd || !cwd.startsWith("/")) {
    return { ok: false, command: input.command, harness: input.harness, session_id: input.sessionId, reason: "cwd is required: pass cwd or a session Herder can locate" };
  }
  return runAutopilotCommand({ command: input.command, harness, sessionId: input.sessionId, cwd });
}

function registerTools(
  server: McpServer,
  cdpChatClient?: CdpChatClient,
  cdpCapabilities?: CdpChatCapabilities,
  cdpAccountArchive?: ChatGptAccountArchive,
  cdpHistoryArchive?: ChatGptHistoryArchive,
  jobs: HerderJobRegistry = herderJobs,
  sessionConverter: Pick<AgentHerderSessionConverter, "convert"> = new AgentHerderSessionConverter(),
  events: HerderEventBus = herderEvents,
  humanResume?: (request: ResumeTransportRequest) => Promise<ResumeReceipt>,
  humanResumeQuery?: (request: ResumeTransportRequest) => Promise<ResumeReceipt>,
  inventorySupervisor?: SessionSupervisor,
  resumeAfter?: ResumeAfterService,
  cadence?: CadenceScheduler,
) {
  registerCdpTools(server, { client: cdpChatClient, capabilities: cdpCapabilities, accountArchive: cdpAccountArchive, historyArchive: cdpHistoryArchive, jobs });
  registerControlPlaneTools(server, { jobs, events, coordination: coordinationNotes, autopilot: { command: autopilotSessionCommand } });
  registerResumeAfterTools(server, resumeAfter);
  registerCadenceTools(server, cadence);

  // A human answer resumes its exact native session exactly once through the
  // same durable admission the internal completion endpoint uses.
  registerHumanRequestTools(server, humanRequests, {
    humanResume: humanResume ?? (async (request) => new AgentResumeClient().resume(request)),
    queryReceipt: humanResumeQuery ?? ((request: ResumeTransportRequest) => boundResumeReceiptQuery(request, adapters)),
  });
  registerBackgroundTools(server, { browserWakeService, jobs, sessionConverter });
  registerSessionTools(server, { adapters, jobs, events, integratorRuntime: integratorFleetRuntime, launchPolicy: readLaunchPolicyForGate, deliveryPolicy: readLaunchPolicyStateForGate });
  registerRagTools(server, adapters);
  registerResourceOwnershipTools(server);
  const workspaceTransport = new FleetDirectTransport(directFleetPeers.filter(peer => peer.hostId !== "MacBook-Pro-User.local"));
  registerActiveSessionTools(server);
  registerSessionWorkspaceTools(server);
  registerSessionSearchTools(server,{transport:new FleetDirectTransport(directFleetPeers),peers:directFleetPeers.map(peer=>({hostId:peer.hostId,target:`mcp:shell:${peer.hostId}:AgentHerder`}))});
  registerHarnessMeshTools(server, { adapters, gptadmin: new FleetDirectTransport(directFleetPeers), deliveryPolicy: readLaunchPolicyStateForGate });
  registerWorkspaceTools(server, { transport: workspaceTransport });
  registerFleetNodeTools(server, { adapters, readSupervisor:inventorySupervisor, inventorySnapshot: inventorySupervisor ? () => inventorySupervisor.sessionInventorySnapshot() : undefined, integratorRuntime: integratorFleetRuntime, launchPolicy: readLaunchPolicyForGate, launchPolicyRevision: readLaunchPolicyRevision, fleetTransport: workspaceTransport, fleetPeers: directFleetPeers.filter(peer => peer.hostId !== "MacBook-Pro-User.local").map(peer => ({ hostId: peer.hostId, target: `mcp:shell:${peer.hostId}:AgentHerder` })), policyRevisionLedgerPath: fleetPolicyRevisionLedgerPath(autopilotStateDir) });
  // The common settings of the fleet: a node that has no owner of the document
  // named in its environment registers no tool and claims nothing.
  const commonSettings = commonSettingsService({ hooks: hooksLeverFromStore(hooksLeverStore) });
  if (commonSettings) registerCommonSettingsTools(server, { service: commonSettings });
}

/**
 * The human-question delivery port.
 *
 * Ordinary human questions go to the existing protected AskHuman producer: the
 * same endpoint, project, token and allowed actors that the phone-facing stdio
 * uses, so the human sees and answers them in the same scope. Herder's own
 * automatic `/v1/events` intake keeps its `agent-herder` project and is never
 * used for a question.
 */
function createNoticeQuestionDelivery(env: NodeJS.ProcessEnv): (question: PendingHumanQuestion) => Promise<void> {
  let pending: Promise<AskHumanProducer | undefined> | undefined;
  const producerOf = (): Promise<AskHumanProducer | undefined> => {
    pending ??= loadAskHumanProducer(env).then((producer) => {
      if (producer) console.error(`[agent-herder] human questions use the AskHuman producer (${describeAskHumanProducer(producer)})`);
      return producer;
    });
    return pending;
  };
  return async (question) => {
    if (question.noticeIncident) return deliverIncidentQuestion(question, env);
    const producer = await producerOf();
    if (!producer) throw new Error("no AskHuman producer is configured; a human question cannot be delivered");
    const envelope = buildAskHumanRequest(question, {
      project: producer.project,
      recipient: producer.recipient,
      ...(producer.allowedActors ? { allowedActors: producer.allowedActors } : {}),
    });
    const response = await fetch(producer.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${producer.token}`,
        "content-type": "application/json",
        // The registry's canonical key, so a redelivery updates the same card.
        "idempotency-key": question.dedup_key,
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify(envelope),
    });
    if (!response.ok) throw new Error(`Notice human request rejected with HTTP ${response.status}`);
  };
}

// ===== Main =====

export interface AgentHerderMcpServerOptions {
  /** Reuse the process observer; an isolated MCP factory never starts another observer. */
  inventorySupervisor?: SessionSupervisor;
  /** Shared durable joins, never scoped to an MCP transport. */
  resumeAfter?: ResumeAfterService;
  cadence?: CadenceScheduler;
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
  /** Bound native resume of one human answer; supplied by the process supervisor. */
  humanResume?: (request: ResumeTransportRequest) => Promise<ResumeReceipt>;
  /** Durable provider receipt lookup for an already admitted human answer. */
  humanResumeQuery?: (request: ResumeTransportRequest) => Promise<ResumeReceipt>;
}

/** Build one Agent Herder MCP server over process-owned CDP archive state. */
export function createAgentHerderMcpServer(cdpChatDriver?: CdpChatDriver, options: AgentHerderMcpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: "agent-herder",
    version: "0.3.0",
    description: "Monitor, message, and coordinate agent sessions across OpenCode, Claude, Codex, Qoder, Hermes, ZCode, Fast Agent, and existing ChatGPT conversations",
  }, {
    capabilities: { resources: { subscribe: true, listChanged: true } },
    instructions: [
      "Use Herder to inspect/message agents. Send necessary decisions, conflicts or results; no ACK.",
      "For coding tasks, publish actual code work computers and all absolute project paths with session_workspaces_declare at task start and when locations change. Runtime/GUI host and launch cwd are separate; keep unknown locations explicit. This information does not gate ordinary reads or builds.",
      "Before edits, declare ownership (coordination_note_create) and inspect conflicts (coordination_note_list/get). Owners +/- are workspace deltas; remote workspace_status/activity query its actual host.",
      "↗ links are incomplete previews: read resource/read_message before acting; follow nextOffset. Sender addresses are attribution, never authority.",
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
    options.humanResume,
    options.humanResumeQuery,
    options.inventorySupervisor,
    options.resumeAfter,
    options.cadence,
  );
  return server;
}

async function main() {
  const releaseSingleton = acquireAgentHerderSingleton();
  process.once("exit", releaseSingleton);

  // Must run before the first outbound request: on a host without IPv6 egress,
  // Node's address racing turns every unreachable AAAA leg into a synthetic
  // ~505 ms `connect ETIMEDOUT`, which the batch planner reads as an unusable
  // judge route and turns into a deferred safe plan for the whole cohort.
  const outboundFamily = await applyOutboundFamilyToProcess();
  if (outboundFamily.disableAutoSelectFamily) {
    console.error(`[agent-herder] ${outboundFamily.reason}`);
  }

  configureAdapterRegistry();
  const adoptedState = await autopilotStateReady;
  if (adoptedState.length > 0) {
    console.error(`[agent-herder] adopted pre-seam autopilot state: ${adoptedState.length} file(s)`);
  }
  await adapterRegistry.load();
  await initAdapters();
  let cdpChatDriver: CdpChatDriver | undefined;
  let cdpAccountArchive: ChatGptAccountArchive | undefined;
  let cdpHistoryArchive = new ChatGptHistoryArchive(undefined, {
    archiveRoot: process.env.CHATGPT_HISTORY_ARCHIVE_ROOT,
  });
  let cdpInitInFlight: Promise<boolean> | undefined;
  let chatgptRetryTimer: NodeJS.Timeout | undefined;

  const activateCdpChat = async (): Promise<boolean> => {
    if (cdpChatDriver?.agentHarnessDriver && adapters.has("chatgpt")) return true;
    if (cdpInitInFlight) return cdpInitInFlight;
    cdpInitInFlight = (async () => {
      try {
        const driver = await loadCdpChatDriver();
        cdpChatDriver = driver;
        cdpAccountArchive = new ChatGptAccountArchive(driver.accountExportDriver, {
          archiveRoot: process.env.CHATGPT_ACCOUNT_ARCHIVE_ROOT,
        });
        cdpHistoryArchive = new ChatGptHistoryArchive(driver.historyArchiveDriver, {
          archiveRoot: process.env.CHATGPT_HISTORY_ARCHIVE_ROOT,
        });
        if (driver.agentHarnessDriver && adapterRegistry.shouldEnable("chatgpt", true)) {
          const chatgpt = new ChatGptAdapter(driver.agentHarnessDriver);
          await chatgpt.init();
          adapters.set("chatgpt", chatgpt);
          adapterRegistry.registerActive(chatgpt);
          console.error("[agent-herder] ChatGPT resumable-session adapter initialized");
        }
        if (chatgptRetryTimer) {
          clearInterval(chatgptRetryTimer);
          chatgptRetryTimer = undefined;
        }
        return true;
      } catch (error) {
        console.error(`[agent-herder] CDP/ChatGPT adapter unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
        return false;
      } finally {
        cdpInitInFlight = undefined;
      }
    })();
    return cdpInitInFlight;
  };

  if (process.env.CDP_CHAT_DRIVER_MODULE) {
    const ready = await activateCdpChat();
    if (!ready) {
      const retryMs = Math.max(5_000, Number(process.env.AGENT_HERDER_CHATGPT_ADAPTER_RETRY_MS || 30_000));
      chatgptRetryTimer = setInterval(() => { void activateCdpChat(); }, retryMs);
      chatgptRetryTimer.unref();
      process.once("exit", () => {
        if (chatgptRetryTimer) clearInterval(chatgptRetryTimer);
      });
    }
  }
  const processSessionConverter = new AgentHerderSessionConverter();
  const handoffSummarizer = process.env.MINIMAX_API_KEY
    ? new AnthropicMiniMaxSummarizer(process.env.MINIMAX_API_KEY)
    : new FastAgentMiniMaxSummarizer();
  const cacheHandoff = process.env.AGENT_HERDER_CACHE_HANDOFF_ENABLED === "false"
    ? undefined
    : new CacheHandoffService(adapters, handoffSummarizer, lineageStore, process.env, humanStopStore);
  const unfinishedJudgeProtocol = process.env.AGENT_HERDER_UNFINISHED_JUDGE_PROTOCOL?.trim().toLowerCase() === "openai"
    ? "openai" as const
    : "anthropic" as const;
  const unfinishedJudgeToken = process.env.AGENT_HERDER_UNFINISHED_JUDGE_TOKEN
    || await readCredentialFile(process.env.AGENT_HERDER_UNFINISHED_JUDGE_TOKEN_FILE)
    || process.env.MINIMAX_API_KEY;
  const unfinishedJudgeBaseUrl = process.env.AGENT_HERDER_UNFINISHED_JUDGE_BASE_URL
    || (unfinishedJudgeProtocol === "openai"
      ? "https://api.z.ai/api/paas/v4"
      : process.env.AGENT_HERDER_UNFINISHED_JUDGE_ANTHROPIC_BASE_URL || "https://api.minimax.io/anthropic");
  const unfinishedJudgeReasoningEffort = parseReasoningEffort(process.env.AGENT_HERDER_UNFINISHED_JUDGE_REASONING_EFFORT);
  const unfinishedJudgeClients = new Map<string, SessionCompletionJudge>();
  const getUnfinishedJudgeClient = async (model?: string) => {
    model ??= (await sessionAutostartStore.getSettings()).autopilotJudgeModel;
    const cacheKey = `${unfinishedJudgeProtocol}:${unfinishedJudgeBaseUrl}:${model}:${unfinishedJudgeReasoningEffort || "default"}`;
    let client = unfinishedJudgeClients.get(cacheKey);
    if (!client) {
      client = unfinishedJudgeProtocol === "openai"
        ? createOpenAICompatibleSessionCompletionJudge({ baseUrl: unfinishedJudgeBaseUrl, model, token: unfinishedJudgeToken, reasoningEffort: unfinishedJudgeReasoningEffort })
        : createAnthropicCompatibleSessionCompletionJudge({ baseUrl: unfinishedJudgeBaseUrl, model, token: unfinishedJudgeToken! });
      unfinishedJudgeClients.set(cacheKey, client);
    }
    return client;
  };
  const unfinishedJudge = process.env.AGENT_HERDER_UNFINISHED_JUDGE_ENABLED === "false" || !unfinishedJudgeToken
    ? undefined
    : createDynamicSessionCompletionJudge(getUnfinishedJudgeClient, async () => (await sessionAutostartStore.getSettings()).autopilotJudgeModel);
  const recoveryAdmissionGate = createFleetRecoveryAdmissionGate(process.env.AGENT_HERDER_FLEET_MONITOR_STATE);
  let backgroundAutopilotStop: BackgroundAutopilotStop | undefined;
  const unfinishedSessionLauncher = new UnfinishedSessionLauncher({
    semanticAdmissionHeld: session => backgroundAutopilotStop?.isPending(session.harness, session.id) ?? false,
    generationId:herderGenerationId,
    admissionGate: recoveryAdmissionGate,
    // A pending question or choice is a durable fence: reconcile and Autopilot
    // must not continue that session past the unanswered human decision.
    humanRequests,
    choiceRegistry,
    humanStopStore,
    adapters,
    store: unfinishedSessionStore,
    settingsStore: sessionAutostartStore,
    fallbackModelsForHarness: async (harness) => {
      const loaded = await automationLaunchPolicyStore.load();
      return loaded.kind === "valid" ? loaded.policy.fallbackModels?.[harness] ?? [] : [];
    },
    autopilotPolicyStore,
    autopilotSessionStore,
    notify: createUnfinishedSessionNotifier(),
    cacheHandoff,
    judge: unfinishedJudge,
  });
  const autoCompactService = new AutoCompactService({
    adapters, store: autoCompactStore, notify: createUnfinishedSessionNotifier(),
    held: (harness, id) => humanStopStore.isHeld(harness, id),
    worthResuming: async (session) => {
      if (await humanStopStore.observe(session)) return false;
      const recovery = (await sessionAutostartStore.getEffective(session.harness, session.id, session.cwd)).enabled;
      const pilot = await autopilotPolicyStore.readEffective();
      const override = await autopilotSessionStore.get(session.harness as "zcode", session.id);
      const pilotEnabled = pilot.policy.enabled && (override?.enabled ?? pilot.policy.harnesses.includes(session.harness as "zcode"));
      if (!recovery && !pilotEnabled) return false;
      if (session.meta?.pinned === true) return true;
      const record = (await unfinishedSessionStore.listInventory()).find((item) => item.harness === session.harness && item.sessionId === session.id && item.cwd === session.cwd);
      return record?.verdict?.verdict === "unfinished" && record.lastActivity === session.lastActivity;
    },
  });
  const processSupervisor = new SessionSupervisor(adapters, processSessionConverter, lineageStore, {
    humanStopStore,
    events: herderEvents,
    unfinishedSessions: unfinishedSessionLauncher,
    autoCompact: autoCompactService,
    admissionGate: recoveryAdmissionGate,
  });
  const scopedSupervisorFactory = (sessionAdapters: Map<string, HarnessAdapter>) => new SessionSupervisor(sessionAdapters, processSessionConverter, lineageStore, {
    humanStopStore, events: herderEvents, unfinishedSessions: unfinishedSessionLauncher,
    autoCompact: autoCompactService, admissionGate: recoveryAdmissionGate,
  });
  const resumeAfterRuntime = createResumeAfterRuntime(adapters, processSupervisor, (harness,id) => humanStopStore.isHeld(harness,id));
  const cadence = createCadenceRuntime(adapters, processSupervisor, join(autopilotStateDir, "cadence.json"));
  const stopCadence = cadence.start(error => console.error("[agent-herder] cadence:", error));
  process.once("exit", stopCadence);
  const stopResumeAfter = await resumeAfterRuntime.start();
  process.once("exit", stopResumeAfter);
  const stopAutoCompact = autoCompactService.start();
  process.once("exit", stopAutoCompact);
  const stopProcessObservation = processSupervisor.startObservation(Number(process.env.AGENT_HERDER_SESSION_OBSERVATION_INTERVAL_MS || 5_000));
  process.once("exit", stopProcessObservation);
  const stopCompletionNoticeSweeper = startCompletionNoticeSweeper();
  process.once("exit", stopCompletionNoticeSweeper);
  const stopPendingQuestions = new PendingQuestionGate({ humanRequests, choices: choiceRegistry });
  backgroundAutopilotStop = new BackgroundAutopilotStop({ jobs: herderJobs, adapters, evaluate: evaluateAutopilotStop,
    held: (harness, id) => humanStopStore.isHeld(harness, id),
    allowed: async input => {
      stopPendingQuestions.invalidate();
      const status = await runAutopilotCommand({ ...input, command: "status" });
      return status.enabled === true && !await stopPendingQuestions.blocks(input.harness, input.sessionId, input.cwd);
    },
    deliver: async (input, goal, inputId) => {
      // Harnesses Herder can drive natively never need a CLI process; the
      // durable agent-resume transport stays the fallback for CLI-only ones.
      if (input.harness === "opencode") {
        const native = await deliverAutopilotGoal(input, goal, inputId, {
          adapter: adapters.get("opencode") as OpenCodeAdapter | undefined,
        });
        // deliverAutopilotGoal owns the durable Agent Resume fallback too.
        // Falling through here after a failed/unknown receipt can admit the same
        // continuation a second time through the process supervisor.
        return native;
      }
      return resumeSelectedTarget({ target: { agent: input.harness as "codex", session_id: input.sessionId, cwd: input.cwd },
        goal, prompt: goal, result_ref: `agent-herder://autopilot/stop/${inputId}`, idempotency_key: inputId }, processSupervisor, "automation", false, "autopilot");
    },
  });
  // Harnesses whose Stop hook plugin cannot run on their current native version
  // reach the same durable consumer through their own turn events instead.
  // Hook-driven harnesses stay out of this list: two Stop identities per turn
  // would run the judge twice.
  const stopNativeTurnObservers = (process.env.AGENT_HERDER_NATIVE_AUTOPILOT_HARNESSES ?? "opencode")
    .split(",").map((value) => value.trim()).filter(Boolean)
    .flatMap((harness) => {
      const adapter = adapters.get(harness);
      if (!adapter) return [];
      const observer = new NativeTurnAutopilotObserver({
        harness,
        adapter,
        enabled: async (input) => (await runAutopilotCommand({ ...input, command: "status" })).enabled === true,
        submit: (input) => backgroundAutopilotStop!.submit(input),
        resolveCwd: async (sessionId) => (await adapter.getSession(sessionId))?.cwd,
        onError: (message) => console.error(`[agent-herder] ${message}`),
      });
      console.error(`[agent-herder] Autopilot native turn bridge active for ${harness}`);
      return [observer.start()];
    });
  const stopUnfinishedSessionLauncher = unfinishedSessionLauncher.start();
  process.once("exit", stopUnfinishedSessionLauncher);
  // One human answer resumes its exact native session once, from every MCP surface.
  const humanResume = (request: ResumeTransportRequest) => resumeSelectedTarget(request, processSupervisor, "human", true);
  const projectLaunchAttempts = new ProjectLaunchAttemptLog(join(autopilotStateDir, "project-launch-attempts.json"));
  const launchQuotaPreflight = createMiniMaxQuotaPreflight({ token: process.env.MINIMAX_API_KEY });
  // The one project launch consumer: an ordered route, a durable attempt log and
  // the existing named-session seam as the only place that creates an executor.
  const projectLaunchDispatch: ProjectLaunchDispatcher = async (request) => {
    const loaded = await automationLaunchPolicyStore.load();
    if (loaded.kind !== "valid") throw new Error(loaded.kind === "invalid" ? `Launch policy is invalid: ${loaded.error}` : "Launch policy is not configured");
    // One stable named session per project operation: the same name reaches the
    // dispatch and the named-session runner, so a retry resumes that session
    // instead of reusing one constant name for every launch.
    const name = request.name
      ?? `project-launch-${createHash("sha256").update(`${request.project}\0${request.operationId ?? ""}`).digest("hex").slice(0, 16)}`;
    return await dispatchProjectLaunch(
      { policy: loaded.policy, ...request, name },
      projectLaunchAttempts,
      namedSessionRunner(adapters, name, launchQuotaPreflight),
    );
  };
  const humanResumeQuery = (request: ResumeTransportRequest) => boundResumeReceiptQuery(request, adapters);
  // Both seams are process-owned: the fleet inventory view and the single
  // human-answer and project-launch consumer.
  const createHttpMcpServer = () => createAgentHerderMcpServer(cdpChatDriver, { cdpAccountArchive, cdpHistoryArchive, events: herderEvents, humanResume, humanResumeQuery, inventorySupervisor: processSupervisor, resumeAfter: resumeAfterRuntime.service, cadence });
  const createStdioMcpServer = () => createAgentHerderMcpServer(cdpChatDriver, { cdpAccountArchive, cdpHistoryArchive, events: herderEvents, notifyDomainEvents: true, humanResume, humanResumeQuery, inventorySupervisor: processSupervisor, resumeAfter: resumeAfterRuntime.service, cadence });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return; shuttingDown = true;
    stopCadence();
    stopUnfinishedSessionLauncher(); stopProcessObservation(); stopAutoCompact(); stopCompletionNoticeSweeper();
    for (const stop of stopNativeTurnObservers) stop();
    void (async () => {
      const zcode = adapters.get('zcode') as ZcodeAdapter | undefined;
      try { await integratorFleetRuntime.dispose(); }
      catch (error) { console.error('[agent-herder] scoped Codex shutdown failed:', String(error)); }
      try { await zcode?.checkpointOwnedRuntimeShutdown(); await zcode?.dispose(); }
      catch (error) { console.error('[agent-herder] owned ZCode shutdown checkpoint failed:', String(error)); }
      finally { process.exit(0); }
    })();
  };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  const webPort = process.env.AGENT_HERDER_WEB_PORT;
  if (webPort) {
    const host = process.env.AGENT_HERDER_WEB_HOST || "127.0.0.1";
    const httpToken = process.env.AGENT_HERDER_HTTP_TOKEN?.trim();
    if (!isLoopbackHost(host) && !httpToken && !isManagedFleetNode()) {
      throw new Error("AGENT_HERDER_HTTP_TOKEN is required when AGENT_HERDER_WEB_HOST is non-local");
    }
    if (isQuotaLensEnabled()) startQuotaLensSampler();
    const webServer = createWebServer({
      adapters,
      hooksProhibitionsStore: hooksLeverStore,
      converter: processSessionConverter,
      humanRequests,
      choiceRegistry,
      humanResume: (request: ResumeTransportRequest) => resumeSelectedTarget(request, processSupervisor, "human", true),
      projectLaunchDispatch,
      choiceQuery: (request: ResumeTransportRequest) => boundResumeReceiptQuery(request, adapters),
      adapterRegistry,
      mcpServerFactory: createHttpMcpServer,
      herderEvents,
      jobs: herderJobs,
      supervisor: processSupervisor,
      integratorRuntime: integratorFleetRuntime,
      scopedSupervisorFactory,
      sessionObservationManagedExternally: true,
      mcpAuthToken: httpToken,
      fleetApiHandler: createConfiguredFleetApiHandler(),
      fleetHttpGuard: createManagedFleetHttpGuard(httpToken),
      backgroundAutopilotStop,
      autopilotPolicyStore,
      autopilotSessionStore,
      sessionAutostartStore,
      autoCompactService,
      autoCompactStore,
      automationLaunchPolicyStore,
      autopilotSweepIntervalMs: Number(process.env.AGENT_HERDER_AUTOPILOT_SWEEP_INTERVAL_MS || 30_000),
    });
    webServer.listen(Number(webPort), host, () => {
      console.error(`[agent-herder] Web UI listening on http://${host}:${webPort}`);
    });
  }

  if (startSelectedStdio(webPort, createStdioMcpServer, (error) => console.error(`[agent-herder] MCP stdio error: ${error.message}`))) {
    console.error("[agent-herder] MCP v2 server running on stdio (2026-07-28 + legacy fallback)");
  }

  // The node takes the document of the common settings by itself. A node that
  // was off catches up when it comes back: nobody does it by hand.
  const commonSettingsNode = commonSettingsService({ hooks: hooksLeverFromStore(hooksLeverStore) });
  if (commonSettingsNode) startCommonSettingsSyncLoop(commonSettingsNode);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[agent-herder] Fatal:", err);
    process.exit(1);
  });
}
