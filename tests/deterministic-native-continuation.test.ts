import { describe, expect, it, vi } from "vitest";
import { continueManualSession } from "../scripts/deterministic-native-watch.mjs";
describe("finite explicit manual Codex continuation", () => {
  const id = "01a11b29-cb7a-73f1-b64b-39a7688c0f9f";
  const options = () => ({ sessionId: id, expectedLastTurnId: "broken", inputId: "manual-1", message: "Continue source checkpoint", model: "gpt-6.1-sol", humanRequested: true, sourceOnly: true, grantExpiresAt: Date.now() + 60000 });
  const idle = () => ({ id, status: "idle", meta: { nativeLastTurn: { turnId: "broken", status: "interrupted" } } });
  function harness(sessions = [idle(), idle(), idle(), { id, status: "running", meta: { activeTurnId: "new", nativeLastTurn: { turnId: "new", status: "inProgress" } } }]) {
    let n = 0;
    return { getSession: vi.fn(async () => sessions[Math.min(n++, sessions.length - 1)]),
      resumeSession: vi.fn(async () => ({ threadId: id })), startTurn: vi.fn(async () => ({ turnId: "new" })) };
  }
  const hooks = () => ({ guard: vi.fn(async () => null), persistIntent: vi.fn(async () => true), persistResult: vi.fn(async () => {}) });
  it("confirms a new native turn without calling any judge or claiming automatic recovery", async () => {
    const a = harness(), h = hooks(); const result = await continueManualSession(a, options(), h);
    expect(result).toMatchObject({ status: "started", turnId: "new", automaticRecoveryProven: false });
    expect(a.resumeSession).toHaveBeenCalledTimes(1); expect(a.startTurn).toHaveBeenCalledTimes(1);
    expect(h.persistIntent).toHaveBeenCalledBefore(a.resumeSession);
  });
  it("never sends or resumes an already active target", async () => {
    const a = harness([{ ...idle(), status: "running" }]); const result = await continueManualSession(a, options(), hooks());
    expect(result.status).toBe("hold"); expect(a.resumeSession).not.toHaveBeenCalled(); expect(a.startTurn).not.toHaveBeenCalled();
  });
  it("requires direct manual grant, exact broken identity and fresh owner/resource/queue gates", async () => {
    for (const change of [{ humanRequested: false }, { sourceOnly: false }, { expectedLastTurnId: "other" }, { grantExpiresAt: Date.now() - 1 }]) {
      const a = harness(); expect((await continueManualSession(a, { ...options(), ...change }, hooks())).status).toBe("hold"); expect(a.startTurn).not.toHaveBeenCalled();
    }
    const a = harness(), h = hooks(); h.guard.mockResolvedValue("queue/stop/resource blocker");
    expect((await continueManualSession(a, options(), h)).status).toBe("hold"); expect(a.resumeSession).not.toHaveBeenCalled();
  });
  it("holds if a native turn starts during persisted-intent or resume I/O", async () => {
    for (const sessions of [[idle(), { ...idle(), status: "running" }], [idle(), idle(), { ...idle(), status: "running" }]]) {
      const a = harness(sessions); expect((await continueManualSession(a, options(), hooks())).status).toBe("hold"); expect(a.startTurn).not.toHaveBeenCalled();
    }
  });
  it("holds a new queue/stop/resource blocker before start after resume", async () => {
    const a = harness(), h = hooks(); h.guard.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue("new blocker");
    expect((await continueManualSession(a, options(), h)).status).toBe("hold"); expect(a.startTurn).not.toHaveBeenCalled();
  });
  it("never replays duplicate intent or ambiguous native admission", async () => {
    const a = harness(), h = hooks(); h.persistIntent.mockResolvedValue(false);
    expect((await continueManualSession(a, options(), h)).status).toBe("hold"); expect(a.resumeSession).not.toHaveBeenCalled();
    const b = harness(); b.startTurn.mockRejectedValue(new Error("socket timeout after possible acceptance"));
    expect((await continueManualSession(b, options(), hooks())).status).toBe("admission_unknown"); expect(b.startTurn).toHaveBeenCalledTimes(1);
  });
  it("requires exact resume/start receipts and native readback identity", async () => {
    const a = harness(); a.resumeSession.mockResolvedValue({ threadId: "foreign" });
    expect((await continueManualSession(a, options(), hooks())).status).toBe("admission_unknown"); expect(a.startTurn).not.toHaveBeenCalled();
    const b = harness(); b.startTurn.mockResolvedValue({ turnId: undefined });
    expect((await continueManualSession(b, options(), hooks())).status).toBe("admission_unknown");
    const c = harness([idle(), idle(), idle(), idle()]);
    expect((await continueManualSession(c, options(), hooks())).status).toBe("admitted_unconfirmed");
  });
});
