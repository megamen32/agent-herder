import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { filterVibeOwnedPages, makeConfiguredAdapter } from "../src/ahap-browser-runner.js";
import { ownedTabClaimScript, ownedTabMarker, ownedTabUrl, resolveOwnedTab } from "../src/adapters/browser-owned-tab.js";
import { MAC_MINI_VIBE_TARGET, VibeTransportError, vibeOwnershipNamespace } from "../src/adapters/vibe-chrome-transport.js";

const scope = "a".repeat(64);
const config = { target: MAC_MINI_VIBE_TARGET, sessionId: "session_1" };
const fence = (value: unknown) => "```json\n" + JSON.stringify(value) + "\n```";
const denial = (id: number) => new VibeTransportError("vibe_tool_refused", { content: [{ type: "text", text:
  `Error: tabId ${id} is not authorized for this session \u2014 only the tab this session started on, or tabs it opened itself, can be scripted` }] });

describe("explicit Vibe owned-page namespace", () => {
  it("normalizes defaults and distinguishes explicit browser bindings", () => {
    const namespace = vibeOwnershipNamespace(config);
    expect(namespace).toMatch(/^vibe-[a-f0-9]{64}$/u);
    expect(vibeOwnershipNamespace({ ...config, relayPort: 19888 })).toBe(namespace);
    expect(vibeOwnershipNamespace({ ...config, sessionId: "session_2" })).not.toBe(namespace);
    const isolated = { ...config, relayPort: 19898, relayStateDir: "/home/roomhacker/ci-vibe" };
    expect(vibeOwnershipNamespace(isolated)).not.toBe(namespace);
    expect(vibeOwnershipNamespace({ ...isolated, relayStateDir: "/home/roomhacker/./ci-vibe/" })).toBe(vibeOwnershipNamespace(isolated));
  });

  it("preserves legacy markers and never upgrades a legacy marker into a Vibe namespace", () => {
    const namespace = "vibe-" + "b".repeat(64);
    expect(ownedTabMarker("chatgpt", scope)).toBe("chatgpt:" + scope);
    expect(ownedTabMarker("chatgpt", scope, namespace)).toBe("chatgpt:" + scope + ":" + namespace);
    const window = { name: "herder-owned:chatgpt:" + scope };
    expect(runInNewContext(`(${ownedTabClaimScript("chatgpt", scope, namespace)})()`, { window })).toMatchObject({ owned: false });
    expect(window.name).toBe("herder-owned:chatgpt:" + scope);
  });

  it("does not probe known legacy or another namespace's marked pages", async () => {
    const call = vi.fn(async () => { throw Error("foreign page must not be scripted"); });
    const namespace = "vibe-" + "b".repeat(64);
    const tools = { call, ownedTabNamespace: namespace, ownedTabAccountScope: scope };
    const pages = [
      { id: 1, url: ownedTabUrl("https://chatgpt.com", "chatgpt", scope) },
      { id: 2, url: ownedTabUrl("https://chatgpt.com", "chatgpt", scope, "vibe-other") },
    ];
    expect(await resolveOwnedTab(tools, "chatgpt", pages, scope)).toBeUndefined();
    expect(call).not.toHaveBeenCalled();
  });

  it("only exposes exact marked or recovered owned pages to all driver branches", async () => {
    const namespace = "vibe-" + "b".repeat(64);
    const call = vi.fn(async (_name: string, args: Record<string, unknown> = {}) => {
      if (args.pageId === 4) throw denial(4);
      expect([2, 3]).toContain(args.pageId);
      expect(String(args.function)).toContain("window.name ===");
      expect(String(args.function)).not.toContain("fetch(");
      return fence({ owned: true });
    });
    const rows = [
      `1: Peer (${ownedTabUrl("https://chatgpt.com", "chatgpt", scope)})`,
      `2: Own (${ownedTabUrl("https://chatgpt.com", "chatgpt", scope, namespace)})`,
      "3: Current (https://chatgpt.com/c/current)",
      "4: Personal (https://chatgpt.com/c/private)",
      "5: Dashboard (https://chatgpt.com/dots/project)",
    ];
    expect(await filterVibeOwnedPages({ call }, rows.join("\n"), "chatgpt", scope, namespace)).toBe(rows.slice(1, 3).join("\n"));
    expect(call).toHaveBeenCalledTimes(3);
  });

  it.each([new VibeTransportError("vibe_mcp_outcome_unknown"), denial(99)])("does not turn an uncertain read or another tab's denial into an empty list", async error => {
    const call = vi.fn(async () => { throw error; });
    await expect(filterVibeOwnedPages({ call }, "4: Page (https://chatgpt.com/c/current)", "chatgpt", scope, "vibe-x")).rejects.toBe(error);
  });

  it("normalizes the documented browser-state envelope before comparing an exact ownership refusal", async () => {
    const error = denial(4);
    (error.receipt as { content: { text: string }[] }).content[0]!.text += "\n\n---\n# Current browser state:\nBrowser metadata follows";
    const call = vi.fn(async () => { throw error; });
    await expect(filterVibeOwnedPages({ call }, "4: Personal (https://chatgpt.com/c/private)", "chatgpt", scope, "vibe-x")).resolves.toBe("");
  });

  it.each(["chatgpt", "zai"] as const)("creates a fresh %s scoped page without adopting the peer's page", async harness => {
    const origin = harness === "chatgpt" ? "https://chatgpt.com" : "https://chat.z.ai";
    const namespace = vibeOwnershipNamespace(config);
    let createdUrl: string | undefined;
    const call = vi.fn(async (name: string, args: Record<string, unknown> = {}) => {
      if (name === "list_pages") return `1: Peer (${ownedTabUrl(origin, harness, scope)})` +
        (createdUrl ? `\n2: Own (${createdUrl})` : "");
      if (name === "new_page") { createdUrl = String(args.url); return "Vibe page opened: 2"; }
      if (name === "evaluate_script") {
        expect(args.pageId).toBe(2);
        if (String(args.function).includes("origin:location.origin")) return fence({ origin });
        if (String(args.function).includes("window.name =")) return fence({ owned: true });
        if (/\/api\/(auth\/session|v1\/auths\/)/u.test(String(args.function))) return fence({ scope });
      }
      throw Error("unexpected " + name);
    });
    const adapter = makeConfiguredAdapter({ AHAP_HARNESS: harness, AHAP_BROWSER_TRANSPORT: "vibe",
      AHAP_BROWSER_ACCOUNT_SCOPE: scope, AHAP_BROWSER_VIBE_TARGET: config.target,
      AHAP_BROWSER_VIBE_SESSION_ID: config.sessionId }, {
      macMini() { throw Error("legacy not selected"); }, directCdp() { throw Error("CDP not selected"); }, vibe() { return { call }; },
    });
    await adapter.verifyPinnedAccountScope!();
    expect(createdUrl).toBe(ownedTabUrl(origin, harness, scope, namespace));
    expect(adapter.getOwnedPageNamespace!()).toBe(namespace);
    expect(call.mock.calls.filter(([name]) => name === "new_page")).toHaveLength(1);
    await adapter.close?.();
  });
});
