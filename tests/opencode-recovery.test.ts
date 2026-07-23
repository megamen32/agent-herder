import { createServer, type Server } from "node:http";
import { describe, expect, it, afterEach } from "vitest";
import { OpenCodeAdapter, parseOpenCodeServerCommand } from "../src/adapters/opencode.js";
import { handleFindParent, handleListChildren, handleSendMessage } from "../src/mcp-tools/handlers.js";

describe("OpenCode native recovery controls", () => {
  let server: Server | undefined;
  let port = 0;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("derives the local server URL from an OpenCode serve command", () => {
    const command = ["/usr/bin/opencode", "serve", "--hostname", "127.0.0.1", "--port", "39225", ""].join(String.fromCharCode(0));
    expect(parseOpenCodeServerCommand(command)).toBe("http://127.0.0.1:39225");
  });

  it("lists children, forks, and queues a recovery prompt", async () => {
    let recoveryPrompts = 0;
    server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/global/health") return response.end(JSON.stringify({ healthy: true }));
      if (request.url === "/session" && request.method === "GET") {
        return response.end(JSON.stringify([{ id: "parent", title: "Parent", path: "/tmp/project", createdAt: "2026-07-19T00:00:00Z", updatedAt: "2026-07-19T00:01:00Z" }]));
      }
      if (request.url === "/session/status") return response.end(JSON.stringify({ parent: { status: "idle" } }));
      if (request.url === "/session/parent/message?limit=1") return response.end(JSON.stringify([]));
      if (request.url === "/session/parent/children") {
        return response.end(JSON.stringify([{ id: "child", title: "Child", path: "/tmp/project" }]));
      }
      if (request.url === "/session/parent/fork" && request.method === "POST") {
        return response.end(JSON.stringify({ id: "forked", title: "Forked", path: "/tmp/project" }));
      }
      if (request.url === "/session/parent/prompt_async" && request.method === "POST") {
        recoveryPrompts += 1;
        return response.end(JSON.stringify({ accepted: true }));
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    }).listen(0);
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
    port = (server.address() as { port: number }).port;

    const adapter = new OpenCodeAdapter({ baseUrl: `http://127.0.0.1:${port}` });
    await adapter.init();
    expect(await adapter.listChildren("parent")).toHaveLength(1);
    expect(await adapter.forkSession("parent")).toEqual({ ok: true, sessionId: "forked" });
    expect(await adapter.recover("parent", "please continue after the error")).toEqual({ ok: true });
    expect(recoveryPrompts).toBe(1);
  });

  it("sends to a direct session id that is absent from the list response", async () => {
    let sentBody = "";
    server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/global/health") return response.end(JSON.stringify({ healthy: true }));
      if (request.url === "/session" && request.method === "GET") return response.end(JSON.stringify([]));
      if (request.url === "/session/direct-parent" && request.method === "GET") {
        return response.end(JSON.stringify({ id: "direct-parent", title: "Parent", path: "/tmp/project" }));
      }
      if (request.url === "/session/direct-parent/prompt_async" && request.method === "POST") {
        request.setEncoding("utf8");
        request.on("data", (chunk) => { sentBody += chunk; });
        request.on("end", () => response.end(JSON.stringify({ accepted: true })));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    }).listen(0);
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
    port = (server.address() as { port: number }).port;

    const adapter = new OpenCodeAdapter({ baseUrl: `http://127.0.0.1:${port}` });
    await adapter.init();
    const result = await handleSendMessage(new Map([["opencode", adapter]]), {
      sessionId: "direct-parent",
      harness: "opencode",
      message: "reply to parent",
      mode: "queue",
    });

    expect(result).toContain("Message sent to [opencode] direct-parent (queued).");
    expect(JSON.parse(sentBody)).toEqual({ parts: [{ type: "text", text: "reply to parent" }] });
  });

  it("finds a session parent and lists its children through MCP handlers", async () => {
    server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/global/health") return response.end(JSON.stringify({ healthy: true }));
      if (request.url === "/session/child" && request.method === "GET") {
        return response.end(JSON.stringify({ id: "child", title: "Child", path: "/tmp/project", parentID: "parent" }));
      }
      if (request.url === "/session/parent" && request.method === "GET") {
        return response.end(JSON.stringify({ id: "parent", title: "Parent", path: "/tmp/project" }));
      }
      if (request.url === "/session/parent/children" && request.method === "GET") {
        return response.end(JSON.stringify([
          { id: "child", title: "Child", path: "/tmp/project", parentID: "parent" },
          { id: "child-2", title: "Second child", path: "/tmp/project", parentID: "parent" },
        ]));
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    }).listen(0);
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
    port = (server.address() as { port: number }).port;

    const adapter = new OpenCodeAdapter({ baseUrl: `http://127.0.0.1:${port}` });
    await adapter.init();
    const adapters = new Map([["opencode", adapter]]);

    const parent = await handleFindParent(adapters, { sessionId: "child", harness: "opencode" });
    const children = await handleListChildren(adapters, { sessionId: "parent", harness: "opencode" });

    expect(parent).toContain("Parent of [opencode] child:");
    expect(parent).toContain("parent");
    expect(children).toContain("Children of [opencode] parent (2):");
    expect(children).toContain("child-2");
  });
});
