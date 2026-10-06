import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebServer } from "../src/web/server.js";
import { HumanStopStore } from "../src/human-stop-store.js";
import { SessionSupervisor } from "../src/session-supervisor.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("per-session archive route", () => {
  it("archives only an idle permission-free session and keeps its history and human stop fence", async () => {
    const current: AgentSession = {
      id: "session-archive-1", harness: "zcode", title: "completed diagnosis", cwd: "/tmp/project",
      status: "idle", lastActivity: new Date().toISOString(), needsPermission: false,
    };
    let archived = false;
    const history = [
      { id: "user-1", role: "user" as const, text: "inspect this host", parts: [{ type: "text" as const, text: "inspect this host" }] },
      { id: "assistant-1", role: "assistant" as const, text: "diagnosis complete", parts: [{ type: "text" as const, text: "diagnosis complete" }] },
    ];
    const archiveSession = async () => { archived = true; return { ok: true, sessionId: current.id }; };
    const adapter: HarnessAdapter = {
      type: "zcode", name: "archive fixture", async init() {},
      async listSessions() { return archived ? [] : [current]; },
      async getSession(id) { return id === current.id ? current : null; },
      async getSessionMessages(id) { return id === current.id ? history : null; },
      archiveSession,
      async sendMessage() { return { ok: true }; },
      async stopSession() { return { ok: true }; },
      async respondPermission() { return { ok: true }; },
      async setPermissions() { return { ok: true }; },
    };
    const adapters = new Map<string, HarnessAdapter>([["zcode", adapter]]);
    const root = await mkdtemp(join(tmpdir(), "agent-herder-archive-route-"));
    roots.push(root);
    const store = new HumanStopStore(join(root, "stops.json"));
    await store.hold({ harness: "zcode", id: current.id }, {
      id: "explicit-stop-before-archive", at: new Date(Date.now() - 1_000).toISOString(), reason: "interrupted",
    });
    const converter = { async convert() { return { success: true, targetSessionId: "x", targetPath: "/tmp/x", messageCount: 0 }; } };
    const supervisor = new SessionSupervisor(adapters, converter as any, undefined, { humanStopStore: store });
    const server = createWebServer({ adapters, converter, supervisor });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const base = `http://127.0.0.1:${address.port}`;

    current.status = "running";
    const running = await fetch(`${base}/api/sessions/zcode/${current.id}/archive`, { method: "POST" });
    expect(running.status).toBe(502);
    expect(archived).toBe(false);
    current.status = "idle";
    current.needsPermission = true;
    const permissionPending = await fetch(`${base}/api/sessions/zcode/${current.id}/archive`, { method: "POST" });
    expect(permissionPending.status).toBe(502);
    expect(archived).toBe(false);
    current.needsPermission = false;

    const response = await fetch(`${base}/api/sessions/zcode/${current.id}/archive`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, sessionId: current.id });
    expect(await store.isHeld("zcode", current.id)).toBe(true);
    expect(await (await fetch(`${base}/api/sessions?harness=zcode`)).json()).toMatchObject({ sessions: [] });

    const details = await fetch(`${base}/api/sessions/zcode/${current.id}/details?history=acp`);
    expect(details.status).toBe(200);
    expect(await details.json()).toMatchObject({
      session: { id: current.id },
      messages: history,
      history: { source: "acp-load" },
    });
  });

  it("forwards deliberate recovery and fork intent while keeping automatic HTTP actions fenced", async () => {
    const current: AgentSession = {
      id: "session-held-1", harness: "zcode", title: "paused session", cwd: "/tmp/project",
      status: "idle", lastActivity: new Date().toISOString(), needsPermission: false,
    };
    const recover = async () => ({ ok: true });
    const forkSession = async () => ({ ok: true });
    let recoverCalls = 0;
    let forkCalls = 0;
    const adapter: HarnessAdapter = {
      type: "zcode", name: "held fixture", async init() {},
      async listSessions() { return [current]; },
      async getSession(id) { return id === current.id ? current : null; },
      async recover() { recoverCalls += 1; return recover(); },
      async forkSession() { forkCalls += 1; return forkSession(); },
      async sendMessage() { return { ok: true }; },
      async stopSession() { return { ok: true }; },
      async respondPermission() { return { ok: true }; },
      async setPermissions() { return { ok: true }; },
    };
    const adapters = new Map<string, HarnessAdapter>([["zcode", adapter]]);
    const root = await mkdtemp(join(tmpdir(), "agent-herder-held-action-route-"));
    roots.push(root);
    const store = new HumanStopStore(join(root, "stops.json"));
    await store.hold({ harness: "zcode", id: current.id }, {
      id: "explicit-stop", at: new Date(Date.now() - 1_000).toISOString(), reason: "interrupted",
    });
    const converter = { async convert() { return { success: true, targetSessionId: "x", targetPath: "/tmp/x", messageCount: 0 }; } };
    const supervisor = new SessionSupervisor(adapters, converter as any, undefined, { humanStopStore: store });
    const server = createWebServer({ adapters, converter, supervisor });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const base = `http://127.0.0.1:${address.port}/api/sessions/zcode/${current.id}`;

    const automaticRecover = await fetch(`${base}/recover`, { method: "POST", body: JSON.stringify({ message: "automatic recovery" }) });
    expect(automaticRecover.status).toBe(502);
    const automaticFork = await fetch(`${base}/fork`, { method: "POST", body: JSON.stringify({ message: "automatic fork" }) });
    expect(automaticFork.status).toBe(502);
    expect(recoverCalls).toBe(0);
    expect(forkCalls).toBe(0);

    const requestedRecover = await fetch(`${base}/recover`, {
      method: "POST", body: JSON.stringify({ message: "operator recovery", humanRequested: true }),
    });
    expect(requestedRecover.status).toBe(200);
    expect(recoverCalls).toBe(1);
    await store.hold({ harness: "zcode", id: current.id }, {
      id: "explicit-stop-again", at: new Date().toISOString(), reason: "interrupted",
    });
    const requestedFork = await fetch(`${base}/fork`, {
      method: "POST", body: JSON.stringify({ message: "operator fork", humanRequested: true }),
    });
    expect(requestedFork.status).toBe(200);
    expect(forkCalls).toBe(1);
  });
});
