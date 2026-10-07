import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createWebServer } from "../src/web/server.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function trackedNamedAdapter(harness: "opencode" | "hermes" | "zcode" | "fast-agent") {
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
        meta: { healthRecovery: options.healthRecovery === true },
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
    adapter: {
      ...tracked.adapter,
      getExecutionProfile() {
        return { provider: "openai-codex", reasoning: "high", toolsets: "terminal" };
      },
    },
    get createCalls() {
      return tracked.createCalls;
    },
  };
}

describe("health remediation route harness guard", () => {
  it("rejects a Hermes harness when the execution profile is canonical ZCode", async () => {
    const zcode = trackedNamedAdapter("zcode");
    const hermes = approvedHermesAdapter();
    const server = createWebServer({
      adapters: new Map([
        ["zcode", zcode.adapter],
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
        execution: { runtime: "zcode", provider: "account:zai-individual-coding-plan", model: "GLM-5.3-Flash", reasoning: "high", topic: "health" },
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.any(String) });
    expect(hermes.createCalls).toBe(0);
    expect(zcode.createCalls).toBe(0);
  });

  it("accepts the canonical ZCode health remediation request", async () => {
    const zcode = trackedNamedAdapter("zcode");
    const server = createWebServer({
      adapters: new Map([["zcode", zcode.adapter]]),
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
        harness: "zcode",
        name: "health_repair_inc-health-guard-2",
        cwd: "/tmp",
        message: "Repair the selected health incident and report useful progress.",
        execution: { runtime: "zcode", provider: "account:zai-individual-coding-plan", model: "GLM-5.3-Flash", reasoning: "high", topic: "health" },
      }),
    });

    expect(response.status).toBe(200);
    expect(zcode.createCalls).toBe(1);
  });


  it("accepts independent Fast Agent MiniMax remediation", async () => {
    const tracked = trackedNamedAdapter("fast-agent");
    const server = createWebServer({
      adapters: new Map([["fast-agent", tracked.adapter]]),
      converter: { async convert() { return { success: true, targetSessionId: "x", targetPath: "/tmp/x", messageCount: 0 }; } },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health/remediation`, {
      method: "POST",
      body: JSON.stringify({
        incident_id: "inc-fast-agent-minimax", plan_id: "repair", harness: "fast-agent",
        name: "health_fast_agent", cwd: "/tmp", message: "Read-only diagnostic canary.",
        execution: { runtime: "fast-agent", provider: "minimax", model: "MiniMax-M3.1-Flash-Preview", reasoning: "default", topic: "health" },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, model: "anthropic.MiniMax-M3.1-Flash-Preview" });
    expect(tracked.createCalls).toBe(1);
  });

  it("accepts the canonical Hermes health remediation request", async () => {
    const hermes = approvedHermesAdapter();
    const server = createWebServer({
      adapters: new Map([["hermes", hermes.adapter]]),
      converter: { async convert() { return { success: true, targetSessionId: "x", targetPath: "/tmp/x", messageCount: 0 }; } },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/health/remediation`, {
      method: "POST",
      body: JSON.stringify({
        incident_id: "inc-health-hermes-1",
        plan_id: "repair",
        harness: "hermes",
        name: "health_repair_inc-health-hermes-1",
        cwd: "/tmp",
        message: "Repair the selected health incident and report useful progress.",
        execution: { runtime: "hermes", provider: "openai-codex", model: "gpt-5.6-luna", reasoning: "high", topic: "health" },
      }),
    });

    expect(response.status).toBe(200);
    expect(hermes.createCalls).toBe(1);
  });

  it("preserves health source receipts and rejects malformed sources or control characters in session models", async () => {
    const zcode = trackedNamedAdapter("zcode");
    const server = createWebServer({
      adapters: new Map([["zcode", zcode.adapter]]),
      converter: { async convert() { return { success: true, targetSessionId: "x", targetPath: "/tmp/x", messageCount: 0 }; } },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const base = `http://127.0.0.1:${address.port}`;
    const healthBody = {
      incident_id: "inc-health-source-1",
      plan_id: "repair",
      harness: "zcode",
      name: "health_repair_inc-health-source-1",
      cwd: "/tmp",
      message: "Repair the selected health incident.",
      execution: { runtime: "zcode", provider: "account:zai-individual-coding-plan", model: "GLM-5.3-Flash", reasoning: "high", topic: "health" },
      sourceSessionId: "missing-source-session",
      sourceHarness: "zcode",
    };
    const blockedHealth = await fetch(`${base}/api/health/remediation`, { method: "POST", body: JSON.stringify(healthBody) });
    expect(blockedHealth.status).toBe(502);
    expect(await blockedHealth.json()).toMatchObject({ ok: false, error: expect.stringContaining("Исходный чат недоступен") });
    expect(zcode.createCalls).toBe(0);

    const malformedSource = await fetch(`${base}/api/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "zcode", name: "invalid-source", cwd: "/tmp", sourceHarness: "claude", sourceSessionId: "source" }),
    });
    expect(malformedSource.status).toBe(400);

    const badCreateModel = await fetch(`${base}/api/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "zcode", name: "invalid-model", cwd: "/tmp", model: "bad\u0001model" }),
    });
    expect(badCreateModel.status).toBe(400);

    const badResumeModel = await fetch(`${base}/api/sessions/new-or-resume`, {
      method: "POST",
      body: JSON.stringify({ harness: "zcode", name: "invalid-resume-model", cwd: "/tmp", message: "continue", model: "bad\u0001model" }),
    });
    expect(badResumeModel.status).toBe(400);
    expect(zcode.createCalls).toBe(0);
  });
});
