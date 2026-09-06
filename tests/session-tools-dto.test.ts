import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { registerSessionTools } from "../src/mcp/session-tools.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

function fixtureSession(id = "sess-1"): AgentSession {
  return {
    id, harness: "opencode", status: "idle", title: `Session ${id}`, cwd: "/repo",
    lastActivity: "2026-09-06T02:00:00.000Z", model: "gpt-test", needsPermission: false,
    messageCount: 3, lastMessage: "done",
  };
}

async function connect(): Promise<Client> {
  const session = fixtureSession();
  const child = fixtureSession("child-1");
  const parent = fixtureSession("parent-1");
  const adapter: HarnessAdapter = {
    type: "opencode", name: "OpenCode Fixture",
    async init() {}, async listSessions() { return [session]; }, async getSession(id) { return id === session.id ? session : null; },
    async getParent() { return parent; }, async listChildren() { return [child]; }, async listModels() { return ["gpt-test", "gpt-alt"]; },
    async sendMessage() { return { ok: true }; }, async stopSession() { return { ok: true }; }, async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
  };
  const events = new HerderEventBus();
  const server = new McpServer({ name: "session-dto-test", version: "1" });
  registerSessionTools(server, { adapters: new Map([["opencode", adapter]]), jobs: new HerderJobRegistry(events), events });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "session-dto-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

describe("session tool DTOs", () => {
  it("publishes output schemas and structured session results", async () => {
    const client = await connect();
    const tools = (await client.listTools()).tools;
    for (const name of ["list_agents", "agent_info", "find_parent", "list_children", "list_models"]) {
      expect(tools.find((tool) => tool.name === name)?.outputSchema).toMatchObject({ type: "object" });
    }

    const listed = await client.callTool({ name: "list_agents", arguments: { harness: "opencode", includeLastMessage: true } });
    expect(listed.structuredContent).toMatchObject({ total: 1, limited: false, sessions: [expect.objectContaining({ id: "sess-1", model: "gpt-test" })] });
    expect(listed.content[0]?.type === "text" ? listed.content[0].text : "").toContain("[opencode] sess-1");

    const info = await client.callTool({ name: "agent_info", arguments: { harness: "opencode", sessionId: "sess-1" } });
    expect(info.structuredContent).toMatchObject({ session: { id: "sess-1", messageCount: 3 } });

    const parent = await client.callTool({ name: "find_parent", arguments: { harness: "opencode", sessionId: "sess-1" } });
    expect(parent.structuredContent).toMatchObject({ supported: true, parent: { id: "parent-1" } });

    const children = await client.callTool({ name: "list_children", arguments: { harness: "opencode", sessionId: "sess-1" } });
    expect(children.structuredContent).toMatchObject({ supported: true, children: [{ id: "child-1" }] });

    const models = await client.callTool({ name: "list_models", arguments: { harness: "opencode" } });
    expect(models.structuredContent).toEqual({ harnesses: [{ harness: "opencode", name: "OpenCode Fixture", models: ["gpt-test", "gpt-alt"], defaultModel: "gpt-test" }] });
  });
});
