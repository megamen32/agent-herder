import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSessionTools } from "../src/mcp/session-tools.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { agentInfoResult } from "../src/mcp-tools/handlers.js";
import { getHumanStopStore } from "../src/human-stop-store.js";

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

it("fills missing exact native activity through a bounded session read, not a full active sweep", async () => {
  const direct = { id: "native-active", harness: "codex", status: "idle", title: "test", cwd: "/tmp", hostId: "fixture", lastActivity: "2026-01-01", needsPermission: false, meta: { sourceRoute: "native" , humanStopHeld: false } };
  const getActiveSessionForInfo = vi.fn(async () => ({ ...direct, status: "running", meta: { activeTurnId: "turn-exact", nativeLastTurn: { turnId: "turn-exact", status: "inProgress" }, nativeThreadStatus: "active" } }));
  const listActiveSessions = vi.fn(async () => []);
  const adapter = { type: "codex", name: "fixture", getSession: async (id: string) => id === direct.id ? direct : null, getActiveSessionForInfo, listActiveSessions };
  const result = await agentInfoResult(new Map([["codex", adapter as any]]), { sessionId: direct.id, harness: "codex" });
  expect(result).toMatchObject({ status: "running", meta: {
    activeTurnId: "turn-exact", nativeLastTurn: { turnId: "turn-exact", status: "inProgress" },
    sourceRoute: "native", humanStopHeld: false,
  } });
  expect(getActiveSessionForInfo).toHaveBeenCalledTimes(1);
  expect(listActiveSessions).not.toHaveBeenCalled();
});

it.each([
  ["stopped", { status: "stopped", needsPermission: false, meta: {} }],
  ["approval", { status: "idle", needsPermission: true, meta: {} }],
  ["metadata hold", { status: "idle", needsPermission: false, meta: { humanStopHeld: true } }],
] as const)("does not replace a direct %s session projection", async (_name, state) => {
  const direct = { id: "protected-direct", harness: "codex", title: "test", cwd: "/tmp", hostId: "fixture", lastActivity: "2026-01-01", ...state };
  const getActiveSessionForInfo = vi.fn(async () => ({ ...direct, status: "running", needsPermission: false, meta: { activeTurnId: "turn-other", nativeLastTurn: { turnId: "turn-other", status: "inProgress" } } }));
  const listActiveSessions = vi.fn(async () => [{ ...direct, status: "running", needsPermission: false, meta: { activeTurnId: "turn-other", nativeLastTurn: { turnId: "turn-other", status: "inProgress" } } }]);
  const adapter = { type: "codex", name: "fixture", getSession: async () => direct, getActiveSessionForInfo, listActiveSessions };
  const result = await agentInfoResult(new Map([["codex", adapter as any]]), { sessionId: direct.id, harness: "codex" });
  expect(result?.status).toBe(state.status);
  expect(result?.needsPermission).toBe(state.needsPermission);
  expect(getActiveSessionForInfo).not.toHaveBeenCalled();
  expect(listActiveSessions).not.toHaveBeenCalled();
});

it("respects a durable HumanStop hold even when the direct session metadata omits it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-info-human-stop-"));
  const previous = process.env.AGENT_HERDER_HUMAN_STOP_STORE;
  process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(directory, "human-stops.json");
  try {
    await getHumanStopStore().hold({ harness: "codex", id: "held-direct" }, { id: "stop-1", at: new Date().toISOString(), reason: "explicit stop" });
    const direct = { id: "held-direct", harness: "codex", status: "idle", title: "test", cwd: "/tmp", hostId: "fixture", lastActivity: "2026-01-01", needsPermission: false, meta: {} };
    const getActiveSessionForInfo = vi.fn(async () => ({ ...direct, status: "running", meta: { activeTurnId: "turn-held", nativeLastTurn: { turnId: "turn-held", status: "inProgress" } } }));
    const listActiveSessions = vi.fn(async () => [{ ...direct, status: "running", meta: { activeTurnId: "turn-held", nativeLastTurn: { turnId: "turn-held", status: "inProgress" } } }]);
    const adapter = { type: "codex", name: "fixture", getSession: async () => direct, getActiveSessionForInfo, listActiveSessions };
    const result = await agentInfoResult(new Map([["codex", adapter as any]]), { sessionId: direct.id, harness: "codex" });
    expect(result?.status).toBe("idle");
    expect(result?.meta?.humanStopHeld).toBe(true);
    expect(getActiveSessionForInfo).not.toHaveBeenCalled();
    expect(listActiveSessions).not.toHaveBeenCalled();
  } finally {
    if (previous === undefined) delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    else process.env.AGENT_HERDER_HUMAN_STOP_STORE = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

it("recovers the latest human-readable messages when the recent window contains only tool activity", async () => {
  const session = { id: "s2", harness: "codex", status: "running", title: "test", cwd: "/tmp", hostId: "fixture", lastActivity: "2026-01-01", needsPermission: false };
  const lines = [
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "actual request" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "actual answer" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<codex_internal_context source=\"goal\">not a human request</codex_internal_context>" }] } },
  ];
  const adapter = { type: "codex", name: "fixture", getSession: async (id: string) => id === "s2" ? session : null,
    getSessionMessages: async () => [
      { id: "old-user", role: "user", text: "old request", parts: [] },
      { id: "old-answer", role: "assistant", text: "old answer", parts: [] },
      { id: "tool", role: "assistant", parts: [{ type: "tool_call", name: "shell" }] },
    ],
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
