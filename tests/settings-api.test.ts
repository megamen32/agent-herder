import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as fsp from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSettingsApi } from "../src/web/settings-api.js";
import { SettingsStore, settingsFingerprint } from "../src/web/settings-store.js";
import { AutomationLaunchPolicyStore } from "../src/automation-launch-policy.js";
import { createWebServer, type WebDependencies } from "../src/web/server.js";

/**
 * The settings of the herder, managed by the owner from one form.
 *
 * The API is the server half of the form: it reads the current values of the
 * settings of the product and accepts the changes of the owner. A secret is
 * write-only, every change is audited, and a change can be rolled back.
 */

// Every file operation of the test is recorded, so the isolation of the
// products is proved by the files that were really opened.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const wrap = (name: string) => vi.fn(async (...args: unknown[]) => await (actual[name] as (...a: unknown[]) => unknown)(...args));
  return {
    ...actual,
    readFile: wrap("readFile"),
    writeFile: wrap("writeFile"),
    appendFile: wrap("appendFile"),
    rename: wrap("rename"),
    mkdir: wrap("mkdir"),
    stat: wrap("stat"),
  };
});

/** The value of a secret of another product: it must never leave its file. */
const FOREIGN_SENTINEL = "center-secret-value-must-never-appear";

/** The files of another product: the settings of the herder never touch them. */
const FOREIGN_PATTERNS = [
  /notification-center/i,
  /omniroute/i,
  /minimax/i,
  /noticeplace\.env/i,
  /opencode\.env/i,
  /startup\.env/i,
  /^\/etc\//,
];

let configDir = "";
let workDir = "";
let stateDir = "";
let envPath = "";
let nodeConfigPath = "";
let foreignPath = "";
let settingsStateDir = "";
let store: SettingsStore;
let policyStore: AutomationLaunchPolicyStore;
let servers: Server[] = [];

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "herder-l20-config-"));
  workDir = await mkdtemp(join(tmpdir(), "herder-l20-work-"));
  stateDir = await mkdtemp(join(tmpdir(), "herder-l20-state-"));
  envPath = join(configDir, "herder.env");
  nodeConfigPath = join(configDir, "node-config.json");
  foreignPath = join(configDir, "notification-center.env");
  settingsStateDir = join(stateDir, "settings");
  await writeFile(envPath, [
    "# the environment of the herder product",
    "NOTIFY_CENTER_EVENT_URL=https://center.example/v1/events",
    "NOTIFY_CENTER_PROJECT=agent-herder",
    "NOTIFY_CENTER_RECIPIENT=me",
    "NOTIFY_CENTER_TOKEN=center-token-value",
    "NOTICEPLACE_HEALTH_LAUNCH_TOKEN=launch-token-value",
    "",
  ].join("\n"), { mode: 0o600 });
  await chmod(envPath, 0o600);
  // The file of another product stands next to the file of the herder: the
  // settings of the herder must never open it.
  await writeFile(foreignPath, `NOTIFY_CENTER_TOKEN=${FOREIGN_SENTINEL}\n`, { mode: 0o600 });
  await writeFile(nodeConfigPath, `${JSON.stringify({
    hostId: "roomhacker-server-100",
    sourceSha: "abc123",
    harnesses: ["codex", "opencode"],
    webPort: 18789,
  }, null, 2)}\n`, { mode: 0o600 });
  store = new SettingsStore({
    envPath,
    nodeConfigPath,
    stateDir: settingsStateDir,
    actor: "roomhacker",
    hostId: "roomhacker-server-100",
  });
  // The policy of the launch keeps its own store: the settings API reads it
  // through the layer that already owns it.
  policyStore = new AutomationLaunchPolicyStore(join(stateDir, "automation-launch-policy.json"));
  await writeFile(policyStore.filePath, `${JSON.stringify({
    version: 1,
    allowedHarnesses: ["codex"],
    preferredHarness: "codex",
    models: { codex: "gpt-5.6-sol" },
  }, null, 2)}\n`, { mode: 0o600 });
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all([
    rm(configDir, { recursive: true, force: true }),
    rm(workDir, { recursive: true, force: true }),
    rm(stateDir, { recursive: true, force: true }),
  ]);
});

/** The runtime of the test, with the settings store of the test. */
async function startServer(dependencies: Partial<WebDependencies> = {}): Promise<number> {
  const server = createWebServer({
    adapters: new Map(),
    converter: { async convert() { throw new Error("unused"); } },
    settingsStore: store,
    automationLaunchPolicyStore: policyStore,
    sessionObservationManagedExternally: true,
    ...dependencies,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("not listening");
  return address.port;
}

/** The settings of the owner, as the API answers them. */
async function readSettings(port: number): Promise<Record<string, any>> {
  const response = await fetch(`http://127.0.0.1:${port}/api/settings`);
  expect(response.status).toBe(200);
  return await response.json() as Record<string, any>;
}

/**
 * A change of the owner.
 *
 * A browser sends the Origin of the page with every change, so the test
 * sends it too: the origin of the loopback of the test is the origin of the
 * request.
 */
async function putSettings(port: number, body: unknown): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify(body),
  });
}

/** A rollback of the owner. */
async function rollbackSettings(port: number, body: unknown): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}/api/settings/rollback`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify(body),
  });
}

/** The files that were really opened during the test. */
function touchedPaths(): string[] {
  const mocked = fsp as unknown as Record<string, { mock?: { calls: unknown[][] } }>;
  const paths: string[] = [];
  for (const name of ["readFile", "writeFile", "appendFile", "rename", "mkdir", "stat"]) {
    const calls = mocked[name]?.mock?.calls ?? [];
    for (const call of calls) {
      const first = call[0];
      if (typeof first === "string") paths.push(first);
      else if (first instanceof URL) paths.push(first.pathname);
      else if (first && typeof first === "object" && "path" in first) paths.push(String((first as { path: string }).path));
    }
  }
  return paths;
}

/** Forget the file operations that happened before. */
function clearTouched(): void {
  const mocked = fsp as unknown as Record<string, { mockClear?: () => void }>;
  for (const name of ["readFile", "writeFile", "appendFile", "rename", "mkdir", "stat"]) {
    mocked[name]?.mockClear?.();
  }
}

describe("the settings of the herder are managed by the owner from one API", () => {
  it("reads the current value of every entity of the contour", async () => {
    const port = await startServer();
    const view = await readSettings(port);

    // The environment of the product: the file of the product is the source.
    expect(view.environment.path).toBe(envPath);
    expect(view.environment.present).toBe(true);
    expect(view.environment.mode).toBe("0600");
    expect(view.environment.values.NOTIFY_CENTER_EVENT_URL.value).toBe("https://center.example/v1/events");
    expect(view.environment.values.NOTIFY_CENTER_PROJECT.value).toBe("agent-herder");
    expect(view.environment.values.NOTIFY_CENTER_RECIPIENT.value).toBe("me");

    // The configuration of this node.
    expect(view.fleetNode.path).toBe(nodeConfigPath);
    expect(view.fleetNode.present).toBe(true);
    expect(view.fleetNode.config.webPort).toBe(18789);
    // The keys of the deployment are named as such: the form never writes them.
    expect(view.fleetNode.managedKeys).toContain("hostId");
    expect(view.fleetNode.managedKeys).toContain("sourceSha");

    // The policy of the launch keeps its own endpoint: the settings API reads
    // it and never writes it a second time.
    expect(view.launchPolicy.endpoint).toBe("/api/automation/launch-policy");
    expect(view.launchPolicy.managedBy).toContain("existing launch policy API");
    expect(view.launchPolicy.state).toBe("valid");
    expect(view.launchPolicy.policy.models.codex).toBe("gpt-5.6-sol");
    expect(typeof view.launchPolicy.etag).toBe("string");
  });

  it("accepts a change of the owner and writes it into the file of the product", async () => {
    const port = await startServer();
    const response = await putSettings(port, { environment: { NOTIFY_CENTER_PROJECT: "agent-herder-next" } });
    expect(response.status).toBe(200);
    const view = await response.json() as Record<string, any>;
    expect(view.environment.values.NOTIFY_CENTER_PROJECT.value).toBe("agent-herder-next");

    // The file of the product carries the change: the file stays the source
    // for the services.
    const text = await readFile(envPath, "utf8");
    expect(text).toContain("NOTIFY_CENTER_PROJECT=agent-herder-next");
    // The comment of the owner is not lost by the write.
    expect(text).toContain("# the environment of the herder product");
    // The other keys are untouched.
    expect(text).toContain("NOTIFY_CENTER_EVENT_URL=https://center.example/v1/events");
  });

  it("leaves the policy of the launch to the endpoint that owns it", async () => {
    const port = await startServer();
    const before = await readFile(policyStore.filePath, "utf8");

    // The settings API does not write the policy of the launch: it names the
    // endpoint that owns it instead.
    const response = await putSettings(port, { launchPolicy: { version: 1, allowedHarnesses: [] } });
    expect(response.status).toBe(400);
    expect((await response.json() as Record<string, any>).error).toContain("/api/automation/launch-policy");
    // The file of the policy is untouched.
    expect(await readFile(policyStore.filePath, "utf8")).toBe(before);

    // The read of the settings names the endpoint and the version of it.
    const view = await readSettings(port);
    expect(view.launchPolicy.endpoint).toBe("/api/automation/launch-policy");
    expect(view.launchPolicy.state).toBe("valid");
  });

  it("writes a secret and never returns its value", async () => {
    const port = await startServer();
    const secret = "brand-new-secret-value-42";
    const response = await putSettings(port, { environment: { NOTIFY_CENTER_TOKEN: secret } });
    expect(response.status).toBe(200);
    const text = await response.text();

    // The value of the secret is nowhere in the answer.
    expect(text).not.toContain(secret);
    const view = JSON.parse(text) as Record<string, any>;
    expect(view.environment.values.NOTIFY_CENTER_TOKEN.value).toBeUndefined();
    expect(view.environment.values.NOTIFY_CENTER_TOKEN.configured).toBe(true);
    // The answer names the secret by a stable fingerprint of it.
    expect(view.environment.values.NOTIFY_CENTER_TOKEN.fingerprint).toBe(settingsFingerprint(secret));
    // The record of the change names it the same way.
    expect(JSON.stringify(view.applied)).not.toContain(secret);
    expect(view.applied[0].after.fingerprint).toBe(settingsFingerprint(secret));

    // The value is in the file of the product: the form manages the file, it
    // does not replace it.
    expect(await readFile(envPath, "utf8")).toContain(`NOTIFY_CENTER_TOKEN=${secret}`);

    // A later read never returns it either.
    const later = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).text();
    expect(later).not.toContain(secret);
  });

  it("audits every change with its author, its time and what changed", async () => {
    const port = await startServer();
    await putSettings(port, { environment: { NOTIFY_CENTER_PROJECT: "changed-project" } });
    await putSettings(port, { environment: { NOTIFY_CENTER_TOKEN: "audited-secret" } });

    const records = await store.readAudit(50);
    expect(records).toHaveLength(2);

    expect(records[0]!.actor).toBe("roomhacker");
    expect(records[0]!.action).toBe("set");
    expect(records[0]!.entity).toBe("herder.env");
    expect(records[0]!.key).toBe("NOTIFY_CENTER_PROJECT");
    expect(records[0]!.before.value).toBe("agent-herder");
    expect(records[0]!.after.value).toBe("changed-project");
    expect(records[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // The secret is audited by its fingerprint and never by its value.
    expect(records[1]!.kind).toBe("secret");
    expect(records[1]!.before.fingerprint).toBe(settingsFingerprint("center-token-value"));
    expect(records[1]!.after.fingerprint).toBe(settingsFingerprint("audited-secret"));
    expect(records[1]!.after.value).toBeUndefined();
    expect(JSON.stringify(records)).not.toContain("audited-secret");

    // The journal of the changes is readable through the API as well.
    const audit = await (await fetch(`http://127.0.0.1:${port}/api/settings/audit`)).json() as Record<string, any>;
    expect(audit.records).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain("audited-secret");
  });

  it("rolls a change back to the value the key had before it", async () => {
    const port = await startServer();
    await putSettings(port, { environment: { NOTIFY_CENTER_PROJECT: "changed-project" } });

    const response = await rollbackSettings(port, { entity: "herder.env", key: "NOTIFY_CENTER_PROJECT" });
    expect(response.status).toBe(200);
    const view = await response.json() as Record<string, any>;

    // The value before the change is back in the file of the product.
    expect(view.environment.values.NOTIFY_CENTER_PROJECT.value).toBe("agent-herder");
    expect(await readFile(envPath, "utf8")).toContain("NOTIFY_CENTER_PROJECT=agent-herder");
    // The rollback is a change of its own and it is audited.
    expect(view.applied[0].action).toBe("rollback");
    const records = await store.readAudit(50);
    const last = records[records.length - 1]!;
    expect(last.action).toBe("rollback");
    expect(last.key).toBe("NOTIFY_CENTER_PROJECT");
  });

  it("rolls a secret back without telling its value to anybody", async () => {
    const port = await startServer();
    await putSettings(port, { environment: { NOTIFY_CENTER_TOKEN: "rolled-back-secret" } });

    const response = await rollbackSettings(port, { entity: "herder.env", key: "NOTIFY_CENTER_TOKEN" });
    expect(response.status).toBe(200);
    const text = await response.text();

    // The value of the secret is nowhere in the answer.
    expect(text).not.toContain("rolled-back-secret");
    expect(text).not.toContain("center-token-value");
    // The value before the change is back in the file of the product.
    expect(await readFile(envPath, "utf8")).toContain("NOTIFY_CENTER_TOKEN=center-token-value");
  });

  it("never touches the file of another product", async () => {
    // The operations of the fixture are forgotten: only the operations of the
    // API itself are watched.
    clearTouched();
    const port = await startServer();
    const before = readFileSync(foreignPath, "utf8");

    const read = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).text();
    const written = await (await putSettings(port, { environment: { NOTIFY_CENTER_PROJECT: "changed-project" } })).text();

    // The file of the other product is untouched.
    expect(readFileSync(foreignPath, "utf8")).toBe(before);
    // The value of the other product is in no answer.
    expect(read).not.toContain(FOREIGN_SENTINEL);
    expect(written).not.toContain(FOREIGN_SENTINEL);
    // And no file of another product was ever opened.
    const foreign = touchedPaths().filter((path) => FOREIGN_PATTERNS.some((pattern) => pattern.test(path)));
    expect(foreign).toEqual([]);
  });

  it("names no file of another product in the code of the settings", async () => {
    const root = process.cwd();
    const source = `${await readFile(join(root, "src/web/settings-store.ts"), "utf8")}\n${await readFile(join(root, "src/web/settings-api.ts"), "utf8")}`;
    for (const pattern of FOREIGN_PATTERNS) {
      expect(pattern.test(source)).toBe(false);
    }
  });
});

describe("the settings of the herder keep the access of the panel", () => {
  /** One request to the API without a server behind it. */
  async function callApi(handler: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>, options: {
    method: string;
    url: string;
    body?: unknown;
    remoteAddress?: string;
    cookie?: string;
    origin?: string;
    host?: string;
  }): Promise<{ handled: boolean; status: number; body: any }> {
    const chunks = options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))];
    const request = {
      method: options.method,
      url: options.url,
      headers: {
        host: options.host ?? "127.0.0.1:18789",
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.origin ? { origin: options.origin } : {}),
      },
      socket: { remoteAddress: options.remoteAddress ?? "127.0.0.1" },
      [Symbol.asyncIterator]: async function* () { for (const chunk of chunks) yield chunk; },
    } as unknown as IncomingMessage;
    let status = 0;
    let payload = "";
    const response = {
      writeHead(code: number) { status = code; return response; },
      end(body?: unknown) { payload = typeof body === "string" ? body : ""; return response; },
      setHeader() { return response; },
    } as unknown as ServerResponse;
    const handled = await handler(request, response);
    return { handled, status, body: payload ? JSON.parse(payload) : null };
  }

  it("refuses a request that carries no authority of the owner", async () => {
    const handler = createSettingsApi({ store, verifyOwnerCookie: async () => false });
    const refused = await callApi(handler, { method: "GET", url: "/api/settings", remoteAddress: "10.0.0.5" });
    expect(refused.status).toBe(401);
    expect(refused.body.ok).toBe(false);
  });

  it("refuses a request whose cookie of the owner is not valid", async () => {
    const handler = createSettingsApi({ store, verifyOwnerCookie: async (cookie: string) => cookie === "good-cookie" });
    const refused = await callApi(handler, { method: "GET", url: "/api/settings", remoteAddress: "10.0.0.5", cookie: "bad-cookie" });
    expect(refused.status).toBe(401);
  });

  it("accepts the owner of the cabinet and refuses a change of another origin", async () => {
    const handler = createSettingsApi({ store, verifyOwnerCookie: async (cookie: string) => cookie === "good-cookie" });
    const allowed = await callApi(handler, {
      method: "GET",
      url: "/api/settings",
      remoteAddress: "10.0.0.5",
      cookie: "good-cookie",
      origin: "https://agent.example",
      host: "agent.example",
    });
    expect(allowed.status).toBe(200);

    const crossOrigin = await callApi(handler, {
      method: "PUT",
      url: "/api/settings",
      remoteAddress: "10.0.0.5",
      cookie: "good-cookie",
      origin: "https://evil.example",
      host: "agent.example",
      body: { environment: { NOTIFY_CENTER_PROJECT: "crossed" } },
    });
    expect(crossOrigin.status).toBe(403);
    // The change of another origin never reached the file.
    expect(await readFile(envPath, "utf8")).toContain("NOTIFY_CENTER_PROJECT=agent-herder");
  });

  it("refuses a rollback of another origin even without a cookie of the owner", async () => {
    const port = await startServer();
    await putSettings(port, { environment: { NOTIFY_CENTER_PROJECT: "changed-project" } });
    const before = await readFile(envPath, "utf8");

    // A simple request of another site reaches the loopback without any
    // credential of the owner: it carries no cookie and no authorization.
    const response = await fetch(`http://127.0.0.1:${port}/api/settings/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ entity: "herder.env", key: "NOTIFY_CENTER_PROJECT" }),
    });
    expect(response.status).toBe(403);
    // The rollback was not applied and the file of the product is untouched.
    expect(await readFile(envPath, "utf8")).toBe(before);
    expect((await readFile(envPath, "utf8")).includes("NOTIFY_CENTER_PROJECT=changed-project")).toBe(true);
  });

  it("refuses a rollback of the loopback that names no origin", async () => {
    const port = await startServer();
    await putSettings(port, { environment: { NOTIFY_CENTER_PROJECT: "changed-project" } });
    const before = await readFile(envPath, "utf8");

    const response = await fetch(`http://127.0.0.1:${port}/api/settings/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entity: "herder.env", key: "NOTIFY_CENTER_PROJECT" }),
    });
    expect(response.status).toBe(403);
    expect(await readFile(envPath, "utf8")).toBe(before);
  });

  it("applies a rollback of the owner with the origin of the panel", async () => {
    const port = await startServer();
    await putSettings(port, { environment: { NOTIFY_CENTER_PROJECT: "changed-project" } });

    const response = await rollbackSettings(port, { entity: "herder.env", key: "NOTIFY_CENTER_PROJECT" });
    expect(response.status).toBe(200);
    // The value before the change is back in the file of the product.
    expect(await readFile(envPath, "utf8")).toContain("NOTIFY_CENTER_PROJECT=agent-herder");
  });

  it("refuses a change of another origin on the loopback too", async () => {
    const port = await startServer();
    const before = await readFile(envPath, "utf8");

    const response = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ environment: { NOTIFY_CENTER_PROJECT: "crossed" } }),
    });
    expect(response.status).toBe(403);
    // The file of the product is untouched.
    expect(await readFile(envPath, "utf8")).toBe(before);
  });

  it("answers the routes of the settings only", async () => {
    const handler = createSettingsApi({ store, verifyOwnerCookie: async () => true });
    const other = await callApi(handler, { method: "GET", url: "/api/sessions", remoteAddress: "10.0.0.5" });
    expect(other.handled).toBe(false);
  });
});
