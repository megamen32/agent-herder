import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, expect, it, vi } from "vitest";
import { HumanRequestRegistry } from "../src/human-request/index.js";
import { registerHumanRequestTools } from "../src/mcp/human-request-tools.js";
import { createPermissionHumanQuestion, createPermissionNoticeObserver, permissionReplyContextRef, readCanonicalNoticePermissionAnswer } from "../src/permission-control/notice-bridge.js";
import { SessionSupervisor } from "../src/session-supervisor.js";
import type { AgentSession, HarnessAdapter, HarnessPermissionState, SessionMessageView } from "../src/types/index.js";
import { createWebServer } from "../src/web/server.js";

const connected: Array<{ client: Client; server: McpServer }> = [];
const servers: Server[] = [];
const roots: string[] = [];
const oldAskHumanEnvFile = process.env.ASK_HUMAN_ENV_FILE;
const oldNoticeProducerBindingsFile = process.env.AGENT_HERDER_NOTICE_PRODUCER_BINDINGS_FILE;

function nativePermissionReceipt(requestId: string, session: AgentSession, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "ask_human.response.v1", request_id: requestId, state: "pending", kind: "user",
    project: "test-project", recipient: "test-recipient", mode: "choice",
    choices: [{ value: "allow", label: "Разрешить" }, { value: "deny", label: "Запретить" }],
    native_harness: session.harness,
    native_session_id: session.id, native_cwd: session.cwd,
    telegram: { status: "sent", chat_id: "fixture-only", message_id: 42 },
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(connected.splice(0).map(async ({ client, server }) => { await client.close(); await server.close(); }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (oldAskHumanEnvFile === undefined) delete process.env.ASK_HUMAN_ENV_FILE;
  else process.env.ASK_HUMAN_ENV_FILE = oldAskHumanEnvFile;
  if (oldNoticeProducerBindingsFile === undefined) delete process.env.AGENT_HERDER_NOTICE_PRODUCER_BINDINGS_FILE;
  else process.env.AGENT_HERDER_NOTICE_PRODUCER_BINDINGS_FILE = oldNoticeProducerBindingsFile;
});

it("creates one exact, redacted Notice binding per pending native permission", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-permission-notice-")); roots.push(root);
  const envFile = join(root, "qa-ask-human.env");
  const productionEnvFile = join(root, "production-ask-human.env");
  const bindingsFile = join(root, "producer-bindings.json");
  await writeFile(envFile, "ASK_HUMAN_URL=https://notice.test/v1/human-requests\nNOTIFY_CENTER_TOKEN=qa-fixture-token\nNOTIFY_CENTER_PROJECT=test-project\nNOTIFY_CENTER_RECIPIENT=test-recipient\nASK_HUMAN_ALLOWED_ACTORS=telegram:540308572\n", { mode: 0o600 });
  await writeFile(productionEnvFile, "ASK_HUMAN_URL=https://notice.test/v1/human-requests\nNOTIFY_CENTER_TOKEN=production-fixture-token\nNOTIFY_CENTER_PROJECT=agent-herder\nNOTIFY_CENTER_RECIPIENT=me\nASK_HUMAN_ALLOWED_ACTORS=telegram:540308572\n", { mode: 0o600 });
  await writeFile(bindingsFile, JSON.stringify({ version: 1, bindings: [{ target: { hostId: "host-test", harness: "opencode", sessionId: "s-1" }, askHumanEnvFile: envFile }] }), { mode: 0o600 });
  await chmod(envFile, 0o600); await chmod(bindingsFile, 0o600);
  process.env.ASK_HUMAN_ENV_FILE = productionEnvFile;
  process.env.AGENT_HERDER_NOTICE_PRODUCER_BINDINGS_FILE = bindingsFile;
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
  expect(a.request.notify).toMatchObject({ project: "test-project", recipient: "test-recipient" });
  expect(a.binding.question.choices).toEqual([{ choice_id: "allow", label: "Разрешить" }, { choice_id: "deny", label: "Запретить" }]);
  expect(a.binding.question.message).toContain("Последнее сообщение пользователя: Run the check");
  expect(a.binding.question.message).toContain("Последний видимый ответ агента: Visible explanation");
  expect(a.binding.question.message).toContain("Команда: cat token=[скрыто]");
  expect(a.binding.question.message).not.toContain("private reasoning");
  expect(a.binding.question.message).not.toContain("should-not-leak");
  const records = await registry.list();
  expect(records).toHaveLength(1);
});

it("delivers the automatic permission question with the exact target's QA producer", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-permission-qa-observer-")); roots.push(root);
  const qaFile = join(root, "qa-ask-human.env");
  const productionEnvFile = join(root, "production-ask-human.env");
  const bindingsFile = join(root, "producer-bindings.json");
  await writeFile(qaFile, "ASK_HUMAN_URL=https://notice.test/v1/human-requests\nNOTIFY_CENTER_TOKEN=qa-fixture-token\nNOTIFY_CENTER_PROJECT=test-project\nNOTIFY_CENTER_RECIPIENT=test-recipient\nASK_HUMAN_ALLOWED_ACTORS=telegram:540308572\n", { mode: 0o600 });
  await writeFile(productionEnvFile, "ASK_HUMAN_URL=https://notice.test/v1/human-requests\nNOTIFY_CENTER_TOKEN=production-fixture-token\nNOTIFY_CENTER_PROJECT=agent-herder\nNOTIFY_CENTER_RECIPIENT=me\nASK_HUMAN_ALLOWED_ACTORS=telegram:540308572\n", { mode: 0o600 });
  await writeFile(bindingsFile, JSON.stringify({ version: 1, bindings: [{ target: { hostId: "host-test", harness: "opencode", sessionId: "s-qa-auto" }, askHumanEnvFile: qaFile }] }), { mode: 0o600 });
  await chmod(qaFile, 0o600); await chmod(bindingsFile, 0o600);
  process.env.ASK_HUMAN_ENV_FILE = productionEnvFile;
  process.env.AGENT_HERDER_NOTICE_PRODUCER_BINDINGS_FILE = bindingsFile;

  const session: AgentSession = { id: "s-qa-auto", harness: "opencode", hostId: "host-test", cwd: root, title: "QA permission", status: "needs_input", needsPermission: true, lastActivity: new Date().toISOString() };
  const state: HarnessPermissionState = { target: { hostId: "host-test", harness: "opencode", sessionId: session.id }, scope: "session", currentMode: "ask", canSetMode: true, supportedModes: ["default"], pendingRequests: [{ id: "p-qa-auto", canRespond: true, nativeMethod: "permission.request", command: "echo QA marker" }], observedAt: new Date().toISOString() };
  const registry = new HumanRequestRegistry(join(root, "human-requests.json"));
  let authorization: string | null = null;
  let postedBody: Record<string, unknown> | undefined;
  const observer = createPermissionNoticeObserver(registry, { fetchImpl: async (_input, init) => {
    authorization = new Headers(init?.headers).get("authorization");
    postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(nativePermissionReceipt(String(postedBody.request_id), session)), { status: 201 });
  } });
  const adapter: HarnessAdapter = {
    type: "opencode", name: "qa-fixture", async init() {},
    async getPermissionState() { return state; }, async getSession() { return session; }, async getSessionMessages() { return []; },
    async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
    async stopSession() { return { ok: true }; }, async sendMessage() { return { ok: true }; },
  };

  await observer.onEvent(adapter, { kind: "permission.requested", harness: "opencode", sessionId: session.id, permissionId: "p-qa-auto" });

  expect(authorization).toBe("Bearer qa-fixture-token");
  expect(postedBody).toMatchObject({ project: "test-project", recipient: "test-recipient", allowed_actors: ["telegram:540308572"] });
  expect((await registry.list())[0]?.notify).toMatchObject({ project: "test-project", recipient: "test-recipient" });
});

it("joins an exact permission event and initial pending snapshot to one durable Notice delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-permission-auto-notice-")); roots.push(root);
  const session: AgentSession = { id: "s-auto", harness: "codex", hostId: "host-test", cwd: root, title: "Fixture", status: "needs_input", needsPermission: true, lastActivity: new Date().toISOString() };
  const state: HarnessPermissionState = { target: { hostId: "host-test", harness: "codex", sessionId: session.id }, scope: "session", canSetMode: false,
    pendingRequests: [{ id: "native-p-auto", canRespond: true, nativeMethod: "item/commandExecution/requestApproval", command: "printf safe" }], observedAt: new Date().toISOString() };
  let listener: ((event: HarnessEvent) => void) | undefined;
  let stateReads = 0;
  const posts: Array<{ body: any; key: string }> = [];
  const registry = new HumanRequestRegistry(join(root, "human-requests.json"));
  const observer = createPermissionNoticeObserver(registry, {
    loadProducer: async () => ({ endpoint: "https://notice.test/v1/human-requests", token: "fixture-token", project: "test-project", recipient: "test-recipient", allowedActors: ["fixture:only"], source: "ask_human_env" }),
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      posts.push({ body, key: new Headers(init?.headers).get("idempotency-key") || "" });
      return new Response(JSON.stringify(nativePermissionReceipt(body.request_id, session)), { status: 201 });
    },
  });
  const adapter: HarnessAdapter = {
    type: "codex", name: "fixture", async init() {},
    subscribeEvents(handler) { listener = handler; return () => { listener = undefined; }; },
    async listSessions() { return [session]; }, async getSession() { return session; },
    async getPermissionState() { stateReads += 1; return state; },
    async getSessionMessages() { return [
      { id: "u1", role: "user", text: "Check this", parts: [{ type: "text", text: "Check this" }] },
      { id: "a1", role: "assistant", text: "thinking secret=hidden", parts: [{ type: "thinking", text: "hidden reasoning" }, { type: "text", text: "Visible explanation" }] },
    ]; },
    async sendMessage() { return { ok: true }; }, async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
  };
  const supervisor = new SessionSupervisor(new Map([["codex", adapter]]), { async convert() { return { success: true }; } } as any, undefined, { permissionNoticeObserver: observer });
  const stop = supervisor.startObservation(60_000);
  try {
    const requested: HarnessEvent = { kind: "permission.requested", harness: "codex", sessionId: session.id, permissionId: "native-p-auto" };
    listener?.(requested);
    listener?.(requested);
    for (let attempt = 0; attempt < 100 && posts.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(posts).toHaveLength(1);
    for (let attempt = 0; attempt < 100 && (await registry.list()).length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posts).toHaveLength(1);
    const [record] = await registry.list();
    expect(record).toMatchObject({ answerSource: "notice_question", contextRef: expect.any(String), noticeDelivery: { state: "accepted", noticeRequestId: record.requestId, deliveryStatus: "sent" } });
    expect(posts[0]?.key).toBe(`human-request:${record.requestId}`);
    expect(posts[0]?.body.request_id).toBe(record.requestId);
    expect(posts[0]?.body.native_target).toMatchObject({ harness: "codex", session_id: session.id, cwd: root });
    expect(posts[0]?.body.choices.map((choice: { value: string }) => choice.value)).toEqual(["allow", "deny"]);
    expect(posts[0]?.body.message).toContain("Visible explanation");
    expect(posts[0]?.body.message).not.toContain("hidden reasoning");
    expect(JSON.stringify(await registry.get(record.requestId))).not.toContain("Check this");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const readsBeforeRestart = stateReads;
    stop();
    const stopSameSupervisorRestart = supervisor.startObservation(60_000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stateReads).toBe(readsBeforeRestart);
    stopSameSupervisorRestart();
  } finally { stop(); }
});

it("retries a partial native inventory on the existing poll and shares one listSessions read", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-permission-partial-snapshot-")); roots.push(root);
  const session: AgentSession = { id: "s-snapshot-retry", harness: "codex", hostId: "host-test", cwd: root, title: "Fixture", status: "needs_input", needsPermission: true, lastActivity: new Date().toISOString() };
  const state: HarnessPermissionState = { target: { hostId: "host-test", harness: "codex", sessionId: session.id }, scope: "session", canSetMode: false,
    pendingRequests: [{ id: "p-snapshot-retry", canRespond: true, command: "printf safe" }], observedAt: new Date().toISOString() };
  let listReads = 0;
  let permissionReads = 0;
  let posts = 0;
  const registry = new HumanRequestRegistry(join(root, "human-requests.json"));
  const observer = createPermissionNoticeObserver(registry, {
    loadProducer: async () => ({ endpoint: "https://notice.test/v1/human-requests", token: "fixture-token", project: "test-project", recipient: "test-recipient", source: "ask_human_env" }),
    fetchImpl: async (_input, init) => {
      posts += 1;
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(nativePermissionReceipt(body.request_id, session)), { status: 201 });
    },
  });
  const adapter: HarnessAdapter = {
    type: "codex", name: "partial-snapshot-fixture", async init() {},
    async listSessions() { listReads += 1; return listReads === 1 ? [] : [session]; },
    getSessionSnapshotReceipt() { return { exhaustive: listReads >= 2, observedAt: new Date().toISOString(), source: "fixture", ...(listReads < 2 ? { reason: "fixture_partial_first_read" } : {}) }; },
    async getSession() { return session; }, async getPermissionState() { permissionReads += 1; return state; },
    async getSessionMessages() { return []; },
    async sendMessage() { return { ok: true }; }, async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
  };
  const supervisor = new SessionSupervisor(new Map([["codex", adapter]]), { async convert() { return { success: true }; } } as any, undefined,
    { permissionNoticeObserver: observer });
  const stop = supervisor.startObservation(1_000);
  try {
    for (let attempt = 0; attempt < 200 && posts === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(posts).toBe(1);
    expect(listReads).toBe(2);
    let [record] = await registry.list();
    for (let attempt = 0; attempt < 100 && record?.noticeDelivery?.state !== "accepted"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      [record] = await registry.list();
    }
    expect(record).toMatchObject({ target: { harness: "codex", sessionId: session.id }, noticeDelivery: { state: "accepted" } });
    const readsAtAdmission = listReads;
    const permissionReadsAtAdmission = permissionReads;
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    expect(listReads - readsAtAdmission).toBe(1);
    expect(permissionReads).toBe(permissionReadsAtAdmission);
  } finally { stop(); }
});

it("delivers a permission discovered after the startup scan when no native event arrives", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-permission-late-poll-")); roots.push(root);
  const session: AgentSession = { id: "s-late", harness: "opencode", hostId: "host-test", cwd: root, title: "Late request", status: "running", needsPermission: false, lastActivity: new Date().toISOString() };
  const state: HarnessPermissionState = { target: { hostId: "host-test", harness: "opencode", sessionId: session.id }, scope: "session", canSetMode: false,
    pendingRequests: [{ id: "p-late", canRespond: true, command: "printf safe" }], observedAt: new Date().toISOString() };
  let pending = false;
  let listReads = 0;
  let posts = 0;
  let producerReads = 0;
  const registry = new HumanRequestRegistry(join(root, "human-requests.json"));
  const observer = createPermissionNoticeObserver(registry, {
    loadProducer: async () => {
      producerReads += 1;
      if (producerReads === 1) throw new Error("producer_not_configured");
      return { endpoint: "https://notice.test/v1/human-requests", token: "fixture-token", project: "test-project", recipient: "test-recipient", source: "ask_human_env" };
    },
    fetchImpl: async (_input, init) => {
      posts += 1;
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(nativePermissionReceipt(body.request_id, session)), { status: 201 });
    },
  });
  const adapter: HarnessAdapter = {
    type: "opencode", name: "late-fixture", async init() {},
    async listSessions() { listReads += 1; return [{ ...session, status: pending ? "needs_input" : "running", needsPermission: pending,
      ...(pending ? { permissionDetails: { id: "p-late", type: "shell", description: "shell" } } : {}) }]; },
    getSessionSnapshotReceipt() { return { exhaustive: true, observedAt: new Date().toISOString(), source: "fixture" }; },
    async getSession() { return session; }, async getPermissionState() { return state; }, async getSessionMessages() { return []; },
    async sendMessage() { return { ok: true }; }, async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
  };
  const supervisor = new SessionSupervisor(new Map([["opencode", adapter]]), { async convert() { return { success: true }; } } as any, undefined,
    { permissionNoticeObserver: observer });
  const stop = supervisor.startObservation(1_000);
  try {
    for (let attempt = 0; attempt < 100 && listReads === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(listReads).toBeGreaterThan(0);
    expect(posts).toBe(0);
    pending = true;
    for (let attempt = 0; attempt < 250 && posts === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(posts).toBe(1);
    expect(producerReads).toBeGreaterThanOrEqual(2);
    let [record] = await registry.list();
    for (let attempt = 0; attempt < 100 && record?.noticeDelivery?.state !== "accepted"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      [record] = await registry.list();
    }
    expect(record).toMatchObject({ target: { harness: "opencode", sessionId: session.id }, noticeDelivery: { state: "accepted" } });
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    expect(posts).toBe(1);
  } finally { stop(); }
});

it("uses the fast OpenCode active snapshot when the full session scan has not reached a late request", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-permission-active-poll-")); roots.push(root);
  const session: AgentSession = { id: "s-active-late", harness: "opencode", hostId: "host-test", cwd: root, title: "Active request", status: "needs_input", needsPermission: true,
    permissionDetails: { id: "p-active-late", type: "shell", description: "shell" }, lastActivity: new Date().toISOString() };
  const state: HarnessPermissionState = { target: { hostId: "host-test", harness: "opencode", sessionId: session.id }, scope: "session", canSetMode: false,
    pendingRequests: [{ id: "p-active-late", canRespond: true, command: "printf safe" }], observedAt: new Date().toISOString() };
  let activePending = false;
  let posts = 0;
  const registry = new HumanRequestRegistry(join(root, "human-requests.json"));
  const observer = createPermissionNoticeObserver(registry, {
    loadProducer: async () => ({ endpoint: "https://notice.test/v1/human-requests", token: "fixture-token", project: "test-project", recipient: "test-recipient", source: "ask_human_env" }),
    fetchImpl: async (_input, init) => {
      posts += 1;
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(nativePermissionReceipt(body.request_id, session)), { status: 201 });
    },
  });
  const adapter: HarnessAdapter = {
    type: "opencode", name: "active-fixture", async init() {},
    async listSessions() { return []; }, async listActiveSessions() { return activePending ? [session] : []; },
    getSessionSnapshotReceipt() { return { exhaustive: true, observedAt: new Date().toISOString(), source: "fixture" }; },
    async getSession() { return session; }, async getPermissionState() { return state; }, async getSessionMessages() { return []; },
    async sendMessage() { return { ok: true }; }, async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
  };
  const supervisor = new SessionSupervisor(new Map([["opencode", adapter]]), { async convert() { return { success: true }; } } as any, undefined,
    { permissionNoticeObserver: observer });
  const stop = supervisor.startObservation(1_000);
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posts).toBe(0);
    activePending = true;
    for (let attempt = 0; attempt < 250 && posts === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(posts).toBe(1);
    let [record] = await registry.list();
    for (let attempt = 0; attempt < 100 && record?.noticeDelivery?.state !== "accepted"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10)); [record] = await registry.list();
    }
    expect(record).toMatchObject({ target: { harness: "opencode", sessionId: session.id }, noticeDelivery: { state: "accepted" } });
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    expect(posts).toBe(1);
  } finally { stop(); }
});

it("fails closed on an ID-less permission event and freezes an ambiguous Notice POST as unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-permission-auto-unknown-")); roots.push(root);
  const session: AgentSession = { id: "s-unknown", harness: "codex", hostId: "host-test", cwd: root, title: "Fixture", status: "needs_input", needsPermission: true, lastActivity: new Date().toISOString() };
  const state: HarnessPermissionState = { target: { hostId: "host-test", harness: "codex", sessionId: session.id }, scope: "session", canSetMode: false,
    pendingRequests: [{ id: "native-p-unknown", canRespond: true }], observedAt: new Date().toISOString() };
  let listener: ((event: HarnessEvent) => void) | undefined;
  let posts = 0;
  const registry = new HumanRequestRegistry(join(root, "human-requests.json"));
  const observer = createPermissionNoticeObserver(registry, {
    loadProducer: async () => ({ endpoint: "https://notice.test/v1/human-requests", token: "fixture-token", project: "test-project", recipient: "test-recipient", source: "ask_human_env" }),
    fetchImpl: async (_input, init) => {
      posts += 1;
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(nativePermissionReceipt(body.request_id, session, { request_id: "mismatched-id" })), { status: 201 });
    },
  });
  const adapter: HarnessAdapter = {
    type: "codex", name: "fixture", async init() {}, subscribeEvents(handler) { listener = handler; return () => { listener = undefined; }; },
    async listSessions() { return []; }, async getSession() { return session; }, async getPermissionState() { return state; },
    async sendMessage() { return { ok: true }; }, async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
  };
  const supervisor = new SessionSupervisor(new Map([["codex", adapter]]), { async convert() { return { success: true }; } } as any, undefined, { permissionNoticeObserver: observer });
  const stop = supervisor.startObservation(60_000);
  try {
    listener?.({ kind: "permission.requested", harness: "codex", sessionId: session.id, nativeType: "requestApproval" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(posts).toBe(0);
    listener?.({ kind: "permission.requested", harness: "codex", sessionId: session.id, permissionId: "native-p-unknown" });
    for (let attempt = 0; attempt < 100 && posts === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    listener?.({ kind: "permission.requested", harness: "codex", sessionId: session.id, permissionId: "native-p-unknown" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posts).toBe(1);
    const [record] = await registry.list();
    expect(record.noticeDelivery).toMatchObject({ state: "unknown" });
    expect(record.noticeDelivery?.noticeRequestId).toBeUndefined();
    stop();
    const restarted = new SessionSupervisor(new Map([["codex", { ...adapter, async listSessions() { return [session]; } }]]), { async convert() { return { success: true }; } } as any, undefined,
      { permissionNoticeObserver: createPermissionNoticeObserver(new HumanRequestRegistry(join(root, "human-requests.json")), {
        loadProducer: async () => ({ endpoint: "https://notice.test/v1/human-requests", token: "fixture-token", project: "test-project", recipient: "test-recipient", source: "ask_human_env" }),
        fetchImpl: async (_input, init) => { posts += 1; const body = JSON.parse(String(init?.body)); return new Response(JSON.stringify(nativePermissionReceipt(body.request_id, session)), { status: 201 }); },
      }) });
    const stopRestarted = restarted.startObservation(60_000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(posts).toBe(1);
    stopRestarted();
  } finally { stop(); }
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

it("rejects a CWD change between initial and under-lock permission reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-permission-cwd-drift-")); roots.push(root);
  const session: AgentSession = { id: "s-cwd", harness: "codex", hostId: "host-test", cwd: root, title: "Fixture", status: "needs_input", needsPermission: true, lastActivity: new Date().toISOString() };
  const state: HarnessPermissionState = { target: { hostId: "host-test", harness: "codex", sessionId: session.id }, scope: "session", canSetMode: false,
    pendingRequests: [{ id: "p-cwd", canRespond: true }], observedAt: new Date().toISOString() };
  let sessionReads = 0;
  const adapter: HarnessAdapter = {
    type: "codex", name: "fixture", async init() {}, async getPermissionState() { return state; },
    async getSession() { sessionReads += 1; return { ...session, cwd: sessionReads === 1 ? root : `${root}-changed` }; },
    async sendMessage() { return { ok: true }; }, async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
  };
  const registry = new HumanRequestRegistry(join(root, "human-requests.json"));
  await expect(createPermissionHumanQuestion(adapter, registry, "codex", session.id, "p-cwd", {
    loadProducer: async () => ({ endpoint: "https://notice.test/v1/human-requests", token: "fixture-token", project: "test-project", recipient: "test-recipient", source: "ask_human_env" }),
  }, undefined, "automatic")).rejects.toThrow("native permission target changed before Notice request creation");
  expect(await registry.list()).toHaveLength(0);
});

it("uses the visible context from the exact under-lock permission recheck", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-permission-fresh-context-")); roots.push(root);
  const session: AgentSession = { id: "s-fresh-context", harness: "codex", hostId: "host-test", cwd: root, title: "Fixture", status: "needs_input", needsPermission: true, lastActivity: new Date().toISOString() };
  const state: HarnessPermissionState = { target: { hostId: "host-test", harness: "codex", sessionId: session.id }, scope: "session", canSetMode: false,
    pendingRequests: [{ id: "p-fresh-context", canRespond: true, command: "printf safe" }], observedAt: new Date().toISOString() };
  let messageReads = 0;
  const adapter: HarnessAdapter = {
    type: "codex", name: "fresh-context-fixture", async init() {},
    async getPermissionState() { return state; }, async getSession() { return session; },
    async getSessionMessages() {
      messageReads += 1;
      const text = messageReads === 1 ? "Earlier visible snapshot" : "Fresh visible under lock";
      return [{ id: `a${messageReads}`, role: "assistant", text, parts: [{ type: "text", text }] }];
    },
    async sendMessage() { return { ok: true }; }, async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
  };
  const registry = new HumanRequestRegistry(join(root, "human-requests.json"));
  const created = await createPermissionHumanQuestion(adapter, registry, "codex", session.id, "p-fresh-context", {
    loadProducer: async () => ({ endpoint: "https://notice.test/v1/human-requests", token: "fixture-token", project: "test-project", recipient: "test-recipient", source: "ask_human_env" }),
  });
  expect(messageReads).toBe(2);
  expect(created.binding.question?.message).toContain("Fresh visible under lock");
  expect(created.binding.question?.message).not.toContain("Earlier visible snapshot");
});

it("dispatches the canonical Notice answer to the exact native permission once", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-permission-callback-")); roots.push(root);
  const envFile = join(root, "qa-ask-human.env");
  const productionEnvFile = join(root, "production-ask-human.env");
  const bindingsFile = join(root, "producer-bindings.json");
  await writeFile(envFile, "ASK_HUMAN_URL=https://notice.test/v1/human-requests\nNOTIFY_CENTER_TOKEN=qa-fixture-token\nNOTIFY_CENTER_PROJECT=qa-project\nNOTIFY_CENTER_RECIPIENT=qa-recipient\nASK_HUMAN_ALLOWED_ACTORS=telegram:540308572\n", { mode: 0o600 });
  await writeFile(productionEnvFile, "ASK_HUMAN_URL=https://notice.test/v1/human-requests\nNOTIFY_CENTER_TOKEN=production-fixture-token\nNOTIFY_CENTER_PROJECT=agent-herder\nNOTIFY_CENTER_RECIPIENT=me\nASK_HUMAN_ALLOWED_ACTORS=telegram:540308572\n", { mode: 0o600 });
  await writeFile(bindingsFile, JSON.stringify({ version: 1, bindings: [{ target: { hostId: "host-test", harness: "opencode", sessionId: "s-2" }, askHumanEnvFile: envFile }] }), { mode: 0o600 });
  await chmod(envFile, 0o600); await chmod(bindingsFile, 0o600);
  process.env.ASK_HUMAN_ENV_FILE = productionEnvFile;
  process.env.AGENT_HERDER_NOTICE_PRODUCER_BINDINGS_FILE = bindingsFile;
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
    notify: { project: "qa-project", recipient: "qa-recipient", kind: "human_request", severity: "important", title: "Permission" },
  });
  const noticeAnswerFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(`https://notice.test/v1/human-requests/${request.requestId}/result`);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer qa-fixture-token");
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
