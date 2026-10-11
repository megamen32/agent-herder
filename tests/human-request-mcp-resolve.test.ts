import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import { HumanRequestRegistry } from "../src/human-request/index.js";
import { registerHumanRequestTools } from "../src/mcp/human-request-tools.js";
import type { ResumeReceipt, ResumeTransportRequest } from "../src/resume-transport.js";

const connected: Array<{ client: Client; server: McpServer }> = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(connected.splice(0).map(async ({ client, server }) => { await client.close(); await server.close(); }));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("native MCP human question and resolve", () => {
  it("answers a question once and reports the canonical resume receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-mcp-human-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const registry = new HumanRequestRegistry(join(root, "human-requests.json"));
    const invocations: ResumeTransportRequest[] = [];
    const humanResume = async (request: ResumeTransportRequest): Promise<ResumeReceipt> => {
      invocations.push(request);
      return { status: "accepted", target: request.target, result_ref: request.result_ref, receipt_ref: "agent-resume://opencode/1", idempotency_key: request.idempotency_key };
    };
    const server = new McpServer({ name: "human-request-fixture", version: "1.0.0" });
    registerHumanRequestTools(server, registry, { humanResume });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "human-request-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(clientTransport);
    connected.push({ client, server });

    const created = await client.callTool({
      name: "human_request_create",
      arguments: {
        kind: "user", harness: "opencode", sessionId: "ses_incident", cwd: "/workspace/incident",
        message: "Инцидент требует решения человека",
        notify: { project: "agent-herder", recipient: "me", kind: "ask.user", severity: "high", title: "Нужно решение человека" },
      },
    });
    const requestId = (created.structuredContent as { request: { requestId: string } }).request.requestId;
    expect(created.isError).not.toBe(true);

    const resolved = await client.callTool({ name: "human_request_resolve", arguments: { requestId, resolutionRef: "result://answer/1" } });
    const repeat = await client.callTool({ name: "human_request_resolve", arguments: { requestId, resolutionRef: "result://answer/2" } });

    const first = resolved.structuredContent as { resume: { status: string; idempotencyKey: string; duplicate: boolean; requestId: string } };
    const second = repeat.structuredContent as { resume: { status: string; idempotencyKey: string; duplicate: boolean; requestId: string } };
    expect(first.resume).toMatchObject({ status: "resumed", duplicate: false, requestId });
    expect(second.resume).toMatchObject({ status: "resumed", duplicate: true, idempotencyKey: first.resume.idempotencyKey });
    // One native resume of the exact session, under one stable key.
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.target).toMatchObject({ agent: "opencode", session_id: "ses_incident", cwd: "/workspace/incident" });
    await expect(registry.get(requestId)).resolves.toMatchObject({ status: "resumed", resultRef: "result://answer/1" });
  });

  it("keeps the legacy metadata-only create signature", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-mcp-human-legacy-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const registry = new HumanRequestRegistry(join(root, "human-requests.json"));
    const server = new McpServer({ name: "human-request-legacy", version: "1.0.0" });
    registerHumanRequestTools(server, registry, { humanResume: async (request) => ({ status: "accepted", target: request.target, result_ref: request.result_ref, receipt_ref: "agent-herder://opencode/1", idempotency_key: request.idempotency_key }) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "human-request-legacy-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(clientTransport);
    connected.push({ client, server });

    const created = await client.callTool({
      name: "human_request_create",
      arguments: { kind: "secret", harness: "opencode", sessionId: "ses_secret", cwd: "/workspace/incident" },
    });

    expect(created.isError).not.toBe(true);
    const payload = created.structuredContent as { request: { requestId: string; kind: string }; binding?: { question?: unknown } };
    expect(payload.request.kind).toBe("secret");
    expect(payload.binding?.question).toBeUndefined();
    expect(await registry.get(payload.request.requestId)).toMatchObject({ kind: "secret", status: "pending" });
  });

  it("resumes a Hermes request through its immutable locator", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-mcp-human-hermes-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const registry = new HumanRequestRegistry(join(root, "human-requests.json"));
    const invocations: ResumeTransportRequest[] = [];
    const server = new McpServer({ name: "human-request-hermes-fixture", version: "1.0.0" });
    registerHumanRequestTools(server, registry, { humanResume: async (request) => {
      invocations.push(request);
      return { status: "accepted", target: request.target, result_ref: request.result_ref, receipt_ref: "agent-herder://hermes/1", idempotency_key: request.idempotency_key };
    } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "human-request-hermes-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(clientTransport);
    connected.push({ client, server });

    const created = await client.callTool({
      name: "human_request_create",
      arguments: {
        kind: "user", harness: "hermes", sessionId: "agent:main:telegram:1",
        locator: { schema: "hermes.locator.v2", session_key: "agent:main:telegram:1", platform: "telegram", chat_id: "1", chat_type: "dm" },
        message: "Вопрос для Hermes",
        notify: { project: "agent-herder", recipient: "me", kind: "ask.user", severity: "high", title: "Вопрос" },
      },
    });
    const requestId = (created.structuredContent as { request: { requestId: string } }).request.requestId;
    const resolved = await client.callTool({ name: "human_request_resolve", arguments: { requestId, resolutionRef: "result://answer/1" } });

    expect((resolved.structuredContent as { resume: { status: string } }).resume.status).toBe("resumed");
    expect(invocations[0]?.target).toMatchObject({ agent: "hermes", locator: { session_key: "agent:main:telegram:1" } });
  });

  it("refuses an answer for a request without a resumable native target", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-mcp-human-hermes-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const registry = new HumanRequestRegistry(join(root, "human-requests.json"));
    const server = new McpServer({ name: "human-request-hermes-fixture", version: "1.0.0" });
    registerHumanRequestTools(server, registry, { humanResume: async (request) => ({ status: "accepted", target: request.target, result_ref: request.result_ref, receipt_ref: "agent-herder://hermes/1", idempotency_key: request.idempotency_key }) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "human-request-hermes-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(clientTransport);
    connected.push({ client, server });

    const created = await client.callTool({
      name: "human_request_create",
      arguments: {
        kind: "user", harness: "fast-agent", sessionId: "fa-session-1",
        message: "Вопрос без нативного возобновления",
        notify: { project: "agent-herder", recipient: "me", kind: "ask.user", severity: "high", title: "Вопрос" },
      },
    });
    const requestId = (created.structuredContent as { request: { requestId: string } }).request.requestId;
    const resolved = await client.callTool({ name: "human_request_resolve", arguments: { requestId, resolutionRef: "result://answer/1" } });

    expect(resolved.isError).toBe(true);
    await expect(registry.get(requestId)).resolves.toMatchObject({ status: "pending" });
  });
});