import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("autopilot runner", () => {
  beforeEach(async () => {
    vi.resetModules();
    process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR = await mkdtemp(join(tmpdir(), "agent-herder-runner-"));
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
});
