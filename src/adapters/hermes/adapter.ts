import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import type {
  AgentSession,
  ControlResult,
  HarnessAdapter,
  HarnessCapabilities,
  ListSessionsOptions,
  RawTranscriptExport,
  SendMessageOptions,
  SessionMessageView,
  SetPermissionsOptions,
} from "../../types/index.js";

type JsonObject = Record<string, unknown>;

/** The public tool surface of `hermes mcp serve`. Kept injectable for tests. */
export interface HermesToolClient {
  callTool(name: string, args?: JsonObject): Promise<unknown>;
  close?(): Promise<void> | void;
}

export interface HermesAdapterConfig {
  hermesBin?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Provider used by health/remediation jobs launched through the CLI. */
  jobProvider?: string;
  /** Reasoning effort used by health/remediation jobs launched through the CLI. */
  jobReasoning?: string;
  /** Explicitly bounded toolsets for non-interactive jobs. */
  jobToolsets?: string;
  /** Hard wall-clock limit for one non-interactive health job. */
  jobTimeoutMs?: number;
  /** Injectable child spawner for adapter-level tests. */
  spawnJob?: HermesJobSpawner;
  /** Supply a public-surface client without starting a Hermes child process. */
  client?: HermesToolClient;
  /** Upper bound for observation-only MCP bridge calls. */
  observationTimeoutMs?: number;
}

export type HermesJobSpawner = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

interface Conversation {
  session_key?: string;
  session_id?: string;
  platform?: string;
  chat_type?: string;
  display_name?: string;
  chat_name?: string;
  user_name?: string;
  updated_at?: string;
  created_at?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  chat_id?: string;
  thread_id?: string;
}

interface HermesMessage {
  id?: string;
  role?: "user" | "assistant";
  content?: string;
  timestamp?: string | number;
}

interface HermesJob {
  id: string;
  title: string;
  cwd: string;
  model: string;
  execution: HermesExecutionProfile;
  timeoutMs: number;
  status: "idle" | "running" | "stopped" | "error";
  createdAt: string;
  lastActivity: string;
  messages: SessionMessageView[];
  stdout: string;
  stderr: string;
  nativeSessionId?: string;
  child?: ChildProcessWithoutNullStreams;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  timedOut?: boolean;
  terminationReason?: "timeout" | "cancelled" | "spawn-error";
  lastProgress?: string;
  finished: boolean;
}

const MAX_JOB_OUTPUT = 256 * 1024;
const MAX_PROGRESS_MESSAGES = 128;
const MAX_PROGRESS_TEXT = 2_000;
const MCP_OBSERVATION_TIMEOUT_MS = 2_500;
const DEFAULT_JOB_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_JOB_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface HermesExecutionProfile extends Record<string, string> {
  provider: string;
  reasoning: string;
  toolsets: string;
}

function resultJson(value: unknown): JsonObject {
  if (typeof value === "string") {
    try { return JSON.parse(value) as JsonObject; } catch { return { error: value }; }
  }
  if (value && typeof value === "object") return value as JsonObject;
  return {};
}

function iso(value: unknown): string {
  if (typeof value === "number") return new Date(value * 1000).toISOString();
  if (typeof value === "string" && value) return value;
  return new Date(0).toISOString();
}

function errorResult(message: string): ControlResult { return { ok: false, error: message }; }

/**
 * Hermes adapter with two deliberately separate transports: the public
 * `hermes mcp serve` bridge remains observation-only, while health remediation
 * uses a bounded local CLI job. The two paths must not be conflated.
 */
export class HermesAdapter implements HarnessAdapter {
  // Hermes is intentionally not added to session-convert's narrower legacy
  // HarnessType union; the central converter does not support Hermes.
  readonly type = "hermes";
  readonly name = "Hermes gateway";
  readonly lazyStart = true;
  readonly controlCapabilities: HarnessCapabilities = {
    cancelTurn: true,
    detach: true,
    resume: false,
    terminate: true,
    recover: false,
    fork: false,
    modelSwitch: true,
    subagents: false,
    events: true,
  };

  private readonly config: HermesAdapterConfig;
  private client?: HermesToolClient;
  private ownedClient = false;
  private readonly jobs = new Map<string, HermesJob>();
  private readonly spawnJob: HermesJobSpawner;
  private readonly jobTimeoutMs: number;
  private readonly observationTimeoutMs: number;

  constructor(config: HermesAdapterConfig = {}) {
    this.config = config;
    this.client = config.client;
    this.spawnJob = config.spawnJob || ((command, args, options) => (
      spawn(command, args, options) as ChildProcessWithoutNullStreams
    ));
    this.jobTimeoutMs = normalizeJobTimeout(config.jobTimeoutMs ?? envNumber("HERMES_HEALTH_TIMEOUT_MS") ?? DEFAULT_JOB_TIMEOUT_MS);
    this.observationTimeoutMs = normalizeObservationTimeout(config.observationTimeoutMs ?? MCP_OBSERVATION_TIMEOUT_MS);
  }

  isReady(): boolean { return Boolean(this.client) || this.jobs.size > 0; }

  getExecutionProfile(): HermesExecutionProfile {
    return {
      provider: this.config.jobProvider || process.env.HERMES_HEALTH_PROVIDER || "openai-codex",
      reasoning: this.config.jobReasoning || process.env.HERMES_HEALTH_REASONING || "high",
      toolsets: this.config.jobToolsets || process.env.HERMES_HEALTH_TOOLSETS || "terminal",
    };
  }

  async init(): Promise<void> {
    if (this.client) return;
    const child = spawn(this.config.hermesBin || process.env.HERMES_BIN || "hermes", this.config.args || ["mcp", "serve"], {
      cwd: this.config.cwd || process.cwd(),
      env: { ...process.env, ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.client = new StdioHermesToolClient(child);
    this.ownedClient = true;
    await this.client.callTool("conversations_list", { limit: 1 });
  }

  async dispose(): Promise<void> {
    await this.disposeObservationClient();
    for (const job of this.jobs.values()) this.stopJob(job);
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<AgentSession[]> {
    const local = [...this.jobs.values()]
      .filter((job) => !options.cwd || job.cwd === options.cwd)
      .map((job) => this.jobToSession(job));
    try {
      const data = await this.observe(() => this.init().then(() => this.client!.callTool("conversations_list", { limit: 200 })).then(resultJson));
      const rows = Array.isArray(data.conversations) ? data.conversations as Conversation[] : [];
      return [...local, ...rows.filter((row) => row.session_key).map((row) => this.toSession(row))];
    } catch {
      // A health job must not depend on the optional observation-only MCP bridge.
      await this.disposeObservationClient();
      return local;
    }
  }

  private async disposeObservationClient(): Promise<void> {
    if (this.ownedClient) await this.client?.close?.();
    this.client = undefined;
    this.ownedClient = false;
  }

  async getSession(id: string): Promise<AgentSession | null> {
    const job = this.jobs.get(id);
    if (job) return this.jobToSession(job);
    try {
      const data = await this.observe(() => this.init().then(() => this.client!.callTool("conversation_get", { session_key: id })).then(resultJson));
      return data.error ? null : this.toSession(data as Conversation, id);
    } catch {
      await this.disposeObservationClient();
      return null;
    }
  }

  async getSessionMessages(id: string, limit = 200): Promise<SessionMessageView[] | null> {
    const job = this.jobs.get(id);
    if (job) return job.messages.slice(Math.max(0, job.messages.length - Math.max(1, limit)));
    try {
      const data = await this.observe(() => this.init().then(() => this.client!.callTool("messages_read", { session_key: id, limit })).then(resultJson));
      if (data.error) return null;
      const messages = Array.isArray(data.messages) ? data.messages as HermesMessage[] : [];
      return messages.map((message, index) => ({
        id: String(message.id || `${id}:${index}`),
        role: message.role || "system",
        timestamp: message.timestamp == null ? undefined : iso(message.timestamp),
        text: message.content || "",
        parts: [{ type: "text", text: message.content || "" }],
      }));
    } catch {
      await this.disposeObservationClient();
      return null;
    }
  }

  private async observe<T>(request: () => Promise<T>): Promise<T> {
    return withTimeout(request(), this.observationTimeoutMs);
  }

  async getTranscript(id: string): Promise<string | null> {
    const messages = await this.getSessionMessages(id);
    return messages ? messages.map((message) => `${message.role}: ${message.text || ""}`).join("\n") : null;
  }

  async getRawTranscript(id: string): Promise<RawTranscriptExport | null> {
    const messages = await this.getSessionMessages(id);
    if (!messages) return null;
    const job = this.jobs.get(id);
    if (job) {
      const trace = {
        schema: "agent-herder.hermes-cli-trace.v1",
        session_id: job.id,
        native_session_id: job.nativeSessionId,
        status: job.status,
        execution: job.execution,
        timeout_ms: job.timeoutMs,
        timed_out: job.timedOut === true,
        termination_reason: job.terminationReason,
        stdout: redactSensitive(job.stdout),
        stderr: redactSensitive(job.stderr),
      };
      return {
        bytes: new TextEncoder().encode(`${JSON.stringify(trace)}\n`),
        complete: job.status !== "running",
        source: { kind: "observed-cli-output", location: `hermes:cli:${job.nativeSessionId || job.id}`, format: "json" },
        timestampCoverage: "partial",
        limitations: ["The archive preserves bounded Hermes CLI stdout/stderr and rendered progress; it is not a native Hermes event export."],
      };
    }
    return {
      bytes: new TextEncoder().encode(`${JSON.stringify(messages)}\n`),
      complete: false,
      source: { kind: "observed-gateway-messages", location: `hermes:mcp:messages_read:${id}`, format: "json" },
      timestampCoverage: messages.every((message) => !!message.timestamp) ? "partial" : "none",
      limitations: ["Hermes public MCP bridge exposes rendered user/assistant messages only; tool records and native export are unavailable."],
    };
  }

  async sendMessage(id: string, options: SendMessageOptions): Promise<{ ok: boolean; error?: string }> {
    const job = this.jobs.get(id);
    if (job) return this.sendJob(job, options);
    await this.init();
    const session = await this.getSession(id);
    if (!session) return { ok: false, error: `Hermes conversation '${id}' not found` };
    const origin = (session.meta?.origin || {}) as JsonObject;
    const platform = String(session.meta?.platform || origin.platform || "");
    const chatId = String(session.meta?.chatId || origin.chat_id || "");
    if (!platform || !chatId) return { ok: false, error: "Hermes conversation has no public messaging target" };
    if (options.queue || options.steer) {
      return { ok: false, error: "Hermes MCP messages_send has no queue or steer control" };
    }
    const data = resultJson(await this.client!.callTool("messages_send", { target: `${platform}:${chatId}`, message: options.message }));
    return data.error ? { ok: false, error: String(data.error) } : { ok: true };
  }

  async createSession(options: { name: string; cwd: string }): Promise<AgentSession> {
    const existing = [...this.jobs.values()].find((job) => job.title === options.name && job.cwd === options.cwd);
    if (existing) throw new Error(`Named Hermes job '${options.name}' already exists for ${options.cwd}`);
    const now = new Date().toISOString();
    const job: HermesJob = {
      id: `hermes-job-${randomUUID()}`,
      title: options.name,
      cwd: options.cwd,
      model: process.env.HERMES_HEALTH_MODEL || "gpt-5.6-luna",
      execution: this.getExecutionProfile(),
      timeoutMs: this.jobTimeoutMs,
      status: "idle",
      createdAt: now,
      lastActivity: now,
      messages: [],
      stdout: "",
      stderr: "",
      finished: false,
    };
    this.jobs.set(job.id, job);
    return this.jobToSession(job);
  }

  async changeModel(id: string, model: string): Promise<{ ok: boolean; error?: string }> {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, error: "Hermes public MCP surface does not expose model switching" };
    if (job.status === "running") return { ok: false, error: "Hermes job is already running" };
    const normalized = model.trim();
    if (!normalized || normalized.length > 128) return { ok: false, error: "model must be a bounded non-empty string" };
    job.model = normalized.includes("/") ? normalized.slice(normalized.lastIndexOf("/") + 1) : normalized;
    job.lastActivity = new Date().toISOString();
    return { ok: true };
  }

  async stopSession(id: string): Promise<ControlResult> {
    const job = this.jobs.get(id);
    return job ? this.stopJob(job) : errorResult("Hermes public MCP surface does not expose stop/cancel");
  }
  async cancelTurn(id: string): Promise<ControlResult> {
    const job = this.jobs.get(id);
    return job ? this.stopJob(job) : errorResult("Hermes public MCP surface does not expose in-turn cancel");
  }
  async terminate(id: string): Promise<ControlResult> {
    const job = this.jobs.get(id);
    return job ? this.stopJob(job) : errorResult("Hermes public MCP surface does not expose session termination");
  }
  async recover(_id: string): Promise<ControlResult> { return errorResult("Hermes public MCP surface does not expose session recovery"); }
  async forkSession(_id: string): Promise<ControlResult> { return errorResult("Hermes public MCP surface does not expose session fork"); }
  async resumeSession(_id: string): Promise<ControlResult> { return errorResult("Hermes public MCP surface does not expose session resume"); }
  async detach(id: string): Promise<ControlResult> {
    if (this.jobs.has(id)) return errorResult("Hermes CLI jobs cannot be detached while preserving their process");
    await this.dispose();
    return { ok: true };
  }

  async respondPermission(_sessionId: string, _permissionId: string, _response: "allow" | "deny"): Promise<ControlResult> {
    return errorResult("Hermes MCP approval bridge is observation-only for this adapter");
  }
  async setPermissions(_sessionId: string, _options: SetPermissionsOptions): Promise<ControlResult> {
    return errorResult("Hermes permissions are not exposed by the public MCP bridge");
  }

  private sendJob(job: HermesJob, options: SendMessageOptions): { ok: boolean; error?: string } {
    if (options.steer) return { ok: false, error: "Hermes CLI jobs do not support steering" };
    if (job.status === "running") return { ok: false, error: "Hermes job is already running" };
    const message = options.message.trim();
    if (!message) return { ok: false, error: "message must be a non-empty string" };
    const now = new Date().toISOString();
    job.status = "running";
    job.finished = false;
    job.stdout = "";
    job.stderr = "";
    job.timedOut = false;
    job.terminationReason = undefined;
    job.lastProgress = undefined;
    job.lastActivity = now;
    job.messages.push({
      id: `${job.id}:user:${job.messages.length + 1}`,
      role: "user",
      timestamp: now,
      text: message,
      parts: [{ type: "text", text: message }],
    });
    const command = this.config.hermesBin || process.env.HERMES_BIN || "hermes";
    const args = [
      // Keep tool/output progress visible to the supervisor. `-Q` suppresses
      // exactly the previews needed to distinguish useful work from a live
      // but idle process.
      "chat", "-q", message,
      "--model", job.model,
      "--provider", job.execution.provider,
      "--reasoning", job.execution.reasoning,
      "--toolsets", job.execution.toolsets,
      "--source", "agent-herder-health",
    ];
    try {
      const child = this.spawnJob(command, args, {
        cwd: job.cwd,
        env: {
          ...process.env,
          ...this.config.env,
          HERMES_YOLO_MODE: "1",
          HERMES_ACCEPT_HOOKS: "1",
          HERMES_SESSION_SOURCE: "agent-herder-health",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      job.child = child;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        this.appendJobOutput(job, "stdout", chunk);
      });
      child.stderr.on("data", (chunk: string) => {
        // Hermes may print its session receipt and progress on stderr. Keep
        // the raw stream bounded and expose only redacted progress previews.
        this.appendJobOutput(job, "stderr", chunk);
      });
      child.once("error", () => this.finishJob(job, null, "spawn-error"));
      child.once("exit", (code) => this.finishJob(job, code));
      job.timeoutTimer = setTimeout(() => this.timeoutJob(job), job.timeoutMs);
      job.timeoutTimer.unref?.();
      return { ok: true };
    } catch {
      this.finishJob(job, null, "spawn-error");
      return { ok: false, error: "Hermes CLI job could not be started" };
    }
  }

  private appendJobOutput(job: HermesJob, stream: "stdout" | "stderr", chunk: string): void {
    if (stream === "stdout") job.stdout = boundedAppend(job.stdout, chunk);
    else job.stderr = boundedAppend(job.stderr, chunk);
    job.lastActivity = new Date().toISOString();
    if (job.messages.filter((message) => message.id.includes(":progress:")).length >= MAX_PROGRESS_MESSAGES) return;
    const lines = stripAnsi(chunk).split(/[\r\n]+/).map((line) => redactSensitive(line).trim()).filter(Boolean);
    for (const line of lines) {
      if (/^\s*(?:session_id|session(?:\s+id)?)\s*[:=]\s*/i.test(line)) continue;
      const text = `${stream}: ${line}`.slice(0, MAX_PROGRESS_TEXT);
      if (!text || text === job.lastProgress) continue;
      job.lastProgress = text;
      job.messages.push({
        id: `${job.id}:progress:${job.messages.length + 1}`,
        role: "assistant",
        timestamp: job.lastActivity,
        text,
        parts: [{ type: "text", text }],
      });
      if (job.messages.filter((message) => message.id.includes(":progress:")).length >= MAX_PROGRESS_MESSAGES) break;
    }
  }

  private timeoutJob(job: HermesJob): void {
    if (job.finished || job.status !== "running" || !job.child) return;
    const child = job.child;
    job.timedOut = true;
    job.terminationReason = "timeout";
    try { child.kill("SIGTERM"); } catch { /* already exited */ }
    this.finishJob(job, null, "timeout");
    const forceKillTimer = setTimeout(() => {
      if (child.exitCode === null) {
        try { child.kill("SIGKILL"); } catch { /* already exited */ }
      }
    }, 5_000);
    forceKillTimer.unref?.();
  }

  private finishJob(job: HermesJob, code: number | null, reason?: "timeout" | "cancelled" | "spawn-error"): void {
    if (job.finished) return;
    job.finished = true;
    if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
    job.timeoutTimer = undefined;
    if (reason) job.terminationReason = reason;
    job.child = undefined;
    job.status = code === 0 && !reason ? "stopped" : "error";
    job.lastActivity = new Date().toISOString();
    const native = extractNativeSessionId(`${job.stdout}\n${job.stderr}`);
    if (native) job.nativeSessionId = native.slice(0, 128);
    const output = redactSensitive(stripSessionReceipt(job.stdout)).trim();
    if (output || code !== 0) {
      const text = output || (reason === "timeout"
        ? "Hermes CLI job exceeded its bounded timeout and was terminated."
        : "Hermes CLI job failed before producing a final response.");
      job.messages.push({
        id: `${job.id}:assistant:${job.messages.length + 1}`,
        role: "assistant",
        timestamp: job.lastActivity,
        text,
        parts: [{ type: "text", text }],
      });
    }
  }

  private stopJob(job: HermesJob): ControlResult {
    if (job.child && job.status === "running") {
      const child = job.child;
      try { job.child.kill("SIGTERM"); } catch { /* already exited */ }
      if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
      job.timeoutTimer = undefined;
      job.terminationReason = "cancelled";
      job.finished = true;
      job.child = undefined;
      job.status = "stopped";
      job.lastActivity = new Date().toISOString();
      void child;
    }
    return { ok: true, sessionId: job.id };
  }

  private jobToSession(job: HermesJob): AgentSession {
    const last = [...job.messages].reverse().find((message) => message.role !== "tool");
    return {
      id: job.id,
      harness: "hermes",
      status: job.status,
      title: job.title,
      cwd: job.cwd,
      lastActivity: job.lastActivity,
      model: job.model,
      needsPermission: false,
      messageCount: job.messages.length,
      lastMessage: last?.text,
      meta: {
        transport: "hermes-cli-job",
        createdAt: job.createdAt,
        nativeSessionId: job.nativeSessionId,
        execution: job.execution,
        timeoutMs: job.timeoutMs,
        timedOut: job.timedOut === true,
        terminationReason: job.terminationReason,
        progressSource: "hermes-cli-output",
      },
    };
  }

  private toSession(row: Conversation, fallbackId?: string): AgentSession {
    const id = String(row.session_key || fallbackId || "");
    const origin = { platform: row.platform, chat_id: row.chat_id, thread_id: row.thread_id, chat_type: row.chat_type };
    return {
      id,
      harness: "hermes",
      status: "idle",
      title: row.display_name || row.chat_name || id,
      cwd: this.config.cwd || process.cwd(),
      lastActivity: iso(row.updated_at),
      needsPermission: false,
      messageCount: undefined,
      meta: {
        transport: "hermes-mcp",
        sessionId: row.session_id,
        sessionKey: id,
        platform: row.platform,
        chatId: row.chat_id,
        origin,
        lineage: { kind: "unknown", reason: "Hermes MCP does not expose session parent/child lineage" },
        history: { source: "live-cache", complete: false, warning: "Public Hermes MCP exposes rendered messages, not native session export" },
      },
    };
  }
}

function boundedAppend(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= MAX_JOB_OUTPUT ? next : next.slice(next.length - MAX_JOB_OUTPUT);
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function normalizeJobTimeout(value: number): number {
  if (!Number.isFinite(value) || value < 1_000 || value > MAX_JOB_TIMEOUT_MS) {
    throw new Error(`Hermes health job timeout must be between 1000 and ${MAX_JOB_TIMEOUT_MS} ms`);
  }
  return Math.floor(value);
}

function normalizeObservationTimeout(value: number): number {
  if (!Number.isFinite(value) || value < 10 || value > 60_000) {
    throw new Error("Hermes observation timeout must be between 10 and 60000 ms");
  }
  return Math.floor(value);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "");
}

function redactSensitive(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|credential)\s*[:=]\s*([^\s,;]+)/gi, "$1=[redacted]")
    .replace(/([?&](?:token|key|secret|password|signature)=)[^&\s]+/gi, "$1[redacted]");
}

function extractNativeSessionId(value: string): string | undefined {
  const patterns = [
    /(?:^|\n)\s*session_id\s*[:=]\s*([^\s\n]+)/i,
    /(?:^|\n)\s*session(?:\s+id)?\s*:\s*([^\s\n]+)/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern)?.[1];
    if (match) return match;
  }
  return undefined;
}

function stripSessionReceipt(value: string): string {
  return value
    .replace(/^\s*session_id\s*[:=]\s*[^\n]+\n?/gim, "")
    .replace(/^\s*session(?:\s+id)?\s*:\s*[^\n]+\n?/gim, "");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Hermes observation MCP timed out")), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

class StdioHermesToolClient implements HermesToolClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  private buffer = "";
  private initialized?: Promise<void>;
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.once("error", (error) => this.failPending(error));
    child.once("exit", (code, signal) => this.failPending(new Error(`Hermes MCP process exited (${code ?? "null"}, ${signal ?? "none"})`)));
  }
  async callTool(name: string, args: JsonObject = {}): Promise<unknown> {
    await this.ensureInitialized();
    return this.unwrap(await this.request("tools/call", { name, arguments: args }));
  }
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "agent-herder", version: "0.1.0" },
      }).then(async () => {
        this.notify("notifications/initialized", {});
      });
    }
    await this.initialized;
  }
  private request(method: string, params: JsonObject): Promise<unknown> {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  private notify(method: string, params: JsonObject): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }
  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  async close(): Promise<void> { this.child.kill(); }
  private consume(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as { id?: number; result?: unknown };
        if (typeof message.id === "number") {
          const pending = this.pending.get(message.id);
          if (pending) {
            const error = (message as { error?: { message?: string } }).error;
            error ? pending.reject(new Error(error.message || "Hermes MCP request failed")) : pending.resolve(this.unwrap(message.result));
          }
        }
        this.pending.delete(message.id as number);
      } catch { /* Ignore non-JSON diagnostics on stdout; tool errors are returned by MCP. */ }
    }
  }
  private unwrap(result: unknown): unknown {
    const content = (result as JsonObject | undefined)?.content;
    if (Array.isArray(content)) {
      const text = content.find((part) => (part as JsonObject)?.type === "text") as JsonObject | undefined;
      return text?.text ?? result;
    }
    return result;
  }
}
