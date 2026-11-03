import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentSession,
  ControlResult,
  CreateSessionOptions,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
  HarnessType,
  ListSessionsOptions,
  SendMessageOptions,
  SendMessageResult,
  SessionMessageView,
  SetPermissionsOptions,
  SessionRenameOutcome,
  SessionSnapshotReceipt,
  RawTranscriptExport,
} from "../types/index.js";
import { localSessionHostId } from "../types/index.js";

/**
 * External-process adapter: a HarnessAdapter that proxies every call to a
 * subprocess speaking the Agent-Herder Adapter Protocol (AHAP) — JSON-RPC
 * 2.0 over newline-delimited JSON on stdio. See
 * docs/external-adapter-protocol.md for the spec.
 *
 * The subprocess can be written in any language. The supervisor keeps
 * only this thin shim in its V8 heap; the heavy per-harness bridge code
 * (200 KB+ of TS that V8 JITs into hundreds of MB) lives in the
 * subprocess, with its own (native, much smaller) heap.
 *
 * Lifecycle:
 *   - constructed with the executable path and args;
 *   - `init()` spawns the subprocess and sends `initialize` + `init`;
 *   - every HarnessAdapter method becomes a JSON-RPC request;
 *   - events emitted by the subprocess become HarnessEvents on the bus;
 *   - `stop()` sends `shutdown`, waits 5s, then SIGTERM + SIGKILL.
 */
export interface ExternalAdapterConfig {
  /** Harness type id, e.g. "chatgpt", "zai", "codex", "echo". */
  harness: HarnessType;
  /** Human-readable name shown in the registry. */
  name: string;
  /** Executable path, absolute. */
  command: string;
  /** Arguments passed to the executable. */
  args?: readonly string[];
  /** Working directory for the subprocess. */
  cwd?: string;
  /** Extra environment variables (the supervisor never leaks secrets). */
  env?: Record<string, string>;
  /** Max time to wait for a single JSON-RPC response. Default 30 s. */
  requestTimeoutMs?: number;
  /** Max time to wait for the subprocess to exit on shutdown. Default 5 s. */
  shutdownGraceMs?: number;
}

const AHAP_VERSION = "0.1";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface InitializeResult {
  harness: string;
  name: string;
  capabilities: {
    methods: string[];
    controlCapabilities: Partial<HarnessCapabilities>;
    browserFeatures?: { nativeConversationIds: boolean; queueAfterGeneration: boolean; chatCreation: boolean; accountArchiveViaCdp: boolean };
    runtimeCapabilities?: Record<string, unknown>;
  };
}

export class ExternalProcessAdapter implements HarnessAdapter {
  readonly type: HarnessType;
  readonly name: string;
  controlCapabilities: HarnessCapabilities;
  private child: ChildProcess | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventListeners = new Set<(event: HarnessEvent) => void>();
  private initialized = false;
  private initResult?: InitializeResult;
  private readonly requestTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private stderrBuffer = "";

  constructor(private readonly config: ExternalAdapterConfig) {
    this.type = config.harness;
    this.name = config.name;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30_000;
    this.shutdownGraceMs = config.shutdownGraceMs ?? 5_000;
    // Conservative defaults; refined after initialize() returns the actual set.
    this.controlCapabilities = {
      cancelTurn: false, detach: false, resume: false, terminate: false,
      recover: false, fork: false, modelSwitch: false, subagents: false, events: true,
    };
  }

  private ensureChild(): ChildProcess {
    if (this.child && !this.child.killed) return this.child;
    const env: Record<string, string> = {
      AHAP_VERSION,
      AHAP_HARNESS: String(this.config.harness),
      AHAP_ROLE: "adapter",
      // The subprocess MAY read this for durable state alongside the supervisor.
      AGENT_HERDER_AUTOPILOT_STATE_DIR: process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR || "",
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
      LANG: process.env.LANG || "C.UTF-8",
      ...this.config.env,
    };
    const child = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.config.cwd,
      env,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let buffer = "";
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) this.onLine(line).catch((error) => {
          console.error("[agent-herder] external_adapter parse_error " + String((error as Error)?.message || error).slice(0, 200));
        });
      }
    });
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer += chunk;
      if (this.stderrBuffer.length > 8192) this.stderrBuffer = this.stderrBuffer.slice(-8192);
      // surface stderr lines to journald so an adapter crash is never silent
      for (const line of chunk.split("\n")) {
        if (line.trim()) console.error("[agent-herder] external_adapter stderr " + this.config.harness + ": " + line.slice(0, 300));
      }
    });
    // A spawn failure (missing binary, no execute permission) surfaces as an
    // 'error' event, not a thrown exception: without a listener Node would
    // raise it as an uncaught exception and take the supervisor down.
    child.on("error", (error) => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("external_adapter_spawn_failed: " + String((error as Error)?.message || error).slice(0, 200)));
        this.pending.delete(id);
      }
    });
    child.on("exit", (code, signal) => {
      // Reject every pending request: the subprocess is gone.
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("external_adapter_exited code=" + String(code) + " signal=" + String(signal)));
        this.pending.delete(id);
      }
      if (!this.initialized) {
        // init() will see this and reject; no extra log needed.
      } else {
        console.error("[agent-herder] external_adapter exited " + this.config.harness + " code=" + String(code) + " signal=" + String(signal));
      }
    });
    this.child = child;
    return child;
  }

  private async onLine(line: string): Promise<void> {
    let msg: { jsonrpc: "2.0"; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };
    try { msg = JSON.parse(line); } catch (error) { throw new Error("invalid JSON line: " + line.slice(0, 200)); }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      // Response to one of our requests
      const id = Number(msg.id);
      const pending = this.pending.get(id);
      if (!pending) return; // stale reply after timeout
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (msg.error) {
        const err = new Error("external_adapter_error " + msg.error.code + ": " + msg.error.message);
        (err as Error & { code?: number; data?: unknown }).code = msg.error.code;
        (err as Error & { code?: number; data?: unknown }).data = msg.error.data;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (msg.method === "event" && msg.params) {
      const event = msg.params as HarnessEvent;
      // Always tag the harness so listeners can route even if the adapter forgot.
      if (!event.harness) event.harness = this.type;
      for (const handler of this.eventListeners) {
        try { handler(event); } catch { /* a listener must never break the adapter */ }
      }
    }
    // Adapters may also send their own requests to the supervisor later
    // (e.g. asking for the active fleet node). That is a v0.2 extension;
    // v0.1 ignores them with a logged warning.
    if (msg.id !== undefined && msg.method && msg.method !== "event") {
      console.error("[agent-herder] external_adapter unexpected_request method=" + msg.method);
    }
  }

  private async rpc<T>(method: string, params?: unknown): Promise<T> {
    const child = this.ensureChild();
    if (!child.stdin || !child.stdin.writable) throw new Error("external_adapter stdin not writable");
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("external_adapter_timeout method=" + method + " timeout_ms=" + this.requestTimeoutMs));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve: (v: unknown) => resolve(v as T), reject, timer });
      child.stdin!.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error("external_adapter_write_failed: " + err.message));
        }
      });
    });
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    const result = await this.rpc<InitializeResult>("initialize", {
      harness: this.config.harness,
      ahapVersion: AHAP_VERSION,
      autopilotStateDir: process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR,
    });
    this.initResult = result;
    if (result.capabilities?.controlCapabilities) {
      this.controlCapabilities = {
        ...this.controlCapabilities,
        ...result.capabilities.controlCapabilities,
        events: true, // we always proxy events
      };
    }
    // Only call `init` if the adapter declares it.
    if (result.capabilities?.methods?.includes("init")) {
      await this.rpc<void>("init").catch((error) => {
        // init failures are not fatal: the adapter still answers per-call.
        console.error("[agent-herder] external_adapter init_failed " + this.config.harness + ": " + String((error as Error)?.message || error).slice(0, 200));
      });
    }
    this.initialized = true;
  }

  isReady(): boolean { return this.initialized && !!this.child && !this.child.killed; }

  subscribeEvents(handler: (event: HarnessEvent) => void): () => void {
    this.eventListeners.add(handler);
    // Tell the subprocess to start emitting events. The supervisor's
    // existing handleHarnessEvent fan-out routes them to the notice-bridge
    // and the UI event bus.
    void this.rpc<void>("subscribeEvents", {}).catch(() => undefined);
    return () => { this.eventListeners.delete(handler); };
  }

  async listSessions(options?: ListSessionsOptions): Promise<AgentSession[]> {
    return this.tagSessions(await this.rpc<AgentSession[]>("listSessions", { options }));
  }
  async getSession(id: string): Promise<AgentSession | null> {
    const s = await this.rpc<AgentSession | null>("getSession", { id });
    return s ? this.tagOne(s) : null;
  }
  async getSessionMessages(id: string, limit?: number): Promise<SessionMessageView[] | null> {
    return this.rpc<SessionMessageView[] | null>("getSessionMessages", { id, limit });
  }
  async sendMessage(id: string, options: SendMessageOptions): Promise<SendMessageResult> {
    return this.rpc<SendMessageResult>("sendMessage", { id, options });
  }
  async stopTurn(id: string): Promise<ControlResult> {
    return this.rpc<ControlResult>("stopTurn", { id });
  }
  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    return this.tagOne(await this.rpc<AgentSession>("createSession", { options }));
  }
  async renameSession(id: string, options: { title: string }): Promise<SessionRenameOutcome> {
    return this.rpc<SessionRenameOutcome>("renameSession", { id, options });
  }
  async setPermissions(id: string, options: SetPermissionsOptions): Promise<{ ok: boolean; error?: string }> {
    return this.rpc<{ ok: boolean; error?: string }>("setPermissions", { id, options });
  }
  async listModels(): Promise<string[]> {
    return this.rpc<string[]>("listModels");
  }
  async stopSession(id: string): Promise<ControlResult> {
    // Legacy alias of terminate. The supervisor's registry treats any
    // adapter that implements stopSession as able to terminate a session.
    return this.rpc<ControlResult>("stopSession", { id });
  }
  async respondPermission(
    sessionId: string,
    permissionId: string,
    response: "allow" | "deny",
    remember?: boolean,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.rpc<{ ok: boolean; error?: string }>("respondPermission",
      { sessionId, permissionId, response, remember });
  }

  /** Stop the subprocess cleanly. Safe to call multiple times. */
  async stop(): Promise<void> {
    if (!this.child) return;
    try { await this.rpc<void>("shutdown", {}); } catch { /* adapter may already be gone */ }
    // The grace window only has to cover a subprocess that is still alive:
    // one that already exited after answering shutdown must not make every
    // caller wait the full grace period.
    const alive = () => !!this.child && !this.child.killed && this.child.exitCode === null && this.child.signalCode === null;
    const deadline = Date.now() + this.shutdownGraceMs;
    while (alive() && Date.now() < deadline) await delay(50);
    if (alive()) {
      this.child.kill("SIGTERM");
      await delay(500);
      if (alive()) this.child.kill("SIGKILL");
    }
    this.child = undefined;
  }

  // The supervisor stamps hostId on every session it serves so that the
  // active-session inventory stays consistent across fleet nodes; the
  // external subprocess must not have to know the supervisor's hostId.
  private tagSessions(sessions: AgentSession[]): AgentSession[] {
    return sessions.map((s) => this.tagOne(s));
  }
  private tagOne(s: AgentSession): AgentSession {
    return s.hostId ? s : { ...s, hostId: localSessionHostId() };
  }
}
