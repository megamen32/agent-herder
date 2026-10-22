import { hostname } from "node:os";
import { rm } from "node:fs/promises";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createWebServer } from "../src/web/server.js";
import { coordinationNotes } from "../src/coordination-notes.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

// Focused integration: the work-target route of the web surface, no native turns.
const statePath = vi.hoisted(() => {
  const path = `/tmp/agent-herder-session-target-api-${process.pid}-${Math.random().toString(36).slice(2)}.json`;
  process.env.AGENT_HERDER_COORDINATION_NOTES = path;
  return path;
});

const localHost = hostname();

type Receipt = {
  sessionId: string;
  harness: string;
  hostId: string;
  cwd: string;
  previous: { hostId: string; cwd: string };
  state: string;
  reason?: string;
};

async function withServer(sessionId: string, run: (origin: string) => Promise<void>): Promise<void> {
  const live: AgentSession = {
    id: sessionId,
    harness: "codex",
    status: "running",
    title: sessionId,
    cwd: "/launch/dir",
    hostId: localHost,
    lastActivity: new Date().toISOString(),
    needsPermission: false,
  };
  const adapter = {
    type: "codex",
    name: "codex",
    async listSessions() { return [live]; },
    async getSession(id: string) { return id === live.id ? live : null; },
  } as unknown as HarnessAdapter;
  const server = createWebServer({
    adapters: new Map([["codex", adapter]]),
    converter: {} as never,
    supervisor: {
      getSession: async (harness: string, id: string) => (harness === "codex" && id === live.id ? live : null),
    } as never,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await run(origin);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const post = (origin: string, body: unknown) => fetch(`${origin}/api/session-target`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("POST /api/session-target", () => {
  it("applies a new working directory on the local machine", async () => {
    await withServer("s1", async (origin) => {
      const response = await post(origin, { sessionId: "s1", harness: "codex", cwd: "/work/dir" });
      expect(response.status).toBe(200);
      const receipt = await response.json() as Receipt;
      expect(receipt).toEqual({
        sessionId: "s1",
        harness: "codex",
        hostId: localHost,
        cwd: "/work/dir",
        previous: { hostId: localHost, cwd: "/launch/dir" },
        state: "updated",
      });
      // The declaration is the one truth: the coordination store sees the new place.
      expect(await coordinationNotes.activeWorkspaceObservation("s1")).toMatchObject({ hostId: localHost, cwd: "/work/dir" });
    });
  });

  it("reports the same target as unchanged", async () => {
    await withServer("s2", async (origin) => {
      const response = await post(origin, { sessionId: "s2", harness: "codex", cwd: "/launch/dir" });
      expect(response.status).toBe(200);
      const receipt = await response.json() as Receipt;
      expect(receipt.state).toBe("unchanged");
      expect(receipt.cwd).toBe("/launch/dir");
    });
  });

  it("refuses an unreachable machine instead of applying it locally", async () => {
    await withServer("s3", async (origin) => {
      const response = await post(origin, { sessionId: "s3", harness: "codex", hostId: "not-a-fleet-machine", cwd: "/remote/work" });
      expect(response.status).toBe(200);
      const receipt = await response.json() as Receipt;
      expect(receipt.state).toBe("unreachable");
      expect(receipt.state).not.toBe("updated");
      expect(receipt.reason).toContain("host_target_unavailable");
      // Nothing was declared: the session still works where it worked before.
      expect(await coordinationNotes.activeWorkspaceObservation("s3")).toBeUndefined();
    });
  });

  it("rejects an empty body", async () => {
    await withServer("s4", async (origin) => {
      const response = await fetch(`${origin}/api/session-target`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "",
      });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toBeTruthy();
    });
  });

  it("rejects a request without a machine and without a directory", async () => {
    await withServer("s5", async (origin) => {
      const response = await post(origin, { sessionId: "s5", harness: "codex" });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toContain("hostId");
    });
  });

  it("rejects a session it cannot see", async () => {
    await withServer("s6", async (origin) => {
      const response = await post(origin, { sessionId: "missing", harness: "codex", cwd: "/work/dir" });
      expect(response.status).toBe(404);
      expect((await response.json() as { error: string }).error).toContain("session_not_found");
    });
  });
});

describe("GET /api/session-target", () => {
  it("shows the effective work target of a live session", async () => {
    await withServer("s7", async (origin) => {
      const response = await fetch(`${origin}/api/session-target?sessionId=s7&harness=codex`);
      expect(response.status).toBe(200);
      const receipt = await response.json() as Receipt;
      expect(receipt.sessionId).toBe("s7");
      expect(receipt.hostId).toBe(localHost);
      expect(receipt.cwd).toBe("/launch/dir");
    });
  });

  it("rejects a read without a session", async () => {
    await withServer("s8", async (origin) => {
      const response = await fetch(`${origin}/api/session-target`);
      expect(response.status).toBe(400);
    });
  });
});

afterAll(async () => {
  await rm(statePath, { force: true });
});
