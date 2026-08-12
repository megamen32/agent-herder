import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebServer } from "../src/web/server.js";
import { ChoiceRegistry } from "../src/autopilot/choice-registry.js";
import type { HarnessAdapter } from "../src/types/index.js";
import type { ResumeTransportRequest } from "../src/resume-transport.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("autopilot choice callback HTTP seam", () => {
  it("lists pending choices for the web inbox without exposing next goals", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-choice-http-list-"));
    const registry = new ChoiceRegistry(join(root, "choices.json"));
    const pending = await registry.create({
      harness: "codex",
      sessionId: "codex-web-session",
      turnId: "turn-web",
      cwd: "/workspace/web",
      choices: [
        { choiceId: "inspect", label: "Проверить логи", nextGoal: "Secret continuation prompt." },
        { choiceId: "retry", label: "Повторить", nextGoal: "Retry prompt." },
      ],
    });
    const server = createWebServer({
      adapters: new Map(),
      converter: { async convert() { throw new Error("unused"); } },
      choiceRegistry: registry,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/autopilot/choices?status=pending`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ choices: [{ requestId: pending.requestId, sessionId: "codex-web-session", harness: "codex", choices: [{ choiceId: "inspect", label: "Проверить логи" }, { choiceId: "retry", label: "Повторить" }] }] });
    expect(JSON.stringify(body)).not.toContain("Secret continuation prompt");
  });

  it("hands a Hermes selection to the polling plugin without invoking Agent Resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-choice-http-hermes-"));
    const registry = new ChoiceRegistry(join(root, "choices.json"));
    const pending = await registry.create({
      harness: "hermes",
      sessionId: "telegram:dm:42",
      turnId: "turn-hermes",
      cwd: "/workspace/hermes",
      choices: [
        { choiceId: "inspect", label: "Проверить", nextGoal: "Проверь состояние." },
        { choiceId: "retry", label: "Повторить", nextGoal: "Повтори проверку." },
      ],
    });
    const resume = vi.fn();
    const server = createWebServer({
      adapters: new Map(),
      converter: { async convert() { throw new Error("unused"); } },
      choiceRegistry: registry,
      choiceResume: resume,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const response = await fetch(`http://127.0.0.1:${address.port}/internal/autopilot/choices/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: pending.requestId, choice_id: "inspect" }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "resumed", resumed: true, transport: "hermes-plugin" });
    expect(resume).not.toHaveBeenCalled();
    await expect(registry.get(pending.requestId)).resolves.toMatchObject({ status: "resumed", nextGoal: "Проверь состояние." });
  });

  it("resumes an OpenCode-bound choice through agent-resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-choice-http-opencode-"));
    const registry = new ChoiceRegistry(join(root, "choices.json"));
    const pending = await registry.create({
      harness: "opencode",
      sessionId: "opencode-session-42",
      turnId: "turn-1",
      cwd: "/workspace/opencode",
      choices: [
        { choiceId: "inspect", label: "Inspect", nextGoal: "Inspect now." },
        { choiceId: "retry", label: "Retry", nextGoal: "Retry now." },
      ],
    });
    const resume = vi.fn(async (request: ResumeTransportRequest) => ({
      status: "accepted" as const,
      target: request.target,
      result_ref: request.result_ref,
      idempotency_key: request.idempotency_key,
      receipt_ref: "receipt-opencode",
    }));
    const server = createWebServer({
      adapters: new Map(),
      converter: { async convert() { throw new Error("unused"); } },
      choiceRegistry: registry,
      choiceResume: resume,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/autopilot/choices/select`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request_id: pending.requestId, choice_id: "inspect" }),
      });
      expect(response.status).toBe(202);
      expect(resume).toHaveBeenCalledWith(expect.objectContaining({
        target: { agent: "opencode", session_id: "opencode-session-42", cwd: "/workspace/opencode" },
      }));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("resumes a Claude Code-bound choice through agent-resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-choice-http-claude-"));
    const registry = new ChoiceRegistry(join(root, "choices.json"));
    const pending = await registry.create({
      harness: "claude",
      sessionId: "claude-session-42",
      turnId: "turn-claude-1",
      cwd: "/workspace/claude",
      choices: [
        { choiceId: "inspect", label: "Проверить", nextGoal: "Проверь состояние." },
        { choiceId: "retry", label: "Повторить", nextGoal: "Повтори проверку." },
      ],
    });
    const resume = vi.fn(async (request: ResumeTransportRequest) => ({
      status: "accepted" as const,
      target: request.target,
      result_ref: request.result_ref,
      idempotency_key: request.idempotency_key,
      receipt_ref: "receipt-claude",
    }));
    const server = createWebServer({
      adapters: new Map(),
      converter: { async convert() { throw new Error("unused"); } },
      choiceRegistry: registry,
      choiceResume: resume,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/autopilot/choices/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: pending.requestId, choice_id: "inspect" }),
    });
    expect(response.status).toBe(202);
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({
      target: { agent: "claude", session_id: "claude-session-42", cwd: "/workspace/claude" },
    }));
  });

  it("keeps bearer auth on the internal callback while allowing the same-origin web action", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-choice-http-auth-"));
    const registry = new ChoiceRegistry(join(root, "choices.json"));
    const pending = await registry.create({
      harness: "hermes",
      sessionId: "telegram:dm:web",
      turnId: "turn-web-auth",
      cwd: "/workspace/hermes",
      choices: [
        { choiceId: "continue", label: "Продолжить", nextGoal: "Продолжай." },
        { choiceId: "inspect", label: "Проверить", nextGoal: "Проверь." },
      ],
    });
    const server = createWebServer({
      adapters: new Map(),
      converter: { async convert() { throw new Error("unused"); } },
      choiceRegistry: registry,
      mcpAuthToken: "internal-secret",
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const body = JSON.stringify({ request_id: pending.requestId, choice_id: "continue" });
    const internal = await fetch(`http://127.0.0.1:${address.port}/internal/autopilot/choices/select`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(internal.status).toBe(401);
    const web = await fetch(`http://127.0.0.1:${address.port}/api/autopilot/choices/select`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(web.status).toBe(202);
    expect(await web.json()).toMatchObject({ status: "resumed", resumed: true, session_id: "telegram:dm:web" });
  });

  it("resumes the bound Codex session once through Agent Resume and rejects a duplicate selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-choice-http-"));
    const requests: ResumeTransportRequest[] = [];
    const adapter: HarnessAdapter = {
      type: "codex",
      name: "Fake Codex",
      async init() {},
      async listSessions() { return []; },
      async getSession() { return null; },
      async sendMessage() { return { ok: true }; },
      async stopSession() { return { ok: true }; },
      async respondPermission() { return { ok: true }; },
      async setPermissions() { return { ok: true }; },
    };
    const registry = new ChoiceRegistry(join(root, "choices.json"));
    const pending = await registry.create({
      sessionId: "codex-session-42",
      turnId: "turn-9",
      cwd: "/workspace",
      choices: [
        { choiceId: "inspect", label: "Inspect", nextGoal: "Inspect the exact failure." },
        { choiceId: "verify", label: "Verify", nextGoal: "Verify the repaired path." },
      ],
    });
    const server = createWebServer({
      adapters: new Map([["codex", adapter]]),
      converter: { async convert() { return { success: true, targetSessionId: "x", targetPath: "/tmp/x", messageCount: 0 }; } },
      choiceRegistry: registry,
      choiceResume: async (request) => {
        requests.push(request);
        return {
          status: "accepted",
          target: request.target,
          result_ref: request.result_ref,
          receipt_ref: "agent-resume://receipt/choice-1",
          idempotency_key: request.idempotency_key,
        };
      },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const url = `http://127.0.0.1:${address.port}/internal/autopilot/choices/select`;
    const body = JSON.stringify({ request_id: pending.requestId, choice_id: "inspect" });

    const first = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ request_id: pending.requestId, status: "resumed", choice_id: "inspect", session_id: "codex-session-42", resumed: true, transport: "agent-resume" });
    expect(requests).toHaveLength(1);

    const duplicate = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: pending.requestId, choice_id: "verify" }) });
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({ status: "resumed", duplicate: true, resumed: false });
    expect(requests).toHaveLength(1);
  });

  it("uses durable Agent Resume when the Codex session is absent from the in-memory adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-choice-http-agent-resume-"));
    const requests: ResumeTransportRequest[] = [];
    const registry = new ChoiceRegistry(join(root, "choices.json"));
    const pending = await registry.create({
      sessionId: "codex-cli-session-42",
      turnId: "turn-10",
      cwd: "/workspace/cli",
      choices: [
        { choiceId: "inspect", label: "Inspect", nextGoal: "Inspect the exact failure." },
        { choiceId: "verify", label: "Verify", nextGoal: "Verify the repaired path." },
      ],
    });
    const adapter: HarnessAdapter = {
      type: "codex",
      name: "Missing Codex session",
      async init() {},
      async listSessions() { return []; },
      async getSession() { return null; },
      async sendMessage() { return { ok: false, error: "Session not found" }; },
      async stopSession() { return { ok: true }; },
      async respondPermission() { return { ok: true }; },
      async setPermissions() { return { ok: true }; },
    };
    const server = createWebServer({
      adapters: new Map([["codex", adapter]]),
      converter: { async convert() { return { success: true, targetSessionId: "x", targetPath: "/tmp/x", messageCount: 0 }; } },
      choiceRegistry: registry,
      choiceResume: async (request) => {
        requests.push(request);
        return {
          status: "accepted",
          target: request.target,
          result_ref: request.result_ref,
          receipt_ref: "agent-resume://receipt/choice-42",
          idempotency_key: request.idempotency_key,
        };
      },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const response = await fetch(`http://127.0.0.1:${address.port}/internal/autopilot/choices/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: pending.requestId, choice_id: "inspect" }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "resumed", resumed: true, transport: "agent-resume" });
    expect(requests).toEqual([{
      target: { agent: "codex", session_id: "codex-cli-session-42", cwd: "/workspace/cli" },
      goal: "Inspect the exact failure.",
      prompt: "Inspect the exact failure.",
      result_ref: `agent-herder://autopilot/choice/${pending.requestId}`,
      idempotency_key: `${pending.requestId}:inspect`,
    }]);
    await expect(registry.get(pending.requestId)).resolves.toMatchObject({
      status: "resumed",
      resumeReceipt: {
        status: "accepted",
        idempotencyKey: `${pending.requestId}:inspect`,
        receiptRef: "agent-resume://receipt/choice-42",
      },
    });
  });

  it("recovers a manual choice from the durable receipt without relaunching", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-choice-http-recovery-"));
    const registry = new ChoiceRegistry(join(root, "choices.json"));
    const pending = await registry.create({
      sessionId: "codex-cli-session-recovery",
      turnId: "turn-recovery",
      cwd: "/workspace/recovery",
      choices: [
        { choiceId: "inspect", label: "Inspect", nextGoal: "Inspect the exact failure." },
        { choiceId: "verify", label: "Verify", nextGoal: "Verify the repaired path." },
      ],
    });
    const claimed = (await registry.claimForResume(pending.requestId, "inspect")).record;
    const resume = vi.fn();
    const query = vi.fn(async (request: ResumeTransportRequest) => ({
      status: "accepted" as const,
      target: request.target,
      result_ref: request.result_ref,
      receipt_ref: "agent-resume://receipt/recovered-choice",
      idempotency_key: request.idempotency_key,
    }));
    const server = createWebServer({
      adapters: new Map(),
      converter: { async convert() { return { success: true, targetSessionId: "x", targetPath: "/tmp/x", messageCount: 0 }; } },
      choiceRegistry: registry,
      choiceResume: resume,
      choiceQuery: query,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const response = await fetch(`http://127.0.0.1:${address.port}/internal/autopilot/choices/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: pending.requestId, choice_id: "inspect" }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "resumed", resumed: true, recovered: true, transport: "agent-resume" });
    expect(resume).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0].idempotency_key).toBe(claimed.idempotencyKey);
  });
});
