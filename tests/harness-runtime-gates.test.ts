import { mkdtemp, rm, writeFile } from "node:fs/promises";
import "./_harness-caps-bootstrap.js";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserTurnAutopilotObserver } from "../src/autopilot/browser-turn-observer.js";
import { BrowserChatAdapter, type BrowserChatDriver } from "../src/adapters/browser-chat.js";
import { BrowserChatHistoryCache } from "../src/adapters/browser-chat-history-cache.js";
import { runClaudeAutopilotHook } from "../src/claude-autopilot-hook.js";
import { setHarnessRuntimeSettingsPathForTests } from "../src/harness-runtime-settings.js";
import type { AgentSession, HarnessAdapter, HarnessType } from "../src/types/index.js";

let dir: string;
let settingsPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-runtime-gates-"));
  settingsPath = join(dir, "harness-runtime-settings.json");
  await writeFile(settingsPath, JSON.stringify({ version: 1, pollingEnabled: true }), "utf8");
  setHarnessRuntimeSettingsPathForTests(settingsPath);
});

afterEach(async () => {
  vi.useRealTimers();
  setHarnessRuntimeSettingsPathForTests(undefined);
  await rm(dir, { recursive: true, force: true });
});

async function pauseHarness(harness: string, pollingEnabled = false): Promise<void> {
  await writeFile(settingsPath, JSON.stringify({
    version: 1,
    pollingEnabled: true,
    harnesses: { [harness]: { pollingEnabled } },
  }), "utf8");
}

async function silenceHooks(harness: string): Promise<void> {
  await writeFile(settingsPath, JSON.stringify({
    version: 1,
    pollingEnabled: true,
    harnesses: { [harness]: { hooksEnabled: false } },
  }), "utf8");
}

function fakeAdapter(): { adapter: HarnessAdapter; listSessions: ReturnType<typeof vi.fn> } {
  const listSessions = vi.fn(async () => [
    {
      id: "route:s1",
      harness: "zai",
      status: "idle",
      title: "t",
      cwd: "/tmp/browser-wd",
      hostId: "h",
      lastActivity: new Date().toISOString(),
      needsPermission: false,
      meta: {},
    } as AgentSession,
  ]);
  return { adapter: { listSessions } as unknown as HarnessAdapter, listSessions };
}

describe("the browser turn observer obeys the runtime switch", () => {
  function observerFor(adapter: HarnessAdapter) {
    return new BrowserTurnAutopilotObserver({
      harnesses: ["zai"],
      adapters: new Map([["zai", adapter]]),
      supervisor: { sendMessage: async () => undefined },
      submit: vi.fn(),
      enabled: async () => true,
      held: async () => false,
      stallMs: 1_200_000,
      autoContinue: false,
      onError: vi.fn(),
    });
  }

  it("polls the inventory while the harness is running", async () => {
    const { adapter, listSessions } = fakeAdapter();
    await observerFor(adapter).observeOnce();
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it("still reads the passive inventory while the harness is paused", async () => {
    // The pause stops the requests the herder initiates, not the
    // observation: the adapter decides what a paused harness may answer
    // without a request of its own.
    const { adapter, listSessions } = fakeAdapter();
    await pauseHarness("zai");
    await observerFor(adapter).observeOnce();
    expect(listSessions).toHaveBeenCalledTimes(1);
  });
});

describe("the history cache obeys the runtime switch", () => {
  function makeCache(): { cache: BrowserChatHistoryCache; fetchMessages: ReturnType<typeof vi.fn> } {
    const fetchMessages = vi.fn(async () => null);
    const cache = new BrowserChatHistoryCache("chatgpt", fetchMessages, join(dir, "history"));
    cache.setAccountScope("a".repeat(64));
    return { cache, fetchMessages };
  }

  it("prewarms while the harness is running", async () => {
    const { cache, fetchMessages } = makeCache();
    cache.prewarm(["c1"]);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(fetchMessages).toHaveBeenCalled();
  });

  it("prewarms nothing while the harness is paused", async () => {
    const { cache, fetchMessages } = makeCache();
    await pauseHarness("chatgpt");
    cache.prewarm(["c1", "c2", "c3"]);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(fetchMessages).not.toHaveBeenCalled();
  });
});

describe("the browser chat adapter obeys the runtime switch", () => {
  function chatDriver() {
    const chats = [{
      id: "c1", title: "Chat 1", unread: false, working: false, updatedAt: new Date().toISOString(),
    }];
    return {
      driver: {
        listChats: vi.fn(async () => chats),
        getMessages: vi.fn(async () => null),
        getAccountScope: () => "b".repeat(64),
      } as unknown as BrowserChatDriver,
      listChats: undefined as unknown as ReturnType<typeof vi.fn>,
    };
  }

  function adapterOf(driver: BrowserChatDriver): BrowserChatAdapter {
    return new BrowserChatAdapter(driver, { id: "chatgpt", name: "ChatGPT test", harness: "chatgpt" as HarnessType, cwd: "/tmp/w" });
  }

  it("scans the site at startup while running and serves the cache while paused", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const built = chatDriver();
    built.listChats = built.driver.listChats as unknown as ReturnType<typeof vi.fn>;
    const adapter = adapterOf(built.driver);
    await adapter.init();
    expect(built.listChats).toHaveBeenCalledTimes(1);
    // The cached inventory ages past its TTL while the harness is paused: a
    // paused harness serves what it has and makes no list request.
    await pauseHarness("chatgpt");
    vi.setSystemTime(Date.now() + 120_000);
    const sessions = await adapter.listSessions();
    expect(sessions).toHaveLength(1);
    expect(built.listChats).toHaveBeenCalledTimes(1);
  });

  it("starts with an empty inventory and scans nothing while paused", async () => {
    const built = chatDriver();
    built.listChats = built.driver.listChats as unknown as ReturnType<typeof vi.fn>;
    await pauseHarness("chatgpt");
    const adapter = adapterOf(built.driver);
    await adapter.init();
    expect(built.listChats).not.toHaveBeenCalled();
    expect(await adapter.listSessions()).toEqual([]);
    expect(built.listChats).not.toHaveBeenCalled();
  });

  it("keeps revalidating a passive driver through the pause", async () => {
    // The ChatGPT driver answers from the intercept stash and its durable
    // inventory without one site request, so the paused harness keeps its
    // cache revalidation: the autopilot still sees finished turns.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const chats = [{
      id: "c1", title: "Chat 1", unread: false, working: false, updatedAt: new Date().toISOString(),
    }];
    const listChats = vi.fn(async () => chats);
    const driver = {
      listChats,
      getMessages: async () => null,
      getAccountScope: () => "b".repeat(64),
      passiveInventory: true,
    } as unknown as BrowserChatDriver;
    const adapter = adapterOf(driver);
    await pauseHarness("chatgpt");
    await adapter.init();
    expect(listChats).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 120_000);
    const sessions = await adapter.listSessions();
    expect(sessions).toHaveLength(1);
    expect(listChats).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe("the plugin hooks obey the runtime switch", () => {
  const input = { hook_event_name: "Stop" as const, session_id: "s1", cwd: "/tmp/x" };

  it("runs the Claude Stop hook while the harness is running", async () => {
    const runner = vi.fn(async () => ({}));
    await runClaudeAutopilotHook(input, runner);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("answers an empty decision and runs nothing while the harness is silent", async () => {
    await silenceHooks("claude");
    const runner = vi.fn(async () => ({}));
    const result = await runClaudeAutopilotHook(input, runner);
    expect(result).toEqual({});
    expect(runner).not.toHaveBeenCalled();
  });

  it("gates the codex Stop hook path on the same switch", async () => {
    const source = await readFile(fileURLToPath(new URL("../src/autopilot-hook.ts", import.meta.url)), "utf8");
    expect(source).toContain("liveHarnessHooksEnabled");
    const gateAt = source.indexOf('if (!liveHarnessHooksEnabled(input.harness ?? "codex"))');
    const runAt = source.indexOf("runAutopilotStopHook(input");
    expect(gateAt).toBeGreaterThan(-1);
    expect(runAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(runAt);
  });
});

describe("the ChatGPT modal-prompt poller obeys the runtime switch", () => {
  it("gates its poll cycle on the prompt-polling switch", async () => {
    const source = await readFile(fileURLToPath(new URL("../src/adapters/chatgpt-mac-cdp-driver.ts", import.meta.url)), "utf8");
    expect(source).toContain("liveHarnessPromptPollingEnabled");
    // The gate stands at the head of the poll cycle, before any CDP call.
    const gateAt = source.indexOf("if (!liveHarnessPromptPollingEnabled(");
    const pollAt = source.indexOf("private async pollOnce(): Promise<void> {");
    const inflightAt = source.indexOf("if (this.promptPollInFlight) return;");
    expect(gateAt).toBeGreaterThan(pollAt);
    expect(gateAt).toBeLessThan(inflightAt);
  });
});
