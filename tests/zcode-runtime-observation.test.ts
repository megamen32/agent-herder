import { describe, expect, it, vi } from "vitest";
import { ZcodeAppServerClient } from "../src/adapters/zcode-protocol.js";
import { readExistingZcodeRuntimeObservation } from "../src/adapters/zcode-runtime-observation.js";
const workspace = { workspacePath: "/owned", workspaceIdentity: "/owned", workspaceKey: "/owned" };
describe("existing ZCode runtime observation", () => {
  it("never starts a cold transport or silently reconnects", async () => {
    const client = new ZcodeAppServerClient({ command: "must-not-run" });
    const start = vi.spyOn(client, "start").mockRejectedValue(new Error("must not start"));
    const observation = await readExistingZcodeRuntimeObservation(client, workspace, "known");
    expect(observation.available).toBe(false);
    expect(observation.reason).toBe("existing_transport_or_runtime_unavailable");
    expect(observation.idleProof).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });
  it("uses a ready existing transport without calling start", async () => {
    const client = new ZcodeAppServerClient({ command: "must-not-run" });
    const start = vi.spyOn(client, "start").mockRejectedValue(new Error("must not start"));
    const write = vi.fn(() => { throw new Error("stub write refused"); });
    Object.assign(client, { ready: true, child: { stdin: { write } } });
    await expect(client.callIfReady("zcode-agent", "readSession", [{ runtimePolicy: "existing-only" }])).rejects.toThrow("stub write refused");
    expect(write).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });
  it("requests existing-only native state and strips dialogues without complete idle coverage", async () => {
    const callIfReady = vi.fn(async () => ({
      session: { sessionId: "known", title: "SECRET" }, messages: [{ text: "SECRET" }],
      runtime: { activeTurnId: "turn-live", pendingRequestIds: ["permission"], eventSeq: 7, stateRevision: 9 },
    }));
    const observation = await readExistingZcodeRuntimeObservation({ callIfReady }, workspace, "known");
    expect(callIfReady).toHaveBeenCalledWith("zcode-agent", "readSession", [
      { ...workspace, sessionId: "known", runtimePolicy: "existing-only", messageLimit: 0 },
    ]);
    expect(observation).toMatchObject({ available: true, activeTurnId: "turn-live", pendingRequestCount: 1,
      loadedSessionCoverage: "unknown", queuedInputCount: null, admittedNotStartedCount: null, idleProof: false });
    expect(JSON.stringify(observation)).not.toContain("SECRET");
  });
  it("does not treat no active turn or permissions as no queued or admitted inputs", async () => {
    const observation = await readExistingZcodeRuntimeObservation({ callIfReady: async () => ({
      session: { sessionId: "known" }, runtime: { pendingRequestIds: [], eventSeq: 2, stateRevision: 3 },
    }) }, workspace, "known");
    expect(observation.available).toBe(true);
    expect(observation.pendingRequestCount).toBe(0);
    expect(observation.queuedInputCount).toBeNull();
    expect(observation.admittedNotStartedCount).toBeNull();
    expect(observation.idleProof).toBe(false);
  });
  it.each(["wrong-identity", "missing-runtime", "malformed-runtime"])("holds %s evidence unavailable", async (kind) => {
    const observation = await readExistingZcodeRuntimeObservation({ callIfReady: async () => ({
      session: { sessionId: kind === "wrong-identity" ? "other" : "known" },
      runtime: kind === "missing-runtime" ? undefined : { pendingRequestIds: [], eventSeq: -1, stateRevision: 2 },
    }) }, workspace, "known");
    expect(observation.available).toBe(false);
    expect(observation.idleProof).toBe(false);
  });
});
