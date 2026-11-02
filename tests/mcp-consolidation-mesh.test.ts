import { hostname } from "node:os";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { withCatalogProjection } from "../src/mcp/catalog-projection.js";
import { withToolConsolidation } from "../src/mcp/tool-consolidation.js";

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

async function connect(withRemote: boolean) {
  const server = new McpServer({ name: "native-mesh-consolidation-fixture", version: "1" });
  const hidden = new Set<string>();
  const ordinary = vi.fn(async () => response({ kind: "ordinary" }));
  const local = vi.fn(async (args: unknown) => response({ kind: "local", args }));
  const remote = vi.fn(async (args: unknown) => response({ kind: "remote", args }));
  withCatalogProjection(server, () => withToolConsolidation(server, () => {
    server.registerTool("deliver", { inputSchema: z.object({ sessionId: z.string(), message: z.string() }).strict() }, ordinary);
    server.registerTool("mesh_deliver", { inputSchema: meshSchema }, local);
    if (withRemote) server.registerTool("mesh_route", { inputSchema: meshSchema }, remote);
  }, hidden), hidden);
  const client = new Client({ name: "mesh-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server, ordinary, local, remote };
}
it("keeps discoverable exact local and remote target delivery with old direct aliases", async () => {
  const { client, server, ordinary, local, remote } = await connect(true);
  try {
    const advertised = (await client.listTools()).tools;
    expect(advertised.map(tool => tool.name)).toEqual(["deliver"]);
    const schema = advertised[0]?.inputSchema;
    expect(JSON.stringify(schema)).toContain("target");
    const localMessage = { target: { hostId: localHost, harness: "opencode", nativeSessionId: "worker-1" }, sender, inputId: "local-exact", message: "work delta" };
    const remoteMessage = { ...localMessage, target: { ...localMessage.target, hostId: "remote-host" }, inputId: "remote-exact" };
    expect((await client.callTool({ name: "deliver", arguments: { sessionId: "worker-1", message: "legacy" } })).content).toMatchObject([{ text: '{"kind":"ordinary"}' }]);
    await client.callTool({ name: "deliver", arguments: localMessage });
    await client.callTool({ name: "deliver", arguments: remoteMessage });
    expect(ordinary).toHaveBeenCalledTimes(1);
    expect(local).toHaveBeenCalledWith(localMessage, expect.anything());
    expect(remote).toHaveBeenCalledWith(remoteMessage, expect.anything());
    const malformed = await client.callTool({ name: "deliver", arguments: { ...remoteMessage, sender: undefined } });
    expect(malformed.isError).toBe(true);
    expect(remote).toHaveBeenCalledTimes(1);
    const legacy = await client.callTool({ name: "mesh_route", arguments: remoteMessage });
    expect(legacy.isError).not.toBe(true);
    expect(remote).toHaveBeenCalledTimes(2);
  } finally { await client.close(); await server.close(); }
});
it("refuses remote target without mesh transport instead of falling back to ordinary send", async () => {
  const { client, server, ordinary, local } = await connect(false);
  try {
    const reply = await client.callTool({ name: "deliver", arguments: {
      target: { hostId: "unreachable-peer", harness: "opencode", nativeSessionId: "worker-1" },
      sender, inputId: "no-mesh", message: "do not deliver locally",
    } });
    expect(reply.isError).toBe(true);
    expect(JSON.stringify(reply.content)).toContain("remote_mesh_transport_unavailable");
    expect(ordinary).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();
  } finally { await client.close(); await server.close(); }
});
