import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserChatDraftStore } from "../src/adapters/browser-chat-drafts.js";
import { ZaiCdpDriver } from "../src/adapters/zai-cdp-driver.js";
import { ownedTabUrl } from "../src/adapters/browser-owned-tab.js";

const scope = "a".repeat(64), remote = "10000000-0000-4000-8000-000000000001";
const fence = (value: unknown) => "```json\n" + JSON.stringify(value) + "\n```";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "herder-zai-durable-read-"));
  vi.stubEnv("AGENT_HERDER_BROWSER_DRAFT_ROOT", root);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const store = new BrowserChatDraftStore("zai", root);
  await store.useScope(scope);
  const draft = await store.create("owned canary");
  await store.startSend(draft.id);
  await store.admit(draft.id, "route:" + remote);
  let actualScope = scope;
  const call = vi.fn(async (name: string, args: Record<string, unknown> = {}) => {
    if (name === "list_pages") return `2: Own (${ownedTabUrl("https://chat.z.ai", "zai", scope, "vibe-test")})`;
    if (name !== "evaluate_script" || args.pageId !== 2) throw Error("unexpected_browser_effect");
    const script = String(args.function);
    if (script.includes("window.name")) return fence({ owned: true });
    if (script.includes("/api/v1/auths/")) return fence({ scope: actualScope });
    if (script.includes("/api/v1/chats/") && script.includes(remote)) {
      return fence({ messages: [{ id: "reply", role: "assistant", text: "OWN_TOKEN" }] });
    }
    throw Error("unrelated_history_scan_forbidden");
  });
  const driver = new ZaiCdpDriver({ call, ownedTabNamespace: "vibe-test", ownedTabAccountScope: scope }, undefined, 0);
  await driver.verifyPinnedAccountScope(scope);
  return { driver, call, draft, changeAccount() { actualScope = "b".repeat(64); } };
}

describe("Zai durable draft reads in a fresh driver", () => {
  it("resolves the admitted original handle without an account history scan or ID replacement", async () => {
    const f = await fixture();
    await expect(f.driver.getChat(f.draft.id)).resolves.toMatchObject({ id: f.draft.id,
      pendingRemoteCreation: false, sourceRoute: "https://chat.z.ai/c/" + remote });
    expect(f.call.mock.calls.every(([name]) => name === "list_pages" || name === "evaluate_script")).toBe(true);
  });

  it("reads the exact admitted conversation messages in a fresh process", async () => {
    const f = await fixture();
    await expect(f.driver.getMessages(f.draft.id)).resolves.toMatchObject([{ id: "reply", role: "assistant", text: "OWN_TOKEN" }]);
  });

  it("fails before loading an old draft when the pinned account changed", async () => {
    const f = await fixture();
    f.changeAccount();
    await expect(f.driver.getChat(f.draft.id)).rejects.toThrow("pinned browser account scope mismatch");
  });
});
