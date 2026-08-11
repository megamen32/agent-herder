import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createWebServer } from "../src/web/server.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function trackedNamedAdapter(harness: "opencode" | "hermes") {
  const sessions: AgentSession[] = [];
  let createCalls = 0;
  const adapter: HarnessAdapter = {
    type: harness,
    name: `Fake ${harness}`,
    async init() {},
    async listSessions() {
      return [...sessions];
    },
    async getSession(id) {
      return sessions.find((session) => session.id === id) || null;
    },
    async createSession(options) {
      createCalls += 1;
      const session: AgentSession = {
        id: `${harness}-${createCalls}`,
        harness,
        status: "idle",
        title: options.name,
        cwd: options.cwd,
        lastActivity: new Date().toISOString(),
        needsPermission: false,
      };
      sessions.push(session);
      return session;
    },
    async sendMessage() {
      return { ok: true };
    },
    async changeModel() {
      return { ok: true };
    },
    async stopSession() {
      return { ok: true };
    },
    async respondPermission() {
      return { ok: true };
    },
    async setPermissions() {
      return { ok: true };
    },
  };
  return {
    adapter,
    get createCalls() {
      return createCalls;
    },
  };
}

function approvedHermesAdapter() {
  const tracked = trackedNamedAdapter("hermes");
  return {
    ...tracked,
    adapter: {
      ...tracked.adapter,
      getExecutionProfile() {
        return { provider: "openai-codex", reasoning: "high", toolsets: "terminal" };
      },
    },
  };
}

describe("health remediation route harness guard", () => {
  it("rejects a Hermes harness when the execution profile is canonical OpenCode", async () => {
    const opencode = trackedNamedAdapter("opencode");
    const hermes = approvedHermesAdapter();
    const server = createWebServer({
      adapters: new Map([
        ["opencode", opencode.adapter],
        ["hermes", hermes.adapter],
      ]),
      converter: { async convert() { return { success: true, targetSessionId: "x", targetPath: "/tmp/x", messageCount: 0 }; } },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/health/remediation`, {
      method: "POST",
      body: JSON.stringify({
        incident_id: "inc-health-guard-1",
        plan_id: "repair",
        harness: "hermes",
        name: "health_repair_inc-health-guard-1",
        cwd: "/tmp",
        message: "Repair the selected health incident and report useful progress.",
        execution: { runtime: "opencode", provider: "openai-codex", model: "gpt-5.6-luna", reasoning: "high", topic: "health" },
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.any(String) });
    expect(hermes.createCalls).toBe(0);
    expect(opencode.createCalls).toBe(0);
  });

  it("still accepts the canonical OpenCode health remediation request", async () => {
    const opencode = trackedNamedAdapter("opencode");
    const server = createWebServer({
      adapters: new Map([["opencode", opencode.adapter]]),
      converter: { async convert() { return { success: true, targetSessionId: "x", targetPath: "/tmp/x", messageCount: 0 }; } },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/health/remediation`, {
      method: "POST",
      body: JSON.stringify({
        incident_id: "inc-health-guard-2",
        plan_id: "repair",
        harness: "opencode",
        name: "health_repair_inc-health-guard-2",
        cwd: "/tmp",
        message: "Repair the selected health incident and report useful progress.",
        execution: { runtime: "opencode", provider: "openai-codex", model: "gpt-5.6-luna", reasoning: "high", topic: "health" },
      }),
    });

    expect(response.status).toBe(200);
    expect(opencode.createCalls).toBe(1);
  });
});
