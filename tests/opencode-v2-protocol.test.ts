import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { expect, it } from "vitest";
import { normalizeOpenCodeEvent, OpenCodeAdapter, unwrapEnvelope } from "../src/adapters/opencode.js";

// Focused integration: OpenCode >= 2 protocol over real HTTP.
// The fixture serves the v2 `/api` surface with `{ data }` envelopes and answers
// every legacy path with the SPA shell, exactly like a real v2 server.
// Expected 2s/max 20s. No native task, provider or paid request.
type Call = { method: string; path: string; body?: string };

function v2Fixture(state: {
  sessions: Record<string, any>;
  active: Record<string, any>;
  permissions: any[];
  calls: Call[];
  models?: any[];
}) {
  const html = (response: any, path: string) => {
    response.setHeader("content-type", "text/html");
    response.statusCode = 200;
    response.end("<!doctype html><html><body>opencode</body></html>");
    void path;
  };
  const json = (response: any, value: unknown) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(value));
  };
  return createServer((request, response) => {
    const url = new URL(request.url!, "http://v2");
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      state.calls.push({ method: request.method!, path: request.url!, ...(body ? { body } : {}) });

      // v2 never serves the API outside `/api`; unknown roots return the SPA.
      if (!url.pathname.startsWith("/api")) return html(response, url.pathname);

      if (url.pathname === "/api/config") return json(response, { data: [{ type: "document", path: "/tmp/project/opencode.json" }] });
      if (url.pathname === "/api/model") {
        return json(response, { location: { directory: "/tmp/project" }, data: state.models ?? [
          { id: "gpt-4.1", modelID: "gpt-4.1", providerID: "openrouter" },
          { id: "flash", modelID: "flash", providerID: "minimax-coding-plan" },
        ] });
      }
      if (url.pathname === "/api/provider") {
        return json(response, { location: { directory: "/tmp/project" }, data: [
          { id: "openrouter", activation: "enabled" },
          { id: "disabled-one", activation: "disabled" },
        ] });
      }
      if (url.pathname === "/api/session/active") return json(response, { data: state.active });
      if (url.pathname === "/api/permission/request") {
        return json(response, { location: { directory: "/tmp/project" }, data: state.permissions });
      }
      if (url.pathname === "/api/session" && request.method === "GET") {
        const parentID = url.searchParams.get("parentID");
        const list = Object.values(state.sessions)
          .filter((session) => !parentID || session.parentID === parentID);
        return json(response, { data: list, cursor: { next: null } });
      }
      if (url.pathname === "/api/session" && request.method === "POST") {
        const parsed = JSON.parse(body || "{}");
        const created = {
          id: "ses_created",
          title: parsed.title,
          model: parsed.model,
          permissions: parsed.permissions,
          location: parsed.location,
          time: { created: 1_000, updated: 1_000 },
        };
        state.sessions[created.id] = created;
        return json(response, { data: created });
      }

      const sessionMatch = url.pathname.match(/^\/api\/session\/([^/]+)(?:\/(.*))?$/);
      if (sessionMatch) {
        const [, id, rest] = sessionMatch;
        const session = state.sessions[id];
        if (!session) return json(response, { _tag: "SessionNotFoundError", sessionID: id, message: "session not found" });
        if (!rest && request.method === "PATCH") {
          session.permissions = JSON.parse(body || "{}").permissions;
          return json(response, { data: session });
        }
        if (!rest) return json(response, { data: session.readbackId ? { ...session, id: session.readbackId } : session });
        if (rest === "message" && request.method === "GET") {
          if (url.searchParams.has("cursor") && session.emptyCursorTail === true) {
            return json(response, {data:[],cursor:{previous:null,next:null},...session.tailEnvelope});
          }
          const messages = session.messages ?? [];
          const limit = Number(url.searchParams.get("limit") ?? messages.length);
          const ordered = url.searchParams.get("order") === "desc" ? [...messages].reverse() : messages;
          const filtered = url.searchParams.get("type") ? ordered.filter((m) => m.type === url.searchParams.get("type")) : ordered;
          return json(response, { data: filtered.slice(0, limit), cursor: {}, ...session.messageEnvelope });
        }
        if (rest === "prompt" && request.method === "POST") {
          const parsed = JSON.parse(body || "{}");
          const inbox = { id: `msg_${parsed.delivery}`, sessionID: id, type: "user", payload: { text: parsed.text, metadata: parsed.metadata }, delivery: parsed.delivery };
          session.messages = [...(session.messages ?? []), { id: inbox.id, type: "user", metadata: parsed.metadata, text: parsed.text }];
          return json(response, { data: inbox });
        }
        if (rest === "interrupt") return json(response, { data: { interrupted: true } });
        if (rest === "fork") {
          const forked = { ...session, id: "ses_forked", title: `${session.title} (fork)`, parentID: id };
          state.sessions[forked.id] = forked;
          return json(response, { data: forked });
        }
        if (rest === "model" && request.method === "POST") {
          const parsed = JSON.parse(body || "{}");
          session.model = parsed.model;
          response.statusCode = 204;
          return response.end();
        }
        if (rest === "wait") { response.statusCode = 204; return response.end(); }
        if (rest === "permission") {
          const reply = rest === "permission" && url.pathname.endsWith("/reply");
          if (request.method === "POST" && url.pathname.endsWith("/reply")) return json(response, { decision: JSON.parse(body || "{}").decision });
          if (request.method === "POST") return json(response, { data: [] });
          return json(response, { data: [] });
        }
      }
      const replyMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/);
      if (replyMatch && request.method === "POST") {
        response.statusCode = 204;
        return response.end();
      }
      if (url.pathname.match(/^\/api\/experimental\/session\/[^/]+\/wait$/)) {
        response.statusCode = 204;
        return response.end();
      }
      json(response, { _tag: "RouteNotFound", message: `no route ${url.pathname}` });
    });
  });
}

async function start(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

function sessionFixture() {
  return {
    calls: [] as Call[],
    active: {} as Record<string, any>,
    permissions: [] as any[],
    sessions: {
      ses_running: {
        id: "ses_running",
        title: "Running session",
        location: { directory: "/tmp/project" },
        parentID: "ses_root",
        model: { providerID: "minimax-coding-plan", id: "flash" },
        cost: 0.25,
        outcome: "succeeded",
        time: { created: 1_700_000_000_000, updated: 1_700_000_060_000 },
      },
      ses_idle: {
        id: "ses_idle",
        title: "Idle session",
        location: { directory: "/tmp/project" },
        outcome: "failed",
        time: { created: 1_700_000_000_000, updated: 1_700_000_090_000 },
      },
      ses_root: {
        id: "ses_root",
        title: "Root session",
        location: { directory: "/tmp/project" },
        time: { created: 1_699_000_000_000, updated: 1_699_000_060_000 },
      },
    } as Record<string, any>,
  };
}

it("detects the v2 protocol and never treats the SPA shell as JSON", async () => {
  const state = sessionFixture();
  state.active = { ses_running: { type: "running" } };
  const server = v2Fixture(state);
  const adapter = new OpenCodeAdapter({ baseUrl: await start(server) });
  try {
    await adapter.init();
    const sessions = await adapter.listSessions();
    // Legacy paths would have answered with the HTML shell and thrown.
    expect(state.calls.every((call) => call.path.startsWith("/api/"))).toBe(true);
    expect(sessions.map((session) => session.id)).toContain("ses_running");
    const running = sessions.find((session) => session.id === "ses_running")!;
    expect(running).toMatchObject({ harness: "opencode", status: "running", cwd: "/tmp/project", model: "minimax-coding-plan/flash", costUsd: 0.25 });
    expect(sessions.find((session) => session.id === "ses_idle")!.status).toBe("error");
  } finally {
    server.close();
  }
});

it("rejects unknown V2 permission modes without writing an allow rule", async () => {
  const state = sessionFixture();
  const server = v2Fixture(state);
  const adapter = new OpenCodeAdapter({ baseUrl: await start(server) });
  try {
    await adapter.init();
    const before = state.calls.length;
    const result = await adapter.setPermissions("ses_running", { mode: "mystery" });
    expect(result.ok).toBe(false);
    expect(state.calls.slice(before).some((call) => call.method === "PATCH" && call.path === "/api/session/ses_running")).toBe(false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("sets V2 Full Access on the selected session and confirms native readback", async () => {
  const state = sessionFixture();
  const server = v2Fixture(state);
  const adapter = new OpenCodeAdapter({ baseUrl: await start(server) });
  try {
    await adapter.init();
    expect(await adapter.setPermissions("ses_running", { mode: "fullAuto" })).toEqual({ ok: true });
    expect(state.sessions.ses_running.permissions).toEqual([{ action: "*", resource: "*", effect: "allow" }]);
    expect(state.calls.some((call) => call.method === "PATCH" && call.path === "/api/session/ses_running")).toBe(true);
    expect(state.calls.some((call) => call.method === "GET" && call.path === "/api/session/ses_running")).toBe(true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("rejects a Full Access readback returned for a different native session", async () => {
  const state = sessionFixture();
  state.sessions.ses_running.readbackId = "ses_other";
  const server = v2Fixture(state);
  const adapter = new OpenCodeAdapter({ baseUrl: await start(server) });
  try {
    await adapter.init();
    expect(await adapter.setPermissions("ses_running", { mode: "fullAuto" })).toMatchObject({ ok: false, error: expect.stringContaining("different or missing session id") });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("reads the selected V2 session mode and only its exact pending requests", async () => {
  const state = sessionFixture();
  state.sessions.ses_running.permissions = [{ action: "*", resource: "*", effect: "allow" }];
  state.permissions = [
    { id: "perm_selected", sessionID: "ses_running", action: "bash", resources: ["pwd"], message: "Run command" },
    { id: "perm_other", sessionID: "ses_idle", action: "write", resources: ["file"] },
  ];
  const server = v2Fixture(state);
  const adapter = new OpenCodeAdapter({ baseUrl: await start(server) });
  try {
    await adapter.init();
    expect(await adapter.getPermissionState("ses_running")).toMatchObject({
      target: { harness: "opencode", sessionId: "ses_running" },
      currentMode: "allow",
      scope: "session",
      pendingRequests: [{ id: "perm_selected", toolName: "bash", command: "pwd", reason: "Run command" }],
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("returns the exact native inbox input id and carries the stable Herder input id as metadata", async () => {
  const state = sessionFixture();
  const server = v2Fixture(state);
  const adapter = new OpenCodeAdapter({ baseUrl: await start(server) });
  try {
    await adapter.init();
    const sent = await adapter.sendMessage("ses_running", {
      message: "reply OK",
      queue: true,
      inputId: "quota-recovery-input-123",
    });
    expect(sent).toMatchObject({ ok: true, admitted: true, nativeInputMessageId: "msg_queue" });
    const call = state.calls.find((entry) => entry.method === "POST" && entry.path === "/api/session/ses_running/prompt")!;
    expect(JSON.parse(call.body!)).toMatchObject({
      text: "reply OK",
      delivery: "queue",
      metadata: { agentHerderInputId: "quota-recovery-input-123" },
    });
  } finally {
    server.close();
  }
});

it("reads v2 permission requests as pending session input", async () => {
  const state = sessionFixture();
  state.active = { ses_running: { type: "running" } };
  state.permissions = [{ id: "per_1", sessionID: "ses_running", action: "bash", resources: ["rm -rf /tmp/x"], message: "run command" }];
  const server = v2Fixture(state);
  const adapter = new OpenCodeAdapter({ baseUrl: await start(server) });
  try {
    const session = (await adapter.listSessions()).find((item) => item.id === "ses_running")!;
    expect(session.needsPermission).toBe(true);
    expect(session.permissionDetails).toMatchObject({ id: "per_1", type: "bash", toolName: "bash", description: "run command" });
  } finally {
    server.close();
  }
});

it("creates v2 sessions with a native location and admits queued and steering prompts", async () => {
  const state = sessionFixture();
  const server = v2Fixture(state);
  const adapter = new OpenCodeAdapter({ baseUrl: await start(server) });
  try {
    const created = await adapter.createSession({ name: "worker", cwd: "/tmp/project", model: "minimax-coding-plan/flash", fullAccess: true });
    expect(created).toMatchObject({ id: "ses_created", title: "worker", cwd: "/tmp/project" });
    const create = state.calls.find((call) => call.path === "/api/session" && call.method === "POST")!;
    expect(JSON.parse(create.body!)).toMatchObject({
      title: "worker",
      location: { directory: "/tmp/project" },
      model: { providerID: "minimax-coding-plan", id: "flash" },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    });

    expect(await adapter.sendMessage("ses_idle", { message: "queued work", queue: true })).toMatchObject({ ok: true, admitted: true });
    expect(await adapter.sendMessage("ses_idle", { message: "steer me" })).toMatchObject({ ok: true, admitted: true });
    const prompts = state.calls.filter((call) => call.path === "/api/session/ses_idle/prompt");
    expect(prompts.map((call) => JSON.parse(call.body!).delivery)).toEqual(["queue", "steer"]);
  } finally {
    server.close();
  }
});

it("reads OmniRoute models from the native catalog and confirms a session model switch", async () => {
  const state = sessionFixture();
  state.models = [
    { id: "glm", modelID: "glm/MiniMax-M3.1-Flash", providerID: "omniroute" },
  ];
  state.sessions.ses_idle.model = { providerID: "openrouter", id: "old-model" };
  state.sessions.ses_idle.messages = [
    { id: "old-assistant", role: "assistant", type: "assistant", model: { providerID: "openrouter", id: "old-model" }, content: [{ type: "text", text: "previous run" }] },
  ];
  const server = v2Fixture(state);
  const adapter = new OpenCodeAdapter({ baseUrl: await start(server) });
  try {
    await adapter.init();
    const fallback = "omniroute/glm/MiniMax-M3.1-Flash";
    expect(await adapter.listModels()).toEqual([fallback]);
    expect(await adapter.changeModel("ses_idle", fallback)).toEqual({ ok: true });
    // The native catalog names the gateway id; OpenCode dispatches the
    // catalog key that carries it, so the session reads back the key.
    const session = await adapter.getSession("ses_idle");
    expect(session?.model).toBe("omniroute/glm");
    const call = state.calls.find((entry) => entry.path === "/api/session/ses_idle/model" && entry.method === "POST");
    expect(JSON.parse(call!.body!)).toEqual({ model: { providerID: "omniroute", id: "glm" } });
  } finally {
    server.close();
  }
});

it("resolves the exact OpenCode combo ID into its complete configured OmniRoute provider leaves", async () => {
  const state = sessionFixture();
  state.models = [{ id: "minimax-combo-m3.1", modelID: "minimax-combo-m3.1", providerID: "omniroute" }];
  const server = v2Fixture(state);
  const calls: Array<{ url: string; method?: string; authorization: string | null }> = [];
  const gatewayModels = [
    { id: "minimax-combo-m3.1", owned_by: "combo", root: "minimax-combo-m3.1", parent: null },
    { id: "mmcode/MiniMax-M3.1-Flash", owned_by: "minimax-code", root: "MiniMax-M3.1-Flash", parent: null },
    { id: "minimax/MiniMax-M3.1-Flash", owned_by: "minimax", root: "MiniMax-M3.1-Flash", parent: null },
  ];
  let modelMappings = [
    { id: "mapping-target", comboId: "combo-uuid", comboName: "minimax-combo-m3.1", pattern: "minimax-combo-m3.1/MiniMax-M3.1-Flash", enabled: true },
    { id: "mapping-other-a", comboId: "other-a", comboName: "glm-5.3-flash-minimax-m3.1", pattern: "glm-5.3-flash-minimax-m3.1/glm-5.3-flash", enabled: true },
    { id: "mapping-other-b", comboId: "other-b", comboName: "minimax-combo-m3", pattern: "minimax-combo-m3/MiniMax-M3", enabled: true },
  ];
  let modelAliases: Record<string, string> = {};
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    calls.push({ url: `${url.origin}${url.pathname}`, method: init?.method, authorization: new Headers(init?.headers).get("authorization") });
    const payload = url.pathname === "/v1/models"
      ? { object: "list", data: gatewayModels }
      : url.pathname === "/api/combos"
        ? { total: 1, combos: [{ id: "combo-uuid", name: "minimax-combo-m3.1", strategy: "priority", models: [
          { providerId: "minimax-code", model: "mmcode/MiniMax-M3.1-Flash" },
          { providerId: "minimax", model: "minimax/MiniMax-M3.1-Flash" },
        ] }] }
        : url.pathname === "/api/model-combo-mappings"
          ? { total: modelMappings.length, mappings: modelMappings }
          : { aliases: modelAliases, catalogVersion: "fixture" };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  const adapter = new OpenCodeAdapter({ baseUrl: await start(server) });
  try {
    await expect(adapter.resolveModelProviderLeaves("omniroute/minimax-combo-m3.1", {
      omniRouteBaseUrl: "http://omniroute.test", omniRouteApiKey: "fixture-key", fetcher,
    })).resolves.toEqual({
      nativeHarness: "opencode",
      nativeModelId: "omniroute/minimax-combo-m3.1",
      providerId: "omniroute",
      modelId: "minimax-combo-m3.1",
      resolvedProviderLeaves: [
        { providerId: "minimax-code", modelId: "mmcode/MiniMax-M3.1-Flash" },
        { providerId: "minimax", modelId: "minimax/MiniMax-M3.1-Flash" },
      ],
    });
    expect(calls.map(({ url, method }) => [url, method])).toEqual(expect.arrayContaining([
      ["http://omniroute.test/v1/models", "GET"],
      ["http://omniroute.test/api/combos", "GET"],
      ["http://omniroute.test/api/model-combo-mappings", "GET"],
      ["http://omniroute.test/api/models/alias", "GET"],
    ]));
    expect(calls.every((call) => call.authorization === "Bearer fixture-key")).toBe(true);

    modelAliases = { "minimax-combo-m3.1": "other-combo" };
    await expect(adapter.resolveModelProviderLeaves("omniroute/minimax-combo-m3.1", {
      omniRouteBaseUrl: "http://omniroute.test", omniRouteApiKey: "fixture-key", fetcher,
    })).resolves.toBeNull();
    modelAliases = {};

    modelMappings = [
      { ...modelMappings[0]!, pattern: "minimax-combo-m3.1/rewritten-model" },
      ...modelMappings.slice(1),
    ];
    await expect(adapter.resolveModelProviderLeaves("omniroute/minimax-combo-m3.1", {
      omniRouteBaseUrl: "http://omniroute.test", omniRouteApiKey: "fixture-key", fetcher,
    })).resolves.toBeNull();

    modelMappings = [
      { id: "mapping-target-duplicate", comboId: "combo-uuid", comboName: "minimax-combo-m3.1", pattern: "minimax-combo-m3.1/MiniMax-M3.1-Flash", enabled: true },
      ...modelMappings,
    ];
    await expect(adapter.resolveModelProviderLeaves("omniroute/minimax-combo-m3.1", {
      omniRouteBaseUrl: "http://omniroute.test", omniRouteApiKey: "fixture-key", fetcher,
    })).resolves.toBeNull();

    modelMappings = [
      { id: "mapping-overlap", comboId: "other-combo", comboName: "other-combo", pattern: "minimax-combo-m3.1/MiniMax-M3.1-Flash", enabled: true },
      { id: "mapping-other-a", comboId: "other-a", comboName: "glm-5.3-flash-minimax-m3.1", pattern: "glm-5.3-flash-minimax-m3.1/glm-5.3-flash", enabled: true },
      { id: "mapping-other-b", comboId: "other-b", comboName: "minimax-combo-m3", pattern: "minimax-combo-m3/MiniMax-M3", enabled: true },
    ];
    await expect(adapter.resolveModelProviderLeaves("omniroute/minimax-combo-m3.1", {
      omniRouteBaseUrl: "http://omniroute.test", omniRouteApiKey: "fixture-key", fetcher,
    })).resolves.toBeNull();
  } finally {
    server.close();
  }
});

it("recursively resolves nested configured OmniRoute combos and fails closed on incomplete trees", async () => {
  const state = sessionFixture();
  state.models = [{ id: "outer-combo", modelID: "outer-combo", providerID: "omniroute" }];
  const server = v2Fixture(state);
  const makeFetcher = (total: number, rows: unknown[]): typeof fetch => async (input) => {
    const path = new URL(typeof input === "string" ? input : input.toString()).pathname;
    const payload = path === "/v1/models"
      ? { data: [
        { id: "outer-combo", owned_by: "combo", root: "outer-combo", parent: null },
        { id: "inner-combo", owned_by: "combo", root: "inner-combo", parent: null },
        { id: "mmcode/MiniMax-M3.1-Flash", owned_by: "minimax-code", root: "MiniMax-M3.1-Flash", parent: null },
        { id: "minimax/MiniMax-M3.1-Flash", owned_by: "minimax", root: "MiniMax-M3.1-Flash", parent: null },
      ] }
      : path === "/api/combos" ? { total, combos: rows }
        : path === "/api/model-combo-mappings" ? { total: 0, mappings: [] }
          : { aliases: {} };
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  const adapter = new OpenCodeAdapter({ baseUrl: await start(server) });
  const tree = [
    { id: "outer-id", name: "outer-combo", models: [{ providerId: "combo", model: "inner-combo" }] },
    { id: "inner-id", name: "inner-combo", models: [
      { providerId: "minimax-code", model: "mmcode/MiniMax-M3.1-Flash" },
      { providerId: "minimax", model: "minimax/MiniMax-M3.1-Flash" },
    ] },
  ];
  try {
    const options = { omniRouteBaseUrl: "http://omniroute.test", omniRouteApiKey: "fixture-key" };
    await expect(adapter.resolveModelProviderLeaves("omniroute/outer-combo", { ...options, fetcher: makeFetcher(2, tree) }))
      .resolves.toMatchObject({ resolvedProviderLeaves: [
        { providerId: "minimax-code", modelId: "mmcode/MiniMax-M3.1-Flash" },
        { providerId: "minimax", modelId: "minimax/MiniMax-M3.1-Flash" },
      ] });
    await expect(adapter.resolveModelProviderLeaves("omniroute/outer-combo", { ...options, fetcher: makeFetcher(3, tree) }))
      .resolves.toBeNull();
  } finally {
    server.close();
  }
});

it("steers a live v2 turn natively and records the once-only receipt", async () => {
  const state = sessionFixture();
  // Unique identity: the durable receipt store outlives a single test run.
  const sessionId = `ses_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const inputId = `input-${randomUUID()}`;
  state.sessions[sessionId] = {
    id: sessionId,
    title: "Steerable session",
    location: { directory: "/tmp/project" },
    time: { created: 1_700_000_000_000, updated: 1_700_000_060_000 },
    messages: [
      { id: "msg_user_1", type: "user", text: "initial task" },
      { id: "msg_assistant_1", type: "assistant", content: [{ type: "text", text: "working" }] },
    ],
  };
  state.active = { [sessionId]: { type: "running" } };
  const server = v2Fixture(state);
  const adapter = new OpenCodeAdapter({ baseUrl: await start(server) });
  try {
    expect(await adapter.getCoordinationActiveTurnId(sessionId)).toBe("msg_user_1");
    const delivered = await adapter.sendActiveMessage(sessionId, { message: "changed priority", inputId });
    expect(delivered).toMatchObject({ ok: true, admitted: true });
    const steer = state.calls.filter((call) => call.path === `/api/session/${sessionId}/prompt`);
    expect(steer).toHaveLength(1);
    expect(JSON.parse(steer[0].body!)).toMatchObject({ text: "changed priority", delivery: "steer" });

    const repeat = await adapter.sendActiveMessage(sessionId, { message: "changed priority", inputId });
    expect(repeat).toMatchObject({ ok: true, admitted: true });
    expect(state.calls.filter((call) => call.path === `/api/session/${sessionId}/prompt`)).toHaveLength(1);
  } finally {
    server.close();
  }
});

it("refuses active-turn delivery when the v2 session is idle", async () => {
  const state = sessionFixture();
  const server = v2Fixture(state);
  const adapter = new OpenCodeAdapter({ baseUrl: await start(server) });
  try {
    const result = await adapter.sendActiveMessage("ses_idle", { message: "you are idle" });
    expect(result).toMatchObject({ ok: false, notSubmitted: true });
    expect(state.calls.some((call) => call.path === "/api/session/ses_idle/prompt")).toBe(false);
  } finally {
    server.close();
  }
});

it("reads v2 history without turn-status frames and surfaces provider failures", async () => {
  const state = sessionFixture();
  state.sessions.ses_idle.messages = [
    { id: "msg_user_1", type: "user", text: "проверь претензии кода" },
    { id: "msg_assistant_1", type: "assistant", model: { providerID: "omniroute", id: "zc/glm-5.3-flash" }, content: [{ type: "text", text: "читаю файлы" }] },
    { id: "msg_exec_1", time: { created: 10 }, type: "idle", outcome: "succeeded" },
    { id: "msg_exec_2", time: { created: 20 }, type: "idle", outcome: "failed", error: { type: "provider.internal", message: "[502]: Model request was cancelled." } },
    { id: "msg_assistant_2", type: "assistant", model: { providerID: "omniroute", id: "zc/glm-5.3-flash" }, finish: "error", content: [], error: { type: "provider.internal", message: "[502]: Model request was cancelled." } },
    { id: "msg_exec_3", time: { created: 30 }, type: "idle", outcome: "failed", error: { type: "provider.internal", message: "[502]: Model request was cancelled." } },
  ];
  const server = v2Fixture(state);
  const adapter = new OpenCodeAdapter({ baseUrl: await start(server) });
  try {
    // The execution frames (idle + outcome) are not assistant messages.
    const messages = (await adapter.getSessionMessages("ses_idle", 3))!;
    expect(messages.map((message) => message.id)).toEqual(["msg_user_1", "msg_assistant_1", "msg_assistant_2"]);
    expect(messages[1]).toMatchObject({ role: "assistant", model: "omniroute/zc/glm-5.3-flash", text: "читаю файлы" });
    // The failed assistant turn shows its provider error instead of an empty bubble.
    expect(messages[2]).toMatchObject({ role: "assistant", text: "Ошибка хода: [502]: Model request was cancelled." });

    const idle = await adapter.getSession("ses_idle");
    expect(idle!.lastMessage).toContain("Model request was cancelled");
  } finally {
    server.close();
  }
});

it("exposes a status-only v2 window as an explicit turn failure, not empty assistants", async () => {
  const state = sessionFixture();
  state.sessions.ses_idle.messages = [
    { id: "msg_exec_failed", time: { created: 1 }, type: "idle", outcome: "failed", error: { type: "provider.internal", message: "[502]: Model request was cancelled." } },
  ];
  const server = v2Fixture(state);
  const adapter = new OpenCodeAdapter({ baseUrl: await start(server) });
  try {
    const messages = (await adapter.getSessionMessages("ses_idle", 3))!;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "assistant", text: "Ошибка хода: [502]: Model request was cancelled." });
  } finally {
    server.close();
  }
});


it("controls v2 turns, lineage, recovery, permissions and models", async () => {
  const state = sessionFixture();
  const server = v2Fixture(state);
  const adapter = new OpenCodeAdapter({ baseUrl: await start(server) });
  try {
    expect(await adapter.cancelTurn("ses_running")).toEqual({ ok: true });
    expect(state.calls.some((call) => call.path === "/api/session/ses_running/interrupt" && call.method === "POST")).toBe(true);

    const children = await adapter.listChildren("ses_root");
    expect(children.map((child) => child.id)).toEqual(["ses_running"]);
    expect(state.calls.some((call) => call.path.includes("parentID=ses_root"))).toBe(true);

    expect(await adapter.forkSession("ses_root", "continue here")).toMatchObject({ ok: true, sessionId: "ses_forked" });
    expect(await adapter.recover("ses_running", "resume please")).toMatchObject({ ok: true, admitted: true });
    expect(state.calls.some((call) => call.path === "/api/experimental/session/ses_running/wait")).toBe(true);

    expect(await adapter.respondPermission("ses_running", "per_1", "allow", true)).toEqual({ ok: true });
    expect(await adapter.respondPermission("ses_running", "per_1", "deny")).toEqual({ ok: true });
    const replies = state.calls.filter((call) => call.path.includes("/permission/per_1/reply"));
    expect(replies.map((call) => JSON.parse(call.body!).decision)).toEqual(["always", "reject"]);

    expect(await adapter.setPermissions("ses_running", { allowedTools: "read,edit", mode: "plan" })).toEqual({ ok: true });
    const patched = state.calls.find((call) => call.method === "PATCH")!;
    expect(JSON.parse(patched.body!).permissions).toEqual([
      { action: "read", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "allow" },
      { action: "*", resource: "*", effect: "ask" },
    ]);

    expect(await adapter.changeModel("ses_running", "minimax-coding-plan/flash")).toEqual({ ok: true });
    expect(await adapter.listModels()).toEqual(["openrouter/gpt-4.1", "minimax-coding-plan/flash"]);
  } finally {
    server.close();
  }
});

it("reads v2 messages newest-page-first into a chronological view", async () => {
  const state = sessionFixture();
  state.sessions.ses_running.messages = [
    { id: "msg_user_1", type: "user", text: "task" },
    { id: "msg_assistant_1", type: "assistant", content: [{ type: "text", text: "first" }] },
    { id: "msg_assistant_2", type: "assistant", content: [{ type: "tool", name: "shell", state: { status: "error", input: { command: "ls" }, error: { message: "boom" } } }, { type: "text", text: "second" }] },
  ];
  const server = v2Fixture(state);
  const adapter = new OpenCodeAdapter({ baseUrl: await start(server) });
  try {
    const messages = (await adapter.getSessionMessages("ses_running", 3))!;
    expect(messages.map((message) => message.id)).toEqual(["msg_user_1", "msg_assistant_1", "msg_assistant_2"]);
    expect(messages[0]).toMatchObject({ role: "user", text: "task" });
    expect(messages[2].parts).toEqual(expect.arrayContaining([
      { type: "tool_result", name: "shell", output: "boom", error: true },
    ]));
  } finally {
    server.close();
  }
});

it("unwraps v2 envelopes only when the payload is one", () => {
  expect(unwrapEnvelope({ data: [{ id: "ses_1" }], cursor: {} })).toEqual([{ id: "ses_1" }]);
  expect(unwrapEnvelope({ data: { ses_1: { type: "running" } } })).toEqual({ ses_1: { type: "running" } });
  expect(unwrapEnvelope({ id: "ses_1" })).toEqual({ id: "ses_1" });
  expect(unwrapEnvelope({ data: "payload", unexpected: true })).toEqual({ data: "payload", unexpected: true });
});

it("normalizes native v2 event frames", () => {
  const frames = [
    { id: "evt_1", type: "session.inbox.enqueued", data: { sessionID: "ses_1", inboxID: "msg_1" } },
    { id: "evt_2", type: "session.execution.started", data: { sessionID: "ses_1" } },
    { id: "evt_3", type: "session.execution.succeeded", data: { sessionID: "ses_1" } },
    { id: "evt_4", type: "session.execution.failed", data: { sessionID: "ses_1" } },
    { id: "evt_5", type: "permission.asked", data: { sessionID: "ses_1", permissionID: "per_1" } },
    { id: "evt_6", type: "session.deleted", data: { sessionID: "ses_1" } },
  ];
  expect(frames.map((frame) => normalizeOpenCodeEvent(frame)?.kind)).toEqual([
    "message.updated", "turn.started", "turn.completed", "turn.failed", "permission.requested", "session.deleted",
  ]);
  // The core owns protocol facts only: identity, directory and native type.
  const started = normalizeOpenCodeEvent(frames[1])!;
  expect(started).toMatchObject({ kind: "turn.started", sessionId: "ses_1", nativeType: "session.execution.started" });
  expect(started.data).toMatchObject({ nativeEventId: "evt_2" });
  expect(normalizeOpenCodeEvent({ type: "provider.updated", data: {} })?.kind).toBe("unknown");
  const failed = normalizeOpenCodeEvent({
    id: "evt_failed",
    type: "session.execution.failed",
    data: {
      sessionID: "ses_1",
      turnId: "turn_native_1",
      inputId: "input_native_1",
      error: {
        type: "QuotaExceeded",
        code: "quota_exhausted",
        status: 400,
        message: "Weekly/Monthly Limit Exhausted; Authorization: Bearer sk-abcdefghijklmnop",
      },
    },
  })!;
  expect(failed.data).toMatchObject({
    nativeEventId: "evt_failed",
    turnId: "turn_native_1",
    inputId: "input_native_1",
    nativeErrorType: "QuotaExceeded",
    nativeErrorCode: "quota_exhausted",
    nativeErrorStatus: 400,
  });
  expect(failed.data?.nativeErrorMessage).toContain("Weekly/Monthly Limit Exhausted");
  expect(JSON.stringify(failed)).not.toContain("sk-abcdefghijklmnop");
  // Legacy frames keep working unchanged.
  expect(normalizeOpenCodeEvent({ type: "message.updated", properties: { info: {
    sessionID: "ses_2", id: "msg_2", parentID: "msg_user_2", role: "assistant",
    providerID: "omniroute", modelID: "minimax/MiniMax-M3.1-Flash",
    metadata: { agentHerderInputId: "input_2" },
  } } })).toMatchObject({
    kind: "message.updated", sessionId: "ses_2", messageId: "msg_2",
    data: {
      nativeMessageId: "msg_2", nativeMessageRole: "assistant",
      nativeParentMessageId: "msg_user_2", nativeProviderId: "omniroute",
      nativeModelId: "minimax/MiniMax-M3.1-Flash", inputId: "input_2",
    },
  });
});

it("maps an exact delivered inbox ID onto the following native started event without inventing a turn ID", async () => {
  const adapter = new OpenCodeAdapter({ protocol: "v2" });
  const correlate = (adapter as unknown as { correlateInboxStart: (event: ReturnType<typeof normalizeOpenCodeEvent>) => ReturnType<typeof normalizeOpenCodeEvent> })
    .correlateInboxStart.bind(adapter);
  const delivered = normalizeOpenCodeEvent({ type: "session.inbox.delivered", data: { sessionID: "ses_1", inboxID: "msg_exact_1" } })!;
  const started = normalizeOpenCodeEvent({ type: "session.execution.started", data: { sessionID: "ses_1" } })!;
  correlate(delivered);
  expect(correlate(started)?.data).toMatchObject({ inputId: "msg_exact_1", nativeInputMessageId: "msg_exact_1" });
  expect(correlate(started)?.data).not.toHaveProperty("turnId");
});

it("fails closed when multiple native inbox deliveries make the following start ambiguous", () => {
  const adapter = new OpenCodeAdapter({ protocol: "v2" });
  const correlate = (adapter as unknown as { correlateInboxStart: (event: ReturnType<typeof normalizeOpenCodeEvent>) => ReturnType<typeof normalizeOpenCodeEvent> })
    .correlateInboxStart.bind(adapter);
  correlate(normalizeOpenCodeEvent({ type: "session.inbox.delivered", data: { sessionID: "ses_1", inboxID: "msg_1" } })!);
  correlate(normalizeOpenCodeEvent({ type: "session.inbox.delivered", data: { sessionID: "ses_1", inboxID: "msg_2" } })!);
  const started = normalizeOpenCodeEvent({ type: "session.execution.started", data: { sessionID: "ses_1" } })!;
  expect(correlate(started)?.data).not.toHaveProperty("inputId");
});

it("correlates an exact terminal event to the native root input and persists the same quota proof on getSession", async () => {
  const state = sessionFixture();
  state.sessions.ses_failed = {
    id: "ses_failed",
    title: "Failed quota session",
    location: { directory: "/tmp/project" },
    outcome: "failed",
    time: { created: 1_700_000_000_000, updated: 1_700_000_090_000 },
    messages: [
      { info: { id: "user_native_1", role: "user", sessionID: "ses_failed", metadata: { agentHerderInputId: "input_native_1" } }, parts: [{ type: "text", text: "resume controlled task" }] },
      {
        info: {
          id: "assistant_native_1", parentID: "user_native_1", role: "assistant", sessionID: "ses_failed",
          providerID: "omniroute", modelID: "minimax/MiniMax-M3.1-Flash",
          time: { created: 1_700_000_010_000, completed: 1_700_000_090_000 },
          error: { type: "QuotaExceeded", code: "quota_exhausted", status: 400, message: "Weekly/Monthly Limit Exhausted" },
        },
        finish: "error", parts: [],
      },
      {
        id: "evt_native_failed_1", turnId: "turn_native_1", type: "idle", outcome: "failed",
        time: { created: 1_700_000_090_000 },
        error: { type: "QuotaExceeded", code: "quota_exhausted", status: 400, message: "Weekly/Monthly Limit Exhausted" },
      },
    ],
  };
  state.active.ses_failed = { type: "idle" };
  const server = v2Fixture(state);
  const adapter = new OpenCodeAdapter({ baseUrl: await start(server) });
  try {
    await adapter.init();
    const session = await adapter.getSession("ses_failed");
    expect(session?.meta?.nativeLastTurn).toMatchObject({
      turnId: "turn_native_1",
      inputId: "input_native_1",
      status: "failed",
      quotaFailure: {
        classification: "quota_exhausted",
        nativeTurnId: "turn_native_1",
        inputId: "input_native_1",
        providerId: "omniroute",
        modelId: "minimax/MiniMax-M3.1-Flash",
        status: "failed",
      },
    });
    state.sessions.ses_no_turn_id = {
      ...state.sessions.ses_failed,
      id: "ses_no_turn_id",
      messages: state.sessions.ses_failed.messages.map((message: any) =>
        message.type === "idle" ? { ...message, id: "evt_without_turn_id", turnId: undefined }
          : message.info?.id === "assistant_native_1" ? { ...message, info: { ...message.info, turnId: undefined } } : message),
    };
    state.active.ses_no_turn_id = { type: "idle" };
    expect((await adapter.getSession("ses_no_turn_id"))?.meta?.nativeLastTurn?.quotaFailure).toMatchObject({
      nativeTurnId: "assistant_native_1",
      inputId: "input_native_1",
    });
    state.sessions.ses_missing_parent = {
      ...state.sessions.ses_no_turn_id,
      id: "ses_missing_parent",
      messages: state.sessions.ses_no_turn_id.messages.map((message: any) =>
        message.info?.id === "assistant_native_1" ? { ...message, info: { ...message.info, parentID: undefined } } : message),
    };
    state.active.ses_missing_parent = { type: "idle" };
    expect((await adapter.getSession("ses_missing_parent"))?.meta?.nativeLastTurn?.quotaFailure).toBeUndefined();

    const event = normalizeOpenCodeEvent({
      id: "evt_native_failed_1",
      type: "session.execution.failed",
      data: { sessionID: "ses_failed", error: { type: "QuotaExceeded", code: "quota_exhausted", status: 400, message: "Weekly/Monthly Limit Exhausted" } },
    })!;
    const normalized = await (adapter as unknown as { toQuotaAwareHarnessEvent(event: unknown): Promise<any> }).toQuotaAwareHarnessEvent(event);
    expect(normalized?.data).toMatchObject({
      turnId: "turn_native_1",
      inputId: "input_native_1",
      quotaFailure: { classification: "quota_exhausted", providerId: "omniroute", modelId: "minimax/MiniMax-M3.1-Flash" },
    });

    const conflict = normalizeOpenCodeEvent({
      id: "evt_native_failed_1", type: "session.execution.failed",
      data: { sessionID: "ses_failed", turnId: "other-turn", error: { type: "QuotaExceeded", status: 400, message: "Weekly/Monthly Limit Exhausted" } },
    })!;
    expect((await (adapter as unknown as { toQuotaAwareHarnessEvent(event: unknown): Promise<any> }).toQuotaAwareHarnessEvent(conflict))?.data?.quotaFailure).toBeUndefined();
    state.sessions.ses_failed.messages.push({ id: "new-user-after-failure", type: "user", role: "user", text: "new task" });
    const afterNewInput = await adapter.getSession("ses_failed");
    expect(afterNewInput?.meta?.nativeLastTurn?.quotaFailure).toBeUndefined();
  } finally {
    server.close();
  }
});

it("projects exact failed-turn identity for operator continuation without quota or plugin metadata proof", async () => {
  const state = sessionFixture();
  state.sessions.ses_operator_continue = {
    id: "ses_operator_continue",
    title: "Historical provider failure",
    location: { directory: "/tmp/project" },
    outcome: "failed",
    messages: [
      { id: "user_native_exact", type: "user", info: { id: "user_native_exact", role: "user" }, parts: [] },
      {
        id: "assistant_native_exact",
        type: "assistant",
        info: {
          id: "assistant_native_exact", role: "assistant", providerID: "minimax-code",
          modelID: "MiniMax-M3.1-Flash", time: { created: 1_798_000_000_000, completed: 1_798_000_000_250 },
          error: { type: "ProviderError", message: "Native provider request failed" },
        },
        finish: "error", parts: [],
      },
      { id: "idle_native_exact", type: "idle", outcome: "failed", time: { created: 1_798_000_000_250 } },
    ],
  };
  state.active.ses_operator_continue = { type: "idle" };
  const server = v2Fixture(state);
  const adapter = new OpenCodeAdapter({ baseUrl: await start(server) });
  try {
    await adapter.init();
    const session = await adapter.getSession("ses_operator_continue");
    expect(session?.meta?.nativeLastTurn).toEqual({
      sessionId: "ses_operator_continue",
      turnId: "assistant_native_exact",
      assistantMessageId: "assistant_native_exact",
      providerId: "minimax-code",
      modelId: "MiniMax-M3.1-Flash",
      status: "failed",
      completedAt: 1_798_000_000_250,
    });
    expect(session?.meta?.nativeLastTurn).not.toHaveProperty("quotaFailure");
  } finally {
    server.close();
  }
});

it("projects a separately identified rejected OpenCode admission without creating nativeLastTurn", async () => {
  const state = sessionFixture();
  const sessionId = "ses_guard_rejected";
  const nativeInputMessageId = "msg_15ca9b506001ikwvM8wXJK89Ci";
  const inputId = "herder-quota:a1786e18-4bf0-44cc-9c7b-b8d7a441003a";
  const terminalEventId = "msg_15ca9b93c001CXilKWuX1NG20b";
  const errorMessage = "Agent Herder blocked this model request: the complete native provider route is forbidden or could not be verified for this project.";
  state.sessions[sessionId] = {
    id: sessionId,
    title: "Rejected restricted model request",
    location: { directory: "/tmp/project" },
    outcome: "failed",
    time: { created: 1_700_000_000_000, updated: 1_700_000_010_000 },
    messages: [
      {
        id: nativeInputMessageId, type: "user", role: "user",
        metadata: { agentHerderInputId: inputId }, time: { created: 1_700_000_001_000 }, parts: [],
      },
      {
        id: terminalEventId, type: "idle", outcome: "failed",
        error: { type: "unknown", message: errorMessage }, time: { created: 1_700_000_002_000 },
      },
    ],
  };
  state.active[sessionId] = { type: "idle" };
  const server = v2Fixture(state);
  const adapter = new OpenCodeAdapter({ baseUrl: await start(server) });
  try {
    await adapter.init();
    const session = await adapter.getSession(sessionId);
    expect(session?.meta?.nativeRejectedAttempt).toEqual({
      sessionId,
      nativeInputMessageId,
      inputId,
      terminalEventId,
      status: "failed",
      errorType: "unknown",
      errorMessage,
      terminalAt: 1_700_000_002_000,
    });
    expect(session?.meta?.nativeLastTurn).toBeUndefined();

    state.sessions[sessionId].messages.push({ id: "assistant_after_rejection", type: "assistant", role: "assistant", parts: [] });
    expect((await adapter.getSession(sessionId))?.meta?.nativeRejectedAttempt).toBeUndefined();
    state.sessions[sessionId].messages.pop();
    const exactTerminal = state.sessions[sessionId].messages[1];
    state.sessions[sessionId].messages[1] = {
      ...exactTerminal, error: { type: "unknown", message: "different failure" },
    };
    expect((await adapter.getSession(sessionId))?.meta?.nativeRejectedAttempt).toBeUndefined();
    state.sessions[sessionId].messages[1] = exactTerminal;
    state.sessions[sessionId].messages.push({ id: "new_user_after_rejection", type: "user", role: "user", parts: [] });
    expect((await adapter.getSession(sessionId))?.meta?.nativeRejectedAttempt).toBeUndefined();
    state.sessions[sessionId].messages.pop();
    state.active[sessionId] = { type: "running" };
    expect((await adapter.getSession(sessionId))?.meta?.nativeRejectedAttempt).toBeUndefined();
  } finally {
    server.close();
  }
});

it("keeps the exact failed native snapshot after a current-model change and status-only idle frame", async () => {
  const state = sessionFixture();
  state.sessions.ses_ea3bf238fffe4ezSGA5Ht2iWTX = {
    id: "ses_ea3bf238fffe4ezSGA5Ht2iWTX",
    title: "Failed session after fallback model selection",
    location: { directory: "/tmp/project" },
    outcome: "failed",
    model: { providerID: "omniroute", id: "minimax-combo-m3.1" },
    time: { created: 1_792_549_117_064, updated: 1_792_552_783_256, idle: 1_792_549_118_697 },
    messages: [
      {
        id: "msg_15c40dcca001ueFTuK9EQED9NG", type: "user",
        info: { id: "msg_15c40dcca001ueFTuK9EQED9NG", role: "user" },
        time: { created: 1_792_549_117_497 }, parts: [],
      },
      {
        id: "msg_15c40de46001ejIlGoK2JiYJ7c",
        type: "assistant",
        info: {
          id: "msg_15c40de46001ejIlGoK2JiYJ7c", role: "assistant",
          providerID: "minimax-coding-plan", modelID: "MiniMax-M3.1-Flash",
          time: { created: 1_792_549_117_771, completed: 1_792_549_118_685 },
        },
        // The exact failed idle frame carries the terminal error signal; the
        // assistant record itself has no error/finish marker in this fixture.
        parts: [],
      },
      {
        id: "msg_15c40e2e9001HgWtdyb2qH9TXS", type: "idle", outcome: "failed",
        error: { type: "provider.quota", status: 429 }, time: { created: 1_792_549_118_697 },
      },
      // This is the exact later native row from the live readback: model
      // selection appends a nonterminal status frame after the failure.
      {
        id: "msg_15c78cd98001PFBveo704dY7gO", type: "model-switched",
        model: { providerID: "omniroute", id: "minimax-combo-m3.1", variant: "default" },
        time: { created: 1_792_552_783_256 },
      },
    ],
  };
  state.active.ses_ea3bf238fffe4ezSGA5Ht2iWTX = { type: "idle" };
  const server = v2Fixture(state);
  const adapter = new OpenCodeAdapter({ baseUrl: await start(server) });
  try {
    await adapter.init();
    const session = await adapter.getSession("ses_ea3bf238fffe4ezSGA5Ht2iWTX");
    expect(session?.status).toBe("error");
    expect(session?.model).toBe("omniroute/minimax-combo-m3.1");
    expect(session?.meta?.nativeLastTurn).toMatchObject({
      sessionId: "ses_ea3bf238fffe4ezSGA5Ht2iWTX",
      turnId: "msg_15c40de46001ejIlGoK2JiYJ7c",
      assistantMessageId: "msg_15c40de46001ejIlGoK2JiYJ7c",
      providerId: "minimax-coding-plan",
      modelId: "MiniMax-M3.1-Flash",
      status: "failed",
      completedAt: 1_792_549_118_685,
    });
    state.sessions.ses_ea3bf238fffe4ezSGA5Ht2iWTX.messages.push({ id: "user_after_original_failure", type: "user", role: "user", parts: [] });
    expect((await adapter.getSession("ses_ea3bf238fffe4ezSGA5Ht2iWTX"))?.meta?.nativeLastTurn).toBeUndefined();
    state.sessions.ses_ea3bf238fffe4ezSGA5Ht2iWTX.messages.pop();
    state.sessions.ses_ea3bf238fffe4ezSGA5Ht2iWTX.messages.push({
      id: "idle_conflicting_outcome", type: "idle", outcome: "succeeded", time: { created: 1_792_552_783_500 },
    });
    expect((await adapter.getSession("ses_ea3bf238fffe4ezSGA5Ht2iWTX"))?.meta?.nativeLastTurn).toBeUndefined();
  } finally {
    server.close();
  }
});

it("projects metadata proof only when both native message IDs and parent link match fresh terminal records", async () => {
  const state = sessionFixture();
  state.sessions.ses_proof = {
    id: "ses_proof", title: "Metadata proof", location: { directory: "/tmp/project" }, outcome: "failed",
    metadata: { agentHerder: { quotaFailure: {
      version: 1, status: "failed", inputId: "stable_input", userMessageId: "user_exact",
      parentMessageId: "user_exact", assistantMessageId: "assistant_exact", nativeTurnId: "assistant_exact",
      providerId: "omniroute", modelId: "minimax/MiniMax-M3.1-Flash",
      errorCode: "quota_exhausted", errorMessage: "Weekly limit exhausted", statusCode: 429,
    } } },
    messages: [
      { id: "user_exact", role: "user" },
      { id: "assistant_exact", role: "assistant", model: { providerID: "omniroute", id: "minimax/MiniMax-M3.1-Flash" }, finish: "error", time: { completed: 1_700_000_000_100 } },
      { id: "status_exact", type: "idle", outcome: "failed", time: { created: 1_700_000_000_100 } },
    ],
  };
  state.active.ses_proof = { type: "idle" };
  const server = v2Fixture(state);
  const adapter = new OpenCodeAdapter({ baseUrl: await start(server) });
  try {
    await adapter.init();
    const session = await adapter.getSession("ses_proof");
    expect(session?.meta?.nativeLastTurn).toMatchObject({
      turnId: "assistant_exact", inputId: "stable_input", status: "failed",
      quotaFailure: { classification: "quota_exhausted", nativeTurnId: "assistant_exact", inputId: "stable_input" },
    });
    state.sessions.ses_proof.metadata.agentHerder.quotaFailure.parentMessageId = "different_user";
    expect((await adapter.getSession("ses_proof"))?.meta?.nativeLastTurn?.quotaFailure).toBeUndefined();
  } finally {
    server.close();
  }
});

it("the adapter adds Herder's orchestration shape on top of the core event", () => {
  const adapter = new OpenCodeAdapter({ baseUrl: "http://127.0.0.1:1", protocol: "v2" });
  const harnessEvent = (adapter as unknown as {
    toHarnessEvent(event: unknown): { kind: string; harness: string; at: string } | null;
  }).toHarnessEvent(normalizeOpenCodeEvent({ id: "evt_2", type: "session.execution.started", data: { sessionID: "ses_1" } }));
  expect(harnessEvent).toMatchObject({ kind: "turn.started", harness: "opencode" });
  expect(typeof harnessEvent?.at).toBe("string");
  expect((adapter as unknown as { toHarnessEvent(event: unknown): unknown }).toHarnessEvent({ kind: "unknown" })).toBeNull();
});

it("fails closed on a combo whose legs carry different model identities", async () => {
  const state = sessionFixture();
  state.models = [{ id: "minimax/MiniMax-M3.1-Flash", modelID: "minimax-combo-m3.1", providerID: "omniroute" }];
  const server = v2Fixture(state);
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const payload = url.pathname === "/v1/models"
      ? { object: "list", data: [
        { id: "minimax-combo-m3.1", owned_by: "combo", root: "minimax-combo-m3.1", parent: null },
        { id: "mmcode/MiniMax-M3.1-Flash", owned_by: "minimax-code", root: "MiniMax-M3.1-Flash", parent: null },
        { id: "minimax/MiniMax-M3", owned_by: "minimax", root: "MiniMax-M3", parent: null },
      ] }
      : url.pathname === "/api/combos"
        ? { total: 1, combos: [{ id: "combo-uuid", name: "minimax-combo-m3.1", strategy: "priority", models: [
          { providerId: "minimax-code", model: "mmcode/MiniMax-M3.1-Flash" },
          { providerId: "minimax", model: "minimax/MiniMax-M3" },
        ] }] }
        : url.pathname === "/api/model-combo-mappings"
          ? { total: 1, mappings: [{ id: "mapping-target", comboId: "combo-uuid", comboName: "minimax-combo-m3.1", pattern: "minimax-combo-m3.1/MiniMax-M3.1-Flash", enabled: true }] }
          : { aliases: {} };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  const adapter = new OpenCodeAdapter({ baseUrl: await start(server) });
  try {
    await expect(adapter.resolveModelProviderLeaves("omniroute/minimax-combo-m3.1", {
      omniRouteBaseUrl: "http://omniroute.test", omniRouteApiKey: "fixture-key", fetcher,
    })).resolves.toBeNull();
  } finally {
    server.close();
  }
});

it("keeps a combo route verifiable when another enabled mapping serves the same combo under an unrelated name", async () => {
  const state = sessionFixture();
  state.models = [{ id: "minimax/MiniMax-M3", modelID: "minimax-combo-m3", providerID: "omniroute" }];
  const server = v2Fixture(state);
  const gatewayModels = [
    { id: "minimax-combo-m3", owned_by: "combo", root: "minimax-combo-m3", parent: null },
    { id: "mmcode/MiniMax-M3", owned_by: "minimax-code", root: "MiniMax-M3", parent: null },
    { id: "minimax/MiniMax-M3", owned_by: "minimax", root: "MiniMax-M3", parent: null },
  ];
  let modelMappings = [
    { id: "mapping-target", comboId: "combo-uuid", comboName: "minimax-combo-m3", pattern: "minimax-combo-m3/MiniMax-M3", enabled: true },
    { id: "mapping-other", comboId: "other-uuid", comboName: "glm-combo", pattern: "glm-combo/glm-5.3-flash", enabled: true },
    { id: "mapping-preview", comboId: "combo-uuid", comboName: "minimax-combo-m3", pattern: "MiniMax-M3.1-Flash-Preview", enabled: true },
  ];
  let modelAliases: Record<string, string> = { "gemini-2.5-flash": "minimax/MiniMax-M3" };
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const payload = url.pathname === "/v1/models"
      ? { object: "list", data: gatewayModels }
      : url.pathname === "/api/combos"
        ? { total: 1, combos: [{ id: "combo-uuid", name: "minimax-combo-m3", strategy: "priority", models: [
          { providerId: "minimax-code", model: "mmcode/MiniMax-M3" },
          { providerId: "minimax", model: "minimax/MiniMax-M3" },
        ] }] }
        : url.pathname === "/api/model-combo-mappings"
          ? { total: modelMappings.length, mappings: modelMappings }
          : { aliases: modelAliases, catalogVersion: "fixture" };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  const adapter = new OpenCodeAdapter({ baseUrl: await start(server) });
  const options = { omniRouteBaseUrl: "http://omniroute.test", omniRouteApiKey: "fixture-key", fetcher };
  try {
    await expect(adapter.resolveModelProviderLeaves("omniroute/minimax-combo-m3", options)).resolves.toMatchObject({
      nativeModelId: "omniroute/minimax-combo-m3",
      resolvedProviderLeaves: [
        { providerId: "minimax-code", modelId: "mmcode/MiniMax-M3" },
        { providerId: "minimax", modelId: "minimax/MiniMax-M3" },
      ],
    });

    // An alias name that shadows a leaf id stays a conflict.
    modelAliases = { "minimax/MiniMax-M3": "other-model" };
    await expect(adapter.resolveModelProviderLeaves("omniroute/minimax-combo-m3", options)).resolves.toBeNull();

    // A mapping that rewrites a sibling name inside the combo namespace stays a conflict.
    modelAliases = {};
    modelMappings = [
      modelMappings[0]!,
      { id: "mapping-rewrite", comboId: "combo-uuid", comboName: "minimax-combo-m3", pattern: "minimax-combo-m3/rewritten", enabled: true },
    ];
    await expect(adapter.resolveModelProviderLeaves("omniroute/minimax-combo-m3", options)).resolves.toBeNull();

    // A second enabled mapping that claims the same identity for another combo stays a conflict.
    modelMappings = [
      modelMappings[0]!,
      { id: "mapping-overlap", comboId: "other-uuid", comboName: "other-combo", pattern: "minimax-combo-m3/MiniMax-M3", enabled: true },
    ];
    await expect(adapter.resolveModelProviderLeaves("omniroute/minimax-combo-m3", options)).resolves.toBeNull();
  } finally {
    server.close();
  }
});

it('reads an exact native V2 linear turn packet without inventing a parentID',async()=>{
 const {OpenCodeClient}=await import('../packages/agent-resume/src/harness/opencode/client.js');
 const state=sessionFixture();const id='ses_linear_native';const error={type:'provider.quota',status:429,message:'[1310][Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-24 02:06:22]'};
 const user={id:'user_linear',type:'user',metadata:{agentHerderInputId:'stable_linear'},time:{created:100}};
 const assistant={id:'assistant_linear',type:'assistant',model:{providerID:'omniroute',id:'zc/glm-5.3-flash'},time:{created:110,completed:120},finish:'error',error};
 const terminal={id:'idle_linear',type:'idle',outcome:'failed',time:{created:130},error};
 state.sessions[id]={id,title:'native linear',location:{directory:'/tmp/project'},outcome:'failed',messages:[user,assistant,terminal]};state.active[id]={type:'idle'};
 const server=v2Fixture(state);const baseUrl=await start(server);const client=new OpenCodeClient({baseUrl});
 try{
  await expect(client.getTerminalFailureContext(id)).resolves.toMatchObject({nativeTurnId:assistant.id,inputId:'stable_linear',statusCode:429});
  for(const messages of [
   [user,{...assistant,parentID:'wrong_parent'},terminal],
   [user,{...assistant,parentID:'wrong_parent',inputId:'stable_linear'},terminal],
   [user,{...user,id:'same_input_again'},assistant,terminal],
   [user,{...user,id:'second_user',metadata:{agentHerderInputId:'different'}},assistant,terminal],
   [user,{...assistant,id:'earlier_assistant'},assistant,terminal],
   [{...user,metadata:{}},assistant,terminal],
   [{id:'unknown_earlier_actor',type:'assistant'},user,assistant,terminal],
   [{id:'unknown_boundary',type:'action',outcome:'failed',time:{created:90}},user,assistant,terminal],
   [user,assistant,{...terminal,error:{...error,status:401}}],
   [user,{...assistant,parts:[{type:'tool',state:{status:'completed'}}]},terminal],
   [user,{...assistant,content:[{type:'tool-call',name:'read'}]},terminal],
   [user,{...assistant,snapshot:{files:['changed']}},terminal],
   [user,{...assistant,tool_calls:[{id:'call'}]},terminal],
   [user,{id:'tool_step',type:'tool',time:{created:115}},assistant,terminal],
   [user,{...assistant,sessionID:'wrong_session'},terminal],
   [user,assistant,{...terminal,inputId:'wrong_input'}],
   [user,{...assistant,metadata:{},info:{metadata:{agentHerderInputId:'wrong_input'}}},terminal],
   [user,assistant,{...terminal,turnId:'wrong_turn'}],
   [user,assistant,{...terminal,outcome:'succeeded'}],
   [user,{...assistant,time:{created:99,completed:120}},terminal],
   [user,{...assistant,time:{created:110}},terminal],
   [user,{...assistant,cached:true},terminal],
   [{...user,info:{metadata:{cached:true}}},assistant,terminal],
   [user,{...assistant,info:{partial:true}},terminal],
   [user,{...assistant,id:user.id},terminal],
   [...Array.from({length:147},(_,i)=>({id:`old_${i}`,type:'unknown'})),user,assistant,terminal],
  ]){state.sessions[id].messages=messages;expect(await client.getTerminalFailureContext(id)).toBeNull();}
  state.sessions[id].messages=[user,assistant,terminal];
  for (const messageEnvelope of [{partial:true},{cached:true},{truncated:true},{cursor:{next:'more'}}]) {
   state.sessions[id].messageEnvelope=messageEnvelope;
   expect(await client.getTerminalFailureContext(id)).toBeNull();
  }
  state.sessions[id].messageEnvelope={cursor:{next:'native_tail'}};
  state.sessions[id].emptyCursorTail=true;
  await expect(client.getTerminalFailureContext(id)).resolves.toMatchObject({inputId:'stable_linear'});
  state.sessions[id].messageEnvelope={cursor:{next:'native_tail'},metadata:{partial:true}};
  expect(await client.getTerminalFailureContext(id)).toBeNull();
  state.sessions[id].messageEnvelope={cursor:{next:'native_tail'}};

  for (const tailEnvelope of [{cursor:{next:'still-more'}},{metadata:{partial:true}},{hasMore:true},{info:{cached:true}}]) {
   state.sessions[id].tailEnvelope=tailEnvelope;
   expect(await client.getTerminalFailureContext(id)).toBeNull();
  }
  delete state.sessions[id].tailEnvelope;
  delete state.sessions[id].emptyCursorTail;
  delete state.sessions[id].messageEnvelope;
  const switched={id:'switch_linear',type:'model-switched',time:{created:140},previous:assistant.model,model:{providerID:'omniroute',id:'minimax/MiniMax-M3.1-Flash'}};
  state.sessions[id].model=switched.model;
  state.sessions[id].messages=[user,assistant,terminal,switched];
  await expect(client.getTerminalFailureContext(id)).resolves.toMatchObject({inputId:'stable_linear',userMessageId:user.id});
  const adapter=new OpenCodeAdapter({baseUrl});
  expect((await adapter.getSession(id))?.meta?.nativeLastTurn).toMatchObject({inputId:'stable_linear',userMessageId:user.id});

  for (const control of [{...switched,previous:{providerID:'foreign',id:'wrong'}},{...switched,model:{providerID:'foreign',id:'wrong'}},{...switched,tool_calls:[{id:'x'}]},{...switched,time:{created:90}},{...switched,sessionID:'foreign'},{...switched,model:{...switched.model,variant:{tool:'bad'}}}]) {
    state.sessions[id].messages=[user,assistant,terminal,control];
    expect(await client.getTerminalFailureContext(id)).toBeNull();
  }
  state.sessions[id].messages=[user,assistant,terminal,switched,{...switched,id:'second_switch'}];
  expect(await client.getTerminalFailureContext(id)).toBeNull();
  state.sessions[id].messages=[{id:'old_user',type:'user'},{id:'old_assistant',type:'assistant'},{id:'old_idle',type:'idle',outcome:'succeeded',time:{created:90}},user,assistant,terminal];
  await expect(client.getTerminalFailureContext(id)).resolves.toMatchObject({nativeTurnId:assistant.id,inputId:'stable_linear'});
 }finally{server.close();}
});
