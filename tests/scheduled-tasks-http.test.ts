import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebServer } from "../src/web/server.js";
import type { CadenceSchedule, CadenceScheduler } from "../src/cadence-scheduler.js";
import type { ResumeAfterBackend, ResumeAfterWait } from "../src/resume-after.js";

const servers: Array<ReturnType<typeof createWebServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(server: ReturnType<typeof createWebServer>): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("scheduled task fixture did not bind");
  return "http://127.0.0.1:" + address.port;
}

describe("scheduled task web surface", () => {
  it("reads both durable sources and controls the exact stored records", async () => {
    const cadenceRow: CadenceSchedule = {
      id: "cadence_1234567890abcdef1234567890abcdef",
      sessionId: "session-cadence",
      requestId: "cadence-request",
      message: "continue cadence",
      harness: "codex",
      activatedAt: "2026-11-15T10:00:00.000Z",
      nextAt: "2026-11-15T11:00:00.000Z",
      state: "scheduled",
      sequence: 0,
    };
    const waitRow: ResumeAfterWait = {
      id: "wait_1234567890abcdef1234567890abcdef",
      owner: { harness: "opencode", sessionId: "session-wait" },
      dependencies: [],
      trigger: { kind: "at", at: "2026-11-15T12:00:00.000Z" },
      scheduledAt: "2026-11-15T12:00:00.000Z",
      message: "continue once",
      createdAt: "2026-11-15T09:00:00.000Z",
      state: "waiting",
      completed: {},
    };
    const cadence = {
      list: vi.fn(async () => [cadenceRow]),
      control: vi.fn(async (_id: string, _sessionId: string, action: "pause" | "complete") => ({ ...cadenceRow, state: action === "pause" ? "paused" : "complete" })),
    } as unknown as CadenceScheduler;
    const resumeAfter = {
      list: vi.fn(async () => [waitRow]),
      get: vi.fn(async (id: string) => id === waitRow.id ? waitRow : null),
      cancel: vi.fn(async () => ({ ...waitRow, state: "cancelled" })),
    } as unknown as ResumeAfterBackend;
    const supervisor = {
      getSession: vi.fn(async (harness: string, sessionId: string) => ({ id: sessionId, harness, title: "Fixture " + sessionId, cwd: "/tmp/project" })),
    } as any;
    const base = await listen(createWebServer({
      adapters: new Map(),
      converter: {} as never,
      supervisor,
      sessionObservationManagedExternally: true,
      cadence,
      resumeAfter,
    }));

    const listed = await fetch(base + "/api/scheduled-tasks");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      tasks: [
        expect.objectContaining({ id: cadenceRow.id, kind: "cadence", state: "scheduled", actions: ["pause", "disable"] }),
        expect.objectContaining({ id: waitRow.id, kind: "resume-after", state: "waiting", actions: ["cancel"] }),
      ],
      sources: { cadence: true, resumeAfter: true },
    });

    const paused = await fetch(base + "/api/scheduled-tasks/cadence/" + cadenceRow.id, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "pause" }),
    });
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({ task: { id: cadenceRow.id, state: "paused", actions: [] } });
    expect(cadence.control).toHaveBeenCalledWith(cadenceRow.id, cadenceRow.sessionId, "pause");

    const cancelled = await fetch(base + "/api/scheduled-tasks/resume-after/" + waitRow.id, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel" }),
    });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ task: { id: waitRow.id, state: "cancelled", actions: [] } });
    expect(resumeAfter.cancel).toHaveBeenCalledWith(waitRow.id, waitRow.owner);
  });
});
