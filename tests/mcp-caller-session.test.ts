import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentHerderMcpServer } from "../src/index.js";
import { callerSessionFromMcpContext } from "../src/mcp/caller-session.js";
import type { ResumeAfterService } from "../src/resume-after.js";

const connected: Array<{ client: Client; server: { close(): Promise<void> } }> = [];
afterEach(async () => {
  await Promise.all(connected.splice(0).map(async ({ client, server }) => { await client.close(); await server.close(); }));
});

async function connectedClient(register: ReturnType<typeof vi.fn>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const service = { register } as unknown as ResumeAfterService;
  const server = createAgentHerderMcpServer(undefined, { resumeAfter: service });
  const client = new Client({ name: "caller-session-test", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connected.push({ client, server });
  return client;
}

const scheduled = {
  message: "resume once",
  requestId: "caller-session-test",
  trigger: { kind: "delay" as const, delayMs: 60_000 },
};
const acceptedWait = { id: "wait_test", state: "waiting" };

describe("native MCP caller session metadata", () => {
  it.each([
    [{ "ai.opencode/sessionID": " ses_native-a " }, { harness: "opencode", sessionId: "ses_native-a" }],
    [{ "com.zcode/request-context": { session_id: "zcode-native-a" } }, { harness: "zcode", sessionId: "zcode-native-a" }],
    [{ threadId: "codex-thread-only" }, { harness: "codex", sessionId: "codex-thread-only" }],
    [{ threadId: "codex-thread-a", sessionId: "codex-provider-session-a" }, { harness: "codex", sessionId: "codex-thread-a" }],
  ])("uses documented request metadata as the omitted resume owner", async (meta, expected) => {
    const register = vi.fn(async () => acceptedWait);
    const client = await connectedClient(register);
    const result = await client.callTool({ name: "resume_after", arguments: scheduled, _meta: meta });
    expect(result.isError).not.toBe(true);
    expect(register).toHaveBeenCalledOnce();
    expect(register.mock.calls[0]![0]).toMatchObject({ owner: expected });
  });

  it("preserves an explicit owner even when caller metadata names another session", async () => {
    const register = vi.fn(async () => acceptedWait);
    const client = await connectedClient(register);
    const result = await client.callTool({
      name: "resume_after",
      arguments: { ...scheduled, owner: { harness: "codex", sessionId: "explicit-b" } },
      _meta: { "ai.opencode/sessionID": "ses_native-a" },
    });
    expect(result.isError).not.toBe(true);
    expect(register.mock.calls[0]![0]).toMatchObject({ owner: { harness: "codex", sessionId: "explicit-b" } });
  });

  it.each([
    undefined,
    { "mcp-session-id": "transport-only" },
    { "ai.opencode/sessionID": "not-native" },
    { "ai.opencode/sessionID": "ses_" + "x".repeat(512) },
    { "com.zcode/request-context": { session_id: "   " } },
    { "ai.opencode/sessionID": "ses_a", "com.zcode/request-context": { session_id: "zcode-b" } },
  ])("fails closed before service registration for absent, malformed, or conflicting metadata: %s", async (meta) => {
    const register = vi.fn(async () => acceptedWait);
    const client = await connectedClient(register);
    const result = await client.callTool({ name: "resume_after", arguments: scheduled, ...(meta ? { _meta: meta } : {}) });
    expect(result.isError).toBe(true);
    expect(register).not.toHaveBeenCalled();
  });

  it("extracts only documented native metadata and rejects conflicting harness identities", () => {
    expect(callerSessionFromMcpContext({ mcpReq: { _meta: { "ai.opencode/sessionID": "ses_a" } } }))
      .toEqual({ harness: "opencode", sessionId: "ses_a" });
    expect(callerSessionFromMcpContext({ mcpReq: { sessionId: "ses_transport", _meta: { "mcp-session-id": "transport" } } })).toBeNull();
    expect(callerSessionFromMcpContext({ mcpReq: { _meta: { sessionId: "codex-provider-id-only" } } })).toBeNull();
    expect(callerSessionFromMcpContext({ mcpReq: { _meta: {
      "ai.opencode/sessionID": "ses_a", "com.zcode/request-context": { session_id: "zcode_b" },
    } } })).toBeNull();
  });
});
