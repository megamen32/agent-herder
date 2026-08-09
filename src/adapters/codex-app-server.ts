import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { CodexAdapter } from "./codex.js";
import type {
  AgentSession,
  ControlResult,
  CreateSessionOptions,
  HarnessAdapter,
  HarnessCapabilities,
  SendMessageOptions,
  SetPermissionsOptions,
  RawTranscriptExport,
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
  createdAt?: string;
  updatedAt?: string;
}

interface TurnCompletion {
  resolve: (result: ControlResult) => void;
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
  private child?: ChildProcessWithoutNullStreams;
  private initialized = false;
  private nextRequestId = 1;
  private inputBuffer = "";
  private readonly pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  private readonly threads = new Map<string, CodexThread>();
  private readonly activeTurns = new Map<string, string>();
  private readonly completions = new Map<string, TurnCompletion>();

  constructor(config: {
    codexBin?: string;
    /** Exact process arguments. Defaults to the native `app-server` command. */
    args?: string[];
    cwd?: string;
    modelIds?: string[];
    /** Codex's local data root holding native rollout JSONL files. */
    codexDir?: string;
  } = {}) {
    this.codexBin = config.codexBin || process.env.CODEX_BIN || "codex";
    this.processArgs = config.args || ["app-server"];
    this.cwd = config.cwd || process.cwd();
    this.modelIds = config.modelIds || ["o4-mini", "o3", "o3-mini", "gpt-4.1", "gpt-4o"];
    this.rawTranscriptAdapter = new CodexAdapter({ codexBin: this.codexBin, codexDir: config.codexDir });
  }

  async init(): Promise<void> {
    await this.ensureReady();
  }

  isReady(): boolean { return this.initialized && !!this.child && !this.child.killed; }

  async dispose(): Promise<void> {
    this.rejectPending(new Error("Codex app-server disposed"));
    this.initialized = false;
    this.child?.kill();
    this.child = undefined;
  }

  async listSessions(): Promise<AgentSession[]> {
    await this.ensureReady();
    const result = await this.request("thread/list", { limit: 200, archived: false }) as {
      data?: CodexThread[];
    };
    const sessions = (result.data || []).filter((thread) => typeof thread.id === "string");
    for (const thread of sessions) this.threads.set(thread.id, thread);
    return sessions.map((thread) => this.toSession(thread));
  }

  async getSession(id: string): Promise<AgentSession | null> {
    const cached = this.threads.get(id);
    if (cached) return this.toSession(cached);
    return (await this.listSessions()).find((session) => session.id === id) || null;
  }

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    await this.ensureReady();
    const result = await this.request("thread/start", { cwd: options.cwd }) as { thread?: CodexThread };
    const thread = result.thread;
    if (!thread?.id) throw new Error("Codex thread/start did not return a thread id");
    await this.request("thread/name/set", { threadId: thread.id, name: options.name });
    thread.name = options.name;
    thread.cwd = thread.cwd || options.cwd;
    this.threads.set(thread.id, thread);
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
      if (result.thread?.id) this.threads.set(result.thread.id, result.thread);
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
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
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
    this.startProcess();
    await this.request("initialize", {
      clientInfo: { name: "agent-herder", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
    this.initialized = true;
  }

  private startProcess(): void {
    this.child = spawn(this.codexBin, this.processArgs, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consumeOutput(chunk));
    this.child.stderr.resume();
    this.child.on("error", (error) => {
      this.initialized = false;
      this.child = undefined;
      this.rejectPending(error);
    });
    this.child.on("exit", () => {
      this.initialized = false;
      this.child = undefined;
      this.rejectPending(new Error("Codex app-server exited"));
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.child?.stdin.writable) throw new Error("Codex app-server stdin is not writable");
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.child?.stdin.writable) return Promise.reject(new Error("Codex app-server is not connected"));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  private consumeOutput(chunk: string): void {
    this.inputBuffer += chunk;
    const lines = this.inputBuffer.split("\n");
    this.inputBuffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.consumeMessage(JSON.parse(line) as RpcResponse & { method?: string; params?: Record<string, unknown> });
      } catch {
        // Ignore non-JSON diagnostic output on stdout from an incompatible wrapper.
      }
    }
  }

  private consumeMessage(message: RpcResponse & { method?: string; params?: Record<string, unknown> }): void {
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || `Codex RPC error ${message.error.code || "unknown"}`));
      else pending.resolve(message.result);
      return;
    }
    if (!message.method || !message.params) return;
    const params = message.params;
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (threadId && typeof params.thread === "object" && params.thread) {
      this.threads.set(threadId, params.thread as CodexThread);
    }
    if (message.method === "turn/started" && threadId) {
      const turn = params.turn as { id?: string } | undefined;
      if (turn?.id) this.activeTurns.set(threadId, turn.id);
    }
    if (message.method === "item/agentMessage/delta" && threadId && typeof params.delta === "string") {
      const thread = this.threads.get(threadId);
      if (thread) thread.preview = params.delta;
    }
    if (message.method === "turn/completed" && threadId) {
      this.activeTurns.delete(threadId);
      const completion = this.completions.get(threadId);
      if (completion) {
        clearTimeout(completion.timer);
        this.completions.delete(threadId);
        const turn = params.turn as { status?: string } | undefined;
        completion.resolve(turn?.status === "failed"
          ? { ok: false, error: "Codex turn failed" }
          : { ok: true });
      }
    }
    if (message.method === "error" && threadId) {
      const completion = this.completions.get(threadId);
      if (completion) {
        clearTimeout(completion.timer);
        this.completions.delete(threadId);
        completion.resolve({ ok: false, error: "Codex turn reported an error" });
      }
    }
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

  private clearCompletion(threadId: string): void {
    const completion = this.completions.get(threadId);
    if (!completion) return;
    clearTimeout(completion.timer);
    this.completions.delete(threadId);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private toSession(thread: CodexThread): AgentSession {
    return {
      id: thread.id,
      harness: "codex",
      status: this.mapStatus(thread.status, thread.id),
      title: thread.name || thread.preview || "Untitled session",
      cwd: thread.cwd || thread.path || this.cwd,
      lastActivity: thread.updatedAt || thread.createdAt || new Date(0).toISOString(),
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
    if (this.activeTurns.has(id) || raw === "inProgress" || raw === "running") return "running";
    if (raw === "failed" || raw === "error") return "error";
    if (raw === "interrupted" || raw === "completed" || raw === "idle") return "idle";
    return "idle";
  }
}
