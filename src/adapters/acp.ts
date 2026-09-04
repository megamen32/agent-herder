import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type ClientSideConnection as ClientConnection,
} from "@agentclientprotocol/sdk";
import type {
  AgentCapabilities,
  ContentBlock,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type {
  AgentSession,
  CreateSessionOptions,
  HarnessAdapter,
  RawTranscriptExport,
  PermissionRequest,
  SendMessageOptions,
  SetPermissionsOptions,
  SessionMessagePart,
  SessionMessageView,
  HarnessType,
  HarnessCapabilities,
} from "../types/index.js";

export interface AcpAgentConfig {
  profile: string;
  harness?: HarnessType;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  modelIds?: string[];
}

interface CachedSession {
  session: AgentSession;
  transcript: string[];
  messages: SessionMessageView[];
}

/**
 * Owns one long-lived ACP child process and exposes its sessions as a harness adapter.
 * A process is never re-created for an ordinary prompt, which avoids concurrent
 * `--resume` calls against a transcript owned by another transport.
 */
export class AcpAdapter implements HarnessAdapter {
  readonly type: HarnessType;
  readonly name: string;
  readonly controlCapabilities: HarnessCapabilities = {
    cancelTurn: true,
    detach: true,
    resume: true,
    terminate: false,
    recover: true,
    fork: false,
    modelSwitch: true,
    subagents: false,
    events: true,
  };

  private readonly config: AcpAgentConfig;
  private readonly modelIds: string[];
  private child?: ChildProcessWithoutNullStreams;
  private connection?: ClientConnection;
  private capabilities?: AgentCapabilities;
  private readonly sessions = new Map<string, CachedSession>();
  private readonly pendingPermissions = new Map<string, {
    request: PermissionRequest;
    resolve: (response: RequestPermissionResponse) => void;
    allowOptionId?: string;
    denyOptionId?: string;
  }>();
  private initPromise?: Promise<void>;

  constructor(config: AcpAgentConfig) {
    this.config = config;
    this.type = config.harness || "claude";
    this.modelIds = [...(config.modelIds || [])];
    this.name = `ACP (${config.profile})`;
  }

  async init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.start();
    return this.initPromise;
  }

  async listSessions(): Promise<AgentSession[]> {
    await this.init();
    if (!this.capabilities?.sessionCapabilities?.list) {
      throw new Error(`ACP agent '${this.config.profile}' does not advertise session/list`);
    }

    const response = await this.connection!.listSessions({});
    const sessions = response.sessions.map((info) => this.cacheSession({
      id: this.externalId(info.sessionId),
      harness: this.type,
      status: "idle",
      title: info.title || "Untitled ACP session",
      cwd: info.cwd,
      lastActivity: info.updatedAt || new Date().toISOString(),
      needsPermission: false,
      meta: { transport: "acp", profile: this.config.profile, nativeSessionId: info.sessionId },
    }));
    return sessions;
  }

  async getSession(id: string): Promise<AgentSession | null> {
    const cached = this.sessions.get(id);
    if (cached) return cached.session;
    const listed = await this.listSessions();
    return listed.find((session) => session.id === id || session.meta?.nativeSessionId === id) || null;
  }

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    await this.init();
    const created = await this.connection!.newSession({ cwd: resolve(options.cwd), mcpServers: [] });
    const id = this.externalId(created.sessionId);
    const session = this.cacheSession({
      id, harness: this.type, status: "idle", title: options.name, cwd: resolve(options.cwd),
      lastActivity: new Date().toISOString(), model: options.model, needsPermission: false, messageCount: 0,
      meta: { transport: "acp", profile: this.config.profile, nativeSessionId: created.sessionId },
    });
    if (options.model) {
      const changed = await this.changeModel(id, options.model);
      if (!changed.ok) throw new Error(changed.error || `Could not select model '${options.model}'`);
    }
    return session;
  }

  async sendMessage(id: string, options: SendMessageOptions): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.init();
      const session = await this.getSession(id);
      if (!session) return { ok: false, error: `ACP session '${id}' not found` };
      const externalId = this.externalId(this.nativeId(id));
      const cached = this.sessions.get(externalId)!;
      cached.session.status = "running";
      cached.transcript.push(`User: ${options.message}`);
      appendTextMessage(cached, "user", options.message);
      const prompt = this.connection!.prompt({
        sessionId: this.nativeId(id),
        prompt: [{ type: "text", text: options.message } as ContentBlock],
      });
      if (options.queue) {
        void prompt.then(() => this.markIdle(externalId)).catch((err: unknown) => this.markError(externalId, err));
        return { ok: true };
      }
      const result = await prompt;
      if (result.stopReason === "cancelled" || result.stopReason === "refusal" || result.stopReason === "max_tokens") {
        return { ok: false, error: `ACP prompt stopped with '${result.stopReason}'` };
      }
      this.markIdle(externalId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async resumeSession(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.init();
      const session = await this.getSession(id);
      if (!session) return { ok: false, error: `ACP session '${id}' not found` };
      const nativeId = this.nativeId(id);
      if (this.capabilities?.loadSession) {
        await this.connection!.loadSession({ sessionId: nativeId, cwd: session.cwd, mcpServers: [] });
      } else if (this.capabilities?.sessionCapabilities?.resume) {
        await this.connection!.resumeSession({ sessionId: nativeId, cwd: session.cwd, mcpServers: [] });
      } else {
        return { ok: false, error: `ACP agent '${this.config.profile}' supports neither session/load nor session/resume` };
      }
      this.markIdle(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async stopSession(id: string): Promise<{ ok: boolean; error?: string }> {
    return this.cancelTurn(id);
  }

  async cancelTurn(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.init();
      const nativeId = this.nativeId(id);
      await this.connection!.cancel({ sessionId: nativeId });
      this.markIdle(this.externalId(nativeId));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async detach(_id: string): Promise<{ ok: boolean; error?: string }> {
    return { ok: true };
  }

  async recover(id: string, message?: string): Promise<{ ok: boolean; error?: string }> {
    const resumed = await this.resumeSession(id);
    if (!resumed.ok || !message) return resumed;
    return this.sendMessage(id, { message, queue: false });
  }

  async respondPermission(
    _sessionId: string,
    permissionId: string,
    response: "allow" | "deny",
  ): Promise<{ ok: boolean; error?: string }> {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) return { ok: false, error: `Permission '${permissionId}' not found` };
    this.pendingPermissions.delete(permissionId);
    const optionId = response === "allow" ? pending.allowOptionId : pending.denyOptionId;
    if (optionId) pending.resolve({ outcome: { outcome: "selected", optionId } });
    else pending.resolve({ outcome: { outcome: "cancelled" } });
    return { ok: true };
  }

  async setPermissions(_sessionId: string, _options: SetPermissionsOptions): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: "ACP permissions are controlled per request by the web/MCP permission flow" };
  }

  async changeModel(id: string, model: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.init();
      if (!id) return { ok: false, error: "ACP model changes require a session ID" };
      const session = await this.getSession(id);
      if (!session) return { ok: false, error: `ACP session '${id}' not found` };
      const sessionId = this.nativeId(id);

      if (this.type === "qoder") {
        try {
          await this.connection!.setSessionConfigOption({ sessionId, configId: "model", value: model });
          session.model = model;
          return { ok: true };
        } catch {
          // Qoder versions that do not expose the config option may expose the ACP experimental method.
        }
      }

      try {
        await this.connection!.unstable_setSessionModel({ sessionId, modelId: model });
        session.model = model;
        return { ok: true };
      } catch {
        if (this.type !== "qoder") {
          try {
            await this.connection!.setSessionConfigOption({ sessionId, configId: "model", value: model });
            session.model = model;
            return { ok: true };
          } catch {
            // Report one stable error below instead of leaking transport-specific details.
          }
        }
      }
      return { ok: false, error: `ACP agent '${this.config.profile}' does not support model switching` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async listModels(): Promise<string[]> {
    await this.init();
    return [...this.modelIds];
  }

  async getTranscript(id: string): Promise<string | null> {
    await this.init();
    const cached = this.sessions.get(this.externalId(this.nativeId(id)));
    return cached ? cached.transcript.join("\n\n") : null;
  }

  async getRawTranscript(id: string): Promise<RawTranscriptExport | null> {
    await this.init();
    const cached = this.sessions.get(this.externalId(this.nativeId(id)));
    if (!cached) return null;
    return {
      bytes: Buffer.from(cached.transcript.join("\n\n")),
      complete: false,
      source: { kind: "observed-acp-events", location: this.config.profile, format: "text" },
      timestampCoverage: "none",
      limitations: ["ACP archive contains only events observed by this connection."],
    };
  }

  async getSessionMessages(id: string, limit = 3): Promise<SessionMessageView[] | null> {
    await this.init();
    const session = await this.getSession(id);
    if (!session) return null;
    const externalId = this.externalId(this.nativeId(id));
    const cached = this.sessions.get(externalId);
    if (!cached) return null;
    const beforeReplay = cached.messages.length;
    if (!this.capabilities?.loadSession) return null;
    await this.connection!.loadSession({ sessionId: this.nativeId(id), cwd: session.cwd, mcpServers: [] });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const replayed = cached.messages.slice(beforeReplay);
    return replayed.length > 0 ? replayed.slice(-Math.max(1, limit)) : null;
  }

  getPendingPermissionRequests(): PermissionRequest[] {
    return [...this.pendingPermissions.values()].map(({ request }) => request);
  }

  async dispose(): Promise<void> {
    this.connection = undefined;
    if (this.child && !this.child.killed) this.child.kill();
    this.child = undefined;
    this.initPromise = undefined;
  }

  private async start(): Promise<void> {
    const child = spawn(this.config.command, this.config.args || [], {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env },
      stdio: "pipe",
    });
    this.child = child;
    child.on("error", (err) => this.markAllError(err));
    child.on("exit", (code, signal) => {
      if (code !== 0 && signal !== "SIGTERM") this.markAllError(new Error(`ACP process exited with ${code ?? signal}`));
    });

    const client: Client = {
      requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        const permission: PermissionRequest = {
          id: `acp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: "tool_use",
          description: params.toolCall.title || "ACP agent requested permission",
          toolName: params.toolCall.title || undefined,
          details: JSON.stringify(params.toolCall, null, 2),
        };
        return new Promise<RequestPermissionResponse>((resolve) => {
          this.pendingPermissions.set(permission.id, {
            request: permission,
            resolve,
            allowOptionId: params.options.find((option) => option.kind.startsWith("allow"))?.optionId,
            denyOptionId: params.options.find((option) => option.kind.startsWith("reject"))?.optionId,
          });
          setTimeout(() => {
            if (!this.pendingPermissions.delete(permission.id)) return;
            resolve({ outcome: { outcome: "cancelled" } });
          }, 300_000).unref();
        });
      },
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        const cached = this.sessions.get(this.externalId(params.sessionId));
        if (!cached) return;
        cached.session.lastActivity = new Date().toISOString();
        const update = params.update as unknown as Record<string, unknown>;
        const kind = String(update.sessionUpdate || "");
        const content = update.content as { type?: string; text?: string } | undefined;
        if ((kind === "agent_message_chunk" || kind === "user_message_chunk") && content?.type === "text" && content.text) {
          const role = kind === "user_message_chunk" ? "user" : "assistant";
          appendTextMessage(cached, role, content.text);
          cached.transcript.push(`${role === "user" ? "User" : "Assistant"}: ${content.text}`);
          cached.session.lastMessage = content.text.slice(0, 300);
        } else if (kind === "agent_thought_chunk" && content?.type === "text" && content.text) {
          appendPartMessage(cached, "assistant", { type: "thinking", text: content.text });
          cached.transcript.push(`Thinking: ${content.text}`);
        } else if (kind === "tool_call") {
          appendPartMessage(cached, "assistant", {
            type: "tool_call",
            name: typeof update.title === "string" ? update.title : typeof update.name === "string" ? update.name : "tool",
            input: update.rawInput,
          });
        } else if (kind === "tool_call_update") {
          appendToolResult(cached, {
            type: "tool_result",
            name: typeof update.title === "string" ? update.title : undefined,
            output: typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput || ""),
            error: /fail|error/i.test(String(update.status || "")),
          });
        }
      },
      readTextFile: async ({ path }) => ({ content: await this.readWorkspaceFile(path) }),
      writeTextFile: async ({ path, content }) => {
        await this.writeWorkspaceFile(path, content);
        return {};
      },
    };

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const connection = new ClientSideConnection(() => client, stream);
    this.connection = connection;
    const initialized = await connection.initialize({
      protocolVersion: 1,
      clientInfo: { name: "agent-herder", version: "0.3.0" },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    this.capabilities = initialized.agentCapabilities;
  }

  private cacheSession(session: AgentSession): AgentSession {
    const previous = this.sessions.get(session.id);
    this.sessions.set(session.id, {
      session: { ...previous?.session, ...session },
      transcript: previous?.transcript || [],
      messages: previous?.messages || [],
    });
    return this.sessions.get(session.id)!.session;
  }

  private externalId(nativeId: string): string {
    return `acp:${this.config.profile}:${nativeId}`;
  }

  private nativeId(id: string): string {
    const prefix = `acp:${this.config.profile}:`;
    return id.startsWith(prefix) ? id.slice(prefix.length) : id;
  }

  private markIdle(id: string): void {
    const cached = this.sessions.get(id);
    if (cached) cached.session.status = "idle";
  }

  private markError(id: string, err: unknown): void {
    const cached = this.sessions.get(id);
    if (cached) {
      cached.session.status = "error";
      cached.session.lastMessage = (err as Error).message;
    }
  }

  private markAllError(err: unknown): void {
    for (const id of this.sessions.keys()) this.markError(id, err);
  }

  private resolveWorkspacePath(path: string): string {
    const cwd = resolve(this.config.cwd || process.cwd());
    const candidate = resolve(cwd, path);
    const rel = relative(cwd, candidate);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`ACP path escapes workspace: ${path}`);
    return candidate;
  }

  private async readWorkspaceFile(path: string): Promise<string> {
    return readFile(this.resolveWorkspacePath(path), "utf8");
  }

  private async writeWorkspaceFile(path: string, content: string): Promise<void> {
    await writeFile(this.resolveWorkspacePath(path), content, "utf8");
  }
}

function appendTextMessage(cached: CachedSession, role: "user" | "assistant", text: string): void {
  const last = cached.messages.at(-1);
  const lastPart = last?.parts.at(-1);
  if (last && last.role === role && lastPart?.type === "text") {
    lastPart.text = `${lastPart.text || ""}${text}`;
    last.text = lastPart.text;
    return;
  }
  cached.messages.push({ id: `${role}-${Date.now()}-${cached.messages.length}`, role, text, parts: [{ type: "text", text }] });
}

function appendPartMessage(cached: CachedSession, role: "assistant" | "tool", part: SessionMessagePart): void {
  const last = cached.messages.at(-1);
  if (last && last.role === role) {
    last.parts.push(part);
    return;
  }
  cached.messages.push({ id: `${role}-${Date.now()}-${cached.messages.length}`, role, parts: [part] });
}

function appendToolResult(cached: CachedSession, part: SessionMessagePart): void {
  const owner = [...cached.messages].reverse().find((message) =>
    message.role === "assistant" && message.parts.some((candidate) => candidate.type === "tool_call"),
  );
  if (owner) {
    owner.parts.push(part);
    return;
  }
  appendPartMessage(cached, "tool", part);
}
