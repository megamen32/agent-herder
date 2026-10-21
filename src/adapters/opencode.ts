import { currentTurnContextReceipt, previousCoordinationReceipt, reserveCurrentTurnContext } from "../coordination-active-delivery.js";
import { deferredMessages } from "../deferred-messages.js";
import { getHumanStopStore } from "../human-stop-store.js";
import {
  OpenCodeClient,
  normalizeOpenCodeEvent,
  parseOpenCodeServerCommand,
  unwrapEnvelope,
  type OpenCodeEvent,
} from "agent-resume-mcp";
import { HarnessAdapter, AgentSession, ControlResult, CreateSessionOptions, HarnessCapabilities, HarnessEvent, ListSessionsOptions, RawTranscriptExport, SendMessageOptions, SendMessageResult, SetPermissionsOptions, SessionMessagePart, SessionMessageView } from "../types/index.js";
import { randomUUID } from "node:crypto";
import { throwIfAborted } from "../abort-utils.js";
import { terminalQuotaFailure } from "./quota-failure.js";

export { normalizeOpenCodeEvent, openCodeConnectedModels, openCodeMessageParts, openCodeModelCatalogEntries, parseOpenCodeServerCommand, unwrapEnvelope } from "agent-resume-mcp";
export type { OpenCodeEvent } from "agent-resume-mcp";

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
  /** Read-only catalog auth. Never included in the resolution result or errors. */
  omniRouteApiKey?: string;
  /** Test seam for the supported GET-only catalog calls. */
  fetcher?: typeof fetch;
}

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
  const seen = new Set<string>();
  for (const raw of body.data) {
    const row = objectRecord(raw);
    const id = nonEmptyString(row?.id);
    const owner = nonEmptyString(row?.owned_by);
    if (!row || !id || !owner || seen.has(id)) return undefined;
    seen.add(id);
    const root = nonEmptyString(row.root);
    const parent = row.parent === null || typeof row.parent === "string" ? row.parent : undefined;
    if (row.parent !== undefined && parent === undefined) return undefined;
    result.push({ id, owner, ...(root ? { root } : {}), ...(parent !== undefined ? { parent } : {}) });
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
  /** Native v2 emits the inbox delivery before execution.started, whose frame has no input ID. */
  private readonly deliveredInboxBySession = new Map<string, string | null>();

  constructor(config: { baseUrl?: string; password?: string; protocol?: "auto" | "v1" | "v2" } = {}) {
    this.client = new OpenCodeClient({
      baseUrl: config.baseUrl,
      ...(config.password ? { password: config.password } : {}),
      ...(config.protocol ? { protocol: config.protocol } : {}),
    });
  }

  /** True once the server answered as an OpenCode 2 (`/api`) instance. */
  get isV2(): boolean {
    return this.client.isV2;
  }

  async init(): Promise<void> {
    await this.client.init();
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<AgentSession[]> {
    const sessions = await this.client.listSessions({ cwd: options.cwd, limit: options.limit });
    return sessions.map((session) => this.toAgentSession(session));
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
    const previousNativeLastTurn = meta.nativeLastTurn && typeof meta.nativeLastTurn === "object"
      ? meta.nativeLastTurn as Record<string, unknown> : {};
    const retainedNativeLastTurn = { ...previousNativeLastTurn };
    delete retainedNativeLastTurn.quotaFailure;
    delete retainedNativeLastTurn.inputId;
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
        ...(sameNativeTurn && nativeFailure ? { inputId: nativeFailure.inputId } : {}),
        ...(quotaFailure ? { quotaFailure } : {}),
      };
    } else {
      delete meta.nativeLastTurn;
    }
    result.meta = Object.keys(meta).length ? meta : undefined;
    return result;
  }

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    const created = await this.client.createSession({
      title: options.name,
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.fullAccess ? { fullAccess: true } : {}),
    });
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
    return this.client.send(id, { message: options.message, delivery: options.queue ? "queue" : "steer", ...(options.inputId ? { inputId: options.inputId } : {}) });
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
    return this.client.changeModel(sessionId, model);
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
    options: OpenCodeModelProviderResolverOptions = {},
  ): Promise<OpenCodeModelProviderResolution | null> {
    try {
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

      const apiKey = options.omniRouteApiKey ?? process.env.OMNIROUTE_API_KEY;
      if (!apiKey) return null;
      const urls = omniRouteCatalogUrls(options.omniRouteBaseUrl
        ?? process.env.AGENT_HERDER_OMNIROUTE_BASE_URL
        ?? "http://127.0.0.1:20128");
      if (!urls) return null;
      const fetcher = options.fetcher ?? globalThis.fetch;
      const headers = { Authorization: `Bearer ${apiKey}` };
      const request = async (url: string): Promise<unknown> => {
        const response = await fetcher(url, {
          method: "GET", headers, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error("catalog unavailable");
        return response.json();
      };

      const [modelCatalogResponse, mappingResponse, aliasResponse] = await Promise.all([
        request(urls.models),
        request(`${urls.api}/model-combo-mappings`),
        request(`${urls.api}/models/alias`),
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
        if (mappingRows.some((row) => row.enabled)) return null;
        return { ...base, resolvedProviderLeaves: [{ providerId: selected.owner, modelId: selected.root }] };
      }
      // This model is an actual top-level combo only when the native gateway
      // catalog says so. A child/alias route needs a separately understood map.
      if (selected.root !== modelId || selected.parent !== null) return null;

      const comboResponse = await request(`${urls.api}/combos`);
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
      const relevantMappings = mappingRows.filter((row) => row.enabled && (
        row.comboId === rootCombo.id || row.comboName === rootCombo.name || row.pattern.startsWith(`${rootCombo.name}/`)
      ));
      if (relevantMappings.length > 1) return null;
      const catalogById = new Map(modelCatalog.map((entry) => [entry.id, entry]));
      const expand = (combo: OmniRouteCombo, ancestors: ReadonlySet<string>): OpenCodeProviderLeaf[] | null => {
        if (ancestors.has(combo.id) || combo.models.length === 0) return null;
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(combo.id);
        const leaves: OpenCodeProviderLeaf[] = [];
        for (const member of combo.models) {
          const listedModel = catalogById.get(member.model);
          if (!listedModel || !listedModel.root) return null;
          if (listedModel.owner === "combo") {
            const child = combosByNameOrId.get(member.model);
            if (!child || (member.providerId !== "combo" && member.providerId !== "omniroute"
              && member.providerId !== child.name && member.providerId !== child.id)) return null;
            const childLeaves = expand(child, nextAncestors);
            if (!childLeaves) return null;
            leaves.push(...childLeaves);
            continue;
          }
          if (listedModel.owner !== member.providerId) return null;
          leaves.push({ providerId: member.providerId, modelId: member.model });
        }
        return leaves.length ? leaves : null;
      };
      const leaves = expand(rootCombo, new Set());
      if (!leaves) return null;
      const uniqueLeaves = [...new Map(leaves.map((leaf) => [`${leaf.providerId}\0${leaf.modelId}`, leaf])).values()];
      if (aliasesIntersect(modelAliases, uniqueLeaves.map((leaf) => leaf.modelId))) return null;
      if (relevantMappings.length === 1) {
        const mapping = relevantMappings[0]!;
        const identityModels = [...new Set(uniqueLeaves.map((leaf) => leaf.modelId.split("/").at(-1)!).filter(Boolean))];
        if (mapping.comboId !== rootCombo.id || mapping.comboName !== rootCombo.name
          || identityModels.length !== 1 || mapping.pattern !== `${rootCombo.name}/${identityModels[0]}`) return null;
      }
      return { ...base, resolvedProviderLeaves: uniqueLeaves };
    } catch {
      return null;
    }
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
  }): AgentSession {
    return {
      id: session.id,
      harness: "opencode",
      status: session.status ?? "idle",
      title: session.title,
      cwd: session.cwd,
      lastActivity: session.lastActivity ?? new Date(0).toISOString(),
      ...(session.model ? { model: session.model } : {}),
      needsPermission: session.needsPermission === true,
      ...(session.permissionDetails ? { permissionDetails: session.permissionDetails } : {}),
      ...(session.costUsd !== undefined ? { costUsd: session.costUsd } : {}),
      ...(session.parentId ? { meta: { parentID: session.parentId } } : {}),
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
