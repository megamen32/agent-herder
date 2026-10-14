import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoCompactService, AutoCompactStore } from "../src/autocontinue/auto-compact.js";
import type { AgentSession, HarnessAdapter, HarnessEvent } from "../src/types/index.js";

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
    nativeLoaded: true, nativeStatus: "idle", nativeHumanMessageCount: 5, latestUserPrompt: { id: "user-1" },
    nativeLastTurn: { status: "completed", completedAt: now },
    nativeContextUsage: { used: 100_000, size: 200_000, cache: { cacheReadTokens: 90_000, inputTokens: 10_000 } },
  } } as AgentSession;
  const compactSession = vi.fn(async () => ({ ok: true, admitted: true, pending: true }));
  const sendMessage = vi.fn(), createSession = vi.fn();
  const adapter = { isReady: () => true, getSession: async () => session, listSessions: async () => [session], compactSession, sendMessage, createSession } as unknown as HarnessAdapter;
  const notified: { title: string; body: string }[] = [];
  const options = { adapters: new Map([["zcode", adapter]]), store, held: async () => held, worthResuming: async () => useful, now: () => now,
    notify: async (notice: { title: string; body: string }) => { notified.push(notice); } };
  return { store, service: new AutoCompactService(options), restart: () => new AutoCompactService(options), session, compactSession, sendMessage, createSession, notified,
    age: (seconds: number) => { now = Date.parse("2026-10-11T10:00:00Z") + seconds * 1000; }, useful: (value: boolean) => { useful = value; }, held: (value: boolean) => { held = value; } };
}

describe("same-session warm-context maintenance (fast unit, expected 1s/max 10s)", () => {
  it("defaults to 35% and five human messages and allows each threshold to change", async () => {
    const f = await fixture();
    expect((await f.store.read()).settings).toMatchObject({ minContextPercent: 35, minHumanMessages: 5 });
    f.age(205); (f.session.meta!.nativeContextUsage as { used: number }).used = 70_000;
    await f.service.tick(); expect(f.compactSession).toHaveBeenCalledTimes(1);
    const g = await fixture(); g.age(205); g.session.meta!.nativeHumanMessageCount = 3;
    (g.session.meta!.nativeContextUsage as { used: number }).used = 40_000;
    await g.service.tick(); expect(g.compactSession).not.toHaveBeenCalled();
    await g.store.updateSettings({ ...(await g.store.read()).settings, minContextPercent: 20, minHumanMessages: 3 });
    await g.service.tick(); expect(g.compactSession).toHaveBeenCalledTimes(1);
  });
  it("starts near estimated expiry, confirms reduced context and never sends task prompts", async () => {
    const f = await fixture(); f.age(100); await f.service.tick(); expect(f.compactSession).not.toHaveBeenCalled();
    f.age(205); await f.service.tick(); expect(f.compactSession).toHaveBeenCalledExactlyOnceWith("original", expect.objectContaining({ expectedUserMessageId: "user-1" }));
    expect((await f.store.read()).operations[0]?.state).toBe("accepted");
    f.age(230); (f.session.meta!.nativeContextUsage as { used: number }).used = 8_000;
    await f.restart().tick(); expect((await f.store.read()).operations[0]).toMatchObject({ state: "completed", tokensBefore: 100_000, tokensAfter: 8_000, durationMs: 25_000 });
    expect(f.compactSession).toHaveBeenCalledTimes(1); expect(f.sendMessage).not.toHaveBeenCalled(); expect(f.createSession).not.toHaveBeenCalled();
  });
  it.each(["finished", "stopped", "cold", "late", "active", "human", "small", "few-messages"])("skips %s without consuming native admission", async (reason) => {
    const f = await fixture(); f.age(205);
    if (reason === "finished") f.useful(false);
    if (reason === "stopped") f.held(true);
    if (reason === "cold") f.session.meta!.nativeLoaded = false;
    if (reason === "late") f.age(290);
    if (reason === "active") f.session.meta!.nativeActiveTurnId = "turn";
    if (reason === "human") f.session.needsPermission = true;
    if (reason === "small") (f.session.meta!.nativeContextUsage as { used: number }).used = 10_000;
    if (reason === "few-messages") f.session.meta!.nativeHumanMessageCount = 4;
    await f.service.tick(); expect(f.compactSession).not.toHaveBeenCalled();
  });
  it("does not replay unknown admission after restart or overlapping requests", async () => {
    const f = await fixture(); f.age(205); f.compactSession.mockRejectedValue(new Error("transport lost"));
    await Promise.all([f.service.compact("zcode", "original", "one", false), f.restart().compact("zcode", "original", "one", false)]);
    await f.restart().tick(); expect(f.compactSession).toHaveBeenCalledTimes(1);
    expect((await f.store.read()).operations[0]?.state).toBe("failed");
  });
});

describe("native compact failure (fast unit, expected 1s/max 10s)", () => {
  it("records the native failure at once and reports its real cause", async () => {
    const f = await fixture(); f.age(205); await f.service.tick();
    const inputId = (await f.store.read()).operations[0]!.inputId;
    f.age(235);
    await f.service.observe({ kind: "turn.failed", harness: "zcode", sessionId: "original", at: new Date().toISOString(),
      data: { maintenance: "compact", inputId, nativeErrorCode: "UNKNOWN_ERROR", nativeErrorMessage: "Compact failed" } } as HarnessEvent);
    const receipt = (await f.store.read()).operations[0]!;
    expect(receipt).toMatchObject({ state: "failed", tokensBefore: 100_000, durationMs: 30_000 });
    expect(receipt.error).toContain("Compact failed");
    await f.restart().tick();
    expect(f.notified).toHaveLength(1);
    expect(f.notified[0]!.body).toContain("Compact failed");
    expect(f.compactSession).toHaveBeenCalledTimes(1);
  });
  it("fails from a failed compact turn in the session snapshot", async () => {
    const f = await fixture(); f.age(205); await f.service.tick(); f.age(250);
    Object.assign(f.session.meta!.nativeLastTurn as Record<string, unknown>, { status: "failed", kind: "compact", turnId: "turn-9", completedAt: undefined });
    await f.restart().tick();
    expect((await f.store.read()).operations[0]?.state).toBe("failed");
    expect(f.compactSession).toHaveBeenCalledTimes(1);
  });
  it("settles from the durable native turn receipt that carries no compact kind", async () => {
    // Real zcode shape: turn_usage is the only receipt, it has no `kind`, and the
    // harness emits no turn.failed session event for a compact failure.
    const f = await fixture(); f.age(205); await f.service.tick();
    expect((await f.store.read()).operations[0]?.turnBoundaryAt).toBe(String(Date.parse("2026-10-11T10:00:00Z")));
    f.age(235);
    f.session.meta!.nativeLastTurn = { turnId: "turn-1bfae040", status: "error", errorType: "unknown_error",
      errorCode: "UNKNOWN_ERROR", cancelledByUser: false, completedAt: Date.parse("2026-10-11T10:01:35Z") };
    await f.restart().tick();
    const receipt = (await f.store.read()).operations[0]!;
    expect(receipt).toMatchObject({ state: "failed", durationMs: 30_000 });
    expect(receipt.error).toContain("UNKNOWN_ERROR");
    await f.restart().tick();
    expect(f.notified).toHaveLength(1);
    expect(f.notified[0]!.body).toContain("UNKNOWN_ERROR");
    expect(f.notified[0]!.body).not.toContain("Причина нативной средой не сообщена");
    expect(f.compactSession).toHaveBeenCalledTimes(1);
  });
  it("names the real cause of a cancelled maintenance turn that the native flag blames on a user", async () => {
    // Real zcode receipt of a compact killed by a Herder restart: status cancelled,
    // cancelled_by_user=1, no user prompt, errorCode TURN_CANCELLED.
    const f = await fixture(); f.age(205); await f.service.tick(); f.age(235);
    f.session.meta!.nativeLastTurn = { turnId: "turn-5a426eb8", status: "cancelled", errorType: "turn_cancelled",
      errorCode: "TURN_CANCELLED", cancelledByUser: true, completedAt: Date.parse("2026-10-11T10:03:56Z") };
    await f.restart().tick();
    const receipt = (await f.store.read()).operations[0]!;
    expect(receipt).toMatchObject({ state: "failed", durationMs: 30_000 });
    expect(receipt.cause).toContain("TURN_CANCELLED");
    await f.restart().tick();
    expect(f.notified).toHaveLength(1);
    expect(f.notified[0]!.body).toContain("TURN_CANCELLED");
    expect(f.compactSession).toHaveBeenCalledTimes(1);
  });
  it("names the provider failure that the aggregate turn code hides", async () => {
    // Real zcode receipt of 2026-10-14T19:51:31Z: the durable turn_usage row holds
    // only the placeholder UNKNOWN_ERROR, and the per-request receipt of the same
    // compact turn holds the network failure that actually ended the stream.
    const f = await fixture(); f.age(205); await f.service.tick(); f.age(235);
    f.session.meta!.nativeLastTurn = { turnId: "turn-3461f34c", status: "error", errorType: "unknown_error",
      errorCode: "UNKNOWN_ERROR", modelErrorType: "network_error",
      errorMessage: "Network connection failed for the provider request.",
      cancelledByUser: false, completedAt: Date.parse("2026-10-11T10:01:35Z") };
    await f.restart().tick();
    const receipt = (await f.store.read()).operations[0]!;
    expect(receipt).toMatchObject({ state: "failed", durationMs: 30_000 });
    expect(receipt.cause).toContain("Network connection failed for the provider request.");
    expect(receipt.cause).toContain("network_error");
    await f.restart().tick();
    expect(f.notified).toHaveLength(1);
    expect(f.notified[0]!.body).toContain("Network connection failed for the provider request.");
    expect(f.notified[0]!.body).not.toContain("request..");
    expect(f.notified[0]!.body).not.toContain("UNKNOWN_ERROR");
    expect(f.compactSession).toHaveBeenCalledTimes(1);
  });
  it("keeps the real cause of a failed compact turn instead of a generic sentence", async () => {
    const f = await fixture(); f.age(205); await f.service.tick(); f.age(250);
    Object.assign(f.session.meta!.nativeLastTurn as Record<string, unknown>, { status: "failed", kind: "compact", turnId: "turn-9", completedAt: undefined,
      errorType: "unknown_error", errorCode: "UNKNOWN_ERROR", errorMessage: "Network connection failed for the provider request." });
    await f.restart().tick();
    expect((await f.store.read()).operations[0]?.cause).toContain("Network connection failed for the provider request.");
    expect((await f.store.read()).operations[0]?.cause).not.toContain("без подробностей");
  });
  it("keeps a human-stopped native turn out of the compact failure path", async () => {
    const f = await fixture(); f.age(205); await f.service.tick(); f.age(235);
    f.session.meta!.humanStopHeld = true;
    f.session.meta!.nativeLastTurn = { turnId: "turn-5a42", status: "cancelled", errorType: "turn_cancelled",
      errorCode: "TURN_CANCELLED", cancelledByUser: true, completedAt: Date.parse("2026-10-11T10:03:56Z") };
    await f.restart().tick();
    expect((await f.store.read()).operations[0]?.state).toBe("accepted");
    expect(f.notified).toHaveLength(0);
  });
  it("keeps the operation open for a task turn failure and times out only afterwards", async () => {
    const f = await fixture(); f.age(205); await f.service.tick(); f.age(250);
    // A real task turn owns its user prompt; a maintenance turn never does.
    Object.assign(f.session.meta!.nativeLastTurn as Record<string, unknown>, { status: "failed", turnId: "turn-9", userMessageId: "user-1", completedAt: undefined });
    await f.service.observe({ kind: "turn.failed", harness: "zcode", sessionId: "original", data: { inputId: (await f.store.read()).operations[0]!.inputId } } as HarnessEvent);
    await f.restart().tick();
    expect((await f.store.read()).operations[0]?.state).toBe("accepted");
    expect(f.notified).toHaveLength(0);
    f.age(1_200); await f.restart().tick();
    expect((await f.store.read()).operations[0]?.state).toBe("failed");
  });
});

// Fast unit expected1s/max5s: first-request cache misses still seed an implicit prefix cache.
it("uses the configured cache-window estimate without an invented minimum hit ratio", async () => {
 const f=await fixture(); f.age(205);
 (f.session.meta!.nativeContextUsage as {cache:unknown}).cache={cacheReadTokens:0,inputTokens:100000,latestHitRate:0};
 await f.service.tick(); expect(f.compactSession).toHaveBeenCalledTimes(1);
});
