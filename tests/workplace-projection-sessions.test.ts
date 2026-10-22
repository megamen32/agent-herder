import { hostname, tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createWebServer } from "../src/web/server.js";
import { LineageStore } from "../src/lineage-store.js";
import { SessionSupervisor } from "../src/session-supervisor.js";
import { CoordinationNoteStore, coordinationNotes } from "../src/coordination-notes.js";
import { HerderEventBus, type HerderEvent } from "../src/herder-events.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

// The durable coordination ledger of this test file stays private to the machine.
const statePath = vi.hoisted(() => {
  const path = `/tmp/agent-herder-workplace-sessions-${process.pid}-${Math.random().toString(36).slice(2)}.json`;
  process.env.AGENT_HERDER_COORDINATION_NOTES = path;
  return path;
});

const localHost = hostname();

function session(id: string, cwd: string, hostId = localHost): AgentSession {
  return {
    id,
    harness: "codex",
    status: "running",
    title: id,
    cwd,
    hostId,
    launchCwd: cwd,
    lastActivity: new Date().toISOString(),
    needsPermission: false,
  };
}

async function withServer(sessions: AgentSession[], run: (origin: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "herder-workplace-sessions-"));
  const adapter = {
    type: "codex",
    name: "codex",
    async listSessions() { return sessions; },
    async getSession(id: string) { return sessions.find((item) => item.id === id) ?? null; },
  } as unknown as HarnessAdapter;
  const server = createWebServer({
    adapters: new Map([["codex", adapter]]),
    converter: { async convert() { return { success: true }; } } as never,
    lineageStore: new LineageStore(join(dir, "lineage.json")),
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

describe("GET /api/sessions", () => {
  it("shows the declared machine and directory of a session and the native values of the others", async () => {
    // Another herder process declares the work place: the ledger on disk is
    // the truth, not the cache of this process.
    const other = new CoordinationNoteStore(statePath);
    await other.declareWorkspace({ sessionId: "moved", harness: "codex", hostId: "host-88", cwd: "/srv/remote/work", ttlSeconds: 600 });
    await withServer([session("moved", "/launch/dir"), session("native", "/native/dir")], async (origin) => {
      const response = await fetch(`${origin}/api/sessions`);
      expect(response.status).toBe(200);
      const body = await response.json() as { sessions: AgentSession[] };
      const byId = new Map(body.sessions.map((item) => [item.id, item]));
      expect(byId.get("moved")).toMatchObject({ hostId: "host-88", cwd: "/srv/remote/work" });
      // The native launch directory of the declared session stays untouched.
      expect(byId.get("moved")?.launchCwd).toBe("/launch/dir");
      expect(byId.get("native")).toMatchObject({ hostId: localHost, cwd: "/native/dir" });
    });
  });

  it("keeps the machine and the directory of every session without a declaration", async () => {
    await withServer([session("one", "/one"), session("two", "/two")], async (origin) => {
      const response = await fetch(`${origin}/api/sessions`);
      expect(response.status).toBe(200);
      const body = await response.json() as { sessions: AgentSession[] };
      expect(body.sessions.map((item) => item.hostId)).toEqual([localHost, localHost]);
      expect(body.sessions.map((item) => item.cwd)).toEqual(["/one", "/two"]);
    });
  });

  it("shows the work place declared by this process as well", async () => {
    await coordinationNotes.declareWorkspace({ sessionId: "own", harness: "codex", hostId: "host-44", cwd: "/srv/own/work", ttlSeconds: 600 });
    await withServer([session("own", "/launch/dir")], async (origin) => {
      const response = await fetch(`${origin}/api/sessions`);
      const body = await response.json() as { sessions: AgentSession[] };
      expect(body.sessions[0]).toMatchObject({ hostId: "host-44", cwd: "/srv/own/work" });
    });
  });
});

describe("the session snapshot of a moved session", () => {
  it("does not report a change when only the declared work place moved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herder-workplace-events-"));
    const events = new HerderEventBus();
    const changed: HerderEvent[] = [];
    events.subscribe((event) => { if (event.kind === "sessions" && event.action === "changed") changed.push(event); });
    const live = session("moved", "/launch/dir");
    const adapter = {
      type: "codex",
      name: "codex",
      async listSessions() { return [live]; },
      async getSession(id: string) { return id === live.id ? live : null; },
    } as unknown as HarnessAdapter;
    const supervisor = new SessionSupervisor(
      new Map([["codex", adapter]]),
      { async convert() { return { success: true }; } } as never,
      new LineageStore(join(dir, "lineage.json")),
      { events, sessionCacheTtlMs: 0 },
    );

    // Another herder process moves the session to another machine.
    const other = new CoordinationNoteStore(statePath);
    await other.declareWorkspace({ sessionId: "moved", harness: "codex", hostId: "host-88", cwd: "/srv/remote/work", ttlSeconds: 600 });
    await supervisor.refreshSessions();
    const listed = await supervisor.listSessions();
    expect(listed[0]).toMatchObject({ hostId: "host-88", cwd: "/srv/remote/work" });

    // The work place moves again. The native session did not change, so the
    // refresh must not report the session as changed.
    await other.declareWorkspace({ sessionId: "moved", harness: "codex", hostId: "host-44", cwd: "/srv/other/work", ttlSeconds: 600 });
    await supervisor.refreshSessions();
    expect((await supervisor.listSessions())[0]).toMatchObject({ hostId: "host-44", cwd: "/srv/other/work" });
    expect(changed).toEqual([]);
  });
});
