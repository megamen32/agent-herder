import { describe, expect, it } from "vitest";
import { buildIntegratorProgress } from "../src/integrator-progress.js";
import type { AgentSession, SessionDetails, SessionMessageView } from "../src/types/index.js";

const now = Date.parse("2026-10-20T10:00:00.000Z");
const stamp = (ageMs: number) => new Date(now - ageMs).toISOString();
const session = (overrides: Partial<AgentSession> = {}): AgentSession => ({
  id: "s1", harness: "codex", status: "running", title: "work", cwd: "/repo",
  lastActivity: stamp(30_000), needsPermission: false, ...overrides,
});
const details = (overrides: { session?: AgentSession; messages?: SessionMessageView[] } = {}): SessionDetails => ({
  session: overrides.session ?? session(), lineage: { kind: "root" }, children: [], messages: overrides.messages ?? [],
  history: { source: "acp-load", complete: true },
});
const message = (overrides: Partial<SessionMessageView> = {}): SessionMessageView => ({
  id: "m1", role: "assistant", turnId: "turn-new", timestamp: stamp(10_000), parts: [], ...overrides,
});
const base = (overrides: Partial<Parameters<typeof buildIntegratorProgress>[0]> = {}) =>
  buildIntegratorProgress({ now, staleAfterMs: 60_000, ...overrides });

describe("buildIntegratorProgress", () => {
  it("normalizes a fresh running AgentSession snapshot as active progress", () => {
    expect(base({ details: details({ session: session({ lastActivity: stamp(30_000) }) }) }))
      .toMatchObject({ state: "active_progress", source: "session-snapshot", observedAt: stamp(30_000) });
  });

  it("normalizes real transcript tool output and preserves its native turn and message identity", () => {
    expect(base({ details: details({ messages: [message({ id: "tool-msg", role: "tool", turnId: "turn-9", parts: [{ type: "tool_result", output: "ok" }] })] }) }))
      .toMatchObject({ state: "active_progress", source: "native-message", receiptId: "tool-msg", turnId: "turn-9" });
  });

  it("lets a later native turn supersede an older terminal event", () => {
    expect(base({
      details: details({ messages: [message({ timestamp: stamp(5_000), turnId: "turn-2" })] }),
      events: [{ kind: "turn.completed", harness: "codex", sessionId: "s1", at: stamp(20_000), data: { turnId: "turn-1" } }],
    })).toMatchObject({ state: "active_progress", source: "native-message", turnId: "turn-2" });
  });

  it("requires both harness and session ID to match a native event", () => {
    expect(base({
      details: details({ session: session({ harness: "codex" }) }),
      events: [{ kind: "turn.completed", harness: "claude", sessionId: "s1", at: stamp(1_000) }],
    })).toMatchObject({ state: "active_progress", source: "session-snapshot" });
  });

  it("uses the native active turn ID to discount a later-timestamp event from an older turn", () => {
    expect(base({
      details: details({ session: session({ meta: { nativeActiveTurnId: "turn-current" } }), messages: [message({ timestamp: stamp(20_000), turnId: "turn-current" })] }),
      events: [{ kind: "turn.failed", harness: "codex", sessionId: "s1", at: stamp(5_000), data: { turnId: "turn-old" } }],
    })).toMatchObject({ state: "active_progress", source: "native-message", turnId: "turn-current" });
  });

  it("lets later progress supersede an old external wait", () => {
    expect(base({
      details: details({ messages: [message({ timestamp: stamp(5_000) })] }),
      externalWait: { kind: "provider", receiptId: "p1", observedAt: stamp(25_000), reason: "provider callback" },
    })).toMatchObject({ state: "active_progress", source: "native-message" });
  });

  it("lets later progress supersede an old explicit block receipt", () => {
    expect(base({
      details: details({ messages: [message({ timestamp: stamp(5_000) })] }),
      blocked: { receiptId: "hold-old", observedAt: stamp(25_000), reason: "old hold" },
    })).toMatchObject({ state: "active_progress", source: "native-message" });
  });

  it("keeps a newer explicit external wait in force", () => {
    expect(base({
      details: details({ session: session({ meta: { nativeActiveTurnId: "turn-new" } }), messages: [message({ timestamp: stamp(25_000) })] }),
      externalWait: { kind: "human", receiptId: "p2", observedAt: stamp(5_000), reason: "approval pending" },
    })).toMatchObject({ state: "externally_waiting", receiptId: "p2" });
  });

  it("marks genuinely old running evidence stale without declaring death", () => {
    expect(base({ details: details({ session: session({ lastActivity: stamp(600_000) }) }) }))
      .toMatchObject({ state: "stale_running", source: "session-snapshot", reason: "running evidence is stale" });
  });

  it("uses lifecycle snapshots and terminal statuses only when their real timestamps are valid", () => {
    expect(base({ lifecycle: { state: "ended", at: now - 1_000 } }))
      .toMatchObject({ state: "terminal", source: "lifecycle-hook" });
    expect(base({ details: details({ session: session({ status: "stopped", lastActivity: stamp(1_000) }) }) }))
      .toMatchObject({ state: "terminal", source: "session-status" });
    expect(base({ details: details({ session: session({ status: "stopped", lastActivity: "invalid" }) }) }))
      .toMatchObject({ state: "unknown" });
  });

  it("uses real timestamped permission events; a bare needsPermission snapshot remains unknown", () => {
    expect(base({
      details: details({ session: session({ status: "needs_input", needsPermission: true }) }),
      events: [{ kind: "permission.requested", harness: "codex", sessionId: "s1", at: stamp(2_000), permissionId: "perm-4" }],
    })).toMatchObject({ state: "externally_waiting", source: "harness-event", receiptId: "perm-4" });
    expect(base({ details: details({ session: session({ status: "needs_input", needsPermission: true }) }) }))
      .toMatchObject({ state: "unknown" });
  });

  it("normalizes a durable queued Herder job only for its owning session", () => {
    const job = { id: "job-1", kind: "worker", state: "queued", createdAt: stamp(3_000), updatedAt: stamp(3_000), ownerSessionId: "s1", resultRef: "herder://jobs/job-1" } as const;
    expect(base({ details: details(), jobs: [job] })).toMatchObject({ state: "queued", source: "herder-job", receiptId: "job-1" });
    expect(base({ details: details(), jobs: [{ ...job, ownerSessionId: "other" }] })).toMatchObject({ state: "active_progress" });
  });

  it.each(["completed", "failed", "cancelled", "interrupted"] as const)("does not let a %s child job terminate its running owner session", (state) => {
    const job = { id: "job-child", kind: "worker", state, createdAt: stamp(5_000), updatedAt: stamp(1_000), ownerSessionId: "s1", resultRef: "herder://jobs/job-child" };
    expect(base({ details: details(), jobs: [job] })).toMatchObject({ state: "active_progress", source: "session-snapshot" });
  });

  it("does not let a newer historical message revive a stopped session", () => {
    expect(base({
      details: details({
        session: session({ status: "stopped", lastActivity: stamp(5_000) }),
        messages: [message({ timestamp: stamp(0), turnId: "old-turn" })],
      }),
    })).toMatchObject({ state: "terminal", source: "session-status" });
  });

  it("keeps explicit blocks, clock skew and absence of evidence distinguishable", () => {
    expect(base({ blocked: { receiptId: "b1", observedAt: stamp(1_000), reason: "manual hold" } }))
      .toMatchObject({ state: "blocked", source: "explicit-block", receiptId: "b1" });
    expect(base({ lifecycle: { state: "running", at: now + 60_000 } })).toMatchObject({ state: "unknown", reason: "evidence timestamp is in the future" });
    expect(base({ lifecycle: { state: "running", at: now + 20_000 } })).toMatchObject({ state: "active_progress" });
    expect(base({ now: Number.NaN })).toMatchObject({ state: "unknown", reason: "clock input is invalid" });
    expect(base({ staleAfterMs: Number.POSITIVE_INFINITY })).toMatchObject({ state: "unknown", reason: "staleness threshold is invalid" });
    expect(base({ staleAfterMs: -1 })).toMatchObject({ state: "unknown", reason: "staleness threshold is invalid" });
    expect(base()).toMatchObject({ state: "unknown", reason: "no progress evidence" });
  });
});
