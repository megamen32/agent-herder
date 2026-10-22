import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";

import { registerSessionTools } from "../src/mcp/session-tools.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { LocalHarnessMesh } from "../src/mesh/local.js";
import { GptAdminMesh } from "../src/mesh/gptadmin.js";
import { checkDeliveryModel, resolveSessionWorkDirectory } from "../src/project-model-delivery-gate.js";
import type { ProjectModelPolicy, ProjectModelPolicyState } from "../src/project-model-delivery-gate.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

const closers: Array<() => Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A project root that only exists in the temporary directory of the test. */
async function projectRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function sessionOf(cwd: string, id: string, harness = "opencode", meta?: Record<string, unknown>): AgentSession {
  return {
    id, harness, status: "running", title: `Session ${id}`, cwd,
    lastActivity: "2026-09-06T02:00:00.000Z", model: "model-a", needsPermission: false,
    messageCount: 3, lastMessage: "done", ...(meta ? { meta } : {}),
  } as AgentSession;
}

function adapterOf(sessions: AgentSession[], sendMessage: ReturnType<typeof vi.fn>): HarnessAdapter {
  return {
    type: "opencode", name: "Fixture",
    async init() {}, async listSessions() { return sessions; },
    async getSession(id) { return sessions.find((session) => session.id === id) ?? null; },
    async getParent() { return null; }, async listChildren() { return []; },
    async listModels() { return ["model-a", "model-b"]; },
    async sendMessage(id: string, options: { message: string }) { return sendMessage(id, options); },
    async sendActiveMessage(id: string, options: { message: string }) { return sendMessage(id, options); },
    async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
    async createSession(options: { name: string; cwd: string; model?: string }) {
      return sessionOf(options.cwd, `created-${options.name}`);
    },
    async changeModel() { return { ok: true }; },
  } as unknown as HarnessAdapter;
}

async function connect(sessions: AgentSession[], state: ProjectModelPolicyState, sendMessage: ReturnType<typeof vi.fn>) {
  const events = new HerderEventBus();
  const server = new McpServer({ name: "delivery-gate-test", version: "1" });
  registerSessionTools(server, {
    adapters: new Map([["opencode", adapterOf(sessions, sendMessage)]]),
    jobs: new HerderJobRegistry(events),
    events,
    deliveryPolicy: async () => state,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "delivery-gate-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

describe("the model gate of a delivery", () => {
  it("refuses a delivery into a project that denies the model the session would run on", async () => {
    const root = await projectRoot("delivery-gate-project-");
    const policy: ProjectModelPolicy = {
      models: { opencode: "model-b" },
      projectRoutes: { [root]: { deniedModels: ["model-b"] } },
    };
    const sendMessage = vi.fn(async () => ({ ok: true }));
    const client = await connect([sessionOf(root, "sess-a")], { kind: "valid", policy }, sendMessage);
    const result = await client.callTool({ name: "send_message", arguments: { sessionId: "sess-a", message: "work" } });
    expect(result.isError).toBe(true);
    expect(String((result.content as Array<{ text: string }>)[0]?.text)).toContain("model_not_permitted_for_project");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("lets a delivery into a project without a route through", async () => {
    const root = await projectRoot("delivery-gate-other-");
    const policy: ProjectModelPolicy = {
      models: { opencode: "model-b" },
      projectRoutes: { [await projectRoot("delivery-gate-restricted-")]: { deniedModels: ["model-b"] } },
    };
    const sendMessage = vi.fn(async () => ({ ok: true }));
    const client = await connect([sessionOf(root, "sess-b")], { kind: "valid", policy }, sendMessage);
    const result = await client.callTool({ name: "send_message", arguments: { sessionId: "sess-b", message: "work" } });
    expect(result.isError).toBeFalsy();
    expect(sendMessage).toHaveBeenCalled();
  });

  it("checks the model the delivery names", async () => {
    const root = await projectRoot("delivery-gate-named-");
    const policy: ProjectModelPolicy = { projectRoutes: { [root]: { deniedModels: ["model-b"] } } };
    const sendMessage = vi.fn(async () => ({ ok: true }));
    const client = await connect([sessionOf(root, "sess-c")], { kind: "valid", policy }, sendMessage);
    const refused = await client.callTool({ name: "deliver", arguments: { sessionId: "sess-c", message: "work", model: "model-b" } });
    expect(refused.isError).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
    const allowed = await client.callTool({ name: "deliver", arguments: { sessionId: "sess-c", message: "work", model: "model-a" } });
    expect(allowed.isError).toBeFalsy();
    expect(sendMessage).toHaveBeenCalled();
  });

  it("refuses every delivery while the policy document cannot be read", async () => {
    const root = await projectRoot("delivery-gate-unreadable-");
    const sendMessage = vi.fn(async () => ({ ok: true }));
    const client = await connect([sessionOf(root, "sess-e")], { kind: "invalid", error: "broken json" }, sendMessage);
    const result = await client.callTool({ name: "send_message", arguments: { sessionId: "sess-e", message: "work" } });
    expect(result.isError).toBe(true);
    expect(String((result.content as Array<{ text: string }>)[0]?.text)).toContain("model_not_permitted_for_project");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("refuses a delivery whose work directory is unknown", async () => {
    const policy: ProjectModelPolicy = {
      models: { opencode: "model-b" },
      projectRoutes: { [await projectRoot("delivery-gate-pseudo-")]: { deniedModels: ["model-b"] } },
    };
    const sendMessage = vi.fn(async () => ({ ok: true }));
    // A harness with one working directory for the whole runtime does not know
    // where its session works, so the project stays unknown.
    const client = await connect([sessionOf("/pseudo/project", "sess-d", "opencode", { workDirectory: "pseudo" })], { kind: "valid", policy }, sendMessage);
    const result = await client.callTool({ name: "send_message", arguments: { sessionId: "sess-d", message: "work" } });
    expect(result.isError).toBe(true);
    expect(String((result.content as Array<{ text: string }>)[0]?.text)).toContain("model_not_permitted_for_project");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("the model gate of a mesh delivery", () => {
  it("refuses the delivery, names the project and the model, and never retries it", async () => {
    const root = await projectRoot("mesh-gate-project-");
    const policy: ProjectModelPolicy = { models: { codex: "model-b" }, projectRoutes: { [root]: { deniedModels: ["model-b"] } } };
    const send = vi.fn(async (args: { inputId: string }) => ({ admitted: true, inputId: args.inputId, turnId: "turn-1" }));
    const mesh = new LocalHarnessMesh({
      hostId: "host-1",
      adapters: new Map([["codex", adapterOf([sessionOf(root, "sess-m", "codex")], vi.fn(async () => ({ ok: true })))]]),
      send,
      ledgerPath: join(root, "ledger.json"),
      deliveryPolicy: async () => ({ kind: "valid", policy }),
    });
    const request = {
      target: { hostId: "host-1", harness: "codex", nativeSessionId: "sess-m" },
      sender: { hostId: "host-2", harness: "codex", nativeSessionId: "peer" },
      inputId: "input-1", message: "work",
    };
    const receipt = await mesh.deliver(request);
    expect(receipt.state).toBe("not_attempted");
    expect(receipt.retryable).toBe(false);
    expect(receipt.reason).toContain("model_not_permitted_for_project");
    expect(receipt.reason).toContain("model-b");
    expect(receipt.reason).toContain(root);
    expect(send).not.toHaveBeenCalled();
    // The refusal is kept, so the same intent is never delivered again.
    expect((await mesh.deliver(request)).state).toBe("not_attempted");
    expect(send).not.toHaveBeenCalled();
  });

  it("delivers into a project that allows the model", async () => {
    const root = await projectRoot("mesh-gate-allowed-");
    const policy: ProjectModelPolicy = { models: { codex: "model-a" }, projectRoutes: { [root]: { deniedModels: ["model-b"] } } };
    const send = vi.fn(async (args: { inputId: string }) => ({ admitted: true, inputId: args.inputId, turnId: "turn-1" }));
    const mesh = new LocalHarnessMesh({
      hostId: "host-1",
      adapters: new Map([["codex", adapterOf([sessionOf(root, "sess-n", "codex")], vi.fn(async () => ({ ok: true })))]]),
      send,
      ledgerPath: join(root, "ledger.json"),
      deliveryPolicy: async () => ({ kind: "valid", policy }),
    });
    const receipt = await mesh.deliver({
      target: { hostId: "host-1", harness: "codex", nativeSessionId: "sess-n" },
      sender: { hostId: "host-2", harness: "codex", nativeSessionId: "peer" },
      inputId: "input-2", message: "work",
    });
    expect(receipt.state).toBe("admitted");
    expect(send).toHaveBeenCalled();
  });
});

describe("the model gate of a delivery to another machine", () => {
 const address = { hostId: "100", harness: "codex", nativeSessionId: "native-remote" };
 function hub(project: { launchCwd: string | null; currentCwd: string | null }) {
  return {
   discover: vi.fn(async () => ({ servers: [{ server_id: "mcp:shell:100:Herder", kind: "child_mcp", status: "online" }] })),
   schema: vi.fn(async () => ({ tools: [{ name: "mesh_snapshot" }, { name: "mesh_deliver" }] })),
   call: vi.fn(async (_target: string, name: string, args: Record<string, unknown>) => name === "mesh_snapshot"
    ? { hostId: "100", sessions: [{ address, project: { ...project, source: project.currentCwd ? "native" : "unverified" }, status: "running", title: "t", lastActivity: "now" }], harnesses: [], complete: true }
    : { state: "admitted", inputId: args.inputId, turnId: "turn", retryable: false }),
  };
 }

 it("refuses a delivery into a project of another machine that denies the model", async () => {
  const root = await projectRoot("remote-gate-project-");
  const policy: ProjectModelPolicy = { models: { codex: "model-b" }, projectRoutes: { [root]: { deniedModels: ["model-b"] } } };
  const h = hub({ launchCwd: root, currentCwd: null });
  const mesh = new GptAdminMesh(h as never, 5000, async () => ({ kind: "valid", policy }));
  await mesh.discover();
  const receipt = await mesh.deliver({ target: address, sender: { ...address, nativeSessionId: "source" }, inputId: "remote-1", message: "work" });
  expect(receipt.state).toBe("not_attempted");
  expect(receipt.retryable).toBe(false);
  expect(receipt.reason).toContain("model_not_permitted_for_project");
  expect(h.call.mock.calls.filter((call) => call[1] === "mesh_deliver")).toHaveLength(0);
 });

 it("refuses a delivery whose work place of another machine is unknown", async () => {
  const policy: ProjectModelPolicy = { models: { codex: "model-b" }, projectRoutes: { [await projectRoot("remote-gate-other-")]: { deniedModels: ["model-b"] } } };
  const h = hub({ launchCwd: null, currentCwd: null });
  const mesh = new GptAdminMesh(h as never, 5000, async () => ({ kind: "valid", policy }));
  await mesh.discover();
  const receipt = await mesh.deliver({ target: address, sender: { ...address, nativeSessionId: "source" }, inputId: "remote-2", message: "work" });
  expect(receipt.state).toBe("not_attempted");
  expect(receipt.reason).toContain("model_not_permitted_for_project");
  expect(h.call.mock.calls.filter((call) => call[1] === "mesh_deliver")).toHaveLength(0);
 });

 it("delivers into a project of another machine that allows the model", async () => {
  const root = await projectRoot("remote-gate-allowed-");
  const policy: ProjectModelPolicy = { models: { codex: "model-a" }, projectRoutes: { [root]: { deniedModels: ["model-b"] } } };
  const h = hub({ launchCwd: root, currentCwd: null });
  const mesh = new GptAdminMesh(h as never, 5000, async () => ({ kind: "valid", policy }));
  await mesh.discover();
  const receipt = await mesh.deliver({ target: address, sender: { ...address, nativeSessionId: "source" }, inputId: "remote-3", message: "work" });
  expect(receipt.state).toBe("admitted");
  expect(h.call.mock.calls.filter((call) => call[1] === "mesh_deliver")).toHaveLength(1);
 });
});

describe("the rules of the delivery gate", () => {
  it("keeps a project without a route unaffected and stays quiet without restrictions", () => {
    const policy: ProjectModelPolicy = { models: { opencode: "model-b" } };
    expect(() => checkDeliveryModel({ kind: "valid", policy }, { directory: "/nowhere", harness: "opencode" })).not.toThrow();
    expect(() => checkDeliveryModel({ kind: "absent" }, { directory: null, harness: "opencode" })).not.toThrow();
  });

  it("uses the model of the project route and the global model as the fallback", () => {
    const root = "/work/app";
    const policy: ProjectModelPolicy = {
      models: { opencode: "global-model" },
      projectRoutes: { [root]: { deniedModels: ["route-model"], models: { opencode: "route-model" } } },
    };
    expect(() => checkDeliveryModel({ kind: "valid", policy }, { directory: root, harness: "opencode" })).toThrow(/model_not_permitted_for_project/);
    const other: ProjectModelPolicy = { models: { opencode: "global-model" }, projectRoutes: { [root]: { deniedModels: ["other"] } } };
    expect(() => checkDeliveryModel({ kind: "valid", policy: other }, { directory: root, harness: "opencode" })).not.toThrow();
  });

  it("resolves the work place of a session: the declared one wins, a pseudo project has none", () => {
    expect(resolveSessionWorkDirectory({ id: "s", cwd: "/pseudo" }, "/declared")).toBe("/declared");
    expect(resolveSessionWorkDirectory({ id: "s", cwd: "/pseudo", meta: { workDirectory: "pseudo" } }, null)).toBeNull();
    expect(resolveSessionWorkDirectory({ id: "s", cwd: "/real/project" }, null)).toBe("/real/project");
    expect(resolveSessionWorkDirectory(null, null)).toBeNull();
  });
});
