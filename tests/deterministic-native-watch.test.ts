import { describe, expect, it } from "vitest";
import { classifyRecoveryObservation, compactNativeSnapshot } from "../scripts/deterministic-native-watch.mjs";
describe("finite no-LLM native observer", () => {
  const session = { status: "idle", meta: { nativeLastTurn: { turnId: "t", status: "interrupted" } } };
  const proof = { recoveryCause: "process.disconnected", recoveryTurnId: "t" };
  const owner = { taskState: "active" };
  const resources = { observedAt: Date.now(), hostAvailable: 30 * 1024 ** 3, uidEffectiveSpare: 10 * 1024 ** 3, psiSome: 0, psiFull: 0 };
  it("reads only compact native turn identity and holds unknown state", () => {
    expect(compactNativeSnapshot("s", { id: "s", status: { type: "idle" } }, { data: [{ id: "t", status: "interrupted", items: ["secret dialogue"] }] })).toEqual({ id: "s", status: "idle", needsPermission: false, meta: { activeTurnId: undefined, nativeLastTurn: { turnId: "t", status: "interrupted" } } });
    expect(compactNativeSnapshot("s", { id: "s", status: { type: "unknown" } }, { data: [] })).toBeUndefined();
    expect(compactNativeSnapshot("s", { id: "s", status: "idle" }, {})).toBeUndefined();
  });
  it("requires exact disconnect proof for interrupted native inventory", () => {
    expect(classifyRecoveryObservation(session, undefined, owner, resources)).toContain("no exact");
    expect(classifyRecoveryObservation(session, proof, owner, resources)).toContain("eligible proof");
  });
  it("holds active, inaccessible, blocked and pressured owning sessions", () => {
    expect(classifyRecoveryObservation({ ...session, status: "running" }, proof, owner, resources)).toContain("already active");
    expect(classifyRecoveryObservation(undefined, proof, owner, resources)).toContain("access unavailable");
    expect(classifyRecoveryObservation(session, proof, { ...owner, blocker: "measurement missing" }, resources)).toContain("blocker");
    expect(classifyRecoveryObservation(session, proof, owner, { ...resources, psiFull: 0.01 })).toContain("PSI");
    expect(classifyRecoveryObservation(session, proof, owner, { ...resources, psiFull: NaN })).toContain("PSI");
  });
});
