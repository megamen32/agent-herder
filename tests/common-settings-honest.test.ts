import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildCommonDocument,
  readOwnerDocument,
  type CommonSettingsDocument,
  type CommonSettingsNodeStatus,
  type CommonSettingsTransport,
} from "../src/common-settings/index.js";
import { createSettingsApi } from "../src/web/settings-api.js";
import { SettingsStore } from "../src/web/settings-store.js";

/**
 * The common settings of the fleet, named honestly.
 *
 * The owner looks at the panel and sees what the nodes answered: the revision
 * that every opt-in node really applied, the nodes that did not answer and
 * the nodes that answered but applied nothing. Nothing here is written by the
 * panel on its own: every fact is the answer of a node.
 */

let configDir = "";
let stateDir = "";
let envPath = "";
let store: SettingsStore;
let document: CommonSettingsDocument;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "herder-common-honest-"));
  stateDir = await mkdtemp(join(tmpdir(), "herder-common-honest-state-"));
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
function fakeTransport(nodes: Record<string, { revision: string | null; reachable?: boolean }>) {
  const noticed: string[] = [];
  const transport: CommonSettingsTransport = {
    async read() { return document; },
    async status(target: string) {
      const hostId = target.includes("server-44") ? "server-44" : "server-88";
      const node = nodes[hostId];
      if (!node) return null;
      if (node.reachable === false) throw new Error("direct_peer_unavailable");
      const status: CommonSettingsNodeStatus = {
        hostId,
        role: "member",
        optIn: true,
        appliedRevision: node.revision,
        appliedAt: node.revision ? "2026-10-24T00:00:00.000Z" : null,
        conflicts: [],
      };
      return status;
    },
    async notify(target: string, revision: string) {
      const hostId = target.includes("server-44") ? "server-44" : "server-88";
      const node = nodes[hostId];
      if (!node) return null;
      if (node.reachable === false) throw new Error("direct_peer_unavailable");
      noticed.push(revision);
      node.revision = revision;
      return {
        hostId,
        role: "member",
        optIn: true,
        appliedRevision: revision,
        appliedAt: "2026-10-24T00:05:00.000Z",
        conflicts: [],
      } satisfies CommonSettingsNodeStatus;
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

/** The API of the owner with the given fleet. */
function handlerFor(transport: CommonSettingsTransport) {
  return createSettingsApi({
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
}

describe("the fleet names the fact of every node", () => {
  it("calls a node that did not answer unreachable and knows nothing about it", async () => {
    const { transport } = fakeTransport({
      "server-44": { revision: document.revision },
      "server-88": { revision: null, reachable: false },
    });
    const answer = await callApi(handlerFor(transport), { method: "GET", url: "/api/settings/common" });
    expect(answer.status).toBe(200);
    const silent = answer.body.nodes.find((node: any) => node.hostId === "server-88");
    // The node did not answer: it is unreachable, and nothing is known about
    // it — not even that it takes the common settings.
    expect(silent.reachable).toBe(false);
    expect(silent.fact).toBe("недоступна");
    expect(silent.optIn).toBeNull();
    expect(silent.appliedRevision).toBeNull();
    expect(answer.body.unreachable).toEqual(["server-88"]);
    // A node that did not answer is never counted as synchronized.
    expect(answer.body.confirmed).toBe(1);
    expect(answer.body.total).toBe(2);
    expect(answer.body.unconfirmed).toContain("server-88");
  });

  it("tells a node that answered and applied nothing apart from a node that is down", async () => {
    const { transport } = fakeTransport({
      "server-44": { revision: document.revision },
      "server-88": { revision: null, reachable: true },
    });
    const answer = await callApi(handlerFor(transport), { method: "GET", url: "/api/settings/common" });
    const waiting = answer.body.nodes.find((node: any) => node.hostId === "server-88");
    expect(waiting.reachable).toBe(true);
    expect(waiting.fact).toBe("не применена");
    expect(waiting.optIn).toBe(true);
    expect(waiting.appliedRevision).toBeNull();
    expect(answer.body.unreachable).toEqual([]);
  });

  it("names the revision that the node really applied", async () => {
    const { transport } = fakeTransport({
      "server-44": { revision: document.revision },
      "server-88": { revision: "sha256:old" },
    });
    const answer = await callApi(handlerFor(transport), { method: "GET", url: "/api/settings/common" });
    const applied = answer.body.nodes.find((node: any) => node.hostId === "server-44");
    expect(applied.fact).toBe("применена");
    expect(applied.appliedRevision).toBe(document.revision);
    const diverged = answer.body.nodes.find((node: any) => node.hostId === "server-88");
    expect(diverged.fact).toBe("расходится");
    expect(diverged.appliedRevision).toBe("sha256:old");
  });
});

describe("a change of a common setting reaches the nodes and is confirmed by them", () => {
  it("delivers the new revision and answers with the revision the nodes applied", async () => {
    const readDocument = async (): Promise<CommonSettingsDocument> => await readOwnerDocument({
      owner: "roomhacker-server-100",
      store: {
        readEnvironment: async () => await store.readEnvironment(),
        readSecretValue: async (key: string) => await store.readSecretValue(key),
      },
    });
    const before = await readDocument();
    const { transport, noticed } = fakeTransport({
      "server-44": { revision: before.revision },
      "server-88": { revision: before.revision },
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

    // The delivery: the nodes are told that the document moved, and they take
    // the new revision by themselves.
    for (let attempt = 0; attempt < 40 && noticed.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(noticed).toContain(after.revision);

    // The confirmation: the fleet answers with the revision that every node
    // really applied. Nothing here is the panel guessing.
    const confirmed = await callApi(handler, {
      method: "POST",
      url: "/api/settings/common/sync",
      origin: "http://127.0.0.1:18787",
      host: "127.0.0.1:18787",
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.revision).toBe(after.revision);
    expect(confirmed.body.confirmed).toBe(2);
    for (const node of confirmed.body.nodes) {
      expect(node.fact).toBe("применена");
      expect(node.appliedRevision).toBe(after.revision);
    }
  });

  it("keeps a node that is down out of the applied ones after the delivery", async () => {
    const { transport } = fakeTransport({
      "server-44": { revision: "sha256:old" },
      "server-88": { revision: null, reachable: false },
    });
    const answer = await callApi(handlerFor(transport), {
      method: "POST",
      url: "/api/settings/common/sync",
      origin: "http://127.0.0.1:18787",
      host: "127.0.0.1:18787",
    });
    expect(answer.status).toBe(200);
    const silent = answer.body.nodes.find((node: any) => node.hostId === "server-88");
    expect(silent.fact).toBe("недоступна");
    expect(silent.appliedRevision).toBeNull();
    expect(answer.body.unreachable).toEqual(["server-88"]);
    expect(answer.body.confirmed).toBe(1);
    expect(answer.body.unconfirmed).toContain("server-88");
  });
});
