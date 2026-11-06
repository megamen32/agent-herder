import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { createAgentHerderMcpServer } from "../src/index.js";

it("explains invalid workspace declaration fields and how to reserve paths", async () => {
  const server = createAgentHerderMcpServer();
  const client = new Client({ name: "validation-guidance", version: "1" }, { versionNegotiation: { mode: "auto" } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    const workspace = (await client.listTools()).tools.find(tool => tool.name === "workspace");
    expect(workspace?.description).toContain("Declare a workspace first; reserve file paths separately");
    const result = await client.callTool({ name: "workspace", arguments: {
      action: "declare", sessionId: "test", harness: "opencode", hostId: "local", cwd: "/tmp", paths: ["/tmp/test"], ttlSeconds: 600,
    } });
    expect(result.isError).toBe(true);
    const explanation = JSON.stringify(result.content);
    expect(explanation).toMatch(/paths/i);
    expect(explanation).toMatch(/reserve/i);
  } finally {
    await client.close();
    await server.close();
  }
});

it("accepts session_info without a detail selector and explains invalid selectors", async () => {
  const server = createAgentHerderMcpServer();
  const client = new Client({ name: "session-info-default", version: "1" }, { versionNegotiation: { mode: "auto" } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  try {
    const missing = await client.callTool({ name: "session_info", arguments: { sessionId: "missing-session", harness: "codex" } });
    expect(JSON.stringify(missing.content)).not.toMatch(/validation error/i);
    const invalid = await client.callTool({ name: "session_info", arguments: { sessionId: "missing-session", detail: "full" } });
    expect(JSON.stringify(invalid.content)).toMatch(/agent.*identity/i);
  } finally { await client.close(); await server.close(); }
});
