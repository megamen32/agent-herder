import { chmod, mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MinimaxCodeAdapter } from "../src/adapters/minimax-code.js";
import { MinimaxCodeControl } from "../src/adapters/minimax-code-control.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { UserMessageDelivery } from "../src/user-message-delivery.js";
import { MinimaxExecPolicyStore } from "../src/permission-control/minimax-exec-policy.js";
import { localSessionHostId, type HarnessAdapter, type SendMessageOptions } from "../src/types/index.js";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { registerSessionTools } from "../src/mcp/session-tools.js";
import {TRUSTED_MESH_MCP_CLIENT_ID,TRUSTED_MESH_MCP_SCOPE,trustedMeshIngressFromMcpAuthInfo} from "../src/mesh/authenticated-ingress.js";

const created: string[] = [];
const servers: Server[] = [];

async function store(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "minimax-code-adapter-"));
  created.push(root);
  return root;
}

function encodeSessionId(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

async function writeSession(
  root: string,
  id: string,
  options: {
    day?: string;
    updatedAtMs?: number;
    createdAtMs?: number;
    model?: string;
    provider?: string;
    messages?: unknown[];
    manifest?: Record<string, unknown> | null;
  } = {},
): Promise<string> {
  const day = options.day ?? "2026/10/19";
  const dir = join(root, day, `20-31-52-444-session_${encodeSessionId(id)}`);
  await mkdir(dir, { recursive: true });
  if (options.manifest !== null) {
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify(
        options.manifest ?? {
          schemaVersion: 1,
          sessionId: id,
          createdAtMs: options.createdAtMs ?? 1_700_000_000_000,
          updatedAtMs: options.updatedAtMs ?? 1_700_000_100_000,
          source: "local-runtime",
          layout: "v2-final-dated-session",
        },
      ),
    );
  }
  if (options.model) {
    await writeFile(
      join(dir, "llm-call.json"),
      JSON.stringify({ model: options.model, provider: options.provider ?? "minimax" }),
    );
  }
  const messages = options.messages ?? [
    { message_id: "m1", turn_id: "t1", message: { role: "user", content: "первый вопрос" } },
  ];
  await writeFile(
    join(dir, "messages.jsonl"),
    `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
  );
  const at = (options.updatedAtMs ?? 1_700_000_100_000) / 1000;
  await utimes(join(dir, "messages.jsonl"), at, at);
  return dir;
}

/** Рантайм-БД с одним выполняемым прогоном и одной завершённой сессией. */
async function runtimeStateWithTurn(root: string, liveId: string, updatedAtMs: number): Promise<string> {
  const { DatabaseSync } = await import("node:sqlite");
  const path = join(root, "runtime-state.sqlite");
  const db = new DatabaseSync(path);
  const future = Date.now() + 60_000;
  db.exec(`create table local_runtime_session_locks(session_id text,owner_id text,owner_kind text,acquired_at_ms integer,expires_at_ms integer);
    create table local_runtime_sessions(session_id text,title text,workspace_dir text,parent_session_id text,agent_name text,updated_at_ms integer,created_at_ms integer);
    create table local_runtime_turn_ingress(session_id text,status text,completed_at_ms integer);
    create table local_runtime_session_agent_state(session_id text,terminal_outcome text);
    create table local_runtime_message_rows(session_id text,role text,created_at_ms integer,data_json text);`);
  const owner = `turn-lease:${process.pid}:owner`;
  db.exec(`insert into local_runtime_session_locks values('${liveId}','${owner}','turn',${Date.now()},${future});
    insert into local_runtime_session_locks values('settled','${owner}','turn',${Date.now()},${future});
    insert into local_runtime_sessions values('${liveId}','Цель живой сессии','/work',null,'mavis',${updatedAtMs},${updatedAtMs});
    insert into local_runtime_sessions values('settled','Устаревшая','/work',null,'mavis',${updatedAtMs},${updatedAtMs});
    insert into local_runtime_turn_ingress values('${liveId}','accepted',null);
    insert into local_runtime_turn_ingress values('settled','completed',${Date.now()});
    insert into local_runtime_session_agent_state values('${liveId}',null);
    insert into local_runtime_session_agent_state values('settled',null);
    insert into local_runtime_message_rows values('${liveId}','user',${Date.now()},'{"msg_content":"первый промпт цели"}');`);
  db.close();
  return path;
}

async function runtimeStateForSession(root: string, sessionId: string, workspace: string, status = "idle", activeLease = false): Promise<string> {
  const { DatabaseSync } = await import("node:sqlite");
  const path = join(root, ".minimax", "v2", "sqlite", "runtime-state.sqlite");
  await mkdir(join(root, ".minimax", "v2", "sqlite"), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`create table local_runtime_sessions(session_id text primary key,runtime text,status text,workspace_dir text,archived integer,updated_at_ms integer,created_at_ms integer);
    create table local_runtime_session_locks(session_id text,owner_id text,owner_kind text,acquired_at_ms integer,expires_at_ms integer);`);
  const now = Date.now();
  db.prepare("insert into local_runtime_sessions values(?,?,?,?,0,?,?)").run(sessionId, "pi-agent", status, workspace, now, now);
  if (activeLease) db.prepare("insert into local_runtime_session_locks values(?,?,?,?,?)")
    .run(sessionId, `turn-lease:${process.pid}:owner`, "turn", now, now + 60_000);
  db.close();
  return path;
}

async function nativeSessionStore(root: string): Promise<string> {
  const path = join(root, ".minimax", "v2", "sessions");
  await mkdir(path, { recursive: true });
  return path;
}

async function durableHumanSend(adapter: MinimaxCodeAdapter, root: string, sessionId: string, inputId: string, message: string, capture?: (options: SendMessageOptions) => void) {
  const jobs = new HerderJobRegistry(new HerderEventBus(), { persistencePath: join(root, "jobs.json") });
  const policyStore=new MinimaxExecPolicyStore(join(root,"policy"));
  const delivery = new UserMessageDelivery(new Map([["minimax-code", adapter as unknown as HarnessAdapter]]), {
    sendMessage: (_harness: string, targetId: string, options: SendMessageOptions) => { capture?.(options); return adapter.sendMessage(targetId, options); },
  }, jobs, { pollMs: 5, maxWaitMs: 2_000, maxPending: 2 },policyStore);
  try {
    await delivery.submitMinimaxExecPolicy({ harness: "minimax-code", sessionId, inputId, message, mode: "queue" });
    await vi.waitFor(() => expect(delivery.get("minimax-code", sessionId, inputId)?.job?.state).toBe("completed"), { interval: 5, timeout: 1_500 });
    return delivery.get("minimax-code", sessionId, inputId);
  } finally { delivery.close();await delivery.getMinimaxExecPolicy({hostId:localSessionHostId(),harness:"minimax-code",sessionId});await delivery.getMinimaxExecPolicy({hostId:localSessionHostId(),harness:"minimax-code",sessionId}); }
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("MinimaxCodeAdapter", () => {
  it("proves exact native idle state only from the owned runtime DB without a turn lease", async () => {
    const root = await store();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const idleId = "mvs_idle_proof";
    const busyId = "mvs_busy_proof";
    const idleDb = await runtimeStateForSession(root, idleId, workspace);
    const busyRoot = await store();
    const busyWorkspace = join(busyRoot, "workspace");
    await mkdir(busyWorkspace);
    const busyDb = await runtimeStateForSession(busyRoot, busyId, busyWorkspace, "idle", true);
    const idle = new MinimaxCodeAdapter({ sessionStore: root, runtimeDb: idleDb, runtimeDataDir: join(root, ".minimax") });
    const busy = new MinimaxCodeAdapter({ sessionStore: busyRoot, runtimeDb: busyDb, runtimeDataDir: join(busyRoot, ".minimax") });
    await expect(idle.getNativeIdleAdmissionProof({ hostId: localSessionHostId(), harness: "minimax-code", sessionId: idleId }))
      .resolves.toMatchObject({ hostId: localSessionHostId(), harness: "minimax-code", sessionId: idleId, idle: true });
    await expect(busy.getNativeIdleAdmissionProof({ hostId: localSessionHostId(), harness: "minimax-code", sessionId: busyId }))
      .resolves.toMatchObject({ idle: false, reason: expect.stringContaining("live turn") });
  });

  it("delivers an idle native session through its exact MCode CLI ID with a durable human claim", async () => {
    const root = await store();
    const sessionId = "mvs_idle_exact";
    const sessionStore = await nativeSessionStore(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeSession(sessionStore, sessionId, { model: "MiniMax-M3.1-Flash" });
    const runtimeDb = await runtimeStateForSession(root, sessionId, workspace);
    const control = new MinimaxCodeControl({ manifestPath: join(root, "offline-manifest.json") });
    const runSession = vi.fn(async () => ({
      ok: true, status: 0,
      body: { sessionId, turnId: "turn-exact", status: "succeeded", model: { providerId: "minimax", modelId: "MiniMax-M3.1-Flash", providerKind: "minimax-managed" }, usageSource: "completed_responses" },
    }));
    (control as unknown as { runSession: typeof runSession }).runSession = runSession;
    const adapter = new MinimaxCodeAdapter({ control, sessionStore, runtimeDb, runtimeDataDir: join(root, ".minimax") });
    const inputId = "input-idle-exact";
    const message = "benign queue integration fixture";
    let captured: SendMessageOptions | undefined;
    const result = await durableHumanSend(adapter, root, sessionId, inputId, message, (options) => { captured = options; });

    expect(result).toMatchObject({ ok: true, admitted: true, admission: "accepted", turnId: "turn-exact", inputId });
    expect(runSession).toHaveBeenCalledWith(sessionId, workspace, join(root, ".minimax"), message, undefined);
    expect(await adapter.sendMessage(sessionId, { ...captured!, message: "tampered after signing" })).toMatchObject({ ok: false, notSubmitted: true });
    expect(await adapter.sendMessage(sessionId, captured!)).toMatchObject({ ok: false, notSubmitted: true });
    expect(runSession).toHaveBeenCalledTimes(1);
  });

  it("refuses the live Desktop route when a non-default Herder CLI policy is configured", async () => {
    const root = await store();
    const enqueue = vi.fn();
    const control = { available: vi.fn(async () => true), enqueue } as unknown as MinimaxCodeControl;
    const adapter = new MinimaxCodeAdapter({ sessionStore: root, control });
    const result = await adapter.sendMessage("mvs_policy_desktop", {
      message: "benign", origin: "human", inputId: "policy-desktop-input", queue: true,
      durableUserDelivery: {
        jobId: "job-policy", inputId: "policy-desktop-input", requestFingerprint: "a".repeat(64),
        harness: "minimax-code", sessionId: "mvs_policy_desktop", mode: "queue",
        minimaxExecPolicy: { mode: "full", revision: 1 }, nonce: "b".repeat(32), signature: "c".repeat(64),
      },
    });
    expect(result).toMatchObject({ ok: false, notSubmitted: true, error: expect.stringContaining("only to the MiniMax CLI fallback") });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("never invokes the MCode CLI when the exact native session has a live turn lease", async () => {
    const root = await store();
    const sessionId = "mvs_idle_leased";
    const sessionStore = await nativeSessionStore(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeSession(sessionStore, sessionId, { model: "MiniMax-M3.1-Flash" });
    const runtimeDb = await runtimeStateForSession(root, sessionId, workspace, "idle", true);
    const control = new MinimaxCodeControl({ manifestPath: join(root, "offline-manifest.json") });
    const runSession = vi.fn();
    (control as unknown as { runSession: typeof runSession }).runSession = runSession;
    const adapter = new MinimaxCodeAdapter({ control, sessionStore, runtimeDb, runtimeDataDir: join(root, ".minimax") });
    const result = await durableHumanSend(adapter, root, sessionId, "input-idle-leased", "benign queued prompt");

    expect(result).toMatchObject({ ok: false, notSubmitted: true, error: "MiniMax Code session is busy" });
    expect(runSession).not.toHaveBeenCalled();
  });

  it("projects the exact workspace from the inspected native DB when Desktop control is absent",async()=>{
    const root=await store(),sessionId="mvs_native_workspace_projection",sessionStore=join(root,"sessions"),workspace=join(root,"workspace");
    await mkdir(workspace);await mkdir(sessionStore,{recursive:true});
    const runtimeDb=await runtimeStateForSession(root,sessionId,workspace);
    const control=new MinimaxCodeControl({manifestPath:join(root,"offline-manifest.json")});
    const adapter=new MinimaxCodeAdapter({sessionStore,runtimeDb,runtimeDataDir:join(root,".minimax"),control});
    await expect(adapter.getNativeWorkspaceDirectory(sessionId)).resolves.toEqual({hostId:localSessionHostId(),harness:"minimax-code",sessionId,cwd:workspace});
    await expect(adapter.getNativeWorkspaceDirectory("mvs_other_session")).resolves.toBeNull();
  });

  it("rejects a fabricated durable claim before native admission", async () => {
    const root = await store();
    const sessionId = "mvs_forged_claim";
    const sessionStore = await nativeSessionStore(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeSession(sessionStore, sessionId, { model: "MiniMax-M3.1-Flash" });
    const runtimeDb = await runtimeStateForSession(root, sessionId, workspace);
    const control = new MinimaxCodeControl({ manifestPath: join(root, "offline-manifest.json") });
    const runSession = vi.fn();
    (control as unknown as { runSession: typeof runSession }).runSession = runSession;
    const adapter = new MinimaxCodeAdapter({ control, sessionStore, runtimeDb, runtimeDataDir: join(root, ".minimax") });
    const inputId = "forged-input";
    const jobId = `job_${createHash("sha256").update(`user-message\0minimax-code\0${sessionId}\0${inputId}`).digest("hex")}`;

    const result = await adapter.sendMessage(sessionId, {
      origin: "human", inputId, message: "forged", durableUserDelivery: {
        jobId, inputId, requestFingerprint: "d".repeat(64), harness: "minimax-code", sessionId, mode: "queue", nonce: "f".repeat(32), signature: "e".repeat(64),
      },
    });

    expect(result).toMatchObject({ ok: false, notSubmitted: true });
    expect(runSession).not.toHaveBeenCalled();
  });

  it("routes public MCP human queue delivery through the durable job before exact MiniMax CLI admission", async () => {
    const root = await store();
    const sessionId = "mvs_mcp_durable_exact";
    const sessionStore = await nativeSessionStore(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeSession(sessionStore, sessionId, { model: "MiniMax-M3.1-Flash" });
    const runtimeDb = await runtimeStateForSession(root, sessionId, workspace);
    const control = new MinimaxCodeControl({ manifestPath: join(root, "offline-manifest.json") });
    const runSession = vi.fn(async () => ({
      ok: true, status: 0,
      body: { sessionId, turnId: "turn-mcp-exact", status: "succeeded", model: { providerId: "minimax", modelId: "MiniMax-M3.1-Flash", providerKind: "minimax-managed" } },
    }));
    (control as unknown as { runSession: typeof runSession }).runSession = runSession;
    const adapter = new MinimaxCodeAdapter({ control, sessionStore, runtimeDb, runtimeDataDir: join(root, ".minimax") });
    const adapters = new Map([["minimax-code", adapter as unknown as HarnessAdapter]]);
    const events = new HerderEventBus();
    const jobs = new HerderJobRegistry(events, { persistencePath: join(root, "jobs.json") });
    const delivery = new UserMessageDelivery(adapters, { sendMessage: (_harness, id, options) => adapter.sendMessage(id, options) }, jobs,
      { pollMs: 5, maxWaitMs: 2_000, maxPending: 4 }, new MinimaxExecPolicyStore(join(root, "policy")));
    await delivery.setMinimaxExecPolicy({ hostId: localSessionHostId(), harness: "minimax-code", sessionId }, 0, "full");
    const adapterSend = vi.spyOn(adapter, "sendMessage");
    const server = new McpServer({ name: "minimax-durable-send-test", version: "1" });
    const client = new Client({ name: "minimax-durable-send-test-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    registerSessionTools(server, { adapters, jobs, events, userMessageDelivery: delivery, routingPeers: [] });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const args = { harness: "minimax-code", sessionId, humanRequested: true, inputId: "public-mcp-idle-canary-input", mode: "queue", message: "benign public MCP delivery fixture" };
      const first = await client.callTool({ name: "send_message", arguments: args });
      expect(first.isError).not.toBe(true);
      const pending = JSON.parse(first.content[0]?.type === "text" ? first.content[0].text : "{}");
      expect(pending).toMatchObject({ ok: true, delivery: "durable_pending", nativeAdmission: "pending", inputId: args.inputId });
      expect(typeof pending.jobId).toBe("string");
      await vi.waitFor(() => expect(jobs.get(pending.jobId)?.state).toBe("completed"), { interval: 5, timeout: 1_500 });
      expect(jobs.get(pending.jobId)?.result).toMatchObject({ ok: true, admitted: true, admission: "accepted", turnId: "turn-mcp-exact", inputId: args.inputId });
      expect(runSession).toHaveBeenCalledTimes(1);
      expect(runSession).toHaveBeenCalledWith(sessionId, workspace, join(root, ".minimax"), expect.any(String), "full");

      const replay = await client.callTool({ name: "send_message", arguments: args });
      expect(replay.content[0]).toMatchObject({ text: expect.stringContaining("Native admission receipt") });
      expect(runSession).toHaveBeenCalledTimes(1);
      for (const mode of ["steer", "sync"]) {
        const refused = await client.callTool({ name: "send_message", arguments: { ...args, inputId: `nonqueue-${mode}`, mode } });
        const result = JSON.parse(refused.content[0]?.type === "text" ? refused.content[0].text : "{}");
        expect(result).toMatchObject({ ok: false, delivery: "not_attempted", activated: false, error: expect.stringContaining("was not sent") });
      }
      expect(adapterSend).toHaveBeenCalledOnce();
      expect(runSession).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("admits a mesh agent claim through the exact idle CLI without granting human origin",async()=>{
    const root=await store(),sessionId="mvs_agent_cli_claim",sessionStore=join(root,".minimax","v2","sessions"),workspace=join(root,"workspace");
    await mkdir(workspace,{recursive:true});await writeSession(sessionStore,sessionId,{model:"MiniMax-M3.1-Flash"});
    const runtimeDb=await runtimeStateForSession(root,sessionId,workspace);
    const control=new MinimaxCodeControl({manifestPath:join(root,"offline-manifest.json")});
    const runSession=vi.fn(async()=>({ok:true,status:200,body:{sessionId,turnId:"agent-native-turn",status:"succeeded",model:{providerId:"minimax",modelId:"MiniMax-M3.1-Flash",providerKind:"minimax-managed"}}}));
    (control as unknown as {runSession:typeof runSession}).runSession=runSession;
    const adapter=new MinimaxCodeAdapter({sessionStore,runtimeDb,runtimeDataDir:join(root,".minimax"),control});
    const jobs=new HerderJobRegistry(new HerderEventBus(),{persistencePath:join(root,"jobs.json")});
    const delivery=new UserMessageDelivery(new Map([["minimax-code",adapter as unknown as HarnessAdapter]]),{
      sendMessage:async(_harness, id, options)=>adapter.sendMessage(id,options),
    },jobs,{pollMs:1,maxWaitMs:3_000,maxPending:4},new MinimaxExecPolicyStore(join(root,"policy")));
    const input={harness:"minimax-code",sessionId,inputId:"agent-cli-input",message:"benign agent delta",mode:"queue" as const};
    try{
      const ingress=trustedMeshIngressFromMcpAuthInfo({token:"test-transport-token",clientId:TRUSTED_MESH_MCP_CLIENT_ID,scopes:[TRUSTED_MESH_MCP_SCOPE]})!;
      await delivery.submitMinimaxAgent(input,{hostId:"source-host",harness:"opencode",nativeSessionId:"source-session"},ingress);
      await vi.waitFor(()=>expect(delivery.get(input.harness,sessionId,input.inputId)).toMatchObject({ok:true,admitted:true,turnId:"agent-native-turn"}));
      expect(runSession).toHaveBeenCalledOnce();
      expect(runSession).toHaveBeenCalledWith(sessionId,workspace,join(root,".minimax"),input.message,undefined);
      expect(delivery.get(input.harness,sessionId,input.inputId)?.job?.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    }finally{delivery.close();await delivery.getMinimaxExecPolicy({hostId:localSessionHostId(),harness:"minimax-code",sessionId});await delivery.getMinimaxExecPolicy({hostId:localSessionHostId(),harness:"minimax-code",sessionId});}
  });

  it("keeps a recently active old session visible before applying the store window", async () => {
    const root = await store();
    const active = await writeSession(root, "mvs_active", { day: "2026/10/09", updatedAtMs: 1000 });
    await writeSession(root, "mvs_old", { day: "2026/10/10", updatedAtMs: 2000 });
    await writeSession(root, "mvs_new", { day: "2026/10/23", updatedAtMs: 3000 });
    await utimes(join(active, "messages.jsonl"), 5, 5);
    const adapter = new MinimaxCodeAdapter({ control: new MinimaxCodeControl({ manifestPath: join(root, "offline-manifest.json") }), sessionStore: root, maxSessions: 2 });
    expect((await adapter.listSessions({ limit: 1 }))[0]).toMatchObject({ id: "mvs_active", lastActivity: new Date(5000).toISOString() });
    expect((await adapter.getSession("mvs_new"))?.id).toBe("mvs_new");
  });
  it("lists stored sessions newest first with title, model and last message", async () => {
    const root = await store();
    await writeSession(root, "mvs_0000000000000000000000000000aaaa", {
      updatedAtMs: 1_700_000_100_000,
      model: "MiniMax-M3.1-Flash",
      messages: [
        {
          message_id: "m1",
          turn_id: "t1",
          message: {
            role: "user",
            content: [
              { type: "text", text: "<system-reminder>\nnoise\n</system-reminder>\nчистый вопрос" },
            ],
          },
        },
        { message_id: "m2", turn_id: "t1", message: { role: "assistant", content: "ответ" } },
      ],
    });
    await writeSession(root, "mvs_0000000000000000000000000000bbbb", {
      updatedAtMs: 1_700_000_900_000,
      messages: [{ message_id: "m1", turn_id: "t1", message: { role: "user", content: "свежая" } }],
    });

    const adapter = new MinimaxCodeAdapter({ control: new MinimaxCodeControl({ manifestPath: join(root, "offline-manifest.json") }), sessionStore: root });
    const sessions = await adapter.listSessions();

    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.id).toBe("mvs_0000000000000000000000000000bbbb");
    expect(sessions[0]?.harness).toBe("minimax-code");
    expect(sessions[0]?.title).toBe("свежая");
    expect(sessions[0]?.model).toBeUndefined();
    expect(sessions[1]?.title).toBe("чистый вопрос");
    expect(sessions[1]?.model).toBe("minimax/MiniMax-M3.1-Flash");
    expect(sessions[1]?.lastMessage).toBe("ответ");
    expect(sessions[1]?.status).toBe("idle");
    expect(sessions[1]?.needsPermission).toBe(false);
    expect(sessions[1]?.meta?.readOnly).toBe(true);
  });

  it("resolves a session by id and falls back to the encoded directory name", async () => {
    const root = await store();
    await writeSession(root, "mvs_0000000000000000000000000000cccc", { manifest: null });

    const adapter = new MinimaxCodeAdapter({ control: new MinimaxCodeControl({ manifestPath: join(root, "offline-manifest.json") }), sessionStore: root });
    const session = await adapter.getSession("mvs_0000000000000000000000000000cccc");

    expect(session?.id).toBe("mvs_0000000000000000000000000000cccc");
    expect(session?.title).toBe("первый вопрос");
  });

  it("skips unreadable session directories instead of failing the pass", async () => {
    const root = await store();
    await writeSession(root, "mvs_0000000000000000000000000000dddd");
    await mkdir(join(root, "2026/10/19/20-31-52-444-session_broken"), { recursive: true });

    const adapter = new MinimaxCodeAdapter({ control: new MinimaxCodeControl({ manifestPath: join(root, "offline-manifest.json") }), sessionStore: root });
    const sessions = await adapter.listSessions();

    expect(sessions.map((session) => session.id)).toEqual(["mvs_0000000000000000000000000000dddd"]);
  });

  it("reads a transcript from the message log", async () => {
    const root = await store();
    await writeSession(root, "mvs_0000000000000000000000000000eeee", {
      messages: [
        { message_id: "m1", turn_id: "t1", message: { role: "user", content: "вопрос" } },
        { message_id: "m2", turn_id: "t1", message: { role: "assistant", content: [{ type: "text", text: "ответ" }] } },
      ],
    });

    const adapter = new MinimaxCodeAdapter({ control: new MinimaxCodeControl({ manifestPath: join(root, "offline-manifest.json") }), sessionStore: root });
    const transcript = await adapter.getTranscript("mvs_0000000000000000000000000000eeee");

    expect(transcript).toContain("## user\nвопрос");
    expect(transcript).toContain("## assistant\nответ");
  });

  it("exposes session messages for the supervisor", async () => {
    const root = await store();
    await writeSession(root, "mvs_0000000000000000000000000000aabb", {
      messages: [
        { message_id: "m1", turn_id: "t1", message: { role: "user", content: "вопрос" } },
        {
          message_id: "m2",
          turn_id: "t1",
          message: { role: "assistant", content: [{ type: "text", text: "ответ" }], model: "MiniMax-M3.1-Flash" },
        },
      ],
    });

    const adapter = new MinimaxCodeAdapter({ control: new MinimaxCodeControl({ manifestPath: join(root, "offline-manifest.json") }), sessionStore: root });
    const messages = await adapter.getSessionMessages("mvs_0000000000000000000000000000aabb");

    expect(messages).toHaveLength(2);
    expect(messages?.[0]?.role).toBe("user");
    expect(messages?.[0]?.text).toBe("вопрос");
    expect(messages?.[1]?.role).toBe("assistant");
    expect(messages?.[1]?.model).toBe("MiniMax-M3.1-Flash");
    expect(messages?.[1]?.turnId).toBe("t1");
    expect(messages?.[1]?.parts[0]?.text).toBe("ответ");
  });

  it("refuses delivery because desktop sessions are runtime owned", async () => {
    const root = await store();
    await writeSession(root, "mvs_0000000000000000000000000000ffff");
    // The control must not see the manifest of a live desktop runtime of the
    // host: the refusal of the store-only transport is the subject here.
    const adapter = new MinimaxCodeAdapter({
      sessionStore: root,
      control: new MinimaxCodeControl({ manifestPath: join(root, "no-manifest.json") }),
    });

    const result = await adapter.sendMessage("mvs_0000000000000000000000000000ffff", { message: "привет" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("local runtime");
    expect(adapter.controlCapabilities.steer).toBe(false);
    expect(adapter.controlCapabilities.resume).toBe(false);
    expect(adapter.controlCapabilities.cancelTurn).toBe(false);
  });

  it("reports a missing store on init", async () => {
    const adapter = new MinimaxCodeAdapter({ sessionStore: join(tmpdir(), "minimax-code-missing-store") });
    await expect(adapter.init()).rejects.toThrow(/session store not found/);
  });

  it("initialises on an empty store directory", async () => {
    const root = await store();
    await mkdir(join(root, "2026/10/19"), { recursive: true });
    const adapter = new MinimaxCodeAdapter({ control: new MinimaxCodeControl({ manifestPath: join(root, "offline-manifest.json") }), sessionStore: root });

    await expect(adapter.init()).resolves.toBeUndefined();
    expect(await adapter.listSessions()).toEqual([]);
  });

  it("serves a repeated enumeration from the content cache", async () => {
    const root = await store();
    const dir = await writeSession(root, "mvs_0000000000000000000000000000cafe", {
      messages: [{ message_id: "m1", turn_id: "t1", message: { role: "user", content: "вопрос" } }],
    });

    const adapter = new MinimaxCodeAdapter({ control: new MinimaxCodeControl({ manifestPath: join(root, "offline-manifest.json") }), sessionStore: root });
    expect((await adapter.listSessions())[0]?.title).toBe("вопрос");

    // The transcript becomes unreadable while its stamp stays the same, so a
    // pass that still resolves the title proves the content cache answered.
    await chmod(join(dir, "messages.jsonl"), 0o000);
    expect((await adapter.listSessions())[0]?.title).toBe("вопрос");
  });

  it("re-reads a session when its message log changed", async () => {
    const root = await store();
    const dir = await writeSession(root, "mvs_0000000000000000000000000000beef", {
      messages: [{ message_id: "m1", turn_id: "t1", message: { role: "user", content: "вопрос" } }],
    });

    const adapter = new MinimaxCodeAdapter({ control: new MinimaxCodeControl({ manifestPath: join(root, "offline-manifest.json") }), sessionStore: root });
    expect((await adapter.listSessions())[0]?.lastMessage).toBe("вопрос");

    await writeFile(
      join(dir, "messages.jsonl"),
      `${JSON.stringify({ message_id: "m1", turn_id: "t1", message: { role: "user", content: "вопрос" } })}\n${JSON.stringify({ message_id: "m2", turn_id: "t1", message: { role: "assistant", content: "ответ" } })}\n`,
    );

    expect((await adapter.listSessions())[0]?.lastMessage).toBe("ответ");
  });
});

describe("MinimaxCodeAdapter with the published desktop transport", () => {
  it.each([
    ["missing item ID", { status: "pending" }],
    ["invalid status", { item_id: "queue-item", status: "accepted" }],
  ])("treats a 2xx queue response with %s as terminal UNKNOWN", async (_case, body) => {
    const enqueue = vi.fn(async () => ({ ok: true, status: 200, body }));
    const control = { available: async () => true, enqueue } as unknown as MinimaxCodeControl;
    const adapter = new MinimaxCodeAdapter({ control });

    const result = await adapter.sendMessage("mvs_queue_missing_receipt", { message: "queue fixture", queue: true, inputId: "queue-no-item-id" });

    expect(result).toMatchObject({ ok: false, admissionUnknown: true, nonRetryable: true, inputId: "queue-no-item-id" });
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("delivers, steers, queues and aborts through the live runtime", async () => {
    const root = await store();
    await writeSession(root, "mvs_0000000000000000000000000000aaa1", {
      messages: [{ message_id: "m1", turn_id: "t1", message: { role: "user", content: "вопрос" } }],
    });

    const calls: { url: string; body: string }[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        calls.push({ url: request.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
        if (request.url?.endsWith("/message")) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(`data: ${JSON.stringify({ type: "turn_started", turn_id: "turn-1" })}\n\n`);
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ success: true, turn_id: "turn-1", item_id: "queue-1" }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const manifestDir = await mkdtemp(join(tmpdir(), "minimax-code-manifest-"));
    created.push(manifestDir);
    const manifestPath = join(manifestDir, "mcode-diagnostic.json");
    await writeFile(manifestPath, JSON.stringify({ port, host: "127.0.0.1", pid: process.pid }));

    const adapter = new MinimaxCodeAdapter({
      sessionStore: root,
      control: new MinimaxCodeControl({ manifestPath, manifestTtlMs: 0 }),
    });
    await adapter.init();

    expect(adapter.controlCapabilities.steer).toBe(true);
    expect(adapter.controlCapabilities.resume).toBe(false);

    const sent = await adapter.sendMessage("mvs_0000000000000000000000000000aaa1", { message: "привет" });
    expect(sent.ok).toBe(true);
    expect(sent.admitted).toBe(true);
    expect(sent.turnId).toBe("turn-1");

    const steered = await adapter.sendMessage("mvs_0000000000000000000000000000aaa1", {
      message: "свернись",
      steer: true,
    });
    expect(steered.ok).toBe(true);
    expect(steered.turnId).toBe("turn-1");

    const active = await adapter.sendActiveMessage("mvs_0000000000000000000000000000aaa1", {
      message: "ответь на текущее сообщение",
      origin: "human",
      inputId: "active-turn-1",
      activeTurnOnly: true,
      steer: true,
    });
    expect(active).toMatchObject({ ok: true, admitted: true, turnId: "turn-1", inputId: "active-turn-1" });

    const queued = await adapter.sendMessage("mvs_0000000000000000000000000000aaa1", {
      message: "в очередь",
      queue: true,
    });
    expect(queued.ok).toBe(true);
    expect(queued.turnId).toBe("queue-1");

    const aborted = await adapter.stopSession("mvs_0000000000000000000000000000aaa1");
    expect(aborted.ok).toBe(true);

    expect(calls.map((call) => call.url)).toEqual([
      "/minimax-desktop/api/v1/session/mvs_0000000000000000000000000000aaa1/message",
      "/minimax-desktop/api/v1/session/mvs_0000000000000000000000000000aaa1/queue",
      "/minimax-desktop/api/v1/session/mvs_0000000000000000000000000000aaa1/steer",
      "/minimax-desktop/api/v1/session/mvs_0000000000000000000000000000aaa1/queue",
      "/minimax-desktop/api/v1/session/mvs_0000000000000000000000000000aaa1/steer",
      "/minimax-desktop/api/v1/session/mvs_0000000000000000000000000000aaa1/queue",
      "/minimax-desktop/api/v1/session/mvs_0000000000000000000000000000aaa1/abort",
    ]);
  });

  it("keeps the store-only refusal while the desktop app publishes no transport", async () => {
    const root = await store();
    await writeSession(root, "mvs_0000000000000000000000000000bbb1", {
      messages: [{ message_id: "m1", turn_id: "t1", message: { role: "user", content: "вопрос" } }],
    });
    const manifestDir = await mkdtemp(join(tmpdir(), "minimax-code-manifest-"));
    created.push(manifestDir);

    const adapter = new MinimaxCodeAdapter({
      sessionStore: root,
      control: new MinimaxCodeControl({ manifestPath: join(manifestDir, "missing.json") }),
    });
    await adapter.init();

    expect(adapter.controlCapabilities.steer).toBe(false);
    const result = await adapter.sendMessage("mvs_0000000000000000000000000000bbb1", { message: "привет" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("local runtime");
  });

  /**
   * Список сессий MiniMax Code должен говорить правду о живости.
   *
   * Стор на диске знает, какие сессии существуют, но не знает, какие из них
   * работают сейчас: до правки каждая сохранённая сессия получала статус
   * `idle`. Рантайм знает: он держит lease прогона, который выполняет прямо
   * сейчас. Список обязан совпадать с активным инвентарём, иначе живая
   * сессия, которую рантайм доказывает, в панели не видна.
   */
  it("приводит в списке сессию, которую рантайм доказывает как выполняемую", async () => {
    const root = await store();
    const storedId = "mvs_0000000000000000000000000000c001";
    const liveId = "mvs_0000000000000000000000000000c002";
    const updatedAtMs = 1_700_000_100_000;
    await writeSession(root, storedId, { updatedAtMs });
    const runtimeDb = await runtimeStateWithTurn(root, liveId, updatedAtMs);
    const adapter = new MinimaxCodeAdapter({
      sessionStore: root,
      cwd: "/tmp/minimax",
      runtimeDb,
      control: new MinimaxCodeControl({ manifestPath: join(root, "offline-manifest.json") }),
    });

    const sessions = await adapter.listSessions();
    const live = sessions.find((session) => session.id === liveId);
    expect(live).toBeDefined();
    expect(live?.status).toBe("running");
    expect(live?.meta?.activityEvidence).toBe("native_runtime_turn_lease");
    // Время последней активности — реальное, а не штамп старого файла.
    expect(live?.lastActivity).toBe(new Date(updatedAtMs).toISOString());
    // Сохранённая сессия остаётся в списке и не выдумывает живость.
    const stored = sessions.find((session) => session.id === storedId);
    expect(stored).toBeDefined();
    expect(stored?.status).toBe("idle");
  });

  it("берёт время последней активности как позднейшую из двух реальных отметок", async () => {
    const root = await store();
    const liveId = "mvs_0000000000000000000000000000c003";
    const storedAt = 1_700_000_100_000;
    const runtimeAt = 1_700_000_900_000;
    await writeSession(root, "mvs_0000000000000000000000000000c004", { updatedAtMs: storedAt });
    const runtimeDb = await runtimeStateWithTurn(root, liveId, runtimeAt);
    const adapter = new MinimaxCodeAdapter({
      sessionStore: root,
      cwd: "/tmp/minimax",
      runtimeDb,
      control: new MinimaxCodeControl({ manifestPath: join(root, "offline-manifest.json") }),
    });

    const live = (await adapter.listSessions()).find((session) => session.id === liveId);
    // Рантайм обновил сессию позже транскрипта — значит позже и последняя активность.
    expect(live?.lastActivity).toBe(new Date(runtimeAt).toISOString());
  });

  it("без рантайм-БД список остаётся правдивым и не выдумывает живых сессий", async () => {
    const root = await store();
    const storedId = "mvs_0000000000000000000000000000c005";
    await writeSession(root, storedId, { updatedAtMs: 1_700_000_100_000 });
    const adapter = new MinimaxCodeAdapter({
      sessionStore: root,
      cwd: "/tmp/minimax",
      runtimeDb: join(root, "нет-такой-базы.sqlite"),
      control: new MinimaxCodeControl({ manifestPath: join(root, "offline-manifest.json") }),
    });

    const sessions = await adapter.listSessions();
    expect(sessions.map((session) => session.id)).toEqual([storedId]);
    expect(sessions[0]?.status).toBe("idle");
    expect(sessions[0]?.meta?.liveStatus).toBe("unknown");
  });
});
