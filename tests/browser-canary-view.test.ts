import { describe, expect, it, vi } from "vitest";
import { makeConfiguredAdapter } from "../src/ahap-browser-runner.js";
import { BrowserChatAdapter } from "../src/adapters/browser-chat.js";
import { ownedTabUrl } from "../src/adapters/browser-owned-tab.js";
const scope = "a".repeat(64), remote = "10000000-0000-4000-8000-000000000001";
const fence = (value: unknown) => "```json\n" + JSON.stringify(value) + "\n```";

function fixture(harness: "chatgpt" | "zai") {
  const origin = harness === "chatgpt" ? "https://chatgpt.com" : "https://chat.z.ai";
  const control = harness + "::draft%3Aoriginal-control";
  const page = { url: origin + "/", created: false, claimed: false, closed: false };
  const call = vi.fn(async (name: string, args: Record<string, unknown> = {}) => {
    if (name === "list_pages") return `1: Peer (${ownedTabUrl(origin, harness, scope)})` +
      (page.created && !page.closed ? `\n2: Own (${page.url})` : "");
    if (name === "new_page") { page.created = true; return "Vibe page opened: 2"; } // The site may remove the query before list_pages.
    if (name === "navigate_page") { expect(args.pageId).toBe(2); page.url = String(args.url); return "Successfully navigated page 2"; }
    if (name === "close_page") { expect(args.pageId).toBe(2); page.closed = true; return "Successfully closed page 2"; }
    if (name === "evaluate_script") {
      expect(args.pageId).toBe(2);
      const script = String(args.function);
      if (script.includes("try{window.name =")) { page.claimed = true; return fence({ owned: true }); }
      if (script.includes("window.name ===")) return fence({ owned: page.claimed });
      if (script.trimStart().startsWith("async") && /\/api\/(auth\/session|v1\/auths\/)/u.test(script)) return fence({ scope });
      return fence({ origin, path: new URL(page.url).pathname, url: page.url,
        authenticated: true, composer: true, phase: "idle", securityVerification: false });
    }
    throw Error("unexpected " + name);
  });
  const adapter = makeConfiguredAdapter({ AHAP_HARNESS: harness, AHAP_BROWSER_TRANSPORT: "vibe",
    AHAP_BROWSER_ACCOUNT_SCOPE: scope, AHAP_BROWSER_VIBE_TARGET: "mcp:shell:mac-mini-2012.lan:VibeMacMiniLocal",
    AHAP_BROWSER_VIBE_SESSION_ID: "session_1" }, {
    macMini() { throw Error("legacy not selected"); }, directCdp() { throw Error("CDP not selected"); }, vibe() { return { call }; },
  });
  const getSession = vi.spyOn(adapter, "getSession").mockResolvedValue({ id: control, harness, status: "idle", title: "canary", cwd: "/owned",
    lastActivity: "2026-11-09T00:00:00Z", needsPermission: false,
    meta: { sourceRoute: origin + "/c/" + remote, pendingRemoteCreation: false } });
  vi.spyOn(adapter, "getSessionMessages").mockResolvedValue([{ id: "native-message", role: "assistant", text: "OWN_TOKEN" }]);
  return { adapter, call, control, origin, getSession, page };
}

describe("independent owned canary view", () => {
  it.each(["chatgpt", "zai"] as const)("opens an authorized %s view of the maintained native conversation and closes only that view", async harness => {
    const f = fixture(harness);
    const receipt = await f.adapter.prepareCanaryObservation!(f.control);
    expect(receipt).toMatchObject({ native_session_id: f.control, native_conversation_id: remote, owned_page_id: 2,
      source_route: f.origin + "/c/" + remote, creation_receipt: "Vibe page opened: 2" });
    expect(f.getSession).toHaveBeenCalledWith(f.control);
    expect(f.call.mock.calls.filter(([name]) => name === "new_page")).toHaveLength(1);
    expect(f.call.mock.calls.filter(([name]) => name === "navigate_page")).toHaveLength(1);
    await expect(f.adapter.prepareCanaryObservation!(f.control)).resolves.toBe(receipt);
    const proof = await f.adapter.readCanaryObservation!(f.control);
    expect(proof.proof.owned_view_receipt).toBe(receipt);
    expect(await f.adapter.closeCanaryObservation!()).toMatchObject({ page_id: 2, closed: true });
    expect(f.call.mock.calls.some(([name]) => name === "fill")).toBe(false);
    await f.adapter.close?.();
  });

  it("rejects a foreign provider handle before opening any page", async () => {
    const f = fixture("chatgpt");
    await expect(f.adapter.prepareCanaryObservation!("zai::draft%3Aforeign")).rejects.toThrow("Browser session belongs to another provider");
    expect(f.call).not.toHaveBeenCalled();
  });

  it("never navigates to an arbitrary URL from metadata", async () => {
    const f = fixture("chatgpt");
    f.getSession.mockResolvedValueOnce({ id: f.control, harness: "chatgpt", status: "idle", title: "canary", cwd: "/owned",
      lastActivity: "2026-11-09T00:00:00Z", needsPermission: false,
      meta: { sourceRoute: "https://example.com/c/foreign", pendingRemoteCreation: false } });
    await expect(f.adapter.prepareCanaryObservation!(f.control)).rejects.toThrow("browser_canary_native_binding_unverified");
    expect(f.call.mock.calls.some(([name]) => name === "navigate_page")).toBe(false);
  });

  it("invalidates earlier idle proof before a send and requires a fresh terminal read before closing", async () => {
    const send = vi.spyOn(BrowserChatAdapter.prototype, "sendMessage").mockRejectedValueOnce(new Error("owned_test_unknown"));
    try {
      const f = fixture("zai");
      await f.adapter.prepareCanaryObservation!(f.control);
      await f.adapter.readCanaryObservation!(f.control);
      await expect(f.adapter.sendMessage(f.control, { message: "OWN_TOKEN", inputId: "owned-input" })).rejects.toThrow("owned_test_unknown");
      expect(send).toHaveBeenCalledTimes(1);
      await expect(f.adapter.closeCanaryObservation!()).rejects.toThrow("browser_canary_view_not_terminal");
      expect(f.call.mock.calls.some(([name]) => name === "close_page")).toBe(false);
      await f.adapter.readCanaryObservation!(f.control);
      await expect(f.adapter.closeCanaryObservation!()).resolves.toMatchObject({ page_id: 2, closed: true });
    } finally { send.mockRestore(); }
  });
});
