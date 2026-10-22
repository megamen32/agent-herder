import { describe, expect, it, vi } from "vitest";
import { hostname } from "node:os";
import { registerSessionTools } from "../src/mcp/session-tools.js";
import { coordinationNotes } from "../src/coordination-notes.js";
import { projectObservation } from "../src/mesh/protocol.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

// The durable coordination ledger of this test file stays private to the machine.
const statePath = vi.hoisted(() => {
  const path = `/tmp/agent-herder-host-targeting-${process.pid}-${Math.random().toString(36).slice(2)}.json`;
  process.env.AGENT_HERDER_COORDINATION_NOTES = path;
  return path;
});

const localHost = hostname();

function session(id: string, hostId: string, cwd: string): AgentSession {
  return {
    id,
    harness: "codex",
    status: "running",
    title: id,
    cwd,
    hostId,
    lastActivity: new Date().toISOString(),
    needsPermission: false,
  };
}

function fixture(sessions: AgentSession[], transport?: { call: (target: string, tool: string, args: Record<string, unknown>) => Promise<unknown> }) {
  const callbacks = new Map<string, (args: unknown) => Promise<any>>();
  const events = new HerderEventBus();
  const adapter = {
    type: "codex",
    name: "codex",
    async listSessions() { return sessions; },
    async getSession(id: string) { return sessions.find((item) => item.id === id) ?? null; },
    async sendMessage() { return { ok: true }; },
    async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; },
    async setPermissions() { return { ok: true }; },
  } as unknown as HarnessAdapter;
  registerSessionTools(
    { registerTool: (name: string, _schema: unknown, cb: (args: unknown) => Promise<any>) => { callbacks.set(name, cb); } } as never,
    {
      adapters: new Map([["codex", adapter]]),
      jobs: new HerderJobRegistry(events),
      events,
      ...(transport ? { transport: transport as never } : {}),
    },
  );
  return { callbacks };
}

describe("work machine of a live session", () => {
  it("lists every machine without a filter and only one machine with it", async () => {
    const { callbacks } = fixture([
      session("on-44", "server-44", "/w/44"),
      session("on-88", "roomhacker-server-88", "/w/88"),
    ]);
    const list = callbacks.get("list_agents")!;
    const all = await list({});
    expect(all.structuredContent.sessions.map((item: AgentSession) => item.id).sort()).toEqual(["on-44", "on-88"]);
    expect(all.structuredContent.filters.hostId).toBeUndefined();
    const only44 = await list({ hostId: "Server-44" });
    expect(only44.structuredContent.sessions.map((item: AgentSession) => item.id)).toEqual(["on-44"]);
    expect(only44.structuredContent.filters.hostId).toBe("server-44");
    const only88 = await list({ hostId: "roomhacker-server-88" });
    expect(only88.structuredContent.sessions.map((item: AgentSession) => item.id)).toEqual(["on-88"]);
    const none = await list({ hostId: "server-100" });
    expect(none.structuredContent.sessions).toEqual([]);
  });

  it("moves a live session to another machine and shows the new owner in the projection", async () => {
    const live = session("s1", localHost, "/launch/dir");
    const { callbacks } = fixture([live], {
      call: async (target, tool) => {
        expect(tool).toBe("workspace_probe");
        expect(target).toBe("mcp:shell:server-44:AgentHerder");
        return { hostId: "server-44", cwd: "/remote/work" };
      },
    });
    const result = await callbacks.get("set_session_target")!({ sessionId: "s1", hostId: "server-44", cwd: "/remote/work" });
    const receipt = result.structuredContent;
    expect(receipt.state).toBe("updated");
    expect(receipt.hostId).toBe("server-44");
    expect(receipt.cwd).toBe("/remote/work");
    expect(receipt.previous).toEqual({ hostId: localHost, cwd: "/launch/dir" });

    // The mesh projection observes the new machine and directory.
    const declared = await coordinationNotes.activeWorkspaceObservation("s1");
    expect(declared?.hostId).toBe("server-44");
    expect(declared?.cwd).toBe("/remote/work");
    const projected = {
      ...live,
      cwd: declared!.cwd,
      meta: { launchCwd: live.cwd, activeCwd: declared!.cwd, workspaceHostId: declared!.hostId, projectSource: declared!.source },
    };
    const observation = projectObservation(projected);
    expect(observation.currentCwd).toBe("/remote/work");
    expect(observation.hostId).toBe("server-44");

    // The old machine does not own the session any more.
    expect(declared!.hostId).not.toBe(localHost);

    // And the list shows the machine the session now works on.
    const listed = await callbacks.get("list_agents")!({});
    expect(listed.structuredContent.sessions[0].hostId).toBe("server-44");
    const only44 = await callbacks.get("list_agents")!({ hostId: "server-44" });
    expect(only44.structuredContent.sessions.map((item: AgentSession) => item.id)).toEqual(["s1"]);
    const onlyLocal = await callbacks.get("list_agents")!({ hostId: localHost });
    expect(onlyLocal.structuredContent.sessions).toEqual([]);
  });

  it("keeps the machine and only moves the directory when no machine is named", async () => {
    const live = session("s2", localHost, "/launch/dir");
    const { callbacks } = fixture([live]);
    const result = await callbacks.get("set_session_target")!({ sessionId: "s2", cwd: "/other/dir" });
    expect(result.structuredContent.state).toBe("updated");
    expect(result.structuredContent.hostId).toBe(localHost);
    expect(result.structuredContent.cwd).toBe("/other/dir");
    const declared = await coordinationNotes.activeWorkspaceObservation("s2");
    expect(declared?.hostId).toBe(localHost);
    expect(declared?.cwd).toBe("/other/dir");
  });
});
