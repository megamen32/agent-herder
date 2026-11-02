import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { CHATGPT_MAC_SNAPSHOT, ChatGptMacCdpDriver, parseChatGptPages, pickChatGptPage } from "../src/adapters/chatgpt-mac-cdp-driver.js";
import { parseChromeEvaluation, type ChromePageTools } from "../src/adapters/mac-mini-chrome-transport.js";

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
  it("parses only the official ChatGPT origin", () => {
    expect(parseChatGptPages(
      "7: ChatGPT (https://chatgpt.com/c/" + ID + ")\n"
      + "8: impostor (https://chatgpt.com.evil.invalid/c/" + ID + ")\n"
      + "9: ZAI (https://chat.z.ai/)"))
      .toEqual([{ id: 7, url: "https://chatgpt.com/c/" + ID }]);
  });
  it("reads verified native route IDs without sending or touching ZAI", async () => {
    const f = new BrowserFixture();
    const driver = new ChatGptMacCdpDriver(f);
    expect(await driver.listChats()).toMatchObject([{ id: ID, title: "Fixture chat", working: false }]);
    expect(await driver.getChat(ID)).toMatchObject({ id: ID, working: false });
    expect(f.actions.every(a => ["list_pages","evaluate_script"].includes(a))).toBe(true);
    expect(await driver.getChat("6ada477c-7014-83ed-82ae-7881dbe3e999")).toBeNull();
  });
  it("will not write while generating, unknown, or when user has a draft", async () => {
    const f = new BrowserFixture();
    const driver = new ChatGptMacCdpDriver(f);
    await driver.listChats();
    f.phase = "generating";
    expect((await driver.getChat(ID))?.working).toBe(true);
    await expect(driver.sendMessage({ chatId: ID, text: "hold" })).rejects.toThrow(/already running/);
    f.phase = "unknown";
    await expect(driver.sendMessage({ chatId: ID, text: "hold" })).rejects.toThrow(/unavailable/);
    f.phase = "idle"; f.draft = true;
    await expect(driver.sendMessage({ chatId: ID, text: "hold" })).rejects.toThrow(/personal draft/);
    expect(f.actions.every(a => ["list_pages","evaluate_script"].includes(a))).toBe(true);
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
  expect(parseChatGptPages(listing)).toEqual([{id:7,url:"https://chatgpt.com/c/"+ID}]);
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
 it("excludes the dot root route, retains normal chat candidates",()=>{
  expect(parseChatGptPages("1: Dot (https://chatgpt.com/dots)\n2: ChatGPT (https://chatgpt.com/)")).toEqual([{id:2,url:"https://chatgpt.com/"}]);
 });
});


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
