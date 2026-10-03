import { describe, expect, it } from "vitest";
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

describe("ZCode adapter", () => {
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
    expect(await adapter.forkSession?.("session-1")).toEqual({ ok: false, error: expect.stringContaining("not supported") });
    await adapter.dispose();
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
