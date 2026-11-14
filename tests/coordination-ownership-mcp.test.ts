import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentHerderMcpServer } from "../src/index.js";
import { CoordinationNoteStore } from "../src/coordination-notes.js";
import * as catalogPolicy from "../src/mcp/catalog-policy.js";

const connections: Array<{ client: Client; server: { close(): Promise<void> } }> = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map(async ({ client, server }) => { await client.close(); await server.close(); }));
});

describe("coordination ownership question MCP tools", () => {
  function payload<T>(result: { structuredContent?: unknown; content: Array<{ type: string; text?: string }> }): T {
    if (result.structuredContent !== undefined) return result.structuredContent as T;
    return JSON.parse(result.content.find((item) => item.type === "text")?.text ?? "{}") as T;
  }

  it("advertises scoped note guidance and closes an answered ownership question idempotently", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-herder-ownership-mcp-"));
    const coordination = new CoordinationNoteStore(join(dir, "notes.json"));
    const server = createAgentHerderMcpServer(undefined, { coordination });
    const client = new Client({ name: "coordination-ownership-test", version: "1" }, { versionNegotiation: { mode: "auto" } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    connections.push({ client, server });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    vi.spyOn(catalogPolicy, "projectToolCatalog").mockImplementationOnce((result) => result);
    const tools = (await client.listTools()).tools;
    expect(tools.find((tool) => tool.name === "coordination_note_create")?.description).toContain("scope=global");
    expect(tools.find((tool) => tool.name === "coordination_ownership_read")?.description).toContain("leave it open");
    expect(tools.find((tool) => tool.name === "coordination_ownership_answer")?.description).toContain("idempotent");

    const created = await client.callTool({ name: "coordination_note", arguments: { action: "create", scope: "workspace", kind: "question", message: "Can I own src/a.ts?", cwd: "/repo", paths: ["src/a.ts"], authorSessionId: "owner" } });
    const question = payload<{ note: { id: string } }>(created).note;
    const read = await client.callTool({ name: "coordination_ownership_read", arguments: { questionId: question.id, readerSessionId: "owner" } });
    expect(payload<{ questions: Array<{ status: string }> }>(read).questions[0]).toMatchObject({ status: "open" });

    const answered = await client.callTool({ name: "coordination_ownership_answer", arguments: { questionId: question.id, answererSessionId: "owner", answer: "Yes" } });
    expect(payload<{ question: { status: string; answer: string } }>(answered).question).toMatchObject({ status: "closed", answer: "Yes" });
    const repeated = await client.callTool({ name: "coordination_ownership_answer", arguments: { questionId: question.id, answererSessionId: "owner", answer: "Yes" } });
    expect(payload(repeated)).toEqual(payload(answered));
  });
});
