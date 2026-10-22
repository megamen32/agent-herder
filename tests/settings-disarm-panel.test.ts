import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSettingsApi } from "../src/web/settings-api.js";
import { SettingsStore } from "../src/web/settings-store.js";
import { AutomationDisarmStore, AUTOMATION_CANNOT_CHANGE_DISARM_REASON } from "../src/automation-disarm/index.js";
import type { FleetDisarmNodeResult, FleetDisarmRequest, FleetDisarmTransport } from "../src/automation-disarm/service.js";

/**
 * The panel moves the lever of the owner over the automation.
 *
 * The route of the panel lives in the settings API: the mounting of the
 * settings API is a prefix dispatcher, so the route answers here and the
 * frozen server keeps its own route for the bearer callers. Both read and
 * write one runtime state of the lever.
 *
 * The browser never carries the token of the lever: the rights are checked
 * on the backend, by the same owner check as the other routes of the
 * settings. A node without the token configured fails closed.
 */

let servers: Server[] = [];
let stateDir = "";
let configDir = "";
let envPath = "";
let nodeConfigPath = "";
let previousToken: string | undefined;

/** The transport of the test: it answers instead of reaching the fleet. */
function fakeTransport(): FleetDisarmTransport & { calls: FleetDisarmRequest[] } {
  const calls: FleetDisarmRequest[] = [];
  return {
    calls,
    async apply(_nodeId: string, request: FleetDisarmRequest): Promise<{ ok: boolean; reason?: string }> {
      calls.push(request);
      return { ok: true };
    },
    async read(_nodeId: string): Promise<{ ok: boolean; reason?: string }> {
      return { ok: true };
    },
  };
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "herder-disarm-config-"));
  stateDir = await mkdtemp(join(tmpdir(), "herder-disarm-state-"));
  envPath = join(configDir, "herder.env");
  nodeConfigPath = join(configDir, "node-config.json");
  await writeFile(envPath, "NOTIFY_CENTER_PROJECT=agent-herder\n", { mode: 0o600 });
  await writeFile(nodeConfigPath, `${JSON.stringify({ hostId: "roomhacker-server-100", sourceSha: "abc123" })}\n`, { mode: 0o600 });
  previousToken = process.env.AGENT_HERDER_DISARM_TOKEN;
  process.env.AGENT_HERDER_DISARM_TOKEN = "test-lever-token";
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  if (previousToken === undefined) delete process.env.AGENT_HERDER_DISARM_TOKEN;
  else process.env.AGENT_HERDER_DISARM_TOKEN = previousToken;
  await rm(configDir, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

/** The panel server of the test: the settings API answers the route of the lever. */
async function startPanel(transport: FleetDisarmTransport = fakeTransport()): Promise<string> {
  const settingsApi = createSettingsApi({
    store: new SettingsStore({
      envPath,
      nodeConfigPath,
      stateDir: join(stateDir, "settings"),
      actor: "roomhacker",
      hostId: "roomhacker-server-100",
    }),
    actor: "roomhacker",
    disarm: { store: AutomationDisarmStore.at(stateDir), transport },
  });
  const server = createServer(async (request, response) => {
    if (await settingsApi(request, response)) return;
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

describe("the panel moves the lever of the owner", () => {
  it("answers the state of the lever with the nodes and the revision", async () => {
    const base = await startPanel();
    const response = await fetch(`${base}/api/settings/automation/disarm`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("etag")).toBeTruthy();
    const body = await response.json() as {
      ok: boolean; records: unknown[]; state: { disarmed?: boolean }; nodes: FleetDisarmNodeResult[]; summary: string; etag: string;
    };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.records)).toBe(true);
    expect(body.state).toBeTruthy();
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(typeof body.summary).toBe("string");
    expect(body.etag).toBe(response.headers.get("etag"));
  });

  it("refuses a request that is not an explicit owner action", async () => {
    const base = await startPanel();
    const response = await fetch(`${base}/api/settings/automation/disarm`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ scope: "*", forbidden: true }),
    });
    expect(response.status).toBe(403);
    const body = await response.json() as { ok: boolean; applied: boolean; reason?: string };
    expect(body.ok).toBe(false);
    expect(body.applied).toBe(false);
    expect(body.reason).toBe(AUTOMATION_CANNOT_CHANGE_DISARM_REASON);
  });

  it("moves the lever for the owner and names every node", async () => {
    const transport = fakeTransport();
    const base = await startPanel(transport);
    const response = await fetch(`${base}/api/settings/automation/disarm`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ source: "owner", scope: "*", forbidden: true, reason: "остановка владельцем" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBeTruthy();
    const body = await response.json() as {
      ok: boolean; applied: boolean; scope: string; forbidden: boolean; disarmed: boolean;
      state: { disarmed?: boolean; records?: Array<{ scope: string; forbidden: boolean }> };
      records: Array<{ scope: string; forbidden: boolean }>; nodes: FleetDisarmNodeResult[]; summary: string; etag: string;
    };
    expect(body.applied).toBe(true);
    expect(body.scope).toBe("*");
    expect(body.forbidden).toBe(true);
    expect(body.disarmed).toBe(true);
    // The decision is one record per scope, and the local state holds it.
    expect(body.records.some((record) => record.scope === "*" && record.forbidden)).toBe(true);
    expect(body.state.disarmed).toBe(true);
    expect(typeof body.summary).toBe("string");
    // The fleet was asked: the decision travels to the other nodes.
    expect(transport.calls.length).toBeGreaterThan(0);
    expect(transport.calls[0]?.disarmed).toBe(true);
  });

  it("answers the flat shape of the lever as well", async () => {
    const base = await startPanel();
    const response = await fetch(`${base}/api/settings/automation/disarm`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ source: "owner", disarmed: true, reason: "остановка владельцем" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { applied: boolean; scope: string; forbidden: boolean; disarmed: boolean };
    expect(body.applied).toBe(true);
    expect(body.scope).toBe("*");
    expect(body.forbidden).toBe(true);
    expect(body.disarmed).toBe(true);
  });

  it("fails closed on a node without the token of the lever", async () => {
    delete process.env.AGENT_HERDER_DISARM_TOKEN;
    const base = await startPanel();
    const response = await fetch(`${base}/api/settings/automation/disarm`);
    expect(response.status).toBe(503);
    const body = await response.json() as { ok: boolean; applied: boolean; summary: string; reason?: string };
    expect(body.ok).toBe(false);
    expect(body.applied).toBe(false);
    expect(body.summary).toContain("не настроен");
    expect(body.reason).toContain("AGENT_HERDER_DISARM_TOKEN");
  });

  it("refuses a change that comes from another origin", async () => {
    const base = await startPanel();
    const response = await fetch(`${base}/api/settings/automation/disarm`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://another.example" },
      body: JSON.stringify({ source: "owner", scope: "*", forbidden: true }),
    });
    expect(response.status).toBe(403);
  });

  it("refuses a scope that is not a path of a project", async () => {
    const base = await startPanel();
    const response = await fetch(`${base}/api/settings/automation/disarm`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ source: "owner", scope: "relative/path", forbidden: true }),
    });
    expect(response.status).toBe(400);
  });
});
