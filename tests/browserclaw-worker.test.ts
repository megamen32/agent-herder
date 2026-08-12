import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BROWSER_CANARY_TOKEN,
  BrowserClawBrowserDriver,
  BrowserClawWorkerError,
  type BrowserClawToolClient,
  BrowserClawWorker,
  BrowserClawWorkerLedger,
  browserWorkerPrompt,
  createBrowserClawWorkerServer,
} from "../src/browserclaw-worker.js";
import { BrowserWorkerReceiptSchema, BrowserWorkerRequestSchema, type BrowserWorkerRequest } from "../src/browser-worker.js";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function request(overrides: Record<string, unknown> = {}): BrowserWorkerRequest {
  return BrowserWorkerRequestSchema.parse({
    schema: "agent-herder.browser-worker.v1",
    worker: "mac-mini-browserclaw",
    target: "E-Frontier",
    templateId: "secretary.browser-canary.v1",
    sourceRefs: ["canary://source-1"],
    runId: "run-1",
    idempotencyId: "idempotency-1",
    deadlineMs: 5_000,
    ...overrides,
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("worker server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

function sendMcpResponse(response: ServerResponse, body: Record<string, unknown>, sessionId?: string, sse = false): void {
  const serialized = JSON.stringify(body);
  response.statusCode = 200;
  response.setHeader("content-type", sse ? "text/event-stream" : "application/json");
  if (sessionId) response.setHeader("mcp-session-id", sessionId);
  response.end(sse ? `data: ${serialized}\n\n` : serialized);
}

describe("provider-neutral BrowserClaw worker", () => {
  it("completes the safe browser canary and replays its durable receipt without a second driver call", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-browserclaw-worker-canary-"));
    roots.push(root);
    const ledgerPath = join(root, "worker-ledger.json");
    const canaryRequest = request({ idempotencyId: "canary-replay", runId: "canary-run" });
    let firstDriverCalls = 0;
    let replayDriverCalls = 0;

    const firstWorker = new BrowserClawWorker(new BrowserClawWorkerLedger(ledgerPath), {
      async execute(input, deadlineAt) {
        firstDriverCalls += 1;
        expect(input).toEqual(canaryRequest);
        expect(deadlineAt).toBeGreaterThan(Date.now());
      },
    });

    const canaryPrompt = browserWorkerPrompt(canaryRequest.templateId);
    expect(canaryPrompt).not.toContain(BROWSER_CANARY_TOKEN);
    expect(canaryPrompt).toContain("объединением двух частей");
    expect(canaryPrompt).toMatch(/не вызывай внешние инструменты/i);

    const firstReceipt = await firstWorker.dispatch(canaryRequest);
    BrowserWorkerReceiptSchema.parse(firstReceipt);
    expect(firstReceipt).toMatchObject({
      worker: "mac-mini-browserclaw",
      target: "E-Frontier",
      templateId: "secretary.browser-canary.v1",
      runId: "canary-run",
      idempotencyId: "canary-replay",
      status: "completed",
    });
    expect(firstReceipt.receiptRef).toMatch(/^browserclaw\.receipt\.[A-Za-z0-9-]+$/);

    const replayWorker = new BrowserClawWorker(new BrowserClawWorkerLedger(ledgerPath), {
      async execute() {
        replayDriverCalls += 1;
      },
    });
    const replayReceipt = await replayWorker.dispatch(canaryRequest);

    expect(replayReceipt).toEqual(firstReceipt);
    expect(firstDriverCalls).toBe(1);
    expect(replayDriverCalls).toBe(0);
  });

  it("rejects a conflicting reuse of an idempotency key before calling the driver again", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-browserclaw-worker-conflict-"));
    roots.push(root);
    let driverCalls = 0;
    const worker = new BrowserClawWorker(new BrowserClawWorkerLedger(join(root, "worker-ledger.json")), {
      async execute() {
        driverCalls += 1;
      },
    });
    const originalRequest = request({ idempotencyId: "conflict-key", runId: "original-run" });

    await worker.dispatch(originalRequest);
    await expect(worker.dispatch(request({ idempotencyId: "conflict-key", runId: "different-run" }))).rejects.toMatchObject({ statusCode: 409 });
    expect(driverCalls).toBe(1);
  });

  it("requires the configured bearer token before accepting a canary wake", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-browserclaw-worker-auth-"));
    roots.push(root);
    let driverCalls = 0;
    const worker = new BrowserClawWorker(new BrowserClawWorkerLedger(join(root, "worker-ledger.json")), {
      async execute() {
        driverCalls += 1;
      },
    });
    const base = await listen(createBrowserClawWorkerServer({
      host: "127.0.0.1",
      port: 0,
      token: "worker-test-token",
      worker,
    }));
    const body = JSON.stringify(request({ idempotencyId: "http-auth-canary" }));
    const endpoint = `${base}/browser-wake`;

    const missingToken = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(missingToken.status).toBe(401);
    expect(await missingToken.json()).toEqual({ error: "unauthorized" });

    const wrongToken = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong-token" },
      body,
    });
    expect(wrongToken.status).toBe(401);
    expect(await wrongToken.json()).toEqual({ error: "unauthorized" });
    expect(driverCalls).toBe(0);

    const accepted = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer worker-test-token" },
      body,
    });
    expect(accepted.status).toBe(200);
    expect(BrowserWorkerReceiptSchema.parse(await accepted.json()).status).toBe("completed");
    expect(driverCalls).toBe(1);
  });

  it("returns validation errors for malformed or schema-invalid HTTP requests without dispatching", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-browserclaw-worker-validation-"));
    roots.push(root);
    let driverCalls = 0;
    const worker = new BrowserClawWorker(new BrowserClawWorkerLedger(join(root, "worker-ledger.json")), {
      async execute() {
        driverCalls += 1;
      },
    });
    const base = await listen(createBrowserClawWorkerServer({
      host: "127.0.0.1",
      port: 0,
      token: "worker-test-token",
      worker,
    }));
    const headers = { "content-type": "application/json", authorization: "Bearer worker-test-token" };
    const endpoint = `${base}/browser-wake`;

    const malformed = await fetch(endpoint, { method: "POST", headers, body: "{" });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid_request" });

    const invalidRequest = { ...request({ idempotencyId: "invalid-request" }), deadlineMs: 0 };
    const invalid = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(invalidRequest),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_request" });
    expect(driverCalls).toBe(0);
  });

  it("serves an authenticated screenshot from the worker-owned debug page without dispatching a prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-browserclaw-worker-screenshot-"));
    roots.push(root);
    let driverCalls = 0;
    let screenshotCalls = 0;
    const png = Buffer.from("fake-png-bytes");
    const driver = {
      async execute() {
        driverCalls += 1;
      },
      async captureScreenshot(deadlineAt: number) {
        screenshotCalls += 1;
        expect(deadlineAt).toBeGreaterThan(Date.now());
        return { mimeType: "image/png", data: png.toString("base64") };
      },
    };
    const worker = new BrowserClawWorker(new BrowserClawWorkerLedger(join(root, "worker-ledger.json")), driver);
    const base = await listen(createBrowserClawWorkerServer({
      host: "127.0.0.1",
      port: 0,
      token: "worker-test-token",
      worker,
    }));

    const unauthorized = await fetch(`${base}/debug/screenshot`);
    expect(unauthorized.status).toBe(401);

    const accepted = await fetch(`${base}/debug/screenshot`, { headers: { authorization: "Bearer worker-test-token" } });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await accepted.arrayBuffer())).toEqual(png);
    expect(screenshotCalls).toBe(1);
    expect(driverCalls).toBe(0);
  });

  it("reuses one BrowserClaw session and target page across wakes", async () => {
    const targetUrl = "https://chatgpt.com/c/e-frontier";
    let clientFactoryCalls = 0;
    const openedPages: number[] = [];
    const clients = new Map<number, BrowserClawToolClient>();

    const driver = new BrowserClawBrowserDriver({
      endpoint: "http://127.0.0.1:9010/mcp",
      targetUrl,
      clientFactory: async () => {
        clientFactoryCalls += 1;
        const clientNumber = clientFactoryCalls;
        let snapshotCount = 0;
        let targetClicked = false;
        let promptSubmitted = false;
        let completionSnapshots = 0;
        const client = {
          async callTool(name: string, args: Record<string, unknown>): Promise<string> {
            if (name === "tabs" && args.action === "list") return targetClicked ? `[${10 + clientNumber}] ${targetUrl}` : "[1] chrome://newtab/";
            if (name === "tabs" && args.action === "new") {
              const page = 10 + clientNumber;
              openedPages.push(page);
              return `opened page ${page}`;
            }
            if (name === "snapshot") {
              if (promptSubmitted && completionSnapshots >= 2) {
                promptSubmitted = false;
                completionSnapshots = 0;
              }
              if (promptSubmitted) {
                completionSnapshots += 1;
                return completionSnapshots === 1 ? 'Остановить\ntextbox "Чат с ChatGPT" [ref=e7]' : 'textbox "Чат с ChatGPT" [ref=e7]';
              }
              snapshotCount += 1;
              return snapshotCount === 1
                ? 'link "ИИ Фронтир — вечер, закрепленный диалог" [ref=e8]'
                : [2, 4, 5].includes(snapshotCount)
                ? 'textbox "Чат с ChatGPT" [ref=e7]'
                : 'textbox "Чат с ChatGPT" [ref=e7]';
            }
            if (name === "grep") return `match ${BROWSER_CANARY_TOKEN}`;
            if (name === "act" && args.kind === "click") targetClicked = true;
            if (name === "act" && args.kind === "press") {
              promptSubmitted = true;
              completionSnapshots = 0;
            }
            return "ok";
          },
        };
        clients.set(clientNumber, client);
        return client;
      },
    });

    await driver.execute(request({ idempotencyId: "single-page-1" }), Date.now() + 5_000);
    await driver.execute(request({ idempotencyId: "single-page-2" }), Date.now() + 5_000);

    expect(clientFactoryCalls).toBe(1);
    expect(openedPages).toEqual([11]);
    expect(clients.size).toBe(1);
  });

  it("captures cached-page evidence directly when page snapshot validation is unsafe", async () => {
    const calls: string[] = [];
    let snapshotCalls = 0;
    let targetClicked = false;
    let promptSubmitted = false;
    let completionSnapshots = 0;
    const driver = new BrowserClawBrowserDriver({
      endpoint: "http://127.0.0.1:9010/mcp",
      targetUrl: "https://chatgpt.com/c/e-frontier",
      clientFactory: async () => ({
        async callTool(name: string, args: Record<string, unknown>): Promise<string> {
          calls.push(name);
          if (name === "tabs" && args.action === "list") return targetClicked ? "[12] https://chatgpt.com/c/e-frontier" : "[12] https://chatgpt.com/";
          if (name === "tabs" && args.action === "new") return "opened page 12";
          if (name === "snapshot") {
            if (promptSubmitted) {
              completionSnapshots += 1;
              return completionSnapshots === 1 ? 'Остановить\ntextbox "Чат с ChatGPT" [ref=e7]' : 'textbox "Чат с ChatGPT" [ref=e7]';
            }
            snapshotCalls += 1;
            return snapshotCalls === 1
              ? 'link "ИИ Фронтир — вечер, закрепленный диалог" [ref=e8]'
              : 'textbox "Чат с ChatGPT" [ref=e7]';
          }
          if (name === "grep") return `match ${BROWSER_CANARY_TOKEN}`;
          if (name === "act" && args.kind === "click") targetClicked = true;
          if (name === "act" && args.kind === "press") {
            promptSubmitted = true;
            completionSnapshots = 0;
          }
          return "ok";
        },
        async callToolImage(name: string): Promise<{ mimeType: "image/png"; data: string }> {
          calls.push(`image:${name}`);
          return { mimeType: "image/png", data: "c2NyZWVuc2hvdA==" };
        },
      }),
    });

    await driver.execute(request({ idempotencyId: "screenshot-cache", runId: "screenshot-cache-run" }), Date.now() + 5_000);
    const beforeScreenshot = calls.length;
    const screenshot = await driver.captureScreenshot(Date.now() + 5_000);

    expect(screenshot.mimeType).toBe("image/png");
    expect(calls.slice(beforeScreenshot)).toEqual(["image:screenshot"]);
  });

  it("captures failure evidence before dropping a timed-out BrowserClaw session", async () => {
    let imageCalls = 0;
    let snapshotCalls = 0;
    let targetClicked = false;
    const driver = new BrowserClawBrowserDriver({
      endpoint: "http://127.0.0.1:9010/mcp",
      targetUrl: "https://chatgpt.com/c/e-frontier",
      clientFactory: async () => ({
        async callTool(name: string, args: Record<string, unknown>): Promise<string> {
          if (name === "tabs" && args.action === "list") return targetClicked ? "[13] https://chatgpt.com/c/e-frontier" : "[13] https://chatgpt.com/";
          if (name === "tabs" && args.action === "new") return "opened page 13";
          if (name === "snapshot") {
            snapshotCalls += 1;
            return snapshotCalls === 1
              ? 'link "ИИ Фронтир — вечер, закрепленный диалог" [ref=e8]'
              : 'textbox "Чат с ChatGPT" [ref=e7]';
          }
          if (name === "act" && args.kind === "press") throw new BrowserClawWorkerError("worker_timeout", "simulated timeout");
          if (name === "act" && args.kind === "click") targetClicked = true;
          return "ok";
        },
        async callToolImage(): Promise<{ mimeType: "image/png"; data: string }> {
          imageCalls += 1;
          return { mimeType: "image/png", data: "ZmFpbHVyZS1zY3JlZW5zaG90" };
        },
      }),
    });

    await expect(driver.execute(request({ idempotencyId: "failure-screenshot", runId: "failure-screenshot-run" }), Date.now() + 5_000)).rejects.toMatchObject({ errorClass: "worker_timeout" });
    expect(imageCalls).toBe(2);
    await driver.captureScreenshot(Date.now() + 5_000);
    expect(imageCalls).toBe(2);
  });

  it("drives the safe canary through a fake Streamable-HTTP MCP target workflow", async () => {
    const sessionId = "fake-mcp-session";
    const targetUrl = "https://chatgpt.com/c/e-frontier";
    const protocolViolations: string[] = [];
    const toolCalls: Array<Record<string, unknown>> = [];
    let snapshotCalls = 0;
    let targetClicked = false;
    let promptSubmitted = false;
    let completionSnapshots = 0;
    const mcpServer = createServer(async (incoming, response) => {
      if (incoming.method !== "POST" || incoming.url !== "/mcp") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id?: number;
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      if (body.method !== "initialize" && incoming.headers["mcp-session-id"] !== sessionId) protocolViolations.push("missing-session");
      if (incoming.headers.authorization !== "Bearer fake-mcp-token") protocolViolations.push("missing-auth");

      if (body.method === "initialize") {
        sendMcpResponse(response, {
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake-browserclaw", version: "test" } },
        }, sessionId);
        return;
      }
      if (body.method === "notifications/initialized") {
        sendMcpResponse(response, { jsonrpc: "2.0", result: {} }, sessionId);
        return;
      }
      if (body.method !== "tools/call" || !body.params?.name) {
        sendMcpResponse(response, { jsonrpc: "2.0", id: body.id, error: { code: -32600, message: "invalid request" } }, sessionId, true);
        return;
      }

      const name = body.params.name;
      const args = body.params.arguments || {};
      if (name === "tabs") {
        toolCalls.push({ name, action: args.action });
        const text = args.action === "list" ? (targetClicked ? "[7] https://chatgpt.com/c/e-frontier" : "[9] https://chatgpt.com/") : "opened page 7";
        sendMcpResponse(response, {
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text }] },
        }, sessionId, true);
        return;
      }
      if (name === "snapshot") {
        toolCalls.push({ name, page: args.page, mode: args.mode, depth: args.depth, snapshotCalls });
        if (args.page === 9) {
          sendMcpResponse(response, {
            jsonrpc: "2.0",
            id: body.id,
            result: { isError: true, content: [{ type: "text", text: "page 9 is not owned by this agent" }] },
          }, sessionId, true);
          return;
        }
        snapshotCalls += 1;
        toolCalls[toolCalls.length - 1].snapshotCalls = snapshotCalls;
        if (promptSubmitted) completionSnapshots += 1;
        const text = snapshotCalls === 1
          ? 'link "ИИ Фронтир — вечер, закрепленный диалог" [ref=e8]'
          : snapshotCalls === 2
            ? "textbox [ref=e7]"
            : promptSubmitted && completionSnapshots === 1
              ? 'Остановить\ntextbox "Чат с ChatGPT" [ref=e7]'
              : "textbox \"Чат с ChatGPT\" [ref=e7]";
        sendMcpResponse(response, {
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text }] },
        }, sessionId, true);
        return;
      }
      if (name === "grep") {
        toolCalls.push({ name, page: args.page, pattern: args.pattern, over: args.over, limit: args.limit });
        sendMcpResponse(response, {
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: `match ${BROWSER_CANARY_TOKEN}` }] },
        }, sessionId, true);
        return;
      }
      if (name === "act") {
        const text = typeof args.text === "string" ? args.text : "";
        if (args.kind === "click") targetClicked = true;
        if (args.kind === "press") {
          promptSubmitted = true;
          completionSnapshots = 0;
        }
        toolCalls.push({
          name,
          page: args.page,
          kind: args.kind,
          ref: args.ref,
          key: args.key,
          hasFullCanaryToken: text.includes(BROWSER_CANARY_TOKEN),
          hasCanaryParts: text.includes("AGENT_HERDER_BROWSER_CANARY_") && text.includes("READY_8"),
          forbidsExternalTools: /не вызывай внешние инструменты/i.test(text),
        });
        sendMcpResponse(response, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "ok" }] } }, sessionId, true);
        return;
      }
      if (name === "wait") {
        toolCalls.push({ name, page: args.page, for: args.for, value: args.value });
        sendMcpResponse(response, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "waited" }] } }, sessionId, true);
        return;
      }
      sendMcpResponse(response, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unknown tool" } }, sessionId, true);
    });
    const base = await listen(mcpServer);

    await new BrowserClawBrowserDriver({ endpoint: `${base}/mcp`, token: "fake-mcp-token", targetUrl }).execute(
      request({ idempotencyId: "protocol-canary", runId: "protocol-run" }),
      Date.now() + 5_000,
    );

    expect(protocolViolations).toEqual([]);
    expect(toolCalls.map((call) => call.name)).toEqual(["tabs", "snapshot", "act", "tabs", "snapshot", "act", "act", "snapshot", "wait", "snapshot"]);
    expect(toolCalls[0]).toMatchObject({ name: "tabs", action: "new" });
    expect(toolCalls[1]).toMatchObject({ name: "snapshot", page: 7, mode: "full", depth: 100 });
    expect(toolCalls[2]).toMatchObject({ name: "act", page: 7, kind: "click", ref: "e8" });
    expect(toolCalls[3]).toMatchObject({ name: "tabs", action: "list" });
    expect(toolCalls[4]).toMatchObject({ name: "snapshot", page: 7, mode: "full", depth: 10 });
    expect(toolCalls[5]).toMatchObject({ name: "act", page: 7, kind: "type", ref: "e7", hasFullCanaryToken: false, hasCanaryParts: true, forbidsExternalTools: true });
    expect(toolCalls[6]).toMatchObject({ name: "act", page: 7, kind: "press", key: "Enter" });
    expect(toolCalls[7]).toMatchObject({ name: "snapshot", page: 7, snapshotCalls: 3 });
    expect(toolCalls[8]).toMatchObject({ name: "wait", page: 7, for: "time", value: 1000 });
    expect(toolCalls[9]).toMatchObject({ name: "snapshot", page: 7, snapshotCalls: 4 });
  });
});
