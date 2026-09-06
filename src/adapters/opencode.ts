import { HarnessAdapter, AgentSession, ControlResult, CreateSessionOptions, HarnessCapabilities, HarnessEvent, ListSessionsOptions, RawTranscriptExport, SendMessageOptions, SetPermissionsOptions, SessionMessagePart, SessionMessageView } from "../types/index.js";
import { readFileSync } from "node:fs";
import { throwIfAborted } from "../abort-utils.js";

interface OpenCodeSessionPayload {
  id: string;
  title?: string;
  path?: string;
  directory?: string;
  createdAt?: string;
  updatedAt?: string;
  time?: { created?: number; updated?: number };
  model?: string | { providerID?: string; id?: string };
  costUsd?: number;
  cost?: number;
  parentID?: string;
}

interface OpenCodeMessagePayload {
  id?: string;
  role?: string;
  info?: { id?: string; role?: string; time?: { created?: number } };
  content?: string | Array<Record<string, unknown>>;
  parts?: Array<Record<string, unknown>>;
}

function normalizeOpenCodeEvent(raw: unknown): HarnessEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const event = raw as Record<string, unknown>;
  const nativeType = typeof event.type === "string" ? event.type : typeof event.event === "string" ? event.event : "";
  const properties = event.properties && typeof event.properties === "object" ? event.properties as Record<string, unknown> : event;
  const info = properties.info && typeof properties.info === "object" ? properties.info as Record<string, unknown> : undefined;
  const session = properties.session && typeof properties.session === "object" ? properties.session as Record<string, unknown> : undefined;
  const sessionId = stringValue(properties.sessionID, properties.sessionId, properties.session_id, info?.sessionID, info?.sessionId, session?.id);
  const messageId = stringValue(properties.messageID, properties.messageId, info?.id);
  const permissionId = stringValue(properties.permissionID, properties.permissionId, properties.id);
  let kind: HarnessEvent["kind"] | undefined;
  if (/session\.(created|added)/i.test(nativeType)) kind = "session.created";
  else if (/session\.(deleted|removed)/i.test(nativeType)) kind = "session.deleted";
  else if (/session\.(status|updated|idle|busy|error)/i.test(nativeType)) kind = "session.updated";
  else if (/message(\.part)?\.(updated|created|delta|completed)/i.test(nativeType)) kind = "message.updated";
  else if (/permission\.(asked|requested|updated)/i.test(nativeType)) kind = "permission.requested";
  else if (/permission\.(replied|resolved|completed)/i.test(nativeType)) kind = "permission.resolved";
  else if (/turn\.(started|start)/i.test(nativeType)) kind = "turn.started";
  else if (/turn\.(completed|finished|idle)/i.test(nativeType)) kind = "turn.completed";
  else if (/turn\.(failed|error)/i.test(nativeType)) kind = "turn.failed";
  else if (/model\.(changed|updated)/i.test(nativeType)) kind = "model.changed";
  else return null;
  const statusRaw = stringValue(properties.status, properties.type);
  const status = statusRaw ? (/busy|running|active/i.test(statusRaw) ? "running" : /wait|permission|input/i.test(statusRaw) ? "needs_input" : /error|fail/i.test(statusRaw) ? "error" : /stop|abort/i.test(statusRaw) ? "stopped" : "idle") : undefined;
  return {
    kind, harness: "opencode", sessionId, nativeType, messageId, permissionId, status,
    at: new Date().toISOString(),
    data: { nativeType },
  };
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

const opencodeMessageTextLimit = 16_384;
const opencodeThinkingLimit = 2_048;
const opencodeToolOutputLimit = 4_096;
const opencodeToolInputLimit = 4_096;

function boundedOpenCodeText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.slice(0, limit);
}

function openCodeMessageParts(message: OpenCodeMessagePayload): SessionMessagePart[] {
  const rawParts = Array.isArray(message.parts)
    ? message.parts
    : Array.isArray(message.content)
      ? message.content
      : typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : [];
  const parts: SessionMessagePart[] = [];
  for (const part of rawParts) {
    const type = typeof part.type === "string" ? part.type : "";
    if (type === "text") {
      const text = boundedOpenCodeText(part.text, opencodeMessageTextLimit);
      if (text) parts.push({ type: "text", text });
      continue;
    }
    if (type === "reasoning" || type === "thinking") {
      const text = boundedOpenCodeText(part.text, opencodeThinkingLimit);
      if (text) parts.push({ type: "thinking", text });
      continue;
    }
    if (type !== "tool") continue;
    const state = part.state && typeof part.state === "object" ? part.state as Record<string, unknown> : {};
    const name = typeof part.tool === "string" ? part.tool : typeof part.name === "string" ? part.name : undefined;
    const input = state.input;
    parts.push({
      type: "tool_call",
      name,
      input: typeof input === "string" ? input.slice(0, opencodeToolInputLimit) : input,
    });
    const output = boundedOpenCodeText(state.output, opencodeToolOutputLimit) || boundedOpenCodeText(state.error, opencodeToolOutputLimit);
    if (output) {
      parts.push({
        type: "tool_result",
        name,
        output,
        error: typeof state.error === "string" && state.error.length > 0,
      });
    }
  }
  return parts;
}

/** Resolve a local OpenCode server URL from its `serve` command line. */
export function parseOpenCodeServerCommand(commandLine: string): string | undefined {
  const port = commandLine.match(/(?:^|[\s\0])--port(?:=|[\s\0]+)(\d+)/)?.[1];
  if (!port) return undefined;

  const hostname = commandLine.match(/(?:^|[\s\0])--hostname(?:=|[\s\0]+)([^\s\0]+)/)?.[1] || "127.0.0.1";
  return `http://${hostname === "0.0.0.0" ? "127.0.0.1" : hostname}:${port}`;
}

function discoverOpenCodeServerUrl(pid: string | undefined): string | undefined {
  if (!pid || !/^\d+$/.test(pid)) return undefined;
  try {
    return parseOpenCodeServerCommand(readFileSync(`/proc/${pid}/cmdline`, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * OpenCode adapter — communicates via its HTTP server (opencode serve).
 *
 * Prerequisites:
 *   - `opencode serve` must be running (default: http://127.0.0.1:4096)
 *   - Optionally set OPENCODE_SERVER_PASSWORD for auth
 */
export class OpenCodeAdapter implements HarnessAdapter {
  readonly type = "opencode" as const;
  readonly name = "OpenCode";
  readonly controlCapabilities: HarnessCapabilities = {
    cancelTurn: true,
    detach: true,
    resume: false,
    terminate: false,
    recover: true,
    fork: true,
    modelSwitch: true,
    subagents: true,
    events: true,
  };

  private baseUrl: string;
  private headers: Record<string, string> = {};

  constructor(config: { baseUrl?: string; password?: string } = {}) {
    this.baseUrl = config.baseUrl
      || process.env.OPENCODE_URL
      || discoverOpenCodeServerUrl(process.env.OPENCODE_PID)
      || "http://127.0.0.1:4096";
    const password = config.password || process.env.OPENCODE_SERVER_PASSWORD;
    const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
    if (password) {
      this.headers["Authorization"] = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
    }
  }

  async init(): Promise<void> {
    try {
      const res = await this.fetch("/global/health");
      if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
    } catch (err) {
      throw new Error(
        `Cannot connect to OpenCode at ${this.baseUrl}. Make sure 'opencode serve' is running. Error: ${(err as Error).message}`
      );
    }
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<AgentSession[]> {
    const query = options.cwd ? `?${new URLSearchParams({ directory: options.cwd }).toString()}` : "";
    const sessions = await this.fetchJson<OpenCodeSessionPayload[]>(`/session${query}`);

    // Get statuses for all sessions
    let statuses: Record<string, { status?: string; type?: string; needsPermission?: boolean; permission?: { id: string; type: string; description: string; toolName?: string; details?: string } }> = {};
    try {
      statuses = await this.fetchJson<Record<string, unknown>>("/session/status") as typeof statuses;
    } catch {
      // status endpoint may fail
    }

    return Promise.all(sessions.map(async (s) => {
      const st = statuses[s.id] as typeof statuses[string] | undefined;
      const status = this.mapStatus(st?.status || st?.type);
      const perm = st?.permission as { id: string; type: string; description: string; toolName?: string; details?: string } | undefined;

      // Try to get last message from the session messages endpoint
      let lastMessage: string | undefined;
      try {
        const messages = await this.fetchJson<Array<{ role?: string; content?: string | Array<{ type?: string; text?: string }>; parts?: Array<{ type?: string; text?: string }> }>>(
          `/session/${s.id}/message?limit=1`
        );
        if (messages && messages.length > 0) {
          const last = messages[messages.length - 1];
          const content = last.content || last.parts;
          if (content) {
            if (typeof content === "string") {
              lastMessage = content.slice(0, 300);
            } else if (Array.isArray(content)) {
              const textBlock = content.find((b) => b.type === "text");
              if (textBlock?.text) lastMessage = textBlock.text.slice(0, 300);
            }
          }
        }
      } catch {
        // messages endpoint may not exist or may fail
      }

      return {
        id: s.id,
        harness: "opencode",
        status,
        title: s.title || "Untitled session",
        cwd: s.directory || s.path || process.cwd(),
        lastActivity: this.timestamp(s.time?.updated, s.updatedAt, s.time?.created, s.createdAt),
        model: this.modelName(s.model),
        needsPermission: st?.needsPermission === true || !!perm,
        permissionDetails: perm ? {
          id: perm.id,
          type: perm.type,
          description: perm.description,
          toolName: perm.toolName,
          details: perm.details,
        } : undefined,
        costUsd: s.costUsd ?? s.cost,
        durationSec: this.durationSeconds(s.time?.created, s.createdAt),
        lastMessage,
        meta: { createdAt: this.timestamp(s.time?.created, s.createdAt) },
      };
    }));
  }

  async getSession(id: string): Promise<AgentSession | null> {
    // OpenCode exposes a direct lookup for sessions that may not be present in
    // the paginated/list response (for example, a parent session opened from a
    // UI link). Prefer it so control tools can address an explicit session ID.
    try {
      const session = await this.fetchJson<OpenCodeSessionPayload>(`/session/${encodeURIComponent(id)}`);
      return this.toSession(session);
    } catch {
      const all = await this.listSessions();
      return all.find((s) => s.id === id) || null;
    }
  }

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    const query = new URLSearchParams({ directory: options.cwd });
    const session = await this.fetchJson<OpenCodeSessionPayload>(`/session?${query.toString()}`, {
      method: "POST",
      body: JSON.stringify({ title: options.name }),
    });
    return this.toSession(session);
  }

  async getParent(id: string): Promise<AgentSession | null> {
    const session = await this.fetchJson<OpenCodeSessionPayload>(`/session/${encodeURIComponent(id)}`);
    return session.parentID ? this.getSession(session.parentID) : null;
  }

  async sendMessage(id: string, options: SendMessageOptions): Promise<{ ok: boolean; error?: string }> {
    if (options.queue) {
      const res = await this.fetch(`/session/${id}/prompt_async`, {
        method: "POST",
        body: JSON.stringify({
          parts: [{ type: "text", text: options.message }],
        }),
      });
      return { ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };
    }

    const res = await this.fetch(`/session/${id}/message`, {
      method: "POST",
      body: JSON.stringify({
        parts: [{ type: "text", text: options.message }],
      }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  }

  async stopSession(id: string): Promise<{ ok: boolean; error?: string }> {
    return this.cancelTurn(id);
  }

  async cancelTurn(id: string): Promise<ControlResult> {
    const res = await this.fetch(`/session/${id}/interrupt`, { method: "POST" });
    if (res.ok) return { ok: true };
    if (res.status !== 404) return { ok: false, error: `HTTP ${res.status}` };
    const v2 = await this.fetch(`/api/session/${id}/interrupt`, { method: "POST" });
    if (v2.ok) return { ok: true };
    const legacy = await this.fetch(`/session/${id}/abort`, { method: "POST" });
    return { ok: legacy.ok, error: legacy.ok ? undefined : `HTTP ${legacy.status}` };
  }

  async detach(_id: string): Promise<ControlResult> {
    return { ok: true };
  }

  async listChildren(id: string): Promise<AgentSession[]> {
    const children = await this.fetchJson<OpenCodeSessionPayload[]>(`/session/${encodeURIComponent(id)}/children`);
    return children.map((child) => this.toSession(child));
  }

  /** Subscribe to OpenCode's durable SSE stream and normalize native events. */
  subscribeEvents(onEvent: (event: HarnessEvent) => void): () => void {
    const controller = new AbortController();
    void this.consumeEvents(
      controller.signal,
      (raw) => { const normalized = normalizeOpenCodeEvent(raw); if (normalized) onEvent(normalized); },
      () => onEvent({ kind: "process.connected", harness: "opencode", data: { transport: "sse" } }),
      (error) => onEvent({ kind: "process.disconnected", harness: "opencode", data: { transport: "sse", ...(error ? { error } : {}) } }),
    );
    return () => controller.abort();
  }

  async forkSession(id: string, message?: string): Promise<ControlResult> {
    try {
      const child = await this.fetchJson<OpenCodeSessionPayload>(`/session/${id}/fork`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (message) {
        const sent = await this.sendMessage(child.id, { message, queue: true });
        if (!sent.ok) return { ...sent, sessionId: child.id };
      }
      return { ok: true, sessionId: child.id };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  async recover(id: string, message?: string, signal?: AbortSignal): Promise<ControlResult> {
    try {
      throwIfAborted(signal);
      let wait = await this.fetch(`/session/${id}/wait`, { method: "POST", signal });
      if (wait.status === 404) wait = await this.fetch(`/api/session/${id}/wait`, { method: "POST", signal });
      throwIfAborted(signal);
      if (!wait.ok && wait.status !== 404) throw new Error(`OpenCode wait failed: HTTP ${wait.status}`);
      if (!message) return { ok: true };
      const result = await this.sendMessage(id, { message, queue: true });
      if (result.ok) return result;
      throw new Error(result.error || "OpenCode recovery prompt failed");
    } catch (error) {
      if (signal?.aborted) throw error;
      const forked = await this.forkSession(id, message);
      return forked.ok
        ? { ...forked, error: `Recovery used a child session after transport error: ${(error as Error).message}` }
        : { ok: false, error: `${(error as Error).message}; fork failed: ${forked.error}` };
    }
  }

  async respondPermission(
    sessionId: string,
    permissionId: string,
    response: "allow" | "deny",
    remember?: boolean
  ): Promise<{ ok: boolean; error?: string }> {
    const res = await this.fetch(`/session/${sessionId}/permissions/${permissionId}`, {
      method: "POST",
      body: JSON.stringify({ response, remember }),
    });
    return { ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };
  }

  async setPermissions(sessionId: string, options: SetPermissionsOptions): Promise<{ ok: boolean; error?: string }> {
    const updates: Record<string, unknown> = {};
    if (options.allowedTools) {
      updates.allowedTools = options.allowedTools.split(",").map((t) => t.trim());
    }
    if (options.mode) {
      updates.permissionMode = options.mode;
    }
    const res = await this.fetch("/config", {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
    return { ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };
  }

  async changeModel(sessionId: string, model: string): Promise<{ ok: boolean; error?: string }> {
    // The legacy PATCH /session endpoint silently ignores `model`.  The
    // current OpenCode API requires the v2 per-session model switch before
    // the first prompt, otherwise the prompt runs on the configured default.
    const separator = model.indexOf("/");
    const providerID = separator > 0 ? model.slice(0, separator) : "";
    const modelID = separator > 0 ? model.slice(separator + 1) : "";
    if (!providerID || !modelID) {
      return { ok: false, error: "Model must use the provider/model format" };
    }
    try {
      const res = await this.fetch(`/api/session/${encodeURIComponent(sessionId)}/model`, {
        method: "POST",
        body: JSON.stringify({ model: { providerID, id: modelID } }),
      });
      if (res.ok) return { ok: true };
      return { ok: false, error: `Failed to select model: HTTP ${res.status}` };
    } catch {
      return { ok: false, error: "Failed to select model: request failed" };
    }
  }

  async listModels(): Promise<string[]> {
    // OpenCode uses provider-based model names
    // Try to fetch from config, otherwise return common ones
    try {
      const config = await this.fetchJson<{ model?: string; provider?: string; models?: string[] }>("/config");
      if (config.models) return config.models;
      if (config.model) return [config.model];
    } catch { /* fallback */ }

    return [
      "openai/gpt-4o",
      "openai/gpt-4o-mini",
      "anthropic/claude-sonnet-4-20250514",
      "anthropic/claude-3-5-sonnet-20241022",
      "google/gemini-2.5-pro",
      "google/gemini-2.5-flash",
      "deepseek/deepseek-chat",
      "deepseek/deepseek-reasoner",
      "ollama/llama3",
      "ollama/codellama",
    ];
  }

  /** Read recent native messages without falling back to an unbounded converter. */
  async getSessionMessages(id: string, limit = 3): Promise<SessionMessageView[] | null> {
    try {
      const boundedLimit = Math.max(1, Math.min(limit, 50));
      const messages = await this.fetchJson<OpenCodeMessagePayload[]>(
        `/session/${encodeURIComponent(id)}/message?limit=${boundedLimit}`,
      );
      if (!Array.isArray(messages)) return null;
      return messages.slice(-boundedLimit).map((message, index) => {
        const parts = openCodeMessageParts(message);
        const info = message.info || {};
        const role = message.role || info.role || (parts.length > 0 && parts.every((part) => part.type === "tool_result") ? "tool" : "assistant");
        const text = parts.filter((part) => part.type === "text" || part.type === "thinking").map((part) => part.text || "").join("\n").trim() || undefined;
        return {
          id: message.id || info.id || `${id}:message-${index + 1}`,
          role: role === "user" || role === "assistant" || role === "system" || role === "tool" ? role : "assistant",
          timestamp: typeof info.time?.created === "number" ? new Date(info.time.created * 1000).toISOString() : undefined,
          text,
          parts,
        };
      });
    } catch {
      return null;
    }
  }

  async getTranscript(id: string): Promise<string | null> {
    try {
      const messages = await this.fetchJson<Array<{
        role?: string;
        content?: string | Array<{ type?: string; text?: string; input?: Record<string, unknown> }>;
        info?: { role?: string };
        parts?: Array<{ type?: string; text?: string }>;
      }>>(`/session/${id}/message?limit=200`);

      if (!messages || messages.length === 0) return null;

      const parts: string[] = [];
      for (const msg of messages) {
        const role = msg.role || msg.info?.role || "unknown";
        const content = msg.content || msg.parts;
        if (typeof content === "string") {
          parts.push(`${role}: ${content.slice(0, 2000)}`);
        } else if (Array.isArray(content)) {
          const textParts: string[] = [];
          for (const block of content) {
            if (block.type === "text" && block.text) textParts.push(block.text);
          }
          if (textParts.length > 0) parts.push(`${role}: ${textParts.join(" ").slice(0, 2000)}`);
        }
      }
      return parts.join("\n\n") || null;
    } catch {
      return null;
    }
  }

  async getRawTranscript(id: string, signal?: AbortSignal): Promise<RawTranscriptExport | null> {
    try {
      const endpoint = `/session/${encodeURIComponent(id)}/message?limit=200`;
      const messages = await this.fetchJson<unknown[]>(endpoint, { signal });
      if (!Array.isArray(messages)) return null;
      return {
        bytes: Buffer.from(JSON.stringify(messages, null, 2)),
        complete: false,
        source: { kind: "native-api", location: `${this.baseUrl}${endpoint}`, format: "json" },
        timestampCoverage: "partial",
        limitations: ["OpenCode message API was fetched with limit=200; pagination has not been verified."],
      };
    } catch {
      return null;
    }
  }

  // ---- helpers ----

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
  }

  private async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetch(path, init);
    if (!res.ok) throw new Error(`OpenCode API ${path}: HTTP ${res.status}`);
    return res.json() as Promise<T>;
  }

  private async consumeEvents(
    signal: AbortSignal,
    onEvent: (event: unknown) => void,
    onConnected: () => void,
    onDisconnected: (error?: string) => void,
  ): Promise<void> {
    let backoffMs = 500;
    while (!signal.aborted) {
      try {
        const response = await this.fetch("/event", { signal });
        if (!response.ok || !response.body) throw new Error(`OpenCode event stream HTTP ${response.status}`);
        onConnected();
        backoffMs = 500;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() || "";
          for (const frame of frames) {
            const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
            if (!data) continue;
            try { onEvent(JSON.parse(data)); } catch { /* ignore malformed SSE frames */ }
          }
        }
        try { await reader.cancel(); } catch { /* already closed */ }
        if (!signal.aborted) onDisconnected("OpenCode event stream closed");
      } catch (error) {
        if (signal.aborted) break;
        onDisconnected(error instanceof Error ? error.message : String(error));
      }
      if (signal.aborted) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, backoffMs);
        const abort = () => { clearTimeout(timer); resolve(); };
        signal.addEventListener("abort", abort, { once: true });
      });
      backoffMs = Math.min(10_000, backoffMs * 2);
    }
  }

  private mapStatus(raw?: string): AgentSession["status"] {
    switch (raw) {
      case "running":
      case "busy": return "running";
      case "idle": return "idle";
      case "waiting": return "needs_input";
      default: return "idle";
    }
  }

  private toSession(session: OpenCodeSessionPayload): AgentSession {
    return {
      id: session.id,
      harness: "opencode",
      status: "idle",
      title: session.title || "Untitled session",
      cwd: session.directory || session.path || process.cwd(),
      lastActivity: this.timestamp(session.time?.updated, session.updatedAt, session.time?.created, session.createdAt),
      model: this.modelName(session.model),
      needsPermission: false,
      meta: { createdAt: this.timestamp(session.time?.created, session.createdAt) },
    };
  }

  private modelName(model: OpenCodeSessionPayload["model"]): string | undefined {
    if (typeof model === "string") return model;
    if (model?.providerID && model.id) return `${model.providerID}/${model.id}`;
    return model?.id;
  }

  private timestamp(...values: Array<number | string | undefined>): string {
    const value = values.find((candidate) => candidate !== undefined);
    if (typeof value === "number") return new Date(value).toISOString();
    return value || new Date(0).toISOString();
  }

  private durationSeconds(createdAt?: number, legacyCreatedAt?: string): number | undefined {
    const timestamp = createdAt !== undefined
      ? createdAt
      : legacyCreatedAt ? new Date(legacyCreatedAt).getTime() : undefined;
    return timestamp === undefined ? undefined : Math.max(0, (Date.now() - timestamp) / 1000);
  }
}
