import { describe, expect, it, vi } from "vitest";
import { FleetCabinetService } from "../src/mesh/fleet-service.js";
import { fleetSessionControlSchema } from "../src/mesh/fleet-session-control.js";

// Fleet sessions are addressed by their full address; the transport is mocked, so no network is used.
describe("fleet addressing of an existing session", () => {
  function serviceWith(requestSession: ReturnType<typeof vi.fn>, hosts = [{ hostId: "server-44", label: "44", nativeUser: "roomhacker" }]) {
    return new FleetCabinetService({
      hosts,
      scope: { profileId: "owner", userId: "me" },
      transportFactory: () => ({
        discover: async () => ({}),
        schema: async () => ({}),
        call: async () => ({}),
        requestSession: requestSession as never,
      }),
    });
  }

  it("sends the work target of an existing session to the machine that owns it", async () => {
    const requestSession = vi.fn(async () => ({ hostId: "server-44", status: 200, body: { ok: true, hostId: "server-88", cwd: "/w" } }));
    const service = serviceWith(requestSession);
    const receipt = await service.setSessionTarget(
      { hostId: "server-44", harness: "codex", nativeSessionId: "s1" },
      { hostId: "server-88", cwd: "/w" },
    );
    expect(requestSession).toHaveBeenCalledTimes(1);
    expect(requestSession.mock.calls[0]?.[0]).toBe("mcp:shell:server-44:AgentHerder");
    expect(requestSession.mock.calls[0]?.[1]).toBe("codex");
    expect(requestSession.mock.calls[0]?.[2]).toBe("s1");
    expect(requestSession.mock.calls[0]?.[3]).toEqual({ operation: "set-target", hostId: "server-88", cwd: "/w" });
    expect(receipt).toEqual({ state: "updated", hostId: "server-88", cwd: "/w" });
  });

  it("keeps one spelling of a machine", async () => {
    const requestSession = vi.fn(async () => ({ hostId: "server-44", status: 200, body: {} }));
    const service = serviceWith(requestSession);
    const receipt = await service.setSessionTarget(
      { hostId: "SERVER-44", harness: "codex", nativeSessionId: "s1" },
      { hostId: "SERVER-88", cwd: "/w" },
    );
    expect(requestSession.mock.calls[0]?.[0]).toBe("mcp:shell:server-44:AgentHerder");
    expect(requestSession.mock.calls[0]?.[3]).toEqual({ operation: "set-target", hostId: "server-88", cwd: "/w" });
    expect(receipt.state).toBe("updated");
  });

  it("refuses a session of a machine that is not part of the fleet", async () => {
    const requestSession = vi.fn(async () => ({ hostId: "server-44", status: 200, body: {} }));
    const service = serviceWith(requestSession);
    const receipt = await service.setSessionTarget(
      { hostId: "server-99", harness: "codex", nativeSessionId: "s1" },
      { hostId: "server-88", cwd: "/w" },
    );
    expect(receipt.state).toBe("unsupported");
    expect(receipt.reason).toBe("fleet_session_invalid");
    expect(requestSession).not.toHaveBeenCalled();
  });

  it("refuses a harness that the fleet does not host", async () => {
    const requestSession = vi.fn(async () => ({ hostId: "server-44", status: 200, body: {} }));
    const service = serviceWith(requestSession);
    const receipt = await service.setSessionTarget(
      { hostId: "server-44", harness: "minimax-code", nativeSessionId: "s1" },
      { hostId: "server-88", cwd: "/w" },
    );
    expect(receipt.state).toBe("unsupported");
    expect(requestSession).not.toHaveBeenCalled();
  });

  it("reports an unreachable machine instead of a silent success", async () => {
    const requestSession = vi.fn(async () => { throw new Error("peer_unreachable"); });
    const service = serviceWith(requestSession);
    const receipt = await service.setSessionTarget(
      { hostId: "server-44", harness: "codex", nativeSessionId: "s1" },
      { hostId: "server-88", cwd: "/w" },
    );
    expect(receipt.state).toBe("unreachable");
    expect(receipt.hostId).toBe("server-88");
  });

  it("keeps the work target inside the existing session control contract", () => {
    const parsed = fleetSessionControlSchema.parse({ operation: "set-target", hostId: "server-88", cwd: "/w" });
    expect(parsed.operation).toBe("set-target");
    expect(fleetSessionControlSchema.safeParse({ operation: "set-target" }).success).toBe(false);
    expect(fleetSessionControlSchema.safeParse({ operation: "message", message: "hi", inputId: "1" }).success).toBe(true);
  });
});
