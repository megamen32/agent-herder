import { ZAI_LIST_API_SCRIPT } from "../src/adapters/browser-chat-api-scripts.js";
import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { ZaiCdpDriver, ZAI_ACTIVITY_SCRIPT, parseZaiPages, pickZaiPage } from "../src/adapters/zai-cdp-driver.js";
import { ListAgentsSchema, AgentInfoSchema } from "../src/mcp-tools/definitions.js";
import { parseChromeEvaluation, type ChromePageTools } from "../src/adapters/mac-mini-chrome-transport.js";

const route = "/c/123e4567-e89b-12d3-a456-426614174000";
const evalJson = (value: unknown) => "Script ran on page and returned:\n```json\n" + JSON.stringify(value) + "\n```";
type Phase = "idle" | "generating" | "unknown";
const state = (
  path = "/", titles = ["Test fixture", "Another fixture"], selectedTitle?: string,
  phase: Phase = "idle", draftPresent = false,
) => ({
  origin: "https://chat.z.ai", path, loggedIn: true, composer: true,
  titles, selectedTitle, phase, draftPresent,
});

class MockChromeTools implements ChromePageTools {
  readonly actions: Array<{ name: string; args: Record<string, unknown> }> = [];
  page = state();
  draft = "";
  sent: string[] = [];
  preClickBusy = false;
  async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    this.actions.push({ name, args });
    if (name === "list_pages") return "11: Z.ai (https://chat.z.ai/) [selected]";
    if (name === "take_snapshot") return 'uid=1_87 textbox "Send a Message" multiline';
    if (name === "fill") { this.draft = String(args.value); return "ok"; }
    if (name === "navigate_page") {
      this.page = state(route, ["Test fixture", "Another fixture"], "Test fixture");
      return "ok";
    }
    if (name === "evaluate_script" && String(args.function).includes("history.pushState")) {
      this.page = state(route, ["Test fixture", "Another fixture"], "Test fixture");
      return evalJson({ pushed: route });
    }
    if (name !== "evaluate_script") throw new Error("unexpected tool: " + name);
    const fn = String(args.function);
    if (fn.includes("const title =")) {
      if (this.page.phase !== "idle" || this.draft) return evalJson({ selected: false, busy: true });
      this.page = state(route, ["Test fixture", "Another fixture"], "Test fixture");
      return evalJson({ selected: true });
    }
    if (fn.includes("const expected =")) {
      if (this.preClickBusy || this.page.phase === "generating") {
        return evalJson({ submitted: false, reason: "busy" });
      }
      if (this.page.phase === "unknown") return evalJson({ submitted: false, reason: "send_not_ready" });
      if (!this.draft) return evalJson({ submitted: false, reason: "draft_changed" });
      this.sent.push(this.draft);
      this.draft = "";
      this.page.phase = "generating";
      return evalJson({ submitted: true });
    }
    if (fn.includes("() => ({remaining:")) {
      return evalJson({ remaining: this.draft, origin: this.page.origin, path: this.page.path });
    }
    return evalJson({ ...this.page, draftPresent: Boolean(this.draft) || this.page.draftPresent, value: this.draft });
  }
}

describe("ZAI real DOM activity selectors", () => {
  function runMarkupFixture(options: { stop: boolean; send: boolean; disabled?: boolean }) {
    const stopButton = {
      getClientRects: () => [1],
      querySelector: (selector: string) => selector.includes("span.block.size-3.rounded-xs.bg-text-inverted") && options.stop
        ? ({}) : null,
    };
    const editor = { value: "" };
    const send = { disabled: options.disabled ?? true, getClientRects: () => [1] };
    const document = {
      querySelectorAll: (selector: string) => selector === "button" ? [stopButton] : [],
      querySelector: (selector: string) => {
        if (selector === "#chat-group-tab-zai-web") return {};
        if (selector === "#send-message-button") return options.send ? send : null;
        if (selector.startsWith("textarea")) return editor;
        return null;
      },
    };
    return runInNewContext("(" + ZAI_ACTIVITY_SCRIPT + ")()", {
      document, location: { origin: "https://chat.z.ai", pathname: route },
    }) as { phase: Phase; draftPresent: boolean };
  }

  it("recognizes the square Stop button as generating even when Send exists", () => {
    expect(runMarkupFixture({ stop: true, send: true }).phase).toBe("generating");
  });
  it("recognizes disabled empty Send as idle and missing controls as unknown", () => {
    expect(runMarkupFixture({ stop: false, send: true, disabled: true }).phase).toBe("idle");
    expect(runMarkupFixture({ stop: false, send: false }).phase).toBe("unknown");
  });
});

describe("Mac mini CDP ZAI provider", () => {
  it("parses only exact ZAI origins and handles 404-only Chrome browser sockets", () => {
    expect(parseZaiPages("11: Z.ai (https://chat.z.ai/)\n12: Unknown (https://chat.z.ai.evil.invalid/)\n13: ChatGPT (https://chatgpt.com/)"))
      .toEqual([{ id: 11, url: "https://chat.z.ai/" }]);
    expect(parseChromeEvaluation<number>("Result:\n```json\n42\n```")).toBe(42);
  });
  it("lists visible sidebar conversations without creating a new chat", async () => {
    const tools = new MockChromeTools();
    const driver = new ZaiCdpDriver(tools);
    expect(await driver.listChats()).toMatchObject([
      { id: "sidebar:Test%20fixture", title: "Test fixture", working: false },
      { id: "sidebar:Another%20fixture", title: "Another fixture", working: false },
    ]);
    expect(tools.actions.every(action => ["list_pages", "evaluate_script"].includes(action.name))).toBe(true);
    expect((await driver.getChat("sidebar:Test%20fixture"))?.title).toBe("Test fixture");
  });
  it("sends exactly once after target identity and button checks; no Enter/Stop press", async () => {
    const tools = new MockChromeTools();
    const driver = new ZaiCdpDriver(tools);
    await driver.listChats();
    await expect(driver.sendMessage({ chatId: "sidebar:Test%20fixture", text: "fixture-only" })).resolves.toEqual({});
    expect(tools.sent).toEqual(["fixture-only"]);
    expect(tools.actions.find(x => x.name === "fill")?.args.value).toBe("fixture-only");
    expect(tools.actions.every(x => x.name !== "press_key")).toBe(true);
    expect((await driver.getChat("sidebar:Test%20fixture"))?.working).toBe(true);
    await expect(driver.sendMessage({ chatId: "sidebar:Unknown", text: "not allowed" })).rejects.toThrow(/not in/);
  });
  it("never sends while generating and notices the switch from busy to idle", async () => {
    const tools = new MockChromeTools();
    tools.page = state(route, ["Test fixture"], "Test fixture", "generating");
    const driver = new ZaiCdpDriver(tools);
    await driver.listChats();
    expect((await driver.getChat("sidebar:Test%20fixture"))?.working).toBe(true);
    await expect(driver.sendMessage({ chatId: "sidebar:Test%20fixture", text: "deferred" })).rejects.toThrow(/already running/);
    expect(tools.actions.some(x => x.name === "fill")).toBe(false);
    tools.page.phase = "idle";
    expect((await driver.getChat("sidebar:Test%20fixture"))?.working).toBe(false);
    await driver.sendMessage({ chatId: "sidebar:Test%20fixture", text: "deferred" });
    expect(tools.sent).toEqual(["deferred"]);
  });
  it("holds a different target while the current chat generates, then selects and inspects the target", async () => {
    const tools = new MockChromeTools();
    tools.page = state(route, ["Test fixture", "Another fixture"], "Another fixture", "generating");
    const driver = new ZaiCdpDriver(tools);
    await driver.listChats();
    const first = await driver.getChat("sidebar:Test%20fixture");
    expect(first?.working).toBe(true);
    expect(tools.actions.filter(x => String(x.args.function).includes("const title ="))).toHaveLength(0);
    tools.page.phase = "idle";
    expect((await driver.getChat("sidebar:Test%20fixture"))?.working).toBe(false);
    expect(tools.actions.some(x => String(x.args.function).includes("const title ="))).toBe(true);
  });
  it("prevents a race where generation begins after filling but before clicking Send", async () => {
    const tools = new MockChromeTools();
    const driver = new ZaiCdpDriver(tools);
    await driver.listChats();
    tools.preClickBusy = true;
    await expect(driver.sendMessage({ chatId: "sidebar:Test%20fixture", text: "should not send" })).rejects.toThrow(/already running/);
    expect(tools.sent).toHaveLength(0);
  });
  it("uses atomic Send-click preflight and clears only an unsent owned draft", async () => {
    const tools = new MockChromeTools();
    const driver = new ZaiCdpDriver(tools);
    await driver.listChats();
    await driver.sendMessage({ chatId: "sidebar:Test%20fixture", text: "exact-payload" });
    const script = String(tools.actions.find(x => String(x.args.function).includes("const expected ="))?.args.function);
    expect(script).toContain("#send-message-button");
    expect(script).toContain("span.block.size-3.rounded-xs.bg-text-inverted");

    async function run(options: { generating?: boolean; disabled?: boolean; wrongTitle?: boolean; otherDraft?: boolean }) {
      let clicked = 0;
      class Editor {
        private content = options.otherDraft ? "human draft" : "exact-payload";
        get value() { return this.content; }
        set value(value: string) { this.content = value; }
        dispatchEvent() { return true; }
      }
      const editor = new Editor();
      const button = {
        getClientRects: () => [1],
        disabled: Boolean(options.disabled),
        click: () => { clicked++; editor.value = ""; },
      };
      const stop = {
        getClientRects: () => [1],
        querySelector: (q: string) => q.includes("span.block.size-3.rounded-xs.bg-text-inverted") && options.generating ? {} : null,
      };
      const selected = {
        getAttribute: (name: string) => name === "data-selected" ? "true" : null,
        querySelector: () => ({ textContent: options.wrongTitle ? "Other conversation" : "Test fixture" }),
        textContent: "Test fixture",
      };
      const document = {
        querySelectorAll: (q: string) => q === "button" ? [stop] : q === "button[data-selected]" ? [selected] : [],
        querySelector: (q: string) => q === "#send-message-button" ? button :
          q.startsWith("textarea") ? editor : null,
      };
      const result = await runInNewContext("(" + script + ")()", {
        document,
        location: { origin: "https://chat.z.ai", pathname: route },
        setTimeout: (done: () => void) => { done(); return 0; },
        HTMLTextAreaElement: Editor,
        Event: class { constructor(public type: string, public options: object) {} },
      }) as { submitted: boolean; reason?: string };
      return { result, clicked, draft: editor.value };
    }

    expect(await run({ generating: true })).toMatchObject({
      result: { submitted: false, reason: "busy" }, clicked: 0, draft: "",
    });
    expect(await run({ disabled: true })).toMatchObject({
      result: { submitted: false, reason: "send_not_ready" }, clicked: 0, draft: "",
    });
    expect(await run({ wrongTitle: true })).toMatchObject({
      result: { submitted: false, reason: "target_changed" }, clicked: 0, draft: "",
    });
    expect(await run({ otherDraft: true })).toMatchObject({
      result: { submitted: false, reason: "draft_changed" }, clicked: 0, draft: "human draft",
    });
    expect(await run({})).toMatchObject({
      result: { submitted: true }, clicked: 1, draft: "",
    });
  });
  it("refuses unknown UI and unexpected origins; a stale pin falls back and a draft is preserved", async () => {
    const duplicate = new MockChromeTools();
    duplicate.page = state("/", ["Duplicate", "Duplicate"]);
    const driver = new ZaiCdpDriver(duplicate);
    expect(await driver.listChats()).toHaveLength(0);
    // A stale pin falls back to auto-detection instead of failing.
    await expect(new ZaiCdpDriver(duplicate, 99).listChats()).resolves.toHaveLength(0);
    const wrongOrigin = new MockChromeTools();
    wrongOrigin.page = { ...state(), origin: "https://fake.z.ai" };
    await expect(new ZaiCdpDriver(wrongOrigin).listChats()).rejects.toThrow(/not a logged-in/);
    const unknown = new MockChromeTools();
    unknown.page.phase = "unknown";
    const notReady = new ZaiCdpDriver(unknown);
    expect((await notReady.listChats())[0]?.working).toBe(false);
    await expect(notReady.sendMessage({ chatId: "sidebar:Test%20fixture", text: "no" })).rejects.toThrow(/unavailable/);
    const draft = new MockChromeTools();
    draft.page.draftPresent = true;
    const protectedDriver = new ZaiCdpDriver(draft);
    await protectedDriver.listChats();
    // A user draft no longer blocks the herder's send; it is preserved and restored.
    await expect(protectedDriver.sendMessage({ chatId: "sidebar:Test%20fixture", text: "no" })).resolves.toEqual({});
  });
  it("resumes an exact route target that was never rendered in the sidebar", async () => {
    const tools = new MockChromeTools();
    const driver = new ZaiCdpDriver(tools);
    const chat = await driver.getChat("route:" + route.slice(3));
    expect(chat).toMatchObject({ id: "route:" + route.slice(3), title: "Test fixture", working: false });
    expect(tools.actions.some(x => x.name === "navigate_page")).toBe(false);
    expect(String(tools.actions.find(x => String(x.args.function).includes("history.pushState"))?.args.function))
      .toContain(JSON.stringify(route));
  });
  it("delivers to an exact route target without prior sidebar observation", async () => {
    const tools = new MockChromeTools();
    const driver = new ZaiCdpDriver(tools);
    await driver.sendMessage({ chatId: "route:" + route.slice(3), text: "route-exact" });
    expect(tools.sent).toEqual(["route-exact"]);
    expect(tools.actions.some(x => x.name === "navigate_page")).toBe(false);
    expect(String(tools.actions.find(x => String(x.args.function).includes("history.pushState"))?.args.function))
      .toContain(JSON.stringify(route));
    expect((await driver.getChat("route:" + route.slice(3)))?.title).toBe("Test fixture");
  });
  it("rejects malformed route identities without any navigation", async () => {
    const tools = new MockChromeTools();
    const driver = new ZaiCdpDriver(tools);
    expect(await driver.getChat("route:not-a-uuid")).toBeNull();
    await expect(driver.sendMessage({ chatId: "route:not-a-uuid", text: "no" })).rejects.toThrow(/not in/);
    expect(tools.actions.some(x => String(x.args.function || "").includes("history.pushState"))).toBe(false);
    expect(tools.actions.some(x => x.name === "navigate_page")).toBe(false);
  });
});

describe("browser-chat API schema compatibility", () => {
  it("accepts browser-chat in filtered and exact agent tools", () => {
    expect(ListAgentsSchema.safeParse({ harness: "zai", limit: 2 }).success).toBe(true);
    expect(AgentInfoSchema.safeParse({ sessionId: "zai::sidebar%3ATest", harness: "zai" }).success).toBe(true);
  });
});

it("labels only authenticated API update timestamps as remote revisions", async () => {
  class ApiTools extends MockChromeTools {
    override async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
      if (name === "evaluate_script" && args.function === ZAI_LIST_API_SCRIPT) {
        return evalJson({scope:"a".repeat(64),chats:[
          {id:"123e4567-e89b-12d3-a456-426614174000",title:"Changed",updatedAt:1730000000},
          {id:"123e4567-e89b-12d3-a456-426614174001",title:"Unknown"}
        ]});
      }
      return super.call(name,args);
    }
  }
  const chats = await new ZaiCdpDriver(new ApiTools()).listChats();
  expect(chats[0]).toMatchObject({updatedAtSemantics:"remote-update-time",updatedAt:new Date(1730000000000).toISOString()});
  expect(chats[1]).toMatchObject({updatedAtSemantics:"observed-sidebar-order"});
  const fallback = await new ZaiCdpDriver(new MockChromeTools()).listChats();
  expect(fallback.every(chat => chat.updatedAtSemantics === "observed-sidebar-order")).toBe(true);
});


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


describe("ZAI draft preservation", () => {
  it("saves a user draft before the herder's send and restores it after", async () => {
    const tools = new MockChromeTools();
    tools.draft = "user draft text";
    const fills: string[] = [];
    const origCall = tools.call.bind(tools);
    tools.call = async (name: string, args: Record<string, unknown> = {}) => {
      if (name === "fill") fills.push(String(args.value));
      return origCall(name, args);
    };
    const driver = new ZaiCdpDriver(tools);
    await driver.sendMessage({ chatId: "route:123e4567-e89b-12d3-a456-426614174000", text: "herder msg" });
    expect(fills).toEqual(["herder msg", "user draft text"]);
  });
});
