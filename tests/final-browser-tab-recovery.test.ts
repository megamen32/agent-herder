import { expect, it } from "vitest";
import { ChatGptMacCdpDriver, CHATGPT_MAC_SNAPSHOT } from "../src/adapters/chatgpt-mac-cdp-driver.js";
import { ZaiCdpDriver, ZAI_ACTIVITY_SCRIPT } from "../src/adapters/zai-cdp-driver.js";
import type { ChromePageTools } from "../src/adapters/mac-mini-chrome-transport.js";
import { openOwnedBlankChatPage } from "../src/adapters/browser-chat-new-page.js";
import { makeConfiguredAdapter } from "../src/ahap-browser-runner.js";

const json = (x: unknown) => "```json\n" + JSON.stringify(x) + "\n```";
const id = "123e4567-e89b-12d3-a456-426614174000";

it.each(["chatgpt", "zai"] as const)("%s finds its existing page after a process restart and gateway renumbering", async (provider) => {
  const origin = provider === "chatgpt" ? "https://chatgpt.com" : "https://chat.z.ai";
  let ownedId = 2;
  const snapshots: number[] = [];
  let opened = 0;
  const tools: ChromePageTools = { call: async (name, args = {}) => {
    if (name === "list_pages") return `1: Foreign (${origin}/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee) [selected]\n${ownedId}: Ours (${origin}/c/${id})`;
    if (name === "new_page") { opened++; throw new Error("existing owned tab must be reused"); }
    if (name !== "evaluate_script") throw new Error(`unexpected ${name}`);
    if (String(args.function).includes("herder-owned:")) return json({ owned: Number(args.pageId) === ownedId });
    if (args.function === CHATGPT_MAC_SNAPSHOT || args.function === ZAI_ACTIVITY_SCRIPT) {
      snapshots.push(Number(args.pageId));
      return json({ origin, path: `/c/${id}`, authenticated: true, loggedIn: true,
        composer: true, phase: "idle", draftPresent: false, titles: [], chats: [] });
    }
    return json({ scope: "a".repeat(64), chats: [], source: "passive" });
  } };
  const make = () => provider === "chatgpt" ? new ChatGptMacCdpDriver(tools, undefined, 0) : new ZaiCdpDriver(tools, undefined, 0);
  await make().listChats();
  ownedId = 20;
  await make().listChats();
  expect(snapshots).toEqual([2, 20]);
  expect(opened).toBe(0);
});

it("the production Z.ai wrapper verifies the recovered page rather than a stale configured number", async () => {
  const scope = "a".repeat(64);
  const authPages: number[] = [];
  const tools: ChromePageTools = { call: async (name, args = {}) => {
    if (name === "list_pages") return "17: Z.ai (https://chat.z.ai/?herder_owned=zai)";
    if (name === "evaluate_script" && String(args.function).includes("herder-owned:")) return json({ owned: true });
    if (name === "evaluate_script") {
      authPages.push(Number(args.pageId));
      if (args.pageId !== 17) throw new Error("No page found");
      return json({ scope, chats: [] });
    }
    throw new Error(`unexpected ${name}`);
  } };
  const adapter = makeConfiguredAdapter({ AHAP_HARNESS: "zai", AHAP_BROWSER_TRANSPORT: "mac-mini",
    AHAP_BROWSER_PAGE_ID: "9", AHAP_BROWSER_ACCOUNT_SCOPE: scope }, {
    macMini: () => tools, directCdp: () => { throw new Error("unexpected transport"); },
  });
  await adapter.verifyPinnedAccountScope?.();
  expect(authPages).toEqual([17]);
  expect(adapter.getAccountScope()).toBe(scope);
});

it("persists the ownership of a newly created blank before the site drops its URL marker", async () => {
  let created = false;
  let claimed = false;
  const tools: ChromePageTools = { call: async (name, args = {}) => {
    if (name === "list_pages") return created ? "10: Z.ai (https://chat.z.ai/?herder_owned=zai)" : "";
    if (name === "new_page") { created = true; return ""; }
    if (name === "evaluate_script") {
      if (String(args.function).includes("window.name =")) { claimed = true; return json({ owned: true }); }
      return json({ origin: "https://chat.z.ai", path: "/", ready: true, empty: true });
    }
    throw new Error(`unexpected ${name}`);
  } };
  expect(await openOwnedBlankChatPage(tools, "zai")).toBe(10);
  expect(claimed).toBe(true);
});
