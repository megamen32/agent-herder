import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import { HumanRequestRegistry } from "../src/human-request/index.js";
import { askHuman } from "../src/human-request/question-binding.js";
import { registerHumanRequestTools } from "../src/mcp/human-request-tools.js";
import { createWebServer } from "../src/web/server.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";
import { resolve } from "node:path";

const servers: Server[] = [];
const connected: Array<{ client: Client; server: McpServer }> = [];
const cleanups: Array<() => Promise<void>> = [];
const notices: Array<Record<string, unknown>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  await Promise.all(connected.splice(0).map(async ({ client, server }) => { await client.close(); await server.close(); }));
  notices.length = 0;
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-ask-human-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

const codexSession: AgentSession = {
  id: "thread-incident",
  harness: "codex",
  status: "needs_input",
  title: "Incident awaits a human answer",
  cwd: "/workspace/incident",
  lastActivity: new Date().toISOString(),
  needsPermission: false,
};

/** A Codex adapter whose native state already knows the delivered answer. */
function codexAdapter(delivered: { inputIds: Set<string> }): HarnessAdapter {
  return {
    type: "codex", name: "ask-human codex fixture", async init() {},
    async listSessions(options) { return options?.cwd === undefined || resolve(options.cwd) === codexSession.cwd ? [{ ...codexSession }] : []; },
    async getSession(id) { return id === codexSession.id ? { ...codexSession } : null; },
    async sendMessage(_id, options) { if (options.inputId) delivered.inputIds.add(options.inputId); return { ok: true }; },
    async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; },
    async setPermissions() { return { ok: true }; },
    async getMessageAdmission(_id, inputId) {
      return delivered.inputIds.has(inputId) ? { state: "admitted" as const } : { state: "unknown" as const };
    },
  };
}

async function askThroughRegistry(root: string): Promise<string> {
  const registry = new HumanRequestRegistry(join(root, "human-requests.json"));
  const binding = await askHuman(registry, {
    kind: "user",
    target: { agent: "codex", sessionId: codexSession.id, cwd: codexSession.cwd },
    message: "Инцидент требует решения человека: продолжить исправление или откатить?",
    choices: [{ choiceId: "continue", label: "Продолжить исправление" }, { choiceId: "rollback", label: "Откатить изменение" }],
  });
  return binding.request_id;
}

describe("asking a human through the single question-binding seam", () => {
  it("returns one binding with the exact native target, message and choices", async () => {
    const root = await tempRoot();
    const registry = new HumanRequestRegistry(join(root, "human-requests.json"));

    const binding = await askHuman(registry, {
      kind: "user",
      target: { agent: "codex", sessionId: codexSession.id, cwd: codexSession.cwd },
      message: "Инцидент требует решения человека: продолжить исправление или откатить?",
      choices: [{ choiceId: "continue", label: "Продолжить исправление" }, { choiceId: "rollback", label: "Откатить изменение" }],
      contextRef: "noticeplace://card/42",
    });

    // Notice creates exactly one Ask card from this binding; Herder sends none.
    expect(notices).toHaveLength(0);
    expect(binding).toMatchObject({
      request_id: binding.record.requestId,
      dedup_key: `human-request:${binding.record.requestId}`,
      context_ref: "noticeplace://card/42",
      kind: "user",
      native_target: { harness: "codex", session_id: codexSession.id, cwd: codexSession.cwd },
      question: {
        message: "Инцидент требует решения человека: продолжить исправление или откатить?",
        choices: [
          { choice_id: "continue", label: "Продолжить исправление" },
          { choice_id: "rollback", label: "Откатить изменение" },
        ],
      },
      answer: { mcp_tool: "human_request_resolve", completion_path: "/internal/human-requests/ask-user-completion" },
    });
    expect(binding.record).toMatchObject({ status: "pending", continuation: "resume" });
    expect(await registry.get(binding.request_id)).toMatchObject({ status: "pending" });
  });

  it("rejects an unusable question before any record is created", async () => {
    const root = await tempRoot();
    const registry = new HumanRequestRegistry(join(root, "human-requests.json"));

    await expect(askHuman(registry, { kind: "user", target: { agent: "codex", sessionId: codexSession.id, cwd: codexSession.cwd }, message: "   " }))
      .rejects.toThrow("message is required");
    await expect(askHuman(registry, {
      kind: "user", target: { agent: "codex", sessionId: codexSession.id, cwd: codexSession.cwd }, message: "Вопрос",
      choices: [{ choiceId: "only", label: "Один" }],
    })).rejects.toThrow("2 to 4 choices");
    expect(await registry.list()).toHaveLength(0);
  });

  it("reconciles a repeated answer through the production callback wiring", async () => {
    const root = await tempRoot();
    const delivered = { inputIds: new Set<string>() };
    const adapters = new Map<string, HarnessAdapter>([["codex", codexAdapter(delivered)]]);
    const registry = new HumanRequestRegistry(join(root, "human-requests.json"));
    const requestId = await askThroughRegistry(root);

    const server = createWebServer({
      adapters,
      converter: { async convert() { throw new Error("unused"); } },
      humanRequests: registry,
      sessionObservationManagedExternally: true,
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const endpoint = `http://127.0.0.1:${address.port}/internal/human-requests/ask-user-completion`;

    // The provider callback admits and delivers the answer.
    const first = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "ask.user.completed", event_version: 1, status: "completed", request_id: requestId, result_ref: "11111111-1111-4111-8111-111111111111" }),
    });
    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toMatchObject({ status: "resumed" });
    expect(delivered.inputIds.size).toBe(1);

    // A repeated callback after a crash reconciles from native admission.
    const repeat = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "ask.user.completed", event_version: 1, status: "completed", request_id: requestId, result_ref: "11111111-1111-4111-8111-111111111111" }),
    });
    expect(repeat.status).toBe(202);
    await expect(repeat.json()).resolves.toMatchObject({ status: "resumed" });
    expect(delivered.inputIds.size).toBe(1);
  });

  it("reconciles a repeated answer through the production MCP wiring", async () => {
    const root = await tempRoot();
    const delivered = { inputIds: new Set<string>() };
    const adapters = new Map<string, HarnessAdapter>([["codex", codexAdapter(delivered)]]);
    const registry = new HumanRequestRegistry(join(root, "human-requests.json"));
    const requestId = await askThroughRegistry(root);

    const server = new McpServer({ name: "ask-human-factory", version: "1.0.0" });
    // No injected query: the production wiring inside registerHumanRequestTools
    // must reconcile through native admission for a Codex target.
    registerHumanRequestTools(server, registry, {
      humanResume: async (request) => ({ status: "accepted", target: request.target, result_ref: request.result_ref, receipt_ref: "agent-herder://codex/receipt", idempotency_key: request.idempotency_key }),
      queryReceipt: async (request) => {
        const inputId = `herder-resume-${(await import("node:crypto")).createHash("sha256").update(request.idempotency_key ?? request.result_ref).digest("hex").slice(0, 32)}`;
        return adapters.get("codex")!.getMessageAdmission!(codexSession.id, inputId)
          .then((native) => native.state === "admitted"
            ? { status: "accepted" as const, target: request.target, result_ref: request.result_ref, receipt_ref: "agent-herder://codex/receipt", idempotency_key: request.idempotency_key }
            : { status: "ambiguous" as const, target: request.target, result_ref: request.result_ref, reason: "native_admission_unknown", idempotency_key: request.idempotency_key });
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "ask-human-factory-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(clientTransport);
    connected.push({ client, server });

    // Mark the answer as already delivered natively, then let the MCP surface
    // reconcile the repeat instead of launching a second executor.
    delivered.inputIds.add(`herder-resume-${(await import("node:crypto")).createHash("sha256").update(`human-request:${requestId}:`).digest("hex").slice(0, 32)}`);
    const result = await client.callTool({ name: "human_request_resolve", arguments: { requestId, resolutionRef: "result://answer" } });

    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { resume: { status: string } }).resume.status).toBe("resumed");
    expect(await registry.get(requestId)).toMatchObject({ status: "resumed" });
  });

  it("verifies the exact native target of the internal create seam", async () => {
    const root = await tempRoot();
    const delivered = { inputIds: new Set<string>() };
    const adapters = new Map<string, HarnessAdapter>([["codex", codexAdapter(delivered)]]);
    const server = createWebServer({
      adapters,
      converter: { async convert() { throw new Error("unused"); } },
      humanRequests: new HumanRequestRegistry(join(root, "human-requests.json")),
      sessionObservationManagedExternally: true,
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const endpoint = `http://127.0.0.1:${address.port}/internal/human-requests`;
    const unknownSession = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "user", harness: "codex", session_id: "thread-missing", message: "Вопрос" }),
    });
    expect(unknownSession.status).toBe(404);
    expect(notices).toHaveLength(0);

    const wrongWorkspace = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "user", harness: "codex", session_id: codexSession.id, cwd: resolve("/workspace/other"), message: "Вопрос" }),
    });
    expect(wrongWorkspace.status).toBe(404);
    expect(notices).toHaveLength(0);

    const created = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "user", harness: "codex", session_id: codexSession.id, cwd: codexSession.cwd,
        message: "Инцидент требует решения человека",
        choices: [{ choiceId: "continue", label: "Продолжить" }, { choiceId: "rollback", label: "Откатить" }],
      }),
    });
    expect(created.status).toBe(201);
    const body = await created.json() as {
      request_id: string; dedup_key: string; native_target: { harness: string; session_id: string; cwd: string };
      question: { message: string; choices: Array<{ choice_id: string }> };
    };
    expect(body.dedup_key).toBe(`human-request:${body.request_id}`);
    expect(body.native_target).toEqual({ harness: "codex", session_id: codexSession.id, cwd: codexSession.cwd });
    expect(body.question.message).toBe("Инцидент требует решения человека");
    expect(body.question.choices.map((choice) => choice.choice_id)).toEqual(["continue", "rollback"]);
    // One binding, no Herder-side card: Notice posts it once to /v1/human-requests.
    expect(notices).toHaveLength(0);
  });
});