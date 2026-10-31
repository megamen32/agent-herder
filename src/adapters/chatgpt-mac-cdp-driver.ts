import type { BrowserChat, BrowserChatDriver } from "./browser-chat.js";
import { MacMiniChromeTransport, parseChromeEvaluation, type ChromePageTools } from "./mac-mini-chrome-transport.js";

const ORIGIN = "https://chatgpt.com";
const MAX_MESSAGE = 16_000;
const POST_SEND_GUARD_MS = 1_800;
const NATIVE_CHAT_ID = /^[a-f0-9]{8}-[a-f0-9-]{20,75}$/i;
type Phase = "idle" | "generating" | "unknown";
type Page = { id: number; url: string };
type Snapshot = {
  origin: string; path: string; authenticated: boolean; composer: boolean;
  phase: Phase; draftPresent: boolean;
  chats: Array<{ id: string; title: string }>;
};

export function parseChatGptPages(text: string): Page[] {
  return text.split("\n").flatMap(line => {
    const match = line.match(/^\s*(\d+):.*?\((https:\/\/chatgpt\.com(?:\/[^)]*)?)\)/);
    if (!match) return [];
    try {
      const url = new URL(match[2]!);
      return url.origin === ORIGIN ? [{ id: Number(match[1]), url: url.toString() }] : [];
    } catch { return []; }
  });
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
 * A single pinned/unique tab is required; no fallback to the other provider.
 */
export class ChatGptMacCdpDriver implements BrowserChatDriver {
  private readonly cache = new Map<string, BrowserChat>();
  private operation: Promise<void> = Promise.resolve();
  private lastSubmittedAt = 0;

  constructor(private readonly tools: ChromePageTools, private readonly pinnedPageId?: number) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const op = this.operation.then(fn);
    this.operation = op.then(() => undefined, () => undefined);
    return op;
  }

  private async page(): Promise<Page> {
    const pages = parseChatGptPages(await this.tools.call("list_pages"));
    if (this.pinnedPageId !== undefined) {
      const page = pages.find(p => p.id === this.pinnedPageId);
      if (!page) throw new Error("Pinned ChatGPT tab unavailable; no other tab selected");
      return page;
    }
    if (pages.length !== 1) throw new Error(pages.length
      ? "Multiple ChatGPT tabs; pin AGENT_HERDER_CHATGPT_PAGE_ID"
      : "No ChatGPT tab in Mac mini Chrome");
    return pages[0]!;
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

  private toChat(id: string, title: string, s: Snapshot): BrowserChat {
    const selected = s.path === "/c/" + id;
    return {
      id, title, updatedAt: new Date().toISOString(),
      working: selected ? this.busy(s) : s.phase !== "idle",
      unread: false, updatedAtSemantics: "observed-sidebar-order",
      sourceRoute: ORIGIN + "/c/" + id,
    };
  }

  private async listUnlocked(): Promise<BrowserChat[]> {
    const page = await this.page();
    const s = await this.snapshot(page.id);
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

  async getChat(id: string): Promise<BrowserChat | null> {
    return this.exclusive(async () => {
      if (!NATIVE_CHAT_ID.test(id)) return null;
      return (await this.listUnlocked()).find(c => c.id === id) ?? null;
    });
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
