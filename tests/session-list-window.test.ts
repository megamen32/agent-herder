import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";

import { createWebServer } from "../src/web/server.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

/**
 * The list of the sessions answers a window and the counter of the whole list.
 *
 * The whole list of the mesh is megabytes of JSON: a browser that parses it
 * on the first paint does not come alive. The panel asks for a window, and
 * the answer says how many sessions the mesh has in total, so the owner sees
 * that the list is longer than the window and can load more.
 *
 * The server bounds the answer even when the caller names no window: the
 * history of the mesh is megabytes of JSON, and a screen of the panel must
 * not become slow because another screen asked for the history. The counter
 * of the whole list travels with the answer, so a caller that counts the
 * sessions of the mesh still counts them all.
 */

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function fakeAdapter(count: number, padding = ""): HarnessAdapter {
  const sessions: AgentSession[] = Array.from({ length: count }, (_, index) => ({
    id: `session-${index}`,
    harness: "claude",
    status: "stopped",
    title: `Session ${index}`,
    cwd: `/tmp/project-${index}`,
    lastActivity: new Date().toISOString(),
    needsPermission: false,
    ...(padding ? { meta: { padding } } as Partial<AgentSession> : {}),
  }));
  return {
    type: "claude",
    name: "Fake Claude",
    async init() {},
    async listSessions() { return [...sessions]; },
    async getSession(id) { return sessions.find((session) => session.id === id) ?? null; },
    async sendMessage() { return { ok: true }; },
    async stopSession() { return { ok: false, error: "cannot stop" }; },
    async respondPermission() { return { ok: false, error: "permission backend unavailable" }; },
    async setPermissions() { return { ok: true }; },
  };
}

/** The server of the test with the given number of sessions. */
async function startServer(count: number, padding = ""): Promise<string> {
  const server = createWebServer({
    adapters: new Map([["claude", fakeAdapter(count, padding)]]),
    converter: { async convert() { return { success: true, targetSessionId: "x", targetPath: "/tmp/x", messageCount: 0 }; } },
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  // The first read establishes the snapshot of the sessions, so the quick
  // read below answers from the snapshot and not from an empty one.
  await fetch(`${base}/api/sessions`);
  return base;
}

describe("the list of the sessions is a window with a counter", () => {
  it("answers the window the panel asks for and the counter of the whole list", async () => {
    const base = await startServer(25);
    const response = await fetch(`${base}/api/sessions?quick=1&limit=10`);
    expect(response.status).toBe(200);
    const body = await response.json() as { sessions: unknown[]; total?: number; limit?: number; truncated?: boolean };
    expect(body.sessions.length).toBe(10);
    expect(body.total).toBe(25);
    expect(body.limit).toBe(10);
    expect(body.truncated).toBe(true);
  });

  it("answers a bounded window and the counter of the whole list when the caller names no window", async () => {
    const base = await startServer(150);
    const response = await fetch(`${base}/api/sessions?quick=1`);
    const body = await response.json() as { sessions: unknown[]; total?: number; limit?: number; truncated?: boolean };
    // The server bounds the answer: a caller that names no window gets the
    // default window, not the whole history of the mesh. The counter of the
    // whole list travels with the answer, so a contour that counts the
    // sessions of the mesh must not lose half of them silently.
    expect(body.sessions.length).toBe(100);
    expect(body.total).toBe(150);
    expect(body.limit).toBe(100);
    expect(body.truncated).toBe(true);
  });

  it("bounds the window and never answers more than the bound", async () => {
    const base = await startServer(25);
    const response = await fetch(`${base}/api/sessions?quick=1&limit=100000`);
    const body = await response.json() as { sessions: unknown[]; total?: number };
    expect(body.sessions.length).toBe(25);
    // The counter names the whole list, not the window.
    expect(body.total).toBe(25);
  });

  it("keeps the answer inside the byte budget even with heavy sessions", async () => {
    const base = await startServer(40, "x".repeat(10_000));
    const response = await fetch(`${base}/api/sessions?quick=1&limit=40`);
    const text = await response.text();
    // The budget of the answer is 300 KiB; the envelope of the answer is
    // counted apart from the sessions.
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(300 * 1024 + 4096);
    const body = JSON.parse(text) as { sessions: unknown[]; total?: number };
    expect(body.sessions.length).toBeLessThan(40);
    expect(body.total).toBe(40);
  });

  it("answers the default window when the window is not a number", async () => {
    const base = await startServer(25);
    const response = await fetch(`${base}/api/sessions?quick=1&limit=many`);
    const body = await response.json() as { sessions: unknown[]; total?: number; limit?: number; truncated?: boolean };
    // A window that is not a number is not a window to ask for everything
    // with: the default window answers, and the counter keeps the truth.
    expect(body.sessions.length).toBe(25);
    expect(body.total).toBe(25);
    expect(body.limit).toBe(100);
    expect(body.truncated).toBe(false);
  });

  it("keeps the answer inside the byte budget even when the caller names no window", async () => {
    const base = await startServer(40, "x".repeat(10_000));
    const response = await fetch(`${base}/api/sessions?quick=1`);
    const text = await response.text();
    // The budget of the answer is 300 KiB; the envelope of the answer is
    // counted apart from the sessions.
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(300 * 1024 + 4096);
    const body = JSON.parse(text) as { sessions: unknown[]; total?: number; truncated?: boolean };
    expect(body.sessions.length).toBeLessThan(40);
    expect(body.total).toBe(40);
    expect(body.truncated).toBe(true);
  });

  it("never caches the shell of the panel", async () => {
    const base = await startServer(5);
    const response = await fetch(`${base}/`);
    // The shell names the bundle of the current release. A cached shell keeps
    // an old bundle alive in the browser, and an old bundle asks for the
    // whole history of the mesh.
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
