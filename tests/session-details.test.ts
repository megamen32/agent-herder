import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Conversation } from "session-convert";
import { SessionSupervisor } from "../src/session-supervisor.js";
import { LineageStore } from "../src/lineage-store.js";
import type { AgentSession, HarnessAdapter, SessionMessageView } from "../src/types/index.js";

const session: AgentSession = {
  id: "session-1",
  harness: "claude",
  status: "idle",
  title: "Build parser",
  cwd: "/tmp/project",
  lastActivity: "2026-07-19T00:00:00.000Z",
  needsPermission: false,
};

const messages: SessionMessageView[] = [
  { id: "u1", role: "user", text: "Implement parser", parts: [{ type: "text", text: "Implement parser" }] },
  { id: "a1", role: "assistant", parts: [{ type: "tool_call", name: "Bash", input: { command: "npm test" } }] },
  { id: "t1", role: "tool", parts: [{ type: "tool_result", name: "Bash", output: "passed" }] },
];

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function adapter(): HarnessAdapter {
  return {
    type: "claude",
    name: "Fake Claude",
    async init() {},
    async listSessions() { return [session]; },
    async getSession(id) { return id === session.id ? session : null; },
    async getSessionMessages() { return messages; },
    async sendMessage() { return { ok: true }; },
    async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; },
    async setPermissions() { return { ok: true }; },
  };
}

function adapterWithoutLiveHistory(): HarnessAdapter {
  return {
    ...adapter(),
    async getSessionMessages() { return null; },
  };
}

describe("SessionSupervisor details", () => {
  it("returns structured live messages and marks an unregistered external session honestly", async () => {
    const supervisor = new SessionSupervisor(
      new Map([["claude-acp", adapter()]]),
      { async convert() { return { success: true }; }, async read() { return null; } },
      new LineageStore("/tmp/agent-herder-test-lineage-do-not-create.json"),
    );

    const details = await supervisor.getSessionDetails("claude-acp", session.id, { limit: 3 });
    expect(details).toMatchObject({
      session,
      lineage: { kind: "external" },
      history: { source: "acp-load", complete: false },
    });
    expect(details.messages).toHaveLength(3);
    expect(details.messages[1].parts[0]).toMatchObject({ type: "tool_call", name: "Bash" });
  });

  it("falls back to session-convert and returns the last three logical turns", async () => {
    const conversation: Conversation = {
      id: "session-1",
      sourceHarness: "claude",
      cwd: session.cwd,
      title: session.title,
      createdAt: session.lastActivity,
      updatedAt: session.lastActivity,
      messages: [1, 2, 3, 4].flatMap((turn) => [
        { id: `u${turn}`, role: "user" as const, parts: [{ type: "text" as const, text: `prompt ${turn}` }] },
        { id: `a${turn}`, role: "assistant" as const, parts: [{ type: "text" as const, text: `answer ${turn}` }] },
      ]),
    };
    const supervisor = new SessionSupervisor(
      new Map([["claude", adapterWithoutLiveHistory()]]),
      {
        async convert() { return { success: true }; },
        async read() { return conversation; },
      },
      new LineageStore("/tmp/agent-herder-test-lineage-fallback.json"),
    );

    const details = await supervisor.getSessionDetails("claude", session.id, { limit: 3, history: "auto" });
    expect(details.history).toEqual({ source: "session-convert", complete: true });
    expect(details.messages.map((message) => message.id)).toEqual(["u2", "a2", "u3", "a3", "u4", "a4"]);
  });

  it("falls back when the adapter history request fails", async () => {
    const failingAdapter: HarnessAdapter = {
      ...adapterWithoutLiveHistory(),
      async getSessionMessages() { throw new Error("ACP load failed"); },
    };
    const supervisor = new SessionSupervisor(
      new Map([["claude", failingAdapter]]),
      {
        async convert() { return { success: true }; },
        async read() {
          return {
            id: session.id,
            sourceHarness: "claude",
            cwd: session.cwd,
            title: session.title,
            createdAt: session.lastActivity,
            updatedAt: session.lastActivity,
            messages: [{ id: "fallback", role: "assistant", parts: [{ type: "text", text: "from disk" }] }],
          };
        },
      },
      new LineageStore("/tmp/agent-herder-test-lineage-error.json"),
    );

    const details = await supervisor.getSessionDetails("claude", session.id);
    expect(details.history).toMatchObject({ source: "session-convert", complete: true });
    expect(details.messages[0]).toMatchObject({ id: "fallback", text: "from disk" });
  });

  it("exposes recorded child sessions in the list and parent details", async () => {
    const child: AgentSession = { ...session, id: "child", title: "Worker", status: "running" };
    const base = adapter();
    const lineageAdapter: HarnessAdapter = {
      ...base,
      async listSessions() { return [session, child]; },
      async getSession(id) { return id === session.id ? session : id === child.id ? child : null; },
    };
    const root = await mkdtemp(join(tmpdir(), "agent-herder-details-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const supervisor = new SessionSupervisor(
      new Map([["claude", lineageAdapter]]),
      { async convert() { return { success: true }; }, async read() { return null; } },
      new LineageStore(join(root, "lineage.json")),
    );
    await supervisor.recordSpawn({ provider: "claude", sessionId: child.id, parentProvider: "claude", parentSessionId: session.id, role: "worker", task: "Implement parser" });

    const listed = await supervisor.listSessions();
    expect(listed.find((item) => item.id === child.id)?.meta).toMatchObject({ lineage: { kind: "subagent", role: "worker" }, parentSessionKey: "claude:session-1" });
    const details = await supervisor.getSessionDetails("claude", session.id);
    expect(details.children).toHaveLength(1);
    expect(details.children[0]).toMatchObject({ id: child.id });
  });

  it("keys lineage by provider and native session ids", async () => {
    const rootSession: AgentSession = {
      ...session,
      id: "acp:profile:native-root",
      meta: { nativeSessionId: "native-root" },
    };
    const childSession: AgentSession = {
      ...session,
      id: "acp:profile:native-child",
      title: "Worker",
      meta: { nativeSessionId: "native-child" },
    };
    const nativeAdapter: HarnessAdapter = {
      ...adapter(),
      async listSessions() { return [rootSession, childSession]; },
      async getSession(id) {
        return [rootSession, childSession].find((item) => item.id === id || item.meta?.nativeSessionId === id) || null;
      },
    };
    const root = await mkdtemp(join(tmpdir(), "agent-herder-native-lineage-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const supervisor = new SessionSupervisor(
      new Map([["claude-acp", nativeAdapter]]),
      { async convert() { return { success: true }; }, async read() { return null; } },
      new LineageStore(join(root, "lineage.json")),
    );

    await supervisor.recordSpawn({
      provider: "claude-acp",
      sessionId: childSession.id,
      nativeSessionId: "native-child",
      parentProvider: "claude-acp",
      parentSessionId: rootSession.id,
      parentNativeSessionId: "native-root",
      role: "worker",
    });

    const listed = await supervisor.listSessions();
    expect(listed.find((item) => item.id === childSession.id)?.meta).toMatchObject({
      lineage: { kind: "subagent", role: "worker" },
      parentSessionKey: "claude-acp:native-root",
    });
  });

  it("projects native Codex parent_thread_id records into the session tree", async () => {
    const rootSession: AgentSession = { ...session, harness: "codex", id: "codex-root", meta: { nativeSessionId: "codex-root" } };
    const childSession: AgentSession = { ...rootSession, id: "codex-child", title: "Worker", meta: { nativeSessionId: "codex-child", parentThreadId: "codex-root", threadSource: "subagent", agentRole: "worker" } };
    const codexAdapter: HarnessAdapter = {
      ...adapter(),
      type: "codex",
      async listSessions() { return [rootSession, childSession]; },
      async getSession(id) { return [rootSession, childSession].find((item) => item.id === id) || null; },
    };
    const root = await mkdtemp(join(tmpdir(), "agent-herder-codex-native-lineage-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const supervisor = new SessionSupervisor(
      new Map([["codex", codexAdapter]]),
      { async convert() { return { success: true }; }, async read() { return null; } },
      new LineageStore(join(root, "lineage.json")),
    );

    const listed = await supervisor.listSessions();
    expect(listed.find((item) => item.id === childSession.id)?.meta).toMatchObject({
      lineage: { kind: "subagent", role: "worker" },
      parentSessionKey: "codex:codex-root",
    });
    const details = await supervisor.getSessionDetails("codex", rootSession.id);
    expect(details.children).toHaveLength(1);
    expect(details.children[0]).toMatchObject({ id: childSession.id });
  });
});
