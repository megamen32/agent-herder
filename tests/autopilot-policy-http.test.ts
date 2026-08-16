import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AutopilotPolicyStore } from "../src/autopilot/policy-store.js";
import { createWebServer } from "../src/web/server.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("web autopilot runtime policy", () => {
  it("reads and durably updates the global runtime settings with CAS", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-policy-http-"));
    const store = new AutopilotPolicyStore(join(root, "autopilot-policy.json"));
    const server = createWebServer({
      adapters: new Map(),
      converter: { async convert() { throw new Error("unused"); } },
      autopilotPolicyStore: store,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const endpoint = `http://127.0.0.1:${address.port}/api/autopilot/policy`;

    const initial = await fetch(endpoint);
    expect(initial.status).toBe(200);
    const initialBody = await initial.json();
    expect(initialBody).toMatchObject({
      source: "default",
      revision: "default",
      policy: {
        enabled: false,
        harnesses: ["codex", "opencode", "claude", "hermes"],
        timeout: { mode: "auto_continue", delayMs: 1_800_000 },
        card: { includeUserMessage: true, includeAssistantMessage: true, includeReason: true },
      },
    });

    const saved = await fetch(endpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: null,
        policy: {
          ...initialBody.policy,
          enabled: true,
          harnesses: ["codex", "claude"],
        },
      }),
    });
    expect(saved.status).toBe(200);
    const savedBody = await saved.json();
    expect(savedBody).toMatchObject({ source: "persisted", writeStatus: "durable", policy: { enabled: true, harnesses: ["codex", "claude"] } });

    const stale = await fetch(endpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: null, policy: initialBody.policy }),
    });
    expect(stale.status).toBe(409);
  });
});
