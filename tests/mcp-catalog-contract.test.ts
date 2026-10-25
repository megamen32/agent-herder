import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentHerderMcpServer } from "../src/index.js";
import * as catalogPolicy from "../src/mcp/catalog-policy.js";

const connections: Array<{ client: Client; server: { close(): Promise<void> } }> = [];
afterEach(async () => {
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
  it("omits exactly the two internal local readers from discovery", async () => {
    const client = await connect();
    // Observe the same SDK catalog without projection; no registration or
    // configuration changes between requests, and no production opt-out.
    vi.spyOn(catalogPolicy, "projectToolCatalog").mockImplementationOnce(result => result);
    const baseline = (await client.listTools()).tools;
    const projected = (await client.listTools()).tools;
    const names = projected.map(tool => tool.name);
    expect(baseline.map(tool => tool.name)).toEqual(expect.arrayContaining(["session_search_local", "list_active_sessions_local"]));
    expect(projected).toEqual(baseline.filter(tool => tool.name !== "session_search_local" && tool.name !== "list_active_sessions_local"));
    expect(projected).toHaveLength(baseline.length - 2);
    console.info(`catalog advertisement: ${baseline.length} -> ${projected.length}; exactly two internal readers omitted`);
    expect(names).not.toContain("session_search_local");
    expect(names).not.toContain("list_active_sessions_local");
    expect(names).toEqual(expect.arrayContaining(["session_search", "list_active_sessions", "send_message", "deliver", "stop_agent"]));
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
