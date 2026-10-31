import type { AgentSession, ControlResult, CreateSessionOptions, HarnessAdapter, HarnessCapabilities, HarnessType, ListSessionsOptions, SendMessageOptions, SendMessageResult, SetPermissionsOptions } from "../types/index.js";
import { localSessionHostId } from "../types/index.js";
/** Normalized browser chat; native IDs belong to their provider driver. */
export interface BrowserChat {
  id: string;
  title: string;
  unread: boolean;
  working: boolean;
  updatedAt: string;
  sourceRoute?: string;
  updatedAtSemantics?: string;
  providerId?: string;
  cwd?: string;
}

/** A browser transport owns its authenticated page and implements these operations. */
export interface BrowserChatDriver {
  listChats(signal?: AbortSignal): Promise<readonly BrowserChat[]>;
  getChat?(chatId: string, signal?: AbortSignal): Promise<BrowserChat | null>;
  sendMessage(
    input: { chatId: string; text: string; waitForCompletion?: boolean },
    signal?: AbortSignal,
  ): Promise<{ assistantText?: string }>;
  createChat?(input: { title?: string }, signal?: AbortSignal): Promise<BrowserChat>;
  listModels?(signal?: AbortSignal): Promise<string[]>;
  supportsModelSwitch?(): boolean;
  changeModel?(input: { chatId: string; model: string }, signal?: AbortSignal): Promise<{ ok: boolean; error?: string }>;
  /** Explicit site contract. Feature reporting must not be inferred from the common base. */
  browserFeatures?: {
    nativeConversationIds: boolean;
    queueAfterGeneration: boolean;
    chatCreation: boolean;
    accountArchiveViaCdp: boolean;
  };
}
export interface BrowserChatProvider { id: string; name: string; harness: HarnessType; cwd: string }


/**
 * One HarnessAdapter for a browser-owned conversation provider.
 *
 * Keeps authentication, Chrome profile, selectors and page leases in the
 * provider driver. Never starts an independent browser or silently creates
 * a chat while trying to resume an existing one.
 */
export class BrowserChatAdapter implements HarnessAdapter {
  readonly type: HarnessType;
  readonly name: string;
  readonly controlCapabilities: HarnessCapabilities;
  readonly browserFeatures: NonNullable<BrowserChatDriver["browserFeatures"]>;
  private static readonly browserCapabilities: HarnessCapabilities = {
    cancelTurn: false,
    detach: false,
    resume: true,
    terminate: false,
    recover: false,
    fork: false,
    modelSwitch: false,
    subagents: false,
    events: false,
  };
  readonly lazyDiscovery = true;

  constructor(
    private readonly driver: BrowserChatDriver,
    private readonly provider: BrowserChatProvider,
    private readonly cwd = provider.cwd,
    private readonly scopedIds = false,
  ) {
    this.type = provider.harness;
    this.name = provider.name;
    this.controlCapabilities = { ...BrowserChatAdapter.browserCapabilities,
      modelSwitch: driver.supportsModelSwitch?.() ?? typeof driver.changeModel === "function" };
    this.browserFeatures = driver.browserFeatures ?? {
      nativeConversationIds: false,
      queueAfterGeneration: false,
      chatCreation: typeof driver.createChat === "function",
      accountArchiveViaCdp: false,
    };
  }

  private scopedId(nativeId: string): string {
    return this.scopedIds ? `${this.provider.id}::${encodeURIComponent(nativeId)}` : nativeId;
  }

  private nativeId(id: string): string {
    if (!this.scopedIds) return id;
    const prefix = `${this.provider.id}::`;
    if (!id.startsWith(prefix)) throw new Error("Browser session belongs to another provider");
    let nativeId: string;
    try { nativeId = decodeURIComponent(id.slice(prefix.length)); }
    catch { throw new Error("Invalid encoded browser session"); }
    if (!nativeId) throw new Error("Empty native browser session");
    return nativeId;
  }

  async init(): Promise<void> {
    await this.driver.listChats();
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<AgentSession[]> {
    void options;
    return (await this.driver.listChats()).map((chat) => this.toSession(chat));
  }

  async findNamedSessions(name: string, cwd: string): Promise<AgentSession[]> {
    void cwd;
    const normalized = name.trim();
    return (await this.driver.listChats())
      .filter((chat) => chat.title.trim() === normalized)
      .map((chat) => this.toSession(chat));
  }

  /** Launch one ChatGPT session: a new disposable chat becomes the session. */
  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    if (!this.driver.createChat) {
      throw new Error("This browser provider does not create chats");
    }
    const chat = await this.driver.createChat({ title: options.name });
    return {
      ...this.toSession(chat),
      meta: {
        ...this.toSession(chat).meta,
        ...(options.model ? { model: options.model } : {}),
      },
    };
  }

  /** Models the page's own model picker offers. */
  async listModels(): Promise<string[]> {
    return this.driver.listModels ? this.driver.listModels() : [];
  }

  /** Select one model for one chat through the page's own picker. */
  async changeModel(sessionId: string, model: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.driver.changeModel) {
      return { ok: false, error: "This browser provider does not expose a model picker" };
    }
    return this.driver.changeModel({ chatId: this.nativeId(sessionId), model });
  }

  async getSession(id: string): Promise<AgentSession | null> {
    const native = this.nativeId(id);
    const chat = this.driver.getChat
      ? await this.driver.getChat(native)
      : (await this.driver.listChats()).find((entry) => entry.id === native);
    return chat ? this.toSession(chat) : null;
  }

  async sendMessage(id: string, options: SendMessageOptions): Promise<SendMessageResult> {
    try {
      await this.driver.sendMessage({
        chatId: this.nativeId(id),
        text: options.message,
        waitForCompletion: options.queue !== true,
      });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Only a proven pre-click busy state is retryable. Never replay a click
      // whose admission may already have reached either browser provider.
      if (/prompt is already running/i.test(message)) return { ok: false, error: message };
      if (/(?:ZAI|ChatGPT) submission (outcome|admission) unknown/i.test(message)) {
        return { ok: false, error: message, admissionUnknown: true, nonRetryable: true };
      }
      return { ok: false, error: message, notSubmitted: true, nonRetryable: true };
    }
  }

  /** Browser conversations are resumable; a message is the resume action. */
  async resumeSession(id: string): Promise<ControlResult> {
    const session = await this.getSession(id);
    return session ? { ok: true, sessionId: id } : { ok: false, error: `Browser chat '${id}' not found` };
  }

  async stopSession(): Promise<ControlResult> {
    return { ok: false, error: "This browser provider does not expose native turn cancellation" };
  }

  async respondPermission(): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: "This browser provider does not expose Herder permission prompts" };
  }

  async setPermissions(_sessionId: string, _options: SetPermissionsOptions): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: "Browser chat permissions are controlled by their provider" };
  }

  private toSession(chat: BrowserChat): AgentSession {
    return {
      id: this.scopedId(chat.id),
      harness: this.type,
      status: chat.working ? "running" : "idle",
      title: chat.title,
      cwd: chat.cwd ?? this.cwd,
      hostId: localSessionHostId(),
      lastActivity: chat.updatedAt,
      needsPermission: false,
      meta: {
        unread: chat.unread,
        sourceRoute: chat.sourceRoute,
        transport: chat.sourceRoute ? "browser-owned-page" : "owned-chat-page",
        browserProvider: chat.providerId ?? this.provider.id,
        timestampSemantics: chat.updatedAtSemantics ?? "native-or-visible-order",
      },
    };
  }
}
