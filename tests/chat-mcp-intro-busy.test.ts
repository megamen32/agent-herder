import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The busy-target park must be observable through an isolated deferred store,
// so the store path is chosen before the module under test is imported.
const cleanups: string[] = [];
const previousStore = process.env.AGENT_HERDER_DEFERRED_MESSAGES;

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agent-herder-intro-busy-"));
  cleanups.push(path);
  return realpath(path);
}

afterEach(async () => {
  for (const key of ["AGENT_HERDER_CHAT_INTRO_URL", "AGENT_HERDER_CHAT_INTRO_TOKEN", "AGENT_HERDER_CHAT_INTRO_HARNESSES", "AGENT_HERDER_CHAT_INTRO_TEMPLATE"]) {
    delete process.env[key];
  }
  if (previousStore === undefined) delete process.env.AGENT_HERDER_DEFERRED_MESSAGES;
  else process.env.AGENT_HERDER_DEFERRED_MESSAGES = previousStore;
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const BUSY = "prompt is already running; ZAI queue must wait";

async function loadModule(storePath: string) {
  process.env.AGENT_HERDER_DEFERRED_MESSAGES = storePath;
  vi.resetModules();
  return await import("../src/chat-mcp-intro-delivery.js");
}

describe("busy target parks the intro", () => {
  it("parks into the deferred inbox when the chat refuses input because it is generating", async () => {
    const cwd = await workspace();
    const storePath = join(cwd, "deferred.json");
    const mod = await loadModule(storePath);
    process.env.AGENT_HERDER_CHAT_INTRO_URL = "https://mcp.example/mcp";
    process.env.AGENT_HERDER_CHAT_INTRO_TOKEN = "gptk_shared";
    const supervisor = { sendMessage: vi.fn(async () => ({ ok: false, error: BUSY })) };
    const sent = await mod.deliverChatMcpIntroForSession(supervisor, "zai", "zai::route%3Abusy", "human");
    expect(sent).toBe(true);
    const stored = JSON.parse(await readFile(storePath, "utf8"));
    expect(stored.messages).toHaveLength(1);
    expect(stored.messages[0]).toMatchObject({ sessionId: "zai::route%3Abusy", harness: "zai" });
    expect(stored.messages[0].message).toContain("https://mcp.example/mcp");
    expect(stored.messages[0].message).toContain("gptk_shared");
    // The park is idempotent by text: a repeated trigger stays one intro.
    await mod.deliverChatMcpIntroForSession(supervisor, "zai", "zai::route%3Abusy", "human");
    const stored2 = JSON.parse(await readFile(storePath, "utf8"));
    expect(stored2.messages).toHaveLength(1);
  });

  it("parks when the send throws the busy error", async () => {
    const cwd = await workspace();
    const storePath = join(cwd, "deferred.json");
    const mod = await loadModule(storePath);
    process.env.AGENT_HERDER_CHAT_INTRO_URL = "https://mcp.example/mcp";
    process.env.AGENT_HERDER_CHAT_INTRO_TOKEN = "gptk_shared";
    const supervisor = { sendMessage: vi.fn(async () => { throw new Error(BUSY); }) };
    const sent = await mod.deliverChatMcpIntroForSession(supervisor, "zai", "zai::route%3Abusy2", "human");
    expect(sent).toBe(true);
    const stored = JSON.parse(await readFile(storePath, "utf8"));
    expect(stored.messages).toHaveLength(1);
  });

  it("does not park a non-busy refusal and logs it instead", async () => {
    const cwd = await workspace();
    const storePath = join(cwd, "deferred.json");
    const mod = await loadModule(storePath);
    process.env.AGENT_HERDER_CHAT_INTRO_URL = "https://mcp.example/mcp";
    process.env.AGENT_HERDER_CHAT_INTRO_TOKEN = "gptk_shared";
    const supervisor = { sendMessage: vi.fn(async () => ({ ok: false, error: "admission refused", nonRetryable: true })) };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const sent = await mod.deliverChatMcpIntroForSession(supervisor, "zai", "zai::route%3Arefused", "human");
      expect(sent).toBe(true);
      // No park happened, so the store file was never created.
      let stored: { messages: unknown[] } = { messages: [] };
      try { stored = JSON.parse(await readFile(storePath, "utf8")); } catch { /* absent by design */ }
      expect(stored.messages).toHaveLength(0);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("admission refused"));
    } finally {
      error.mockRestore();
    }
  });
});
