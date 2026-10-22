import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import { createWebServer } from "../src/web/server.js";
import { AutomationDisarmStore } from "../src/automation-disarm/state.js";
import type { FleetDisarmTransport } from "../src/automation-disarm/service.js";

const TOKEN = "owner-disarm-secret-for-scope-tests";
const servers: Server[] = [];
const cleanups: string[] = [];

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-disarm-http-scopes-"));
  cleanups.push(root);
  vi.stubEnv("AGENT_HERDER_AUTOPILOT_STATE_DIR", root);
  vi.stubEnv("AGENT_HERDER_DISARM_TOKEN", TOKEN);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A fleet that holds the same state on every node it answers for. */
function fleetTransport(): FleetDisarmTransport {
  return {
    async apply(nodeId, request) {
      return {
        ok: true,
        state: {
          version: 2,
          records: request.records ?? [],
          disarmed: request.disarmed,
          blockedWorkKeys: request.workKeys,
          changedAt: new Date().toISOString(),
          changedBy: "owner",
        },
      };
    },
    async read() {
      const state = await AutomationDisarmStore.forRuntime().read();
      return { ok: true, state };
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

async function post(url: string, body: unknown, token?: string, ifMatch?: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(ifMatch === undefined ? {} : { "if-match": ifMatch }),
    },
    body: JSON.stringify(body),
  });
}

async function get(url: string, token?: string): Promise<Response> {
  return fetch(url, {
    method: "GET",
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-herder-disarm-http-area-"));
  cleanups.push(dir);
  return realpath(dir);
}

describe("the owner lever over HTTP: the read handle", () => {
  it("names the records and the revision of the state", async () => {
    const url = await startServer(fleetTransport());
    const area = await workspace();
    await post(url, { source: "owner", scope: area, forbidden: true, owner: "owner-1", reason: "стоп" }, TOKEN);

    const response = await get(url, TOKEN);
    expect(response.status).toBe(200);
    const etag = response.headers.get("etag");
    expect(etag).toBeTruthy();
    const body = await response.json() as {
      ok: boolean;
      records: Array<{ scope: string; forbidden: boolean; owner?: string; reason?: string }>;
      nodes: Array<{ hostId: string; status: string; reason: string | null }>;
      summary: string;
      etag: string;
    };
    expect(body.ok).toBe(true);
    expect(body.etag).toBe(etag);
    expect(body.records).toHaveLength(1);
    expect(body.records[0]).toMatchObject({ scope: area, forbidden: true, owner: "owner-1", reason: "стоп" });
    // The node list is always there: a bare success is not an answer.
    expect(body.nodes.length).toBeGreaterThan(0);
    expect(body.nodes[0]?.status).toBe("confirmed");
    expect(body.summary).toContain("records");
  });

  it("refuses the read without the owner secret", async () => {
    const url = await startServer(fleetTransport());
    const area = await workspace();
    await post(url, { source: "owner", scope: area, forbidden: true }, TOKEN);

    const refused = await get(url);
    expect(refused.status).toBe(401);
    const body = await refused.json() as { ok: boolean; records: unknown[]; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("unauthorized");
    // The state names the areas of the projects and is not public.
    expect(body.records).toEqual([]);
  });

  it("fails closed on a node without a configured secret", async () => {
    vi.stubEnv("AGENT_HERDER_DISARM_TOKEN", "");
    const url = await startServer(fleetTransport());
    const refused = await get(url, TOKEN);
    expect(refused.status).toBe(503);
    const body = await refused.json() as { ok: boolean; records: unknown[]; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("AGENT_HERDER_DISARM_TOKEN");
    expect(body.records).toEqual([]);
  });
});

describe("the owner lever over HTTP: the write handle", () => {
  it("refuses a write without the owner secret", async () => {
    const url = await startServer(fleetTransport());
    const area = await workspace();
    const refused = await post(url, { source: "owner", scope: area, forbidden: true });
    expect(refused.status).toBe(401);
    // Nothing was written.
    expect((await AutomationDisarmStore.forRuntime().read()).records).toHaveLength(0);
  });

  it("refuses a write that is not an explicit owner action", async () => {
    const url = await startServer(fleetTransport());
    const area = await workspace();
    const refused = await post(url, { scope: area, forbidden: true }, TOKEN);
    expect(refused.status).toBe(403);
    const body = await refused.json() as { ok: boolean; applied: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.applied).toBe(false);
    expect(body.reason).toContain("только явное действие владельца");
    // Nothing was written.
    expect((await AutomationDisarmStore.forRuntime().read()).records).toHaveLength(0);
  });

  it("writes the record and answers with the new revision", async () => {
    const url = await startServer(fleetTransport());
    const area = await workspace();
    const response = await post(url, { source: "owner", scope: area, forbidden: true, owner: "owner-1" }, TOKEN);
    expect(response.status).toBe(200);
    const etag = response.headers.get("etag");
    expect(etag).toBeTruthy();
    const body = await response.json() as {
      ok: boolean; applied: boolean; scope: string; forbidden: boolean;
      state: { records: Array<{ scope: string; forbidden: boolean }>; changedAt: string; changedBy: string };
      nodes: Array<{ hostId: string; status: string }>;
      summary: string; etag: string;
    };
    expect(body.ok).toBe(true);
    expect(body.applied).toBe(true);
    expect(body.scope).toBe(area);
    expect(body.forbidden).toBe(true);
    expect(body.state.records).toHaveLength(1);
    expect(body.state.changedBy).toBe("owner");
    expect(body.etag).toBe(etag);
    expect(body.nodes.length).toBeGreaterThan(0);
    expect(body.summary).toContain("new launches forbidden (saved)");
    expect(body.summary).toContain(`scope ${area}`);
  });

  it("refuses a write whose expected revision is not the current one", async () => {
    const url = await startServer(fleetTransport());
    const area = await workspace();
    await post(url, { source: "owner", scope: area, forbidden: true }, TOKEN);
    const before = await AutomationDisarmStore.forRuntime().read();

    const refused = await post(url, { source: "owner", scope: area, forbidden: false }, TOKEN, '"a-stale-revision"');
    expect(refused.status).toBe(412);
    const body = await refused.json() as { ok: boolean; applied: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.applied).toBe(false);
    expect(body.error).toBe("state_conflict");
    // Nothing was written: the prohibition still holds.
    const after = await AutomationDisarmStore.forRuntime().read();
    expect(after.records).toHaveLength(1);
    expect(after.records[0]?.forbidden).toBe(true);
    expect(after.changedAt).toBe(before.changedAt);
  });

  it("writes when the expected revision is the current one", async () => {
    const url = await startServer(fleetTransport());
    const area = await workspace();
    await post(url, { source: "owner", scope: area, forbidden: true }, TOKEN);
    const read = await get(url, TOKEN);
    const etag = read.headers.get("etag")!;

    const response = await post(url, { source: "owner", scope: area, forbidden: false }, TOKEN, etag);
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; forbidden: boolean };
    expect(body.ok).toBe(true);
    expect(body.forbidden).toBe(false);
    expect((await AutomationDisarmStore.forRuntime().read()).records[0]?.forbidden).toBe(false);
  });

  it("lifts the prohibition with the same interface", async () => {
    const url = await startServer(fleetTransport());
    const area = await workspace();
    await post(url, { source: "owner", scope: area, forbidden: true, reason: "стоп" }, TOKEN);

    // The same handle, the same shape, the other position.
    const response = await post(url, { source: "owner", scope: area, forbidden: false }, TOKEN);
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; forbidden: boolean; summary: string };
    expect(body.ok).toBe(true);
    expect(body.forbidden).toBe(false);
    expect(body.summary).toContain("new launches allowed");
    expect((await AutomationDisarmStore.forRuntime().read()).records[0]?.forbidden).toBe(false);
  });

  it("refuses a scope that is not a path", async () => {
    const url = await startServer(fleetTransport());
    const refused = await post(url, { source: "owner", scope: "not-a-path", forbidden: true }, TOKEN);
    expect(refused.status).toBe(400);
    expect((await AutomationDisarmStore.forRuntime().read()).records).toHaveLength(0);
  });

  it("refuses a request that names no position", async () => {
    const url = await startServer(fleetTransport());
    const area = await workspace();
    const refused = await post(url, { source: "owner", scope: area }, TOKEN);
    expect(refused.status).toBe(400);
    expect((await AutomationDisarmStore.forRuntime().read()).records).toHaveLength(0);
  });
});
