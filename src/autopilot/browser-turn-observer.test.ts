import { describe, expect, it, vi } from "vitest";

vi.mock("../harness-runtime-settings.js", () => ({ liveHarnessPollingEnabled: () => true }));

import { BrowserTurnAutopilotObserver, type BrowserTurnObserverOptions } from "./browser-turn-observer.js";
import type { AgentSession, HarnessAdapter } from "../types/index.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sessionId = "zai::route%3A6aa1dd0e-4f11-4fc9-a633-94fa95566c2f";

function session(status: "running" | "idle"): AgentSession {
  return {
    id: sessionId,
    harness: "zai",
    status,
    title: "t",
    cwd: "/home/roomhacker/.browser-chat/zai",
    lastActivity: new Date().toISOString(),
  } as unknown as AgentSession;
}

type RefreshableAdapter = HarnessAdapter & { refreshSession: (id: string) => Promise<boolean> };

function makeAdapter(statusProvider: () => AgentSession[]): RefreshableAdapter {
  return {
    listSessions: vi.fn(async () => statusProvider()),
    getSessionMessages: vi.fn(async () => [
      { id: "m1", role: "user", text: "hi" },
      { id: "m2", role: "assistant", text: "done" },
    ]),
    invalidateHistory: vi.fn(async () => undefined),
    refreshSession: vi.fn(async () => true),
  } as unknown as RefreshableAdapter;
}

function makeObserver(adapter: RefreshableAdapter, extra: Partial<BrowserTurnObserverOptions> = {}) {
  const submit = vi.fn();
  const observer = new BrowserTurnAutopilotObserver({
    harnesses: ["zai"],
    adapters: new Map<string, HarnessAdapter>([["zai", adapter as unknown as HarnessAdapter]]),
    supervisor: { sendMessage: vi.fn(async () => ({ ok: true })) },
    submit,
    enabled: vi.fn(async () => true),
    held: vi.fn(async () => false),
    stallMs: 60_000_000,
    autoContinue: false,
    onError: () => undefined,
    ...extra,
  });
  return { observer, submit };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("BrowserTurnAutopilotObserver", () => {
  it("submits one Stop for an observed running->idle transition", async () => {
    let status: "running" | "idle" = "running";
    const adapter = makeAdapter(() => [session(status)]);
    const { observer, submit } = makeObserver(adapter);
    await observer.observeOnce();
    expect(submit).not.toHaveBeenCalled();
    status = "idle";
    await observer.observeOnce();
    expect(submit).toHaveBeenCalledTimes(1);
    expect((submit.mock.calls[0]![0] as { sessionId: string }).sessionId).toBe(sessionId);
  });

  it("refreshes a stale running turn through the driver, rate-limited", async () => {
    const adapter = makeAdapter(() => [session("running")]);
    const { observer } = makeObserver(adapter, { staleRefreshMs: 20 });
    await observer.observeOnce();
    expect(adapter.refreshSession).not.toHaveBeenCalled();
    await sleep(30);
    await observer.observeOnce();
    expect(adapter.refreshSession).toHaveBeenCalledTimes(1);
    await observer.observeOnce();
    expect(adapter.refreshSession).toHaveBeenCalledTimes(1);
    await sleep(30);
    await observer.observeOnce();
    expect(adapter.refreshSession).toHaveBeenCalledTimes(2);
    expect(adapter.refreshSession).toHaveBeenCalledWith(sessionId);
  });

  it("survives a restart mid-run: the persisted running turn still fires the Stop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "btobserver-"));
    const turnsFile = join(dir, "browser-turn-observer.json");
    try {
      let status: "running" | "idle" = "running";
      const adapterA = makeAdapter(() => [session(status)]);
      const observerA = makeObserver(adapterA, { turnsFile }).observer;
      await observerA.observeOnce();
      const persisted = JSON.parse(readFileSync(turnsFile, "utf8")) as {
        turns: Record<string, { running: boolean }>;
      };
      expect(persisted.turns[`zai:${sessionId}`]?.running).toBe(true);

      status = "idle";
      const adapterB = makeAdapter(() => [session(status)]);
      const { observer: observerB, submit } = makeObserver(adapterB, { turnsFile });
      await observerB.observeOnce();
      expect(submit).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
