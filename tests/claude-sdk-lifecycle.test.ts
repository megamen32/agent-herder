import { expect, it } from "vitest";
import { CreateSessionSchema } from "../src/mcp-tools/definitions.js";

it("accepts Claude creation settings through the MCP schema", () => {
  const request = { harness: "claude", name: "build", cwd: "/tmp", effort: "medium", thinkingBudget: 4096, permissionMode: "plan" };
  expect(CreateSessionSchema.parse(request)).toMatchObject(request);
});

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { getSessionInfo, getSessionMessages, listSessions, query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSDKAdapter } from "../src/adapters/claude-sdk.js";
import { registerSessionTools } from "../src/mcp/session-tools.js";
import { withToolConsolidation } from "../src/mcp/tool-consolidation.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(), listSessions: vi.fn(), getSessionInfo: vi.fn(), getSessionMessages: vi.fn(),
}));

it("rejects settings for the other harness before opening either native adapter", async () => {
  const { CodexAppServerAdapter } = await import("../src/adapters/codex-app-server.js");
  const options = { name: "build", cwd: "/tmp" };
  const codex = new CodexAppServerAdapter();
  vi.spyOn(codex as unknown as { ensureReady(): Promise<void> }, "ensureReady").mockRejectedValue(new Error("transport opened"));
  await expect(codex.createSession({ ...options, effort: "max" })).rejects.toThrow(/effort.*Claude/i);
  const claude = new ClaudeSDKAdapter();
  await expect(claude.createSession({ ...options, reasoningEffort: "high" })).rejects.toThrow(/reasoningEffort.*Codex/i);
  await expect(claude.createSession({ ...options, serviceTier: "fast" })).rejects.toThrow(/serviceTier.*Codex/i);
  const { ClaudeCodeAdapter } = await import("../src/adapters/claude.js");
  await expect(new ClaudeCodeAdapter().createSession({ ...options, serviceTier: "fast" })).rejects.toThrow(/serviceTier.*Codex/i);
  expect(query).not.toHaveBeenCalled();
});

it("controls one Claude session over MCP and answers an exact permission without reading history", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "herder-stream-test-"));
  const name = "Build";
  let id = "";
  const info = () => ({ sessionId: id, cwd, customTitle: name, summary: "long noisy prompt", lastModified: Date.now() });
  vi.mocked(listSessions).mockImplementation(async () => id ? [info()] : []);
  vi.mocked(getSessionInfo).mockImplementation(async key => key === id ? info() : undefined);
  vi.mocked(getSessionMessages).mockResolvedValue([]);
  const inputs: SDKUserMessage[] = [];
  let output: PassThrough;
  vi.mocked(query).mockImplementation(({ prompt, options }) => {
    id = options!.sessionId || options!.resume!;
    output = new PassThrough({ objectMode: true });
    const input = prompt as PassThrough;
    input.on("data", (frame: SDKUserMessage) => {
      inputs.push(frame);
      output.write({ type: "system", subtype: "init", session_id: id, model: "resolved-model", permissionMode: "plan" });
      output.write({ ...frame, isReplay: true });
    });
    return Object.assign(output, { initializationResult: async () => ({}), close: () => output.end() }) as unknown as Query;
  });
  const adapter = new ClaudeSDKAdapter();
  const events = new HerderEventBus();
  const server = new McpServer({ name: "test-herder", version: "1" });
  withToolConsolidation(server, () => registerSessionTools(server, {
    adapters: new Map([["claude", adapter]]), jobs: new HerderJobRegistry(events), events,
  }), new Set());
  const client = new Client({ name: "orchestrator", version: "1" }, { versionNegotiation: { mode: "auto" } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  const call = (tool: string, args: Record<string, unknown>) => client.callTool({ name: tool, arguments: args });
  try {
    const request = { variant: "native", harness: "claude", cwd, name, model: "sonnet", effort: "medium", permissionMode: "plan", thinkingBudget: 4096 };
    const created = await call("create_session", request);
    expect(JSON.stringify(created.content)).toContain('ready');
    const replay = await call("create_session", request);
    expect(JSON.parse((replay.content as {text:string}[])[0].text)).toMatchObject({ created: false, sessionId: id });
    expect(inputs).toHaveLength(1);
    expect(inputs[0].shouldQuery).toBe(false);
    const target = { harness: "claude", sessionId: id };
    expect(await adapter.sendActiveMessage(id, { message: "too early" })).toMatchObject({ notSubmitted: true });
    const started = await call("deliver", { ...target, activation: "always", message: "Build", mode: "queue" });
    expect(JSON.stringify(started.content)).toContain("accepted");
    const steer = await call("deliver", { ...target, message: "Check types" });
    expect(JSON.stringify(steer.content)).toContain("accepted");
    expect(inputs.at(-1)?.priority).toBe("now");
    const opts = vi.mocked(query).mock.calls[0][0].options!;
    expect(opts).toMatchObject({ effort: "medium", thinking: { type: "enabled", budgetTokens: 4096 }, permissionMode: "plan" });
    output!.write({ type: "assistant", session_id: id, message: { content: [
      { type: "text", text: "Working\nChecking types" }, { type: "tool_use", name: "Read" },
    ] } });
    const decision = opts.canUseTool!("Read", { file_path: "index.ts" }, {
      signal: new AbortController().signal, toolUseID: "read-1", requestId: "approval-1", title: "Read index.ts",
    });
    vi.mocked(getSessionMessages).mockClear();
    const detail = await call("session_info", { ...target, view: "compact" });
    expect(detail.structuredContent).toMatchObject({ session: {
      status: "needs_input", title: name, permissionDetails: { id: "approval-1" },
      meta: { progress: { lastAssistantLine: "Checking types", lastTool: "Read" } },
    } });
    expect(getSessionMessages).not.toHaveBeenCalled();
    expect(await adapter.respondPermission("another-session", "approval-1", "allow")).toMatchObject({ ok: false });
    await call("respond_permission", { ...target, permissionId: "approval-1", response: "allow" });
    expect(await decision).toMatchObject({ behavior: "allow" });
    expect(query).toHaveBeenCalledTimes(1);
    await adapter.stopSession(id);
    await adapter.resumeSession(id);
    expect(vi.mocked(query).mock.lastCall?.[0].options).toMatchObject({ resume: id, effort: "medium", permissionMode: "plan" });
  } finally { await adapter.stopSession(id); await client.close(); await server.close(); }
});
