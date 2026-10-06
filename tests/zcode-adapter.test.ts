import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ZcodeClientLike } from "../src/adapters/zcode-protocol.js";
import { ZcodeAdapter, resolveConfiguredZcodeModel, zcodeConfiguredModels } from "../src/adapters/zcode.js";
import { markLifecycleEvent } from "../src/session-lifecycle.js";
import { getHumanStopStore } from "../src/human-stop-store.js";

const session = {
  sessionId: "session-1",
  workspace: { workspacePath: "/workspace", workspaceIdentity: "/workspace" },
  parentSessionId: "parent-1",
  sessionKind: "subagent_child",
  title: "Repair task",
  mode: "build",
  status: "running",
  model: { providerId: "zai", modelId: "GLM-4.5" },
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
};

const snapshot = {
  protocol: { name: "ZCode Protocol", version: 1 },
  session,
  settings: { model: { current: session.model, available: [session.model] } },
  projection: {},
  runtime: { eventSeq: 2, stateRevision: 3, pendingRequestIds: [] },
  messages: [
    {
      info: { messageId: "message-1", sessionId: "session-1", role: "user", time: { created: 1_700_000_000_000 }, agent: "glm", model: session.model },
      parts: [{ partId: "part-1", sessionId: "session-1", messageId: "message-1", type: "text", text: "Please repair it" }],
    },
    {
      info: { messageId: "message-2", sessionId: "session-1", role: "assistant", time: { created: 1_700_000_010_000 }, parentMessageId: "message-1", agent: "glm", model: session.model, path: { cwd: "/workspace", root: "/workspace" }, cost: 0, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } },
      parts: [{ partId: "part-2", sessionId: "session-1", messageId: "message-2", type: "text", text: "I will inspect the repository." }],
    },
  ],
};

class FakeClient implements ZcodeClientLike {
  readonly calls: Array<{ channel: string; method: string; args: unknown[] }> = [];
  nativeEvents: Array<Record<string, unknown>> = [];
  started = false;
  closed = false;
  readonly listeners: Array<{ channel: string; event: string; arg: unknown; handler: (payload: unknown) => void }> = [];

  async start(): Promise<void> { this.started = true; }
  async close(): Promise<void> { this.closed = true; }
  listen(channel: string, event: string, arg: unknown, handler: (payload: unknown) => void): () => void {
    const entry = { channel, event, arg, handler };
    this.listeners.push(entry);
    return () => { const index = this.listeners.indexOf(entry); if (index >= 0) this.listeners.splice(index, 1); };
  }

  async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
    this.calls.push({ channel, method, args });
    if (channel === "zcode-agent" && method === "initialize") {
      return { available: true, protocolName: "ZCode Protocol", protocolVersion: 1, transportKind: "stdio" };
    }
    if (channel === "zcode-agent" && method === "listSessions") return [session];
    if (channel === "zcode-agent" && method === "readSession") return snapshot;
    if (channel === "zcode-agent" && method === "readSessionMessages") return snapshot.messages;
    if (channel === "zcode-agent" && method === "readSessionEvents") {
      const accepted = [...this.calls].reverse().find((call) => call.channel === "zcode-agent" && call.method === "sendPrompt");
      const inputId = (accepted?.args[0] as { inputId?: string } | undefined)?.inputId;
      const acceptedEvent = inputId ? [{
        type: "turn.started",
        eventId: `turn-started-${inputId}`,
        sessionId: (accepted?.args[0] as { sessionId?: string }).sessionId,
        turnId: `turn-${inputId}`,
        seq: 3,
        timestamp: Date.now(),
        payload: { inputId },
      }] : [];
      return { events: [...this.nativeEvents, ...acceptedEvent] };
    }
    if (channel === "zcode-agent" && method === "readWorkspaceState") return { settings: { model: { current: session.model, available: [{ ref: session.model, label: "GLM-4.5" }] } } };
    if (channel === "zcode-agent" && method === "resumeSession") return snapshot;
    if (channel === "zcode-agent" && method === "createSession") return { ...snapshot, session: { ...session, sessionId: "created-1", title: "New task", parentSessionId: undefined, sessionKind: "interactive" } };
    if (channel === "zcode-agent" && method === "setMode") return {
      ...snapshot,
      session: { ...session, sessionId: (args[0] as { sessionId: string }).sessionId, mode: "yolo", parentSessionId: undefined, sessionKind: "interactive" },
      settings: { ...snapshot.settings, permission: { mode: (args[0] as { mode: string }).mode, rulesRevision: 1 } },
    };
    if (channel === "zcode-agent" && method === "sendPrompt") return { accepted: true };
    if (channel === "zcode-agent" && method === "setModel") return snapshot;
    if (channel === "zcode-agent" && method === "closeSession") return { closed: true };
    if (channel === "zcode-task" && method === "stopGeneration") return undefined;
    if (channel === "zcode-task" && method === "respondPermission") return true;
    throw new Error(`unexpected fake call ${channel}.${method}`);
  }
}

class StaleStatusClient extends FakeClient {
  updatedAtMs = Date.now() - 30_000;
  override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
    if (channel === "zcode-agent" && method === "listSessions") {
      return [{
        ...session,
        status: "idle",
        updatedAt: this.updatedAtMs,
      }];
    }
    if (channel === "zcode-agent" && method === "readSession") {
      throw new Error("Cannot read properties of undefined (reading 'runtimePolicy')");
    }
    return super.call(channel, method, args);
  }
}

class LongTranscriptClient extends FakeClient {
  readonly messages = [
    {
      info: { messageId: "original-user", sessionId: "session-1", role: "user", time: { created: 1_700_000_000_000 } },
      parts: [{ partId: "original-part", sessionId: "session-1", messageId: "original-user", type: "text", text: "original zcode goal" }],
    },
    ...Array.from({ length: 210 }, (_, index) => ({
      info: {
        messageId: `later-${index}`,
        sessionId: "session-1",
        role: index % 2 ? "assistant" : "user",
        time: { created: 1_700_000_001_000 + index },
      },
      parts: [{
        partId: `later-part-${index}`,
        sessionId: "session-1",
        messageId: `later-${index}`,
        type: "text",
        text: `later zcode message ${index}`,
      }],
    })),
  ];

  override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
    if (channel === "zcode-agent" && method === "readSessionMessages") {
      const limit = Number((args[0] as { limit?: number } | undefined)?.limit ?? 100);
      return this.messages.slice(-limit);
    }
    if (channel === "zcode-agent" && method === "readSession") return { ...snapshot, messages: this.messages };
    return super.call(channel, method, args);
  }
}

describe("ZCode adapter", () => {
  it("persists native pinned state in the cross-workspace task index", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-zcode-pin-"));
    const dbPath = join(root, "tasks-index.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("create table tasks (task_id text primary key, pinned integer not null default 0, deleted integer not null default 0)");
    db.prepare("insert into tasks (task_id, pinned, deleted) values (?, 0, 0)").run("session-pin");
    db.close();
    try {
      const adapter = new ZcodeAdapter({ client: new FakeClient(), tasksIndexDbPath: dbPath });
      await expect(adapter.setSessionPinned?.("session-pin", true)).resolves.toMatchObject({ ok: true, sessionId: "session-pin" });
      const reader = new DatabaseSync(dbPath, { readOnly: true });
      expect(reader.prepare("select pinned from tasks where task_id = ?").get("session-pin")).toMatchObject({ pinned: 1 });
      reader.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers persisted sessions across workspaces before the live app-server is ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-zcode-index-"));
    const dbPath = join(root, "tasks-index.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`create table tasks (
      task_id text primary key, workspace_path text, title text, task_status text,
      model text, created_at integer, updated_at integer, deleted integer default 0,
      archived integer default 0
    )`);
    db.prepare("insert into tasks (task_id,workspace_path,title,task_status,model,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run("persisted-1", "/another/workspace", "Unfinished persisted task", "running", "zai/GLM-5.3-Flash", Date.now() - 60_000, Date.now() - 60_000);
    db.prepare("insert into tasks (task_id,workspace_path,title,task_status,model,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run("persisted-no-model", "/another/workspace", "Persisted task without model", "idle", null, Date.now() - 60_000, Date.now() - 60_000);
    db.close();
    try {
      const adapter = new ZcodeAdapter({ client: new FakeClient(), tasksIndexDbPath: dbPath });
      expect((await adapter.listSessions()).find((session) => session.id === "persisted-1")).toMatchObject({
        id: "persisted-1", harness: "zcode", title: "Unfinished persisted task",
        cwd: "/another/workspace", status: "running", model: "zai/GLM-5.3-Flash",
        meta: { discoverySource: "tasks-index" },
      });
      expect((await adapter.listSessions()).find((session) => session.id === "persisted-no-model")).toMatchObject({
        id: "persisted-no-model",
        model: undefined,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pages the complete persisted task index instead of truncating discovery at 200 rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-zcode-large-index-"));
    const dbPath = join(root, "tasks-index.sqlite");
    const sessionDbPath = join(root, "db.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`create table tasks (
      task_id text primary key, workspace_path text, title text, task_status text,
      model text, created_at integer, updated_at integer, deleted integer default 0,
      archived integer default 0
    )`);
    const insert = db.prepare("insert into tasks (task_id,workspace_path,title,task_status,created_at,updated_at) values (?,?,?,?,?,?)");
    const now = Date.now();
    db.exec("begin");
    for (let index = 0; index < 605; index += 1) {
      insert.run(`persisted-${index}`, `/workspace/${index}`, `Task ${index}`, "completed", now - index, now - index);
    }
    db.exec("commit");
    db.close();
    const sessionDb = new DatabaseSync(sessionDbPath);
    sessionDb.exec("create table session (id text primary key, directory text not null, workspace_id text)");
    sessionDb.close();
    try {
      const adapter = new ZcodeAdapter({ client: new FakeClient(), tasksIndexDbPath: dbPath, localDbPath: sessionDbPath });
      const sessions = await adapter.listSessions();
      expect(sessions).toHaveLength(605);
      expect(new Set(sessions.map((item) => item.id)).size).toBe(605);
      expect(sessions.map((item) => item.id)).toContain("persisted-604");
      expect(adapter.getSessionSnapshotReceipt?.()).toMatchObject({
        exhaustive: true,
        source: "zcode-tasks-index",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks a multi-page persisted snapshot non-exhaustive when a later page fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-zcode-partial-index-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const sessionDbPath = join(root, "db.sqlite");
    const tasks = new DatabaseSync(taskDbPath);
    tasks.exec(`create table task_rows (
      position integer primary key, task_id text, workspace_path text,
      workspace_identity text, title text, task_status text, model text,
      created_at integer, updated_at integer, pinned integer default 0,
      deleted integer default 0, archived integer default 0
    )`);
    const insert = tasks.prepare(`insert into task_rows (
      position,task_id,workspace_path,workspace_identity,title,task_status,created_at,updated_at
    ) values (?,?,?,?,?,?,?,?)`);
    const now = Date.now();
    tasks.exec("begin");
    for (let index = 0; index < 605; index += 1) {
      insert.run(index, `persisted-${index}`, `/workspace/${index}`, `/workspace/${index}`, `Task ${index}`, "completed", now - index, now - index);
    }
    tasks.exec("commit");
    tasks.exec(`create view tasks as
      select task_id, workspace_path,
             case when position >= 500 then json_extract('malformed', '$.workspace') else workspace_identity end as workspace_identity,
             title, task_status, model, created_at, updated_at, pinned, deleted, archived
      from task_rows`);
    tasks.close();
    const sessionDb = new DatabaseSync(sessionDbPath);
    sessionDb.exec("create table session (id text primary key, directory text not null, workspace_id text)");
    sessionDb.close();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const adapter = new ZcodeAdapter({
        cwd: root,
        command: "/definitely/not-started",
        tasksIndexDbPath: taskDbPath,
        localDbPath: sessionDbPath,
      });
      await expect(adapter.listSessions()).resolves.toEqual([]);
      expect(adapter.getSessionSnapshotReceipt?.()).toMatchObject({
        exhaustive: false,
        source: "zcode-tasks-index",
        reason: expect.stringContaining("tasks_index_read_failed"),
      });
    } finally {
      error.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a task listing non-exhaustive when native workspace canonicalization fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-zcode-native-index-error-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const sessionDbPath = join(root, "db.sqlite");
    const tasks = new DatabaseSync(taskDbPath);
    tasks.exec(`create table tasks (
      task_id text primary key, workspace_path text, title text, task_status text,
      model text, created_at integer, updated_at integer, deleted integer default 0,
      archived integer default 0
    )`);
    tasks.prepare("insert into tasks (task_id,workspace_path,title,task_status,created_at,updated_at) values (?,?,?,?,?,?)")
      .run("persisted-1", root, "Task", "completed", Date.now(), Date.now());
    tasks.close();
    const invalidNativeDb = new DatabaseSync(sessionDbPath);
    invalidNativeDb.exec("create table unrelated (id text primary key)");
    invalidNativeDb.close();
    try {
      const adapter = new ZcodeAdapter({ client: new FakeClient(), tasksIndexDbPath: taskDbPath, localDbPath: sessionDbPath });
      await expect(adapter.listSessions()).resolves.toHaveLength(1);
      expect(adapter.getSessionSnapshotReceipt?.()).toMatchObject({
        exhaustive: false,
        source: "zcode-tasks-index",
        reason: "native_session_schema_missing",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads exact cold failure evidence without waking the transport or confusing human stops", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-cold-native-"));
    const tasksPath = join(root, "tasks.sqlite");
    const nativePath = join(root, "native.sqlite");
    const tasks = new DatabaseSync(tasksPath);
    tasks.exec("create table tasks(task_id text, workspace_path text, title text, task_status text, model text, created_at integer, updated_at integer, deleted integer default 0, archived integer default 0)");
    const native = new DatabaseSync(nativePath);
    native.exec(`create table session(id text primary key, directory text, parent_id text, time_updated integer);
      create table turn_usage(session_id text,turn_id text,user_message_id text,status text,started_at integer,completed_at integer,retryable integer,cancelled_by_user integer,error_type text,error_code text,primary key(session_id,turn_id));
      create table message(id text primary key,session_id text,data text,sequence integer,time_updated integer);
      create index message_session_sequence_idx on message(session_id,sequence);
      create table session_input(id text,session_id text,status text,time_created integer);
    `);
    const now = Date.now();
    const cases = ["retry", "captcha", "cancelled", "completed", "running", "child", "new-user", "progress", "succeeded", "pending"];
    for (const id of cases) {
      tasks.prepare("insert into tasks values(?,?,?,?,?,?,?,?,?)").run(id,root,id,"completed",null,now-10000,now-2000,0,0);
      native.prepare("insert into session values(?,?,?,?)").run(id,root,id==="child"?"parent":null,now-2000);
      const status = id === "cancelled" ? "cancelled" : id === "completed" ? "completed" : id === "running" ? "running" : "error";
      native.prepare("insert into turn_usage values(?,?,?,?,?,?,?,?,?,?)").run(id,"turn-"+id,"user-"+id,status,now-10000,id==="running"?null:now-2000,id==="captcha"?0:1,id==="cancelled"?1:0,"transport_error","CONNECTION_RESET");
      native.prepare("insert into message values(?,?,?,?,?)").run("user-"+id,id,JSON.stringify({role:"user"}),1,now-10000);
      native.prepare("insert into message values(?,?,?,?,?)").run("assistant-"+id,id,JSON.stringify({role:"assistant",parentID:"user-"+id,...(id==="succeeded"?{finish:"stop"}: {error:{name:"NativeError",data:{message:id==="captcha"?"Captcha verification request timed out":"connection lost"}}})}),2,id==="progress"?now-1000:now-2001);
      if (id==="pending") native.prepare("insert into session_input values(?,?,?,?)").run("pending-input",id,"admitted",now-5000);
      if (id==="new-user") native.prepare("insert into message values(?,?,?,?,?)").run("new-user-input",id,JSON.stringify({role:"user"}),3,now-1000);
    }
    tasks.close();native.close();
    const client = new FakeClient();
    try {
      const adapter = new ZcodeAdapter({client,tasksIndexDbPath:tasksPath,localDbPath:nativePath});
      const rows = await adapter.listSessions();
      const meta = (id:string) => rows.find((x)=>x.id===id)!.meta!.nativeLastTurn as Record<string,unknown>;
      expect(meta("retry")).toMatchObject({turnId:"turn-retry",status:"error",rootSession:true,pendingInput:false,userMessageMatchesLatest:true,assistantSucceeded:false,progressedAfterFailure:false,retryable:true,cancelledByUser:false});
      expect(rows.find((x)=>x.id==="retry")?.status).toBe("error");
      expect(rows.find((x)=>x.id==="captcha")?.status).toBe("error");
      expect(meta("captcha")).toMatchObject({retryable:false,cancelledByUser:false,requiresHuman:true});
      expect(meta("cancelled")).toMatchObject({status:"cancelled",cancelledByUser:true});
      expect(meta("child").rootSession).toBe(false);
      expect(meta("new-user").userMessageMatchesLatest).toBe(false);
      expect(meta("progress").progressedAfterFailure).toBe(true);
      expect(meta("succeeded").assistantSucceeded).toBe(true);
      expect(meta("running").status).toBe("running");
      expect(meta("pending").pendingInput).toBe(true);
      expect(client.started).toBe(false);expect(client.calls).toEqual([]);
    } finally { await rm(root,{recursive:true,force:true}); }
  });

  it("deduplicates ghost task rows using the native session workspace identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-zcode-duplicate-index-"));
    const taskDbPath = join(root, "tasks-index.sqlite");
    const sessionDbPath = join(root, "db.sqlite");
    const canonicalCwd = join(root, "canonical");
    const ghostCwd = join(root, "ghost");
    const workspaceIdentity = "remote:ssh:example.test:22:user:/canonical";
    const tasks = new DatabaseSync(taskDbPath);
    tasks.exec(`create table tasks (
      workspace_key text not null, task_id text not null, workspace_path text,
      workspace_identity text, title text, task_status text, model text,
      created_at integer, updated_at integer, pinned integer default 0,
      deleted integer default 0, archived integer default 0,
      primary key (workspace_key, task_id)
    )`);
    const insert = tasks.prepare(`insert into tasks (
      workspace_key,task_id,workspace_path,workspace_identity,title,task_status,
      created_at,updated_at,pinned
    ) values (?,?,?,?,?,?,?,?,?)`);
    insert.run(canonicalCwd, "duplicate-1", canonicalCwd, canonicalCwd, "Canonical task", "running", 1, Date.now() - 60_000, 1);
    insert.run(ghostCwd, "duplicate-1", ghostCwd, ghostCwd, "Ghost task", "completed", 1, Date.now(), 0);
    tasks.close();
    const sessionsDb = new DatabaseSync(sessionDbPath);
    sessionsDb.exec("create table session (id text primary key, directory text not null, workspace_id text)");
    sessionsDb.prepare("insert into session (id,directory,workspace_id) values (?,?,?)")
      .run("duplicate-1", canonicalCwd, workspaceIdentity);
    sessionsDb.close();
    try {
      const client = new FakeClient();
      const adapter = new ZcodeAdapter({
        client,
        tasksIndexDbPath: taskDbPath,
        localDbPath: sessionDbPath,
      });
      await expect(adapter.listSessions()).resolves.toMatchObject([{
        id: "duplicate-1",
        cwd: canonicalCwd,
        title: "Canonical task",
        status: "running",
        meta: {
          pinned: true,
          workspaceIdentity,
          duplicateTaskRows: 2,
          taskIndexWorkspacePaths: expect.arrayContaining([canonicalCwd, ghostCwd]),
        },
      }]);
      await adapter.init();
      await expect(adapter.sendMessage("duplicate-1", { message: "Continue canonical session" })).resolves.toEqual({ ok: true });
      expect(client.calls.find((call) => call.method === "sendPrompt")?.args[0]).toMatchObject({
        sessionId: "duplicate-1",
        workspacePath: canonicalCwd,
        workspaceIdentity,
        workspaceKey: canonicalCwd,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers recent persisted tasks without starting the ZCode app-server and treats stale running as a signal", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-zcode-index-"));
    const indexPath = join(root, "tasks-index.sqlite");
    const db = new DatabaseSync(indexPath);
    db.exec(`create table tasks (
      task_id text, workspace_path text, title text, task_status text, model text,
      created_at integer, updated_at integer, archived integer, deleted integer
    )`);
    db.prepare("insert into tasks values (?, ?, ?, ?, ?, ?, ?, 0, 0)").run(
      "persisted-1", root, "Interrupted task", "running", "minimax/MiniMax-M3", Date.now() - 20_000, Date.now() - 10 * 60_000,
    );
    db.close();
    const previous = process.env.ZCODE_TASKS_INDEX_DB;
    process.env.ZCODE_TASKS_INDEX_DB = indexPath;
    const adapter = new ZcodeAdapter({ cwd: root, command: "/definitely/not-started" });
    try {
      await expect(adapter.listSessions()).resolves.toMatchObject([{
        id: "persisted-1",
        status: "idle",
        meta: { persistedTaskStatus: "running", discoverySource: "tasks-index" },
      }]);
      expect(adapter.isReady()).toBe(false);
    } finally {
      await adapter.dispose();
      if (previous === undefined) delete process.env.ZCODE_TASKS_INDEX_DB;
      else process.env.ZCODE_TASKS_INDEX_DB = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes friendly provider model names and resolves them to native provider ids", () => {
    const config = {
      model: { main: "provider-uuid/minimax/MiniMax-M3" },
      provider: {
        "provider-uuid": {
          name: "omniroute",
          models: {
            "minimax/MiniMax-M3": {},
            "zc/glm-5.3-flash": {},
          },
        },
      },
    };

    expect(zcodeConfiguredModels(config)).toEqual([
      "provider-uuid/minimax/MiniMax-M3",
      "omniroute/minimax/MiniMax-M3",
      "omniroute/zc/glm-5.3-flash",
    ]);
    expect(resolveConfiguredZcodeModel("omniroute/zc/glm-5.3-flash", config)).toEqual({
      providerId: "provider-uuid",
      modelId: "zc/glm-5.3-flash",
    });
    expect(resolveConfiguredZcodeModel("provider-uuid/minimax/MiniMax-M3$high", config)).toEqual({
      providerId: "provider-uuid",
      modelId: "minimax/MiniMax-M3",
      options: { reasoningLevel: "high" },
    });
  });

  it("preserves native cancellation, sequence, and ordinary terminal outcomes", async () => {
    const client = new FakeClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    const events: Array<{ kind: string; sessionId?: string; nativeType?: string; data?: Record<string, unknown> }> = [];
    const stop = adapter.subscribeEvents((event) => events.push(event));
    await adapter.init();
    await adapter.listSessions();
    expect(client.listeners).toHaveLength(0);
    await adapter.getSession("session-1");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(client.listeners).toHaveLength(1);
    expect(client.listeners[0]).toMatchObject({
      channel: "zcode-agent",
      event: "onDynamicSessionEvent",
      arg: { sessionId: "session-1", deliveryKind: "replayable", afterSeq: 2, includeSnapshot: true },
    });
    client.listeners[0].handler({ type: "session.event", event: {
      type: "turn.completed", eventId: "zcode-stop-1", sessionId: "session-1", turnId: "turn-1", seq: 3,
      timestamp: 1_700_000_020_000, payload: { response: "", tokenCount: 0, toolCallCount: 0, duration: 0, resultType: "cancelled" },
    } });
    client.listeners[0].handler({ type: "session.event", event: {
      type: "turn.completed", eventId: "zcode-done-1", sessionId: "session-1", turnId: "turn-2", seq: 4,
      timestamp: 1_700_000_030_000, payload: { response: "done", tokenCount: 0, toolCallCount: 0, duration: 0, resultType: "success" },
    } });
    client.listeners[0].handler({ type: "session.event", event: {
      type: "turn.failed", eventId: "zcode-error-1", sessionId: "session-1", turnId: "turn-3", seq: 5,
      timestamp: 1_700_000_040_000, payload: { turnPhase: "execution", error: { type: "provider_error", message: "failed" } },
    } });
    client.listeners[0].handler({ type: "session.event", event: {
      type: "message.upserted", eventId: "zcode-message-1", sessionId: "session-1", turnId: "turn-3", seq: 6,
      timestamp: 1_700_000_041_000, payload: { content: "partial" },
    } });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "process.connected" }),
      expect.objectContaining({
        kind: "turn.completed", sessionId: "session-1", nativeType: "turn.completed",
        data: expect.objectContaining({ nativeType: "turn.completed", turnId: "turn-1", nativeResultType: "cancelled", nativeEventSeq: 3, automationStop: { id: "zcode-stop-1", at: new Date(1_700_000_020_000).toISOString(), reason: "cancelled", turnId: "turn-1" } }),
      }),
      expect.objectContaining({ kind: "turn.completed", sessionId: "session-1", nativeType: "turn.completed", data: expect.not.objectContaining({ automationStop: expect.anything() }) }),
      expect.objectContaining({
        kind: "turn.failed", sessionId: "session-1", nativeType: "turn.failed", status: "error",
        data: expect.objectContaining({ nativeErrorCode: "provider_error", nativeErrorMessage: "failed" }),
      }),
      expect.objectContaining({ kind: "message.updated", sessionId: "session-1", nativeType: "message.upserted" }),
    ]));
    stop();
  });

  it("replays a native stop across adapter restart and ignores a newer generated prompt", async () => {
    const human = {
      info: {
        messageId: "human-before-stop", sessionId: "session-1", role: "user", time: { created: 1_700_000_010_000 },
        semantics: { origin: "real_user", kind: "user_prompt" }, metadata: { inputId: "native-user-input" },
      },
      parts: [{ type: "text", text: "Please continue manually" }],
    };
    const generated = {
      info: {
        messageId: "generated-after-stop", sessionId: "session-1", role: "user", time: { created: 1_700_000_030_000 },
        semantics: { origin: "real_user", kind: "user_prompt" }, metadata: { inputId: "agent-herder:auto:generated-1" },
      },
      parts: [{ type: "text", text: "Continue automatically" }],
    };
    class PersistedNativeHistoryClient extends FakeClient {
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "readSession") {
          this.calls.push({ channel, method, args });
          return { ...snapshot, runtime: { ...snapshot.runtime, eventSeq: 3 }, messages: [human, generated] };
        }
        if (channel === "zcode-agent" && method === "readSessionEvents") {
          this.calls.push({ channel, method, args });
          return { events: [
            { type: "turn.started", eventId: "human-start", sessionId: "session-1", turnId: "turn-human", seq: 1, timestamp: 1_700_000_010_000, payload: { messageId: "human-before-stop", inputId: "native-user-input" } },
            { type: "turn.completed", eventId: "human-stop", sessionId: "session-1", turnId: "turn-human", seq: 2, timestamp: 1_700_000_020_000, payload: { response: "", tokenCount: 0, toolCallCount: 0, duration: 0, resultType: "cancelled" } },
            { type: "turn.started", eventId: "auto-start", sessionId: "session-1", turnId: "turn-auto", seq: 3, timestamp: 1_700_000_030_000, payload: { messageId: "generated-after-stop", inputId: "agent-herder:auto:generated-1" } },
          ] };
        }
        return super.call(channel, method, args);
      }
    }

    const adapter = new ZcodeAdapter({ cwd: "/workspace", client: new PersistedNativeHistoryClient() });
    await adapter.init();
    await expect(adapter.getSession("session-1")).resolves.toMatchObject({
      meta: {
        automationStop: { id: "human-stop", at: new Date(1_700_000_020_000).toISOString(), reason: "cancelled", turnId: "turn-human" },
        automationStopSequence: 2,
        automationStopHistoryAvailable: true,
        latestUserPrompt: { id: "human-before-stop", turnId: "turn-human" },
        latestUserPromptSequence: 1,
      },
    });
    await adapter.dispose();
  });

  it("clears a replayed native stop only after a newer explicit human prompt", async () => {
    const oldHuman = {
      info: { messageId: "human-old", sessionId: "session-1", role: "user", time: { created: 1_700_000_010_000 }, semantics: { origin: "real_user", kind: "user_prompt" } },
      parts: [{ type: "text", text: "old request" }],
    };
    const newHuman = {
      info: { messageId: "human-new", sessionId: "session-1", role: "user", time: { created: 1_700_000_030_000 }, semantics: { origin: "real_user", kind: "user_prompt" }, metadata: { inputId: "native-human-new" } },
      parts: [{ type: "text", text: "I am explicitly asking again" }],
    };
    class NewHumanPromptClient extends FakeClient {
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "readSession") {
          this.calls.push({ channel, method, args });
          return { ...snapshot, runtime: { ...snapshot.runtime, eventSeq: 3 }, messages: [oldHuman, newHuman] };
        }
        if (channel === "zcode-agent" && method === "readSessionEvents") {
          this.calls.push({ channel, method, args });
          return { events: [
            { type: "turn.started", eventId: "old-start", sessionId: "session-1", turnId: "turn-old", seq: 1, timestamp: 1_700_000_010_000, payload: { messageId: "human-old" } },
            { type: "turn.completed", eventId: "old-stop", sessionId: "session-1", turnId: "turn-old", seq: 2, timestamp: 1_700_000_020_000, payload: { response: "", tokenCount: 0, toolCallCount: 0, duration: 0, resultType: "cancelled" } },
            { type: "turn.started", eventId: "new-start", sessionId: "session-1", turnId: "turn-new", seq: 3, timestamp: 1_700_000_030_000, payload: { messageId: "human-new", inputId: "native-human-new" } },
          ] };
        }
        return super.call(channel, method, args);
      }
    }
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client: new NewHumanPromptClient() });
    await adapter.init();
    await expect(adapter.getSession("session-1")).resolves.toMatchObject({
      meta: { automationStopHistoryAvailable: true, latestUserPrompt: { id: "human-new", turnId: "turn-new" } },
    });
    const sessionResult = await adapter.getSession("session-1");
    expect(sessionResult?.meta?.automationStop).toBeUndefined();
    await adapter.dispose();
  });

  it("keeps a stop held for an untagged generated prompt with matching text, then clears it for a later human turn", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "agent-herder-zcode-prompt-provenance-"));
    const previousStopStore = process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(storeDir, "human-stops.json");
    const generatedText = "continue the queued automation exactly";
    const stopAt = 1_700_000_020_000;
    const generatedPrompt = {
      info: {
        messageId: "untagged-generated-prompt", sessionId: "session-1", role: "user",
        time: { created: stopAt + 10_000 }, semantics: { origin: "real_user", kind: "user_prompt" },
        metadata: { inputId: "native-input-without-herder-prefix" },
      },
      parts: [{ type: "text", text: generatedText }],
    };
    const humanPrompt = {
      info: {
        messageId: "later-human-prompt", sessionId: "session-1", role: "user",
        time: { created: stopAt + 20_000 }, semantics: { origin: "real_user", kind: "user_prompt" },
        metadata: { inputId: "native-human-input" },
      },
      parts: [{ type: "text", text: "I am explicitly asking to continue now" }],
    };
    class PromptProvenanceClient extends FakeClient {
      currentMessage: typeof generatedPrompt | typeof humanPrompt = generatedPrompt;
      latestTurnId = "turn-untagged-generated";
      latestMessageId = generatedPrompt.info.messageId;
      latestSeq = 3;
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "readSession") {
          this.calls.push({ channel, method, args });
          return { ...snapshot, runtime: { ...snapshot.runtime, eventSeq: this.latestSeq }, messages: [this.currentMessage] };
        }
        if (channel === "zcode-agent" && method === "readSessionEvents") {
          this.calls.push({ channel, method, args });
          return { events: [
            { type: "turn.completed", eventId: "manual-stop-event", sessionId: "session-1", turnId: "turn-stopped", seq: 2, timestamp: stopAt, payload: { response: "", resultType: "cancelled" } },
            { type: "turn.started", eventId: "prompt-start", sessionId: "session-1", turnId: this.latestTurnId, seq: this.latestSeq, timestamp: stopAt + 10_000, payload: { messageId: this.latestMessageId, inputId: "native-input-without-herder-prefix" } },
          ] };
        }
        return super.call(channel, method, args);
      }
    }
    const client = new PromptProvenanceClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    const store = getHumanStopStore();
    try {
      await store.hold({ harness: "zcode", id: "session-1" }, {
        id: "manual-stop-before-generated-input", at: new Date(stopAt).toISOString(), reason: "operator stopped the run",
      });
      await store.rememberGeneratedPrompt("zcode", "session-1", generatedText);
      await adapter.init();

      const generatedSession = await adapter.getSession("session-1");
      expect(generatedSession?.meta?.latestUserPrompt).toMatchObject({ id: generatedPrompt.info.messageId, text: generatedText });
      await expect(store.observe(generatedSession!)).resolves.toBe(true);
      await expect(store.isHeld("zcode", "session-1")).resolves.toBe(true);

      client.currentMessage = humanPrompt;
      client.latestTurnId = "turn-later-human";
      client.latestMessageId = humanPrompt.info.messageId;
      client.latestSeq = 4;
      const laterHumanSession = await adapter.getSession("session-1");
      expect(laterHumanSession?.meta?.latestUserPrompt).toMatchObject({ id: humanPrompt.info.messageId, text: humanPrompt.parts[0]!.text });
      await expect(store.observe(laterHumanSession!)).resolves.toBe(false);
      await expect(store.isHeld("zcode", "session-1")).resolves.toBe(false);
    } finally {
      await adapter.dispose();
      if (previousStopStore === undefined) delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;
      else process.env.AGENT_HERDER_HUMAN_STOP_STORE = previousStopStore;
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  it("tags only generated native input IDs and keeps explicit human IDs unchanged", async () => {
    const client = new FakeClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    await adapter.init();
    await adapter.sendMessage("session-1", { message: "generated prompt", inputId: "generated-id" });
    await adapter.sendMessage("session-1", { message: "human prompt", inputId: "human-id", origin: "human" });
    expect(client.calls.filter((call) => call.method === "sendPrompt").map((call) => (call.args[0] as { inputId: string }).inputId))
      .toEqual(["agent-herder:auto:generated-id", "human-id"]);
    await adapter.dispose();
  });

  it("discards queued generated prompts when a native stop arrives", async () => {
    vi.useFakeTimers();
    const storeDir = await mkdtemp(join(tmpdir(), "agent-herder-zcode-queued-stop-"));
    const previousStopStore = process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(storeDir, "human-stops.json");
    class BusyQueuedClient extends FakeClient {
      sendPromptCalls = 0;
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "sendPrompt") {
          expect(await getHumanStopStore().isGeneratedPrompt("zcode", "session-1", { text: "queued automation" })).toBe(true);
          this.calls.push({ channel, method, args });
          this.sendPromptCalls += 1;
          throw new Error("prompt is already running");
        }
        return super.call(channel, method, args);
      }
    }
    const client = new BusyQueuedClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    const unsubscribe = adapter.subscribeEvents(() => undefined);
    try {
      await adapter.init();
      await adapter.getSession("session-1");
      await expect(adapter.sendMessage("session-1", { message: "queued automation", queue: true })).resolves.toEqual({ ok: true });
      await getHumanStopStore().hold({ harness: "zcode", id: "session-1" }, {
        id: "manual-stop-after-queue", at: new Date().toISOString(), reason: "operator stopped before queued send",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect((adapter as unknown as { queuedPrompts: Map<string, unknown[]> }).queuedPrompts.has("session-1")).toBe(false));
      expect(client.sendPromptCalls).toBe(1);
      expect(await getHumanStopStore().isHeld("zcode", "session-1")).toBe(true);
      // The initial attempted send was registered before RPC, even though it
      // collided with a busy turn. A late callback must not clear this stop.
      expect(await getHumanStopStore().release("zcode", "session-1", {
        id: "late-busy-send-hook", at: new Date(Date.now() + 1_000).toISOString(), text: "queued automation",
      })).toBe(false);
    } finally {
      unsubscribe();
      await adapter.dispose();
      vi.useRealTimers();
      await rm(storeDir, { recursive: true, force: true });
      if (previousStopStore === undefined) delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;
      else process.env.AGENT_HERDER_HUMAN_STOP_STORE = previousStopStore;
    }
  });

  it("does not mislabel a native cancellation matched to a Herder stop as a human stop", async () => {
    class ActiveTurnClient extends FakeClient {
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "readSession") {
          this.calls.push({ channel, method, args });
          return { ...snapshot, runtime: { ...snapshot.runtime, activeTurnId: "turn-active" } };
        }
        return super.call(channel, method, args);
      }
    }
    const originalStorePath = process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    const isolatedState = await mkdtemp(join(tmpdir(), "agent-herder-zcode-cancel-store-"));
    process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(isolatedState, "human-stops.json");
    const client = new ActiveTurnClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    const events: Array<{ data?: Record<string, unknown> }> = [];
    let resolveCancellation!: () => void;
    const cancellationObserved = new Promise<void>((resolve) => { resolveCancellation = resolve; });
    const unsubscribe = adapter.subscribeEvents((event) => {
      events.push(event);
      if (event.data?.herderCancellation === true) resolveCancellation();
    });
    try {
      await adapter.init();
      await adapter.getSession("session-1");
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(adapter.cancelTurn("session-1")).resolves.toEqual({ ok: true });
      client.listeners[0]!.handler({ type: "session.event", event: {
        type: "turn.completed", eventId: "internal-stop", sessionId: "session-1", turnId: "turn-active", seq: 3,
        timestamp: 1_700_000_060_000, payload: { response: "", tokenCount: 0, toolCallCount: 0, duration: 0, resultType: "cancelled" },
      } });
      await cancellationObserved;
      expect(events.at(-1)?.data).toMatchObject({ herderCancellation: true, nativeEventSeq: 3 });
      expect(events.at(-1)?.data?.automationStop).toBeUndefined();
    } finally {
      unsubscribe();
      await adapter.dispose();
      if (originalStorePath === undefined) delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;
      else process.env.AGENT_HERDER_HUMAN_STOP_STORE = originalStorePath;
      await rm(isolatedState, { recursive: true, force: true });
    }
  });

  it("scopes transport death to an observed active native turn and excludes completed turns", async () => {
    class DisconnectClient extends FakeClient {
      disconnected?: (error: Error) => void;
      onDisconnect(handler: (error: Error) => void) { this.disconnected = handler; return () => { this.disconnected = undefined; }; }
    }
    const client = new DisconnectClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    const events: Array<{ kind: string; sessionId?: string; data?: Record<string, unknown> }> = [];
    const stop = adapter.subscribeEvents((event) => events.push(event));
    try {
      await adapter.init();
      await adapter.getSession("session-1");
      await new Promise<void>((resolve) => setImmediate(resolve));
      const emit = async (type: string, turnId: string) => {
        client.listeners[0]!.handler({ type: "session.event", event: { type, sessionId: "session-1", turnId, eventId: `${type}-${turnId}`, timestamp: Date.now(), seq: 5, payload: { inputId: "input-1" } } });
        await new Promise<void>((resolve) => setImmediate(resolve));
      };
      await emit("turn.started", "native-1");
      await emit("turn.completed", "stale-different-turn"); // Reused inputId must not erase the newer live turn.
      client.disconnected?.(new Error("transport died"));
      expect(events).toContainEqual(expect.objectContaining({ kind: "process.disconnected", sessionId: "session-1", data: expect.objectContaining({ turnId: "native-1", inputId: "input-1" }) }));
      events.length = 0;
      await adapter.init();
      await adapter.getSession("session-1");
      await new Promise<void>((resolve) => setImmediate(resolve));
      await emit("turn.started", "native-2");
      await emit("turn.completed", "native-2");
      client.disconnected?.(new Error("transport died after completion"));
      expect(events.filter((event) => event.kind === "process.disconnected" && event.sessionId)).toEqual([]);
    } finally { stop(); await adapter.dispose(); }
  });

  it("ignores native callbacks invoked after the event subscription is disposed", async () => {
    const client = new FakeClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    const events: string[] = [];
    const unsubscribeEvents = adapter.subscribeEvents((event) => {
      if (event.nativeType) events.push(event.nativeType);
    });
    await adapter.init();
    await adapter.getSession("session-1");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const lateCallback = client.listeners[0]!.handler;
    try {
      await adapter.dispose();
      lateCallback({ type: "session.event", event: {
        type: "turn.completed", eventId: "late-callback", sessionId: "session-1", turnId: "turn-late", seq: 4,
        timestamp: Date.now(), payload: { response: "", tokenCount: 0, toolCallCount: 0, duration: 0, resultType: "completed" },
      } });
      await Promise.resolve();
      expect(events).not.toContain("turn.completed");
    } finally {
      unsubscribeEvents();
      await adapter.dispose();
    }
  });

  it("does not start the app-server during passive model discovery", async () => {
    const client = new FakeClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client, modelIds: ["zai/GLM-4.5"] });

    expect(await adapter.listModels?.()).toEqual(["zai/GLM-4.5"]);
    expect(client.started).toBe(false);
    expect(client.calls).toEqual([]);
  });

  it("keeps health sessions on bounded built-in tools", async () => {
    const client = new FakeClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    await adapter.init();

    await adapter.createSession({ name: "health_remediation_canary", cwd: "/workspace", model: "zai/GLM-4.5$high" });

    const create = client.calls.find((call) => call.method === "createSession");
    expect(create?.args[0]).toMatchObject({
      toolAllowlist: ["Bash", "Read", "Edit", "Write", "Glob", "Grep"],
      model: { providerId: "zai", modelId: "GLM-4.5", options: { reasoningLevel: "high" } },
      thoughtLevel: "high",
    });
  });

  it("passes the explicit autonomous mode only for automation-owned sessions", async () => {
    const client = new FakeClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    await adapter.init();

    await adapter.createSession({ name: "autocontinue", cwd: "/workspace", mode: "yolo" });

    const create = client.calls.find((call) => call.method === "createSession");
    expect(create?.args[0]).toMatchObject({ mode: "yolo" });
  });

  it("maps explicit full access to ZCode yolo mode", async () => {
    const client = new FakeClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    await adapter.init();

    await adapter.createSession({ name: "unattended", cwd: "/workspace", fullAccess: true });

    const create = client.calls.find((call) => call.method === "createSession");
    expect(create?.args[0]).toMatchObject({ mode: "yolo" });
  });

  it("confirms the native permission mode for full-access creation", async () => {
    const client = new FakeClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    await adapter.init();

    const created = await adapter.createSession({ name: "unattended-confirmed", cwd: "/workspace", fullAccess: true });

    const createIndex = client.calls.findIndex((call) => call.method === "createSession");
    const setModeIndex = client.calls.findIndex((call) => call.method === "setMode");
    expect(createIndex).toBeGreaterThan(-1);
    expect(setModeIndex).toBeGreaterThan(createIndex);
    expect(client.calls[setModeIndex]?.args[0]).toMatchObject({ sessionId: "created-1", mode: "yolo" });
    expect(created.meta).toMatchObject({ permissionMode: "yolo", permissionRulesRevision: 1 });

    await adapter.dispose();
  });

  it("uses a native yolo permission mode already returned by createSession", async () => {
    class AlreadyYoloClient extends FakeClient {
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "createSession") {
          this.calls.push({ channel, method, args });
          return {
            ...snapshot,
            session: { ...session, sessionId: "created-1", parentSessionId: undefined, sessionKind: "interactive" },
            settings: { ...snapshot.settings, permission: { mode: "yolo", rulesRevision: 2 } },
          };
        }
        return super.call(channel, method, args);
      }
    }

    const client = new AlreadyYoloClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    await adapter.init();
    const created = await adapter.createSession({ name: "unattended-native-yolo", cwd: "/workspace", fullAccess: true });
    expect(client.calls.some((call) => call.method === "setMode")).toBe(false);
    expect(created.meta).toMatchObject({ permissionMode: "yolo", permissionRulesRevision: 2 });
    await adapter.dispose();
  });

  it("fails closed if ZCode does not confirm full-access permission mode", async () => {
    class RefusedModeClient extends FakeClient {
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "setMode") {
          this.calls.push({ channel, method, args });
          return { ...snapshot, session: { ...session, sessionId: "created-1" }, settings: { ...snapshot.settings, permission: { mode: "build" } } };
        }
        return super.call(channel, method, args);
      }
    }

    const adapter = new ZcodeAdapter({ cwd: "/workspace", client: new RefusedModeClient() });
    await adapter.init();
    await expect(adapter.createSession({ name: "unattended-unconfirmed", cwd: "/workspace", fullAccess: true }))
      .rejects.toThrow("ZCode did not confirm full-access permission mode");
    await adapter.dispose();
  });

  it("persists the requested session name after ZCode derives a prompt title", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-zcode-title-"));
    const dbPath = join(root, "tasks-index.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`create table tasks (task_id text primary key, title text)`);
    db.close();
    try {
      const adapter = new ZcodeAdapter({ cwd: "/workspace", client: new FakeClient(), tasksIndexDbPath: dbPath });
      await adapter.init();
      const created = await adapter.createSession({ name: "Автопродолжение — Аудит t-proxy", cwd: "/workspace" });
      const writer = new DatabaseSync(dbPath);
      writer.prepare("insert into tasks (task_id, title) values (?, ?)").run(created.id, "Автопродолжение — Аудит t-proxy Это единое продолжение");
      writer.close();

      expect(await adapter.sendMessage(created.id, { message: "Автопродолжение — Аудит t-proxy\n\nПродолжи задачу" })).toEqual({ ok: true });
      const reader = new DatabaseSync(dbPath, { readOnly: true });
      const row = reader.prepare("select title from tasks where task_id = ?").get(created.id) as { title: string };
      reader.close();
      expect(row.title).toBe("Автопродолжение — Аудит t-proxy");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("finds a newly created named session before the task index catches up", async () => {
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client: new FakeClient() });
    await adapter.init();
    const created = await adapter.createSession({ name: "same-id-canary", cwd: "/workspace" });

    await expect(adapter.findNamedSessions?.("same-id-canary", "/workspace")).resolves.toMatchObject([{
      id: created.id,
      title: "same-id-canary",
      cwd: "/workspace",
    }]);
    await adapter.dispose();
  });

  it("retries the requested title when ZCode indexes the task after prompt admission", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), "agent-herder-zcode-late-title-"));
    const dbPath = join(root, "tasks-index.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`create table tasks (task_id text primary key, title text)`);
    db.close();
    try {
      const adapter = new ZcodeAdapter({ cwd: "/workspace", client: new FakeClient(), tasksIndexDbPath: dbPath });
      await adapter.init();
      const created = await adapter.createSession({ name: "Автопродолжение — Поздний индекс", cwd: "/workspace" });
      expect(await adapter.sendMessage(created.id, { message: "Продолжи" })).toEqual({ ok: true });
      const writer = new DatabaseSync(dbPath);
      writer.prepare("insert into tasks (task_id, title) values (?, ?)").run(created.id, "Продолжи технический хвост");
      writer.close();

      await vi.advanceTimersByTimeAsync(300);
      const firstReader = new DatabaseSync(dbPath, { readOnly: true });
      expect((firstReader.prepare("select title from tasks where task_id = ?").get(created.id) as { title: string }).title).toBe("Автопродолжение — Поздний индекс");
      firstReader.close();

      const lateWriter = new DatabaseSync(dbPath);
      lateWriter.prepare("update tasks set title = ? where task_id = ?").run("Продолжи технический хвост снова", created.id);
      lateWriter.close();
      await vi.advanceTimersByTimeAsync(15_000);
      const finalReader = new DatabaseSync(dbPath, { readOnly: true });
      expect((finalReader.prepare("select title from tasks where task_id = ?").get(created.id) as { title: string }).title).toBe("Автопродолжение — Поздний индекс");
      finalReader.close();
      await adapter.dispose();
    } finally {
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("initializes, maps sessions/messages, and controls the native protocol", async () => {
    const client = new FakeClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client, modelIds: ["zai/GLM-4.5"] });

    await adapter.init();
    expect(client.started).toBe(true);

    const sessions = await adapter.listSessions();
    expect(sessions).toMatchObject([{
      id: "session-1",
      harness: "zcode",
      status: "running",
      title: "Repair task",
      cwd: "/workspace",
      model: "zai/GLM-4.5",
      lastMessage: "I will inspect the repository.",
    }]);

    const messages = await adapter.getSessionMessages?.("session-1", 20);
    expect(messages).toMatchObject([
      { id: "message-1", role: "user", text: "Please repair it" },
      { id: "message-2", role: "assistant", text: "I will inspect the repository." },
    ]);

    expect(await adapter.sendMessage("session-1", { message: "continue", queue: true })).toEqual({ ok: true });
    expect(await adapter.cancelTurn?.("session-1")).toEqual({ ok: true });
    expect(await adapter.resumeSession?.("session-1")).toEqual({ ok: true });
    expect(await adapter.terminate?.("session-1")).toEqual({ ok: true });
    expect(await adapter.changeModel?.("session-1", "zai/GLM-4.5")).toEqual({ ok: true });
    expect(await adapter.changeModel?.("session-1", "zai/GLM-4.5$high")).toEqual({ ok: true });
    expect(await adapter.listModels?.()).toEqual(["zai/GLM-4.5"]);

    const raw = await adapter.getRawTranscript?.("session-1");
    expect(raw).toMatchObject({ complete: true, source: { kind: "native-api", format: "json" } });
    expect(Buffer.from(raw!.bytes).toString("utf8")).toContain("Please repair it");

    expect(client.calls.map((call) => `${call.channel}.${call.method}`)).toEqual(expect.arrayContaining([
      "zcode-agent.initialize",
      "zcode-agent.listSessions",
      "zcode-agent.readSessionMessages",
      "zcode-agent.sendPrompt",
      "zcode-task.stopGeneration",
      "zcode-agent.resumeSession",
      "zcode-agent.closeSession",
      "zcode-agent.setModel",
      "zcode-agent.readWorkspaceState",
    ]));
    expect(client.calls.filter((call) => call.method === "setModel").at(-1)?.args[0]).toMatchObject({
      model: { providerId: "zai", modelId: "GLM-4.5", options: { reasoningLevel: "high" } },
    });

    await adapter.dispose();
    expect(client.closed).toBe(true);
  });

  it("keeps unsupported operations explicit and uses native permission response", async () => {
    const client = new FakeClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    await adapter.init();
    expect(await adapter.setPermissions("session-1", { mode: "fullAuto" })).toEqual({ ok: false, error: expect.stringContaining("not supported") });
    expect(await adapter.respondPermission("session-1", "request-1", "allow")).toEqual({ ok: true });
    expect(await adapter.respondPermission("session-1", "request-2", "allow", true)).toEqual({ ok: true });
    expect(client.calls.filter((call) => call.method === "respondPermission").at(-1)?.args[0]).toMatchObject({ optionId: "allowAlways" });
    expect(await adapter.forkSession?.("session-1")).toEqual({ ok: false, error: expect.stringContaining("not supported") });
    await adapter.dispose();
  });

  it("reads the original user request independently of a 200-message native tail", async () => {
    const client = new LongTranscriptClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    await adapter.init();
    try {
      const tail = await adapter.getSessionMessages?.("session-1", 200);
      expect(tail).toHaveLength(200);
      expect(tail?.some((item) => item.id === "original-user")).toBe(false);
      await expect(adapter.getFirstUserMessage?.("session-1")).resolves.toMatchObject({
        id: "original-user",
        role: "user",
        text: "original zcode goal",
      });
    } finally {
      await adapter.dispose();
    }
  });

  it("recycles a wedged app-server when stopGeneration times out", async () => {
    class WedgedClient extends FakeClient {
      startCalls = 0;
      override async start(): Promise<void> { this.startCalls += 1; await super.start(); }
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-task" && method === "stopGeneration") {
          throw new Error("ZCode RPC request timed out: zcode-task.stopGeneration");
        }
        return super.call(channel, method, args);
      }
    }
    const client = new WedgedClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    await adapter.init();

    expect(await adapter.stopSession("session-1")).toEqual({
      ok: false,
      error: "ZCode RPC request timed out: zcode-task.stopGeneration",
    });
    expect(client.closed).toBe(true);
    expect(client.startCalls).toBeGreaterThanOrEqual(2);
  });

  it("auto-resumes an idle TUI session when the direct prompt is rejected as not active", async () => {
    class NotActiveThenResumedClient extends FakeClient {
      sendPromptCalls = 0;
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "sendPrompt") {
          this.calls.push({ channel, method, args });
          this.sendPromptCalls += 1;
          if (this.sendPromptCalls === 1) throw new Error("Session is not active: session-1");
          return { accepted: true };
        }
        return super.call(channel, method, args);
      }
    }

    const client = new NotActiveThenResumedClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    await adapter.init();

    const result = await adapter.sendMessage("session-1", { message: "ping", queue: true });
    expect(result).toEqual({ ok: true });
    expect(client.sendPromptCalls).toBe(2);
    const methods = client.calls.map((call) => call.method);
    const firstSend = methods.indexOf("sendPrompt");
    expect(methods[firstSend + 1]).toBe("resumeSession");
    expect(methods[firstSend + 2]).toBe("readSession");
    expect(methods[firstSend + 3]).toBe("sendPrompt");
    expect(methods[firstSend + 4]).toBe("readSessionEvents");

    await adapter.dispose();
  });

  it("does not treat a native resume snapshot as proof that an accepted prompt started", async () => {
    class AcceptedWithoutTurnClient extends FakeClient {
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "readSessionEvents") {
          this.calls.push({ channel, method, args });
          return [];
        }
        return super.call(channel, method, args);
      }
    }

    const client = new AcceptedWithoutTurnClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client, turnStartTimeoutMs: 5 });
    await adapter.init();

    await expect(adapter.sendMessage("session-1", { message: "continue", queue: true })).resolves.toEqual({
      ok: true,
      admitted: true,
      pending: true,
    });
    expect(client.calls.filter((call) => call.method === "sendPrompt")).toHaveLength(1);
    expect(client.calls.filter((call) => call.method === "resumeSession")).toHaveLength(0);

    await adapter.dispose();
  });

  it("does not send another prompt while a fresh native snapshot has pending permission", async () => {
    class PendingPermissionClient extends FakeClient {
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "readSession") {
          this.calls.push({ channel, method, args });
          return { ...snapshot, runtime: { ...snapshot.runtime, pendingRequestIds: ["permission-current"] } };
        }
        return super.call(channel, method, args);
      }
    }

    const client = new PendingPermissionClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    await adapter.init();

    await expect(adapter.sendMessage("session-1", { message: "continue", queue: true })).resolves.toEqual({
      ok: false,
      error: "ZCode ожидает вашего разрешения. Ответьте на запрос в этой сессии, затем продолжите работу.",
    });
    expect(client.calls.filter((call) => call.method === "readSession")).toHaveLength(1);
    expect(client.calls.filter((call) => call.method === "sendPrompt")).toHaveLength(0);
    expect(client.calls.filter((call) => call.method === "respondPermission")).toHaveLength(0);

    await adapter.dispose();
  });

  it("proves prompt processing from its assistant parent when event history rejects a newer field", async () => {
    const inputId = "input-snapshot-fallback";
    class NewEventFieldClient extends FakeClient {
      sendPromptAccepted = false;

      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "readSessionEvents") {
          this.calls.push({ channel, method, args });
          throw new Error('Unrecognized key: "executionStartedAt"');
        }
        if (channel === "zcode-agent" && method === "readSession") {
          this.calls.push({ channel, method, args });
          if (!this.sendPromptAccepted) return { ...snapshot, session: { ...session, status: "idle" } };
          return {
            ...snapshot,
            session: { ...session, status: "running" },
            runtime: { ...snapshot.runtime, eventSeq: 4, stateRevision: 4, activeTurnId: "turn-current" },
            projection: { currentTurnId: "turn-current" },
            messages: [
              ...snapshot.messages,
              {
                info: {
                  messageId: "user-current",
                  sessionId: "session-1",
                  role: "user",
                  metadata: { inputId: (this.calls.find((call) => call.method === "sendPrompt")?.args[0] as { inputId: string }).inputId },
                },
                parts: [{ type: "text", text: "snapshot fallback prompt" }],
              },
              {
                info: { messageId: "assistant-current", sessionId: "session-1", role: "assistant", parentMessageId: "user-current" },
                parts: [{ type: "text", text: "processed snapshot fallback prompt" }],
              },
            ],
          };
        }
        if (channel === "zcode-agent" && method === "sendPrompt") {
          this.calls.push({ channel, method, args });
          this.sendPromptAccepted = true;
          return { accepted: true, sessionId: "session-1", stateRevision: 4 };
        }
        return super.call(channel, method, args);
      }
    }

    const client = new NewEventFieldClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client, turnStartTimeoutMs: 100 });
    await adapter.init();

    await expect(adapter.sendMessage("session-1", {
      message: "snapshot fallback prompt",
      inputId,
    })).resolves.toEqual({ ok: true });
    expect(client.calls.find((call) => call.method === "readSessionEvents")?.args[0]).toMatchObject({ afterSeq: 2 });
    expect(client.calls.filter((call) => call.method === "sendPrompt")).toHaveLength(1);

    await adapter.dispose();
  });

  it("does not treat an unrelated turn after an idle baseline as the queued prompt starting", async () => {
    const inputId = "input-queued-behind-existing-turn";
    class TurnSwitchWhileQueuedClient extends FakeClient {
      accepted = false;

      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "readSessionEvents") {
          this.calls.push({ channel, method, args });
          throw new Error('Unrecognized key: "executionStartedAt"');
        }
        if (channel === "zcode-agent" && method === "readSession") {
          this.calls.push({ channel, method, args });
          const activeTurnId = this.accepted ? "turn-b" : undefined;
          return {
            ...snapshot,
            session: { ...session, status: this.accepted ? "running" : "idle" },
            runtime: { ...snapshot.runtime, eventSeq: this.accepted ? 4 : 2, stateRevision: this.accepted ? 4 : 2, ...(activeTurnId ? { activeTurnId } : {}) },
            projection: { currentTurnId: this.accepted ? "turn-b" : "turn-old" },
            ...(this.accepted ? {
              messages: [
                ...snapshot.messages,
                {
                  info: { messageId: "user-queued", sessionId: "session-1", role: "user", metadata: { inputId } },
                  parts: [{ type: "text", text: "queued behind existing turn" }],
                },
              ],
            } : {}),
          };
        }
        if (channel === "zcode-agent" && method === "sendPrompt") {
          this.calls.push({ channel, method, args });
          this.accepted = true;
          return { accepted: true, sessionId: "session-1", stateRevision: 4 };
        }
        return super.call(channel, method, args);
      }
    }

    const client = new TurnSwitchWhileQueuedClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client, turnStartTimeoutMs: 5 });
    await adapter.init();

    await expect(adapter.sendMessage("session-1", {
      message: "queued behind existing turn",
      inputId,
    })).resolves.toEqual({ ok: true, admitted: true, pending: true });

    await adapter.dispose();
  });

  it("does not mistake an existing active turn for a queued prompt starting", async () => {
    const inputId = "input-still-queued";
    class ExistingTurnClient extends FakeClient {
      accepted = false;

      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "readSessionEvents") {
          this.calls.push({ channel, method, args });
          throw new Error('Unrecognized key: "executionStartedAt"');
        }
        if (channel === "zcode-agent" && method === "readSession") {
          this.calls.push({ channel, method, args });
          return {
            ...snapshot,
            runtime: { ...snapshot.runtime, eventSeq: 4, stateRevision: this.accepted ? 4 : 2, activeTurnId: "turn-existing" },
            projection: { currentTurnId: "turn-existing" },
            ...(this.accepted ? {
              messages: [
                ...snapshot.messages,
                {
                  info: { messageId: "user-queued", sessionId: "session-1", role: "user", metadata: { inputId } },
                  parts: [{ type: "text", text: "queued while another turn runs" }],
                },
              ],
            } : {}),
          };
        }
        if (channel === "zcode-agent" && method === "sendPrompt") {
          this.calls.push({ channel, method, args });
          this.accepted = true;
          return { accepted: true, sessionId: "session-1", stateRevision: 4 };
        }
        return super.call(channel, method, args);
      }
    }

    const client = new ExistingTurnClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client, turnStartTimeoutMs: 5 });
    await adapter.init();

    await expect(adapter.sendMessage("session-1", {
      message: "queued while another turn runs",
      inputId,
    })).resolves.toEqual({ ok: true, admitted: true, pending: true });

    await adapter.dispose();
  });

  it("keeps a pending native permission visible as needs_input even when lifecycle ended", async () => {
    class PendingPermissionClient extends FakeClient {
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "readSession") {
          this.calls.push({ channel, method, args });
          return {
            ...snapshot,
            session: { ...session, status: "stopped" },
            runtime: { ...snapshot.runtime, pendingRequestIds: ["permission-current"] },
          };
        }
        return super.call(channel, method, args);
      }
    }

    const adapter = new ZcodeAdapter({ cwd: "/workspace", client: new PendingPermissionClient() });
    await adapter.init();

    await expect(adapter.getSession("session-1")).resolves.toMatchObject({
      status: "needs_input",
      needsPermission: true,
      meta: { pendingRequestIds: ["permission-current"] },
    });

    await adapter.dispose();
  });

  it("reuses a caller operation id and reconciles its native turn event", async () => {
    const client = new FakeClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    await adapter.init();

    await expect(adapter.sendMessage("session-1", {
      message: "stable handoff",
      inputId: "handoff-operation-1",
    })).resolves.toEqual({ ok: true });
    expect(client.calls.find((call) => call.method === "sendPrompt")?.args[0]).toMatchObject({
      sessionId: "session-1",
      inputId: "agent-herder:auto:handoff-operation-1",
    });
    await expect(adapter.getMessageAdmission("session-1", "handoff-operation-1"))
      .resolves.toEqual({ state: "admitted" });

    await adapter.dispose();
  });

  it("gives a later native turn failure precedence over the matching start event", async () => {
    class StartedThenFailedClient extends FakeClient {
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "readSessionEvents") {
          this.calls.push({ channel, method, args });
          return [
            { type: "turn.started", payload: { inputId: "handoff-operation-failed" } },
            {
              type: "turn.failed",
              payload: {
                inputId: "handoff-operation-failed",
                error: { code: 1113, message: "Provider rejected the request" },
              },
            },
          ];
        }
        return super.call(channel, method, args);
      }
    }
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client: new StartedThenFailedClient() });
    await adapter.init();

    await expect(adapter.getMessageAdmission("session-1", "handoff-operation-failed"))
      .resolves.toEqual({
        state: "failed",
        error: "ZCode принял запрос для session-1, но выполнение завершилось ошибкой. Native failure: [1113] Provider rejected the request",
      });

    await adapter.dispose();
  });

  it("accepts replayed turn-start proof when the event history RPC is unavailable", async () => {
    class ReplayOnlyClient extends FakeClient {
      override listen(channel: string, event: string, arg: unknown, handler: (payload: unknown) => void): () => void {
        const unsubscribe = super.listen(channel, event, arg, handler);
        queueMicrotask(() => {
          const accepted = [...this.calls].reverse().find((call) => call.method === "sendPrompt");
          const inputId = (accepted?.args[0] as { inputId?: string } | undefined)?.inputId;
          handler({ type: "task_run_started", inputId });
        });
        return unsubscribe;
      }

      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "readSessionEvents") {
          this.calls.push({ channel, method, args });
          throw new Error("event history temporarily unavailable");
        }
        return super.call(channel, method, args);
      }
    }

    const client = new ReplayOnlyClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client, turnStartTimeoutMs: 100 });
    await adapter.init();

    const result = await adapter.sendMessage("session-1", { message: "continue", queue: true });
    expect(client.listeners).toHaveLength(1);
    expect(result).toEqual({ ok: true });
    expect(client.calls.filter((call) => call.method === "resumeSession")).toHaveLength(0);

    await adapter.dispose();
  });

  it("surfaces a redacted native failure from replay when event history rejects a newer field", async () => {
    const secret = "top-secret-bearer-value";
    const jsonApiSecret = "json-api-secret";
    const jsonPasswordSecret = "json-password-secret";
    class ReplayFailureClient extends FakeClient {
      override listen(channel: string, event: string, arg: unknown, handler: (payload: unknown) => void): () => void {
        const unsubscribe = super.listen(channel, event, arg, handler);
        queueMicrotask(() => {
          const accepted = [...this.calls].reverse().find((call) => call.method === "sendPrompt");
          const inputId = (accepted?.args[0] as { inputId?: string } | undefined)?.inputId;
          handler({
            type: "session.event",
            event: {
              type: "turn.failed",
              eventId: "failure-after-schema-reject",
              sessionId: "session-1",
              turnId: "turn-failed",
              seq: 3,
              timestamp: Date.now(),
              payload: {
                inputId,
                executionStartedAt: Date.now(),
                error: {
                  type: "provider_error",
                  message: `Provider rejected Authorization: Bearer ${secret} {"api_key":"${jsonApiSecret}","password":"${jsonPasswordSecret}"} ${"x".repeat(500)}`,
                },
              },
            },
          });
        });
        return unsubscribe;
      }

      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "readSessionEvents") {
          this.calls.push({ channel, method, args });
          throw new Error('Unrecognized key: "executionStartedAt"');
        }
        return super.call(channel, method, args);
      }
    }

    const client = new ReplayFailureClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client, turnStartTimeoutMs: 100 });
    await adapter.init();

    const result = await adapter.sendMessage("session-1", { message: "continue", queue: true });
    expect(result).toMatchObject({ ok: false, admitted: true, nonRetryable: true });
    expect(result.error).toContain("ZCode принял запрос для session-1, но выполнение завершилось ошибкой.");
    expect(result.error).toContain("Native failure: [provider_error] Provider rejected Authorization: Bearer [redacted]");
    expect(result.error).toContain('{"api_key":"[redacted]","password":"[redacted]"}');
    expect(result.error).not.toContain(secret);
    expect(result.error).not.toContain(jsonApiSecret);
    expect(result.error).not.toContain(jsonPasswordSecret);
    expect(result.error!.length).toBeLessThan(520);
    expect(client.calls.filter((call) => call.method === "sendPrompt")).toHaveLength(1);
    expect(client.calls.filter((call) => call.method === "resumeSession")).toHaveLength(0);

    await adapter.dispose();
  });

  it("returns a terminal inactive result after native resume cannot reattach the task", async () => {
    class PermanentlyInactiveClient extends FakeClient {
      sendPromptCalls = 0;
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "sendPrompt") {
          this.calls.push({ channel, method, args });
          this.sendPromptCalls += 1;
          throw new Error("Session is not active: session-1");
        }
        return super.call(channel, method, args);
      }
    }

    const client = new PermanentlyInactiveClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    await adapter.init();

    await expect(adapter.sendMessage("session-1", { message: "continue", queue: true })).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/terminal inactive/i),
    });
    expect(client.sendPromptCalls).toBe(2);
    expect(client.calls.filter((call) => call.method === "resumeSession")).toHaveLength(1);

    await adapter.dispose();
  });

  it("surfaces a native turn failure after prompt admission", async () => {
    class NativeTurnFailedClient extends FakeClient {
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "readSessionEvents") {
          this.calls.push({ channel, method, args });
          const accepted = [...this.calls].reverse().find((call) => call.method === "sendPrompt");
          const inputId = (accepted?.args[0] as { inputId?: string } | undefined)?.inputId;
          return [{
            type: "turn.failed",
            payload: { inputId, error: { type: "provider_error", message: "Native provider failed" } },
          }];
        }
        return super.call(channel, method, args);
      }
    }
    const client = new NativeTurnFailedClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    await adapter.init();

    await expect(adapter.sendMessage("session-1", { message: "continue", queue: true })).resolves.toEqual({
      ok: false,
      admitted: true,
      nonRetryable: true,
      error: "ZCode принял запрос для session-1, но выполнение завершилось ошибкой. Native failure: [provider_error] Native provider failed",
    });
    expect(client.calls.filter((call) => call.method === "resumeSession")).toHaveLength(0);

    await adapter.dispose();
  });

  it("preserves admitted failure metadata through recover", async () => {
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client: new FakeClient() });
    await adapter.init();
    adapter.resumeSession = async () => ({ ok: true });
    adapter.sendMessage = async () => ({
      ok: false,
      admitted: true,
      nonRetryable: true,
      error: "native recovered turn failed",
    });

    await expect(adapter.recover("session-1", "continue")).resolves.toEqual({
      ok: false,
      admitted: true,
      nonRetryable: true,
      error: "native recovered turn failed",
    });

    await adapter.dispose();
  });

  it("queues a second prompt while the same ZCode session is still finishing", async () => {
    vi.useFakeTimers();
    const storeDir = await mkdtemp(join(tmpdir(), "agent-herder-zcode-turn-binding-"));
    const previousStopStore = process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(storeDir, "human-stops.json");
    class BusyThenAcceptClient extends FakeClient {
      sendCalls = 0;
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "readSession") {
          const result = await super.call(channel, method, args) as Record<string, unknown>;
          const runtime = result.runtime && typeof result.runtime === "object" ? result.runtime as Record<string, unknown> : {};
          return { ...result, runtime: { ...runtime, activeTurnId: "turn-before-queued-prompt" } };
        }
        if (channel === "zcode-agent" && method === "sendPrompt") {
          this.calls.push({ channel, method, args });
          this.sendCalls += 1;
          if (this.sendCalls === 1) throw new Error("A prompt is already running for this session");
          return { accepted: true };
        }
        return super.call(channel, method, args);
      }
    }
    const client = new BusyThenAcceptClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    try {
      await adapter.init();
      await expect(adapter.sendMessage("session-1", { message: "second continuation", queue: true })).resolves.toEqual({ ok: true });
      expect(client.sendCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(client.sendCalls).toBe(2));
      await vi.waitFor(() => expect((adapter as unknown as { queuedPromptFlushes: Set<string> }).queuedPromptFlushes.has("session-1")).toBe(false));
      expect(client.calls.filter((call) => call.method === "resumeSession")).toHaveLength(0);
      expect(client.calls.filter((call) => call.method === "sendPrompt")[1]?.args[0]).toMatchObject({
        sessionId: "session-1",
        content: "second continuation",
      });
      const inputId = (client.calls.filter((call) => call.method === "sendPrompt")[1]?.args[0] as { inputId: string }).inputId;
      await expect(getHumanStopStore().isGeneratedPrompt("zcode", "session-1", { turnId: "turn-before-queued-prompt" })).resolves.toBe(false);
      await expect(getHumanStopStore().isGeneratedPrompt("zcode", "session-1", { turnId: `turn-${inputId}` })).resolves.toBe(true);
    } finally {
      await adapter.dispose();
      vi.useRealTimers();
      await rm(storeDir, { recursive: true, force: true });
      if (previousStopStore === undefined) delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;
      else process.env.AGENT_HERDER_HUMAN_STOP_STORE = previousStopStore;
    }
  });

  it("drops a queued prompt when the task stays inactive after native resume", async () => {
    vi.useFakeTimers();
    class BusyThenInactiveClient extends FakeClient {
      sendCalls = 0;
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "sendPrompt") {
          this.calls.push({ channel, method, args });
          this.sendCalls += 1;
          if (this.sendCalls === 1) throw new Error("A prompt is already running for this session");
          throw new Error("Session is not active: session-1");
        }
        return super.call(channel, method, args);
      }
    }
    const client = new BusyThenInactiveClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    try {
      await adapter.init();
      await expect(adapter.sendMessage("session-1", { message: "queued continuation", queue: true })).resolves.toEqual({ ok: true });
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(client.sendCalls).toBe(3));
      expect(client.calls.filter((call) => call.method === "resumeSession")).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(client.sendCalls).toBe(3);
    } finally {
      await adapter.dispose();
      vi.useRealTimers();
    }
  });

  it("backs off queued sends when fresh stop-fence inspection fails", async () => {
    vi.useFakeTimers();
    class BusyClient extends FakeClient {
      sendCalls = 0;
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "sendPrompt") {
          this.sendCalls += 1;
          throw new Error("A prompt is already running for this session");
        }
        return super.call(channel, method, args);
      }
    }
    const client = new BusyClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    let fenceReads = 0;
    try {
      await adapter.init();
      await expect(adapter.sendMessage("session-1", { message: "queued work", queue: true })).resolves.toEqual({ ok: true });
      adapter.getSession = async () => { fenceReads += 1; throw new Error("stop-fence inspection unavailable"); };
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fenceReads).toBe(1);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fenceReads).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fenceReads).toBe(2);
      expect(client.sendCalls).toBe(1);
    } finally {
      await adapter.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps a queued prompt after a transient native resume failure", async () => {
    vi.useFakeTimers();
    class TransientResumeClient extends FakeClient {
      sendCalls = 0;
      resumeCalls = 0;
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "sendPrompt") {
          this.calls.push({ channel, method, args });
          this.sendCalls += 1;
          if (this.sendCalls === 1) throw new Error("A prompt is already running for this session");
          throw new Error("Session is not active: session-1");
        }
        if (channel === "zcode-agent" && method === "resumeSession") {
          this.calls.push({ channel, method, args });
          this.resumeCalls += 1;
          throw new Error("temporary transport timeout");
        }
        return super.call(channel, method, args);
      }
    }
    const client = new TransientResumeClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    try {
      await adapter.init();
      await expect(adapter.sendMessage("session-1", { message: "queued continuation", queue: true })).resolves.toEqual({ ok: true });
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(client.sendCalls).toBe(2));
      expect(client.resumeCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(client.sendCalls).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(client.sendCalls).toBe(3));
      expect(client.resumeCalls).toBe(2);
    } finally {
      await adapter.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps later queued prompts and wakes after a recovered inactive send", async () => {
    vi.useFakeTimers();
    class RecoveredQueueClient extends FakeClient {
      sendCalls = 0;
      resumeCalls = 0;
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "sendPrompt") {
          this.calls.push({ channel, method, args });
          this.sendCalls += 1;
          if (this.sendCalls <= 2) throw new Error("A prompt is already running for this session");
          if (this.sendCalls === 3) throw new Error("Session is not active: session-1");
          return { accepted: true };
        }
        if (channel === "zcode-agent" && method === "resumeSession") {
          this.calls.push({ channel, method, args });
          this.resumeCalls += 1;
          return snapshot;
        }
        return super.call(channel, method, args);
      }
    }
    const client = new RecoveredQueueClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    try {
      await adapter.init();
      await expect(adapter.sendMessage("session-1", { message: "first", queue: true })).resolves.toEqual({ ok: true });
      await expect(adapter.sendMessage("session-1", { message: "second", queue: true })).resolves.toEqual({ ok: true });

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.runOnlyPendingTimersAsync();
      await vi.waitFor(() => expect(client.sendCalls).toBe(5));

      const acceptedContents = client.calls
        .filter((call) => call.method === "sendPrompt")
        .slice(-2)
        .map((call) => (call.args[0] as { content?: string }).content);
      expect(acceptedContents).toEqual(["first", "second"]);
      expect(client.sendCalls).toBe(5);
      expect(client.resumeCalls).toBe(1);
    } finally {
      await adapter.dispose();
      vi.useRealTimers();
    }
  });

  it("marks an unfinished native tool part as an active tool call", async () => {
    const activeSession = { ...session, sessionId: "active-tool-session" };
    class ActiveToolClient extends FakeClient {
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "listSessions") {
          return [{
            ...snapshot,
            session: activeSession,
            messages: [{
              info: { messageId: "user-message", role: "user", time: { created: Date.now() - 1 } },
              parts: [{ type: "text", text: "Run the tests." }],
            }, {
              info: { messageId: "tool-message", role: "assistant", time: { created: Date.now() } },
              parts: [
                { type: "text", text: "Running the focused test." },
                { type: "tool", tool: "Bash", state: { status: "running", input: { command: "pytest" } } },
              ],
            }],
          }];
        }
        return super.call(channel, method, args);
      }
    }

    const adapter = new ZcodeAdapter({ cwd: "/workspace", client: new ActiveToolClient() });
    markLifecycleEvent("zcode", activeSession.sessionId, "turn-start");
    await adapter.init();
    await expect(adapter.listSessions({ cwd: "/workspace" })).resolves.toMatchObject([{
      id: activeSession.sessionId,
      meta: { hasActiveToolCall: true },
    }]);
    await adapter.dispose();
  });

  it("does not treat an old interrupted tool part as active in a later turn", async () => {
    const laterSession = { ...session, sessionId: "later-turn-session" };
    class OldToolClient extends FakeClient {
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "listSessions") {
          return [{
            ...snapshot,
            session: laterSession,
            messages: [{
              info: { messageId: "old-tool", role: "assistant", time: { created: Date.now() - 3 } },
              parts: [{ type: "tool", tool: "Bash", state: { status: "running" } }],
            }, {
              info: { messageId: "new-user", role: "user", time: { created: Date.now() - 2 } },
              parts: [{ type: "text", text: "A new turn." }],
            }, {
              info: { messageId: "new-assistant", role: "assistant", time: { created: Date.now() - 1 } },
              parts: [{ type: "text", text: "Ready." }],
            }],
          }];
        }
        return super.call(channel, method, args);
      }
    }

    const adapter = new ZcodeAdapter({ cwd: "/workspace", client: new OldToolClient() });
    markLifecycleEvent("zcode", laterSession.sessionId, "turn-start");
    await adapter.init();
    await expect(adapter.listSessions({ cwd: "/workspace" })).resolves.toMatchObject([{
      id: laterSession.sessionId,
      meta: { hasActiveToolCall: false },
    }]);
    await adapter.dispose();
  });

  it("reports recently-updated sessions as running despite stale idle status", async () => {
    // Interactive TUI sessions come back from listSessions with a stale
    // "idle" status while a turn is executing; updatedAt recency is the
    // reliable liveness signal. readSession crashes for these on current
    // zcode-server builds, so only the list row is available.
    class StaleStatusClient extends FakeClient {
      updatedAtMs = Date.now() - 30_000;
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "listSessions") {
          return [{
            ...session,
            status: "idle",
            updatedAt: this.updatedAtMs,
          }];
        }
        if (channel === "zcode-agent" && method === "readSession") {
          throw new Error("Cannot read properties of undefined (reading 'runtimePolicy')");
        }
        return super.call(channel, method, args);
      }
    }

    const client = new StaleStatusClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    const fresh = await adapter.listSessions();
    expect(fresh).toHaveLength(1);
    expect(fresh[0].status).toBe("running");

    client.updatedAtMs = Date.now() - 30 * 60 * 1000;
    const stale = await adapter.listSessions();
    expect(stale[0].status).toBe("idle");
    await adapter.dispose();
  });

  it("prefers hook-fed lifecycle state over stale list status", async () => {
    const client = new StaleStatusClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });

    markLifecycleEvent("zcode", "session-1", "turn-start");
    const running = await adapter.listSessions();
    expect(running[0].status).toBe("running");

    markLifecycleEvent("zcode", "session-1", "end");
    const ended = await adapter.listSessions();
    expect(ended[0].status).toBe("stopped");

    await adapter.dispose();
  });
});
