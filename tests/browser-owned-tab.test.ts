import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import {
  isOwnedTabUrl,
  isProviderOwnedTabUrl,
  ownedTabClaimScript,
  ownedTabProbeScript,
  ownedTabUrl,
  ownedTabWindowName,
  resolveOwnedTab,
} from "../src/adapters/browser-owned-tab.js";

describe("owned browser tab marker", () => {
  it("marks one tab per provider and recognizes only its own marker", () => {
    expect(ownedTabUrl("https://chatgpt.com", "chatgpt")).toBe("https://chatgpt.com/?herder_owned=chatgpt");
    expect(isOwnedTabUrl("https://chatgpt.com/?herder_owned=chatgpt", "chatgpt")).toBe(true);
    expect(isOwnedTabUrl("https://chatgpt.com/?herder_owned=zai", "chatgpt")).toBe(false);
    expect(isOwnedTabUrl("https://chatgpt.com/c/6ada477c-7014-83ed-82ae-7881dbe3e109", "chatgpt")).toBe(false);
  });

  it("recognizes legacy, account and worker markers without treating human tabs as owned", () => {
    const account="a".repeat(64);
    expect(isProviderOwnedTabUrl("https://chatgpt.com/?herder_owned=chatgpt","chatgpt")).toBe(true);
    expect(isProviderOwnedTabUrl(ownedTabUrl("https://chatgpt.com","chatgpt",account),"chatgpt")).toBe(true);
    expect(isProviderOwnedTabUrl(ownedTabUrl("https://chatgpt.com","chatgpt",account,"worker"),"chatgpt")).toBe(true);
    expect(isProviderOwnedTabUrl("https://chatgpt.com/?herder_owned=zai","chatgpt")).toBe(false);
    expect(isProviderOwnedTabUrl("https://chatgpt.com/","chatgpt")).toBe(false);
  });

  it("keeps ownership in the page itself when the site drops the URL marker", () => {
    expect(ownedTabWindowName("chatgpt")).toBe("herder-owned:chatgpt");
    const probe = runInNewContext("(" + ownedTabProbeScript("chatgpt") + ")()", {
      window: { name: "herder-owned:chatgpt" },
    }) as { owned: boolean };
    expect(probe.owned).toBe(true);
    const foreign = runInNewContext("(" + ownedTabProbeScript("chatgpt") + ")()", {
      window: { name: "" },
    }) as { owned: boolean };
    expect(foreign.owned).toBe(false);
  });

  it("claims the tab it owns in the page itself", () => {
    const scope: { name: string } = { name: "" };
    const result = runInNewContext("(" + ownedTabClaimScript("chatgpt") + ")()", {
      window: scope,
      globalThis: {},
    }) as { owned: boolean };
    expect(result.owned).toBe(true);
    expect(scope.name).toBe("herder-owned:chatgpt");
  });

  it("finds its own tab by the page marker even when the URL marker is gone", async () => {
    const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
    const tools = { call: async (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args });
      if (name === "evaluate_script") return "Script ran on page and returned:\n```json\n{\"owned\":true}\n```";
      throw new Error("unexpected action " + name);
    } };
    const owned = await resolveOwnedTab(tools, "chatgpt", [
      { id: 7, url: "https://chatgpt.com/c/6ada477c-7014-83ed-82ae-7881dbe3e109" },
      { id: 9, url: "https://chatgpt.com/" },
    ]);
    expect(owned?.id).toBe(7);
    expect(calls[0]?.args?.pageId).toBe(7);
  });

  it("prefers the URL-marked tab without asking the page", async () => {
    const tools = { call: async () => { throw new Error("must not probe a marked tab"); } };
    const owned = await resolveOwnedTab(tools, "chatgpt", [
      { id: 7, url: "https://chatgpt.com/?herder_owned=chatgpt" },
      { id: 9, url: "https://chatgpt.com/" },
    ]);
    expect(owned?.id).toBe(7);
  });
});


it("does not confuse two account markers or overwrite another account's ownership", async () => {
  const a = "a".repeat(64), b = "b".repeat(64);
  const foreign = { name: ownedTabWindowName("chatgpt", b) };
  const result = runInNewContext("(" + ownedTabClaimScript("chatgpt", a) + ")()", { window: foreign });
  expect(result.owned).toBe(false);
  expect(foreign.name).toBe(ownedTabWindowName("chatgpt", b));
  const tools = { call: async () => { throw Error("must resolve exact URL marker"); } };
  const pages = [{ id: 1, url: ownedTabUrl("https://chatgpt.com", "chatgpt", a) },
    { id: 2, url: ownedTabUrl("https://chatgpt.com", "chatgpt", b) }];
  expect((await resolveOwnedTab(tools, "chatgpt", pages, b))?.id).toBe(2);
  await expect(resolveOwnedTab(tools, "chatgpt", [pages[0]!, { ...pages[0]!, id: 3 }], a))
    .rejects.toThrow("duplicate_owned_browser_tabs");
});
