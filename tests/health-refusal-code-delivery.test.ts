import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AutomationDisarmStore, projectWorkKey } from "../src/automation-disarm/index.js";
import { NoticeplaceHealthObserver } from "../src/automation/noticeplace-health-observer.js";
import { recoverNoticeplaceHealthObservation } from "../src/automation/noticeplace-health-recovery.js";
import { dispatchProjectLaunch, ProjectLaunchAttemptLog } from "../src/automation/project-launch-dispatch.js";
import { AutopilotSessionStore } from "../src/autopilot/session-store.js";
import { validateAutomationLaunchPolicy } from "../src/automation-launch-policy.js";
import { createWebServer } from "../src/web/server.js";
import type { NamedSessionResult } from "../src/named-session.js";
import type { SessionDetails } from "../src/types/index.js";

/**
 * The durable trail of the refusals of the health contour.
 *
 * The path is pinned on purpose: it is the place a third-party reader looks
 * at, so the reader never has to know an internal name of the contour.
 */
const TRAIL_FILE = "health-refusals.audit.jsonl";

const cleanups: Array<() => Promise<void>> = [];
let stateDir = "";
let workDir = "";
let servers: Server[] = [];

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "agent-herder-health-trail-state-"));
  workDir = await mkdtemp(join(tmpdir(), "agent-herder-health-trail-work-"));
  cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  cleanups.push(() => rm(workDir, { recursive: true, force: true }));
  servers = [];
  // The owner state of a test is a temporary file: the live state of the
  // runtime is never read and never written by a test.
  vi.stubEnv("AGENT_HERDER_AUTOPILOT_STATE_DIR", stateDir);
});

afterEach(async () => {
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
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

/** The incident binding of the observed run: the center names the incident. */
const binding = { incidentId: "inc_trail", project: "omniroute-guard", planId: "repair" as const };

/** The records of the durable trail, read with a JSON reader. */
async function readTrail(): Promise<Array<Record<string, unknown>>> {
  const path = join(stateDir, TRAIL_FILE);
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The trail is written by the contour, so the reader waits for the record. */
async function waitForTrail(): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const records = await readTrail();
    if (records.length > 0) return records;
    if (Date.now() >= deadline) return records;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A native runner that never touches a real harness. */
function acceptingRunner(): ReturnType<typeof vi.fn> {
  return vi.fn(async (request: { harness: string; cwd: string; inputId: string; model?: string }): Promise<NamedSessionResult> => ({
    ok: true,
    created: true,
    harness: request.harness,
    name: "health-refusal-code",
    cwd: request.cwd,
    sessionId: "native-health-refusal-code",
    inputId: request.inputId,
    delivery: "accepted",
    ...(request.model ? { model: request.model } : {}),
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
 * The refusal of the health contour has to reach a consumer that can count it.
 *
 * The consumer reads the code of the refusal and never the Russian wording of
 * the log line, so a refusal that stays in the text of a log is a refusal
 * nobody can count.
 */
describe("the refusal code of the health contour reaches a machine-readable consumer", () => {
  it("writes the refusal of the observer into the durable trail of the production path", async () => {
    await disarmByOwner();
    const store = new AutopilotSessionStore(join(stateDir, "sessions.json"));
    const server = createWebServer({
      adapters: new Map(),
      converter: { async convert() { throw new Error("unused"); } },
      autopilotSessionStore: store,
      sessionObservationManagedExternally: true,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("not listening");

    // The center arms the session of an incident, exactly as it does in
    // production: the observer refuses it while the owner forbids automation.
    const arm = await fetch(`http://127.0.0.1:${address.port}/api/autopilot/sessions/opencode/ses_trail`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        cwd: "/tmp",
        noticeIncident: { incidentId: "inc_trail", project: "omniroute-guard", planId: "repair" },
      }),
    });
    expect(arm.status).toBe(200);

    const records = await waitForTrail();
    const refusal = records.find((record) => record.sessionId === "ses_trail");

    // The refusal is on the trail of the production path, not only in the log.
    expect(refusal).toBeDefined();
    // The class of the refusal is a field of the record: a reader counts it
    // without parsing the wording.
    expect(refusal?.code).toBe("automation_disabled");
    expect(refusal?.detail).toBe("*");
    expect(refusal?.incidentId).toBe("inc_trail");
    expect(refusal?.harness).toBe("opencode");
    // Every record of the trail is one JSON object, so a JSON reader takes it.
    expect(records.every(record => typeof record.code === "string")).toBe(true);
  });

  it("gives the refusal to the consumer through the callback, not only through the log text", async () => {
    await disarmByOwner();
    const errors: string[] = [];
    const refusals: Array<Record<string, unknown>> = [];
    const observer = new NoticeplaceHealthObserver({
      readDetails: async () => details("running", "Шаг"),
      publish: async () => {},
      onError: (message) => errors.push(message),
      onRefused: (refusal) => { refusals.push(refusal as unknown as Record<string, unknown>); },
    });

    const outcome = await observer.start({ harness: "opencode", sessionId: "ses_callback", cwd: "/tmp", binding });

    expect(outcome).toBe("refused");
    // The consumer receives the class as a field of the refusal.
    expect(refusals[0]?.code).toBe("automation_disabled");
    expect(refusals[0]?.sessionId).toBe("ses_callback");
    expect(refusals[0]?.incidentId).toBe("inc_trail");
    // The wording of the log line stays as it was.
    expect(errors.join("\n")).toContain("[automation_disabled]");
  });

  it("tells a forbidden automation from a blocked work in the machine-readable detail", async () => {
    await disarmByOwner();
    const refusals: Array<Record<string, unknown>> = [];
    const observer = new NoticeplaceHealthObserver({
      readDetails: async () => details("running", "Шаг"),
      publish: async () => {},
      onRefused: (refusal) => { refusals.push(refusal as unknown as Record<string, unknown>); },
    });

    expect(await observer.start({ harness: "opencode", sessionId: "ses_global", cwd: "/tmp", binding })).toBe("refused");
    // The owner turns the global lever off and blocks one concrete work.
    const change = await AutomationDisarmStore.forRuntime().apply({
      source: "owner", disarmed: false, reason: "one work is blocked", workKeys: [projectWorkKey(binding.project)],
    });
    expect(change.ok).toBe(true);
    expect(await observer.start({ harness: "opencode", sessionId: "ses_work", cwd: "/tmp", binding })).toBe("refused");

    // The top-level class is the one agreed class of a disarm refusal.
    expect(refusals.map((refusal) => refusal.code)).toEqual(["automation_disabled", "automation_disabled"]);
    // The area travels beside the class. A project named by a name has no
    // path of its own, so its area is the catch-all scope of the contour, and
    // the work the refusal was made on is named beside it.
    expect(refusals[0]?.detail).toBe("*");
    expect(refusals[0]?.workKey).toBe(projectWorkKey(binding.project));
    expect(refusals[1]?.detail).toBe("*");
    expect(refusals[1]?.workKey).toBe(projectWorkKey(binding.project));
  });

  it("keeps the wording of the recovery and adds the machine-readable class", async () => {
    await disarmByOwner();

    const result = await recoverNoticeplaceHealthObservation({
      candidates: [{ harness: "opencode", sessionId: "ses_recovery", cwd: "/tmp", binding }],
      isAlive: async () => true,
      arm: async () => "started",
    });

    expect(result.armed).toBe(0);
    expect(result.skipped).toBe(1);
    // The wording of the operator's log is unchanged.
    expect(result.reasons.join("\n")).toContain("[automation_disabled]");
    // The record carries the class of the refusal and the area of it.
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]?.code).toBe("automation_disabled");
    expect(result.refusals[0]?.detail).toBe("*");
    expect(result.refusals[0]?.sessionId).toBe("ses_recovery");
  });

  it("keeps the top-level class of the dispatch and adds the class of the cause", async () => {
    await disarmByOwner();

    const global = await dispatchProjectLaunch({
      policy,
      project: "/workspace/guarded",
      cwd: workDir,
      message: "Исправить инцидент",
      operationId: "op-global",
    }, new ProjectLaunchAttemptLog(join(workDir, "attempts-global.json")), acceptingRunner());

    expect(global.routingReasonCode).toBe("automation_disabled");
    expect(global.routingReasonDetail).toBe("*");
    // The wording of the reason is unchanged.
    expect(global.routingReason).toContain("Автоматический запуск запрещён владельцем");

    // The owner turns the global lever off and blocks the work of the project.
    const change = await AutomationDisarmStore.forRuntime().apply({
      source: "owner", disarmed: false, reason: "the project is blocked", workKeys: [projectWorkKey("/workspace/guarded")],
    });
    expect(change.ok).toBe(true);

    const blocked = await dispatchProjectLaunch({
      policy,
      project: "/workspace/guarded",
      cwd: workDir,
      message: "Исправить инцидент",
      operationId: "op-work",
    }, new ProjectLaunchAttemptLog(join(workDir, "attempts-work.json")), acceptingRunner());

    expect(blocked.routingReasonCode).toBe("automation_disabled");
    // The area of the blocked work is the canonical path of its scope.
    expect(blocked.routingReasonDetail).toBe("/workspace/guarded");
  });
});
