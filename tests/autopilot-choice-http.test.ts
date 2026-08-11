import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebServer } from "../src/web/server.js";
import { ChoiceRegistry } from "../src/autopilot/choice-registry.js";
import type { HarnessAdapter } from "../src/types/index.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("autopilot choice callback HTTP seam", () => {
  it("resumes the bound Codex session once and rejects a duplicate selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-choice-http-"));
    const calls: Array<{ id: string; options: { message: string; queue?: boolean } }> = [];
    const adapter: HarnessAdapter = {
      type: "codex",
      name: "Fake Codex",
      async init() {},
      async listSessions() { return []; },
      async getSession() { return null; },
      async sendMessage(id, options) {
        calls.push({ id, options });
        return { ok: true };
      },
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
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const url = `http://127.0.0.1:${address.port}/internal/autopilot/choices/select`;
    const body = JSON.stringify({ request_id: pending.requestId, choice_id: "inspect" });

    const first = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ request_id: pending.requestId, status: "resumed", choice_id: "inspect", session_id: "codex-session-42", resumed: true });
    expect(calls).toEqual([{ id: "codex-session-42", options: { message: "Inspect the exact failure.", queue: true } }]);

    const duplicate = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: pending.requestId, choice_id: "verify" }) });
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({ status: "resumed", duplicate: true, resumed: false });
    expect(calls).toHaveLength(1);
  });
});
