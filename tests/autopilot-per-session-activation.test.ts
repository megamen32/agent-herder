import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AutopilotPolicyStore } from "../src/autopilot/policy-store.js";
import { createDefaultAutopilotPolicy } from "../src/autopilot/policy.js";
import { AutopilotSessionStore } from "../src/autopilot/session-store.js";
import { createWebServer } from "../src/web/server.js";

const servers: Server[] = [];
let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-herder-per-session-activation-"));
  process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR = root;
  process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(root, "human-stops.json");
  vi.resetModules();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  delete process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR;
  delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;
  await rm(root, { recursive: true, force: true });
});

describe("per-session autopilot activation through the shared state seam", () => {
  it("activates one exact OpenCode session while the live policy still selects only ZCode", async () => {
    await new AutopilotPolicyStore(join(root, "autopilot-policy.json")).replacePolicy({
      ...createDefaultAutopilotPolicy(),
      enabled: true,
      harnesses: ["zcode"],
    }, null);

    const server = createWebServer({
      adapters: new Map(),
      converter: { async convert() { throw new Error("unused"); } },
      autopilotSessionStore: new AutopilotSessionStore(join(root, "sessions.json")),
      autopilotPolicyStore: new AutopilotPolicyStore(join(root, "autopilot-policy.json")),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const pinned = await fetch(`http://127.0.0.1:${address.port}/api/autopilot/sessions/opencode/ses_incident`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, cwd: "/workspace/incident" }),
    });
    expect(pinned.status).toBe(200);
    await expect(pinned.json()).resolves.toMatchObject({ harness: "opencode", sessionId: "ses_incident", enabled: true });

    const { runAutopilotCommand } = await import("../src/autopilot-runner.js");
    await expect(runAutopilotCommand({ command: "status", harness: "opencode", sessionId: "ses_incident", cwd: "/workspace/incident" }))
      .resolves.toMatchObject({ ok: true, enabled: true, source: "session" });
    // No other OpenCode session is activated by this exact switch.
    await expect(runAutopilotCommand({ command: "status", harness: "opencode", sessionId: "ses_other", cwd: "/workspace/other" }))
      .resolves.toMatchObject({ ok: true, enabled: false });
    // The live ZCode selector is untouched.
    await expect(runAutopilotCommand({ command: "status", harness: "zcode", sessionId: "zcode-1", cwd: "/workspace/zcode" }))
      .resolves.toMatchObject({ ok: true, enabled: true, source: "persisted" });
  });
});