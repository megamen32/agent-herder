import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { registerSessionTools } from "../src/mcp/session-tools.js";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { deferredMessages } from "../src/deferred-messages.js";
import { coordinationNotes } from "../src/coordination-notes.js";

afterEach(() => vi.restoreAllMocks());

describe("registered Codex communication delivery", () => {
  it("steers active coordination, refuses ended-turn fallback, deduplicates unknown receipts and starts explicit tasks once", async () => {
    await mkdir(".tmp", { recursive: true });
    const root = await mkdtemp(join(tmpdir(), "rc-"));
    const previous = process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(root, "stops.json");
    // The quota guard reads its policy from the autopilot state dir. An empty
    // one is the default policy: enabled, reserve 20%, unknown blocks.
    const previousAutopilotStateDir = process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR;
    process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR = join(root, "autopilot");
    const listInbox = vi.spyOn(deferredMessages, "list").mockResolvedValue([]);
    const removeInbox = vi.spyOn(deferredMessages, "remove").mockImplementation(async () => { listInbox.mockResolvedValue([]); });
    const deferred = vi.spyOn(deferredMessages, "add").mockImplementation(async (sessionId, message) => ({ id: "fixture-deferred", sessionId, message, createdAt: new Date().toISOString() }));
    vi.spyOn(coordinationNotes, "inject").mockImplementation(async (_s, text) => text);
    // /proc/self/cwd shortens AF_UNIX while keeping the file inside the owned bounded TMPDIR.
    const socketPath = join("/proc/self/cwd", relative(process.cwd(), join(root, "native.sock")));
    const http = createServer();
    const ws = new WebSocketServer({ server: http });
    let active: string | undefined = "native-turn-1";
    let race = false;
    let endsDuringSteer = false;
    let uncertain = false;
    const accepted: string[] = [];
    const methods: string[] = [];
    ws.on("connection", socket => socket.on("message", data => {
      const req = JSON.parse(data.toString());
      methods.push(req.method);
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: req.id, result }));
      const reject = (message: string) => socket.send(JSON.stringify({ id: req.id, error: { code: -32600, message } }));
      const thread = { id: "native-thread", name: "communication fixture", cwd: root, status: { type: active ? "active" : "idle" } };
      switch (req.method) {
        case "initialize": return reply({});
        case "initialized": return;
        // The quota guard asks the native server for its rate limits before
        // every admission: a healthy reading opens the path.
        case "account/rateLimits/read": return reply({ rateLimits: { primary: { used_percent: 10, reset_at: Math.floor(Date.now() / 1000) + 3600 }, secondary: { used_percent: 10, reset_at: Math.floor(Date.now() / 1000) + 7200 } } });
        case "thread/read": return reply({ thread });
        case "thread/list": return reply({ data: [thread], nextCursor: null });
        case "thread/resume": return reply({ thread });
        case "thread/turns/list": return reply({ data: active ? [{ id: active, status: "inProgress" }] : [] });
        case "turn/steer":
          if (endsDuringSteer) { endsDuringSteer = false; active = undefined; return reject("no active turn"); }
          if (race) { race = false; active = "native-turn-2"; return reject("expected active turn id `native-turn-1` but found `native-turn-2`"); }
          expect(req.params.expectedTurnId).toBe(active);
          accepted.push(req.params.input[0].text);
          if (uncertain) { uncertain = false; return; }
          return reply({ turnId: active });
        case "turn/start":
          if (active) return reject("thread native-thread already has an active writer");
          active = "idle-start-1";
          accepted.push(req.params.input[0].text);
          return reply({ turn: { id: active, status: "inProgress" } });
        default: return reply({});
      }
    }));
    await new Promise<void>(resolve => http.listen(socketPath, resolve));
    let adapter = new CodexAppServerAdapter({ socketPath, codexDir: root, requestTimeoutMs: 100 });
    const events = new HerderEventBus();
    const server = new McpServer({ name: "registered-delivery-test", version: "1" });
    const adapters = new Map([["codex", adapter]]);
    registerSessionTools(server, { adapters, events, jobs: new HerderJobRegistry(events) });
    const client = new Client({ name: "sender", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const deliver = (message: string, inputId = message) => client.callTool({ name: "deliver", arguments: { harness: "codex", sessionId: "native-thread", message, inputId } });
    const payload = (r: Awaited<ReturnType<typeof deliver>>) => JSON.parse(r.content[0]?.type === "text" ? r.content[0].text : "{}");
    try {
      await server.connect(st); await client.connect(ct);
      const results = await Promise.all([deliver("active coordination"), deliver("active coordination")]);
      expect(results.map(payload)).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })]);
      expect(methods.filter(m => m === "turn/start")).toHaveLength(0);
      expect(methods.filter(m => m === "turn/steer")).toHaveLength(1);
      expect(accepted).toEqual(["active coordination"]);
      expect(deferred).not.toHaveBeenCalled();
      await client.callTool({ name: "deliver", arguments: { harness: "codex", name: "communication fixture", cwd: root, message: "active coordination", inputId: "active coordination", create: "never" } });
      expect(accepted).toEqual(["active coordination"]);
      await client.callTool({ name: "send_message", arguments: { harness: "codex", sessionId: "native-thread", message: "active coordination", inputId: "active coordination", mode: "queue" } });
      expect(accepted).toEqual(["active coordination"]);
      race = true;
      expect(payload(await deliver("race coordination"))).toMatchObject({ ok: true });
      expect(accepted).toEqual(["active coordination", "race coordination"]);
      uncertain = true;
      listInbox.mockResolvedValue([{ id: "old-inbox", sessionId: "native-thread", message: "prior coordination", createdAt: new Date().toISOString() }]);
      expect(payload(await deliver("uncertain receipt"))).toMatchObject({ ok: false });
      expect(removeInbox).toHaveBeenCalledWith(["old-inbox"]);
      await deliver("uncertain receipt");
      expect(accepted.filter(x => x.includes("uncertain receipt"))).toHaveLength(1);
      await adapter.dispose();
      adapter = new CodexAppServerAdapter({ socketPath, codexDir: root, requestTimeoutMs: 100 });
      adapters.set("codex", adapter);
      await deliver("active coordination"); await deliver("uncertain receipt");
      expect(accepted.filter(x => x === "active coordination")).toHaveLength(1);
      expect(accepted.filter(x => x.includes("uncertain receipt"))).toHaveLength(1);
      endsDuringSteer = true;
      const late=payload(await deliver("must not revive completed turn"));
      expect(late).toMatchObject({delivery:"skipped_inactive",activated:false});
      expect(methods.filter(m => m === "turn/start")).toHaveLength(0);
      expect(deferred).not.toHaveBeenCalled();
      await client.callTool({ name:"send_message",arguments:{harness:"codex",sessionId:"native-thread",message:"idle report",mode:"queue",inputId:"idle-report"}});
      expect(payload(await deliver("idle default deliver"))).toMatchObject({delivery:"skipped_inactive",activated:false});
      expect(methods.filter(m => m === "turn/start")).toHaveLength(0);
      const explicit=(message:string)=>client.callTool({name:"deliver",arguments:{harness:"codex",sessionId:"native-thread",message,inputId:message,activation:"always"}});
      await Promise.all([explicit("wake idle once"), explicit("wake idle once"), explicit("second distinct idle input")]);
      expect(methods.filter(m => m === "turn/start")).toHaveLength(1);
      expect(accepted.filter(x => x === "wake idle once")).toHaveLength(1);
      expect(accepted.filter(x => x === "second distinct idle input")).toHaveLength(1);
      // Wake deliveries park durably before dispatch and remove the parked id on admission.
      expect(deferred).toHaveBeenCalled();
      expect(removeInbox).toHaveBeenCalledWith(["fixture-deferred"]);
    } finally {
      await client.close(); await server.close(); await adapter.dispose();
      for (const socket of ws.clients) socket.terminate();
      await new Promise<void>(resolve => ws.close(() => resolve()));
      await new Promise<void>(resolve => http.close(() => resolve()));
      if (previous === undefined) delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;
      else process.env.AGENT_HERDER_HUMAN_STOP_STORE = previous;
      if (previousAutopilotStateDir === undefined) delete process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR;
      else process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR = previousAutopilotStateDir;
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
