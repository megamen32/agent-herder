import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { validateAutomationLaunchPolicy, type AutomationLaunchPolicy } from "../src/automation-launch-policy.js";
import { dispatchProjectLaunch, ProjectLaunchAttemptLog } from "../src/automation/project-launch-dispatch.js";
import { NOTICEPLACE_HEALTH_AUTHORIZED, healthRepairModel } from "../src/automation/noticeplace-health-launch.js";
import { IncidentSessionRouter, incidentSourceKey } from "../src/automation/incident-session-router.js";
import type { AgentSession } from "../src/types/common.js";

/**
 * The shared gateway repair must not run on the gateway it repairs, and the
 * observers of one gateway must share one repair session. Every other project
 * keeps its own route and every ordinary launch keeps its own model.
 */

const DIRECT = "minimax-coding-plan/MiniMax-M3.1-Flash";
const GATEWAY = "omniroute/cx/gpt-6-luna";
const GUARD_PROJECT = "omniroute-guard";
const ROUTE_ROOT = "/home/roomhacker/ServersAdministartion";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "herder-guard-repair-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function policy(): AutomationLaunchPolicy {
  return validateAutomationLaunchPolicy({
    version: 1,
    allowedHarnesses: ["opencode"],
    preferredHarness: "opencode",
    models: { opencode: GATEWAY },
    projectRoutes: {
      [ROUTE_ROOT]: { harnesses: ["opencode"], aliases: [GUARD_PROJECT], models: { opencode: GATEWAY } },
      "/workspace/other": { harnesses: ["opencode"], models: { opencode: "vendor/other-model" } },
    },
  });
}

function runner() {
  return vi.fn(async (request: { harness: string; cwd: string; inputId: string; model?: string }) => ({
    ok: true, created: true, harness: request.harness, name: "repair", cwd: request.cwd,
    inputId: request.inputId, sessionId: "ses_fixture", delivery: "accepted" as const, model: request.model,
  }));
}

describe("health repair route of the shared gateway", () => {
  it("names only the shared gateway repair as an independent route", () => {
    expect(healthRepairModel(GUARD_PROJECT)).toBe(DIRECT);
    expect(healthRepairModel(ROUTE_ROOT)).toBe(DIRECT);
    expect(healthRepairModel("OMNIROUTE-GUARD")).toBe(DIRECT);
    expect(healthRepairModel("/workspace/other")).toBeUndefined();
    expect(healthRepairModel("")).toBeUndefined();
    expect(healthRepairModel(undefined)).toBeUndefined();
  });

  it("repairs the shared gateway on the verified independent provider", async () => {
    const dir = await directory();
    const run = runner();
    const result = await dispatchProjectLaunch({
      [NOTICEPLACE_HEALTH_AUTHORIZED]: true,
      policy: policy(),
      project: GUARD_PROJECT,
      cwd: ROUTE_ROOT,
      message: "repair the shared gateway",
      operationId: "guard-health",
      harness: "opencode",
    }, new ProjectLaunchAttemptLog(join(dir, "attempts.json")), run);
    expect(result.outcome).toBe("accepted");
    expect(run.mock.calls[0]?.[0]?.model).toBe(DIRECT);
    expect(run.mock.calls[0]?.[0]?.model).not.toBe(GATEWAY);
  });

  it("keeps the project route of every other health project", async () => {
    const dir = await directory();
    const run = runner();
    const result = await dispatchProjectLaunch({
      [NOTICEPLACE_HEALTH_AUTHORIZED]: true,
      policy: policy(),
      project: "/workspace/other",
      cwd: "/workspace/other",
      message: "repair another project",
      operationId: "other-health",
      harness: "opencode",
    }, new ProjectLaunchAttemptLog(join(dir, "attempts.json")), run);
    expect(result.outcome).toBe("accepted");
    expect(run.mock.calls[0]?.[0]?.model).toBe("vendor/other-model");
  });

  it("keeps an ordinary launch of the same project on its own route", async () => {
    const dir = await directory();
    const run = runner();
    const result = await dispatchProjectLaunch({
      policy: policy(),
      project: GUARD_PROJECT,
      cwd: ROUTE_ROOT,
      message: "ordinary work",
      operationId: "guard-ordinary",
      harness: "opencode",
    }, new ProjectLaunchAttemptLog(join(dir, "attempts.json")), run);
    expect(result.outcome).toBe("accepted");
    expect(run.mock.calls[0]?.[0]?.model).toBe(GATEWAY);
  });
});

describe("shared repair identity of one observed target", () => {
  const observer = (id: string, host: string, service?: string) => ({
    harness: "opencode",
    cwd: "/workspace",
    inputId: id,
    message: JSON.stringify({
      id: `inc_${id}`,
      project: GUARD_PROJECT,
      source_id: `host:${host}`,
      consumer_id: `${GUARD_PROJECT}+host:${host}`,
      host_id: host,
      signal_type: "omniroute-unavailable",
      problem_type: "omniroute-unavailable",
      correlation_id: `omniroute-host:${host}:20261124T0900Z`,
      ...(service ? { service } : {}),
    }),
  });

  it("joins the observers of one declared target and keeps every source distinct", () => {
    const first = observer("one", "host-100", "omniroute");
    const second = observer("two", "host-88", "omniroute");
    expect(incidentSourceKey(first.message)).toBe(incidentSourceKey(second.message));
    // The per-source evidence stays exact: the facts are not rewritten.
    expect(JSON.parse(first.message).source_id).toBe("host:host-100");
    expect(JSON.parse(second.message).source_id).toBe("host:host-88");
    // A different problem on the same target is a different repair.
    const other = { ...second, message: second.message.replace('"problem_type":"omniroute-unavailable"', '"problem_type":"omniroute-slow"') };
    expect(incidentSourceKey(first.message)).not.toBe(incidentSourceKey(other.message));
    // Without a declared target the hosts stay separate, as before.
    expect(incidentSourceKey(observer("three", "host-100").message))
      .not.toBe(incidentSourceKey(observer("four", "host-88").message));
  });

  it("runs one executor for every observer of the same target", async () => {
    const dir = await directory();
    const sessions = new Map<string, AgentSession>();
    const deliveries: string[] = [];
    let created = 0;
    const router = new IncidentSessionRouter(join(dir, "groups.json"), {
      readSession: async (_harness, id) => sessions.get(id) ?? null,
      unfinished: async (session: AgentSession) => session.status !== "stopped",
    });
    const launch = async (existing?: string) => {
      const id = existing ?? `ses_${++created}`;
      if (!existing) sessions.set(id, { id, cwd: "/workspace", harness: "opencode", status: "running", title: "repair", lastActivity: "", needsPermission: false });
      deliveries.push(id);
      return { ok: true, created: !existing, harness: "opencode", cwd: "/workspace", name: "repair", sessionId: id };
    };
    const first = await router.run(observer("one", "host-100", "omniroute"), launch);
    const second = await router.run(observer("two", "host-88", "omniroute"), launch);
    expect(created).toBe(1);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.coalesced).toBe(true);
    expect(deliveries.length).toBe(2);
  });
});
