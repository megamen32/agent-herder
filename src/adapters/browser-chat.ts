import type { AgentSession, ControlResult, CreateSessionOptions, HarnessAdapter, HarnessCapabilities, HarnessType, ListSessionsOptions, SendMessageOptions, SendMessageResult, SetPermissionsOptions } from "../types/index.js";
import { localSessionHostId, type SessionMessageView } from "../types/index.js";
import { BrowserChatHistoryCache } from "./browser-chat-history-cache.js";
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
  /** Only a currently selected generating chat has a real Stop control. */
  stopVisible?: boolean;
}

/** A browser transport owns its authenticated page and implements these operations. */
export interface BrowserChatDriver {
  listChats(signal?: AbortSignal): Promise<readonly BrowserChat[]>;
  getChat?(chatId: string, signal?: AbortSignal): Promise<BrowserChat | null>;
  /** Pure exact-link metadata without browser navigation. Allows opening an
   * older chat outside the current 100-item inventory from an existing URL.
   * This is NOT proof that a send would be accepted by the remote site.
   */
  getKnownChat?(chatId: string): BrowserChat | null;
  /** Authenticated read-only owner API; no navigation or model turn. */
  getMessages?(chatId: string): Promise<SessionMessageView[] | null>;
  /** SHA-256 browser account ID; never a token, cookie or display name. */
  getAccountScope?(): string | undefined;
  sendMessage(
    input: { chatId: string; text: string; waitForCompletion?: boolean },
    signal?: AbortSignal,
  ): Promise<{ assistantText?: string }>;
  /** Stop only the actively generating turn of this exact conversation.
   * Never navigates to another chat to find a Stop button.
   */
  stopTurn?(chatId: string, signal?: AbortSignal): Promise<{ stopped: boolean; error?: string }>;
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
  private readonly inventory = new Map<string, BrowserChat>();
  private inventoryAt = 0;
  private inventoryRefresh: Promise<void> | undefined;
  private readonly historyCache: BrowserChatHistoryCache;


  constructor(
    private readonly driver: BrowserChatDriver,
    private readonly provider: BrowserChatProvider,
    private readonly cwd = provider.cwd,
    private readonly scopedIds = false,
  ) {
    this.historyCache = new BrowserChatHistoryCache(
      provider.id === "zai" ? "zai" : "chatgpt",
      nativeId => this.driver.getMessages?.(nativeId) ?? Promise.resolve(null),
    );
    this.type = provider.harness;
    this.name = provider.name;
    this.controlCapabilities = {
      ...BrowserChatAdapter.browserCapabilities,
      cancelTurn: typeof driver.stopTurn === "function",
      modelSwitch: driver.supportsModelSwitch?.() ?? typeof driver.changeModel === "function",
    };
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

  private updateInventory(chats: readonly BrowserChat[]): void {
    this.inventory.clear();
    for (const chat of chats) this.inventory.set(chat.id, chat);
    this.inventoryAt = Date.now();
    this.historyCache.setAccountScope(this.driver.getAccountScope?.());
    this.historyCache.prewarm(chats.map(chat => chat.id));
  }

  async init(): Promise<void> {
    this.updateInventory(await this.driver.listChats());
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<AgentSession[]> {
    void options;
    if (this.inventory.size) {
      // Cached titles and session identity are also stale-while-revalidate.
      // Never block selected-chat details on an unrelated 100-chat API list.
      if (Date.now() - this.inventoryAt > 30_000 && !this.inventoryRefresh) {
        this.inventoryRefresh = this.driver.listChats().then(chats => {
          this.updateInventory(chats);
        }).catch(() => undefined).finally(() => { this.inventoryRefresh = undefined; });
      }
      return [...this.inventory.values()].map(chat => this.toSession(chat));
    }
    const chats = await this.driver.listChats();
    this.updateInventory(chats);
    return chats.map(chat => this.toSession(chat));
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
    // Never navigate the user's browser merely to display history metadata.
    const observed = this.inventory.get(native);
    if (observed) return this.toSession(observed);
    // An exact deep link outside the current 100 chats must not switch the
    // user's browser tab just to resolve the frontend's session header.
    const known = this.driver.getKnownChat?.(native);
    if (known) return this.toSession(known);
    const chat = this.driver.getChat
      ? await this.driver.getChat(native)
      : (await this.driver.listChats()).find((entry) => entry.id === native);
    return chat ? this.toSession(chat) : null;
  }

  async getSessionMessages(id: string, limit = 100): Promise<SessionMessageView[] | null> {
    const native = this.nativeId(id);
    if (!this.driver.getMessages) return null;
    if (this.historyCache.available) return this.historyCache.messages(native, limit);
    const live = await this.driver.getMessages(native);
    return live?.slice(-Math.max(1, limit)) ?? null;
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

  /** Stop and cancel both map to the site's own Stop-generation control.
   * The native chat stays alive and can accept subsequent human messages.
   */
  async stopSession(id: string): Promise<ControlResult> {
    return this.cancelTurn(id);
  }

  async cancelTurn(id: string): Promise<ControlResult> {
    if (!this.driver.stopTurn) {
      return { ok: false, error: `${this.provider.name} does not expose a verified Stop control` };
    }
    try {
      const receipt = await this.driver.stopTurn(this.nativeId(id));
      return receipt.stopped ? { ok: true, sessionId: id } :
        { ok: false, error: receipt.error || "No running turn to stop in the selected conversation" };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
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
        stopVisible: chat.stopVisible === true,
        timestampSemantics: chat.updatedAtSemantics ?? "native-or-visible-order",
      },
    };
  }
}
