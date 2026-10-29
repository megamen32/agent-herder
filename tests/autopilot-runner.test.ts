import { mkdtemp, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The runner starts the real daemon evaluation, so this file needs more than
// the default timeout of 5s under the load of the full suite.
vi.setConfig({ testTimeout: 30_000 });

describe("autopilot runner", () => {
  beforeEach(async () => {
    vi.resetModules();
    process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR = await mkdtemp(join(tmpdir(), "agent-herder-runner-"));
    process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR, "human-stops.json");
  });

  it("evaluates inside the daemon with a token file and inherited recipient, without native delivery", async () => {
    const { runAutopilotCommand, evaluateAutopilotStop } = await import("../src/autopilot-runner.js");
    const tokenPath = join(process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR!, "judge-token");
    await writeFile(tokenPath, "fixture-token\n");
    vi.stubEnv("AGENT_HERDER_AUTOPILOT_JUDGE_BASE_URL", "https://fixture-judge.invalid/v1");
    vi.stubEnv("AGENT_HERDER_AUTOPILOT_JUDGE_TOKEN", "");
    vi.stubEnv("AGENT_HERDER_AUTOPILOT_JUDGE_TOKEN_FILE", tokenPath);
    vi.stubEnv("AGENT_HERDER_AUTOPILOT_NOTIFY_RECIPIENT", "");
    vi.stubEnv("NOTIFY_CENTER_RECIPIENT", "fixture-recipient");
    vi.stubEnv("NOTIFY_CENTER_EVENT_URL", "https://fixture-notice.invalid/v1/events");
    vi.stubEnv("NOTIFY_CENTER_TOKEN", "fixture-notify-token");
    const judgeDeadline = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn(async (_url: unknown, init: any) => {
      expect(init.headers.authorization).toBe("Bearer fixture-token");
      return Response.json({ choices: [{ message: { content: JSON.stringify({ kind: "continue", nextGoal: "Проверить результат" }) } }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const input = { harness: "opencode" as const, sessionId: "background-fixture", cwd: "/workspace/app", turnId: "t1", lastAssistantMessage: "Осталась проверка" };
      await runAutopilotCommand({ ...input, command: "on" });
      await expect(evaluateAutopilotStop(input)).resolves.toMatchObject({ decision: "continue", next_goal: "Проверить результат" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(judgeDeadline).toHaveBeenCalledWith(90_000);
    } finally { judgeDeadline.mockRestore(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  });

  it("defaults slash invocation to on and persists exact current-session status", async () => {
    const { runAutopilotCommand } = await import("../src/autopilot-runner.js");
    const target = { harness: "codex" as const, sessionId: "thread-1", cwd: "/workspace/app" };

    expect(await runAutopilotCommand(target)).toMatchObject({ ok: true, command: "on", enabled: true });
    expect(await runAutopilotCommand({ ...target, command: "status" })).toMatchObject({
      ok: true,
      command: "status",
      enabled: true,
      source: "session",
    });
  });

  it("does not invoke the judge for a disabled lifecycle event", async () => {
    const { runAutopilotCommand } = await import("../src/autopilot-runner.js");
    const target = { harness: "opencode" as const, sessionId: "ses-1", cwd: "/workspace/app" };

    await runAutopilotCommand({ ...target, command: "off" });
    await expect(runAutopilotCommand({ ...target, command: "stop", turnId: "turn-1" })).resolves.toMatchObject({
      ok: true,
      enabled: false,
      decision: "disabled",
    });
  });

  it("persists an early-amendment judge failure without advancing the goal cursor", async () => {
    const { GoalStore } = await import("../src/autopilot/goal-store.js");
    const { evaluateAutopilotStop } = await import("../src/autopilot-runner.js");
    const root = process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR!;
    const identity = { harness: "codex", sessionId: "early-amendment-failure", cwd: root };
    const goals = new GoalStore(root);
    await goals.arm({ identity, goal: { eventId: "human-objective", text: "Build and verify the result" }, requirements: [] });
    await goals.acceptHumanEvent(identity, { eventId: "human-amendment", text: "Also include a concise report" });
    const before = await goals.snapshot(identity);

    vi.stubEnv("AGENT_HERDER_AUTOPILOT_JUDGE_BASE_URL", "https://judge.fixture.invalid/v1");
    vi.stubEnv("AGENT_HERDER_AUTOPILOT_JUDGE_MODEL", "fixture-model");
    const fetchMock = vi.fn(async () => Response.json({ error: { message: "fixture schema rejection" } }, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await evaluateAutopilotStop({ harness: "codex", sessionId: identity.sessionId, cwd: identity.cwd,
        nativeFence: async () => true, lastAssistantMessage: "prior turn ended" });
      const after = await goals.snapshot(identity);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ decision: "unavailable", reason: expect.stringContaining("fixture schema rejection") });
      expect(after.evaluation?.lastDecision).toBe("blocked");
      expect(after.evaluation?.lastReason).toContain("fixture schema rejection");
      expect(after.evaluation?.requirementMemo?.primaryHash).toMatch(/^[a-f0-9]{64}$/);
      expect(after.evaluation?.requirementMemo?.requirements).toEqual([]);
      expect(after.processedInputCursor).toBe(before.processedInputCursor);
      expect(after.processedInputCursor).toBeLessThan(after.inputCursor);
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  });

  it("admits native report proof only after the exact current continuation and rejects an old report after amendment", async () => {
    const root = process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR!;
    const { GoalStore } = await import("../src/autopilot/goal-store.js");
    const { autopilotGoalNativeReportAdmissible } = await import("../src/autopilot-runner.js");
    const goals = new GoalStore(root);
    const identity = { harness: "codex", sessionId: "native-report-correlation", cwd: root };
    await goals.arm({ identity, goal: { eventId: "human-1", text: "Complete the task and report it" }, requirements: [], nativeCursor: "before-action" });
    const beforeAdmission = await goals.snapshot(identity);
    const action = "Verify ALPHA-READY and BETA-FINAL, then emit the concise report";
    const actionFingerprint = createHash("sha256").update(action).digest("hex");
    await goals.withContinuationAdmission(identity, beforeAdmission, async () => ({ status: "accepted" }), {
      actionFingerprint, evidenceFingerprint: "sha256:evidence",
      classify: result => result.status === "accepted" ? "accepted" : "not-admitted",
    });
    const messages = [
      { id: "before-action", role: "assistant" as const, parts: [{ type: "text" as const, text: "Old report from before this goal step" }] },
      { id: "generated-input", role: "user" as const, parts: [{ type: "text" as const, text: action }] },
    ];
    await expect(autopilotGoalNativeReportAdmissible(identity, messages, "before-action")).resolves.toBe(false);
    const freshReply = [...messages, { id: "fresh-report", role: "assistant" as const, parts: [{ type: "text" as const, text: "ALPHA-READY and BETA-FINAL verified." }] }];
    await expect(autopilotGoalNativeReportAdmissible(identity, freshReply, "fresh-report")).resolves.toBe(true);
    await goals.stop(identity);
    await goals.resume(identity);
    await expect(autopilotGoalNativeReportAdmissible(identity, freshReply, "fresh-report")).resolves.toBe(true);

    await goals.acceptHumanEvent(identity, { eventId: "human-2", text: "Also include the changed-output explanation" });
    await expect(autopilotGoalNativeReportAdmissible(identity, freshReply, "fresh-report")).resolves.toBe(false);
  });

  it("inherits the selected harness from the persisted global policy", async () => {
    const { AutopilotPolicyStore } = await import("../src/autopilot/policy-store.js");
    const { createDefaultAutopilotPolicy } = await import("../src/autopilot/policy.js");
    const { runAutopilotCommand } = await import("../src/autopilot-runner.js");
    const root = process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR!;
    await new AutopilotPolicyStore(join(root, "autopilot-policy.json")).replacePolicy({
      ...createDefaultAutopilotPolicy(),
      enabled: true,
      harnesses: ["claude"],
    }, null);

    await expect(runAutopilotCommand({ command: "status", harness: "claude", sessionId: "claude-global", cwd: "/workspace/app" })).resolves.toMatchObject({ enabled: true, source: "persisted" });
    await expect(runAutopilotCommand({ command: "status", harness: "opencode", sessionId: "open-global", cwd: "/workspace/app" })).resolves.toMatchObject({ enabled: false, source: "persisted" });
  });

  it("lets the master off override a session that carries no switch of its own", async () => {
    const { AutopilotPolicyStore } = await import("../src/autopilot/policy-store.js");
    const { createDefaultAutopilotPolicy } = await import("../src/autopilot/policy.js");
    const { runAutopilotCommand } = await import("../src/autopilot-runner.js");
    const target = { harness: "codex" as const, sessionId: "master-off", cwd: "/workspace/app" };
    const root = process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR!;
    await new AutopilotPolicyStore(join(root, "autopilot-policy.json")).replacePolicy({
      ...createDefaultAutopilotPolicy(),
      enabled: false,
    }, null);

    // A session that was never switched on follows the global policy: with the
    // master off it is not judged.
    await expect(runAutopilotCommand({ ...target, command: "status" })).resolves.toMatchObject({ enabled: false });
    await expect(runAutopilotCommand({ ...target, command: "stop", turnId: "turn-1" })).resolves.toMatchObject({ enabled: false, decision: "disabled" });
  });

  it("keeps an explicitly enabled session judged while the master policy is off", async () => {
    const { AutopilotPolicyStore } = await import("../src/autopilot/policy-store.js");
    const { createDefaultAutopilotPolicy } = await import("../src/autopilot/policy.js");
    const { runAutopilotCommand } = await import("../src/autopilot-runner.js");
    const target = { harness: "codex" as const, sessionId: "master-off-opted-in", cwd: "/workspace/app" };
    await runAutopilotCommand({ ...target, command: "on" });
    const root = process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR!;
    await new AutopilotPolicyStore(join(root, "autopilot-policy.json")).replacePolicy({
      ...createDefaultAutopilotPolicy(),
      enabled: false,
    }, null);

    // The owner switched this exact session on, so the global default does not
    // silence it. The owner-facing setting says exactly this: with the master
    // off, new completions are not evaluated "except explicitly enabled
    // sessions".
    await expect(runAutopilotCommand({ ...target, command: "status" })).resolves.toMatchObject({ enabled: true, source: "session" });
  });

  it("does not enable or judge a human-stopped session until explicit release", async () => {
    const { getHumanStopStore } = await import("../src/human-stop-store.js");
    const { runAutopilotCommand } = await import("../src/autopilot-runner.js");
    const target = { harness: "codex" as const, sessionId: "human-stopped", cwd: "/workspace/app" };
    await getHumanStopStore().hold({ harness: target.harness, id: target.sessionId, cwd: target.cwd }, {
      id: "stop-event", at: new Date().toISOString(), reason: "human interruption", turnId: "turn-stop",
    });

    await expect(runAutopilotCommand({ ...target, command: "on" })).resolves.toMatchObject({
      enabled: false,
      human_stop_held: true,
    });
    await expect(runAutopilotCommand({ ...target, command: "stop", turnId: "turn-after-stop" })).resolves.toMatchObject({
      decision: "human-stop-held",
    });
    await expect(getHumanStopStore().isHeld("codex", target.sessionId)).resolves.toBe(true);
  });

  it("records the exact Codex stop-hook continuation for generated-input provenance", async () => {
    const { runAutopilotStopHook } = await import("../src/autopilot-hook.js");
    const { getHumanStopStore } = await import("../src/human-stop-store.js");
    const sessionId = "generated-codex-continuation";
    const nextGoal = "<agent-herder-inbox>verify the exact task</agent-herder-inbox>";
    const result = await runAutopilotStopHook({
      hook_event_name: "Stop",
      session_id: sessionId,
      cwd: "/workspace/app",
      turn_id: "current-turn",
      last_assistant_message: "Still working.",
      transcript_path: null,
      stop_hook_active: false,
      harness: "codex",
    }, {
      judge: { async decide() { return { kind: "continue", nextGoal }; } },
      notify: { async send() {} },
      allowSessions: new Set([sessionId]),
      receiptStore: new Map(),
      maxContinuationsPerSession: 2,
      humanStopStore: getHumanStopStore(),
    });

    expect(result).toEqual({ decision: "block", reason: nextGoal });
    await expect(getHumanStopStore().isGeneratedPrompt("codex", sessionId, { text: nextGoal })).resolves.toBe(true);
  });
});
