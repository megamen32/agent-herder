import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionAutostartStore, UnfinishedSessionLauncher, UnfinishedSessionStore } from "../src/autopilot/unfinished-session-launcher.js";
import { HumanStopStore } from "../src/human-stop-store.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cold-codex-capacity-")); roots.push(root);
  const completedAt = new Date(Date.now() - 60_000).toISOString();
  const current: AgentSession = { id: "existing-codex", harness: "codex", cwd: root, title: "capacity fixture", model: "gpt-6-luna", status: "idle", needsPermission: false, lastActivity: completedAt,
    meta: { nativeLastTurn: { turnId: "failed-capacity-turn", status: "failed", completedAt, capacityFailure: { classification: "model_capacity", nativeTurnId: "failed-capacity-turn", providerId: "codex", modelId: "gpt-6-luna", errorCode: "serverOverloaded", message: "Selected model is at capacity", completedAt } } } };
  const resumeSession = vi.fn(async () => ({ ok: true }));
  const sendMessage = vi.fn(async () => ({ ok: true }));
  const getSession = vi.fn(async () => current);
  const adapter = { type: "codex", name: "Codex fixture", init: vi.fn(async () => {}), listSessions: async () => [{ ...current, meta: {} }], getSession, resumeSession, sendMessage,
    getSessionMessages: async () => [], stopSession: async () => ({ ok: true }), respondPermission: async () => ({ ok: true }), setPermissions: async () => ({ ok: true }) } as unknown as HarnessAdapter;
  const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
  const settingsStore = new SessionAutostartStore(join(root, "settings.json"), {});
  await settingsStore.setGlobal(true);
  const humanStopStore = new HumanStopStore(join(root, "stop.json"));
  const launcher = () => new UnfinishedSessionLauncher({ adapters: new Map([["codex", adapter]]), store, settingsStore, humanStopStore, discoveryIdleMs: 1 });
  return { current, adapter, store, settingsStore, humanStopStore, launcher, getSession, resumeSession, sendMessage };
}
it("recovers one exact missed Codex capacity failure without a persisted start or invented input ID", async () => {
  const f = await fixture();
  expect(await f.store.list()).toEqual([]);
  await f.launcher().recoverPending();
  expect(f.sendMessage).toHaveBeenCalledTimes(1);
  expect(f.resumeSession).toHaveBeenCalledTimes(1);
  const admitted = (await f.store.list())[0]!;
  expect(admitted.recoveryTurnId).toBe("failed-capacity-turn");
  expect(admitted.recoveryInputId).toBeUndefined();
  await f.launcher().recoverPending();
  expect(f.sendMessage).toHaveBeenCalledTimes(1);
  expect(f.adapter.init).not.toHaveBeenCalled();
});
it.each(["held", "permission", "running", "wrong-turn", "quota", "disabled", "model-mismatch"])("does not launch a cold capacity recovery when %s", async mode => {
  const f = await fixture();
  if (mode === "held") await f.humanStopStore.hold(f.current, { id: "owner-stop", at: new Date().toISOString(), reason: "human stop" });
  if (mode === "permission") f.current.needsPermission = true;
  if (mode === "running") f.current.status = "running";
  if (mode === "wrong-turn") (f.current.meta!.nativeLastTurn as any).capacityFailure.nativeTurnId = "other-turn";
  if (mode === "quota") (f.current.meta!.nativeLastTurn as any).capacityFailure.classification = "quota_exhausted";
  if (mode === "model-mismatch") (f.current.meta!.nativeLastTurn as any).capacityFailure.modelId = "other-model";
  if (mode === "disabled") await f.settingsStore.setGlobal(false);
  await f.launcher().recoverPending();
  expect(f.resumeSession).not.toHaveBeenCalled(); expect(f.sendMessage).not.toHaveBeenCalled();
});
it.each(["turn", "proof", "model"])("rechecks native %s before admission when it changes after cold discovery", async mode => {
  const f = await fixture();
  const changed = mode === "model" ? { ...f.current, model: "different-model" }
    : mode === "proof" ? { ...f.current, meta: { nativeLastTurn: { turnId: "failed-capacity-turn", status: "failed" } } }
    : { ...f.current, meta: { nativeLastTurn: { turnId: "new-completed-turn", status: "completed" } } };
  f.getSession.mockImplementationOnce(async () => f.current).mockImplementation(async () => changed);
  await f.launcher().recoverPending();
  expect(f.resumeSession).not.toHaveBeenCalled(); expect(f.sendMessage).not.toHaveBeenCalled();
});
it("does not re-read unchanged native discovery on every controller tick", async () => {
  const f = await fixture();
  (f.current.meta!.nativeLastTurn as any).capacityFailure.classification = "other";
  const launcher = f.launcher();
  await launcher.recoverPending(); await launcher.recoverPending();
  expect(f.getSession).toHaveBeenCalledTimes(1);
  expect(f.sendMessage).not.toHaveBeenCalled();
});
it("preserves an unknown native admission across controller restart without resending", async () => {
  const f = await fixture();
  f.sendMessage.mockResolvedValueOnce({ ok: false, admissionUnknown: true, error: "native reply lost" } as any);
  await f.launcher().recoverPending();
  await f.launcher().recoverPending();
  expect(f.sendMessage).toHaveBeenCalledTimes(1);
  expect(f.resumeSession).toHaveBeenCalledTimes(1);
  expect((await f.store.list())[0]).toMatchObject({ recoveryTurnId: "failed-capacity-turn", admissionPhase: "accepted_pending", deliveryPending: true });
});
