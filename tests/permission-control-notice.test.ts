import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, expect, it, vi } from "vitest";
import { HumanRequestRegistry } from "../src/human-request/index.js";
import { registerHumanRequestTools } from "../src/mcp/human-request-tools.js";
import { permissionReplyContextRef, readCanonicalNoticePermissionAnswer } from "../src/permission-control/notice-bridge.js";
import type { AgentSession, HarnessAdapter, HarnessPermissionState, SessionMessageView } from "../src/types/index.js";
import { createWebServer } from "../src/web/server.js";

const connected: Array<{ client: Client; server: McpServer }> = [];
const servers: Server[] = [];
const roots: string[] = [];
const oldAskHumanEnvFile = process.env.ASK_HUMAN_ENV_FILE;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(connected.splice(0).map(async ({ client, server }) => { await client.close(); await server.close(); }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (oldAskHumanEnvFile === undefined) delete process.env.ASK_HUMAN_ENV_FILE;
  else process.env.ASK_HUMAN_ENV_FILE = oldAskHumanEnvFile;
});

it("creates one exact, redacted Notice binding per pending native permission", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-permission-notice-")); roots.push(root);
  const envFile = join(root, "ask-human.env");
  await writeFile(envFile, "ASK_HUMAN_URL=https://notice.test/v1/human-requests\nNOTIFY_CENTER_TOKEN=test-token\nNOTIFY_CENTER_PROJECT=test-project\nNOTIFY_CENTER_RECIPIENT=test-recipient\n");
  process.env.ASK_HUMAN_ENV_FILE = envFile;
  const session: AgentSession = { id: "s-1", harness: "opencode", hostId: "host-test", cwd: root, title: "Fixture", status: "needs_input", needsPermission: true, lastActivity: new Date().toISOString() };
  const permission: HarnessPermissionState = { target: { hostId: "host-test", harness: "opencode", sessionId: "s-1" }, scope: "session", canSetMode: false, supportedModes: [], pendingRequests: [{ id: "p-1", canRespond: true, nativeMethod: "permission.respond", command: "cat token=shh", reason: "read requested file" }], observedAt: new Date().toISOString() };
  const messages: SessionMessageView[] = [
    { id: "u-1", role: "user", text: "Run the check", parts: [{ type: "text", text: "Run the check" }] },
    { id: "a-1", role: "assistant", text: "secret token=should-not-leak", parts: [{ type: "thinking", text: "private reasoning" }, { type: "text", text: "Visible explanation" }] },
  ];
  const adapter: HarnessAdapter = {
    type: "opencode", name: "fixture", async init() {},
    async getPermissionState() { return permission; },
    async getSession() { return session; },
    async getSessionMessages() { return messages; },
    async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
    async stopSession() { return { ok: true }; }, async sendMessage() { return { ok: true }; },
  };
  const registry = new HumanRequestRegistry(join(root, "human-requests.json"));
  const server = new McpServer({ name: "permission-notice-fixture", version: "1.0.0" });
  registerHumanRequestTools(server, registry, { adapters: new Map([["opencode", adapter]]), humanResume: async () => { throw new Error("native resume must not run"); } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "permission-notice-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(clientTransport); connected.push({ client, server });

  const invoke = () => client.callTool({ name: "human_request_create", arguments: {
    kind: "user", harness: "opencode", sessionId: "s-1", cwd: root, permissionRequestId: "p-1",
    notify: { project: "test-project", recipient: "test-recipient", kind: "human_request", severity: "important", title: "Permission" },
  } });
  const first = await invoke();
  const again = await invoke();
  expect(first.isError, JSON.stringify(first)).not.toBe(true); expect(again.isError, JSON.stringify(again)).not.toBe(true);
  const a = first.structuredContent as any; const b = again.structuredContent as any;
  expect(a.request.requestId).toBe(b.request.requestId);
  expect(a.binding.question.choices).toEqual([{ choice_id: "allow", label: "Разрешить" }, { choice_id: "deny", label: "Запретить" }]);
  expect(a.binding.question.message).toContain("Последнее сообщение пользователя: Run the check");
  expect(a.binding.question.message).toContain("Последний видимый ответ агента: Visible explanation");
  expect(a.binding.question.message).toContain("Команда: cat token=[скрыто]");
  expect(a.binding.question.message).not.toContain("private reasoning");
  expect(a.binding.question.message).not.toContain("should-not-leak");
  const records = await registry.list();
  expect(records).toHaveLength(1);
});

it("rechecks the exact pending native request under the creation lock before admitting a card", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-permission-stale-create-")); roots.push(root);
  const envFile = join(root, "ask-human.env");
  await writeFile(envFile, "ASK_HUMAN_URL=https://notice.test/v1/human-requests\nNOTIFY_CENTER_TOKEN=test-token\nNOTIFY_CENTER_PROJECT=test-project\nNOTIFY_CENTER_RECIPIENT=test-recipient\n");
  process.env.ASK_HUMAN_ENV_FILE = envFile;
  const session: AgentSession = { id: "s-stale", harness: "opencode", hostId: "host-test", cwd: root, title: "Fixture", status: "needs_input", needsPermission: true, lastActivity: new Date().toISOString() };
  let stateReads = 0;
  const adapter: HarnessAdapter = {
    type: "opencode", name: "fixture", async init() {},
    async getPermissionState() {
      stateReads += 1;
      return { target: { hostId: "host-test", harness: "opencode", sessionId: "s-stale" }, scope: "session", canSetMode: false, supportedModes: [],
        pendingRequests: stateReads === 1 ? [{ id: "p-stale", canRespond: true }] : [], observedAt: new Date().toISOString() };
    },
    async getSession() { return session; }, async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
    async stopSession() { return { ok: true }; }, async sendMessage() { return { ok: true }; },
  };
  const registry = new HumanRequestRegistry(join(root, "human-requests.json"));
  const server = new McpServer({ name: "permission-notice-stale-test", version: "1.0.0" });
  registerHumanRequestTools(server, registry, { adapters: new Map([["opencode", adapter]]), humanResume: async () => { throw new Error("unused"); } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "permission-notice-stale-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(clientTransport); connected.push({ client, server });

  const result = await client.callTool({ name: "human_request_create", arguments: {
    kind: "user", harness: "opencode", sessionId: "s-stale", cwd: root, permissionRequestId: "p-stale",
  } });
  expect(result.isError).toBe(true);
  expect(stateReads).toBeGreaterThanOrEqual(2);
  expect(await registry.list()).toHaveLength(0);
});

it("keeps typed permission routing refs within the Human Request opaque-reference limit", () => {
  expect(() => permissionReplyContextRef({
    hostId: "h".repeat(512), harness: "opencode", sessionId: "s-1", permissionRequestId: "p-1",
  })).toThrow("exceeds the Human Request context reference limit");
});

it("dispatches the canonical Notice answer to the exact native permission once", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-permission-callback-")); roots.push(root);
  const envFile = join(root, "ask-human.env");
  await writeFile(envFile, "ASK_HUMAN_URL=https://notice.test/v1/human-requests\nNOTIFY_CENTER_TOKEN=test-token\nNOTIFY_CENTER_PROJECT=test-project\nNOTIFY_CENTER_RECIPIENT=test-recipient\n");
  process.env.ASK_HUMAN_ENV_FILE = envFile;
  const session: AgentSession = { id: "s-2", harness: "opencode", hostId: "host-test", cwd: root, title: "Fixture", status: "needs_input", needsPermission: true, lastActivity: new Date().toISOString() };
  let pending = true;
  const permission: HarnessPermissionState = { target: { hostId: "host-test", harness: "opencode", sessionId: "s-2" }, scope: "session", canSetMode: false, supportedModes: [], pendingRequests: [], observedAt: new Date().toISOString() };
  const reply = vi.fn(async (_id: string, _requestId: string, _response: "allow" | "deny") => { pending = false; return { ok: true }; });
  const adapter: HarnessAdapter = {
    type: "opencode", name: "fixture", async init() {},
    async getPermissionState() { return { ...permission, pendingRequests: pending ? [{ id: "native-p-2", canRespond: true, nativeMethod: "permission.respond" }] : [] }; },
    async getSession() { return session; }, async respondPermission(...args: Parameters<NonNullable<HarnessAdapter["respondPermission"]>>) { return reply(...args); },
    async stopSession() { return { ok: true }; }, async sendMessage() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
  };
  const adapters = new Map([["opencode", adapter]]);
  const humanRequests = new HumanRequestRegistry(join(root, "human-requests.json"));
  const request = await humanRequests.create({
    kind: "user", answerSource: "notice_question", target: { harness: "opencode", sessionId: session.id, cwd: root },
    contextRef: permissionReplyContextRef({ hostId: "host-test", harness: "opencode", sessionId: session.id, permissionRequestId: "native-p-2" }),
    notify: { project: "test-project", recipient: "test-recipient", kind: "human_request", severity: "important", title: "Permission" },
  });
  const noticeAnswerFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(`https://notice.test/v1/human-requests/${request.requestId}/result`);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
    return new Response(JSON.stringify({ schema: "ask_human.result.v1", request_id: request.requestId, state: "resolved", kind: "user", result_ref: randomUUID(), answer: "allow", native: { harness: "opencode", session_id: session.id, cwd: root } }), { status: 200 });
  });
  await expect(readCanonicalNoticePermissionAnswer(request, noticeAnswerFetch)).resolves.toMatchObject({ answer: "allow", requestId: request.requestId });
  const humanResume = vi.fn(async () => { throw new Error("typed permission answers must not resume the session"); });
  const server = createWebServer({ adapters, converter: { async convert() { throw new Error("unused"); } }, humanRequests, humanResume: humanResume as any, noticeAnswerFetch, sessionObservationManagedExternally: true });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("server did not bind");
  const endpoint = `http://127.0.0.1:${address.port}/internal/human-requests/ask-user-completion`;
  const body = JSON.stringify({ event: "ask.user.completed", event_version: 1, status: "completed", request_id: request.requestId, result_ref: randomUUID() });
  const first = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body });
  const duplicate = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body });
  expect(first.status).toBe(202); expect(duplicate.status).toBe(202);
  await expect(first.json()).resolves.toMatchObject({ request_id: request.requestId, status: "resumed", continuation: "permission_reply" });
  expect(reply).toHaveBeenCalledTimes(1);
  expect(humanResume).not.toHaveBeenCalled();
  expect(reply.mock.calls[0]?.slice(0, 3)).toEqual([session.id, "native-p-2", "allow"]);
  expect(await humanRequests.get(request.requestId)).toMatchObject({ status: "resumed", resultRef: expect.any(String) });
});
