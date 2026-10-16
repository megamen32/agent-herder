import { currentTurnContextReceipt, previousCoordinationReceipt, reserveCurrentTurnContext } from "../coordination-active-delivery.js";
import { deferredMessages } from "../deferred-messages.js";
import { getHumanStopStore } from "../human-stop-store.js";
import { HarnessAdapter, AgentSession, ControlResult, CreateSessionOptions, HarnessCapabilities, HarnessEvent, ListSessionsOptions, RawTranscriptExport, SendMessageOptions, SendMessageResult, SetPermissionsOptions, SessionMessagePart, SessionMessageView } from "../types/index.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { throwIfAborted } from "../abort-utils.js";

interface OpenCodeSessionPayload {
  id: string;
  title?: string;
  path?: string;
  directory?: string;
  /** OpenCode v2 records the working directory as `location.directory`. */
  location?: { directory?: string };
  createdAt?: string;
  updatedAt?: string;
  time?: { created?: number; updated?: number };
  model?: string | { providerID?: string; id?: string };
  costUsd?: number;
  cost?: number;
  parentID?: string;
  /** v2 terminal outcome of the last turn. */
  outcome?: "succeeded" | "failed" | "interrupted";
  permissions?: unknown;
}

interface OpenCodeMessagePayload {
  id?: string;
  role?: string;
  /** OpenCode v2 message discriminator (user/assistant/idle/sys/...). */
  type?: string;
  /** OpenCode v2 user message text is carried directly on the message. */
  text?: string;
  info?: { id?: string; sessionID?: string; role?: string; providerID?: string; modelID?: string; time?: { created?: number } };
  model?: { providerID?: string; id?: string };
  content?: string | Array<Record<string, unknown>>;
  parts?: Array<Record<string, unknown>>;
}

interface OpenCodeSessionStatus {
  status?: string;
  type?: string;
  needsPermission?: boolean;
  permission?: { id: string; type: string; description: string; toolName?: string; details?: string };
}

/** OpenCode v2 pending permission request from `/api/permission/request`. */
interface OpenCodePermissionRequest {
  id: string;
  sessionID?: string;
  action?: string;
  resources?: string[];
  message?: string;
  source?: { type?: string; messageID?: string; id?: string };
}

interface OpenCodeProviderCatalog {
  all?: Array<{
    id?: string;
    models?: Record<string, unknown> | Array<{ id?: string }>;
  }>;
  connected?: string[];
  /** OpenCode v2 `/api/provider` payload. */
  data?: Array<{ id?: string; activation?: string }>;
}

/** OpenCode v2 `/api/model` payload entry. */
interface OpenCodeModelCatalogEntry {
  id?: string;
  modelID?: string;
  providerID?: string;
  name?: string;
}

/** Connected provider filter shared by the v1 `/provider` and v2 `/api/provider` catalogs. */
export function openCodeConnectedProviders(catalog: OpenCodeProviderCatalog): Set<string> {
  const connected = new Set((catalog.connected ?? []).filter((value): value is string => typeof value === "string" && value.length > 0));
  for (const provider of catalog.data ?? []) {
    if (typeof provider.id !== "string" || !provider.id) continue;
    // v2 marks an inactive integration explicitly; absent activation means connected.
    if (provider.activation === undefined || provider.activation === "enabled" || provider.activation === "connected") {
      connected.add(provider.id);
    }
  }
  return connected;
}

export function openCodeConnectedModels(catalog: OpenCodeProviderCatalog): string[] {
  const connected = openCodeConnectedProviders(catalog);
  const result: string[] = [];
  for (const provider of catalog.all ?? []) {
    const providerId = typeof provider.id === "string" ? provider.id.trim() : "";
    if (!providerId || (connected.size > 0 && !connected.has(providerId))) continue;
    const modelIds = Array.isArray(provider.models)
      ? provider.models.map((model) => typeof model?.id === "string" ? model.id.trim() : "")
      : Object.keys(provider.models ?? {});
    for (const modelId of modelIds) {
      if (modelId) result.push(`${providerId}/${modelId}`);
    }
  }
  return [...new Set(result)];
}

/** Flatten the OpenCode v2 `/api/model` catalog into provider/model identifiers. */
export function openCodeModelCatalogEntries(entries: OpenCodeModelCatalogEntry[]): string[] {
  const result: string[] = [];
  for (const entry of entries) {
    const providerId = typeof entry?.providerID === "string" ? entry.providerID.trim() : "";
    const modelId = typeof entry?.modelID === "string" && entry.modelID.trim()
      ? entry.modelID.trim()
      : typeof entry?.id === "string" ? entry.id.trim() : "";
    if (providerId && modelId) result.push(`${providerId}/${modelId}`);
  }
  return [...new Set(result)];
}

function normalizeOpenCodeEvent(raw: unknown): HarnessEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const event = raw as Record<string, unknown>;
  const nativeType = typeof event.type === "string" ? event.type : typeof event.event === "string" ? event.event : "";
  const properties = event.properties && typeof event.properties === "object" ? event.properties as Record<string, unknown> : event;
  const info = properties.info && typeof properties.info === "object" ? properties.info as Record<string, unknown> : undefined;
  const session = properties.session && typeof properties.session === "object" ? properties.session as Record<string, unknown> : undefined;
  // OpenCode v2 frames carry the native payload under `data`.
  const payload = properties.data && typeof properties.data === "object" ? properties.data as Record<string, unknown> : undefined;
  const sessionId = stringValue(
    properties.sessionID, properties.sessionId, properties.session_id,
    info?.sessionID, info?.sessionId, session?.id,
    payload?.sessionID, payload?.sessionId,
    stringValue(payload?.aggregateID),
  );
  const messageId = stringValue(properties.messageID, properties.messageId, info?.id, payload?.messageID, payload?.messageId, payload?.inboxID);
  const permissionId = stringValue(properties.permissionID, properties.permissionId, properties.id, payload?.permissionID, payload?.requestID);
  let kind: HarnessEvent["kind"] | undefined;
  if (/session\.(created|added)/i.test(nativeType)) kind = "session.created";
  else if (/session\.(deleted|removed|closed)/i.test(nativeType)) kind = "session.deleted";
  else if (/session\.(status|updated|idle|busy|error)/i.test(nativeType)) kind = "session.updated";
  else if (/message(\.part)?\.(updated|created|delta|completed|removed)/i.test(nativeType)) kind = "message.updated";
  // OpenCode v2 publishes delivery and execution lifecycle under its own names.
  else if (/session\.inbox\.(enqueued|delivered|rejected)/i.test(nativeType)) kind = "message.updated";
  else if (/session\.execution\.(started|start)/i.test(nativeType)) kind = "turn.started";
  else if (/session\.execution\.(succeeded|completed|finished)/i.test(nativeType)) kind = "turn.completed";
  else if (/session\.execution\.(failed|error|interrupted)/i.test(nativeType)) kind = "turn.failed";
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
    // OpenCode v2 reports tool failures as `{ message }` objects instead of strings.
    const errorText = typeof state.error === "string"
      ? state.error
      : state.error && typeof state.error === "object"
        ? (typeof (state.error as Record<string, unknown>).message === "string" ? (state.error as Record<string, unknown>).message as string : "")
        : "";
    const output = boundedOpenCodeText(state.output, opencodeToolOutputLimit) || boundedOpenCodeText(errorText, opencodeToolOutputLimit);
    if (output) {
      parts.push({
        type: "tool_result",
        name,
        output,
        error: errorText.length > 0,
      });
    }
  }
  // OpenCode v2 carries plain user/assistant text directly on the message.
  if (parts.length === 0 && typeof message.text === "string" && message.text.length > 0) {
    parts.push({ type: "text", text: boundedOpenCodeText(message.text, opencodeMessageTextLimit)! });
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

function isJsonResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("json");
}

/** OpenCode v2 answers unknown API paths with its SPA shell instead of 404. */
function isHtmlResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("text/html");
}

/** OpenCode v2 wraps every JSON result in `{ data }`; some routes add context. */
export function unwrapEnvelope<T>(value: unknown): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value as T;
  const record = value as Record<string, unknown>;
  if (!("data" in record)) return value as T;
  const extraKeys = Object.keys(record).filter((key) => key !== "data");
  if (extraKeys.some((key) => !["cursor", "location", "durable"].includes(key))) return value as T;
  return record.data as T;
}

/**
 * OpenCode adapter — communicates via its HTTP server (`opencode serve`).
 *
 * Supports both native protocols:
 *   - v2 (OpenCode >= 2): JSON API under `/api`, `{ data }` response envelopes,
 *     `location.directory` working directories, `/api/session/{id}/prompt`
 *     delivery with `steer`/`queue`, and session-scoped permission requests.
 *   - v1 (legacy servers): unprefixed JSON API with `/global/health` and
 *     `/session/status`.
 *
 * Prerequisites:
 *   - `opencode serve` must be running (default: http://127.0.0.1:4096)
 *   - `OPENCODE_SERVER_PASSWORD` when the server requires Basic auth
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
  private sessionDirectories = new Map<string, string>();
  /** Native protocol in use. Probed once, then self-corrected on HTML responses. */
  private apiPrefix = "";
  private protocolProbed = false;
  private readonly pinnedProtocol?: "v1" | "v2";

  constructor(config: { baseUrl?: string; password?: string; protocol?: "auto" | "v1" | "v2" } = {}) {
    this.baseUrl = config.baseUrl
      || process.env.OPENCODE_URL
      || discoverOpenCodeServerUrl(process.env.OPENCODE_PID)
      || "http://127.0.0.1:4096";
    const password = config.password || process.env.OPENCODE_SERVER_PASSWORD;
    const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
    if (password) {
      this.headers["Authorization"] = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
    }
    if (config.protocol === "v1" || config.protocol === "v2") this.pinnedProtocol = config.protocol;
  }

  /** True once the server answered as an OpenCode v2 (`/api`) instance. */
  get isV2(): boolean {
    return this.apiPrefix === "/api";
  }

  async init(): Promise<void> {
    await this.probeProtocol();
    try {
      const res = await this.fetch(this.isV2 ? this.api("/config") : "/global/health");
      if (!res.ok) throw new Error(`Health check failed: HTTP ${res.status}${await this.errorHint(res)}`);
    } catch (err) {
      throw new Error(
        `Cannot connect to OpenCode at ${this.baseUrl}. Make sure 'opencode serve' is running. Error: ${(err as Error).message}`
      );
    }
  }

  /** Detect the native protocol once; v2 answers on `/api`, v1 on the root API. */
  private async probeProtocol(): Promise<void> {
    if (this.protocolProbed) return;
    if (this.pinnedProtocol) {
      this.protocolProbed = true;
      this.apiPrefix = this.pinnedProtocol === "v2" ? "/api" : "";
      return;
    }
    this.protocolProbed = true;
    const v2 = await this.rawFetch("/api/config");
    if (v2.ok && isJsonResponse(v2)) {
      this.apiPrefix = "/api";
      return;
    }
    const v1 = await this.rawFetch("/global/health");
    if (v1.ok) {
      this.apiPrefix = "";
      return;
    }
    // Nothing answered yet: default to v2 and let the first real call correct it.
    this.apiPrefix = "/api";
  }

  /** Native endpoint for this protocol. */
  private api(path: string): string {
    return `${this.apiPrefix}${path}`;
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<AgentSession[]> {
    await this.probeProtocol();
    const params = new URLSearchParams();
    if (options.cwd) params.set("directory", options.cwd);
    if (this.isV2) {
      // v2 bounds the page itself; the newest sessions matter most.
      params.set("order", "desc");
      params.set("limit", String(Math.max(1, Math.min(options.limit ?? 100, 500))));
    }
    const query = params.toString() ? `?${params.toString()}` : "";
    const sessions = await this.fetchJson<OpenCodeSessionPayload[]>(this.api(`/session${query}`));

    // Get statuses for all sessions
    const statuses = await this.readStatuses(options.cwd);

    return sessions.map((s) => {
      const st = statuses[s.id] as typeof statuses[string] | undefined;
      const status = this.mapStatus(st?.status || st?.type, s.outcome);
      const perm = st?.permission as { id: string; type: string; description: string; toolName?: string; details?: string } | undefined;

      return {
        id: s.id,
        harness: "opencode",
        status,
        title: s.title || "Untitled session",
        cwd: this.sessionDirectory(s) || process.cwd(),
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
        meta: { createdAt: this.timestamp(s.time?.created, s.createdAt) },
      };
    });
  }

  async getSession(id: string): Promise<AgentSession | null> {
    await this.probeProtocol();
    // OpenCode exposes a direct lookup for sessions that may not be present in
    // the paginated/list response (for example, a parent session opened from a
    // UI link). Prefer it so control tools can address an explicit session ID.
    let session: OpenCodeSessionPayload;
    try {
      session = await this.fetchJson<OpenCodeSessionPayload>(this.api(`/session/${encodeURIComponent(id)}`));
    } catch {
      const all = await this.listSessions();
      return all.find((s) => s.id === id) || null;
    }
    const result = this.toSession(session);
    const statuses = await this.readStatuses(this.sessionDirectory(session));
    result.status = this.mapStatus(statuses[id]?.status || statuses[id]?.type, session.outcome);
    const permission = statuses[id]?.permission;
    result.needsPermission = statuses[id]?.needsPermission === true || !!permission;
    result.permissionDetails = permission;
    const last = (await this.getSessionMessages(id, 1))?.at(-1);
    if (last) {
      const tool = [...last.parts].reverse().find((part) => part.type === "tool_call" || part.type === "tool_result");
      if (last.model) result.model = last.model;
      result.lastMessage = last.text || (tool ? `Инструмент: ${tool.name || "tool"}` : undefined);
      if (last.timestamp && last.timestamp > result.lastActivity) result.lastActivity = last.timestamp;
    }
    return result;
  }

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    await this.probeProtocol();
    const separator = options.model?.indexOf("/") ?? -1;
    const requestedModel = separator > 0 ? {
      providerID: options.model!.slice(0, separator),
      id: options.model!.slice(separator + 1),
    } : undefined;
    if (this.isV2) {
      const session = await this.fetchJson<OpenCodeSessionPayload>(this.api("/session"), {
        method: "POST",
        body: JSON.stringify({
          title: options.name,
          location: { directory: options.cwd },
          ...(requestedModel ? { model: requestedModel } : {}),
          ...(options.fullAccess ? { permissions: [{ action: "*", resource: "*", effect: "allow" }] } : {}),
        }),
      });
      return this.toSession({ ...session, directory: this.sessionDirectory(session) || options.cwd });
    }
    const query = new URLSearchParams({ directory: options.cwd });
    const session = await this.fetchJson<OpenCodeSessionPayload>(`/session?${query.toString()}`, {
      method: "POST",
      body: JSON.stringify({
        title: options.name,
        ...(requestedModel ? { model: requestedModel } : {}),
        ...(options.fullAccess ? {
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } : {}),
      }),
    });
    return this.toSession({ ...session, directory: session.directory || session.path || options.cwd });
  }

  async getParent(id: string): Promise<AgentSession | null> {
    await this.probeProtocol();
    const session = await this.fetchJson<OpenCodeSessionPayload>(this.api(`/session/${encodeURIComponent(id)}`));
    return session.parentID ? this.getSession(session.parentID) : null;
  }

  async getCoordinationActiveTurnId(id:string):Promise<string|null>{
    await this.probeProtocol();
    // Native active-turn identity. Cold reads resolve the instance directory
    // without loading/resuming the session; independent reads then share one
    // network latency budget.
    const directory=await this.resolveSessionDirectory(id);
    if(!directory)return null;
    const directoryQuery = this.isV2 ? "" : `?directory=${encodeURIComponent(directory)}&limit=50`;
    const v2Messages = this.isV2
      ? await this.fetchJson<OpenCodeMessagePayload[]>(this.api(`/session/${encodeURIComponent(id)}/message?limit=10&type=user&order=desc`))
      : null;
    const [messages,session,statuses]=await Promise.all([
      v2Messages ?? this.fetchJson<OpenCodeMessagePayload[]>(`/session/${encodeURIComponent(id)}/message${directoryQuery}`),
      this.fetchJson<OpenCodeSessionPayload>(this.api(`/session/${encodeURIComponent(id)}`)),
      this.readStatuses(directory),
    ]);
    if(session.id!==id||this.sessionDirectory(session)!==directory||!Array.isArray(messages))return null;
    const st=statuses[id];if(this.mapStatus(st?.status||st?.type)!=='running'||st?.needsPermission||st?.permission)return null;
    const user=this.isV2
      ? messages.find(m=>m.type==='user'&&typeof m.id==='string')
      : [...messages].reverse().find(m=>(m.info?.role||m.role)==='user');
    if(!user)return null;
    if(!this.isV2&&user.info?.sessionID&&user.info.sessionID!==id)return null;
    const identity = this.isV2 ? user.id : user.info?.id;
    return typeof identity==='string'&&identity?identity:null;
  }

  /**
   * Active-turn delivery. OpenCode v2 steers the running turn natively through
   * `delivery: "steer"`, so the message reaches the live turn instead of waiting
   * for a plugin hook that only older servers run.
   */
  async sendActiveMessage(id: string, options: SendMessageOptions): Promise<ControlResult> {
    await this.probeProtocol();
    // Legacy servers have no native steer; they keep the durable hook offer.
    if (!this.isV2) return reserveCurrentTurnContext(this, id, options);
    const prior = await previousCoordinationReceipt(this, id, options.inputId);
    if (prior) {
      const parsed = JSON.parse(prior) as {
        ok: boolean; admitted?: boolean; pending?: boolean; error?: string;
        admissionUnknown?: boolean; nonRetryable?: boolean;
      };
      return {
        ok: parsed.ok,
        admitted: parsed.admitted ?? parsed.ok,
        ...(parsed.pending ? { pending: true } : {}),
        ...(parsed.error ? { error: parsed.error } : {}),
        ...(parsed.admissionUnknown ? { admissionUnknown: true } : {}),
        ...(parsed.nonRetryable ? { nonRetryable: true } : {}),
        inputId: options.inputId,
      };
    }
    const identity = await this.getCoordinationActiveTurnId?.(id);
    if (!identity) {
      return { ok: false, notSubmitted: true, nonRetryable: true, inputId: options.inputId, error: "skipped_inactive: точный активный native ход не установлен" };
    }
    if (await getHumanStopStore().isHeld(this.type, id)) {
      return { ok: false, notSubmitted: true, nonRetryable: true, inputId: options.inputId, error: "Чат явно остановлен." };
    }
    const delivered = await this.dispatchPrompt(id, options.message, "steer");
    if (!delivered.ok) {
      return { ...delivered, notSubmitted: delivered.notSubmitted, nonRetryable: delivered.notSubmitted, inputId: options.inputId };
    }
    await deferredMessages.addActive(this.type, id, identity, options.inputId || randomUUID(), options.message, options.retainedInboxIds);
    return { ok: true, admitted: true, pending: true, inputId: options.inputId, error: undefined };
  }

  async getCoordinationMessageAdmission(id:string,inputId:string){return currentTurnContextReceipt(this,id,inputId);}

  async sendMessage(id: string, options: SendMessageOptions): Promise<SendMessageResult> {
    await this.probeProtocol();
    if (this.isV2) {
      // `queue` defers the input to the next turn; anything else steers the live
      // turn and starts one when the session is idle.
      return this.dispatchPrompt(id, options.message, options.queue ? "queue" : "steer", options.inputId);
    }
    if (options.queue) {
      const res = await this.fetch(`/session/${id}/prompt_async`, {
        method: "POST",
        body: JSON.stringify({
          parts: [{ type: "text", text: options.message }],
        }),
      });
      // prompt_async acknowledges native admission, independently of model completion.
      return res.ok ? { ok: true, admitted: true } : { ok: false, error: `HTTP ${res.status}` };
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

  /**
   * Native v2 prompt admission through the session inbox.
   * `steer` is consumed by the running turn, `queue` waits for the next one.
   */
  private async dispatchPrompt(
    id: string,
    message: string,
    delivery: "steer" | "queue",
    inputId?: string,
  ): Promise<SendMessageResult> {
    try {
      const res = await this.fetch(this.api(`/session/${encodeURIComponent(id)}/prompt`), {
        method: "POST",
        body: JSON.stringify({ text: message, delivery }),
      });
      if (res.ok) return { ok: true, admitted: true, pending: true, ...(inputId ? { inputId } : {}) };
      const hint = await this.errorHint(res);
      if (res.status === 409) {
        // The inbox refuses a steer while the turn is busy: retry it as a queue.
        const queued = await this.fetch(this.api(`/session/${encodeURIComponent(id)}/prompt`), {
          method: "POST",
          body: JSON.stringify({ text: message, delivery: "queue" }),
        });
        if (queued.ok) return { ok: true, admitted: true, pending: true, ...(inputId ? { inputId } : {}) };
        return { ok: false, error: `HTTP ${queued.status}${await this.errorHint(queued)}`, ...(inputId ? { inputId } : {}) };
      }
      return { ok: false, error: `HTTP ${res.status}${hint}`, ...(inputId ? { inputId } : {}) };
    } catch (error) {
      return { ok: false, error: (error as Error).message, admissionUnknown: true, nonRetryable: true, ...(inputId ? { inputId } : {}) };
    }
  }

  async stopSession(id: string): Promise<{ ok: boolean; error?: string }> {
    return this.cancelTurn(id);
  }

  async cancelTurn(id: string): Promise<ControlResult> {
    await this.probeProtocol();
    if (this.isV2) {
      const res = await this.fetch(this.api(`/session/${encodeURIComponent(id)}/interrupt`), { method: "POST" });
      if (res.ok) return { ok: true };
      return { ok: false, error: `HTTP ${res.status}${await this.errorHint(res)}` };
    }
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
    await this.probeProtocol();
    if (this.isV2) {
      // v2 removed the dedicated children route; parentID is a native filter.
      const children = await this.fetchJson<OpenCodeSessionPayload[]>(this.api(`/session?parentID=${encodeURIComponent(id)}&order=asc`));
      return children.map((child) => this.toSession(child));
    }
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
    await this.probeProtocol();
    try {
      const child = await this.fetchJson<OpenCodeSessionPayload>(this.api(`/session/${encodeURIComponent(id)}/fork`), {
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
    await this.probeProtocol();
    try {
      throwIfAborted(signal);
      // v2 exposes the wait primitive as an experimental route.
      const wait = this.isV2
        ? await this.fetch(this.api(`/experimental/session/${encodeURIComponent(id)}/wait`), { method: "POST", signal })
        : await this.fetch(`/session/${id}/wait`, { method: "POST", signal });
      throwIfAborted(signal);
      if (!wait.ok && wait.status !== 404) throw new Error(`OpenCode wait failed: HTTP ${wait.status}${await this.errorHint(wait)}`);
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
    await this.probeProtocol();
    if (this.isV2) {
      const decision = response === "deny" ? "reject" : remember ? "always" : "once";
      const res = await this.fetch(this.api(`/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(permissionId)}/reply`), {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
      return { ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}${await this.errorHint(res)}` };
    }
    const res = await this.fetch(`/session/${sessionId}/permissions/${permissionId}`, {
      method: "POST",
      body: JSON.stringify({ response, remember }),
    });
    return { ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };
  }

  async setPermissions(sessionId: string, options: SetPermissionsOptions): Promise<{ ok: boolean; error?: string }> {
    await this.probeProtocol();
    if (this.isV2) {
      // v2 owns permissions as a session-scoped ruleset instead of a config patch.
      const rules: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }> = [];
      if (options.allowedTools) {
        for (const tool of options.allowedTools.split(",").map((value) => value.trim()).filter(Boolean)) {
          rules.push({ action: tool, resource: "*", effect: "allow" });
        }
      }
      if (options.mode) {
        rules.push({ action: "*", resource: "*", effect: options.mode === "plan" || options.mode === "default" ? "ask" : "allow" });
      }
      if (rules.length === 0) return { ok: true };
      const res = await this.fetch(this.api(`/session/${encodeURIComponent(sessionId)}`), {
        method: "PATCH",
        body: JSON.stringify({ permissions: rules }),
      });
      return { ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}${await this.errorHint(res)}` };
    }
    const updates: Record<string, unknown> = {};
    if (options.allowedTools) {
      updates.allowedTools = options.allowedTools.split(",").map((t) => t.trim());
    }
    if (options.mode) {
      updates.permissionMode = options.mode;
    }
    const directory = await this.resolveSessionDirectory(sessionId);
    const query = directory ? `?${new URLSearchParams({ directory })}` : "";
    const res = await this.fetch(`/config${query}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
    return { ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };
  }

  async changeModel(sessionId: string, model: string): Promise<{ ok: boolean; error?: string }> {
    await this.probeProtocol();
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
      // The per-session model switch lives on the `/api` route in every
      // generation that has it; older servers expose it unprefixed.
      const res = await this.fetch(`/api/session/${encodeURIComponent(sessionId)}/model`, {
        method: "POST",
        body: JSON.stringify({ model: { providerID, id: modelID } }),
      });
      if (res.ok) return { ok: true };
      if (res.status === 404) {
        const legacy = await this.fetch(`/session/${encodeURIComponent(sessionId)}/model`, {
          method: "POST",
          body: JSON.stringify({ model: { providerID, id: modelID } }),
        });
        if (legacy.ok) return { ok: true };
        return { ok: false, error: `Failed to select model: HTTP ${legacy.status}` };
      }
      return { ok: false, error: `Failed to select model: HTTP ${res.status}${await this.errorHint(res)}` };
    } catch {
      return { ok: false, error: "Failed to select model: request failed" };
    }
  }

  async listModels(): Promise<string[]> {
    await this.probeProtocol();
    if (this.isV2) {
      // `/api/model` is the live v2 catalog for the current location.
      try {
        const models = openCodeModelCatalogEntries(await this.fetchJson<OpenCodeModelCatalogEntry[]>(this.api("/model")));
        if (models.length > 0) return models;
      } catch { /* fall through to the legacy catalog */ }
    }
    // `/provider` is OpenCode's live catalog.  It contains the connected
    // providers and their current model IDs, while `/config` often exposes
    // only the selected default and made newly-added routes invisible here.
    try {
      const models = openCodeConnectedModels(await this.fetchJson<OpenCodeProviderCatalog>(this.api("/provider")));
      if (models.length > 0) return models;
    } catch { /* fall through to older OpenCode compatibility */ }
    try {
      const config = await this.fetchJson<{ model?: string; provider?: string; models?: string[] }>(this.api("/config"));
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
    await this.probeProtocol();
    try {
      const boundedLimit = Math.max(1, Math.min(limit, 50));
      const endpoint = this.isV2
        ? this.api(`/session/${encodeURIComponent(id)}/message?limit=${boundedLimit}&order=desc`)
        : this.api(`/session/${encodeURIComponent(id)}/message?limit=${boundedLimit}`);
      const messages = await this.fetchJson<OpenCodeMessagePayload[]>(endpoint);
      if (!Array.isArray(messages)) return null;
      // v2 returns the newest page first; the view must stay chronological.
      const ordered = this.isV2 ? [...messages].reverse().slice(-boundedLimit) : messages.slice(-boundedLimit);
      return ordered.map((message, index) => {
        const parts = openCodeMessageParts(message);
        const info = message.info || {};
        const nativeRole = message.role || info.role || message.type;
        const role = nativeRole === "user" || nativeRole === "system"
          ? nativeRole
          : nativeRole === "tool" || (parts.length > 0 && parts.every((part) => part.type === "tool_result"))
            ? "tool"
            : "assistant";
        const text = parts.filter((part) => part.type === "text" || part.type === "thinking").map((part) => part.text || "").join("\n").trim() || undefined;
        const model = message.model?.providerID && message.model?.id
          ? `${message.model.providerID}/${message.model.id}`
          : info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : undefined;
        return {
          id: message.id || info.id || `${id}:message-${index + 1}`,
          role,
          ...(model ? { model } : {}),
          timestamp: typeof info.time?.created === "number" ? new Date(info.time.created).toISOString() : undefined,
          text,
          parts,
        };
      });
    } catch {
      return null;
    }
  }

  async getTranscript(id: string): Promise<string | null> {
    await this.probeProtocol();
    try {
      const messages = await this.fetchJson<Array<{
        role?: string;
        type?: string;
        text?: string;
        content?: string | Array<{ type?: string; text?: string; input?: Record<string, unknown> }>;
        info?: { role?: string };
        parts?: Array<{ type?: string; text?: string }>;
      }>>(this.api(`/session/${encodeURIComponent(id)}/message?limit=200`));

      if (!messages || messages.length === 0) return null;

      const parts: string[] = [];
      for (const msg of messages) {
        const role = msg.role || msg.info?.role || msg.type || "unknown";
        const content = msg.content || msg.parts || (typeof msg.text === "string" ? msg.text : undefined);
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
    await this.probeProtocol();
    try {
      const directory = await this.resolveSessionDirectory(id);
      const query = new URLSearchParams({ limit: "200", ...(directory && !this.isV2 ? { directory } : {}) });
      const endpoint = this.api(`/session/${encodeURIComponent(id)}/message?${query}`);
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

  /**
   * v2 exposes running turns as `/api/session/active` and pending permissions as
   * a global queue; v1 reports both through `/session/status`.
   */
  private async readStatuses(directory?: string): Promise<Record<string, OpenCodeSessionStatus>> {
    if (this.isV2) {
      const [active, permissions] = await Promise.all([
        this.fetchJson<Record<string, { type?: string; status?: string; permission?: OpenCodeSessionStatus["permission"] }>>(this.api("/session/active"))
          .catch(() => ({}) as Record<string, { type?: string; status?: string; permission?: OpenCodeSessionStatus["permission"] }>),
        this.fetchJson<OpenCodePermissionRequest[]>(this.api("/permission/request"))
          .catch(() => [] as OpenCodePermissionRequest[]),
      ]);
      const statuses: Record<string, OpenCodeSessionStatus> = {};
      for (const [id, entry] of Object.entries(active ?? {})) {
        const raw = entry?.type || entry?.status;
        statuses[id] = {
          status: raw === "running" ? "running" : raw === "idle" ? "idle" : raw,
          ...(entry?.permission ? { permission: entry.permission, needsPermission: true } : {}),
        };
      }
      for (const request of permissions ?? []) {
        if (!request?.sessionID) continue;
        const current = statuses[request.sessionID] ?? { status: "idle" };
        statuses[request.sessionID] = {
          ...current,
          needsPermission: true,
          permission: {
            id: request.id,
            type: request.action || "tool_use",
            description: request.message || request.action || "permission request",
            toolName: request.action,
            details: (request.resources ?? []).join(", ") || undefined,
          },
        };
      }
      return statuses;
    }
    const query = directory ? `?${new URLSearchParams({ directory })}` : "";
    const response = await this.fetch(`/session/status${query}`);
    // Older servers do not expose this endpoint. Other read failures are not
    // evidence that a working native session became idle.
    if (response.status === 404) return {};
    if (!response.ok) throw new Error(`OpenCode status read failed: HTTP ${response.status}`);
    return unwrapEnvelope<Record<string, OpenCodeSessionStatus>>(await response.json()) ?? {};
  }

  /** Working directory of a native session across v1 and v2 payload shapes. */
  private sessionDirectory(session: OpenCodeSessionPayload): string | undefined {
    return session.location?.directory || session.directory || session.path || undefined;
  }

  private rememberSession(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const session = value as OpenCodeSessionPayload;
    const directory = this.sessionDirectory(session);
    if (typeof session.id === "string" && typeof directory === "string" && directory.length > 0) {
      this.sessionDirectories.set(session.id, directory);
    }
  }

  private async resolveSessionDirectory(id: string): Promise<string | undefined> {
    if (!this.sessionDirectories.has(id)) {
      // A direct native lookup works across projects and supplies the instance
      // directory after a Herder restart. It does not resume or create a session.
      try { await this.fetchJson<OpenCodeSessionPayload>(this.api(`/session/${encodeURIComponent(id)}`)); } catch { /* older APIs */ }
    }
    return this.sessionDirectories.get(id);
  }

  /** Native error body, so operators see OpenCode's own rejection reason. */
  private async errorHint(response: Response): Promise<string> {
    if (response.status < 400) return "";
    try {
      const body = await response.clone().text();
      if (!body) return "";
      try {
        const parsed = JSON.parse(body) as { message?: string; _tag?: string };
        const message = parsed.message || parsed._tag;
        return message ? `: ${String(message).slice(0, 200)}` : "";
      } catch {
        return `: ${body.replace(/\s+/g, " ").slice(0, 200)}`;
      }
    } catch {
      return "";
    }
  }

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    await this.probeProtocol();
    const url = new URL(`${this.baseUrl}${path}`);
    const match = url.pathname.match(/^\/(?:api\/)?session\/([^/]+)(?:\/|$)/);
    if (match && match[1] !== "status" && !this.isV2 && !url.searchParams.has("directory")) {
      const id = decodeURIComponent(match[1]);
      const directLookup = url.pathname === `/session/${match[1]}` && (!init?.method || init.method === "GET");
      const directory = directLookup ? this.sessionDirectories.get(id) : await this.resolveSessionDirectory(id);
      if (directory) url.searchParams.set("directory", directory);
    }
    const response = await this.rawFetch(url.toString().slice(this.baseUrl.length), init);
    // A v2 server answers a v1-shaped path with its SPA shell. Retry the same
    // operation once on the other protocol instead of failing as broken JSON.
    if (!this.pinnedProtocol && isHtmlResponse(response)) {
      const retargeted = this.retarget(path);
      if (retargeted !== path) {
        const retry = await this.rawFetch(retargeted, init);
        // Keep later calls on the protocol that actually answered.
        this.apiPrefix = retargeted.startsWith("/api") ? "/api" : "";
        return retry;
      }
    }
    return response;
  }

  /** Same logical route on the other native protocol. */
  private retarget(path: string): string {
    const bare = path.startsWith("/api/") ? path.slice("/api".length) : path;
    return this.apiPrefix === "/api" ? `/api${bare}` : bare;
  }

  private async rawFetch(path: string, init?: RequestInit): Promise<Response> {
    const url = new URL(`${this.baseUrl}${path}`);
    return fetch(url, {
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
    if (!res.ok) throw new Error(`OpenCode API ${path}: HTTP ${res.status}${await this.errorHint(res)}`);
    const value = await res.json();
    const unwrapped = this.isV2 ? unwrapEnvelope(value) : value;
    if (Array.isArray(unwrapped)) unwrapped.forEach((item) => this.rememberSession(item));
    else this.rememberSession(unwrapped);
    return unwrapped as T;
  }

  private async consumeEvents(
    signal: AbortSignal,
    onEvent: (event: unknown) => void,
    onConnected: () => void,
    onDisconnected: (error?: string) => void,
  ): Promise<void> {
    let backoffMs = 500;
    await this.probeProtocol();
    while (!signal.aborted) {
      try {
        const response = await this.fetch(this.api("/event"), { signal });
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

  private mapStatus(raw?: string, outcome?: OpenCodeSessionPayload["outcome"]): AgentSession["status"] {
    switch (raw) {
      case "running":
      case "retry":
      case "busy": return "running";
      case "idle": return outcome === "failed" ? "error" : "idle";
      case "waiting": return "needs_input";
      default: return outcome === "failed" ? "error" : "idle";
    }
  }

  private toSession(session: OpenCodeSessionPayload): AgentSession {
    this.rememberSession(session);
    return {
      id: session.id,
      harness: "opencode",
      status: this.mapStatus(undefined, session.outcome),
      title: session.title || "Untitled session",
      cwd: this.sessionDirectory(session) || process.cwd(),
      lastActivity: this.timestamp(session.time?.updated, session.updatedAt, session.time?.created, session.createdAt),
      model: this.modelName(session.model),
      needsPermission: false,
      meta: { createdAt: this.timestamp(session.time?.created, session.createdAt), ...(session.parentID ? { parentID: session.parentID } : {}) },
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
