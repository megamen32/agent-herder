import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentHerderMcpServer } from "../src/index.js";
import { WakeBindingStore } from "../src/chatgpt-wake-binding.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

const connected: Array<{ client: Client; server: { close(): Promise<void> } }> = [];
afterEach(async () => {
  await Promise.all(connected.splice(0).map(async ({ client, server }) => { await client.close(); await server.close(); }));
});

const owned: AgentSession = {
  id: "ses_binding_owner", harness: "opencode", hostId: "host-a", title: "owner", cwd: "/tmp/wake", status: "idle",
  lastActivity: new Date().toISOString(), needsPermission: false,
};

function adapter(): HarnessAdapter {
  return {
    type: "opencode", name: "wake fixture", init: async () => {},
    listSessions: async () => [owned],
    getSession: async (id: string) => id === owned.id ? owned : null,
  } as unknown as HarnessAdapter;
}

async function connectedClient(jobs: HerderJobRegistry = new HerderJobRegistry()) {
  const dir = await mkdtemp(join(tmpdir(), "wake-mcp-"));
  const bindings = new WakeBindingStore({ filePath: join(dir, "b.json") });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createAgentHerderMcpServer(undefined, {
    chatgptWakeBindings: bindings,
    chatgptWakeAdapters: new Map([["opencode", adapter()]]),
    jobs,
  });
  const client = new Client({ name: "wake-test", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connected.push({ client, server });
  return client;
}

describe("chatgpt wake binding MCP behavior", () => {
  it("session_identity without native metadata stays fail-closed for a ChatGPT caller", async () => {
    const client = await connectedClient();
    const missing = await client.callTool({ name: "session_identity", arguments: {} });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("caller_session_unavailable") });
  });

  it("refuses to register a binding whose owner session does not exist", async () => {
    const client = await connectedClient();
    const register = await client.callTool({ name: "chatgpt_wake_binding_register", arguments: {
      bindingId: "wb-mcp", secret: "s".repeat(20),
      owner: { harness: "opencode", sessionId: "ses_does_not_exist" },
    } });
    expect(register.isError).toBe(true);
    expect(register.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("owner_unverified") });
  });

  it("refuses an unknown harness instead of guessing an owner", async () => {
    const client = await connectedClient();
    const register = await client.callTool({ name: "chatgpt_wake_binding_register", arguments: {
      bindingId: "wb-mcp", secret: "s".repeat(20),
      owner: { harness: "codex", sessionId: "ses_does_not_exist" },
    } });
    expect(register.isError).toBe(true);
    expect(register.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("owner_unknown_harness") });
  });

  it("registers a validated owner and returns exactly that owner on verification", async () => {
    const client = await connectedClient();
    const register = await client.callTool({ name: "chatgpt_wake_binding_register", arguments: {
      bindingId: "wb-mcp", secret: "s".repeat(20),
      owner: { harness: "opencode", sessionId: owned.id },
    } });
    expect(register.isError).not.toBe(true);
    const verified = await client.callTool({ name: "chatgpt_wake_binding_verify", arguments: {
      bindingId: "wb-mcp", secret: "s".repeat(20),
    } });
    expect(verified.isError).not.toBe(true);
    expect((verified.structuredContent as { owner: { harness: string; sessionId: string } }).owner)
      .toEqual({ harness: "opencode", sessionId: owned.id });
  });

  it("fails closed on a wrong secret and never echoes the secret back", async () => {
    const client = await connectedClient();
    await client.callTool({ name: "chatgpt_wake_binding_register", arguments: {
      bindingId: "wb-mcp", secret: "s".repeat(20),
      owner: { harness: "opencode", sessionId: owned.id },
    } });
    const wrong = await client.callTool({ name: "chatgpt_wake_binding_verify", arguments: {
      bindingId: "wb-mcp", secret: "x".repeat(20),
    } });
    expect(wrong.isError).toBe(true);
    expect(wrong.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("chatgpt_wake_binding_unverified") });
    expect(JSON.stringify(wrong)).not.toContain("s".repeat(20));
  });

  it("does not let one binding resolve to another owner (cross-chat substitution)", async () => {
    const client = await connectedClient();
    await client.callTool({ name: "chatgpt_wake_binding_register", arguments: {
      bindingId: "wb-mcp", secret: "s".repeat(20),
      owner: { harness: "opencode", sessionId: owned.id },
    } });
    const other = await client.callTool({ name: "chatgpt_wake_binding_verify", arguments: {
      bindingId: "wb-other", secret: "s".repeat(20),
    } });
    expect(other.isError).toBe(true);
    expect(other.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("chatgpt_wake_binding_unverified") });
  });

  it("delivers the terminal job result exactly once through chatgpt_wake_await", async () => {
    const jobs = new HerderJobRegistry();
    const client = await connectedClient(jobs);
    await client.callTool({ name: "chatgpt_wake_binding_register", arguments: {
      bindingId: "wb-mcp", secret: "s".repeat(20),
      owner: { harness: "opencode", sessionId: owned.id },
    } });
    const job = jobs.start({
      kind: "wake-fixture",
      run: async () => ({ answer: 42 }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const delivered = await client.callTool({ name: "chatgpt_wake_await", arguments: {
      bindingId: "wb-mcp", secret: "s".repeat(20), jobId: job.id, timeoutMs: 5_000,
    } });
    expect(delivered.isError).not.toBe(true);
    const payload = delivered.structuredContent as { owner: { sessionId: string }; job: { state: string; result: { answer: number } } };
    expect(payload.owner.sessionId).toBe(owned.id);
    expect(payload.job.state).toBe("completed");
    expect(payload.job.result).toEqual({ answer: 42 });
    const second = await client.callTool({ name: "chatgpt_wake_await", arguments: {
      bindingId: "wb-mcp", secret: "s".repeat(20), jobId: job.id, timeoutMs: 5_000,
    } });
    expect(second.isError).toBe(true);
    expect(second.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("already_done") });
  });
});
