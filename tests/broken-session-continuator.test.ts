import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionAutostartStore, UnfinishedSessionLauncher, UnfinishedSessionStore } from "../src/autopilot/unfinished-session-launcher.js";
import { AutopilotPolicyStore } from "../src/autopilot/policy-store.js";
import { AutopilotSessionStore } from "../src/autopilot/session-store.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

function fixture(id: string, status: AgentSession["status"] = "error", harness = "codex"): AgentSession {
  return { id, harness, status, title: "Broken recovery", cwd: "/tmp/broken-recovery", lastActivity: new Date(Date.now() - 60000).toISOString(), needsPermission: false };
}
function nativeAdapter(harness: string, sessions: Map<string, AgentSession>, calls: { resumes: string[]; messages: string[] }): HarnessAdapter {
  return { type: harness, name: "fixture", async init() {},
    async listSessions() { return [...sessions.values()]; },
    async getSession(id) { return sessions.get(id) ?? null; },
    async getSessionMessages() { return []; },
    async resumeSession(id) { calls.resumes.push(id); return { ok: true }; },
    async sendMessage(id) { calls.messages.push(id); return { ok: true }; },
    async stopSession() { throw new Error("recovery must not stop"); },
    async respondPermission() { throw new Error("recovery must not approve"); },
    async setPermissions() { throw new Error("recovery must not change permissions"); },
  };
}
async function setup(harness = "codex") {
  const root = await mkdtemp(join(tmpdir(), "broken-continuator-"));
  const state = new UnfinishedSessionStore(join(root, "state.json"));
  const settings = new SessionAutostartStore(join(root, "settings.json"), {});
  const sessions = new Map<string, AgentSession>();
  const calls = { resumes: [] as string[], messages: [] as string[] };
  const adapter = nativeAdapter(harness, sessions, calls);
  const launcher = new UnfinishedSessionLauncher({ adapters: new Map([[harness, adapter]]), store: state, settingsStore: settings, discoveryIdleMs: 1 });
  return { state, settings, sessions, calls, adapter, launcher };
}
describe("broken-session deterministic continuator", () => {
  it("recovers provider-wide transport exit for persisted exact active identities once", async () => {
    const f = await setup();
    const broken = fixture("broken");
    f.sessions.set(broken.id, broken);
    await f.state.markNativeTurnStarted(broken, { turnId: "turn-broken", inputId: "input-broken" }, "old-controller");
    await f.launcher.handleEvent("codex", { kind: "process.disconnected", harness: "codex", data: { transport: "app-server" } });
    expect((await f.state.list())[0]).toMatchObject({ recoveryCause: "process.disconnected", recoveryTurnId: "turn-broken", recoveryInputId: "input-broken" });
    await f.launcher.recoverPending();
    await f.launcher.recoverPending();
    expect(f.calls).toEqual({ resumes: ["broken"], messages: ["broken"] });
  });
  it("does not turn global observation loss into work for idle, active, held or other harness sessions", async () => {
    const f = await setup();
    const active = fixture("active", "running");
    const waiting = { ...fixture("waiting", "needs_input"), needsPermission: true };
    const idle = fixture("idle", "idle");
    for (const session of [active, waiting, idle]) f.sessions.set(session.id, session);
    await f.state.markNativeTurnStarted(active, { turnId: "active-turn" });
    await f.state.markNativeTurnStarted(waiting, { turnId: "waiting-turn" });
    await f.state.markStarted(idle, "idle");
    await f.state.markNativeTurnStarted(fixture("other", "running", "zcode"), { turnId: "other-turn" });
    await f.launcher.handleEvent("codex", { kind: "process.disconnected", harness: "codex", data: { transport: "app-server" } });
    await f.launcher.recoverPending();
    expect(f.calls).toEqual({ resumes: [], messages: [] });
    expect((await f.state.list()).find(row => row.sessionId === "other")).toMatchObject({ activeTurnId: "other-turn" });
  });
  it("keeps subscription access failures observational", async () => {
    const f = await setup("zcode");
    const session = fixture("access", "error", "zcode");
    f.sessions.set(session.id, session);
    await f.state.markNativeTurnStarted(session, { turnId: "access-turn" });
    await f.launcher.handleEvent("zcode", { kind: "process.disconnected", harness: "zcode", nativeType: "event-subscription-error", data: { error: "access unavailable" } });
    expect((await f.state.list())[0]).toMatchObject({ activeTurnId: "access-turn" });
    expect((await f.state.list())[0].recoveryCause).toBeUndefined();
    expect(f.calls).toEqual({ resumes: [], messages: [] });
  });
  it("ingests matching cold native failure after controller death without a live event", async () => {
    const f = await setup("zcode");
    const completedAt = Date.now() - 60000;
    const session = { ...fixture("cold", "stopped", "zcode"), meta: { nativeLastTurn: { turnId: "failed-turn", userMessageId: "input-1", status: "error", startedAt: completedAt - 10000, completedAt, rootSession: true, cancelledByUser: false, retryable: true, userMessageMatchesLatest: true, assistantSucceeded: false, progressedAfterFailure: false, pendingInput: false, errorType: "provider_error", errorCode: "E_RETRY" } } };
    f.sessions.set(session.id, session);
    await f.state.markNativeTurnStarted(session, { turnId: "failed-turn", inputId: "input-1" }, "dead-controller");
    await f.launcher.recoverPending();
    await f.launcher.recoverPending();
    expect(f.calls).toEqual({ resumes: ["cold"], messages: ["cold"] });
    expect((await f.state.list())[0]).toMatchObject({ recoveryCause: "turn.failed", recoveryTurnId: "failed-turn", recoveryInputId: "input-1", admissionPhase: "accepted_pending" });
  });
  it("preserves a newer active native identity over lagging cold failure", async () => {
    const f = await setup("zcode");
    const completedAt = Date.now() - 60000;
    const session = { ...fixture("newer", "stopped", "zcode"), meta: { nativeLastTurn: { turnId: "old-turn", userMessageId: "old-input", status: "error", startedAt: completedAt - 10000, completedAt, rootSession: true, cancelledByUser: false, retryable: true, userMessageMatchesLatest: true, assistantSucceeded: false, progressedAfterFailure: false, pendingInput: false } } };
    f.sessions.set(session.id, session);
    await f.state.markNativeTurnStarted(session, { turnId: "new-turn", inputId: "new-input" });
    await f.launcher.recoverPending();
    expect(f.calls).toEqual({ resumes: [], messages: [] });
    expect((await f.state.list())[0]).toMatchObject({ activeTurnId: "new-turn", activeInputId: "new-input" });
  });

  it("recovers exact Codex interrupted turn only after persisted disconnect proof", async () => {
    const f = await setup();
    const session = { ...fixture("interrupted", "idle"), meta: { nativeLastTurn: { turnId: "lost-turn", status: "interrupted" } } };
    f.sessions.set(session.id, session);
    await f.state.markRecoveryEligible(session, "process.disconnected", { turnId: "lost-turn" }, "prior-controller", new Date(Date.now() - 60000));
    await f.launcher.recoverPending();
    expect(f.calls).toEqual({ resumes: ["interrupted"], messages: ["interrupted"] });
  });
  it.each(["before-resume", "after-resume"])("holds duplicate continuation if native becomes active %s", async (stage) => {
    const f = await setup();
    const session = fixture("became-active");
    f.sessions.set(session.id, session);
    await f.state.markRecoveryEligible(session, "turn.failed", { turnId: "failed-turn" }, "prior-controller", new Date(Date.now() - 60000));
    if (stage === "before-resume") {
      const original = f.state.beginAttempt.bind(f.state);
      f.state.beginAttempt = async (...args: Parameters<typeof f.state.beginAttempt>) => {
        const result = await original(...args);
        f.sessions.set(session.id, { ...session, status: "running", meta: { activeTurnId: "active-new" } });
        return result;
      };
    } else {
      f.adapter.resumeSession = async id => {
        f.calls.resumes.push(id);
        f.sessions.set(session.id, { ...session, status: "running", meta: { activeTurnId: "active-new" } });
        return { ok: true };
      };
    }
    await f.launcher.recoverPending();
    expect(f.calls.resumes).toEqual(stage === "before-resume" ? [] : [session.id]);
    expect(f.calls.messages).toEqual([]);
  });
  it("never treats an interrupted idle Codex turn alone as crash proof", async () => {
    const f = await setup();
    const session = { ...fixture("human-stop", "idle"), meta: { nativeLastTurn: { turnId: "stopped-turn", status: "interrupted" } } };
    f.sessions.set(session.id, session);
    await f.state.markNativeTurnStarted(session, { turnId: "stopped-turn" }, "old-controller");
    await f.launcher.recoverPending();
    expect(f.calls).toEqual({ resumes: [], messages: [] });
  });

  it("recovers broken sessions with an enabled but unavailable LLM without calling it", async () => {
    const f = await setup("zcode");
    const broken = fixture("broken-no-llm", "error", "zcode");
    const idle = fixture("unfinished-semantic", "idle", "zcode");
    f.sessions.set(broken.id, broken); f.sessions.set(idle.id, idle);
    f.adapter.getSessionMessages = async id => [{ id: id + "-u", role: "user", text: "finish the owning task", parts: [{ type: "text", text: "finish the owning task" }] }];
    const root = await mkdtemp(join(tmpdir(), "independent-llm-"));
    const policy = new AutopilotPolicyStore(join(root, "policy.json"));
    await policy.replacePolicy({ schemaVersion: 1, enabled: true, harnesses: ["zcode"], scope: { mode: "all_ingress" }, maxContinuationsPerSession: 10, timeout: { mode: "auto_continue", delayMs: 1000 }, card: { includeUserMessage: true, includeAssistantMessage: true, includeReason: true } }, null);
    let llmCalls = 0;
    const launcher = new UnfinishedSessionLauncher({
      adapters: new Map([["zcode", f.adapter]]), store: f.state, settingsStore: f.settings, discoveryIdleMs: 1,
      autopilotPolicyStore: policy, autopilotSessionStore: new AutopilotSessionStore(join(root, "sessions.json")),
      judge: { async decide() { llmCalls++; throw new Error("LLM unavailable"); }, async plan() { llmCalls++; throw new Error("LLM unavailable"); } },
    });
    await f.state.markRecoveryEligible(broken, "turn.failed", { turnId: "broken-turn" }, "old-controller", new Date(Date.now() - 60000));
    await launcher.recoverPending();
    expect(f.calls).toEqual({ resumes: [broken.id], messages: [broken.id] });
    expect(llmCalls).toBe(0);
  });

  it("holds a continuation forgotten during native resume", async () => {
    const f = await setup();
    const session = { ...fixture("forgotten", "idle"), meta: { nativeLastTurn: { turnId: "lost", status: "interrupted" } } };
    f.sessions.set(session.id, session);
    await f.state.markRecoveryEligible(session, "process.disconnected", { turnId: "lost" }, "prior", new Date(Date.now() - 60000));
    f.adapter.resumeSession = async id => { f.calls.resumes.push(id); await f.launcher.forget("codex", id); return { ok: true }; };
    await f.launcher.recoverPending();
    expect(f.calls).toEqual({ resumes: [session.id], messages: [] });
  });
  it("holds fresh native explicit stop observed after resume even without an injected stop store", async () => {
    const f = await setup();
    const session = fixture("explicit-stop");
    f.sessions.set(session.id, session);
    await f.state.markRecoveryEligible(session, "turn.failed", { turnId: "failed" }, "prior", new Date(Date.now() - 60000));
    f.adapter.resumeSession = async id => {
      f.calls.resumes.push(id);
      f.sessions.set(id, { ...session, meta: { automationStop: { id: "human-stop", turnId: "failed", at: new Date().toISOString(), reason: "interrupted" } } });
      return { ok: true };
    };
    await f.launcher.recoverPending();
    expect(f.calls).toEqual({ resumes: [session.id], messages: [] });
  });
  it("ignores provider-wide disconnect evidence older than the current active turn", async () => {
    const f = await setup();
    const session = fixture("new-generation");
    f.sessions.set(session.id, session);
    const oldAt = new Date(Date.now() - 60000).toISOString();
    await f.state.markNativeTurnStarted(session, { turnId: "new-turn" });
    await f.launcher.handleEvent("codex", { kind: "process.disconnected", harness: "codex", at: oldAt, data: { transport: "app-server" } });
    expect((await f.state.list())[0]).toMatchObject({ activeTurnId: "new-turn" });
    expect((await f.state.list())[0].recoveryCause).toBeUndefined();
  });

  it("fences a global disconnect when a newer native start arrives during its I/O", async () => {
    const f = await setup();
    const session = fixture("race-generation", "running");
    f.sessions.set(session.id, session);
    await f.state.markNativeTurnStarted(session, { turnId: "old-active" });
    const original = f.settings.getSettings.bind(f.settings);
    let ready!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { ready = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    f.settings.getSettings = async () => { if (first) { first = false; ready(); await blocked; } return original(); };
    const disconnect = f.launcher.handleEvent("codex", { kind: "process.disconnected", harness: "codex", data: { transport: "app-server" } });
    await entered;
    const start = f.launcher.handleEvent("codex", { kind: "turn.started", harness: "codex", sessionId: session.id, data: { turnId: "new-active" } });
    release(); await Promise.all([disconnect, start]);
    expect((await f.state.list())[0]).toMatchObject({ activeTurnId: "new-active" });
    expect((await f.state.list())[0].recoveryCause).toBeUndefined();
    expect(f.calls).toEqual({ resumes: [], messages: [] });
  });
});
