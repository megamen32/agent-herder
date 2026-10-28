import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionAutostartStore, UnfinishedSessionLauncher, UnfinishedSessionStore } from "../src/autopilot/unfinished-session-launcher.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

it.each(["idle", "old", "pending", "session-off", "finished-notice-attempt"] as const)("does not cold-resume %s OpenCode work", async reason => {
  const root = await mkdtemp(join(tmpdir(), "opencode-cold-guard-"));
  try {
    const completedAt = new Date(Date.now() - (reason === "old" ? 25 * 60 * 60_000 : 60_000)).toISOString();
    const current: AgentSession = { id: "guarded", harness: "opencode", model: "omniroute/qa", title: "Guarded", cwd: root,
      status: reason === "idle" ? "idle" : "error", lastActivity: completedAt,
      meta: { nativeLastTurn: { turnId: "failed", userMessageId: "user", status: "failed", completedAt, retryable: true,
        pendingInput: reason === "pending", userMessageMatchesLatest: true, assistantSucceeded: false, progressedAfterFailure: false, cancelledByUser: false } } };
    let sends = 0;
    const adapter = { type: "opencode", name: "fixture", listSessions: async () => [current], getSession: async () => current,
      resumeSession: async () => ({ ok: true }), sendMessage: async () => { sends += 1; return { ok: true, admitted: true }; } } as unknown as HarnessAdapter;
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const settings = new SessionAutostartStore(join(root, "settings.json"), {});
    await settings.setHarness("opencode", true);
    if (reason === "session-off") await settings.setSession({ harness: "opencode", sessionId: current.id, cwd: root }, false);
    await new UnfinishedSessionLauncher({ adapters: new Map([["opencode", adapter]]), store, settingsStore: settings,
      ...(reason === "finished-notice-attempt" ? { autopilotSessionStore: { get: async () => ({ enabled: false, noticeAttempt: { incidentId: "finished-incident", attemptId: "finished-attempt" } }) } as any } : {}),
    }).recoverPending();
    expect(sends).toBe(0);
    expect(await store.list()).toHaveLength(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("retains and continues one exact failed OpenCode turn through ordinary recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-native-recovery-"));
  try {
    const completedAt = new Date(Date.now() - 60_000).toISOString();
    const current: AgentSession = { id: "opencode-recovery-fixture", harness: "opencode", model: "omniroute/qa", title: "Own interrupted task", cwd: root, status: "error", lastActivity: completedAt,
      meta: { nativeLastTurn: { turnId: "native-failed", userMessageId: "native-user", status: "failed", completedAt, retryable: true, pendingInput: false,
        userMessageMatchesLatest: true, assistantSucceeded: false, progressedAfterFailure: false, cancelledByUser: false } } };
    let sends = 0;
    const adapter = { type: "opencode", name: "OpenCode fixture", listSessions: async () => [current], getSession: async () => current,
      resumeSession: async () => ({ ok: true }), sendMessage: async () => { sends += 1; return { ok: true, admitted: true }; },
      getSessionMessages: async () => [{ id: "native-user", role: "user", text: "Finish marker", parts: [] }],
    } as unknown as HarnessAdapter;
    const store = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const settings = new SessionAutostartStore(join(root, "settings.json"), {});
    await settings.setHarness("opencode", true);
    const launcher = new UnfinishedSessionLauncher({ adapters: new Map([["opencode", adapter]]), store, settingsStore: settings, retryDelayMs: 1 });
    await launcher.recoverPending();
    expect(sends).toBe(1);
    expect((await store.list())[0]?.acceptedAt).toBeTruthy();
    await launcher.recoverPending();
    expect(sends).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
