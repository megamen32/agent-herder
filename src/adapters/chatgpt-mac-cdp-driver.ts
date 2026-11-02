import type { BrowserChat, BrowserChatDriver } from "./browser-chat.js";
import type { SessionMessageView } from "../types/index.js";
import { CHATGPT_LIST_API_SCRIPT, chatgptMessagesApiScript } from "./browser-chat-api-scripts.js";
import { MacMiniChromeTransport, parseChromeEvaluation, type ChromePageTools } from "./mac-mini-chrome-transport.js";

const ORIGIN = "https://chatgpt.com";
const MAX_MESSAGE = 16_000;
const POST_SEND_GUARD_MS = 1_800;
const NATIVE_CHAT_ID = /^[a-f0-9]{8}-[a-f0-9-]{20,75}$/i;
type Phase = "idle" | "generating" | "unknown";
export type Page = { id: number; url: string; selected?: boolean };
type Snapshot = {
  origin: string; path: string; authenticated: boolean; composer: boolean;
  phase: Phase; draftPresent: boolean;
  chats: Array<{ id: string; title: string }>;
};

export function parseChatGptPages(text: string): Page[] {
  return text.split("\n").flatMap(line => {
    const match = line.match(/^\s*(\d+):.*?\((https:\/\/chatgpt\.com(?:\/[^)]*)?)\)(\s*\[selected\])?/);
    if (!match) return [];
    try {
      const url = new URL(match[2]!);
      return url.origin === ORIGIN && !/^\/dots(?:\/|$)/.test(url.pathname)
        ? [{ id: Number(match[1]), url: url.toString(), ...(match[3] ? { selected: true } : {}) }] : [];
    } catch { return []; }
  });
}

/** Deterministic pick among open ChatGPT tabs: the selected tab first, then the lowest page ID. */
export function pickChatGptPage(pages: Page[]): Page {
  return pages.find(page => page.selected) ?? [...pages].sort((a, b) => a.id - b.id)[0]!;
}

/** A read-only page snapshot, using the live ChatGPT sidebar's native /c/ URLs.
 * This code never reads message bodies, cookies, JWTs or private drafts.
 */
export const CHATGPT_MAC_SNAPSHOT = `() => {
  const route = /^\\/c\\/([a-f0-9-]{28,80})$/i;
  const links = [...document.querySelectorAll('a[data-interactive-row-link][href^="/c/"]')];
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
  return {
    origin:location.origin,path:location.pathname,
    authenticated:!!document.querySelector('button[aria-label="Открыть меню профиля"],button[aria-label="Open profile menu"]'),
    composer:visible(editor),
    phase:stop?'generating':(visible(editor)&&voice?'idle':'unknown'),
    draftPresent:!!(editor?.textContent||'').trim(),
    chats:chats.slice(0,300),
  };
}`;

/** ChatGPT browser site, sharing Mac mini's established CDP owner with ZAI.
 * The tab is auto-discovered (selected tab, else the lowest page ID) or opened
 * on demand; there is never a fallback to the other provider's tab.
 */
export class ChatGptMacCdpDriver implements BrowserChatDriver {
  readonly browserFeatures = {
    nativeConversationIds: true,
    queueAfterGeneration: true,
    chatCreation: false,
    accountArchiveViaCdp: true,
  } as const;
  private readonly cache = new Map<string, BrowserChat>();
  private operation: Promise<void> = Promise.resolve();
  private lastSubmittedAt = 0;
  private accountScope: string | undefined;
  getAccountScope(): string | undefined { return this.accountScope; }


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
    if (pinned) return pinned;
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
    const result = parseChromeEvaluation<Snapshot>(
      await this.tools.call("evaluate_script", { pageId, function: CHATGPT_MAC_SNAPSHOT }));
    if (result.origin !== ORIGIN || !result.authenticated || !result.composer ||
      !["idle", "generating", "unknown"].includes(result.phase)) {
      throw new Error("ChatGPT Mac mini tab is not an authenticated chat page");
    }
    return result;
  }

  private busy(s: Snapshot): boolean {
    return s.phase !== "idle" || s.draftPresent ||
      Date.now() - this.lastSubmittedAt < POST_SEND_GUARD_MS;
  }

  private toChat(id: string, title: string, s: Snapshot, at?: number): BrowserChat {
    const selected = s.path === "/c/" + id;
    return {
      id, title, updatedAt: typeof at === "number" && at > 0
        ? new Date(at < 1e12 ? at * 1000 : at).toISOString() : new Date().toISOString(),
      working: selected && this.busy(s),
      stopVisible: selected && s.phase === "generating",
      unread: false, updatedAtSemantics: typeof at === "number" && Number.isFinite(at) && at > 0 ? "remote-update-time" : "observed-sidebar-order",
      sourceRoute: ORIGIN + "/c/" + id,
    };
  }

  private async listUnlocked(): Promise<BrowserChat[]> {
    const page = await this.page();
    const s = await this.snapshot(page.id);
    // The real authenticated list API returns 100 native IDs immediately.
    // It does not navigate or change the user's selected chat.
    try {
      const data = parseChromeEvaluation<{
        scope?: string; error?: string;
        chats?: Array<{ id: string; title: string; updatedAt?: number }>;
      }>(await this.tools.call("evaluate_script", { pageId: page.id, function: CHATGPT_LIST_API_SCRIPT }));
      if (data.scope && /^[a-f0-9]{64}$/.test(data.scope) && Array.isArray(data.chats)) {
        this.accountScope = data.scope;
        const seen = new Set<string>();
        const chats: BrowserChat[] = [];
        for (const entry of data.chats) {
          if (!NATIVE_CHAT_ID.test(entry.id) || seen.has(entry.id) || !entry.title) continue;
          seen.add(entry.id);
          chats.push(this.toChat(entry.id, entry.title, s, entry.updatedAt));
        }
        const selected = s.path.match(/^\/c\/([a-f0-9-]{28,80})$/i)?.[1];
        if (selected && NATIVE_CHAT_ID.test(selected) && !seen.has(selected)) {
          chats.unshift(this.toChat(selected, this.cache.get(selected)?.title || "ChatGPT conversation", s));
        }
        for (const chat of chats) this.cache.set(chat.id, chat);
        return chats;
      }
    } catch { /* The site may change its private API; retain the DOM fallback. */ }
    this.accountScope = undefined;
    const seen = new Set<string>();
    const chats: BrowserChat[] = [];
    for (const { id, title } of s.chats) {
      if (!NATIVE_CHAT_ID.test(id) || seen.has(id)) continue;
      seen.add(id);
      chats.push(this.toChat(id, title, s));
    }
    const current = s.path.match(/^\/c\/([a-f0-9-]{28,80})$/i)?.[1];
    if (current && NATIVE_CHAT_ID.test(current) && !seen.has(current)) {
      const oldTitle = this.cache.get(current)?.title;
      chats.unshift(this.toChat(current, oldTitle || "ChatGPT conversation", s));
    }
    for (const chat of chats) this.cache.set(chat.id, chat);
    return chats;
  }

  async listChats(): Promise<readonly BrowserChat[]> {
    return this.exclusive(() => this.listUnlocked());
  }

  getKnownChat(id: string): BrowserChat | null {
    if (!NATIVE_CHAT_ID.test(id)) return null;
    return this.cache.get(id) ?? {
      id, title: "ChatGPT conversation", working: false, stopVisible: false,
      unread: false, updatedAt: new Date(0).toISOString(),
      sourceRoute: ORIGIN + "/c/" + id,
      updatedAtSemantics: "deep-link-unverified",
    };
  }

  async getChat(id: string): Promise<BrowserChat | null> {
    return this.exclusive(async () => {
      if (!NATIVE_CHAT_ID.test(id)) return null;
      return (await this.listUnlocked()).find(c => c.id === id) ?? null;
    });
  }

  /** Authenticated read-only conversation API; never navigate to load history. */
  async getMessages(chatId: string): Promise<SessionMessageView[] | null> {
    if (!NATIVE_CHAT_ID.test(chatId)) return null;
    const page = await this.page();
    const result = parseChromeEvaluation<{
      error?: string; messages?: Array<{ id: string; role: string; text: string;
        timestamp?: string; model?: string }>;
    }>(await this.tools.call("evaluate_script",
      { pageId: page.id, function: chatgptMessagesApiScript(chatId) }));
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

  async sendMessage(input: { chatId: string; text: string; waitForCompletion?: boolean }): Promise<{ assistantText?: string }> {
    return this.exclusive(async () => {
      const { chatId, text } = input;
      if (!NATIVE_CHAT_ID.test(chatId) || !text.trim() || text.length > MAX_MESSAGE) {
        throw new Error("Invalid ChatGPT conversation or message");
      }
      const known = this.cache.get(chatId) ?? (await this.listUnlocked()).find(c => c.id === chatId);
      if (!known) throw new Error("ChatGPT conversation absent from authenticated inventory");
      const page = await this.page();
      let state = await this.snapshot(page.id);
      if (this.busy(state)) {
        if (state.phase === "generating" || Date.now() - this.lastSubmittedAt < POST_SEND_GUARD_MS) {
          throw new Error("prompt is already running; browser queue must wait");
        }
        throw new Error("ChatGPT composer unavailable or has a personal draft; message not sent");
      }
      if (state.path !== "/c/" + chatId) {
        await this.tools.call("navigate_page", {
          pageId: page.id, type: "url", url: ORIGIN + "/c/" + chatId,
        });
      }
      let ready = false;
      for (let i = 0; i < 4; i++) {
        state = await this.snapshot(page.id);
        if (state.path === "/c/" + chatId && !this.busy(state)) {
          ready = true;
          break;
        }
      }
      if (!ready) throw new Error("ChatGPT target or idle state not confirmed; message not sent");
      const accessibility = await this.tools.call("take_snapshot", { pageId: page.id });
      const textbox = accessibility.match(/uid=([\w-]+) textbox "(?:Спросить ChatGPT|Ask ChatGPT|Ask anything|Message ChatGPT)"/i)?.[1];
      if (!textbox) throw new Error("ChatGPT editor unavailable; message not sent");
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
      const { chatId, model } = input;
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

/** One built-in authenticated ChatGPT instance on the existing Mac mini CDP owner. */
export async function createBrowserChatDriver(): Promise<BrowserChatDriver> {
  const raw = process.env.AGENT_HERDER_CHATGPT_PAGE_ID?.trim();
  const pageId = raw ? Number(raw) : undefined;
  if (raw && (!Number.isSafeInteger(pageId) || !pageId || pageId < 1)) {
    throw new Error("Invalid AGENT_HERDER_CHATGPT_PAGE_ID");
  }
  return new ChatGptMacCdpDriver(new MacMiniChromeTransport(), pageId);
}
