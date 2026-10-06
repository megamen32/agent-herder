import { describe, expect, it } from "vitest";
import { pickNativeLastTurn, resolvePersistedZcodeStatus, type NativeTurnUsageRow } from "./zcode.js";
import { lifecycleEntryFor, markLifecycleEvent } from "../session-lifecycle.js";

const WINDOW = 5 * 60 * 1000;

function input(overrides: Partial<Parameters<typeof resolvePersistedZcodeStatus>[0]> = {}) {
  return {
    rawStatus: "running",
    tasksUpdatedAt: 0,
    now: 1_000_000_000_000,
    activeWindowMs: WINDOW,
    ...overrides,
  };
}

describe("resolvePersistedZcodeStatus", () => {
  it("reports running from fresh native time_updated while the tasks-index row froze at prompt time", () => {
    const now = 1_000_000_000_000;
    // Reproduces the reported bug: a 40-minute turn, tasks-index stuck at the
    // prompt submit, no lifecycle entry (daemon restarted mid-turn).
    const status = resolvePersistedZcodeStatus(input({
      tasksUpdatedAt: now - 40 * 60 * 1000,
      nativeUpdatedAt: now - 2_000,
      now,
    }));
    expect(status).toBe("running");
  });

  it("keeps the legacy tasks-index recency path when no native signal exists", () => {
    const now = 1_000_000_000_000;
    expect(resolvePersistedZcodeStatus(input({ tasksUpdatedAt: now - 60_000, now }))).toBe("running");
    expect(resolvePersistedZcodeStatus(input({ tasksUpdatedAt: now - WINDOW - 1, now }))).toBe("idle");
  });

  it("prefers an observed turn-end over recency so a finished turn is idle immediately", () => {
    const now = 1_000_000_000_000;
    const status = resolvePersistedZcodeStatus(input({
      tasksUpdatedAt: now - 60_000,
      nativeUpdatedAt: now - 30_000,
      lifecycle: { state: "idle", at: now - 20_000 },
      now,
    }));
    expect(status).toBe("idle");
  });

  it("maps an observed session end to stopped", () => {
    const now = 1_000_000_000_000;
    const status = resolvePersistedZcodeStatus(input({
      tasksUpdatedAt: now - 60_000,
      lifecycle: { state: "ended", at: now - 10_000 },
      now,
    }));
    expect(status).toBe("stopped");
  });

  it("lets a fresh turn-start win over an older completed task status", () => {
    const now = 1_000_000_000_000;
    const status = resolvePersistedZcodeStatus(input({
      rawStatus: "completed",
      tasksUpdatedAt: now - 60_000,
      lifecycle: { state: "running", at: now - 5_000 },
      now,
    }));
    expect(status).toBe("running");
  });

  it("ignores a stale lifecycle running mark when native writes stopped long ago", () => {
    const now = 1_000_000_000_000;
    // Turn started (hook marked running) but the runtime kept writing for a
    // while after that mark and then died: the fresher native timestamp must
    // demote the stale hook observation.
    const status = resolvePersistedZcodeStatus(input({
      tasksUpdatedAt: now - 2 * WINDOW,
      nativeUpdatedAt: now - WINDOW - 1,
      lifecycle: { state: "running", at: now - 3 * WINDOW },
      now,
    }));
    expect(status).toBe("idle");
  });

  it("keeps a long turn running through a fresh tool-activity heartbeat", () => {
    const now = 1_000_000_000_000;
    // The native DB read and the tasks-index row are both starved (e.g. one
    // long quiet stretch), but Pre/PostToolUse activity keeps refreshing the
    // observed running mark.
    const status = resolvePersistedZcodeStatus(input({
      tasksUpdatedAt: now - 40 * 60 * 1000,
      nativeUpdatedAt: now - 40 * 60 * 1000,
      lifecycle: { state: "running", at: now - 60_000 },
      now,
    }));
    expect(status).toBe("running");
  });

  it("decays a running heartbeat to idle once it is older than the window", () => {
    const now = 1_000_000_000_000;
    const status = resolvePersistedZcodeStatus(input({
      tasksUpdatedAt: now - 10 * WINDOW,
      lifecycle: { state: "running", at: now - 6 * WINDOW },
      now,
    }));
    expect(status).toBe("idle");
  });

  it("keeps waiting and error task states authoritative", () => {
    const now = 1_000_000_000_000;
    expect(resolvePersistedZcodeStatus(input({ rawStatus: "waiting", tasksUpdatedAt: now - 60_000, now }))).toBe("needs_input");
    expect(resolvePersistedZcodeStatus(input({ rawStatus: "needs_input", tasksUpdatedAt: now - 60_000, now }))).toBe("needs_input");
    expect(resolvePersistedZcodeStatus(input({ rawStatus: "error", tasksUpdatedAt: now - 60_000, now }))).toBe("error");
  });

  it("maps completed to stopped once nothing is recent", () => {
    const now = 1_000_000_000_000;
    expect(resolvePersistedZcodeStatus(input({ rawStatus: "completed", tasksUpdatedAt: now - WINDOW - 1, now }))).toBe("stopped");
  });

  it("marks lifecycle entries observable through the registry", () => {
    markLifecycleEvent("zcode", "sess_status_probe", "turn-start", "/tmp/probe");
    expect(lifecycleEntryFor("zcode", "sess_status_probe")).toMatchObject({ state: "running" });
    markLifecycleEvent("zcode", "sess_status_probe", "turn-end", "/tmp/probe");
    expect(lifecycleEntryFor("zcode", "sess_status_probe")).toMatchObject({ state: "idle" });
  });
});

describe("pickNativeLastTurn", () => {
  const row = (overrides: Partial<NativeTurnUsageRow> = {}): NativeTurnUsageRow => ({
    sessionId: "sess_probe",
    turnId: "turn_a",
    status: "completed",
    startedAt: 1_000,
    completedAt: 2_000,
    userMessageId: "msg_1",
    ...overrides,
  });

  it("returns the newest turn by startedAt", () => {
    const summary = pickNativeLastTurn([row({ turnId: "turn_old", startedAt: 500 }), row({ turnId: "turn_new", startedAt: 1_500 })]);
    expect(summary).toMatchObject({ turnId: "turn_new", startedAt: 1_500, status: "completed", userMessageId: "msg_1" });
  });

  it("breaks startedAt ties deterministically by completedAt then input order", () => {
    const first = row({ turnId: "turn_first", startedAt: 1_000, completedAt: 1_500 });
    const second = row({ turnId: "turn_second", startedAt: 1_000, completedAt: 1_800 });
    expect(pickNativeLastTurn([first, second])).toMatchObject({ turnId: "turn_second" });
    const a = row({ turnId: "turn_a", startedAt: 1_000, completedAt: 1_500 });
    const b = row({ turnId: "turn_b", startedAt: 1_000, completedAt: 1_500 });
    expect(pickNativeLastTurn([a, b])).toMatchObject({ turnId: "turn_b" });
  });

  it("excludes the summary when a newer user input has not been consumed", () => {
    const rows = [row({ startedAt: 1_000, completedAt: 2_000 })];
    expect(pickNativeLastTurn(rows, 3_500)).toBeUndefined();
    expect(pickNativeLastTurn(rows, 2_500)).toBeUndefined();
    expect(pickNativeLastTurn(rows, 2_251)).toBeUndefined();
  });

  it("keeps the summary when the newest input is inside the turn boundary or stale slack", () => {
    const rows = [row({ startedAt: 1_000, completedAt: 2_000 })];
    expect(pickNativeLastTurn(rows, 2_000)).toBeDefined();
    expect(pickNativeLastTurn(rows, 2_250)).toBeDefined();
    expect(pickNativeLastTurn(rows)).toBeDefined();
  });

  it("maps native integer flags into booleans only when set", () => {
    const summary = pickNativeLastTurn([row({ status: "error", retryable: 1, errorType: "unknown_error", errorCode: "UNKNOWN_ERROR" })]);
    expect(summary).toMatchObject({ status: "error", retryable: true, errorType: "unknown_error", errorCode: "UNKNOWN_ERROR" });
    expect(summary!.cancelledByUser).toBeUndefined();
    const humanStopped = pickNativeLastTurn([row({ status: "cancelled", cancelledByUser: 1, contextExceeded: 1 })]);
    expect(humanStopped).toMatchObject({ status: "cancelled", cancelledByUser: true, contextExceeded: true });
    expect(humanStopped!.retryable).toBeUndefined();
  });

  it("returns undefined for empty rows", () => {
    expect(pickNativeLastTurn([])).toBeUndefined();
  });
});
