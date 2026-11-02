#!/usr/bin/env python3
"""Anchored, idempotent patcher: browser chat drivers auto-discover their tab.

ChatGPT and Z.ai Mac mini CDP drivers no longer depend on a hard page-ID pin
or on a unique matching tab:
  * parseZaiPages/parseChatGptPages capture the "[selected]" marker
  * pickZaiPage/pickChatGptPage: selected tab first, else the lowest page ID
  * zero matching tabs -> the driver opens one via new_page; the tool's own
    navigation-timeout error is tolerated (the re-listed inventory is truth)
  * a stale explicit pin falls back to auto-detection instead of failing
  * optional constructor arg openWaitMs (default 5s) keeps tests fast

Run from the repo root on roomhacker-server-100. Aborts cleanly on any
missing/non-unique anchor; timestamped .bak-autofind-<UTC> copies per file.
"""
from __future__ import annotations

import datetime as _dt
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent if str(Path(__file__).resolve().parent).endswith("scripts") else Path.cwd()
if (ROOT / "src" / "adapters").is_dir():
    REPO = ROOT
else:
    REPO = Path("/home/roomhacker/agents-projects/agent-herder")

STAMP = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
BACKUP_SUFFIX = f".bak-autofind-{STAMP}"

ZAI = "src/adapters/zai-cdp-driver.ts"
CGP = "src/adapters/chatgpt-mac-cdp-driver.ts"
ZT = "tests/zai-cdp-driver.test.ts"
CT = "tests/chatgpt-mac-cdp-driver.test.ts"

# ---------------------------------------------------------------- zai driver
ZAI_TYPE_OLD = r'type BrowserPage = { id: number; url: string };'
ZAI_TYPE_NEW = r'export type BrowserPage = { id: number; url: string; selected?: boolean };'

ZAI_PARSE_OLD = r'''export function parseZaiPages(text: string): BrowserPage[] {
  return text.split("\n").flatMap(line => {
    const match = line.match(/^\s*(\d+):.*?\((https:\/\/chat\.z\.ai(?:\/[^)]*)?)\)/);
    if (!match) return [];
    try {
      const url = new URL(match[2]!);
      return url.origin === ZAI_ORIGIN ? [{ id: Number(match[1]), url: url.toString() }] : [];
    } catch { return []; }
  });
}'''
ZAI_PARSE_NEW = r'''export function parseZaiPages(text: string): BrowserPage[] {
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
}'''

CTOR_OLD = '  constructor(private readonly tools: ChromePageTools, private readonly pinnedPageId?: number) {}'
CTOR_NEW = '  constructor(private readonly tools: ChromePageTools, private readonly pinnedPageId?: number, private readonly openWaitMs = 5_000) {}'

ZAI_PAGE_OLD = r'''  private async page(): Promise<BrowserPage> {
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
  }'''
ZAI_PAGE_NEW = r'''  /** Auto-detect the ZAI tab; open one when none exists. A stale explicit
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
  }'''

# --------------------------------------------------------- chatgpt driver
CGP_TYPE_OLD = r'type Page = { id: number; url: string };'
CGP_TYPE_NEW = r'export type Page = { id: number; url: string; selected?: boolean };'

CGP_PARSE_OLD = r'''export function parseChatGptPages(text: string): Page[] {
  return text.split("\n").flatMap(line => {
    const match = line.match(/^\s*(\d+):.*?\((https:\/\/chatgpt\.com(?:\/[^)]*)?)\)/);
    if (!match) return [];
    try {
      const url = new URL(match[2]!);
      return url.origin === ORIGIN && !/^\/dots(?:\/|$)/.test(url.pathname) ? [{ id: Number(match[1]), url: url.toString() }] : [];
    } catch { return []; }
  });
}'''
CGP_PARSE_NEW = r'''export function parseChatGptPages(text: string): Page[] {
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
}'''

CGP_DOC_OLD = ' * A single pinned/unique tab is required; no fallback to the other provider.'
CGP_DOC_NEW = (' * The tab is auto-discovered (selected tab, else the lowest page ID) or opened\n'
               ' * on demand; there is never a fallback to the other provider\'s tab.')

CGP_PAGE_OLD = r'''  private async page(): Promise<Page> {
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
  }'''
CGP_PAGE_NEW = r'''  /** Auto-detect the ChatGPT tab; open one when none exists. A stale explicit
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
  }'''

# ---------------------------------------------------------------- zai tests
ZT_IMPORT_OLD = 'import { ZaiCdpDriver, ZAI_ACTIVITY_SCRIPT, parseZaiPages } from "../src/adapters/zai-cdp-driver.js";'
ZT_IMPORT_NEW = 'import { ZaiCdpDriver, ZAI_ACTIVITY_SCRIPT, parseZaiPages, pickZaiPage } from "../src/adapters/zai-cdp-driver.js";'

ZT_REFUSE_TITLE_OLD = '  it("refuses unknown UI, drafts, duplicates, unexpected origins, and wrong tab IDs", async () => {'
ZT_REFUSE_TITLE_NEW = '  it("refuses unknown UI, drafts, and unexpected origins; a stale pin falls back", async () => {'

ZT_PIN_OLD = '    await expect(new ZaiCdpDriver(duplicate, 99).listChats()).rejects.toThrow(/Pinned/);'
ZT_PIN_NEW = '    // A stale pin falls back to auto-detection instead of failing.\n    await expect(new ZaiCdpDriver(duplicate, 99).listChats()).resolves.toHaveLength(0);'

ZT_APPEND = r'''

describe("ZAI tab auto-discovery", () => {
  it("captures the selected marker; the selected tab wins, then the lowest ID", () => {
    const pages = parseZaiPages("3: Z.ai (https://chat.z.ai/)\n5: Z.ai (https://chat.z.ai/) [selected]");
    expect(pages).toEqual([
      { id: 3, url: "https://chat.z.ai/" },
      { id: 5, url: "https://chat.z.ai/", selected: true },
    ]);
    expect(pickZaiPage(pages).id).toBe(5);
    expect(pickZaiPage(parseZaiPages("9: Z.ai (https://chat.z.ai/)\n4: Z.ai (https://chat.z.ai/)")).id).toBe(4);
  });
  it("opens a ZAI tab when none exists and tolerates the tool navigation timeout", async () => {
    let opened = 0;
    const tools: ChromePageTools = {
      call: async (name, args = {}) => {
        if (name === "list_pages") return opened
          ? "5: Z.ai (https://chat.z.ai/) [selected]\n1: ChatGPT (https://chatgpt.com/)"
          : "1: ChatGPT (https://chatgpt.com/)";
        if (name === "new_page") {
          opened += 1;
          expect(args.url).toBe("https://chat.z.ai/");
          throw Error("Error: Navigation timeout of 10000 ms exceeded");
        }
        if (name === "evaluate_script") return evalJson(state("/", ["Auto chat"], "Auto chat"));
        throw Error("unexpected tool: " + name);
      },
    };
    const driver = new ZaiCdpDriver(tools, undefined, 0);
    expect(await driver.listChats()).toMatchObject([{ id: "sidebar:Auto%20chat", title: "Auto chat" }]);
    expect(opened).toBe(1);
  });
});
'''

# ---------------------------------------------------------- chatgpt tests
CT_IMPORT_OLD = 'import { CHATGPT_MAC_SNAPSHOT, ChatGptMacCdpDriver, parseChatGptPages } from "../src/adapters/chatgpt-mac-cdp-driver.js";'
CT_IMPORT_NEW = 'import { CHATGPT_MAC_SNAPSHOT, ChatGptMacCdpDriver, parseChatGptPages, pickChatGptPage } from "../src/adapters/chatgpt-mac-cdp-driver.js";'

CT_DOT_TITLE_OLD = ' it("excludes dot routes even when the pinned numeric page points there", async () => {'
CT_DOT_TITLE_NEW = ' it("falls back to auto-detection when the pinned numeric page is a dot route", async () => {'

CT_DOT_TOOLS_OLD = '''  const actions:string[]=[];
  const tools:ChromePageTools={call:async(name:string)=>{actions.push(name);if(name==="list_pages")return listing;throw Error("must not touch dot");}};'''
CT_DOT_TOOLS_NEW = '''  const pageIds:number[]=[];
  const tools:ChromePageTools={call:async(name:string,args:Record<string,unknown>={})=>{
    if(name==="list_pages")return listing;
    if(name==="evaluate_script"){pageIds.push(Number(args.pageId));return json({origin:"https://chatgpt.com",path:"/c/"+ID,authenticated:true,composer:true,phase:"generating",draftPresent:false,chats:[{id:ID,title:"Fixture chat"}]});}
    throw Error("must not touch dot");
  }};'''

CT_DOT_EXPECT_OLD = '''  await expect(driver.sendMessage({chatId:ID,text:"must not send"})).rejects.toThrow(/Pinned ChatGPT tab unavailable/);
  expect(actions).toEqual(["list_pages"]);'''
CT_DOT_EXPECT_NEW = '''  await expect(driver.sendMessage({chatId:ID,text:"must not send"})).rejects.toThrow(/already running/);
  expect(pageIds.length).toBeGreaterThan(0);
  expect(pageIds.every(id=>id===7)).toBe(true);'''

CT_APPEND = r'''

describe("ChatGPT tab auto-discovery", () => {
  it("captures the selected marker; the selected tab wins, then the lowest ID", () => {
    const pages = parseChatGptPages("2: ChatGPT (https://chatgpt.com/)\n4: ChatGPT (https://chatgpt.com/c/" + ID + ") [selected]");
    expect(pages).toEqual([
      { id: 2, url: "https://chatgpt.com/" },
      { id: 4, url: "https://chatgpt.com/c/" + ID, selected: true },
    ]);
    expect(pickChatGptPage(pages).id).toBe(4);
    expect(pickChatGptPage(parseChatGptPages("9: ChatGPT (https://chatgpt.com/)\n4: ChatGPT (https://chatgpt.com/)")).id).toBe(4);
  });
  it("opens a ChatGPT tab when none exists and tolerates the tool navigation timeout", async () => {
    let opened = 0;
    const tools: ChromePageTools = {
      call: async (name, args = {}) => {
        if (name === "list_pages") return opened
          ? "2: ChatGPT (https://chatgpt.com/) [selected]\n3: ZAI (https://chat.z.ai/)"
          : "3: ZAI (https://chat.z.ai/)";
        if (name === "new_page") {
          opened += 1;
          expect(args.url).toBe("https://chatgpt.com/");
          throw Error("Error: Navigation timeout of 10000 ms exceeded");
        }
        if (name === "evaluate_script") return json({
          origin: "https://chatgpt.com", path: "/c/" + ID, authenticated: true, composer: true,
          phase: "idle", draftPresent: false, chats: [{ id: ID, title: "Auto chat" }],
        });
        throw Error("unexpected tool: " + name);
      },
    };
    const driver = new ChatGptMacCdpDriver(tools, undefined, 0);
    expect(await driver.listChats()).toMatchObject([{ id: ID, title: "Auto chat" }]);
    expect(opened).toBe(1);
  });
});
'''

REPLACEMENTS: dict[str, list[tuple[str, str, str]]] = {
    ZAI: [
        (ZAI_TYPE_OLD, ZAI_TYPE_NEW, "zai BrowserPage type"),
        (ZAI_PARSE_OLD, ZAI_PARSE_NEW, "zai parseZaiPages + pickZaiPage"),
        (CTOR_OLD, CTOR_NEW, "zai constructor openWaitMs"),
        (ZAI_PAGE_OLD, ZAI_PAGE_NEW, "zai page() auto-discovery"),
    ],
    CGP: [
        (CGP_TYPE_OLD, CGP_TYPE_NEW, "chatgpt Page type"),
        (CGP_PARSE_OLD, CGP_PARSE_NEW, "chatgpt parseChatGptPages + pickChatGptPage"),
        (CGP_DOC_OLD, CGP_DOC_NEW, "chatgpt class doc comment"),
        (CTOR_OLD, CTOR_NEW, "chatgpt constructor openWaitMs"),
        (CGP_PAGE_OLD, CGP_PAGE_NEW, "chatgpt page() auto-discovery"),
    ],
    ZT: [
        (ZT_IMPORT_OLD, ZT_IMPORT_NEW, "zai test import pickZaiPage"),
        (ZT_REFUSE_TITLE_OLD, ZT_REFUSE_TITLE_NEW, "zai test refuse-case title"),
        (ZT_PIN_OLD, ZT_PIN_NEW, "zai test stale pin falls back"),
    ],
    CT: [
        (CT_IMPORT_OLD, CT_IMPORT_NEW, "chatgpt test import pickChatGptPage"),
        (CT_DOT_TITLE_OLD, CT_DOT_TITLE_NEW, "chatgpt dot test title"),
        (CT_DOT_TOOLS_OLD, CT_DOT_TOOLS_NEW, "chatgpt dot test tools mock"),
        (CT_DOT_EXPECT_OLD, CT_DOT_EXPECT_NEW, "chatgpt dot test expectations"),
    ],
}

APPENDS: dict[str, tuple[str, str]] = {
    ZT: ("ZAI tab auto-discovery", ZT_APPEND),
    CT: ("ChatGPT tab auto-discovery", CT_APPEND),
}


def main() -> int:
    problems: list[str] = []
    contents: dict[str, str] = {}
    for rel in REPLACEMENTS:
        path = REPO / rel
        if not path.is_file():
            problems.append(f"missing file {rel}")
            continue
        text = path.read_text(encoding="utf-8")
        contents[rel] = text
        for old, new, name in REPLACEMENTS[rel]:
            count = text.count(old)
            if text.count(new) and text.count(old) == 0:
                print(f"[skip] {rel}: {name} already applied")
                continue
            if count != 1:
                problems.append(f"{rel}: anchor for '{name}' found {count}, expected 1")
    for rel, (marker, block) in APPENDS.items():
        text = contents.get(rel, "")
        if marker in text:
            print(f"[skip] {rel}: append '{marker}' already present")
            APPENDS[rel] = (marker, "")
    if problems:
        print("ABORT: anchors failed verification:")
        for p in problems:
            print("  -", p)
        return 1

    changed: list[str] = []
    for rel, pairs in REPLACEMENTS.items():
        text = contents[rel]
        before = text
        for old, new, name in pairs:
            if old in text:
                text = text.replace(old, new, 1)
                print(f"[ok] {rel}: {name}")
        marker, block = APPENDS.get(rel, ("", ""))
        if block:
            if not text.endswith("\n"):
                text += "\n"
            text += block
            print(f"[ok] {rel}: appended '{marker}' tests")
        if text != before:
            src = REPO / rel
            backup = REPO / (rel + BACKUP_SUFFIX)
            backup.write_text(before, encoding="utf-8")
            src.write_text(text, encoding="utf-8")
            changed.append(rel)
            print(f"[write] {rel} (backup {backup.name})")

    print()
    print("SUMMARY:", "changed " + ", ".join(changed) if changed else "nothing to do (idempotent no-op)")
    print("BACKUP SUFFIX:", BACKUP_SUFFIX)
    return 0


if __name__ == "__main__":
    sys.exit(main())
