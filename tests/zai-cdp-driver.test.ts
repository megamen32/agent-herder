import { describe, expect, it } from "vitest";
import { ZaiCdpDriver, parseZaiPages } from "../src/adapters/zai-cdp-driver.js";
import { parseChromeEvaluation, type ChromePageTools } from "../src/adapters/mac-mini-chrome-transport.js";

const route = "/c/123e4567-e89b-12d3-a456-426614174000";
const evalJson = (value: unknown) => "Script ran on page and returned:\n```json\n" + JSON.stringify(value) + "\n```";
const state = (path = "/", titles = ["Test fixture", "Another fixture"], selectedTitle?: string) =>
  ({ origin: "https://chat.z.ai", path, loggedIn: true, composer: true, titles, selectedTitle });

class MockChromeTools implements ChromePageTools {
  readonly actions: Array<{ name: string; args: Record<string, unknown> }> = [];
  page = state();
  async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    this.actions.push({ name, args });
    if (name === "list_pages") return "11: Z.ai (https://chat.z.ai/) [selected]";
    if (name === "take_snapshot") return 'uid=1_87 textbox "Send a Message" multiline';
    if (name === "fill" || name === "press_key") return "ok";
    if (name === "navigate_page") { this.page = state(route, ["Test fixture"], "Test fixture"); return "ok"; }
    if (name !== "evaluate_script") throw new Error("unexpected tool");
    const fn = String(args.function);
    if (fn.includes("const title =")) {
      this.page = state(route, ["Test fixture", "Another fixture"], "Test fixture");
      return evalJson({ selected: true });
    }
    if (fn.includes("() => ({text:")) return evalJson({ text: "" });
    return evalJson(this.page);
  }
}

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
      { id: "sidebar:Test%20fixture", title: "Test fixture" },
      { id: "sidebar:Another%20fixture", title: "Another fixture" },
    ]);
    expect(tools.actions.every(action => ["list_pages", "evaluate_script"].includes(action.name))).toBe(true);
    expect((await driver.getChat("sidebar:Test%20fixture"))?.title).toBe("Test fixture");
  });
  it("sends to exactly one known chat after a positive page identity check", async () => {
    const tools = new MockChromeTools();
    const driver = new ZaiCdpDriver(tools);
    await driver.listChats();
    await expect(driver.sendMessage({ chatId: "sidebar:Test%20fixture", text: "fixture-only" })).resolves.toEqual({});
    expect(tools.actions.map(x => x.name)).toContain("fill");
    expect(tools.actions.find(x => x.name === "fill")?.args.value).toBe("fixture-only");
    expect(tools.actions.at(-2)?.name).toBe("press_key");
    await expect(driver.sendMessage({ chatId: "sidebar:Unknown", text: "not allowed" })).rejects.toThrow(/not in/);
  });
  it("refuses duplicate names, unexpected origins, unknown page ids, and stale conversations", async () => {
    const duplicate = new MockChromeTools();
    duplicate.page = state("/", ["Duplicate", "Duplicate"]);
    const driver = new ZaiCdpDriver(duplicate);
    expect(await driver.listChats()).toHaveLength(0);
    const wrongId = new ZaiCdpDriver(duplicate, 99);
    await expect(wrongId.listChats()).rejects.toThrow(/Pinned/);
    const wrongOrigin = new MockChromeTools();
    wrongOrigin.page = { ...state(), origin: "https://fake.z.ai" };
    await expect(new ZaiCdpDriver(wrongOrigin).listChats()).rejects.toThrow(/not a logged-in/);
  });
});
