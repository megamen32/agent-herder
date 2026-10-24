import { describe, expect, it, vi } from "vitest";
import { registerSessionTools } from "../src/mcp/session-tools.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { directFleetPeers, fleetPeers } from "../src/mesh/fleet-direct-transport.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

// The unit test environment may not start a process: a unit test that talks to
// a neighbour is a unit test that reads another machine.
const started = vi.hoisted(() => ({ commands: [] as string[] }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawn = (executable: string, args: string[] = []) => {
    started.commands.push([executable, ...args].join(" "));
    throw new Error("unit_test_forbids_process_start");
  };
  return { ...actual, default: { ...actual, spawn }, spawn };
});

function fixture(sessions: AgentSession[], routingPeers: readonly { hostId: string }[]) {
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
      routingPeers: routingPeers as never,
    },
  );
  return { callbacks };
}

describe("unit test fleet isolation", () => {
  it("knows the machines of the fleet, but addresses none of them", () => {
    const peers = fleetPeers();
    // The same machine names as the installation...
    expect(peers.map((peer) => peer.hostId)).toEqual(directFleetPeers.map((peer) => peer.hostId));
    // ...but no address of a live neighbour: every one of them is the machine of this test.
    for (const peer of peers) expect(peer.sshHost).toBe("127.0.0.1");
    // The installed list itself is untouched: the injection lives in the test environment only.
    expect(directFleetPeers.some((peer) => peer.sshHost !== "127.0.0.1")).toBe(true);
  });

  it("answers a machine of the fleet from the fixture of the test and starts no process", async () => {
    const session: AgentSession = { id: "on-44", harness: "codex", status: "running", title: "on-44", cwd: "/w/44", hostId: "server-44", lastActivity: new Date().toISOString(), needsPermission: false };
    const { callbacks } = fixture([session], []);
    const answer = await callbacks.get("list_agents")!({ hostId: "Server-44" });
    expect(answer.structuredContent.sessions.map((item: AgentSession) => item.id)).toEqual(["on-44"]);
    expect(started.commands).toEqual([]);
  });

  it("cannot reach a live neighbour even when the route to it is taken", async () => {
    const session: AgentSession = { id: "on-44", harness: "codex", status: "running", title: "on-44", cwd: "/w/44", hostId: "server-44", lastActivity: new Date().toISOString(), needsPermission: false };
    const { callbacks } = fixture([session], fleetPeers());
    await expect(callbacks.get("list_agents")!({ hostId: "Server-44" })).rejects.toThrow("unit_test_forbids_process_start");
    // The route that was taken points at the machine of the test, never at the neighbour of the installation.
    expect(started.commands.join("\n")).not.toContain("192.168.2.5");
    expect(started.commands.join("\n")).not.toContain("192.168.2.75");
  });
});
