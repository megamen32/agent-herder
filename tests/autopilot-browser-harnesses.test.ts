import { mkdtemp, rm } from "node:fs/promises";
import "./_harness-caps-bootstrap.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutopilotSessionStore } from "../src/autopilot/session-store.js";
import {
  createDefaultAutopilotPolicy,
  effectivePolicyAllowsTarget,
  type AutopilotHarness,
  type AutopilotPolicy,
  type EffectivePolicy,
} from "../src/autopilot/policy.js";
import { goalControllerAdmission } from "../src/autopilot/goal-controller-admission.js";
import { BackgroundAutopilotStop } from "../src/autopilot/background-stop.js";
import { BrowserTurnAutopilotObserver } from "../src/autopilot/browser-turn-observer.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";
import type { HerderJobRegistry } from "../src/herder-jobs.js";

// Focused unit tests for Autopilot on the browser chat harnesses (Z.ai,
// ChatGPT) and the browser autocontinue watchdog. Expected <1s per case; no
// production MCP/model/session operations.

function fakeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "zai::abc",
    harness: "zai",
    status: "idle",
    title: "t",
    cwd: "/tmp/browser-wd",
    hostId: "h",
    lastActivity: new Date("2026-11-01T10:00:00Z").toISOString(),
    needsPermission: false,
    meta: {},
    ...overrides,
  } as AgentSession;
}

function policyFor(harnesses: AutopilotHarness[]): EffectivePolicy {
  const policy: AutopilotPolicy = { ...createDefaultAutopilotPolicy(), enabled: true, harnesses };
  return { policy, source: "persisted", revision: "r-test", coverage: "enabled-harnesses" };
}

describe("browser harnesses in the autopilot unions", () => {
  it("keeps zai and chatgpt in the default policy harness list", () => {
    const harnesses = createDefaultAutopilotPolicy().harnesses;
    expect(harnesses).toContain("zai");
    expect(harnesses).toContain("chatgpt");
  });

  it("lets the policy decide zai sessions", () => {
    const effective = policyFor(["zai", "chatgpt"]);
    expect(effectivePolicyAllowsTarget(effective, { harness: "zai", sessionId: "s1", cwd: "/tmp/w" })).toBe(true);
    expect(effectivePolicyAllowsTarget(effective, { harness: "chatgpt", sessionId: "s2", cwd: "/tmp/w" })).toBe(true);
  });

  it("stores per-session switches for zai and chatgpt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ap-store-"));
    try {
      const store = new AutopilotSessionStore(join(dir, "sessions.json"));
      await store.set({ harness: "zai", sessionId: "s1", cwd: "/tmp/w" }, true);
      await store.set({ harness: "chatgpt", sessionId: "s2", cwd: "/tmp/w" }, false);
      expect((await store.get("zai", "s1"))?.enabled).toBe(true);
      expect((await store.get("chatgpt", "s2"))?.enabled).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("admits browser chats as goal controllers like opencode and zcode", async () => {
    expect((await goalControllerAdmission(fakeSession({ harness: "zai" }))).allowed).toBe(true);
    expect((await goalControllerAdmission(fakeSession({ harness: "chatgpt" }))).allowed).toBe(true);
  });

  it("accepts a durable Stop submission for a browser harness and rejects unknown ones", () => {
    const start = vi.fn(() => ({}));
    const jobs = { get: () => undefined, start } as unknown as HerderJobRegistry;
    const stop = new BackgroundAutopilotStop({
      jobs,
      adapters: new Map(),
      evaluate: async () => ({}),
      held: async () => false,
      allowed: async () => true,
      deliver: async () => ({}),
    });
    expect(() => stop.submit({
      harness: "zai", sessionId: "s1", cwd: "/tmp/browser-wd", turnId: "browser:abc",
    } as never)).not.toThrow();
    expect(start).toHaveBeenCalledTimes(1);
    expect(() => stop.submit({
      harness: "browser-chat", sessionId: "s1", cwd: "/tmp/browser-wd", turnId: "browser:abc",
    } as never)).toThrow();
  });
});

describe("BrowserTurnAutopilotObserver", () => {
  function harness(overrides: {
    sessions?: AgentSession[];
    messages?: unknown;
    enabled?: (input: { sessionId: string }) => Promise<boolean>;
    held?: (harness: string, sessionId: string) => Promise<boolean>;
    sendMessage?: ReturnType<typeof vi.fn>;
    submit?: ReturnType<typeof vi.fn>;
    stallMs?: number;
    autoContinue?: boolean;
  } = {}) {
    const listSessions = vi.fn(async () => overrides.sessions ?? []);
    const getSessionMessages = vi.fn(async () => overrides.messages ?? null);
    const adapter = { listSessions, getSessionMessages } as unknown as HarnessAdapter;
    const sendMessage = overrides.sendMessage ?? vi.fn(async () => ({ ok: true }));
    const submit = overrides.submit ?? vi.fn();
    const observer = new BrowserTurnAutopilotObserver({
      harnesses: ["zai"],
      adapters: new Map([["zai", adapter]]),
      supervisor: { sendMessage } as never,
      submit: submit as never,
      enabled: overrides.enabled ?? (async () => true),
      held: overrides.held ?? (async () => false),
      stallMs: overrides.stallMs ?? 60_000,
      autoContinue: overrides.autoContinue ?? true,
    });
    return { observer, listSessions, getSessionMessages, sendMessage, submit };
  }

  const messages = [
    { id: "m1", role: "user", text: "задача" },
    { id: "m2", role: "assistant", text: "ответ" },
  ];

  it("submits exactly one durable Stop on the running→idle transition", async () => {
    const h = harness({ messages, sessions: [fakeSession({ status: "running" })] });
    await h.observer.observeOnce();
    expect(h.submit).not.toHaveBeenCalled();
    h.listSessions.mockResolvedValue([fakeSession({ status: "idle" })]);
    await h.observer.observeOnce();
    expect(h.submit).toHaveBeenCalledTimes(1);
    const input = h.submit.mock.calls[0][0] as { harness: string; sessionId: string; cwd: string; turnId: string };
    expect(input.harness).toBe("zai");
    expect(input.sessionId).toBe("zai::abc");
    expect(input.cwd).toBe("/tmp/browser-wd");
    expect(input.turnId).toMatch(/^browser:[0-9a-f]{32}$/);
    await h.observer.observeOnce();
    expect(h.submit).toHaveBeenCalledTimes(1);
  });

  it("skips the Stop when the session is human-held or autopilot is disabled", async () => {
    const held = harness({ messages, sessions: [fakeSession({ status: "running" })], held: async () => true });
    held.listSessions.mockResolvedValue([fakeSession({ status: "idle" })]);
    await held.observer.observeOnce();
    expect(held.submit).not.toHaveBeenCalled();

    const disabled = harness({ messages, sessions: [fakeSession({ status: "running" })], enabled: async () => false });
    disabled.listSessions.mockResolvedValue([fakeSession({ status: "idle" })]);
    await disabled.observer.observeOnce();
    expect(disabled.submit).not.toHaveBeenCalled();
  });

  it("does not judge a turn it never observed running", async () => {
    const h = harness({ messages, sessions: [fakeSession({ status: "idle" })] });
    await h.observer.observeOnce();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it("nudges a stalled running turn once per burst through the automation send path", async () => {
    const stalled = new Date(Date.now() - 120_000).toISOString();
    const h = harness({
      sessions: [fakeSession({
        status: "running",
        lastActivity: stalled,
        meta: { timestampSemantics: "remote-update-time" },
      })],
    });
    await h.observer.observeOnce();
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const [sentHarness, sentSession, options] = h.sendMessage.mock.calls[0] as [string, string, { inputId: string; origin: string; queue: boolean }];
    expect(sentHarness).toBe("zai");
    expect(sentSession).toBe("zai::abc");
    expect(options.origin).toBe("automation");
    expect(options.queue).toBe(true);
    expect(options.inputId).toMatch(/^autocontinue-zai-/);
    await h.observer.observeOnce();
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("never nudges sessions without a real remote update timestamp", async () => {
    const h = harness({
      sessions: [fakeSession({
        status: "running",
        lastActivity: new Date(Date.now() - 120_000).toISOString(),
        meta: { timestampSemantics: "observed-sidebar-order" },
      })],
    });
    await h.observer.observeOnce();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("starts a new nudge burst only after fresh remote progress", async () => {
    const stalledA = new Date(Date.now() - 120_000).toISOString();
    const h = harness({
      sessions: [fakeSession({ status: "running", lastActivity: stalledA, meta: { timestampSemantics: "remote-update-time" } })],
    });
    await h.observer.observeOnce();
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    // Fresh remote progress resets the burst and is far from the stall window.
    h.listSessions.mockResolvedValue([
      fakeSession({ status: "running", lastActivity: new Date(Date.now() - 10_000).toISOString(), meta: { timestampSemantics: "remote-update-time" } }),
    ]);
    await h.observer.observeOnce();
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    // A different, stale timestamp is a new stalled burst: exactly one more nudge.
    const stalledB = new Date(Date.now() - 120_000).toISOString();
    h.listSessions.mockResolvedValue([
      fakeSession({ status: "running", lastActivity: stalledB, meta: { timestampSemantics: "remote-update-time" } }),
    ]);
    await h.observer.observeOnce();
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
    // The same stalled burst never nudges twice.
    await h.observer.observeOnce();
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("does not nudge a human-held session and respects the off switch", async () => {
    const held = harness({
      sessions: [fakeSession({ status: "running", lastActivity: new Date(Date.now() - 120_000).toISOString(), meta: { timestampSemantics: "remote-update-time" } })],
      held: async () => true,
    });
    await held.observer.observeOnce();
    expect(held.sendMessage).not.toHaveBeenCalled();

    const off = harness({
      sessions: [fakeSession({ status: "running", lastActivity: new Date(Date.now() - 120_000).toISOString(), meta: { timestampSemantics: "remote-update-time" } })],
      autoContinue: false,
    });
    await off.observer.observeOnce();
    expect(off.sendMessage).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});


describe("BackgroundAutopilotStop browser-chat deliver", () => {
  function buildStop(deliver: (input: { harness: string; sessionId: string; cwd: string }, goal: string, inputId: string) => Promise<unknown>) {
    const jobs = { start: vi.fn(async ({ run }: { run: ({ signal, progress }: { signal: AbortSignal; progress: (n: number, msg?: string) => void }) => Promise<unknown> }) => run({ signal: new AbortController().signal, progress: () => undefined })), get: () => undefined } as unknown as HerderJobRegistry;
    const adapter = { listSessions: vi.fn(async () => [fakeSession({ status: "idle" })]), getSession: vi.fn(async () => fakeSession({ status: "idle" })), getSessionMessages: vi.fn(async () => [{ id: "m1", role: "user", text: "hi", parts: [{ type: "text", text: "hi" }] }, { id: "m2", role: "assistant", text: "hi back", parts: [{ type: "text", text: "hi back" }] }]) } as unknown as HarnessAdapter;
    return new BackgroundAutopilotStop({
      jobs, adapters: new Map([["chatgpt", adapter], ["zai", adapter]]),
      evaluate: async () => ({ decision: "continue", next_goal: "next step" }),
      held: async () => false,
      allowed: async () => true,
      deliver,
    });
  }

  it("routes chatgpt and zai continuations through the browser-chat deliver callback with a stable inputId", async () => {
    const seen: Array<{ harness: string; sessionId: string; goal: string; inputId: string }> = [];
    const stop = buildStop(async (input, goal, inputId) => {
      seen.push({ harness: input.harness, sessionId: input.sessionId, goal, inputId });
      return { status: "delivered", transport: "browser-chat", inputId, goal, sessionId: input.sessionId, harness: input.harness };
    });
    for (const harness of ["chatgpt", "zai"] as const) {
      await stop.submit({ harness, sessionId: "zai::abc", cwd: "/tmp/browser-wd", turnId: "browser:" + "a".repeat(32) } as never);
    }
    expect(seen).toHaveLength(2);
    expect(seen.map(s => s.harness)).toEqual(["chatgpt", "zai"]);
    expect(seen.every(s => s.goal === "next step")).toBe(true);
    expect(seen.every(s => s.inputId.startsWith("agent-herder:auto:"))).toBe(true);
  });
});
