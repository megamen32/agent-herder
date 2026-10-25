import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { UserMessageDelivery } from "../src/user-message-delivery.js";
import { registerHarnessMeshTools } from "../src/mesh/register-tools.js";
import { createWebServer } from "../src/web/server.js";
import { trustedMeshIngressForOwnerStdio, trustedMeshIngressFromMcpAuthInfo } from "../src/mesh/authenticated-ingress.js";
import type { HarnessAdapter } from "../src/types/index.js";

let root: string | undefined;
let cleanup: Array<() => Promise<void>> = [];
const webServers: Array<ReturnType<typeof createWebServer>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
  for (const server of webServers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("owner stdio mesh ingress", () => {
  it("admits an OpenCode mesh delivery through the real MCP tool transport", async () => {
    root = await mkdtemp(join(tmpdir(), "herder-stdio-mesh-ingress-"));
    const session = {
      id: "opencode-fixture", harness: "opencode", hostId: "host-100", status: "idle",
      title: "fixture", cwd: "/tmp/herder-mesh-fixture", lastActivity: new Date().toISOString(), needsPermission: false,
    };
    const sendMessage = vi.fn(async (_id: string, options: any) => ({
      ok: true, admitted: true, inputId: options.inputId, turnId: "fixture-turn",
    }));
    const adapter = {
      type: "opencode", async getSession(id: string) { return id === session.id ? session : null; },
      async sendMessage(id: string, options: any) { return sendMessage(id, options); },
      async sendActiveMessage(id: string, options: any) { return sendMessage(id, options); },
      isReady: () => true,
    } as unknown as HarnessAdapter;
    const events = new HerderEventBus();
    const jobs = new HerderJobRegistry(events, { persistencePath: join(root, "jobs.json") });
    const delivery = new UserMessageDelivery(new Map([["opencode", adapter]]), {
      sendMessage: async (_harness, id, options) => adapter.sendMessage(id, options),
    }, jobs, { pollMs: 1, maxWaitMs: 2_000, maxPending: 4 });
    const server = new McpServer({ name: "stdio-mesh-ingress-test", version: "1" });
    registerHarnessMeshTools(server, {
      hostId: "host-100", adapters: new Map([["opencode", adapter]]),
      ledgerPath: join(root, "mesh-ledger.json"), userMessageDelivery: delivery,
      trustedIngress: trustedMeshIngressForOwnerStdio(),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "stdio-mesh-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanup.push(async () => { delivery.close(); await client.close(); await server.close(); });

    const result = await client.callTool({ name: "mesh_deliver", arguments: {
      target: { hostId: "host-100", harness: "opencode", nativeSessionId: session.id },
      sender: { hostId: "host-100", harness: "opencode", nativeSessionId: "sender-fixture" },
      inputId: "stdio-opencode-mesh-1", message: "bounded fixture delta",
    } });
    const receipt = JSON.parse(result.content[0]?.text ?? "{}");
    expect(["queued", "admitted"]).toContain(receipt.state);
    expect(receipt.inputId).toBe("stdio-opencode-mesh-1");
    await vi.waitFor(() => expect(jobs.list(10).find((job) => job.ownerSessionId === session.id)?.state).toBe("completed"));
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[1]?.durableUserDelivery?.actor).toMatchObject({
      kind: "agent", principal: "agent-herder-owner-mcp", senderVerified: false,
      senderAssertion: { hostId: "host-100", harness: "opencode", nativeSessionId: "sender-fixture" },
    });
    expect(jobs.list(10)).toHaveLength(1);
  });

  it("accepts an OpenCode mesh delivery only after the owner HTTP route validates its bearer", async () => {
    root = await mkdtemp(join(tmpdir(), "herder-http-mesh-ingress-"));
    const session = {
      id: "http-opencode-fixture", harness: "opencode", hostId: "host-100", status: "idle",
      title: "fixture", cwd: "/tmp/herder-mesh-fixture", lastActivity: new Date().toISOString(), needsPermission: false,
    };
    const sendMessage = vi.fn(async (_id: string, options: any) => ({ ok: true, admitted: true, inputId: options.inputId, turnId: "http-fixture-turn" }));
    const adapter = {
      type: "opencode", async getSession(id: string) { return id === session.id ? session : null; },
      async sendMessage(id: string, options: any) { return sendMessage(id, options); },
      async sendActiveMessage(id: string, options: any) { return sendMessage(id, options); },
      isReady: () => true,
    } as unknown as HarnessAdapter;
    const events = new HerderEventBus();
    const jobs = new HerderJobRegistry(events, { persistencePath: join(root, "jobs.json") });
    const delivery = new UserMessageDelivery(new Map([["opencode", adapter]]), {
      sendMessage: async (_harness, id, options) => adapter.sendMessage(id, options),
    }, jobs, { pollMs: 1, maxWaitMs: 2_000, maxPending: 4 });
    const server = createWebServer({
      adapters: new Map([["opencode", adapter]]), converter: {} as never, sessionObservationManagedExternally: true,
      mcpAuthToken: "owner-mcp-fixture-token",
      mcpServerFactory: (context) => {
        const mcp = new McpServer({ name: "http-mesh-ingress-test", version: "1" });
        registerHarnessMeshTools(mcp, {
          hostId: "host-100", adapters: new Map([["opencode", adapter]]),
          ledgerPath: join(root!, "http-mesh-ledger.json"), userMessageDelivery: delivery,
          trustedIngress: trustedMeshIngressFromMcpAuthInfo(context?.authInfo),
        });
        return mcp;
      },
    });
    webServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
    const client = new Client({ name: "authenticated-mesh-client", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(origin), { authProvider: { token: async () => "owner-mcp-fixture-token" } });
    await client.connect(transport);
    cleanup.push(async () => { delivery.close(); await client.close(); });
    const response = await client.callTool({ name: "mesh_deliver", arguments: {
      target: { hostId: "host-100", harness: "opencode", nativeSessionId: session.id },
      sender: { hostId: "asserted-source", harness: "opencode", nativeSessionId: "asserted-session" },
      inputId: "http-opencode-mesh-1", message: "bounded fixture delta",
    } });
    const receipt = JSON.parse(response.content[0]?.text ?? "{}");
    expect(["queued", "admitted"]).toContain(receipt.state);
    expect(receipt.inputId).toBe("http-opencode-mesh-1");
    await vi.waitFor(() => expect(jobs.list(10).find((job) => job.ownerSessionId === session.id)?.state).toBe("completed"));
    expect(sendMessage).toHaveBeenCalledOnce();

    const deniedClient = new Client({ name: "unauthenticated-mesh-client", version: "1" });
    const deniedTransport = new StreamableHTTPClientTransport(new URL(origin));
    await expect(deniedClient.connect(deniedTransport)).rejects.toThrow();
    await deniedClient.close().catch(() => undefined);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(jobs.list(10)).toHaveLength(1);
  });

  it("derives the owner capability for the documented no-token loopback MCP endpoint", async () => {
    root = await mkdtemp(join(tmpdir(), "herder-loopback-mesh-ingress-"));
    const session = {
      id: "loopback-opencode-fixture", harness: "opencode", hostId: "host-100", status: "idle",
      title: "fixture", cwd: "/tmp/herder-mesh-fixture", lastActivity: new Date().toISOString(), needsPermission: false,
    };
    const sendMessage = vi.fn(async (_id: string, options: any) => ({ ok: true, admitted: true, inputId: options.inputId, turnId: "loopback-fixture-turn" }));
    const adapter = {
      type: "opencode", async getSession(id: string) { return id === session.id ? session : null; },
      async sendMessage(id: string, options: any) { return sendMessage(id, options); },
      async sendActiveMessage(id: string, options: any) { return sendMessage(id, options); },
      isReady: () => true,
    } as unknown as HarnessAdapter;
    const events = new HerderEventBus();
    const jobs = new HerderJobRegistry(events, { persistencePath: join(root, "jobs.json") });
    const delivery = new UserMessageDelivery(new Map([["opencode", adapter]]), {
      sendMessage: async (_harness, id, options) => adapter.sendMessage(id, options),
    }, jobs, { pollMs: 1, maxWaitMs: 2_000, maxPending: 4 });
    const server = createWebServer({
      adapters: new Map([["opencode", adapter]]), converter: {} as never, sessionObservationManagedExternally: true,
      allowOwnerLoopbackMcp: true,
      // This matches the owner-local server-100 configuration: no second bearer
      // is configured, and the client targets 127.0.0.1:18787.
      mcpServerFactory: (context) => {
        const mcp = new McpServer({ name: "loopback-mesh-ingress-test", version: "1" });
        registerHarnessMeshTools(mcp, {
          hostId: "host-100", adapters: new Map([["opencode", adapter]]),
          ledgerPath: join(root!, "loopback-mesh-ledger.json"), userMessageDelivery: delivery,
          trustedIngress: trustedMeshIngressFromMcpAuthInfo(context?.authInfo),
        });
        return mcp;
      },
    });
    webServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
    const client = new Client({ name: "loopback-owner-mesh-client", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(origin)));
    cleanup.push(async () => { delivery.close(); await client.close(); });
    const response = await client.callTool({ name: "mesh_deliver", arguments: {
      target: { hostId: "host-100", harness: "opencode", nativeSessionId: session.id },
      sender: { hostId: "claimed-source", harness: "opencode", nativeSessionId: "claimed-session" },
      inputId: "loopback-opencode-mesh-1", message: "bounded fixture delta",
    } });
    const receipt = JSON.parse(response.content[0]?.text ?? "{}");
    expect(["queued", "admitted"]).toContain(receipt.state);
    expect(receipt.inputId).toBe("loopback-opencode-mesh-1");
    await vi.waitFor(() => expect(jobs.list(10).find((job) => job.ownerSessionId === session.id)?.state).toBe("completed"));
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[1]?.durableUserDelivery?.actor).toMatchObject({
      kind: "agent", senderVerified: false,
      senderAssertion: { hostId: "claimed-source", harness: "opencode", nativeSessionId: "claimed-session" },
    });
  });
});
