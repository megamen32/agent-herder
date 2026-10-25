import { describe, expect, it, vi } from "vitest";
import { FleetCabinetService } from "../src/mesh/fleet-service.js";

const macOffline = { hostId: "mac", label: "Mac Mini", offline: true, offlineReason: "led by another session" };
const server = { hostId: "100", label: "Сервер 100" };

function transport() {
  return {
    discover: vi.fn(async () => ({ servers: [
      { kind: "virtual_shell", server_id: "shell:100", status: "online" },
      { kind: "virtual_shell", server_id: "shell:mac", status: "online" },
      { kind: "child_mcp", server_id: "mcp:shell:100:AgentHerder", name: "agent-herder", status: "online" },
    ] })),
    schema: vi.fn(async () => ({ tools: [{ name: "fleet_node_info" }, { name: "mesh_snapshot" }] })),
    call: vi.fn(async (_target: string, tool: string) => tool === "fleet_node_info"
      ? { hostId: "100", nativeUser: "roomhacker", generation: 1, createHarnesses: ["codex"] }
      : { hostId: "100", sessions: [], complete: false, harnesses: [] }),
  };
}

describe("a machine another session leads", () => {
  it("reads as offline for our fleet and is never probed", async () => {
    const factory = vi.fn(() => transport());
    const service = new FleetCabinetService({ hosts: [server, macOffline], scope: { profileId: "p", userId: "u" }, transportFactory: factory });
    const view = await service.snapshot({ limit: 3 });

    const mac = view.hosts.find((host) => host.hostId === "mac");
    expect(mac?.state).toBe("offline");
    expect(mac?.reason).toBe("led by another session");
    expect(mac?.createHarnesses).toEqual([]);
    expect(view.sessions.filter((session) => session.address.hostId === "mac")).toEqual([]);
    // The registry of that machine still says online: the offline state is ours.
    expect(factory.mock.calls.some((call) => (call[0] as { hostId: string }).hostId === "mac")).toBe(false);
  });

  it("reads as ready when nothing of ours declares it offline", async () => {
    const factory = vi.fn(() => transport());
    const service = new FleetCabinetService({ hosts: [server, { hostId: "mac", label: "Mac Mini" }], scope: { profileId: "p", userId: "u" }, transportFactory: factory });
    const view = await service.snapshot({ limit: 3 });

    expect(view.hosts.find((host) => host.hostId === "mac")?.state).not.toBe("offline");
  });
});
