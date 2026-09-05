import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import {
  type AgentSession,
  type ControlResult,
  type CreateSessionOptions,
  type HarnessAdapter,
  type HarnessCapabilities,
  type ListSessionsOptions,
  type RawTranscriptExport,
  type SendMessageOptions,
  type SessionMessagePart,
  type SessionMessageView,
  type SetPermissionsOptions,
} from "../types/index.js";
import { ZcodeAppServerClient, type ZcodeClientLike } from "./zcode-protocol.js";

interface ZcodeWorkspaceRef {
  workspacePath: string;
  workspaceIdentity: string;
  /** Current zcode-server builds validate this key; older ones used workspaceIdentity. */
  workspaceKey: string;
}

interface ZcodeModelRef {
  providerId: string;
  modelId: string;
  variant?: string;
}

interface ZcodeSessionInfo {
  sessionId: string;
  workspace?: { workspacePath?: string; workspaceIdentity?: string };
  parentSessionId?: string;
  traceId?: string;
  sessionKind?: string;
  title?: string;
  mode?: string;
  status?: string;
  model?: ZcodeModelRef;
  createdAt?: number | string;
  updatedAt?: number | string;
}

interface ZcodeMessage {
  info?: {
    messageId?: string;
    role?: string;
    time?: { created?: number | string };
    cost?: number;
  };
  parts?: Array<Record<string, unknown>>;
}

interface ZcodeSnapshot {
  session?: ZcodeSessionInfo;
  settings?: {
    model?: {
      current?: ZcodeModelRef;
      available?: Array<ZcodeModelRef | string>;
    };
  };
  runtime?: { pendingRequestIds?: string[] };
  messages?: ZcodeMessage[];
}

interface ZcodeCommand {
  command: string;
  args: string[];
}

export interface ZcodeAdapterOptions {
  /** Override the stdio app-server executable, primarily for tests. */
  command?: string;
  args?: string[];
  cwd?: string;
  modelIds?: string[];
  /** Inject a transport in tests or when embedding agent-herder. */
  client?: ZcodeClientLike;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function timestamp(value: unknown, fallback = Date.now()): string {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(fallback).toISOString();
}

function modelName(model: ZcodeModelRef | undefined): string | undefined {
  if (!model?.providerId || !model.modelId) return undefined;
  return `${model.providerId}/${model.modelId}${model.variant ? `#${model.variant}` : ""}`;
}

function modelNameFromCatalogEntry(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const entry = record(value);
  const ref = record(entry.ref) as unknown as ZcodeModelRef;
  return modelName(ref) || nonEmptyString(entry.label);
}

function parseModelName(value: string, currentProviderId?: string): ZcodeModelRef | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const separator = trimmed.indexOf("/");
  if (separator > 0) {
    const providerId = trimmed.slice(0, separator).trim();
    const modelAndVariant = trimmed.slice(separator + 1);
    const variantSeparator = modelAndVariant.indexOf("#");
    return {
      providerId,
      modelId: variantSeparator >= 0 ? modelAndVariant.slice(0, variantSeparator) : modelAndVariant,
      ...(variantSeparator >= 0 ? { variant: modelAndVariant.slice(variantSeparator + 1) } : {}),
    };
  }
  if (!currentProviderId) return undefined;
  return { providerId: currentProviderId, modelId: trimmed };
}

function mapStatus(status: unknown): AgentSession["status"] {
  switch (status) {
    case "running": return "running";
    case "waiting": return "needs_input";
    case "error": return "error";
    case "completed": return "stopped";
    case "paused":
    case "idle":
    default: return "idle";
  }
}

function textFromMessage(message: ZcodeMessage): string {
  return (message.parts ?? [])
    .filter((part) => part.type === "text" || part.type === "reasoning")
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("");
}

function mapMessagePart(part: Record<string, unknown>): SessionMessagePart[] {
  if (part.type === "text" && typeof part.text === "string") {
    return [{ type: "text", text: part.text }];
  }
  if (part.type === "reasoning" && typeof part.text === "string") {
    return [{ type: "thinking", text: part.text }];
  }
  if (part.type === "tool") {
    const state = record(part.state);
    const input = state.input;
    const name = typeof part.tool === "string" ? part.tool : undefined;
    const result: SessionMessagePart[] = [{ type: "tool_call", name, input }];
    if (state.status === "completed" && typeof state.output === "string") {
      result.push({ type: "tool_result", name, output: state.output });
    } else if (state.status === "error" && typeof state.error === "string") {
      result.push({ type: "tool_result", name, output: state.error, error: true });
    }
    return result;
  }
  return [];
}

function mapMessage(message: ZcodeMessage, index: number): SessionMessageView {
  const info = record(message.info);
  const role = info.role === "user" || info.role === "assistant" ? info.role : "assistant";
  const id = nonEmptyString(info.messageId) || `zcode-message-${index + 1}`;
  const parts = (message.parts ?? []).flatMap(mapMessagePart);
  const text = textFromMessage(message);
  return {
    id,
    role,
    timestamp: timestamp(record(info.time).created),
    text: text || undefined,
    parts,
  };
}

function sessionInfoFromPayload(payload: unknown): ZcodeSessionInfo | undefined {
  const root = record(payload);
  const nested = record(root.session);
  const source = Object.keys(nested).length > 0 ? nested : root;
  const sessionId = nonEmptyString(source.sessionId);
  return sessionId ? {
    sessionId,
    workspace: record(source.workspace) as ZcodeSessionInfo["workspace"],
    parentSessionId: nonEmptyString(source.parentSessionId),
    traceId: nonEmptyString(source.traceId),
    sessionKind: nonEmptyString(source.sessionKind),
    title: typeof source.title === "string" ? source.title : undefined,
    mode: typeof source.mode === "string" ? source.mode : undefined,
    status: typeof source.status === "string" ? source.status : undefined,
    model: record(source.model) as unknown as ZcodeModelRef,
    createdAt: typeof source.createdAt === "number" || typeof source.createdAt === "string" ? source.createdAt : undefined,
    updatedAt: typeof source.updatedAt === "number" || typeof source.updatedAt === "string" ? source.updatedAt : undefined,
  } : undefined;
}

function mapSession(payload: unknown, fallbackCwd: string, fallbackTitle?: string): AgentSession {
  const root = record(payload);
  const session = sessionInfoFromPayload(payload);
  if (!session) throw new Error("ZCode returned a session payload without sessionId");
  const workspace = record(session.workspace);
  const cwd = nonEmptyString(workspace.workspacePath) || fallbackCwd;
  const snapshot = root as ZcodeSnapshot;
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  const views = messages.map(mapMessage);
  const lastMessage = [...views].reverse().find((message) => message.text)?.text;
  const createdAt = typeof session.createdAt === "number" ? session.createdAt : Date.parse(String(session.createdAt ?? ""));
  const updatedAt = typeof session.updatedAt === "number" ? session.updatedAt : Date.parse(String(session.updatedAt ?? ""));
  const durationSec = Number.isFinite(createdAt) && Number.isFinite(updatedAt) && updatedAt >= createdAt
    ? (updatedAt - createdAt) / 1000
    : undefined;
  const pendingRequestIds = Array.isArray(record(root.runtime).pendingRequestIds)
    ? (record(root.runtime).pendingRequestIds as unknown[]).filter((id): id is string => typeof id === "string")
    : [];
  const costUsd = messages.reduce((sum, message) => sum + (typeof record(message.info).cost === "number" ? record(message.info).cost as number : 0), 0);
  const meta: Record<string, unknown> = {
    sessionKind: session.sessionKind,
    mode: session.mode,
    traceId: session.traceId,
    parentSessionId: session.parentSessionId,
    workspaceIdentity: nonEmptyString(workspace.workspaceIdentity),
    pendingRequestIds,
  };
  return {
    id: session.sessionId,
    harness: "zcode",
    status: mapStatus(session.status),
    title: session.title || fallbackTitle || "Untitled ZCode session",
    cwd,
    lastActivity: timestamp(session.updatedAt ?? session.createdAt),
    model: modelName(session.model),
    needsPermission: pendingRequestIds.length > 0,
    messageCount: messages.length || undefined,
    costUsd: costUsd || undefined,
    durationSec,
    lastMessage,
    meta,
  };
}

function snapshotMessages(payload: unknown): ZcodeMessage[] {
  if (Array.isArray(payload)) return payload as ZcodeMessage[];
  const root = record(payload);
  if (Array.isArray(root.messages)) return root.messages as ZcodeMessage[];
  return [];
}

function unsupported(operation: string): ControlResult {
  return { ok: false, error: `ZCode Protocol operation '${operation}' is not supported by the native app-server` };
}

function defaultCommand(): ZcodeCommand {
  const runtimeRoot = process.env.ZCODE_SERVER_RUNTIME_ROOT || join(homedir(), ".zcode", "server");
  const serverNode = process.env.ZCODE_SERVER_NODE || join(runtimeRoot, "node");
  const serverEntry = process.env.ZCODE_SERVER_ENTRY || join(runtimeRoot, "zcode-server.cjs");
  if (existsSync(serverNode) && existsSync(serverEntry)) {
    return { command: serverNode, args: [serverEntry] };
  }
  let args = ["app-server"];
  if (process.env.ZCODE_ARGS) {
    const parsed: unknown = JSON.parse(process.env.ZCODE_ARGS);
    if (!Array.isArray(parsed) || !parsed.every((arg) => typeof arg === "string")) {
      throw new Error("ZCODE_ARGS must be a JSON array of strings");
    }
    args = parsed;
  }
  return { command: process.env.ZCODE_BIN || "zcode", args };
}

/** ZCode adapter backed by the local stdio app-server, not the remote GUI relay. */
export class ZcodeAdapter implements HarnessAdapter {
  readonly type = "zcode" as const;
  readonly name = "ZCode";
  readonly lazyStart = true;
  readonly controlCapabilities: HarnessCapabilities = {
    cancelTurn: true,
    detach: true,
    resume: true,
    terminate: true,
    recover: true,
    fork: false,
    modelSwitch: true,
    subagents: true,
    events: false,
  };

  private readonly cwd: string;
  private readonly modelIds: string[];
  private readonly client: ZcodeClientLike;
  private readonly useLocalConfig: boolean;
  private readonly sessionWorkspaces = new Map<string, ZcodeWorkspaceRef>();
  private initialized = false;

  constructor(options: ZcodeAdapterOptions = {}) {
    this.cwd = resolve(options.cwd || process.env.ZCODE_CWD || process.cwd());
    this.modelIds = options.modelIds ?? [];
    this.useLocalConfig = !options.client;
    if (options.client) {
      this.client = options.client;
    } else {
      const command = options.command || process.env.ZCODE_SERVER_NODE || defaultCommand().command;
      const args = options.args || (process.env.ZCODE_SERVER_NODE
        ? [process.env.ZCODE_SERVER_ENTRY || join(process.env.ZCODE_SERVER_RUNTIME_ROOT || join(homedir(), ".zcode", "server"), "zcode-server.cjs")]
        : defaultCommand().args);
      this.client = new ZcodeAppServerClient({ command, args, cwd: this.cwd });
    }
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      await this.client.start();
      const result = record(await this.callAgent("initialize", this.workspace()));
      if (result.available !== true) {
        // provider_not_ready only blocks session CREATION; discovery and
        // messaging of existing sessions (listSessions/sendPrompt) work —
        // degrade instead of failing the whole adapter.
        const reason = nonEmptyString(result.reason) || "ZCode app-server reported unavailable";
        console.error(`[agent-herder-zcode] app-server degraded: ${reason}`);
      }
      this.initialized = true;
    } catch (error) {
      await this.client.close().catch(() => undefined);
      throw new Error(`Cannot initialize ZCode app-server: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  isReady(): boolean { return this.initialized; }

  async dispose(): Promise<void> {
    this.initialized = false;
    await this.client.close();
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<AgentSession[]> {
    const workspace = this.workspace(options.cwd);
    const result = await this.callAgent("listSessions", {
      ...workspace,
      includeArchived: false,
      limit: 200,
    });
    const rows: unknown[] = Array.isArray(result)
      ? result
      : (Array.isArray(record(result).sessions) ? record(result).sessions as unknown[] : []);
    return Promise.all(rows.map(async (row) => {
      const info = sessionInfoFromPayload(row);
      if (!info) throw new Error("ZCode returned an invalid listSessions entry");
      const rowWorkspace = this.workspace(nonEmptyString(record(info.workspace).workspacePath) || workspace.workspacePath);
      this.sessionWorkspaces.set(info.sessionId, rowWorkspace);
      let mapped = mapSession(row, rowWorkspace.workspacePath);
      if (!mapped.lastMessage) {
        try {
          const snapshot = await this.readSnapshot(info.sessionId, rowWorkspace, 1);
          mapped = mapSession(snapshot, rowWorkspace.workspacePath, mapped.title);
        } catch {
          // A list row is still useful when a historical snapshot cannot be read.
        }
      }
      return mapped;
    }));
  }

  async getSession(id: string): Promise<AgentSession | null> {
    try {
      const workspace = this.sessionWorkspaces.get(id) || this.workspace();
      const snapshot = await this.readSnapshot(id, workspace);
      this.sessionWorkspaces.set(id, workspace);
      return mapSession(snapshot, workspace.workspacePath);
    } catch {
      return null;
    }
  }

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    const workspace = this.workspace(options.cwd);
    const snapshot = await this.callAgent("createSession", {
      ...workspace,
      sessionTraceId: randomUUID(),
      mode: "build",
      persistence: "persistent",
    });
    const info = sessionInfoFromPayload(snapshot);
    if (!info) throw new Error("ZCode createSession returned no sessionId");
    this.sessionWorkspaces.set(info.sessionId, workspace);
    return mapSession(snapshot, workspace.workspacePath, options.name);
  }

  async getParent(id: string): Promise<AgentSession | null> {
    const session = await this.getSession(id);
    const parentId = typeof session?.meta?.parentSessionId === "string" ? session.meta.parentSessionId : undefined;
    return parentId ? this.getSession(parentId) : null;
  }

  async listChildren(id: string): Promise<AgentSession[]> {
    const session = await this.getSession(id);
    if (!session) return [];
    const sessions = await this.listSessions({ cwd: session.cwd });
    return sessions.filter((candidate) => candidate.meta?.parentSessionId === id);
  }

  async sendMessage(id: string, options: SendMessageOptions): Promise<{ ok: boolean; error?: string }> {
    try {
      const workspace = this.sessionWorkspaces.get(id) || this.workspace();
      await this.callAgent("sendPrompt", {
        ...workspace,
        sessionId: id,
        inputId: randomUUID(),
        content: options.message,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async stopSession(id: string): Promise<ControlResult> {
    return this.stopGeneration(id);
  }

  async cancelTurn(id: string): Promise<ControlResult> {
    return this.stopGeneration(id);
  }

  private async stopGeneration(id: string): Promise<ControlResult> {
    try {
      const workspace = this.sessionWorkspaces.get(id) || this.workspace();
      await this.callTask("stopGeneration", { ...workspace, taskId: id });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async detach(_id: string): Promise<ControlResult> {
    return { ok: true };
  }

  async terminate(id: string): Promise<ControlResult> {
    try {
      const workspace = this.sessionWorkspaces.get(id) || this.workspace();
      await this.callAgent("closeSession", { ...workspace, sessionId: id });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async recover(id: string, message?: string): Promise<ControlResult> {
    const resumed = await this.resumeSession(id);
    if (!resumed.ok || !message) return resumed;
    const sent = await this.sendMessage(id, { message, queue: true });
    return sent.ok ? resumed : { ok: false, error: sent.error };
  }

  async forkSession(_id: string, _message?: string): Promise<ControlResult> {
    return unsupported("fork");
  }

  async respondPermission(
    sessionId: string,
    permissionId: string,
    response: "allow" | "deny",
    remember = false,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const workspace = this.sessionWorkspaces.get(sessionId) || this.workspace();
      await this.callTask("respondPermission", {
        ...workspace,
        taskId: sessionId,
        requestId: permissionId,
        optionId: response === "deny" ? "deny" : remember ? "allowAlways" : "allowOnce",
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async setPermissions(_sessionId: string, _options: SetPermissionsOptions): Promise<{ ok: boolean; error?: string }> {
    return unsupported("permissions");
  }

  async changeModel(sessionId: string, model: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const workspace = this.sessionWorkspaces.get(sessionId) || this.workspace();
      const snapshot = await this.readSnapshot(sessionId, workspace, 1);
      const current = record(record(snapshot).settings).model;
      const currentModel = record(current).current as ZcodeModelRef | undefined;
      const modelRef = parseModelName(model, currentModel?.providerId);
      if (!modelRef?.providerId || !modelRef.modelId) {
        return { ok: false, error: "ZCode model must be provider/model or a model ID with a known current provider" };
      }
      await this.callAgent("setModel", { ...workspace, sessionId, model: modelRef });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async getTranscript(id: string): Promise<string | null> {
    const messages = await this.getSessionMessages(id, 200);
    if (!messages || messages.length === 0) return null;
    return messages
      .map((message) => `${message.role}: ${message.text || message.parts.map((part) => part.text || part.output || "").join(" ")}`)
      .join("\n\n");
  }

  async getRawTranscript(id: string): Promise<RawTranscriptExport | null> {
    try {
      const workspace = this.sessionWorkspaces.get(id) || this.workspace();
      const snapshot = await this.readSnapshot(id, workspace);
      return {
        bytes: Buffer.from(JSON.stringify(snapshot, null, 2), "utf8"),
        complete: true,
        source: { kind: "native-api", location: "zcode app-server session/read", format: "json" },
        timestampCoverage: "native",
      };
    } catch {
      return null;
    }
  }

  async getSessionMessages(id: string, limit = 100): Promise<SessionMessageView[] | null> {
    try {
      const workspace = this.sessionWorkspaces.get(id) || this.workspace();
      const result = await this.callAgent("readSessionMessages", {
        ...workspace,
        sessionId: id,
        limit,
      });
      return snapshotMessages(result).map(mapMessage);
    } catch {
      return null;
    }
  }

  async resumeSession(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const workspace = this.sessionWorkspaces.get(id) || this.workspace();
      const snapshot = await this.callAgent("resumeSession", { ...workspace, sessionId: id });
      this.sessionWorkspaces.set(id, workspace);
      if (!sessionInfoFromPayload(snapshot)) throw new Error("ZCode resumeSession returned no sessionId");
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async listModels(): Promise<string[]> {
    const configured = [...this.modelIds];
    if (this.useLocalConfig) {
      try {
        const raw = JSON.parse(await readFile(join(homedir(), ".zcode", "cli", "config.json"), "utf8")) as { model?: Record<string, unknown> };
        for (const value of Object.values(raw.model ?? {})) {
          if (typeof value === "string" && value.trim()) configured.push(value.trim());
        }
      } catch { /* local CLI config is optional */ }
    }
    try {
      const state = record(await Promise.race([
        this.callAgent("readWorkspaceState", this.workspace()),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("ZCode model catalog timeout")), 2_500)),
      ]));
      const settingsModel = record(record(state.settings).model);
      const available = Array.isArray(settingsModel.available) ? settingsModel.available : [];
      const models = available.map(modelNameFromCatalogEntry).filter((model): model is string => Boolean(model));
      return [...new Set([...models, ...configured])];
    } catch {
      return [...new Set(configured)];
    }
  }

  private workspace(cwd = this.cwd): ZcodeWorkspaceRef {
    const canonical = resolve(cwd);
    return { workspacePath: canonical, workspaceIdentity: canonical, workspaceKey: canonical };
  }

  private async readSnapshot(id: string, workspace: ZcodeWorkspaceRef, messageLimit?: number): Promise<ZcodeSnapshot> {
    return await this.callAgent("readSession", {
      ...workspace,
      sessionId: id,
      ...(messageLimit !== undefined ? { messageLimit } : {}),
    }) as ZcodeSnapshot;
  }

  private async callAgent(method: string, ...args: unknown[]): Promise<unknown> {
    await this.client.start();
    return this.client.call("zcode-agent", method, args);
  }

  private async callTask(method: string, ...args: unknown[]): Promise<unknown> {
    await this.client.start();
    return this.client.call("zcode-task", method, args);
  }
}
