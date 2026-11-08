import { CHATGPT_LIST_API_SCRIPT, CHATGPT_LIST_API_PASSIVE_SCRIPT } from "../src/adapters/browser-chat-api-scripts.js";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { runInNewContext } from "node:vm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHATGPT_MAC_SNAPSHOT, ChatGptMacCdpDriver, parseChatGptPages, pickChatGptPage } from "../src/adapters/chatgpt-mac-cdp-driver.js";
import { parseChromeEvaluation, type ChromePageTools } from "../src/adapters/mac-mini-chrome-transport.js";
import { CHATGPT_CREATE_SCOPE_SCRIPT } from "../src/adapters/browser-chat-new-page.js";
import { BrowserChatDraftStore } from "../src/adapters/browser-chat-drafts.js";
// The driver now owns a durable inventory cache; every test keeps its own
// private root so nothing ever touches the state directory of the host.
let _invDir: string;
beforeEach(() => { _invDir = mkdtempSync(join(tmpdir(), "chatgpt-inv-")); process.env.AGENT_HERDER_BROWSER_CHAT_INVENTORY_ROOT = _invDir; });
afterEach(() => { rmSync(_invDir, { recursive: true, force: true }); delete process.env.AGENT_HERDER_BROWSER_CHAT_INVENTORY_ROOT; });

const ID = "6ada477c-7014-83ed-82ae-7881dbe3e109";
const json = (x: unknown) => "Script ran on page and returned:\n```json\n" + JSON.stringify(x) + "\n```";
class BrowserFixture implements ChromePageTools {
  readonly actions: string[] = [];
  phase: "idle" | "generating" | "unknown" = "idle";
  path = "/c/" + ID;
  draft = false;
  async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    this.actions.push(name);
    if (name === "list_pages") return "7: ChatGPT (https://chatgpt.com/c/" + ID + ")\n11: ZAI (https://chat.z.ai/)";
    if (name === "evaluate_script") {
      return json({
        origin: "https://chatgpt.com", path: this.path, authenticated: true, composer: true,
        phase: this.phase, draftPresent: this.draft,
        chats: [{ id: ID, title: "Fixture chat" }],
      });
    }
    throw new Error("Unexpected browser write in read-only test: " + name);
  }
}
describe("ChatGPT on existing Mac mini CDP", () => {
  it("retains explicitly verified account scope with a fresh inventory and no passive hook", async () => {
    const scope = "a".repeat(64);
    const tools: ChromePageTools = { call: async (name, args = {}) => {
      if (name === "list_pages") return `7: ChatGPT (https://chatgpt.com/c/${ID})`;
      if (name === "evaluate_script" && args.function === CHATGPT_CREATE_SCOPE_SCRIPT) return json({ scope });
      if (name === "evaluate_script" && args.function === CHATGPT_MAC_SNAPSHOT) return json({
        origin: "https://chatgpt.com", path: "/c/" + ID, authenticated: true,
        composer: true, phase: "idle", draftPresent: false, chats: [],
      });
      if (name === "evaluate_script" && args.function === CHATGPT_LIST_API_PASSIVE_SCRIPT) return json({ scope: "", chats: [], source: "passive" });
      throw new Error(`unexpected action ${name}`);
    } };
    const driver = new ChatGptMacCdpDriver(tools, 7, 0, scope);
    expect(driver.getAccountScope()).toBeUndefined();
    await driver.verifyPinnedAccountScope();
    expect(driver.getAccountScope()).toBe(scope);
    await expect(driver.listObservedChats()).resolves.toBeDefined();
  });

  it("does not cache a mismatched account during explicit verification", async () => {
    const tools: ChromePageTools = { call: async (name, args = {}) => {
      if (name === "list_pages") return `7: ChatGPT (https://chatgpt.com/c/${ID})`;
      if (name === "evaluate_script" && args.function === CHATGPT_CREATE_SCOPE_SCRIPT) return json({ scope: "b".repeat(64) });
      throw new Error(`unexpected action ${name}`);
    } };
    const driver = new ChatGptMacCdpDriver(tools, 7, 0, "a".repeat(64));
    await expect(driver.verifyPinnedAccountScope()).rejects.toThrow("pinned account scope mismatch");
    expect(driver.getAccountScope()).toBeUndefined();
  });

  it("rejects list data from an account that differs from the pinned account", async () => {
    const actions: string[] = [];
    const tools: ChromePageTools = { call: async (name, args = {}) => {
      actions.push(name);
      if (name === "list_pages") return `7: ChatGPT (https://chatgpt.com/c/${ID})`;
      if (name === "evaluate_script" && args.function === CHATGPT_CREATE_SCOPE_SCRIPT) return json({ scope: "a".repeat(64) });
      if (name === "evaluate_script" && args.function === CHATGPT_MAC_SNAPSHOT) return json({
        origin: "https://chatgpt.com", path: "/c/" + ID, authenticated: true,
        composer: true, phase: "idle", draftPresent: false, chats: [],
      });
      if (name === "evaluate_script" && args.function === CHATGPT_LIST_API_SCRIPT) return json({
        scope: "b".repeat(64), chats: [{ id: ID, title: "Other account" }],
      });
      throw new Error(`unexpected tool ${name}`);
    } };
    const driver = new ChatGptMacCdpDriver(tools, 7, 0, "a".repeat(64));
    await expect(driver.listChats()).rejects.toThrow("pinned account scope mismatch");
    expect(actions).toContain("evaluate_script");
  });

  it("rejects message data returned by the provider under a different account", async () => {
    let scopeReads = 0;
    const tools: ChromePageTools = { call: async (name, args = {}) => {
      if (name === "list_pages") return `7: ChatGPT (https://chatgpt.com/c/${ID})`;
      if (name === "evaluate_script" && args.function === CHATGPT_CREATE_SCOPE_SCRIPT) {
        return json({ scope: ++scopeReads === 1 ? "a".repeat(64) : "b".repeat(64) });
      }
      if (name === "evaluate_script" && String(args.function).includes("conversation_read")) {
        return json({ messages: [{ id: "m1", role: "assistant", text: "other account" }] });
      }
      throw new Error(`unexpected tool ${name}`);
    } };
    const driver = new ChatGptMacCdpDriver(tools, 7, 0, "a".repeat(64));
    await expect(driver.getMessages(ID)).rejects.toThrow("pinned account scope mismatch");
  });

  it("returns a read when the provider response is from the pinned account", async () => {
    let scopeReads = 0;
    const tools: ChromePageTools = { call: async (name, args = {}) => {
      if (name === "list_pages") return `7: ChatGPT (https://chatgpt.com/c/${ID})`;
      if (name === "evaluate_script" && args.function === CHATGPT_CREATE_SCOPE_SCRIPT) {
        scopeReads += 1;
        return json({ scope: "a".repeat(64) });
      }
      if (name === "evaluate_script" && String(args.function).includes("conversation_read")) {
        return json({ messages: [{ id: "m1", role: "assistant", text: "same account" }] });
      }
      throw new Error(`unexpected tool ${name}`);
    } };
    const driver = new ChatGptMacCdpDriver(tools, 7, 0, "a".repeat(64));
    await expect(driver.getMessages(ID)).resolves.toMatchObject([{ id: "m1", text: "same account" }]);
    expect(scopeReads).toBe(2);
  });

  it("rejects draft creation when the site account changes from the pinned scope", async () => {
    const actions: string[] = [];
    const tools: ChromePageTools = { call: async (name, args = {}) => {
      actions.push(name);
      if (name === "list_pages") return `7: ChatGPT (https://chatgpt.com/c/${ID})`;
      if (name === "evaluate_script" && args.function === CHATGPT_CREATE_SCOPE_SCRIPT) return json({ scope: "b".repeat(64) });
      throw new Error(`unexpected action ${name}`);
    } };
    const Driver = ChatGptMacCdpDriver as unknown as new (
      tools: ChromePageTools, pinnedPageId?: number, openWaitMs?: number, expectedScope?: string,
    ) => ChatGptMacCdpDriver;
    const driver = new Driver(tools, 7, 0, "a".repeat(64));
    await expect(driver.createChat({ title: "must not be created" })).rejects.toThrow("pinned account scope mismatch");
    // Resolve the surviving page marker, then verify the account. Both are reads.
    expect(actions).toEqual(["list_pages", "evaluate_script", "evaluate_script"]);
  });

  it("parses only the official ChatGPT origin", () => {
    expect(parseChatGptPages(
      "7: ChatGPT (https://chatgpt.com/c/" + ID + ")\n"
      + "8: impostor (https://chatgpt.com.evil.invalid/c/" + ID + ")\n"
      + "9: ZAI (https://chat.z.ai/)"))
      .toEqual([{ id: 7, url: "https://chatgpt.com/c/" + ID, conversation: true }]);
  });
  it("reads verified native route IDs without sending or touching ZAI", async () => {
    const f = new BrowserFixture();
    const driver = new ChatGptMacCdpDriver(f);
    expect(await driver.listChats()).toMatchObject([{ id: ID, title: "Fixture chat", working: false }]);
    expect(await driver.getChat(ID)).toMatchObject({ id: ID, working: false });
    expect(f.actions.every(a => ["list_pages","evaluate_script"].includes(a))).toBe(true);
    expect(await driver.getChat("6ada477c-7014-83ed-82ae-7881dbe3e999")).toBeNull();
  });
  it("will not write while generating or unknown; a draft is preserved", async () => {
    const f = new BrowserFixture();
    const driver = new ChatGptMacCdpDriver(f);
    await driver.listChats();
    f.phase = "generating";
    expect((await driver.getChat(ID))?.working).toBe(true);
    await expect(driver.sendMessage({ chatId: ID, text: "hold" })).rejects.toThrow(/already running/);
    f.phase = "unknown";
    await expect(driver.sendMessage({ chatId: ID, text: "hold" })).rejects.toThrow(/unavailable/);
    // A user draft no longer blocks the herder's send (preserved + restored);
    // the dedicated preservation test below covers the save/restore sequence.
    expect(f.actions.every(a => ["list_pages","evaluate_script"].includes(a))).toBe(true);
  });
  it.each([
    ["/c/123e4567-e89b-42d3-a456-426614174000", "generating", false],
    ["/g/g-p-123e4567-e89b-42d3-a456-426614174000/c/" + ID, "generating", false],
    ["/dots/home", "unknown", true],
    ["/c/123e4567-e89b-42d3-a456-426614174000", "idle", true],
  ] as const)("does not navigate a busy or recently submitted tab from %s", async (path, phase, cooldown) => {
    const fixture = new BrowserFixture();
    const driver = new ChatGptMacCdpDriver(fixture);
    await driver.listChats();
    fixture.path = path;
    fixture.phase = phase;
    if (cooldown) Object.defineProperty(driver, "lastSubmittedAt", { value: Date.now(), writable: true });
    await expect(driver.sendMessage({ chatId: ID, text: "hold" })).rejects.toThrow(/already running/);
    expect(fixture.actions.every(action => ["list_pages", "evaluate_script"].includes(action))).toBe(true);
  });
  it("navigates to recover when another conversation is in unknown state", async () => {
    // Regression: a stale tab on a different conversation in phase=unknown used
    // to throw "composer unavailable" without trying to navigate, which blocked
    // every chatgpt send when the picked tab was stuck. The fix: navigate to
    // the target chat and let the post-navigate snapshot loop decide.
    const initialPath = "/c/123e4567-e89b-42d3-a456-426614174000";
    const navs: string[] = [];
    let navigated = false;
    const tools: ChromePageTools = {
      call: async (name, args = {}) => {
        if (name === "list_pages") return "6: ChatGPT (https://chatgpt.com" + initialPath + ")";
        if (name === "navigate_page") { navigated = true; navs.push(String(args.url)); return "ok"; }
        if (name === "take_snapshot") return 'uid=1_7 textbox "Спросить ChatGPT"';
        if (name === "fill") return "ok";
        if (name === "evaluate_script") {
          const fn = String(args.function);
          if (fn === CHATGPT_LIST_API_SCRIPT) return json({ scope: "a".repeat(64), chats: [{ id: ID, title: "Workspace chat" }] });
          if (fn.includes("editor.innerText")) return json({ value: "" });
          if (fn.includes("const expected")) return json({ submitted: true });
          // Before navigation: phase=unknown on a different conversation.
          // After navigation: phase=idle on the target chat, composer present.
          const path = navigated ? "/c/" + ID : initialPath;
          return json({ origin: "https://chatgpt.com", path, authenticated: true, composer: navigated,
            phase: navigated ? "idle" : "unknown", draftPresent: false,
            chats: navigated ? [{ id: ID, title: "Workspace chat" }] : [] });
        }
        throw Error("unexpected tool: " + name);
      },
    };
    const driver = new ChatGptMacCdpDriver(tools, undefined, 0);
    await driver.sendMessage({ chatId: ID, text: "recover and send" });
    expect(navs).toEqual(["https://chatgpt.com/c/" + ID]);
  });
  it("still refuses to send when the target chat itself is in unknown state", async () => {
    // On the target chat in unknown phase, navigation cannot recover: we are
    // already where we need to be and the composer is still missing. This is
    // the one case where "unknown" still fails closed.
    const fixture = new BrowserFixture();
    const driver = new ChatGptMacCdpDriver(fixture);
    await driver.listChats();
    // fixture.path defaults to "/c/" + ID (the target chat)
    fixture.phase = "unknown";
    await expect(driver.sendMessage({ chatId: ID, text: "hold" })).rejects.toThrow(/unavailable/);
    expect(fixture.actions.every(action => ["list_pages", "evaluate_script"].includes(action))).toBe(true);
  });

  it("keeps a chat marked working for the TTL grace window after the tab navigates away", async () => {
    // Regression: when the herder borrows the only ChatGPT tab to deliver a
    // continuation to another chat, the adapter used to lose the running
    // state of the chat that was generating (the site's async_status is not
    // a reliable signal — /backend-api/conversations often returns an empty
    // items list). The browser-turn-observer then never saw the running->idle
    // transition of the original chat, so the autopilot's Stop consumer (and
    // with it the /pilot command path) never fired.
    //
    // The fix: remember every chat we last saw generating on its own tab,
    // keep it marked working for RECENTLY_GENERATING_TTL_MS (5 min), and
    // clear it the next time its own tab returns and reports phase=idle.
    const OTHER = "6ada477c-7014-83ed-82ae-7881dbe3e110";
    let path = "/c/" + ID;
    let phase: "idle" | "generating" | "unknown" = "generating";
    const tools: ChromePageTools = {
      call: async (name, args = {}) => {
        if (name === "list_pages") return "6: ChatGPT (https://chatgpt.com" + path + ")";
        if (name === "evaluate_script") {
          const fn = String(args.function);
          if (fn === CHATGPT_LIST_API_SCRIPT) {
            // The site returns an empty items list — the regression scenario.
            // The inventory cache supplies both chats from its durable cache.
            return json({ scope: "a".repeat(64), chats: [
              { id: ID, title: "Target chat", updatedAt: 1730000000, asyncStatus: 0 },
              { id: OTHER, title: "Other chat", updatedAt: 1730000001, asyncStatus: 0 },
            ] });
          }
          return json({ origin: "https://chatgpt.com", path, authenticated: true,
            composer: phase === "idle", phase, draftPresent: false,
            chats: path === "/c/" + ID ? [{ id: ID, title: "Target chat" }] : [{ id: OTHER, title: "Other chat" }] });
        }
        throw Error("unexpected tool: " + name);
      },
    };
    const driver = new ChatGptMacCdpDriver(tools, undefined, 0);

    // First poll: tab on /c/<ID> with phase=generating -> ID is working.
    let chats = await driver.listChats();
    expect(chats.find(c => c.id === ID)).toMatchObject({ working: true });
    expect(chats.find(c => c.id === ID)?.workingSource).toBeUndefined(); // selected+generating has no workingSource

    // The herder borrows the tab to deliver to OTHER: tab navigates away,
    // phase becomes idle on OTHER. ID must STILL be working (recently
    // generating, within TTL) — this is the regression under test.
    path = "/c/" + OTHER;
    phase = "idle";
    chats = await driver.listChats();
    expect(chats.find(c => c.id === ID)).toMatchObject({ working: true, workingSource: "recently-generating" });
    expect(chats.find(c => c.id === OTHER)).toMatchObject({ working: false });

    // The tab comes back to ID and sees phase=idle: the turn finished.
    // recentlyGenerating clears immediately, working flips to false.
    path = "/c/" + ID;
    phase = "idle";
    chats = await driver.listChats();
    expect(chats.find(c => c.id === ID)).toMatchObject({ working: false });
  });
  it("extracts sidebar route and recognizes idle voice control from real ChatGPT DOM selectors", () => {
    const nav = { getAttribute: (key: string) => key === "href" ? "/c/" + ID : key === "aria-label" ? "Fixture chat" : null,
      textContent: "Fixture chat" };
    const editor = { getClientRects: () => [1], textContent: "" };
    const profile = { getClientRects: () => [1], getAttribute: (key: string) => key === "aria-label" ? "Открыть меню профиля" : null };
    const voice = { getClientRects: () => [1], getAttribute: (key: string) => key === "aria-label" ? "Начать голосовой разговор" : null };
    const stop = { getClientRects: () => [1], getAttribute: (key: string) => key === "aria-label" ? "Остановить генерацию" : null };
    function render(generating: boolean) {
      const document = {
        querySelectorAll: (sel: string) =>
          sel.startsWith("a[data-interactive-row-link]") ? [nav]
          : sel === "button" ? [profile, generating ? stop : voice] : [],
        querySelector: (sel: string) =>
          sel.startsWith('div[contenteditable=') ? editor
          : sel.startsWith('button[aria-label="Открыть') ? profile : null,
      };
      return runInNewContext("(" + CHATGPT_MAC_SNAPSHOT + ")()", {
        document, location: { origin: "https://chatgpt.com", pathname: "/c/" + ID },
      }) as { chats: Array<{ id: string }>; phase: string; authenticated: boolean };
    }
    expect(render(false)).toMatchObject({ authenticated: true, phase: "idle", chats: [{ id: ID }] });
    expect(render(true).phase).toBe("generating");
  });
});

describe("ChatGPT native async_status running signal", () => {
  it("marks a background-running chat working even when another chat is observed", async () => {
    const OTHER = "6ada477c-7014-83ed-82ae-7881dbe3e110";
    const THIRD = "6ada477c-7014-83ed-82ae-7881dbe3e111";
    class NativeListFixture extends BrowserFixture {
      override async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
        if (name === "evaluate_script" && args.function === CHATGPT_LIST_API_SCRIPT) {
          return json({ scope: "a".repeat(64), chats: [
            { id: ID, title: "Observed idle", updatedAt: 1730000000, asyncStatus: 0 },
            { id: OTHER, title: "Background running", updatedAt: 1730000001, asyncStatus: 3 },
            { id: THIRD, title: "Quiet", updatedAt: 1730000002, asyncStatus: 0 },
          ] });
        }
        return super.call(name, args);
      }
    }
    const f = new NativeListFixture();
    const driver = new ChatGptMacCdpDriver(f);
    const chats = await driver.listChats();
    // The observed tab's own chat keeps the DOM truth (idle here).
    expect(chats.find(c => c.id === ID)).toMatchObject({ working: false });
    expect(chats.find(c => c.id === ID)?.workingSource).toBeUndefined();
    // A chat with non-zero async_status is running on native evidence, with no Stop control.
    expect(chats.find(c => c.id === OTHER)).toMatchObject({ working: true, workingSource: "native-async-status", stopVisible: false });
    // Zero async_status stays idle.
    expect(chats.find(c => c.id === THIRD)).toMatchObject({ working: false });
    expect(chats.find(c => c.id === THIRD)?.workingSource).toBeUndefined();
  });
});

describe("ChatGPT browser submit admission", () => {
  it("blocks a race after fill without pressing Enter", async () => {
    const f = new BrowserFixture();
    const actions: string[] = [];
    const driver = new ChatGptMacCdpDriver({
      async call(name, args = {}) {
        actions.push(name);
        if (name === "list_pages") return f.call(name, args);
        if (name === "evaluate_script") {
          if (String(args.function || "").includes("const expected =")) return json({ submitted: false, reason: "busy" });
          return f.call(name, args);
        }
        if (name === "take_snapshot") return 'uid=1_42 textbox "Спросить ChatGPT" focusable multiline';
        if (name === "fill") return "ok";
        throw new Error("unexpected " + name);
      },
    });
    await driver.listChats();
    await expect(driver.sendMessage({ chatId: ID, text: "fixture-only" })).rejects.toThrow(/already running/);
    expect(actions).toContain("fill");
    expect(actions).not.toContain("press_key");
    expect(actions).not.toContain("navigate_page");
  });
  it("treats uncertain post-click response as non-retryable", async () => {
    const f = new BrowserFixture();
    const { BrowserChatAdapter } = await import("../src/adapters/browser-chat.js");
    const driver = new ChatGptMacCdpDriver({
      async call(name,args = {}) {
        if (name === "list_pages" || name === "evaluate_script" && !String(args.function).includes("const expected ="))
          return f.call(name,args);
        if (name === "take_snapshot") return 'uid=1_42 textbox "Спросить ChatGPT" focusable multiline';
        if (name === "fill") return "ok";
        if (name === "evaluate_script") throw new Error("transport lost after possible click");
        throw new Error("unexpected " + name);
      },
    });
    const adapter = new BrowserChatAdapter(driver, {
      id: "browser-chat", name: "Browser chats", harness: "chatgpt", cwd: "/browser",
    });
    await adapter.init();
    const receipt = await adapter.sendMessage(ID, { message:"fixture-only", queue:true });
    expect(receipt).toMatchObject({ok:false, admissionUnknown:true,nonRetryable:true});
  });
});

describe("dot tab isolation", () => {
 it("falls back to auto-detection when the pinned numeric page is a dot route", async () => {
  const listing="6: Dot (https://chatgpt.com/dots/owner~room)\n7: ChatGPT (https://chatgpt.com/c/"+ID+")";
  expect(parseChatGptPages(listing)).toEqual([{id:6,url:"https://chatgpt.com/dots/owner~room",conversation:false},{id:7,url:"https://chatgpt.com/c/"+ID,conversation:true}]);
  const pageIds:number[]=[];
  const tools:ChromePageTools={call:async(name:string,args:Record<string,unknown>={})=>{
    if(name==="list_pages")return listing;
    if(name==="evaluate_script"){pageIds.push(Number(args.pageId));return json({origin:"https://chatgpt.com",path:"/c/"+ID,authenticated:true,composer:true,phase:"generating",draftPresent:false,chats:[{id:ID,title:"Fixture chat"}]});}
    throw Error("must not touch dot");
  }};
  const driver=new ChatGptMacCdpDriver(tools,6);
  await expect(driver.sendMessage({chatId:ID,text:"must not send"})).rejects.toThrow(/already running/);
  expect(pageIds.length).toBeGreaterThan(0);
  expect(pageIds.every(id=>id===7)).toBe(true);
 });
 it("includes the dot root route alongside normal chat candidates",()=>{
  expect(parseChatGptPages("1: Dot (https://chatgpt.com/dots)\n2: ChatGPT (https://chatgpt.com/)")).toEqual([{id:1,url:"https://chatgpt.com/dots",conversation:false},{id:2,url:"https://chatgpt.com/",conversation:false}]);
 });
});


describe("ChatGPT tab auto-discovery", () => {
  it("captures the selected marker; the selected tab wins, then the lowest ID", () => {
    const pages = parseChatGptPages("2: ChatGPT (https://chatgpt.com/)\n4: ChatGPT (https://chatgpt.com/c/" + ID + ") [selected]");
    expect(pages).toEqual([
      { id: 2, url: "https://chatgpt.com/", conversation: false },
      { id: 4, url: "https://chatgpt.com/c/" + ID, conversation: true, selected: true },
    ]);
    expect(pickChatGptPage(pages).id).toBe(4);
    expect(pickChatGptPage(parseChatGptPages("9: ChatGPT (https://chatgpt.com/)\n4: ChatGPT (https://chatgpt.com/)")).id).toBe(4);
  });
  it("prefers a tab already on a conversation route over a lower-id dashboard", () => {
    const pages = parseChatGptPages("2: ChatGPT (https://chatgpt.com/)\n4: ChatGPT (https://chatgpt.com/c/" + ID + ")");
    expect(pages.map(p => p.id)).toEqual([2, 4]);
    expect(pickChatGptPage(pages).id).toBe(4);
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


describe("ChatGPT draft preservation", () => {
  it("saves a user draft before the herder's send and restores it after", async () => {
    let composerValue = "user draft text";
    const fills: string[] = [];
    const tools: ChromePageTools = {
      call: async (name, args = {}) => {
        if (name === "list_pages") return "7: ChatGPT (https://chatgpt.com/c/" + ID + ")";
        if (name === "take_snapshot") return 'uid=1_42 textbox "Спросить ChatGPT" focusable multiline';
        if (name === "fill") { fills.push(String(args.value)); composerValue = String(args.value); return "ok"; }
        if (name === "evaluate_script") {
          const fn = String(args.function);
          if (fn.includes("editor.innerText")) return json({ value: composerValue });
          if (fn.includes("const expected")) { composerValue = ""; return json({ submitted: true }); }
          return json({ origin: "https://chatgpt.com", path: "/c/" + ID, authenticated: true, composer: true,
            phase: "idle", draftPresent: false, chats: [{ id: ID, title: "Fixture chat" }] });
        }
        throw Error("unexpected tool: " + name);
      },
    };
    const driver = new ChatGptMacCdpDriver(tools, undefined, 0);
    await driver.sendMessage({ chatId: ID, text: "herder msg" });
    expect(fills).toEqual(["herder msg", "user draft text"]);
  });
});

describe("bounded list failure diagnostics", () => {
  it.each([
    ["list_http_429", "list_http_429"],
    ["read_cooldown", "read_cooldown"],
    ["private-code-state-cookie-sentinel", "unknown_error"],
    [{ secret: "private-code-state-cookie-sentinel" }, "unknown_error"],
  ])("never emits arbitrary CDP list errors", async (error, expected) => {
    const fixture = new BrowserFixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tools: ChromePageTools = { call: (name, args = {}) =>
      name === "evaluate_script" && args.function === CHATGPT_LIST_API_SCRIPT
        ? Promise.resolve(json({ error })) : fixture.call(name, args) };
    try {
      expect(await new ChatGptMacCdpDriver(tools).listChats()).toMatchObject([{ id: ID }]);
      expect(warn.mock.calls.flat().join(" ")).toContain(expected);
      expect(warn.mock.calls.flat().join(" ")).not.toContain("private-code-state-cookie-sentinel");
    } finally { warn.mockRestore(); }
  });
});

describe("dots workspace dashboard", () => {
  it("lists chats from a /dots/home dashboard tab via the authenticated API", async () => {
    const tools: ChromePageTools = {
      call: async (name, args = {}) => {
        if (name === "list_pages") return "6: ChatGPT (https://chatgpt.com/dots/home)";
        if (name === "evaluate_script") {
          const fn = String(args.function);
          if (fn === CHATGPT_LIST_API_SCRIPT) return json({ scope: "a".repeat(64), chats: [{ id: ID, title: "Workspace chat", updatedAt: 1730000000 }] });
          return json({ origin: "https://chatgpt.com", path: "/dots/home", authenticated: true, composer: false,
            phase: "unknown", draftPresent: false, chats: [] });
        }
        throw Error("unexpected tool: " + name);
      },
    };
    const driver = new ChatGptMacCdpDriver(tools, undefined, 0);
    expect(await driver.listChats()).toMatchObject([{ id: ID, title: "Workspace chat", working: false }]);
  });
  it.each([
    "/dots/home",
    "/c/123e4567-e89b-42d3-a456-426614174000",
    "/g/g-p-123e4567-e89b-42d3-a456-426614174000/c/" + ID,
  ])("navigates an idle or dashboard tab from %s before sending", async (initialPath) => {
    const navs: string[] = [];
    let navigated = false;
    const tools: ChromePageTools = {
      call: async (name, args = {}) => {
        if (name === "list_pages") return "6: ChatGPT (https://chatgpt.com" + initialPath + ")";
        if (name === "navigate_page") { navigated = true; navs.push(String(args.url)); return "ok"; }
        if (name === "take_snapshot") return 'uid=1_7 textbox "Спросить ChatGPT"';
        if (name === "fill") return "ok";
        if (name === "evaluate_script") {
          const fn = String(args.function);
          if (fn === CHATGPT_LIST_API_SCRIPT) return json({ scope: "a".repeat(64), chats: [{ id: ID, title: "Workspace chat" }] });
          if (fn.includes("editor.innerText")) return json({ value: "" });
          if (fn.includes("const expected")) return json({ submitted: true });
          const path = navigated ? "/c/" + ID : initialPath;
          return json({ origin: "https://chatgpt.com", path, authenticated: true, composer: navigated,
            phase: navigated || initialPath !== "/dots/home" ? "idle" : "unknown", draftPresent: false, chats: navigated ? [{ id: ID, title: "Workspace chat" }] : [] });
        }
        throw Error("unexpected tool: " + name);
      },
    };
    const driver = new ChatGptMacCdpDriver(tools, undefined, 0);
    await driver.sendMessage({ chatId: ID, text: "hello from herder" });
    expect(navs).toEqual(["https://chatgpt.com/c/" + ID]);
  });
});


describe("the passive list script of the paused harness", () => {
  it("reads the intercept stash and never fetches", () => {
    // The passive script is the "hook" of the owner: the site feeds the
    // herder, the herder asks the site for nothing.
    expect(CHATGPT_LIST_API_PASSIVE_SCRIPT).toContain("source:'passive'");
    expect(CHATGPT_LIST_API_PASSIVE_SCRIPT).toContain("__herderChatGptInventory");
    expect(CHATGPT_LIST_API_PASSIVE_SCRIPT).not.toContain("tracedFetch");
    expect(CHATGPT_LIST_API_PASSIVE_SCRIPT).not.toContain("await fetch(");
  });
});

describe("ChatGPT idle detection without a voice control", () => {
  it("treats a visible composer without Stop as idle", () => {
    const nav = { getAttribute: (key: string) => key === "href" ? "/c/" + ID : key === "aria-label" ? "Fixture chat" : null,
      textContent: "Fixture chat" };
    const editor = { getClientRects: () => [1], textContent: "" };
    const profile = { getClientRects: () => [1], getAttribute: (key: string) => key === "aria-label" ? "Открыть меню профиля" : null };
    const document = {
      querySelectorAll: (sel: string) =>
        sel.startsWith("a[data-interactive-row-link]") ? [nav]
        : sel === "button" ? [profile] : [],
      querySelector: (sel: string) =>
        sel.startsWith('div[contenteditable=') ? editor
        : sel.startsWith('button[aria-label="Открыть') ? profile : null,
    };
    const result = runInNewContext("(" + CHATGPT_MAC_SNAPSHOT + ")()", {
      document, location: { origin: "https://chatgpt.com", pathname: "/c/" + ID },
    }) as { phase: string; composer: boolean };
    expect(result).toMatchObject({ phase: "idle", composer: true });
  });
});

describe("ChatGPT owned tab ownership", () => {
  const scope = "a".repeat(64);
  function tool(opened: string[]): ChromePageTools {
    let listing = "";
    const set = (value: string) => { listing = value; };
    const tools: ChromePageTools = { call: async (name, args = {}) => {
      opened.push(name + ":" + JSON.stringify(args));
      if (name === "list_pages") return listing;
      if (name === "new_page") {
        const url = String(args.url);
        set(url.includes("herder_owned=chatgpt")
          ? "7: ChatGPT (" + url + ")\n9: Other (https://chatgpt.com/c/11111111-2222-3333-4444-555555555555)"
          : listing);
        return "";
      }
      if (name === "evaluate_script" && args.function === CHATGPT_CREATE_SCOPE_SCRIPT) return json({ scope });
      if (name === "evaluate_script") return json({
        origin: "https://chatgpt.com", path: "/c/" + ID, authenticated: true,
        composer: true, phase: "idle", draftPresent: false, chats: [],
      });
      throw new Error("unexpected action " + name);
    } };
    return Object.assign(tools, { set });
  }
  it("uses its own marked tab and never opens a second one", async () => {
    const opened: string[] = [];
    const tools = tool(opened);
    tools.set("7: ChatGPT (https://chatgpt.com/?herder_owned=chatgpt)\n9: Other (https://chatgpt.com/c/11111111-2222-3333-4444-555555555555)");
    const driver = new ChatGptMacCdpDriver(tools, undefined, 0, scope);
    await driver.listChats();
    await driver.listChats();
    expect(opened.filter(a => a.startsWith("new_page")).length).toBe(0);
  });
  it("opens exactly one replacement when its own tab is closed", async () => {
    const opened: string[] = [];
    const tools = tool(opened);
    tools.set("7: ChatGPT (https://chatgpt.com/?herder_owned=chatgpt)");
    const driver = new ChatGptMacCdpDriver(tools, undefined, 0, scope);
    await driver.listChats();
    tools.set("9: Other (https://chatgpt.com/c/11111111-2222-3333-4444-555555555555)");
    await driver.listChats();
    const opened_pages = opened.filter(a => a.startsWith("new_page"));
    expect(opened_pages.length).toBe(1);
    expect(opened_pages[0]).toContain("herder_owned=chatgpt");
  });
  it("adopts one existing tab on first use instead of opening another one", async () => {
    const opened: string[] = [];
    const tools = tool(opened);
    tools.set("9: Other (https://chatgpt.com/c/11111111-2222-3333-4444-555555555555)");
    const driver = new ChatGptMacCdpDriver(tools, undefined, 0, scope);
    await driver.listChats();
    expect(opened.filter(a => a.startsWith("new_page")).length).toBe(0);
  });
});

describe("ChatGPT one owned tab", () => {
  it("does not read the history of a tab whose rate-limit cooldown is active", async () => {
    const scope = "a".repeat(64);
    const readPages: number[] = [];
    const tools: ChromePageTools = { call: async (name, args = {}) => {
      if (name === "list_pages") {
        return [
          "48: ChatGPT (https://chatgpt.com/c/" + ID + ")",
          "49: ChatGPT (https://chatgpt.com/c/22222222-2222-4222-8222-222222222222)",
        ].join("\n");
      }
      if (name === "evaluate_script") {
        const source = String(args.function);
        if (source === CHATGPT_CREATE_SCOPE_SCRIPT) return json({ scope });
        if (source.includes("conversation_read")) {
          readPages.push(Number(args.pageId));
          // The first owned tab is rate-limited on reads; the second one
          // answers. A read must not fail because of the tab it picked.
          if (Number(args.pageId) === 48) return json({ error: "read_cooldown" });
          return json({ messages: [{ id: "m1", role: "user", text: "question" }] });
        }
        return json({
          origin: "https://chatgpt.com", path: "/c/" + ID, authenticated: true,
          composer: true, phase: "idle", draftPresent: false, chats: [],
        });
      }
      throw new Error("unexpected action " + name);
    } };
    const driver = new ChatGptMacCdpDriver(tools, undefined, 0, scope);
    const messages = await driver.getMessages(ID);
    expect(messages).toMatchObject([{ id: "m1", role: "user", text: "question" }]);
    // The rate-limited tab is tried once and then skipped; the read is
    // served by the next tab of the same account, never repeated on the
    // same tab.
    expect(readPages).toEqual([48, 49]);
  });

  it("keeps the verified account scope after the passive startup listing", async () => {
    const scope = "a".repeat(64);
    const tools: ChromePageTools = { call: async (name, args = {}) => {
      if (name === "list_pages") return "7: ChatGPT (https://chatgpt.com/c/" + ID + ")";
      if (name === "evaluate_script") {
        const source = String(args.function);
        if (source === CHATGPT_CREATE_SCOPE_SCRIPT) return json({ scope });
        if (source === CHATGPT_LIST_API_PASSIVE_SCRIPT) return json({ scope: "", chats: [], source: "passive" });
        return json({
          origin: "https://chatgpt.com", path: "/c/" + ID, authenticated: true,
          composer: true, phase: "idle", draftPresent: false, chats: [{ id: ID, title: "Fixture chat" }],
        });
      }
      throw new Error("unexpected action " + name);
    } };
    const driver = new ChatGptMacCdpDriver(tools, undefined, 0, scope);
    // The startup listing is passive and carries no scope of its own. The
    // driver must still prove the account it belongs to, otherwise every
    // later read of the same instance is refused as an unknown account.
    await driver.listObservedChats();
    expect(driver.getAccountScope()).toBe(scope);
  });

  it("reads the history of a draft session before the inventory was listed", async () => {
    const scope = "a".repeat(64);
    const disk = mkdtempSync(join(tmpdir(), "chatgpt-draft-"));
    process.env.AGENT_HERDER_BROWSER_DRAFT_ROOT = disk;
    try {
      const store = new BrowserChatDraftStore("chatgpt", disk);
      await store.useScope(scope);
      const draft = await store.create("Fixture draft");
      await store.startSend(draft.id);
      await store.admit(draft.id, ID);
      const tools: ChromePageTools = { call: async (name, args = {}) => {
        if (name === "list_pages") return "7: ChatGPT (https://chatgpt.com/c/" + ID + ")";
        if (name === "evaluate_script") {
          const source = String(args.function);
          if (source === CHATGPT_CREATE_SCOPE_SCRIPT) return json({ scope });
          if (source.includes("conversation_read")) {
            return json({ messages: [{ id: "m1", role: "user", text: "question" }] });
          }
          return json({
            origin: "https://chatgpt.com", path: "/c/" + ID, authenticated: true,
            composer: true, phase: "idle", draftPresent: false, chats: [],
          });
        }
        throw new Error("unexpected action " + name);
      } };
      const driver = new ChatGptMacCdpDriver(tools, undefined, 0, scope);
      // A fresh process knows no draft yet: the read must resolve the account
      // scope and load the durable drafts itself. A reader that only knows
      // the draft after a listing never confirms the follow-up delivery.
      const messages = await driver.getMessages(draft.id);
      expect(messages).toMatchObject([{ id: "m1", role: "user", text: "question" }]);
    } finally {
      rmSync(disk, { recursive: true, force: true });
      delete process.env.AGENT_HERDER_BROWSER_DRAFT_ROOT;
    }
  });

  it("clears the running flag of a chat whose answer already arrived", async () => {
    const scope = "a".repeat(64);
    const tools: ChromePageTools = { call: async (name, args = {}) => {
      if (name === "list_pages") return "7: ChatGPT (https://chatgpt.com/c/" + ID + ")";
      if (name === "evaluate_script") {
        const source = String(args.function);
        if (source === CHATGPT_CREATE_SCOPE_SCRIPT) return json({ scope });
        if (source.includes("conversation_read")) {
          return json({ messages: [
            { id: "m1", role: "user", text: "question" },
            { id: "m2", role: "assistant", text: "answer" },
          ] });
        }
        return json({
          origin: "https://chatgpt.com", path: "/c/" + ID, authenticated: true,
          composer: true, phase: "idle", draftPresent: false, chats: [],
        });
      }
      throw new Error("unexpected action " + name);
    } };
    const driver = new ChatGptMacCdpDriver(tools, undefined, 0, scope);
    // The first delivery marked the chat as running.
    (driver as unknown as { cache: Map<string, { working: boolean }> }).cache.set(ID, {
      id: ID, title: "Fixture chat", unread: false, working: true,
      updatedAt: new Date().toISOString(),
    });
    expect(driver.getKnownChat?.(ID)?.working).toBe(true);
    // The model answered: the follow-up delivery must not see a busy chat.
    await driver.refreshTurnState?.(ID);
    expect(driver.getKnownChat?.(ID)?.working).toBe(false);
  });

  it("reports an idle chat as idle after its first answer arrived", async () => {
    const scope = "a".repeat(64);
    let phase: "idle" | "generating" = "generating";
    const tools: ChromePageTools = { call: async (name, args = {}) => {
      if (name === "list_pages") return "7: ChatGPT (https://chatgpt.com/c/" + ID + ")";
      if (name === "evaluate_script") {
        const source = String(args.function);
        if (source === CHATGPT_CREATE_SCOPE_SCRIPT) return json({ scope });
        if (source === CHATGPT_LIST_API_SCRIPT) {
          return json({ scope, chats: [{ id: ID, title: "Fixture chat", updatedAt: 1 }] });
        }
        return json({
          origin: "https://chatgpt.com", path: "/c/" + ID, authenticated: true,
          composer: true, phase, draftPresent: false, chats: [{ id: ID, title: "Fixture chat" }],
        });
      }
      throw new Error("unexpected action " + name);
    } };
    const driver = new ChatGptMacCdpDriver(tools, undefined, 0, scope);
    // The tab still shows the generating state of the first turn.
    const running = (await driver.listChats()).find(chat => chat.id === ID);
    expect(running?.working).toBe(true);
    // The model answered and the tab went back to idle. A later delivery to
    // the same chat must see it idle, otherwise every follow-up message is
    // refused as if the chat were still generating.
    phase = "idle";
    const idle = (await driver.listChats()).find(chat => chat.id === ID);
    expect(idle?.working).toBe(false);
  });

  it("reuses its own tab after the site dropped the URL marker on navigation", async () => {
    const scope = "a".repeat(64);
    const opened: string[] = [];
    let listing = "7: ChatGPT (https://chatgpt.com/?herder_owned=chatgpt)";
    const tools: ChromePageTools = { call: async (name, args = {}) => {
      if (name === "list_pages") return listing;
      if (name === "new_page") { opened.push(String(args.url)); return ""; }
      if (name === "evaluate_script") {
        const source = String(args.function);
        if (source.includes("herder-owned:chatgpt")) {
          return json({ owned: Number(args.pageId) === 7, already: true });
        }
        if (source === CHATGPT_CREATE_SCOPE_SCRIPT) return json({ scope });
        return json({
          origin: "https://chatgpt.com", path: "/c/" + ID, authenticated: true,
          composer: true, phase: "idle", draftPresent: false, chats: [],
        });
      }
      throw new Error("unexpected action " + name);
    } };
    const driver = new ChatGptMacCdpDriver(tools, undefined, 0, scope);
    await driver.listChats();
    // The site navigated our own tab into a conversation and dropped the
    // URL marker. The next run must find that same tab, not open another.
    listing = "7: ChatGPT (https://chatgpt.com/c/" + ID + ")\n9: Other (https://chatgpt.com/)";
    await driver.listChats();
    expect(opened).toEqual([]);
  });

  it("closes its own duplicate tabs and keeps exactly one", async () => {
    const scope = "a".repeat(64);
    const closed: number[] = [];
    const tools: ChromePageTools = { call: async (name, args = {}) => {
      if (name === "list_pages") return [
        "29: ChatGPT (https://chatgpt.com/?herder_owned=chatgpt)",
        "30: ChatGPT (https://chatgpt.com/?herder_owned=chatgpt)",
        "31: Other (https://chatgpt.com/c/11111111-2222-3333-4444-555555555555)",
      ].join("\n");
      if (name === "close_page") { closed.push(Number(args.pageId)); return ""; }
      if (name === "evaluate_script" && args.function === CHATGPT_CREATE_SCOPE_SCRIPT) return json({ scope });
      if (name === "evaluate_script") return json({
        origin: "https://chatgpt.com", path: "/c/" + ID, authenticated: true,
        composer: true, phase: "idle", draftPresent: false, chats: [],
      });
      throw new Error("unexpected action " + name);
    } };
    const driver = new ChatGptMacCdpDriver(tools, undefined, 0, scope);
    await driver.listChats();
    expect(closed).toEqual([30]);
  });
});
