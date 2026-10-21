import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSessionTools } from "../src/mcp/session-tools.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { HumanStopStore } from "../src/human-stop-store.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

const closers: Array<() => Promise<void>> = [];
const roots: string[] = [];
let previousStopPath: string | undefined;
let stopPathWasChanged = false;
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (stopPathWasChanged) {
    if (previousStopPath === undefined) delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    else process.env.AGENT_HERDER_HUMAN_STOP_STORE = previousStopPath;
    previousStopPath = undefined;
    stopPathWasChanged = false;
  }
});

function fixtureSession(id = "sess-1"): AgentSession {
  return {
    id, harness: "opencode", status: "idle", title: `Session ${id}`, cwd: "/repo",
    lastActivity: "2026-09-06T02:00:00.000Z", model: "gpt-test", needsPermission: false,
    messageCount: 3, lastMessage: "done",
  };
}

async function connect(): Promise<Client> {
  const session = fixtureSession();
  const child = fixtureSession("child-1");
  const parent = fixtureSession("parent-1");
  const adapter: HarnessAdapter = {
    type: "opencode", name: "OpenCode Fixture",
    async init() {}, async listSessions() { return [session]; }, async getSession(id) { return id === session.id ? session : null; },
    async getParent() { return parent; }, async listChildren() { return [child]; }, async listModels() { return ["gpt-test", "gpt-alt"]; },
    async sendMessage() { return { ok: true }; }, async stopSession() { return { ok: true }; }, async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
  };
  const events = new HerderEventBus();
  const server = new McpServer({ name: "session-dto-test", version: "1" });
  registerSessionTools(server, { adapters: new Map([["opencode", adapter]]), jobs: new HerderJobRegistry(events), events });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "session-dto-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

async function connectHumanStopConsumer(session: AgentSession) {
  const createSession = vi.fn(async (options: { name: string; cwd: string; model?: string }) => ({
    ...session, id: `created-${options.name}`, title: options.name, cwd: options.cwd, model: options.model,
  }));
  const resumeSession = vi.fn(async () => ({ ok: true }));
  const adapter: HarnessAdapter = {
    type: "zcode", name: "ZCode human-stop fixture", async init() {},
    async listSessions() { return [session]; },
    async getSession(id) { return id === session.id ? session : null; },
    createSession, resumeSession,
    async sendMessage() { return { ok: true }; },
    async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; },
    async setPermissions() { return { ok: true }; },
  };
  const events = new HerderEventBus();
  const server = new McpServer({ name: "session-public-schema-test", version: "1" });
  registerSessionTools(server, { adapters: new Map([["zcode", adapter]]), jobs: new HerderJobRegistry(events), events });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "session-public-schema-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => { await client.close(); await server.close(); });
  return { client, createSession, resumeSession };
}

describe("session tool DTOs", () => {
  it("routes exact scoped session sends through a per-call adapter and denies unresolved scope without ordinary fallback", async () => {
    const session = { ...fixtureSession("scoped-1"), harness: "codex" as const, status: "running" as const, cwd: process.cwd() };
    const ordinarySend = vi.fn(async () => ({ ok: true }));
    const scopedSend = vi.fn(async () => ({ ok: true, admitted: true, inputId: "delivery-1" }));
    const ordinaryResume = vi.fn(async () => ({ ok: true }));
    const scopedResume = vi.fn(async () => ({ ok: true }));
    const ordinaryGet = vi.fn(async (id: string) => id === session.id ? session : null);
    const scopedGet = vi.fn(async (id: string) => id === session.id ? session : null);
    const ordinaryRaw = vi.fn(async () => null);
    const scopedRaw = vi.fn(async () => null);
    const adapter = (sendMessage: typeof ordinarySend, resumeSession: typeof ordinaryResume): HarnessAdapter => ({
      type: "codex", name: "Codex fixture", async init() {}, async listSessions() { return [session]; },
      getSession: sendMessage === ordinarySend ? ordinaryGet : scopedGet,
      getRawTranscript: sendMessage === ordinarySend ? ordinaryRaw : scopedRaw,
      sendMessage, resumeSession,
      async stopSession() { return { ok: true }; }, async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
    });
    const resolver = { adapterForSession: vi.fn(async () => ({ kind: "scoped" as const, adapter: adapter(scopedSend, scopedResume) })) };
    const events = new HerderEventBus();
    const server = new McpServer({ name: "session-scoped-routing-test", version: "1" });
    registerSessionTools(server, { adapters: new Map([["codex", adapter(ordinarySend, ordinaryResume)]]), jobs: new HerderJobRegistry(events), events, integratorRuntime: resolver as any });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "session-scoped-routing-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      await client.callTool({ name: "send_message", arguments: { sessionId: "scoped-1", message: "continue", humanRequested: true, inputId: "delivery-1" } });
      expect(resolver.adapterForSession).toHaveBeenCalledWith({ hostId: expect.any(String), harness: "codex", nativeSessionId: "scoped-1" });
      expect(scopedSend).toHaveBeenCalledOnce(); expect(ordinarySend).not.toHaveBeenCalled();
      await client.callTool({ name: "resume_agent", arguments: { sessionId: "scoped-1", humanRequested: true } });
      expect(scopedResume).toHaveBeenCalledOnce(); expect(ordinaryResume).not.toHaveBeenCalled();
      await client.callTool({ name: "deliver", arguments: { sessionId: "scoped-1", message: "observe existing task", activation: "if_running" } });
      expect(scopedGet).toHaveBeenCalled(); expect(ordinaryGet).not.toHaveBeenCalled(); expect(ordinarySend).not.toHaveBeenCalled();
      await client.callTool({ name: "export_transcript", arguments: { sessionId: "scoped-1" } });
      expect(scopedRaw).toHaveBeenCalledOnce(); expect(ordinaryRaw).not.toHaveBeenCalled();
      resolver.adapterForSession.mockResolvedValueOnce({ kind: "deny", reason: "binding_unresolved" });
      const denied = await client.callTool({ name: "stop_agent", arguments: { sessionId: "scoped-1" } });
      expect(denied.isError).toBe(true); expect(ordinarySend).not.toHaveBeenCalled();
    } finally { await client.close(); await server.close(); }
  });

  it("routes all session-affine MCP tools through the scoped adapter and preserves ordinary sessions", async () => {
    const scopedSession = { ...fixtureSession("scoped-affine"), harness: "codex" as const };
    const ordinarySession = { ...fixtureSession("ordinary-affine"), harness: "codex" as const };
    const child = { ...fixtureSession("scoped-child"), harness: "codex" as const };
    const makeAdapter = (session: AgentSession, children: AgentSession[]) => ({
      type: "codex" as const, name: `adapter-${session.id}`,
      init: vi.fn(async () => {}),
      listSessions: vi.fn(async () => [session]),
      getSession: vi.fn(async (id: string) => id === session.id ? session : null),
      listChildren: vi.fn(async () => children),
      respondPermission: vi.fn(async () => ({ ok: true })),
      setPermissions: vi.fn(async () => ({ ok: false, error: "Codex app-server permissions must be configured at thread start" })),
      changeModel: vi.fn(async (id: string, model: string) => id === session.id && model === "gpt-6-luna"
        ? ({ ok: true }) : ({ ok: false, error: "project-scoped Codex model is pinned" })),
      sendMessage: vi.fn(async () => ({ ok: true })),
      stopSession: vi.fn(async () => ({ ok: true })),
    }) as unknown as HarnessAdapter;
    const scoped = makeAdapter(scopedSession, [child]);
    const ordinary = makeAdapter(ordinarySession, []);
    const denied = new Map([
      ["unresolved-affine", "binding_unresolved"],
      ["wrong-root-affine", "project_session_current_route_mismatch"],
      ["wrong-address-affine", "project_session_host_or_harness_mismatch"],
    ]);
    const resolver = { adapterForSession: vi.fn(async ({ nativeSessionId }: { nativeSessionId: string }) => {
      if (nativeSessionId === scopedSession.id) return { kind: "scoped" as const, adapter: scoped };
      if (denied.has(nativeSessionId)) return { kind: "deny" as const, reason: denied.get(nativeSessionId)! };
      return { kind: "ordinary" as const };
    }) };
    const events = new HerderEventBus();
    const server = new McpServer({ name: "session-affine-scoped-routing-test", version: "1" });
    registerSessionTools(server, {
      adapters: new Map([["codex", ordinary]]), jobs: new HerderJobRegistry(events), events,
      integratorRuntime: resolver as any,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "session-affine-scoped-routing-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await server.connect(serverTransport); await client.connect(clientTransport);
    const callAffineTools = async (sessionId: string, harness = "codex") => Promise.all([
      client.callTool({ name: "session_identity", arguments: { sessionId, harness } }),
      client.callTool({ name: "list_children", arguments: { sessionId, harness } }),
      client.callTool({ name: "respond_permission", arguments: { sessionId, harness, permissionId: "permission-1", response: "deny" } }),
      client.callTool({ name: "set_permissions", arguments: { sessionId, harness, allowedTools: "read", mode: "safe" } }),
      client.callTool({ name: "change_model", arguments: { sessionId, harness, model: "gpt-6-luna" } }),
    ]);
    try {
      const scopedResults = await callAffineTools(scopedSession.id);
      expect(scopedResults.every((result) => result.isError !== true)).toBe(true);
      expect((scoped as any).getSession).toHaveBeenCalledTimes(5);
      expect((scoped as any).listChildren).toHaveBeenCalledOnce();
      expect((scoped as any).respondPermission).toHaveBeenCalledOnce();
      expect((scoped as any).setPermissions).toHaveBeenCalledOnce();
      expect((scoped as any).changeModel).toHaveBeenCalledOnce();
      expect((ordinary as any).getSession).not.toHaveBeenCalled();
      expect((ordinary as any).listChildren).not.toHaveBeenCalled();
      expect((ordinary as any).respondPermission).not.toHaveBeenCalled();
      expect((ordinary as any).setPermissions).not.toHaveBeenCalled();
      expect((ordinary as any).changeModel).not.toHaveBeenCalled();

      const ordinaryResults = await callAffineTools(ordinarySession.id);
      expect(ordinaryResults.every((result) => result.isError !== true)).toBe(true);
      expect((ordinary as any).getSession).toHaveBeenCalledTimes(5);
      expect((ordinary as any).listChildren).toHaveBeenCalledOnce();
      expect((ordinary as any).respondPermission).toHaveBeenCalledOnce();
      expect((ordinary as any).setPermissions).toHaveBeenCalledOnce();
      expect((ordinary as any).changeModel).toHaveBeenCalledOnce();

      const countsBeforeDenied = [
        (ordinary as any).getSession.mock.calls.length, (ordinary as any).listChildren.mock.calls.length,
        (ordinary as any).respondPermission.mock.calls.length, (ordinary as any).setPermissions.mock.calls.length,
        (ordinary as any).changeModel.mock.calls.length, (scoped as any).getSession.mock.calls.length,
        (scoped as any).listChildren.mock.calls.length, (scoped as any).respondPermission.mock.calls.length,
        (scoped as any).setPermissions.mock.calls.length, (scoped as any).changeModel.mock.calls.length,
      ];
      for (const sessionId of denied.keys()) {
        const results = await callAffineTools(sessionId);
        expect(results.every((result) => result.isError === true)).toBe(true);
      }
      const wrongHarness = await client.callTool({ name: "list_children", arguments: { sessionId: scopedSession.id, harness: "opencode" } });
      expect(wrongHarness.isError).toBe(true);
      expect([
        (ordinary as any).getSession.mock.calls.length, (ordinary as any).listChildren.mock.calls.length,
        (ordinary as any).respondPermission.mock.calls.length, (ordinary as any).setPermissions.mock.calls.length,
        (ordinary as any).changeModel.mock.calls.length, (scoped as any).getSession.mock.calls.length,
        (scoped as any).listChildren.mock.calls.length, (scoped as any).respondPermission.mock.calls.length,
        (scoped as any).setPermissions.mock.calls.length, (scoped as any).changeModel.mock.calls.length,
      ]).toEqual(countsBeforeDenied);
      expect((scoped as any).init).not.toHaveBeenCalled();
      expect((ordinary as any).init).not.toHaveBeenCalled();
    } finally { await client.close(); await server.close(); }
  });

  it("publishes output schemas and structured session results", async () => {
    const client = await connect();
    const tools = (await client.listTools()).tools;
    for (const name of ["list_agents", "agent_info", "find_parent", "list_children", "list_models"]) {
      expect(tools.find((tool) => tool.name === name)?.outputSchema).toMatchObject({ type: "object" });
    }

    const listed = await client.callTool({ name: "list_agents", arguments: { harness: "opencode", includeLastMessage: true } });
    expect(listed.structuredContent).toMatchObject({ total: 1, limited: false, sessions: [expect.objectContaining({ id: "sess-1", model: "gpt-test" })] });
    expect(listed.content[0]?.type === "text" ? listed.content[0].text : "").toContain("[opencode] sess-1");

    const info = await client.callTool({ name: "agent_info", arguments: { harness: "opencode", sessionId: "sess-1" } });
    expect(info.structuredContent).toMatchObject({ session: { id: "sess-1", messageCount: 3 } });

    const parent = await client.callTool({ name: "find_parent", arguments: { harness: "opencode", sessionId: "sess-1" } });
    expect(parent.structuredContent).toMatchObject({ supported: true, parent: { id: "parent-1" } });

    const children = await client.callTool({ name: "list_children", arguments: { harness: "opencode", sessionId: "sess-1" } });
    expect(children.structuredContent).toMatchObject({ supported: true, children: [{ id: "child-1" }] });

    const models = await client.callTool({ name: "list_models", arguments: { harness: "opencode" } });
    expect(models.structuredContent).toEqual({ harnesses: [{ harness: "opencode", name: "OpenCode Fixture", models: ["gpt-test", "gpt-alt"], defaultModel: "gpt-test" }] });
  });

  it("publishes canonical source and human-intent fields and carries them through public MCP calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-session-mcp-stop-"));
    roots.push(root);
    previousStopPath = process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    stopPathWasChanged = true;
    const stopPath = join(root, "stops.json");
    process.env.AGENT_HERDER_HUMAN_STOP_STORE = stopPath;
    const session = { ...fixtureSession("held-zcode"), harness: "zcode" as const };
    const { client, createSession, resumeSession } = await connectHumanStopConsumer(session);
    const tools = (await client.listTools()).tools;
    const properties = (name: string) => tools.find((tool) => tool.name === name)?.inputSchema?.properties as Record<string, unknown>;

    expect(properties("send_message")).toEqual(expect.objectContaining({
      humanRequested: expect.any(Object), fromSessionId: expect.any(Object), fromHarness: expect.any(Object),
    }));
    expect(properties("create_session")).toEqual(expect.objectContaining({ sourceSessions: expect.any(Object), sourceSessionId: expect.any(Object), sourceHarness: expect.any(Object) }));
    expect(properties("new_or_resume")).toEqual(expect.objectContaining({ humanRequested: expect.any(Object), sourceSessions: expect.any(Object) }));
    expect(properties("deliver")).toEqual(expect.objectContaining({ sourceSessions: expect.any(Object), sourceSessionId: expect.any(Object), sourceHarness: expect.any(Object) }));
    expect(properties("resume_agent")).toEqual(expect.objectContaining({ humanRequested: expect.any(Object) }));

    const blockedCreate = await client.callTool({ name: "create_session", arguments: {
      harness: "zcode", name: "must-not-create", cwd: process.cwd(),
      sourceSessions: [{ harness: "zcode", sessionId: "missing-held-source" }],
    } });
    expect(createSession).not.toHaveBeenCalled();
    expect(blockedCreate.content[0]?.type === "text" ? blockedCreate.content[0].text : "").toContain("Исходный чат недоступен");

    const extendedModel = "m".repeat(200);
    const extendedModelCall = await client.callTool({ name: "new_or_resume", arguments: {
      harness: "zcode", name: "extended-model", cwd: process.cwd(), message: "continue", model: extendedModel,
    } });
    expect(extendedModelCall.isError).not.toBe(true);
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ model: extendedModel }));

    const store = new HumanStopStore(stopPath);
    await store.hold({ harness: "zcode", id: session.id }, {
      id: "public-mcp-stop", at: new Date(Date.now() - 1_000).toISOString(), reason: "interrupted",
    });
    await client.callTool({ name: "resume_agent", arguments: { harness: "zcode", sessionId: session.id, humanRequested: true } });
    expect(resumeSession).toHaveBeenCalledOnce();
    expect(await store.isHeld("zcode", session.id)).toBe(false);
  });
});
