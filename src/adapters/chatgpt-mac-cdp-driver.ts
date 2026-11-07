import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chatgptFullConversationApiScript, chatgptConversationChunkScript, chatgptConversationCleanupScript } from "./chatgpt-full-conversation.js";
import type { BrowserChat, BrowserChatDriver } from "./browser-chat.js";
import { BrowserChatDraftStore } from "./browser-chat-drafts.js";
import { submitFirstChatMessage, verifyNewChatAccountScope } from "./browser-chat-new-page.js";
import { chatgptPassiveHistoryScript } from "./chatgpt-passive-history.js";
import { ChatGptBackgroundBudget } from "./chatgpt-background-budget.js";
import { ChatGptBackgroundNavigator } from "./chatgpt-background-navigator.js";
import { resolveAutopilotStateDir } from "../autopilot/state-dir.js";
import type { HarnessEvent, SessionMessageView } from "../types/index.js";
import { CHATGPT_LIST_API_SCRIPT, CHATGPT_LIST_API_PASSIVE_SCRIPT, CHATGPT_FULL_SCAN_SCRIPT, chatgptMessagesApiScript } from "./browser-chat-api-scripts.js";
import { BrowserChatInventoryCache } from "./browser-chat-inventory-cache.js";
import { ChatGptRequestTrace } from "./chatgpt-request-trace.js";
import { getChatGptBayesBackoff, BAYES_TARGET_CHATGPT_LIST, BAYES_TARGET_CHATGPT_HISTORY } from "./chatgpt-bayes-backoff.js";
import { MacMiniChromeTransport, parseChromeEvaluation, type ChromePageTools } from "./mac-mini-chrome-transport.js";
import { liveHarnessPollingEnabled, liveHarnessPromptPollingEnabled } from "../harness-runtime-settings.js";

const ORIGIN = "https://chatgpt.com";
const MAX_MESSAGE = 16_000;
const POST_SEND_GUARD_MS = 1_800;
/** How long a chat we last saw generating stays marked working after the
 *  hosting tab navigates away. The chatgpt site's async_status is not a
 *  reliable background-running signal, so without this grace window the
 *  autopilot would lose running->idle transitions every time the herder
 *  borrows the tab to deliver a continuation to another chat. Five
 *  minutes is longer than a typical model turn and shorter than the
 *  observer's stale-refresh window, so a real finish still lands. */
const RECENTLY_GENERATING_TTL_MS = 5 * 60 * 1000;
const NATIVE_CHAT_ID = /^[a-f0-9]{8}-[a-f0-9-]{20,75}$/i;
type Phase = "idle" | "generating" | "unknown";
export type Page = { id: number; url: string; selected?: boolean; conversation?: boolean };
/** One modal prompt that the page is currently showing to the user.
 * Collected by the same evaluate_script call as the rest of the snapshot,
 * with no extra HTTP request: it never triggers a 429. Buttons carry only
 * their visible label / aria-label / disabled state. */
export type ModalPromptKind = "permission" | "work_continue" | "unknown_modal";
export interface ModalPromptButton { label: string; ariaLabel?: string; disabled?: boolean; }
export interface ModalPrompt { role: string; title: string; body: string; buttons: ModalPromptButton[]; }
type Snapshot = {
  origin: string; path: string; authenticated: boolean; composer: boolean;
  phase: Phase; draftPresent: boolean;
  chats: Array<{ id: string; title: string }>;
  pageResources?: unknown;
  modalPrompts?: ModalPrompt[];
};

export function parseChatGptPages(text: string): Page[] {
  return text.split("\n").flatMap(line => {
    const match = line.match(/^\s*(\d+):.*?\((https:\/\/chatgpt\.com(?:\/[^)]*)?)\)(\s*\[selected\])?/);
    if (!match) return [];
    try {
      const url = new URL(match[2]!);
      if (url.origin !== ORIGIN) return [];
      // /dots/home is the ChatGPT workspace dashboard: a valid authenticated
      // tab with the same sidebar/composer once navigated. It is no longer
      // excluded; a conversation tab is simply preferred (see pickChatGptPage).
      const conversation = /^(?:\/c\/[a-f0-9-]{28,80}|\/g\/g-p-[a-f0-9-]+\/c\/[a-f0-9-]{28,80})$/i.test(url.pathname);
      return [{ id: Number(match[1]), url: url.toString(), conversation, ...(match[3] ? { selected: true } : {}) }];
    } catch { return []; }
  });
}

/** Deterministic pick among open ChatGPT tabs: the selected tab first, then
 * a tab already on a conversation route (/c/<id> or /g/g-p-…/c/<id>) so a
 * dashboard such as /dots/home is left undisturbed, then the lowest page ID. */
export function pickChatGptPage(pages: Page[]): Page {
  return pages.find(page => page.selected)
    ?? pages.find(page => page.conversation)
    ?? [...pages].sort((a, b) => a.id - b.id)[0]!;
}

/** A read-only page snapshot, using the live ChatGPT sidebar's native /c/ URLs.
 * This code never reads message bodies, cookies, JWTs or private drafts.
 */
export const CHATGPT_MAC_SNAPSHOT = `() => {
  const route = /^\\/(?:c|g\\/g-p-[a-f0-9-]+\\/c)\\/([a-f0-9-]{28,80})$/i;
  const links = [...document.querySelectorAll('a[data-interactive-row-link][href^="/c/"],a[data-interactive-row-link][href^="/g/"]')];
  const chats = links.flatMap(link => {
    const path = link.getAttribute('href') || '';
    const match = path.match(route);
    if (!match) return [];
    const title = (link.getAttribute('aria-label') || link.textContent || '').trim();
    return title ? [{id:match[1],title}] : [];
  });
  const editor = document.querySelector('div[contenteditable="true"][role="textbox"][data-composer-markdown]');
  const visible = node => !!node && node.getClientRects().length > 0;
  const buttons = [...document.querySelectorAll('button')].filter(visible);
  const stop = buttons.some(button =>
    /^(Stop generating|Stop response|Остановить генерацию|Остановить ответ|Остановить)$/i.test(
      button.getAttribute('aria-label') || ''
    ) || button.getAttribute('data-testid') === 'stop-button'
  );
  const voice = buttons.some(button =>
    /^(Начать голосовой разговор|Start voice conversation|Start voice chat)$/i.test(
      button.getAttribute('aria-label') || ''
    )
  );
  // PerformanceResourceTiming is passive; entries can include both native page
  // traffic and our CDP fetches. They are NEVER counted as unique upstream calls.
  let pageResources=[];
  try {
    if(typeof performance!=='undefined' && performance.getEntriesByType) {
      const entries=performance.getEntriesByType('resource').slice(-300);
      const highest=entries.reduce((v,e)=>Math.max(v,e.startTime||0),0);
      const previous=globalThis.__herderTracePerfCursor;
      globalThis.__herderTracePerfCursor=highest;
      if(typeof previous==='number') {
        for(const e of entries) {
          if(!(e.startTime>previous))continue;
          const u=new URL(e.name,location.origin);
          if(u.origin!==location.origin)continue;
          let endpoint,operation;
          if(u.pathname==='/api/auth/session'){endpoint='/api/auth/session';operation='auth_session';}
          else if(u.pathname==='/backend-api/conversations'){endpoint='/backend-api/conversations';operation='conversation_list';}
          else if(/^\\/backend-api\\/conversations?\\/[^/]+$/.test(u.pathname)){
            endpoint=u.pathname.startsWith('/backend-api/conversations/')
              ?'/backend-api/conversations/{id}':'/backend-api/conversation/{id}';
            operation='conversation_read';
          }else continue;
          pageResources.push({endpoint,operation,
            http_status:Number.isInteger(e.responseStatus)?e.responseStatus:null,
            latency_ms:e.duration});
        }
      }
    }
  }catch{pageResources=[];}
  // Collect every visible modal dialog so the driver can answer permission
  // and 'Continue in Work?' prompts without an extra round trip. Read-only:
  // only role, names and disabled state leave the page.
  const modalPrompts = [];
  try {
    const isVisible = node => !!node && node.getClientRects().length > 0;
    const modalRoots = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"]')].filter(isVisible);
    for (const root of modalRoots) {
      const name = (root.getAttribute('aria-label') || '').trim();
      const heading = root.querySelector('h1,h2,h3,[role="heading"]');
      const title = name || (heading ? (heading.textContent || '').trim() : '');
      const textParts = [];
      const walk = (node) => {
        if (textParts.length >= 40) return;
        if (node.nodeType === Node.TEXT_NODE) {
          const t = (node.nodeValue || '').trim();
          if (t) textParts.push(t);
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const tag = node.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style') return;
        for (const child of node.childNodes) walk(child);
      };
      walk(root);
      const dialogButtons = [...root.querySelectorAll('button')].filter(isVisible);
      modalPrompts.push({
        role: root.getAttribute('role') || (root.getAttribute('aria-modal') === 'true' ? 'modal' : 'dialog'),
        title: String(title).slice(0, 200),
        body: textParts.join(' | ').slice(0, 300),
        buttons: dialogButtons.slice(0, 12).map(b => ({
          label: (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 120),
          ariaLabel: (b.getAttribute('aria-label') || '').trim().slice(0, 120) || undefined,
          disabled: !!b.disabled,
        })).filter(b => b.label),
      });
    }
  } catch { modalPrompts.length = 0; }
  return {
    origin:location.origin,path:location.pathname,
    authenticated:!!document.querySelector('button[aria-label="Открыть меню профиля"],button[aria-label="Open profile menu"]'),
    composer:visible(editor),
    phase:stop?'generating':(visible(editor)&&voice?'idle':'unknown'),
    draftPresent:!!(editor?.textContent||'').trim(),
    chats:chats.slice(0,300),
    pageResources:pageResources.slice(-40),
    modalPrompts:modalPrompts.slice(0,8),
  };
}`;

/** ChatGPT browser site, sharing Mac mini's established CDP owner with ZAI.
 * The tab is auto-discovered (selected tab, else the lowest page ID) or opened
 * on demand; there is never a fallback to the other provider's tab.
 */
export class ChatGptMacCdpDriver implements BrowserChatDriver {
  private backgroundNavigator?: ChatGptBackgroundNavigator;
  private backgroundBudget?: ChatGptBackgroundBudget;
  private backgroundBudgetUnsafe = false;

  private getBackgroundBudget(): ChatGptBackgroundBudget | undefined {
    if (this.backgroundBudgetUnsafe) return undefined;
    if (!this.backgroundBudget) {
      const stateDir = resolveAutopilotStateDir();
      try {
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        this.backgroundBudget = new ChatGptBackgroundBudget(join(stateDir, "chatgpt-background-budget.json"));
      } catch { this.backgroundBudgetUnsafe = true; return undefined; }
    }
    return this.backgroundBudget;
  }
  readonly browserFeatures = {
    nativeConversationIds: true,
    queueAfterGeneration: true,
    chatCreation: true,
    accountArchiveViaCdp: true,
    projects: true,
  } as const;
  private readonly cache = new Map<string, BrowserChat>();
  private readonly drafts = new BrowserChatDraftStore("chatgpt");
  /** The list of this driver answers without one site request while the
   * polling of the harness is paused: the intercept stash of the page, the
   * durable inventory of the account and the visible sidebar DOM. */
  readonly passiveInventory = true;
  /** Durable full inventory of the verified account; the intercept hook of
   * the page keeps it fresh without one list request of the herder's own. */
  private readonly inventoryCache = new BrowserChatInventoryCache("chatgpt");
  private inventoryLoaded = false;
  private readonly requestTrace = new ChatGptRequestTrace();
  private operation: Promise<void> = Promise.resolve();
  private lastSubmittedAt = 0;
  private accountScope: string | undefined;
  /** Chats recently observed with phase=generating while their tab was
   *  selected. The ChatGPT site's /backend-api/conversations often returns
   *  an empty items list (or omits async_status), so the only reliable
   *  "this chat is generating" signal is the editor's Stop button on the
   *  tab that hosts the chat. When the herder navigates that tab to a
   *  different chat (to deliver a continuation, to read messages, ...),
   *  the adapter would otherwise lose the running state and the autopilot's
   *  browser-turn-observer would never see the running->idle transition
   *  that fires the Stop consumer (and with it the /pilot command path).
   *  We therefore remember every chat we last saw generating, keep it
   *  marked working for RECENTLY_GENERATING_TTL_MS, and clear it the next
   *  time its own tab returns and reports phase=idle. */
  private readonly recentlyGenerating = new Map<string, number>();
  getAccountScope(): string | undefined { return this.accountScope; }

  // --------------------------------------------------------------
  // Modal-prompt polling + permission/continue-in-work auto-answer.
  // The poller reuses the same MacMiniChromeTransport and the same
  // CHATGPT_MAC_SNAPSHOT script; evaluate_script and take_snapshot go
  // through the local CDP WebSocket and cannot trigger HTTP 429 from
  // chatgpt.com. The poller respects the existing 429 cooldown in three
  // independent ways: (1) the page-side globalThis
  // __herderChatGptReadCooldownUntil timestamp is probed each cycle; (2) a
  // 429 seen in pageResources backs the poller off for 60s; (3) the poller
  // never runs while an exclusive operation is in flight. Clicks happen in
  // one atomic evaluate_script that re-locates the chosen button inside the
  // dialog root and only then clicks; a stale snapshot can never click the
  // wrong button.
  private static readonly PROMPT_POLL_INTERVAL_MS = 5_000;
  private static readonly PROMPT_BACKOFF_AFTER_429_MS = 60_000;
  private static readonly PROMPT_BACKOFF_AFTER_ERROR_MS = 15_000;
  private promptPollTimer: ReturnType<typeof setInterval> | undefined;
  private promptPollInFlight = false;
  private lastSeen429At = 0;
  private promptPollErrorUntil = 0;
  private readonly promptListeners = new Set<(event: HarnessEvent) => void>();

  /** Subscribe to permission.requested / permission.resolved events emitted
   * by this driver when it answers (or skips) a modal prompt. Returns an
   * unsubscribe function. BrowserChatAdapter forwards these into the shared
   * Herder event bus. */
  subscribePromptEvents(handler: (event: HarnessEvent) => void): () => void {
    this.promptListeners.add(handler);
    return () => { this.promptListeners.delete(handler); };
  }

  /** Begin periodic modal-prompt polling. */
  startPromptPolling(opts: { intervalMs?: number } = {}): void {
    const intervalMs = opts.intervalMs && Number.isFinite(opts.intervalMs)
      ? Math.max(2_000, Math.min(60_000, Math.round(opts.intervalMs)))
      : ChatGptMacCdpDriver.PROMPT_POLL_INTERVAL_MS;
    if (this.promptPollTimer) clearInterval(this.promptPollTimer);
    this.promptPollTimer = setInterval(() => { void this.pollOnce().catch(() => undefined); }, intervalMs);
    if (typeof this.promptPollTimer.unref === "function") this.promptPollTimer.unref();
  }

  stopPromptPolling(): void {
    if (this.promptPollTimer) { clearInterval(this.promptPollTimer); this.promptPollTimer = undefined; }
  }

  private emitPromptEvent(event: HarnessEvent): void {
    for (const handler of this.promptListeners) {
      try { handler(event); } catch { /* a listener must never break the driver */ }
    }
  }

  private async pollOnce(): Promise<void> {
    // The runtime switch of the owner: a paused harness stops this poller
    // too — even a CDP snapshot is a request the paused site does not see.
    if (!liveHarnessPromptPollingEnabled("chatgpt")) return;
    if (this.promptPollInFlight) return;
    if (Date.now() < this.promptPollErrorUntil) return;
    if (Date.now() - this.lastSeen429At < ChatGptMacCdpDriver.PROMPT_BACKOFF_AFTER_429_MS) return;
    if (Date.now() < getChatGptBayesBackoff().cooldownUntilMs(BAYES_TARGET_CHATGPT_LIST)) return;
    this.promptPollInFlight = true;
    try {
      const page = await this.page().catch(() => null);
      if (!page) return;
      const probe = parseChromeEvaluation<{ cooldownUntil: number | null }>(
        await this.tools.call("evaluate_script", { pageId: page.id, function:
          `() => ({cooldownUntil: typeof globalThis.__herderChatGptReadCooldownUntil === 'number' ? globalThis.__herderChatGptReadCooldownUntil : null})` }),
      );
      if (probe.cooldownUntil && Date.now() < probe.cooldownUntil) return;
      await this.snapshot(page.id).catch(() => null);
    } catch (error) {
      this.promptPollErrorUntil = Date.now() + ChatGptMacCdpDriver.PROMPT_BACKOFF_AFTER_ERROR_MS;
      console.error("[agent-herder] chatgpt_prompt poll_error " + String((error as Error)?.message || error).slice(0, 200));
    } finally {
      this.promptPollInFlight = false;
    }
  }

  /** Classify each modal prompt and click the chosen button for the kinds
   * we auto-answer. Always emits a permission.* event to listeners,
   * including when no matching button is found, so the Herder UI can
   * surface that a prompt was seen but not handled. */
  private async respondToModalPrompts(pageId: number, prompts: readonly ModalPrompt[]): Promise<void> {
    for (const prompt of prompts) {
      const classification = classifyModalPrompt(prompt);
      const chosen = classification.chosen;
      const baseEvent = {
        harness: "chatgpt" as const,
        at: new Date().toISOString(),
        data: {
          title: prompt.title, body: prompt.body, kind: classification.kind,
          buttons: prompt.buttons.map(b => b.label),
          chosenLabel: chosen?.label, chosenPatternId: chosen?.patternId,
        },
      };
      this.emitPromptEvent({ kind: "permission.requested", ...baseEvent, permissionId: classification.fingerprint });
      if (!chosen) continue;
      try {
        const script = buildPromptClickScript(prompt, chosen);
        const receipt = parseChromeEvaluation<{ clicked: boolean; reason?: string; label?: string }>(
          await this.tools.call("evaluate_script", { pageId, function: script }));
        this.emitPromptEvent({
          kind: "permission.resolved", ...baseEvent, permissionId: classification.fingerprint,
          data: { ...baseEvent.data, clicked: receipt.clicked, reason: receipt.reason, finalLabel: receipt.label },
        });
        if (receipt.clicked) {
          console.error("[agent-herder] chatgpt_prompt clicked " + JSON.stringify({
            kind: classification.kind, label: chosen.label, patternId: chosen.patternId,
            title: prompt.title.slice(0, 80),
          }));
        }
      } catch (error) {
        this.emitPromptEvent({
          kind: "permission.resolved", ...baseEvent, permissionId: classification.fingerprint,
          data: { ...baseEvent.data, clicked: false, error: String((error as Error)?.message || error).slice(0, 200) },
        });
      }
    }
  }


  constructor(private readonly tools: ChromePageTools, private readonly pinnedPageId?: number, private readonly openWaitMs = 5_000) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const op = this.operation.then(fn);
    this.operation = op.then(() => undefined, () => undefined);
    return op;
  }

  /** Auto-detect the ChatGPT tab; open one when none exists. A stale explicit
   * pin never disables the provider and falls back to auto-detection. */
  private async page(): Promise<Page> {
    const pages = parseChatGptPages(await this.tools.call("list_pages"));
    const pinned = this.pinnedPageId !== undefined
      ? pages.find(page => page.id === this.pinnedPageId) : undefined;
    if (pinned?.conversation) return pinned;
    if (pages.length) return pickChatGptPage(pages);
    return this.openChatGptTab();
  }

  /** The tab list is the source of truth: new_page reports its own navigation
   * timeout even when the tab actually opened, so that error is tolerated. */
  private async openChatGptTab(): Promise<Page> {
    try {
      await this.tools.call("new_page", { url: ORIGIN + "/" });
    } catch { /* presence is verified by the re-list below */ }
    await new Promise(resolve => setTimeout(resolve, this.openWaitMs));
    const pages = parseChatGptPages(await this.tools.call("list_pages"));
    if (!pages.length) throw new Error("No ChatGPT tab in Mac mini Chrome and auto-open failed");
    return pickChatGptPage(pages);
  }

  private async snapshot(pageId: number): Promise<Snapshot> {
    const started = Date.now();
    const result = parseChromeEvaluation<Snapshot>(
      await this.tools.call("evaluate_script", { pageId, function: CHATGPT_MAC_SNAPSHOT }));
    this.requestTrace.ingestPageResources(result.pageResources);
    this.requestTrace.record({
      kind: "dom_cache_read", initiator: "herder_browser", executor: "herder_cdp",
      operation: "snapshot", endpoint: "other", latency_ms: Date.now()-started,
    });
    if (Array.isArray(result.pageResources)) {
      for (const r of result.pageResources as Array<Record<string, unknown>>) {
        if (r && r.http_status === 429) { this.lastSeen429At = Date.now(); break; }
      }
    }
    if (result.origin !== ORIGIN || !result.authenticated ||
      !["idle", "generating", "unknown"].includes(result.phase)) {
      // The composer is not required here: a /dots/home workspace dashboard has
      // no editor but is still an authenticated listing surface. sendMessage
      // navigates such a tab to /c/<id> and re-checks the composer there.
      throw new Error("ChatGPT Mac mini tab is not an authenticated page");
    }
    if (result.modalPrompts && result.modalPrompts.length) {
      void this.respondToModalPrompts(pageId, result.modalPrompts).catch((error) => {
        console.error("[agent-herder] chatgpt_prompt respond_error " + String((error as Error)?.message || error).slice(0, 200));
      });
    }
    return result;
  }

  private busy(s: Snapshot): boolean {
    // A user draft is preserved and restored around the herder's send (see
    // readComposerDraft/restoreComposerDraft), so it no longer counts as
    // busy. Only an active generation or the post-send guard blocks the next send.
    return s.phase !== "idle" ||
      Date.now() - this.lastSubmittedAt < POST_SEND_GUARD_MS;
  }

  private toChat(id: string, title: string, s: Snapshot, at?: number, asyncStatus?: number): BrowserChat {
    const selected = s.path.endsWith("/c/" + id);
    // Track which chats we currently see generating on their own tab.
    // The selected tab is the only place the DOM exposes a Stop button,
    // so phase=generating+selected is the one honest "this chat is
    // running right now" signal we can read without a site API that
    // works. When the tab moves away we keep that chat marked working
    // for the TTL grace window so the browser-turn-observer still sees
    // the running->idle transition when the model actually finishes.
    if (selected && s.phase === "generating") {
      this.recentlyGenerating.set(id, Date.now());
    } else if (selected && s.phase === "idle") {
      // The tab came back to a chat that is now idle: the turn we may
      // have been remembering is over. Clear it so working flips back
      // to false immediately, not after the TTL expires.
      this.recentlyGenerating.delete(id);
    }
    const recentlyRunning = !selected && this.recentlyGenerating.has(id)
      && Date.now() - (this.recentlyGenerating.get(id) ?? 0) < RECENTLY_GENERATING_TTL_MS;
    if (!selected && !recentlyRunning) {
      // TTL expired: drop the stale entry so the map cannot grow
      // unbounded across a long session.
      this.recentlyGenerating.delete(id);
    }
    // ChatGPT's conversation list exposes async_status per chat: non-zero
    // marks a conversation with an active background operation (a generation
    // that continued after the driver navigated away, or another async task).
    // That is the only honest busy signal for a conversation not open in the
    // observed tab; the DOM Stop control exists only on the selected page.
    const nativeRunning = !selected && typeof asyncStatus === "number" && asyncStatus !== 0;
    const working = selected ? this.busy(s) : (nativeRunning || recentlyRunning);
    return {
      id, title, updatedAt: typeof at === "number" && at > 0
        ? new Date(at < 1e12 ? at * 1000 : at).toISOString() : new Date().toISOString(),
      working,
      ...(nativeRunning ? { workingSource: "native-async-status" as const }
        : recentlyRunning ? { workingSource: "recently-generating" as const } : {}),
      stopVisible: selected && s.phase === "generating",
      unread: false, updatedAtSemantics: typeof at === "number" && Number.isFinite(at) && at > 0 ? "remote-update-time" : "observed-sidebar-order",
      sourceRoute: ORIGIN + "/c/" + id,
    };
  }

  /** Feed every observed upstream outcome into the Bayesian backoff. This
   * is the single recording point per HTTP outcome (the trace ingest), so
   * the history cache and the prompt poller only consume verdicts and never
   * double-count. */
  private feedBackoff(trace: unknown): void {
    if (!Array.isArray(trace)) return;
    const backoff = getChatGptBayesBackoff();
    for (const entry of trace as Array<Record<string, unknown>>) {
      if (!entry || typeof entry !== "object") continue;
      const status = entry.http_status;
      if (typeof status !== "number") continue;
      const target = entry.operation === "conversation_list" ? BAYES_TARGET_CHATGPT_LIST
        : entry.operation === "conversation_read" ? BAYES_TARGET_CHATGPT_HISTORY : null;
      if (!target) continue;
      if (status === 429) {
        const retry = typeof entry.retry_after_s === "number" && Number.isFinite(entry.retry_after_s)
          ? entry.retry_after_s : undefined;
        backoff.record429(target, undefined, retry);
      } else if (status >= 200 && status < 400) {
        backoff.recordSuccess(target);
      }
    }
  }

  private async listUnlocked(forcePassive = false): Promise<BrowserChat[]> {
    // Passive background inventory must not silently open and load a new
    // ChatGPT page when the browser currently has no matching tab.
    const paused = forcePassive || !liveHarnessPollingEnabled("chatgpt");
    const pages = paused ? parseChatGptPages(await this.tools.call("list_pages")) : undefined;
    if (pages && !pages.length) return [];
    const pinned = pages?.find(candidate => candidate.id === this.pinnedPageId && candidate.conversation);
    const page = pages ? (pinned ?? pickChatGptPage(pages)) : await this.page();
    const s = await this.snapshot(page.id);
    // The runtime switch of the owner: while the site requests of this
    // harness are paused, the list answers from passive sources only — the
    // responses the site itself made (the intercept hook) plus the durable
    // inventory — and never from a fetch the herder initiates.
    if (paused) return this.listPassive(s, page.id);
    // Bayesian 429 verdict: while the adaptive cooldown is active the list
    // answers from passive sources instead of spending another request.
    if (Date.now() < getChatGptBayesBackoff().cooldownUntilMs(BAYES_TARGET_CHATGPT_LIST)) {
      return this.listPassive(s, page.id);
    }
    // The real authenticated list API returns 100 native IDs immediately.
    // It does not navigate or change the user's selected chat.
    try {
      const data = parseChromeEvaluation<{
        scope?: string; error?: string; trace?: unknown;
        chats?: Array<{ id: string; title: string; updatedAt?: number; asyncStatus?: number }>;
      }>(await this.tools.call("evaluate_script", { pageId: page.id, function: CHATGPT_LIST_API_SCRIPT }));
      this.requestTrace.ingestBrowserHttp(data.trace);
      this.feedBackoff(data.trace);
      if (data?.scope && /^[a-f0-9]{64}$/.test(data.scope)) this.accountScope = data.scope;
      if (data.scope && /^[a-f0-9]{64}$/.test(data.scope) && Array.isArray(data.chats)) {
        this.accountScope = data.scope;
        this.inventoryCache.setAccountScope(data.scope);
        if (!this.inventoryLoaded) { await this.inventoryCache.load(); this.inventoryLoaded = true; }
        this.inventoryCache.merge(data.chats.map(entry => ({ id: entry.id, title: entry.title, updatedAt: entry.updatedAt, asyncStatus: entry.asyncStatus, seenAt: Date.now() })));
        void this.inventoryCache.save();
        // The one-time full scan is a burst of the site's own requests: it
        // belongs to the running state alone, never to the paused one.
        if (!this.inventoryCache.lastScannedAt) void this.fullScan().catch(() => undefined);
        const seen = new Set<string>();
        const chats: BrowserChat[] = [];
        const source = this.inventoryCache.size > data.chats.length ? this.inventoryCache.list() : data.chats;
        for (const entry of source) {
          if (!NATIVE_CHAT_ID.test(entry.id) || seen.has(entry.id) || !entry.title) continue;
          seen.add(entry.id);
          chats.push(this.toChat(entry.id, entry.title, s, entry.updatedAt, entry.asyncStatus));
        }
        const selected = s.path.match(/\/c\/([a-f0-9-]{28,80})$/i)?.[1];
        if (selected && NATIVE_CHAT_ID.test(selected) && !seen.has(selected)) {
          chats.unshift(this.toChat(selected, this.cache.get(selected)?.title || "ChatGPT conversation", s));
        }
        for (const chat of chats) this.cache.set(chat.id, chat);
        return chats;
      }
      if (data?.error) {
        const error = typeof data.error === "string" ? data.error : "";
        const classification = ["wrong_origin", "read_cooldown", "session_unavailable", "account_unavailable"].includes(error)
          || /^list_http_[1-5][0-9]{2}$/.test(error) ? error : "unknown_error";
        console.warn("[chatgpt] list API " + classification + "; falling back to sidebar DOM");
      }
    } catch { /* The site may change its private API; retain the DOM fallback. */ }
    return this.listFromSidebarDom(s);
  }

  /** The list of the paused harness. Every source here is read without one
   * request of the herder's own: the intercept stash the page holds, the
   * durable inventory of the account, and the visible sidebar DOM. */
  private async listPassive(s: Snapshot, pageId: number): Promise<BrowserChat[]> {
    try {
      const data = parseChromeEvaluation<{
        scope?: string; error?: string;
        chats?: Array<{ id: string; title: string; updatedAt?: number; asyncStatus?: number }>;
      }>(await this.tools.call("evaluate_script", { pageId, function: CHATGPT_LIST_API_PASSIVE_SCRIPT }));
      const scope = (data.scope && /^[a-f0-9]{64}$/.test(data.scope) ? data.scope : undefined) ?? this.accountScope;
      if (scope) {
        this.inventoryCache.setAccountScope(scope);
        if (!this.inventoryLoaded) { await this.inventoryCache.load(); this.inventoryLoaded = true; }
        if (Array.isArray(data.chats) && data.chats.length) {
          this.inventoryCache.merge(data.chats.map(entry => ({ id: entry.id, title: entry.title, updatedAt: entry.updatedAt, asyncStatus: entry.asyncStatus, seenAt: Date.now() })));
          void this.inventoryCache.save();
        }
        if (this.inventoryCache.size) {
          const seen = new Set<string>();
          const chats: BrowserChat[] = [];
          for (const entry of this.inventoryCache.list()) {
            if (!NATIVE_CHAT_ID.test(entry.id) || seen.has(entry.id) || !entry.title) continue;
            seen.add(entry.id);
            chats.push(this.toChat(entry.id, entry.title, s, entry.updatedAt, entry.asyncStatus));
          }
          const selected = s.path.match(/\/c\/([a-f0-9-]{28,80})$/i)?.[1];
          if (selected && NATIVE_CHAT_ID.test(selected) && !seen.has(selected)) {
            chats.unshift(this.toChat(selected, this.cache.get(selected)?.title || "ChatGPT conversation", s));
          }
          for (const chat of chats) this.cache.set(chat.id, chat);
          return chats;
        }
      }
    } catch { /* passive listing must never throw */ }
    return this.listFromSidebarDom(s);
  }

  /** The last resort of every list path: the chats the observed sidebar
   * actually shows. A pure DOM read — no request of any kind. */
  private listFromSidebarDom(s: Snapshot): BrowserChat[] {
    const seen = new Set<string>();
    const chats: BrowserChat[] = [];
    for (const { id, title } of s.chats) {
      if (!NATIVE_CHAT_ID.test(id) || seen.has(id)) continue;
      seen.add(id);
      chats.push(this.toChat(id, title, s));
    }
    const current = s.path.match(/\/c\/([a-f0-9-]{28,80})$/i)?.[1];
    if (current && NATIVE_CHAT_ID.test(current) && !seen.has(current)) {
      const oldTitle = this.cache.get(current)?.title;
      chats.unshift(this.toChat(current, oldTitle || "ChatGPT conversation", s));
    }
    for (const chat of chats) this.cache.set(chat.id, chat);
    return chats;
  }

  /** Full paginated scan of every conversation: offset=0,100,200… with a 15s
   * gap between pages, respecting the 429 cooldown of the page. An explicit
   * action of the owner (the rescan button or the very first run), so it may
   * run even while the periodic polling stays paused. */
  async fullScan(): Promise<{ count: number; pages: number }> {
    return this.exclusive(async () => {
      const page = await this.page();
      const result = parseChromeEvaluation<{ scope?: string; error?: string; trace?: unknown; pages?: number; chats?: Array<{ id: string; title: string; updatedAt?: number; asyncStatus?: number }> }>(await this.tools.call("evaluate_script", { pageId: page.id, function: CHATGPT_FULL_SCAN_SCRIPT }));
      this.requestTrace.ingestBrowserHttp(result.trace);
      this.feedBackoff(result.trace);
      if (result.scope && /^[a-f0-9]{64}$/.test(result.scope)) {
        this.accountScope = result.scope;
        this.inventoryCache.setAccountScope(result.scope);
        if (!this.inventoryLoaded) { await this.inventoryCache.load(); this.inventoryLoaded = true; }
      }
      if (Array.isArray(result.chats) && result.chats.length) {
        this.inventoryCache.mergeFull(result.chats.map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, asyncStatus: c.asyncStatus, seenAt: Date.now() })));
        void this.inventoryCache.save();
        console.log("[chatgpt] full scan: " + result.chats.length + " chats across " + (result.pages || 0) + " pages");
      }
      return { count: this.inventoryCache.size, pages: Number(result.pages) || 0 };
    });
  }

  /** A blank ChatGPT composer has no server ID until the first user prompt.
   * Create a durable local draft; do not spend quota or touch the current tab.
   */
  async createChat(input: { title?: string }): Promise<BrowserChat> {
    return this.exclusive(async () => {
      const ownerPage=await this.page();
      this.accountScope=await verifyNewChatAccountScope(this.tools,"chatgpt",ownerPage.id);
      await this.drafts.useScope(this.accountScope);
      // The regular Herder new-session form submits an autogenerated name;
      // don't display that opaque slug as a human chat title.
      const title = input.title && !/^chatgpt-\d{12,}/i.test(input.title)
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

  async listObservedChats(): Promise<readonly BrowserChat[]> {
    return this.exclusive(async () => {
      const native = await this.listUnlocked(true);
      await this.drafts.useScope(this.accountScope);
      return this.drafts.merge(native);
    });
  }

  getKnownChat(id: string): BrowserChat | null {
    if (id.startsWith("draft:")) {
      const draft=this.drafts.get(id);
      return draft ? this.drafts.asChat(draft, draft.remoteId ? this.cache.get(draft.remoteId) : undefined) : null;
    }
    if (!NATIVE_CHAT_ID.test(id)) return null;
    this.requestTrace.record({
      kind: "dom_cache_read", initiator: "herder_browser", executor: "herder_cdp",
      operation: "cache_lookup", endpoint: "other", cache_hit: this.cache.has(id),
    });
    return this.cache.get(id) ?? {
      id, title: "ChatGPT conversation", working: false, stopVisible: false,
      unread: false, updatedAt: new Date(0).toISOString(),
      sourceRoute: ORIGIN + "/c/" + id,
      updatedAtSemantics: "deep-link-unverified",
    };
  }

  async getChat(id: string): Promise<BrowserChat | null> {
    return this.exclusive(async () => {
      if (id.startsWith("draft:")) {
        // A driver restart clears the in-memory store. Restore only the
        // currently verified account's drafts before resolving an exact ID.
        const ownerPage = await this.page();
        this.accountScope = await verifyNewChatAccountScope(this.tools, "chatgpt", ownerPage.id);
        await this.drafts.useScope(this.accountScope);
      }
      const draft = this.drafts.get(id);
      if (draft) return this.drafts.asChat(draft, draft.remoteId ? this.cache.get(draft.remoteId) : undefined);
      if (!NATIVE_CHAT_ID.test(id)) return null;
      return (await this.listUnlocked()).find(c => c.id === id) ?? null;
    });
  }

  /** Read visible messages only from an already-open exact conversation.
   * This background path does not navigate, create tabs, or fetch. */
  async getObservedMessages(id: string): Promise<SessionMessageView[] | null> {
    if (id.startsWith("draft:")) id = this.drafts.get(id)?.remoteId || "";
    if (!NATIVE_CHAT_ID.test(id)) return null;
    const pages = parseChatGptPages(await this.tools.call("list_pages"));
    const matching = pages.filter(candidate => {
      const path = new URL(candidate.url).pathname;
      return path === `/c/${id}` || path.endsWith(`/c/${id}`);
    });
    if (!matching.length) return null;
    let agreed: SessionMessageView[] | null = null;
    let freshVisit = false;
    for (const page of matching) {
      const result = parseChromeEvaluation<{sessionId?:string;phase?:string;freshVisit?:boolean;last429?:string;cooldownUntil?:number;messages?:Array<{id?:unknown;role?:unknown;text?:unknown}>}>(
        await this.tools.call("evaluate_script",{pageId:page.id,function:chatgptPassiveHistoryScript()}));
      if (result.last429) {
        const budget = this.getBackgroundBudget();
        if (!budget || !budget.observe429(result.last429, result.cooldownUntil ?? 0)) {
          this.backgroundBudgetUnsafe = true;
          return null;
        }
      }
      if(result.sessionId!==id || result.phase!=='idle' || !Array.isArray(result.messages) || (result.cooldownUntil||0)>Date.now())return null;
      freshVisit ||= result.freshVisit === true;
      if (result.messages.some(message => (message.role === 'user' || message.role === 'assistant')
        && (typeof message.id !== 'string' || !message.id || typeof message.text !== 'string' || !message.text.trim()))) return null;
      const messages=result.messages.filter(message=>(message.role==='user'||message.role==='assistant')
        && typeof message.id==='string' && !!message.id && typeof message.text==='string' && !!message.text.trim())
        .map(message=>({id:message.id as string,role:message.role as 'user'|'assistant',text:message.text as string,parts:[{type:'text' as const,text:message.text as string}]}));
      if (messages.at(-1)?.role !== 'assistant') return null;
      if (agreed && JSON.stringify(agreed) !== JSON.stringify(messages)) return null;
      agreed = messages;
    }
    return freshVisit ? agreed : null;
  }

  async visitBackgroundChat(id: string): Promise<void> {
    if (id.startsWith("draft:")) id = this.drafts.get(id)?.remoteId || "";
    if (!NATIVE_CHAT_ID.test(id)) return;
    const budget = this.getBackgroundBudget();
    if (!budget) return;
    if (!this.backgroundNavigator) {
      this.backgroundNavigator = new ChatGptBackgroundNavigator(this.tools, budget);
    }
    await this.backgroundNavigator.visit(id);
  }

  async getRawConversation(chatId: string): Promise<unknown | null> {
    if (chatId.startsWith("draft:")) {
      // Revalidate account ownership before resolving an admitted draft.
      if (!await this.getChat(chatId)) return null;
      const native = this.drafts.get(chatId)?.remoteId;
      if (!native) return null;
      chatId = native;
    }
    if (!NATIVE_CHAT_ID.test(chatId)) return null;
    const page = await this.page();
    const transferId = randomUUID();
    try {
      const result = parseChromeEvaluation<{ error?: string; transferId?: string; length?: number; chunkSize?: number }>(await this.tools.call("evaluate_script", { pageId: page.id, function: chatgptFullConversationApiScript(chatId, transferId) }));
      if (result.error || result.transferId !== transferId || !Number.isInteger(result.length) || !Number.isInteger(result.chunkSize) || result.length! < 2 || result.length! > 100 * 1024 * 1024 || result.chunkSize !== 65536) throw new Error("ChatGPT history unavailable: " + (result.error || "unexpected response"));
      const chunks: string[] = [];
      for (let offset = 0; offset < result.length!; offset += result.chunkSize!) {
        const chunk = parseChromeEvaluation<{ error?: string; offset?: number; text?: string }>(await this.tools.call("evaluate_script", { pageId: page.id, function: chatgptConversationChunkScript(transferId, offset, result.chunkSize!) }));
        if (chunk.error || chunk.offset !== offset || typeof chunk.text !== "string" || chunk.text.length !== Math.min(result.chunkSize!, result.length! - offset)) throw new Error("ChatGPT history transfer incomplete: " + (chunk.error || "invalid chunk"));
        chunks.push(chunk.text);
      }
      const data = JSON.parse(chunks.join("")) as { conversation_id?: string; mapping?: unknown };
      if (data.conversation_id !== chatId || !data.mapping || typeof data.mapping !== "object") throw new Error("ChatGPT history transfer identity mismatch");
      return data;
    } finally {
      await this.tools.call("evaluate_script", { pageId: page.id, function: chatgptConversationCleanupScript(transferId) }).catch(() => undefined);
    }
  }

  /** Authenticated read-only conversation API; never navigate to load history. */
  async getMessages(chatId: string): Promise<SessionMessageView[] | null> {
    if (chatId.startsWith("draft:")) {
      const draft = this.drafts.get(chatId);
      if (!draft) return null;
      if (!draft.remoteId) return [];
      chatId = draft.remoteId;
    }
    if (!NATIVE_CHAT_ID.test(chatId)) return null;
    const page = await this.page();
    const result = parseChromeEvaluation<{
      error?: string; trace?: unknown; messages?: Array<{ id: string; role: string; text: string;
        timestamp?: string; model?: string }>;
    }>(await this.tools.call("evaluate_script",
      { pageId: page.id, function: chatgptMessagesApiScript(chatId) }));
    this.requestTrace.ingestBrowserHttp(result.trace);
    this.feedBackoff(result.trace);
    if (result.error || !Array.isArray(result.messages)) {
      throw new Error("ChatGPT history unavailable: " + (result.error || "unexpected response"));
    }
    return result.messages.filter(message => ["user", "assistant"].includes(message.role) &&
      typeof message.text === "string" && typeof message.id === "string").map(message => ({
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
        const editor = document.querySelector('div[contenteditable="true"][role="textbox"][data-composer-markdown]');
        return { value: editor ? (editor.innerText || editor.textContent || "") : "" };
      }` }),
    );
    return result.value ?? "";
  }

  /** Restore the captured draft (or clear the composer when there was none).
   * Skipped silently when the composer is not editable mid-generation; ChatGPT
   * keeps its own per-conversation draft state in that case. */
  private async restoreComposerDraft(pageId: number, draft: string): Promise<void> {
    try {
      const snapshot = await this.tools.call("take_snapshot", { pageId });
      const uid = snapshot.match(/uid=([\w-]+) textbox "(?:Спросить ChatGPT|Ask ChatGPT|Ask anything|Message ChatGPT)"/i)?.[1];
      if (uid) await this.tools.call("fill", { pageId, uid, value: draft });
    } catch { /* composer not editable mid-generation */ }
  }

  async sendMessage(input: { chatId: string; text: string; waitForCompletion?: boolean }): Promise<{ assistantText?: string }> {
    return this.exclusive(async () => {
      let { chatId, text } = input;
      if (!text.trim() || text.length > MAX_MESSAGE) {
        throw new Error("Invalid ChatGPT conversation or message");
      }
      if (chatId.startsWith("draft:")) {
        // Revalidate account ownership before touching the remote account.
        const ownerPage=await this.page();
        this.accountScope=await verifyNewChatAccountScope(this.tools,"chatgpt",ownerPage.id);
        await this.drafts.useScope(this.accountScope);
        const draft = await this.drafts.startSend(chatId);
        if (draft.remoteId) {
          chatId = draft.remoteId;
        } else {
          const receipt = await submitFirstChatMessage(this.tools,"chatgpt",text,this.accountScope);
          if (!receipt.clicked) {
            await this.drafts.resetPreClick(chatId);
            throw new Error("ChatGPT first message not submitted: "+(receipt.reason||"unknown"));
          }
          if (!receipt.remoteId) {
            await this.drafts.markUncertain(chatId);
            throw new Error("ChatGPT submission outcome unknown: "+(receipt.reason||"no native route"));
          }
          await this.drafts.admit(chatId,receipt.remoteId);
          // This exact native route came from the tab we ourselves opened
          // and verified, not an untrusted guess from another chat's title.
          this.cache.set(receipt.remoteId, {
            id:receipt.remoteId,title:draft.title,unread:false,working:true,
            updatedAt:new Date().toISOString(),
            sourceRoute:ORIGIN+"/c/"+receipt.remoteId,
            updatedAtSemantics:"first-message-confirmed",
          });
          this.lastSubmittedAt = Date.now();
          return {};
        }
      }
      if (!NATIVE_CHAT_ID.test(chatId)) {
        throw new Error("Invalid ChatGPT conversation or message");
      }
      const known = this.cache.get(chatId) ?? (await this.listUnlocked()).find(c => c.id === chatId);
      if (!known) throw new Error("ChatGPT conversation absent from authenticated inventory");
      const page = await this.page();
      let state = await this.snapshot(page.id);
      // Never navigate away from an active turn, even when another chat is
      // requested or the current conversation uses a project-scoped route.
      if (state.phase === "generating" || Date.now() - this.lastSubmittedAt < POST_SEND_GUARD_MS) {
        throw new Error("prompt is already running; browser queue must wait");
      }
      // Unknown phase fails closed ONLY when the picked tab is already on the
      // target chat: navigation cannot recover a broken target. A different
      // conversation, the workspace dashboard, or any other authenticated
      // path in unknown state may still recover once we navigate to the
      // target chat — the post-navigate snapshot loop below either confirms
      // a ready composer or throws "target or idle state not confirmed".
      // Without this relaxation, one stuck tab on a stale conversation
      // blocked every chatgpt send (autotest: chatgpt-mac-cdp-driver.test.ts).
      if (state.phase === "unknown" && state.path === "/c/" + chatId) {
        throw new Error("ChatGPT composer unavailable; message not sent");
      }
      if (state.path !== "/c/" + chatId) {
        await this.tools.call("navigate_page", {
          pageId: page.id, type: "url", url: ORIGIN + "/c/" + chatId,
        });
      }
      let ready = false;
      for (let i = 0; i < 4; i++) {
        state = await this.snapshot(page.id);
        if (state.path === "/c/" + chatId && !this.busy(state) && state.composer) {
          ready = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      if (!ready) throw new Error("ChatGPT target or idle state not confirmed; message not sent");
      const accessibility = await this.tools.call("take_snapshot", { pageId: page.id });
      const textbox = accessibility.match(/uid=([\w-]+) textbox "(?:Спросить ChatGPT|Ask ChatGPT|Ask anything|Message ChatGPT)"/i)?.[1];
      if (!textbox) throw new Error("ChatGPT editor unavailable; message not sent");
      // Preserve any user draft across the herder's send and restore it after.
      const savedDraft = await this.readComposerDraft(page.id);
      try {
        await this.tools.call("fill", { pageId: page.id, uid: textbox, value: text });

      // A single browser-side check+click: Enter can accidentally stop a turn
      // if the UI transitions between the separate fill and submit RPCs.
      const submit = `async () => {
        await new Promise(resolve => setTimeout(resolve, 80));
        const expected = ${JSON.stringify(text)};
        const wantedPath = ${JSON.stringify("/c/" + chatId)};
        const editor = document.querySelector('div[contenteditable="true"][role="textbox"][data-composer-markdown]');
        const current = (editor?.innerText || editor?.textContent || '').trim();
        const visible = node => !!node && node.getClientRects().length > 0;
        const buttons = [...document.querySelectorAll('button')].filter(visible);
        const stop = buttons.some(button =>
          /^(Stop generating|Stop response|Остановить генерацию|Остановить ответ|Остановить)$/i.test(
            button.getAttribute('aria-label') || ''
          ) || button.getAttribute('data-testid') === 'stop-button'
        );
        if (stop) return {submitted:false,reason:'busy'};
        if (location.origin !== 'https://chatgpt.com' || location.pathname !== wantedPath)
          return {submitted:false,reason:'target_changed'};
        if (current !== expected) return {submitted:false,reason:'draft_changed'};
        const form = editor?.closest('form');
        const candidates = buttons.filter(button => form?.contains(button) && (
          button.type === 'submit' ||
          button.getAttribute('data-testid') === 'send-button' ||
          /^(Отправить сообщение|Send message|Send prompt)$/i.test(button.getAttribute('aria-label') || '')
        ));
        if (candidates.length !== 1 || candidates[0].disabled)
          return {submitted:false,reason:'send_not_ready'};
        candidates[0].click();
        return {submitted:true};
      }`;
      let receipt: { submitted: boolean; reason?: string };
      try {
        receipt = parseChromeEvaluation<{ submitted: boolean; reason?: string }>(
          await this.tools.call("evaluate_script", { pageId: page.id, function: submit }));
      } catch {
        throw new Error("ChatGPT submission outcome unknown: do not retry automatically");
      }
      if (!receipt.submitted) {
        if (receipt.reason === "busy") throw new Error("prompt is already running; browser queue must wait");
        throw new Error("ChatGPT submission rejected before click: " + (receipt.reason || "unknown"));
      }
      this.lastSubmittedAt = Date.now();
      return {};
      } finally {
        await this.restoreComposerDraft(page.id, savedDraft).catch(() => undefined);
      }
    });
  }

  /** Read the site's model menu, leaving an already-open human menu untouched. */
  async listModels(): Promise<string[]> {
    return this.exclusive(async () => {
      const page = await this.page();
      await this.snapshot(page.id);
      const models = parseChromeEvaluation<{ models: string[]; error?: string }>(
        await this.tools.call("evaluate_script", { pageId: page.id, function: `async () => {
          const buttons = [...document.querySelectorAll('button[aria-label="Выбрать модель ChatGPT"],button[aria-label="Select a ChatGPT model"]')]
            .filter(button => button.getClientRects().length > 0);
          if (buttons.length !== 1) return {models:[],error:'model_picker_unavailable'};
          const button = buttons[0];
          const alreadyOpen = button.getAttribute('data-state') === 'open';
          if (!alreadyOpen) button.click();
          try {
            await new Promise(resolve => setTimeout(resolve, 160));
            const options = [...document.querySelectorAll('[role="menuitemradio"]')]
              .filter(option => option.getClientRects().length > 0);
            return {models:[...new Set(options.map(option => (option.textContent || '').trim())
              .filter(label => label && label.length <= 100))]};
          } finally {
            if (!alreadyOpen && button.getAttribute('data-state') === 'open') button.click();
          }
        }` }),
      );
      if (models.error) throw new Error("ChatGPT model discovery failed: " + models.error);
      return models.models;
    });
  }

  supportsModelSwitch(): boolean { return true; }

  /** Model selection changes this *specific chat* only, not a global default.
   * The browser-side transaction verifies the exact route, idle state, model
   * item and checked state. An uncertain click is never retried.
   */
  async changeModel(input: { chatId: string; model: string }): Promise<{ ok: boolean; error?: string }> {
    return this.exclusive(async () => {
      const model=input.model;
      const chatId=this.drafts.get(input.chatId)?.remoteId ?? input.chatId;
      if (!NATIVE_CHAT_ID.test(chatId) || !model.trim() || model.length > 100) {
        return { ok: false, error: "Invalid ChatGPT chat ID or model name" };
      }
      const chat = this.cache.get(chatId) ?? (await this.listUnlocked()).find(item => item.id === chatId);
      if (!chat) return { ok: false, error: "ChatGPT chat not in authenticated inventory" };
      const page = await this.page();
      let state = await this.snapshot(page.id);
      if (this.busy(state)) return { ok: false, error: "ChatGPT model switch requires an idle chat without a personal draft" };
      if (state.path !== "/c/" + chatId) {
        await this.tools.call("navigate_page", { pageId: page.id, type: "url", url: ORIGIN + "/c/" + chatId });
        let selected = false;
        for (let i = 0; i < 5; i++) {
          state = await this.snapshot(page.id);
          if (state.path === "/c/" + chatId && !this.busy(state)) { selected = true; break; }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!selected) return { ok: false, error: "ChatGPT target model switch not verified" };
      }
      try {
        const result = parseChromeEvaluation<{ ok: boolean; reason?: string }>(
          await this.tools.call("evaluate_script", { pageId: page.id, function: `async () => {
            const model = ${JSON.stringify(model)};
            const chatPath = ${JSON.stringify("/c/" + chatId)};
            const visible = element => !!element && element.getClientRects().length > 0;
            const editor = document.querySelector('div[contenteditable="true"][role="textbox"][data-composer-markdown]');
            const stop = () => [...document.querySelectorAll('button')].some(button => visible(button)
              && (button.getAttribute('data-testid') === 'stop-button'
              || /^(Stop generating|Stop response|Остановить генерацию|Остановить ответ|Остановить)$/i.test(button.getAttribute('aria-label') || '')));
            const safe = () => location.origin === 'https://chatgpt.com' && location.pathname === chatPath
              && visible(editor) && !(editor.textContent || '').trim() && !stop();
            if (!safe()) return {ok:false,reason:'chat_not_idle_or_target_changed'};
            const buttons = [...document.querySelectorAll('button[aria-label="Выбрать модель ChatGPT"],button[aria-label="Select a ChatGPT model"]')].filter(visible);
            if (buttons.length !== 1) return {ok:false,reason:'model_picker_unavailable'};
            const button = buttons[0];
            const wasOpen = button.getAttribute('data-state') === 'open';
            if (!wasOpen) button.click();
            try {
              await new Promise(resolve => setTimeout(resolve, 160));
              const find = () => [...document.querySelectorAll('[role="menuitemradio"]')].filter(visible)
                .filter(option => (option.textContent || '').trim() === model);
              const options = find();
              if (options.length !== 1) return {ok:false,reason:'model_not_in_live_menu'};
              if (options[0].getAttribute('aria-checked') === 'true') return {ok:true};
              if (!safe()) return {ok:false,reason:'target_changed_before_model_click'};
              options[0].click();
              await new Promise(resolve => setTimeout(resolve, 200));
              if (!safe()) return {ok:false,reason:'post_click_target_unknown'};
              if (button.getAttribute('data-state') !== 'open') button.click();
              await new Promise(resolve => setTimeout(resolve, 160));
              return {ok:find().length === 1 && find()[0].getAttribute('aria-checked') === 'true',
                reason:'model_selection_readback_unconfirmed'};
            } finally {
              if (!wasOpen && button.getAttribute('data-state') === 'open') button.click();
            }
          }` }),
        );
        return result.ok ? { ok: true } :
          { ok: false, error: "ChatGPT model change not confirmed: " + (result.reason || "unknown") };
      } catch {
        return { ok: false, error: "ChatGPT model selection outcome unknown; do not retry automatically" };
      }
    });
  }

  /** Only Stop for the exact *currently selected and generating* conversation. */
  async stopTurn(chatId: string): Promise<{ stopped: boolean; error?: string }> {
    return this.exclusive(async () => {
      chatId=this.drafts.get(chatId)?.remoteId ?? chatId;
      if (!NATIVE_CHAT_ID.test(chatId)) return { stopped: false, error: "Invalid ChatGPT chat ID" };
      const page = await this.page();
      const state = await this.snapshot(page.id);
      if (state.path !== "/c/" + chatId) {
        return { stopped: false, error: "ChatGPT Stop requires the exact currently selected chat" };
      }
      if (state.phase !== "generating") return { stopped: false, error: "ChatGPT is not generating in that chat" };
      try {
        const receipt = parseChromeEvaluation<{ stopped: boolean; error?: string }>(
          await this.tools.call("evaluate_script", { pageId: page.id, function: `() => {
            if (location.origin !== 'https://chatgpt.com' || location.pathname !== ${JSON.stringify("/c/" + chatId)})
              return {stopped:false,error:'target_changed'};
            const stop = [...document.querySelectorAll('button')].filter(button => button.getClientRects().length > 0
              && !button.disabled && (button.getAttribute('data-testid') === 'stop-button'
              || /^(Stop generating|Stop response|Остановить генерацию|Остановить ответ|Остановить)$/i.test(button.getAttribute('aria-label') || '')));
            if (stop.length !== 1) return {stopped:false,error:'stop_control_not_unique'};
            stop[0].click();
            return {stopped:true};
          }` }),
        );
        return receipt;
      } catch {
        return { stopped: false, error: "ChatGPT Stop click outcome unknown; do not retry automatically" };
      }
    });
  }

}

// ---------------------------------------------------------------------------
// Modal-prompt classification + atomic click script builder. Patterns are
// anchored (^...$) so 'Allow' cannot match inside 'Allow all'. Two kinds
// are auto-answered: 'permission' clicks Allow; 'work_continue' clicks the
// 'stay in chat' button when ChatGPT proposes Continue in Work. 'unknown_modal'
// is reported but never clicked.
interface ChosenButton { label: string; patternId: string; }
interface ModalClassification { kind: ModalPromptKind; fingerprint: string; chosen: ChosenButton | null; reason?: string; }

const ALLOW_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/^Allow$/, "allow_exact"],
  [/^Allow once$/, "allow_once"],
  [/^Always allow$/, "always_allow"],
  [/^Approve$/, "approve"],
  [/^Approve access$/, "approve_access"],
  [/^Grant access$/, "grant_access"],
  [/^Continue$/, "continue"],
  [/^Continue anyway$/, "continue_anyway"],
  [/^Confirm$/, "confirm"],
  [/^Confirm access$/, "confirm_access"],
  [/^OK$/, "ok"],
  [/^Yes$/, "yes"],
  [/^Yes, allow$/, "yes_allow"],
  [/^Разрешить$/, "razreshit"],
  [/^Разрешить один раз$/, "razreshit_once"],
  [/^Всегда разрешять$/, "vsegda_allow"],
  [/^Одобрить$/, "odobrit"],
  [/^Одобрить доступ$/, "odobrit_access"],
  [/^Предоставить доступ$/, "grant_ru"],
  [/^Продолжить$/, "prodolzhit"],
  [/^Продолжить в любом случае$/, "prodolzhit_anyway"],
  [/^Подтвердить$/, "podtverdit"],
  [/^Подтвердить доступ$/, "podtverdit_access"],
  [/^ОК$/, "ok_ru"],
  [/^Да$/, "da"],
  [/^Да, разрешить$/, "da_allow"],
];

const WORK_STAY_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/^No, continue in chat$/, "no_continue_in_chat"],
  [/^Continue in chat$/, "continue_in_chat"],
  [/^Stay in chat$/, "stay_in_chat"],
  [/^No, stay here$/, "no_stay_here"],
  [/^Not now, keep in chat$/, "not_now_keep_in_chat"],
  [/^Not now$/, "not_now"],
  [/^Нет, продолжить в чате$/, "net_prodolzhit_v_chate"],
  [/^Продолжить в чате$/, "prodolzhit_v_chate"],
  [/^Остаться в чате$/, "ostatsya_v_chate"],
  [/^Нет, остаться здесь$/, "net_ostatsya_zdes"],
  [/^Не сейчас, остаться в чате$/, "ne_seychas_ostatsya"],
  [/^Не сейчас$/, "ne_seychas"],
];

const WORK_OPEN_PATTERNS: ReadonlyArray<RegExp> = [
  /^Continue in Work$/i, /^Open in Work$/i, /^Open in Workspaces$/i,
  /^Try in Work$/i, /^Switch to Work$/i, /^Continue in Workspaces$/i,
  /^Продолжить в Work$/i, /^Открыть в Work$/i,
  /^Открыть в рабочих пространствах$/i, /^Перейти в Work$/i,
  /^Продолжить в рабочих пространствах$/i,
];

function matchFirst(label: string, patterns: ReadonlyArray<[RegExp, string]>): ChosenButton | null {
  for (const [pat, patternId] of patterns) { if (pat.test(label)) return { label, patternId }; }
  return null;
}

function anyMatch(label: string, patterns: ReadonlyArray<RegExp>): boolean {
  for (const pat of patterns) if (pat.test(label)) return true;
  return false;
}

function classifyModalPrompt(prompt: ModalPrompt): ModalClassification {
  const fingerprintSeed = prompt.role + "|" + prompt.title.slice(0, 80);
  let hash = 0;
  for (let i = 0; i < fingerprintSeed.length; i++) {
    hash = ((hash << 5) - hash + fingerprintSeed.charCodeAt(i)) | 0;
  }
  const fingerprint = "cgmodal_" + (hash >>> 0).toString(16).padStart(8, "0");
  const labels = prompt.buttons.map(b => b.label).filter(Boolean);
  const hasWorkOpen = labels.some(l => anyMatch(l, WORK_OPEN_PATTERNS));
  const workStay = labels.map(l => matchFirst(l, WORK_STAY_PATTERNS)).find((x): x is ChosenButton => x !== null) ?? null;
  if (hasWorkOpen || workStay) {
    return { kind: "work_continue", fingerprint, chosen: workStay, reason: workStay ? undefined : "no_stay_button" };
  }
  const allow = labels.map(l => matchFirst(l, ALLOW_PATTERNS)).find((x): x is ChosenButton => x !== null) ?? null;
  if (allow) return { kind: "permission", fingerprint, chosen: allow };
  return { kind: "unknown_modal", fingerprint, chosen: null, reason: "no_matching_button" };
}

/** Atomic evaluate_script that re-locates the chosen button inside the
 * dialog root by exact aria-label or textContent and only then clicks. */
function buildPromptClickScript(prompt: ModalPrompt, chosen: ChosenButton): string {
  const label = JSON.stringify(chosen.label);
  const titleSeed = JSON.stringify(prompt.title.slice(0, 80));
  return `() => {
    const wantedLabel = ${label};
    const wantedTitle = ${titleSeed};
    const visible = node => !!node && node.getClientRects().length > 0;
    const modalRoots = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"]')].filter(visible);
    if (!modalRoots.length) return {clicked:false,reason:'no_modal_present'};
    const matchRoot = modalRoots.find(root => {
      const name = (root.getAttribute('aria-label') || '').trim();
      if (name && name === wantedTitle) return true;
      const heading = root.querySelector('h1,h2,h3,[role="heading"]');
      const ht = heading ? (heading.textContent || '').trim() : '';
      return ht && ht === wantedTitle;
    }) || modalRoots[0];
    const buttons = [...matchRoot.querySelectorAll('button')].filter(visible).filter(b => !b.disabled);
    const match = buttons.find(b => {
      const aria = (b.getAttribute('aria-label') || '').trim();
      const text = (b.textContent || '').trim();
      return aria === wantedLabel || text === wantedLabel;
    });
    if (!match) return {clicked:false,reason:'button_not_found',label:wantedLabel};
    let p = match; let inModal = false;
    while (p) {
      const role = p.getAttribute && p.getAttribute('role');
      const modal = p.getAttribute && p.getAttribute('aria-modal');
      if (role === 'dialog' || role === 'alertdialog' || modal === 'true') { inModal = true; break; }
      p = p.parentElement;
    }
    if (!inModal) return {clicked:false,reason:'button_left_modal'};
    match.click();
    return {clicked:true,label:match.getAttribute('aria-label') || match.textContent || ''};
  }`;
}

/** One built-in authenticated ChatGPT instance on the existing Mac mini CDP owner. */
export async function createBrowserChatDriver(): Promise<BrowserChatDriver> {
  const raw = process.env.AGENT_HERDER_CHATGPT_PAGE_ID?.trim();
  const pageId = raw ? Number(raw) : undefined;
  if (raw && (!Number.isSafeInteger(pageId) || !pageId || pageId < 1)) {
    throw new Error("Invalid AGENT_HERDER_CHATGPT_PAGE_ID");
  }
  const driver = new ChatGptMacCdpDriver(new MacMiniChromeTransport(), pageId);
  if (process.env.AGENT_HERDER_CHATGPT_PROMPT_POLLING?.trim().toLowerCase() !== "off") {
    const intervalRaw = Number(process.env.AGENT_HERDER_CHATGPT_PROMPT_POLL_INTERVAL_MS);
    const intervalMs = Number.isFinite(intervalRaw) && intervalRaw > 0
      ? Math.min(60_000, Math.max(2_000, Math.round(intervalRaw)))
      : undefined;
    driver.startPromptPolling({ intervalMs });
  }
  return driver;
}
