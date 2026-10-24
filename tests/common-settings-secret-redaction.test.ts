/**
 * The value of a secret never leaves the node in an answer.
 *
 * The common settings of the fleet travel between the nodes, and the value of a
 * secret is a part of the document that travels. Every answer a reader of the
 * fleet gets — the document, the nodes, the deviations, the journal and the
 * answers of the tools of the node — shows the fact that the setting holds a
 * secret and its fingerprint, and never the value.
 *
 * The secrets of this test are fictional: `test-secret-A` and `test-secret-B`.
 * No value of a living node is written here.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSettingsApi } from "../src/web/settings-api.js";
import { SettingsStore } from "../src/web/settings-store.js";
import {
  applyCommonSettingsDocument,
  buildCommonDocument,
  CommonSettingsNodeService,
  CommonSettingsStateStore,
  emptyCommonSettingsState,
  registerCommonSettingsTools,
  type CommonSettingsConflict,
  type CommonSettingsDocument,
  type CommonSettingsNodeStatus,
  type CommonSettingsTarget,
  type CommonSettingsTransport,
} from "../src/common-settings/index.js";

/** The secret of the common document in this test. */
const COMMON_SECRET = "test-secret-A";
/** The secret the node held before the document was applied. */
const LOCAL_SECRET = "test-secret-B";

let configDir = "";
let stateDir = "";
let store: SettingsStore;
let document: CommonSettingsDocument;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "herder-secret-redaction-"));
  stateDir = await mkdtemp(join(tmpdir(), "herder-secret-redaction-state-"));
  await writeFile(join(configDir, "herder.env"), [
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
    envPath: join(configDir, "herder.env"),
    nodeConfigPath: join(configDir, "node-config.json"),
    stateDir,
    actor: "roomhacker",
    hostId: "roomhacker-server-100",
  });
  document = buildCommonDocument({
    owner: "roomhacker-server-100",
    environment: {
      NOTIFY_CENTER_PROJECT: "agent-herder",
      NOTIFY_CENTER_TOKEN: COMMON_SECRET,
      NOTICEPLACE_HEALTH_LAUNCH_TOKEN: LOCAL_SECRET,
    },
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
  origin?: string;
  host?: string;
}): Promise<{ handled: boolean; status: number; body: any }> {
  const chunks = options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))];
  const request = {
    method: options.method,
    url: options.url,
    headers: {
      host: options.host ?? "127.0.0.1:18787",
      ...(options.origin ? { origin: options.origin } : {}),
    },
    socket: { remoteAddress: "127.0.0.1" },
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

/** The deviations of a node, with the values of the secrets still in them. */
function rawConflicts(): CommonSettingsConflict[] {
  return [
    {
      id: "herder.env/NOTIFY_CENTER_TOKEN",
      commonValue: COMMON_SECRET,
      localValue: LOCAL_SECRET,
      kind: "adopted",
      detectedAt: "2026-10-24T12:00:00.000Z",
      open: true,
    },
    {
      id: "herder.env/NOTICEPLACE_HEALTH_LAUNCH_TOKEN",
      commonValue: LOCAL_SECRET,
      localValue: null,
      kind: "local-change",
      detectedAt: "2026-10-24T12:00:00.000Z",
      open: false,
    },
    {
      id: "herder.env/AGENT_HERDER_UNFINISHED_JUDGE_REASONING_EFFORT",
      commonValue: "high",
      localValue: "low",
      kind: "local-change",
      detectedAt: "2026-10-24T12:00:00.000Z",
      open: true,
    },
  ];
}

/** The transport of the fleet, as a fake of a node that still answers with the values. */
function fakeTransport(): CommonSettingsTransport {
  const status = (): CommonSettingsNodeStatus => ({
    hostId: "server-44",
    role: "member",
    optIn: true,
    appliedRevision: document.revision,
    appliedAt: "2026-10-24T12:00:00.000Z",
    conflicts: rawConflicts(),
  });
  return {
    async read() { return document; },
    async status() { return status(); },
    async notify() { return status(); },
    async setOptIn() { return status(); },
    async restore() { return status(); },
  };
}

const peers = [{ hostId: "server-44", target: "mcp:shell:server-44:AgentHerder" }];

/** The API of the panel, with the common settings of the fleet. */
function commonApi(transport: CommonSettingsTransport, restoreLocal?: () => Promise<any>) {
  return createSettingsApi({
    store,
    verifyOwnerCookie: async () => true,
    commonSettings: {
      role: "owner",
      ownerHostId: "roomhacker-server-100",
      readDocument: async () => document,
      peers,
      transport,
      state: async () => ({ ...emptyCommonSettingsState("owner"), document }),
      setLocalOptIn: async () => {},
      ...(restoreLocal ? { restoreLocal } : {}),
    },
  });
}

describe("the answer of the panel holds no value of a secret", () => {
  it("names the deviations of the nodes and closes the values of the secrets", async () => {
    const handler = commonApi(fakeTransport());
    const answer = await callApi(handler, { method: "GET", url: "/api/settings/common" });
    expect(answer.status).toBe(200);
    // The actual answer of the API, as the owner reads it.
    console.log("=== the answer of /api/settings/common ===");
    console.log(JSON.stringify(answer.body, null, 2));
    const text = JSON.stringify(answer.body);
    expect(text).not.toContain(COMMON_SECRET);
    expect(text).not.toContain(LOCAL_SECRET);
    const node = answer.body.nodes.find((item: any) => item.hostId === "server-44");
    const secret = node.conflicts.find((item: any) => item.id === "herder.env/NOTIFY_CENTER_TOKEN");
    expect(secret.commonValue).toBeNull();
    expect(secret.localValue).toBeNull();
    expect(secret.commonSecret).toBe(true);
    expect(secret.localSecret).toBe(true);
    expect(String(secret.commonFingerprint)).toMatch(/^sha256:/);
    expect(String(secret.localFingerprint)).toMatch(/^sha256:/);
    // The purpose of the setting is on the place: the owner sees what the
    // secret is for and never what it is.
    expect(typeof secret.purpose).toBe("string");
    expect(String(secret.purpose).length).toBeGreaterThan(0);
  });

  it("closes the value of a secret in a deviation that is already closed", async () => {
    const handler = commonApi(fakeTransport());
    const answer = await callApi(handler, { method: "GET", url: "/api/settings/common" });
    const node = answer.body.nodes.find((item: any) => item.hostId === "server-44");
    const history = node.conflicts.find((item: any) => item.id === "herder.env/NOTICEPLACE_HEALTH_LAUNCH_TOKEN");
    expect(history.open).toBe(false);
    expect(history.commonValue).toBeNull();
    expect(history.commonSecret).toBe(true);
    expect(String(history.commonFingerprint)).toMatch(/^sha256:/);
    expect(JSON.stringify(answer.body)).not.toContain(LOCAL_SECRET);
  });

  it("keeps the value of a setting that is not a secret", async () => {
    const handler = commonApi(fakeTransport());
    const answer = await callApi(handler, { method: "GET", url: "/api/settings/common" });
    const node = answer.body.nodes.find((item: any) => item.hostId === "server-44");
    const plain = node.conflicts.find((item: any) => item.id === "herder.env/AGENT_HERDER_UNFINISHED_JUDGE_REASONING_EFFORT");
    expect(plain.commonValue).toBe("high");
    expect(plain.localValue).toBe("low");
    expect(plain.commonSecret).toBeUndefined();
  });

  it("keeps the fact of the secret and its fingerprint in the document", async () => {
    const handler = commonApi(fakeTransport());
    const answer = await callApi(handler, { method: "GET", url: "/api/settings/common" });
    const view = answer.body.document.environment.NOTIFY_CENTER_TOKEN;
    expect(view.secret).toBe(true);
    expect(view.value).toBeNull();
    expect(String(view.fingerprint)).toMatch(/^sha256:/);
    expect(JSON.stringify(answer.body)).not.toContain(COMMON_SECRET);
  });

  it("closes the values of the secrets in the answer of the restore", async () => {
    const handler = commonApi(fakeTransport(), async () => ({
      ok: true,
      hostId: "roomhacker-server-100",
      appliedRevision: document.revision,
      appliedAt: "2026-10-24T12:05:00.000Z",
      changed: ["herder.env/NOTIFY_CENTER_TOKEN"],
      conflicts: rawConflicts(),
    }));
    const answer = await callApi(handler, {
      method: "POST",
      url: "/api/settings/common/restore",
      origin: "http://127.0.0.1:18787",
      host: "127.0.0.1:18787",
    });
    expect(answer.status).toBe(200);
    console.log("=== the answer of /api/settings/common/restore ===");
    console.log(JSON.stringify(answer.body.restored, null, 2));
    expect(JSON.stringify(answer.body)).not.toContain(COMMON_SECRET);
    expect(JSON.stringify(answer.body)).not.toContain(LOCAL_SECRET);
  });
});

/** The settings of a node, as a fake of the product of the node. */
function fakeTarget(initial: Record<string, string> = {}) {
  const values: Record<string, string> = { ...initial };
  const target: CommonSettingsTarget = {
    async readEnvironment() {
      return {
        values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { present: true, value }])),
      };
    },
    async readSecretValue(key: string) { return values[key]; },
    async applyEnvironment(changes: Record<string, string | null>) {
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) delete values[key];
        else values[key] = value;
      }
      return [];
    },
  };
  return { values, target };
}

/** The tools of the node, as a fake of the server of the MCP. */
function fakeMcpServer() {
  const tools = new Map<string, (request: unknown) => Promise<any>>();
  const server = {
    registerTool(name: string, _definition: unknown, handler: (request: unknown) => Promise<any>) {
      tools.set(name, handler);
    },
  };
  return { server: server as never, tools };
}

describe("the tools of the node hold no value of a secret", () => {
  it("closes the values of the secrets in the state of the node", async () => {
    const node = fakeTarget({ NOTIFY_CENTER_TOKEN: LOCAL_SECRET });
    const stateStore = new CommonSettingsStateStore({ path: join(stateDir, "common-settings.json") });
    const service = new CommonSettingsNodeService({
      hostId: "server-44",
      role: "member",
      ownerHostId: "roomhacker-server-100",
      stateStore,
      target: node.target,
    });
    const { server, tools } = fakeMcpServer();
    registerCommonSettingsTools(server, { service });

    // The node takes the document of the owner and finds the deviation.
    await service.apply(document);
    const status = await tools.get("common_settings_status")!({});
    console.log("=== the answer of the tool common_settings_status ===");
    console.log(JSON.stringify(status.structuredContent, null, 2));
    const text = JSON.stringify(status.structuredContent);
    expect(text).not.toContain(COMMON_SECRET);
    expect(text).not.toContain(LOCAL_SECRET);
    const secret = status.structuredContent.conflicts.find((item: any) => item.id === "herder.env/NOTIFY_CENTER_TOKEN");
    expect(secret.commonValue).toBeNull();
    expect(secret.localValue).toBeNull();
    expect(secret.commonSecret).toBe(true);
    expect(String(secret.commonFingerprint)).toMatch(/^sha256:/);
  });

  it("keeps the settings of the node manageable: the value is applied and can be put back", async () => {
    const node = fakeTarget({ NOTIFY_CENTER_TOKEN: LOCAL_SECRET });
    const stateStore = new CommonSettingsStateStore({ path: join(stateDir, "common-settings.json") });
    const service = new CommonSettingsNodeService({
      hostId: "server-44",
      role: "member",
      ownerHostId: "roomhacker-server-100",
      stateStore,
      target: node.target,
    });
    const { server, tools } = fakeMcpServer();
    registerCommonSettingsTools(server, { service });

    await service.apply(document);
    // The common value wins on the node.
    expect(node.values.NOTIFY_CENTER_TOKEN).toBe(COMMON_SECRET);
    // The value the node held is kept in the state of the node: that is what
    // lets the owner put it back.
    const state = await stateStore.read();
    const kept = state.conflicts.find((item) => item.id === "herder.env/NOTIFY_CENTER_TOKEN");
    expect(kept?.localValue).toBe(LOCAL_SECRET);
    // The answer of the tool of the restore holds no value of the secret.
    const restored = await tools.get("common_settings_restore")!({});
    console.log("=== the answer of the tool common_settings_restore ===");
    console.log(JSON.stringify(restored.structuredContent, null, 2));
    expect(JSON.stringify(restored.structuredContent)).not.toContain(LOCAL_SECRET);
    // The local value is put back: the settings of the node are still managed.
    expect(node.values.NOTIFY_CENTER_TOKEN).toBe(LOCAL_SECRET);
  });

  it("keeps the value of a setting that is not a secret in the deviations", async () => {
    const node = fakeTarget({ NOTIFY_CENTER_PROJECT: "my-own" });
    const stateStore = new CommonSettingsStateStore({ path: join(stateDir, "common-settings.json") });
    const service = new CommonSettingsNodeService({
      hostId: "server-44",
      role: "member",
      ownerHostId: "roomhacker-server-100",
      stateStore,
      target: node.target,
    });
    const { server, tools } = fakeMcpServer();
    registerCommonSettingsTools(server, { service });
    await service.apply(document);
    const status = await tools.get("common_settings_status")!({});
    const plain = status.structuredContent.conflicts.find((item: any) => item.id === "herder.env/NOTIFY_CENTER_PROJECT");
    expect(plain.commonValue).toBe("agent-herder");
    expect(plain.localValue).toBe("my-own");
    expect(plain.commonSecret).toBeUndefined();
  });
});

describe("the application of the document keeps the value in the state of the node", () => {
  it("writes the common value and keeps the local one for the restore", async () => {
    const node = fakeTarget({ NOTIFY_CENTER_TOKEN: LOCAL_SECRET });
    const result = await applyCommonSettingsDocument({
      document,
      target: node.target,
      state: emptyCommonSettingsState("member"),
      hostId: "server-44",
    });
    expect(result.ok).toBe(true);
    expect(node.values.NOTIFY_CENTER_TOKEN).toBe(COMMON_SECRET);
    // The result of the application is the state of the node: it holds the
    // value, because the node has to be able to put it back.
    const conflict = result.conflicts.find((item) => item.id === "herder.env/NOTIFY_CENTER_TOKEN");
    expect(conflict?.localValue).toBe(LOCAL_SECRET);
    expect(conflict?.commonValue).toBe(COMMON_SECRET);
  });
});
