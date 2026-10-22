import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { automationDisarmDecision, AUTOMATION_WORK_DISARMED_MESSAGE } from "../src/automation-disarm/guard.js";
import { AutomationDisarmStore } from "../src/automation-disarm/state.js";
import { projectWorkKey } from "../src/automation-disarm/work-key.js";
import { AUTOMATION_DISABLED_CODE } from "../src/automation/health-reason-codes.js";
import {
  attemptKeyOf,
  dispatchProjectLaunch,
  ProjectLaunchAttemptLog,
  type ProjectLaunchDispatchResult,
} from "../src/automation/project-launch-dispatch.js";
import { validateAutomationLaunchPolicy, type AutomationLaunchPolicy } from "../src/automation-launch-policy.js";
import type { NamedSessionResult } from "../src/named-session.js";

/** The root of the configured route. */
const ROUTE_ROOT = "/workspace/root";
/** A directory inside the root of the route. */
const ROUTE_SUBDIR = "/workspace/root/sub";

const cleanups: Array<() => Promise<void>> = [];
let stateDir = "";
let workDir = "";

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "agent-herder-disarm-keys-state-"));
  workDir = await mkdtemp(join(tmpdir(), "agent-herder-disarm-keys-work-"));
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

/** A route whose root is the parent of the directory a card names. */
function policyWithParentRoute(): AutomationLaunchPolicy {
  return validateAutomationLaunchPolicy({
    version: 1,
    allowedHarnesses: ["opencode"],
    preferredHarness: "opencode",
    models: { opencode: "omniroute/glm-5.3-flash-minimax-m3.1" },
    projectRoutes: { [ROUTE_ROOT]: { harnesses: ["opencode"] } },
  });
}

/** The same route, with the subdirectory declared as one of its aliases. */
function policyWithAliasedRoute(): AutomationLaunchPolicy {
  return validateAutomationLaunchPolicy({
    version: 1,
    allowedHarnesses: ["opencode"],
    preferredHarness: "opencode",
    models: { opencode: "omniroute/glm-5.3-flash-minimax-m3.1" },
    projectRoutes: { [ROUTE_ROOT]: { harnesses: ["opencode"], aliases: [ROUTE_SUBDIR] } },
  });
}

/** The owner blocks the work of a project, exactly as the owner route does. */
async function blockProject(project: string): Promise<void> {
  const change = await AutomationDisarmStore.forRuntime().apply({
    source: "owner", disarmed: false, workKeys: [`project|${project}`],
  });
  expect(change.ok).toBe(true);
  expect(change.state.blockedWorkKeys).toEqual([projectWorkKey(project)]);
}

/** A native runner that never touches a real harness. */
function acceptingRunner(): ReturnType<typeof vi.fn> {
  return vi.fn(async (request: { harness: string; cwd: string; inputId: string; model?: string }): Promise<NamedSessionResult> => ({
    ok: true,
    created: true,
    harness: request.harness,
    name: "disarm-project-keys",
    cwd: request.cwd,
    sessionId: "native-disarm-project-keys",
    inputId: request.inputId,
    delivery: "accepted",
    ...(request.model ? { model: request.model } : {}),
  }));
}

/** One automatic dispatch of a project, with its own attempt log and runner. */
async function launch(
  policy: AutomationLaunchPolicy,
  project: string,
  operationId: string,
): Promise<{ result: ProjectLaunchDispatchResult; run: ReturnType<typeof vi.fn> }> {
  const run = acceptingRunner();
  const result = await dispatchProjectLaunch({
    policy,
    project,
    cwd: workDir,
    message: "fix the incident",
    operationId,
  }, new ProjectLaunchAttemptLog(join(workDir, `attempts-${operationId}.json`)), run);
  return { result, run };
}

/**
 * The owner-level disarm gate of a project launch.
 *
 * The work of a dispatch has two project names: the project the caller asked
 * for and the project the route governs. The route may resolve a directory to
 * the root that contains it, so the key the owner blocked can be either of the
 * two names. The gate checks both of them, so a block of the owner never falls
 * silent when the route resolution of a project changes.
 */
describe("the owner-level disarm gate of a project launch", () => {
  it("refuses the launch of a blocked subdirectory the route governs", async () => {
    // The owner blocked the work of the subdirectory the card names.
    await blockProject(ROUTE_SUBDIR);
    const { result, run } = await launch(policyWithAliasedRoute(), ROUTE_SUBDIR, "op-blocked-subdirectory");

    // The route resolves the subdirectory to its root, and the block of the
    // subdirectory still holds: the gate checks the requested project too.
    expect(result.outcome).toBe("no_harness");
    expect(result.routingReason).toBe(AUTOMATION_WORK_DISARMED_MESSAGE);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses the launch of a blocked route root", async () => {
    // The owner blocked the work of the root of the route.
    await blockProject(ROUTE_ROOT);
    const { result, run } = await launch(policyWithAliasedRoute(), ROUTE_SUBDIR, "op-blocked-route-root");

    // The route governs the subdirectory, so the block of the root holds.
    expect(result.outcome).toBe("no_harness");
    expect(result.routingReason).toBe(AUTOMATION_WORK_DISARMED_MESSAGE);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses the launch of a blocked project that is the route root itself", async () => {
    await blockProject(ROUTE_ROOT);
    const { result, run } = await launch(policyWithAliasedRoute(), ROUTE_ROOT, "op-blocked-root-exact");

    expect(result.outcome).toBe("no_harness");
    expect(result.routingReason).toBe(AUTOMATION_WORK_DISARMED_MESSAGE);
    expect(run).not.toHaveBeenCalled();
  });

  it("names the class of the refusal and the cause of a blocked work", async () => {
    await blockProject(ROUTE_SUBDIR);
    const { result } = await launch(policyWithAliasedRoute(), ROUTE_SUBDIR, "op-refusal-class");

    // The class of the refusal is the one the owner gate names.
    expect(result.routingReasonCode).toBe(AUTOMATION_DISABLED_CODE);
    expect(result.routingReasonCode).toBe("automation_disabled");
    // The cause is told apart from a forbidden automation.
    expect(result.routingReasonDetail).toBe("work_disarmed");
    // The reason a person reads is the one of before.
    expect(result.routingReason).toBe(AUTOMATION_WORK_DISARMED_MESSAGE);
    expect(result.error).toBe(AUTOMATION_WORK_DISARMED_MESSAGE);
    // The refused work is the blocked one: the store holds exactly that key.
    expect((await AutomationDisarmStore.forRuntime().read()).blockedWorkKeys).toEqual([projectWorkKey(ROUTE_SUBDIR)]);
  });

  it("decides on the requested project first and on the route project second", async () => {
    await AutomationDisarmStore.forRuntime().apply({
      source: "owner", disarmed: false,
      workKeys: [projectWorkKey(ROUTE_SUBDIR), projectWorkKey(ROUTE_ROOT)],
    });
    const decision = await automationDisarmDecision(
      AutomationDisarmStore.forRuntime(),
      [projectWorkKey(ROUTE_SUBDIR), projectWorkKey(ROUTE_ROOT)],
      "automation",
    );

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("work_disarmed");
    // The decision names the key it was made on: the requested project first.
    expect(decision.workKey).toBe(projectWorkKey(ROUTE_SUBDIR));
  });

  it("matches the blocked work key exactly and never a neighbour of it", async () => {
    // The block of another project of the same route does not refuse this one.
    await blockProject("/workspace/root/other");
    const { result, run } = await launch(policyWithAliasedRoute(), ROUTE_SUBDIR, "op-other-block");

    expect(result.outcome).toBe("accepted");
    expect(result.routingReasonDetail).toBeUndefined();
    expect(run).toHaveBeenCalled();
  });

  it("keeps the ordinary launch of an armed runtime without a blocked work", async () => {
    const { result, run } = await launch(policyWithAliasedRoute(), ROUTE_SUBDIR, "op-armed");

    expect(result.outcome).toBe("accepted");
    expect(result.routingReasonCode).toBeUndefined();
    expect(result.routingReasonDetail).toBeUndefined();
    expect(run).toHaveBeenCalled();
  });

  it("honors the project the route governs, whatever the route resolves to", async () => {
    const policy = policyWithParentRoute();
    // The route lookup may resolve a directory to the root that contains it.
    // The gate honors the name the lookup gives as well, so the block of the
    // route root survives the change of the route resolution.
    const governed = attemptKeyOf(policy, ROUTE_SUBDIR);
    const change = await AutomationDisarmStore.forRuntime().apply({
      source: "owner", disarmed: false, workKeys: [projectWorkKey(governed)],
    });
    expect(change.ok).toBe(true);

    const { result, run } = await launch(policy, ROUTE_SUBDIR, "op-governed");
    expect(result.outcome).toBe("no_harness");
    expect(result.routingReasonDetail).toBe("work_disarmed");
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps the block of the requested directory when the route governs it", async () => {
    const policy = policyWithParentRoute();
    // The name the owner wrote for the requested directory holds as well, even
    // when the route resolves that directory to another project.
    await blockProject(ROUTE_SUBDIR);

    const { result, run } = await launch(policy, ROUTE_SUBDIR, "op-requested-name");
    expect(result.outcome).toBe("no_harness");
    expect(result.routingReasonDetail).toBe("work_disarmed");
    expect(run).not.toHaveBeenCalled();
  });
});
