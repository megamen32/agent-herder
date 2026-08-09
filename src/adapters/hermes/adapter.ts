import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
  /** Supply a public-surface client without starting a Hermes child process. */
  client?: HermesToolClient;
}

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
 * Hermes adapter backed only by the supported `hermes mcp serve` bridge.
 * The bridge exposes gateway conversations and messages, not native session
 * controls or raw transcript export; those limitations are retained in the
 * returned metadata instead of being inferred from Hermes internals.
 */
export class HermesAdapter implements HarnessAdapter {
  // Hermes is intentionally not added to session-convert's narrower legacy
  // HarnessType union; the central converter does not support Hermes.
  readonly type = "hermes";
  readonly name = "Hermes gateway";
  readonly lazyStart = true;
  readonly controlCapabilities: HarnessCapabilities = {
    cancelTurn: false,
    detach: true,
    resume: false,
    terminate: false,
    recover: false,
    fork: false,
    modelSwitch: false,
    subagents: false,
    events: true,
  };

  private readonly config: HermesAdapterConfig;
  private client?: HermesToolClient;
  private ownedClient = false;

  constructor(config: HermesAdapterConfig = {}) { this.config = config; this.client = config.client; }

  isReady(): boolean { return Boolean(this.client); }

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
    if (this.ownedClient) await this.client?.close?.();
    this.client = undefined;
    this.ownedClient = false;
  }

  async listSessions(_options: ListSessionsOptions = {}): Promise<AgentSession[]> {
    await this.init();
    const args: JsonObject = { limit: 200 };
    const data = resultJson(await this.client!.callTool("conversations_list", args));
    const rows = Array.isArray(data.conversations) ? data.conversations as Conversation[] : [];
    return rows.filter((row) => row.session_key).map((row) => this.toSession(row));
  }

  async getSession(id: string): Promise<AgentSession | null> {
    await this.init();
    const data = resultJson(await this.client!.callTool("conversation_get", { session_key: id }));
    return data.error ? null : this.toSession(data as Conversation, id);
  }

  async getSessionMessages(id: string, limit = 200): Promise<SessionMessageView[] | null> {
    await this.init();
    const data = resultJson(await this.client!.callTool("messages_read", { session_key: id, limit }));
    if (data.error) return null;
    const messages = Array.isArray(data.messages) ? data.messages as HermesMessage[] : [];
    return messages.map((message, index) => ({
      id: String(message.id || `${id}:${index}`),
      role: message.role || "system",
      timestamp: message.timestamp == null ? undefined : iso(message.timestamp),
      text: message.content || "",
      parts: [{ type: "text", text: message.content || "" }],
    }));
  }

  async getTranscript(id: string): Promise<string | null> {
    const messages = await this.getSessionMessages(id);
    return messages ? messages.map((message) => `${message.role}: ${message.text || ""}`).join("\n") : null;
  }

  async getRawTranscript(id: string): Promise<RawTranscriptExport | null> {
    const messages = await this.getSessionMessages(id);
    if (!messages) return null;
    return {
      bytes: new TextEncoder().encode(`${JSON.stringify(messages)}\n`),
      complete: false,
      source: { kind: "observed-gateway-messages", location: `hermes:mcp:messages_read:${id}`, format: "json" },
      timestampCoverage: messages.every((message) => !!message.timestamp) ? "partial" : "none",
      limitations: ["Hermes public MCP bridge exposes rendered user/assistant messages only; tool records and native export are unavailable."],
    };
  }

  async sendMessage(id: string, options: SendMessageOptions): Promise<{ ok: boolean; error?: string }> {
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

  async stopSession(_id: string): Promise<ControlResult> { return errorResult("Hermes public MCP surface does not expose stop/cancel"); }
  async cancelTurn(_id: string): Promise<ControlResult> { return errorResult("Hermes public MCP surface does not expose in-turn cancel"); }
  async terminate(_id: string): Promise<ControlResult> { return errorResult("Hermes public MCP surface does not expose session termination"); }
  async recover(_id: string): Promise<ControlResult> { return errorResult("Hermes public MCP surface does not expose session recovery"); }
  async forkSession(_id: string): Promise<ControlResult> { return errorResult("Hermes public MCP surface does not expose session fork"); }
  async resumeSession(_id: string): Promise<ControlResult> { return errorResult("Hermes public MCP surface does not expose session resume"); }
  async detach(_id: string): Promise<ControlResult> { await this.dispose(); return { ok: true }; }

  async respondPermission(_sessionId: string, _permissionId: string, _response: "allow" | "deny"): Promise<ControlResult> {
    return errorResult("Hermes MCP approval bridge is observation-only for this adapter");
  }
  async setPermissions(_sessionId: string, _options: SetPermissionsOptions): Promise<ControlResult> {
    return errorResult("Hermes permissions are not exposed by the public MCP bridge");
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
