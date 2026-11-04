import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { withCatalogProjection } from "../src/mcp/catalog-projection.js";
import { withToolConsolidation } from "../src/mcp/tool-consolidation.js";

const connections: Array<{ client: Client; server: McpServer }> = [];
// Run catalog contract fixtures without the host-specific production hide file.
beforeEach(() => vi.stubEnv("AGENT_HERDER_CATALOG_POLICY_FILE", "/dev/null"));
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const { client, server } of connections.splice(0)) {
    await client.close();
    await server.close();
  }
});

function text(message: string) {
  return { content: [{ type: "text" as const, text: message }] };
}

describe("consolidated MCP facades preserve native semantics", () => {
  it("routes action, target, legacy, async and union schemas without weakening guards", async () => {
    const server = new McpServer({ name: "consolidated-fixture", version: "1" });
    const hidden = new Set<string>();
    const change = vi.fn(async ({ model }: { model: string }) => text("changed:" + model));
    const oldWait = vi.fn(async () => text("registered-wait"));
    const stop = vi.fn(async ({ sessionId }: { sessionId: string }) => text("stopped:" + sessionId));
    const rename = vi.fn(async ({ title }: { title?: string }) => text("renamed:" + title));
    const sendFixture = vi.fn(async () => text("sent"));
    const archiveSync = vi.fn(async () => text("archived-sync"));
    const archiveAsync = vi.fn(async () => text("archived-async"));
    const cadenceControl = vi.fn(async ({ action }: { action: "pause" | "complete" }) => text("controlled:" + action));
    withCatalogProjection(server, () => withToolConsolidation(server, () => {
      server.registerTool("list_models", { inputSchema: z.object({}).strict() }, async () => text("models"));
      server.registerTool("change_model", { inputSchema: z.object({ model: z.string().min(1) }).strict() }, change);
      server.registerTool("stop_agent", { inputSchema: z.object({
        sessionId: z.string().min(1), harness: z.string().optional(), hostId: z.string().optional(),
      }).strict() }, stop);
      server.registerTool("rename_session", { inputSchema: z.object({
        sessionId: z.string().min(1), harness: z.string().optional(), hostId: z.string().optional(),
        title: z.string().optional(), goal: z.string().optional(), project: z.string().optional(), stage: z.string().optional(),
      }).strict() }, rename);
      server.registerTool("resume_after", { inputSchema: z.union([
        z.object({ delayMs: z.number().int().positive() }).strict(),
        z.object({ dependencies: z.array(z.string()).min(1) }).strict(),
      ]) }, oldWait);
      server.registerTool("resume_after_status", {
        inputSchema: z.object({ waitId: z.string().optional() }).strict(),
      }, async () => text("pending"));
      server.registerTool("cadence_control", {
        inputSchema: z.object({ action: z.enum(["pause", "complete"]), scheduleId: z.string(), sessionId: z.string() }).strict(),
      }, cadenceControl);
      server.registerTool("cadence_schedule", {
        inputSchema: z.object({ sessionId: z.string(), requestId: z.string() }).strict(),
      }, async () => text("scheduled"));
      server.registerTool("cdp_send_message", {
        inputSchema: z.object({
          chatRef: z.string().min(1), text: z.string().min(1), confirmation: z.literal("SEND_MESSAGE"),
          idempotencyKey: z.string().min(1),
        }).strict(),
      }, sendFixture);
      server.registerTool("cdp_export_chat", {
        inputSchema: z.object({ chatRef: z.string().min(1) }).strict(),
      }, archiveSync);
      server.registerTool("cdp_export_chat_async", {
        inputSchema: z.object({ chatRef: z.string().min(1), ownerSessionId: z.string().optional() }).strict(),
      }, archiveAsync);
      server.registerTool("deliver", { inputSchema: z.object({ message: z.string() }).strict() }, async () => text("delivered"));
      server.registerTool("send_message", { inputSchema: z.object({ message: z.string() }).strict() }, async () => text("legacy-send"));
    }, hidden), hidden);

    const client = new Client({ name: "fixture-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    connections.push({ client, server });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(["model", "stop", "rename", "resume_after", "cadence", "cdp_chat", "cdp_archive", "deliver"]));
    for (const old of ["list_models", "change_model", "stop_agent", "rename_session", "resume_after_status", "cdp_send_message", "cdp_export_chat", "send_message"]) {
      expect(names).not.toContain(old);
    }
    expect((await client.callTool({ name: "model", arguments: { action: "list" } })).content).toMatchObject([{ text: "models" }]);
    expect((await client.callTool({ name: "model", arguments: { action: "set", model: "allowed" } })).content).toMatchObject([{ text: "changed:allowed" }]);
    expect(change).toHaveBeenCalledWith({ model: "allowed" }, expect.anything());
    // The legacy original no longer answers its old name: the consolidated
    // command is the one public path.
    const legacy = await client.callTool({ name: "change_model", arguments: { model: "legacy" } });
    expect(legacy.isError).toBe(true);
    expect(legacy.content).toMatchObject([{ text: expect.stringContaining("legacy_tool_removed") }]);
    expect((await client.callTool({ name: "model", arguments: { action: "set", model: "again" } })).content).toMatchObject([{ text: "changed:again" }]);
    expect((await client.callTool({ name: "model", arguments: { action: "bogus", model: "unsafe" } })).isError).toBe(true);
    expect(change).toHaveBeenCalledTimes(2);
    expect((await client.callTool({ name: "stop", arguments: { target: { sessionId: "s1" } } })).content).toMatchObject([{ text: "stopped:s1" }]);
    expect((await client.callTool({ name: "stop", arguments: { target: {} } })).isError).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect((await client.callTool({ name: "rename", arguments: { target: { sessionId: "s1" }, title: "new" } })).content).toMatchObject([{ text: "renamed:new" }]);
    expect((await client.callTool({ name: "resume_after", arguments: { delayMs: 200 } })).content).toMatchObject([{ text: "registered-wait" }]);
    expect((await client.callTool({ name: "resume_after", arguments: { action: "wait", dependencies: ["s1"] } })).content).toMatchObject([{ text: "registered-wait" }]);
    expect((await client.callTool({ name: "resume_after", arguments: { action: "status" } })).content).toMatchObject([{ text: "pending" }]);
    expect((await client.callTool({ name: "resume_after", arguments: { action: "unknown", delayMs: 300 } })).isError).toBe(true);
    expect(oldWait).toHaveBeenCalledTimes(2);
    expect((await client.callTool({ name: "cadence", arguments: { action: "pause", scheduleId: "sch", sessionId: "s1" } })).content).toMatchObject([{ text: "controlled:pause" }]);
    expect(cadenceControl).toHaveBeenCalledTimes(1);
    expect((await client.callTool({ name: "cdp_chat", arguments: { action: "send", chatRef: "chat", text: "hi", confirmation: "MISSING", idempotencyKey: "x" } })).isError).toBe(true);
    expect(sendFixture).not.toHaveBeenCalled();
    expect((await client.callTool({ name: "cdp_chat", arguments: { action: "send", chatRef: "chat", text: "hi", confirmation: "SEND_MESSAGE", idempotencyKey: "x" } })).content).toMatchObject([{ text: "sent" }]);
    expect(sendFixture).toHaveBeenCalledTimes(1);
    expect((await client.callTool({ name: "cdp_archive", arguments: { action: "chat", chatRef: "x" } })).content).toMatchObject([{ text: "archived-sync" }]);
    expect((await client.callTool({ name: "cdp_archive", arguments: { action: "chat", async: true, chatRef: "x" } })).content).toMatchObject([{ text: "archived-async" }]);
    expect(archiveSync).toHaveBeenCalledTimes(1);
    expect(archiveAsync).toHaveBeenCalledTimes(1);
  });
});
