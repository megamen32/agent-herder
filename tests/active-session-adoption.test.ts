import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionSupervisor } from "../src/session-supervisor.js";
import { SessionAutostartStore, UnfinishedSessionLauncher, UnfinishedSessionStore } from "../src/autopilot/unfinished-session-launcher.js";
import { AutopilotSessionStore } from "../src/autopilot/session-store.js";
import { HumanStopStore } from "../src/human-stop-store.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const base = tmpdir();
  const root = await mkdtemp(join(base, "active-adoption-")); roots.push(root);
  let current: AgentSession = { id: "owned-active", harness: "codex", cwd: root, title: "fixture", status: "running", needsPermission: false, lastActivity: new Date().toISOString(), model: "gpt-6.1-sol", meta: { activeTurnId: "turn-original" } };
  let resumes = 0, sends = 0;
  const adapter: HarnessAdapter = { type: "codex", name: "fixture", async init() {}, async listSessions() { return [current]; }, async getSession(id) { return id === current.id ? { ...current, meta: { ...current.meta } } : null; }, async resumeSession() { resumes++; return { ok: true }; }, async sendMessage() { sends++; return { ok: true }; }, async stopSession() { throw Error("must not stop"); }, async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; } };
  const settings = new SessionAutostartStore(join(root, "settings.json"), {});
  await settings.setGlobal(true); await settings.setHarness("codex", true);
  const autopilot = new AutopilotSessionStore(join(root, "autopilot.json"));
  const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
  const humanStops = new HumanStopStore(join(root, "human-stops.json"));
  const launcher = new UnfinishedSessionLauncher({ adapters: new Map([["codex", adapter]]), settingsStore: settings, autopilotSessionStore: autopilot, store, humanStopStore: humanStops });
  const supervisor = new SessionSupervisor(new Map([["codex", adapter]]), { async convert() { return { success: true }; } } as any, undefined, { unfinishedSessions: launcher, humanStopStore: humanStops });
  return { root, adapter, settings, autopilot, store, launcher, supervisor, current: () => current, update: (value: Partial<AgentSession>) => { current = { ...current, ...value }; }, calls: () => ({ resumes, sends }), async enable() { await settings.setSession({ harness: current.harness, sessionId: current.id, cwd: current.cwd }, true); await autopilot.set({ harness: "codex", sessionId: current.id, cwd: current.cwd }, true); } };
}
describe("explicit active Codex adoption", () => {
  it("persists the exact active recovery identity without loading, sending or stopping", async () => {
    const f = await setup(); await f.enable();
    expect(await f.supervisor.resumeSession("codex", f.current().id, undefined, true)).toEqual({ ok: true });
    expect(await f.store.activeNativeTurn("codex", f.current().id)).toEqual({ turnId: "turn-original" });
    expect(await f.store.list()).toHaveLength(1);
    expect(f.calls()).toEqual({ resumes: 0, sends: 0 });
    expect(f.current().meta?.activeTurnId).toBe("turn-original");
    expect(await f.supervisor.resumeSession("codex", f.current().id, undefined, true)).toEqual({ ok: true });
    expect(await f.store.list()).toHaveLength(1);
    expect(f.calls()).toEqual({ resumes: 0, sends: 0 });
    f.launcher.stop();
  });
  it("requires both exact session switches rather than inherited global permission", async () => {
    const f = await setup();
    expect((await f.supervisor.resumeSession("codex", f.current().id, undefined, true)).ok).toBe(false);
    await f.settings.setSession({ harness: f.current().harness, sessionId: f.current().id, cwd: f.current().cwd }, true);
    expect((await f.supervisor.resumeSession("codex", f.current().id, undefined, true)).ok).toBe(false);
    expect(await f.store.list()).toEqual([]); expect(f.calls().sends).toBe(0); f.launcher.stop();
  });
  it("rejects a mismatched stored workspace", async () => {
    const f = await setup(); await f.enable();
    await f.autopilot.set({ harness: "codex", sessionId: f.current().id, cwd: join(f.root, "other") }, true);
    expect((await f.supervisor.resumeSession("codex", f.current().id, undefined, true)).ok).toBe(false);
    expect(await f.store.list()).toEqual([]); f.launcher.stop();
  });
  it("rejects absent native identity and a changed turn observed during adoption", async () => {
    const f = await setup(); await f.enable(); f.update({ meta: {} });
    expect((await f.supervisor.resumeSession("codex", f.current().id, undefined, true)).ok).toBe(false);
    f.update({ meta: { activeTurnId: "turn-original" } });
    let reads = 0; f.adapter.getSession = async () => ({ ...f.current(), meta: { activeTurnId: ++reads <= 2 ? "turn-original" : "turn-new" } });
    expect((await f.supervisor.resumeSession("codex", f.current().id, undefined, true)).ok).toBe(false);
    expect(await f.store.list()).toEqual([]); expect(f.calls().sends).toBe(0); f.launcher.stop();
  });
  it("keeps idle no-message resume as load-only and never invents work", async () => {
    const f = await setup(); await f.enable(); f.update({ status: "idle", meta: {} });
    expect(await f.supervisor.resumeSession("codex", f.current().id, undefined, true)).toEqual({ ok: true });
    expect(f.calls()).toEqual({ resumes: 1, sends: 0 }); expect(await f.store.list()).toEqual([]); f.launcher.stop();
  });
  it("correlates a subsequent failure with the adopted identity", async () => {
    const f = await setup(); await f.enable();
    expect((await f.supervisor.resumeSession("codex", f.current().id, undefined, true)).ok).toBe(true);
    f.update({ status: "error" });
    await f.launcher.handleEvent("codex", { kind: "turn.failed", harness: "codex", sessionId: f.current().id, data: { turnId: "turn-original" } });
    expect(await f.store.recoveryNativeTurn("codex", f.current().id)).toEqual({ turnId: "turn-original" });
    expect((await f.store.list())[0]?.recoveryCause).toBe("turn.failed");
    expect(f.calls().sends).toBe(0); f.launcher.stop();
  });
});

