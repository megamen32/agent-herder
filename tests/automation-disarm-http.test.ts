import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import { createWebServer } from "../src/web/server.js";
import { AutomationDisarmStore } from "../src/automation-disarm/state.js";
import type { FleetDisarmTransport } from "../src/automation-disarm/service.js";

const TOKEN = "owner-disarm-secret-for-tests";
const servers: Server[] = [];
const cleanups: string[] = [];

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-disarm-http-"));
  cleanups.push(root);
  vi.stubEnv("AGENT_HERDER_AUTOPILOT_STATE_DIR", root);
  vi.stubEnv("AGENT_HERDER_DISARM_TOKEN", TOKEN);
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
      if (nodeId === "server-44") return { ok: false, noRuntime: true, reason: "not_a_herder_runtime" };
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

async function post(url: string, body: unknown, token?: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

describe("the owner lever over HTTP", () => {
  it("moves the lever for an explicit owner action and names every node", async () => {
    const url = await startServer(fleetTransport());
    const response = await post(url, { disarmed: true, source: "owner", reason: "владелец остановил автоматику" }, TOKEN);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean; disarmed: boolean; applied: boolean;
      state: { disarmed: boolean; reason?: string; blockedWorkKeys: string[]; blockedWorkKeysHuman: string[] };
      nodes: Array<{ hostId: string; status: string; reason: string | null }>;
      summary: string;
    };
    expect(body.ok).toBe(true);
    expect(body.applied).toBe(true);
    expect(body.disarmed).toBe(true);
    expect(body.state.disarmed).toBe(true);
    // The node list is always present: the local node plus every fleet peer,
    // with the node without a runtime named as such.
    expect(body.nodes.length).toBe(5);
    expect(body.nodes[0]?.status).toBe("confirmed");
    expect(body.nodes[0]?.reason).toBeNull();
    expect(body.nodes.find((node) => node.hostId === "server-44")?.status).toBe("no_runtime");
    // The summary is the owner answer, in words.
    expect(body.summary).toBe("new launches forbidden (saved); admission forbidden confirmed on 4 nodes");
    // The durable state really holds the decision.
    expect((await AutomationDisarmStore.forRuntime().read()).disarmed).toBe(true);
  });

  it("releases the lever again for an explicit owner action", async () => {
    const url = await startServer(fleetTransport());
    await post(url, { disarmed: true, source: "owner" }, TOKEN);
    const response = await post(url, { disarmed: false, source: "owner" }, TOKEN);
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; disarmed: boolean; summary: string };
    expect(body.ok).toBe(true);
    expect(body.disarmed).toBe(false);
    expect(body.summary).toContain("new launches allowed");
    expect((await AutomationDisarmStore.forRuntime().read()).disarmed).toBe(false);
  });

  it("refuses a call from an automatic context and changes nothing", async () => {
    const url = await startServer(fleetTransport());
    const refused = await post(url, { disarmed: true }, TOKEN);
    expect(refused.status).toBe(403);
    const body = await refused.json() as { ok: boolean; applied: boolean; reason: string; nodes: unknown[]; summary: string };
    expect(body.ok).toBe(false);
    expect(body.applied).toBe(false);
    expect(body.reason).toContain("только явное действие владельца");
    expect(body.nodes).toEqual([]);
    expect(body.summary).toContain("not an explicit owner action");
    // Nothing was written.
    expect((await AutomationDisarmStore.forRuntime().read()).disarmed).toBe(false);
  });

  it("refuses an explicit attempt to release the lever from an automatic context", async () => {
    const url = await startServer(fleetTransport());
    await post(url, { disarmed: true, source: "owner" }, TOKEN);
    const refused = await post(url, { disarmed: false, source: "automation" }, TOKEN);
    expect(refused.status).toBe(403);
    const body = await refused.json() as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toContain("только явное действие владельца");
    // The lever stays where the owner put it.
    expect((await AutomationDisarmStore.forRuntime().read()).disarmed).toBe(true);
  });

  it("refuses an owner action without the secret", async () => {
    const url = await startServer(fleetTransport());
    const refused = await post(url, { disarmed: true, source: "owner" });
    expect(refused.status).toBe(401);
    const body = await refused.json() as { ok: boolean; applied: boolean; error: string; nodes: unknown[]; summary: string };
    expect(body.ok).toBe(false);
    expect(body.applied).toBe(false);
    expect(body.error).toBe("unauthorized");
    expect(body.nodes).toEqual([]);
    expect(body.summary).toContain("token is missing or wrong");
    // The intent marker alone moves nothing.
    expect((await AutomationDisarmStore.forRuntime().read()).disarmed).toBe(false);
  });

  it("refuses a wrong secret", async () => {
    const url = await startServer(fleetTransport());
    const refused = await post(url, { disarmed: true, source: "owner" }, "not-the-owner-secret");
    expect(refused.status).toBe(401);
    const body = await refused.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("unauthorized");
    expect((await AutomationDisarmStore.forRuntime().read()).disarmed).toBe(false);
  });

  it("fails closed on a node without a configured secret", async () => {
    vi.stubEnv("AGENT_HERDER_DISARM_TOKEN", "");
    const url = await startServer(fleetTransport());
    const refused = await post(url, { disarmed: true, source: "owner" }, TOKEN);
    expect(refused.status).toBe(503);
    const body = await refused.json() as { ok: boolean; applied: boolean; error: string; nodes: unknown[]; summary: string };
    expect(body.ok).toBe(false);
    expect(body.applied).toBe(false);
    expect(body.error).toContain("AGENT_HERDER_DISARM_TOKEN");
    expect(body.nodes).toEqual([]);
    expect(body.summary).toContain("not configured on this node");
    // A node without a secret never moves the lever, not even for the owner.
    expect((await AutomationDisarmStore.forRuntime().read()).disarmed).toBe(false);
  });

  it("names the blocked work in a readable form next to the canonical one", async () => {
    const url = await startServer(fleetTransport());
    const response = await post(url, { disarmed: true, source: "owner", workKeys: ["opencode|/work|my-card"] }, TOKEN);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      state: { blockedWorkKeys: string[]; blockedWorkKeysHuman: string[] };
    };
    expect(body.state.blockedWorkKeys).toEqual(["opencode\u0000/work\u0000my-card"]);
    expect(body.state.blockedWorkKeysHuman).toEqual(["opencode|/work|my-card"]);
  });
});
