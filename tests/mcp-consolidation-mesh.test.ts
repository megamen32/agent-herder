import { hostname } from "node:os";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { withCatalogProjection } from "../src/mcp/catalog-projection.js";

// Run without the host-specific production hide file: this test asserts the
// projection mechanism, the operator's policy file has its own test.
beforeEach(() => vi.stubEnv("AGENT_HERDER_CATALOG_POLICY_FILE", "/dev/null"));

const response = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const address = z.object({ hostId: z.string().min(1), harness: z.string().min(1), nativeSessionId: z.string().min(1) });
const meshSchema = z.object({
  target: address,
  sender: address,
  inputId: z.string().min(1).max(256),
  message: z.string().min(1),
});
const localHost = hostname();
const sender = { hostId: localHost, harness: "opencode", nativeSessionId: "sender-1" };

async function connect() {
  const server = new McpServer({ name: "native-mesh-catalog-fixture", version: "1" });
  const ordinary = vi.fn(async () => response({ kind: "ordinary" }));
  const local = vi.fn(async (args: unknown) => response({ kind: "local", args }));
  const remote = vi.fn(async (args: unknown) => response({ kind: "remote", args }));
  withCatalogProjection(server, () => {
    server.registerTool("deliver", { inputSchema: z.object({ sessionId: z.string(), message: z.string() }).strict() }, ordinary);
    server.registerTool("mesh_deliver", { inputSchema: meshSchema }, local);
    server.registerTool("mesh_route", { inputSchema: meshSchema }, remote);
  });
  const client = new Client({ name: "mesh-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server, ordinary, local, remote };
}

it("keeps ordinary delivery and both native mesh endpoints discoverable and callable", async () => {
  const { client, server, ordinary, local, remote } = await connect();
  try {
    // The consolidation facade layer is gone: every registered endpoint is
    // advertised under its own name, so the peers and the fleet can read
    // their capability proofs straight from the catalog.
    const advertised = (await client.listTools()).tools.map(tool => tool.name);
    expect(advertised).toEqual(["deliver", "mesh_deliver", "mesh_route"]);

    const localMessage = { target: { hostId: localHost, harness: "opencode", nativeSessionId: "worker-1" }, sender, inputId: "local-exact", message: "work delta" };
    const remoteMessage = { ...localMessage, target: { ...localMessage.target, hostId: "remote-host" }, inputId: "remote-exact" };

    expect((await client.callTool({ name: "deliver", arguments: { sessionId: "worker-1", message: "legacy" } })).content)
      .toMatchObject([{ text: '{"kind":"ordinary"}' }]);
    await client.callTool({ name: "mesh_deliver", arguments: localMessage });
    expect(local).toHaveBeenCalledWith(localMessage, expect.anything());
    await client.callTool({ name: "mesh_route", arguments: remoteMessage });
    expect(remote).toHaveBeenCalledWith(remoteMessage, expect.anything());
    expect(ordinary).toHaveBeenCalledTimes(1);

    const malformed = await client.callTool({ name: "mesh_route", arguments: { ...remoteMessage, sender: undefined } });
    expect(malformed.isError).toBe(true);
    expect(remote).toHaveBeenCalledTimes(1);
  } finally { await client.close(); await server.close(); }
});
