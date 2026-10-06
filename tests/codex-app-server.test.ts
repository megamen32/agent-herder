import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { WebSocketServer } from "ws";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { getHumanStopStore } from "../src/human-stop-store.js";
import { createNamedSession } from "../src/named-session.js";

const fixture = join(process.cwd(), "tests/fixtures/fake-codex-app-server.mjs");

describe("Codex app-server adapter", () => {
  it("bounds a Unix socket that accepts but never upgrades the WebSocket", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-unix-timeout-"));
    const socketPath = join(tempDir, "app-server.sock");
    const server = createNetServer((socket) => socket.on("data", () => {}));
    const sockets = new Set<import("node:net").Socket>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    const listening = new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const adapter = new CodexAppServerAdapter({
      codexBin: "/definitely/not-started",
      socketPath,
      requestTimeoutMs: 100,
    });
    try {
      await listening;
      await expect(adapter.init()).rejects.toThrow(/timed out/i);
      expect(adapter.isReady()).toBe(false);
    } finally {
      await adapter.dispose();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("shares an existing app-server Unix socket for thread control", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-unix-socket-"));
    const socketPath = join(tempDir, "app-server.sock");
    const codexDir = join(tempDir, "codex");
    const previousHumanStopStore = process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(tempDir, "human-stops.json");
    const sessionDir = join(codexDir, "sessions", "2026", "10", "05");
    const rolloutPath = join(sessionDir, "rollout-thread-unix.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(rolloutPath, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-unix", session_id: "thread-unix", cwd: "/workspace" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
      "",
    ].join("\n"));
    const db = new DatabaseSync(join(codexDir, "state_5.sqlite"));
    db.exec("create table threads (id text, rollout_path text, cwd text, model text, preview text, updated_at_ms integer, thread_source text, agent_role text, is_pinned integer)");
    db.exec("create table thread_spawn_edges (child_thread_id text, parent_thread_id text)");
    db.prepare("insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "thread-unix", rolloutPath, "/workspace", null, "", Date.now(), null, null, 0,
    );
    db.close();
    const server = createServer();
    const webSocketServer = new WebSocketServer({ server });
    const methods: string[] = [];
    const interruptTurnIds: string[] = [];
    const events: Array<{ kind: string; data?: { automationStop?: unknown } }> = [];
    let activeTurnId: string | undefined;
    let turnSequence = 0;
    let disconnectAfterTurnStart = false;
    let threadReadStatus: { type: string; activeFlags?: string[] } = { type: "idle" };
    const thread = {
      id: "thread-unix",
      cwd: "/workspace",
      name: "Unix socket fixture",
      model: null,
      status: "idle",
    };
    webSocketServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString()) as {
          id?: number;
          method?: string;
          params?: { threadId?: string; turnId?: string; input?: Array<{ text?: string }> };
        };
        if (!request.method) return;
        methods.push(request.method);
        const reply = (result: unknown) => {
          if (request.id !== undefined) socket.send(JSON.stringify({ id: request.id, result }));
        };
        if (request.method === "initialize") return reply({ userAgent: "fixture" });
        if (request.method === "thread/list") return reply({ data: [thread], nextCursor: null });
        if (request.method === "thread/read") return reply({ thread: { ...thread, status: threadReadStatus } });
        if (request.method === "thread/resume") return reply({ thread });
        if (request.method === "thread/turns/list") return reply({
          data: activeTurnId ? [{ id: activeTurnId, status: "inProgress" }] : [],
          nextCursor: null,
          backwardsCursor: null,
        });
        if (request.method === "turn/start") {
          activeTurnId = `turn-unix-${++turnSequence}`;
          socket.send(JSON.stringify({
            method: "turn/started",
            params: { threadId: request.params?.threadId, turn: { id: activeTurnId, status: "inProgress" } },
          }));
          reply({ turn: { id: activeTurnId, status: "inProgress" } });
          if (disconnectAfterTurnStart) {
            disconnectAfterTurnStart = false;
            setTimeout(() => socket.terminate(), 0);
          }
          return;
        }
        if (request.method === "turn/interrupt") {
          interruptTurnIds.push(request.params?.turnId || "");
          activeTurnId = undefined;
          socket.send(JSON.stringify({
            method: "turn/completed",
            params: { threadId: request.params?.threadId, turn: { id: request.params?.turnId, status: "interrupted" } },
          }));
          return reply({});
        }
        reply({});
      });
    });

    const listening = new Promise<void>((resolve) => server.listen(socketPath, resolve));
    let adapter: CodexAppServerAdapter | undefined;
    try {
      await listening;
      adapter = new CodexAppServerAdapter({ codexBin: "/definitely/not-started", socketPath, codexDir });
      const unsubscribe = adapter.subscribeEvents((event) => events.push({ kind: event.kind, data: event.data }));
      await adapter.init();
      expect(adapter.isReady()).toBe(true);
      const sessions = await adapter.listSessions();
      expect(sessions).toMatchObject([{ id: "thread-unix", title: "Unix socket fixture", status: "idle" }]);
      expect(sessions[0]).not.toHaveProperty("model");
      expect(sessions[0].meta).not.toHaveProperty("status");
      const liveSession = await adapter.getSession("thread-unix");
      expect(liveSession).toMatchObject({ id: "thread-unix", status: "idle", needsPermission: false });
      expect(liveSession).not.toHaveProperty("model");
      expect(liveSession?.meta).not.toHaveProperty("status");
      threadReadStatus = { type: "active", activeFlags: ["waitingOnApproval"] };
      await expect(adapter.getSession("thread-unix")).resolves.toMatchObject({
        id: "thread-unix", status: "needs_input", needsPermission: true,
      });
      threadReadStatus = { type: "idle" };
      await expect(adapter.getSession("thread-unix")).resolves.toMatchObject({
        id: "thread-unix", status: "idle", needsPermission: false,
      });
      await expect(adapter.sendMessage("thread-unix", { message: "hold", queue: true })).resolves.toEqual({ ok: true });
      await expect(adapter.getSession("thread-unix")).resolves.toMatchObject({
        id: "thread-unix", meta: { activeTurnId: "turn-unix-1" },
      });
      threadReadStatus = { type: "idle" };
      activeTurnId = undefined;
      await expect(adapter.getSession("thread-unix")).resolves.toMatchObject({
        id: "thread-unix", status: "idle", meta: { activeTurnId: undefined },
      });
      disconnectAfterTurnStart = true;
      await expect(adapter.sendMessage("thread-unix", { message: "hold after fresh status", queue: true })).resolves.toEqual({ ok: true });
      for (let attempt = 0; attempt < 100 && adapter.isReady(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(adapter.isReady()).toBe(false);
      expect(events.some((event) => event.kind === "turn.failed")).toBe(false);
      expect(events.some((event) => event.kind === "process.disconnected")).toBe(true);
      await expect(adapter.cancelTurn("thread-unix")).resolves.toEqual({ ok: true });
      expect(adapter.isReady()).toBe(true);
      expect(interruptTurnIds).toEqual(["turn-unix-2"]);
      expect(events.filter((event) => event.kind === "turn.completed").every((event) => !event.data?.automationStop)).toBe(true);
      expect(JSON.parse(await readFile(join(tempDir, "human-stops.json"), "utf8"))).toMatchObject({
        sessions: [expect.objectContaining({ ignoredStopIds: ["turn-unix-2"] })],
      });
      await writeFile(rolloutPath, `${JSON.stringify({
        type: "event_msg",
        timestamp: "2026-10-06T12:34:56.000Z",
        payload: { type: "turn_aborted", reason: "interrupted", turn_id: "turn-unix-2" },
      })}\n`, { flag: "a" });
      const restartedNativeMetadata = await new CodexAdapter({ codexDir }).getNativeAutomationMetadata("thread-unix");
      expect(restartedNativeMetadata.automationStop).toMatchObject({
        id: "turn-unix-2", turnId: "turn-unix-2", reason: "interrupted",
      });
      await expect(getHumanStopStore().observe({
        id: "thread-unix", harness: "codex", status: "idle", title: "Unix socket fixture", cwd: "/workspace",
        lastActivity: new Date().toISOString(), needsPermission: false, meta: restartedNativeMetadata,
      })).resolves.toBe(false);

      const publishTerminalTurn = (id: string, status: "interrupted" | "completed" | "failed") => {
        for (const client of webSocketServer.clients) {
          client.send(JSON.stringify({
            method: "turn/completed",
            params: { threadId: "thread-unix", turn: { id, status, completedAt: "2026-10-06T12:34:56.000Z" } },
          }));
        }
      };
      const terminalEventsStart = events.length;
      publishTerminalTurn("turn-external-interrupted", "interrupted");
      for (let attempt = 0; attempt < 100 && events.length === terminalEventsStart; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      publishTerminalTurn("turn-normal-completed", "completed");
      for (let attempt = 0; attempt < 100 && events.length < terminalEventsStart + 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      publishTerminalTurn("turn-normal-failed", "failed");
      for (let attempt = 0; attempt < 100 && events.length < terminalEventsStart + 3; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(events.slice(terminalEventsStart)).toEqual([
        expect.objectContaining({
          kind: "turn.completed",
          data: { automationStop: {
            id: "turn-external-interrupted",
            at: "2026-10-06T12:34:56.000Z",
            reason: "interrupted",
            turnId: "turn-external-interrupted",
          } },
        }),
        expect.objectContaining({ kind: "turn.completed", data: undefined }),
        expect.objectContaining({ kind: "turn.failed", data: undefined }),
      ]);
      expect(methods).toEqual(expect.arrayContaining([
        "initialize",
        "initialized",
        "thread/list",
        "thread/read",
        "thread/resume",
        "turn/start",
        "thread/turns/list",
        "turn/interrupt",
      ]));
      expect(methods.filter((method) => method === "turn/start")).toHaveLength(2);
      unsubscribe();
    } finally {
      await adapter?.dispose();
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(tempDir, { recursive: true, force: true });
      if (previousHumanStopStore === undefined) delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;
      else process.env.AGENT_HERDER_HUMAN_STOP_STORE = previousHumanStopStore;
    }
  });

  it("persists native pinned state without starting a second app-server", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-pin-"));
    const dbPath = join(codexDir, "state_5.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("create table threads (id text primary key, is_pinned integer not null default 0)");
    db.prepare("insert into threads (id, is_pinned) values (?, 0)").run("thread-pin");
    db.close();
    const adapter = new CodexAppServerAdapter({ codexBin: "/definitely/not-started", codexDir });
    try {
      await expect(adapter.setSessionPinned?.("thread-pin", true)).resolves.toMatchObject({ ok: true, sessionId: "thread-pin" });
      const reader = new DatabaseSync(dbPath, { readOnly: true });
      expect(reader.prepare("select is_pinned from threads where id = ?").get("thread-pin")).toMatchObject({ is_pinned: 1 });
      reader.close();
      expect(adapter.isReady()).toBe(false);
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("keeps sparse Codex messages found within the bounded transcript tail", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-sparse-tail-"));
    const previousHumanStopStore = process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(codexDir, "human-stops.json");
    const sessionDir = join(codexDir, "sessions", "2026", "10", "03");
    const rollout = join(sessionDir, "rollout-thread-sparse.jsonl");
    await mkdir(sessionDir, { recursive: true });
    const filler = `${JSON.stringify({ type: "event_msg", payload: { type: "noise", text: "x".repeat(1_024) } })}\n`.repeat(5_000);
    const message = (role: "user" | "assistant", text: string) => JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "response_item",
      payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
    });
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-sparse", cwd: "/workspace" } }),
      filler,
      message("user", "finish the interrupted work"),
      message("assistant", "working"),
      "",
    ].join("\n"));
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-sparse", updated_at: new Date().toISOString() }) + "\n");
    const adapter = new CodexAppServerAdapter({ codexBin: "/definitely/not-started", codexDir });
    try {
      const messages = await adapter.getSessionMessages?.("thread-sparse", 50);
      expect(messages?.map((item) => [item.role, item.text])).toEqual([
        ["user", "finish the interrupted work"],
        ["assistant", "working"],
      ]);
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("reads the original user request independently of a 200-message transcript tail", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-first-user-"));
    const sessionDir = join(codexDir, "sessions", "2026", "10", "03");
    const rollout = join(sessionDir, "rollout-thread-long.jsonl");
    await mkdir(sessionDir, { recursive: true });
    const message = (role: "user" | "assistant", text: string, offset: number) => JSON.stringify({
      timestamp: new Date(Date.UTC(2026, 9, 3, 12, 0, offset)).toISOString(),
      type: "response_item",
      payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
    });
    const later = Array.from({ length: 210 }, (_, index) => message(index % 2 ? "assistant" : "user", `later-${index}`, index + 1));
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-long", cwd: "/workspace" } }),
      message("user", "original goal that must survive tail truncation", 0),
      ...later,
      "",
    ].join("\n"));
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-long", updated_at: new Date().toISOString() }) + "\n");
    const adapter = new CodexAppServerAdapter({ codexBin: "/definitely/not-started", codexDir });
    try {
      const tail = await adapter.getSessionMessages?.("thread-long", 200);
      expect(tail).toHaveLength(50);
      expect(tail?.some((item) => item.text === "original goal that must survive tail truncation")).toBe(false);
      await expect(adapter.getFirstUserMessage?.("thread-long")).resolves.toMatchObject({
        role: "user",
        text: "original goal that must survive tail truncation",
      });
      expect(adapter.isReady()).toBe(false);
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("normalizes numeric native timestamps into AgentSession ISO strings", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-numeric-timestamp-"));
    const previous = process.env.CODEX_APP_SERVER_NUMERIC_TIMESTAMPS;
    process.env.CODEX_APP_SERVER_NUMERIC_TIMESTAMPS = "1";
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await adapter.init();
      const [session] = await adapter.listSessions();
      expect(session.lastActivity).toBe("2026-07-19T00:00:01.000Z");
      expect(typeof session.lastActivity).toBe("string");
    } finally {
      await adapter.dispose();
      if (previous === undefined) delete process.env.CODEX_APP_SERVER_NUMERIC_TIMESTAMPS;
      else process.env.CODEX_APP_SERVER_NUMERIC_TIMESTAMPS = previous;
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("enumerates every native thread page and proves the snapshot exhaustive", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-pagination-"));
    const logPath = join(codexDir, "app-server.log");
    const previousCount = process.env.CODEX_APP_SERVER_THREAD_COUNT;
    const previousLogPath = process.env.CODEX_APP_SERVER_LOG;
    process.env.CODEX_APP_SERVER_THREAD_COUNT = "325";
    process.env.CODEX_APP_SERVER_LOG = logPath;
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await adapter.init();
      const sessions = await adapter.listSessions();
      expect(sessions).toHaveLength(325);
      expect(new Set(sessions.map((session) => session.id)).size).toBe(325);
      expect(adapter.getSessionSnapshotReceipt()).toMatchObject({
        exhaustive: true,
        source: "codex-app-server",
      });
      const listRequests = (await readFile(logPath, "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line) as { kind: string; method: string; params?: { cursor?: string } })
        .filter((entry) => entry.kind === "request" && entry.method === "thread/list");
      expect(listRequests.map((entry) => entry.params?.cursor)).toEqual([undefined, "200"]);
    } finally {
      await adapter.dispose();
      if (previousCount === undefined) delete process.env.CODEX_APP_SERVER_THREAD_COUNT;
      else process.env.CODEX_APP_SERVER_THREAD_COUNT = previousCount;
      if (previousLogPath === undefined) delete process.env.CODEX_APP_SERVER_LOG;
      else process.env.CODEX_APP_SERVER_LOG = previousLogPath;
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("marks a multi-page snapshot incomplete when a later native page fails", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-pagination-failure-"));
    const previousCount = process.env.CODEX_APP_SERVER_THREAD_COUNT;
    const previousFailure = process.env.CODEX_APP_SERVER_FAIL_LIST_CURSOR;
    process.env.CODEX_APP_SERVER_THREAD_COUNT = "325";
    process.env.CODEX_APP_SERVER_FAIL_LIST_CURSOR = "200";
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await adapter.init();
      await expect(adapter.listSessions()).rejects.toThrow(/forced thread\/list failure at 200/);
      expect(adapter.getSessionSnapshotReceipt()).toMatchObject({
        exhaustive: false,
        source: "codex-app-server",
      });
    } finally {
      await adapter.dispose();
      if (previousCount === undefined) delete process.env.CODEX_APP_SERVER_THREAD_COUNT;
      else process.env.CODEX_APP_SERVER_THREAD_COUNT = previousCount;
      if (previousFailure === undefined) delete process.env.CODEX_APP_SERVER_FAIL_LIST_CURSOR;
      else process.env.CODEX_APP_SERVER_FAIL_LIST_CURSOR = previousFailure;
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("archives an idle Codex thread from the active list while retaining exact-ID transcript history", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-archive-"));
    const sessionDir = join(codexDir, "sessions", "2026", "10", "06");
    const rollout = join(sessionDir, "rollout-thread-1.jsonl");
    await mkdir(sessionDir, { recursive: true });
    const message = (role: "user" | "assistant", text: string) => JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "response_item",
      payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
    });
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-1", cwd: "/tmp/codex-fixture" } }),
      message("user", "preserve this exact session history"),
      message("assistant", "the completed result"),
      "",
    ].join("\n"));
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-1", updated_at: new Date().toISOString() }) + "\n");
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await adapter.init();
      await expect(adapter.listSessions()).resolves.toMatchObject([{ id: "thread-1", status: "idle" }]);
      await expect(adapter.archiveSession("thread-1")).resolves.toMatchObject({ ok: true, sessionId: "thread-1" });
      await expect(adapter.listSessions()).resolves.toEqual([]);
      await expect(adapter.getSessionMessages("thread-1", 10)).resolves.toMatchObject([
        { role: "user", text: "preserve this exact session history" },
        { role: "assistant", text: "the completed result" },
      ]);
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["running", false],
    ["error", false],
    ["unrecognized", false],
    ["active", true],
  ] as const)("refuses native Codex archive for status %s (permission pending: %s)", async (status, permissionPending) => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-archive-guard-"));
    const previousLogPath = process.env.CODEX_APP_SERVER_LOG;
    const previousStatus = process.env.CODEX_APP_SERVER_THREAD_STATUS;
    const previousPermissionWait = process.env.CODEX_APP_SERVER_PERMISSION_WAIT;
    const logPath = join(codexDir, "app-server.log");
    process.env.CODEX_APP_SERVER_LOG = logPath;
    process.env.CODEX_APP_SERVER_THREAD_STATUS = status;
    if (permissionPending) process.env.CODEX_APP_SERVER_PERMISSION_WAIT = "1";
    else delete process.env.CODEX_APP_SERVER_PERMISSION_WAIT;
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await adapter.init();
      await expect(adapter.archiveSession("thread-1")).resolves.toMatchObject({ ok: false });
      const requests = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { kind: string; method: string });
      expect(requests.some((entry) => entry.kind === "request" && entry.method === "thread/archive")).toBe(false);
    } finally {
      await adapter.dispose();
      if (previousLogPath === undefined) delete process.env.CODEX_APP_SERVER_LOG;
      else process.env.CODEX_APP_SERVER_LOG = previousLogPath;
      if (previousStatus === undefined) delete process.env.CODEX_APP_SERVER_THREAD_STATUS;
      else process.env.CODEX_APP_SERVER_THREAD_STATUS = previousStatus;
      if (previousPermissionWait === undefined) delete process.env.CODEX_APP_SERVER_PERMISSION_WAIT;
      else process.env.CODEX_APP_SERVER_PERMISSION_WAIT = previousPermissionWait;
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("uses the native state database instead of scanning every archived rollout", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-state-db-"));
    const sessionDir = join(codexDir, "sessions", "2026", "10", "03");
    const rollout = join(sessionDir, "rollout-thread-db.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-db", cwd: "/workspace-db" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    ].join("\n") + "\n");
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-db", thread_name: "Indexed", updated_at: new Date().toISOString() }) + "\n");
    const db = new DatabaseSync(join(codexDir, "state_5.sqlite"));
    db.exec("create table threads (id text, rollout_path text, cwd text, model text, preview text, updated_at_ms integer, thread_source text, agent_role text)");
    db.exec("create table thread_spawn_edges (child_thread_id text, parent_thread_id text)");
    db.prepare("insert into threads values (?, ?, ?, ?, ?, ?, ?, ?)").run("thread-db", rollout, "/workspace-db", "gpt-test", "working", Date.now(), "subagent", "worker");
    db.prepare("insert into thread_spawn_edges values (?, ?)").run("thread-db", "parent-db");
    db.close();
    const adapter = new CodexAppServerAdapter({ codexBin: "/definitely/not-started", codexDir });
    try {
      await expect(adapter.listSessions()).resolves.toMatchObject([{
        id: "thread-db", status: "idle", cwd: "/workspace-db", model: "gpt-test",
        meta: { parentThreadId: "parent-db", threadSource: "subagent", agentRole: "worker" },
      }]);
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("discovers persisted sessions without spawning the app-server", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-lazy-"));
    const sessionDir = join(codexDir, "sessions", "2026", "07", "30");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(codexDir, "session_index.jsonl"), [
      JSON.stringify({ id: "thread-lazy", thread_name: "Older", updated_at: "2026-01-01T00:00:00Z" }),
      JSON.stringify({ id: "thread-lazy", thread_name: "Existing", updated_at: new Date().toISOString() }),
    ].join("\n") + "\n");
    await writeFile(join(sessionDir, "rollout-thread-lazy.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { session_id: "thread-lazy", id: "thread-lazy", parent_thread_id: "thread-parent", thread_source: "subagent", agent_role: "worker", cwd: "/workspace" } }),
    ].join("\n") + "\n");
    const adapter = new CodexAppServerAdapter({ codexBin: "/definitely/not-started", codexDir });
    try {
      const sessions = await adapter.listSessions();
      expect(sessions).toMatchObject([{ id: "thread-lazy", title: "Existing", cwd: "/workspace", meta: { parentThreadId: "thread-parent", threadSource: "subagent", agentRole: "worker" } }]);
      expect(sessions).toHaveLength(1);
      expect(adapter.isReady()).toBe(false);
      expect(adapter.getSessionSnapshotReceipt()).toMatchObject({ exhaustive: true, source: "codex-state-index" });
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("reports a turn running in another app-server instance from native thread status", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-external-running-"));
    const previous = process.env.CODEX_APP_SERVER_EXTERNAL_RUNNING_THREAD;
    process.env.CODEX_APP_SERVER_EXTERNAL_RUNNING_THREAD = "thread-1";
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await adapter.init();
      const session = (await adapter.listSessions()).find((item) => item.id === "thread-1");
      expect(session?.status).toBe("running");
    } finally {
      await adapter.dispose();
      if (previous === undefined) delete process.env.CODEX_APP_SERVER_EXTERNAL_RUNNING_THREAD;
      else process.env.CODEX_APP_SERVER_EXTERNAL_RUNNING_THREAD = previous;
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["task_started", "idle"],
    ["task_complete", "idle"],
    ["turn_aborted", "idle"],
  ] as const)("overlays persisted Desktop lifecycle %s onto an idle app-server thread", async (marker, expected) => {
    const codexDir = await mkdtemp(join(tmpdir(), `agent-herder-codex-rollout-${marker}-`));
    const sessionDir = join(codexDir, "sessions", "2026", "10", "03");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({
      id: "thread-1", thread_name: "Desktop task", updated_at: new Date().toISOString(),
    }) + "\n");
    await writeFile(join(sessionDir, "rollout-thread-1.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-1", session_id: "thread-1", cwd: "/workspace" } }),
      JSON.stringify({ type: "event_msg", payload: { type: marker } }),
    ].join("\n") + "\n");
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await adapter.init();
      const session = (await adapter.listSessions()).find((item) => item.id === "thread-1");
      expect(session?.status).toBe(expected);
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("replays an interrupted native stop across adapter restart without claiming prompt origin", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-stop-replay-"));
    const sessionDir = join(codexDir, "sessions", "2026", "10", "06");
    const rollout = join(sessionDir, "rollout-thread-stopped.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({
      id: "thread-stopped", thread_name: "Stopped task", updated_at: "2026-10-06T12:34:57.000Z",
    }) + "\n");
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-stopped", session_id: "thread-stopped", cwd: "/workspace" } }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-test" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-10-06T12:00:00.000Z", id: "user-prompt-1", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Please inspect the fixture." }] } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-10-06T12:00:01.000Z", payload: { type: "task_started" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-10-06T12:34:56.000Z", id: "aborted-user-item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<turn_aborted>" }] } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-10-06T12:34:56.000Z", payload: { type: "turn_aborted", reason: "interrupted", turn_id: "turn-stopped-1" } }),
      "",
    ].join("\n"));

    const adapter = new CodexAppServerAdapter({ codexBin: "/definitely/not-started", codexDir });
    const restartedAdapter = new CodexAppServerAdapter({ codexBin: "/definitely/not-started", codexDir });
    try {
      for (const current of [adapter, restartedAdapter]) {
        const session = (await current.listSessions()).find((item) => item.id === "thread-stopped");
        expect(session?.meta).toMatchObject({
          automationStop: {
            id: "turn-stopped-1",
            at: "2026-10-06T12:34:56.000Z",
            reason: "interrupted",
            turnId: "turn-stopped-1",
          },
        });
        expect(session?.meta).not.toHaveProperty("latestUserPrompt");
      }
    } finally {
      await adapter.dispose();
      await restartedAdapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("does not treat an old persisted task_started marker as a live Codex turn", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-stale-running-"));
    const sessionDir = join(codexDir, "sessions", "2026", "10", "03");
    const rollout = join(sessionDir, "rollout-thread-1.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-1", thread_name: "Old task", updated_at: new Date().toISOString() }) + "\n");
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-1", session_id: "thread-1", cwd: "/workspace" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    ].join("\n") + "\n");
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(rollout, old, old);
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await adapter.init();
      expect((await adapter.listSessions()).find((item) => item.id === "thread-1")?.status).toBe("idle");
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("does not keep a recent task_started marker running after its Codex writer died", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-dead-writer-"));
    const sessionDir = join(codexDir, "sessions", "2026", "10", "03");
    const rollout = join(sessionDir, "rollout-thread-1.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-1", thread_name: "Interrupted task", updated_at: new Date().toISOString() }) + "\n");
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-1", session_id: "thread-1", cwd: "/workspace" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    ].join("\n") + "\n");
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await adapter.init();
      expect((await adapter.listSessions()).find((item) => item.id === "thread-1")?.status).toBe("idle");
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("keeps a recent task_started marker running while a Codex process owns the rollout", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-live-writer-"));
    const sessionDir = join(codexDir, "sessions", "2026", "10", "03");
    const rollout = join(sessionDir, "rollout-thread-1.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-1", thread_name: "Active task", updated_at: new Date().toISOString() }) + "\n");
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-1", session_id: "thread-1", cwd: "/workspace" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    ].join("\n") + "\n");
    const holder = spawn(process.execPath, [
      "-e",
      "const fs=require('node:fs');fs.openSync(process.argv[1],'a');process.stdout.write('ready');setInterval(()=>{},1000)",
      rollout,
    ], { argv0: "codex-rollout-holder", stdio: ["ignore", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout.once("data", () => resolve());
        holder.once("error", reject);
      });
      await adapter.init();
      expect((await adapter.listSessions()).find((item) => item.id === "thread-1")?.status).toBe("running");
    } finally {
      holder.kill();
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("does not count a Codex process with a read-only rollout descriptor as its writer", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-readonly-holder-"));
    const sessionDir = join(codexDir, "sessions", "2026", "10", "03");
    const rollout = join(sessionDir, "rollout-thread-1.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-1", thread_name: "Interrupted task", updated_at: new Date().toISOString() }) + "\n");
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-1", session_id: "thread-1", cwd: "/workspace" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    ].join("\n") + "\n");
    const holder = spawn(process.execPath, [
      "-e",
      "const fs=require('node:fs');fs.openSync(process.argv[1],'r');process.stdout.write('ready');setInterval(()=>{},1000)",
      rollout,
    ], { argv0: "codex-rollout-reader", stdio: ["ignore", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout.once("data", () => resolve());
        holder.once("error", reject);
      });
      await adapter.init();
      expect((await adapter.listSessions()).find((item) => item.id === "thread-1")?.status).toBe("idle");
    } finally {
      holder.kill();
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("ignores unrelated Codex candidate churn when no rollout ownership was observed", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-proc-race-"));
    const sessionDir = join(codexDir, "sessions", "2026", "10", "03");
    const rollout = join(sessionDir, "rollout-thread-race.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-race", updated_at: new Date().toISOString() }) + "\n");
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-race", cwd: "/workspace" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    ].join("\n") + "\n");
    const adapter = new CodexAdapter({ codexDir });
    const internals = adapter as unknown as { getCodexCandidatePids: () => Promise<string[] | null> };
    internals.getCodexCandidatePids = async () => ["999999999"];
    try {
      expect((await adapter.listSessions()).find((item) => item.id === "thread-race")?.status).toBe("idle");
    } finally {
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("fails closed when access mode is unreadable for an observed rollout descriptor", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-relevant-proc-race-"));
    const sessionDir = join(codexDir, "sessions", "2026", "10", "03");
    const rollout = join(sessionDir, "rollout-thread-race.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-race", updated_at: new Date().toISOString() }) + "\n");
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-race", cwd: "/workspace" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    ].join("\n") + "\n");
    const adapter = new CodexAdapter({ codexDir });
    const internals = adapter as unknown as {
      getCodexCandidatePids: () => Promise<string[] | null>;
      inspectCodexProcessRollouts: (pid: string) => Promise<Set<string> | null>;
    };
    internals.getCodexCandidatePids = async () => ["relevant-candidate"];
    internals.inspectCodexProcessRollouts = async () => null;
    try {
      expect((await adapter.listSessions()).find((item) => item.id === "thread-race")?.status).toBe("running");
    } finally {
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("keeps a native thread, interrupts turns, resumes, and forks", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-app-"));
    const previousHumanStopStore = process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    const sessionDir = join(codexDir, "sessions", "2026", "07", "30");
    const rawPath = join(sessionDir, "rollout-thread-1.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(rawPath, [
      JSON.stringify({ type: "session_meta", payload: { session_id: "thread-1", id: "thread-1", parent_thread_id: "thread-parent", thread_source: "subagent", agent_role: "worker", cwd: "/workspace" } }),
      '{"type":"response_item"}',
    ].join("\n") + "\n");
    const adapter = new CodexAppServerAdapter({
      codexBin: process.execPath,
      args: [fixture],
      modelIds: ["gpt-test", "gpt-test-2"],
      codexDir,
    });
    const nativeEvents: Array<{ kind: string; sessionId?: string }> = [];
    const unsubscribeEvents = adapter.subscribeEvents((event) => nativeEvents.push(event));
    try {
      await adapter.init();
      const sessions = await adapter.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("thread-1");
      expect(sessions[0].harness).toBe("codex");
      expect(sessions[0].meta).toMatchObject({ parentThreadId: "thread-parent", threadSource: "subagent", agentRole: "worker" });

      const created = await adapter.createSession({ name: "repair_100", cwd: "/tmp/codex-repair" });
      expect(created).toMatchObject({
        id: "thread-created-1",
        harness: "codex",
        title: "repair_100",
        cwd: "/tmp/codex-repair",
      });

      const raw = await adapter.getRawTranscript?.("thread-1");
      expect(raw).toMatchObject({ complete: true, source: { kind: "native-file", location: rawPath, format: "jsonl" } });
      expect(raw?.bytes.toString("utf8")).toContain('"session_id":"thread-1"');

      const queued = await adapter.sendMessage("thread-1", { message: "hold", queue: true });
      expect(queued).toEqual({ ok: true });
      for (let i = 0; i < 20 && !nativeEvents.some((event) => event.kind === "turn.started"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(nativeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "process.connected" }),
        expect.objectContaining({ kind: "turn.started", sessionId: "thread-1" }),
      ]));
      expect(await adapter.cancelTurn("thread-1")).toEqual({ ok: true });
      expect(await adapter.resumeSession("thread-1")).toEqual({ ok: true });
      expect(await adapter.changeModel("thread-1", "gpt-test-2")).toEqual({ ok: true });

      const forked = await adapter.forkSession("thread-1", "continue in a child");
      expect(forked.ok).toBe(true);
      expect(forked.sessionId).toBe("thread-fork-1");
      expect(await adapter.listModels()).toEqual(["gpt-test", "gpt-test-2"]);
    } finally {
      unsubscribeEvents();
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
      if (previousHumanStopStore === undefined) delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;
      else process.env.AGENT_HERDER_HUMAN_STOP_STORE = previousHumanStopStore;
    }
  });

  it("admits a cold same-thread continue only through initialize, resume, and turn/start", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-same-thread-"));
    const logPath = join(codexDir, "app-server.log");
    const previousLogPath = process.env.CODEX_APP_SERVER_LOG;
    process.env.CODEX_APP_SERVER_LOG = logPath;
    const adapter = new CodexAppServerAdapter({
      codexBin: process.execPath,
      args: [fixture],
      codexDir,
    });
    try {
      const result = await adapter.sendMessage("thread-1", { message: "continue" });
      expect(result).toEqual({ ok: true });
      const log = await readFile(logPath, "utf8").catch(() => "");
      expect(log).toContain('"method":"initialize"');
      expect(log).toContain('"method":"thread/resume"');
      expect(log).toContain('"threadId":"thread-1"');
      expect(log).toContain('"method":"turn/start"');
      expect(log).not.toContain('"method":"thread/start"');
    } finally {
      await adapter.dispose();
      if (previousLogPath === undefined) delete process.env.CODEX_APP_SERVER_LOG;
      else process.env.CODEX_APP_SERVER_LOG = previousLogPath;
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("registers automated Codex input before start and prevents a late hook from clearing a stop", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-generated-prompt-"));
    const previousHumanStopStore = process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(codexDir, "human-stops.json");
    const store = getHumanStopStore();
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    const message = "generated continuation text";
    try {
      await store.hold({ harness: "codex", id: "thread-1" }, {
        id: "explicit-stop:test", at: new Date(Date.now() - 60_000).toISOString(), reason: "interrupted", turnId: "prior-turn",
      });
      await expect(adapter.sendMessage("thread-1", { message, queue: true, origin: "automation" })).resolves.toEqual({ ok: true });

      const nativePrompt = {
        id: "codex-turn-1", at: new Date(Date.now() + 1_000).toISOString(), origin: "human", kind: "user_prompt",
        turnId: "turn-1", text: message,
      };
      await expect(store.isGeneratedPrompt("codex", "thread-1", nativePrompt)).resolves.toBe(true);
      await expect(store.release("codex", "thread-1", nativePrompt)).resolves.toBe(false);
      await expect(store.isHeld("codex", "thread-1")).resolves.toBe(true);

      const laterHumanPrompt = { ...nativePrompt, id: "codex-turn-2", turnId: "turn-2" };
      await expect(store.isGeneratedPrompt("codex", "thread-1", laterHumanPrompt)).resolves.toBe(false);
      await expect(store.release("codex", "thread-1", laterHumanPrompt)).resolves.toBe(true);
      await expect(store.isHeld("codex", "thread-1")).resolves.toBe(false);
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
      if (previousHumanStopStore === undefined) delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;
      else process.env.AGENT_HERDER_HUMAN_STOP_STORE = previousHumanStopStore;
    }
  });

  it("delivers two sequential turns to the same native thread without creating a replacement", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-sequential-turns-"));
    const logPath = join(codexDir, "app-server.log");
    const previousLogPath = process.env.CODEX_APP_SERVER_LOG;
    process.env.CODEX_APP_SERVER_LOG = logPath;
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await expect(adapter.sendMessage("thread-1", { message: "first continuation" })).resolves.toEqual({ ok: true });
      await expect(adapter.sendMessage("thread-1", { message: "second continuation" })).resolves.toEqual({ ok: true });

      const requests = (await readFile(logPath, "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line) as { kind: string; method: string; params?: { threadId?: string } })
        .filter((entry) => entry.kind === "request");
      expect(requests.filter((entry) => entry.method === "initialize")).toHaveLength(1);
      expect(requests.filter((entry) => entry.method === "thread/resume").map((entry) => entry.params?.threadId)).toEqual(["thread-1", "thread-1"]);
      expect(requests.filter((entry) => entry.method === "turn/start").map((entry) => entry.params?.threadId)).toEqual(["thread-1", "thread-1"]);
      expect(requests.some((entry) => entry.method === "thread/start")).toBe(false);
    } finally {
      await adapter.dispose();
      if (previousLogPath === undefined) delete process.env.CODEX_APP_SERVER_LOG;
      else process.env.CODEX_APP_SERVER_LOG = previousLogPath;
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("drops cached running state and fails the same turn when the native writer process dies", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-writer-death-"));
    const sessionDir = join(codexDir, "sessions", "2026", "10", "05");
    const rollout = join(sessionDir, "rollout-thread-1.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-1", thread_name: "Interrupted native turn", updated_at: new Date().toISOString() }) + "\n");
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-1", session_id: "thread-1", cwd: "/workspace" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    ].join("\n") + "\n");
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    const events: Array<{ kind: string; sessionId?: string }> = [];
    const unsubscribe = adapter.subscribeEvents((event) => events.push(event));
    try {
      await adapter.init();
      await expect(adapter.sendMessage("thread-1", { message: "hold", queue: true })).resolves.toEqual({ ok: true });
      for (let attempt = 0; attempt < 50 && !events.some((event) => event.kind === "turn.started"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await expect(adapter.getSession("thread-1")).resolves.toMatchObject({
        id: "thread-1",
        status: "running",
        meta: { activeTurnId: "turn-1" },
      });

      const child = (adapter as unknown as { child?: ChildProcessWithoutNullStreams }).child;
      expect(child?.pid).toEqual(expect.any(Number));
      const lateStdout = child?.stdout.listeners("data")[0] as ((chunk: string) => void) | undefined;
      expect(lateStdout).toEqual(expect.any(Function));
      child?.kill("SIGTERM");
      for (let attempt = 0; attempt < 100 && !events.some((event) => event.kind === "process.disconnected"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      await expect(adapter.getSession("thread-1")).resolves.toMatchObject({ id: "thread-1", status: "idle" });
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "turn.failed", sessionId: "thread-1" }),
        expect.objectContaining({ kind: "process.disconnected" }),
      ]));

      events.length = 0;
      await expect(adapter.sendMessage("thread-1", { message: "hold", queue: true })).resolves.toEqual({ ok: true });
      for (let attempt = 0; attempt < 100 && !events.some((event) => event.kind === "turn.started"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await expect(adapter.getSession("thread-1")).resolves.toMatchObject({
        id: "thread-1",
        status: "running",
        meta: { activeTurnId: "turn-1" },
      });

      lateStdout?.('{"method":"turn/com');
      lateStdout?.('pleted","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed"}}}\n');
      await new Promise((resolve) => setImmediate(resolve));

      await expect(adapter.getSession("thread-1")).resolves.toMatchObject({
        id: "thread-1",
        status: "running",
        meta: { activeTurnId: "turn-1" },
      });
      expect(events.some((event) => event.kind === "turn.completed")).toBe(false);
    } finally {
      unsubscribe();
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("shares one cold app-server initialization between observer and control callers", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-single-control-"));
    const logPath = join(codexDir, "app-server.log");
    const previousLogPath = process.env.CODEX_APP_SERVER_LOG;
    process.env.CODEX_APP_SERVER_LOG = logPath;
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      const [initialized, observed, resumed] = await Promise.all([
        adapter.init().then(() => true),
        adapter.listSessions(),
        adapter.resumeSession("thread-1"),
      ]);
      expect(initialized).toBe(true);
      expect(observed).toEqual(expect.any(Array));
      expect(resumed).toEqual({ ok: true });

      const log = await readFile(logPath, "utf8");
      expect(log.match(/"method":"initialize"/g)).toHaveLength(1);
      expect(log.match(/"method":"thread\/resume"/g)).toHaveLength(1);
    } finally {
      await adapter.dispose();
      if (previousLogPath === undefined) delete process.env.CODEX_APP_SERVER_LOG;
      else process.env.CODEX_APP_SERVER_LOG = previousLogPath;
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("fails closed when turn/started is for the wrong turn id", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-same-thread-mismatch-"));
    const previousStarted = process.env.CODEX_APP_SERVER_TURN_STARTED_ID;
    const previousCompleted = process.env.CODEX_APP_SERVER_TURN_COMPLETED_ID;
    process.env.CODEX_APP_SERVER_TURN_STARTED_ID = "turn-other";
    process.env.CODEX_APP_SERVER_TURN_COMPLETED_ID = "turn-1";
    const adapter = new CodexAppServerAdapter({
      codexBin: process.execPath,
      args: [fixture],
      codexDir,
    });
    try {
      const result = await adapter.sendMessage("thread-1", { message: "continue" });
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/admission mismatch/i) });
    } finally {
      await adapter.dispose();
      if (previousStarted === undefined) delete process.env.CODEX_APP_SERVER_TURN_STARTED_ID;
      else process.env.CODEX_APP_SERVER_TURN_STARTED_ID = previousStarted;
      if (previousCompleted === undefined) delete process.env.CODEX_APP_SERVER_TURN_COMPLETED_ID;
      else process.env.CODEX_APP_SERVER_TURN_COMPLETED_ID = previousCompleted;
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("uses session_meta.id as the child identity when session_id names the parent", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-subagent-meta-"));
    const sessionDir = join(codexDir, "sessions", "2026", "07", "30");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-child", thread_name: "Child", updated_at: new Date().toISOString() }) + "\n");
    await writeFile(join(sessionDir, "rollout-thread-child.jsonl"), JSON.stringify({
      type: "session_meta",
      payload: { session_id: "thread-parent", id: "thread-child", parent_thread_id: "thread-parent", thread_source: "subagent", agent_nickname: "worker", cwd: "/workspace" },
    }) + "\n");
    const adapter = new CodexAppServerAdapter({ codexBin: "/definitely/not-started", codexDir });
    try {
      const sessions = await adapter.listSessions();
      expect(sessions).toMatchObject([{ id: "thread-child", meta: { parentThreadId: "thread-parent", threadSource: "subagent", agentRole: "worker" } }]);
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });
  it("finds an exact named thread without reading the persisted transcript archive", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-named-"));
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await adapter.init();
      const created = await adapter.createSession({ name: "Fixture", cwd: "/tmp/codex-fixture" });
      const matches = await adapter.findNamedSessions("Fixture", "/tmp/codex-fixture");
      expect(matches).toMatchObject([{ id: created.id, title: "Fixture", cwd: "/tmp/codex-fixture" }]);
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("finds and reuses a named zero-turn thread omitted from thread/list", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-named-empty-"));
    const cwd = join(codexDir, "workspace");
    const socketPath = join(codexDir, "app-server.sock");
    const name = "Previously created native thread";
    await mkdir(cwd, { recursive: true });
    const db = new DatabaseSync(join(codexDir, "state_5.sqlite"));
    db.exec("create table threads (id text, name text, cwd text, archived integer, archived_at text)");
    db.prepare("insert into threads values (?, ?, ?, ?, ?)").run("thread-zero-turn", name, cwd, 0, null);
    db.prepare("insert into threads values (?, ?, ?, ?, ?)").run("thread-archived", name, cwd, 1, "2026-10-05T00:00:00Z");
    db.close();

    const server = createServer();
    const webSocketServer = new WebSocketServer({ server });
    const methods: string[] = [];
    let createdThreads = 0;
    webSocketServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString()) as { id?: number; method?: string; params?: { threadId?: string } };
        if (!request.method) return;
        methods.push(request.method);
        const reply = (result: unknown) => {
          if (request.id !== undefined) socket.send(JSON.stringify({ id: request.id, result }));
        };
        if (request.method === "initialize") return reply({ userAgent: "fixture" });
        if (request.method === "thread/list") return reply({ data: [], nextCursor: null });
        if (request.method === "thread/read" && request.params?.threadId === "thread-zero-turn") {
          return reply({ thread: { id: "thread-zero-turn", model: null, status: "idle" } });
        }
        if (request.method === "thread/start") {
          createdThreads += 1;
          return reply({ thread: { id: `thread-created-${createdThreads}`, name, cwd, status: "idle" } });
        }
        return reply({});
      });
    });
    const listening = new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const adapter = new CodexAppServerAdapter({ codexBin: "/definitely/not-started", socketPath, codexDir });
    try {
      await listening;
      await adapter.init();
      const matches = await adapter.findNamedSessions(name, cwd);
      expect(matches).toMatchObject([{ id: "thread-zero-turn", title: name, cwd }]);
      expect(matches).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "thread-archived" })]));
      const duplicate = await createNamedSession(new Map([["codex", adapter]]), { harness: "codex", name, cwd });
      expect(duplicate).toMatchObject({ ok: false, created: false });
      expect(duplicate.error).toMatch(/already exists/i);
      expect(methods.filter((method) => method === "thread/read")).toHaveLength(2);
      expect(createdThreads).toBe(0);
      expect(methods).not.toContain("thread/start");
    } finally {
      await adapter.dispose();
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("creates and resumes full-access threads with native approval and sandbox settings", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-full-access-"));
    const logPath = join(codexDir, "app-server.jsonl");
    const previousLogPath = process.env.CODEX_APP_SERVER_LOG;
    const previousPersistedThread = process.env.CODEX_APP_SERVER_FULL_ACCESS_THREAD;
    process.env.CODEX_APP_SERVER_LOG = logPath;
    let adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await adapter.init();
      const created = await adapter.createSession({ name: "unattended task", cwd: "/tmp/codex-fixture", fullAccess: true });
      expect(await adapter.resumeSession(created.id)).toEqual({ ok: true });
      await adapter.dispose();

      process.env.CODEX_APP_SERVER_FULL_ACCESS_THREAD = created.id;
      adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
      await adapter.init();
      expect(await adapter.resumeSession(created.id)).toEqual({ ok: true });
      expect(await adapter.resumeSession(created.id)).toEqual({ ok: true });

      const requests = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { kind: string; method?: string; params?: Record<string, unknown> })
        .filter((entry) => entry.kind === "request");
      expect(requests.find((entry) => entry.method === "thread/start")?.params).toMatchObject({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
      expect(requests.find((entry) => entry.method === "thread/resume")?.params).toMatchObject({
        threadId: created.id,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
      expect(requests.filter((entry) => entry.method === "thread/resume").at(-1)?.params).toMatchObject({
        threadId: created.id,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
    } finally {
      await adapter.dispose();
      if (previousLogPath === undefined) delete process.env.CODEX_APP_SERVER_LOG;
      else process.env.CODEX_APP_SERVER_LOG = previousLogPath;
      if (previousPersistedThread === undefined) delete process.env.CODEX_APP_SERVER_FULL_ACCESS_THREAD;
      else process.env.CODEX_APP_SERVER_FULL_ACCESS_THREAD = previousPersistedThread;
      await rm(codexDir, { recursive: true, force: true });
    }
  });

});
