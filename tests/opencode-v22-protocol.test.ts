import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";

type Fixture = {
  paths: Array<{ method: string; path: string; body?: Record<string, unknown> }>;
  messages: Array<Record<string, unknown>>;
  postStatus: number;
};

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {};
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function startFixture(fixture: Fixture): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url || "/", "http://fixture").pathname;
    const body = request.method === "POST" ? await readJson(request) : undefined;
    fixture.paths.push({ method: request.method || "GET", path, ...(body ? { body } : {}) });

    if (path === "/api/health" && request.method === "GET") return json(response, 404, { error: "not found" });
    if (path === "/global/health" && request.method === "GET") return json(response, 200, { healthy: true });
    if (path === "/api/config") return json(response, 404, { error: "not found" });
    if (path === "/session" && request.method === "POST") {
      return json(response, 200, { id: "ses_fresh", title: body?.title, directory: "/tmp/work", time: { created: 1, updated: 1 } });
    }
    if (path === "/session/ses_fresh/message" && request.method === "GET") return json(response, 200, fixture.messages);
    if (path === "/session/ses_fresh/message" && request.method === "POST") {
      const parts = body?.parts as Array<{ type?: string; text?: string }> | undefined;
      const text = parts?.find((part) => part.type === "text")?.text || "";
      fixture.messages.push({ id: "msg_exact1", type: "user", info: { id: "msg_exact1", role: "user" }, parts: [{ type: "text", text }] });
      return json(response, fixture.postStatus, { accepted: fixture.postStatus < 400 });
    }
    if (path === "/session/ses_fresh" && request.method === "GET") {
      return json(response, 200, { id: "ses_fresh", title: "worker", directory: "/tmp/work", time: { created: 1, updated: 1 } });
    }
    return json(response, 404, { error: "not found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind TCP port");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function fixtureState(postStatus = 200): Fixture {
  return { paths: [], messages: [], postStatus };
}

it("uses pinned v22 create, initial Start, and exact new native user-message readback", async () => {
  const state = fixtureState();
  const { server, baseUrl } = await startFixture(state);
  const adapter = new OpenCodeAdapter({ baseUrl, protocol: "v22" });
  try {
    await adapter.init();
    const session = await adapter.createSession({ name: "worker", cwd: "/tmp/work" });
    const receipt = await adapter.sendMessage(session.id, {
      message: "initial task",
      model: "fixture/herder-test",
      start: true,
      queue: false,
      activeTurnOnly: true,
      inputId: "caller-input-1",
    });
    const duplicate = await adapter.sendMessage(session.id, {
      message: "must not replay",
      start: true,
      queue: false,
      inputId: "caller-input-2",
    });

    expect(session.id).toBe("ses_fresh");
    expect(adapter.controlCapabilities).toEqual({ cancelTurn: false, detach: false, resume: false, terminate: false, recover: false, fork: false, modelSwitch: false, subagents: false, events: false, steer: false });
    expect(receipt).toMatchObject({ ok: true, admitted: true, nativeInputMessageId: "msg_exact1" });
    expect(receipt.nativeInputMessageId).not.toBe("caller-input-1");
    expect(duplicate).toMatchObject({ ok: false, notSubmitted: true, admission: "not_submitted" });
    expect(state.paths).toContainEqual({ method: "GET", path: "/global/health" });
    expect(state.paths.some((call) => call.path === "/api/config")).toBe(false);
    const create = state.paths.find((call) => call.method === "POST" && call.path === "/session")!;
    expect(create.body).toEqual({ title: "worker" });
    const post = state.paths.find((call) => call.method === "POST" && call.path === "/session/ses_fresh/message")!;
    expect(post.body).toEqual({ model: { providerID: "fixture", modelID: "herder-test" }, parts: [{ type: "text", text: "initial task" }] });
    expect(state.paths.filter((call) => call.method === "POST")).toHaveLength(2);
  } finally {
    server.close();
  }
});

it("refuses queue and existing-session Start before POST", async () => {
  const state = fixtureState();
  const { server, baseUrl } = await startFixture(state);
  const adapter = new OpenCodeAdapter({ baseUrl, protocol: "v22" });
  try {
    await adapter.init();
    const session = await adapter.createSession({ name: "worker", cwd: "/tmp/work" });
    const queued = await adapter.sendMessage(session.id, { message: "later", queue: true, inputId: "queue-1" });
    const existingStart = await adapter.sendMessage("ses_existing", { message: "start", start: true, queue: false, inputId: "start-1" });

    expect(queued).toMatchObject({ ok: false, notSubmitted: true, admission: "not_submitted" });
    expect(existingStart).toMatchObject({ ok: false, notSubmitted: true, admission: "not_submitted" });
    expect(state.paths.filter((call) => call.method === "POST" && call.path.endsWith("/message"))).toHaveLength(0);
  } finally {
    server.close();
  }
});

it("returns UNKNOWN after a post-effect HTTP error without retrying", async () => {
  const state = fixtureState(500);
  const { server, baseUrl } = await startFixture(state);
  const adapter = new OpenCodeAdapter({ baseUrl, protocol: "v22" });
  try {
    await adapter.init();
    const session = await adapter.createSession({ name: "worker", cwd: "/tmp/work" });
    const receipt = await adapter.sendMessage(session.id, { message: "one only", start: true, queue: false, inputId: "caller-input-2" });
    const replay = await adapter.sendMessage(session.id, { message: "one only", start: true, queue: false, inputId: "caller-input-2" });

    expect(receipt).toMatchObject({ ok: false, admission: "unknown", admissionUnknown: true });
    expect(replay).toMatchObject({ ok: false, notSubmitted: true, admission: "not_submitted" });
    expect(state.paths.filter((call) => call.method === "POST" && call.path.endsWith("/message"))).toHaveLength(1);
  } finally {
    server.close();
  }
});

it("routes actual AHAP runner Start through v22 adapter to native payload", async () => {
  const { PassThrough } = await import("node:stream");
  const { serveOpenCodeAhap } = await import("../src/ahap-opencode-runner.js");
  const state = fixtureState();
  const { server, baseUrl } = await startFixture(state);
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => chunks.push(chunk));
  const adapter = new OpenCodeAdapter({ baseUrl, protocol: "v22" });
  try {
    const done = serveOpenCodeAhap(adapter, input, output, "v22");
    const requests = [
      {jsonrpc:"2.0",id:1,method:"initialize",params:{harness:"opencode",ahapVersion:"0.1"}},
      {jsonrpc:"2.0",id:2,method:"createSession",params:{options:{name:"worker",cwd:"/tmp/work"}}},
      {jsonrpc:"2.0",id:3,method:"sendMessage",params:{id:"ses_fresh",options:{message:"initial task",queue:false,start:true,activeTurnOnly:true,inputId:"caller-input-1"}}},
      {jsonrpc:"2.0",id:4,method:"shutdown"},
    ];
    input.end(requests.map((request) => JSON.stringify(request)).join("\n") + "\n");
    await done;
    const replies = chunks.join("").trim().split("\n").map((line) => JSON.parse(line));
    expect(replies[2].result).toMatchObject({ admitted:true, nativeInputMessageId:"msg_exact1", inputId:"caller-input-1" });
    const posts = state.paths.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual({method:"POST",path:"/session/ses_fresh/message",body:{parts:[{type:"text",text:"initial task"}]}});
  } finally { server.close(); }
});
