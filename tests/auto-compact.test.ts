import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoCompactService, AutoCompactStore } from "../src/autocontinue/auto-compact.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "herder-compact-")); roots.push(root);
  const store = new AutoCompactStore(join(root, "state.json"));
  const settings = (await store.read()).settings;
  await store.updateSettings({ ...settings, enabled: true });
  let now = Date.parse("2026-10-11T10:00:00Z");
  let useful = true, held = false;
  const session = { id: "original", harness: "zcode", cwd: "/workspace", status: "idle", lastActivity: new Date(now).toISOString(), meta: {
    nativeLoaded: true, nativeStatus: "idle", latestUserPrompt: { id: "user-1" },
    nativeLastTurn: { status: "completed", completedAt: now },
    nativeContextUsage: { used: 100_000, cache: { cacheReadTokens: 90_000, inputTokens: 10_000 } },
  } } as AgentSession;
  const compactSession = vi.fn(async () => ({ ok: true, admitted: true, pending: true }));
  const sendMessage = vi.fn(), createSession = vi.fn();
  const adapter = { isReady: () => true, getSession: async () => session, listSessions: async () => [session], compactSession, sendMessage, createSession } as unknown as HarnessAdapter;
  const options = { adapters: new Map([["zcode", adapter]]), store, held: async () => held, worthResuming: async () => useful, now: () => now };
  return { store, service: new AutoCompactService(options), restart: () => new AutoCompactService(options), session, compactSession, sendMessage, createSession,
    age: (seconds: number) => { now = Date.parse("2026-10-11T10:00:00Z") + seconds * 1000; }, useful: (value: boolean) => { useful = value; }, held: (value: boolean) => { held = value; } };
}

describe("same-session warm-context maintenance (fast unit, expected 1s/max 10s)", () => {
  it("starts near estimated expiry, confirms reduced context and never sends task prompts", async () => {
    const f = await fixture(); f.age(100); await f.service.tick(); expect(f.compactSession).not.toHaveBeenCalled();
    f.age(205); await f.service.tick(); expect(f.compactSession).toHaveBeenCalledExactlyOnceWith("original", expect.objectContaining({ expectedUserMessageId: "user-1" }));
    expect((await f.store.read()).operations[0]?.state).toBe("accepted");
    f.age(230); (f.session.meta!.nativeContextUsage as { used: number }).used = 8_000;
    await f.restart().tick(); expect((await f.store.read()).operations[0]).toMatchObject({ state: "completed", tokensBefore: 100_000, tokensAfter: 8_000, durationMs: 25_000 });
    expect(f.compactSession).toHaveBeenCalledTimes(1); expect(f.sendMessage).not.toHaveBeenCalled(); expect(f.createSession).not.toHaveBeenCalled();
  });
  it.each(["finished", "stopped", "cold", "late", "active", "human"])("skips %s without consuming native admission", async (reason) => {
    const f = await fixture(); f.age(205);
    if (reason === "finished") f.useful(false);
    if (reason === "stopped") f.held(true);
    if (reason === "cold") (f.session.meta!.nativeContextUsage as { cache: { cacheReadTokens: number } }).cache.cacheReadTokens = 0;
    if (reason === "late") f.age(290);
    if (reason === "active") f.session.meta!.nativeActiveTurnId = "turn";
    if (reason === "human") f.session.needsPermission = true;
    await f.service.tick(); expect(f.compactSession).not.toHaveBeenCalled();
  });
  it("does not replay unknown admission after restart or overlapping requests", async () => {
    const f = await fixture(); f.age(205); f.compactSession.mockRejectedValue(new Error("transport lost"));
    await Promise.all([f.service.compact("zcode", "original", "one", false), f.restart().compact("zcode", "original", "one", false)]);
    await f.restart().tick(); expect(f.compactSession).toHaveBeenCalledTimes(1);
    expect((await f.store.read()).operations[0]?.state).toBe("failed");
  });
});
