import type { BrowserChat, BrowserChatDriver } from "./browser-chat.js";
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
type BrowserPage = { id: number; url: string };

const ZAI_ORIGIN = "https://chat.z.ai";
const MAX_MESSAGE_CHARS = 16_000;
const ROUTE_PATTERN = /^\/c\/[a-f0-9-]{12,80}$/i;
const POST_SEND_GUARD_MS = 1_800;

/** Extract only tab IDs and exact ZAI origins from the shared Chrome owner's page list. */
export function parseZaiPages(text: string): BrowserPage[] {
  return text.split("\n").flatMap(line => {
    const match = line.match(/^\s*(\d+):.*?\((https:\/\/chat\.z\.ai(?:\/[^)]*)?)\)/);
    if (!match) return [];
    try {
      const url = new URL(match[2]!);
      return url.origin === ZAI_ORIGIN ? [{ id: Number(match[1]), url: url.toString() }] : [];
    } catch { return []; }
  });
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
  private readonly cache = new Map<string, BrowserChat>();
  private operation: Promise<void> = Promise.resolve();
  private lastSubmittedAt = 0;

  constructor(private readonly tools: ChromePageTools, private readonly pinnedPageId?: number) {}

  private exclusive<T>(callback: () => Promise<T>): Promise<T> {
    const result = this.operation.then(callback);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  private async page(): Promise<BrowserPage> {
    const pages = parseZaiPages(await this.tools.call("list_pages"));
    if (this.pinnedPageId !== undefined) {
      const match = pages.find(page => page.id === this.pinnedPageId);
      if (!match) throw new Error("Pinned ZAI Chrome tab no longer exists; no fallback to another tab");
      return match;
    }
    if (pages.length !== 1) throw new Error(
      pages.length ? "Ambiguous ZAI Chrome tabs; pin AGENT_HERDER_ZAI_PAGE_ID" : "No ZAI tab open in Mac mini Chrome",
    );
    return pages[0]!;
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
    return state.phase !== "idle" || state.draftPresent ||
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

  private async listUnlocked(): Promise<BrowserChat[]> {
    const page = await this.page();
    const state = await this.snapshot(page.id);
    const observedAt = new Date().toISOString();
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
      result.push(chat);
    }
    // The current chat may be open but missing from the bounded sidebar.
    if (ROUTE_PATTERN.test(state.path) && (!state.selectedTitle || counts.get(state.selectedTitle) !== 1)) {
      result.unshift({
        ...this.recordChat("route:" + state.path.slice(3),
          state.selectedTitle || "ZAI conversation", observedAt, state.path),
        working: this.busy(state),
      });
    }
    for (const chat of result) this.cache.set(chat.id, chat);
    return result;
  }

  async listChats(): Promise<readonly BrowserChat[]> {
    return this.exclusive(() => this.listUnlocked());
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
      await this.tools.call("navigate_page", { pageId, type: "url", url: ZAI_ORIGIN + route });
      return "selected";
    }
    return "missing";
  }

  private async confirmTarget(pageId: number, id: string, known: BrowserChat): Promise<ZaiSnapshot> {
    for (let i = 0; i < 4; i++) {
      const state = await this.snapshot(pageId);
      if (this.isSelected(id, known, state)) return state;
    }
    throw new Error("ZAI conversation identity not confirmed; message not sent");
  }

  async getChat(id: string): Promise<BrowserChat | null> {
    return this.exclusive(async () => {
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
      }
      if (!known) return null;
      if (id.startsWith("sidebar:") && state.titles.filter(entry => entry === known.title).length !== 1) {
        return null; // Deleted/renamed or now ambiguous.
      }
      if (!this.isSelected(id, known, state)) {
        // Never leave a currently generating conversation to inspect another.
        if (this.busy(state)) return { ...known, working: true };
        const selected = await this.selectChat(page.id, id, known);
        if (selected === "busy") return { ...known, working: true };
        if (selected === "missing") return null;
        state = await this.confirmTarget(page.id, id, known);
      }
      return { ...known, working: this.busy(state) };
    });
  }

  async sendMessage(input: { chatId: string; text: string; waitForCompletion?: boolean }): Promise<{ assistantText?: string }> {
    return this.exclusive(async () => {
      const { chatId, text } = input;
      if (!text.trim() || text.length > MAX_MESSAGE_CHARS) throw new Error("Invalid ZAI message size");
      const known = this.cache.get(chatId) ?? (await this.listUnlocked()).find(chat => chat.id === chatId);
      if (!known) throw new Error("ZAI chat is not in the authenticated browser inventory");
      const page = await this.page();
      let state = await this.snapshot(page.id);
      if (this.busy(state)) {
        if (state.phase === "generating" || Date.now() - this.lastSubmittedAt < POST_SEND_GUARD_MS) {
          throw new Error("prompt is already running; ZAI queue must wait");
        }
        throw new Error("ZAI composer is unavailable or has an existing draft; message not sent");
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
