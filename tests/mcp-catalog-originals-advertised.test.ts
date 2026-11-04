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

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createAgentHerderMcpServer();
  const client = new Client({ name: "catalog-v2-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connected.push({ client, server });
  return client;
}

async function advertisedNames(): Promise<string[]> {
  const client = await connect();
  return (await client.listTools()).tools.map((tool) => tool.name);
}

describe("the consolidated catalog (v2: selector facades plus protected proofs)", () => {
  it("advertises the machine endpoints the fleet and peers read as capability proofs", async () => {
    const names = await advertisedNames();
    for (const proof of ["mesh_snapshot", "mesh_deliver", "mesh_route", "fleet_node_info", "fleet_session_page", "list_agents", "create_session"]) {
      expect(names).toContain(proof);
    }
  });

  it("advertises the selector facades over the superseded originals", async () => {
    const names = await advertisedNames();
    for (const facade of ["stop", "rename", "session_info", "list_sessions", "search", "model", "service_tier", "session_queue", "job", "coordination_note", "resume_after", "cadence", "human_request", "workspace", "read_message", "export_transcript", "browser_wake", "chatgpt_wake", "project", "session_lineage", "deliver"]) {
      expect(names).toContain(facade);
    }
  });

  it("hides the superseded original names from discovery but keeps them callable", async () => {
    const names = await advertisedNames();
    for (const hidden of ["stop_agent", "rename_session", "mesh_stop", "mesh_rename_session", "fleet_session_view", "job_list", "job_get", "job_cancel", "coordination_note_create", "list_models", "change_model", "save_message_to_file", "workspace_declare", "workspace_status", "send_message", "new_or_resume"]) {
      expect(names).not.toContain(hidden);
    }
    // Hidden tools stay registered and callable: the fleet's direct transports
    // and existing callers still address these exact names.
    const client = await connect();
    const result = await client.callTool({ name: "job_list", arguments: {} });
    const text = JSON.stringify(result.content ?? "");
    expect(text).not.toMatch(/Unknown tool|not found/i);
  });
});
