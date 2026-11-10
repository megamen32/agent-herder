import { describe, expect, it, vi } from "vitest";
import { makeConfiguredAdapter, readBrowserCanaryObservation } from "../src/ahap-browser-runner.js";
import { browserChatNativeId } from "../src/adapters/browser-chat.js";
import { ownedTabUrl } from "../src/adapters/browser-owned-tab.js";
import { CHATGPT_CREATE_SCOPE_SCRIPT, ZAI_CURRENT_ACCOUNT_SCOPE_SCRIPT } from "../src/adapters/browser-chat-new-page.js";

const scope = "a".repeat(64), nativeId = "10000000-0000-4000-8000-000000000001";
const fence = (value: unknown) => "```json\n" + JSON.stringify(value) + "\n```";

function fixture(harness: "chatgpt" | "zai" = "chatgpt", draft = false) {
  const origin = harness === "chatgpt" ? "https://chatgpt.com" : "https://chat.z.ai";
  const id = harness + "::" + encodeURIComponent(draft ? "draft:stable-control-handle" : harness === "chatgpt" ? nativeId : "route:" + nativeId);
  const marked = new URL(ownedTabUrl(origin, harness, scope));
  marked.pathname = "/c/" + nativeId;
  const url = marked.toString();
  const state = { origin, path: "/c/" + nativeId, url, phase: "idle", authenticated: true, composer: true, securityVerification: false };
  const call = vi.fn(async (name: string) => name === "list_pages" ? `71: Own (${url})` : fence(state));
  const getSession = vi.fn(async () => ({ id, harness, status: "running", name: "canary", cwd: "/owned",
    meta: { sourceRoute: origin + "/c/" + nativeId, pendingRemoteCreation: false } }));
  const getSessionMessages = vi.fn(async () => [
    { role: "assistant", text: "FIRST_OWNED_TOKEN", timestamp: "2026-11-09T00:00:00Z" },
    { role: "assistant", text: "SECOND_OWNED_TOKEN", timestamp: "2026-11-09T00:00:01Z" },
  ]);
  const verifyAccount = vi.fn(async () => scope);
  const options = { harness, nativeSessionId: id, accountScope: scope, tools: { call },
    adapter: { getSession, getSessionMessages }, verifyAccount } as unknown as Parameters<typeof readBrowserCanaryObservation>[0];
  return { options, call, state, getSession, getSessionMessages, verifyAccount };
}

describe("owned browser canary observation", () => {
  it("exposes a separate proof API on the configured production adapter", () => {
    const adapter = makeConfiguredAdapter({
      AHAP_HARNESS: "chatgpt", AHAP_BROWSER_TRANSPORT: "vibe", AHAP_BROWSER_ACCOUNT_SCOPE: "a".repeat(64),
      AHAP_BROWSER_VIBE_TARGET: "mac-mini", AHAP_BROWSER_VIBE_SESSION_ID: "session_1",
    }, {
      macMini() { throw Error("legacy not selected"); }, directCdp() { throw Error("CDP not selected"); },
      vibe() { return { async call() { throw Error("test never connects"); } }; },
    });
    expect((adapter as unknown as { readCanaryObservation?: unknown }).readCanaryObservation).toBeTypeOf("function");
  });

  it.each(["chatgpt", "zai"] as const)("uses %s canonical messages and the current DOM instead of inventory heuristics", async harness => {
    const f = fixture(harness);
    const observation = await readBrowserCanaryObservation(f.options);
    expect(observation.complete).toBe(true);
    expect(observation.session.status).toBe("idle"); // The fixture's cached inventory said running.
    expect(observation.proof).toMatchObject({ capability: "owned-current-conversation", account_scope_sha256: scope,
      native_session_id: f.options.nativeSessionId, owned_page_id: 71, canonical_status: "idle" });
    expect(observation.proof.native_messages_receipt.messages).toHaveLength(2);
    expect(observation.proof.dom_generation_state_receipt.raw.phase).toBe("idle");
    expect(f.verifyAccount).toHaveBeenCalledTimes(2);
    expect(f.verifyAccount).toHaveBeenNthCalledWith(1, 71);
    expect(f.verifyAccount).toHaveBeenNthCalledWith(2, 71);
    expect(f.getSessionMessages).toHaveBeenCalledExactlyOnceWith(f.options.nativeSessionId, 200);
    expect(f.call.mock.calls.every(([name]) => name === "list_pages" || name === "evaluate_script")).toBe(true);
  });

  it("refuses a missing owned page before any account helper can create or select one", async () => {
    const f = fixture();
    f.call.mockResolvedValueOnce("");
    await expect(readBrowserCanaryObservation(f.options)).rejects.toThrow("browser_canary_owned_page_unavailable");
    expect(f.verifyAccount).not.toHaveBeenCalled();
    expect(f.getSession).not.toHaveBeenCalled();
  });

  it("rejects the wrong current route before requesting canonical messages", async () => {
    const f = fixture();
    f.state.path = "/c/different-conversation";
    await expect(readBrowserCanaryObservation(f.options)).rejects.toThrow("browser_canary_current_conversation_mismatch");
    expect(f.getSessionMessages).not.toHaveBeenCalled();
  });

  it.each(["chatgpt", "zai"] as const)("resolves the accepted %s native conversation while preserving the original control handle", async harness => {
    const f = fixture(harness, true);
    const observation = await readBrowserCanaryObservation(f.options);
    expect(observation.session.id).toBe(f.options.nativeSessionId);
    expect(observation.proof.native_session_id).toBe(f.options.nativeSessionId);
    expect(observation.proof.native_conversation_id).toBe(nativeId);
    expect(f.getSessionMessages).toHaveBeenCalledExactlyOnceWith(f.options.nativeSessionId, 200);
  });

  it("refuses unknown DOM generation state without falling back to native async_status", async () => {
    const f = fixture();
    f.state.phase = "unknown";
    await expect(readBrowserCanaryObservation(f.options)).rejects.toThrow("browser_canary_dom_state_unverified");
    expect(f.getSession).not.toHaveBeenCalled();
  });

  it("does not return messages if the account changed during the read", async () => {
    const f = fixture();
    f.verifyAccount.mockResolvedValueOnce(scope).mockResolvedValueOnce("b".repeat(64));
    await expect(readBrowserCanaryObservation(f.options)).rejects.toThrow("browser_canary_account_mismatch");
  });

  it("rejects a foreign provider through the adapter's existing ID parser", async () => {
    const f = fixture();
    f.options.nativeSessionId = "zai::route%3Aforeign";
    await expect(readBrowserCanaryObservation(f.options)).rejects.toThrow("Browser session belongs to another provider");
    expect(f.verifyAccount).not.toHaveBeenCalled();
    expect(browserChatNativeId(nativeId, "zai", true)).toBe("route:" + nativeId);
  });

  it("verifies each account without fetching a conversation history", () => {
    expect(CHATGPT_CREATE_SCOPE_SCRIPT).toContain("/api/auth/session");
    expect(ZAI_CURRENT_ACCOUNT_SCOPE_SCRIPT).toContain("/api/v1/auths/");
    expect(ZAI_CURRENT_ACCOUNT_SCOPE_SCRIPT).not.toContain("/chats/");
  });
});
