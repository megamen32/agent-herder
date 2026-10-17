import { createServer, type Server } from "node:http";
import { expect, it } from "vitest";
import { sessionIdentity } from "../src/session-identity.js";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

// Focused integration: a session learns its own identity through the harness's
// own instruction surface.
// Expected <1s/max 15s. One fixture HTTP server; no model call.
function fixtureServer(state: { entries: Array<{ path: string; body: unknown }>; reject?: boolean }) {
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const url = new URL(request.url!, "http://identity");
      const path = url.pathname;
      if (path === "/api/config") {
        response.setHeader("content-type", "application/json");
        return response.end(JSON.stringify({ data: [{ type: "document" }] }));
      }
      if (path.endsWith("/instructions/entries/agent.herder.identity")) {
        state.entries.push({ path, body: request.method === "PUT" && body ? JSON.parse(body) : null });
        response.statusCode = state.reject ? 500 : 204;
        return response.end();
      }
      if (path === "/api/session/active") {
        response.setHeader("content-type", "application/json");
        return response.end(JSON.stringify({ data: {} }));
      }
      if (path === "/api/session" && request.method === "POST") {
        const parsed = (body ? JSON.parse(body) : {}) as { title?: string; location?: { directory?: string } };
        response.setHeader("content-type", "application/json");
        return response.end(JSON.stringify({
          data: { id: "ses_1", title: parsed.title ?? "worker-7", location: parsed.location ?? { directory: "/tmp/project" }, time: { created: 1, updated: 2 } },
        }));
      }
      if (path.startsWith("/api/session/")) {
        response.setHeader("content-type", "application/json");
        return response.end(JSON.stringify({ data: { id: "ses_1", title: "worker-7", location: { directory: "/tmp/project" }, time: { created: 1, updated: 2 } } }));
      }
      response.statusCode = 404;
      response.end();
    });
  });
  return server;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

it("announces the session's own identity into the session's instructions", async () => {
  const state = { entries: [] as Array<{ path: string; body: unknown }> };
  const server = fixtureServer(state);
  try {
    const adapter = new OpenCodeAdapter({ baseUrl: await listen(server), protocol: "v2" });
    await adapter.init();
    const created = await adapter.createSession({ name: "worker-7", cwd: "/tmp/project" });
    expect(created.title).toBe("worker-7");

    const entry = state.entries.find((item) => item.path.includes("/instructions/entries/"));
    expect(entry, "createSession must publish the identity").toBeTruthy();
    const value = (entry!.body as { value: Record<string, unknown> }).value;
    expect(value).toMatchObject({ name: "worker-7", sessionId: "ses_1", harness: "opencode", cwd: "/tmp/project" });
  } finally {
    server.close();
  }
});

it("reads the identity of a session on demand", async () => {
  const state = { entries: [] as Array<{ path: string; body: unknown }> };
  const server = fixtureServer(state);
  try {
    const adapter = new OpenCodeAdapter({ baseUrl: await listen(server), protocol: "v2" });
    const identity = await sessionIdentity(adapter, { sessionId: "ses_1" });
    expect(identity).toMatchObject({ sessionId: "ses_1", harness: "opencode", name: "worker-7", cwd: "/tmp/project" });
    expect(identity?.announced).toBeUndefined();
  } finally {
    server.close();
  }
});

it("reports honestly when a harness cannot publish identity", async () => {
  const adapter = {
    type: "codex", name: "Codex",
    async getSession(id: string): Promise<AgentSession | null> {
      return { id, harness: "codex", status: "idle", title: "Thread", cwd: "/tmp", lastActivity: "", needsPermission: false };
    },
  } as unknown as HarnessAdapter;
  const identity = await sessionIdentity(adapter, { sessionId: "th_1", announce: true });
  expect(identity).toMatchObject({ announced: false });
  expect(identity?.reason).toContain("no native session-identity channel");
});

it("does not fail session creation when the announcement is refused", async () => {
  const state = { entries: [], reject: true } as { entries: Array<{ path: string; body: unknown }>; reject: boolean };
  const server = fixtureServer(state);
  try {
    const adapter = new OpenCodeAdapter({ baseUrl: await listen(server), protocol: "v2" });
    const created = await adapter.createSession({ name: "worker-8", cwd: "/tmp/project" });
    expect(created.id).toBe("ses_1");
    const identity = await sessionIdentity(adapter, { sessionId: created.id, announce: true });
    expect(identity?.announced).toBe(false);
  } finally {
    server.close();
  }
});