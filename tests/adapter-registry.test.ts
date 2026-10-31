import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdapterRegistry } from "../src/adapter-registry.js";
import type { HarnessAdapter } from "../src/types/index.js";

function fakeAdapter(id: string, initError?: string): HarnessAdapter {
  return {
    type: id as HarnessAdapter["type"], name: id, controlCapabilities: { modelSwitch: true },
    async init() { if (initError) throw new Error(initError); },
    async listSessions() { return []; },
    async getSession() { return null; },
    async sendMessage() { return { ok: true }; },
    async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; },
    async setPermissions() { return { ok: true }; },
  };
}

describe("adapter registry", () => {
  it("adds an adapter only after init succeeds and persists the choice", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-registry-"));
    const adapters = new Map<string, HarnessAdapter>();
    const registry = new AdapterRegistry(adapters, join(root, "adapters.json"));
    registry.register({ id: "codex", name: "Codex", description: "test", defaultEnabled: false, factory: () => fakeAdapter("codex") });

    const result = await registry.setEnabled("codex", true);
    expect(result).toMatchObject({ id: "codex", enabled: true, active: true, status: "active" });
    expect(adapters.has("codex")).toBe(true);
    expect(JSON.parse(await readFile(join(root, "adapters.json"))).enabled.codex).toBe(true);
  });

  it("reports a failed init without activating the adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-registry-"));
    const adapters = new Map<string, HarnessAdapter>();
    const registry = new AdapterRegistry(adapters, join(root, "adapters.json"));
    registry.register({ id: "zcode", name: "ZCode", description: "test", defaultEnabled: false, factory: () => fakeAdapter("zcode", "offline") });

    const result = await registry.setEnabled("zcode", true);
    expect(result).toMatchObject({ id: "zcode", enabled: false, active: false, status: "error", error: "offline" });
    expect(adapters.has("zcode")).toBe(false);
  });
});

describe("provider-specific browser adapter cards", () => {
  it("reports two separate site capability sets and does not aggregate them", async () => {
    const { BrowserChatAdapter } = await import("../src/adapters/browser-chat.js");
    const root = await mkdtemp(join(tmpdir(), "browser-registry-"));
    const adapters = new Map<string, HarnessAdapter>();
    const registry = new AdapterRegistry(adapters, join(root, "adapters.json"));
    const browser = (id: "chatgpt" | "zai", nativeConversationIds: boolean) =>
      new BrowserChatAdapter({
        listChats: async () => [],
        sendMessage: async () => ({}),
        browserFeatures: {
          nativeConversationIds, accountArchiveViaCdp: id === "chatgpt",
          queueAfterGeneration: true, chatCreation: false,
        },
      }, { id, name: id, cwd: "/browser/" + id, harness: id });
    const chatgpt = browser("chatgpt",true);
    const zai = browser("zai",false);
    registry.register({id:"chatgpt",name:"ChatGPT",description:"site",defaultEnabled:true});
    registry.register({id:"zai",name:"Z.ai",description:"site",defaultEnabled:true});
    registry.registerActive(chatgpt);
    registry.registerActive(zai);
    const items = registry.list().filter(x=>["chatgpt","zai"].includes(x.id));
    expect(items).toHaveLength(2);
    expect(items.find(x=>x.id==="chatgpt")).toMatchObject({
      name:"ChatGPT",active:true,browserFeatures:{nativeConversationIds:true,accountArchiveViaCdp:true},
    });
    expect(items.find(x=>x.id==="zai")).toMatchObject({
      name:"Z.ai",active:true,browserFeatures:{nativeConversationIds:false,accountArchiveViaCdp:false},
    });
    expect(adapters.has("browser-chat")).toBe(false);
  });
});
