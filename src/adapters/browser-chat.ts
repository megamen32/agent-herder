import type { AgentSession, ControlResult, CreateSessionOptions, HarnessAdapter, HarnessCapabilities, HarnessEvent, HarnessType, RawTranscriptExport, ListSessionsOptions, SendMessageOptions, SendMessageResult, SetPermissionsOptions } from "../types/index.js";
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
  /** Local empty chat awaiting the user's first message on the site. */
  pendingRemoteCreation?: boolean;
  /** Origin of the working signal when it is not the observed page's own DOM. */
  workingSource?: "native-last-run" | "native-async-status" | "recently-generating";
}

/** A browser transport owns its authenticated page and implements these operations. */
export interface BrowserChatDriver {
  listChats(signal?: AbortSignal): Promise<readonly BrowserChat[]>;
  /** Inventory observed without causing provider requests or prewarming history. */
  listObservedChats?(): Promise<readonly BrowserChat[]>;
  getChat?(chatId: string, signal?: AbortSignal): Promise<BrowserChat | null>;
  /** Pure exact-link metadata without browser navigation. Allows opening an
   * older chat outside the current 100-item inventory from an existing URL.
   * This is NOT proof that a send would be accepted by the remote site.
   */
  getKnownChat?(chatId: string): BrowserChat | null;
  /** Authenticated read-only owner API; no navigation or model turn. */
  getMessages?(chatId: string): Promise<SessionMessageView[] | null>;
  /** The native id of the user's own message in the rendered conversation.
   * Ordinary confirmation of the effect when the provider's read API is
   * rate-limited; it never sends and never navigates. */
  getMessageIdFromDom?(chatId: string, text: string): Promise<string | null>;
  /** The native ids of the rendered messages of one conversation. Used as an
   * honest partial baseline when the provider's read API is rate-limited. */
  getMessageIdsFromDom?(chatId: string): Promise<string[]>;
  /** Passive background observation; never triggers a provider request. */
  getObservedMessages?(chatId: string): Promise<SessionMessageView[] | null>;
  /** Optional throttled visit for a completed ChatGPT turn without visible history. */
  visitBackgroundChat?(chatId: string): Promise<unknown>;
  getRawConversation?(chatId: string): Promise<unknown | null>;
  /** One bounded re-read of the turn state of one chat from the
   * provider's own API, merging the fresh result into the durable
   * inventory. Used by the browser turn observer when a running turn's
   * inventory froze. Foreground-only consumers may explicitly inspect their
   * exact owned session while background polling is paused. */
  refreshTurnState?(chatId: string, options?: { foreground: boolean }): Promise<boolean>;
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
  /** True when listChats() keeps answering without one site request while
   * the polling of the harness is paused (the intercept stash of the page
   * plus the durable inventory). A paused harness without this flag serves
   * only what it already holds in memory. */
  readonly passiveInventory?: boolean;
  /** Stop only the actively generating turn of this exact conversation.
   * Never navigates to another chat to find a Stop button.
   */
  stopTurn?(chatId: string, signal?: AbortSignal): Promise<{ stopped: boolean; error?: string }>;
  /** Subscribe to modal-prompt events emitted when the driver answers (or
   * skips) a permission / 'Continue in Work?' prompt on the owned browser
   * page. The adapter forwards these as HarnessEvent of kind
   * permission.requested / permission.resolved into the shared bus. */
  subscribePromptEvents?(handler: (event: HarnessEvent) => void): () => void;
  archiveChat?(chatId: string): Promise<{ ok: boolean; error?: string }>;
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
/** Existing browser ID normalization shared by the adapter and exact canary reads. */
export function browserChatNativeId(id: string, providerId: string, scopedIds = true): string {
  if (!scopedIds) return id;
  const prefix = `${providerId}::`;
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
  if (providerId === "zai" && !id.startsWith("route:") && !id.startsWith("sidebar:") && !id.includes(":")) {
    return "route:" + id;
  }
  return id;
}

export class BrowserChatAdapter implements HarnessAdapter {
  /** Bounded READ-ONLY re-reads that settle a native receipt after a click.
   * The provider stores the accepted message a moment after the click, so a
   * single immediate read can miss it. The send is never repeated. */
  private static readonly RECEIPT_READ_ATTEMPTS = 4;
  private static readonly RECEIPT_READ_GAP_MS = 1_500;
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
    private readonly foregroundOnly = false,
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
    return browserChatNativeId(id, this.provider.id, this.scopedIds);
  }

  /** Preserve the caller's id form so HTTP identity checks pass whether
   *  the caller used the scoped form ("zai::route%3A<uuid>") or a raw
   *  native id. The rest of the session object stays canonical. */
  private withCallerId(session: AgentSession, id: string): AgentSession {
    return session.id === id ? session : { ...session, id };
  }

  private updateInventory(chats: readonly BrowserChat[], prewarm = true): void {
    this.inventory.clear();
    for (const chat of chats) this.inventory.set(chat.id, chat);
    this.inventoryAt = Date.now();
    this.historyCache.setAccountScope(this.driver.getAccountScope?.());
    if (prewarm && !this.foregroundOnly) this.historyCache.prewarm(chats.map(chat => ({ id: chat.id, revision: chat.updatedAtSemantics === "remote-update-time" ? chat.updatedAt : undefined })));
  }

  async listBackgroundSessions(): Promise<AgentSession[]> {
    if (this.provider.id !== "chatgpt" || !this.driver.listObservedChats) return [];
    const chats = await this.driver.listObservedChats();
    this.updateInventory(chats, false);
    return chats.map(chat => this.toSession(chat));
  }

  async init(): Promise<void> {
    if (this.provider.id === "chatgpt") {
      await this.listBackgroundSessions();
      return;
    }
    // The startup scan is a request to the site like any other: a paused
    // harness starts with an empty inventory and serves nothing until the
    // owner resumes it — unless its driver answers passively (the ChatGPT
    // intercept hook and its durable inventory need no request at all).
    if (!liveHarnessPollingEnabled(this.pollingHarness) && this.driver.passiveInventory !== true) return;
    this.updateInventory(await this.driver.listChats());
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<AgentSession[]> {
    void options;
    if (this.provider.id === "chatgpt") return this.listBackgroundSessions();
    const polling = liveHarnessPollingEnabled(this.pollingHarness);
    // A passive driver (the ChatGPT intercept hook) keeps the inventory
    // fresh without one request of the herder's own, so its stale-while-
    // revalidate continues through the pause; every other paused harness
    // serves what it already holds and makes no list call at all.
    const revalidating = polling || this.driver.passiveInventory === true;
    if (this.inventory.size) {
      // Cached titles and session identity are also stale-while-revalidate.
      // Never block selected-chat details on an unrelated 100-chat API list.
      if (!this.foregroundOnly && revalidating && Date.now() - this.inventoryAt > 60_000 && !this.inventoryRefresh) {
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
    if (this.provider.id === "chatgpt") {
      return (await this.listBackgroundSessions()).filter(session => session.title.trim() === normalized);
    }
    // A paused harness answers from the cached inventory: a name lookup is
    // not worth one more request to a site the owner paused.
    const chats = liveHarnessPollingEnabled(this.pollingHarness)
      ? await this.driver.listChats()
      : [...this.inventory.values()];
    return chats
      .filter((chat) => chat.title.trim() === normalized)
      .map((chat) => this.toSession(chat));
  }

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
    // A newly created draft must immediately appear in the UI before the
    // next full browser inventory refresh.
    this.inventory.set(chat.id,chat);
    const session=this.toSession(chat);
    return {
      ...session,
      meta: {
        ...session.meta,
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
    // A chat whose model answered must not stay "running" forever: the core
    // refuses a follow-up delivery to a busy chat, so every later message to
    // the same session would be rejected as if the turn were still active.
    // One bounded read of the provider's own state settles the real status.
    const observedBusy = this.inventory.get(native)?.working
      ?? this.driver.getKnownChat?.(native)?.working;
    if (observedBusy) {
      try {
        if (await this.driver.refreshTurnState?.(native, { foreground: this.foregroundOnly })) {
          // The refreshed state replaces the stale one in the inventory too.
          const settled = this.driver.getKnownChat?.(native);
          if (settled) this.inventory.set(native, settled);
        }
      } catch { /* the cached state stands */ }
    }
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
    // Message reconciliation uses the ordinary history path regardless of
    // the requested limit. Full native export belongs to getRawTranscript:
    // it can require additional reads and a chunked transfer.
    if (!this.driver.getMessages) return null;
    if (!this.foregroundOnly && this.historyCache.available) return this.historyCache.messages(native, limit);
    const live = await this.driver.getMessages(native);
    return live?.slice(-Math.max(1, limit)) ?? null;
  }

  async getBackgroundMessages(id: string): Promise<SessionMessageView[] | null> {
    if (this.provider.id !== "chatgpt" || !this.driver.getObservedMessages) return null;
    return this.driver.getObservedMessages(this.nativeId(id));
  }

  async requestBackgroundVisit(id: string): Promise<void> {
    if (this.provider.id === "chatgpt") await this.driver.visitBackgroundChat?.(this.nativeId(id));
  }

  supportsArchive(): boolean { return typeof this.driver.archiveChat === "function"; }

  async archiveSession(id: string): Promise<ControlResult> {
    if (!this.driver.archiveChat) return { ok: false, error: "archive_unsupported" };
    const native = this.nativeId(id);
    const result = await this.driver.archiveChat(native);
    if (!result.ok) return { ok: false, error: result.error ?? "archive_outcome_unknown" };
    this.inventory.delete(native);
    this.historyCache.invalidate(native);
    return { ok: true, sessionId: id };
  }

  async getRawTranscript(id: string, signal?: AbortSignal): Promise<RawTranscriptExport | null> {
    if (!this.driver.getRawConversation) return null;
    signal?.throwIfAborted();
    const native = this.nativeId(id);
    const data = await this.driver.getRawConversation(native);
    signal?.throwIfAborted();
    if (!data) return null;
    const resolved = (data as { conversation_id?: unknown }).conversation_id;
    if (native.startsWith("draft:") && (typeof resolved !== "string" || !/^[a-f0-9-]{28,80}$/i.test(resolved))) return null;
    const locationId = this.provider.id === "zai" ? resolved : native.startsWith("draft:") ? resolved as string : native;
    if (typeof locationId !== "string" || !/^[a-f0-9-]{12,80}$/i.test(locationId)) return null;
    return {
      bytes: Buffer.from(JSON.stringify(data), "utf8"), complete: true,
      source: { kind: "native-api", location: `https://${this.provider.id === "zai" ? "chat.z.ai" : "chatgpt.com"}/c/${locationId}`, format: "json" },
      timestampCoverage: "native", limitations: ["Attachment bytes are not included; the native conversation contains their references."],
    };
  }

  /** One bounded driver-side re-read of the turn state of one chat. The
   * browser turn observer calls this when a running turn's inventory
   * froze; the refreshed inventory lets the next tick observe the real
   * idle state and submit the finished turn to the Stop consumer. */
  async refreshSession(id: string): Promise<boolean> {
    const native = this.nativeId(id);
    if (!this.driver.refreshTurnState) return false;
    try {
      return await this.driver.refreshTurnState(native);
    } catch {
      return false;
    }
  }

  async sendMessage(id: string, options: SendMessageOptions): Promise<SendMessageResult> {
    try {
      const nativeId = this.nativeId(id);
      // Correlated AHAP sends need a provider message ID, not merely a click.
      // Snapshot first so an older identical prompt cannot become the receipt.
      let beforeIds: Set<string> | undefined;
      if (options.inputId) {
        let before: SessionMessageView[] | null | undefined;
        try { before = await this.driver.getMessages?.(nativeId); }
        catch { before = undefined; }
        if (!Array.isArray(before)) {
          // The provider's read API can be rate-limited BEFORE the send as
          // well. The rendered conversation still carries the ids that
          // existed before the click, so the baseline stays honest and
          // partial instead of missing.
          const rendered = await this.driver.getMessageIdsFromDom?.(nativeId).catch(() => undefined);
          before = Array.isArray(rendered)
            ? rendered.map(id => ({ id, role: "user" as const, text: "", parts: [] }))
            : undefined;
        }
        if (!Array.isArray(before)) {
          return { ok: false, notSubmitted: true, nonRetryable: true,
            error: "Native message baseline unavailable; no message submitted" };
        }
        beforeIds = new Set(before.map(message => message.id));
      }
      await this.driver.sendMessage({
        chatId: nativeId,
        text: options.message,
        waitForCompletion: options.queue !== true,
      });
      // After the first message, the draft's real route has been verified.
      // Refresh its display metadata without waiting for an unrelated
      // 100-chat listing or changing the stable Herder session ID.
      if (nativeId.startsWith("draft:")) {
        const updated = this.driver.getKnownChat?.(nativeId);
        if (updated) this.inventory.set(nativeId,updated);
      }
      this.historyCache.invalidate(nativeId);
      if (beforeIds) {
        // The provider stores the accepted message a moment after the click.
        // One immediate read can therefore find nothing and would leave the
        // delivery permanently unknown even though the message exists. A
        // bounded number of READ-ONLY re-reads settles the receipt; the send
        // itself is never repeated.
        for (let attempt = 0; attempt < BrowserChatAdapter.RECEIPT_READ_ATTEMPTS; attempt++) {
          try {
            const after = await this.driver.getMessages?.(nativeId);
            const matches = after?.filter(message => message.role === "user"
              && !!message.id && !beforeIds.has(message.id)
              && message.text === options.message);
            if (matches?.length === 1) {
              return { ok: true, admitted: true, admission: "accepted",
                inputId: options.inputId, nativeInputMessageId: matches[0]!.id };
            }
            if (matches && matches.length > 1) break;
          } catch { /* A read failure after the click is not a pre-send refusal. */ }
          // The provider's read API can be rate-limited while the very same
          // conversation is rendered in the tab. The native id of the user's
          // own message in the DOM is ordinary confirmation of the effect and
          // needs no new send and no repeated API call.
          const fromDom = await this.driver.getMessageIdFromDom?.(nativeId, options.message)
            .catch(() => null);
          // A message that was already rendered before this send is not this
          // send's receipt, and an older identical prompt must never become
          // one. The baseline holds every id that existed before the click.
          if (fromDom && !beforeIds.has(fromDom)) {
            return { ok: true, admitted: true, admission: "accepted",
              inputId: options.inputId, nativeInputMessageId: fromDom };
          }
          if (attempt + 1 < BrowserChatAdapter.RECEIPT_READ_ATTEMPTS) {
            await new Promise(resolve => setTimeout(resolve, BrowserChatAdapter.RECEIPT_READ_GAP_MS));
          }
        }
        return { ok: false, admission: "unknown", admissionUnknown: true,
          nonRetryable: true, inputId: options.inputId,
          error: "Message submitted but unique native message receipt unavailable; read history before any retry" };
      }
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
        pendingRemoteCreation: chat.pendingRemoteCreation === true,
        timestampSemantics: chat.updatedAtSemantics ?? "native-or-visible-order",
        ...(chat.workingSource ? { runningEvidence: chat.workingSource } : {}),
      },
    };
  }
}
