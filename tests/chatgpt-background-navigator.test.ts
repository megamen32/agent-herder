import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ChatGptBackgroundBudget } from "../src/adapters/chatgpt-background-budget.js";
import { ChatGptBackgroundNavigator, backgroundChatClickScript } from "../src/adapters/chatgpt-background-navigator.js";
import { runInNewContext } from "node:vm";

const json = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
const id = "6aa7e444-0ba4-83ed-992f-d2afaa3159e8";

it("reserves opening and every click, uses only its own tab, and respects observed 429", async () => {
  const root = mkdtempSync(join(tmpdir(), "herder-background-nav-"));
  try {
    let now = 1_000_000; let opened = false; let cooldown = 0; const actions: string[] = [];
    const tools = { call: async (name: string, args: Record<string, unknown> = {}) => {
      actions.push(name);
      if (name === "list_pages") return `1: User (https://chatgpt.com/c/${id})` + (opened ? "\n9: Herder (https://chatgpt.com/)" : "");
      if (name === "new_page") { expect(args.background).toBe(true); opened = true; return "ok"; }
      expect(args.pageId).toBe(9);
      if (String(args.function).includes("__herderBackgroundOwner =")) return json({ owned: true });
      if (String(args.function).includes("__herderPassiveHistoryHook")) return json({ cooldownUntil: cooldown, last429: cooldown ? "429-1" : "" });
      if (String(args.function).includes("link.click()")) return json({ clicked: true });
      throw Error("unexpected browser operation");
    } };
    const budget = new ChatGptBackgroundBudget(join(root, "budget"), () => now);
    const nav = new ChatGptBackgroundNavigator(tools, budget);
    expect(await nav.visit(id)).toBe("created");
    expect(await nav.visit(id)).toBe("waiting");
    now += 300_000; cooldown = now + 600_000;
    expect(await nav.visit(id)).toBe("waiting");
    expect(actions.filter(a => a === "new_page")).toHaveLength(1);
    now += 600_000;
    expect(await nav.visit(id)).toBe("clicked");
    expect(await nav.visit(id)).toBe("waiting");
    expect(actions.filter(a => a === "new_page")).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("clicks only one exact link in its own idle page with no draft", () => {
  let clicks = 0; let draft = ""; let running = false;
  const link = { href: `https://chatgpt.com/c/${id}`, click: () => { clicks++; } };
  const context: any = { URL, location: { origin: "https://chatgpt.com" }, __herderBackgroundOwner: "owned",
    document: { querySelector: (selector: string) => selector.includes("contenteditable") ? { textContent: draft } : (running ? {} : null),
      querySelectorAll: () => [link] } }; context.globalThis = context;
  const click = runInNewContext(`(${backgroundChatClickScript(id, "owned")})`, context);
  draft = "unfinished"; expect(click().clicked).toBe(false);
  draft = ""; running = true; expect(click().clicked).toBe(false);
  running = false; context.__herderBackgroundOwner = "other"; expect(click().clicked).toBe(false);
  context.__herderBackgroundOwner = "owned"; expect(click().clicked).toBe(true); expect(clicks).toBe(1);
});
