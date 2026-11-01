import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatMcpIntroConfig,
  chatMcpIntroInputId,
  chatMcpIntroMessage,
  deliverChatMcpIntroForSession,
} from "../src/chat-mcp-intro-delivery.js";

// Focused unit tests for the owner-configured MCP intro of new chats.
// Expected <1s per case; no production MCP/model/session operations.
const envKeys = [
  "AGENT_HERDER_CHAT_INTRO_URL",
  "AGENT_HERDER_CHAT_INTRO_TOKEN",
  "AGENT_HERDER_CHAT_INTRO_HARNESSES",
  "AGENT_HERDER_CHAT_INTRO_TEMPLATE",
] as const;

beforeEach(() => {
  for (const key of envKeys) delete process.env[key];
});

afterEach(() => {
  for (const key of envKeys) delete process.env[key];
});

function fakeSupervisor(sendMessage = vi.fn(async () => ({ ok: true }))) {
  return { sendMessage };
}

describe("chatMcpIntroConfig", () => {
  it("is disabled until the owner sets both url and token", async () => {
    expect(await chatMcpIntroConfig()).toBeNull();
    process.env.AGENT_HERDER_CHAT_INTRO_URL = "https://mcp.example/mcp";
    expect(await chatMcpIntroConfig()).toBeNull();
    process.env.AGENT_HERDER_CHAT_INTRO_TOKEN = "gptk_shared";
    const config = await chatMcpIntroConfig();
    expect(config?.url).toBe("https://mcp.example/mcp");
    expect(config?.token).toBe("gptk_shared");
  });

  it("defaults to zai and parses a comma-separated harness list", async () => {
    process.env.AGENT_HERDER_CHAT_INTRO_URL = "https://mcp.example/mcp";
    process.env.AGENT_HERDER_CHAT_INTRO_TOKEN = "gptk_shared";
    expect((await chatMcpIntroConfig())?.harnesses).toEqual(["zai"]);
    process.env.AGENT_HERDER_CHAT_INTRO_HARNESSES = "zai, chatgpt ,";
    expect((await chatMcpIntroConfig())?.harnesses).toEqual(["zai", "chatgpt"]);
  });

  it("ignores a harness list that is empty after trimming", async () => {
    process.env.AGENT_HERDER_CHAT_INTRO_URL = "https://mcp.example/mcp";
    process.env.AGENT_HERDER_CHAT_INTRO_TOKEN = "gptk_shared";
    process.env.AGENT_HERDER_CHAT_INTRO_HARNESSES = " , ";
    expect(await chatMcpIntroConfig()).toBeNull();
  });

  it("resolves a write-only marker through the secret store and stays off when the store has no value", async () => {
    process.env.AGENT_HERDER_CHAT_INTRO_URL = "https://mcp.example/mcp";
    process.env.AGENT_HERDER_CHAT_INTRO_TOKEN = "sha256:0123456789abcdef";
    const reader = { readSecret: vi.fn(async () => "gptk_resolved") };
    const config = await chatMcpIntroConfig(reader);
    expect(reader.readSecret).toHaveBeenCalledWith("AGENT_HERDER_CHAT_INTRO_TOKEN");
    expect(config?.token).toBe("gptk_resolved");
    const empty = { readSecret: vi.fn(async () => undefined) };
    expect(await chatMcpIntroConfig(empty)).toBeNull();
  });

  it("uses a raw environment value as is without touching the secret store", async () => {
    process.env.AGENT_HERDER_CHAT_INTRO_URL = "https://mcp.example/mcp";
    process.env.AGENT_HERDER_CHAT_INTRO_TOKEN = "gptk_raw";
    const reader = { readSecret: vi.fn(async () => "gptk_resolved") };
    expect((await chatMcpIntroConfig(reader))?.token).toBe("gptk_raw");
    expect(reader.readSecret).not.toHaveBeenCalled();
  });
});

describe("chatMcpIntroMessage", () => {
  it("substitutes the shared url and token into the default template", async () => {
    process.env.AGENT_HERDER_CHAT_INTRO_URL = "https://mcp.example/mcp";
    process.env.AGENT_HERDER_CHAT_INTRO_TOKEN = "gptk_shared";
    const config = (await chatMcpIntroConfig())!;
    const message = chatMcpIntroMessage(config, "zai", "zai::route%3Aabc");
    expect(message).toContain("https://mcp.example/mcp");
    expect(message).toContain("gptk_shared");
    expect(message).not.toContain("{url}");
    expect(message).not.toContain("{token}");
    expect(message).not.toContain("{harness}");
    expect(message).not.toContain("{sessionId}");
  });

  it("uses the owner template when one is set", async () => {
    process.env.AGENT_HERDER_CHAT_INTRO_URL = "https://mcp.example/mcp";
    process.env.AGENT_HERDER_CHAT_INTRO_TOKEN = "gptk_shared";
    process.env.AGENT_HERDER_CHAT_INTRO_TEMPLATE = "connect {url} with {token} for {sessionId} on {harness}";
    const config = (await chatMcpIntroConfig())!;
    expect(chatMcpIntroMessage(config, "zai", "s1")).toBe(
      "connect https://mcp.example/mcp with gptk_shared for s1 on zai",
    );
  });
});

describe("deliverChatMcpIntroForSession", () => {
  it("sends exactly one fire-and-forget intro with a stable inputId", async () => {
    process.env.AGENT_HERDER_CHAT_INTRO_URL = "https://mcp.example/mcp";
    process.env.AGENT_HERDER_CHAT_INTRO_TOKEN = "gptk_shared";
    const supervisor = fakeSupervisor();
    const sent = await deliverChatMcpIntroForSession(supervisor, "zai", "zai::route%3Aabc", "human");
    expect(sent).toBe(true);
    expect(supervisor.sendMessage).toHaveBeenCalledTimes(1);
    const [harness, sessionId, options] = supervisor.sendMessage.mock.calls[0];
    expect(harness).toBe("zai");
    expect(sessionId).toBe("zai::route%3Aabc");
    expect(options.inputId).toBe(chatMcpIntroInputId("zai", "zai::route%3Aabc"));
    expect(options.origin).toBe("human");
    expect(options.queue).toBe(true);
    expect(options.message).toContain("gptk_shared");
  });

  it("does not send for a harness outside the configured list", async () => {
    process.env.AGENT_HERDER_CHAT_INTRO_URL = "https://mcp.example/mcp";
    process.env.AGENT_HERDER_CHAT_INTRO_TOKEN = "gptk_shared";
    const supervisor = fakeSupervisor();
    expect(await deliverChatMcpIntroForSession(supervisor, "chatgpt", "c1", "human")).toBe(false);
    expect(supervisor.sendMessage).not.toHaveBeenCalled();
  });

  it("does not send when the feature is disabled", async () => {
    const supervisor = fakeSupervisor();
    expect(await deliverChatMcpIntroForSession(supervisor, "zai", "s1", "human")).toBe(false);
    expect(supervisor.sendMessage).not.toHaveBeenCalled();
  });

  it("reports a refused send but never throws", async () => {
    process.env.AGENT_HERDER_CHAT_INTRO_URL = "https://mcp.example/mcp";
    process.env.AGENT_HERDER_CHAT_INTRO_TOKEN = "gptk_shared";
    const supervisor = fakeSupervisor(vi.fn(async () => ({ ok: false, error: "admission refused" })));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await deliverChatMcpIntroForSession(supervisor, "zai", "s1", "automation")).toBe(true);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("admission refused"));
    } finally {
      error.mockRestore();
    }
  });
});
