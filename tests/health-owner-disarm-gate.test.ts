import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AutomationDisarmStore } from "../src/automation-disarm/index.js";
import {
  AUTOMATION_DISABLED_CODE,
  INCIDENT_NOT_OPEN_CODE,
  NO_SELECTED_HEALTH_PLAN_CODE,
  type HealthReasonRefusal,
} from "../src/automation/health-reason-codes.js";
import { NoticeplaceHealthObserver } from "../src/automation/noticeplace-health-observer.js";
import { recoverNoticeplaceHealthObservation } from "../src/automation/noticeplace-health-recovery.js";
import { dispatchProjectLaunch, ProjectLaunchAttemptLog } from "../src/automation/project-launch-dispatch.js";
import { validateAutomationLaunchPolicy } from "../src/automation-launch-policy.js";
import type { NamedSessionResult } from "../src/named-session.js";
import type { SessionDetails } from "../src/types/index.js";

const cleanups: Array<() => Promise<void>> = [];
let stateDir = "";
let workDir = "";

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "agent-herder-health-disarm-state-"));
  workDir = await mkdtemp(join(tmpdir(), "agent-herder-health-disarm-work-"));
  cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  cleanups.push(() => rm(workDir, { recursive: true, force: true }));
  // The owner state of a test is a temporary file: the live state of the
  // runtime is never read and never written by a test.
  vi.stubEnv("AGENT_HERDER_AUTOPILOT_STATE_DIR", stateDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** The owner turns the lever on, exactly as the owner route of the runtime does. */
async function disarmByOwner(reason = "the owner stopped the automation"): Promise<void> {
  const change = await AutomationDisarmStore.forRuntime().apply({ source: "owner", disarmed: true, reason });
  expect(change.ok).toBe(true);
}

/** One live executor session, as the observer reads it. */
function details(status: string, text: string): SessionDetails {
  return {
    session: {
      id: "ses_test", harness: "opencode", status, title: "health", cwd: "/tmp",
      lastActivity: "2026-01-01T00:00:00.000Z", needsPermission: false, messageCount: 1, lastMessage: text,
    },
    lineage: { kind: "root" },
    children: [],
    messages: [{ id: "msg_1", role: "assistant", text, parts: [] }],
    history: { source: "live-cache", complete: true },
  } as unknown as SessionDetails;
}

// The incident binding carries the selected plan: the center accepts progress
// only for that plan.
const binding = { incidentId: "inc_test", project: "omniroute-guard", planId: "repair" as const };

/** A native runner that never touches a real harness. */
function acceptingRunner(): ReturnType<typeof vi.fn> {
  return vi.fn(async (request: { harness: string; cwd: string; inputId: string; model?: string }): Promise<NamedSessionResult> => ({
    ok: true,
    created: true,
    harness: request.harness,
    name: "health-owner-disarm-gate",
    cwd: request.cwd,
    sessionId: "native-health-owner-disarm-gate",
    inputId: request.inputId,
    delivery: "accepted",
    ...(request.model ? { model: request.model } : {}),
  }));
}

/** A native runner whose launch is refused before the admission. */
function refusingRunner(): ReturnType<typeof vi.fn> {
  return vi.fn(async (request: { harness: string; cwd: string; inputId: string; model?: string }): Promise<NamedSessionResult> => ({
    ok: false,
    created: false,
    harness: request.harness,
    name: "health-owner-disarm-gate",
    cwd: request.cwd,
    sessionId: "native-health-owner-disarm-gate",
    inputId: request.inputId,
    delivery: "not_attempted",
    error: "the harness refused the launch",
  }));
}

const policy = validateAutomationLaunchPolicy({
  version: 1,
  allowedHarnesses: ["opencode"],
  preferredHarness: "opencode",
  models: { opencode: "omniroute/glm-5.3-flash-minimax-m3.1" },
  projectRoutes: {
    "/workspace/guarded": { harnesses: ["opencode"] },
  },
});

/**
 * The owner-level lever of the runtime.
 *
 * The lever is the authority of the owner: while it is on, the health contour
 * observes no executor, publishes no progress and repairs no observation. A
 * state that cannot be read is a forbidden state, so a broken file never
 * re-enables the automation by accident.
 */
describe("the owner-level disarm gate of the health contour", () => {
  it("refuses the observation while the owner forbids automation", async () => {
    await disarmByOwner();
    const readDetails = vi.fn(async () => details("running", "Шаг"));
    const publish = vi.fn(async () => {});
    const errors: string[] = [];
    const refusals: HealthReasonRefusal[] = [];
    const observer = new NoticeplaceHealthObserver({
      readDetails,
      publish,
      onError: (message) => errors.push(message),
      onRefused: (refusal) => refusals.push(refusal),
    });

    const outcome = await observer.start({ harness: "opencode", sessionId: "ses_disarmed", cwd: "/tmp", binding });

    expect(outcome).toBe("refused");
    // The executor is neither read nor published into the incident.
    expect(readDetails).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    // The refusal carries the machine-readable class of the cause.
    expect(refusals.map((refusal) => refusal.code)).toEqual([AUTOMATION_DISABLED_CODE]);
    expect(errors.join("\n")).toContain(AUTOMATION_DISABLED_CODE);
    // The class is one literal, shared with the dispatcher.
    expect(AUTOMATION_DISABLED_CODE).toBe("automation_disabled");
  });

  it("observes as before when the owner never made a decision", async () => {
    const published: string[] = [];
    const observer = new NoticeplaceHealthObserver({
      readDetails: async () => details("running", "Шаг"),
      publish: async (update) => { published.push(update.step); },
      intervalMs: 5,
    });

    const outcome = await observer.start({ harness: "opencode", sessionId: "ses_armed", cwd: "/tmp", binding });
    await new Promise((resolve) => setTimeout(resolve, 120));
    observer.stop();

    // An absent owner file is an armed runtime: nothing is blocked.
    expect(outcome).toBe("started");
    expect(published.length).toBeGreaterThan(0);
  });

  it("blocks the observation when the owner file cannot be trusted", async () => {
    await writeFile(join(stateDir, "automation-disarm.json"), "{ this is not the owner state", "utf8");
    const readDetails = vi.fn(async () => details("running", "Шаг"));
    const publish = vi.fn(async () => {});
    const refusals: HealthReasonRefusal[] = [];
    const observer = new NoticeplaceHealthObserver({
      readDetails,
      publish,
      onRefused: (refusal) => refusals.push(refusal),
    });

    const outcome = await observer.start({ harness: "opencode", sessionId: "ses_broken", cwd: "/tmp", binding });

    // A corrupt owner file reads as forbidden, never as allowed.
    expect(outcome).toBe("refused");
    expect(readDetails).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(refusals.map((refusal) => refusal.code)).toEqual([AUTOMATION_DISABLED_CODE]);
  });

  it("does not repair the observation while the owner forbids automation", async () => {
    await disarmByOwner();
    const arm = vi.fn(async () => "started" as const);

    const result = await recoverNoticeplaceHealthObservation({
      candidates: [{ harness: "opencode", sessionId: "ses_recovery", cwd: "/tmp", binding }],
      isAlive: async () => true,
      arm,
    });

    // The repair does not run and the card stays open for the operator.
    expect(result.armed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(arm).not.toHaveBeenCalled();
    expect(result.reasons.join("\n")).toContain(AUTOMATION_DISABLED_CODE);
  });

  it("names the refusal of the dispatch with the class of the owner lever", async () => {
    await disarmByOwner("владелец остановил автоматику");
    const run = acceptingRunner();

    const result = await dispatchProjectLaunch({
      policy,
      project: "/workspace/guarded",
      cwd: workDir,
      message: "Исправить инцидент",
      operationId: "op-disarmed",
    }, new ProjectLaunchAttemptLog(join(workDir, "attempts-disarmed.json")), run);

    expect(result.outcome).toBe("no_harness");
    expect(result.routingReasonCode).toBe("automation_disabled");
    expect(result.routingReason).toContain("Автоматический запуск запрещён владельцем");
    // A forbidden runtime never touches a harness.
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps the ordinary launch when the owner allows automation", async () => {
    const run = acceptingRunner();

    const result = await dispatchProjectLaunch({
      policy,
      project: "/workspace/guarded",
      cwd: workDir,
      message: "Исправить инцидент",
      operationId: "op-armed",
    }, new ProjectLaunchAttemptLog(join(workDir, "attempts-armed.json")), run);

    expect(result.outcome).toBe("accepted");
    expect(result.routingReasonCode).toBeUndefined();
    expect(run).toHaveBeenCalled();
  });

  it("names an exhausted route as no_harness_left on the first refusal", async () => {
    const run = refusingRunner();
    const log = new ProjectLaunchAttemptLog(join(workDir, "attempts-exhausted.json"));

    const first = await dispatchProjectLaunch({
      policy,
      project: "/workspace/guarded",
      cwd: workDir,
      message: "Исправить инцидент",
      operationId: "op-exhausted",
    }, log, run);

    // The route has one harness and it refused: the route is exhausted, and
    // the class says so instead of naming an unconfirmed admission.
    expect(first.outcome).toBe("no_harness");
    expect(first.routingReasonCode).toBe("no_harness_left");

    const second = await dispatchProjectLaunch({
      policy,
      project: "/workspace/guarded",
      cwd: workDir,
      message: "Исправить инцидент",
      operationId: "op-exhausted",
    }, log, run);

    // The repeat of the same operation names the same class.
    expect(second.outcome).toBe("no_harness");
    expect(second.routingReasonCode).toBe("no_harness_left");
  });
});

/**
 * The classes of the refusals of the observer and of the recovery.
 *
 * The wording an operator reads stays as it was; the class is added next to
 * it, so the observer of the Projects contour can count the refusals without
 * parsing a free text.
 */
describe("the reason codes of the observer and of the recovery", () => {
  it("names the refusal of an incident without a selected plan", async () => {
    const errors: string[] = [];
    const refusals: HealthReasonRefusal[] = [];
    const observer = new NoticeplaceHealthObserver({
      readDetails: async () => details("running", "Шаг"),
      publish: async () => {},
      onError: (message) => errors.push(message),
      onRefused: (refusal) => refusals.push(refusal),
    });

    const outcome = await observer.start({
      harness: "opencode",
      sessionId: "ses_no_plan",
      cwd: "/tmp",
      binding: { incidentId: "inc_test", project: "omniroute-guard" },
    });

    expect(outcome).toBe("refused");
    expect(refusals.map((refusal) => refusal.code)).toEqual([NO_SELECTED_HEALTH_PLAN_CODE]);
    // The existing wording is still there; only the class was added.
    expect(errors.join("\n")).toContain("Notice health observer refused ses_no_plan: the incident inc_test has no selected health plan");
  });

  it("names the refusal of an incident that is not open any more", async () => {
    const refusals: HealthReasonRefusal[] = [];
    const observer = new NoticeplaceHealthObserver({
      readDetails: async () => details("running", "Шаг"),
      publish: async () => {},
      validateTarget: async () => "Notice incident inc_test is not open (state resolved)",
      onRefused: (refusal) => refusals.push(refusal),
    });

    const outcome = await observer.start({ harness: "opencode", sessionId: "ses_closed", cwd: "/tmp", binding });

    expect(outcome).toBe("refused");
    expect(refusals.map((refusal) => refusal.code)).toEqual([INCIDENT_NOT_OPEN_CODE]);
  });

  it("keeps the wording of the refusals of the recovery and only adds the class", async () => {
    const result = await recoverNoticeplaceHealthObservation({
      candidates: [{ harness: "opencode", sessionId: "ses_no_plan", cwd: "/tmp", binding: { incidentId: "inc_test", project: "omniroute-guard" } }],
      isAlive: async () => true,
      arm: async () => "started",
    });

    expect(result.armed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.reasons.join("\n")).toContain("the incident inc_test has no selected health plan");
    expect(result.reasons.join("\n")).toContain(NO_SELECTED_HEALTH_PLAN_CODE);
  });
});
