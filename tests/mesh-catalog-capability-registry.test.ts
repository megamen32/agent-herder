import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { withCatalogProjection } from "../src/mcp/catalog-projection.js";
import { withToolConsolidation } from "../src/mcp/tool-consolidation.js";
import { GptAdminMesh } from "../src/mesh/gptadmin.js";
import { FleetCabinetService } from "../src/mesh/fleet-service.js";

const connections: Array<{ client: Client; server: McpServer }> = [];
const dirs: string[] = [];
let policyFile: string;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-catalog-"));
  dirs.push(dir);
  policyFile = join(dir, "catalog-policy.json");
  // Mirrors the deployed ~/.config/agent-herder/catalog-policy.json whose
  // hide list contains the machine endpoints the fleet reads.
  writeFileSync(policyFile, JSON.stringify({
    hide: ["mesh_snapshot", "mesh_deliver", "mesh_route", "fleet_node_info", "fleet_session_page", "list_agents"],
  }));
  vi.stubEnv("AGENT_HERDER_CATALOG_POLICY_FILE", policyFile);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const { client, server } of connections.splice(0)) {
    await client.close();
    await server.close();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

/**
 * The production registration shape: the list_sessions family and the
 * deliver facade consolidate exactly the machine endpoints the fleet reads,
 * and the policy file hides them on top of that.
 */
async function consolidatedHerder(): Promise<Client> {
  const server = new McpServer({ name: "herder-catalog-fixture", version: "1" });
  const hidden = new Set<string>();
  withCatalogProjection(server, () => withToolConsolidation(server, () => {
    server.registerTool("mesh_snapshot", { inputSchema: z.object({ limit: z.number().int().min(1).max(12).default(12) }).strict() }, async () => text({ hostId: "100", sessions: [], harnesses: [], complete: true }));
    server.registerTool("mesh_discover", { inputSchema: z.object({ limit: z.number().int().min(1).max(12).default(12) }).strict() }, async () => text({ sessions: [], hosts: [], complete: true }));
    server.registerTool("mesh_route", { inputSchema: z.object({}).strict() }, async () => text({ state: "admitted" }));
    server.registerTool("mesh_deliver", { inputSchema: z.object({}).strict() }, async () => text({ state: "admitted" }));
    server.registerTool("fleet_node_info", { inputSchema: z.object({}).strict() }, async () => text({ hostId: "100", nativeUser: "roomhacker", generation: 1, createHarnesses: ["codex"] }));
    server.registerTool("fleet_session_page", { inputSchema: z.object({}).strict() }, async () => text({ sessions: [], cursor: null }));
    server.registerTool("list_agents", { inputSchema: z.object({}).strict() }, async () => text([]));
    server.registerTool("list_active_sessions", { inputSchema: z.object({}).strict() }, async () => text([]));
    server.registerTool("deliver", { inputSchema: z.object({ sessionId: z.string(), message: z.string() }).strict() }, async () => text({}));
  }, hidden), hidden);
  const client = new Client({ name: "mesh-catalog-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  connections.push({ client, server });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("peer capability registry stays discoverable", () => {
  it("advertises the machine endpoints under consolidation and policy hiding", async () => {
    const client = await consolidatedHerder();
    const names = (await client.listTools()).tools.map(tool => tool.name);
    for (const endpoint of ["mesh_snapshot", "mesh_deliver", "fleet_node_info", "fleet_session_page", "list_agents"]) {
      expect(names).toContain(endpoint);
    }
  });

  it("proves mesh capability from the projected catalog a real peer advertises (GPTAdmin discovery)", async () => {
    const client = await consolidatedHerder();
    const advertised = (await client.listTools()).tools.map(tool => ({ name: tool.name }));
    const hub = {
      discover: vi.fn(async () => ({ servers: [
        { server_id: "shell:100", kind: "virtual_shell", status: "online" },
        { server_id: "mcp:shell:100:AgentHerder", kind: "child_mcp", name: "agent-herder", status: "online" },
      ] })),
      schema: vi.fn(async () => ({ tools: advertised })),
      call: vi.fn(async (_target: string, tool: string) => tool === "mesh_snapshot"
        ? { hostId: "100", sessions: [], harnesses: [], complete: true }
        : { state: "admitted", inputId: "i", turnId: "t", retryable: false }),
    };
    const result = await new GptAdminMesh(hub).discover();
    const host = result.hosts.find(row => row.hostId === "100");
    expect(host?.state).toBe("available");
    expect(host?.reason).toBeUndefined();
  });

  it("serves the fleet cabinet snapshot from the projected catalog a real peer advertises", async () => {
    const client = await consolidatedHerder();
    const advertised = (await client.listTools()).tools.map(tool => ({ name: tool.name }));
    const row = {
      address: { hostId: "100", harness: "codex", nativeSessionId: "same-id" },
      project: { launchCwd: "/launch", currentCwd: null, source: "unverified" },
      status: "running", title: "fixture", lastActivity: "now",
    };
    const transport = {
      discover: vi.fn(async () => ({ servers: [
        { server_id: "shell:100", kind: "virtual_shell", status: "online" },
        { server_id: "mcp:shell:100:AgentHerder", kind: "child_mcp", name: "agent-herder", status: "online" },
      ] })),
      schema: vi.fn(async () => ({ tools: advertised })),
      call: vi.fn(async (_target: string, tool: string) => tool === "mesh_snapshot"
        ? { hostId: "100", sessions: [row], complete: true, harnesses: [] }
        : tool === "fleet_node_info"
          ? { hostId: "100", nativeUser: "roomhacker", generation: 1, createHarnesses: ["codex"] }
          : { ok: true }),
    };
    const service = new FleetCabinetService({
      hosts: [{ hostId: "100", label: "Сервер 100" }],
      scope: { profileId: "p", userId: "u" },
      transportFactory: () => transport,
    });
    const snapshot = await service.snapshot();
    const host = snapshot.hosts.find(row => row.hostId === "100");
    expect(host?.state).toBe("ready");
    expect(host?.reason).toBeUndefined();
    expect(snapshot.sessions).toHaveLength(1);
  });
});
