import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createWebServer } from "../src/web/server.js";
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

describe("agent-herder web API", () => {
  it("serves sessions, resume, conversion, and the PWA shell", async () => {
    const server = createWebServer({
      adapters: new Map([["claude", fakeAdapter()]]),
      converter: {
        async convert() {
          return { success: true, targetSessionId: "codex-session-1", targetPath: "/tmp/codex.jsonl", messageCount: 2 };
        },
      },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const base = `http://127.0.0.1:${address.port}`;

    const sessions = await fetch(`${base}/api/sessions`);
    expect(sessions.status).toBe(200);
    expect(await sessions.json()).toMatchObject({ sessions: [{ id: "session-1" }] });

    const details = await fetch(`${base}/api/sessions/claude/session-1/details`);
    expect(details.status).toBe(200);
    expect(await details.json()).toMatchObject({
      session: { id: "session-1" },
      lineage: { kind: "external" },
      history: { source: "unavailable" },
    });

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
});
