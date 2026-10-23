import { readCodexActiveRuntime, type CodexActiveReceipt } from "./codex-active-runtime.js";
import { terminalQuotaFailure, type TerminalQuotaFailure } from "./quota-failure.js";
import { execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { isAbsolute, join, resolve } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { assertCodexQuota, CodexQuotaBlockedError, type QuotaReader } from "../codex-quota-guard.js";
import { CodexDeliveryReceipts } from "./codex-delivery-receipts.js";
import WebSocket from "ws";
import { getHumanStopStore } from "../human-stop-store.js";
import { CodexAdapter, type CodexAutomationStop, type CodexNativeAutomationMetadata } from "./codex.js";
import { spawnIsolatedWorkload } from "../workload-launcher.js";
import {
  assertCodexProjectRoot,
  codexProjectAppServerArgs,
  codexProjectIntegrationFeatureDeny,
  codexProjectNativeWebSearch,
  codexProjectFilesystemProfileDeny,
  codexProjectDiscoveryDenyList,
  codexProjectPermissionObserved,
  codexProjectResumeParams,
  codexProjectThreadParams,
  codexProjectTurnParams,
  CODEX_PROJECT_MODEL_ID,
  type CodexProjectToolDenyList,
  type CodexProjectRuntimePolicy,
} from "../project-runtime-policy.js";
import type {
  AgentSession,
  ControlResult,
  CreateSessionOptions,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
  MessageAdmissionResult,
  SendMessageOptions,
  SetPermissionsOptions,
  RawTranscriptExport,
  SessionMessageView,
  SessionSnapshotReceipt,
} from "../types/index.js";
import { localSessionHostId } from "../types/index.js";
import type { IntegratorCurrentProjectScopeEvidence } from "../integrator-session-admission.js";
import { IntegratorSessionBindingStore, type IntegratorAttemptScope, type IntegratorHarness } from "../integrator-session-binding.js";
import { resolveProjectExecutionScope, type TrustedRuntimeOwnerResolver } from "../project-execution-scope.js";
import type { ProjectExecutionBinding } from "../project-execution-scope.js";

const execFileAsync = promisify(execFile);

interface ProjectScopeDirectoryIdentity {
  path: string;
  device: number;
  inode: number;
}

interface RpcResponse {
  id?: number;
  emittedAtMs?: number;
  result?: unknown;
  error?: { message?: string; code?: number };
}

class CodexRpcError extends Error {
  constructor(message: string, readonly code?: number) { super(message); }
}

interface CodexThread {
  id: string;
  parentThreadId?: string;
  cwd?: string;
  path?: string;
  name?: string;
  preview?: string;
  model?: string | null;
  modelProvider?: string;
  status?: string | { type?: string; activeFlags?: string[] };
  createdAt?: string | number;
  updatedAt?: string | number;
}

interface CodexThreadPermissionState {
  approvalPolicy?: unknown;
  sandbox?: { type?: unknown };
  activePermissionProfile?: { id?: unknown } | null;
  runtimeWorkspaceRoots?: unknown;
}

/** Native terminal evidence, not a Stop invocation or a business verdict. */
export interface CodexTrackedTurnCompletion {
  session: AgentSession;
  turnId: string;
  fingerprint: string;
  transcriptTail: string;
}

interface CodexProjectToolInventory {
  complete: boolean;
  denyList: CodexProjectToolDenyList;
  active: boolean;
  nativeWebSearch: { complete: boolean; mode: string; origin: string };
  summary: string;
}

export interface CodexProjectReadinessEvidence {
  isolated: boolean;
  nativeWebSearch: { complete: boolean; mode: string; origin: string };
  availableModels: string[];
  harnessVersion: string | null;
}

interface CodexProjectCommandReceipt {
  itemId: string;
  turnId: string;
  command: string;
  cwd: string;
  status?: string;
  exitCode?: number | null;
  output: string;
}

/** Nonsecret, immediately observable materialization checkpoint. */
export interface CodexMaterializationProgress {
  phase: "reserved" | "native_created" | "accepted" | "turn_admitted" | "command_observed" | "command_completed"
    | "restore_preflight" | "restore_read" | "restore_resumed" | "failure";
  operationId: string;
  inputId?: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  cwd?: string;
  commandSha256?: string;
  outputSha256?: string;
  status?: string;
  exitCode?: number | null;
  failureStage?: string;
  failureType?: string;
}

function hasCodexFullAccess(state: CodexThreadPermissionState): boolean {
  return state.approvalPolicy === "never" && state.sandbox?.type === "dangerFullAccess";
}

function withKnownModel(session: AgentSession, model: unknown): AgentSession {
  const normalized = { ...session };
  if (typeof model === "string") normalized.model = model;
  else delete normalized.model;
  return normalized;
}

function mergeAutomationMetadata(meta: AgentSession["meta"], automation: CodexNativeAutomationMetadata): AgentSession["meta"] {
  const merged = { ...meta };
  delete merged.automationStop;
  if (automation.automationStop) merged.automationStop = automation.automationStop;
  return merged;
}

function threadTimestamp(value: string | number | undefined): string | undefined {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
    const parsed = new Date(milliseconds);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
  }
  return undefined;
}

/** Exact failed native turn only; generic RPC errors and missing native input stay unknown. */
export function codexTerminalQuotaEvidence(value: unknown, model: string | null | undefined): TerminalQuotaFailure | undefined {
  if (!value || typeof value !== "object" || !model) return undefined;
  const turn = value as Record<string, unknown>;
  if (turn.status !== "failed" || !threadTimestamp(turn.completedAt as string | number | undefined)) return undefined;
  const items = Array.isArray(turn.items) ? turn.items as Array<Record<string, unknown>> : [];
  const user = [...items].reverse().find(item => item.type === "userMessage" && typeof item.id === "string");
  const error = turn.error && typeof turn.error === "object" ? turn.error as Record<string, unknown> : {};
  return terminalQuotaFailure({ terminal: true, status: "failed", nativeTurnId: typeof turn.id === "string" ? turn.id : undefined,
    inputId: typeof user?.id === "string" ? user.id : undefined, providerId: "codex", modelId: model,
    errorCode: typeof error.codexErrorInfo === "string" ? error.codexErrorInfo : undefined,
    errorMessage: typeof error.message === "string" ? error.message : undefined });
}

interface TurnCompletion {
  resolve: (result: ControlResult) => void;
  timer: NodeJS.Timeout;
  requestedTurnId?: string;
  startedTurnId?: string;
  completedTurnId?: string;
  completedStatus?: string;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Persistent native transport for Codex's JSONL app-server or shared Unix socket.
 *
 * Codex owns thread and turn state. A configured Unix socket lets this adapter
 * share that authority with another client instead of starting a competing
 * app-server writer.
 */
export class CodexAppServerAdapter implements HarnessAdapter {
  readonly type = "codex" as const;
  readonly name = "Codex app-server";
  readonly lazyStart = true;
  readonly lazyDiscovery = true;
  readonly controlCapabilities: HarnessCapabilities = {
    imageInput: true, steer: true,
    cancelTurn: true,
    detach: true,
    resume: true,
    terminate: false,
    recover: true,
    fork: true,
    modelSwitch: true,
    subagents: true,
    events: true,
  };

  private readonly codexBin: string;
  private readonly quotaReader?: QuotaReader;
  private readonly processArgs: string[];
  private readonly cwd: string;
  private readonly socketPath?: string;
  private readonly modelIds: string[];
  private readonly appServerDataHome: string;
  private readonly transcriptReaderDataHome: string;
  private readonly projectRuntimePolicy?: CodexProjectRuntimePolicy;
  private readonly projectToolDenyList?: CodexProjectToolDenyList;
  private readonly integratorSessionBindingStore?: IntegratorSessionBindingStore;
  private readonly projectRuntimeOwner?: TrustedRuntimeOwnerResolver;
  private readonly onMaterializationProgress?: (progress: CodexMaterializationProgress) => void;
  private readonly lifecycleSignal?: AbortSignal;
  private readonly abortListener: () => void;
  private disposed = false;
  private disposal?: Promise<void>;
  private materializationObserverFailed = false;
  private readonly rawTranscriptAdapter: CodexAdapter;
  private readonly requestTimeoutMs: number;
  private readonly deliveryReceipts: CodexDeliveryReceipts;
  private readonly deliveryTails = new Map<string, Promise<void>>();
  private child?: ChildProcessWithoutNullStreams;
  private socket?: WebSocket;
  private initialized = false;
  private initialization?: Promise<void>;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly threads = new Map<string, CodexThread>();
  private readonly projectLiveMessages = new Map<string, SessionMessageView[]>();
  private readonly projectCommandReceipts = new Map<string, CodexProjectCommandReceipt[]>();
  private readonly fullAccessThreads = new Set<string>();
  private readonly projectThreadIds = new Set<string>();
  private readonly activeTurns = new Map<string, string>();
  private readonly eventStartedTurns = new Set<string>();
  private readonly lastNativeTurns = new Map<string, { turnId: string; status: string; completedAt?: string; inputId?: string; userMessageId?: string; quotaFailure?: TerminalQuotaFailure }>();
  private readonly unavailableNativeTurnStates = new Set<string>();
  private readonly completions = new Map<string, TurnCompletion>();
  private readonly internalInterrupts = new Map<string, { turnId: string; expiresAt: number }>();
  private readonly transportCleanups = new WeakMap<ChildProcessWithoutNullStreams, () => void>();
  private readonly socketCleanups = new WeakMap<WebSocket, () => void>();
  private stderrTail = "";
  private readonly eventListeners = new Set<(event: HarnessEvent) => void>();
  private sessionSnapshotReceipt: SessionSnapshotReceipt = {
    exhaustive: false,
    observedAt: new Date(0).toISOString(),
    source: "codex-app-server",
    reason: "not_observed",
  };

  constructor(config: {
    /** Trusted dependency for embedding/tests; never populated from tool arguments. */
    quotaReader?: QuotaReader;
    codexBin?: string;
    /** Exact process arguments. Defaults to the native `app-server` command. */
    args?: string[];
    cwd?: string;
    /** Existing app-server control socket to share its thread writer authority. */
    socketPath?: string;
    modelIds?: string[];
    requestTimeoutMs?: number;
    /** Codex's local data root holding native rollout JSONL files. */
    codexDir?: string;
    /** Trusted, per-attempt policy. Forces a dedicated app-server process. */
    projectRuntimePolicy?: CodexProjectRuntimePolicy;
    /** Generated only from in-process, non-secret integration metadata. */
    projectToolDenyList?: CodexProjectToolDenyList;
    /** Trusted composition-root H34 journal and fresh H31 proof resolver. */
    integratorSessionBindingStore?: IntegratorSessionBindingStore;
    projectRuntimeOwner?: TrustedRuntimeOwnerResolver;
    onMaterializationProgress?: (progress: CodexMaterializationProgress) => void;
    signal?: AbortSignal;
  } = {}) {
    this.quotaReader = config.quotaReader;
    this.codexBin = config.codexBin || process.env.CODEX_BIN || "codex";
    this.projectRuntimePolicy = config.projectRuntimePolicy;
    this.projectToolDenyList = config.projectToolDenyList;
    this.integratorSessionBindingStore = config.integratorSessionBindingStore;
    this.projectRuntimeOwner = config.projectRuntimeOwner;
    this.onMaterializationProgress = config.onMaterializationProgress;
    this.lifecycleSignal = config.signal;
    this.abortListener = () => {
      void this.dispose().catch((error: unknown) => {
        this.emitEvent({ kind: "process.disconnected", harness: "codex", data: {
          transport: "app-server", reason: "owned-child-cleanup-unconfirmed",
          error: error instanceof Error ? error.name : "Error",
        } });
      });
    };
    if (this.projectToolDenyList && !this.projectRuntimePolicy) {
      throw new Error("project tool deny overlays require a trusted project runtime policy");
    }
    if (this.projectRuntimePolicy && (config.socketPath || process.env.CODEX_APP_SERVER_SOCKET || config.args)) {
      throw new Error("project-scoped Codex requires its own app-server process and generated policy arguments");
    }
    if (this.projectRuntimePolicy?.materialized && (!this.integratorSessionBindingStore || !this.projectRuntimeOwner)) {
      throw new Error("materialized project Codex requires the trusted H34 journal and H31 runtime owner");
    }
    this.processArgs = this.projectRuntimePolicy ? codexProjectAppServerArgs(
      this.projectToolDenyList, this.codexBin, this.projectRuntimePolicy.nativeWebSearchMode,
    ) : (config.args || ["app-server"]);
    this.cwd = config.cwd || process.cwd();
    this.appServerDataHome = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
    this.transcriptReaderDataHome = resolve(config.codexDir || process.env.CODEX_DATA_DIR || join(homedir(), ".codex"));
    this.socketPath = config.socketPath ?? process.env.CODEX_APP_SERVER_SOCKET;
    if (this.socketPath && (!isAbsolute(this.socketPath) || this.socketPath.includes(":") || this.socketPath.includes("?"))) {
      throw new Error("CODEX_APP_SERVER_SOCKET must be an absolute Unix socket path without ':' or '?' characters");
    }
    this.modelIds = config.modelIds || [];
    this.requestTimeoutMs = config.requestTimeoutMs || 30_000;
    this.deliveryReceipts = new CodexDeliveryReceipts(config.codexDir);
    this.rawTranscriptAdapter = new CodexAdapter({
      codexBin: this.codexBin,
      codexDir: this.projectRuntimePolicy ? this.transcriptReaderDataHome : config.codexDir,
    });
    if (this.lifecycleSignal?.aborted) this.disposed = true;
    else this.lifecycleSignal?.addEventListener("abort", this.abortListener, { once: true });
    if (this.disposed) void this.dispose();
  }

  /**
   * Discover only IDs/flags in a first owned child, then start a second child
   * with explicit per-ID denies. No thread or model turn exists in discovery.
   */
  static async createProjectScoped(config: {
    policy: CodexProjectRuntimePolicy;
    codexBin?: string;
    cwd?: string;
    requestTimeoutMs?: number;
    codexDir?: string;
    integratorSessionBindingStore?: IntegratorSessionBindingStore;
    projectRuntimeOwner?: TrustedRuntimeOwnerResolver;
    onMaterializationProgress?: (progress: CodexMaterializationProgress) => void;
    signal?: AbortSignal;
    /** Called synchronously as soon as each factory-owned child adapter exists. */
    onOwnedAdapter?: (adapter: CodexAppServerAdapter) => void;
  }): Promise<CodexAppServerAdapter> {
    throwIfSignalAborted(config.signal);
    const discovery = new CodexAppServerAdapter({
      codexBin: config.codexBin,
      cwd: config.cwd || config.policy.rootPath,
      requestTimeoutMs: config.requestTimeoutMs,
      codexDir: config.codexDir,
      projectRuntimePolicy: config.policy,
      integratorSessionBindingStore: config.integratorSessionBindingStore,
      projectRuntimeOwner: config.projectRuntimeOwner,
      onMaterializationProgress: config.onMaterializationProgress,
      signal: config.signal,
    });
    let inventory: CodexProjectToolInventory;
    try {
      config.onOwnedAdapter?.(discovery);
      await discovery.init();
      discovery.assertLifecycleActive();
      inventory = await discovery.readProjectToolInventory(undefined, true);
      discovery.assertLifecycleActive();
    } finally {
      await discovery.dispose();
    }
    throwIfSignalAborted(config.signal);
    if (!inventory.complete) {
      throw new Error(`Codex project deny discovery incomplete (${inventory.summary})`);
    }

    const isolated = new CodexAppServerAdapter({
      codexBin: config.codexBin,
      cwd: config.cwd || config.policy.rootPath,
      requestTimeoutMs: config.requestTimeoutMs,
      codexDir: config.codexDir,
      projectRuntimePolicy: config.policy,
      projectToolDenyList: inventory.denyList,
      integratorSessionBindingStore: config.integratorSessionBindingStore,
      projectRuntimeOwner: config.projectRuntimeOwner,
      onMaterializationProgress: config.onMaterializationProgress,
      signal: config.signal,
    });
    try {
      config.onOwnedAdapter?.(isolated);
      await isolated.init();
      isolated.assertLifecycleActive();
      const effective = await isolated.readProjectToolInventory();
      isolated.assertLifecycleActive();
      if (!effective.complete || effective.active) {
        throw new Error(`Codex project deny overlay did not isolate effective tools (${effective.summary})`);
      }
      return isolated;
    } catch (error) {
      await isolated.dispose();
      throw error;
    }
  }

  async init(): Promise<void> {
    await this.ensureReady();
  }

  /** Read-only host capability evidence; this does not create a thread or run a model turn. */
  async readProjectReadinessEvidence(): Promise<CodexProjectReadinessEvidence> {
    if (!this.projectRuntimePolicy) throw new Error("project readiness requires a trusted project policy");
    this.assertLifecycleActive();
    const [inventory, models, harnessVersion] = await Promise.all([
      this.readProjectToolInventory(),
      this.listModels(),
      this.verifiedNativeHarnessVersion(),
    ]);
    this.assertLifecycleActive();
    return {
      isolated: inventory.complete && !inventory.active,
      nativeWebSearch: inventory.nativeWebSearch,
      availableModels: models,
      harnessVersion,
    };
  }

  isReady(): boolean {
    return this.initialized && (this.socketPath
      ? this.socket?.readyState === WebSocket.OPEN
      : !!this.child && !this.child.killed);
  }

  subscribeEvents(handler: (event: HarnessEvent) => void): () => void {
    this.eventListeners.add(handler);
    if (this.isReady()) queueMicrotask(() => handler({
      kind: "process.connected",
      harness: "codex",
      data: { transport: this.socketPath ? "app-server-unix-websocket" : "app-server" },
    }));
    return () => { this.eventListeners.delete(handler); };
  }

  async dispose(): Promise<void> {
    if (!this.disposal) this.disposal = this.disposeOwned();
    return this.disposal;
  }

  private async disposeOwned(): Promise<void> {
    this.disposed = true;
    this.lifecycleSignal?.removeEventListener("abort", this.abortListener);
    this.initialized = false;
    const pendingInitialization = this.initialization;
    const socket = this.socket;
    if (socket) {
      this.handleSocketDisconnect(socket, new Error("Codex app-server disposed"), { reason: "disposed" });
      const closed = waitForSocketClose(socket, 1_000);
      socket.close();
      await closed;
    }
    const child = this.child;
    if (child) {
      this.handleTransportDisconnect(child, new Error("Codex app-server disposed"), { reason: "disposed" });
      await terminateOwnedChild(child);
    } else {
      this.rejectPending(new Error("Codex app-server disposed"));
      this.failCompletions(new Error("Codex app-server disposed"));
      this.activeTurns.clear();
      this.eventStartedTurns.clear();
      this.initialized = false;
    }
    await pendingInitialization?.catch(() => undefined);
  }

  private activeSessionSnapshotReceipt: CodexActiveReceipt | null = null;

  getActiveSessionSnapshotReceipt(): CodexActiveReceipt | null { return this.activeSessionSnapshotReceipt; }

  /** Existing connected controller only; no historical index or runtime startup. */
  async listActiveSessions(): Promise<AgentSession[]> {
    this.activeSessionSnapshotReceipt = null;
    if (!this.isReady()) throw new Error("codex_active_existing_transport_unavailable");
    if (this.projectRuntimePolicy && !(await this.hasCurrentProjectRoot())) throw new Error("codex_active_project_root_changed");
    const result = await readCodexActiveRuntime((method, params) => this.request(method, params),
      thread => this.toSession(thread),
      thread => !this.projectRuntimePolicy || (this.projectThreadIds.has(thread.id) && thread.cwd === this.projectRuntimePolicy.rootPath));
    this.activeSessionSnapshotReceipt = result.receipt;
    return result.sessions;
  }

  async listSessions(options: {limit?: number} = {}): Promise<AgentSession[]> {
    if (this.projectRuntimePolicy) {
      if (!(await this.hasCurrentProjectRoot())) {
        this.sessionSnapshotReceipt = {
          exhaustive: false,
          observedAt: new Date().toISOString(),
          source: "codex-app-server",
          reason: "project_root_identity_changed",
        };
        return [];
      }
      const ownedThreads = [...this.projectThreadIds].flatMap((id) => {
        const thread = this.threads.get(id);
        return thread?.id === id && thread.cwd === this.projectRuntimePolicy!.rootPath ? [thread] : [];
      }).sort((a, b) =>
        Date.parse(threadTimestamp(b.updatedAt) || threadTimestamp(b.createdAt) || new Date(0).toISOString())
        - Date.parse(threadTimestamp(a.updatedAt) || threadTimestamp(a.createdAt) || new Date(0).toISOString())
        || a.id.localeCompare(b.id));
      const limit = options.limit ? Math.max(1, Math.min(Math.floor(options.limit), 100)) : undefined;
      const bounded = limit !== undefined && ownedThreads.length > limit;
      this.sessionSnapshotReceipt = {
        exhaustive: !bounded,
        observedAt: new Date().toISOString(),
        source: "codex-app-server",
        reason: bounded ? "bounded_project_owned_page" : "project_owned_threads_only",
      };
      return (limit === undefined ? ownedThreads : ownedThreads.slice(0, limit)).map((thread) => this.toSession(thread));
    }
    this.sessionSnapshotReceipt = {
      exhaustive: false,
      observedAt: new Date().toISOString(),
      source: this.isReady() || this.socketPath ? "codex-app-server" : "codex-state-index",
      reason: "enumeration_in_progress",
    };
    if (!this.isReady() && !this.socketPath) {
      const sessions = await this.rawTranscriptAdapter.listSessions();
      this.sessionSnapshotReceipt = this.rawTranscriptAdapter.getSessionSnapshotReceipt();
      return sessions;
    }
    try {
      await this.ensureReady();
      let bounded = false;
      let candidatePartial: string | undefined;
      let sessions: CodexThread[];
      if (options.limit) {
        const limit = Math.max(1, Math.min(Math.floor(options.limit), 100));
        const page = await this.request("thread/list", {limit, archived:false, sortKey:"updated_at", sortDirection:"desc"}) as {data?:CodexThread[];nextCursor?:string|null};
        sessions = page.data || [];
        bounded = Boolean(page.nextCursor);
        const indexed = await this.rawTranscriptAdapter.getNativeUnmaterializedThreadIds(limit);
        if (!indexed.available) candidatePartial = "native_unmaterialized_index_unavailable";
        bounded ||= indexed.limited;
        let loadedIds: string[] = [];
        try {
          const loaded = await this.request("thread/loaded/list", {limit}) as {data?:unknown[];nextCursor?:string|null};
          if (!Array.isArray(loaded.data) || loaded.data.some(id => typeof id !== "string" || !id || id.length > 512 || /[\x00-\x1f\x7f]/.test(id))) throw new Error("invalid loaded IDs");
          loadedIds = loaded.data as string[];
          bounded ||= Boolean(loaded.nextCursor) || loadedIds.length > limit;
        } catch { candidatePartial = "native_loaded_page_unavailable"; }
        const merged = new Map(sessions.map(thread => [thread.id, thread]));
        const missing = [...new Set([...indexed.ids, ...loadedIds])].filter(id => !merged.has(id));
        bounded ||= missing.length > limit;
        // Only one candidate window. No rollout scan, cached identity or history
        // hydration substitutes for exact metadata on the current controller.
        await Promise.all(missing.slice(0, limit).map(async id => {
          try {
            const read = await this.request("thread/read", {threadId:id, includeTurns:false}) as {thread?:CodexThread};
            if (read.thread?.id !== id) throw new Error("native candidate identity mismatch");
            merged.set(id, read.thread);
          } catch { candidatePartial = "native_candidate_metadata_unavailable"; }
        }));
        const sorted = [...merged.values()].sort((a, b) =>
          Date.parse(threadTimestamp(b.updatedAt) || threadTimestamp(b.createdAt) || new Date(0).toISOString())
          - Date.parse(threadTimestamp(a.updatedAt) || threadTimestamp(a.createdAt) || new Date(0).toISOString())
          || a.id.localeCompare(b.id));
        bounded ||= sorted.length > limit;
        sessions = sorted.slice(0, limit);
      } else sessions = await this.listAllThreads();
      for (const thread of sessions) {
        if (this.socketPath) this.activeTurns.delete(thread.id);
        this.threads.set(thread.id, thread);
      }
      const indexedMetadata = options.limit
        ? await this.rawTranscriptAdapter.getNativeSessionMetadataForIds(sessions.map(thread => thread.id))
        : undefined;
      const nativeMetadata = indexedMetadata?.metadata ?? await this.rawTranscriptAdapter.getNativeSessionMetadata();
      const result = sessions.map((thread) => {
        const session = this.toSession(thread);
        if (indexedMetadata?.available === false) session.meta = { ...session.meta, nativeIndexMetadata: "unavailable" };
        const nativeMeta = nativeMetadata.get(thread.id);
        if (!nativeMeta) return session;
        const { status: nativeStatus, parentThreadId: indexedParentThreadId, ...nativeMetadataFields } = nativeMeta;
        const automation = this.externalAutomationMetadata(thread.id, nativeMeta);
        delete nativeMetadataFields.automationStop;
        if (automation.automationStop) nativeMetadataFields.automationStop = automation.automationStop;
        return {
          ...session,
          status: !this.socketPath && nativeStatus === "running" ? "running" : session.status,
          meta: {
            ...session.meta,
            ...nativeMetadataFields,
            ...(!thread.parentThreadId && indexedParentThreadId ? { parentThreadId: indexedParentThreadId } : {}),
            ...(!this.socketPath && nativeStatus ? { status: nativeStatus } : {}),
          },
        };
      });
      this.sessionSnapshotReceipt = {
        exhaustive: !bounded && !candidatePartial && indexedMetadata?.available !== false,
        observedAt: new Date().toISOString(),
        source: "codex-app-server",
        ...(indexedMetadata?.available === false ? { reason: "native_index_metadata_unavailable" } : candidatePartial ? {reason:candidatePartial} : bounded ? {reason:"bounded_native_page"} : {}),
      };
      return result;
    } catch (error) {
      this.sessionSnapshotReceipt = {
        exhaustive: false,
        observedAt: new Date().toISOString(),
        source: "codex-app-server",
        reason: error instanceof Error ? error.message : "thread_list_failed",
      };
      throw error;
    }
  }

  getSessionSnapshotReceipt(): SessionSnapshotReceipt {
    return { ...this.sessionSnapshotReceipt };
  }

  private async listAllThreads(): Promise<CodexThread[]> {
    const threads = new Map<string, CodexThread>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.request("thread/list", {
        limit: 200,
        archived: false,
        ...(cursor ? { cursor } : {}),
      }) as { data?: CodexThread[]; nextCursor?: string | null };
      for (const thread of result.data || []) {
        if (typeof thread.id === "string") threads.set(thread.id, thread);
      }
      const nextCursor = typeof result.nextCursor === "string" && result.nextCursor.length > 0
        ? result.nextCursor
        : undefined;
      if (nextCursor && seenCursors.has(nextCursor)) throw new Error("Codex thread/list returned a repeated pagination cursor");
      if (nextCursor) seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    return [...threads.values()];
  }

  private threadStatusTag(status: CodexThread["status"]): string | undefined {
    return typeof status === "string" ? status : status?.type;
  }

  private threadActiveFlags(status: CodexThread["status"]): string[] {
    return typeof status === "object" && status ? status.activeFlags || [] : [];
  }

  async findNamedSessions(name: string, cwd: string): Promise<AgentSession[]> {
    if (this.projectRuntimePolicy) {
      if (!(await this.hasCurrentProjectRoot()) || cwd !== this.projectRuntimePolicy.rootPath) return [];
      const matches: AgentSession[] = [];
      for (const id of this.projectThreadIds) {
        const thread = this.threads.get(id);
        if (thread?.id === id && thread.name === name && thread.cwd === this.projectRuntimePolicy.rootPath) {
          matches.push(this.toSession(thread));
        }
      }
      return matches;
    }
    await this.ensureReady();
    const nativeThreads = await this.rawTranscriptAdapter.findNativeNamedThreads(name, cwd);
    const threads: CodexThread[] = [];
    if (nativeThreads !== null) {
      for (const nativeThread of nativeThreads) {
        const result = await this.request("thread/read", { threadId: nativeThread.id, includeTurns: false }) as { thread?: CodexThread };
        // An unreadable indexed match is uncertain, not proof that a new named
        // session should be created. Preserve the error instead of duplicating it.
        if (result.thread?.id !== nativeThread.id) throw new Error(`Codex could not verify indexed named thread ${nativeThread.id}`);
        threads.push({ ...result.thread, name: result.thread.name || nativeThread.name, cwd: result.thread.cwd || nativeThread.cwd });
      }
    } else {
      // Older Codex installations have no usable exact name index.
      threads.push(...await this.listAllThreads());
    }
    const canonicalCwd = await realpath(cwd).catch(() => cwd);
    const matches: AgentSession[] = [];
    for (const thread of threads) {
      if (thread.name !== name || !thread.cwd) continue;
      if (thread.cwd !== cwd && await realpath(thread.cwd).catch(() => thread.cwd) !== canonicalCwd) continue;
      this.threads.set(thread.id, thread);
      matches.push(this.toSession(thread));
    }
    return matches;
  }

  async readTrackedTurnCompletion(id: string, turnId: string, cwd: string): Promise<CodexTrackedTurnCompletion | null> {
    if (!(await this.canReadProjectHistory(id))) return null;
    if (!this.socketPath && !this.isReady()) return null;
    await this.ensureReady();
    const result = await this.request("thread/read", { threadId: id, includeTurns: true }) as { thread?: Record<string, unknown> };
    const thread = result?.thread;
    if (!thread || thread.id !== id || thread.cwd !== cwd) return null;
    const status = thread.status as { type?: unknown; activeFlags?: unknown } | undefined;
    if (!status || !["idle", "notLoaded"].includes(String(status.type))
      || (status.activeFlags !== undefined && (!Array.isArray(status.activeFlags) || status.activeFlags.length !== 0))) return null;
    if (!Array.isArray(thread.turns) || thread.turns.length === 0) return null;
    const turns = thread.turns as Array<Record<string, unknown>>;
    if (turns.some(turn => !turn || typeof turn !== "object" || turn.status === "inProgress")) return null;
    const latest = turns.at(-1)!;
    if (latest.id !== turnId || latest.status !== "completed" || latest.error !== null || !Array.isArray(latest.items)) return null;
    const items = latest.items as Array<Record<string, unknown>>;
    if (items.filter(item => item?.type === "userMessage").length !== 1 || items[0]?.type !== "userMessage") return null;
    const last = items.at(-1);
    if (last?.type !== "agentMessage" || last.phase !== "final_answer" || typeof last.text !== "string" || !last.text.trim()) return null;
    const passive = new Set(["userMessage", "agentMessage", "reasoning", "plan", "webSearch", "imageView", "enteredReviewMode", "exitedReviewMode", "contextCompaction"]);
    const stateful = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabToolCall"]);
    for (const turn of turns) {
      if (!Array.isArray(turn.items)) return null; // No partial-history judgement.
      for (const item of turn.items as Array<Record<string, unknown>>) {
        if (!item || typeof item.id !== "string" || typeof item.type !== "string") return null;
        if (stateful.has(item.type)) {
          if (item.status !== "completed") return null;
          if (item.type === "commandExecution" && item.exitCode !== 0) return null;
          if (item.error != null || item.success === false) return null;
        } else if (!passive.has(item.type)) return null;
      }
    }
    const transcriptTail = JSON.stringify(turns);
    // Retain full original instructions and completed effects; don't silently
    // judge a truncated tail which lost the original task.
    if (transcriptTail.length > 120_000) return null;
    const fingerprint = createHash("sha256").update(JSON.stringify({ id, cwd, status, turns })).digest("hex");
    return { session: this.toSession(thread as unknown as CodexThread), turnId, fingerprint, transcriptTail };
  }

  async getSession(id: string, options: { includeMetrics?: boolean } = {}): Promise<AgentSession | null> {
    if (!(await this.canReadProjectHistory(id))) return null;
    let base: AgentSession | null = null;
    if (this.socketPath || this.isReady()) {
      await this.ensureReady();
      // Shared-socket observations must reverify the active ID. The owned
      // stdio transport may retain its turn/started receipt when an older
      // server cannot expose turn metadata; a supported empty list clears it.
      if (this.socketPath) this.activeTurns.delete(id);
      try {
        const result = await this.request("thread/read", { threadId: id, includeTurns: false }) as { thread?: CodexThread };
        if (result.thread?.id === id) {
          await this.refreshActiveTurnId(id);
          const cached = this.threads.get(id);
          const thread = { ...result.thread, name: result.thread.name ?? cached?.name, cwd: result.thread.cwd ?? cached?.cwd };
          this.threads.set(id, thread);
          base = this.toSession(thread);
        } else {
          this.threads.delete(id);
        }
      } catch {
        this.threads.delete(id);
      }
    }
    const tailMissing = { value: false };
    const readArchive = async (read: () => Promise<AgentSession | null>) => {
      try { return await read(); }
      catch (error) {
        // Native thread/start can allocate a rollout path before its first turn creates the file.
        // Preserve only freshly verified native metadata; never hide permission/other archive failures.
        if (base && this.projectRuntimePolicy && this.projectThreadIds.has(id) && !this.lastNativeTurns.has(id)
          && !this.activeTurns.has(id) && /no rollout found for thread id/.test((error as Error).message)) {
          return null;
        }
        if (base && (error as NodeJS.ErrnoException).code === "ENOENT") {
          // A thread with proven native turn history must keep its rollout tail observable:
          // the tail carries stop evidence and message archive, so mutation may not proceed blindly.
          if (this.lastNativeTurns.has(id)) tailMissing.value = true;
          return null;
        }
        throw error;
      }
    };
    const observation = await readArchive(() => this.rawTranscriptAdapter.getSessionObservation(id));
    const raw = options.includeMetrics
      ? await readArchive(() => this.rawTranscriptAdapter.getSession(id))
      : observation;
    const automationStop = observation?.meta?.automationStop as CodexAutomationStop | undefined;
    const nativeAutomation = this.externalAutomationMetadata(id, automationStop ? { automationStop } : {});
    if (!base) {
      if (!raw) return null;
      // A stopped owned stdio process keeps its historical idle display. The
      // explicit observation flag prevents admission from trusting that view.
      const status = !this.socketPath && !this.isReady() ? "idle" : "stopped";
      const normalized = withKnownModel({ ...raw, status, meta: { ...mergeAutomationMetadata(raw.meta, nativeAutomation), nativeStateObserved: false } }, raw.model);
      return normalized;
    }
    if (!raw) {
      const merged = { ...mergeAutomationMetadata(base.meta, nativeAutomation) };
      if (tailMissing.value) merged.nativeStateObserved = false;
      return { ...base, meta: merged };
    }
    const rawMeta = { ...raw.meta };
    if (this.socketPath) delete rawMeta.status;
    delete rawMeta.automationStop;
    const mergedMeta = { ...base.meta, ...rawMeta };
    if (typeof base.meta?.parentThreadId === "string") mergedMeta.parentThreadId = base.meta.parentThreadId;
    const session: AgentSession = {
      ...base,
      messageCount: raw.messageCount,
      durationSec: raw.durationSec,
      costUsd: raw.costUsd,
      lastMessage: raw.lastMessage || base.lastMessage,
      meta: mergeAutomationMetadata(mergedMeta, nativeAutomation),
    };
    return withKnownModel(session, typeof base.model === "string" ? base.model : raw.model);
  }

  async getParent(id: string): Promise<AgentSession | null> {
    const child = await this.getSession(id);
    if (!child) throw new Error("Codex session became unavailable during native parent lookup");
    const metadataParent = typeof child.meta?.parentThreadId === "string" ? child.meta.parentThreadId : undefined;
    const lineage = metadataParent ? undefined : await this.rawTranscriptAdapter.getNativeLineageForId(id);
    if (!metadataParent && lineage?.available === false) throw new Error("Codex native parent lineage is unavailable from the app-server and session index");
    const parentId = metadataParent ?? lineage?.parentThreadId;
    if (!parentId || parentId === id) return null;
    const parent = await this.getSession(parentId);
    if (!parent) throw new Error(`Codex native parent session ${parentId} could not be read`);
    return parent;
  }

  async listChildren(id: string): Promise<AgentSession[]> {
    if (!await this.getSession(id)) throw new Error("Codex parent session became unavailable during native child lookup");
    let nativeChildren: CodexThread[] | undefined;
    try {
      // Query by exact native parent ID. Separate archived and active pages:
      // Codex's default archived:null view omits archived descendants.
      await this.ensureReady();
      const found = new Map<string, CodexThread>();
      for (const archived of [false, true]) {
        const seenCursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await this.request("thread/list", {
            limit: 200,
            parentThreadId: id,
            archived,
            ...(cursor ? { cursor } : {}),
          }) as { data?: CodexThread[]; nextCursor?: string | null };
          for (const thread of page.data || []) {
            if (typeof thread.id === "string" && thread.id !== id && thread.parentThreadId === id) found.set(thread.id, thread);
          }
          const nextCursor = typeof page.nextCursor === "string" && page.nextCursor.length ? page.nextCursor : undefined;
          if (nextCursor && seenCursors.has(nextCursor)) throw new Error("Codex parent-filtered thread/list returned a repeated pagination cursor");
          if (nextCursor) seenCursors.add(nextCursor);
          cursor = nextCursor;
        } while (cursor);
      }
      nativeChildren = [...found.values()];
    } catch {
      // Older app-server versions may not accept a parent-filtered query.
    }
    let childIds: string[];
    if (nativeChildren !== undefined) {
      childIds = nativeChildren.map(thread => thread.id);
    } else {
      const lineage = await this.rawTranscriptAdapter.getNativeLineageForId(id, { includeHeaderChildren: true });
      if (!lineage.available) throw new Error("Codex native child lineage is unavailable from the app-server and session index");
      childIds = lineage.childThreadIds;
    }
    const children = await Promise.all(childIds.map(async childId => {
      const child = await this.getSession(childId);
      if (!child) throw new Error(`Codex native child session ${childId} could not be read`);
      const metadataParent = typeof child.meta?.parentThreadId === "string" ? child.meta.parentThreadId : undefined;
      if (metadataParent && metadataParent !== id) throw new Error(`Codex child ${childId} has conflicting native parent ${metadataParent}`);
      return metadataParent ? child : { ...child, meta: { ...child.meta, parentThreadId: id } };
    }));
    return children.filter((child): child is AgentSession => child !== null);
  }

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    await this.ensureReady();
    this.assertLifecycleActive();
    if (this.projectRuntimePolicy) {
      await assertCodexProjectRoot(this.projectRuntimePolicy, options.cwd);
      this.assertLifecycleActive();
      if (options.fullAccess) throw new Error("project-scoped Codex does not permit full access");
      if (options.model && options.model !== this.projectRuntimePolicy.modelId) {
        throw new Error(`project-scoped Codex is pinned to ${this.projectRuntimePolicy.modelId}`);
      }
      await this.assertEffectiveProjectToolIsolation();
      this.assertLifecycleActive();
    }
    const reservation = this.projectRuntimePolicy?.materialized ? await this.reserveMaterializedOperation() : undefined;
    let observedThreadId: string | undefined;
    let materializationStage = "thread_start_not_sent";
    try {
    this.assertLifecycleActive();
    if (reservation) {
      materializationStage = "thread_start_sent";
    }
    const result = await this.request("thread/start", {
      cwd: options.cwd,
      ...(this.projectRuntimePolicy ? { model: this.projectRuntimePolicy.modelId } : options.model ? { model: options.model } : {}),
      ...(options.fullAccess ? { approvalPolicy: "never", sandbox: "danger-full-access" } : {}),
      ...(this.projectRuntimePolicy ? codexProjectThreadParams(this.projectRuntimePolicy) : {}),
    }) as { thread?: CodexThread } & CodexThreadPermissionState;
    const thread = result.thread;
    if (!thread?.id) throw new Error("Codex thread/start did not return a thread id");
    observedThreadId = thread.id;
    materializationStage = "thread_start_observed";
    if (reservation) {
      this.reportMaterializationProgress({ phase: "native_created", operationId: reservation.operationId,
        inputId: reservation.inputId, threadId: thread.id, cwd: thread.cwd || options.cwd });
      this.assertLifecycleActive();
      if (this.materializationObserverFailed) throw new Error("materialization progress receipt could not be persisted after native create");
    }
    if (this.projectRuntimePolicy?.materialized && (thread as CodexThread & { ephemeral?: boolean }).ephemeral !== false) {
      throw new Error("Codex did not materialize the required non-ephemeral project thread");
    }
    if (this.projectRuntimePolicy && !codexProjectPermissionObserved(result, this.projectRuntimePolicy)) {
      await this.request("thread/archive", { threadId: thread.id }).catch(() => undefined);
      throw new Error("Codex did not confirm the requested project permission profile and exact runtime root");
    }
    if (this.projectRuntimePolicy) {
      this.projectThreadIds.add(thread.id);
      this.projectLiveMessages.set(thread.id, []);
      this.projectCommandReceipts.set(thread.id, []);
      try {
        await this.assertEffectiveProjectToolIsolation(thread.id);
        if (!(await this.listModels()).includes(CODEX_PROJECT_MODEL_ID)) {
          throw new Error(`Codex project runtime does not advertise the required model ${CODEX_PROJECT_MODEL_ID}`);
        }
      }
      catch (error) {
        this.projectThreadIds.delete(thread.id);
        this.projectLiveMessages.delete(thread.id);
        this.projectCommandReceipts.delete(thread.id);
        await this.request("thread/archive", { threadId: thread.id }).catch(() => undefined);
        throw error;
      }
    }
    if (reservation && this.integratorSessionBindingStore) {
      await this.integratorSessionBindingStore.record({
        operationId: reservation.operationId,
        attempt: reservation.attempt,
        receipt: {
          state: "created",
          inputId: reservation.inputId,
          address: { hostId: reservation.hostId, harness: "codex", nativeSessionId: thread.id },
          launchCwd: this.projectRuntimePolicy!.rootPath,
          retryable: false,
        },
      });
      materializationStage = "h34_accepted";
      this.reportMaterializationProgress({ phase: "accepted", operationId: reservation.operationId,
        inputId: reservation.inputId, threadId: thread.id, cwd: thread.cwd || options.cwd });
    }
    if (options.fullAccess) {
      if (!hasCodexFullAccess(result)) throw new Error("Codex app-server did not confirm the requested full-access thread settings");
      this.fullAccessThreads.add(thread.id);
    }
    // Codex ephemeral threads are not persisted and reject all metadata updates.
    // The project-scoped session name is local presentation state only.
    if (!this.projectRuntimePolicy) {
      await this.request("thread/name/set", { threadId: thread.id, name: options.name });
    }
    thread.name = options.name;
    thread.cwd = thread.cwd || options.cwd;
    this.threads.set(thread.id, thread);
    this.emitEvent({ kind: "session.created", harness: "codex", sessionId: thread.id, status: "idle" });
    return this.toSession(thread);
    } catch (error) {
      if (reservation && this.integratorSessionBindingStore) {
        await this.integratorSessionBindingStore.record({
          operationId: reservation.operationId,
          attempt: reservation.attempt,
          receipt: { state: "unknown", inputId: reservation.inputId,
            ...(observedThreadId ? { address: { hostId: reservation.hostId, harness: "codex" as const, nativeSessionId: observedThreadId } } : {}),
            retryable: false,
            reason: "native_materialization_outcome_uncertain" },
        }).catch(() => undefined);
      }
      if (reservation) this.reportMaterializationProgress({ phase: "failure", operationId: reservation.operationId,
        inputId: reservation.inputId, ...(observedThreadId ? { threadId: observedThreadId } : {}),
        failureStage: materializationStage, failureType: error instanceof Error ? error.name : "unknown" });
      throw error;
    }
  }

  /** Restore only the exact accepted H34 ID after fresh H32/H31 scope proof. */
  async restoreMaterializedSession(): Promise<ControlResult> {
    this.assertLifecycleActive();
    const policy = this.projectRuntimePolicy;
    const accepted = policy?.acceptedSession;
    const store = this.integratorSessionBindingStore;
    const owner = this.projectRuntimeOwner;
    if (!policy?.materialized || !accepted || !store || !owner) {
      return { ok: false, nonRetryable: true, error: "materialized Codex restore requires an accepted H34 operation" };
    }
    const evidence = await this.resolveCurrentProjectScope({
      projectId: policy.binding.projectId, rootIdentity: policy.binding.rootIdentity,
      policyRevision: policy.binding.policyRevision, hostId: policy.binding.hostId, harness: "codex",
    });
    this.assertLifecycleActive();
    if (!evidence || !sameProjectExecutionBinding(evidence.binding, policy.binding)
      || !sameScopeDirectoryIdentity(evidence.appServerDataHome, evidence.transcriptReaderDataHome)) {
      return { ok: false, nonRetryable: true, error: "materialized Codex current scope is unavailable" };
    }
    const trusted = await resolveProjectExecutionScope(policy.binding, owner);
    this.assertLifecycleActive();
    if (!trusted.eligible) return { ok: false, nonRetryable: true, error: "materialized Codex runtime owner proof is unavailable" };
    let binding;
    try { binding = await store.get(accepted.operationId); }
    catch { return { ok: false, nonRetryable: true, error: "materialized Codex H34 record is unreadable" }; }
    this.assertLifecycleActive();
    const attempt = binding?.attempts.at(-1);
    const scope = attempt?.scope;
    if (!binding || binding.state !== "accepted" || binding.operationId !== policy.binding.attemptId
      || binding.harness !== "codex" || attempt?.state !== "accepted" || attempt.receipt?.state !== "created"
      || attempt.address?.nativeSessionId !== accepted.address.nativeSessionId
      || attempt.address?.hostId !== policy.binding.hostId || attempt.address?.harness !== "codex"
      || !scope || scope.projectId !== policy.binding.projectId || scope.rootIdentity !== policy.binding.rootIdentity
      || scope.policyRevision !== policy.binding.policyRevision || scope.hostId !== policy.binding.hostId
      || scope.harness !== "codex" || scope.harnessVersion !== evidence.harnessVersion
      || !sameScopeDirectoryIdentity(scope.canonicalRoot, evidence.canonicalRoot)
      || !sameScopeDirectoryIdentity(scope.nativeDataHome, evidence.appServerDataHome)) {
      return { ok: false, nonRetryable: true, error: "materialized Codex H34 scope or receipt does not match current runtime" };
    }
    const id = accepted.address.nativeSessionId;
    this.reportMaterializationProgress({ phase: "restore_preflight", operationId: accepted.operationId,
      threadId: id });
    try {
      await assertCodexProjectRoot(policy, policy.rootPath);
      this.assertLifecycleActive();
      await this.ensureReady();
      this.assertLifecycleActive();
      await this.assertEffectiveProjectToolIsolation();
      this.assertLifecycleActive();
      const read = await this.request("thread/read", { threadId: id, includeTurns: true }) as {
        thread?: CodexThread;
      } & CodexThreadPermissionState;
      if (read.thread?.id !== id || read.thread.cwd !== policy.rootPath
        || (read.thread as (CodexThread & { ephemeral?: boolean }) | undefined)?.ephemeral !== false) {
        return { ok: false, nonRetryable: true, error: "native materialized thread readback does not match accepted project scope" };
      }
      this.reportMaterializationProgress({ phase: "restore_read", operationId: accepted.operationId, threadId: id });
      this.assertLifecycleActive();
      this.projectThreadIds.add(id);
      this.projectLiveMessages.set(id, []);
      this.projectCommandReceipts.set(id, []);
      const resumed = await this.resumeSession(id);
      this.assertLifecycleActive();
      if (!resumed.ok) {
        this.projectThreadIds.delete(id);
        this.projectLiveMessages.delete(id);
        this.projectCommandReceipts.delete(id);
        return resumed;
      }
      this.reportMaterializationProgress({ phase: "restore_resumed", operationId: accepted.operationId, threadId: id });
      this.threads.set(id, read.thread);
      return { ok: true, sessionId: id };
    } catch (error) {
      this.projectThreadIds.delete(id);
      this.projectLiveMessages.delete(id);
      this.projectCommandReceipts.delete(id);
      this.reportMaterializationProgress({ phase: "failure", operationId: accepted.operationId, threadId: id,
        failureStage: "restore_read_or_resume", failureType: error instanceof Error ? error.name : "unknown" });
      return { ok: false, nonRetryable: true, error: (error as Error).message };
    }
  }

  private async reserveMaterializedOperation(): Promise<{ operationId: string; attempt: number; inputId: string; hostId: string }> {
    const policy = this.projectRuntimePolicy;
    const store = this.integratorSessionBindingStore;
    const owner = this.projectRuntimeOwner;
    if (!policy?.materialized || !store || !owner) throw new Error("materialized Codex H34 admission is unavailable");
    const evidence = await this.resolveCurrentProjectScope({
      projectId: policy.binding.projectId, rootIdentity: policy.binding.rootIdentity,
      policyRevision: policy.binding.policyRevision, hostId: policy.binding.hostId, harness: "codex",
    });
    this.assertLifecycleActive();
    if (!evidence || !sameProjectExecutionBinding(evidence.binding, policy.binding)
      || !sameScopeDirectoryIdentity(evidence.appServerDataHome, evidence.transcriptReaderDataHome)) {
      throw new Error("materialized Codex current scope is unavailable");
    }
    const trusted = await resolveProjectExecutionScope(policy.binding, owner);
    this.assertLifecycleActive();
    if (!trusted.eligible) throw new Error("materialized Codex runtime owner proof is unavailable");
    const scope: IntegratorAttemptScope = {
      projectId: policy.binding.projectId, rootIdentity: policy.binding.rootIdentity,
      policyRevision: policy.binding.policyRevision, hostId: policy.binding.hostId, harness: "codex",
      harnessVersion: evidence.harnessVersion, canonicalRoot: evidence.canonicalRoot,
      nativeDataHome: evidence.appServerDataHome,
    };
    const reservation = await store.reserve({ operationId: policy.binding.attemptId,
      hostId: policy.binding.hostId, harness: "codex", scope });
    if (!reservation.claimed) throw new Error("materialized Codex operation is already reserved or terminal; no create replay permitted");
    this.reportMaterializationProgress({ phase: "reserved", operationId: policy.binding.attemptId, inputId: reservation.attempt.inputId });
    if (this.lifecycleSignal?.aborted || this.disposed) {
      await store.record({ operationId: policy.binding.attemptId, attempt: reservation.attempt.attempt,
        receipt: { state: "unknown", inputId: reservation.attempt.inputId, retryable: false,
          reason: "operation_aborted_after_durable_reservation" } });
      throw operationAbortedError();
    }
    if (this.materializationObserverFailed) {
      await store.record({ operationId: policy.binding.attemptId, attempt: reservation.attempt.attempt,
        receipt: { state: "unknown", inputId: reservation.attempt.inputId, retryable: false,
          reason: "materialization_progress_receipt_unavailable" } });
      throw new Error("materialization progress receipt could not be persisted after H34 reservation");
    }
    return { operationId: policy.binding.attemptId, attempt: reservation.attempt.attempt,
      inputId: reservation.attempt.inputId, hostId: reservation.attempt.hostId };
  }

  private reportMaterializationProgress(progress: CodexMaterializationProgress): void {
    if (!this.projectRuntimePolicy?.materialized || !this.onMaterializationProgress) return;
    try { this.onMaterializationProgress({ ...progress }); }
    catch { this.materializationObserverFailed = true; }
  }

  /**
   * App-server threads and CLI rollouts share Codex's native session ID. Use
   * that persisted rollout as the raw archive source instead of synthesizing
   * display text from RPC events.
   */
  async getRawTranscript(id: string): Promise<RawTranscriptExport | null> {
    if (!(await this.canReadProjectHistory(id))) return null;
    return this.rawTranscriptAdapter.getRawTranscript(id);
  }

  /** Project history is readable only for a thread admitted by this adapter
   * instance while its bound root identity still matches. */
  private async canReadProjectHistory(id: string): Promise<boolean> {
    if (!this.projectRuntimePolicy) return true;
    if (!this.projectThreadIds.has(id)) return false;
    return this.hasCurrentProjectRoot();
  }

  private async hasCurrentProjectRoot(): Promise<boolean> {
    if (!this.projectRuntimePolicy) return true;
    try {
      await assertCodexProjectRoot(this.projectRuntimePolicy, this.projectRuntimePolicy.rootPath);
      return true;
    } catch {
      return false;
    }
  }

  /** Resolve current adapter-owned scope evidence for a trusted server caller.
   * Caller identifiers are compared with the frozen policy; they never supply
   * the returned binding, paths, filesystem identities, or native version. */
  async resolveCurrentProjectScope(input: {
    projectId: string;
    rootIdentity: string;
    policyRevision: string;
    hostId: string;
    harness: IntegratorHarness;
  }): Promise<IntegratorCurrentProjectScopeEvidence | null> {
    const policy = this.projectRuntimePolicy;
    if (!policy || input.harness !== this.type
      || input.projectId !== policy.binding.projectId
      || input.rootIdentity !== policy.binding.rootIdentity
      || input.policyRevision !== policy.binding.policyRevision
      || input.hostId !== policy.binding.hostId) return null;
    try {
      await assertCodexProjectRoot(policy, policy.rootPath);
      const canonicalRoot = await this.directoryIdentity(policy.rootPath);
      const currentRootIdentity = JSON.stringify([canonicalRoot.path, canonicalRoot.device, canonicalRoot.inode]);
      if (canonicalRoot.path !== policy.rootPath || canonicalRoot.device !== policy.rootDevice
        || canonicalRoot.inode !== policy.rootInode || currentRootIdentity !== policy.binding.rootIdentity) return null;

      const [appServerDataHome, transcriptReaderDataHome, harnessVersion] = await Promise.all([
        this.directoryIdentity(this.appServerDataHome),
        this.directoryIdentity(this.transcriptReaderDataHome),
        this.verifiedNativeHarnessVersion(),
      ]);
      if (!harnessVersion) return null;
      return {
        binding: { ...policy.binding },
        canonicalRoot,
        harnessVersion,
        appServerDataHome,
        transcriptReaderDataHome,
      };
    } catch {
      return null;
    }
  }

  private async directoryIdentity(path: string): Promise<ProjectScopeDirectoryIdentity> {
    const canonicalPath = await realpath(path);
    const details = await stat(canonicalPath);
    if (!details.isDirectory()) throw new Error("project runtime evidence path is not a directory");
    return { path: canonicalPath, device: details.dev, inode: details.ino };
  }

  private async verifiedNativeHarnessVersion(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(this.codexBin, ["--version"], {
        cwd: this.cwd,
        env: this.projectChildEnvironment(),
        signal: this.lifecycleSignal,
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      });
      const version = stdout.trim();
      return version && version.length <= 128 && !/[\x00-\x1f\x7f]/.test(version) ? version : null;
    } catch {
      return null;
    }
  }

  private projectChildEnvironment(): NodeJS.ProcessEnv | undefined {
    if (!this.projectRuntimePolicy) return undefined;
    return { ...process.env, CODEX_HOME: this.appServerDataHome };
  }

  async sendMessage(id: string, options: SendMessageOptions): Promise<ControlResult> {
    const operation = async () => {
      this.assertLifecycleActive();
      const previous = this.deliveryTails.get(id) ?? Promise.resolve();
      let release!: () => void;
      const admission = new Promise<void>(resolve => { release = resolve; });
      const tail = previous.then(() => admission);
      this.deliveryTails.set(id, tail);
      await previous;
      this.assertLifecycleActive();
      try { return await this.sendNativeMessage(id, options, release); }
      finally {
        release();
        if (this.deliveryTails.get(id) === tail) this.deliveryTails.delete(id);
      }
    };
    if (!options.inputId) return operation();
    return this.deliveryReceipts.once(id, options.inputId, operation);
  }

  /** Current-turn coordination uses native steer CAS, never idle resume/start. */
  async sendActiveMessage(id: string, options: SendMessageOptions): Promise<ControlResult> {
    return this.sendMessage(id, {...options, activeTurnOnly: true, steer: true});
  }

  /** This adapter's admission lookup reads only durable receipt files. */
  async getCoordinationMessageAdmission(id: string, inputId: string): Promise<MessageAdmissionResult> {
    return this.getMessageAdmission(id,inputId);
  }

  /** Read-only admission lookup for an earlier input; it never delivers again. */
  async getMessageAdmission(id: string, inputId: string): Promise<MessageAdmissionResult> {
    let receipt: ControlResult | undefined;
    try {
      receipt = await this.deliveryReceipts.find(id, inputId);
    } catch (error) {
      return { state: "unknown", error: error instanceof Error ? error.message : String(error) };
    }
    if (!receipt) return { state: "unknown" };
    if (receipt.ok || receipt.admitted) return { state: "admitted", ...(receipt.turnId ? { error: receipt.turnId } : {}) };
    if (receipt.admissionUnknown) return { state: "unknown", error: receipt.error };
    if (receipt.notSubmitted === true && receipt.nonRetryable === true) {
      return { state: "failed", error: receipt.error, receipt };
    }
    if (receipt.nonRetryable) return { state: "unknown", error: receipt.error };
    return { state: "failed", error: receipt.error };
  }

  private async sendNativeMessage(id: string, options: SendMessageOptions, release: () => void, startRaceRetries = 1): Promise<ControlResult> {
    this.assertLifecycleActive();
    if (this.projectRuntimePolicy && !this.projectThreadIds.has(id)) {
      return { ok: false, nonRetryable: true, error: "project-scoped Codex can only address a thread created by this runtime instance" };
    }
    if (this.projectRuntimePolicy && options.model && options.model !== this.projectRuntimePolicy.modelId) {
      return { ok: false, nonRetryable: true, error: `project-scoped Codex is pinned to ${this.projectRuntimePolicy.modelId}` };
    }
    if (options.activeTurnOnly && !this.socketPath && !this.isReady()) return {ok:false,notSubmitted:true,nonRetryable:true,error:"Current-turn transport is unavailable; coordination was not delivered"};
    await this.ensureReady();
    this.assertLifecycleActive();
    if (this.projectRuntimePolicy) {
      await assertCodexProjectRoot(this.projectRuntimePolicy, this.projectRuntimePolicy.rootPath);
      this.assertLifecycleActive();
      await this.assertEffectiveProjectToolIsolation(id);
      this.assertLifecycleActive();
    }
    let session: AgentSession | null;
    try { session = await this.getSession(id); }
    catch (error) {
      return { ok: false, admitted: false, error: `Codex session preflight failed: ${(error as Error).message}` };
    }
    this.assertLifecycleActive();
    if (!session) return { ok: false, error: `Session ${id} not found` };
    if (session.meta?.nativeStateObserved === false) return { ok: false, admitted: false, nonRetryable: true, error: "Codex native thread state could not be verified; prompt was not delivered" };
    if (options.activeTurnOnly && session.status !== "running") {
      return {ok:false,notSubmitted:true,nonRetryable:true,error:"skipped_inactive: Codex has no active turn; coordination was not delivered"};
    }
    // Queue controls whether the caller waits. It never queues coordination
    // behind an active native turn or starts a competing writer.
    const steerActive = options.steer === true || options.origin !== "human";
    if (steerActive && session.status === "needs_input") {
      return { ok: false, nonRetryable: true, error: "Codex is waiting for approval or user input; coordination was not delivered" };
    }
    for (let attempt = 0; steerActive && session.status === "running" && attempt < 2; attempt++) {
      const expectedTurnId = this.activeTurns.get(id);
      if (!expectedTurnId) return { ok: false, nonRetryable: true, error: "Active Codex turn ID could not be verified; coordination was not delivered" };
      let deliveryAttempted = false;
      try {
        if (options.origin !== "human") {
          await getHumanStopStore().rememberGeneratedPrompt("codex", id, options.message, expectedTurnId);
        }
        if (options.activeTurnOnly && await getHumanStopStore().isHeld("codex", id)) {
          return {ok:false,notSubmitted:true,nonRetryable:true,error:"Чат явно остановлен; сообщение в текущий ход не отправлено."};
        }
        deliveryAttempted = true;
        const result = await this.request("turn/steer", {
          threadId: id,
          expectedTurnId,
          input: [{ type: "text", text: options.message }, ...(options.images ?? []).map((image) => ({ type: "localImage", path: image.path }))],
        }) as { turnId?: string };
        if (result.turnId !== expectedTurnId) {
          return { ok: false, admitted: true, nonRetryable: true, error: "Codex steer receipt did not match the verified active turn; do not retry" };
        }
        return { ok: true, admitted: true, turnId: expectedTurnId, ...(options.inputId ? { inputId: options.inputId } : {}) };
      } catch (error) {
        if (error instanceof CodexQuotaBlockedError) return {ok:false,notSubmitted:true,admitted:false,nonRetryable:true,error:error.message};
        // Only an explicit native pre-admission rejection permits refresh.
        // A timeout/disconnect may follow acceptance and must never be replayed.
        if (attempt === 0 && error instanceof CodexRpcError && error.code === -32600
          && /expected active turn id .*but found|expected.*turn.*(?:match|mismatch)|no active turn/i.test(error.message)) {
          const fresh = await this.getSession(id);
          this.assertLifecycleActive();
          if (!fresh) return { ok: false, nonRetryable: true, error: "Codex thread disappeared during steer refresh" };
          session = fresh;
          if (session.status === "needs_input") return { ok: false, nonRetryable: true, error: "Codex now requires human input" };
          if (session.status !== "running" && session.status !== "idle") return { ok: false, nonRetryable: true, error: "Codex turn refresh did not verify an active or idle thread" };
          if (options.activeTurnOnly && session.status !== "running") return {ok:false,notSubmitted:true,nonRetryable:true,error:"skipped_inactive: Codex turn ended during coordination delivery"};
          continue;
        }
        return { ok: false, admissionUnknown: deliveryAttempted && !(error instanceof CodexRpcError && error.code === -32600), nonRetryable: true, error: (error as Error).message };
      }
    }
    // Never convert an explicit no-active rejection into a new turn/start.
    if (options.activeTurnOnly) return {ok:false,notSubmitted:true,nonRetryable:true,error:"skipped_inactive: native current-turn admission is no longer available"};
    // Ephemeral project threads are already selected in this dedicated server;
    // materialized threads are resumed only after the accepted H34 restore path.
    const resumed: ControlResult = this.projectRuntimePolicy && this.projectThreadIds.has(id)
      ? { ok: true }
      : await this.resumeSession(id);
    this.assertLifecycleActive();
    if (!resumed.ok) {
      if (steerActive && startRaceRetries > 0 && /already has an active writer/i.test(resumed.error ?? "")) {
        const fresh = await this.getSession(id);
        if (fresh?.status === "running") return this.sendNativeMessage(id, { ...options, steer: true }, release, 0);
        return { ...resumed, nonRetryable: true };
      }
      return resumed;
    }

    const completion = options.queue || options.steer === true ? undefined : this.waitForCompletion(id);
    const generatedPrompt = options.origin !== "human";
    if (generatedPrompt) {
      try {
        await getHumanStopStore().rememberGeneratedPrompt("codex", id, options.message);
      } catch (error) {
        if (completion) this.clearCompletion(id);
        return { ok: false, error: `Could not register the generated Codex prompt: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    try {
      const result = await this.request("turn/start", {
        threadId: id,
        input: [{ type: "text", text: options.message }, ...(options.images ?? []).map((image) => ({ type: "localImage", path: image.path }))],
        model: this.projectRuntimePolicy?.modelId ?? options.model ?? session.model ?? null,
        ...(this.projectRuntimePolicy ? codexProjectTurnParams(this.projectRuntimePolicy) : {}),
      }) as { turn?: { id?: string; status?: string } };
      const turnId = result.turn?.id;
      if (typeof turnId !== "string" || !turnId.trim()) {
        if (completion) this.clearCompletion(id);
        return { ok: false, admitted: true, admissionUnknown: true, nonRetryable: true,
          error: "Codex accepted turn/start without a verifiable turn ID; do not replay",
          ...(options.inputId ? { inputId: options.inputId } : {}) };
      }
      if (this.projectRuntimePolicy?.materialized) {
        this.reportMaterializationProgress({ phase: "turn_admitted", operationId: this.projectRuntimePolicy.binding.attemptId,
          threadId: id, turnId });
      }
      this.assertLifecycleActive();
      if (this.projectRuntimePolicy && this.projectThreadIds.has(id)) {
        this.recordProjectUserMessage(id, turnId, options.message);
      }
      if (generatedPrompt && turnId) {
        try {
          await getHumanStopStore().rememberGeneratedPrompt("codex", id, options.message, turnId);
        } catch (error) {
      if (error instanceof CodexQuotaBlockedError) { if (completion) this.clearCompletion(id); return {ok:false,notSubmitted:true,admitted:false,nonRetryable:true,error:error.message}; }
          if (turnId && result.turn?.status === "inProgress") this.activeTurns.set(id, turnId);
          if (completion) this.clearCompletion(id);
          return {
            ok: false,
            admitted: true,
            nonRetryable: true,
            turnId,
            ...(options.inputId ? { inputId: options.inputId } : {}),
            error: `Codex admitted the prompt, but its turn ID could not be registered: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
      if (completion) {
        const pending = this.completions.get(id);
        if (pending) {
          pending.requestedTurnId = turnId;
          this.settleCompletion(id);
        }
      }
      if (turnId && result.turn?.status === "inProgress") this.activeTurns.set(id, turnId);
      release(); // Waiting for a sync reply must not block another current-turn steer.
      if (!completion) return { ok: true, admitted: true, turnId, ...(options.inputId ? { inputId: options.inputId } : {}) };
      const completed = await completion;
      return { ...completed, admitted: true, turnId, ...(options.inputId ? { inputId: options.inputId } : {}),
        ...(!completed.ok ? { nonRetryable: true } : {}) };
    } catch (error) {
      if (completion) this.clearCompletion(id);
      if (steerActive && startRaceRetries > 0 && error instanceof CodexRpcError && error.code === -32600
        && /already has an active writer/i.test(error.message)) {
        const fresh = await this.getSession(id);
        if (fresh?.status === "running") return this.sendNativeMessage(id, { ...options, steer: true }, release, 0);
      }
      return { ok: false, admissionUnknown: !(error instanceof CodexRpcError && error.code === -32600), nonRetryable: true, error: (error as Error).message };
    }
  }

  async cancelTurn(id: string): Promise<ControlResult> {
    await this.ensureReady();
    let turnId = this.activeTurns.get(id);
    if (!turnId) {
      try {
        const result = await this.request("thread/turns/list", {
          threadId: id,
          limit: 1,
          sortDirection: "desc",
          itemsView: "notLoaded",
        }) as { data?: Array<{ id?: string; status?: string }> };
        const activeTurn = result.data?.find((turn) => turn.status === "inProgress" && typeof turn.id === "string");
        if (activeTurn?.id) {
          turnId = activeTurn.id;
          this.activeTurns.set(id, turnId);
        }
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    }
    if (!turnId) return { ok: false, error: `No active Codex turn found for session ${id}` };
    try {
      await getHumanStopStore().ignoreNativeStop("codex", id, {
        id: turnId,
        at: new Date().toISOString(),
        reason: "interrupted",
        turnId,
      });
    } catch (error) {
      return { ok: false, error: `Could not persist the Codex interrupt origin: ${error instanceof Error ? error.message : String(error)}` };
    }
    this.pruneInternalInterrupts();
    this.internalInterrupts.set(id, { turnId, expiresAt: Date.now() + 24 * 60 * 60 * 1_000 });
    try {
      await this.request("turn/interrupt", { threadId: id, turnId });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  private async refreshActiveTurnId(id: string): Promise<void> {
    try {
      const result = await this.request("thread/turns/list", {
        threadId: id,
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      }) as { data?: Array<{ id?: string; status?: string; completedAt?: string | number | null }> };
      if (!Array.isArray(result.data)) throw new Error("Codex native turn list is unavailable");
      this.unavailableNativeTurnStates.delete(id);
      this.eventStartedTurns.delete(id);
      const turn = result.data?.find((candidate) => candidate.status === "inProgress" && typeof candidate.id === "string");
      const latest = result.data?.[0];
      if (typeof latest?.id === "string" && typeof latest.status === "string") {
        const previous = this.lastNativeTurns.get(id);
        const quotaFailure = codexTerminalQuotaEvidence(latest, this.threads.get(id)?.model)
          ?? (previous?.turnId === latest.id && latest.status === "failed" ? previous.quotaFailure : undefined);
        this.lastNativeTurns.set(id, {
          ...(quotaFailure ? { quotaFailure, inputId: quotaFailure.inputId, userMessageId: quotaFailure.inputId } : {}),
          turnId: latest.id,
          status: latest.status,
          ...(threadTimestamp(latest.completedAt ?? undefined) ? { completedAt: threadTimestamp(latest.completedAt ?? undefined) } : {}),
        });
      } else this.lastNativeTurns.delete(id);
      if (turn?.id) this.activeTurns.set(id, turn.id);
      else this.activeTurns.delete(id);
    } catch {
      // Do not let a stale observed turn look like the current native turn.
      // A failed read invalidates summary-only cache for every transport.
      // Preserve only a running turn whose start event this live stdio process
      // observed; terminal summary/event cache cannot rule out a newer turn.
      if (this.socketPath || !this.eventStartedTurns.has(id)) {
        this.activeTurns.delete(id);
        this.lastNativeTurns.delete(id);
        this.unavailableNativeTurnStates.add(id);
      }
    }
  }

  private externalAutomationMetadata(id: string, metadata: CodexNativeAutomationMetadata): CodexNativeAutomationMetadata {
    this.pruneInternalInterrupts();
    const internal = this.internalInterrupts.get(id);
    if (!internal || !metadata.automationStop?.turnId || metadata.automationStop.turnId !== internal.turnId) return metadata;
    const { automationStop: _internalStop, ...externalMetadata } = metadata;
    return externalMetadata;
  }

  private pruneInternalInterrupts(): void {
    const now = Date.now();
    for (const [sessionId, interrupt] of this.internalInterrupts) {
      if (interrupt.expiresAt <= now) this.internalInterrupts.delete(sessionId);
    }
  }

  async detach(_id: string): Promise<ControlResult> {
    // Detaching only releases the caller's logical ownership; the shared
    // app-server remains alive so other phone sessions are not interrupted.
    return { ok: true };
  }

  async terminate(id: string): Promise<ControlResult> {
    return this.cancelTurn(id);
  }

  async stopSession(id: string): Promise<ControlResult> {
    return this.cancelTurn(id);
  }

  async archiveSession(id: string): Promise<ControlResult> {
    try {
      await this.ensureReady();
      const read = await this.request("thread/read", { threadId: id, includeTurns: false }) as { thread?: CodexThread };
      const thread = read.thread;
      if (!thread || thread.id !== id) return { ok: false, error: "Codex thread was not found" };
      const status = this.threadStatusTag(thread.status);
      const activeFlags = this.threadActiveFlags(thread.status);
      if (this.activeTurns.has(id) || activeFlags.includes("waitingOnApproval") || activeFlags.includes("waitingOnUserInput")
        || !["idle", "stopped", "completed", "interrupted", "notLoaded"].includes(status || "")) {
        return { ok: false, error: "Only an idle or stopped Codex thread without a pending permission can be archived" };
      }
      await this.request("thread/archive", { threadId: id });
      this.threads.delete(id);
      this.activeTurns.delete(id);
      this.emitEvent({ kind: "session.updated", harness: "codex", sessionId: id, nativeType: "thread/archive" });
      return { ok: true, sessionId: id };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async unarchiveSession(id: string): Promise<ControlResult> {
    try {
      await this.ensureReady();
      await this.request("thread/unarchive", { threadId: id });
      this.threads.delete(id);
      this.emitEvent({ kind: "session.updated", harness: "codex", sessionId: id, nativeType: "thread/unarchive" });
      return { ok: true, sessionId: id };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  async resumeSession(id: string): Promise<ControlResult> {
    try { this.assertLifecycleActive(); }
    catch (error) { return { ok: false, nonRetryable: true, error: (error as Error).message }; }
    if (this.projectRuntimePolicy) {
      if (!this.projectThreadIds.has(id)) {
        return { ok: false, nonRetryable: true, error: "project-scoped Codex cannot resume a thread it did not create in this runtime instance" };
      }
      try {
        await assertCodexProjectRoot(this.projectRuntimePolicy, this.projectRuntimePolicy.rootPath);
        this.assertLifecycleActive();
      } catch (error) {
        return { ok: false, nonRetryable: true, error: (error as Error).message };
      }
    }
    try {
      await this.ensureReady();
      this.assertLifecycleActive();
      const result = await this.request("thread/resume", {
        threadId: id,
        ...(this.projectRuntimePolicy ? codexProjectResumeParams(this.projectRuntimePolicy) : {}),
        ...(this.fullAccessThreads.has(id) ? { approvalPolicy: "never", sandbox: "danger-full-access" } : {}),
      }) as { thread?: CodexThread } & CodexThreadPermissionState;
      if (!result.thread?.id) throw new Error("Codex thread/resume did not return a thread id");
      if (result.thread.id !== id) throw new Error(`Codex thread/resume returned a different thread id (${result.thread.id})`);
      if (this.projectRuntimePolicy && !codexProjectPermissionObserved(result, this.projectRuntimePolicy)) {
        throw new Error("Codex resume did not confirm the project permission profile and exact runtime root");
      }
      if (hasCodexFullAccess(result)) this.fullAccessThreads.add(id);
      if (this.fullAccessThreads.has(id) && !hasCodexFullAccess(result)) {
        throw new Error("Codex app-server did not preserve the full-access thread settings on resume");
      }
      this.threads.set(id, result.thread);
      return { ok: true };
    } catch (error) {
      const refusal = this.quotaRefusal(error);
      if (refusal) return refusal;
      return { ok: false, error: (error as Error).message };
    }
  }

  async recover(id: string, message?: string): Promise<ControlResult> {
    if (this.projectRuntimePolicy) {
      if (!this.projectThreadIds.has(id)) {
        return { ok: false, nonRetryable: true, error: "project-scoped Codex cannot recover a thread it did not create in this runtime instance" };
      }
      try {
        await assertCodexProjectRoot(this.projectRuntimePolicy, this.projectRuntimePolicy.rootPath);
      } catch (error) {
        return { ok: false, nonRetryable: true, error: (error as Error).message };
      }
    }
    const resumed = await this.resumeSession(id);
    if (!resumed.ok) {
      const forked = await this.forkSession(id, message);
      return forked.ok ? { ...forked, error: `Original session recovery failed; forked a child instead.` } : forked;
    }
    return message ? this.sendMessage(id, { message, queue: false }) : resumed;
  }

  async forkSession(id: string, message?: string): Promise<ControlResult> {
    if (this.projectRuntimePolicy) return { ok: false, nonRetryable: true, error: "project-scoped Codex threads cannot be forked outside the trusted admission path" };
    try {
      await this.ensureReady();
      const result = await this.request("thread/fork", { threadId: id }) as { thread?: CodexThread };
      const childId = result.thread?.id;
      if (!childId) return { ok: false, error: "Codex fork did not return a child thread id" };
      if (result.thread) this.threads.set(childId, result.thread);
      if (message) {
        const sent = await this.sendMessage(childId, { message, queue: false });
        if (!sent.ok) return { ...sent, sessionId: childId };
      }
      return { ok: true, sessionId: childId };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  async changeModel(sessionId: string, model: string): Promise<ControlResult> {
    if (!sessionId) return { ok: false, error: "Codex model changes require a session id with app-server" };
    if (this.projectRuntimePolicy && model !== this.projectRuntimePolicy.modelId) return { ok: false, nonRetryable: true, error: `project-scoped Codex is pinned to ${this.projectRuntimePolicy.modelId}` };
    if (this.projectRuntimePolicy && !this.projectThreadIds.has(sessionId)) return { ok: false, nonRetryable: true, error: "project-scoped Codex cannot change a foreign thread" };
    try {
      await this.ensureReady();
      const result = await this.request("thread/resume", {
        threadId: sessionId,
        model,
        ...(this.projectRuntimePolicy ? codexProjectResumeParams(this.projectRuntimePolicy) : {}),
        ...(this.fullAccessThreads.has(sessionId) ? { approvalPolicy: "never", sandbox: "danger-full-access" } : {}),
      }) as { thread?: CodexThread } & CodexThreadPermissionState;
      if (hasCodexFullAccess(result)) this.fullAccessThreads.add(sessionId);
      if (this.projectRuntimePolicy && !codexProjectPermissionObserved(result, this.projectRuntimePolicy)) {
        throw new Error("Codex model switch did not confirm the project permission profile and exact runtime root");
      }
      if (this.fullAccessThreads.has(sessionId) && !hasCodexFullAccess(result)) {
        throw new Error("Codex app-server did not preserve the full-access thread settings on model switch");
      }
      const thread = result.thread || this.threads.get(sessionId);
      if (thread) {
        thread.model = model;
        this.threads.set(sessionId, thread);
      }
      this.emitEvent({ kind: "model.changed", harness: "codex", sessionId, data: { model } });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  async setSessionPinned(sessionId: string, pinned: boolean): Promise<ControlResult> {
    return this.rawTranscriptAdapter.setSessionPinned(sessionId, pinned);
  }

  async getSessionMessages(id: string, limit = 12): Promise<SessionMessageView[] | null> {
    if (!(await this.canReadProjectHistory(id))) return null;
    try {
      const messages = await this.rawTranscriptAdapter.getSessionMessages(id, limit);
      if (!this.projectRuntimePolicy || !this.projectThreadIds.has(id)) return messages;
      const live = this.projectLiveMessages.get(id) ?? [];
      if (messages !== null && (messages.length > 0 || live.length === 0)) return messages;
      // Ephemeral project threads have no durable rollout. This bounded in-memory
      // fallback is neither paged nor shared across threads and is deleted with
      // the owning adapter; it must never be described as archived history.
      return live.slice(-Math.max(1, Math.min(Math.floor(limit), 50)));
    }
    catch (error) {
      const projectEphemeral = this.projectRuntimePolicy && this.projectThreadIds.has(id);
      if (projectEphemeral) {
        const noRollout = /no rollout found for thread id/.test((error as Error).message);
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !noRollout) throw error;
        return this.projectLiveMessages.get(id)?.slice(-Math.max(1, Math.min(Math.floor(limit), 50))) ?? [];
      }
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.ensureReady();
      const result = await this.request("thread/read", { threadId: id, includeTurns: true }) as {
        thread?: CodexThread & { turns?: unknown[] };
      };
      // An empty native history is authoritative. An unavailable archive of an older thread is not.
      if (result.thread?.id === id && Array.isArray(result.thread.turns) && result.thread.turns.length === 0) return [];
      throw error;
    }
  }


  async getFirstUserMessage(id: string): Promise<SessionMessageView | null> {
    if (!(await this.canReadProjectHistory(id))) return null;
    return this.rawTranscriptAdapter.getFirstUserMessage(id);
  }

  async listModels(): Promise<string[]> {
    // Explicit operator overrides stay supported. The default must follow the
    // same native client that will execute the selected model, not old constants.
    if (this.modelIds.length) return [...this.modelIds];
    await this.ensureReady();
    const rows: Array<{model: string; isDefault: boolean}> = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await this.request("model/list", {
        limit: 100, includeHidden: false, ...(cursor ? {cursor} : {}),
      }) as {data?: Array<{model?: unknown; id?: unknown; hidden?: boolean; isDefault?: boolean}>; nextCursor?: string | null};
      if (!result || !Array.isArray(result.data)) throw new Error("Native Codex model catalog is unavailable or malformed");
      for (const item of result.data) {
        if (!item || item.hidden) continue;
        const model = typeof item.model === "string" ? item.model : item.id;
        if (typeof model === "string" && model.trim()) rows.push({model, isDefault: item.isDefault === true});
      }
      if (!result.nextCursor) {
        rows.sort((a,b)=>Number(b.isDefault)-Number(a.isDefault));
        return [...new Set(rows.map(row=>row.model))];
      }
      if (typeof result.nextCursor !== "string" || cursors.has(result.nextCursor)) throw new Error("Native Codex model catalog repeated or malformed cursor");
      cursor = result.nextCursor;
      cursors.add(cursor);
    }
    throw new Error("Native Codex model catalog exceeded bounded pagination");
  }

  async respondPermission(
    _sessionId: string,
    _permissionId: string,
    _response: "allow" | "deny",
    _remember?: boolean,
  ): Promise<ControlResult> {
    return { ok: false, error: "Codex app-server permission response is not implemented in this adapter yet" };
  }

  async setPermissions(_sessionId: string, _options: SetPermissionsOptions): Promise<ControlResult> {
    return { ok: false, error: "Codex app-server permissions must be configured at thread start" };
  }

  private async ensureReady(): Promise<void> {
    this.assertLifecycleActive();
    if (this.isReady()) return;
    if (!this.initialization) {
      this.initialization = this.initializeTransport().finally(() => {
        this.initialization = undefined;
      });
    }
    await this.initialization;
    this.assertLifecycleActive();
  }

  private assertLifecycleActive(): void {
    if (this.disposed || this.lifecycleSignal?.aborted) throw operationAbortedError();
  }

  private async assertEffectiveProjectToolIsolation(threadId?: string): Promise<void> {
    const inventory = await this.readProjectToolInventory(threadId);
    if (!inventory.complete || inventory.active) {
      throw new Error(`project-scoped Codex tool isolation is not proven (${inventory.summary})`);
    }
  }

  private async readProjectToolInventory(threadId?: string, discovery = false): Promise<CodexProjectToolInventory> {
    if (!this.projectRuntimePolicy) throw new Error("project tool inventory requires a trusted project policy");
    type Page = { rows: unknown[]; pages: number; complete: boolean; statusCode?: number };
    const pageAll = async (method: string): Promise<Page> => {
      const rows: unknown[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 100; page++) {
        let response: { data?: unknown[]; nextCursor?: string | null };
        try {
          response = await this.request(method, { limit: 100, ...(threadId ? { threadId } : {}), ...(cursor ? { cursor } : {}) }) as { data?: unknown[]; nextCursor?: string | null };
        } catch (error) {
          const match = (error as Error).message.match(/status\s+(\d{3})\s+/i);
          return { rows, pages: page, complete: false, ...(match ? { statusCode: Number(match[1]) } : {}) };
        }
        if (!Array.isArray(response.data)) return { rows, pages: page + 1, complete: false };
        rows.push(...response.data);
        if (!response.nextCursor) return { rows, pages: page + 1, complete: true };
        cursor = response.nextCursor;
      }
      return { rows, pages: 100, complete: false };
    };
    const [mcpResult, configResult] = await Promise.all([
      pageAll("mcpServerStatus/list"),
      this.request("config/read", {
      cwd: this.projectRuntimePolicy.rootPath,
      includeLayers: false,
      }).then((value) => value as {
        config?: {
          features?: Record<string, unknown>;
          web_search?: unknown;
          permissions?: Record<string, unknown>;
          apps?: Record<string, { enabled?: unknown } | null> | null;
          plugins?: Record<string, { enabled?: unknown } | null> | null;
          mcp_servers?: Record<string, { enabled?: unknown } | null> | null;
        };
        origins?: Record<string, { name?: { type?: unknown } } | undefined>;
      }).catch(() => null),
    ]);
    const mcpRows = mcpResult.rows as Array<{ name?: unknown; runtimeStatus?: unknown; tools?: unknown }>;
    const featureDeny = codexProjectIntegrationFeatureDeny(configResult);
    const nativeWebSearch = codexProjectNativeWebSearch(configResult, this.projectRuntimePolicy.nativeWebSearchMode);
    const filesystemDeny = codexProjectFilesystemProfileDeny(configResult, this.codexBin);
    const appConfig = configResult?.config?.apps;
    const pluginConfig = configResult?.config?.plugins;
    const mcpConfig = configResult?.config?.mcp_servers;
    const configuredAppIds = appConfig && typeof appConfig === "object" ? Object.keys(appConfig).filter((id) => id !== "_default") : [];
    const configuredPluginIds = pluginConfig && typeof pluginConfig === "object" ? Object.keys(pluginConfig) : [];
    const configuredMcpIds = mcpConfig && typeof mcpConfig === "object" ? Object.keys(mcpConfig) : [];
    const discoveryDeny = codexProjectDiscoveryDenyList({
      mcpStatusNames: mcpRows.map((server) => server.name),
      configuredMcpIds,
      configuredAppIds,
      configuredPluginIds,
    });
    const mcpStatusesNotDisabled = mcpRows.filter((server) => typeof server.runtimeStatus === "string" && server.runtimeStatus !== "disabled").length;
    const mcpStatusesUnknown = mcpRows.length - mcpRows.filter((server) => typeof server.runtimeStatus === "string").length;
    const mcpToolCount = mcpRows.reduce((total, server) => total + Object.keys(server.tools ?? {}).length, 0);
    const mcpConfigDisabled = mcpRows.filter((server) => typeof server.name === "string"
      && mcpConfig?.[server.name]?.enabled === false).length;
    const mcpConfigEnabled = Object.values(mcpConfig ?? {}).filter((server) => server?.enabled === true).length;
    const mcpConfigAllDisabled = !!mcpConfig && typeof mcpConfig === "object"
      && mcpConfigDisabled === mcpRows.length
      && Object.values(mcpConfig).every((server) => !!server && server.enabled === false);
    const pluginConfigAllDisabled = !!pluginConfig && typeof pluginConfig === "object"
      && Object.values(pluginConfig).every((plugin) => !!plugin && plugin.enabled === false);
    const mcpExposureSafe = threadId
      ? mcpStatusesUnknown === 0 && mcpStatusesNotDisabled === 0 && mcpToolCount === 0
      : mcpConfigAllDisabled && mcpToolCount === 0 && mcpStatusesNotDisabled === 0;
    const mcpStates = mcpRows.reduce<Record<string, number>>((counts, server) => {
      const state = typeof server.runtimeStatus === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(server.runtimeStatus)
        ? server.runtimeStatus : "unknown";
      counts[state] = (counts[state] ?? 0) + 1;
      return counts;
    }, {});
    const activeApps = featureDeny.complete ? 0 : 1;
    const activePlugins = pluginConfigAllDisabled ? 0 : 1;
    const idsComplete = discoveryDeny.complete;
    const flagsComplete = discovery || (mcpRows.every((server) => !!server.tools
      && typeof server.tools === "object" && !Array.isArray(server.tools)) && mcpExposureSafe);
    const complete = mcpResult.complete && configResult !== null && featureDeny.complete && filesystemDeny.complete && idsComplete && flagsComplete
      && nativeWebSearch.complete
      && (discovery || (mcpConfigAllDisabled && pluginConfigAllDisabled));
    const denyList = discoveryDeny.denyList;
    const active = !discovery && (!mcpExposureSafe || !pluginConfigAllDisabled) || activeApps > 0 || activePlugins > 0;
    const summary = JSON.stringify({
      phase: discovery ? "discovery" : threadId ? "scoped" : "effective",
      mcpRows: mcpRows.length, mcpStatusesNotDisabled, mcpStatusesUnknown, mcpTools: mcpToolCount, mcpPages: mcpResult.pages,
      mcpStates, mcpConfigKeys: configuredMcpIds.length, mcpConfigExplicitDisabled: mcpConfigDisabled,
      mcpConfigExplicitEnabled: mcpConfigEnabled, mcpConfigAllDisabled,
      pluginConfigAllDisabled,
      apps: { featureDisabled: featureDeny.complete, configuredKeys: featureDeny.appConfiguredKeys, explicitEnabled: featureDeny.appExplicitEnabled,
        defaultDisabled: featureDeny.appDefaultDisabled },
      plugins: { featureDisabled: featureDeny.complete, configuredKeys: featureDeny.pluginConfiguredKeys,
        explicitEnabled: featureDeny.pluginExplicitEnabled },
      filesystemProfile: { exactRules: filesystemDeny.exactRules, configuredPaths: filesystemDeny.configuredPaths,
        unexpectedRules: filesystemDeny.unexpectedRules, depthMetadataShape: filesystemDeny.depthMetadataShape },
      admissionChecks: {
        statusPageComplete: mcpResult.complete,
        configReadbackPresent: configResult !== null,
        identityRowsComplete: idsComplete,
        rowsWithToolMaps: mcpRows.filter((server) => !!server.tools && typeof server.tools === "object" && !Array.isArray(server.tools)).length,
        discoveryDenyIds: discoveryDeny.denyList.mcpServerIds.length,
        featurePolicyComplete: featureDeny.complete,
        filesystemPolicyComplete: filesystemDeny.complete,
      },
      featureOriginsVerified: featureDeny.complete, complete,
      nativeWebSearch,
    });
    return { complete, denyList, active, nativeWebSearch, summary };
  }

  private recordProjectUserMessage(threadId: string, turnId: string, text: string): void {
    const messages = this.projectLiveMessages.get(threadId);
    if (!messages || messages.some((message) => message.role === "user" && message.turnId === turnId)) return;
    const message: SessionMessageView = {
      id: `${turnId}:user`, role: "user", turnId, text, parts: [{ type: "text", text }],
    };
    const turnIndex = messages.findIndex((item) => item.turnId === turnId);
    messages.splice(turnIndex >= 0 ? turnIndex : messages.length, 0, message);
    if (messages.length > 200) messages.splice(0, messages.length - 200);
  }

  private recordProjectAssistantDelta(threadId: string, turnId: string, itemId: string | undefined, delta: string): void {
    const messages = this.projectLiveMessages.get(threadId);
    if (!messages || !delta) return;
    const id = itemId || `${turnId}:assistant`;
    let message = messages.find((item) => item.role === "assistant" && item.turnId === turnId && item.id === id);
    if (!message) {
      message = { id, role: "assistant", turnId, text: "", parts: [{ type: "text", text: "" }] };
      messages.push(message);
    }
    const combined = `${message.text ?? ""}${delta}`;
    if (combined.length > 1_000_000) return;
    message.text = combined;
    message.parts = [{ type: "text", text: combined }];
  }

  private recordProjectCompletedItem(threadId: string, turnId: string, item: Record<string, unknown>): void {
    const messages = this.projectLiveMessages.get(threadId);
    if (!messages || typeof item.id !== "string") return;
    if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim() && item.text.length <= 1_000_000) {
      let message = messages.find((candidate) => candidate.role === "assistant" && candidate.turnId === turnId && candidate.id === item.id);
      if (!message) {
        message = { id: item.id, role: "assistant", turnId, text: item.text, parts: [{ type: "text", text: item.text }] };
        messages.push(message);
      } else {
        message.text = item.text;
        message.parts = [{ type: "text", text: item.text }];
      }
      if (typeof item.phase === "string") message.phase = item.phase;
    } else if (item.type === "commandExecution" && typeof item.aggregatedOutput === "string"
      && item.aggregatedOutput.length <= 1_000_000) {
      const prior = messages.find((candidate) => candidate.role === "tool" && candidate.turnId === turnId && candidate.id === item.id);
      if (!item.aggregatedOutput && prior?.text) return;
      const message: SessionMessageView = {
        id: item.id, role: "tool", turnId, text: item.aggregatedOutput,
        parts: [{ type: "tool_result", output: item.aggregatedOutput }],
      };
      const index = messages.findIndex((candidate) => candidate.role === "tool" && candidate.turnId === turnId && candidate.id === item.id);
      if (index >= 0) messages[index] = message;
      else messages.push(message);
    }
    if (messages.length > 200) messages.splice(0, messages.length - 200);
  }

  private recordProjectToolOutputDelta(threadId: string, turnId: string, itemId: string, delta: string): void {
    const messages = this.projectLiveMessages.get(threadId);
    if (!messages || !delta) return;
    let message = messages.find((item) => item.role === "tool" && item.turnId === turnId && item.id === itemId);
    if (!message) {
      message = { id: itemId, role: "tool", turnId, text: "", parts: [{ type: "tool_result", output: "" }] };
      messages.push(message);
    }
    const combined = `${message.text ?? ""}${delta}`;
    if (combined.length > 1_000_000) return;
    message.text = combined;
    message.parts = [{ type: "tool_result", output: combined }];
    if (messages.length > 200) messages.splice(0, messages.length - 200);
  }

  private recordProjectCommandItem(threadId: string, turnId: string, item: Record<string, unknown>): void {
    if (item.type !== "commandExecution" || typeof item.id !== "string") return;
    const receipts = this.projectCommandReceipts.get(threadId);
    if (!receipts) return;
    let receipt = receipts.find((candidate) => candidate.turnId === turnId && candidate.itemId === item.id);
    if (!receipt) {
      receipt = { itemId: item.id, turnId, command: "", cwd: "", output: "" };
      receipts.push(receipt);
    }
    if (typeof item.command === "string" && item.command.length <= 16_384) receipt.command = item.command;
    if (typeof item.cwd === "string" && item.cwd.length <= 4_096) receipt.cwd = item.cwd;
    if (typeof item.status === "string") receipt.status = item.status;
    if (item.exitCode === null || typeof item.exitCode === "number" && Number.isInteger(item.exitCode)) receipt.exitCode = item.exitCode;
    if (typeof item.aggregatedOutput === "string" && item.aggregatedOutput.length <= 1_000_000
      && (item.aggregatedOutput.length > 0 || receipt.output.length === 0)) receipt.output = item.aggregatedOutput;
    if (receipts.length > 50) receipts.splice(0, receipts.length - 50);
    if (this.projectRuntimePolicy?.materialized) {
      this.reportMaterializationProgress({
        phase: item.status === "completed" ? "command_completed" : "command_observed",
        operationId: this.projectRuntimePolicy.binding.attemptId, threadId, turnId, itemId: receipt.itemId,
        cwd: receipt.cwd,
        ...(receipt.command ? { commandSha256: createHash("sha256").update(receipt.command).digest("hex") } : {}),
        ...(receipt.output ? { outputSha256: createHash("sha256").update(receipt.output).digest("hex") } : {}),
        ...(receipt.status ? { status: receipt.status } : {}),
        ...(receipt.exitCode !== undefined ? { exitCode: receipt.exitCode } : {}),
      });
    }
  }

  private recordProjectCommandOutputDelta(threadId: string, turnId: string, itemId: string, delta: string): void {
    const receipts = this.projectCommandReceipts.get(threadId);
    if (!receipts || !delta) return;
    let receipt = receipts.find((candidate) => candidate.turnId === turnId && candidate.itemId === itemId);
    if (!receipt) {
      receipt = { itemId, turnId, command: "", cwd: "", output: "" };
      receipts.push(receipt);
    }
    const combined = `${receipt.output}${delta}`;
    if (combined.length <= 1_000_000) receipt.output = combined;
    if (this.projectRuntimePolicy?.materialized) {
      this.reportMaterializationProgress({ phase: "command_observed", operationId: this.projectRuntimePolicy.binding.attemptId,
        threadId, turnId, itemId, cwd: receipt.cwd,
        ...(receipt.command ? { commandSha256: createHash("sha256").update(receipt.command).digest("hex") } : {}),
        outputSha256: createHash("sha256").update(receipt.output).digest("hex"),
        ...(receipt.status ? { status: receipt.status } : {}),
        ...(receipt.exitCode !== undefined ? { exitCode: receipt.exitCode } : {}),
      });
    }
  }

  private async initializeTransport(): Promise<void> {
    this.assertLifecycleActive();
    if (this.socketPath) {
      if (!this.socket || this.socket.readyState >= WebSocket.CLOSING) await this.startSocket();
    } else if (!this.child || this.child.killed) {
      this.startProcess();
    }
    this.assertLifecycleActive();
    await this.request("initialize", {
      clientInfo: { name: "agent-herder", title: "Agent Herder", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.assertLifecycleActive();
    this.notify("initialized", {});
    this.initialized = true;
  }

  private async startSocket(): Promise<void> {
    const socketPath = this.socketPath;
    if (!socketPath) throw new Error("Codex app-server socket path is not configured");
    const socket = new WebSocket(`ws+unix:${socketPath}:/rpc`, {
      perMessageDeflate: false,
      handshakeTimeout: this.requestTimeoutMs,
    });
    this.socket = socket;
    this.stderrTail = "";
    const onMessage = (data: WebSocket.RawData) => {
      if (this.socket !== socket) return;
      try {
        this.consumeMessage(JSON.parse(data.toString()) as RpcResponse & { method?: string; params?: Record<string, unknown> });
      } catch {
        // Ignore malformed app-server messages, matching the stdio parser.
      }
    };
    const onError = (error: Error) => {
      this.handleSocketDisconnect(socket, error, { error: error.message });
    };
    const onClose = (code: number, reason: Buffer) => {
      this.handleSocketDisconnect(socket, new Error("Codex app-server socket closed"), {
        code,
        reason: reason.toString("utf8"),
      });
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.on("close", onClose);
    this.socketCleanups.set(socket, () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    });
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        socket.off("close", onOpeningClose);
        socket.off("error", onOpeningError);
        this.emitEvent({ kind: "process.connected", harness: "codex", data: { transport: "app-server-unix-websocket" } });
        resolve();
      };
      const onOpeningError = (error: Error) => {
        socket.off("open", onOpen);
        socket.off("close", onOpeningClose);
        reject(error);
      };
      const onOpeningClose = (code: number, reason: Buffer) => {
        socket.off("open", onOpen);
        socket.off("error", onOpeningError);
        reject(new Error(`Codex app-server socket closed before connecting (${code}${reason.length ? `: ${reason.toString("utf8")}` : ""})`));
      };
      socket.once("open", onOpen);
      socket.once("error", onOpeningError);
      socket.once("close", onOpeningClose);
    });
  }

  private startProcess(): void {
    const child = spawnIsolatedWorkload(this.codexBin, this.processArgs, {
      label: "codex-app-server",
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.projectChildEnvironment(),
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.stderrTail = "";
    let inputBuffer = "";
    this.emitEvent({ kind: "process.connected", harness: "codex", data: { transport: "app-server" } });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const onStdout = (chunk: string) => {
      if (this.child !== child) return;
      inputBuffer = this.consumeOutput(chunk, inputBuffer);
    };
    const onStderr = (chunk: string) => {
      if (this.child !== child) return;
      this.consumeStderr(chunk);
    };
    const onError = (error: Error) => {
      this.handleTransportDisconnect(child, error, { error: error.message });
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const detail = this.stderrTail ? `; stderr: ${this.stderrTail}` : "";
      this.handleTransportDisconnect(child, new Error(`Codex app-server exited${detail}`), { code: code ?? undefined, signal: signal ?? undefined });
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("error", onError);
    child.on("exit", onExit);
    this.transportCleanups.set(child, () => {
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      inputBuffer = "";
    });
  }

  private handleTransportDisconnect(
    child: ChildProcessWithoutNullStreams,
    error: Error,
    data: Record<string, unknown>,
  ): void {
    if (this.child !== child) return;
    this.transportCleanups.get(child)?.();
    this.transportCleanups.delete(child);
    this.initialized = false;
    this.child = undefined;
    this.clearTransportState(error, data, true);
  }

  private handleSocketDisconnect(socket: WebSocket, error: Error, data: Record<string, unknown>): void {
    if (this.socket !== socket) return;
    this.socketCleanups.get(socket)?.();
    this.socketCleanups.delete(socket);
    socket.on("error", () => {});
    this.initialized = false;
    this.socket = undefined;
    this.clearTransportState(error, { transport: "app-server-unix-websocket", ...data }, false);
  }

  private clearTransportState(error: Error, data: Record<string, unknown>, failActiveTurns: boolean): void {
    const interruptedSessions = [...this.activeTurns.entries()];
    this.activeTurns.clear();
    this.eventStartedTurns.clear();
    this.failCompletions(error);
    this.rejectPending(error);
    // Loss of the control socket is observation loss, not proof of daemon
    // death. Emit scoped evidence for the recovery owner to persist; it must
    // re-read native state and exclude a still-running turn before action.
    for (const [sessionId, turnId] of interruptedSessions) {
        this.emitEvent({
          kind: "process.disconnected",
          harness: "codex",
          sessionId,
          nativeType: "process.disconnected",
          status: "error",
          data: { transport: failActiveTurns ? "app-server" : "app-server-unix-websocket", turnId, error: error.message },
        });
    }
    this.emitEvent({ kind: "process.disconnected", harness: "codex", data: { transport: "app-server", ...data } });
  }

  private notify(method: string, params: unknown): void {
    this.writeMessage({ method, params });
  }

  async readQuota(): Promise<unknown> {
    await this.ensureReady();
    return this.request("account/rateLimits/read", {});
  }

  /**
   * A quota refusal happens before the transport write: nothing was submitted,
   * so the caller must not read it as an unknown admission it may retry.
   */
  private quotaRefusal(error: unknown): { ok: false; notSubmitted: true; admitted: false; nonRetryable: true; admissionUnknown: false; error: string } | undefined {
    if (!(error instanceof CodexQuotaBlockedError)) return undefined;
    return { ok: false, notSubmitted: true, admitted: false, nonRetryable: true, admissionUnknown: false, error: error.message };
  }

  private async request(method: string, params: unknown, stage = method): Promise<unknown> {
    try { this.assertLifecycleActive(); }
    catch (error) { return Promise.reject(error); }
    if (!this.isTransportWritable()) return Promise.reject(new Error("Codex app-server is not connected"));
    if (["thread/start", "thread/fork", "thread/resume", "turn/start", "turn/steer"].includes(method)) {
      await assertCodexQuota(method, this.quotaReader ?? (() => this.request("account/rateLimits/read", {})));
      this.assertLifecycleActive();
      if (!this.isTransportWritable()) throw new Error("Codex app-server disconnected during quota check");
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server timed out during ${stage}${this.stderrTail ? `; stderr: ${this.stderrTail}` : ""}`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.writeMessage({ id, method, params }, id);
      } catch (error) {
        this.rejectRequest(id, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private isTransportWritable(): boolean {
    return this.socketPath
      ? this.socket?.readyState === WebSocket.OPEN
      : !!this.child?.stdin.writable;
  }

  private writeMessage(message: Record<string, unknown>, requestId?: number): void {
    const serialized = JSON.stringify(message);
    if (this.socketPath) {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Codex app-server WebSocket is not connected");
      socket.send(serialized, (error) => {
        if (error && requestId !== undefined) this.rejectRequest(requestId, error);
      });
      return;
    }
    if (!this.child?.stdin.writable) throw new Error("Codex app-server stdin is not writable");
    this.child.stdin.write(`${serialized}\n`);
  }

  private rejectRequest(id: number, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private consumeOutput(chunk: string, inputBuffer: string): string {
    const lines = `${inputBuffer}${chunk}`.split("\n");
    const remainder = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.consumeMessage(JSON.parse(line) as RpcResponse & { method?: string; params?: Record<string, unknown> });
      } catch {
        // Ignore non-JSON diagnostic output on stdout from an incompatible wrapper.
      }
    }
    return remainder;
  }

  private consumeMessage(message: RpcResponse & { method?: string; params?: Record<string, unknown> }): void {
    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message as RpcResponse & { method: string; params?: Record<string, unknown> });
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new CodexRpcError(message.error.message || `Codex RPC error ${message.error.code || "unknown"}`, message.error.code));
      else pending.resolve(message.result);
      return;
    }
    if (!message.method || !message.params) return;
    const params = message.params;
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (threadId && typeof params.thread === "object" && params.thread) {
      this.threads.set(threadId, params.thread as CodexThread);
      this.emitEvent({ kind: "session.updated", harness: "codex", sessionId: threadId, nativeType: message.method });
    }
    if (message.method === "turn/started" && threadId) {
      const turn = params.turn as { id?: string } | undefined;
      if (turn?.id) {
        this.unavailableNativeTurnStates.delete(threadId);
        this.eventStartedTurns.add(threadId);
        this.activeTurns.set(threadId, turn.id);
        this.lastNativeTurns.set(threadId, { turnId: turn.id, status: "inProgress" });
        const completion = this.completions.get(threadId);
        if (completion) {
          completion.startedTurnId = turn.id;
          this.settleCompletion(threadId);
        }
      }
      this.emitEvent({ kind: "turn.started", harness: "codex", sessionId: threadId, nativeType: message.method, status: "running", data: { turnId: turn?.id } });
    }
    if (message.method === "item/agentMessage/delta" && threadId && typeof params.delta === "string") {
      const thread = this.threads.get(threadId);
      if (thread) thread.preview = params.delta;
      const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
      const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
      if (this.projectRuntimePolicy && this.projectThreadIds.has(threadId) && turnId) {
        this.recordProjectAssistantDelta(threadId, turnId, itemId, params.delta);
      }
      this.emitEvent({ kind: "message.updated", harness: "codex", sessionId: threadId, nativeType: message.method });
    }
    if (threadId && this.projectRuntimePolicy && this.projectThreadIds.has(threadId)) {
      const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
      const item = params.item && typeof params.item === "object" ? params.item as Record<string, unknown> : undefined;
      if (turnId && (message.method === "item/started" || message.method === "item/completed") && item) {
        this.recordProjectCommandItem(threadId, turnId, item);
        if (message.method === "item/completed") this.recordProjectCompletedItem(threadId, turnId, item);
      } else if (turnId && message.method === "item/commandExecution/outputDelta"
        && typeof params.itemId === "string" && typeof params.delta === "string") {
        this.recordProjectToolOutputDelta(threadId, turnId, params.itemId, params.delta);
        this.recordProjectCommandOutputDelta(threadId, turnId, params.itemId, params.delta);
      }
    }
    if (message.method === "turn/completed" && threadId) {
      this.eventStartedTurns.delete(threadId);
      this.activeTurns.delete(threadId);
      const completedTurn = params.turn as { id?: string; status?: string; completedAt?: string | number } | undefined;
      if (completedTurn?.id && completedTurn.status) {
        this.unavailableNativeTurnStates.delete(threadId);
        const quotaFailure = codexTerminalQuotaEvidence(completedTurn, this.threads.get(threadId)?.model);
        this.lastNativeTurns.set(threadId, {
          ...(quotaFailure ? { quotaFailure, inputId: quotaFailure.inputId, userMessageId: quotaFailure.inputId } : {}),
          turnId: completedTurn.id,
          status: completedTurn.status,
          ...(threadTimestamp(completedTurn.completedAt) ? { completedAt: threadTimestamp(completedTurn.completedAt) } : {}),
        });
      }
      const ownInterrupt = this.internalInterrupts.get(threadId);
      const isOwnInterrupt = completedTurn?.status === "interrupted"
        && typeof completedTurn.id === "string"
        && ownInterrupt?.turnId === completedTurn.id;
      if (completedTurn?.status === "interrupted" && !isOwnInterrupt && typeof completedTurn.id === "string") {
        const at = threadTimestamp(completedTurn.completedAt) || threadTimestamp(message.emittedAtMs) || new Date().toISOString();
        const automationStop: CodexAutomationStop = {
          id: completedTurn.id,
          at,
          reason: "interrupted",
          turnId: completedTurn.id,
        };
        this.emitEvent({
          kind: "turn.completed",
          harness: "codex",
          sessionId: threadId,
          nativeType: message.method,
          status: "idle",
          data: { automationStop, turnId: completedTurn.id },
        });
      } else {
        this.emitEvent({ kind: completedTurn?.status === "failed" ? "turn.failed" : "turn.completed", harness: "codex", sessionId: threadId, nativeType: message.method, status: completedTurn?.status === "failed" ? "error" : "idle", data: { turnId: completedTurn?.id, ...(this.lastNativeTurns.get(threadId)?.quotaFailure ? { quotaFailure: this.lastNativeTurns.get(threadId)!.quotaFailure, inputId: this.lastNativeTurns.get(threadId)!.inputId } : {}) } });
      }
      const completion = this.completions.get(threadId);
      if (completion) {
        const turn = params.turn as { id?: string; status?: string } | undefined;
        completion.completedTurnId = turn?.id;
        completion.completedStatus = turn?.status;
        this.settleCompletion(threadId);
      }
    }
    if (message.method === "error" && threadId) {
      // A generic RPC error without an exact native turn cannot authorize recovery.
      this.emitEvent({ kind: "turn.failed", harness: "codex", sessionId: threadId, nativeType: message.method, status: "error", data: { turnId: typeof params.turnId === "string" ? params.turnId : undefined } });
      const completion = this.completions.get(threadId);
      if (completion) {
        clearTimeout(completion.timer);
        this.completions.delete(threadId);
        completion.resolve({ ok: false, error: "Codex turn reported an error" });
      }
    }
  }

  private handleServerRequest(message: RpcResponse & { method: string; params?: Record<string, unknown> }): void {
    if (!message.params) return;
    const threadId = typeof message.params.threadId === "string" ? message.params.threadId : undefined;
    if (threadId && typeof message.params.thread === "object" && message.params.thread) {
      this.threads.set(threadId, message.params.thread as CodexThread);
    }
  }

  private emitEvent(event: HarnessEvent): void {
    const normalized = { ...event, at: event.at ?? new Date().toISOString() };
    for (const listener of [...this.eventListeners]) {
      try { listener(normalized); } catch { /* isolate listeners */ }
    }
  }

  private consumeStderr(chunk: string): void {
    this.stderrTail = boundedAppend(this.stderrTail, redactSensitive(chunk), 8_000);
  }

  private waitForCompletion(threadId: string): Promise<ControlResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.completions.delete(threadId);
        resolve({ ok: false, error: `Timed out waiting for Codex turn completion for ${threadId}` });
      }, 300000);
      this.completions.set(threadId, { resolve, timer });
    });
  }

  private settleCompletion(threadId: string): void {
    const completion = this.completions.get(threadId);
    if (!completion) return;
    if (completion.completedStatus === "failed") {
      clearTimeout(completion.timer);
      this.completions.delete(threadId);
      completion.resolve({ ok: false, error: "Codex turn failed" });
      return;
    }
    if (!completion.requestedTurnId || !completion.startedTurnId || !completion.completedTurnId || !completion.completedStatus) return;
    if (completion.requestedTurnId !== completion.startedTurnId || completion.requestedTurnId !== completion.completedTurnId) {
      clearTimeout(completion.timer);
      this.completions.delete(threadId);
      completion.resolve({ ok: false, error: `Codex turn admission mismatch for ${threadId}` });
      return;
    }
    clearTimeout(completion.timer);
    this.completions.delete(threadId);
    completion.resolve(completion.completedStatus === "failed"
      ? { ok: false, error: "Codex turn failed" }
      : { ok: true });
  }

  private clearCompletion(threadId: string): void {
    const completion = this.completions.get(threadId);
    if (!completion) return;
    clearTimeout(completion.timer);
    this.completions.delete(threadId);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private failCompletions(error: Error): void {
    for (const completion of this.completions.values()) {
      clearTimeout(completion.timer);
      completion.resolve({ ok: false, error: error.message });
    }
    this.completions.clear();
  }

  private toSession(thread: CodexThread): AgentSession {
    const activeFlags = this.threadActiveFlags(thread.status);
    return {
      id: thread.id,
      harness: "codex",
      status: this.mapStatus(thread.status, thread.id),
      // Native preview can exceed the strict HumanStopStore title bound. Keep
      // full preview as lastMessage; display text must not invalidate STOP reads.
      title: (thread.name?.trim() || thread.preview?.trim() || "Untitled session").slice(0, 500),
      cwd: thread.cwd || thread.path || this.cwd,
      hostId: localSessionHostId(),
      lastActivity: threadTimestamp(thread.updatedAt) || threadTimestamp(thread.createdAt) || new Date(0).toISOString(),
      ...(typeof thread.model === "string" ? { model: thread.model } : {}),
      needsPermission: activeFlags.includes("waitingOnApproval"),
      lastMessage: thread.preview,
      meta: {
        nativeSessionId: thread.id,
        createdAt: threadTimestamp(thread.createdAt) || undefined,
        transport: "codex-app-server",
        activeTurnId: this.activeTurns.get(thread.id),
        ...(this.lastNativeTurns.has(thread.id) ? { nativeLastTurn: this.lastNativeTurns.get(thread.id) } : {}),
        ...(this.unavailableNativeTurnStates.has(thread.id) ? { nativeTurnStateUnavailable: true } : {}),
        ...(typeof thread.parentThreadId === "string" && thread.parentThreadId !== thread.id ? { parentThreadId: thread.parentThreadId } : {}),
        modelProvider: thread.modelProvider,
      },
    };
  }

  private mapStatus(raw: CodexThread["status"], id: string): AgentSession["status"] {
    const status = this.threadStatusTag(raw);
    const activeFlags = this.threadActiveFlags(raw);
    if (status === "active" && activeFlags.some((flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput")) {
      return "needs_input";
    }
    if (this.activeTurns.has(id) || status === "inProgress" || status === "running" || status === "active") return "running";
    if (status === "failed" || status === "error" || status === "systemError") return "error";
    if (status === "interrupted" || status === "completed" || status === "idle" || status === "notLoaded") return "idle";
    return "idle";
  }
}

function boundedAppend(current: string, chunk: string, maxChars: number): string {
  const next = `${current}${chunk}`;
  if (next.length <= maxChars) return next;
  return next.slice(next.length - maxChars);
}

function redactSensitive(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|credential)\s*[:=]\s*([^\s,;]+)/gi, "$1=[redacted]")
    .replace(/([?&](?:token|key|secret|password|signature)=)[^&\s]+/gi, "$1[redacted]");
}

function throwIfSignalAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw operationAbortedError();
}

function operationAbortedError(): Error {
  const error = new Error("Codex adapter operation aborted");
  error.name = "AbortError";
  return error;
}

async function terminateOwnedChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const wait = (milliseconds: number): Promise<boolean> => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return; }
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const onError = () => finish(true);
    const timer = setTimeout(() => finish(child.exitCode !== null || child.signalCode !== null), milliseconds);
    timer.unref?.();
    child.once("exit", onExit);
    child.once("error", onError);
  });
  try { child.kill("SIGTERM"); } catch { /* owned child may be exiting */ }
  if (await wait(1_000)) return;
  try { child.kill("SIGKILL"); } catch { /* owned child may exit between checks */ }
  if (!await wait(1_000)) {
    const error = new Error("Codex app-server child termination could not be confirmed");
    error.name = "OwnedChildTerminationUnconfirmedError";
    throw error;
  }
}

async function waitForSocketClose(socket: WebSocket, milliseconds: number): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timer); socket.off("close", finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    socket.once("close", finish);
  });
}

function sameProjectExecutionBinding(left: ProjectExecutionBinding, right: ProjectExecutionBinding): boolean {
  return left.projectId === right.projectId && left.rootIdentity === right.rootIdentity
    && left.policyRevision === right.policyRevision && left.attemptId === right.attemptId
    && left.hostId === right.hostId && left.runtimeInstanceId === right.runtimeInstanceId;
}

function sameScopeDirectoryIdentity(left: ProjectScopeDirectoryIdentity, right: ProjectScopeDirectoryIdentity): boolean {
  return left.path === right.path && left.device === right.device && left.inode === right.inode;
}
