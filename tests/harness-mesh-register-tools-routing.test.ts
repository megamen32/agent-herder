import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHarnessMeshTools } from "../src/mesh/register-tools.js";

const cleanups: Array<() => Promise<void>> = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function registeredMesh(options: { transport?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "herder-mesh-routing-hint-"));
  roots.push(root);
  const getSession = vi.fn(async () => null);
  const sendMessage = vi.fn(async () => ({ ok: true }));
  const server = new McpServer({ name: "mesh-routing-hint-fixture", version: "1" });
  registerHarnessMeshTools(server, {
    hostId: "roomhacker-server-100",
    adapters: new Map([["codex", { type: "codex", getSession, sendMessage, isReady: () => true } as any]]),
    ledgerPath: join(root, "ledger.json"),
    ...(options.transport ? { gptadmin: {} as any } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mesh-routing-hint-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => { await client.close(); await server.close(); });
  return { client, getSession, sendMessage };
}

const request = (hostId: string) => ({
  target: { hostId, harness: "codex", nativeSessionId: "native-session" },
  sender: { hostId: "roomhacker-server-100", harness: "opencode", nativeSessionId: "sender-session" },
  inputId: "routing-hint-test", message: "read-only route fixture",
});

it("returns the mesh_route hint for remote targets without calling native adapters", async () => {
  const { client, getSession, sendMessage } = await registeredMesh({ transport: true });
  const tools = await client.listTools();
  const descriptions = Object.fromEntries(tools.tools.map((tool) => [tool.name, tool.description || ""]));
  expect(descriptions.mesh_deliver).toContain("on this host only");
  expect(descriptions.mesh_deliver).toContain("mesh_route");
  expect(descriptions.mesh_route).toContain("remote host");
  const result = await client.callTool({ name: "mesh_deliver", arguments: request("MacBook-Pro-User.local") });
  const receipt = JSON.parse(result.content[0]?.text ?? "{}");
  expect(receipt).toMatchObject({
    state: "not_attempted", retryable: true, reason: "remote_target_requires_mesh_route",
    suggestedTool: "mesh_route", requestedHost: "MacBook-Pro-User.local", localHost: "roomhacker-server-100",
  });
  expect(getSession).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
});

it("does not suggest an unavailable remote transport", async () => {
  const { client, getSession, sendMessage } = await registeredMesh();
  const result = await client.callTool({ name: "mesh_deliver", arguments: request("MacBook-Pro-User.local") });
  const receipt = JSON.parse(result.content[0]?.text ?? "{}");
  expect(receipt).toMatchObject({
    state: "not_attempted", retryable: false, reason: "remote_mesh_transport_unavailable",
    requestedHost: "MacBook-Pro-User.local", localHost: "roomhacker-server-100",
  });
  expect(receipt.suggestedTool).toBeUndefined();
  expect(getSession).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
});

it("keeps the local target's authenticated ingress guard", async () => {
  const { client, getSession, sendMessage } = await registeredMesh();
  const result = await client.callTool({ name: "mesh_deliver", arguments: request("roomhacker-server-100") });
  const receipt = JSON.parse(result.content[0]?.text ?? "{}");
  expect(receipt).toMatchObject({
    state: "not_attempted", retryable: false, reason: "authenticated_mesh_ingress_required",
  });
  expect(getSession).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
});
