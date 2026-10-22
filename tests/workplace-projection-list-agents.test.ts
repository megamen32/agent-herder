import { describe, expect, it, vi } from "vitest";
import { hostname } from "node:os";
import { registerSessionTools } from "../src/mcp/session-tools.js";
import { CoordinationNoteStore, coordinationNotes } from "../src/coordination-notes.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

// The durable coordination ledger of this test file stays private to the machine.
const statePath = vi.hoisted(() => {
  const path = `/tmp/agent-herder-workplace-list-agents-${process.pid}-${Math.random().toString(36).slice(2)}.json`;
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

function fixture(sessions: AgentSession[]) {
  const callbacks = new Map<string, (args: unknown) => Promise<any>>();
  const events = new HerderEventBus();
  const adapter = {
    type: "codex",
    name: "codex",
    async listSessions() { return sessions; },
    async getSession(id: string) { return sessions.find((item) => item.id === id) ?? null; },
  } as unknown as HarnessAdapter;
  registerSessionTools(
    { registerTool: (name: string, _schema: unknown, cb: (args: unknown) => Promise<any>) => { callbacks.set(name, cb); } } as never,
    {
      adapters: new Map([["codex", adapter]]),
      jobs: new HerderJobRegistry(events),
      events,
    },
  );
  return { callbacks };
}

describe("list_agents work place", () => {
  it("returns the declared machine and directory of a session", async () => {
    // Another herder process declares the work place: the ledger on disk is
    // the truth, not the cache of this process.
    const other = new CoordinationNoteStore(statePath);
    await other.declareWorkspace({ sessionId: "moved", harness: "codex", hostId: "host-88", cwd: "/srv/remote/work", ttlSeconds: 600 });
    const { callbacks } = fixture([session("moved", "/launch/dir"), session("native", "/native/dir")]);
    const all = await callbacks.get("list_agents")!({});
    const byId = new Map(all.structuredContent.sessions.map((item: AgentSession) => [item.id, item]));
    expect(byId.get("moved")).toMatchObject({ hostId: "host-88", cwd: "/srv/remote/work" });
    // The native launch directory of the declared session stays untouched.
    expect(byId.get("moved")?.launchCwd).toBe("/launch/dir");
    expect(byId.get("native")).toMatchObject({ hostId: localHost, cwd: "/native/dir" });
  });

  it("filters by the same machine the answer carries", async () => {
    const other = new CoordinationNoteStore(statePath);
    await other.declareWorkspace({ sessionId: "moved", harness: "codex", hostId: "host-88", cwd: "/srv/remote/work", ttlSeconds: 600 });
    const { callbacks } = fixture([session("moved", "/launch/dir"), session("native", "/native/dir")]);
    const only88 = await callbacks.get("list_agents")!({ hostId: "host-88" });
    expect(only88.structuredContent.sessions.map((item: AgentSession) => item.id)).toEqual(["moved"]);
    expect(only88.structuredContent.sessions[0].hostId).toBe("host-88");
    const onlyLocal = await callbacks.get("list_agents")!({ hostId: localHost });
    expect(onlyLocal.structuredContent.sessions.map((item: AgentSession) => item.id)).toEqual(["native"]);
    const none = await callbacks.get("list_agents")!({ hostId: "host-44" });
    expect(none.structuredContent.sessions).toEqual([]);
  });

  it("returns the work place declared by this process as well", async () => {
    await coordinationNotes.declareWorkspace({ sessionId: "own", harness: "codex", hostId: "host-44", cwd: "/srv/own/work", ttlSeconds: 600 });
    const { callbacks } = fixture([session("own", "/launch/dir")]);
    const all = await callbacks.get("list_agents")!({});
    expect(all.structuredContent.sessions[0]).toMatchObject({ hostId: "host-44", cwd: "/srv/own/work" });
  });
});
