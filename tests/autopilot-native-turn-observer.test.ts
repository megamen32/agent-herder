import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { NativeTurnAutopilotObserver } from "../src/autopilot/native-turn-observer.js";
import { normalizeOpenCodeEvent } from "../src/adapters/opencode.js";
import type { HarnessAdapter, HarnessEvent } from "../src/types/index.js";

// Focused unit: native turn events become the same durable Stop submission a
// hook makes, and a disabled session never creates a job.
// Expected <1s/max 10s. No provider, judge or native session.
function adapterReturning(events: HarnessEvent[], cwd?: string): HarnessAdapter {
  return {
    type: "opencode",
    name: "OpenCode",
    controlCapabilities: {} as never,
    subscribeEvents(handler: (event: HarnessEvent) => void) {
      for (const event of events) handler(event);
      return () => {};
    },
    async getSession() { return cwd ? ({ id: "ses_1", harness: "opencode", status: "idle", title: "t", cwd, lastActivity: "", needsPermission: false } as never) : null; },
  } as unknown as HarnessAdapter;
}

async function flush(times = 6): Promise<void> {
  for (let index = 0; index < times; index++) await new Promise((resolve) => setTimeout(resolve, 5));
}

it("submits a Stop for a finished native turn when Autopilot is enabled", async () => {
  const event = normalizeOpenCodeEvent({
    id: "evt_turn_done",
    type: "session.execution.succeeded",
    location: { directory: "/tmp/project" },
    data: { sessionID: "ses_1" },
  })!;
  expect(event.kind).toBe("turn.completed");
  expect(event.data).toMatchObject({ nativeEventId: "evt_turn_done", directory: "/tmp/project" });

  const submit = vi.fn();
  const observer = new NativeTurnAutopilotObserver({
    harness: "opencode",
    adapter: adapterReturning([event]),
    enabled: async () => true,
    submit,
  });
  const stop = observer.start();
  await flush();
  stop();
  expect(submit).toHaveBeenCalledTimes(1);
  expect(submit.mock.calls[0][0]).toMatchObject({ harness: "opencode", sessionId: "ses_1", cwd: "/tmp/project", turnId: "opencode:evt_turn_done" });
});

it("never submits for a disabled session, a foreign event or a missing cwd", async () => {
  const submit = vi.fn();
  const enabled = vi.fn(async () => false);
  const observer = new NativeTurnAutopilotObserver({
    harness: "opencode",
    adapter: adapterReturning([
      normalizeOpenCodeEvent({ id: "evt_done", type: "session.execution.succeeded", data: { sessionID: "ses_1" } })!,
      normalizeOpenCodeEvent({ id: "evt_start", type: "session.execution.started", location: { directory: "/tmp/project" }, data: { sessionID: "ses_1" } })!,
      normalizeOpenCodeEvent({ id: "evt_text", type: "session.text.delta", location: { directory: "/tmp/project" }, data: { sessionID: "ses_1" } }),
    ]),
    enabled,
    submit,
    resolveCwd: async () => undefined,
  });
  const stop = observer.start();
  await flush();
  stop();
  expect(submit).not.toHaveBeenCalled();
  // Without a resolvable directory the turn is never even probed: no job, no
  // status read, and a delta/started event is ignored outright.
  expect(enabled).not.toHaveBeenCalled();
});

it("does not submit a Stop for a session whose Autopilot is disabled", async () => {
  const submit = vi.fn();
  const observer = new NativeTurnAutopilotObserver({
    harness: "opencode",
    adapter: adapterReturning([normalizeOpenCodeEvent({ id: "evt_done", type: "session.execution.succeeded", location: { directory: "/tmp/project" }, data: { sessionID: "ses_1" } })!]),
    enabled: async () => false,
    submit,
  });
  const stop = observer.start();
  await flush();
  stop();
  expect(submit).not.toHaveBeenCalled();
});

it("resolves the cwd from the native session when the frame carries none", async () => {
  const submit = vi.fn();
  const adapter = adapterReturning([normalizeOpenCodeEvent({ id: "evt_done", type: "session.execution.succeeded", data: { sessionID: "ses_1" } })!], "/workspace/from-session");
  const observer = new NativeTurnAutopilotObserver({
    harness: "opencode",
    adapter,
    enabled: async () => true,
    submit,
    resolveCwd: async (sessionId) => (await adapter.getSession(sessionId))?.cwd,
  });
  const stop = observer.start();
  await flush();
  stop();
  expect(submit.mock.calls[0][0]).toMatchObject({ cwd: "/workspace/from-session" });
});

it("reports observer problems instead of throwing into the event stream", async () => {
  const dir = await mkdtemp(join(tmpdir(), "herder-turn-observer-"));
  const onError = vi.fn();
  const observer = new NativeTurnAutopilotObserver({
    harness: "opencode",
    adapter: adapterReturning([normalizeOpenCodeEvent({ id: "evt_done", type: "session.execution.succeeded", location: { directory: "/tmp/project" }, data: { sessionID: "ses_1" } })!]),
    enabled: async () => { throw new Error("store offline"); },
    submit: vi.fn(),
    onError,
  });
  const stop = observer.start();
  await flush();
  stop();
  await rm(dir, { recursive: true, force: true });
  expect(onError).toHaveBeenCalledWith(expect.stringContaining("status probe failed"));
});
/**
 * The whole OpenCode chain, end to end.
 *
 * The native turn observer is the only path an OpenCode completion takes into
 * the Autopilot judge: it probes the session state and submits a Stop for a
 * finished turn. The probe used to answer "disabled" for a session the owner
 * had switched on, because the per-session switch was ANDed with the global
 * master policy — so an armed OpenCode session with an unfinished goal was
 * never continued at all.
 *
 * This test wires the real state command into the real observer, so the
 * defect cannot hide behind a stubbed probe.
 */
it("continues an armed OpenCode session while the global master policy is off", async () => {
  const dir = await mkdtemp(join(tmpdir(), "herder-turn-observer-armed-"));
  const cleanup: Array<() => Promise<void>> = [() => rm(dir, { recursive: true, force: true })];
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

  vi.resetModules();
  process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR = dir;
  process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(dir, "human-stops.json");
  const { runAutopilotCommand } = await import("../src/autopilot-runner.js");
  const { AutopilotPolicyStore } = await import("../src/autopilot/policy-store.js");
  const { createDefaultAutopilotPolicy } = await import("../src/autopilot/policy.js");

  // The live fleet master policy: the global switch is off.
  await new AutopilotPolicyStore(join(dir, "autopilot-policy.json")).replacePolicy({
    ...createDefaultAutopilotPolicy(),
    enabled: false,
  }, null);

  const target = { harness: "opencode" as const, sessionId: "ses_1", cwd: "/tmp/project" };
  await runAutopilotCommand({ ...target, command: "on" });

  const event = normalizeOpenCodeEvent({
    id: "evt_turn_done",
    type: "session.execution.succeeded",
    location: { directory: "/tmp/project" },
    data: { sessionID: "ses_1" },
  })!;

  const submit = vi.fn();
  const observer = new NativeTurnAutopilotObserver({
    harness: "opencode",
    adapter: adapterReturning([event]),
    // The real gate, exactly as the running service wires it.
    enabled: async (input) => (await runAutopilotCommand({ ...input, command: "status" })).enabled === true,
    submit,
  });
  const stop = observer.start();
  await flush();
  stop();

  // The finished turn of an armed session reaches the judge instead of being
  // dropped by a probe that said "disabled".
  expect(submit).toHaveBeenCalledTimes(1);
  expect(submit.mock.calls[0][0]).toMatchObject({ harness: "opencode", sessionId: "ses_1", cwd: "/tmp/project" });
});
