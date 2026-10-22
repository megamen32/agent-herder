import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AutopilotSessionStore } from "../src/autopilot/session-store.js";
import { NoticeplaceHealthObserver } from "../src/automation/noticeplace-health-observer.js";
import { recoverNoticeplaceHealthObservation, type NoticeplaceHealthRecoveryCandidate } from "../src/automation/noticeplace-health-recovery.js";
import type { IncidentProgressUpdate } from "../src/autopilot/notice-incident.js";
import type { SessionDetails } from "../src/types/index.js";
import { createWebServer } from "../src/web/server.js";

/**
 * The selected plan of an incident belongs to the incident, not to the memory
 * of the process that launched the executor: the center states the plan in
 * the launch message and the arming call carries the incident id only.
 */
describe("the health plan of a launch", () => {
  it("survives a restart of herder", async () => {
    const root = await mkdtemp(join(tmpdir(), "herder-health-plan-"));
    try {
      const path = join(root, "sessions.json");
      const store = new AutopilotSessionStore(path);
      await store.setLaunchPlan("opencode", "ses_plan_1", "repair");

      // A restart is another process reading the same durable file.
      const restarted = new AutopilotSessionStore(path);
      expect(await restarted.getLaunchPlan("opencode", "ses_plan_1")).toBe("repair");
      expect(await restarted.getLaunchPlans()).toMatchObject({ "opencode:ses_plan_1": "repair" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fills the plan of a binding that was written without one", async () => {
    const root = await mkdtemp(join(tmpdir(), "herder-health-plan-bind-"));
    try {
      const store = new AutopilotSessionStore(join(root, "sessions.json"));
      // The arming call of the center carries the incident id only.
      await store.set({ harness: "opencode", sessionId: "ses_2", cwd: "/work", noticeIncident: { incidentId: "inc_1", project: "omniroute-guard" } }, true);
      expect((await store.get("opencode", "ses_2"))?.noticeIncident?.planId).toBeUndefined();

      // The plan of the launch is stated later and fills the binding in.
      await store.set({ harness: "opencode", sessionId: "ses_2", cwd: "/work", noticeIncident: { incidentId: "inc_1", project: "omniroute-guard", planId: "repair" } }, true);
      expect((await store.get("opencode", "ses_2"))?.noticeIncident?.planId).toBe("repair");
      expect((await new AutopilotSessionStore(join(root, "sessions.json")).get("opencode", "ses_2"))?.noticeIncident?.planId).toBe("repair");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never replaces a bound plan and never replaces the incident of a binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "herder-health-plan-immutable-"));
    try {
      const store = new AutopilotSessionStore(join(root, "sessions.json"));
      await store.set({ harness: "opencode", sessionId: "ses_3", cwd: "/work", noticeIncident: { incidentId: "inc_1", project: "omniroute-guard", planId: "repair" } }, true);

      await expect(store.set({ harness: "opencode", sessionId: "ses_3", cwd: "/work", noticeIncident: { incidentId: "inc_1", project: "omniroute-guard", planId: "observe" } }, true))
        .rejects.toThrow(/health plan cannot be replaced/);
      await expect(store.set({ harness: "opencode", sessionId: "ses_3", cwd: "/work", noticeIncident: { incidentId: "inc_2", project: "omniroute-guard" } }, true))
        .rejects.toThrow(/binding cannot be replaced/);
      await expect(store.set({ harness: "opencode", sessionId: "ses_3", cwd: "/other", noticeIncident: { incidentId: "inc_1", project: "omniroute-guard" } }, true))
        .rejects.toThrow(/binding cannot be replaced/);

      expect((await store.get("opencode", "ses_3"))?.noticeIncident).toMatchObject({ incidentId: "inc_1", project: "omniroute-guard", planId: "repair" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops the remembered launch plan once the binding carries it", async () => {
    const root = await mkdtemp(join(tmpdir(), "herder-health-plan-bound-"));
    try {
      const store = new AutopilotSessionStore(join(root, "sessions.json"));
      await store.setLaunchPlan("opencode", "ses_4", "repair");
      await store.set({ harness: "opencode", sessionId: "ses_4", cwd: "/work", noticeIncident: { incidentId: "inc_1", project: "omniroute-guard", planId: "repair" } }, true);

      expect(await store.getLaunchPlan("opencode", "ses_4")).toBeUndefined();
      expect((await store.get("opencode", "ses_4"))?.noticeIncident?.planId).toBe("repair");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the arming call of the center", () => {
  it("binds the plan of the launch to the incident and keeps it across a restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "herder-health-arming-"));
    try {
      const path = join(root, "sessions.json");
      const store = new AutopilotSessionStore(path);
      // The launch of the executor stated the selected plan of the incident.
      await store.setLaunchPlan("opencode", "ses_armed", "repair");

      const server = createWebServer({
        adapters: new Map(),
        converter: { async convert() { throw new Error("unused"); } },
        autopilotSessionStore: store,
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind");
      const endpoint = `http://127.0.0.1:${address.port}/api/autopilot/sessions/opencode/ses_armed`;
      try {
        // The arming call of the center carries the incident id only.
        const armed = await fetch(endpoint, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true, cwd: "/workspace/project", noticeIncident: { incidentId: "inc_1", project: "omniroute-guard" } }),
        });
        expect(armed.status).toBe(200);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }

      // The plan of the launch is bound to the incident and outlives the process.
      expect(await new AutopilotSessionStore(path).get("opencode", "ses_armed")).toMatchObject({
        enabled: true,
        noticeIncident: { incidentId: "inc_1", project: "omniroute-guard", planId: "repair" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("an unusable launch plan in the durable file", () => {
  it("ignores the unknown plan and keeps the armed records readable", async () => {
    const root = await mkdtemp(join(tmpdir(), "herder-health-plan-unknown-"));
    try {
      const path = join(root, "sessions.json");
      // A file with an unknown plan id of a future release next to the armed
      // records of the live state.
      await writeFile(path, JSON.stringify({
        version: 1,
        sessions: [
          { harness: "opencode", sessionId: "ses_armed_1", cwd: "/work", enabled: true, updatedAt: "2026-10-22T00:00:00.000Z", noticeIncident: { incidentId: "inc_1", project: "omniroute-guard" } },
          { harness: "opencode", sessionId: "ses_armed_2", cwd: "/work", enabled: true, updatedAt: "2026-10-22T00:00:00.000Z", noticeIncident: { incidentId: "inc_2", project: "fleet-health" } },
        ],
        launchPlans: { "opencode:ses_armed_1": "repair", "opencode:ses_armed_2": "plan-of-a-future-release" },
      }));

      const store = new AutopilotSessionStore(path);
      // The armed records stay readable: one unusable entry does not make
      // the whole file unreadable.
      expect((await store.get("opencode", "ses_armed_1"))?.noticeIncident?.incidentId).toBe("inc_1");
      expect((await store.get("opencode", "ses_armed_2"))?.noticeIncident?.incidentId).toBe("inc_2");
      // The known plan is kept, the unknown one is ignored.
      expect(await store.getLaunchPlan("opencode", "ses_armed_1")).toBe("repair");
      expect(await store.getLaunchPlan("opencode", "ses_armed_2")).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the recovery of the observation after a restart", () => {
  const candidate = (overrides: Partial<NoticeplaceHealthRecoveryCandidate> = {}): NoticeplaceHealthRecoveryCandidate => ({
    harness: "opencode",
    sessionId: "ses_recovered",
    cwd: "/work",
    binding: { incidentId: "inc_1", project: "omniroute-guard" },
    ...overrides,
  });

  it("arms a candidate whose plan is known from the launch", async () => {
    const armed: Array<string | undefined> = [];
    const result = await recoverNoticeplaceHealthObservation({
      candidates: [candidate()],
      isAlive: async () => true,
      resolvePlan: async () => "repair",
      arm: (entry) => { armed.push(entry.binding.planId); return "started"; },
    });
    expect(armed).toEqual(["repair"]);
    expect(result.armed).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("refuses a candidate without a known plan and names the reason", async () => {
    const armed: string[] = [];
    const result = await recoverNoticeplaceHealthObservation({
      candidates: [candidate()],
      isAlive: async () => true,
      arm: (entry) => { armed.push(entry.sessionId); return "started"; },
    });
    expect(armed).toEqual([]);
    expect(result.armed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.reasons[0]).toContain("inc_1");
    expect(result.reasons[0]).toContain("no selected health plan");
  });

  it("keeps the bound plan of a candidate that already carries one", async () => {
    const armed: Array<string | undefined> = [];
    const result = await recoverNoticeplaceHealthObservation({
      candidates: [candidate({ binding: { incidentId: "inc_1", project: "omniroute-guard", planId: "observe" } })],
      isAlive: async () => true,
      resolvePlan: async () => "repair",
      arm: (entry) => { armed.push(entry.binding.planId); return "started"; },
    });
    expect(armed).toEqual(["observe"]);
    expect(result.armed).toBe(1);
  });
});

describe("the observer of an incident without a selected plan", () => {
  const details = (): SessionDetails => ({
    session: {
      id: "ses_test", harness: "opencode", status: "running", title: "health", cwd: "/tmp",
      lastActivity: "2026-01-01T00:00:00.000Z", needsPermission: false, messageCount: 1, lastMessage: "работаю",
    },
    lineage: { kind: "root" },
    children: [],
    messages: [{ id: "msg_1", role: "assistant", text: "работаю", parts: [] }],
    history: { source: "live-cache", complete: true },
  } as unknown as SessionDetails);

  it("publishes nothing and says why", async () => {
    const published: IncidentProgressUpdate[] = [];
    const errors: string[] = [];
    const observer = new NoticeplaceHealthObserver({
      readDetails: async () => details(),
      publish: async (update) => { published.push(update); },
      onError: (message) => { errors.push(message); },
      intervalMs: 5,
      maxLifetimeMs: 5_000,
    });

    // The incident has no selected plan: nothing is published for it.
    expect(await observer.start({ harness: "opencode", sessionId: "ses_test", cwd: "/tmp", binding: { incidentId: "inc_1", project: "omniroute-guard" } })).toBe("refused");
    await new Promise((resolve) => setTimeout(resolve, 60));
    observer.stop();

    expect(published).toHaveLength(0);
    expect(published.some((update) => update.planId === undefined)).toBe(false);
    expect(errors.join("\n")).toContain("no selected health plan");
  });
});
