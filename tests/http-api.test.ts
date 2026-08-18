import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createWebServer } from "../src/web/server.js";
import { AdapterRegistry } from "../src/adapter-registry.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function fakeSession(): AgentSession {
  return {
    id: "session-1",
    harness: "claude",
    status: "stopped",
    title: "Test session",
    cwd: "/tmp/project",
    lastActivity: new Date().toISOString(),
    needsPermission: false,
  };
}

function fakeAdapter(): HarnessAdapter {
  const session = fakeSession();
  return {
    type: "claude",
    name: "Fake Claude",
    async init() {},
    async listSessions() { return [session]; },
    async getSession(id) { return id === session.id ? session : null; },
    async sendMessage() { return { ok: true }; },
    async stopSession() { return { ok: false, error: "cannot stop" }; },
    async respondPermission() { return { ok: false, error: "permission backend unavailable" }; },
    async setPermissions() { return { ok: true }; },
  };
}

function fakeNamedAdapter(): HarnessAdapter {
  const sessions: AgentSession[] = [];
  let nextId = 0;
  return {
    type: "opencode",
    name: "Fake OpenCode",
    async init() {},
    async listSessions() { return [...sessions]; },
    async getSession(id) { return sessions.find((session) => session.id === id) || null; },
    async createSession(options) {
      const session: AgentSession = {
        id: `named-${++nextId}`,
        harness: "opencode",
        status: "idle",
        title: options.name,
        cwd: options.cwd,
        lastActivity: new Date().toISOString(),
        needsPermission: false,
      };
      sessions.push(session);
      return session;
    },
    async sendMessage() { return { ok: true }; },
    async changeModel(id, model) {
      const target = sessions.find((item) => item.id === id);
      if (target) target.model = model;
      return { ok: true };
    },
    async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; },
    async setPermissions() { return { ok: true }; },
  };
}

function fakeHermesAdapter(): HarnessAdapter {
  const adapter = fakeNamedAdapter();
  return {
    ...adapter,
    type: "hermes",
    name: "Fake Hermes",
    getExecutionProfile() {
      return { provider: "openai-codex", reasoning: "high", toolsets: "terminal" };
    },
  };
}

describe("agent-herder web API", () => {
  it("enforces the configured bearer token on the MCP HTTP surface", async () => {
    const server = createWebServer({
      adapters: new Map(),
      converter: { async convert() { return { success: true, targetSessionId: "x", targetPath: "/tmp/x", messageCount: 0 }; } },
      mcpAuthToken: "mcp-secret",
      mcpServerFactory: () => new McpServer({ name: "test", version: "1.0.0" }),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
    });
    const base = `http://127.0.0.1:${address.port}/mcp`;
    const acceptHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    expect((await fetch(base, { method: "POST", headers: acceptHeaders, body })).status).toBe(401);
    expect((await fetch(base, { method: "POST", headers: { ...acceptHeaders, authorization: "Bearer wrong" }, body })).status).toBe(401);
    expect((await fetch(base, { method: "POST", headers: { ...acceptHeaders, authorization: "Bearer mcp-secret" }, body })).status).toBe(200);
  });

  it("exposes a read-only health remediation route probe without creating a session", async () => {
    const server = createWebServer({
      adapters: new Map([["opencode", fakeNamedAdapter()]]),
      converter: { async convert() { return { success: true, targetSessionId: "x", targetPath: "/tmp/x", messageCount: 0 }; } },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health/remediation`);
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({ error: "method_not_allowed", route: "/api/health/remediation" });
  });

  it("accepts one canonical health remediation request and returns the selected execution profile", async () => {
    const server = createWebServer({
      adapters: new Map([["opencode", fakeNamedAdapter()]]),
      converter: { async convert() { return { success: true, targetSessionId: "x", targetPath: "/tmp/x", messageCount: 0 }; } },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${base}/api/health/remediation`, {
      method: "POST",
      body: JSON.stringify({
        incident_id: "inc-health-1",
        plan_id: "repair",
        harness: "opencode",
        name: "health_repair_inc-health-1",
        cwd: "/tmp",
        message: "Repair the selected health incident and report useful progress.",
        execution: { runtime: "opencode", provider: "openai-codex", model: "gpt-5.6-luna", reasoning: "high", topic: "health" },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      incident_id: "inc-health-1",
      plan_id: "repair",
      model: "openai-codex/gpt-5.6-luna",
      execution: { runtime: "opencode", provider: "openai-codex", model: "gpt-5.6-luna", reasoning: "high", topic: "health" },
    });
  });

  it("routes the canonical health profile to the real OpenCode harness", async () => {
    const server = createWebServer({
      adapters: new Map([["opencode", fakeNamedAdapter()]]),
      converter: { async convert() { return { success: true, targetSessionId: "x", targetPath: "/tmp/x", messageCount: 0 }; } },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health/remediation`, {
      method: "POST",
      body: JSON.stringify({
        incident_id: "inc-health-hermes-1",
        plan_id: "repair",
        harness: "opencode",
        name: "health_repair_opencode_inc-health-1",
        cwd: "/tmp",
        message: "Run the selected health remediation job.",
        execution: { runtime: "opencode", provider: "openai-codex", model: "gpt-5.6-luna", reasoning: "high", topic: "health" },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      harness: "opencode",
      model: "openai-codex/gpt-5.6-luna",
      execution: { runtime: "opencode", provider: "openai-codex", model: "gpt-5.6-luna", reasoning: "high", topic: "health" },
    });
  });

  it("lists adapters and enables one through the explicit registry endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-web-"));
    const adapters = new Map<string, HarnessAdapter>();
    const registry = new AdapterRegistry(adapters, join(root, "adapters.json"));
    registry.register({ id: "opencode", name: "OpenCode", description: "test", defaultEnabled: false, factory: fakeNamedAdapter });
    const server = createWebServer({ adapters, converter: { async convert() { return { success: true, targetSessionId: "x", targetPath: "/tmp/x", messageCount: 0 }; } }, adapterRegistry: registry });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/api/adapters`)).status).toBe(200);
    const enabled = await fetch(`${base}/api/adapters/opencode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });
    expect(enabled.status).toBe(200);
    expect((await enabled.json()).adapter).toMatchObject({ id: "opencode", active: true, status: "active" });
  });

  it("serves sessions, resume, conversion, and the PWA shell", async () => {
    const server = createWebServer({
      adapters: new Map([["claude", fakeAdapter()], ["opencode", fakeNamedAdapter()]]),
      converter: {
        async convert() {
          return { success: true, targetSessionId: "codex-session-1", targetPath: "/tmp/codex.jsonl", messageCount: 2 };
        },
      },
      sessionVisualizer: async (details) => `<html><title>${details.session.harness} graph ${details.session.id}</title></html>`,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const base = `http://127.0.0.1:${address.port}`;

    const sessions = await fetch(`${base}/api/sessions`);
    expect(sessions.status).toBe(200);
    expect(await sessions.json()).toMatchObject({ sessions: [{ id: "session-1" }] });

    const created = await fetch(`${base}/api/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "opencode", name: "manual_100", cwd: "/tmp" }),
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ ok: true, created: true, sessionId: "named-1" });

    const firstNamed = await fetch(`${base}/api/sessions/new-or-resume`, {
      method: "POST",
      body: JSON.stringify({ harness: "opencode", name: "repair_100", cwd: "/tmp", message: "disk 95%", mode: "queue" }),
    });
    expect(firstNamed.status).toBe(200);
    expect(await firstNamed.json()).toMatchObject({ ok: true, created: true, sessionId: "named-2", delivery: "accepted" });

    const profiledNamed = await fetch(`${base}/api/sessions/new-or-resume`, {
      method: "POST",
      body: JSON.stringify({ harness: "opencode", name: "health_remediation_100", cwd: "/tmp", message: "repair selected health incident", mode: "queue", model: "openai-codex/gpt-5.6-luna" }),
    });
    expect(profiledNamed.status).toBe(200);
    expect(await profiledNamed.json()).toMatchObject({ ok: true, created: true, sessionId: "named-3", model: "openai-codex/gpt-5.6-luna" });

    const resumedNamed = await fetch(`${base}/api/sessions/new-or-resume`, {
      method: "POST",
      body: JSON.stringify({ harness: "opencode", name: "repair_100", cwd: "/tmp", message: "disk 96%", mode: "queue" }),
    });
    expect(resumedNamed.status).toBe(200);
    expect(await resumedNamed.json()).toMatchObject({ ok: true, created: false, sessionId: "named-2", delivery: "accepted" });

    const details = await fetch(`${base}/api/sessions/claude/session-1/details`);
    expect(details.status).toBe(200);
    expect(await details.json()).toMatchObject({
      session: { id: "session-1" },
      lineage: { kind: "external" },
      history: { source: "unavailable" },
    });

    const visualization = await fetch(`${base}/api/sessions/claude/session-1/visualization`);
    expect(visualization.status).toBe(200);
    expect(visualization.headers.get("content-type")).toContain("text/html");
    expect(await visualization.text()).toContain("claude graph session-1");

    const missingDetails = await fetch(`${base}/api/sessions/claude/missing/details`);
    expect(missingDetails.status).toBe(404);
    expect(await missingDetails.json()).toEqual({ error: "Session not found" });

    const resume = await fetch(`${base}/api/sessions/claude/session-1/resume`, { method: "POST", body: JSON.stringify({ message: "continue" }) });
    expect(resume.status).toBe(200);
    expect(await resume.json()).toEqual({ ok: true });

    const stop = await fetch(`${base}/api/sessions/claude/session-1/stop`, { method: "POST" });
    expect(stop.status).toBe(502);
    expect(await stop.json()).toEqual({ ok: false, error: "cannot stop" });

    const permission = await fetch(`${base}/api/sessions/claude/session-1/permissions/p-1`, {
      method: "POST",
      body: JSON.stringify({ response: "allow" }),
    });
    expect(permission.status).toBe(502);
    expect(await permission.json()).toEqual({ ok: false, error: "permission backend unavailable" });

    const conversion = await fetch(`${base}/api/conversions`, { method: "POST", body: JSON.stringify({ sessionId: "session-1", from: "claude", to: "codex" }) });
    expect(conversion.status).toBe(200);
    expect(await conversion.json()).toMatchObject({ success: true, targetSessionId: "codex-session-1" });

    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("Agent Herder");
    expect(html).toContain("Convert");
  });

  it("serves bounded useful progress that is stable across timestamp-only heartbeat changes", async () => {
    let heartbeat = 0;
    const session: AgentSession = {
      id: "session-1",
      harness: "claude",
      status: "running",
      title: "Test session",
      cwd: "/tmp/project",
      lastActivity: new Date().toISOString(),
      needsPermission: false,
      messageCount: 3,
      lastMessage: "Investigating current state",
    };
    const progressAdapter: HarnessAdapter = {
      type: "claude",
      name: "Progress Claude",
      async init() {},
      async listSessions() { return [{ ...session, lastActivity: new Date(Date.now() + heartbeat++).toISOString() }]; },
      async getSession(id) { return id === session.id ? { ...session, lastActivity: new Date(Date.now() + heartbeat++).toISOString() } : null; },
      async getSessionMessages() {
        return [
          { id: "u1", role: "user", text: "Inspect", parts: [{ type: "text", text: "Inspect" }] },
          { id: "a1", role: "assistant", parts: [{ type: "text", text: "I found the issue." }, { type: "tool_call", name: "Bash", input: { command: "rg progress" } }] },
          { id: "t1", role: "tool", parts: [{ type: "tool_result", name: "Bash", output: "progress.ts token=super-secret" }] },
        ];
      },
      async sendMessage() { return { ok: true }; },
      async stopSession() { return { ok: true }; },
      async respondPermission() { return { ok: true }; },
      async setPermissions() { return { ok: true }; },
    };
    const server = createWebServer({
      adapters: new Map([["claude", progressAdapter]]),
      converter: { async convert() { return { success: true, targetSessionId: "x", targetPath: "/tmp/x", messageCount: 0 }; } },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const base = `http://127.0.0.1:${address.port}`;

    const first = await fetch(`${base}/api/sessions/claude/session-1/progress`);
    expect(first.status).toBe(200);
    const firstJson = await first.json();
    expect(firstJson).toMatchObject({
      session: { id: "session-1", status: "running" },
      activity: { hasMessageActivity: true, hasToolActivity: true },
    });
    expect(firstJson.fingerprint).toMatch(/^progress:/);
    expect(firstJson.evidence.length).toBeLessThanOrEqual(5);
    expect(firstJson.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "message", id: "a1" }),
      expect.objectContaining({ kind: "tool", id: "t1" }),
    ]));

    expect(firstJson.evidence).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ preview: expect.stringContaining("super-secret") }),
    ]));

    const second = await fetch(`${base}/api/sessions/claude/session-1/progress`);
    const secondJson = await second.json();
    expect(secondJson.fingerprint).toBe(firstJson.fingerprint);
    expect(secondJson.session.lastActivity).not.toBe(firstJson.session.lastActivity);
  });
});
