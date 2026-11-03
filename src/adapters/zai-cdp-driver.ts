import type { BrowserChat, BrowserChatDriver } from "./browser-chat.js";
import { BrowserChatDraftStore } from "./browser-chat-drafts.js";
import { submitFirstChatMessage } from "./browser-chat-new-page.js";
import type { SessionMessageView } from "../types/index.js";
import { ZAI_LIST_API_SCRIPT, ZAI_LIST_API_PASSIVE_SCRIPT, zaiMessagesApiScript, ZAI_LIST_PROJECTS_SCRIPT, zaiMoveToProjectScript } from "./browser-chat-api-scripts.js";
import { BrowserChatInventoryCache } from "./browser-chat-inventory-cache.js";
import { liveHarnessPollingEnabled } from "../harness-runtime-settings.js";
import { MacMiniChromeTransport, parseChromeEvaluation, type ChromePageTools } from "./mac-mini-chrome-transport.js";

type ZaiPhase = "generating" | "idle" | "unknown";
type ZaiSnapshot = {
  origin: string;
  path: string;
  loggedIn: boolean;
  selectedTitle?: string;
  titles: string[];
  composer: boolean;
  phase: ZaiPhase;
  draftPresent: boolean;
};
export type BrowserPage = { id: number; url: string; selected?: boolean };

const ZAI_ORIGIN = "https://chat.z.ai";
const MAX_MESSAGE_CHARS = 16_000;
const ROUTE_PATTERN = /^\/c\/[a-f0-9-]{12,80}$/i;
const POST_SEND_GUARD_MS = 1_800;

/** Extract only tab IDs and exact ZAI origins from the shared Chrome owner's page list. */
export function parseZaiPages(text: string): BrowserPage[] {
  return text.split("\n").flatMap(line => {
    const match = line.match(/^\s*(\d+):.*?\((https:\/\/chat\.z\.ai(?:\/[^)]*)?)\)(\s*\[selected\])?/);
    if (!match) return [];
    try {
      const url = new URL(match[2]!);
      return url.origin === ZAI_ORIGIN
        ? [{ id: Number(match[1]), url: url.toString(), ...(match[3] ? { selected: true } : {}) }] : [];
    } catch { return []; }
  });
}

/** Deterministic pick among open ZAI tabs: the selected tab first, then the lowest page ID. */
export function pickZaiPage(pages: BrowserPage[]): BrowserPage {
  return pages.find(page => page.selected) ?? [...pages].sort((a, b) => a.id - b.id)[0]!;
}

function parseTitleId(id: string): string {
  if (!id.startsWith("sidebar:")) throw new Error("Invalid ZAI conversation ID");
  let title: string;
  try { title = decodeURIComponent(id.slice(8)); }
  catch { throw new Error("Invalid encoded ZAI chat title"); }
  if (!title || title.length > 200) throw new Error("Invalid ZAI chat title");
  return title;
}

/**
 * Real ZAI buttons:
 *  - generating: button > span.block.size-3.rounded-xs.bg-text-inverted (square Stop)
 *  - idle: #send-message-button (may be disabled with an empty composer!)
 * Never interpret a missing Stop as idle unless Send actually exists.
 */
export const ZAI_ACTIVITY_SCRIPT = `() => {
  const buttons = [...document.querySelectorAll('button[data-selected]')];
  const titles = buttons.map(button => button.querySelector('div[dir="auto"]')?.textContent?.trim()
    || button.textContent?.trim() || '').filter(Boolean);
  const selected = buttons.find(button => button.getAttribute('data-selected') === 'true');
  const visible = element => !!element && element.getClientRects().length > 0;
  const stop = [...document.querySelectorAll('button')].some(button =>
    visible(button) && !!button.querySelector(':scope > span.block.size-3.rounded-xs.bg-text-inverted')
  );
  const send = document.querySelector('#send-message-button');
  const composer = document.querySelector('textarea[placeholder="Send a Message"]');
  return {
    origin: location.origin, path: location.pathname,
    loggedIn: !!document.querySelector('#chat-group-tab-zai-web'),
    titles: titles.slice(0, 300),
    selectedTitle: selected?.querySelector('div[dir="auto"]')?.textContent?.trim()
      || selected?.textContent?.trim() || undefined,
    composer: !!composer,
    phase: stop ? 'generating' : (visible(send) && !!composer ? 'idle' : 'unknown'),
    draftPresent: !!composer?.value,
  };
}`;

/**
 * One owned ZAI tab over the existing Mac mini Chrome CDP gateway.
 * Exact reads can select the requested chat only when the current tab is idle.
 * An unknown UI state is always busy, never permission to submit a message.
 */
export class ZaiCdpDriver implements BrowserChatDriver {
  readonly browserFeatures = {
    nativeConversationIds: false, // Sidebar title IDs until ZAI native API is adopted.
    queueAfterGeneration: true,
    chatCreation: true,
    accountArchiveViaCdp: false,
    projects: true,
  } as const;
  /** The paused harness still lists: the intercept stash of the page plus
   * the durable inventory answer without one request of the herder's own. */
  readonly passiveInventory = true;
  private readonly cache = new Map<string, BrowserChat>();
  private readonly drafts = new BrowserChatDraftStore("zai");
  /** Durable full inventory of the verified account, shared with the
   * intercept stash so a restart keeps every chat visible while paused. */
  private readonly inventoryCache = new BrowserChatInventoryCache("zai");
  private inventoryLoaded = false;
  private operation: Promise<void> = Promise.resolve();
  private lastSubmittedAt = 0;
  private accountScope: string | undefined;
  getAccountScope(): string | undefined { return this.accountScope; }


  constructor(private readonly tools: ChromePageTools, private readonly pinnedPageId?: number, private readonly openWaitMs = 5_000) {}

  private exclusive<T>(callback: () => Promise<T>): Promise<T> {
    const result = this.operation.then(callback);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Auto-detect the ZAI tab; open one when none exists. A stale explicit
   * pin never disables the provider and falls back to auto-detection. */
  private async page(): Promise<BrowserPage> {
    const pages = parseZaiPages(await this.tools.call("list_pages"));
    const pinned = this.pinnedPageId !== undefined
      ? pages.find(page => page.id === this.pinnedPageId) : undefined;
    if (pinned) return pinned;
    if (pages.length) return pickZaiPage(pages);
    return this.openZaiTab();
  }

  /** The tab list is the source of truth: new_page reports its own navigation
   * timeout even when the tab actually opened, so that error is tolerated. */
  private async openZaiTab(): Promise<BrowserPage> {
    try {
      await this.tools.call("new_page", { url: ZAI_ORIGIN + "/" });
    } catch { /* presence is verified by the re-list below */ }
    await new Promise(resolve => setTimeout(resolve, this.openWaitMs));
    const pages = parseZaiPages(await this.tools.call("list_pages"));
    if (!pages.length) throw new Error("No ZAI tab open in Mac mini Chrome and auto-open failed");
    return pickZaiPage(pages);
  }

  private async snapshot(pageId: number): Promise<ZaiSnapshot> {
    const data = parseChromeEvaluation<ZaiSnapshot>(
      await this.tools.call("evaluate_script", { pageId, function: ZAI_ACTIVITY_SCRIPT }),
    );
    if (data.origin !== ZAI_ORIGIN || !data.loggedIn || !data.composer) {
      throw new Error("ZAI Chrome tab is not a logged-in chat page; sign in in Mac mini Chrome");
    }
    // A renderer/transport that omits phase must never be interpreted as idle.
    if (!["idle", "generating", "unknown"].includes(data.phase)) {
      throw new Error("ZAI Chrome activity state unavailable; message not sent");
    }
    return data;
  }

  private busy(state: ZaiSnapshot): boolean {
    // A user draft is preserved and restored around the herder's send (see
    // readComposerDraft/restoreComposerDraft), so it no longer counts as
    // busy. Only an active generation or the post-send guard blocks the next send.
    return state.phase !== "idle" ||
      Date.now() - this.lastSubmittedAt < POST_SEND_GUARD_MS;
  }

  private isSelected(id: string, known: BrowserChat, state: ZaiSnapshot): boolean {
    if (id.startsWith("route:")) return state.path === "/c/" + id.slice(6);
    return id.startsWith("sidebar:") && ROUTE_PATTERN.test(state.path) &&
      state.selectedTitle === known.title;
  }

  private recordChat(id: string, title: string, observedAt: string, selectedRoute?: string): BrowserChat {
    return {
      id, title, unread: false, working: false, updatedAt: observedAt,
      ...(selectedRoute ? { sourceRoute: ZAI_ORIGIN + selectedRoute } : {}),
      updatedAtSemantics: "observed-sidebar-order",
    };
  }

  /** A route id is an exact native conversation identity: it stays a valid
   * target even when the chat is not currently rendered in the bounded
   * sidebar. Selecting it navigates the owned tab to the exact route; a
   * wrong route simply fails identity confirmation and nothing is sent. */
  /** Exact route metadata for a read-only deep link; never clicks the browser.
   * The private HTTP history endpoint will separately verify its existence.
   */
  getKnownChat(id: string): BrowserChat | null {
    if (id.startsWith("draft:")) {
      const draft = this.drafts.get(id);
      return draft ? this.drafts.asChat(draft) : null;
    }
    return this.routeRecord(id);
  }

  private routeRecord(id: string): BrowserChat | null {
    if (!id.startsWith("route:")) return null;
    const route = "/c/" + id.slice(6);
    if (!ROUTE_PATTERN.test(route)) return null;
    const cached = this.cache.get(id);
    if (cached) return cached;
    const record = this.recordChat(id, "ZAI conversation", new Date().toISOString(), route);
    this.cache.set(id, record);
    return record;
  }

  private async listUnlocked(): Promise<BrowserChat[]> {
    const page = await this.page();
    const state = await this.snapshot(page.id);
    const observedAt = new Date().toISOString();
    // The runtime switch of the owner: while the site requests of this
    // harness are paused, the list answers from passive sources only — the
    // responses the site itself made (the intercept hook) plus the durable
    // inventory — and never from a fetch the herder initiates.
    if (!liveHarnessPollingEnabled("zai")) return this.listPassive(state, page.id);
    // Native Z.ai HTTP listing: two pages, 100 stable IDs, no sidebar clicks.
    try {
      const data = parseChromeEvaluation<{
        scope?: string; error?: string;
        chats?: Array<{ id: string; title: string; updatedAt?: number; unread?: boolean;
          lastRunStatus?: string }>;
      }>(await this.tools.call("evaluate_script", { pageId: page.id, function: ZAI_LIST_API_SCRIPT }));
      if (data.scope && /^[a-f0-9]{64}$/.test(data.scope) && Array.isArray(data.chats)) {
        this.accountScope = data.scope;
        // Keep the durable inventory warm: the paused harness of the next
        // list call (or a restarted herder) serves it without any request.
        this.inventoryCache.setAccountScope(data.scope);
        if (!this.inventoryLoaded) { await this.inventoryCache.load(); this.inventoryLoaded = true; }
        this.inventoryCache.merge(data.chats.map(entry => ({
          id: entry.id,
          title: entry.title && entry.title.trim() ? entry.title : "ZAI conversation",
          updatedAt: entry.updatedAt, lastRunStatus: entry.lastRunStatus, seenAt: Date.now(),
        })));
        // Awaited on purpose: a later list call (or a restarted herder) in
        // the paused state must find the durable inventory already on disk.
        await this.inventoryCache.save();
        const chats: BrowserChat[] = [];
        for (const item of data.chats) {
          if (!/^[a-f0-9-]{12,80}$/i.test(item.id)) continue;
          // A chat without a title is still a real conversation of the account:
          // keep it with the stable untitled label (the same one routeRecord
          // uses) instead of dropping it from the inventory. Selection is by
          // exact route identity, so the shared label stays safe.
          const title = typeof item.title === "string" && item.title.trim() ? item.title : "ZAI conversation";
          const selected = state.path === "/c/" + item.id;
          const updatedAt = typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) && item.updatedAt > 0
            ? new Date(item.updatedAt < 1e12 ? item.updatedAt * 1000 : item.updatedAt).toISOString()
            : observedAt;
          const chat = this.recordChat("route:" + item.id, title, updatedAt,
            selected ? state.path : undefined);
          if (typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) && item.updatedAt > 0) {
            chat.updatedAtSemantics = "remote-update-time";
          }
          // The DOM Stop control exists only on the observed page's own
          // conversation, but the native listing reports last_run for every
          // chat of the account: that is the only honest busy signal for a
          // conversation generating in another tab or in no herder tab at all.
          const nativeRunning = item.lastRunStatus === "running";
          chat.working = selected ? this.busy(state) : nativeRunning;
          if (nativeRunning && !selected) chat.workingSource = "native-last-run";
          chat.stopVisible = selected && state.phase === "generating";
          chat.unread = item.unread === true;
          chats.push(chat);
          this.cache.set(chat.id, chat);
        }
        const current = state.path.match(/^\/c\/([a-f0-9-]{12,80})$/i)?.[1];
        if (current && !chats.some(chat => chat.id === "route:" + current)) {
          const chat = this.recordChat("route:" + current,
            state.selectedTitle || "Z.ai conversation", observedAt, state.path);
          chat.working = this.busy(state);
          chat.stopVisible = state.phase === "generating";
          chats.unshift(chat);
          this.cache.set(chat.id, chat);
        }
        return chats.slice(0,101);
      }
    } catch { /* Fallback to the verified sidebar, without writing to the page. */ }
    this.accountScope = undefined;
    return this.listFromSidebarDom(state, observedAt);
  }

  /** The last resort of every list path: the chats the observed sidebar
   * actually shows. A pure DOM read — no request of any kind. */
  private listFromSidebarDom(state: ZaiSnapshot, observedAt = new Date().toISOString()): BrowserChat[] {
    const counts = new Map<string, number>();
    for (const title of state.titles) counts.set(title, (counts.get(title) || 0) + 1);
    const result: BrowserChat[] = [];
    for (const title of state.titles) {
      // Duplicate titles cannot be safely selected by name.
      if (counts.get(title) !== 1 || title === "New Chat") continue;
      const selected = title === state.selectedTitle && ROUTE_PATTERN.test(state.path);
      // The sidebar title ID stays stable when a chat becomes selected.
      const id = "sidebar:" + encodeURIComponent(title);
      const chat = this.recordChat(id, title, observedAt, selected ? state.path : undefined);
      chat.working = selected && this.busy(state);
      chat.stopVisible = selected && state.phase === "generating";
      result.push(chat);
    }
    // The current chat may be open but missing from the bounded sidebar.
    if (ROUTE_PATTERN.test(state.path) && (!state.selectedTitle || counts.get(state.selectedTitle) !== 1)) {
      result.unshift({
        ...this.recordChat("route:" + state.path.slice(3),
          state.selectedTitle || "ZAI conversation", observedAt, state.path),
        working: this.busy(state),
        stopVisible: state.phase === "generating",
      });
    }
    for (const chat of result) this.cache.set(chat.id, chat);
    return result;
  }

  /** The list of the paused harness. Every source here is read without one
   * request of the herder's own: the intercept stash the page holds, the
   * durable inventory of the account, and the visible sidebar DOM. */
  private async listPassive(state: ZaiSnapshot, pageId: number): Promise<BrowserChat[]> {
    try {
      const data = parseChromeEvaluation<{
        scope?: string; error?: string;
        chats?: Array<{ id: string; title: string; updatedAt?: number; unread?: boolean; lastRunStatus?: string }>;
      }>(await this.tools.call("evaluate_script", { pageId, function: ZAI_LIST_API_PASSIVE_SCRIPT }));
      const scope = (data.scope && /^[a-f0-9]{64}$/.test(data.scope) ? data.scope : undefined) ?? this.accountScope;
      if (scope) {
        this.accountScope = scope;
        this.inventoryCache.setAccountScope(scope);
        if (!this.inventoryLoaded) { await this.inventoryCache.load(); this.inventoryLoaded = true; }
        if (Array.isArray(data.chats) && data.chats.length) {
          this.inventoryCache.merge(data.chats.map(entry => ({
            id: entry.id,
            title: entry.title && entry.title.trim() ? entry.title : "ZAI conversation",
            updatedAt: entry.updatedAt, lastRunStatus: entry.lastRunStatus, seenAt: Date.now(),
          })));
          void this.inventoryCache.save();
        }
        if (this.inventoryCache.size) {
          const chats: BrowserChat[] = [];
          const current = state.path.match(/^\/c\/([a-f0-9-]{12,80})$/i)?.[1];
          for (const entry of this.inventoryCache.list()) {
            if (!/^[a-f0-9-]{12,80}$/i.test(entry.id)) continue;
            const selected = current === entry.id;
            const nativeRunning = entry.lastRunStatus === "running";
            const updatedAt = typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt) && entry.updatedAt > 0
              ? new Date(entry.updatedAt < 1e12 ? entry.updatedAt * 1000 : entry.updatedAt).toISOString()
              : new Date().toISOString();
            const chat = this.recordChat("route:" + entry.id, entry.title || "ZAI conversation",
              updatedAt, selected ? state.path : undefined);
            if (typeof entry.updatedAt === "number" && entry.updatedAt > 0) chat.updatedAtSemantics = "remote-update-time";
            chat.working = selected ? this.busy(state) : nativeRunning;
            if (nativeRunning && !selected) chat.workingSource = "native-last-run";
            chat.stopVisible = selected && state.phase === "generating";
            chats.push(chat);
            this.cache.set(chat.id, chat);
          }
          if (current && !chats.some(chat => chat.id === "route:" + current)) {
            const chat = this.recordChat("route:" + current, state.selectedTitle || "ZAI conversation",
              new Date().toISOString(), state.path);
            chat.working = this.busy(state);
            chat.stopVisible = state.phase === "generating";
            chats.unshift(chat);
            this.cache.set(chat.id, chat);
          }
          return chats.slice(0, 101);
        }
      }
    } catch { /* passive listing must never throw */ }
    return this.listFromSidebarDom(state);
  }

  /** Z.ai allocates the native route after the first message, not on /new.
   * Create only a durable local draft until the user explicitly sends text.
   */
  async createChat(input: { title?: string }): Promise<BrowserChat> {
    return this.exclusive(async () => {
      if (!this.accountScope) await this.listUnlocked();
      await this.drafts.useScope(this.accountScope);
      const title = input.title && !/^zai-\d{12,}/i.test(input.title)
        ? input.title : undefined;
      return this.drafts.create(title);
    });
  }

  async listChats(): Promise<readonly BrowserChat[]> {
    return this.exclusive(async () => {
      const native = await this.listUnlocked();
      await this.drafts.useScope(this.accountScope);
      return this.drafts.merge(native);
    });
  }

  /** Switches only when the currently selected page is safely idle. */
  private async selectChat(pageId: number, id: string, known: BrowserChat): Promise<"selected" | "busy" | "missing"> {
    if (id.startsWith("sidebar:")) {
      const title = parseTitleId(id);
      if (title !== known.title) return "missing";
      const outcome = parseChromeEvaluation<{ selected: boolean; busy?: boolean }>(
        await this.tools.call("evaluate_script", { pageId, function: `() => {
          const title = ${JSON.stringify(title)};
          const stop = [...document.querySelectorAll('button')].some(button =>
            button.getClientRects().length > 0 &&
            !!button.querySelector(':scope > span.block.size-3.rounded-xs.bg-text-inverted')
          );
          const send = document.querySelector('#send-message-button');
          const editor = document.querySelector('textarea[placeholder="Send a Message"]');
          if (stop || !send || !send.getClientRects().length || !editor || editor.value)
            return { selected: false, busy: true };
          const matches = [...document.querySelectorAll('button[data-selected]')].filter(
            button => (button.querySelector('div[dir="auto"]')?.textContent?.trim()
              || button.textContent?.trim() || '') === title
          );
          if (matches.length !== 1) return { selected: false };
          matches[0].click(); return { selected: true };
        }` }),
      );
      return outcome.selected ? "selected" : outcome.busy ? "busy" : "missing";
    }
    if (id.startsWith("route:")) {
      const route = "/c/" + id.slice(6);
      if (!ROUTE_PATTERN.test(route)) return "missing";
      const before = await this.snapshot(pageId);
      if (this.busy(before)) return "busy";
      // chat.z.ai serves /c/<uuid> only through its client router: a full
      // page load of the route redirects back to home. Drive the app's own
      // history instead; a wrong uuid then simply fails confirmation below.
      const outcome = parseChromeEvaluation<{ pushed?: string; error?: string }>(
        await this.tools.call("evaluate_script", { pageId, function: `async () => {
          const route = ${JSON.stringify(route)};
          if (location.origin !== ${JSON.stringify(ZAI_ORIGIN)}) return { error: "wrong_origin" };
          history.pushState({}, "", route);
          dispatchEvent(new PopStateEvent("popstate"));
          return { pushed: location.pathname };
        }` }),
      );
      if (outcome.error || outcome.pushed !== route) return "missing";
      return "selected";
    }
    return "missing";
  }

  private async confirmTarget(pageId: number, id: string, known: BrowserChat): Promise<ZaiSnapshot> {
    for (let i = 0; i < 6; i++) {
      // The client router loads the conversation asynchronously: mid-route
      // the page may briefly have no composer at all, which is transient.
      try {
        const state = await this.snapshot(pageId);
        if (this.isSelected(id, known, state)) return state;
      } catch { /* transient during the route transition */ }
      await new Promise(resolve => setTimeout(resolve, 600));
    }
    throw new Error("ZAI conversation identity not confirmed; message not sent");
  }

  async getChat(id: string): Promise<BrowserChat | null> {
    return this.exclusive(async () => {
      const draft = this.drafts.get(id);
      if (draft) return this.drafts.asChat(draft);
      // Don't return the old cached working=false value: a queued delivery
      // polls this method until the site's square Stop disappears.
      const page = await this.page();
      let state = await this.snapshot(page.id);
      let known = this.cache.get(id);
      if (!known) {
        known = (await this.listUnlocked()).find(entry => entry.id === id);
        if (!known && id.startsWith("sidebar:")) {
          const title = parseTitleId(id);
          if (state.titles.filter(entry => entry === title).length === 1 && title !== "New Chat") {
            known = this.recordChat(id, title, new Date().toISOString());
            this.cache.set(id, known);
          }
        }
        // An exact route id is a valid target without prior observation.
        if (!known && id.startsWith("route:")) known = this.routeRecord(id) ?? undefined;
      }
      if (!known) return null;
      if (id.startsWith("sidebar:") && state.titles.filter(entry => entry === known.title).length !== 1) {
        return null; // Deleted/renamed or now ambiguous.
      }
      if (!this.isSelected(id, known, state)) {
        // Never leave a currently generating conversation to inspect another.
        if (this.busy(state)) return { ...known, working: true, stopVisible: false };
        const selected = await this.selectChat(page.id, id, known);
        if (selected === "busy") return { ...known, working: true, stopVisible: false };
        if (selected === "missing") return null;
        state = await this.confirmTarget(page.id, id, known);
      }
      // A separate binding keeps the captured `known` narrowing for the
      // sidebar-uniqueness filter callback above intact.
      const refined = id.startsWith("route:") && known.title === "ZAI conversation" && state.selectedTitle
        ? { ...known, title: state.selectedTitle }
        : known;
      if (refined !== known) this.cache.set(id, refined);
      return { ...refined, working: this.busy(state), stopVisible: state.phase === "generating" };
    });
  }

  /** Read normalized history from Z.ai's own messages/batch API, without
   * selecting or reloading the user's currently open conversation.
   */
  async getMessages(chatId: string): Promise<SessionMessageView[] | null> {
    if (chatId.startsWith("draft:")) {
      const draft = this.drafts.get(chatId);
      if (!draft) return null;
      if (!draft.remoteId) return [];
      chatId = draft.remoteId;
    }
    let nativeId = chatId.startsWith("route:") ? chatId.slice(6) : "";
    if (!nativeId && chatId.startsWith("sidebar:")) {
      const title = parseTitleId(chatId);
      const candidates = [...this.cache.values()].filter(chat =>
        chat.title === title && chat.id.startsWith("route:"));
      if (candidates.length === 1) nativeId = candidates[0]!.id.slice(6);
    }
    if (!/^[a-f0-9-]{12,80}$/i.test(nativeId)) return null;
    const page = await this.page();
    const result = parseChromeEvaluation<{
      error?: string; messages?: Array<{ id: string; role: string; text: string;
        timestamp?: string; model?: string }>;
    }>(await this.tools.call("evaluate_script",
      { pageId: page.id, function: zaiMessagesApiScript(nativeId) }));
    if (result.error || !Array.isArray(result.messages))
      throw new Error("Z.ai history unavailable: " + (result.error || "unexpected response"));
    return result.messages.filter(message => ["user", "assistant"].includes(message.role) &&
      typeof message.id === "string" && typeof message.text === "string").map(message => ({
      id: message.id, role: message.role as "user" | "assistant",
      text: message.text, parts: [{ type: "text" as const, text: message.text }],
      ...(message.timestamp ? { timestamp: message.timestamp } : {}),
      ...(message.model ? { model: message.model } : {}),
    }));
  }

  /** Read the user's own unsent draft so the herder's send can restore it
   * after submission instead of clobbering it. */
  private async readComposerDraft(pageId: number): Promise<string> {
    const result = parseChromeEvaluation<{ value: string }>(
      await this.tools.call("evaluate_script", { pageId, function: `() => {
        const editor = document.querySelector('textarea[placeholder="Send a Message"]');
        return { value: editor ? editor.value : "" };
      }` }),
    );
    return result.value ?? "";
  }

  /** Restore the captured draft (or clear the composer when there was none).
   * Skipped silently when the composer is not editable mid-generation; Z.ai
   * keeps its own per-conversation draft state in that case. */
  private async restoreComposerDraft(pageId: number, draft: string): Promise<void> {
    try {
      const snapshot = await this.tools.call("take_snapshot", { pageId });
      const uid = snapshot.match(/uid=([\w-]+) textbox "Send a Message"/)?.[1];
      if (uid) await this.tools.call("fill", { pageId, uid, value: draft });
    } catch { /* composer not editable mid-generation */ }
  }

  async sendMessage(input: { chatId: string; text: string; waitForCompletion?: boolean }): Promise<{ assistantText?: string }> {
    return this.exclusive(async () => {
      let { chatId, text } = input;
      if (!text.trim() || text.length > MAX_MESSAGE_CHARS) throw new Error("Invalid ZAI message size");
      if (chatId.startsWith("draft:")) {
        await this.listUnlocked();
        await this.drafts.useScope(this.accountScope);
        const draft = await this.drafts.startSend(chatId);
        if (draft.remoteId) {
          chatId = draft.remoteId;
        } else {
          const receipt = await submitFirstChatMessage(this.tools,"zai",text);
          if (!receipt.clicked) {
            await this.drafts.resetPreClick(chatId);
            throw new Error("ZAI first message not submitted: "+(receipt.reason||"unknown"));
          }
          if (!receipt.remoteId) {
            await this.drafts.markUncertain(chatId);
            throw new Error("ZAI submission outcome unknown: "+(receipt.reason||"no native route"));
          }
          await this.drafts.admit(chatId,receipt.remoteId);
          const created=this.recordChat(receipt.remoteId,draft.title,
            new Date().toISOString(),"/c/"+receipt.remoteId.slice(6));
          created.working=true;
          this.cache.set(receipt.remoteId,created);
          this.lastSubmittedAt=Date.now();
          return {};
        }
      }
      const known = this.cache.get(chatId) ?? (await this.listUnlocked()).find(chat => chat.id === chatId)
        ?? (chatId.startsWith("route:") ? (this.routeRecord(chatId) ?? undefined) : undefined);
      if (!known) throw new Error("ZAI chat is not in the authenticated browser inventory");
      const page = await this.page();
      let state = await this.snapshot(page.id);
      if (this.busy(state)) {
        if (state.phase === "generating" || Date.now() - this.lastSubmittedAt < POST_SEND_GUARD_MS) {
          throw new Error("prompt is already running; ZAI queue must wait");
        }
        throw new Error("ZAI composer is unavailable; message not sent");
      }
      if (!this.isSelected(chatId, known, state)) {
        const outcome = await this.selectChat(page.id, chatId, known);
        if (outcome === "busy") throw new Error("prompt is already running; ZAI queue must wait");
        if (outcome === "missing") throw new Error("ZAI conversation is missing or ambiguous; message not sent");
        state = await this.confirmTarget(page.id, chatId, known);
      }
      if (this.busy(state)) {
        if (state.phase === "generating") throw new Error("prompt is already running; ZAI queue must wait");
        throw new Error("ZAI composer not ready; message not sent");
      }
      // Last read before composing: a human may have started another turn.
      const latest = await this.snapshot(page.id);
      if (!this.isSelected(chatId, known, latest) || this.busy(latest)) {
        throw new Error("prompt is already running; ZAI queue must wait");
      }
      const snapshot = await this.tools.call("take_snapshot", { pageId: page.id });
      const uid = snapshot.match(/uid=([\w-]+) textbox "Send a Message"/)?.[1];
      if (!uid) throw new Error("ZAI message composer not found; message not sent");
      // Preserve any user draft across the herder's send and restore it after.
      const savedDraft = await this.readComposerDraft(page.id);
      try {
        await this.tools.call("fill", { pageId: page.id, uid, value: text });

      // ONE atomic browser-side preflight+click: re-check Stop, exact target,
      // actual filled textarea and enabled Send immediately before the click.
      // Neither a second MCP command nor an Enter key can accidentally select
      // Stop while the UI transitions into the generating state.
      const submission = `async () => {
        await new Promise(resolve => setTimeout(resolve, 80));
        const expected = ${JSON.stringify(text)};
        const targetTitle = ${JSON.stringify(known.title)};
        const targetPath = ${JSON.stringify(chatId.startsWith("route:") ? "/c/" + chatId.slice(6) : "")};
        const editor = document.querySelector('textarea[placeholder="Send a Message"]');
        // A queue race may start generation after our native fill. Clear only
        // the exact draft we supplied when the Send click was not attempted.
        const clearOwnedDraft = () => {
          if (!editor || editor.value !== expected) return;
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          if (setter) setter.call(editor, ''); else editor.value = '';
          editor.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const stop = [...document.querySelectorAll('button')].some(button =>
          button.getClientRects().length > 0 &&
          !!button.querySelector(':scope > span.block.size-3.rounded-xs.bg-text-inverted')
        );
        if (stop) {
          clearOwnedDraft();
          return {submitted:false,reason:'busy'};
        }
        const send = document.querySelector('#send-message-button');
        const selected = [...document.querySelectorAll('button[data-selected]')]
          .find(button => button.getAttribute('data-selected') === 'true');
        const selectedTitle = selected?.querySelector('div[dir="auto"]')?.textContent?.trim()
          || selected?.textContent?.trim();
        if (location.origin !== 'https://chat.z.ai' ||
          !new RegExp("^/c/[a-f0-9-]{12,80}$", "i").test(location.pathname) ||
          (targetPath ? location.pathname !== targetPath : selectedTitle !== targetTitle)) {
          clearOwnedDraft();
          return {submitted:false,reason:'target_changed'};
        }
        if (!editor || editor.value !== expected) return {submitted:false,reason:'draft_changed'};
        if (!send || !send.getClientRects().length || send.disabled) {
          clearOwnedDraft();
          return {submitted:false,reason:'send_not_ready'};
        }
        send.click();
        return {submitted:true};
      }`;
      let receipt: { submitted: boolean; reason?: string };
      try {
        receipt = parseChromeEvaluation<{ submitted: boolean; reason?: string }>(
          await this.tools.call("evaluate_script", { pageId: page.id, function: submission }),
        );
      } catch {
        throw new Error("ZAI submission outcome unknown: do not retry automatically");
      }
      if (!receipt.submitted) {
        if (receipt.reason === "busy") throw new Error("prompt is already running; ZAI queue must wait");
        throw new Error("ZAI submission blocked before click: " + (receipt.reason || "unknown"));
      }
      this.lastSubmittedAt = Date.now();
      // A successful click is an attempt, not a receipt. When the site gives no
      // observable admission, fail closed without resubmitting.
      const confirmation = parseChromeEvaluation<{ remaining: string; origin: string; path: string }>(
        await this.tools.call("evaluate_script", {
          pageId: page.id,
          function: `() => ({remaining:document.querySelector('textarea[placeholder="Send a Message"]')?.value || '',
             origin:location.origin,path:location.pathname})`,
        }),
      );
      if (confirmation.remaining === text || confirmation.origin !== ZAI_ORIGIN ||
        !ROUTE_PATTERN.test(confirmation.path)) {
        throw new Error("ZAI submission admission unknown: do not retry automatically");
      }
      return {};
      } finally {
        await this.restoreComposerDraft(page.id, savedDraft).catch(() => undefined);
      }
    });
  }

  supportsModelSwitch(): boolean { return true; }

  /** Read the Z.ai model menu on the existing authenticated tab. */
  async listModels(): Promise<string[]> {
    return this.exclusive(async () => {
      const page = await this.page();
      await this.snapshot(page.id);
      const menu = parseChromeEvaluation<{ models: string[]; error?: string }>(
        await this.tools.call("evaluate_script", { pageId: page.id, function: `async () => {
          const visible = element => !!element && element.getClientRects().length > 0;
          if (location.origin !== 'https://chat.z.ai') return {models:[],error:'wrong_origin'};
          const buttons = [...document.querySelectorAll('button[aria-label="Select a model"]')].filter(visible);
          if (buttons.length !== 1) return {models:[],error:'model_picker_unavailable'};
          const button = buttons[0];
          const wasOpen = button.getAttribute('data-state') === 'open';
          if (!wasOpen) button.click();
          try {
            await new Promise(resolve => setTimeout(resolve, 160));
            const menu = [...document.querySelectorAll('[role="menu"][data-state="open"]')]
              .find(element => visible(element) && element.querySelector('button'));
            if (!menu) return {models:[],error:'model_menu_unavailable'};
            const models = [...menu.querySelectorAll('button')].filter(visible)
              .map(option => (option.textContent || '').trim())
              .filter(label => /^GLM-[A-Za-z0-9.-]+$/i.test(label) && label.length <= 100);
            return {models:[...new Set(models)]};
          } finally {
            if (!wasOpen && button.getAttribute('data-state') === 'open') button.click();
          }
        }` }),
      );
      if (menu.error) throw new Error("Z.ai model discovery failed: " + menu.error);
      return menu.models;
    });
  }

  /** A model is selected only for the verified, idle target conversation. */
  async changeModel(input: { chatId: string; model: string }): Promise<{ ok: boolean; error?: string }> {
    return this.exclusive(async () => {
      const { chatId, model } = input;
      if (!/^[\w.\-]{3,110}$/.test(model) || !model.startsWith("GLM-")) {
        return { ok: false, error: "Invalid Z.ai model name" };
      }
      const known = this.cache.get(chatId) ?? (await this.listUnlocked()).find(chat => chat.id === chatId);
      if (!known) return { ok: false, error: "Z.ai chat is not in the authenticated inventory" };
      const page = await this.page();
      let state = await this.snapshot(page.id);
      if (this.busy(state)) return { ok: false, error: "Z.ai model switch requires an idle chat" };
      if (!this.isSelected(chatId, known, state)) {
        const selection = await this.selectChat(page.id, chatId, known);
        if (selection !== "selected") return { ok: false, error: "Z.ai chat could not be selected safely" };
        state = await this.confirmTarget(page.id, chatId, known);
      }
      if (this.busy(state)) return { ok: false, error: "Z.ai chat became busy before model selection" };
      try {
        const receipt = parseChromeEvaluation<{ ok: boolean; reason?: string }>(
          await this.tools.call("evaluate_script", { pageId: page.id, function: `async () => {
            const model = ${JSON.stringify(model)};
            const route = ${JSON.stringify(chatId.startsWith("route:") ? "/c/" + chatId.slice(6) : "")};
            const title = ${JSON.stringify(chatId.startsWith("sidebar:") ? known.title : "")};
            const visible = element => !!element && element.getClientRects().length > 0;
            const stopped = () => [...document.querySelectorAll('button')].some(button => visible(button) &&
              !!button.querySelector(':scope > span.block.size-3.rounded-xs.bg-text-inverted'));
            const selectedTitle = () => {
              const selected = document.querySelector('button[data-selected="true"]');
              return selected?.querySelector('div[dir="auto"]')?.textContent?.trim()
                || selected?.textContent?.trim() || '';
            };
            const editor = document.querySelector('textarea[placeholder="Send a Message"]');
            const send = document.querySelector('#send-message-button');
            const safe = () => location.origin === 'https://chat.z.ai'
              && (route ? location.pathname === route :
                new RegExp('^/c/[a-f0-9-]{12,80}$', 'i').test(location.pathname) && selectedTitle() === title)
              && visible(send) && !!editor && !editor.value && !stopped();
            if (!safe()) return {ok:false,reason:'target_not_idle'};
            const buttons = [...document.querySelectorAll('button[aria-label="Select a model"]')].filter(visible);
            if (buttons.length !== 1) return {ok:false,reason:'picker_missing'};
            const button = buttons[0];
            const wasOpen = button.getAttribute('data-state') === 'open';
            if (!wasOpen) button.click();
            try {
              await new Promise(resolve => setTimeout(resolve, 160));
              const option = () => [...document.querySelectorAll('[role="menu"][data-state="open"] button')]
                .filter(visible).filter(item => (item.textContent || '').trim() === model);
              const matches = option();
              if (matches.length !== 1) return {ok:false,reason:'model_not_in_live_menu'};
              if ((button.textContent || '').trim() === model) return {ok:true};
              if (!safe()) return {ok:false,reason:'target_changed_before_click'};
              matches[0].click();
              await new Promise(resolve => setTimeout(resolve, 180));
              return {ok:safe() && (button.textContent || '').trim() === model,
                reason:'model_selection_readback_unconfirmed'};
            } finally {
              if (!wasOpen && button.getAttribute('data-state') === 'open') button.click();
            }
          }` }),
        );
        return receipt.ok ? { ok: true } :
          { ok: false, error: "Z.ai model change not confirmed: " + (receipt.reason || "unknown") };
      } catch {
        return { ok: false, error: "Z.ai model change outcome unknown; do not retry automatically" };
      }
    });
  }

  /** Clicking Stop never navigates to or changes a different chat. */
  async stopTurn(chatId: string): Promise<{ stopped: boolean; error?: string }> {
    return this.exclusive(async () => {
      const page = await this.page();
      const known = this.cache.get(chatId) ?? (await this.listUnlocked()).find(chat => chat.id === chatId);
      if (!known) return { stopped: false, error: "Z.ai chat not in authenticated inventory" };
      const current = await this.snapshot(page.id);
      if (!this.isSelected(chatId, known, current)) {
        return { stopped: false, error: "Z.ai Stop requires the exact currently selected chat" };
      }
      if (current.phase !== "generating") return { stopped: false, error: "Z.ai is not generating in that chat" };
      try {
        return parseChromeEvaluation<{ stopped: boolean; error?: string }>(
          await this.tools.call("evaluate_script", { pageId: page.id, function: `() => {
            const route = ${JSON.stringify(chatId.startsWith("route:") ? "/c/" + chatId.slice(6) : "")};
            const title = ${JSON.stringify(chatId.startsWith("sidebar:") ? known.title : "")};
            const selected = document.querySelector('button[data-selected="true"]');
            const selectedTitle = selected?.querySelector('div[dir="auto"]')?.textContent?.trim()
              || selected?.textContent?.trim() || '';
            const matches = location.origin === 'https://chat.z.ai' && (route
              ? location.pathname === route
              : new RegExp('^/c/[a-f0-9-]{12,80}$', 'i').test(location.pathname) && selectedTitle === title);
            if (!matches) return {stopped:false,error:'target_changed'};
            const stop = [...document.querySelectorAll('button')].filter(button =>
              button.getClientRects().length > 0 && !button.disabled
              && !!button.querySelector(':scope > span.block.size-3.rounded-xs.bg-text-inverted'));
            if (stop.length !== 1) return {stopped:false,error:'stop_control_not_unique'};
            stop[0].click();
            return {stopped:true};
          }` }),
        );
      } catch {
        return { stopped: false, error: "Z.ai Stop click outcome unknown; do not retry automatically" };
      }
    });
  }

  /** List the account's ZAI projects (chat.z.ai/project/<uuid>). */
  async listProjects(): Promise<Array<{ id: string; name: string; chatCount: number; archived: boolean }>> {
    return this.exclusive(async () => {
      const page = await this.page();
      const result = parseChromeEvaluation<{ error?: string; projects?: Array<{ id: string; name: string; chatCount: number; archived: boolean }> }>(
        await this.tools.call("evaluate_script", { pageId: page.id, function: ZAI_LIST_PROJECTS_SCRIPT }));
      if (result.error || !Array.isArray(result.projects)) return [];
      return result.projects;
    });
  }

  /** Move a ZAI chat into a project: PATCH /api/v1/chats/<id> with {project_id}. */
  async moveToProject(input: { chatId: string; projectId: string }): Promise<{ ok: boolean; error?: string }> {
    return this.exclusive(async () => {
      const page = await this.page();
      const result = parseChromeEvaluation<{ ok: boolean; status?: number; error?: string }>(
        await this.tools.call("evaluate_script", { pageId: page.id, function: zaiMoveToProjectScript(input.chatId, input.projectId) }));
      if (!result.ok) return { ok: false, error: result.error || ("move_http_" + (result.status || 0)) };
      return { ok: true };
    });
  }
}

/** Provider module loaded by the shared BrowserChatAdapter. No new Chrome instance. */
export async function createBrowserChatDriver(): Promise<BrowserChatDriver> {
  const raw = process.env.AGENT_HERDER_ZAI_PAGE_ID?.trim();
  const pageId = raw ? Number(raw) : undefined;
  if (raw && (!Number.isSafeInteger(pageId) || !pageId || pageId < 1)) {
    throw new Error("Invalid AGENT_HERDER_ZAI_PAGE_ID");
  }
  return new ZaiCdpDriver(new MacMiniChromeTransport(), pageId);
}
