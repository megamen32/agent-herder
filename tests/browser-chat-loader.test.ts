import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBrowserChatAdapter } from "../src/adapters/browser-chat-loader.js";

let directory: string | null = null;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = null; });

describe("browser provider module loader", () => {
  it("adds a trusted local provider to the common harness without a special MCP tool", async () => {
    directory = await mkdtemp(join(tmpdir(), "herder-browser-provider-"));
    const module = join(directory, "fixture.mjs");
    await writeFile(module, `export async function createBrowserChatDriver() {
      return {
        listChats: async () => [{ id: "native", title: "ZAI test", unread: false, working: false, updatedAt: "2026-10-31T10:00:00Z" }],
        sendMessage: async () => ({ assistantText: "ok" }),
      };
    }`);
    const adapter = await loadBrowserChatAdapter(JSON.stringify([{ id: "zai", name: "ZAI", cwd: "/browser/zai", module }]));
    expect(adapter?.type).toBe("browser-chat");
    await adapter!.init();
    expect((await adapter!.listSessions())[0]).toMatchObject({
      id: "zai::native", harness: "browser-chat", cwd: "/browser/zai", meta: { browserProvider: "zai" },
    });
  });
  it("rejects nonlocal driver modules and duplicate providers before any browser use", async () => {
    await expect(loadBrowserChatAdapter(JSON.stringify([{ id: "zai", name: "ZAI", cwd: "/browser/zai", module: "https://invalid/" }]))).rejects.toThrow(/absolute local path/);
    await expect(loadBrowserChatAdapter(JSON.stringify([{ id: "zai", name: "ZAI", cwd: "/browser/zai", module: "/tmp/fixture" }, { id: "zai", name: "ZAI", cwd: "/browser/zai", module: "/tmp/fixture" }]))).rejects.toThrow(/Duplicate/);
  });
});
