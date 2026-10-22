import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import { createWebServer } from "../src/web/server.js";
import { AutomationDisarmStore } from "../src/automation-disarm/state.js";
import type { FleetDisarmTransport } from "../src/automation-disarm/service.js";

const servers: Server[] = [];
const cleanups: string[] = [];

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-disarm-http-"));
  cleanups.push(root);
  vi.stubEnv("AGENT_HERDER_AUTOPILOT_STATE_DIR", root);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A fleet whose only other node has no herder runtime. */
function fleetTransport(): FleetDisarmTransport {
  return {
    async apply(nodeId, request) {
      if (nodeId === "server-44") return { ok: false, noRuntime: true, reason: "На ноде нет herder-рантайма" };
      return {
        ok: true,
        state: {
          version: 1,
          disarmed: request.disarmed,
          changedAt: new Date().toISOString(),
          changedBy: "owner",
          blockedWorkKeys: request.workKeys,
        },
      };
    },
  };
}

async function startServer(transport: FleetDisarmTransport): Promise<string> {
  const server = createWebServer({
    adapters: new Map(),
    converter: { async convert() { throw new Error("unused"); } },
    automationDisarmStore: AutomationDisarmStore.forRuntime(),
    automationDisarmTransport: transport,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return `http://127.0.0.1:${address.port}/api/automation/disarm`;
}

describe("the owner lever over HTTP", () => {
  it("moves the lever for an explicit owner action and names every node", async () => {
    const url = await startServer(fleetTransport());
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disarmed: true, source: "owner", reason: "владелец остановил автоматику" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean; disarmed: boolean; complete: boolean; applied: boolean;
      state: { disarmed: boolean; reason?: string };
      nodes: Array<{ hostId: string; status: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.complete).toBe(true);
    expect(body.applied).toBe(true);
    expect(body.disarmed).toBe(true);
    expect(body.state.disarmed).toBe(true);
    // The node list is always present: the local node plus every fleet peer,
    // with the node without a runtime named as such.
    expect(body.nodes.length).toBe(5);
    expect(body.nodes[0]?.status).toBe("confirmed");
    expect(body.nodes.find((node) => node.hostId === "server-44")?.status).toBe("no_runtime");
    // The durable state really holds the decision.
    expect((await AutomationDisarmStore.forRuntime().read()).disarmed).toBe(true);
  });

  it("releases the lever again for an explicit owner action", async () => {
    const url = await startServer(fleetTransport());
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disarmed: true, source: "owner" }),
    });
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disarmed: false, source: "owner" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; disarmed: boolean };
    expect(body.ok).toBe(true);
    expect(body.disarmed).toBe(false);
    expect((await AutomationDisarmStore.forRuntime().read()).disarmed).toBe(false);
  });

  it("refuses a call from an automatic context and changes nothing", async () => {
    const url = await startServer(fleetTransport());
    const refused = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disarmed: true }),
    });
    expect(refused.status).toBe(403);
    const body = await refused.json() as { ok: boolean; applied: boolean; reason: string; nodes: unknown[] };
    expect(body.ok).toBe(false);
    expect(body.applied).toBe(false);
    expect(body.reason).toContain("только явное действие владельца");
    expect(body.nodes).toEqual([]);
    // Nothing was written.
    expect((await AutomationDisarmStore.forRuntime().read()).disarmed).toBe(false);
  });

  it("refuses an explicit attempt to release the lever from an automatic context", async () => {
    const url = await startServer(fleetTransport());
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disarmed: true, source: "owner" }),
    });
    const refused = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disarmed: false, source: "automation" }),
    });
    expect(refused.status).toBe(403);
    const body = await refused.json() as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toContain("только явное действие владельца");
    // The lever stays where the owner put it.
    expect((await AutomationDisarmStore.forRuntime().read()).disarmed).toBe(true);
  });
});
