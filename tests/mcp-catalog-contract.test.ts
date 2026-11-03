import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentHerderMcpServer } from "../src/index.js";
import * as catalogPolicy from "../src/mcp/catalog-policy.js";

const connections: Array<{ client: Client; server: { close(): Promise<void> } }> = [];
// Run catalog contract fixtures without the host-specific production hide file.
beforeEach(() => vi.stubEnv("AGENT_HERDER_CATALOG_POLICY_FILE", "/dev/null"));
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const { client, server } of connections.splice(0)) {
    await client.close();
    await server.close();
  }
});

async function connect() {
  const server = createAgentHerderMcpServer();
  const client = new Client({ name: "catalog-contract", version: "1" }, { versionNegotiation: { mode: "auto" } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  connections.push({ client, server });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("ordinary Agent Herder catalog", () => {
  it("advertises every registered tool under its own name except the internal readers", async () => {
    const client = await connect();
    // Observe the same SDK catalog without projection; no registration or
    // configuration changes between requests, and no production opt-out.
    vi.spyOn(catalogPolicy, "projectToolCatalog").mockImplementationOnce(result => result);
    const baseline = (await client.listTools()).tools;
    const projected = (await client.listTools()).tools;
    const names = projected.map(tool => tool.name);
    expect(baseline.map(tool => tool.name)).toEqual(expect.arrayContaining(["session_search_local", "list_active_sessions_local"]));
    for (const tool of projected) expect(tool).toEqual(baseline.find(original => original.name === tool.name));
    // The consolidation facade layer is gone: projection hides only the two
    // documented internal readers, and nothing else.
    expect(baseline.length - projected.length).toBe(2);
    console.info("catalog projection: " + baseline.length + " registered -> " + projected.length + " visible");
    expect(names).toEqual(expect.arrayContaining(["resume_after", "deliver", "create_session", "send_message", "stop_agent", "rename_session", "list_agents", "job_list", "change_model", "resume_after_status"]));
    for (const internal of ["session_search_local", "list_active_sessions_local"]) {
      expect(names).not.toContain(internal);
      expect(baseline.map(tool => tool.name)).toContain(internal);
    }
    for (const facade of ["model", "stop", "rename", "session_info", "list_sessions", "job", "workspace", "search", "service_tier", "session_queue", "coordination_note"]) {
      expect(names).not.toContain(facade);
    }
  });

  it.each([
    ["session_search_local", { query: "" }],
    ["list_active_sessions_local", { unexpected: true }],
  ])("keeps the exact %s dispatcher and strict input validation", async (name, args) => {
    const client = await connect();
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toMatch(/valid|argument|unrecognized/i);
    expect(text).not.toMatch(/not found|disabled/);
  });
});
