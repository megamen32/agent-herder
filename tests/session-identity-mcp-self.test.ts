import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { registerSessionTools } from "../src/mcp/session-tools.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

it("resolves self identity from each request's native metadata, not a shared connection", async () => {
  const sessions = ["ses_self_A", "ses_self_B"].map((id): AgentSession => ({
    id, harness: "opencode", hostId: "host-a", title: id, cwd: "/tmp/identity", status: "idle",
    lastActivity: new Date().toISOString(), needsPermission: false,
  }));
  const adapter = {
    type: "opencode", name: "identity fixture", init: async () => {},
    listSessions: async () => sessions,
    getSession: async (id: string) => sessions.find(s => s.id === id) ?? null,
  } as HarnessAdapter;
  const server = new McpServer({ name: "self-identity-fixture", version: "1" });
  registerSessionTools(server, { adapters: new Map([["opencode", adapter]]), routingPeers: [] });
  const client = new Client({ name: "self-identity-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
  const [a,b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try {
    const [first,second] = await Promise.all(sessions.map(s => client.callTool({
      name: "session_identity", arguments: {}, _meta: { "ai.opencode/sessionID": s.id },
    })));
    expect(first.isError).not.toBe(true); expect(second.isError).not.toBe(true);
    expect(first.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("ses_self_A") });
    expect(second.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("ses_self_B") });
    const explicit = await client.callTool({ name: "session_identity", arguments: { sessionId: "ses_self_B", harness: "opencode" }, _meta: { "ai.opencode/sessionID": "ses_self_A" } });
    expect(explicit.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("ses_self_B") });
    const missing = await client.callTool({ name: "session_identity", arguments: {} });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("caller_session_unavailable") });
  } finally { await client.close(); await server.close(); }
});
