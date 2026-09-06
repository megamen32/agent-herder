import { createServer, type Server } from "node:http";
import { describe, expect, it, afterEach } from "vitest";
import { OpenCodeAdapter, parseOpenCodeServerCommand } from "../src/adapters/opencode.js";
import { handleFindParent, handleListChildren, handleSendMessage } from "../src/mcp-tools/handlers.js";
import { newOrResumeNamedSession } from "../src/named-session.js";

describe("OpenCode native recovery controls", () => {
  let server: Server | undefined;
  let port = 0;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("normalizes native OpenCode SSE events", async () => {
    server = createServer((request, response) => {
      if (request.url === "/event") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        response.write(`data: ${JSON.stringify({ type: "message.updated", properties: { sessionID: "sess-live", messageID: "msg-1" } })}\n\n`);
        return;
      }
      response.statusCode = 404; response.end();
    }).listen(0);
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
    port = (server.address() as { port: number }).port;
    const adapter = new OpenCodeAdapter({ baseUrl: `http://127.0.0.1:${port}` });
    const events: Array<{ kind: string; sessionId?: string; messageId?: string }> = [];
    const stop = adapter.subscribeEvents((event) => events.push(event));
    for (let i = 0; i < 20 && !events.some((event) => event.kind === "message.updated"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    stop();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "process.connected" }),
      expect.objectContaining({ kind: "message.updated", sessionId: "sess-live", messageId: "msg-1" }),
    ]));
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

  it("creates a named session with the requested directory", async () => {
    let createBody = "";
    server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/global/health") return response.end(JSON.stringify({ healthy: true }));
      if (request.url === "/session?directory=%2Ftmp%2Frepair" && request.method === "POST") {
        request.setEncoding("utf8");
        request.on("data", (chunk) => { createBody += chunk; });
        request.on("end", () => response.end(JSON.stringify({
          id: "created-session",
          title: "repair_100",
          directory: "/tmp/repair",
          time: { created: 1, updated: 1 },
        })));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    }).listen(0);
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
    port = (server.address() as { port: number }).port;

    const adapter = new OpenCodeAdapter({ baseUrl: `http://127.0.0.1:${port}` });
    await adapter.init();
    const created = await adapter.createSession({ name: "repair_100", cwd: "/tmp/repair" });

    expect(created).toMatchObject({ id: "created-session", title: "repair_100", cwd: "/tmp/repair", harness: "opencode" });
    expect(JSON.parse(createBody)).toEqual({ title: "repair_100" });
  });

  it("selects a provider model through the v2 per-session endpoint", async () => {
    let selectedBody = "";
    server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/session/selected-session/model" && request.method === "POST") {
        request.setEncoding("utf8");
        request.on("data", (chunk) => { selectedBody += chunk; });
        request.on("end", () => {
          response.statusCode = 204;
          response.end();
        });
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    }).listen(0);
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
    port = (server.address() as { port: number }).port;

    const adapter = new OpenCodeAdapter({ baseUrl: `http://127.0.0.1:${port}` });
    const result = await adapter.changeModel("selected-session", "openrouter/openai/gpt-4.1");

    expect(result).toEqual({ ok: true });
    expect(JSON.parse(selectedBody)).toEqual({ model: { providerID: "openrouter", id: "openai/gpt-4.1" } });
  });

  it("selects the model before the first queued prompt", async () => {
    const order: string[] = [];
    server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/session?directory=%2Ftmp" && request.method === "GET") {
        return response.end(JSON.stringify([]));
      }
      if (request.url === "/session/status" && request.method === "GET") return response.end(JSON.stringify({}));
      if (request.url === "/session?directory=%2Ftmp" && request.method === "POST") {
        return response.end(JSON.stringify({ id: "health-session", title: "health", directory: "/tmp" }));
      }
      if (request.url === "/api/session/health-session/model" && request.method === "POST") {
        order.push("model");
        response.statusCode = 204;
        response.end();
        return;
      }
      if (request.url === "/session/health-session/prompt_async" && request.method === "POST") {
        order.push("prompt");
        return response.end(JSON.stringify({ accepted: true }));
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    }).listen(0);
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
    port = (server.address() as { port: number }).port;

    const adapter = new OpenCodeAdapter({ baseUrl: `http://127.0.0.1:${port}` });
    const result = await newOrResumeNamedSession(new Map([["opencode", adapter]]), {
      harness: "opencode",
      name: "health",
      cwd: "/tmp",
      message: "diagnose bounded telemetry",
      mode: "queue",
      model: "omniroute/subagent",
    });

    expect(result).toMatchObject({ ok: true, delivery: "accepted", sessionId: "health-session" });
    expect(order).toEqual(["model", "prompt"]);
  });

  it("does not send the first prompt when model selection fails", async () => {
    let promptCount = 0;
    server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/session?directory=%2Ftmp" && request.method === "GET") {
        return response.end(JSON.stringify([]));
      }
      if (request.url === "/session/status" && request.method === "GET") return response.end(JSON.stringify({}));
      if (request.url === "/session?directory=%2Ftmp" && request.method === "POST") {
        return response.end(JSON.stringify({ id: "health-session", title: "health", directory: "/tmp" }));
      }
      if (request.url === "/api/session/health-session/model" && request.method === "POST") {
        response.statusCode = 503;
        return response.end(JSON.stringify({ error: "model unavailable" }));
      }
      if (request.url === "/session/health-session/prompt_async" && request.method === "POST") {
        promptCount += 1;
        return response.end(JSON.stringify({ accepted: true }));
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    }).listen(0);
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
    port = (server.address() as { port: number }).port;

    const adapter = new OpenCodeAdapter({ baseUrl: `http://127.0.0.1:${port}` });
    const result = await newOrResumeNamedSession(new Map([["opencode", adapter]]), {
      harness: "opencode",
      name: "health",
      cwd: "/tmp",
      message: "diagnose bounded telemetry",
      mode: "queue",
      model: "omniroute/subagent",
    });

    expect(result).toMatchObject({ ok: false, delivery: "not_attempted", sessionId: "health-session" });
    expect(result.error).toContain("HTTP 503");
    expect(promptCount).toBe(0);
  });

  it("lists sessions within the requested directory", async () => {
    server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/session?directory=%2Ftmp%2Frepair" && request.method === "GET") {
        return response.end(JSON.stringify([{
          id: "existing-session",
          title: "repair_100",
          directory: "/tmp/repair",
          time: { created: 1, updated: 1 },
        }]));
      }
      if (request.url === "/session/status") return response.end(JSON.stringify({}));
      if (request.url === "/session/existing-session/message?limit=1") return response.end(JSON.stringify([]));
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    }).listen(0);
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
    port = (server.address() as { port: number }).port;

    const adapter = new OpenCodeAdapter({ baseUrl: `http://127.0.0.1:${port}` });
    expect(await adapter.listSessions({ cwd: "/tmp/repair" })).toMatchObject([
      { id: "existing-session", title: "repair_100", cwd: "/tmp/repair" },
    ]);
  });

  it("reads bounded native messages and preserves assistant JSON while truncating tool output", async () => {
    const plans = JSON.stringify({ plans: [{ plan_id: "observe" }, { plan_id: "repair" }, { plan_id: "verify" }] });
    server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/session/health/message?limit=3" && request.method === "GET") {
        return response.end(JSON.stringify([
          { info: { id: "user-1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "bounded telemetry" }] },
          { info: { id: "assistant-1", role: "assistant", time: { created: 2 } }, parts: [
            { type: "tool", tool: "shell", state: { input: { command: "inspect" }, output: "x".repeat(10000) } },
            { type: "text", text: plans },
          ] },
        ]));
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    }).listen(0);
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
    port = (server.address() as { port: number }).port;

    const adapter = new OpenCodeAdapter({ baseUrl: `http://127.0.0.1:${port}` });
    const messages = await adapter.getSessionMessages("health", 3);

    expect(messages).toHaveLength(2);
    expect(messages?.[1]).toMatchObject({ id: "assistant-1", role: "assistant", text: plans });
    expect(messages?.[1].parts.find((part) => part.type === "tool_result")?.output).toHaveLength(4096);
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
      if (request.url === "/session/child" && request.method === "GET") {
        return response.end(JSON.stringify({ id: "child", title: "Child", path: "/tmp/project", parentID: "parent" }));
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
