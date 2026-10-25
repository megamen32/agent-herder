import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer, type ListToolsResult } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { projectToolCatalog } from "../src/mcp/catalog-policy.js";
import { withCatalogProjection } from "../src/mcp/catalog-projection.js";

const connections: Array<{ client: Client; server: McpServer }> = [];
afterEach(async () => {
  for (const { client, server } of connections.splice(0)) {
    await client.close();
    await server.close();
  }
});

describe("advertisement-only catalog projection", () => {
  it("filters exact names without changing metadata, schemas, cursor or the input", () => {
    const names = ["session_search_local", "list_active_sessions_local", "session_search", "list_active_sessions", "session_search_local_extra"];
    const result: ListToolsResult = {
      tools: names.map(name => ({ name, inputSchema: { type: "object" }, description: name, annotations: { readOnlyHint: true } })),
      nextCursor: "next-page",
      _meta: { revision: 1 },
    };
    const before = structuredClone(result);
    const projected = projectToolCatalog(result);
    expect(projected).toEqual({ ...result, tools: result.tools.slice(2) });
    expect(projected.tools[0]).toBe(result.tools[2]);
    expect(result).toEqual(before);
  });

  it("keeps SDK tools/call, validation and a handler refusal after hiding both exact endpoints", async () => {
    const server = new McpServer({ name: "catalog-sdk-contract", version: "1" });
    const protocol = server.server;
    const originalRegistration = protocol.setRequestHandler;
    // Observe both sides of the projection through public registration only:
    // submitted = SDK's original handlers, forwarded = what reaches dispatch.
    const submitted: unknown[][] = [];
    const forwarded: unknown[][] = [];
    protocol.setRequestHandler = new Proxy(originalRegistration, {
      apply(target, receiver, args) {
        forwarded.push(args);
        return Reflect.apply(target, receiver, args);
      },
    });
    const observedRegistration = protocol.setRequestHandler;
    const search = vi.fn(async ({ query }: { query: string }) => {
      if (query === "denied") throw new Error("fixture_access_denied");
      return { content: [{ type: "text" as const, text: query }] };
    });
    const active = vi.fn(async () => ({ content: [{ type: "text" as const, text: "current-inventory" }] }));
    withCatalogProjection(server, () => {
      protocol.setRequestHandler = new Proxy(protocol.setRequestHandler, {
        apply(target, receiver, args) {
          submitted.push(args);
          return Reflect.apply(target, receiver, args);
        },
      });
      server.registerTool("session_search_local", { inputSchema: z.object({ query: z.string().min(1) }).strict() }, search);
      server.registerTool("list_active_sessions_local", { inputSchema: z.object({}).strict() }, active);
      server.registerTool("session_search", { inputSchema: z.object({}).strict() }, active);
    });
    expect(protocol.setRequestHandler).toBe(observedRegistration);
    for (const method of ["tools/list", "tools/call"]) {
      expect(submitted.filter(args => args[0] === method)).toHaveLength(1);
      expect(forwarded.filter(args => args[0] === method)).toHaveLength(1);
    }
    expect(forwarded.find(args => args[0] === "tools/call")?.[1]).toBe(submitted.find(args => args[0] === "tools/call")?.[1]);
    expect(forwarded.find(args => args[0] === "tools/list")?.[1]).not.toBe(submitted.find(args => args[0] === "tools/list")?.[1]);
    protocol.setRequestHandler = originalRegistration;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "catalog-sdk-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
    connections.push({ client, server });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["session_search"]);
    expect(await client.callTool({ name: "session_search_local", arguments: { query: "allowed" } })).toMatchObject({ content: [{ type: "text", text: "allowed" }] });
    expect(await client.callTool({ name: "list_active_sessions_local", arguments: {} })).toMatchObject({ content: [{ type: "text", text: "current-inventory" }] });
    expect(search).toHaveBeenCalledTimes(1);
    expect(await client.callTool({ name: "session_search_local", arguments: { query: "" } })).toMatchObject({ isError: true });
    expect(await client.callTool({ name: "list_active_sessions_local", arguments: { unexpected: true } })).toMatchObject({ isError: true });
    expect(search).toHaveBeenCalledTimes(1);
    expect(active).toHaveBeenCalledTimes(1);
    const denied = await client.callTool({ name: "session_search_local", arguments: { query: "denied" } });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toContain("fixture_access_denied");
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("replaces a duplicate public tools/list handler without replacing SDK tools/call", async () => {
    const server = new McpServer({ name: "sdk-duplicate-dispatch", version: "1" });
    const called = vi.fn(async () => ({ content: [{ type: "text" as const, text: "native-dispatch" }] }));
    server.registerTool("session_search_local", { inputSchema: z.object({}).strict() }, called);
    const first = vi.fn(() => ({ tools: [{ name: "first", inputSchema: { type: "object" as const } }] }));
    const second = vi.fn(() => ({ tools: [] }));
    server.server.setRequestHandler("tools/list", first);
    server.server.setRequestHandler("tools/list", second);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "duplicate-dispatch-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
    connections.push({ client, server });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect((await client.listTools()).tools).toEqual([]);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(await client.callTool({ name: "session_search_local", arguments: {} })).toMatchObject({ content: [{ type: "text", text: "native-dispatch" }] });
    expect(called).toHaveBeenCalledTimes(1);
  });

  it("confirms enabled:false and remove both hide and reject calls on the installed SDK", async () => {
    const server = new McpServer({ name: "sdk-disabled-tool", version: "1" });
    const called = vi.fn(async () => ({ content: [{ type: "text" as const, text: "enabled" }] }));
    const tool = server.registerTool("session_search_local", { inputSchema: z.object({}).strict() }, called);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "disabled-tool-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
    connections.push({ client, server });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.callTool({ name: "session_search_local", arguments: {} });
    tool.update({ enabled: false });
    expect((await client.listTools()).tools).toEqual([]);
    await expect(client.callTool({ name: "session_search_local", arguments: {} })).rejects.toThrow(/disabled/);
    expect(called).toHaveBeenCalledTimes(1);
    tool.enable();
    await client.callTool({ name: "session_search_local", arguments: {} });
    tool.remove();
    expect((await client.listTools()).tools).toEqual([]);
    await expect(client.callTool({ name: "session_search_local", arguments: {} })).rejects.toThrow(/not found/);
    expect(called).toHaveBeenCalledTimes(2);
  });

  it("restores the public registration method when registration fails", () => {
    const server = new McpServer({ name: "registration-failure", version: "1" });
    const original = server.server.setRequestHandler;
    expect(() => withCatalogProjection(server, () => { throw new Error("registration failed"); })).toThrow("registration failed");
    expect(server.server.setRequestHandler).toBe(original);
  });
});
