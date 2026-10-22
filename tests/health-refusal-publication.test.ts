import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AutomationDisarmStore, projectWorkKey } from "../src/automation-disarm/index.js";
import { AutopilotSessionStore } from "../src/autopilot/session-store.js";
import { HerderEventBus, healthRefusalUri, herderEvents as moduleHerderEvents } from "../src/herder-events.js";
import { createWebServer } from "../src/web/server.js";

/**
 * The refusal of the health contour travels into the journal of the events.
 *
 * The class of the refusal is what a reader counts, so it travels in the
 * `reason_code` of an event of the kind `health`. The journal of the runtime
 * is the bus of the dependency of the server: a herder without that bus has
 * no journal to publish into, and the refusal stays in the durable trail.
 */
const TRAIL_FILE = "health-refusals.audit.jsonl";
const PROJECT = "omniroute-guard";

const cleanups: Array<() => Promise<void>> = [];
let stateDir = "";
let workDir = "";
let servers: Server[] = [];

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "agent-herder-refusal-events-state-"));
  workDir = await mkdtemp(join(tmpdir(), "agent-herder-refusal-events-work-"));
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

/** The owner turns the global lever on, exactly as the owner route does. */
async function disarmByOwner(): Promise<void> {
  const change = await AutomationDisarmStore.forRuntime().apply({ source: "owner", disarmed: true, reason: "the owner stopped the automation" });
  expect(change.ok).toBe(true);
}

/** The owner blocks one concrete work and leaves the rest of the automation alone. */
async function blockWork(workKey: string): Promise<void> {
  const change = await AutomationDisarmStore.forRuntime().apply({
    source: "owner",
    disarmed: false,
    reason: "one work is blocked",
    workKeys: [workKey],
  });
  expect(change.ok).toBe(true);
}

/** The runtime of the test, with the journal of the events when there is one. */
async function startServer(bus?: HerderEventBus): Promise<number> {
  const server = createWebServer({
    adapters: new Map(),
    converter: { async convert() { throw new Error("unused"); } },
    autopilotSessionStore: new AutopilotSessionStore(join(stateDir, "sessions.json")),
    sessionObservationManagedExternally: true,
    ...(bus ? { herderEvents: bus } : {}),
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("not listening");
  return address.port;
}

/** The center arms the session of an incident, exactly as it does in production. */
async function arm(port: number, sessionId: string, incidentId: string): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}/api/autopilot/sessions/opencode/${sessionId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enabled: true,
      cwd: workDir,
      noticeIncident: { incidentId, project: PROJECT, planId: "repair" },
    }),
  });
}

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
async function waitForTrail(sessionId: string): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const records = await readTrail();
    if (records.some((record) => record.sessionId === sessionId)) return records;
    if (Date.now() >= deadline) return records;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The refusals of one incident in the journal, read by the prefix of their uri. */
async function waitForHealthEvents(bus: HerderEventBus, incidentId: string): Promise<Array<ReturnType<HerderEventBus["listAfter"]>[number]>> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const events = bus.listAfter(0, 50, healthRefusalUri(incidentId));
    if (events.length > 0) return events;
    if (Date.now() >= deadline) return events;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("the health refusal of the production path travels into the journal of the events", () => {
  it("states the class of the refusal, the incident and the uri of the incident", async () => {
    await disarmByOwner();
    const bus = new HerderEventBus();
    const port = await startServer(bus);

    const response = await arm(port, "ses_publish", "inc_publish");
    expect(response.status).toBe(200);

    const events = await waitForHealthEvents(bus, "inc_publish");
    expect(events).toHaveLength(1);
    const event = events[0]!;
    // The kind is the one the center reads the refusals by.
    expect(event.kind).toBe("health");
    // The class of the refusal travels in the reason code, not in the wording.
    expect(event.reason_code).toBe("automation_disabled");
    // The incident of the refusal is the id of the event.
    expect(event.id).toBe("inc_publish");
    // The uri names the incident, so the refusals of one incident are read apart.
    expect(event.uri).toBe(healthRefusalUri("inc_publish"));
    // The source is the area of the refusal.
    expect(event.source).toBe("*");
  });

  it("maps the refusal of the trail into the event one to one", async () => {
    await disarmByOwner();
    await blockWork(projectWorkKey(PROJECT));
    const bus = new HerderEventBus();
    const port = await startServer(bus);

    const response = await arm(port, "ses_mapping", "inc_mapping");
    expect(response.status).toBe(200);

    const records = await waitForTrail("ses_mapping");
    const refusal = records.find((record) => record.sessionId === "ses_mapping");
    // The refusal of the trail names the class of the refusal and the area of
    // it, and the blocked work beside them.
    expect(refusal?.code).toBe("automation_disabled");
    expect(refusal?.detail).toBe("*");
    expect(refusal?.workKey).toBe(projectWorkKey(PROJECT));

    const events = await waitForHealthEvents(bus, "inc_mapping");
    expect(events).toHaveLength(1);
    const event = events[0]!;
    // The mapping is one to one: the class of the refusal, the incident and
    // the source of the refusal are the very fields of the refusal itself.
    expect(event.reason_code).toBe(refusal?.code);
    expect(event.id).toBe(refusal?.incidentId);
    expect(event.source).toBe(refusal?.detail ?? refusal?.workKey);
    // The source is the area of the refusal and never the blocked work key.
    expect(event.source).toBe("*");
    expect(event.source).not.toBe(refusal?.workKey);
  });

  it("publishes the refusal of the recovery of the restart as well", async () => {
    await disarmByOwner();
    // The armed session of a previous run is already in the durable store,
    // so the recovery of the restart refuses it before it arms anything.
    const store = new AutopilotSessionStore(join(stateDir, "sessions.json"));
    await store.set({
      harness: "opencode",
      sessionId: "ses_recovery",
      cwd: workDir,
      noticeIncident: { incidentId: "inc_recovery", project: PROJECT, planId: "repair" },
    }, true);

    const bus = new HerderEventBus();
    await startServer(bus);

    const events = await waitForHealthEvents(bus, "inc_recovery");
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("health");
    expect(events[0]!.reason_code).toBe("automation_disabled");
    expect(events[0]!.id).toBe("inc_recovery");
    expect(events[0]!.source).toBe("*");
    expect(events[0]!.uri).toBe(healthRefusalUri("inc_recovery"));
  });

  it("publishes nothing without a journal of the runtime and never falls back to the module bus", async () => {
    await disarmByOwner();
    // The module bus of the events is a different journal: a silent
    // publication into it would hide the refusal from the reader of the
    // runtime, so the test watches it.
    const baseline = moduleHerderEvents.latestSequence();
    const port = await startServer();

    const response = await arm(port, "ses_no_bus", "inc_no_bus");
    expect(response.status).toBe(200);

    // The refusal still reaches the durable trail: nothing of the contour is
    // broken by the missing journal.
    const records = await waitForTrail("ses_no_bus");
    expect(records.some((record) => record.sessionId === "ses_no_bus")).toBe(true);
    // And no event of the refusal was published anywhere.
    expect(moduleHerderEvents.listAfter(baseline, 100).filter((event) => event.kind === "health")).toHaveLength(0);
  });

  it("logs a refused publication instead of reporting a success", async () => {
    await disarmByOwner();
    const bus = new HerderEventBus();
    const original = bus.publish.bind(bus);
    // The journal of the runtime refuses the event of a refusal.
    bus.publish = (event) => {
      if (event.kind === "health") throw new Error("the journal refuses the health event");
      return original(event);
    };

    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((argument) => String(argument)).join(" "));
    });
    let status = 0;
    try {
      const port = await startServer(bus);
      status = (await arm(port, "ses_failed", "inc_failed")).status;
    } finally {
      spy.mockRestore();
    }

    // The contour is not broken by the refused publication.
    expect(status).toBe(200);
    // The failure is loud: the refusal that was not published is named.
    expect(errors.join("\n")).toMatch(/was not published into the event journal/);
    expect(errors.join("\n")).toContain("inc_failed");
    // And the event was not published, so no reader sees a success.
    expect(bus.listAfter(0, 50, healthRefusalUri("inc_failed"))).toHaveLength(0);
  });
});
