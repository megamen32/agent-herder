import { describe, expect, it, vi } from "vitest";
import { hostname } from "node:os";
import { registerSessionTools } from "../src/mcp/session-tools.js";
import { coordinationNotes } from "../src/coordination-notes.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

const statePath = vi.hoisted(() => {
  const path = `/tmp/agent-herder-set-target-${process.pid}-${Math.random().toString(36).slice(2)}.json`;
  process.env.AGENT_HERDER_COORDINATION_NOTES = path;
  return path;
});

const localHost = hostname();

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

const live: AgentSession = {
  id: "s1",
  harness: "codex",
  status: "running",
  title: "s1",
  cwd: "/launch/dir",
  hostId: localHost,
  lastActivity: new Date().toISOString(),
  needsPermission: false,
};

describe("set_session_target", () => {
  it("reports an unknown machine as unreachable instead of applying it locally", async () => {
    const { callbacks } = fixture([live]);
    const result = await callbacks.get("set_session_target")!({ sessionId: "s1", hostId: "not-a-fleet-machine", cwd: "/remote/work" });
    expect(result.structuredContent.state).toBe("unreachable");
    expect(result.structuredContent.reason).toContain("host_target_unavailable");
    expect(result.structuredContent.hostId).toBe("not-a-fleet-machine");
    // Nothing was declared: the session still works where it worked before.
    expect(await coordinationNotes.activeWorkspaceObservation("s1")).toBeUndefined();
  });

  it("reports a machine that cannot be probed as unreachable and keeps the old target", async () => {
    const { callbacks } = fixture([live], {
      call: async () => { throw new Error("peer_unreachable"); },
    });
    const result = await callbacks.get("set_session_target")!({ sessionId: "s1", hostId: "server-44", cwd: "/remote/work" });
    expect(result.structuredContent.state).toBe("unreachable");
    expect(result.structuredContent.state).not.toBe("updated");
    expect(result.structuredContent.reason).toContain("host_target_unavailable");
    expect(await coordinationNotes.activeWorkspaceObservation("s1")).toBeUndefined();
  });

  it("reports the same target as unchanged", async () => {
    const { callbacks } = fixture([live]);
    const first = await callbacks.get("set_session_target")!({ sessionId: "s1", cwd: "/other/dir" });
    expect(first.structuredContent.state).toBe("updated");
    const second = await callbacks.get("set_session_target")!({ sessionId: "s1", cwd: "/other/dir" });
    expect(second.structuredContent.state).toBe("unchanged");
    expect(second.structuredContent.cwd).toBe("/other/dir");
  });

  it("does not invent a target for a session it cannot see", async () => {
    const { callbacks } = fixture([live]);
    await expect(callbacks.get("set_session_target")!({ sessionId: "missing", hostId: "server-44" })).rejects.toThrow("session_not_found:missing");
  });
});
