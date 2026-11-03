import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentHerderMcpServer } from "../src/index.js";

const connected: Array<{ client: Client; server: { close(): Promise<void> } }> = [];
beforeEach(() => {
  // Run without the host-specific production hide file.
  vi.stubEnv("AGENT_HERDER_CATALOG_POLICY_FILE", "/dev/null");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(connected.splice(0).map(async ({ client, server }) => { await client.close(); await server.close(); }));
});

async function advertisedNames(): Promise<string[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createAgentHerderMcpServer();
  const client = new Client({ name: "catalog-originals-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connected.push({ client, server });
  return (await client.listTools()).tools.map((tool) => tool.name);
}

describe("the catalog keeps the original tool names (consolidation stopped)", () => {
  it("advertises the machine endpoints the fleet and peers read as capability proofs", async () => {
    const names = await advertisedNames();
    expect(names).toContain("mesh_snapshot");
    expect(names).toContain("mesh_deliver");
    expect(names).toContain("mesh_route");
    expect(names).toContain("mesh_discover");
    expect(names).toContain("fleet_node_info");
    expect(names).toContain("fleet_session_page");
    expect(names).toContain("list_agents");
    expect(names).toContain("list_active_sessions");
  });

  it("advertises the original operation names instead of selector facades", async () => {
    const names = await advertisedNames();
    expect(names).toContain("stop_agent");
    expect(names).toContain("rename_session");
    expect(names).toContain("list_models");
    expect(names).toContain("change_model");
    expect(names).toContain("get_service_tier");
    expect(names).toContain("set_service_tier");
    expect(names).toContain("job_list");
    expect(names).toContain("job_get");
    expect(names).toContain("job_cancel");
    expect(names).toContain("coordination_note_create");
    expect(names).toContain("coordination_note_list");
    expect(names).toContain("resume_after");
    expect(names).toContain("resume_after_status");
    expect(names).toContain("resume_after_cancel");
  });

  it("no longer registers selector facades over the originals", async () => {
    const names = await advertisedNames();
    expect(names).not.toContain("search");
    expect(names).not.toContain("model");
    expect(names).not.toContain("service_tier");
    expect(names).not.toContain("session_queue");
    expect(names).not.toContain("job");
    expect(names).not.toContain("session_info");
    expect(names).not.toContain("list_sessions");
    expect(names).not.toContain("stop");
    expect(names).not.toContain("rename");
    expect(names).not.toContain("cdp_chat");
    expect(names).not.toContain("cdp_archive");
    expect(names).not.toContain("cdp_account");
    expect(names).not.toContain("cdp_send");
  });
});
