import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSettingsApi } from "../src/web/settings-api.js";
import { SettingsStore } from "../src/web/settings-store.js";
import {
  buildCommonDocument,
  readOwnerDocument,
  type CommonSettingsDocument,
  type CommonSettingsNodeStatus,
  type CommonSettingsTransport,
} from "../src/common-settings/index.js";

/**
 * The common settings of the fleet, through the API of the panel.
 *
 * The owner changes one thing in one place and every node that takes the
 * common settings gets the same value and confirms the revision it applied.
 * The API keeps the rights of the other settings: the owner of the panel and
 * nobody else, and no new administrative right appears here.
 */

let configDir = "";
let stateDir = "";
let envPath = "";
let store: SettingsStore;
let document: CommonSettingsDocument;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "herder-common-settings-"));
  stateDir = await mkdtemp(join(tmpdir(), "herder-common-settings-state-"));
  envPath = join(configDir, "herder.env");
  await writeFile(envPath, [
    "NOTIFY_CENTER_EVENT_URL=https://center.example/v1/events",
    "NOTIFY_CENTER_PROJECT=agent-herder",
    "NOTIFY_CENTER_RECIPIENT=me",
    "",
  ].join("\n"), { mode: 0o600 });
  await writeFile(join(configDir, "node-config.json"), `${JSON.stringify({
    hostId: "roomhacker-server-100",
    sourceSha: "abc123",
    harnesses: ["codex"],
    webPort: 18787,
  }, null, 2)}\n`, { mode: 0o600 });
  // The store of the test points at the files of the test: the files of the
  // living node are never opened here.
  store = new SettingsStore({
    envPath,
    nodeConfigPath: join(configDir, "node-config.json"),
    stateDir,
    actor: "roomhacker",
    hostId: "roomhacker-server-100",
  });
  document = buildCommonDocument({
    owner: "roomhacker-server-100",
    environment: { NOTIFY_CENTER_PROJECT: "agent-herder", NOTIFY_CENTER_RECIPIENT: "me" },
  });
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

/** One request to the API without a server behind it. */
async function callApi(handler: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>, options: {
  method: string;
  url: string;
  body?: unknown;
  remoteAddress?: string;
  cookie?: string;
  origin?: string;
  host?: string;
  ifMatch?: string;
}): Promise<{ handled: boolean; status: number; body: any }> {
  const chunks = options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))];
  const request = {
    method: options.method,
    url: options.url,
    headers: {
      host: options.host ?? "127.0.0.1:18787",
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.ifMatch ? { "if-match": options.ifMatch } : {}),
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

/** The transport of the fleet, as a fake of the nodes of the fleet. */
function fakeTransport(nodes: Record<string, { status: CommonSettingsNodeStatus; revision: string | null; reachable?: boolean }>) {
  const noticed: string[] = [];
  const transport: CommonSettingsTransport = {
    async read() { return document; },
    async status(target: string) {
      const hostId = target.includes("server-44") ? "server-44" : "server-88";
      const node = nodes[hostId];
      if (!node) return null;
      if (node.reachable === false) throw new Error("direct_peer_unavailable");
      return {
        hostId,
        role: "member",
        optIn: true,
        appliedRevision: node.revision,
        appliedAt: node.revision ? "2026-10-23T00:00:00.000Z" : null,
        conflicts: [],
      };
    },
    async notify(target: string, revision: string) {
      noticed.push(revision);
      const hostId = target.includes("server-44") ? "server-44" : "server-88";
      const node = nodes[hostId];
      if (!node) return null;
      node.revision = revision;
      return {
        hostId,
        role: "member",
        optIn: true,
        appliedRevision: revision,
        appliedAt: "2026-10-23T00:05:00.000Z",
        conflicts: [],
      };
    },
    async setOptIn() { return null; },
    async restore() { return null; },
  };
  return { transport, noticed };
}

const peers = [
  { hostId: "server-44", target: "mcp:shell:server-44:AgentHerder" },
  { hostId: "server-88", target: "mcp:shell:server-88:AgentHerder" },
];

describe("the API of the common settings names the state of every node", () => {
  it("names the revision of the document and the state of every node", async () => {
    const { transport } = fakeTransport({
      "server-44": { status: "подтвердил", revision: document.revision },
      "server-88": { status: "не подтвердил", revision: null, reachable: false },
    });
    const handler = createSettingsApi({
      store,
      verifyOwnerCookie: async () => true,
      commonSettings: {
        role: "owner",
        ownerHostId: "roomhacker-server-100",
        readDocument: async () => document,
        peers,
        transport,
        state: async () => ({ optIn: true, role: "owner", appliedRevision: document.revision, appliedAt: null, document, conflicts: [], rollback: {} }),
        setLocalOptIn: async () => {},
      },
    });
    const answer = await callApi(handler, { method: "GET", url: "/api/settings/common" });
    expect(answer.status).toBe(200);
    expect(answer.body.revision).toBe(document.revision);
    const confirmed = answer.body.nodes.find((node: any) => node.hostId === "server-44");
    expect(confirmed.status).toBe("подтвердил");
    // A node that did not answer is unknown: it is never counted as
    // synchronized.
    const silent = answer.body.nodes.find((node: any) => node.hostId === "server-88");
    expect(silent.status).toBe("не подтвердил");
    expect(answer.body.confirmed).toBe(1);
    expect(answer.body.total).toBe(2);
  });

  it("tells the nodes to take the document and answers who confirmed", async () => {
    const { transport, noticed } = fakeTransport({
      "server-44": { status: "расходится", revision: "sha256:old" },
      "server-88": { status: "расходится", revision: "sha256:old" },
    });
    const handler = createSettingsApi({
      store,
      verifyOwnerCookie: async () => true,
      commonSettings: {
        role: "owner",
        ownerHostId: "roomhacker-server-100",
        readDocument: async () => document,
        peers,
        transport,
        state: async () => ({ optIn: true, role: "owner", appliedRevision: document.revision, appliedAt: null, document, conflicts: [], rollback: {} }),
        setLocalOptIn: async () => {},
      },
    });
    // A browser names its origin with every change, so the test names it too.
    const answer = await callApi(handler, {
      method: "POST",
      url: "/api/settings/common/sync",
      origin: "http://127.0.0.1:18787",
      host: "127.0.0.1:18787",
    });
    expect(answer.status).toBe(200);
    expect(noticed.length).toBe(2);
    expect(noticed[0]).toBe(document.revision);
    expect(answer.body.nodes.every((node: any) => node.status === "подтвердил")).toBe(true);
    expect(answer.body.confirmed).toBe(2);
  });
});

describe("the API of the common settings keeps the rights of the other settings", () => {
  // The options are built inside the test: the document of the owner is built
  // before every test.
  const options = () => ({
    role: "owner" as const,
    ownerHostId: "roomhacker-server-100",
    readDocument: async () => document,
    peers,
    transport: fakeTransport({ "server-44": { status: "подтвердил" as const, revision: document.revision } }).transport,
    state: async () => ({ optIn: true, role: "owner" as const, appliedRevision: document.revision, appliedAt: null, document, conflicts: [], rollback: {} }),
    setLocalOptIn: async () => {},
  });

  it("refuses a request that carries no authority of the owner", async () => {
    const handler = createSettingsApi({ store, verifyOwnerCookie: async () => false, commonSettings: options() });
    const refused = await callApi(handler, { method: "POST", url: "/api/settings/common/sync", remoteAddress: "10.0.0.5" });
    expect(refused.status).toBe(401);
    expect(refused.body.ok).toBe(false);
  });

  it("refuses a change of another origin", async () => {
    const handler = createSettingsApi({ store, verifyOwnerCookie: async () => true, commonSettings: options() });
    const crossed = await callApi(handler, {
      method: "POST",
      url: "/api/settings/common/opt-in",
      remoteAddress: "10.0.0.5",
      cookie: "good-cookie",
      origin: "https://evil.example",
      host: "agent.example",
      body: { enabled: true },
    });
    expect(crossed.status).toBe(403);
  });

  it("accepts the owner of the cabinet", async () => {
    const handler = createSettingsApi({ store, verifyOwnerCookie: async () => true, commonSettings: options() });
    const allowed = await callApi(handler, {
      method: "POST",
      url: "/api/settings/common/opt-in",
      remoteAddress: "10.0.0.5",
      cookie: "good-cookie",
      origin: "https://agent.example",
      host: "agent.example",
      body: { enabled: true },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body.ok).toBe(true);
  });
});

describe("the form of the settings names the common keys", () => {
  it("marks the keys that travel to the nodes of the fleet", async () => {
    const handler = createSettingsApi({ store, verifyOwnerCookie: async () => true });
    const answer = await callApi(handler, { method: "GET", url: "/api/settings" });
    expect(answer.status).toBe(200);
    expect(answer.body.commonSettings.keys).toContain("NOTIFY_CENTER_PROJECT");
    // A machine setting never travels.
    expect(answer.body.commonSettings.keys).not.toContain("AGENT_HERDER_BROWSER_WORKER_PORT");
  });
});

describe("the owner changes a setting in one place and the nodes get it", () => {
  it("reaches the nodes of the fleet and is confirmed by them", async () => {
    // The document of the owner is read from the files of the owner, so a
    // change of the owner moves the revision of the document.
    const readDocument = async (): Promise<CommonSettingsDocument> => await readOwnerDocument({
      owner: "roomhacker-server-100",
      store: {
        readEnvironment: async () => await store.readEnvironment(),
        readSecretValue: async (key: string) => await store.readSecretValue(key),
      },
    });
    const before = await readDocument();
    const { transport, noticed } = fakeTransport({
      "server-44": { status: "подтвердил", revision: before.revision },
      "server-88": { status: "подтвердил", revision: before.revision },
    });
    const handler = createSettingsApi({
      store,
      verifyOwnerCookie: async () => true,
      commonSettings: {
        role: "owner",
        ownerHostId: "roomhacker-server-100",
        readDocument,
        peers,
        transport,
        state: async () => ({ optIn: true, role: "owner", appliedRevision: before.revision, appliedAt: null, document: before, conflicts: [], rollback: {} }),
        setLocalOptIn: async () => {},
      },
    });
    const view = await callApi(handler, { method: "GET", url: "/api/settings" });
    // The owner changes one setting in one place.
    const changed = await callApi(handler, {
      method: "PUT",
      url: "/api/settings",
      origin: "http://127.0.0.1:18787",
      host: "127.0.0.1:18787",
      ifMatch: view.body.etag,
      body: { environment: { NOTIFY_CENTER_RECIPIENT: "owner" } },
    });
    expect(changed.status).toBe(200);
    const after = await readDocument();
    expect(after.revision).not.toBe(before.revision);

    // The nodes are told that the document moved: they take it and confirm
    // the revision they applied.
    let confirmed: any = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const state = await callApi(handler, { method: "GET", url: "/api/settings/common" });
      confirmed = state.body;
      if (confirmed.nodes.every((node: any) => node.status === "подтвердил")) break;
    }
    expect(noticed.length).toBeGreaterThan(0);
    expect(noticed[0]).toBe(after.revision);
    expect(confirmed.revision).toBe(after.revision);
    expect(confirmed.nodes.every((node: any) => node.status === "подтвердил")).toBe(true);
    expect(confirmed.confirmed).toBe(2);
  });
});
