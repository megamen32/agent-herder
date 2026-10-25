import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createWebServer } from "../src/web/server.js";
import { TRUSTED_MESH_MCP_CLIENT_ID, TRUSTED_MESH_MCP_SCOPE } from "../src/mesh/authenticated-ingress.js";

const servers: Array<ReturnType<typeof createWebServer>> = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

describe("authenticated owner MCP context", () => {
  it("propagates only the bearer already validated by the owner HTTP route", async () => {
    const observed: Array<{ clientId: string | undefined; scopes: string[] | undefined }> = [];
    const server = createWebServer({ adapters: new Map(), converter: {} as never, mcpServerFactory: context => {
      observed.push({ clientId: (context?.authInfo as any)?.clientId, scopes: (context?.authInfo as any)?.scopes });
      const mcp = new McpServer({ name: "auth-context-test", version: "1" });
      mcp.registerTool("auth_probe", { inputSchema: {} }, async () => ({ content: [{ type: "text", text: "ok" }] }));
      return mcp;
    },
      mcpAuthToken: "fixture-transport-bearer", sessionObservationManagedExternally: true });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
    const client = new Client({ name: "auth-context-client", version: "1" });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL(origin), {
      authProvider: { token: async () => "fixture-transport-bearer" },
    });
    await client.connect(transport);
    await client.callTool({ name: "auth_probe", arguments: {} });
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every(entry => entry.clientId === TRUSTED_MESH_MCP_CLIENT_ID && entry.scopes?.includes(TRUSTED_MESH_MCP_SCOPE))).toBe(true);
  });
});
