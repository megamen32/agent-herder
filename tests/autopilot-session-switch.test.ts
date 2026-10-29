import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

/**
 * Regression for the on/status divergence of the Autopilot switch.
 *
 * `autopilot_set action=on` writes the per-session switch and answers
 * `enabled:true`. `autopilot_set action=status` used to answer `enabled:false`
 * for the very same session, because the durable session switch was ANDed with
 * the global master policy — and the live master policy carries
 * `enabled:false`. The durable file held `enabled:true` the whole time, so the
 * switch looked armed in the state and looked off in the product.
 *
 * This matters beyond the read: every native turn of OpenCode reaches the
 * Autopilot bridge through the same `status` command, so a session the owner
 * armed was never continued. The per-session switch is the owner's explicit
 * decision for one exact session, and it must survive a restart.
 */
describe("autopilot per-session switch", () => {
  beforeEach(async () => {
    vi.resetModules();
    process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR = await mkdtemp(join(tmpdir(), "agent-herder-autopilot-switch-"));
    process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR, "human-stops.json");
  });

  it("reports the same state for on and status while the global master policy is off", async () => {
    const { runAutopilotCommand } = await import("../src/autopilot-runner.js");
    const { AutopilotPolicyStore } = await import("../src/autopilot/policy-store.js");
    const { createDefaultAutopilotPolicy } = await import("../src/autopilot/policy.js");

    // The live master policy of the fleet: the global switch is off, so the
    // global policy alone never arms a session.
    await new AutopilotPolicyStore(join(process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR!, "autopilot-policy.json"))
      .replacePolicy({ ...createDefaultAutopilotPolicy(), enabled: false }, null);

    const target = { harness: "opencode" as const, sessionId: "opencode-armed", cwd: "/workspace/app" };

    const on = await runAutopilotCommand({ ...target, command: "on" });
    expect(on).toMatchObject({ ok: true, command: "on", enabled: true });

    // The status of the same session must not contradict the switch that was
    // just written.
    const status = await runAutopilotCommand({ ...target, command: "status" });
    expect(status).toMatchObject({ ok: true, command: "status", enabled: true });

    // The durable file and the reported state are one fact.
    const { AutopilotSessionStore } = await import("../src/autopilot/session-store.js");
    const record = await new AutopilotSessionStore(join(process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR!, "sessions.json"))
      .get("opencode", "opencode-armed");
    expect(record?.enabled).toBe(true);
    expect(status.enabled).toBe(record?.enabled);
  });

  it("keeps the armed session enabled after the master policy is re-read from disk", async () => {
    const { runAutopilotCommand } = await import("../src/autopilot-runner.js");
    const { AutopilotPolicyStore } = await import("../src/autopilot/policy-store.js");
    const { createDefaultAutopilotPolicy } = await import("../src/autopilot/policy.js");

    await new AutopilotPolicyStore(join(process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR!, "autopilot-policy.json"))
      .replacePolicy({ ...createDefaultAutopilotPolicy(), enabled: false }, null);

    const target = { harness: "opencode" as const, sessionId: "opencode-restart", cwd: "/workspace/app" };

    await runAutopilotCommand({ ...target, command: "on" });

    // A restart re-reads every durable file. The switch must survive it.
    vi.resetModules();
    const { runAutopilotCommand: afterRestart } = await import("../src/autopilot-runner.js");
    await expect(afterRestart({ ...target, command: "status" })).resolves.toMatchObject({ enabled: true });
  });

  it("still reports an explicitly disabled session as disabled", async () => {
    const { runAutopilotCommand } = await import("../src/autopilot-runner.js");
    const target = { harness: "opencode" as const, sessionId: "opencode-off", cwd: "/workspace/app" };

    await runAutopilotCommand({ ...target, command: "on" });
    await runAutopilotCommand({ ...target, command: "off" });

    await expect(runAutopilotCommand({ ...target, command: "status" })).resolves.toMatchObject({ enabled: false });
  });
});
