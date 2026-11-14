import { expect, it, vi } from "vitest";
import { GptAdminMesh } from "../src/mesh/gptadmin.js";

it("normalizes Codex SSH host aliases before ordinary deliver routing", async () => {
  const target = {
    hostId: "remote-ssh-discovered:104.bezrabotnyi.com",
    harness: "codex",
    nativeSessionId: "native-100",
  };
  const sender = {
    hostId: "remote-ssh-discovered:104.bezrabotnyi.com",
    harness: "opencode",
    nativeSessionId: "sender",
  };
  const hub = {
    discover: vi.fn(async () => ({ servers: [{
      server_id: "mcp:shell:roomhacker-server-100:AgentHerder",
      kind: "child_mcp",
      status: "configured",
    }] })),
    schema: vi.fn(async () => ({ tools: [{ name: "deliver" }, { name: "fleet_node_info" }] })),
    readSession: vi.fn(async () => ({
      hostId: "roomhacker-server-100",
      session: { id: "native-100", harness: "codex", cwd: "/verified-context" },
    })),
    call: vi.fn(async (_target: string, tool: string, args: Record<string, unknown>) => {
      if (tool === "fleet_node_info") return { hostId: "roomhacker-server-100" };
      expect(tool).toBe("deliver");
      expect(args.target).toMatchObject({ hostId: "roomhacker-server-100", nativeSessionId: "native-100" });
      expect(args.sender).toMatchObject({ hostId: "roomhacker-server-100", nativeSessionId: "sender" });
      return { state: "admitted", inputId: args.inputId, turnId: "native-turn", retryable: false };
    }),
  };

  const receipt = await new GptAdminMesh(hub).deliver({
    target,
    sender,
    inputId: "alias-route-once",
    message: "route through ordinary deliver",
  });
  expect(receipt).toMatchObject({ state: "admitted", inputId: "alias-route-once", turnId: "native-turn" });
  expect(hub.call.mock.calls.filter(call => call[1] === "deliver")).toHaveLength(1);
});
