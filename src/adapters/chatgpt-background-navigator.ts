import { randomUUID } from "node:crypto";
import type { ChromePageTools } from "./mac-mini-chrome-transport.js";
import { parseChromeEvaluation } from "./mac-mini-chrome-transport.js";
import { chatgptPassiveHistoryScript } from "./chatgpt-passive-history.js";
import { ChatGptBackgroundBudget } from "./chatgpt-background-budget.js";

const CHAT_ID = /^[a-f0-9]{8}-[a-f0-9-]{20,75}$/i;
function pageIds(list: string): number[] {
  return list.split("\n").flatMap(line => {
    const m = line.match(/^\s*(\d+):.*?\(https:\/\/chatgpt\.com(?:\/[^)]*)?\)/);
    return m ? [Number(m[1])] : [];
  });
}

export function backgroundChatClickScript(id: string, owner: string): string {
  return `() => {
    if(location.origin!=='https://chatgpt.com'||globalThis.__herderBackgroundOwner!==${JSON.stringify(owner)})return {clicked:false};
    const editor=document.querySelector('[contenteditable="true"][role="textbox"]');
    if((editor?.textContent||'').trim()||document.querySelector('[data-testid="stop-button"]'))return {clicked:false};
    const wanted=${JSON.stringify(id)};
    const links=[...document.querySelectorAll('a[data-interactive-row-link][href]')].filter(a=>{
      try { const u=new URL(a.href,location.origin);return u.origin===location.origin && (u.pathname==='/c/'+wanted||u.pathname.endsWith('/c/'+wanted)); } catch { return false; }
    });
    if(links.length!==1)return {clicked:false};
    globalThis.__herderBackgroundVisit={id:wanted,at:Date.now()};
    const link=links[0];link.click();return {clicked:true};
  }`;
}

/** Only navigates a tab this instance created and marked; never borrows a user's tab. */
export class ChatGptBackgroundNavigator {
  private pageId?: number;
  private readonly owner = randomUUID();
  private failed = false;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly tools: ChromePageTools, private readonly budget: ChatGptBackgroundBudget) {}

  visit(id: string): Promise<"created" | "waiting" | "clicked" | "unavailable"> {
    const op = this.tail.then(() => this.visitUnlocked(id));
    this.tail = op.catch(() => undefined);
    return op;
  }

  private async visitUnlocked(id: string): Promise<"created" | "waiting" | "clicked" | "unavailable"> {
    if (!CHAT_ID.test(id) || this.failed) return "unavailable";
    try {
      const before = pageIds(await this.tools.call("list_pages"));
      if (this.pageId === undefined) {
        if (!this.budget.reserve()) return "waiting";
        // An uncertain creation is never replayed by this instance.
        this.failed = true;
        await this.tools.call("new_page", { url: "https://chatgpt.com/", background: true });
        const after = pageIds(await this.tools.call("list_pages"));
        const added = after.filter(page => !before.includes(page));
        if (added.length !== 1) return "unavailable";
        const pageId = added[0]!;
        const receipt = parseChromeEvaluation<{ owned?: boolean }>(await this.tools.call("evaluate_script", {
          pageId, function: `() => { if(location.origin!=='https://chatgpt.com')return {owned:false}; globalThis.__herderBackgroundOwner = ${JSON.stringify(this.owner)}; return {owned:true}; }`,
        }));
        if (!receipt.owned) return "unavailable";
        this.pageId = pageId;
        await this.tools.call("evaluate_script", { pageId, function: chatgptPassiveHistoryScript() });
        this.failed = false;
        return "created";
      }
      if (!before.includes(this.pageId)) { this.failed = true; return "unavailable"; }
      const observation = parseChromeEvaluation<{ cooldownUntil?: number; last429?: string }>(await this.tools.call("evaluate_script", {
        pageId: this.pageId, function: chatgptPassiveHistoryScript(),
      }));
      if (observation.last429 && !this.budget.observe429(observation.last429, observation.cooldownUntil ?? 0)) return "unavailable";
      if (!this.budget.reserve()) return "waiting";
      const script = backgroundChatClickScript(id, this.owner);
      const receipt = parseChromeEvaluation<{ clicked?: boolean }>(await this.tools.call("evaluate_script", { pageId: this.pageId, function: script }));
      return receipt.clicked ? "clicked" : "unavailable";
    } catch { this.failed = true; return "unavailable"; }
  }
}
