import type { BrowserChat, BrowserChatDriver } from "./browser-chat.js";
import { MacMiniChromeTransport, parseChromeEvaluation, type ChromePageTools } from "./mac-mini-chrome-transport.js";

type ZaiSnapshot = {
  origin: string;
  path: string;
  loggedIn: boolean;
  selectedTitle?: string;
  titles: string[];
  composer: boolean;
};
type BrowserPage = { id: number; url: string };

const ZAI_ORIGIN = "https://chat.z.ai";
const MAX_MESSAGE_CHARS = 16_000;
const ROUTE_PATTERN = /^\/c\/[a-f0-9-]{12,80}$/i;

/** Extract only tab IDs and origins from the shared Chrome owner's page list. */
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

const LIST_SCRIPT = `() => {
  const buttons = [...document.querySelectorAll('button[data-selected]')];
  const titles = buttons.map(button => button.querySelector('div[dir="auto"]')?.textContent?.trim()
    || button.textContent?.trim() || '').filter(Boolean);
  const selected = buttons.find(button => button.getAttribute('data-selected') === 'true');
  return {
    origin: location.origin, path: location.pathname,
    loggedIn: !!document.querySelector('#chat-group-tab-zai-web'),
    titles: titles.slice(0, 300),
    selectedTitle: selected?.querySelector('div[dir="auto"]')?.textContent?.trim()
      || selected?.textContent?.trim() || undefined,
    composer: !!document.querySelector('textarea[placeholder="Send a Message"]'),
  };
}`;

export class ZaiCdpDriver implements BrowserChatDriver {
  private readonly cache = new Map<string, BrowserChat>();
  private operation: Promise<void> = Promise.resolve();

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
      await this.tools.call("evaluate_script", { pageId, function: LIST_SCRIPT }),
    );
    if (data.origin !== ZAI_ORIGIN || !data.loggedIn || !data.composer) {
      throw new Error("ZAI Chrome tab is not a logged-in chat page; sign in in Mac mini Chrome");
    }
    return data;
  }

  private async listUnlocked(): Promise<BrowserChat[]> {
    const page = await this.page();
    const snapshot = await this.snapshot(page.id);
    const observedAt = new Date().toISOString();
    const counts = new Map<string, number>();
    for (const title of snapshot.titles) counts.set(title, (counts.get(title) || 0) + 1);
    const result: BrowserChat[] = [];
    for (const title of snapshot.titles) {
      // Duplicate titles cannot be safely selected by name.
      if (counts.get(title) !== 1 || title === "New Chat") continue;
      const selected = title === snapshot.selectedTitle && ROUTE_PATTERN.test(snapshot.path);
      const id = selected ? "route:" + snapshot.path.slice(3) : "sidebar:" + encodeURIComponent(title);
      result.push({
        id, title, unread: false, working: false, updatedAt: observedAt,
        ...(selected ? { sourceRoute: ZAI_ORIGIN + snapshot.path } : {}),
        updatedAtSemantics: "observed-sidebar-order",
      });
    }
    // Current chat can be open even when its title is not visible in the sidebar.
    if (ROUTE_PATTERN.test(snapshot.path) && !result.some(c => c.id === "route:" + snapshot.path.slice(3))) {
      result.unshift({
        id: "route:" + snapshot.path.slice(3), title: snapshot.selectedTitle || "ZAI conversation",
        unread: false, working: false, updatedAt: observedAt,
        sourceRoute: ZAI_ORIGIN + snapshot.path, updatedAtSemantics: "observed-page",
      });
    }
    for (const chat of result) this.cache.set(chat.id, chat);
    return result;
  }

  async listChats(): Promise<readonly BrowserChat[]> {
    return this.exclusive(() => this.listUnlocked());
  }

  async getChat(id: string): Promise<BrowserChat | null> {
    return this.exclusive(async () => {
      if (this.cache.has(id)) return this.cache.get(id)!;
      return (await this.listUnlocked()).find(chat => chat.id === id) ?? null;
    });
  }

  async sendMessage(input: { chatId: string; text: string; waitForCompletion?: boolean }): Promise<{ assistantText?: string }> {
    return this.exclusive(async () => {
      const { chatId, text } = input;
      if (!text.trim() || text.length > MAX_MESSAGE_CHARS) throw new Error("Invalid ZAI message size");
      const known = this.cache.get(chatId) ?? (await this.listUnlocked()).find(chat => chat.id === chatId);
      if (!known) throw new Error("ZAI chat is not in the authenticated browser inventory");
      const page = await this.page();
      if (chatId.startsWith("sidebar:")) {
        const title = parseTitleId(chatId);
        if (title !== known.title) throw new Error("ZAI chat title changed: refusing to guess");
        const selection = parseChromeEvaluation<{ selected: boolean }>(
          await this.tools.call("evaluate_script", { pageId: page.id, function: `() => {
            const title = ${JSON.stringify(title)};
            const matches = [...document.querySelectorAll('button[data-selected]')].filter(
              button => (button.querySelector('div[dir="auto"]')?.textContent?.trim()
                || button.textContent?.trim() || '') === title
            );
            if (matches.length !== 1) return {selected: false};
            matches[0].click(); return {selected: true};
          }` }),
        );
        if (!selection.selected) throw new Error("ZAI sidebar title is missing or ambiguous");
      } else if (chatId.startsWith("route:")) {
        const route = "/c/" + chatId.slice(6);
        if (!ROUTE_PATTERN.test(route)) throw new Error("Invalid ZAI chat route");
        await this.tools.call("navigate_page", { pageId: page.id, type: "url", url: ZAI_ORIGIN + route });
      } else {
        throw new Error("Unknown ZAI conversation ID");
      }
      // Prove navigation before writing. A stale title, redirect, or missing
      // composer must fail closed, never create a different conversation.
      let ready = false;
      for (let i = 0; i < 3; i++) {
        const state = await this.snapshot(page.id);
        if (ROUTE_PATTERN.test(state.path) && (chatId.startsWith("route:")
          ? state.path === "/c/" + chatId.slice(6) : state.selectedTitle === known.title)) {
          ready = true; break;
        }
      }
      if (!ready) throw new Error("ZAI conversation identity not confirmed; message not sent");
      const snapshot = await this.tools.call("take_snapshot", { pageId: page.id });
      const uid = snapshot.match(/uid=([\w-]+) textbox "Send a Message"/)?.[1];
      if (!uid) throw new Error("ZAI message composer not found; message not sent");
      await this.tools.call("fill", { pageId: page.id, uid, value: text });
      try {
        await this.tools.call("press_key", { pageId: page.id, key: "Enter" });
      } catch {
        throw new Error("ZAI submission outcome unknown: do not automatically retry");
      }
      const remaining = parseChromeEvaluation<{ text: string }>(
        await this.tools.call("evaluate_script", {
          pageId: page.id,
          function: ` () => ({text: document.querySelector('textarea[placeholder="Send a Message"]')?.value || ''})`,
        }),
      );
      if (remaining.text === text) throw new Error("ZAI send not confirmed; do not automatically retry");
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
