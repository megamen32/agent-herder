import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AutopilotSessionStore } from "../src/autopilot/session-store.js";
import { AutopilotPolicyStore } from "../src/autopilot/policy-store.js";
import { createDefaultAutopilotPolicy } from "../src/autopilot/policy.js";
import { createWebServer } from "../src/web/server.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("web autopilot session switch", () => {
  it("reports the installed defaults and durably toggles one exact session", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-web-autopilot-session-"));
    const path = join(root, "sessions.json");
    const store = new AutopilotSessionStore(path);
    const server = createWebServer({
      adapters: new Map(),
      converter: { async convert() { throw new Error("unused"); } },
      autopilotSessionStore: store,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const base = `http://127.0.0.1:${address.port}/api/autopilot/sessions`;

    const codexDefault = await fetch(`${base}/codex/codex-web-toggle`);
    expect(codexDefault.status).toBe(200);
    await expect(codexDefault.json()).resolves.toMatchObject({
      harness: "codex",
      sessionId: "codex-web-toggle",
      enabled: true,
      source: "plugin-default",
    });

    const openCodeDefault = await fetch(`${base}/opencode/ses-web-toggle`);
    await expect(openCodeDefault.json()).resolves.toMatchObject({ enabled: false, source: "default" });

    const claudeDefault = await fetch(`${base}/claude/claude-web-toggle`);
    expect(claudeDefault.status).toBe(200);
    await expect(claudeDefault.json()).resolves.toMatchObject({
      harness: "claude",
      sessionId: "claude-web-toggle",
      enabled: false,
      source: "default",
    });

    const disabled = await fetch(`${base}/codex/codex-web-toggle`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, cwd: "/workspace/project" }),
    });
    expect(disabled.status).toBe(200);
    await expect(disabled.json()).resolves.toMatchObject({
      harness: "codex",
      sessionId: "codex-web-toggle",
      enabled: false,
      source: "session",
    });
    await expect(new AutopilotSessionStore(path).get("codex", "codex-web-toggle")).resolves.toMatchObject({
      enabled: false,
      cwd: "/workspace/project",
    });

    const reloaded = await fetch(`${base}/codex/codex-web-toggle`);
    await expect(reloaded.json()).resolves.toMatchObject({ enabled: false, source: "session" });
  });

  it("inherits the global harness policy and can clear an exact session override", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-web-autopilot-inherit-"));
    const sessions = new AutopilotSessionStore(join(root, "sessions.json"));
    const policy = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
    await policy.replacePolicy({
      ...createDefaultAutopilotPolicy(),
      enabled: true,
      harnesses: ["claude"],
    }, null);
    const server = createWebServer({
      adapters: new Map(),
      converter: { async convert() { throw new Error("unused"); } },
      autopilotSessionStore: sessions,
      autopilotPolicyStore: policy,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const endpoint = `http://127.0.0.1:${address.port}/api/autopilot/sessions/claude/claude-inherit?cwd=${encodeURIComponent("/workspace/project")}`;

    await expect((await fetch(endpoint)).json()).resolves.toMatchObject({ enabled: true, source: "policy" });
    await fetch(endpoint, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false, cwd: "/workspace/project" }) });
    await expect((await fetch(endpoint)).json()).resolves.toMatchObject({ enabled: false, source: "session" });
    await expect((await fetch(endpoint, { method: "DELETE" })).json()).resolves.toMatchObject({ enabled: true, source: "policy" });
  });

  it("rejects unsupported harnesses and malformed writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-web-autopilot-session-invalid-"));
    const server = createWebServer({
      adapters: new Map(),
      converter: { async convert() { throw new Error("unused"); } },
      autopilotSessionStore: new AutopilotSessionStore(join(root, "sessions.json")),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const base = `http://127.0.0.1:${address.port}/api/autopilot/sessions`;

    expect((await fetch(`${base}/qoder/session-1`)).status).toBe(400);
    expect((await fetch(`${base}/codex/session-1`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: "yes", cwd: "/workspace" }),
    })).status).toBe(400);
  });
});
