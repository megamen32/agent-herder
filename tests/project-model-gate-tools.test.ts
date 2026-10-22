import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";

import { registerSessionTools } from "../src/mcp/session-tools.js";
import { registerFleetNodeTools } from "../src/mesh/fleet-node.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import type { AutomationLaunchPolicy } from "../src/automation-launch-policy.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

const closers: Array<() => Promise<void>> = [];
const roots: string[] = [];

// The route key follows the temporary project directory, so the test never
// depends on a path that only exists on the production host.
let projectRoot = "";
let policy: AutomationLaunchPolicy;

async function makeProject(): Promise<void> {
  projectRoot = await mkdtemp(join(tmpdir(), "model-gate-project-"));
  roots.push(projectRoot);
  policy = {
    version: 1,
    allowedHarnesses: ["opencode"],
    preferredHarness: "opencode",
    models: { opencode: "omniroute/minimax-combo-m3.1" },
    projectRoutes: {
      [projectRoot]: { harnesses: ["opencode"], aliases: ["app-card"], deniedModels: ["model-b"] },
    },
  };
}

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sessionOf(cwd: string, id = "sess-1"): AgentSession {
  return {
    id, harness: "opencode", status: "idle", title: `Session ${id}`, cwd,
    lastActivity: "2026-09-06T02:00:00.000Z", model: "model-a", needsPermission: false,
    messageCount: 3, lastMessage: "done",
  };
}

async function connect(createSession: ReturnType<typeof vi.fn>, changeModel: ReturnType<typeof vi.fn>) {
  await makeProject();
  const session = sessionOf(projectRoot);
  const adapter: HarnessAdapter = {
    type: "opencode", name: "OpenCode Fixture",
    async init() {}, async listSessions() { return [session]; },
    async getSession(id) { return id === session.id ? session : null; },
    async getParent() { return null; }, async listChildren() { return []; },
    async listModels() { return ["model-a", "model-b"]; },
    async sendMessage() { return { ok: true }; }, async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
    async createSession(options: { name: string; cwd: string; model?: string }) {
      return createSession(options);
    },
    async changeModel(sessionId: string, model: string) {
      return changeModel(sessionId, model);
    },
  } as unknown as HarnessAdapter;
  const events = new HerderEventBus();
  const server = new McpServer({ name: "model-gate-test", version: "1" });
  registerSessionTools(server, {
    adapters: new Map([["opencode", adapter]]),
    jobs: new HerderJobRegistry(events),
    events,
    launchPolicy: async () => policy,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "model-gate-client", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

describe("the model gate of create_session and new_or_resume", () => {
  it("lets a permitted model reach the session", async () => {
    const createSession = vi.fn(async (options: { name: string; cwd: string; model?: string }) => ({
      ...sessionOf(options.cwd, `created-${options.name}`), model: options.model,
    }));
    const client = await connect(createSession, vi.fn(async () => ({ ok: true })));
    const result = await client.callTool({
      name: "create_session",
      arguments: { harness: "opencode", name: "app", cwd: projectRoot, model: "model-a" },
    });
    expect(result.isError).toBeFalsy();
    expect(createSession).toHaveBeenCalled();
  });

  it("refuses a denied model before the session is created", async () => {
    const createSession = vi.fn(async (options: { name: string; cwd: string; model?: string }) => ({
      ...sessionOf(options.cwd, `created-${options.name}`), model: options.model,
    }));
    const client = await connect(createSession, vi.fn(async () => ({ ok: true })));
    const result = await client.callTool({
      name: "create_session",
      arguments: { harness: "opencode", name: "app", cwd: projectRoot, model: "model-b" },
    });
    expect(result.isError).toBe(true);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("refuses a denied model of an aliased project", async () => {
    const createSession = vi.fn(async (options: { name: string; cwd: string; model?: string }) => ({
      ...sessionOf(options.cwd, `created-${options.name}`), model: options.model,
    }));
    const client = await connect(createSession, vi.fn(async () => ({ ok: true })));
    const result = await client.callTool({
      name: "create_session",
      arguments: { harness: "opencode", name: "app", cwd: projectRoot, model: "model-b" },
    });
    expect(result.isError).toBe(true);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("lets a project without a route through", async () => {
    const other = await mkdtemp(join(tmpdir(), "model-gate-other-"));
    roots.push(other);
    const createSession = vi.fn(async (options: { name: string; cwd: string; model?: string }) => ({
      ...sessionOf(options.cwd, `created-${options.name}`), model: options.model,
    }));
    const client = await connect(createSession, vi.fn(async () => ({ ok: true })));
    const result = await client.callTool({
      name: "create_session",
      arguments: { harness: "opencode", name: "other", cwd: other, model: "model-b" },
    });
    expect(result.isError).toBeFalsy();
    expect(createSession).toHaveBeenCalled();
  });

  it("refuses a denied model of new_or_resume", async () => {
    const createSession = vi.fn(async (options: { name: string; cwd: string; model?: string }) => ({
      ...sessionOf(options.cwd, `created-${options.name}`), model: options.model,
    }));
    const client = await connect(createSession, vi.fn(async () => ({ ok: true })));
    const result = await client.callTool({
      name: "new_or_resume",
      arguments: { harness: "opencode", name: "app", cwd: projectRoot, model: "model-b", message: "go" },
    });
    expect(result.isError).toBe(true);
    expect(createSession).not.toHaveBeenCalled();
  });
  it("refuses the default model of a project that forbids it", async () => {
    const createSession = vi.fn(async (options: { name: string; cwd: string; model?: string }) => ({
      ...sessionOf(options.cwd, `created-${options.name}`), model: options.model,
    }));
    const client = await connect(createSession, vi.fn(async () => ({ ok: true })));
    // The project now forbids the model the harness would use on its own.
    policy.projectRoutes![projectRoot]!.deniedModels = ["omniroute/minimax-combo-m3.1"];
    const result = await client.callTool({
      name: "create_session",
      arguments: { harness: "opencode", name: "app", cwd: projectRoot },
    });
    expect(result.isError).toBe(true);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("lets a session start when the default model of the project is allowed", async () => {
    const createSession = vi.fn(async (options: { name: string; cwd: string; model?: string }) => ({
      ...sessionOf(options.cwd, `created-${options.name}`), model: options.model,
    }));
    const client = await connect(createSession, vi.fn(async () => ({ ok: true })));
    const result = await client.callTool({
      name: "create_session",
      arguments: { harness: "opencode", name: "app", cwd: projectRoot },
    });
    expect(result.isError).toBeFalsy();
    expect(createSession).toHaveBeenCalled();
  });

  it("refuses a denied fallback model of new_or_resume", async () => {
    const createSession = vi.fn(async (options: { name: string; cwd: string; model?: string }) => ({
      ...sessionOf(options.cwd, `created-${options.name}`), model: options.model,
    }));
    const client = await connect(createSession, vi.fn(async () => ({ ok: true })));
    const result = await client.callTool({
      name: "new_or_resume",
      arguments: {
        harness: "opencode", name: "app", cwd: projectRoot, model: "model-a",
        fallbackModels: ["model-b"], message: "go",
      },
    });
    expect(result.isError).toBe(true);
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe("the model gate of change_model", () => {
  it("lets a permitted model through", async () => {
    const changeModel = vi.fn(async () => ({ ok: true }));
    const client = await connect(vi.fn(async () => sessionOf("/workspace/app")), changeModel);
    const result = await client.callTool({
      name: "change_model",
      arguments: { sessionId: "sess-1", harness: "opencode", model: "model-a" },
    });
    expect(result.isError).toBeFalsy();
    expect(changeModel).toHaveBeenCalled();
  });

  it("refuses a denied model of the project of the session", async () => {
    const changeModel = vi.fn(async () => ({ ok: true }));
    const client = await connect(vi.fn(async () => sessionOf("/workspace/app")), changeModel);
    const result = await client.callTool({
      name: "change_model",
      arguments: { sessionId: "sess-1", harness: "opencode", model: "model-b" },
    });
    expect(result.isError).toBe(true);
    expect(changeModel).not.toHaveBeenCalled();
  });
});

describe("the model gate of fleet_create_session", () => {
  function captureFleetTool(createSession: ReturnType<typeof vi.fn>) {
    const adapter = { type: "opencode", name: "OpenCode", createSession } as unknown as HarnessAdapter;
    let call: ((request: unknown) => Promise<unknown>) | undefined;
    registerFleetNodeTools({ registerTool: (name: string, _spec: unknown, handler: (request: unknown) => Promise<unknown>) => {
      if (name === "fleet_create_session") call = handler;
    } } as never, {
      adapters: new Map([["opencode", adapter]]),
      ownerJournal: { once: async (_request: unknown, run: () => Promise<unknown>) => run() },
      launchPolicy: async () => policy,
    } as never);
    return call!;
  }

  it("refuses a denied model before the session is created", async () => {
    await makeProject();
    const createSession = vi.fn(async () => ({ id: "native-id", cwd: projectRoot }));
    const call = captureFleetTool(createSession);
    await expect(call({
      inputId: "a".repeat(64), harness: "opencode", name: "app", cwd: projectRoot, model: "model-b",
    })).rejects.toThrow(/model_not_permitted_for_project/u);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("lets a permitted model through", async () => {
    await makeProject();
    const createSession = vi.fn(async () => ({ id: "native-id", cwd: projectRoot }));
    const call = captureFleetTool(createSession);
    const result = await call({
      inputId: "a".repeat(64), harness: "opencode", name: "app", cwd: projectRoot, model: "model-a",
    }) as { structuredContent?: { ok?: boolean } };
    expect(result.structuredContent?.ok).toBe(true);
    expect(createSession).toHaveBeenCalled();
  });
});
