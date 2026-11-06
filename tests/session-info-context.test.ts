import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { expect, it, vi } from "vitest";
import { registerSessionTools } from "../src/mcp/session-tools.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";

it("returns the latest user and assistant by default and skips history in compact mode", async () => {
  const session = { id: "s1", harness: "codex", status: "idle", title: "test", cwd: "/tmp", hostId: "fixture", lastActivity: "2026-01-01", needsPermission: false };
  const read = vi.fn(async () => [
    { id: "a1", role: "assistant", text: "previous answer", parts: [] },
    { id: "u1", role: "user", text: "latest request", parts: [] },
    { id: "t1", role: "tool", text: "tool output", parts: [] },
  ]);
  const adapter = { type: "codex", name: "fixture", getSession: async (id: string) => id === "s1" ? session : null, getSessionMessages: read };
  const events = new HerderEventBus();
  const server = new McpServer({ name: "session-context", version: "1" });
  registerSessionTools(server, { adapters: new Map([["codex", adapter as any]]), jobs: new HerderJobRegistry(events), events });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(st); await client.connect(ct);
  try {
    const recent = await client.callTool({ name: "agent_info", arguments: { sessionId: "s1", harness: "codex" } });
    expect(JSON.stringify(recent.structuredContent)).toContain("latest request");
    expect(JSON.stringify(recent.structuredContent)).toContain("previous answer");
    const prefixed = await client.callTool({ name: "agent_info", arguments: { sessionId: "codex s1" } });
    expect(JSON.stringify(prefixed.structuredContent)).toContain("latest request");
    await client.callTool({ name: "agent_info", arguments: { sessionId: "s1", harness: "codex", view: "compact" } });
    expect(read).toHaveBeenCalledTimes(2);
    const detail = await client.callTool({ name: "agent_info", arguments: { sessionId: "s1", harness: "codex", view: "messages", limit: 20 } });
    expect(JSON.stringify(detail.structuredContent)).toContain("tool output");
  } finally { await client.close(); await server.close(); }
});

it("recovers the latest human-readable messages when the recent window contains only tool activity", async () => {
  const session = { id: "s2", harness: "codex", status: "running", title: "test", cwd: "/tmp", hostId: "fixture", lastActivity: "2026-01-01", needsPermission: false };
  const lines = [
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "actual request" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "actual answer" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<codex_internal_context source=\"goal\">not a human request</codex_internal_context>" }] } },
  ];
  const adapter = { type: "codex", name: "fixture", getSession: async (id: string) => id === "s2" ? session : null,
    getSessionMessages: async () => [{ id: "tool", role: "assistant", parts: [{ type: "tool_call", name: "shell" }] }],
    getRawTranscript: async () => ({ bytes: Buffer.from(lines.map(x => JSON.stringify(x)).join("\n")), complete: true, source: { kind: "native-file", format: "jsonl" }, timestampCoverage: "native" }) };
  const events = new HerderEventBus(); const server = new McpServer({ name: "tail-test", version: "1" });
  registerSessionTools(server, { adapters: new Map([["codex", adapter as any]]), jobs: new HerderJobRegistry(events), events });
  const [ct, st] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: "test", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(st); await client.connect(ct);
  try {
    const result = await client.callTool({ name: "agent_info", arguments: { sessionId: "s2", harness: "codex" } });
    expect(JSON.stringify(result.structuredContent)).toContain("actual request");
    expect(JSON.stringify(result.structuredContent)).toContain("actual answer");
    expect((result.structuredContent as any).conversation.latestUser.text).toBe("actual request");
    expect((result.structuredContent as any).conversation.latestAssistant.text).toBe("actual answer");
  } finally { await client.close(); await server.close(); }
});
