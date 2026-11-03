import type { AgentSession, ControlResult, CreateSessionOptions, HarnessAdapter, HarnessCapabilities, HarnessEvent, HarnessType, ListSessionsOptions, SendMessageOptions, SendMessageResult, SetPermissionsOptions } from "../types/index.js";
import { localSessionHostId, type SessionMessageView } from "../types/index.js";
import { BrowserChatHistoryCache } from "./browser-chat-history-cache.js";
import { liveHarnessPollingEnabled } from "../harness-runtime-settings.js";
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
  /** Origin of the working signal when it is not the observed page's own DOM. */
  workingSource?: "native-last-run" | "native-async-status";
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
  /** Full paginated scan of every conversation (ChatGPT only). Paginates
   * offset=0,100,200… with a 15s gap; respects 429. Used by the Web UI
   * "Пересканировать чаты" button / Ctrl+Shift+R. */
  fullScan?(): Promise<{ count: number; pages: number }>;
<<<<<<< HEAD
=======
  /** True when listChats() keeps answering without one site request while
   * the polling of the harness is paused (the intercept stash of the page
   * plus the durable inventory). A paused harness without this flag serves
   * only what it already holds in memory. */
  readonly passiveInventory?: boolean;
>>>>>>> feat/intercept-pause-20261103T053000Z
  /** Stop only the actively generating turn of this exact conversation.
   * Never navigates to another chat to find a Stop button.
   */
  stopTurn?(chatId: string, signal?: AbortSignal): Promise<{ stopped: boolean; error?: string }>;
  /** Subscribe to modal-prompt events emitted when the driver answers (or
   * skips) a permission / 'Continue in Work?' prompt on the owned browser
   * page. The adapter forwards these as HarnessEvent of kind
   * permission.requested / permission.resolved into the shared bus. */
  subscribePromptEvents?(handler: (event: HarnessEvent) => void): () => void;
  createChat?(input: { title?: string }, signal?: AbortSignal): Promise<BrowserChat>;
  listModels?(signal?: AbortSignal): Promise<string[]>;
  supportsModelSwitch?(): boolean;
  changeModel?(input: { chatId: string; model: string }, signal?: AbortSignal): Promise<{ ok: boolean; error?: string }>;
  /** List the account's projects (ZAI: /api/v1/projects). Returns [] when unsupported. */
  listProjects?(): Promise<Array<{ id: string; name: string; chatCount?: number; archived?: boolean }>>;
  /** Move a chat into a project (ZAI: PATCH /api/v1/chats/<id> with project_id). */
  moveToProject?(input: { chatId: string; projectId: string }): Promise<{ ok: boolean; error?: string }>;
  /** Explicit site contract. Feature reporting must not be inferred from the common base. */
  browserFeatures?: {
    nativeConversationIds: boolean;
    queueAfterGeneration: boolean;
    chatCreation: boolean;
    accountArchiveViaCdp: boolean;
    /** The site has a Projects feature and chats can be moved into one. */
    projects: boolean;
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
import { registerHarnessRuntimeCapabilities, type HarnessRuntimeCapabilities } from "../types/harness-runtime.js";

/** Browser-chat harnesses (chatgpt, zai, browser-chat alias) share one runtime
 * capability set: observer-driven, no CLI, eligible for autopilot except the
 * generic browser-chat alias. */
const BROWSER_RUNTIME_CAPS: HarnessRuntimeCapabilities = { autopilotDispatch: "returnNextGoal", hookDrivenStop: false, browserChat: true, autopilotEligible: true, localInject: false, humanStopObserver: false };
registerHarnessRuntimeCapabilities("chatgpt", BROWSER_RUNTIME_CAPS);
registerHarnessRuntimeCapabilities("zai", BROWSER_RUNTIME_CAPS);
registerHarnessRuntimeCapabilities("browser-chat", { ...BROWSER_RUNTIME_CAPS, autopilotEligible: false });
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
    projects: false,
  };
  private readonly eventListeners = new Set<(event: HarnessEvent) => void>();
  private promptEventsUnsubscribe?: () => void;
  readonly runtimeCapabilities = BROWSER_RUNTIME_CAPS;
  readonly lazyDiscovery = true;
  private readonly inventory = new Map<string, BrowserChat>();
  private inventoryAt = 0;
  private inventoryRefresh: Promise<void> | undefined;
  /** The harness whose runtime switch gates this adapter's site requests. */
  private readonly pollingHarness: "chatgpt" | "zai";
  private readonly historyCache: BrowserChatHistoryCache;


  constructor(
    private readonly driver: BrowserChatDriver,
    private readonly provider: BrowserChatProvider,
    private readonly cwd = provider.cwd,
    private readonly scopedIds = false,
  ) {
    this.pollingHarness = provider.id === "zai" ? "zai" : "chatgpt";
    this.historyCache = new BrowserChatHistoryCache(
      this.pollingHarness,
      nativeId => this.driver.getMessages?.(nativeId) ?? Promise.resolve(null),
    );
    this.type = provider.harness;
    this.name = provider.name;
    const supportsPromptEvents = typeof driver.subscribePromptEvents === "function";
    this.controlCapabilities = {
      ...BrowserChatAdapter.browserCapabilities,
      cancelTurn: typeof driver.stopTurn === "function",
      modelSwitch: driver.supportsModelSwitch?.() ?? typeof driver.changeModel === "function",
      // Advertise event emission only when the underlying driver actually
      // emits modal-prompt events; otherwise the supervisor would call
      // subscribeEvents and get nothing.
      events: supportsPromptEvents,
      projects: driver.browserFeatures?.projects ?? false,
    };
    if (supportsPromptEvents) {
      // The unsubscribe is held for the adapter's lifetime: the driver emits
      // permission.requested / permission.resolved events whenever it
      // answers (or skips) a modal prompt, and the adapter fans them out to
      // every registered listener (the supervisor, the permission-control
      // notice-bridge, the UI event bus).
      this.promptEventsUnsubscribe = driver.subscribePromptEvents?.((event) => this.emitEvent(event));
    }
    this.browserFeatures = driver.browserFeatures ?? {
      nativeConversationIds: false,
      queueAfterGeneration: false,
      chatCreation: typeof driver.createChat === "function",
      accountArchiveViaCdp: false,
      projects: false,
    };
  }

  private scopedId(nativeId: string): string {
    return this.scopedIds ? `${this.provider.id}::${encodeURIComponent(nativeId)}` : nativeId;
  }

  private nativeId(id: string): string {
    if (!this.scopedIds) return id;
    const prefix = `${this.provider.id}::`;
    if (id.startsWith(prefix)) {
      let nativeId: string;
      try { nativeId = decodeURIComponent(id.slice(prefix.length)); }
      catch { throw new Error("Invalid encoded browser session"); }
      if (!nativeId) throw new Error("Empty native browser session");
      return nativeId;
    }
    // An id carrying another provider's scoped prefix must still be
    // refused: cross-provider leaks cannot become possible via the
    // fallback path.
    if (id.includes("::")) throw new Error("Browser session belongs to another provider");
    // Accept a raw native id directly: HTTP routes like
    // /api/sessions/<harness>/<native-id>/<action> and MCP callers do not
    // know the scoped-id convention. The ZAI driver keys deep-link chats
    // by a `route:` prefix (its listChats emits id="route:<uuid>"), so a
    // raw native uuid must be normalized to that form for inventory and
    // driver lookups to resolve. The ChatGPT driver uses native ids
    // directly and needs no prefix.
    if (this.provider.id === "zai" && !id.startsWith("route:") && !id.startsWith("sidebar:") && !id.includes(":")) {
      return "route:" + id;
    }
    return id;
  }

  /** Preserve the caller's id form so HTTP identity checks pass whether
   *  the caller used the scoped form ("zai::route%3A<uuid>") or a raw
   *  native id. The rest of the session object stays canonical. */
  private withCallerId(session: AgentSession, id: string): AgentSession {
    return session.id === id ? session : { ...session, id };
  }

  private updateInventory(chats: readonly BrowserChat[]): void {
    this.inventory.clear();
    for (const chat of chats) this.inventory.set(chat.id, chat);
    this.inventoryAt = Date.now();
    this.historyCache.setAccountScope(this.driver.getAccountScope?.());
    this.historyCache.prewarm(chats.map(chat => ({ id: chat.id, revision: chat.updatedAtSemantics === "remote-update-time" ? chat.updatedAt : undefined })));
  }

  async init(): Promise<void> {
    // The startup scan is a request to the site like any other: a paused
    // harness starts with an empty inventory and serves nothing until the
    // owner resumes it — unless its driver answers passively (the ChatGPT
    // intercept hook and its durable inventory need no request at all).
    if (!liveHarnessPollingEnabled(this.pollingHarness) && this.driver.passiveInventory !== true) return;
    this.updateInventory(await this.driver.listChats());
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<AgentSession[]> {
    void options;
    const polling = liveHarnessPollingEnabled(this.pollingHarness);
    // A passive driver (the ChatGPT intercept hook) keeps the inventory
    // fresh without one request of the herder's own, so its stale-while-
    // revalidate continues through the pause; every other paused harness
    // serves what it already holds and makes no list call at all.
    const revalidating = polling || this.driver.passiveInventory === true;
    if (this.inventory.size) {
      // Cached titles and session identity are also stale-while-revalidate.
      // Never block selected-chat details on an unrelated 100-chat API list.
      if (revalidating && Date.now() - this.inventoryAt > 60_000 && !this.inventoryRefresh) {
        this.inventoryRefresh = this.driver.listChats().then(chats => {
          this.updateInventory(chats);
        }).catch(() => undefined).finally(() => { this.inventoryRefresh = undefined; });
      }
      return [...this.inventory.values()].map(chat => this.toSession(chat));
    }
    if (!revalidating) return [];
    const chats = await this.driver.listChats();
    this.updateInventory(chats);
    return chats.map(chat => this.toSession(chat));
  }

  async findNamedSessions(name: string, cwd: string): Promise<AgentSession[]> {
    void cwd;
    const normalized = name.trim();
    // A paused harness answers from the cached inventory: a name lookup is
    // not worth one more request to a site the owner paused.
    const chats = liveHarnessPollingEnabled(this.pollingHarness)
      ? await this.driver.listChats()
      : [...this.inventory.values()];
    return chats
      .filter((chat) => chat.title.trim() === normalized)
      .map((chat) => this.toSession(chat));
  }

<<<<<<< HEAD
  /** List projects via the driver when supported (ZAI). */
  async listProjects(): Promise<Array<{ id: string; name: string; chatCount?: number; archived?: boolean }>> {
    if (typeof this.driver.listProjects !== "function") return [];
    return this.driver.listProjects();
  }
  /** Move a chat into a project via the driver when supported (ZAI). */
  async moveToProject(input: { chatId: string; projectId: string }): Promise<{ ok: boolean; error?: string }> {
    if (typeof this.driver.moveToProject !== "function") return { ok: false, error: "этот агент не поддерживает перемещение в проект" };
    return this.driver.moveToProject(input);
  }

  /** Delegate to the driver's fullScan when the browser site supports it
   * (ChatGPT). Returns {count:0,pages:0} when unsupported so callers can treat
   * the absence uniformly. */
=======
  /** Delegate to the driver's fullScan when the browser site supports it
   * (ChatGPT). Returns {count:0,pages:0} when unsupported so callers can
   * treat the absence uniformly. */
>>>>>>> feat/intercept-pause-20261103T053000Z
  async fullScan(): Promise<{ count: number; pages: number }> {
    if (typeof this.driver.fullScan !== "function") return { count: 0, pages: 0 };
    return this.driver.fullScan();
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
    if (observed) return this.withCallerId(this.toSession(observed), id);
    // An exact deep link outside the current 100 chats must not switch the
    // user's browser tab just to resolve the frontend's session header.
    const known = this.driver.getKnownChat?.(native);
    if (known) return this.withCallerId(this.toSession(known), id);
    const chat = this.driver.getChat
      ? await this.driver.getChat(native)
      : (await this.driver.listChats()).find((entry) => entry.id === native);
    return chat ? this.withCallerId(this.toSession(chat), id) : null;
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
      this.historyCache.invalidate(this.nativeId(id));
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

  async invalidateHistory(id: string): Promise<void> {
    // A completed remote turn changed this conversation: drop the cached
    // copy AND wait for the fresh read, so the turn fingerprint computed
    // immediately afterwards cannot repeat the already-judged identity.
    await this.historyCache.refreshNow(this.nativeId(id)).catch(() => undefined);
  }

  subscribeEvents(handler: (event: HarnessEvent) => void): () => void {
    this.eventListeners.add(handler);
    return () => { this.eventListeners.delete(handler); };
  }

  private emitEvent(event: HarnessEvent): void {
    for (const handler of this.eventListeners) {
      try { handler(event); } catch { /* a listener must never break the adapter */ }
    }
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
        ...(chat.workingSource ? { runningEvidence: chat.workingSource } : {}),
      },
    };
  }
}
