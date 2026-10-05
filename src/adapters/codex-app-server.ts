import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { CodexAdapter } from "./codex.js";
import { spawnIsolatedWorkload } from "../workload-launcher.js";
import type {
  AgentSession,
  ControlResult,
  CreateSessionOptions,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
  SendMessageOptions,
  SetPermissionsOptions,
  RawTranscriptExport,
  SessionMessageView,
} from "../types/index.js";

interface RpcResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string; code?: number };
}

interface CodexThread {
  id: string;
  cwd?: string;
  path?: string;
  name?: string;
  preview?: string;
  model?: string;
  modelProvider?: string;
  status?: string;
  createdAt?: string | number;
  updatedAt?: string | number;
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
 * Persistent native transport for Codex's JSONL app-server.
 *
 * The adapter owns one app-server process, while Codex owns thread and turn
 * state. A thread can therefore be cancelled and resumed without killing the
 * transport or losing events.
 */
export class CodexAppServerAdapter implements HarnessAdapter {
  readonly type = "codex" as const;
  readonly name = "Codex app-server";
  readonly lazyStart = true;
  readonly lazyDiscovery = true;
  readonly controlCapabilities: HarnessCapabilities = {
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
  private readonly processArgs: string[];
  private readonly cwd: string;
  private readonly modelIds: string[];
  private readonly rawTranscriptAdapter: CodexAdapter;
  private readonly requestTimeoutMs: number;
  private child?: ChildProcessWithoutNullStreams;
  private initialized = false;
  private initialization?: Promise<void>;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly threads = new Map<string, CodexThread>();
  private readonly activeTurns = new Map<string, string>();
  private readonly completions = new Map<string, TurnCompletion>();
  private readonly transportCleanups = new WeakMap<ChildProcessWithoutNullStreams, () => void>();
  private stderrTail = "";
  private readonly eventListeners = new Set<(event: HarnessEvent) => void>();

  constructor(config: {
    codexBin?: string;
    /** Exact process arguments. Defaults to the native `app-server` command. */
    args?: string[];
    cwd?: string;
    modelIds?: string[];
    requestTimeoutMs?: number;
    /** Codex's local data root holding native rollout JSONL files. */
    codexDir?: string;
  } = {}) {
    this.codexBin = config.codexBin || process.env.CODEX_BIN || "codex";
    this.processArgs = config.args || ["app-server"];
    this.cwd = config.cwd || process.cwd();
    this.modelIds = config.modelIds || ["o4-mini", "o3", "o3-mini", "gpt-4.1", "gpt-4o"];
    this.requestTimeoutMs = config.requestTimeoutMs || 30_000;
    this.rawTranscriptAdapter = new CodexAdapter({ codexBin: this.codexBin, codexDir: config.codexDir });
  }

  async init(): Promise<void> {
    await this.ensureReady();
  }

  isReady(): boolean { return this.initialized && !!this.child && !this.child.killed; }

  subscribeEvents(handler: (event: HarnessEvent) => void): () => void {
    this.eventListeners.add(handler);
    if (this.isReady()) queueMicrotask(() => handler({ kind: "process.connected", harness: "codex", data: { transport: "app-server" } }));
    return () => { this.eventListeners.delete(handler); };
  }

  async dispose(): Promise<void> {
    const child = this.child;
    if (child) {
      this.handleTransportDisconnect(child, new Error("Codex app-server disposed"), { reason: "disposed" });
      child.kill();
    } else {
      this.rejectPending(new Error("Codex app-server disposed"));
      this.failCompletions(new Error("Codex app-server disposed"));
      this.activeTurns.clear();
      this.initialized = false;
    }
  }

  async listSessions(): Promise<AgentSession[]> {
    if (!this.isReady()) return this.rawTranscriptAdapter.listSessions();
    await this.ensureReady();
    const result = await this.request("thread/list", { limit: 200, archived: false }) as {
      data?: CodexThread[];
    };
    const sessions = (result.data || []).filter((thread) => typeof thread.id === "string");
    for (const thread of sessions) this.threads.set(thread.id, thread);
    const nativeMetadata = await this.rawTranscriptAdapter.getNativeSessionMetadata();
    return sessions.map((thread) => {
      const session = this.toSession(thread);
      const nativeMeta = nativeMetadata.get(thread.id);
      return nativeMeta ? {
        ...session,
        status: nativeMeta.status === "running" ? "running" : session.status,
        meta: { ...session.meta, ...nativeMeta },
      } : session;
    });
  }

  async findNamedSessions(name: string, cwd: string): Promise<AgentSession[]> {
    await this.ensureReady();
    const result = await this.request("thread/list", { limit: 200, archived: false }) as { data?: CodexThread[] };
    return (result.data || [])
      .filter((thread) => typeof thread.id === "string" && thread.name === name && thread.cwd === cwd)
      .map((thread) => {
        this.threads.set(thread.id, thread);
        return this.toSession(thread);
      });
  }

  async getSession(id: string): Promise<AgentSession | null> {
    const cached = this.threads.get(id);
    let base = cached ? this.toSession(cached) : null;
    if (!base && this.isReady()) base = (await this.listSessions()).find((session) => session.id === id) || null;
    const raw = await this.rawTranscriptAdapter.getSession(id);
    if (!base) return raw;
    if (!raw) return base;
    return {
      ...base,
      status: raw.status === "running" ? "running" : base.status,
      model: base.model || raw.model,
      messageCount: raw.messageCount,
      durationSec: raw.durationSec,
      costUsd: raw.costUsd,
      lastMessage: raw.lastMessage || base.lastMessage,
      meta: { ...base.meta, ...raw.meta },
    };
  }

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    await this.ensureReady();
    const result = await this.request("thread/start", { cwd: options.cwd, ...(options.model ? { model: options.model } : {}) }) as { thread?: CodexThread };
    const thread = result.thread;
    if (!thread?.id) throw new Error("Codex thread/start did not return a thread id");
    await this.request("thread/name/set", { threadId: thread.id, name: options.name });
    thread.name = options.name;
    thread.cwd = thread.cwd || options.cwd;
    this.threads.set(thread.id, thread);
    this.emitEvent({ kind: "session.created", harness: "codex", sessionId: thread.id, status: "idle" });
    return this.toSession(thread);
  }

  /**
   * App-server threads and CLI rollouts share Codex's native session ID. Use
   * that persisted rollout as the raw archive source instead of synthesizing
   * display text from RPC events.
   */
  async getRawTranscript(id: string): Promise<RawTranscriptExport | null> {
    return this.rawTranscriptAdapter.getRawTranscript(id);
  }

  async sendMessage(id: string, options: SendMessageOptions): Promise<ControlResult> {
    await this.ensureReady();
    const session = await this.getSession(id);
    if (!session) return { ok: false, error: `Session ${id} not found` };
    const resumed = await this.resumeSession(id);
    if (!resumed.ok) return resumed;

    const completion = options.queue ? undefined : this.waitForCompletion(id);
    try {
      const result = await this.request("turn/start", {
        threadId: id,
        input: [{ type: "text", text: options.message }],
        model: session.model || null,
      }) as { turn?: { id?: string; status?: string } };
      const turnId = result.turn?.id;
      if (completion) {
        const pending = this.completions.get(id);
        if (pending) {
          pending.requestedTurnId = turnId;
          this.settleCompletion(id);
        }
      }
      if (turnId && result.turn?.status === "inProgress") this.activeTurns.set(id, turnId);
      if (!completion) return { ok: true };
      return await completion;
    } catch (error) {
      if (completion) this.clearCompletion(id);
      return { ok: false, error: (error as Error).message };
    }
  }

  async cancelTurn(id: string): Promise<ControlResult> {
    await this.ensureReady();
    const turnId = this.activeTurns.get(id);
    if (!turnId) return { ok: false, error: `No active Codex turn found for session ${id}` };
    try {
      await this.request("turn/interrupt", { threadId: id, turnId });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
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

  async resumeSession(id: string): Promise<ControlResult> {
    try {
      await this.ensureReady();
      const result = await this.request("thread/resume", { threadId: id }) as { thread?: CodexThread };
      if (!result.thread?.id) throw new Error("Codex thread/resume did not return a thread id");
      if (result.thread.id !== id) throw new Error(`Codex thread/resume returned a different thread id (${result.thread.id})`);
      this.threads.set(id, result.thread);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  async recover(id: string, message?: string): Promise<ControlResult> {
    const resumed = await this.resumeSession(id);
    if (!resumed.ok) {
      const forked = await this.forkSession(id, message);
      return forked.ok ? { ...forked, error: `Original session recovery failed; forked a child instead.` } : forked;
    }
    return message ? this.sendMessage(id, { message, queue: false }) : resumed;
  }

  async forkSession(id: string, message?: string): Promise<ControlResult> {
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
    try {
      await this.ensureReady();
      const result = await this.request("thread/resume", { threadId: sessionId, model }) as { thread?: CodexThread };
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
    return this.rawTranscriptAdapter.getSessionMessages(id, limit);
  }

  async getFirstUserMessage(id: string): Promise<SessionMessageView | null> {
    return this.rawTranscriptAdapter.getFirstUserMessage(id);
  }

  async listModels(): Promise<string[]> {
    return [...this.modelIds];
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
    if (this.initialized && this.child && !this.child.killed) return;
    if (!this.initialization) {
      this.initialization = this.initializeTransport().finally(() => {
        this.initialization = undefined;
      });
    }
    await this.initialization;
  }

  private async initializeTransport(): Promise<void> {
    if (!this.child || this.child.killed) this.startProcess();
    await this.request("initialize", {
      clientInfo: { name: "agent-herder", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
    this.initialized = true;
  }

  private startProcess(): void {
    const child = spawnIsolatedWorkload(this.codexBin, this.processArgs, {
      label: "codex-app-server",
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
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
      this.handleTransportDisconnect(child, new Error("Codex app-server exited"), { code: code ?? undefined, signal: signal ?? undefined });
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
    const interruptedSessions = [...this.activeTurns.keys()];
    this.activeTurns.clear();
    this.failCompletions(error);
    this.rejectPending(error);
    for (const sessionId of interruptedSessions) {
      this.emitEvent({
        kind: "turn.failed",
        harness: "codex",
        sessionId,
        nativeType: "process.disconnected",
        status: "error",
        data: { transport: "app-server", error: error.message },
      });
    }
    this.emitEvent({ kind: "process.disconnected", harness: "codex", data: { transport: "app-server", ...data } });
  }

  private notify(method: string, params: unknown): void {
    if (!this.child?.stdin.writable) throw new Error("Codex app-server stdin is not writable");
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private request(method: string, params: unknown, stage = method): Promise<unknown> {
    if (!this.child?.stdin.writable) return Promise.reject(new Error("Codex app-server is not connected"));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server timed out during ${stage}${this.stderrTail ? `; stderr: ${this.stderrTail}` : ""}`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
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
      if (message.error) pending.reject(new Error(message.error.message || `Codex RPC error ${message.error.code || "unknown"}`));
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
      this.emitEvent({ kind: "turn.started", harness: "codex", sessionId: threadId, nativeType: message.method, status: "running" });
      const turn = params.turn as { id?: string } | undefined;
      if (turn?.id) {
        this.activeTurns.set(threadId, turn.id);
        const completion = this.completions.get(threadId);
        if (completion) {
          completion.startedTurnId = turn.id;
          this.settleCompletion(threadId);
        }
      }
    }
    if (message.method === "item/agentMessage/delta" && threadId && typeof params.delta === "string") {
      const thread = this.threads.get(threadId);
      if (thread) thread.preview = params.delta;
      this.emitEvent({ kind: "message.updated", harness: "codex", sessionId: threadId, nativeType: message.method });
    }
    if (message.method === "turn/completed" && threadId) {
      this.activeTurns.delete(threadId);
      const completedTurn = params.turn as { status?: string } | undefined;
      this.emitEvent({ kind: completedTurn?.status === "failed" ? "turn.failed" : "turn.completed", harness: "codex", sessionId: threadId, nativeType: message.method, status: completedTurn?.status === "failed" ? "error" : "idle" });
      const completion = this.completions.get(threadId);
      if (completion) {
        const turn = params.turn as { id?: string; status?: string } | undefined;
        completion.completedTurnId = turn?.id;
        completion.completedStatus = turn?.status;
        this.settleCompletion(threadId);
      }
    }
    if (message.method === "error" && threadId) {
      this.emitEvent({ kind: "turn.failed", harness: "codex", sessionId: threadId, nativeType: message.method, status: "error" });
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
    return {
      id: thread.id,
      harness: "codex",
      status: this.mapStatus(thread.status, thread.id),
      title: thread.name || thread.preview || "Untitled session",
      cwd: thread.cwd || thread.path || this.cwd,
      lastActivity: threadTimestamp(thread.updatedAt) || threadTimestamp(thread.createdAt) || new Date(0).toISOString(),
      model: thread.model,
      needsPermission: false,
      lastMessage: thread.preview,
      meta: {
        nativeSessionId: thread.id,
        transport: "codex-app-server",
        activeTurnId: this.activeTurns.get(thread.id),
        modelProvider: thread.modelProvider,
      },
    };
  }

  private mapStatus(raw: string | undefined, id: string): AgentSession["status"] {
    if (this.activeTurns.has(id) || raw === "inProgress" || raw === "running" || raw === "active") return "running";
    if (raw === "failed" || raw === "error") return "error";
    if (raw === "interrupted" || raw === "completed" || raw === "idle") return "idle";
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
