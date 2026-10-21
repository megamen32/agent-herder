import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  HarnessClient,
  HarnessClientOptions,
  HarnessMessage,
  HarnessMessagePart,
  HarnessSendRequest,
  HarnessSendResult,
  HarnessSessionSummary,
} from "../client.js";

/**
 * OpenCode protocol client.
 *
 * Owned by the shared core: this is the only place that knows that OpenCode 2
 * serves its JSON API under `/api` behind Basic auth, wraps results in `{ data }`,
 * records working directories in `location.directory`, reports running turns in
 * `/api/session/active`, and admits input through the session inbox
 * (`delivery: steer` into a live turn, `queue` after it). Agent Herder implements
 * its orchestration on top of this client and must not learn the protocol again.
 */

interface OpenCodeSessionPayload {
  id: string;
  title?: string;
  path?: string;
  directory?: string;
  location?: { directory?: string };
  time?: { created?: number; updated?: number };
  model?: string | { providerID?: string; id?: string };
  cost?: number;
  parentID?: string;
  metadata?: Record<string, unknown>;
  outcome?: "succeeded" | "failed" | "interrupted";
}

interface OpenCodeMessagePayload {
  id?: string;
  parentID?: string;
  inputId?: string;
  turnId?: string;
  role?: string;
  type?: string;
  text?: string;
  info?: { id?: string; parentID?: string; sessionID?: string; role?: string; providerID?: string; modelID?: string; inputId?: string; turnId?: string; metadata?: Record<string, unknown>; error?: OpenCodeMessagePayload["error"]; time?: { created?: number } };
  metadata?: Record<string, unknown>;
  model?: { providerID?: string; id?: string };
  finish?: string;
  error?: { type?: string; code?: string; message?: string; status?: number; statusCode?: number; resetAt?: string; reset_at?: string };
  outcome?: "succeeded" | "failed" | "interrupted";
  content?: string | Array<Record<string, unknown>>;
  parts?: Array<Record<string, unknown>>;
}

interface OpenCodeSessionStatus {
  status?: string;
  type?: string;
  needsPermission?: boolean;
  permission?: { id: string; type: string; description: string; toolName?: string; details?: string };
}

interface OpenCodePermissionRequest {
  id: string;
  sessionID?: string;
  action?: string;
  resources?: string[];
  message?: string;
}

interface OpenCodeModelCatalogEntry {
  id?: string;
  modelID?: string;
  providerID?: string;
}

/** Legacy `/provider` catalog shape, still served by OpenCode 1 servers. */
export interface OpenCodeProviderCatalog {
  all?: Array<{ id?: string; models?: Record<string, unknown> | Array<{ id?: string }> }>;
  connected?: string[];
  data?: Array<{ id?: string; activation?: string }>;
}

export interface OpenCodePermissionDetails {
  id: string;
  type: string;
  description: string;
  toolName?: string;
  details?: string;
}

export interface OpenCodeSessionDetail extends HarnessSessionSummary {
  needsPermission: boolean;
  permissionDetails?: OpenCodePermissionDetails;
}

export interface OpenCodeRawTranscript {
  bytes: Uint8Array;
  location: string;
  limitations: string[];
}

export type OpenCodeEvent = {
  kind: string;
  sessionId?: string;
  nativeType?: string;
  messageId?: string;
  permissionId?: string;
  status?: HarnessSessionSummary["status"];
  data?: Record<string, unknown>;
};

export interface OpenCodeTerminalFailureContext {
  status: "failed";
  nativeTurnId: string;
  inputId: string;
  providerId: string;
  modelId: string;
  errorType?: string;
  errorCode?: string;
  errorMessage?: string;
  statusCode?: number;
  resetAt?: string;
}

/** Where a session keeps the identity Agent Herder announced to it. */
export const SESSION_IDENTITY_ENTRY_KEY = "agent.herder.identity";

export interface SessionIdentity {
  /** The name the orchestrator gave this session. */
  name: string;
  sessionId: string;
  harness: string;
  cwd: string;
  /** Where coordination tools live, so the session can answer a human question. */
  herderUrl?: string;
  /** Present when the session continues an existing one. */
  parentSessionId?: string;
}

export interface OpenCodeStatusSnapshot {
  status?: string;
  /** Legacy servers report the same state as `type`. */
  type?: string;
  needsPermission?: boolean;
  permission?: OpenCodePermissionDetails;
}

/** Last resort catalog: what a caller can still try when no catalog endpoint answered. */
const defaultModels = [
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  "anthropic/claude-sonnet-4-20250514",
  "google/gemini-2.5-pro",
  "deepseek/deepseek-chat",
];

const textLimit = 16_384;
const thinkingLimit = 2_048;
const toolOutputLimit = 4_096;
const toolInputLimit = 4_096;

function boundedText(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, limit) : undefined;
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function openCodeMessageRole(message: OpenCodeMessagePayload): string | undefined {
  return stringValue(message.role, message.info?.role, message.metadata?.role, message.type);
}

function openCodeMessageId(message: OpenCodeMessagePayload): string | undefined {
  return stringValue(message.id, message.info?.id);
}

function safeEventError(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim()
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|rk|pk|ghp|glpat|xox[baprs])-[-A-Za-z0-9_]{8,}\b/gi, "[redacted-key]")
    .replace(/(["']?)(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|credential)\1\s*:\s*("[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1$2$1:[redacted]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1[redacted]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .slice(0, 384);
}

export function unwrapEnvelope<T>(value: unknown): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value as T;
  const record = value as Record<string, unknown>;
  if (!("data" in record)) return value as T;
  if (Object.keys(record).filter((key) => key !== "data").some((key) => !["cursor", "location", "durable"].includes(key))) return value as T;
  return record.data as T;
}

function isJsonResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes("json");
}

function isHtmlResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes("text/html");
}

/**
 * OpenCode 2 turns interleave the v2 `/message` list with execution-status
 * frames (`type: "idle"` carrying `outcome`/`error`, no content). They are not
 * conversation messages: mapping them as-role-less records turned Herder's
 * session views into empty assistant bubbles. Conversation record types only.
 */
const openCodeConversationTypes = new Set(["user", "assistant", "system", "tool"]);

function isOpenCodeTurnStatusFrame(message: OpenCodeMessagePayload): boolean {
  if (typeof message.role === "string" || typeof message.info?.role === "string" || typeof message.metadata?.role === "string") return false;
  const type = typeof message.type === "string" ? message.type : "";
  return type.length > 0 && !openCodeConversationTypes.has(type);
}

function openCodeTurnErrorText(message: OpenCodeMessagePayload): string | undefined {
  const message_ = message.error && typeof message.error === "object" ? message.error : undefined;
  if (message_?.message && typeof message_.message === "string") return message_.message.slice(0, toolOutputLimit);
  return undefined;
}

export function openCodeMessageParts(message: OpenCodeMessagePayload): HarnessMessagePart[] {
  const raw = Array.isArray(message.parts)
    ? message.parts
    : Array.isArray(message.content)
      ? message.content
      : typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : [];
  const parts: HarnessMessagePart[] = [];
  for (const part of raw) {
    const type = typeof part.type === "string" ? part.type : "";
    if (type === "text") {
      const text = boundedText(part.text, textLimit);
      if (text) parts.push({ type: "text", text });
      continue;
    }
    if (type === "reasoning" || type === "thinking") {
      const text = boundedText(part.text, thinkingLimit);
      if (text) parts.push({ type: "thinking", text });
      continue;
    }
    if (type !== "tool") continue;
    const state = part.state && typeof part.state === "object" ? part.state as Record<string, unknown> : {};
    const name = typeof part.tool === "string" ? part.tool : typeof part.name === "string" ? part.name : undefined;
    const input = state.input;
    parts.push({ type: "tool_call", name, input: typeof input === "string" ? input.slice(0, toolInputLimit) : input as unknown });
    const errorText = typeof state.error === "string"
      ? state.error
      : state.error && typeof state.error === "object" && typeof (state.error as Record<string, unknown>).message === "string"
        ? (state.error as Record<string, unknown>).message as string
        : "";
    const output = boundedText(state.output, toolOutputLimit) ?? boundedText(errorText, toolOutputLimit);
    if (output) parts.push({ type: "tool_result", name, output, error: errorText.length > 0 });
  }
  if (parts.length === 0 && typeof message.text === "string" && message.text.length > 0) {
    parts.push({ type: "text", text: boundedText(message.text, textLimit)! });
  }
  return parts;
}

export function normalizeOpenCodeEvent(raw: unknown): OpenCodeEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const event = raw as Record<string, unknown>;
  const nativeType = typeof event.type === "string" ? event.type : typeof event.event === "string" ? event.event : "";
  const properties = event.properties && typeof event.properties === "object" ? event.properties as Record<string, unknown> : event;
  const info = properties.info && typeof properties.info === "object" ? properties.info as Record<string, unknown> : undefined;
  const session = properties.session && typeof properties.session === "object" ? properties.session as Record<string, unknown> : undefined;
  const payload = properties.data && typeof properties.data === "object" ? properties.data as Record<string, unknown> : undefined;
  const sessionId = stringValue(
    properties.sessionID, properties.sessionId, properties.session_id,
    info?.sessionID, info?.sessionId, session?.id,
    payload?.sessionID, payload?.sessionId,
    stringValue(payload?.aggregateID),
  );
  const frameLocation = properties.location && typeof properties.location === "object"
    ? properties.location as Record<string, unknown>
    : event.location && typeof event.location === "object" ? event.location as Record<string, unknown> : undefined;
  const directory = stringValue(frameLocation?.directory, session?.directory, session?.path);
  const data: Record<string, unknown> = { nativeType };
  const nativeEventId = stringValue(properties.id, event.id);
  if (nativeEventId) data.nativeEventId = nativeEventId;
  const infoMetadata = info?.metadata && typeof info.metadata === "object" ? info.metadata as Record<string, unknown> : undefined;
  const observedTurnId = stringValue(properties.turnId, properties.turnID, info?.turnId, payload?.turnId);
  const observedInputId = stringValue(properties.inputId, properties.inputID, info?.inputId, payload?.inputId, infoMetadata?.agentHerderInputId);
  if (observedTurnId) data.turnId = observedTurnId;
  if (observedInputId) data.inputId = observedInputId;
  const nativeParentMessageId = stringValue(info?.parentID, properties.parentID);
  if (nativeParentMessageId) data.nativeParentMessageId = nativeParentMessageId;
  if (info?.id) data.nativeMessageId = info.id;
  if (info?.role) data.nativeMessageRole = info.role;
  const infoModel = info?.model && typeof info.model === "object" ? info.model as Record<string, unknown> : undefined;
  const nativeProviderId = stringValue(info?.providerID, infoModel?.providerID);
  const nativeModelId = stringValue(info?.modelID, infoModel?.id);
  if (nativeProviderId) data.nativeProviderId = nativeProviderId;
  if (nativeModelId) data.nativeModelId = nativeModelId;
  const errorValue = payload?.error ?? info?.error ?? properties.error ?? event.error;
  const error = errorValue && typeof errorValue === "object" ? errorValue as Record<string, unknown> : undefined;
  const errorType = stringValue(error?.type, error?.name);
  const errorCode = stringValue(error?.code);
  const errorMessage = safeEventError(typeof errorValue === "string" ? errorValue : error?.message);
  const statusCodeValue = error?.status ?? error?.statusCode ?? payload?.statusCode;
  const statusCode = typeof statusCodeValue === "number" && Number.isInteger(statusCodeValue) ? statusCodeValue : undefined;
  const resetAtValue = stringValue(error?.resetAt, error?.reset_at, payload?.resetAt);
  const resetAt = resetAtValue && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(resetAtValue)
    && Number.isFinite(Date.parse(resetAtValue)) ? new Date(resetAtValue).toISOString() : undefined;
  if (errorType && /^[A-Za-z0-9_.-]{1,96}$/.test(errorType)) data.nativeErrorType = errorType;
  if (errorCode && /^[A-Za-z0-9_.-]{1,96}$/.test(errorCode)) data.nativeErrorCode = errorCode;
  if (errorMessage) data.nativeErrorMessage = errorMessage;
  if (statusCode !== undefined) data.nativeErrorStatus = statusCode;
  if (resetAt) data.nativeErrorResetAt = resetAt;
  if (directory) data.directory = directory;
  const messageId = stringValue(properties.messageID, properties.messageId, info?.id, payload?.messageID, payload?.messageId, payload?.inboxID);
  const inboxId = stringValue(payload?.inboxID, payload?.inboxId);
  if (inboxId) data.nativeInputMessageId = inboxId;
  const permissionId = stringValue(properties.permissionID, properties.permissionId, properties.id, payload?.permissionID, payload?.requestID);
  const statusRaw = stringValue(properties.status, properties.type);
  const status = statusRaw
    ? /busy|running|active/i.test(statusRaw) ? "running"
      : /wait|permission|input/i.test(statusRaw) ? "needs_input"
        : /error|fail/i.test(statusRaw) ? "error"
          : /stop|abort/i.test(statusRaw) ? "stopped" : "idle"
    : undefined;
  return {
    kind: openCodeEventKind(nativeType),
    sessionId,
    nativeType,
    ...(messageId ? { messageId } : {}),
    ...(permissionId ? { permissionId } : {}),
    ...(status ? { status } : {}),
    data,
  };
}

function openCodeEventKind(nativeType: string): string {
  if (/session\.(created|added)/i.test(nativeType)) return "session.created";
  if (/session\.(deleted|removed|closed)/i.test(nativeType)) return "session.deleted";
  if (/session\.(status|updated|idle|busy|error)/i.test(nativeType)) return "session.updated";
  if (/message(\.part)?\.(updated|created|delta|completed|removed)/i.test(nativeType)) return "message.updated";
  if (/session\.inbox\.(enqueued|delivered|rejected)/i.test(nativeType)) return "message.updated";
  if (/session\.execution\.(started|start)/i.test(nativeType)) return "turn.started";
  if (/session\.execution\.(succeeded|completed|finished)/i.test(nativeType)) return "turn.completed";
  if (/session\.execution\.(failed|error|interrupted)/i.test(nativeType)) return "turn.failed";
  if (/permission\.(asked|requested|updated)/i.test(nativeType)) return "permission.requested";
  if (/permission\.(replied|resolved|completed)/i.test(nativeType)) return "permission.resolved";
  if (/turn\.(started|start)/i.test(nativeType)) return "turn.started";
  if (/turn\.(completed|finished|idle)/i.test(nativeType)) return "turn.completed";
  if (/turn\.(failed|error)/i.test(nativeType)) return "turn.failed";
  if (/model\.(changed|updated)/i.test(nativeType)) return "model.changed";
  return "unknown";
}

/** Connected providers of a legacy `/provider` catalog, including v2's activation flag. */
export function openCodeConnectedProviders(catalog: OpenCodeProviderCatalog): Set<string> {
  const connected = new Set((catalog.connected ?? []).filter((value): value is string => typeof value === "string" && value.length > 0));
  for (const provider of catalog.data ?? []) {
    if (typeof provider.id !== "string" || !provider.id) continue;
    if (provider.activation === undefined || provider.activation === "enabled" || provider.activation === "connected") connected.add(provider.id);
  }
  return connected;
}

export function openCodeConnectedModels(catalog: OpenCodeProviderCatalog): string[] {
  const connected = openCodeConnectedProviders(catalog);
  const models: string[] = [];
  for (const provider of catalog.all ?? []) {
    const providerId = typeof provider.id === "string" ? provider.id.trim() : "";
    if (!providerId || (connected.size > 0 && !connected.has(providerId))) continue;
    const ids = Array.isArray(provider.models)
      ? provider.models.map((model) => typeof model?.id === "string" ? model.id.trim() : "")
      : Object.keys(provider.models ?? {});
    for (const id of ids) if (id) models.push(`${providerId}/${id}`);
  }
  return [...new Set(models)];
}

export function openCodeModelCatalogEntries(entries: OpenCodeModelCatalogEntry[]): string[] {
  const models: string[] = [];
  for (const entry of entries) {
    const provider = typeof entry?.providerID === "string" ? entry.providerID.trim() : "";
    const model = typeof entry?.modelID === "string" && entry.modelID.trim() ? entry.modelID.trim() : typeof entry?.id === "string" ? entry.id.trim() : "";
    if (provider && model) models.push(`${provider}/${model}`);
  }
  return [...new Set(models)];
}

export function parseOpenCodeServerCommand(commandLine: string): string | undefined {
  const port = commandLine.match(/(?:^|[\s\0])--port(?:=|[\s\0]+)(\d+)/)?.[1];
  if (!port) return undefined;
  const hostname = commandLine.match(/(?:^|[\s\0])--hostname(?:=|[\s\0]+)([^\s\0]+)/)?.[1] || "127.0.0.1";
  return `http://${hostname === "0.0.0.0" ? "127.0.0.1" : hostname}:${port}`;
}

function discoverServerUrl(pid: string | undefined): string | undefined {
  if (!pid || !/^\d+$/.test(pid)) return undefined;
  try {
    return parseOpenCodeServerCommand(readFileSync(`/proc/${pid}/cmdline`, "utf8"));
  } catch {
    return undefined;
  }
}

export interface OpenCodeCreateRequest {
  title: string;
  cwd: string;
  model?: string;
  fullAccess?: boolean;
}

export class OpenCodeClient implements HarnessClient {
  readonly kind = "opencode" as const;
  private baseUrl: string;
  private headers: Record<string, string> = {};
  private apiPrefix = "";
  private protocolProbed = false;
  private readonly pinnedProtocol?: "v1" | "v2";
  private readonly directories = new Map<string, string>();

  constructor(options: HarnessClientOptions & { baseUrl?: string } = {}) {
    this.baseUrl = options.baseUrl
      || process.env.OPENCODE_URL
      || discoverServerUrl(process.env.OPENCODE_PID)
      || "http://127.0.0.1:4096";
    const password = options.password ?? process.env.OPENCODE_SERVER_PASSWORD;
    const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
    if (password) this.headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    if (options.protocol === "v1" || options.protocol === "v2") this.pinnedProtocol = options.protocol;
  }

  /** True once the server answered as an OpenCode 2 (`/api`) instance. */
  get isV2(): boolean {
    return this.apiPrefix === "/api";
  }

  async init(): Promise<void> {
    await this.probeProtocol();
    const res = await this.fetch(this.isV2 ? this.api("/config") : "/global/health");
    if (!res.ok) throw new Error(`OpenCode ${this.baseUrl} is not reachable: HTTP ${res.status}${await this.errorHint(res)}`);
  }

  async listSessions(options: { cwd?: string; limit?: number } = {}): Promise<HarnessSessionSummary[]> {
    await this.probeProtocol();
    const params = new URLSearchParams();
    if (options.cwd) params.set("directory", options.cwd);
    if (this.isV2) {
      params.set("order", "desc");
      params.set("limit", String(Math.max(1, Math.min(options.limit ?? 100, 500))));
    }
    const query = params.toString() ? `?${params.toString()}` : "";
    const sessions = await this.fetchJson<OpenCodeSessionPayload[]>(this.api(`/session${query}`));
    const statuses = await this.readStatuses(options.cwd);
    return sessions.map((session) => this.toSummary(session, statuses[session.id]));
  }

  async getSession(id: string): Promise<OpenCodeSessionDetail | null> {
    await this.probeProtocol();
    let session: OpenCodeSessionPayload;
    try {
      session = await this.fetchJson<OpenCodeSessionPayload>(this.api(`/session/${encodeURIComponent(id)}`));
    } catch {
      const all = await this.listSessions({ limit: 200 });
      const found = all.find((item) => item.id === id);
      return found ? { ...found, needsPermission: false } : null;
    }
    const statuses = await this.readStatuses(this.directoryOf(session));
    return this.toSummary(session, statuses[id]);
  }

  async createSession(request: OpenCodeCreateRequest): Promise<HarnessSessionSummary> {
    await this.probeProtocol();
    const separator = request.model?.indexOf("/") ?? -1;
    const model = separator > 0
      ? { providerID: request.model!.slice(0, separator), id: request.model!.slice(separator + 1) }
      : undefined;
    if (this.isV2) {
      const session = await this.fetchJson<OpenCodeSessionPayload>(this.api("/session"), {
        method: "POST",
        body: JSON.stringify({
          title: request.title,
          location: { directory: request.cwd },
          ...(model ? { model } : {}),
          ...(request.fullAccess ? { permissions: [{ action: "*", resource: "*", effect: "allow" }] } : {}),
        }),
      });
      return this.toSummary(session);
    }
    const query = new URLSearchParams({ directory: request.cwd });
    const session = await this.fetchJson<OpenCodeSessionPayload>(`/session?${query.toString()}`, {
      method: "POST",
      body: JSON.stringify({ title: request.title, ...(model ? { model } : {}), ...(request.fullAccess ? { permission: [{ permission: "*", pattern: "*", action: "allow" }] } : {}) }),
    });
    return this.toSummary(session);
  }

  async getMessages(id: string, limit = 3): Promise<HarnessMessage[] | null> {
    await this.probeProtocol();
    try {
      const bounded = Math.max(1, Math.min(limit, 50));
      // v2 interleaves execution-status frames with real messages, so overfetch
      // and drop them before the bounded slice keeps the requested window real.
      const fetchLimit = this.isV2 ? bounded * 3 : bounded;
      const endpoint = this.isV2
        ? this.api(`/session/${encodeURIComponent(id)}/message?limit=${fetchLimit}&order=desc`)
        : this.api(`/session/${encodeURIComponent(id)}/message?limit=${bounded}`);
      const messages = await this.fetchJson<OpenCodeMessagePayload[]>(endpoint);
      if (!Array.isArray(messages)) return null;
      const ordered = this.isV2 ? [...messages].reverse() : messages;
      const conversation = this.isV2 ? ordered.filter((message) => !isOpenCodeTurnStatusFrame(message)).slice(-bounded) : ordered.slice(-bounded);
      if (conversation.length === 0 && this.isV2) {
        // Status frames only: do not invent fake assistant bubbles. Surface an
        // explicit turn failure when the window carries one, otherwise the
        // history is unavailable.
        const failed = [...ordered].reverse().find((message) => isOpenCodeTurnStatusFrame(message) && message.error?.message);
        if (!failed) return null;
        return [{
          id: failed.id || `${id}:turn-status`,
          role: "assistant",
          ...{ text: `Ошибка хода: ${failed.error!.message!.slice(0, textLimit)}` },
          parts: [],
        }];
      }
      return conversation.map((message, index) => {
        const parts = openCodeMessageParts(message);
        const info = message.info || {};
        const nativeRole = message.role || info.role || message.type;
        const role = nativeRole === "user" || nativeRole === "system"
          ? nativeRole
          : nativeRole === "tool" || (parts.length > 0 && parts.every((part) => part.type === "tool_result")) ? "tool" : "assistant";
        const text = parts.filter((part) => part.type === "text" || part.type === "thinking").map((part) => part.text || "").join("\n").trim() || undefined;
        // A failed v2 assistant turn persists as an empty assistant record with
        // `finish: "error"` and the provider error attached; show the cause
        // instead of a silently empty response.
        const turnError = text ? undefined : openCodeTurnErrorText(message);
        const shownText = text ?? (turnError ? `Ошибка хода: ${turnError}` : undefined);
        const model = message.model?.providerID && message.model?.id
          ? `${message.model.providerID}/${message.model.id}`
          : info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : undefined;
        return {
          id: message.id || info.id || `${id}:message-${index + 1}`,
          role,
          ...(model ? { model } : {}),
          ...(typeof info.time?.created === "number" ? { timestamp: new Date(info.time.created).toISOString() } : {}),
          ...(shownText ? { text: shownText } : {}),
          parts,
        };
      });
    } catch {
      return null;
    }
  }

  /**
   * Read the exact v2 terminal failure represented by one native event. The
   * event ID must still be the newest persisted failed status frame, the
   * session must be terminal and permission-free, and the failed assistant
   * message must identify its provider/model. Older v1 APIs cannot prove this
   * correlation and intentionally return no evidence.
   */
  async getTerminalFailureContext(
    id: string,
    terminalEventId?: string,
    observedTurnId?: string,
    observedInputId?: string,
  ): Promise<OpenCodeTerminalFailureContext | null> {
    await this.probeProtocol();
    if (!this.isV2) return null;
    try {
      const session = await this.fetchJson<OpenCodeSessionPayload>(this.api(`/session/${encodeURIComponent(id)}`));
      if (session.id !== id || session.outcome !== "failed") return null;
      const [active, permissions] = await Promise.all([
        this.fetchJson<Record<string, { type?: string; status?: string }>>(this.api("/session/active")),
        this.fetchJson<OpenCodePermissionRequest[]>(this.api("/permission/request")),
      ]);
      if (!active || typeof active !== "object" || Array.isArray(active) || !Array.isArray(permissions)) return null;
      const activeType = active[id]?.type ?? active[id]?.status;
      if ((activeType !== undefined && activeType !== "idle") || permissions.some((request) => request?.sessionID === id)) return null;

      const fetched = await this.fetchJson<OpenCodeMessagePayload[]>(this.api(`/session/${encodeURIComponent(id)}/message?limit=150&order=desc`));
      if (!Array.isArray(fetched)) return null;
      const messages = [...fetched].reverse();
      const statusFrames = messages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => isOpenCodeTurnStatusFrame(message));
      const latest = statusFrames.at(-1);
      if (!latest || !latest.message.id || (terminalEventId && latest.message.id !== terminalEventId) || latest.message.outcome !== "failed") return null;
      if (messages.slice(latest.index + 1).some((message) =>
        openCodeMessageRole(message) === "user" || openCodeMessageRole(message) === "assistant")) return null;
      const user = messages
        .map((message, index) => ({ message, index }))
        .filter(({ message, index }) => index < latest.index && openCodeMessageRole(message) === "user")
        .at(-1);
      if (!user) return null;
      const statusMetadata = latest.message.metadata ?? latest.message.info?.metadata;
      const userMetadata = user.message.metadata ?? user.message.info?.metadata;
      const sessionProofNamespace = session.metadata?.agentHerder;
      const sessionProof = sessionProofNamespace && typeof sessionProofNamespace === "object" && !Array.isArray(sessionProofNamespace)
        ? (sessionProofNamespace as Record<string, unknown>).quotaFailure as Record<string, unknown> | undefined
        : undefined;
      const persistedInputId = stringValue(latest.message.inputId, latest.message.info?.inputId, statusMetadata?.agentHerderInputId);
      const userInputId = stringValue(user.message.inputId, user.message.info?.inputId, userMetadata?.agentHerderInputId);
      const proofInputId = typeof sessionProof?.inputId === "string" ? sessionProof.inputId : undefined;
      const knownInputIds = [persistedInputId, observedInputId, userInputId, proofInputId].filter((value): value is string => Boolean(value));
      if (new Set(knownInputIds).size > 1) return null;
      const inputId = stringValue(persistedInputId, observedInputId, userInputId, proofInputId);
      if (!inputId) return null;
      const persistedTurnId = stringValue(latest.message.turnId, latest.message.info?.turnId, statusMetadata?.turnId);
      if (persistedTurnId && observedTurnId && persistedTurnId !== observedTurnId) return null;

      const failedAssistant = messages
        .map((message, index) => ({ message, index }))
        .filter(({ message, index }) => index > user.index && index < latest.index
          && openCodeMessageRole(message) === "assistant")
        .at(-1)?.message;
      if (!failedAssistant || (!failedAssistant.error && !failedAssistant.info?.error && failedAssistant.finish !== "error" && !latest.message.error
        && sessionProof?.assistantMessageId !== openCodeMessageId(failedAssistant))) return null;
      const userMessageId = openCodeMessageId(user.message);
      const assistantMessageId = openCodeMessageId(failedAssistant);
      if (!userMessageId || !assistantMessageId) return null;
      const proofLinked = sessionProof?.status === "failed"
        && sessionProof.userMessageId === userMessageId
        && sessionProof.parentMessageId === userMessageId
        && sessionProof.assistantMessageId === assistantMessageId
        && sessionProof.nativeTurnId === assistantMessageId
        && sessionProof.inputId === inputId;
      const assistantMetadata = failedAssistant.metadata ?? failedAssistant.info?.metadata;
      const assistantInputId = stringValue(failedAssistant.inputId, failedAssistant.info?.inputId, assistantMetadata?.agentHerderInputId);
      if (assistantInputId && assistantInputId !== inputId) return null;
      const assistantParentId = stringValue(failedAssistant.parentID, failedAssistant.info?.parentID, assistantMetadata?.parentID);
      // OpenCode's assistant message is the native turn identity when this
      // transcript does not expose a turnId, but only with an exact parent
      // link to the submitted user message. A status-frame ID is never a turn ID.
      const parentLinked = assistantParentId === userMessageId;
      const inputLinked = assistantInputId === inputId
        && (persistedInputId === inputId || observedInputId === inputId);
      if (!parentLinked && !inputLinked && !proofLinked) return null;
      const assistantTurnId = stringValue(failedAssistant.turnId, failedAssistant.info?.turnId, assistantMetadata?.turnId);
      if (persistedTurnId && assistantTurnId && persistedTurnId !== assistantTurnId) return null;
      if (observedTurnId && assistantTurnId && observedTurnId !== assistantTurnId) return null;
      const nativeTurnId = stringValue(persistedTurnId, observedTurnId, assistantTurnId,
        proofLinked && typeof sessionProof.nativeTurnId === "string" ? sessionProof.nativeTurnId : undefined,
        assistantMessageId);
      if (!nativeTurnId) return null;
      const model = failedAssistant.model?.providerID && failedAssistant.model.id
        ? { providerId: failedAssistant.model.providerID, modelId: failedAssistant.model.id }
        : failedAssistant.info?.providerID && failedAssistant.info.modelID
          ? { providerId: failedAssistant.info.providerID, modelId: failedAssistant.info.modelID }
          : proofLinked && typeof sessionProof.providerId === "string" && typeof sessionProof.modelId === "string"
            ? { providerId: sessionProof.providerId, modelId: sessionProof.modelId }
            : undefined;
      if (!model?.providerId || !model.modelId) return null;
      if (proofLinked && (sessionProof.providerId !== model.providerId || sessionProof.modelId !== model.modelId)) return null;
      const error = latest.message.error ?? failedAssistant.error ?? failedAssistant.info?.error;
      const errorMessage = safeEventError(error?.message);
      const errorType = typeof error?.type === "string" && /^[A-Za-z0-9_.-]{1,96}$/.test(error.type) ? error.type : undefined;
      const errorCode = typeof error?.code === "string" && /^[A-Za-z0-9_.-]{1,96}$/.test(error.code) ? error.code : undefined;
      const statusCodeValue = error?.status ?? error?.statusCode;
      const statusCode = typeof statusCodeValue === "number" && Number.isInteger(statusCodeValue) ? statusCodeValue : undefined;
      const resetAtValue = (error as Record<string, unknown> | undefined)?.resetAt
        ?? (error as Record<string, unknown> | undefined)?.reset_at;
      const resetAt = typeof resetAtValue === "string"
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(resetAtValue)
        && Number.isFinite(Date.parse(resetAtValue))
        ? new Date(resetAtValue).toISOString()
        : undefined;
      return {
        status: "failed", nativeTurnId, inputId, ...model,
        ...(errorType ? { errorType } : {}),
        ...(errorCode ? { errorCode } : {}),
        ...(errorMessage ? { errorMessage } : {}),
        ...(statusCode !== undefined ? { statusCode } : {}),
        ...(resetAt ? { resetAt } : {}),
        ...(proofLinked && typeof sessionProof.errorCode === "string" ? { errorCode: sessionProof.errorCode } : {}),
        ...(proofLinked && typeof sessionProof.errorMessage === "string" ? { errorMessage: sessionProof.errorMessage } : {}),
        ...(proofLinked && typeof sessionProof.statusCode === "number" ? { statusCode: sessionProof.statusCode } : {}),
      };
    } catch {
      return null;
    }
  }

  async send(id: string, request: HarnessSendRequest): Promise<HarnessSendResult> {
    await this.probeProtocol();
    if (!this.isV2) {
      // Legacy servers admit a queued input at `prompt_async` and a direct one
      // through `message`; they have no inbox and no steer.
      try {
        const path = request.delivery === "queue" ? `/session/${id}/prompt_async` : `/session/${id}/message`;
        const res = await this.fetch(path, {
          method: "POST",
          body: JSON.stringify({ parts: [{ type: "text", text: request.message }] }),
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        return request.delivery === "queue" ? { ok: true, admitted: true } : { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    try {
      const res = await this.fetch(this.api(`/session/${encodeURIComponent(id)}/prompt`), {
        method: "POST",
        body: JSON.stringify({
          text: request.message,
          delivery: request.delivery,
          ...(request.inputId ? { metadata: { agentHerderInputId: request.inputId } } : {}),
        }),
      });
      if (res.ok) {
        const body = await res.json().catch(() => undefined) as unknown;
        const receipt = unwrapEnvelope<Record<string, unknown>>(body);
        const nativeInputMessageId = typeof receipt?.id === "string" && /^msg_[A-Za-z0-9]+$/.test(receipt.id)
          ? receipt.id
          : undefined;
        return { ok: true, admitted: true, ...(nativeInputMessageId ? { nativeInputMessageId } : {}) };
      }
      const hint = await this.errorHint(res);
      return { ok: false, error: `HTTP ${res.status}${hint}` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async waitForIdle(id: string, signal?: AbortSignal): Promise<void> {
    await this.probeProtocol();
    const wait = this.isV2
      ? await this.fetch(this.api(`/experimental/session/${encodeURIComponent(id)}/wait`), { method: "POST", signal })
      : await this.fetch(`/session/${id}/wait`, { method: "POST", signal });
    if (!wait.ok && wait.status !== 404) throw new Error(`OpenCode wait failed: HTTP ${wait.status}${await this.errorHint(wait)}`);
  }

  async interrupt(id: string): Promise<{ ok: boolean; error?: string }> {
    await this.probeProtocol();
    if (this.isV2) {
      const res = await this.fetch(this.api(`/session/${encodeURIComponent(id)}/interrupt`), { method: "POST" });
      return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}${await this.errorHint(res)}` };
    }
    const res = await this.fetch(`/session/${id}/interrupt`, { method: "POST" });
    if (res.ok) return { ok: true };
    if (res.status !== 404) return { ok: false, error: `HTTP ${res.status}` };
    const abort = await this.fetch(`/session/${id}/abort`, { method: "POST" });
    return abort.ok ? { ok: true } : { ok: false, error: `HTTP ${abort.status}` };
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
    // `/provider` exposes connected providers and their current model IDs on v1.
    try {
      const models = openCodeConnectedModels(await this.fetchJson<OpenCodeProviderCatalog>(this.api("/provider")));
      if (models.length > 0) return models;
    } catch { /* fall through to the config catalog */ }
    try {
      const config = await this.fetchJson<{ model?: string; models?: string[] }>(this.api("/config"));
      if (config.models?.length) return config.models;
      if (config.model) return [config.model];
    } catch { /* an unreadable catalog must not fabricate availability */ }
    return [...defaultModels];
  }

  subscribe(
    onEvent: (event: OpenCodeEvent) => void,
    hooks: { onConnected?: () => void; onDisconnected?: (error?: string) => void } = {},
  ): () => void {
    const controller = new AbortController();
    void this.consumeEvents(controller.signal, onEvent, hooks);
    return () => controller.abort();
  }

  // ---- protocol capabilities Herder orchestrates on top of ----

  async listChildren(id: string): Promise<HarnessSessionSummary[]> {
    await this.probeProtocol();
    if (this.isV2) {
      const children = await this.fetchJson<OpenCodeSessionPayload[]>(this.api(`/session?parentID=${encodeURIComponent(id)}&order=asc`));
      return children.map((child) => this.toSummary(child));
    }
    const children = await this.fetchJson<OpenCodeSessionPayload[]>(`/session/${encodeURIComponent(id)}/children`);
    return children.map((child) => this.toSummary(child));
  }

  async forkSession(id: string, message?: string): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
    await this.probeProtocol();
    try {
      const child = await this.fetchJson<OpenCodeSessionPayload>(this.api(`/session/${encodeURIComponent(id)}/fork`), { method: "POST", body: JSON.stringify({}) });
      if (message) {
        const sent = await this.send(child.id, { message, delivery: "queue" });
        if (!sent.ok) return { ok: false, sessionId: child.id, error: sent.error };
      }
      return { ok: true, sessionId: child.id };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async respondPermission(sessionId: string, permissionId: string, response: "allow" | "deny", remember?: boolean): Promise<{ ok: boolean; error?: string }> {
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

  async setPermissions(sessionId: string, options: { allowedTools?: string; mode?: string }): Promise<{ ok: boolean; error?: string }> {
    await this.probeProtocol();
    if (this.isV2) {
      const rules: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }> = [];
      if (options.allowedTools) {
        for (const tool of options.allowedTools.split(",").map((value) => value.trim()).filter(Boolean)) {
          rules.push({ action: tool, resource: "*", effect: "allow" });
        }
      }
      if (options.mode) rules.push({ action: "*", resource: "*", effect: options.mode === "plan" || options.mode === "default" ? "ask" : "allow" });
      if (rules.length === 0) return { ok: true };
      const res = await this.fetch(this.api(`/session/${encodeURIComponent(sessionId)}`), {
        method: "PATCH",
        body: JSON.stringify({ permissions: rules }),
      });
      return { ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}${await this.errorHint(res)}` };
    }
    const updates: Record<string, unknown> = {};
    if (options.allowedTools) updates.allowedTools = options.allowedTools.split(",").map((value) => value.trim());
    if (options.mode) updates.permissionMode = options.mode;
    const directory = await this.resolveDirectory(sessionId);
    const query = directory ? `?${new URLSearchParams({ directory })}` : "";
    const res = await this.fetch(`/config${query}`, { method: "PATCH", body: JSON.stringify(updates) });
    return { ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };
  }

  async changeModel(sessionId: string, model: string): Promise<{ ok: boolean; error?: string }> {
    const separator = model.indexOf("/");
    const providerID = separator > 0 ? model.slice(0, separator) : "";
    const modelID = separator > 0 ? model.slice(separator + 1) : "";
    if (!providerID || !modelID) return { ok: false, error: "Model must use the provider/model format" };
    try {
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

  async getRawTranscript(id: string, signal?: AbortSignal): Promise<OpenCodeRawTranscript | null> {
    try {
      const directory = await this.resolveDirectory(id);
      const query = new URLSearchParams({ limit: "200", ...(directory && !this.isV2 ? { directory } : {}) });
      const endpoint = this.api(`/session/${encodeURIComponent(id)}/message?${query}`);
      const messages = await this.fetchJson<unknown[]>(endpoint, { signal });
      if (!Array.isArray(messages)) return null;
      return {
        bytes: Buffer.from(JSON.stringify(messages, null, 2)),
        location: `${this.baseUrl}${endpoint}`,
        limitations: ["OpenCode message API was fetched with limit=200; pagination has not been verified."],
      };
    } catch {
      return null;
    }
  }

  /**
   * Identity of the live turn, or null when the session is not executing one.
   * Herder uses it to guarantee a coordination message lands in the running turn
   * and never in a later one.
   */
  async getActiveTurnId(id: string): Promise<string | null> {
    await this.probeProtocol();
    const directory = await this.resolveDirectory(id);
    if (!directory) return null;
    // One cold directory read, then the three independent reads in parallel:
    // the caller's deadline must not grow with the number of native endpoints.
    const [messages, session, statuses] = await Promise.all([
      this.fetchJson<OpenCodeMessagePayload[]>(
        this.isV2
          ? this.api(`/session/${encodeURIComponent(id)}/message?limit=10&type=user&order=desc`)
          : `/session/${encodeURIComponent(id)}/message?directory=${encodeURIComponent(directory)}&limit=50`,
      ),
      this.fetchJson<OpenCodeSessionPayload>(this.api(`/session/${encodeURIComponent(id)}`)),
      this.readStatuses(directory),
    ]);
    if (session.id !== id || this.directoryOf(session) !== directory || !Array.isArray(messages)) return null;
    const status = statuses[id];
    if (this.mapStatus(status?.status ?? status?.type) !== "running" || status?.needsPermission || status?.permission) return null;
    const user = this.isV2
      ? messages.find((message) => message.type === "user" && typeof message.id === "string")
      : [...messages].reverse().find((message) => (message.info?.role || message.role) === "user");
    if (!user) return null;
    if (!this.isV2 && user.info?.sessionID && user.info.sessionID !== id) return null;
    const identity = this.isV2 ? user.id : user.info?.id;
    return typeof identity === "string" && identity ? identity : null;
  }

  /**
   * Tell a session who it is.
   *
   * OpenCode 2 attaches per-session instruction entries to the session's own
   * instructions, so the identity reaches the agent from its very first turn
   * instead of having to be repeated in every prompt. An absent entry is not an
   * error for callers that only wanted a best effort.
   */
  async announceIdentity(sessionId: string, identity: SessionIdentity): Promise<boolean> {
    await this.probeProtocol();
    const value: SessionIdentity = { ...identity, sessionId: identity.sessionId || sessionId };
    if (this.isV2) {
      const res = await this.fetch(
        this.api(`/experimental/session/${encodeURIComponent(sessionId)}/instructions/entries/${SESSION_IDENTITY_ENTRY_KEY}`),
        { method: "PUT", body: JSON.stringify({ value }) },
      );
      return res.ok;
    }
    return false;
  }

  /** Working directory of a native session, as the server records it. */
  async resolveDirectory(id: string): Promise<string | undefined> {
    if (!this.directories.has(id)) {
      try {
        await this.fetchJson<OpenCodeSessionPayload>(this.api(`/session/${encodeURIComponent(id)}`));
      } catch { /* unreadable session: no directory to add */ }
    }
    return this.directories.get(id);
  }

  // ---- internals ----

  private api(path: string): string {
    return `${this.apiPrefix}${path}`;
  }

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
    this.apiPrefix = v1.ok ? "" : "/api";
  }

  private async readStatuses(directory?: string): Promise<Record<string, OpenCodeStatusSnapshot>> {
    if (this.isV2) {
      const [active, permissions] = await Promise.all([
        this.fetchJson<Record<string, { type?: string; status?: string }>>(this.api("/session/active")).catch(() => ({})),
        this.fetchJson<OpenCodePermissionRequest[]>(this.api("/permission/request")).catch(() => []),
      ]);
      const statuses: Record<string, OpenCodeStatusSnapshot> = {};
      for (const [id, entry] of Object.entries(active ?? {})) {
        const raw = entry?.type || entry?.status;
        statuses[id] = { status: raw === "running" ? "running" : raw === "idle" ? "idle" : raw, type: raw };
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
            ...(request.action ? { toolName: request.action } : {}),
            ...(request.resources?.length ? { details: request.resources.join(", ") } : {}),
          },
        };
      }
      return statuses;
    }
    const query = directory ? `?${new URLSearchParams({ directory })}` : "";
    const response = await this.fetch(`/session/status${query}`);
    if (response.status === 404) return {};
    if (!response.ok) throw new Error(`OpenCode status read failed: HTTP ${response.status}`);
    return unwrapEnvelope<Record<string, OpenCodeStatusSnapshot>>(await response.json()) ?? {};
  }

  private directoryOf(session: OpenCodeSessionPayload): string | undefined {
    return session.location?.directory || session.directory || session.path || undefined;
  }

  private toSummary(session: OpenCodeSessionPayload, status?: OpenCodeStatusSnapshot): OpenCodeSessionDetail {
    const directory = this.directoryOf(session);
    if (directory) this.directories.set(session.id, directory);
    return {
      id: session.id,
      harness: "opencode",
      title: session.title || "Untitled session",
      cwd: directory || process.cwd(),
      lastActivity: this.timestamp(session.time?.updated, session.time?.created),
      ...(this.modelName(session.model) ? { model: this.modelName(session.model) } : {}),
      status: this.mapStatus(status?.status ?? status?.type, session.outcome),
      ...(session.parentID ? { parentId: session.parentID } : {}),
      ...(typeof session.cost === "number" ? { costUsd: session.cost } : {}),
      needsPermission: status?.needsPermission === true || !!status?.permission,
      ...(status?.permission ? { permissionDetails: status.permission } : {}),
    };
  }

  private modelName(model: OpenCodeSessionPayload["model"]): string | undefined {
    if (typeof model === "string") return model;
    if (model?.providerID && model.id) return `${model.providerID}/${model.id}`;
    return model?.id;
  }

  private mapStatus(raw?: string, outcome?: OpenCodeSessionPayload["outcome"]): HarnessSessionSummary["status"] {
    if (raw === "running" || raw === "retry" || raw === "busy") return "running";
    if (raw === "waiting") return "needs_input";
    return outcome === "failed" ? "error" : "idle";
  }

  private timestamp(...values: Array<number | undefined>): string {
    const value = values.find((candidate) => candidate !== undefined);
    return typeof value === "number" ? new Date(value).toISOString() : new Date(0).toISOString();
  }

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
    const matchedId = match?.[1];
    if (matchedId && matchedId !== "status" && !this.isV2 && !url.searchParams.has("directory")) {
      const id = decodeURIComponent(matchedId);
      const directLookup = url.pathname === `/session/${matchedId}` && (!init?.method || init.method === "GET");
      const directory = directLookup ? this.directories.get(id) : await this.resolveDirectory(id);
      if (directory) url.searchParams.set("directory", directory);
    }
    const response = await this.rawFetch(url.toString().slice(this.baseUrl.length), init);
    if (!this.pinnedProtocol && isHtmlResponse(response)) {
      const bare = path.startsWith("/api/") ? path.slice("/api".length) : path;
      const retargeted: string = this.apiPrefix === "/api" ? `/api${bare}` : bare;
      if (retargeted !== path) {
        const retry = await this.rawFetch(retargeted, init);
        this.apiPrefix = retargeted.startsWith("/api") ? "/api" : "";
        return retry;
      }
    }
    return response;
  }

  private async rawFetch(path: string, init?: RequestInit): Promise<Response> {
    return fetch(new URL(`${this.baseUrl}${path}`), {
      ...init,
      headers: { "Content-Type": "application/json", ...this.headers, ...(init?.headers as Record<string, string> | undefined) },
    });
  }

  private async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetch(path, init);
    if (!res.ok) throw new Error(`OpenCode API ${path}: HTTP ${res.status}${await this.errorHint(res)}`);
    const value = await res.json();
    const unwrapped = this.isV2 ? unwrapEnvelope(value) : value;
    if (Array.isArray(unwrapped)) unwrapped.forEach((item) => this.remember(item));
    else this.remember(unwrapped);
    return unwrapped as T;
  }

  private remember(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const session = value as OpenCodeSessionPayload;
    const directory = this.directoryOf(session);
    if (typeof session.id === "string" && directory) this.directories.set(session.id, directory);
  }

  private async consumeEvents(
    signal: AbortSignal,
    onEvent: (event: OpenCodeEvent) => void,
    hooks: { onConnected?: () => void; onDisconnected?: (error?: string) => void } = {},
  ): Promise<void> {
    let backoffMs = 500;
    await this.probeProtocol();
    while (!signal.aborted) {
      try {
        const response = await this.fetch(this.api("/event"), { signal });
        if (!response.ok || !response.body) throw new Error(`OpenCode event stream HTTP ${response.status}`);
        hooks.onConnected?.();
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
            try { onEvent(normalizeOpenCodeEvent(JSON.parse(data))!); } catch { /* malformed frame */ }
          }
        }
        try { await reader.cancel(); } catch { /* already closed */ }
        if (!signal.aborted) hooks.onDisconnected?.("OpenCode event stream closed");
      } catch (error) {
        if (signal.aborted) break;
        hooks.onDisconnected?.(error instanceof Error ? error.message : String(error));
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
}

/** Stable fingerprint of one session's observable state, used by callers for staleness checks. */
export function openCodeSnapshotFingerprint(sessionId: string, messages: unknown): string {
  return createHash("sha256").update(JSON.stringify([sessionId, messages])).digest("hex");
}
