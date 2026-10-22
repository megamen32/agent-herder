import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSettingsApi } from "../src/web/settings-api.js";
import { SettingsStore } from "../src/web/settings-store.js";
import { AutomationDisarmStore } from "../src/automation-disarm/index.js";
import type { FleetDisarmRequest, FleetDisarmTransport } from "../src/automation-disarm/service.js";
import { UnfinishedSessionLauncher, UnfinishedSessionStore } from "../src/autopilot/unfinished-session-launcher.js";
import type { UnfinishedSessionLauncherOptions } from "../src/autopilot/unfinished-session-launcher.js";
import { HumanStopStore } from "../src/human-stop-store.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

/**
 * P6: the live automatic executors of a scope.
 *
 * The order belongs to the owner: the state of the scope is forbidden first
 * and the live executors are stopped after it. Nothing is deleted: the record
 * of the unfinished session stays and the session is masked by the durable
 * fence of the human stop. A session that stays alive is named with the
 * reason.
 */

let servers: Server[] = [];
let stateDir = "";
let previousToken: string | undefined;
const order: string[] = [];

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "herder-p6-"));
  order.length = 0;
  previousToken = process.env.AGENT_HERDER_DISARM_TOKEN;
  process.env.AGENT_HERDER_DISARM_TOKEN = "test-lever-token";
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  if (previousToken === undefined) delete process.env.AGENT_HERDER_DISARM_TOKEN;
  else process.env.AGENT_HERDER_DISARM_TOKEN = previousToken;
  await rm(stateDir, { recursive: true, force: true });
});

/** The panel of the test with one live automatic executor of the scope. */
async function startPanel(): Promise<{ base: string; humanStopStore: HumanStopStore }> {
  const storePath = join(stateDir, "unfinished-sessions.json");
  await writeFile(storePath, JSON.stringify({
    version: 1,
    sessions: [{
      harness: "opencode",
      sessionId: "live-1",
      cwd: "/tmp/project-1",
      state: "active",
      attempts: 1,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
  }), { mode: 0o600 });

  const stopped = new Set<string>();
  const adapter = {
    type: "opencode",
    name: "Fake OpenCode",
    async init() {},
    async listSessions() { return []; },
    async getSession(id: string): Promise<AgentSession | null> {
      if (stopped.has(id)) return null;
      return {
        id, harness: "opencode", status: "running", title: "Живая сессия",
        cwd: "/tmp/project-1", lastActivity: new Date().toISOString(), needsPermission: false,
      };
    },
    async sendMessage() { return { ok: true }; },
    async stopSession(id: string) {
      order.push(`stop:${id}`);
      stopped.add(id);
      return { ok: true };
    },
    async respondPermission() { return { ok: false, error: "permission backend unavailable" }; },
    async setPermissions() { return { ok: true }; },
  } as unknown as HarnessAdapter;

  const humanStopStore = new HumanStopStore(join(stateDir, "human-stops.json"));
  const transport: FleetDisarmTransport = {
    async apply(_nodeId: string, _request: FleetDisarmRequest) {
      order.push("forbid");
      return { ok: true };
    },
    async read() { return { ok: true }; },
  };
  // The launcher of the running process: the panel asks it, and it gets the
  // live store, the live adapters and the live fences.
  new UnfinishedSessionLauncher({
    store: new UnfinishedSessionStore(storePath),
    adapters: new Map([["opencode", adapter]]),
    humanStopStore,
  } as unknown as UnfinishedSessionLauncherOptions);

  const settingsApi = createSettingsApi({
    store: new SettingsStore({
      envPath: join(stateDir, "herder.env"),
      nodeConfigPath: join(stateDir, "node-config.json"),
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
  return { base: `http://127.0.0.1:${address.port}`, humanStopStore };
}

describe("the live automatic executors of a scope", () => {
  it("forbids the scope first and stops the live executors after it", async () => {
    const { base, humanStopStore } = await startPanel();
    const response = await fetch(`${base}/api/settings/automation/stop-current`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ source: "owner", scope: "*" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      applied: boolean; scope: string;
      stopped: Array<{ harness: string; sessionId: string }>;
      stillRunning: Array<{ sessionId: string; reason: string }>;
    };
    expect(body.applied).toBe(true);
    expect(body.scope).toBe("*");
    expect(body.stopped.map((item) => item.sessionId)).toEqual(["live-1"]);
    expect(body.stillRunning).toEqual([]);
    // The order of the owner: the state of the scope first, the stop after it.
    // The fleet confirm may ask every peer, but the forbid comes first and
    // the stop of the live executor comes after it.
    expect(order.indexOf("forbid")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("forbid")).toBeLessThan(order.indexOf("stop:live-1"));
    expect(order[order.length - 1]).toBe("stop:live-1");
    // Nothing is deleted: the session is masked by the durable fence.
    expect(await humanStopStore.isHeld("opencode", "live-1")).toBe(true);
  });

  it("changes nothing on the second call", async () => {
    const { base } = await startPanel();
    const body = JSON.stringify({ source: "owner", scope: "*" });
    const first = await fetch(`${base}/api/settings/automation/stop-current`, {
      method: "POST", headers: { "content-type": "application/json", origin: base }, body,
    });
    const firstBody = await first.json() as { stopped: unknown[]; stillRunning: unknown[] };
    expect(firstBody.stopped).toHaveLength(1);

    const second = await fetch(`${base}/api/settings/automation/stop-current`, {
      method: "POST", headers: { "content-type": "application/json", origin: base }, body,
    });
    const secondBody = await second.json() as { stopped: unknown[]; stillRunning: unknown[] };
    // The same answer, and no second stop attempt: the session is not alive.
    expect(secondBody.stopped).toHaveLength(1);
    expect(secondBody.stillRunning).toEqual([]);
    expect(order.filter((item) => item.startsWith("stop:")).length).toBe(1);
  });

  it("does not revive what was stopped when the scope is allowed again", async () => {
    const { base, humanStopStore } = await startPanel();
    await fetch(`${base}/api/settings/automation/stop-current`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ source: "owner", scope: "*" }),
    });
    const allowed = await fetch(`${base}/api/settings/automation/disarm`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ source: "owner", scope: "*", forbidden: false }),
    });
    expect(allowed.status).toBe(200);
    // The permission of the scope does not lift the mask of the stopped
    // session: the fence of the human stop is independent of the automation.
    expect(await humanStopStore.isHeld("opencode", "live-1")).toBe(true);
  });

  it("refuses a request that is not an explicit owner action", async () => {
    const { base } = await startPanel();
    const response = await fetch(`${base}/api/settings/automation/stop-current`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ scope: "*" }),
    });
    expect(response.status).toBe(403);
    expect(order).toEqual([]);
  });
});
