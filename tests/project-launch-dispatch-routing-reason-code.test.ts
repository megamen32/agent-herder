import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { validateAutomationLaunchPolicy } from "../src/automation-launch-policy.js";
import { dispatchProjectLaunch, ProjectLaunchAttemptLog } from "../src/automation/project-launch-dispatch.js";
import { MODEL_NOT_PERMITTED_CODE } from "../src/project-model-policy.js";
import type { NamedSessionResult } from "../src/named-session.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-herder-routing-reason-code-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A native runner that never touches a real harness. */
function acceptingRunner(): ReturnType<typeof vi.fn> {
  return vi.fn(async (request: { harness: string; cwd: string; inputId: string; model?: string }): Promise<NamedSessionResult> => ({
    ok: true,
    created: true,
    harness: request.harness,
    name: "routing-reason-code",
    cwd: request.cwd,
    sessionId: "native-routing-reason-code",
    inputId: request.inputId,
    delivery: "accepted",
    ...(request.model ? { model: request.model } : {}),
  }));
}

/**
 * The routing decision of a project launch is reported twice: as the text a
 * person reads and as a stable class an observer reads. The class must name
 * the same refusal the tool error code names.
 */
describe("the routing reason code of a project launch", () => {
  it("names the model the project policy forbids with the shared code", async () => {
    const dir = await root();
    const cwd = await root();
    const policy = validateAutomationLaunchPolicy({
      version: 1,
      allowedHarnesses: ["opencode"],
      preferredHarness: "opencode",
      models: { opencode: "omniroute/glm-5.3-flash-minimax-m3.1" },
      projectRoutes: {
        "/workspace/guarded": { harnesses: ["opencode"], deniedModels: ["omniroute/glm-5.3-flash-minimax-m3.1"] },
      },
    });
    const run = acceptingRunner();

    const result = await dispatchProjectLaunch({
      policy,
      project: "/workspace/guarded",
      cwd,
      message: "Исправить инцидент",
      operationId: "op-model-not-permitted",
    }, new ProjectLaunchAttemptLog(join(dir, "attempts.json")), run);

    // The code is the one the model gate of the project policy uses.
    expect(result.routingReasonCode).toBe(MODEL_NOT_PERMITTED_CODE);
    expect(result.routingReasonCode).toBe("model_not_permitted_for_project");
    // The reason a person reads is the one of before.
    expect(result.routingReason).toContain("Ни одна среда маршрута не использует модель, разрешённую для проекта");
    expect(result.outcome).toBe("no_harness");
    // A forbidden model never reaches a native call.
    expect(run).not.toHaveBeenCalled();
  });

  it("names a project without a route with the no_route class", async () => {
    const dir = await root();
    const cwd = await root();
    const policy = validateAutomationLaunchPolicy({
      version: 1,
      allowedHarnesses: ["opencode"],
      preferredHarness: "opencode",
      models: { opencode: "omniroute/glm-5.3-flash-minimax-m3.1" },
    });
    const run = acceptingRunner();

    const result = await dispatchProjectLaunch({
      policy,
      project: "project-without-a-route",
      cwd,
      message: "Исправить инцидент",
      operationId: "op-no-route",
    }, new ProjectLaunchAttemptLog(join(dir, "attempts.json")), run);

    expect(result.routingReasonCode).toBe("no_route");
    expect(result.routingReason).toContain("Для проекта нет маршрута");
    expect(result.outcome).toBe("accepted");
  });

  it("names a harness the policy does not allow for an automatic launch", async () => {
    const dir = await root();
    const cwd = await root();
    const policy = validateAutomationLaunchPolicy({
      version: 1,
      allowedHarnesses: ["opencode"],
      preferredHarness: "opencode",
      models: { opencode: "omniroute/glm-5.3-flash-minimax-m3.1" },
    });
    const run = acceptingRunner();

    const result = await dispatchProjectLaunch({
      policy,
      project: "project-without-a-route",
      cwd,
      message: "Исправить инцидент",
      harness: "codex",
      operationId: "op-harness-not-allowed",
    }, new ProjectLaunchAttemptLog(join(dir, "attempts.json")), run);

    expect(result.routingReasonCode).toBe("harness_not_allowed");
    expect(result.routingReason).toContain("не разрешена для автоматического запуска");
    expect(result.outcome).toBe("no_harness");
    expect(run).not.toHaveBeenCalled();
  });
});
