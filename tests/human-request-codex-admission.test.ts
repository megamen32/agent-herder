import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";
import { HumanRequestRegistry } from "../src/human-request/index.js";
import { HumanStopStore } from "../src/human-stop-store.js";
import { LineageStore } from "../src/lineage-store.js";
import { SessionSupervisor } from "../src/session-supervisor.js";
import { createWebServer } from "../src/web/server.js";

afterEach(() => vi.unstubAllEnvs());

// Real HTTP -> registry -> supervisor -> existing Codex adapter -> Unix WS RPC.
// The synthetic model turn never finishes until cleanup; native ACK is gated.
async function fixture(active = false, malformedAck = false) {
  const dir = await mkdtemp(join(tmpdir(), "herder-codex-human-ack-"));
  const codexDir = join(dir, "codex");
  await mkdir(join(codexDir, "sessions"), { recursive: true });
  vi.stubEnv("AGENT_HERDER_HUMAN_STOP_STORE", join(dir, "stops.json"));
  const native: Server = createServer();
  const ws = new WebSocketServer({ server: native });
  // The bounded TMPDIR can exceed AF_UNIX's path limit. This short descriptor
  // path still binds the socket inside the same owned temporary directory.
  const directory = await open(dir, "r");
  const socketPath = `/proc/self/fd/${directory.fd}/native.sock`;
  let connection: WebSocket | undefined;
  let turnId: string | undefined = active ? "native-current" : undefined;
  const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let ack!: () => void;
  let acked = false;
  const thread = () => ({ id: "fixture-thread", cwd: dir, name: "Fixture", status: { type: turnId ? "active" : "idle" } });
  ws.on("connection", (socket) => {
    connection = socket;
    socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      if (!request.method) return;
      requests.push(request);
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: request.id, result }));
      if (request.method === "initialize") return reply({ userAgent: "fixture" });
      if (request.method === "initialized") return;
      if (request.method === "thread/read") return reply({ thread: thread() });
      if (request.method === "thread/turns/list") return reply({ data: turnId ? [{ id: turnId, status: "inProgress" }] : [] });
      if (request.method === "thread/resume") return reply({ thread: thread() });
      if (request.method === "turn/start" && turnId) {
        return socket.send(JSON.stringify({ id: request.id, error: { code: -32600, message: "already has an active writer" } }));
      }
      if (request.method === "turn/start" || request.method === "turn/steer") {
        ack = () => {
          if (acked) return;
          acked = true;
          turnId ??= "native-new";
          reply(request.method === "turn/steer" ? { turnId } : { turn: malformedAck ? {} : { id: turnId, status: "inProgress" } });
          if (request.method === "turn/start" && !malformedAck) {
            socket.send(JSON.stringify({ method: "turn/started", params: { threadId: "fixture-thread", turn: { id: turnId, status: "inProgress" } } }));
          }
        };
        return;
      }
      reply({});
    });
  });
  await new Promise<void>((resolve, reject) => {
    native.once("error", reject);
    native.listen(socketPath, resolve);
  });
  const adapter = new CodexAppServerAdapter({ socketPath, codexDir, codexBin: "/never-start-a-live-process", requestTimeoutMs: 2_000 });
  await adapter.init();
  const send = vi.spyOn(adapter, "sendMessage");
  const adapters = new Map([["codex", adapter]]);
  const stops = new HumanStopStore(join(dir, "stops.json"));
  const converter = { async convert() { throw new Error("unused"); } };
  const supervisor = new SessionSupervisor(adapters, converter, new LineageStore(join(dir, "lineage.json")), { humanStopStore: stops, autoResumeFailedSessions: false });
  const registry = new HumanRequestRegistry(join(dir, "requests.json"));
  const record = await registry.create({ kind: "user", target: { agent: "codex", sessionId: "fixture-thread", cwd: dir }, answerSource: "notice_question" });
  const web = createWebServer({ adapters, converter, supervisor, humanRequests: registry, sessionObservationManagedExternally: true });
  await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(web.address() as { port: number }).port}/internal/human-requests/ask-user-completion`;
  const body = JSON.stringify({ event: "ask.user.completed", event_version: 1, status: "completed", request_id: record.requestId, result_ref: randomUUID() });
  const post = () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(1_500) });
  const close = async () => {
    if (turnId && connection?.readyState === 1) {
      connection.send(JSON.stringify({ method: "turn/completed", params: { threadId: "fixture-thread", turn: { id: turnId, status: "completed" } } }));
    }
    await vi.waitFor(async () => expect((await registry.get(record.requestId))?.status).not.toBe("resuming"), { timeout: 1_000 });
    await adapter.dispose();
    ws.clients.forEach((socket) => socket.terminate());
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    web.closeAllConnections();
    await Promise.all([web, native].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await directory.close();
    await rm(dir, { recursive: true, force: true });
  };
  return { adapter, send, requests, registry, record, stops, post, ack: () => ack(), close, current: () => turnId };
}

it.each([false, true])("acknowledges the exact Codex human answer before LLM completion (active=%s)", async (active) => {
  const f = await fixture(active);
  let settled = false;
  const started = performance.now();
  const pending = f.post().then((response) => { settled = true; return { response, error: undefined }; }, (error) => { settled = true; return { response: undefined, error }; });
  try {
    await vi.waitFor(() => expect(f.requests.some((request) => request.method === (active ? "turn/steer" : "turn/start"))).toBe(true), { timeout: 1_000 });
    expect(settled).toBe(false); // Never claim accepted before the actual RPC ACK.
    expect((await f.registry.get(f.record.requestId))?.status).toBe("resuming");
    const duplicate = await f.post();
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({ status: "resuming", in_flight: true });
    expect(f.send).toHaveBeenCalledTimes(1);
    f.ack();
    const { response, error } = await pending;
    expect(error).toBeUndefined();
    expect(response!.status).toBe(202);
    expect(await response!.json()).toMatchObject({ status: "resumed" });
    expect(performance.now() - started).toBeLessThan(1_500);
    expect((await f.adapter.getSession("fixture-thread"))?.status).toBe("running");
    const record = (await f.registry.get(f.record.requestId))!;
    const inputId = `herder-resume-${createHash("sha256").update(record.idempotencyKey!).digest("hex").slice(0, 32)}`;
    expect(f.send.mock.calls[0][1]).toMatchObject({ queue: true, origin: "human", inputId, humanRequestedAt: Date.parse(record.admittedAt!) });
    expect((await f.adapter.getMessageAdmission("fixture-thread", inputId)).state).toBe("admitted");
    expect((await f.post()).status).toBe(202);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.requests.filter((request) => request.method === "turn/start")).toHaveLength(active ? 0 : 1);
    if (active) expect(f.requests.find((request) => request.method === "turn/steer")?.params?.expectedTurnId).toBe("native-current");
  } finally { await f.close(); }
});

it("does not accept or replay a Codex start receipt without a verified native turn ID", async () => {
  const f = await fixture(false, true);
  const pending = f.post();
  try {
    await vi.waitFor(() => expect(f.requests.some((request) => request.method === "turn/start")).toBe(true));
    f.ack();
    const response = await pending;
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ status: "resume_failed", retry: false });
    expect((await f.post()).status).toBe(502);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
  } finally { await f.close(); }
});

it("keeps a newer human stop fenced before native Codex admission", async () => {
  const f = await fixture(true);
  try {
    const session = (await f.adapter.getSession("fixture-thread"))!;
    await f.stops.hold(session, { id: "newer-stop", at: new Date(Date.now() + 60_000).toISOString(), reason: "explicit stop after the answer" });
    const response = await f.post();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ status: "resume_failed", retry: false });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.requests.some((request) => request.method === "turn/start" || request.method === "turn/steer")).toBe(false);
    expect(await f.stops.isHeld("codex", session.id)).toBe(true);
  } finally { await f.close(); }
});
