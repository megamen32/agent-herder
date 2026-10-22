import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSettingsApi } from "../src/web/settings-api.js";
import { SettingsStore } from "../src/web/settings-store.js";
import { SettingsConnectionStore } from "../src/web/settings-connection.js";

/**
 * The connection of the herder to the center of notifications.
 *
 * The integration is isolated: the herder keeps its own part of the
 * connection in its own store, and there is no shared env file. The token of
 * the service account is write-only: it goes into the file of the product
 * and never comes back to the browser.
 *
 * The check of the connection reads the readiness of the center: it starts no
 * executor of the herder and creates no event in the center.
 */

let servers: Server[] = [];
let configDir = "";
let stateDir = "";
let envPath = "";
let nodeConfigPath = "";

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "herder-connection-config-"));
  stateDir = await mkdtemp(join(tmpdir(), "herder-connection-state-"));
  envPath = join(configDir, "herder.env");
  nodeConfigPath = join(configDir, "node-config.json");
  await writeFile(envPath, "NOTIFY_CENTER_PROJECT=agent-herder\n", { mode: 0o600 });
  await writeFile(nodeConfigPath, `${JSON.stringify({ hostId: "roomhacker-server-100", sourceSha: "abc123" })}\n`, { mode: 0o600 });
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await rm(configDir, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

async function startPanel(options: { withoutWiring?: boolean } = {}): Promise<string> {
  const settingsApi = createSettingsApi({
    store: new SettingsStore({
      envPath,
      nodeConfigPath,
      stateDir: join(stateDir, "settings"),
      actor: "roomhacker",
      hostId: "roomhacker-server-100",
    }),
    actor: "roomhacker",
    connections: options.withoutWiring
      ? undefined
      : new SettingsConnectionStore({ stateDir: join(stateDir, "connections") }),
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

describe("the connection of the herder to the center", () => {
  it("says that the connection is not configured", async () => {
    const base = await startPanel();
    const response = await fetch(`${base}/api/settings/connections`);
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; connection: unknown };
    expect(body.ok).toBe(true);
    expect(body.connection).toBeNull();
  });

  it("connects the herder to the center and keeps the token write-only", async () => {
    const base = await startPanel();
    const response = await fetch(`${base}/api/settings/connections`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        centerUrl: "https://center.example",
        purpose: "noticeplace.health-analysis",
        permissions: ["read", "notify"],
        token: "the-secret-token-value",
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; connection: { centerUrl: string; purpose: string; permissions: string[]; state: string; tokenFingerprint?: string } };
    expect(body.ok).toBe(true);
    expect(body.connection.centerUrl).toBe("https://center.example");
    expect(body.connection.purpose).toBe("noticeplace.health-analysis");
    expect(body.connection.permissions).toEqual(["read", "notify"]);
    expect(body.connection.state).toBe("connected");
    // The token is named by its fingerprint only, and the value is nowhere.
    expect(body.connection.tokenFingerprint).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(JSON.stringify(body)).not.toContain("the-secret-token-value");

    const read = await fetch(`${base}/api/settings/connections`);
    const readBody = await read.json() as { connection: unknown };
    expect(JSON.stringify(readBody)).not.toContain("the-secret-token-value");

    // The settings of the product name the secret by its fingerprint too.
    const settings = await fetch(`${base}/api/settings`);
    expect(await settings.text()).not.toContain("the-secret-token-value");
  });

  it("refuses a connection without an address or a purpose", async () => {
    const base = await startPanel();
    const noAddress = await fetch(`${base}/api/settings/connections`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ purpose: "noticeplace.health-analysis" }),
    });
    expect(noAddress.status).toBe(400);
    const noPurpose = await fetch(`${base}/api/settings/connections`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ centerUrl: "https://center.example" }),
    });
    expect(noPurpose.status).toBe(400);
  });

  it("checks the connection without inventing a success", async () => {
    const base = await startPanel();
    await fetch(`${base}/api/settings/connections`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ centerUrl: "http://127.0.0.1:1", purpose: "noticeplace.health-analysis" }),
    });
    const response = await fetch(`${base}/api/settings/connections/check`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; check: { reachable: boolean; authorized: boolean; compatible: boolean; detail: string } };
    expect(body.ok).toBe(true);
    // The center of the test does not answer: the check says so.
    expect(body.check.reachable).toBe(false);
    expect(body.check.authorized).toBe(false);
    expect(body.check.compatible).toBe(false);
    expect(body.check.detail).toContain("не ответил");
  });

  it("revokes the connection from the panel and refuses the check after it", async () => {
    const base = await startPanel();
    await fetch(`${base}/api/settings/connections`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ centerUrl: "https://center.example", purpose: "noticeplace.health-analysis" }),
    });
    const revoked = await fetch(`${base}/api/settings/connections/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({}),
    });
    expect(revoked.status).toBe(200);
    const body = await revoked.json() as { connection: { state: string; revokedAt: string | null } };
    expect(body.connection.state).toBe("revoked");
    expect(body.connection.revokedAt).toBeTruthy();

    const check = await fetch(`${base}/api/settings/connections/check`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({}),
    });
    expect(check.status).toBe(409);
  });

  it("refuses a change that comes from another origin", async () => {
    const base = await startPanel();
    const response = await fetch(`${base}/api/settings/connections`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://another.example" },
      body: JSON.stringify({ centerUrl: "https://center.example", purpose: "noticeplace.health-analysis" }),
    });
    expect(response.status).toBe(403);
  });

  it("keeps the connection in the store of the product without a wiring line", async () => {
    // The route of the panel is mounted by prefix, and the wiring of the
    // server is frozen: the part of the connection must live in the store
    // of the product and not wait for a line of the server.
    const base = await startPanel({ withoutWiring: true });
    const response = await fetch(`${base}/api/settings/connections`);
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; connection: unknown };
    expect(body.ok).toBe(true);
    expect(body.connection).toBeNull();

    const connected = await fetch(`${base}/api/settings/connections`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        centerUrl: "https://center.example",
        purpose: "noticeplace.health-analysis",
        permissions: ["read"],
      }),
    });
    expect(connected.status).toBe(200);

    // The part of the connection lives next to the settings of the product.
    const file = join(stateDir, "settings", "connections.json");
    expect(existsSync(file)).toBe(true);
    const stored = JSON.parse(await readFile(file, "utf8")) as { centerUrl: string };
    expect(stored.centerUrl).toBe("https://center.example");
  });
});
