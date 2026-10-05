import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ZcodeClientLike } from "../src/adapters/zcode-protocol.js";
import { ZcodeAdapter, resolveConfiguredZcodeModel, zcodeConfiguredModels } from "../src/adapters/zcode.js";
import { markLifecycleEvent } from "../src/session-lifecycle.js";

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
      return inputId ? [{
        type: "turn.started",
        eventId: `turn-started-${inputId}`,
        sessionId: (accepted?.args[0] as { sessionId?: string }).sessionId,
        turnId: `turn-${inputId}`,
        seq: 3,
        timestamp: Date.now(),
        payload: { inputId },
      }] : [];
    }
    if (channel === "zcode-agent" && method === "readWorkspaceState") return { settings: { model: { current: session.model, available: [{ ref: session.model, label: "GLM-4.5" }] } } };
    if (channel === "zcode-agent" && method === "resumeSession") return snapshot;
    if (channel === "zcode-agent" && method === "createSession") return { ...snapshot, session: { ...session, sessionId: "created-1", title: "New task", parentSessionId: undefined, sessionKind: "interactive" } };
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

  it("normalizes native zcode-task event subscriptions", async () => {
    const client = new FakeClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    const events: Array<{ kind: string; sessionId?: string; nativeType?: string }> = [];
    const stop = adapter.subscribeEvents((event) => events.push(event));
    await adapter.init();
    await adapter.listSessions();
    expect(client.listeners).toHaveLength(0);
    await adapter.resumeSession("session-1");
    expect(client.listeners).toHaveLength(1);
    expect(client.listeners[0]).toMatchObject({ channel: "zcode-task", event: "onDynamicTaskEvent" });
    client.listeners[0].handler({ type: "task_complete" });
    client.listeners[0].handler({ type: "message_delta" });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "process.connected" }),
      expect.objectContaining({ kind: "turn.completed", sessionId: "session-1", nativeType: "task_complete" }),
      expect.objectContaining({ kind: "message.updated", sessionId: "session-1", nativeType: "message_delta" }),
    ]));
    stop();
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
    expect(methods[firstSend + 2]).toBe("sendPrompt");
    expect(methods[firstSend + 3]).toBe("readSessionEvents");

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
      inputId: "handoff-operation-1",
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
            { type: "turn.failed", payload: { inputId: "handoff-operation-failed" } },
          ];
        }
        return super.call(channel, method, args);
      }
    }
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client: new StartedThenFailedClient() });
    await adapter.init();

    await expect(adapter.getMessageAdmission("session-1", "handoff-operation-failed"))
      .resolves.toEqual({ state: "failed", error: "ZCode native turn failed after admission" });

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
          return [{ type: "turn.failed", payload: { inputId } }];
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
      error: expect.stringMatching(/native turn failed/i),
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
    class BusyThenAcceptClient extends FakeClient {
      sendCalls = 0;
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
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
      expect(client.sendCalls).toBe(2);
      expect(client.calls.filter((call) => call.method === "resumeSession")).toHaveLength(0);
      expect(client.calls.filter((call) => call.method === "sendPrompt")[1]?.args[0]).toMatchObject({
        sessionId: "session-1",
        content: "second continuation",
      });
    } finally {
      await adapter.dispose();
      vi.useRealTimers();
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
      expect(client.sendCalls).toBe(3);
      expect(client.calls.filter((call) => call.method === "resumeSession")).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(client.sendCalls).toBe(3);
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
      expect(client.sendCalls).toBe(2);
      expect(client.resumeCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(client.sendCalls).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(client.sendCalls).toBe(3);
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
