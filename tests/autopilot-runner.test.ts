import { mkdtemp, writeFile } from "node:fs/promises";
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

  it("lets master off override a saved enabled session", async () => {
    const { AutopilotPolicyStore } = await import("../src/autopilot/policy-store.js");
    const { createDefaultAutopilotPolicy } = await import("../src/autopilot/policy.js");
    const { runAutopilotCommand } = await import("../src/autopilot-runner.js");
    const target = { harness: "codex" as const, sessionId: "master-off", cwd: "/workspace/app" };
    await runAutopilotCommand({ ...target, command: "on" });
    const root = process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR!;
    await new AutopilotPolicyStore(join(root, "autopilot-policy.json")).replacePolicy({
      ...createDefaultAutopilotPolicy(),
      enabled: false,
    }, null);

    await expect(runAutopilotCommand({ ...target, command: "status" })).resolves.toMatchObject({ enabled: false, source: "session" });
    await expect(runAutopilotCommand({ ...target, command: "stop", turnId: "turn-1" })).resolves.toMatchObject({ enabled: false, decision: "disabled" });
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
