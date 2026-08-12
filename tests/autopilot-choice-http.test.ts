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
