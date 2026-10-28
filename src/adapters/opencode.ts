import {readOpenCodeActiveSessions} from "./opencode-active.js";
import { currentTurnContextReceipt, previousCoordinationReceipt, reserveCurrentTurnContext } from "../coordination-active-delivery.js";
import { deferredMessages } from "../deferred-messages.js";
import { getHumanStopStore } from "../human-stop-store.js";
import {
  OpenCodeClient,
  normalizeOpenCodeEvent,
  parseOpenCodeServerCommand,
  unwrapEnvelope,
  type OpenCodeEvent,
  type OpenCodeModelCatalogEntry,
} from "agent-resume-mcp";
import { HarnessAdapter, AgentSession, ControlResult, CreateSessionOptions, HarnessCapabilities, HarnessEvent, HarnessPermissionState, ListSessionsOptions, RawTranscriptExport, SendMessageOptions, SendMessageResult, SetPermissionsOptions, SessionMessagePart, SessionMessageView, localSessionHostId } from "../types/index.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { throwIfAborted } from "../abort-utils.js";
import { terminalQuotaFailure, normalizeSendAdmission } from "./quota-failure.js";
import type { IntegratorHarness, IntegratorSessionBindingStore } from "../integrator-session-binding.js";

export { normalizeOpenCodeEvent, openCodeConnectedModels, openCodeMessageParts, openCodeModelCatalogEntries, parseOpenCodeServerCommand, unwrapEnvelope } from "agent-resume-mcp";
export type { OpenCodeEvent, OpenCodeModelCatalogEntry } from "agent-resume-mcp";

/**
 * Rows a name search may return before the answer stops being complete.
 *
 * OpenCode 2 answers a text search over the whole catalog of one directory,
 * so the window has to cover that catalog: the busiest workspace already
 * holds more than two thousand sessions, and a search also matches the bodies
 * of the messages.
 */
const NAMED_SEARCH_LIMIT = 5000;

/** The bounded listing used when the server cannot answer a name search. */
const NAMED_SEARCH_LISTING_LIMIT = 500;

/** A row of the OpenCode 2 session index, as the name search answers it. */
type NamedSessionRow = { id?: string; title?: string; time?: { archived?: number | boolean } };

/**
 * True when a raw session row carries an archive timestamp.
 *
 * The archive state lives in `time.archived` of the session payload. A row
 * without that field is treated as live: the field is missing on servers that
 * do not report it, and a live session must never be dropped because of an
 * incomplete answer.
 */
function isArchivedRow(row: NamedSessionRow): boolean {
  const archived = row.time?.archived;
  if (typeof archived === "number") return archived > 0;
  return archived === true;
}

/**
 * The URL of the running OpenCode server.
 *
 * The core client resolves it the same way, so both talk to one server even
 * when it is not published under a fixed address.
 */
function resolveOpenCodeBaseUrl(configured?: string): string {
  return configured?.trim()
    || process.env.OPENCODE_URL?.trim()
    || discoverOpenCodeServerUrl(process.env.OPENCODE_PID)
    || "http://127.0.0.1:4096";
}

function discoverOpenCodeServerUrl(pid: string | undefined): string | undefined {
  if (!pid || !/^\d+$/u.test(pid)) return undefined;
  try {
    return parseOpenCodeServerCommand(readFileSync(`/proc/${pid}/cmdline`, "utf8"));
  } catch {
    return undefined;
  }
}

/** The durable reservation one integrator operation handed to this adapter. */
export interface OpenCodeIntegratorReservation {
  operationId: string;
  attempt: number;
  inputId: string;
  hostId: string;
  /** The harness the operation was reserved for. The receipt names it. */
  harness: IntegratorHarness;
}

export interface OpenCodeProviderLeaf {
  providerId: string;
  modelId: string;
}

export interface OpenCodeModelProviderResolution {
  nativeHarness: "opencode";
  nativeModelId: string;
  providerId: string;
  modelId: string;
  resolvedProviderLeaves: OpenCodeProviderLeaf[];
}

export interface OpenCodeModelProviderResolverOptions {
  /** Optional explicit OmniRoute origin; defaults to the existing local route. */
  omniRouteBaseUrl?: string;
  /** Existing native OpenCode provider API key for `/v1/models`; never returned or logged. */
  omniRouteApiKey?: string;
  /** Existing management credential for read-only `/api/*` catalog routes. */
  omniRouteManagementToken?: string;
  /** Existing machine-bound CLI token; sent only to a loopback OmniRoute origin. */
  omniRouteCliToken?: string;
  /** Test seam for the supported GET-only catalog calls. */
  fetcher?: typeof fetch;
}

type OpenCodeModelProviderResolverConfig = Omit<OpenCodeModelProviderResolverOptions, "fetcher">;

type OmniRouteCombo = { id: string; name: string; models: Array<{ providerId: string; model: string }> };

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function omniRouteCatalogUrls(baseValue: string): { api: string; models: string } | undefined {
  try {
    const url = new URL(baseValue);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    const path = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "");
    const root = `${url.origin}${path}`.replace(/\/+$/u, "");
    return { api: `${root}/api`, models: `${root}/v1/models` };
  } catch {
    return undefined;
  }
}

function isLoopbackOmniRouteOrigin(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.replace(/^\[|\]$/gu, "");
    return hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function parseOmniRouteComboCatalog(value: unknown): OmniRouteCombo[] | undefined {
  const body = objectRecord(value);
  if (!body || !Array.isArray(body.combos) || !Number.isInteger(body.total) || body.total !== body.combos.length) return undefined;
  const combos: OmniRouteCombo[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const raw of body.combos) {
    const row = objectRecord(raw);
    const id = nonEmptyString(row?.id);
    const name = nonEmptyString(row?.name);
    if (!row || !id || !name || ids.has(id) || names.has(name) || !Array.isArray(row.models)) return undefined;
    ids.add(id);
    names.add(name);
    const models: OmniRouteCombo["models"] = [];
    for (const rawMember of row.models) {
      const member = objectRecord(rawMember);
      const providerId = nonEmptyString(member?.providerId);
      const model = nonEmptyString(member?.model);
      if (!providerId || !model) return undefined;
      models.push({ providerId, model });
    }
    combos.push({ id, name, models });
  }
  return combos;
}

function parseOpenAIModelCatalog(value: unknown): Array<{ id: string; owner: string; root?: string; parent?: string | null }> | undefined {
  const body = objectRecord(value);
  if (!body || !Array.isArray(body.data)) return undefined;
  const result: Array<{ id: string; owner: string; root?: string; parent?: string | null }> = [];
  const seen = new Map<string, { owner: string; root?: string; parent?: string | null }>();
  for (const raw of body.data) {
    const row = objectRecord(raw);
    const id = nonEmptyString(row?.id);
    const owner = nonEmptyString(row?.owned_by);
    if (!row || !id || !owner) return undefined;
    const root = nonEmptyString(row.root);
    const parent = row.parent === null || typeof row.parent === "string" ? row.parent : undefined;
    if (row.parent !== undefined && parent === undefined) return undefined;
    const previous = seen.get(id);
    if (previous) {
      // The gateway may repeat an identical model row in its combined
      // provider catalog. Collapse that harmless duplicate, but keep rejecting
      // IDs whose owner or routing metadata disagree.
      if (previous.owner !== owner || previous.root !== root || previous.parent !== parent) return undefined;
      continue;
    }
    const entry = { owner, ...(root ? { root } : {}), ...(parent !== undefined ? { parent } : {}) };
    seen.set(id, entry);
    result.push({ id, ...entry });
  }
  return result;
}

function parseOpenAIModelAliases(value: unknown): Record<string, string> | undefined {
  const body = objectRecord(value);
  const aliases = objectRecord(body?.aliases);
  if (!aliases) return undefined;
  const result: Record<string, string> = {};
  for (const [alias, target] of Object.entries(aliases)) {
    const normalizedAlias = nonEmptyString(alias);
    const normalizedTarget = nonEmptyString(target);
    if (!normalizedAlias || !normalizedTarget) return undefined;
    result[normalizedAlias] = normalizedTarget;
  }
  return result;
}

function aliasesIntersect(aliases: Record<string, string>, modelIds: readonly string[]): boolean {
  const targets = new Set(modelIds);
  return Object.entries(aliases).some(([alias, target]) => targets.has(alias) || targets.has(target));
}

/**
 * True when one of the model ids is itself used as an alias name. An alias
 * name shadows the id it points at, so the model id no longer identifies one
 * route. An alias that only points at a model gives that model a second public
 * name; it does not change which provider the id reaches, so it is not an
 * identity conflict.
 */
function aliasesNamed(aliases: Record<string, string>, modelIds: readonly string[]): boolean {
  const names = new Set(modelIds);
  return Object.keys(aliases).some((alias) => names.has(alias));
}

/**
 * One entry of the live OpenCode model catalog.
 *
 * `id` is the key OpenCode accepts (`omniroute/minimax/MiniMax-M3.1-Flash`),
 * `modelId` is the gateway id behind it (`minimax-combo-m3.1`). The route-proof
 * gate verifies the gateway spelling, OpenCode dispatches the key.
 */
export interface OpenCodeCatalogModel {
  providerId: string;
  id: string;
  modelId: string;
}

export interface OpenCodeDispatchableModel {
  /** The id the caller asked for, e.g. `omniroute/minimax-combo-m3.1`. */
  requested: string;
  /** The id OpenCode can dispatch, e.g. `omniroute/minimax/MiniMax-M3.1-Flash`. */
  dispatchable: string;
  /** The native route the request names. */
  nativeRoute: string;
  /**
   * `catalog-key` when the request was already a catalog key, `native-route`
   * when the native id was translated to the key that serves it,
   * `unqualified` when the request named no provider at all, and `unverified`
   * when the catalog could not be read, so no translation was possible.
   */
  kind: "catalog-key" | "native-route" | "unqualified" | "unverified";
  /** Every catalog key that serves the native id, sorted. */
  candidates: string[];
}

export interface OpenCodeDispatchableModelFailure {
  ok: false;
  requested: string;
  reason: string;
}

export type OpenCodeDispatchableModelResult =
  | ({ ok: true } & OpenCodeDispatchableModel)
  | OpenCodeDispatchableModelFailure;

/** Where the model catalog comes from. Named in every fail-closed reason. */
export const OPENCODE_MODEL_CATALOG_SOURCE = "the live OpenCode model catalog (GET /api/model)";

/**
 * Translate a model id into one OpenCode can actually dispatch.
 *
 * Herder, the launch policy and the Notice Place centre all name the route
 * form `omniroute/<gateway-id>`, but OpenCode only accepts the key from its
 * own catalog. An id that is already a catalog key passes through unchanged; a
 * native id is translated to the key that carries it. An id that matches no
 * catalog entry fails closed here, so the request never reaches OpenCode to
 * fail with an opaque "Model unavailable".
 */
export function resolveOpenCodeDispatchableModel(
  catalog: ReadonlyArray<OpenCodeCatalogModel>,
  requested: string,
): OpenCodeDispatchableModelResult {
  const wanted = typeof requested === "string" ? requested.trim() : "";
  const separator = wanted.indexOf("/");
  if (separator <= 0 || separator === wanted.length - 1) {
    // No provider at all: not a route, and not ours to translate. The id is
    // passed on unchanged, exactly as before.
    return {
      ok: true,
      requested,
      dispatchable: wanted,
      nativeRoute: wanted,
      kind: "unqualified",
      candidates: [],
    };
  }
  const providerId = wanted.slice(0, separator);
  const modelId = wanted.slice(separator + 1);
  const nativeRoute = `${providerId}/${modelId}`;
  const entries = (catalog ?? []).filter((entry) => entry && entry.providerId === providerId);
  const exact = entries.filter((entry) => entry.id === modelId).map((entry) => entry.id).sort();
  if (exact.length > 0) {
    return { ok: true, requested, dispatchable: wanted, nativeRoute, kind: "catalog-key", candidates: exact };
  }
  const native = entries.filter((entry) => entry.modelId === modelId).sort((a, b) => a.id.localeCompare(b.id));
  if (native.length === 0) {
    return {
      ok: false,
      requested,
      reason: `OpenCode model "${nativeRoute}" is not dispatchable: ${OPENCODE_MODEL_CATALOG_SOURCE} has no entry for native id "${modelId}" under provider "${providerId}"`,
    };
  }
  const chosen = native[0]!;
  return {
    ok: true,
    requested,
    dispatchable: `${providerId}/${chosen.id}`,
    nativeRoute,
    kind: "native-route",
    candidates: native.map((entry) => entry.id),
  };
}

/**
 * Agent Herder's OpenCode adapter: orchestration on top of the shared core.
 *
 * The protocol — OpenCode 2's `/api` surface, its `{ data }` envelopes, session
 * enumeration, inbox delivery, permissions, models and events — is owned by the
 * core package. What stays here is what Agent Herder alone does: how a session
 * becomes an orchestration record, how a coordination message is admitted into a
 * *running* turn with a durable receipt, and how delivery interacts with the
 * human-stop fence.
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

  private readonly client: OpenCodeClient;
  /** URL of the same OpenCode server the core client talks to. */
  private readonly baseUrl: string;
  /** Basic authorization of that server, when it is protected. */
  private readonly authorization: string | undefined;
  /** Native v2 emits the inbox delivery before execution.started, whose frame has no input ID. */
  private readonly deliveredInboxBySession = new Map<string, string | null>();
  /** Durable integrator journal of the reserved operation, when this adapter serves one. */
  private readonly integratorSessionBindingStore: IntegratorSessionBindingStore | undefined;
  /** The reservation the integrator runtime handed to this adapter. */
  private readonly integratorReservation: OpenCodeIntegratorReservation | undefined;
  /** Explicit credentials for the read-only OmniRoute route proof. */
  private readonly modelProviderResolverConfig: OpenCodeModelProviderResolverConfig;

  constructor(config: { baseUrl?: string; password?: string; protocol?: "auto" | "v1" | "v2";
    /** Explicit, separately scoped credentials for read-only OmniRoute route resolution. */
    modelProviderResolver?: OpenCodeModelProviderResolverConfig;
    /** Durable integrator journal of the reserved operation, when this adapter serves one. */
    integratorSessionBindingStore?: IntegratorSessionBindingStore;
    /** The reservation the integrator runtime handed to this adapter. */
    integratorReservation?: OpenCodeIntegratorReservation } = {}) {
    this.client = new OpenCodeClient({
      baseUrl: config.baseUrl,
      ...(config.password ? { password: config.password } : {}),
      ...(config.protocol ? { protocol: config.protocol } : {}),
    });
    this.baseUrl = resolveOpenCodeBaseUrl(config.baseUrl);
    const password = config.password ?? process.env.OPENCODE_SERVER_PASSWORD;
    const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
    this.authorization = password ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` : undefined;
    this.integratorSessionBindingStore = config.integratorSessionBindingStore;
    this.integratorReservation = config.integratorReservation;
    this.modelProviderResolverConfig = config.modelProviderResolver ?? {};
  }

  /** True once the server answered as an OpenCode 2 (`/api`) instance. */
  get isV2(): boolean {
    return this.client.isV2;
  }

  async init(): Promise<void> {
    await this.client.init();
  }

  private activeSnapshotReceipt: {exhaustive:boolean;observedAt:string;source:string}|null = null;
  getActiveSessionSnapshotReceipt() {return this.activeSnapshotReceipt;}
  async listActiveSessions():Promise<AgentSession[]> {
    this.activeSnapshotReceipt=null;
    await this.client.init();
    const result=await readOpenCodeActiveSessions({v2:this.client.isV2,hostId:localSessionHostId(),read:async path=>{
      const response=await fetch(`${this.baseUrl}${path}`,{headers:this.authorization?{Authorization:this.authorization}:{},signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error(`opencode_active_native_http_${response.status}`);
      return unwrapEnvelope(await response.json());
    }});
    this.activeSnapshotReceipt=result.receipt;return result.sessions;
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<AgentSession[]> {
    const sessions = await this.client.listSessions({ cwd: options.cwd, limit: options.limit });
    return sessions.map((session) => this.toAgentSession(session));
  }

  /**
   * Exact lookup of the sessions that carry a name.
   *
   * The core client only offers a bounded listing of the newest sessions, and
   * OpenCode 2 caps that request at 500 rows. A busy workspace holds thousands
   * of sessions, so a repeated delivery could not see the session it created
   * and created a second one under the same name. OpenCode 2 answers a text
   * search over the whole catalog, so the name is resolved on the server side
   * and the answer does not depend on the window.
   */
  async findNamedSessions(name: string, cwd: string): Promise<AgentSession[]> {
    const normalized = name.trim();
    if (!normalized) return [];
    const searched = await this.searchNamedOnServer(normalized, cwd);
    if (searched) return searched;
    // The server cannot answer a name search, so the listing is the only
    // source. That listing is bounded, and a full window cannot prove that a
    // session does not exist.
    const sessions = await this.listSessions({ cwd, limit: NAMED_SEARCH_LISTING_LIMIT });
    const matches = sessions.filter((session) => session.title === normalized);
    if (matches.length === 0 && sessions.length >= NAMED_SEARCH_LISTING_LIMIT) {
      throw new Error(`OpenCode named session '${normalized}' was not found in ${cwd}, but the last ${NAMED_SEARCH_LISTING_LIMIT} sessions fill the whole listing window: the server does not answer a name search, so the absence of the session cannot be proven`);
    }
    return matches;
  }

  /** Sessions whose title is exactly the name, or null when the server cannot search. */
  private async searchNamedOnServer(name: string, cwd: string): Promise<AgentSession[] | null> {
    let rows: NamedSessionRow[];
    try {
      rows = await this.fetchNamedRows(name, cwd);
    } catch {
      return null;
    }
    const exact = rows.filter((row) => typeof row.id === "string" && row.title === name);
    if (exact.length === 0 && rows.length >= NAMED_SEARCH_LIMIT) {
      throw new Error(`OpenCode named session '${name}' was not found in ${cwd}, but the search window of ${NAMED_SEARCH_LIMIT} rows is full: the absence of the session cannot be proven`);
    }
    const sessions: AgentSession[] = [];
    for (const row of exact) {
      // An archived session is not a live one: it cannot serve the name, and
      // two candidates under one name are an ambiguity the delivery refuses.
      if (isArchivedRow(row)) continue;
      const detail = await this.client.getSession(row.id!);
      if (!detail || detail.archived) continue;
      sessions.push(this.toAgentSession(detail));
    }
    return sessions;
  }

  /** Raw read of the OpenCode 2 session index for one name. */
  private async fetchNamedRows(name: string, cwd: string): Promise<NamedSessionRow[]> {
    const params = new URLSearchParams();
    params.set("directory", cwd);
    params.set("search", name);
    params.set("limit", String(NAMED_SEARCH_LIMIT));
    const response = await fetch(`${this.baseUrl}/api/session?${params.toString()}`, {
      headers: this.authorization ? { Authorization: this.authorization } : {},
    });
    // An OpenCode 1 server has no /api prefix; the caller falls back to the
    // listing, which is exhaustive there.
    if (!response.ok) throw new Error(`OpenCode named session search failed: HTTP ${response.status}`);
    const payload = unwrapEnvelope<unknown>(await response.json());
    if (!Array.isArray(payload)) throw new Error("OpenCode named session search returned an unexpected payload");
    return payload as NamedSessionRow[];
  }

  async getSession(id: string): Promise<AgentSession | null> {
    const detail = await this.client.getSession(id);
    if (!detail) return null;
    const result = this.toAgentSession(detail);
    const last = (await this.getSessionMessages(id, 1))?.at(-1);
    if (last) {
      const tool = [...last.parts].reverse().find((part) => part.type === "tool_call" || part.type === "tool_result");
      // The session model endpoint is the supported readback for a just-issued
      // model switch. A historical assistant message can report the previous
      // model and must not mask that current native setting.
      if (last.model && !result.model) result.model = last.model;
      result.lastMessage = last.text || (tool ? `Инструмент: ${tool.name || "tool"}` : undefined);
      if (last.timestamp && last.timestamp > result.lastActivity) result.lastActivity = last.timestamp;
    }
    const nativeTurn = detail.status === "error" ? await this.client.getTerminalTurnContext(id) : null;
    const nativeFailure = nativeTurn ? await this.client.getTerminalFailureContext(id) : null;
    const nativeRejectedAttempt = detail.status === "error" && !nativeTurn
      ? await this.client.getTerminalRejectedAttemptContext(id) : null;
    const sameNativeTurn = Boolean(nativeTurn && nativeFailure
      && nativeFailure.sessionId === nativeTurn.sessionId
      && nativeFailure.nativeTurnId === nativeTurn.turnId
      && nativeFailure.assistantMessageId === nativeTurn.assistantMessageId
      && nativeFailure.providerId === nativeTurn.providerId
      && nativeFailure.modelId === nativeTurn.modelId
      && (nativeFailure.completedAt === undefined || nativeFailure.completedAt === nativeTurn.completedAt));
    const quotaFailure = sameNativeTurn && nativeFailure ? terminalQuotaFailure({
      terminal: true,
      status: nativeFailure.status,
      nativeTurnId: nativeFailure.nativeTurnId,
      inputId: nativeFailure.inputId,
      providerId: nativeFailure.providerId,
      modelId: nativeFailure.modelId,
      errorType: nativeFailure.errorType,
      errorCode: nativeFailure.errorCode,
      errorMessage: nativeFailure.errorMessage,
      statusCode: nativeFailure.statusCode,
      resetAt: nativeFailure.resetAt,
    }) : null;
    const meta = { ...(result.meta ?? {}) };
    delete meta.nativeRejectedAttempt;
    if (nativeRejectedAttempt) meta.nativeRejectedAttempt = nativeRejectedAttempt;
    const previousNativeLastTurn = meta.nativeLastTurn && typeof meta.nativeLastTurn === "object"
      ? meta.nativeLastTurn as Record<string, unknown> : {};
    const retainedNativeLastTurn = { ...previousNativeLastTurn };
    delete retainedNativeLastTurn.quotaFailure;
    delete retainedNativeLastTurn.inputId;
    delete retainedNativeLastTurn.userMessageId;
    if (nativeTurn) {
      meta.nativeLastTurn = {
        ...retainedNativeLastTurn,
        sessionId: nativeTurn.sessionId,
        turnId: nativeTurn.turnId,
        assistantMessageId: nativeTurn.assistantMessageId,
        providerId: nativeTurn.providerId,
        modelId: nativeTurn.modelId,
        status: nativeTurn.status,
        completedAt: nativeTurn.completedAt,
        ...(sameNativeTurn && nativeFailure ? { inputId: nativeFailure.inputId, userMessageId: nativeFailure.userMessageId } : {}),
        ...(quotaFailure ? { quotaFailure } : {}),
      };
    } else {
      delete meta.nativeLastTurn;
    }
    result.meta = Object.keys(meta).length ? meta : undefined;
    return result;
  }

  async getPermissionState(sessionId: string): Promise<HarnessPermissionState | null> {
    const state = await this.client.getPermissionState(sessionId);
    if (!state) return null;
    return {
      target: { hostId: localSessionHostId(), harness: "opencode", sessionId },
      ...(state.currentMode ? { currentMode: state.currentMode } : {}),
      scope: state.scope,
      supportedModes: state.supportedModes,
      canSetMode: state.canSetMode,
      pendingRequests: state.pendingRequests,
      observedAt: state.observedAt,
    };
  }

  /**
   * The model id OpenCode can dispatch, or a bounded failure.
   *
   * The route-proof gate verifies the native route (`omniroute/<native-id>`),
   * while OpenCode only accepts the key from its own live catalog
   * (`omniroute/minimax/MiniMax-M3.1-Flash`). Handing OpenCode the native id
   * fails there with an opaque "Model unavailable", so the route spelling is
   * translated here, on the way to OpenCode. The gate keeps proving the
   * native route, unchanged.
   */
  async resolveDispatchableModel(requested: string): Promise<OpenCodeDispatchableModelResult> {
    let catalog: OpenCodeCatalogModel[];
    try {
      const entries = await this.client.listModelCatalogEntries();
      catalog = entries.map((entry) => ({
        providerId: entry.providerID ?? "",
        id: entry.id ?? "",
        modelId: entry.modelID ?? entry.id ?? "",
      }));
    } catch (error) {
      // The catalog could not be read, so no translation is possible. The id
      // is passed on unchanged, exactly as before this translation existed,
      // and the gap is named instead of being hidden.
      const unchanged = requested.trim();
      console.warn(`[agent-herder-opencode] model id "${unchanged}" was not translated: ${OPENCODE_MODEL_CATALOG_SOURCE} is unreadable (${(error as Error).message}); the id was sent to OpenCode unchanged`);
      return { ok: true, requested, dispatchable: unchanged, nativeRoute: unchanged, kind: "unverified", candidates: [] };
    }
    const resolution = resolveOpenCodeDispatchableModel(catalog, requested);
    if (resolution.ok && resolution.kind === "native-route" && resolution.candidates.length > 1) {
      // Several catalog keys serve the same native id. The pick is
      // deterministic (sorted) and named, never a silent guess.
      console.warn(`[agent-herder-opencode] model id "${requested}" is served by ${resolution.candidates.length} catalog keys (${resolution.candidates.join(", ")}); chose "${resolution.dispatchable}"`);
    }
    return resolution;
  }

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    let model: string | undefined;
    if (options.model) {
      const resolution = await this.resolveDispatchableModel(options.model);
      if (!resolution.ok) throw new Error(resolution.reason);
      model = resolution.dispatchable;
    }
    const created = await this.client.createSession({
      title: options.name,
      cwd: options.cwd,
      ...(model ? { model } : {}),
      ...(options.fullAccess ? { fullAccess: true } : {}),
    });
    await this.recordIntegratorCreated(created.id, created.cwd || options.cwd);
    // A session Herder created knows who it is from its first turn: otherwise
    // an OpenCode agent cannot name itself, coordinate, or answer "who am I".
    await this.announceIdentity({
      name: options.name,
      sessionId: created.id,
      cwd: created.cwd || options.cwd,
    }).catch(() => false);
    return this.toAgentSession({ ...created, cwd: created.cwd || options.cwd });
  }

  /**
   * Write the durable created receipt of the reserved integrator operation.
   *
   * The reservation is what this adapter was built for; without one the adapter
   * serves an ordinary session and writes nothing.
   */
  private async recordIntegratorCreated(nativeSessionId: string, launchCwd: string): Promise<void> {
    const store = this.integratorSessionBindingStore;
    const reservation = this.integratorReservation;
    if (!store || !reservation) return;
    await store.recordCreated({ operationId: reservation.operationId, attempt: reservation.attempt,
      harness: reservation.harness, nativeSessionId, launchCwd });
  }

  /**
   * Tell one session its own identity. Best effort by design: an OpenCode 1
   * server has no instruction entries, and a failed announcement must never
   * block the session itself.
   */
  async announceIdentity(input: { name?: string; sessionId: string; cwd?: string; parentSessionId?: string }): Promise<boolean> {
    const cwd = input.cwd ?? (await this.client.resolveDirectory(input.sessionId)) ?? process.cwd();
    const name = input.name?.trim() || (await this.client.getSession(input.sessionId))?.title || input.sessionId;
    return this.client.announceIdentity(input.sessionId, {
      name,
      sessionId: input.sessionId,
      harness: "opencode",
      cwd,
      ...(process.env.AGENT_HERDER_URL ? { herderUrl: process.env.AGENT_HERDER_URL } : {}),
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
    });
  }

  /** Read the identity a session knows about itself, if herder ever announced one. */
  async identityOf(sessionId: string): Promise<{ name: string; sessionId: string; harness: string; cwd: string } | null> {
    const session = await this.client.getSession(sessionId).catch(() => null);
    if (!session) return null;
    return { name: session.title || sessionId, sessionId: session.id, harness: "opencode", cwd: session.cwd };
  }

  async getParent(id: string): Promise<AgentSession | null> {
    const session = await this.client.getSession(id);
    return session?.parentId ? this.getSession(session.parentId) : null;
  }

  /**
   * Native active-turn identity. The core owns the protocol read; Herder owns
   * the guarantee that a coordination message is only ever admitted into the
   * turn that is executing right now.
   */
  async getCoordinationActiveTurnId(id: string): Promise<string | null> {
    return this.client.getActiveTurnId(id);
  }

  /**
   * Active-turn delivery. OpenCode 2 steers the running turn natively, so the
   * message reaches the live turn instead of waiting for a plugin hook that only
   * older servers run.
   */
  async sendActiveMessage(id: string, options: SendMessageOptions): Promise<ControlResult> {
    // Legacy servers have no native steer; they keep the durable hook offer.
    if (!this.client.isV2) return reserveCurrentTurnContext(this, id, options);
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
    const identity = await this.client.getActiveTurnId(id);
    if (!identity) {
      return { ok: false, notSubmitted: true, nonRetryable: true, inputId: options.inputId, error: "skipped_inactive: точный активный native ход не установлен" };
    }
    if (await getHumanStopStore().isHeld(this.type, id)) {
      return { ok: false, notSubmitted: true, nonRetryable: true, inputId: options.inputId, error: "Чат явно остановлен." };
    }
    const delivered = await this.client.send(id, { message: options.message, delivery: "steer" });
    if (!delivered.ok) {
      return { ok: false, notSubmitted: true, nonRetryable: true, inputId: options.inputId, error: delivered.error ?? "steer delivery refused" };
    }
    await deferredMessages.addActive(this.type, id, identity, options.inputId || randomUUID(), options.message, options.retainedInboxIds);
    return { ok: true, admitted: true, pending: true, inputId: options.inputId };
  }

  async getCoordinationMessageAdmission(id: string, inputId: string) {
    return currentTurnContextReceipt(this, id, inputId);
  }

  async sendMessage(id: string, options: SendMessageOptions): Promise<SendMessageResult> {
    return normalizeSendAdmission(await this.client.send(id, { message: options.message, delivery: options.queue ? "queue" : "steer", ...(options.inputId ? { inputId: options.inputId } : {}) }));
  }

  async stopSession(id: string): Promise<{ ok: boolean; error?: string }> {
    return this.cancelTurn(id);
  }

  async cancelTurn(id: string): Promise<ControlResult> {
    return this.client.interrupt(id);
  }

  async detach(_id: string): Promise<ControlResult> {
    return { ok: true };
  }

  async listChildren(id: string): Promise<AgentSession[]> {
    return (await this.client.listChildren(id)).map((child) => this.toAgentSession(child));
  }

  /** Subscribe to the native event stream the core owns and keep Herder's shapes. */
  subscribeEvents(onEvent: (event: HarnessEvent) => void): () => void {
    return this.client.subscribe(
      (event) => {
        const correlated = this.correlateInboxStart(event);
        void this.toQuotaAwareHarnessEvent(correlated).then((normalized) => {
          if (normalized) onEvent(normalized);
        }).catch(() => {
          const normalized = this.toHarnessEvent(event);
          if (normalized) onEvent(normalized);
        });
      },
      {
        onConnected: () => onEvent({ kind: "process.connected", harness: "opencode", data: { transport: "sse" } }),
        onDisconnected: (error) => onEvent({ kind: "process.disconnected", harness: "opencode", data: { transport: "sse", ...(error ? { error } : {}) } }),
      },
    );
  }

  /** Carry only the exact native Inbox.User ID across the adjacent delivery/start lifecycle. */
  private correlateInboxStart(event: OpenCodeEvent): OpenCodeEvent {
    const sessionId = event.sessionId;
    if (!sessionId) return event;
    const data = event.data ?? {};
    if (event.nativeType === "session.inbox.delivered") {
      const inboxId = typeof data.nativeInputMessageId === "string" ? data.nativeInputMessageId : undefined;
      const previous = this.deliveredInboxBySession.get(sessionId);
      this.deliveredInboxBySession.set(sessionId, inboxId && previous === undefined ? inboxId : null);
      return event;
    }
    if (event.kind === "turn.started") {
      const inboxId = this.deliveredInboxBySession.get(sessionId);
      this.deliveredInboxBySession.delete(sessionId);
      if (typeof data.inputId === "string" || !inboxId) return event;
      return { ...event, data: { ...data, inputId: inboxId, nativeInputMessageId: inboxId } };
    }
    if (event.kind === "turn.completed" || event.kind === "turn.failed") {
      this.deliveredInboxBySession.delete(sessionId);
    }
    return event;
  }

  private async toQuotaAwareHarnessEvent(event: OpenCodeEvent): Promise<HarnessEvent | null> {
    const normalized = this.toHarnessEvent(event);
    if (!normalized || normalized.kind !== "turn.failed" || !normalized.sessionId) return normalized;
    const data = normalized.data ?? {};
    const terminalEventId = typeof data.nativeEventId === "string" ? data.nativeEventId : undefined;
    if (!terminalEventId) return normalized;
    const observedTurnId = typeof data.turnId === "string" ? data.turnId : undefined;
    const observedInputId = typeof data.inputId === "string" ? data.inputId : undefined;
    const nativeFailure = await this.client.getTerminalFailureContext(
      normalized.sessionId,
      terminalEventId,
      observedTurnId,
      observedInputId,
    );
    if (!nativeFailure) return normalized;
    const quotaFailure = terminalQuotaFailure({
      terminal: true,
      status: nativeFailure.status,
      nativeTurnId: nativeFailure.nativeTurnId,
      inputId: nativeFailure.inputId,
      providerId: nativeFailure.providerId,
      modelId: nativeFailure.modelId,
      errorType: typeof data.nativeErrorType === "string" ? data.nativeErrorType : nativeFailure.errorType,
      errorCode: typeof data.nativeErrorCode === "string" ? data.nativeErrorCode : nativeFailure.errorCode,
      errorMessage: typeof data.nativeErrorMessage === "string" ? data.nativeErrorMessage : nativeFailure.errorMessage,
      statusCode: typeof data.nativeErrorStatus === "number" ? data.nativeErrorStatus : nativeFailure.statusCode,
      resetAt: data.nativeErrorResetAt ?? nativeFailure.resetAt,
    });
    if (!quotaFailure) return normalized;
    return {
      ...normalized,
      status: "error",
      data: {
        ...data,
        turnId: quotaFailure.nativeTurnId,
        inputId: quotaFailure.inputId,
        quotaFailure,
      },
    };
  }

  async forkSession(id: string, message?: string): Promise<ControlResult> {
    return this.client.forkSession(id, message);
  }

  async recover(id: string, message?: string, signal?: AbortSignal): Promise<ControlResult> {
    try {
      throwIfAborted(signal);
      await this.client.waitForIdle(id, signal);
      throwIfAborted(signal);
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

  async respondPermission(sessionId: string, permissionId: string, response: "allow" | "deny", remember?: boolean): Promise<{ ok: boolean; error?: string }> {
    return this.client.respondPermission(sessionId, permissionId, response, remember);
  }

  async setPermissions(sessionId: string, options: SetPermissionsOptions): Promise<{ ok: boolean; error?: string }> {
    return this.client.setPermissions(sessionId, {
      ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
    });
  }

  async changeModel(sessionId: string, model: string): Promise<{ ok: boolean; error?: string }> {
    const resolution = await this.resolveDispatchableModel(model);
    if (!resolution.ok) return { ok: false, error: resolution.reason };
    return this.client.changeModel(sessionId, resolution.dispatchable);
  }

  async listModels(): Promise<string[]> {
    return this.client.listModels();
  }

  /**
   * Resolve an exact selectable OpenCode ID to its concrete provider leaves.
   * Direct native providers have one leaf. OmniRoute aliases are resolved from
   * its supported read-only model/combos APIs; uncertain or incomplete trees
   * return null so launch policy can deny before create/send/fallback.
   */
  async resolveModelProviderLeaves(
    nativeModelId: string,
    requestOptions: OpenCodeModelProviderResolverOptions = {},
  ): Promise<OpenCodeModelProviderResolution | null> {
    try {
      const options = { ...this.modelProviderResolverConfig, ...requestOptions };
      const separator = nativeModelId.indexOf("/");
      if (separator <= 0 || separator === nativeModelId.length - 1 || nativeModelId.trim() !== nativeModelId) return null;
      const providerId = nativeModelId.slice(0, separator);
      const modelId = nativeModelId.slice(separator + 1);
      // The native catalog is the authority for whether this exact model ID
      // is selectable in this OpenCode instance.
      const nativeModels = await this.client.listModels();
      if (!this.client.isV2 || !nativeModels.includes(nativeModelId)) return null;
      const base = { nativeHarness: "opencode" as const, nativeModelId, providerId, modelId };
      if (providerId !== "omniroute") {
        return { ...base, resolvedProviderLeaves: [{ providerId, modelId }] };
      }

      const apiKey = nonEmptyString(options.omniRouteApiKey);
      if (!apiKey) return null;
      const urls = omniRouteCatalogUrls(options.omniRouteBaseUrl
        ?? process.env.AGENT_HERDER_OMNIROUTE_BASE_URL
        ?? "http://127.0.0.1:20128");
      if (!urls) return null;
      const fetcher = options.fetcher ?? globalThis.fetch;
      const managementToken = nonEmptyString(options.omniRouteManagementToken);
      const cliToken = nonEmptyString(options.omniRouteCliToken);
      if (!managementToken && (!cliToken || !isLoopbackOmniRouteOrigin(urls.api))) return null;
      const managementHeaders: Record<string, string> = managementToken
        ? { Authorization: `Bearer ${managementToken}` }
        : { "X-OmniRoute-CLI-Token": cliToken! };
      const request = async (url: string, headers: Record<string, string>): Promise<unknown> => {
        const response = await fetcher(url, {
          method: "GET", headers, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error("catalog unavailable");
        return response.json();
      };

      const [modelCatalogResponse, mappingResponse, aliasResponse] = await Promise.all([
        request(urls.models, { Authorization: `Bearer ${apiKey}` }),
        request(`${urls.api}/model-combo-mappings`, managementHeaders),
        request(`${urls.api}/models/alias`, managementHeaders),
      ]);
      const modelCatalog = parseOpenAIModelCatalog(modelCatalogResponse);
      const modelAliases = parseOpenAIModelAliases(aliasResponse);
      if (!modelCatalog || !modelAliases) return null;
      const selected = modelCatalog.find((entry) => entry.id === modelId);
      if (!selected || !selected.root) return null;
      const mappings = objectRecord(mappingResponse);
      if (!Array.isArray(mappings?.mappings)
        || !Number.isInteger(mappings.total) || mappings.total !== mappings.mappings.length
        || aliasesIntersect(modelAliases, [nativeModelId, modelId, selected.root])) return null;
      const mappingRows: Array<{ id: string; comboId: string; comboName: string; pattern: string; enabled: boolean }> = [];
      const seenMappingIds = new Set<string>();
      for (const value of mappings.mappings) {
        const row = objectRecord(value);
        const id = nonEmptyString(row?.id);
        const comboId = nonEmptyString(row?.comboId);
        const comboName = nonEmptyString(row?.comboName);
        const pattern = nonEmptyString(row?.pattern);
        if (!row || !id || !comboId || !comboName || !pattern || typeof row.enabled !== "boolean" || seenMappingIds.has(id)) return null;
        seenMappingIds.add(id);
        mappingRows.push({ id, comboId, comboName, pattern, enabled: row.enabled });
      }
      if (selected.owner !== "combo") {
        // Only an enabled mapping that claims this exact model can rewrite its
        // route. A mapping that serves an unrelated model leaves this one alone.
        if (mappingRows.some((row) => row.enabled
          && (row.pattern === modelId || row.pattern.startsWith(`${modelId}/`)))) return null;
        return { ...base, resolvedProviderLeaves: [{ providerId: selected.owner, modelId: selected.root }] };
      }
      // This model is an actual top-level combo only when the native gateway
      // catalog says so. A child/alias route needs a separately understood map.
      if (selected.root !== modelId || selected.parent !== null) return null;

      const comboResponse = await request(`${urls.api}/combos`, managementHeaders);
      const combos = parseOmniRouteComboCatalog(comboResponse);
      if (!combos) return null;

      const combosByNameOrId = new Map<string, OmniRouteCombo>();
      for (const combo of combos) {
        if ((combosByNameOrId.has(combo.name) && combosByNameOrId.get(combo.name)?.id !== combo.id)
          || (combosByNameOrId.has(combo.id) && combosByNameOrId.get(combo.id)?.id !== combo.id)) return null;
        combosByNameOrId.set(combo.name, combo);
        combosByNameOrId.set(combo.id, combo);
      }
      const rootCandidates = combos.filter((combo) => combo.name === modelId);
      if (rootCandidates.length !== 1) return null;
      const rootCombo = rootCandidates[0]!;
      const catalogById = new Map(modelCatalog.map((entry) => [entry.id, entry]));
      const expand = (combo: OmniRouteCombo, ancestors: ReadonlySet<string>): OpenCodeProviderLeaf[] | null => {
        if (ancestors.has(combo.id) || combo.models.length === 0) return null;
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(combo.id);
        const leaves: OpenCodeProviderLeaf[] = [];
        for (const member of combo.models) {
          const listedModel = catalogById.get(member.model);
          const child = combosByNameOrId.get(member.model);
          if (listedModel?.owner === "combo" || child) {
            if (!child || (member.providerId !== "combo" && member.providerId !== "omniroute"
              && member.providerId !== child.name && member.providerId !== child.id)) return null;
            const childLeaves = expand(child, nextAncestors);
            if (!childLeaves) return null;
            leaves.push(...childLeaves);
            continue;
          }
          if (listedModel) {
            if (!listedModel.root || listedModel.owner !== member.providerId) return null;
          } else if (member.providerId === "combo" || member.providerId === "omniroute"
            || !member.model.startsWith(`${member.providerId}/`)
            || member.model.length <= member.providerId.length + 1) {
            // A combo's authenticated management definition remains authoritative
            // when this inference key cannot see one of its provider-scoped leaves.
            // Accept only an exact provider-qualified id in that case.
            return null;
          }
          leaves.push({ providerId: member.providerId, modelId: member.model });
        }
        return leaves.length ? leaves : null;
      };
      const leaves = expand(rootCombo, new Set());
      if (!leaves) return null;
      const uniqueLeaves = [...new Map(leaves.map((leaf) => [`${leaf.providerId}\0${leaf.modelId}`, leaf])).values()];
      // A leaf id must not itself be an alias name, because an alias name
      // shadows the id it points at. An alias that only points at the leaf gives
      // the same model a second public name without changing its provider.
      if (aliasesNamed(modelAliases, uniqueLeaves.map((leaf) => leaf.modelId))) return null;
      const identityModels = [...new Set(uniqueLeaves.map((leaf) => leaf.modelId.split("/").at(-1)!).filter(Boolean))];
      if (identityModels.length === 0) return null;
      const identityPatterns = new Set(identityModels.map((identity) => `${rootCombo.name}/${identity}`));
      // Enabled mappings are judged per route. Only a mapping that claims the
      // selected member identities can redirect it. Exact parentless combo IDs
      // may intentionally contain different terminal model ids; validate each
      // identity mapping independently instead of requiring one shared suffix.
      const claiming = mappingRows.filter((row) => row.enabled && identityPatterns.has(row.pattern));
      if ([...identityPatterns].some((pattern) => claiming.filter((row) => row.pattern === pattern).length > 1)
        || claiming.some((row) => row.comboId !== rootCombo.id || row.comboName !== rootCombo.name)) return null;
      const conflicting = mappingRows.filter((row) => row.enabled && (
        row.pattern === rootCombo.name
        || (row.pattern.startsWith(`${rootCombo.name}/`) && !identityPatterns.has(row.pattern))
      ));
      if (conflicting.length > 0) return null;
      return { ...base, resolvedProviderLeaves: uniqueLeaves };
    } catch {
      return null;
    }
  }

  /** The earliest user-authored message, read from the head of the native history. */
  async getFirstUserMessage(id: string): Promise<SessionMessageView | null> {
    const message = await this.client.getFirstUserMessage(id);
    if (!message) return null;
    return {
      id: message.id,
      role: message.role,
      ...(message.text ? { text: message.text } : {}),
      parts: message.parts as SessionMessagePart[],
    };
  }

  async getSessionMessages(id: string, limit = 3): Promise<SessionMessageView[] | null> {
    const messages = await this.client.getMessages(id, limit);
    if (!messages) return null;
    return messages.map((message) => {
      const toolNames = [...new Set(message.parts
        .filter((part) => part.type === "tool_call" && typeof part.name === "string" && part.name.length > 0)
        .map((part) => part.name as string))];
      // Text-less turns are usually tool rounds; keep them legible instead of
      // an empty bubble that hides what the session actually did.
      const text = message.text || (toolNames.length > 0 ? `Инструмент: ${toolNames.join(", ")}` : undefined);
      return {
        id: message.id,
        role: message.role,
        ...(message.turnId ? { turnId: message.turnId } : {}),
        ...(message.phase ? { phase: message.phase } : {}),
        ...(message.model ? { model: message.model } : {}),
        ...(message.timestamp ? { timestamp: message.timestamp } : {}),
        ...(text ? { text } : {}),
        parts: message.parts as SessionMessagePart[],
      };
    });
  }

  async getTranscript(id: string): Promise<string | null> {
    const messages = await this.getSessionMessages(id, 50);
    if (!messages?.length) return null;
    const lines = messages.map((message) => {
      const text = message.text ?? (message.role === "assistant" ? "" : "");
      return `${message.role}: ${text.slice(0, 2000)}`;
    }).filter((line) => !line.endsWith(": "));
    return lines.join("\n\n") || null;
  }

  async getRawTranscript(id: string, signal?: AbortSignal): Promise<RawTranscriptExport | null> {
    const raw = await this.client.getRawTranscript(id, signal);
    if (!raw) return null;
    return {
      bytes: raw.bytes,
      complete: false,
      source: { kind: "native-api", location: raw.location, format: "json" },
      timestampCoverage: "partial",
      limitations: raw.limitations,
    };
  }

  // ---- orchestration mapping ----

  private toAgentSession(session: {
    id: string; title: string; cwd: string; lastActivity?: string; model?: string;
    status?: AgentSession["status"]; parentId?: string; costUsd?: number;
    needsPermission?: boolean; permissionDetails?: { id: string; type: string; description: string; toolName?: string; details?: string };
    archived?: boolean;
  }): AgentSession {
    const meta: Record<string, unknown> = {};
    if (session.parentId) meta.parentID = session.parentId;
    // An archived session is not a live one: the flag lets the caller refuse
    // it as a reuse candidate.
    if (session.archived) meta.archived = true;
    return {
      id: session.id,
      harness: "opencode",
      status: session.status ?? "idle",
      title: session.title,
      cwd: session.cwd,
      hostId: localSessionHostId(),
      lastActivity: session.lastActivity ?? new Date(0).toISOString(),
      ...(session.model ? { model: session.model } : {}),
      needsPermission: session.needsPermission === true,
      ...(session.permissionDetails ? { permissionDetails: session.permissionDetails } : {}),
      ...(session.costUsd !== undefined ? { costUsd: session.costUsd } : {}),
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    };
  }

  private toHarnessEvent(event: OpenCodeEvent): HarnessEvent | null {
    if (!event || event.kind === "unknown") return null;
    return {
      kind: event.kind as HarnessEvent["kind"],
      harness: "opencode",
      sessionId: event.sessionId,
      nativeType: event.nativeType,
      messageId: event.messageId,
      permissionId: event.permissionId,
      status: event.status,
      at: new Date().toISOString(),
      data: event.data,
    };
  }
}
