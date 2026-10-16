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
        return json(response, { location: { directory: "/tmp/project" }, data: [
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
        if (!rest) return json(response, { data: session });
        if (rest === "message" && request.method === "GET") {
          const messages = session.messages ?? [];
          const limit = Number(url.searchParams.get("limit") ?? messages.length);
          const ordered = url.searchParams.get("order") === "desc" ? [...messages].reverse() : messages;
          const filtered = url.searchParams.get("type") ? ordered.filter((m) => m.type === url.searchParams.get("type")) : ordered;
          return json(response, { data: filtered.slice(0, limit), cursor: {} });
        }
        if (rest === "prompt" && request.method === "POST") {
          const parsed = JSON.parse(body || "{}");
          const inbox = { id: `msg_${parsed.delivery}`, sessionID: id, type: "user", payload: { text: parsed.text }, delivery: parsed.delivery };
          session.messages = [...(session.messages ?? []), { id: `msg_user_${(session.messages ?? []).length}`, type: "user", text: parsed.text }];
          return json(response, { data: inbox });
        }
        if (rest === "interrupt") return json(response, { data: { interrupted: true } });
        if (rest === "fork") {
          const forked = { ...session, id: "ses_forked", title: `${session.title} (fork)`, parentID: id };
          state.sessions[forked.id] = forked;
          return json(response, { data: forked });
        }
        if (rest === "model" && request.method === "POST") return json(response, undefined) ?? void 0, response.statusCode = 204, void response.end();
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
  const steer = normalizeOpenCodeEvent(frames[1])!;
  expect(steer).toMatchObject({ harness: "opencode", sessionId: "ses_1" });
  expect(normalizeOpenCodeEvent({ type: "provider.updated", data: {} })).toBeNull();
  // Legacy frames keep working unchanged.
  expect(normalizeOpenCodeEvent({ type: "message.updated", properties: { info: { sessionID: "ses_2", id: "msg_2" } } }))
    .toMatchObject({ kind: "message.updated", sessionId: "ses_2" });
});