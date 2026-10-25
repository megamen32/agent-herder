import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ZcodeClientLike } from "../src/adapters/zcode-protocol.js";
import { ZcodeAdapter, resolveConfiguredZcodeModel, zcodeConfiguredModels, zcodeQuotaFailureFromSnapshot } from "../src/adapters/zcode.js";
import { markLifecycleEvent } from "../src/session-lifecycle.js";
import { getHumanStopStore } from "../src/human-stop-store.js";

// Native fixtures must never persist automation/STOP attribution in the live
// default store when the source runner does not supply a test-specific path.
let fixtureState: string;
let previousFixtureStore: string | undefined;
beforeAll(async () => {
  fixtureState = await mkdtemp(join(tmpdir(), "agent-herder-zcode-contract-"));
  previousFixtureStore = process.env.AGENT_HERDER_HUMAN_STOP_STORE;
  process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(fixtureState, "human-stops.json");
});
afterAll(async () => {
  if (previousFixtureStore === undefined) delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;
  else process.env.AGENT_HERDER_HUMAN_STOP_STORE = previousFixtureStore;
  await rm(fixtureState, { recursive: true, force: true });
});

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
  currentSnapshot: any = snapshot;
  nativeProjectTree: any = { projects: [{ id: "project-workspace", hostId: "local", roots: [{ rootPath: "/workspace", isPrimary: true }] }] };
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
    if (channel === "project" && method === "readTree") return this.nativeProjectTree;
    if (channel === "zcode-agent" && method === "listSessions") return [session];
    if (channel === "zcode-agent" && method === "readSession") return this.currentSnapshot;
    if (channel === "zcode-agent" && method === "setMode" && (args[0] as { sessionId?: string }).sessionId === "session-1") {
      this.currentSnapshot = { ...this.currentSnapshot, settings: { ...this.currentSnapshot.settings, permission: { mode: (args[0] as { mode?: string }).mode } } };
      return this.currentSnapshot;
    }
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
    if (channel === "model-selection" && method === "getView") return { providers: [{providerId:"zai",models:[{modelId:"GLM-4.5",config:{enabled:true}}]}] };
    if (channel === "zcode-agent" && method === "readWorkspaceState") return { settings: { model: { current: session.model, available: [{ ref: session.model, label: "GLM-4.5" }] } } };
    if (channel === "zcode-agent" && method === "resumeSession") return snapshot;
    if (channel === "zcode-agent" && method === "createSession") return { ...snapshot, session: { ...session, sessionId: "created-1", title: "New task", parentSessionId: undefined, sessionKind: "interactive" } };
    if (channel === "zcode-agent" && method === "setMode") return {
      ...snapshot,
      session: { ...session, sessionId: (args[0] as { sessionId: string }).sessionId, mode: "yolo", parentSessionId: undefined, sessionKind: "interactive" },
      settings: { ...snapshot.settings, permission: { mode: (args[0] as { mode: string }).mode, rulesRevision: 1 } },
    };
    if (channel === "zcode-agent" && method === "sendConversationCommandV4") {
      const { envelope } = args[0] as { envelope: { commandId: string; payload: { requestedDelivery: string } } };
      return { commandId: envelope.commandId, status: "accepted", revisionAtDecision: 3,
        result: { type: "inputAccepted", inputId: `native-${envelope.commandId}`, delivery: envelope.payload.requestedDelivery } };
    }
    if (channel === "zcode-agent" && method === "subscribeWorkspaceConfigV4") {
      const params = args[0] as {workspaceKey:string};
      queueMicrotask(() => this.listeners.find(listener => listener.event === "onDynamicWorkspaceConfigFrame")?.handler({kind:"complete",frame:{topic:`workspace-config/${params.workspaceKey}`,subscriptionId:"fake-model-catalog",payload:{kind:"snapshot",snapshot:{config:{configOptions:[{id:"model",options:[{value:"zai/GLM-4.5",name:"GLM-4.5"}]}]}}}}}));
      return {ack:{subscriptionId:"fake-model-catalog"}};
    }
    if (channel === "zcode-agent" && method === "unsubscribeWorkspaceConfigV4") return {};
    if (channel === "zcode-agent" && method === "sendPrompt") return { accepted: true };
    if (channel === "zcode-agent" && method === "setModel") return snapshot;
    if (channel === "zcode-agent" && method === "closeSession") return { closed: true };
    if (channel === "zcode-task" && method === "renameTask") return { title: (args[0] as { title: string }).title };
    if (channel === "zcode-task" && method === "stopGeneration") return undefined;
    if (channel === "zcode-task" && method === "respondPermission") return true;
    throw new Error(`unexpected fake call ${channel}.${method}`);
  }
}

describe("ZCode terminal quota evidence", () => {
  const quotaSnapshot = {
    ...snapshot,
    session: { ...session, status: "error" },
    settings: { model: { current: { providerId: "omniroute", modelId: "minimax/MiniMax-M3.1-Flash" } } },
    runtime: { eventSeq: 5, stateRevision: 6, pendingRequestIds: [] },
    messages: [
      {
        info: {
          messageId: "user-root-1", sessionId: "session-1", role: "user",
          time: { created: 1_700_000_000_000 }, metadata: { inputId: "native-input-1" },
        },
        parts: [],
      },
      {
        info: {
          messageId: "assistant-failed-1", sessionId: "session-1", role: "assistant",
          parentMessageId: "user-root-1", model: { providerId: "omniroute", modelId: "minimax/MiniMax-M3.1-Flash" },
        },
        parts: [],
      },
    ],
  };
  const failedTurn = {
    turnId: "turn-native-1", userMessageId: "user-root-1", status: "error",
    cancelledByUser: false, pendingInput: false, modelErrorType: "rate_limited",
    errorMessage: "Weekly/Monthly Limit Exhausted. Your limit resets later.",
  } as const;

  it("emits only exact terminal snapshot-correlated quota evidence", () => {
    const event = {
      kind: "turn.failed", harness: "zcode", sessionId: "session-1",
      data: { turnId: "turn-native-1", inputId: "native-input-1", nativeErrorStatus: 400 },
    } as const;
    expect(zcodeQuotaFailureFromSnapshot("session-1", quotaSnapshot, failedTurn, event as any)).toEqual({
      classification: "quota_exhausted", status: "error", nativeTurnId: "turn-native-1",
      inputId: "native-input-1", providerId: "omniroute", modelId: "minimax/MiniMax-M3.1-Flash",
    });
    expect(zcodeQuotaFailureFromSnapshot("session-1", quotaSnapshot, failedTurn)).toEqual({
      classification: "quota_exhausted", status: "error", nativeTurnId: "turn-native-1",
      inputId: "native-input-1", providerId: "omniroute", modelId: "minimax/MiniMax-M3.1-Flash",
    });
    expect(zcodeQuotaFailureFromSnapshot("session-1", quotaSnapshot, failedTurn, {
      ...event, data: { turnId: "different-turn", inputId: "native-input-1" },
    } as any)).toBeUndefined();
    expect(zcodeQuotaFailureFromSnapshot("session-1", quotaSnapshot, failedTurn, {
      ...event, data: { turnId: "turn-native-1", inputId: "different-input" },
    } as any)).toBeUndefined();
    expect(zcodeQuotaFailureFromSnapshot("session-1", {
      ...quotaSnapshot, runtime: { ...quotaSnapshot.runtime, activeTurnId: "new-turn" },
    }, failedTurn)).toBeUndefined();
    expect(zcodeQuotaFailureFromSnapshot("session-1", quotaSnapshot, failedTurn, {
      ...event, data: { turnId: "turn-native-1", inputId: "native-input-1", nativeErrorStatus: 429 },
    } as any)).toMatchObject({ classification: "quota_exhausted", nativeTurnId: "turn-native-1" });
    expect(zcodeQuotaFailureFromSnapshot("session-1", quotaSnapshot, {
      ...failedTurn, errorMessage: "Too many requests",
    }, {
      ...event, data: { turnId: "turn-native-1", inputId: "native-input-1", nativeErrorStatus: 429 },
    } as any)).toBeUndefined();
  });

  it("exposes the same proof on getSession for startup reconciliation", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-quota-proof-"));
    const path = join(root, "native.sqlite");
    const db = new DatabaseSync(path);
    db.exec(`create table turn_usage (session_id text, turn_id text, user_message_id text, status text, started_at integer, completed_at integer, cancelled_by_user integer, error_type text, error_code text);
      create table model_usage (session_id text, turn_id text, completed_at integer, error_type text, error_message text);
      create table message (session_id text, data text);`);
    db.prepare("insert into turn_usage values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("session-1", "turn-native-1", "user-root-1", "error", 100, 200, 0, "unknown_error", "UNKNOWN_ERROR");
    db.prepare("insert into model_usage values (?, ?, ?, ?, ?)").run("session-1", "turn-native-1", 200, "rate_limited", "Weekly/Monthly Limit Exhausted");
    db.prepare("insert into message values (?, ?)").run("session-1", JSON.stringify({ role: "user", semantics: { origin: "real_user", kind: "user_prompt" } }));
    db.close();
    class QuotaClient extends FakeClient {
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "readSession") return quotaSnapshot;
        if (channel === "zcode-agent" && method === "readSessionEvents") return { events: [] };
        return super.call(channel, method, args);
      }
    }
    const client = new QuotaClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client, localDbPath: path });
    const events: Array<{ kind: string; data?: Record<string, unknown> }> = [];
    const unsubscribe = adapter.subscribeEvents((event) => events.push(event));
    await adapter.init();
    try {
      expect((await adapter.getSession("session-1"))?.meta?.nativeLastTurn).toMatchObject({
        turnId: "turn-native-1", inputId: "native-input-1", status: "error",
        quotaFailure: {
          classification: "quota_exhausted", nativeTurnId: "turn-native-1", inputId: "native-input-1",
          providerId: "omniroute", modelId: "minimax/MiniMax-M3.1-Flash", status: "error",
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const listener = client.listeners.find((entry) => entry.event === "onDynamicSessionEvent");
      expect(listener).toBeDefined();
      listener!.handler({ type: "session.event", event: {
        type: "turn.failed", eventId: "native-failed-event", sessionId: "session-1",
        turnId: "turn-native-1", seq: 7, timestamp: 300,
        payload: { inputId: "native-input-1", error: { type: "rate_limited", status: 400, message: "Weekly/Monthly Limit Exhausted" } },
      } });
      await Promise.all([...(adapter as unknown as { sessionEventTasks: Set<Promise<void>> }).sessionEventTasks]);
      expect(events.find((event) => event.kind === "turn.failed")?.data).toMatchObject({
        turnId: "turn-native-1", inputId: "native-input-1",
        quotaFailure: { classification: "quota_exhausted", providerId: "omniroute", modelId: "minimax/MiniMax-M3.1-Flash" },
      });
    } finally { unsubscribe(); await adapter.dispose(); await rm(root, { recursive: true, force: true }); }
  });
});

it("lists OmniRoute models from the native catalog and reads back a confirmed model switch", async () => {
  class OmniRouteModelClient extends FakeClient {
    currentModel = { providerId: "omniroute", modelId: "openrouter/old-model" };
    override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
      if (channel === "zcode-agent" && method === "readSession") {
        this.calls.push({ channel, method, args });
        return {
          ...snapshot,
          session: { ...session, status: "idle", model: this.currentModel },
          settings: { model: { current: this.currentModel, available: [{ ref: this.currentModel }] } },
          runtime: { ...snapshot.runtime, activeTurnId: undefined, activeTurnKind: undefined },
        };
      }
      if (channel === "model-selection" && method === "getView") {
        this.calls.push({ channel, method, args });
        return { providers: [{ providerId: "omniroute", models: [{ modelId: "minimax/MiniMax-M3.1-Flash", config: { enabled: true } }] }] };
      }
      if (channel === "zcode-agent" && method === "setModel") {
        this.calls.push({ channel, method, args });
        this.currentModel = (args[0] as { model: typeof this.currentModel }).model;
        return { ...snapshot, settings: { model: { current: this.currentModel } } };
      }
      return super.call(channel, method, args);
    }
  }
  const client = new OmniRouteModelClient();
  const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
  await adapter.init();
  try {
    const fallback = "omniroute/minimax/MiniMax-M3.1-Flash";
    expect(await adapter.listModels()).toContain(fallback);
    expect(await adapter.changeModel("session-1", fallback)).toEqual({ ok: true });
    expect((await adapter.getSession("session-1"))?.model).toBe(fallback);
    expect(client.calls.find((call) => call.method === "setModel")?.args[0]).toMatchObject({
      sessionId: "session-1",
      model: { providerId: "omniroute", modelId: "minimax/MiniMax-M3.1-Flash" },
    });
  } finally { await adapter.dispose(); }
});

describe("native compact admission (focused integration, expected 1s/max 10s)", () => {
  it("reads omitted terminal receipts and counts only real human messages from native history", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-compact-engagement-"));
    const path = join(root, "native.sqlite"); const db = new DatabaseSync(path);
    db.exec("create table message (session_id text, data text); create table turn_usage (session_id text, turn_id text, status text, started_at integer, completed_at integer)");
    const insert = db.prepare("insert into message values (?, ?)");
    const real = { role: "user", semantics: { origin: "real_user", kind: "user_prompt" } };
    for (let i = 0; i < 5; i++) insert.run("session-1", JSON.stringify(real));
    for (const extra of [{ metadata: { inputId: "agent-herder:auto:one" } }, { synthetic: true }, { visibility: "model-only" }, { metadata: { offPeakTaskId: "automatic" } }]) insert.run("session-1", JSON.stringify({ ...real, ...extra }));
    db.prepare("insert into turn_usage values (?, ?, ?, ?, ?)").run("session-1", "exact-completed-turn", "completed", 100, 200);
    db.close();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client: new FakeClient(), localDbPath: path });
    await adapter.init();
    try {
      expect((await adapter.getSession("session-1"))?.meta).toMatchObject({ nativeHumanMessageCount: 5, nativeLastTurn: { turnId: "exact-completed-turn", status: "completed", completedAt: 200 } });
    } finally { await adapter.dispose(); await rm(root, { recursive: true, force: true }); }
  });
  it("names the provider failure that the aggregate turn receipt hides", async () => {
    // Real zcode receipt of 2026-10-14T19:51:31Z: turn_usage keeps only the
    // placeholder code, and the model_usage row of the same compact turn names
    // the network failure that ended the compaction stream.
    const root = await mkdtemp(join(tmpdir(), "native-turn-failure-"));
    const path = join(root, "native.sqlite"); const db = new DatabaseSync(path);
    db.exec(`create table message (session_id text, data text);
      create table turn_usage (session_id text, turn_id text, status text, started_at integer, completed_at integer, cancelled_by_user integer, error_type text, error_code text);
      create table model_usage (session_id text, turn_id text, status text, completed_at integer, error_type text, error_message text)`);
    db.prepare("insert into turn_usage values (?, ?, ?, ?, ?, ?, ?, ?)").run("session-1", "turn-3461f34c", "error", 1_000, 1_900, 0, "unknown_error", "UNKNOWN_ERROR");
    db.prepare("insert into model_usage values (?, ?, ?, ?, ?, ?)").run("session-1", "turn-3461f34c", "error", 1_900, "network_error", "Network connection failed for the provider request.");
    db.prepare("insert into model_usage values (?, ?, ?, ?, ?, ?)").run("session-1", "turn-earlier", "completed", 900, null, null);
    db.close();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client: new FakeClient(), localDbPath: path });
    await adapter.init();
    try {
      expect((await adapter.getSession("session-1"))?.meta?.nativeLastTurn).toMatchObject({
        turnId: "turn-3461f34c", status: "error", errorCode: "UNKNOWN_ERROR",
        modelErrorType: "network_error", errorMessage: "Network connection failed for the provider request." });
    } finally { await adapter.dispose(); await rm(root, { recursive: true, force: true }); }
  });
  it("keeps a secret-bearing request failure redacted and bounded", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-turn-failure-redaction-"));
    const path = join(root, "native.sqlite"); const db = new DatabaseSync(path);
    db.exec(`create table message (session_id text, data text);
      create table turn_usage (session_id text, turn_id text, status text, started_at integer, completed_at integer, cancelled_by_user integer, error_type text, error_code text);
      create table model_usage (session_id text, turn_id text, status text, completed_at integer, error_type text, error_message text)`);
    db.prepare("insert into turn_usage values (?, ?, ?, ?, ?, ?, ?, ?)").run("session-1", "turn-fine", "completed", 500, 600, 0, null, null);
    db.prepare("insert into turn_usage values (?, ?, ?, ?, ?, ?, ?, ?)").run("session-1", "turn-leaky", "error", 1_000, 1_900, 0, "unknown_error", "UNKNOWN_ERROR");
    db.prepare("insert into model_usage values (?, ?, ?, ?, ?, ?)").run("session-1", "turn-leaky", "error", 1_900, "provider_error", "rejected with api_key=sk-abcdefghijklmnop and token: secret-value-1234");
    db.close();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client: new FakeClient(), localDbPath: path });
    await adapter.init();
    try {
      const leaky = (await adapter.getSession("session-1"))?.meta?.nativeLastTurn;
      expect(leaky?.errorMessage).toContain("[redacted");
      expect(leaky?.errorMessage).not.toContain("sk-abcdefghijklmnop");
      expect(leaky?.errorMessage).not.toContain("secret-value-1234");
      expect(leaky?.errorMessage!.length).toBeLessThanOrEqual(200);
    } finally { await adapter.dispose(); await rm(root, { recursive: true, force: true }); }
  });
  it.each(["accepted", "busy", "new-input"])("keeps the same ID and revision for %s", async (state) => {
    class CompactClient extends FakeClient {
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (channel === "zcode-agent" && method === "readSession") {
          this.calls.push({ channel, method, args });
          return { ...snapshot, messages: snapshot.messages.map((message) => ({ ...message, info: { ...message.info, semantics: { origin: "real_user", kind: "user_prompt" } } })), session: { ...session, status: "idle", parentSessionId: undefined, sessionKind: "interactive", updatedAt: Date.now() }, runtime: { ...snapshot.runtime, ...(state === "busy" ? { activeTurnId: "running" } : {}) } };
        }
        if (channel === "zcode-agent" && method === "compactSession") {
          this.calls.push({ channel, method, args });
          return { snapshot, compact: { state: "accepted", inputId: "compact-one" } };
        }
        return super.call(channel, method, args);
      }
    }
    const client = new CompactClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client }); await adapter.init();
    try {
      const result = await adapter.compactSession("session-1", { inputId: "compact-one", expectedUserMessageId: state === "new-input" ? "old-user" : "message-1" });
      const calls = client.calls.filter((call) => call.method === "compactSession");
      if (state === "accepted") {
        expect(result).toMatchObject({ ok: true, admitted: true, sessionId: "session-1", pending: true });
        expect(calls[0]?.args[0]).toMatchObject({ sessionId: "session-1", inputId: "compact-one", expectedRevision: 3 });
        expect((await adapter.getSession("session-1"))?.status).toBe("idle");
      } else { expect(result.ok).toBe(false); expect(calls).toHaveLength(0); }
      expect(client.calls.some((call) => ["sendPrompt", "sendConversationInput", "createSession"].includes(call.method))).toBe(false);
    } finally { await adapter.dispose(); }
  });
});

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

  it("carries the same real cause through the persisted page snapshot", async () => {
    // The cold getSession path and the persisted listSessions page must not disagree
    // about why a compaction was lost: both read the per-request receipt.
    const root = await mkdtemp(join(tmpdir(), "persisted-page-failure-"));
    const dbPath = join(root, "tasks-index.sqlite"); const sessionDbPath = join(root, "db.sqlite");
    const tasks = new DatabaseSync(dbPath);
    tasks.exec("create table tasks (task_id text primary key, workspace_path text, title text, task_status text, model text, created_at integer, updated_at integer, deleted integer default 0, archived integer default 0)");
    const now = Date.now();
    tasks.prepare("insert into tasks values (?,?,?,?,?,?,?,0,0)").run("failed-session", "/workspace", "Failed", "error", null, now - 5_000, now - 5_000);
    tasks.prepare("insert into tasks values (?,?,?,?,?,?,?,0,0)").run("healthy-session", "/workspace", "Healthy", "completed", null, now - 9_000, now - 9_000);
    tasks.close();
    const native = new DatabaseSync(sessionDbPath);
    native.exec(`create table session(id text primary key, directory text, parent_id text, time_updated integer);
      create table turn_usage(session_id text, turn_id text, status text, started_at integer, completed_at integer, error_type text, error_code text, primary key(session_id, turn_id));
      create table model_usage(session_id text, turn_id text, status text, completed_at integer, error_type text, error_message text)`);
    native.prepare("insert into session values(?,?,?,?)").run("failed-session", "/workspace", null, now - 5_000);
    native.prepare("insert into session values(?,?,?,?)").run("healthy-session", "/workspace", null, now - 9_000);
    native.prepare("insert into turn_usage values(?,?,?,?,?,?,?)").run("failed-session", "turn-net", "error", 1_000, 1_900, "unknown_error", "UNKNOWN_ERROR");
    native.prepare("insert into model_usage values(?,?,?,?,?,?)").run("failed-session", "turn-net", "error", 1_900, "network_error", "Network connection failed for the provider request.");
    native.prepare("insert into turn_usage values(?,?,?,?,?,?,?)").run("healthy-session", "turn-ok", "completed", 500, 600, null, null);
    native.close();
    try {
      const adapter = new ZcodeAdapter({ client: new FakeClient(), tasksIndexDbPath: dbPath, localDbPath: sessionDbPath });
      const sessions = await adapter.listSessions();
      expect(sessions.find((item) => item.id === "failed-session")?.meta?.nativeLastTurn).toMatchObject({
        turnId: "turn-net", errorCode: "UNKNOWN_ERROR", modelErrorType: "network_error",
        errorMessage: "Network connection failed for the provider request." });
      expect(sessions.find((item) => item.id === "healthy-session")?.meta?.nativeLastTurn?.errorMessage).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
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
    tasks.exec("create table tasks(task_id text, workspace_path text, workspace_identity text, title text, task_status text, model text, created_at integer, updated_at integer, deleted integer default 0, archived integer default 0)");
    const native = new DatabaseSync(nativePath);
    native.exec(`create table session(id text primary key, directory text, parent_id text, time_updated integer);
      create table turn_usage(session_id text,turn_id text,user_message_id text,status text,started_at integer,completed_at integer,retryable integer,cancelled_by_user integer,error_type text,error_code text,primary key(session_id,turn_id));
      create table message(id text primary key,session_id text,data text,sequence integer,time_updated integer);
      create index message_session_sequence_idx on message(session_id,sequence);
      create table session_input(id text,session_id text,status text,time_created integer);
    `);
    tasks.exec("begin"); native.exec("begin");
    const now = Date.now();
    const cases = ["retry", "captcha", "cancelled", "transport-lost", "completed", "running", "child", "new-user", "progress", "succeeded", "pending", "runtime-stop", "runtime-progress", "runtime-pending", "runtime-old-stop", "runtime-invalid", "runtime-silent", "runtime-silent-unowned", "runtime-parent-crash", "runtime-parent-crash-foreign"];
    for (const id of cases) {
      tasks.prepare("insert into tasks values(?,?,?,?,?,?,?,?,?,?)").run(id,root,id === "transport-lost" ? "remote:ssh:example.test:22:user:/workspace" : root,id,id === "transport-lost" ? "running" : "completed",null,now-10000,now-2000,0,0);
      native.prepare("insert into session values(?,?,?,?)").run(id,root,id==="child"?"parent":null,now-2000);
      const status = id.startsWith("runtime-") || id === "cancelled" || id === "transport-lost" ? "cancelled" : id === "completed" ? "completed" : id === "running" ? "running" : "error";
      native.prepare("insert into turn_usage values(?,?,?,?,?,?,?,?,?,?)").run(id,"turn-"+id,"user-"+id,status,now-10000,id==="running"?null:now-2000,id==="captcha" || id.startsWith("runtime-")?0:1,id.startsWith("runtime-") || id==="cancelled" || id === "transport-lost"?1:0,"transport_error","CONNECTION_RESET");
      native.prepare("insert into message values(?,?,?,?,?)").run("user-"+id,id,JSON.stringify({role:"user"}),1,now-10000);
      native.prepare("insert into message values(?,?,?,?,?)").run("assistant-"+id,id,JSON.stringify({role:"assistant",parentID:"user-"+id,...(id==="succeeded"?{finish:"stop"}: {error:{name:"NativeError",data:{message:id==="captcha"?"Captcha verification request timed out":"connection lost"}}})}),2,id==="progress"?now-1000:now-2001);
      if (id.startsWith("runtime-")) {
        native.prepare("update message set data=? where id=?").run(JSON.stringify({role:"assistant",parentID:"user-"+id,error:{name:"AiSdkModelAdapterError",data:{message:"ZCode Protocol runtime stopping",code:"model_request_failed",attribution:{source:"runtime"},turnResult:"cancelled"}}}), "assistant-"+id);
        if (id.startsWith("runtime-silent")||id.startsWith('runtime-parent-crash')) native.prepare("update message set data=? where id=?").run(JSON.stringify({role:"assistant",parentID:"user-"+id,finish:"tool-calls"}),"assistant-"+id);
        if(id.startsWith('runtime-parent-crash'))native.prepare('update message set data=? where id=?').run(JSON.stringify({role:'user',anchor:{sourceCommandId:'exact-accepted-command'}}),'user-'+id);
        if (id === "runtime-progress") {
          native.prepare("insert into message values(?,?,?,?,?)").run("runtime-new-user",id,JSON.stringify({role:"user"}),3,now-1500);
          native.prepare("insert into message values(?,?,?,?,?)").run("runtime-new-assistant",id,JSON.stringify({role:"assistant",parentID:"runtime-new-user",finish:"tool-calls"}),4,now-500);
          native.prepare("insert into message values(?,?,?,?,?)").run("runtime-reminder",id,JSON.stringify({role:"user",synthetic:true,semantics:{origin:"agent_runtime",kind:"todo_reminder"}}),5,now-100);
        }
        if (id === "runtime-pending") native.prepare("insert into session_input values(?,?,?,?)").run("runtime-queued",id,"admitted",now-5000);
        if (id === "runtime-old-stop") native.prepare("update message set time_updated=? where id=?").run(now-20000,"assistant-"+id);
        if (id === "runtime-invalid") native.prepare("insert into message values(?,?,?,?,?)").run("runtime-invalid-tail",id,"{",3,now-100);
      }
      if (id === "transport-lost") native.prepare("insert into message values(?,?,?,?,?)").run("transport-tail",id,JSON.stringify({role:"user"}),3,now-1000);
      if (id==="pending") native.prepare("insert into session_input values(?,?,?,?)").run("pending-input",id,"admitted",now-5000);
      if (id==="new-user") native.prepare("insert into message values(?,?,?,?,?)").run("new-user-input",id,JSON.stringify({role:"user"}),3,now-1000);
    }
    tasks.exec("commit"); native.exec("commit");
    tasks.close();native.close();
    await getHumanStopStore().checkpointOwnedZcodeShutdown("runtime-silent",{turnId:"turn-runtime-silent",controllerPid:10,runtimePid:11,at:now-3000});
    for(const id of ['runtime-parent-crash','runtime-parent-crash-foreign'])await getHumanStopStore().checkpointOwnedZcodeShutdown(id,{turnId:'turn-'+id,controllerPid:10,runtimePid:11,at:now-3000,userMessageId:'user-'+id,sourceCommandId:id.endsWith('foreign')?'fake-prefix':'exact-accepted-command'},{kind:'parent-crash',controllerStartedAt:now-20000,journalCursor:'exact-journal-cursor',errorCode:'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING'});
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
      expect(meta("cancelled").transportLost).toBeUndefined();
      expect(meta("transport-lost")).toMatchObject({status:"cancelled",cancelledByUser:true,transportLost:true,userMessageMatchesLatest:false,assistantSucceeded:false,progressedAfterFailure:true});
      expect(rows.find((x)=>x.id==="transport-lost")?.status).toBe("error");
      expect(meta("runtime-stop")).toMatchObject({status:"cancelled",cancelledByUser:true,transportLost:true});
      expect(rows.find((x)=>x.id==="runtime-stop")?.status).toBe("error");
      expect(meta("runtime-progress").transportLost).toBeUndefined();
      // A persisted completed task is terminal until a newer native/lifecycle start.
      expect(rows.find((x)=>x.id==="runtime-progress")?.status).toBe("stopped");
      expect(meta("runtime-pending").transportLost).toBeUndefined();
      expect(meta("runtime-old-stop").transportLost).toBeUndefined();
      expect(meta("runtime-invalid").transportLost).toBeUndefined();
      expect(meta("runtime-silent").transportLost).toBe(true);
      expect(rows.find(x=>x.id==="runtime-silent")?.status).toBe("error");
      expect(meta("runtime-silent-unowned").transportLost).toBeUndefined();
      expect(meta('runtime-parent-crash').transportLost).toBe(true);
      expect(meta('runtime-parent-crash-foreign').transportLost).toBeUndefined();
      class WarmStoppedClient extends FakeClient {
        override async call(channel:string,method:string,args:unknown[]):Promise<unknown>{
          if(method==='readSession')return {...snapshot,session:{...session,sessionId:'runtime-silent',parentSessionId:undefined,status:'idle',workspace:{workspacePath:root,workspaceIdentity:root}},runtime:{eventSeq:3,stateRevision:3,pendingRequestIds:[]},messages:[]};
          return super.call(channel,method,args);
        }
      }
      const warmClient=new WarmStoppedClient();
      warmClient.nativeEvents=[{type:'turn.completed',eventId:'owned-cancel-event',sessionId:'runtime-silent',turnId:'turn-runtime-silent',seq:1,timestamp:now-2000,payload:{resultType:'cancelled'}}];
      const warmAdapter=new ZcodeAdapter({client:warmClient,cwd:root,tasksIndexDbPath:tasksPath,localDbPath:nativePath});
      await warmAdapter.init();
      const warm=await warmAdapter.getSession('runtime-silent');
      expect(warm?.meta?.nativeLastTurn).toMatchObject({turnId:'turn-runtime-silent',transportLost:true});
      expect(warm?.meta?.automationStop).toBeUndefined();
      expect(await getHumanStopStore().observe(warm!)).toBe(false);
      await warmAdapter.dispose();

      markLifecycleEvent("zcode", "runtime-progress", "end", root);
      expect((await adapter.listSessions()).find((x)=>x.id==="runtime-progress")?.status).toBe("stopped");
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

  it("holds automation after native queue admission without a Herder timer replay", async () => {
    vi.useFakeTimers();
    const storeDir = await mkdtemp(join(tmpdir(), "agent-herder-zcode-native-queue-stop-"));
    const previousStopStore = process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(storeDir, "human-stops.json");
    const client = new FakeClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    try {
      await adapter.init();
      await expect(adapter.sendMessage("session-1", { message: "queued automation", queue: true, inputId: "native-stop-queue" })).resolves.toEqual({ ok: true, admitted: true, pending: true, admission: "pending", inputId: "native-stop-queue" });
      await getHumanStopStore().hold({ harness: "zcode", id: "session-1" }, { id: "manual-stop-after-queue", at: new Date().toISOString(), reason: "operator stopped" });
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(adapter.sendMessage("session-1", { message: "blocked automation", queue: true, inputId: "blocked-native-queue" })).resolves.toMatchObject({ ok: false, inputId: "blocked-native-queue", error: expect.stringContaining("остановлен") });
      expect(client.calls.filter(call => call.method === "sendConversationCommandV4")).toHaveLength(1);
      expect(client.calls.some(call => ["sendPrompt", "resumeSession"].includes(call.method))).toBe(false);
      expect(await getHumanStopStore().isHeld("zcode", "session-1")).toBe(true);
      expect(await getHumanStopStore().release("zcode", "session-1", { id: "late-native-hook", at: new Date(Date.now() + 1_000).toISOString(), text: "queued automation" })).toBe(false);
    } finally {
      await adapter.dispose(); vi.useRealTimers(); await rm(storeDir, { recursive: true, force: true });
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

  it("defaults new Herder-created ZCode sessions to native yolo unless explicitly restricted", async () => {
    const defaultClient = new FakeClient();
    const defaultAdapter = new ZcodeAdapter({ cwd: "/workspace", client: defaultClient });
    await defaultAdapter.init();

    await defaultAdapter.createSession({ name: "default-full-access", cwd: "/workspace" });
    const defaultCreate = defaultClient.calls.find((call) => call.method === "createSession");
    const defaultSetMode = defaultClient.calls.find((call) => call.method === "setMode");
    expect(defaultCreate?.args[0]).toMatchObject({ mode: "yolo" });
    expect(defaultSetMode?.args[0]).toMatchObject({ sessionId: "created-1", mode: "yolo" });
    await defaultAdapter.dispose();

    const restrictedClient = new FakeClient();
    const restrictedAdapter = new ZcodeAdapter({ cwd: "/workspace", client: restrictedClient });
    await restrictedAdapter.init();
    await restrictedAdapter.createSession({ name: "explicitly-restricted", cwd: "/workspace", fullAccess: false });
    const restrictedCreate = restrictedClient.calls.find((call) => call.method === "createSession");
    expect(restrictedCreate?.args[0]).toMatchObject({ mode: "build" });
    expect(restrictedClient.calls.some((call) => call.method === "setMode")).toBe(false);
    await restrictedAdapter.dispose();

    const explicitModeClient = new FakeClient();
    const explicitModeAdapter = new ZcodeAdapter({ cwd: "/workspace", client: explicitModeClient });
    await explicitModeAdapter.init();
    await explicitModeAdapter.createSession({ name: "explicit-build-mode", cwd: "/workspace", mode: "build" });
    const explicitModeCreate = explicitModeClient.calls.find((call) => call.method === "createSession");
    expect(explicitModeCreate?.args[0]).toMatchObject({ mode: "build" });
    expect(explicitModeClient.calls.some((call) => call.method === "setMode")).toBe(false);
    await explicitModeAdapter.dispose();
  });

  it.each([
    { fullAccess: false, mode: "yolo", name: "restrictive flag with YOLO mode" },
    { fullAccess: true, mode: "build", name: "full access flag with restrictive mode" },
  ])("rejects contradictory create-session permission options before native creation ($name)", async ({ fullAccess, mode }) => {
    const client = new FakeClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    await adapter.init();

    await expect(adapter.createSession({ name: "contradictory", cwd: "/workspace", fullAccess, mode }))
      .rejects.toThrow("Contradictory ZCode session permission options");
    expect(client.calls.some((call) => call.method === "createSession")).toBe(false);
    await adapter.dispose();
  });

  it("preserves the fullAuto alias when it agrees with full-access creation", async () => {
    const client = new FakeClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    await adapter.init();

    await adapter.createSession({ name: "full-auto-alias", cwd: "/workspace", fullAccess: true, mode: "fullAuto" });
    expect(client.calls.find((call) => call.method === "createSession")?.args[0]).toMatchObject({ mode: "yolo" });
    expect(client.calls.find((call) => call.method === "setMode")?.args[0]).toMatchObject({ sessionId: "created-1", mode: "yolo" });
    await adapter.dispose();
  });

  it("passes the unique exact-root project from the native owner catalog to createSession", async () => {
    const client = new FakeClient();
    client.nativeProjectTree = { projects: [{ id: "native-project-1", hostId: "remote:server:fixture", roots: [{ rootPath: "/workspace", isPrimary: true }] }] };
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    await adapter.init();

    await adapter.createSession({ name: "registered-project", cwd: "/workspace" });
    const createArgs = client.calls.find((call) => call.channel === "zcode-agent" && call.method === "createSession")?.args[0] as Record<string, unknown>;
    expect(createArgs).toMatchObject({ workspacePath: "/workspace", projectId: "native-project-1", mode: "yolo" });
    expect(createArgs).not.toHaveProperty("hostId");
    expect(client.calls.some((call) => call.channel === "project" && call.method === "readTree" && call.args.length === 0)).toBe(true);
    await adapter.dispose();
  });

  it.each([
    { label: "missing exact project", projects: [] },
    { label: "ambiguous exact roots", projects: [
      { id: "native-project-1", hostId: "remote:server:fixture", roots: [{ rootPath: "/workspace" }] },
      { id: "native-project-2", hostId: "remote:server:fixture", roots: [{ rootPath: "/workspace" }] },
    ] },
    { label: "mixed native owner namespaces", projects: [
      { id: "native-project-1", hostId: "remote:server:other", roots: [{ rootPath: "/workspace" }] },
      { id: "native-project-2", hostId: "remote:server:fixture", roots: [{ rootPath: "/other" }] },
    ] },
  ])("fails closed before native session creation for $label", async ({ projects }) => {
    const client = new FakeClient();
    client.nativeProjectTree = { projects };
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    await adapter.init();

    await expect(adapter.createSession({ name: "unmapped", cwd: "/workspace" }))
      .rejects.toThrow("ZCode native project mapping");
    expect(client.calls.some((call) => call.channel === "zcode-agent" && call.method === "createSession")).toBe(false);
    await adapter.dispose();
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

    expect(await adapter.sendMessage("session-1", { message: "continue" })).toEqual({ ok: true });
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
      "model-selection.getView",
    ]));
    expect(client.calls.filter((call) => call.method === "setModel").at(-1)?.args[0]).toMatchObject({
      model: { providerId: "zai", modelId: "GLM-4.5", options: { reasoningLevel: "high" } },
    });

    await adapter.dispose();
    expect(client.closed).toBe(true);
  });

  it("switches the existing native mode with exact session readback and keeps native permission response", async () => {
    const client = new FakeClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    await adapter.init();
    expect(await adapter.setPermissions("session-1", { mode: "fullAuto" })).toEqual({ ok: true });
    expect(client.calls.filter((call) => call.method === "setMode")).toHaveLength(1);
    expect(client.calls.find((call) => call.method === "setMode")?.args[0]).toMatchObject({ sessionId: "session-1", mode: "yolo" });
    expect(await adapter.getPermissionState("session-1")).toMatchObject({
      target: { harness: "zcode", sessionId: "session-1" }, currentMode: "yolo", scope: "session", pendingRequests: [],
    });
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

    const result = await adapter.sendMessage("session-1", { message: "ping" });
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

    await expect(adapter.sendMessage("session-1", { message: "continue" })).resolves.toEqual({
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

    await expect(adapter.sendMessage("session-1", { message: "continue" })).resolves.toEqual({
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

    const result = await adapter.sendMessage("session-1", { message: "continue" });
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

    const result = await adapter.sendMessage("session-1", { message: "continue" });
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

    await expect(adapter.sendMessage("session-1", { message: "continue" })).resolves.toEqual({
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

    await expect(adapter.sendMessage("session-1", { message: "continue" })).resolves.toEqual({
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

  // Native command admission fast unit: expected2s/max20s. Detects obsolete
  // sendPrompt/timer fallback, mode mismatch, missing/lost receipt and preflight bypass.
  it("queues into the existing native turn without completion wait or legacy replay", async () => {
    vi.useFakeTimers();
    const client = new FakeClient(); const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    try {
      await adapter.init();
      await expect(adapter.sendMessage("session-1", { message: "second continuation", queue: true, inputId: "queue-native-1" })).resolves.toEqual({ ok: true, admitted: true, pending: true, admission: "pending", inputId: "queue-native-1" });
      await vi.advanceTimersByTimeAsync(10_000);
      const commands = client.calls.filter(call => call.method === "sendConversationCommandV4");
      expect(commands).toHaveLength(1);
      expect(commands[0]?.args[0]).toMatchObject({ workspacePath: "/workspace", envelope: { commandId: "agent-herder:auto:queue-native-1", clientId: "agent-herder", sessionId: "session-1", type: "sendText", payload: { text: "second continuation", requestedDelivery: "queue" } } });
      expect(client.calls.some(call => ["sendPrompt", "resumeSession", "readSessionEvents", "stopGeneration"].includes(call.method))).toBe(false);
    } finally { await adapter.dispose(); vi.useRealTimers(); }
  });

  it("atomically starts a fresh input on an idle native session when its durable queue is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-idle-start-now-"));
    const path = join(root, "native.sqlite");
    const db = new DatabaseSync(path);
    db.exec("create table session_input (id text primary key, session_id text not null, status text not null)");
    db.close();
    const client = new FakeClient();
    client.currentSnapshot = {
      ...snapshot,
      session: { ...session, status: "idle" },
      runtime: { eventSeq: 2, stateRevision: 3, pendingRequestIds: [] },
    };
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client, localDbPath: path });
    try {
      const result = await adapter.sendMessage("session-1", {
        message: "fresh idle input", queue: true, origin: "human", inputId: "idle-start-now-1",
      });
      expect(result).toMatchObject({ ok: true, admitted: true, inputId: "idle-start-now-1" });
      expect(client.calls.find(call => call.method === "sendConversationCommandV4")?.args[0]).toMatchObject({
        envelope: { commandId: "idle-start-now-1", payload: { text: "fresh idle input", requestedDelivery: "startNow" } },
      });
      expect(client.calls.some(call => call.method === "resumeSession")).toBe(false);
    } finally {
      await adapter.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not add a new native input to an idle session with an already-admitted queue row", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-idle-existing-input-"));
    const path = join(root, "native.sqlite");
    const db = new DatabaseSync(path);
    db.exec("create table session_input (id text primary key, session_id text not null, status text not null)");
    db.prepare("insert into session_input values (?, ?, ?)").run("queue-existing-1", "session-1", "admitted");
    db.close();
    const client = new FakeClient();
    client.currentSnapshot = {
      ...snapshot,
      session: { ...session, status: "idle" },
      runtime: { eventSeq: 2, stateRevision: 3, pendingRequestIds: [] },
    };
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client, localDbPath: path });
    try {
      const result = await adapter.sendMessage("session-1", {
        message: "do not overtake old queue", queue: true, origin: "human", inputId: "new-after-existing-1",
      });
      expect(result).toMatchObject({ ok: false, admitted: false, notSubmitted: true, nonRetryable: true });
      expect(client.calls.some(call => call.method === "sendConversationCommandV4")).toBe(false);
      expect(client.calls.some(call => call.method === "resumeSession")).toBe(false);
    } finally {
      await adapter.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves an admitted-but-mismatched startNow receipt without replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-start-now-mismatch-"));
    const path = join(root, "native.sqlite");
    const db = new DatabaseSync(path);
    db.exec("create table session_input (id text primary key, session_id text not null, status text not null)");
    db.close();
    class QueueInsteadClient extends FakeClient {
      override async call(channel: string, method: string, args: unknown[]) {
        if (method === "sendConversationCommandV4") {
          this.calls.push({ channel, method, args });
          const { envelope } = args[0] as { envelope: { commandId: string } };
          return { commandId: envelope.commandId, status: "accepted", revisionAtDecision: 3,
            result: { type: "inputAccepted", inputId: "native-queued-start", delivery: "queue" } };
        }
        return super.call(channel, method, args);
      }
    }
    const client = new QueueInsteadClient();
    client.currentSnapshot = {
      ...snapshot,
      session: { ...session, status: "idle" },
      runtime: { eventSeq: 2, stateRevision: 3, pendingRequestIds: [] },
    };
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client, localDbPath: path });
    try {
      const result = await adapter.sendMessage("session-1", {
        message: "start receipt mismatch", queue: true, origin: "human", inputId: "idle-start-mismatch-1",
      });
      expect(result).toMatchObject({ ok: false, admitted: true, nonRetryable: true, inputId: "idle-start-mismatch-1" });
      expect(client.calls.filter(call => call.method === "sendConversationCommandV4")).toHaveLength(1);
      expect(client.calls.some(call => ["sendPrompt", "resumeSession"].includes(call.method))).toBe(false);
    } finally {
      await adapter.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats a native startNow busy race as a terminal exact refusal without fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-start-now-busy-"));
    const path = join(root, "native.sqlite");
    const db = new DatabaseSync(path);
    db.exec("create table session_input (id text primary key, session_id text not null, status text not null)");
    db.close();
    class BusyStartClient extends FakeClient {
      override async call(channel: string, method: string, args: unknown[]) {
        if (method === "sendConversationCommandV4") {
          this.calls.push({ channel, method, args });
          const { envelope } = args[0] as { envelope: { commandId: string } };
          return { commandId: envelope.commandId, status: "rejected", reasonCode: "session_busy", revisionAtDecision: 4 };
        }
        return super.call(channel, method, args);
      }
    }
    const client = new BusyStartClient();
    client.currentSnapshot = {
      ...snapshot,
      session: { ...session, status: "idle" },
      runtime: { eventSeq: 2, stateRevision: 3, pendingRequestIds: [] },
    };
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client, localDbPath: path });
    try {
      const result = await adapter.sendMessage("session-1", {
        message: "exact busy-race refusal", queue: true, origin: "human", inputId: "idle-start-busy-1",
      });
      expect(result).toMatchObject({ ok: false, notSubmitted: true, admission: "not_submitted", nonRetryable: true, inputId: "idle-start-busy-1" });
      expect(client.calls.filter(call => call.method === "sendConversationCommandV4")).toHaveLength(1);
      expect(client.calls.find(call => call.method === "sendConversationCommandV4")?.args[0]).toMatchObject({
        envelope: { payload: { requestedDelivery: "startNow" } },
      });
      expect(client.calls.some(call => ["sendPrompt", "resumeSession"].includes(call.method))).toBe(false);
    } finally {
      await adapter.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not resume an unloaded stopped session before fresh input without a native CAS load contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-unloaded-send-"));
    const path = join(root, "native.sqlite");
    const db = new DatabaseSync(path);
    db.exec("create table session_input (id text primary key, session_id text not null, status text not null)");
    db.close();
    const stopped = {
      ...snapshot,
      session: { ...session, status: "stopped" },
      runtime: { eventSeq: 2, stateRevision: 3, pendingRequestIds: [] },
    };
    class UnloadedSessionClient extends FakeClient {
      missing = true;
      override async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
        if (method === "readSession" && this.missing) {
          this.calls.push({ channel, method, args });
          this.missing = false;
          throw Object.assign(new Error("Native session is not loaded"), { code: "proto.sessionNotFound" });
        }
        if (method === "resumeSession") {
          this.calls.push({ channel, method, args });
          return stopped;
        }
        if (method === "readSession") {
          this.calls.push({ channel, method, args });
          return stopped;
        }
        return super.call(channel, method, args);
      }
    }
    const client = new UnloadedSessionClient();
    const adapter = new ZcodeAdapter({ cwd: "/workspace", client, localDbPath: path });
    try {
      const result = await adapter.sendMessage("session-1", {
        message: "new input to unloaded stopped session", queue: true, origin: "human", inputId: "stopped-start-1",
      });
      expect(result).toMatchObject({ ok: false, notSubmitted: true, nonRetryable: true, inputId: "stopped-start-1" });
      expect(client.calls.some(call => call.method === "resumeSession")).toBe(false);
      expect(client.calls.some(call => call.method === "sendConversationCommandV4")).toBe(false);
    } finally {
      await adapter.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("guides the native active turn with human identity and no invented new turn", async () => {
    const client = new FakeClient(); const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    try {
      const result = await adapter.sendMessage("session-1", { message: "guide delta", steer: true, origin: "human", inputId: "human-guide-1" });
      expect(result).toEqual({ ok: true, admitted: true, admission: "accepted", inputId: "human-guide-1" });
      expect(result.turnId).toBeUndefined();
      expect(client.calls.filter(call => call.method === "sendConversationCommandV4")[0]?.args[0]).toMatchObject({ envelope: { commandId: "human-guide-1", payload: { text: "guide delta", requestedDelivery: "guide" } } });
      expect(client.calls.some(call => ["sendPrompt", "resumeSession", "readSessionEvents", "stopGeneration"].includes(call.method))).toBe(false);
    } finally { await adapter.dispose(); }
  });

  it("keeps a native rejected queue receipt non-admitted without resume or timer retry", async () => {
    vi.useFakeTimers();
    class RejectedQueueClient extends FakeClient {
      override async call(channel: string, method: string, args: unknown[]) {
        if (method === "sendConversationCommandV4") {
          this.calls.push({ channel, method, args });
          const { envelope } = args[0] as { envelope: { commandId: string } };
          return { commandId: envelope.commandId, status: "rejected", revisionAtDecision: 3 };
        }
        return super.call(channel, method, args);
      }
    }
    const client = new RejectedQueueClient(); const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    try {
      const result = await adapter.sendMessage("session-1", { message: "native rejection", queue: true, inputId: "native-rejected" });
      expect(result).toMatchObject({ ok: false, admitted: false, inputId: "native-rejected", nonRetryable: true });
      expect(result.admissionUnknown).toBeUndefined();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.calls.filter(call => call.method === "sendConversationCommandV4")).toHaveLength(1);
      expect(client.calls.some(call => ["sendPrompt", "resumeSession"].includes(call.method))).toBe(false);
    } finally { await adapter.dispose(); vi.useRealTimers(); }
  });

  it("fails closed on unknown native baseline before V4 queue mutation", async () => {
    class UnreadableClient extends FakeClient {
      override async call(channel: string, method: string, args: unknown[]) {
        if (method === "readSession") { this.calls.push({ channel, method, args }); throw new Error("native observation timeout"); }
        return super.call(channel, method, args);
      }
    }
    const client = new UnreadableClient(); const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    try {
      const result = await adapter.sendMessage("session-1", { message: "do not guess", queue: true, inputId: "unobserved-queue" });
      expect(result).toMatchObject({ ok: false, inputId: "unobserved-queue", error: "native observation timeout" });
      expect(result.admissionUnknown).toBeUndefined();
      expect(client.calls.map(call => call.method)).toEqual(["readSession"]);
    } finally { await adapter.dispose(); }
  });

  it("retains UNKNOWN after V4 write loses its receipt and never falls back to legacy", async () => {
    vi.useFakeTimers();
    class LostReceiptClient extends FakeClient {
      override async call(channel: string, method: string, args: unknown[]) {
        if (method === "sendConversationCommandV4") { this.calls.push({ channel, method, args }); throw new Error("transport disconnected after write"); }
        return super.call(channel, method, args);
      }
    }
    const client = new LostReceiptClient(); const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    try {
      const result = await adapter.sendMessage("session-1", { message: "single native attempt", queue: true, inputId: "lost-v4-receipt" });
      expect(result).toMatchObject({ ok: false, admissionUnknown: true, nonRetryable: true, inputId: "lost-v4-receipt" });
      expect(result.admitted).toBeUndefined();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.calls.filter(call => call.method === "sendConversationCommandV4")).toHaveLength(1);
      expect(client.calls.some(call => ["sendPrompt", "resumeSession"].includes(call.method))).toBe(false);
    } finally { await adapter.dispose(); vi.useRealTimers(); }
  });

  it.each([
    { name: "accepted envelope without input", ack: (id: string) => ({ commandId: id, status: "accepted", revisionAtDecision: 3 }), unknown: true },
    { name: "foreign command identity", ack: (_id: string) => ({ commandId: "foreign-command", status: "accepted", result: { type: "inputAccepted", inputId: "native-input", delivery: "queue" } }), unknown: true },
    { name: "native mode mismatch", ack: (id: string) => ({ commandId: id, status: "accepted", result: { type: "inputAccepted", inputId: "native-input", delivery: "guide" } }), unknown: false },
  ])("never upgrades $name to successful native queue delivery", async ({ ack, unknown }) => {
    class ReceiptClient extends FakeClient {
      override async call(channel: string, method: string, args: unknown[]) {
        if (method === "sendConversationCommandV4") {
          this.calls.push({ channel, method, args });
          return ack((args[0] as { envelope: { commandId: string } }).envelope.commandId);
        }
        return super.call(channel, method, args);
      }
    }
    const client = new ReceiptClient(); const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    try {
      const result = await adapter.sendMessage("session-1", { message: "receipt fence", queue: true, inputId: "receipt-fenced", origin: "human" });
      expect(result).toMatchObject({ ok: false, nonRetryable: true, inputId: "receipt-fenced" });
      expect(result.admissionUnknown).toBe(unknown ? true : undefined);
      expect(result.admitted).toBe(unknown ? undefined : true);
      expect(client.calls.filter(call => call.method === "sendConversationCommandV4")).toHaveLength(1);
      expect(client.calls.some(call => ["sendPrompt", "resumeSession", "stopGeneration"].includes(call.method))).toBe(false);
    } finally { await adapter.dispose(); }
  });

  it("holds V4 queue before mutation when native permission is pending", async () => {
    class PermissionClient extends FakeClient {
      override async call(channel: string, method: string, args: unknown[]) {
        if (method === "readSession") { this.calls.push({ channel, method, args }); return { ...snapshot, runtime: { ...snapshot.runtime, pendingRequestIds: ["native-permission"] } }; }
        return super.call(channel, method, args);
      }
    }
    const client = new PermissionClient(); const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
    try {
      const result = await adapter.sendMessage("session-1", { message: "must wait", queue: true, inputId: "native-permission-wait" });
      expect(result).toMatchObject({ ok: false, inputId: "native-permission-wait", error: expect.stringContaining("разрешения") });
      expect(result.admissionUnknown).toBeUndefined();
      expect(client.calls.map(call => call.method)).toEqual(["readSession"]);
    } finally { await adapter.dispose(); }
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

// Fast unit expected1s/max5s: image guide must be one native command with local attachments.
it("passes attached image files to the same native ZCode guide command", async () => {
  const client = new FakeClient(); const adapter = new ZcodeAdapter({ cwd: "/workspace", client });
  const image = { id: "a".repeat(64), path: "/protected/image.png", fileName: "figure.png", mimeType: "image/png", bytes: 90 };
  try {
    await expect(adapter.sendMessage("session-1", { message: "describe", origin: "human", steer: true, inputId: "human-image-guide", images: [image] })).resolves.toMatchObject({ ok: true, admitted: true });
    const calls = client.calls.filter(call => call.method === "sendConversationCommandV4");
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0]).toMatchObject({ envelope: { sessionId: "session-1", payload: { requestedDelivery: "guide", attachments: [{ ref: image.path, fileName: image.fileName, mime: image.mimeType, bytes: image.bytes }] } } });
  } finally { await adapter.dispose(); }
});

// Fast unit expected1s/max5s: native artifact rewriting must retain image display.
it("reads attached images from ZCode artifact source paths", async () => {
 class ImageClient extends FakeClient {
  override async call(channel:string, method:string, args:unknown[]):Promise<unknown> {
   if(method==="readSessionMessages")return [{info:{messageId:"image-message",role:"user"},parts:[{type:"file",mime:"image/png",filename:"native-name.png",url:"zcode-artifact://session-1/blob",source:{path:"/protected/"+"a".repeat(64)+".png"}}]}];
   return super.call(channel,method,args);
  }
 }
 const adapter=new ZcodeAdapter({cwd:"/workspace",client:new ImageClient()});
 try {expect((await adapter.getSessionMessages("session-1"))?.[0]?.parts).toEqual([{type:"image",imageUrl:"/api/session-images/"+"a".repeat(64),fileName:"Прикреплённое изображение"}]);}
 finally{await adapter.dispose();}
});

// Focused integration expected1s/max5s: staged guide ACK settles from exact native attribution.
it("waits for a staged guide instead of declaring failure or replaying it", async () => {
 class StagedGuideClient extends FakeClient {
  override async call(channel:string,method:string,args:unknown[]):Promise<unknown>{
   if(method==="sendConversationCommandV4") {this.calls.push({channel,method,args});const {envelope}=args[0] as {envelope:{commandId:string}};return {commandId:envelope.commandId,status:"accepted",result:{type:"inputAccepted",inputId:"native-guide",delivery:"queue"}};}
   if(method==="readSessionMessages")return [{info:{role:"user",anchor:{turnId:"existing-turn",sourceCommandId:"guide-staged"},metadata:{inputIntent:{admittedDelivery:"guide",sourceCommandId:"guide-staged"}}},parts:[]}];
   return super.call(channel,method,args);
  }
 }
 const client=new StagedGuideClient(), adapter=new ZcodeAdapter({cwd:"/workspace",client});
 try{
  await expect(adapter.sendMessage("session-1",{message:"guide",steer:true,origin:"human",inputId:"guide-staged"})).resolves.toEqual({ok:true,pending:true,admission:"pending",inputId:"guide-staged"});
  await expect(adapter.getMessageAdmission("session-1","guide-staged")).resolves.toEqual({state:"admitted"});
  expect(client.calls.filter(call=>call.method==="sendConversationCommandV4")).toHaveLength(1);
 }finally{await adapter.dispose();}
});
// Focused integration expected1s/max5s: explicit picker loads only the existing native session.
it('changes model in a cold existing session without creating a turn', async()=>{
 class ColdPickerClient extends FakeClient {
  cold=true;
  override async call(channel:string,method:string,args:unknown[]):Promise<unknown>{
   if(method==='readSession'&&this.cold)throw new Error('Session not found');
   if(method==='resumeSession')this.cold=false;
   return super.call(channel,method,args);
  }
 }
 const client=new ColdPickerClient(),adapter=new ZcodeAdapter({cwd:'/workspace',client});
 try {
  await expect(adapter.changeModel('session-1','zai/GLM-5.3-Flash$high')).resolves.toEqual({ok:true});
  expect(client.calls.filter(call=>call.method==='resumeSession')).toHaveLength(1);
  expect(client.calls.find(call=>call.method==='setModel')?.args[0]).toMatchObject({sessionId:'session-1',model:{providerId:'zai',modelId:'GLM-5.3-Flash',options:{reasoningLevel:'high'}}});
  expect(client.calls.some(call=>['createSession','sendPrompt','sendConversationCommandV4'].includes(call.method))).toBe(false);
 }finally{await adapter.dispose();}
});

// Focused integration expected1s/max5s: native output validation must not replay resume.
it("recovers current state after a historical message source fails native validation", async()=>{
 const error=new Error(JSON.stringify([{code:"invalid_value",path:["messages",1,"info","source"],message:"Invalid option"}]));
 class LegacySourceClient extends FakeClient {
  override async call(channel:string,method:string,args:unknown[]):Promise<unknown>{
   if(method==="resumeSession"){this.calls.push({channel,method,args});throw error;}
   if(method==="readSession" && (args[0] as {messageLimit?:number}).messageLimit!==1){this.calls.push({channel,method,args});throw error;}
   return super.call(channel,method,args);
  }
 }
 const client=new LegacySourceClient(),adapter=new ZcodeAdapter({cwd:"/workspace",client});
 try{
  await expect(adapter.resumeSession("session-1")).resolves.toEqual({ok:true});
  await expect(adapter.changeModel("session-1","zai/GLM-5.3-Flash")).resolves.toEqual({ok:true});
  expect(client.calls.filter(call=>call.method==="resumeSession")).toHaveLength(1);
  expect(client.calls.some(call=>["createSession","sendPrompt","sendConversationCommandV4"].includes(call.method))).toBe(false);
 }finally{await adapter.dispose();}
});

// Fast unit expected1s/max5s: model chip must reflect current native settings after selection.
it("shows selected native model settings rather than stale session metadata", async()=>{
 class SelectedModelClient extends FakeClient{
  override async call(channel:string,method:string,args:unknown[]):Promise<unknown>{
   if(method==="readSession")return {...snapshot,settings:{...snapshot.settings,model:{current:{providerId:"zai",modelId:"GLM-5.3-Flash",options:{reasoningLevel:"high"}}}}};
   return super.call(channel,method,args);
  }
 }
 const adapter=new ZcodeAdapter({cwd:"/workspace",client:new SelectedModelClient()});
 try{await adapter.init();expect((await adapter.getSession("session-1"))?.model).toBe("zai/GLM-5.3-Flash$high");}finally{await adapter.dispose();}
});

// Focused integration expected1s/max5s: bare model names must use the native-required default reasoning level.
it("uses the model catalog default reasoning level for a plain model selection", async()=>{
 class ReasoningCatalogClient extends FakeClient{
  override async call(channel:string,method:string,args:unknown[]):Promise<unknown>{
   if(method==="readSession")return {...snapshot,settings:{...snapshot.settings,model:{current:session.model,available:[{ref:{providerId:"zai",modelId:"GLM-5.3"},reasoning:{defaultLevel:"high",levels:[{value:"high"}]}}]}}};
   return super.call(channel,method,args);
  }
 }
 const client=new ReasoningCatalogClient(),adapter=new ZcodeAdapter({cwd:"/workspace",client});
 try{await expect(adapter.changeModel("session-1","zai/GLM-5.3")).resolves.toEqual({ok:true});expect(client.calls.find(call=>call.method==="setModel")?.args[0]).toMatchObject({model:{providerId:"zai",modelId:"GLM-5.3",options:{reasoningLevel:"high"}}});}finally{await adapter.dispose();}
});

// Focused integration expected1s/max5s: session snapshots omit other models and required reasoning metadata.
it.each([false,true])("keeps the user's reasoning level using the native provider registry: incomplete %s", async(incompleteEntry)=>{
 class WorkspaceDefaultsClient extends FakeClient{
  override async call(channel:string,method:string,args:unknown[]):Promise<unknown>{
   if(method==="readSession") return {...snapshot,settings:{...snapshot.settings,model:{current:{...session.model,options:{reasoningLevel:"high"}},available:incompleteEntry?[{ref:{providerId:"zai",modelId:"GLM-5.3"}}]:[]}}};
   if(channel==="model-selection" && method==="getView") {this.calls.push({channel,method,args});return {providers:[{providerId:"zai",models:[{modelId:"GLM-5.3",config:{enabled:true,optionSpecs:{reasoningLevel:{values:["low","high","max"]}}}}]}]};}
   return super.call(channel,method,args);
  }
 }
 const client=new WorkspaceDefaultsClient(),adapter=new ZcodeAdapter({cwd:"/workspace",client});
 try{await expect(adapter.changeModel("session-1","zai/GLM-5.3")).resolves.toEqual({ok:true});expect(client.calls.find(call=>call.method==="setModel")?.args[0]).toMatchObject({model:{providerId:"zai",modelId:"GLM-5.3",options:{reasoningLevel:"high"}}});expect(client.calls.some(call=>call.channel==="model-selection"&&call.method==="getView")).toBe(true);expect(client.calls.some(call=>call.method==="readWorkspaceState")).toBe(false);}finally{await adapter.dispose();}
});

// Focused integration expected1s/max5s: durable admission must settle from exact native message attribution when the event schema evolves.
it.each([false,true])("settles a staged guide from native history despite event/message schema failures: %s", async(messageSchemaFails)=>{
 const inputId="guide-schema-reconciliation";
 const attributed={info:{role:"user",metadata:{inputIntent:{sourceCommandId:inputId}}},parts:[{type:"text",text:"Exact guide"}]};
 class SchemaDriftClient extends FakeClient {
  override async call(channel:string,method:string,args:unknown[]):Promise<unknown>{
   this.calls.push({channel,method,args});
   if(method==="readSessionEvents")throw new Error('Unrecognized key: "executionStartedAt"');
   if(method==="readSessionMessages"){if(messageSchemaFails)throw new Error('Invalid source: agent_listing_delta');return {messages:[attributed]};}
   if(method==="readSession")return {...snapshot,messages:[attributed]};
   return super.call(channel,method,args);
  }
 }
 const client=new SchemaDriftClient(),adapter=new ZcodeAdapter({cwd:"/workspace",client});
 try{await adapter.init();await expect(adapter.getMessageAdmission("session-1",inputId)).resolves.toEqual({state:"admitted"});expect(client.calls.filter(call=>["sendPrompt","sendConversationCommandV4","resumeSession"].includes(call.method))).toHaveLength(0);}finally{await adapter.dispose();}
});


it.each(['Desktop input','human Stop'])('rejects recovery when %s arrives during the final native read without replaying tools (focused integration expected .3s/max5s)',async(race)=>{
 const root=await mkdtemp(join(tmpdir(),'zcode-admission-race-'));const path=join(root,'native.sqlite');const db=new DatabaseSync(path);
 db.exec(`create table turn_usage(session_id text,turn_id text,user_message_id text,started_at integer,completed_at integer);
 create table message(id text,session_id text,data text,sequence integer);
 create table session_input(session_id text,status text);create table tool_usage(id text,status text);`);
 db.prepare('insert into turn_usage values(?,?,?,?,?)').run('race-session','old-turn','old-user',1,10);
 db.prepare('insert into message values(?,?,?,?)').run('old-user','race-session',JSON.stringify({role:'user'}),1);
 db.exec("insert into tool_usage values('accepted-old-tool','completed')");
 class RaceClient extends FakeClient {
  override async call(channel:string,method:string,args:unknown[]):Promise<unknown>{
   if(method==='readSession')return {...snapshot,session:{...session,sessionId:'race-session'},runtime:{eventSeq:1,stateRevision:1,pendingRequestIds:[]}};
   return super.call(channel,method,args);
  }
  async callIfReady(channel:string,method:string,args:unknown[]):Promise<unknown>{
   if(method==='readSession'){
    // Other-controller admission is invisible in this controller's snapshot.
    if(race==='Desktop input')db.exec("insert into session_input values('race-session','admitted')");
    else await getHumanStopStore().hold({harness:'zcode',id:'race-session'},{id:'stop-during-final-read',at:new Date().toISOString(),reason:'human Stop',turnId:'old-turn'});
   }
   return this.call(channel,method,args);
  }
 }
 const client=new RaceClient();const adapter=new ZcodeAdapter({client,localDbPath:path,cwd:root});
 try{
  await adapter.init();
  const result=await adapter.sendMessage('race-session',{message:'resume once',queue:true,inputId:'same-recovery',recoveryBoundary:{turnId:'old-turn',userMessageId:'old-user',completedAt:10}});
  expect(result).toMatchObject({ok:false,admitted:false,nonRetryable:true});
  expect(result.error).toContain(race==='Desktop input'?'новый ввод':'остановлен');
  expect(client.calls.some(c=>['sendPrompt','sendConversationCommandV4','createSession'].includes(c.method))).toBe(false);
  expect(db.prepare('select status from tool_usage').get()).toEqual({status:'completed'});
  if(race==='human Stop')expect(await getHumanStopStore().isHeld('zcode','race-session')).toBe(true);
 }finally{await adapter.dispose();db.close();await rm(root,{recursive:true,force:true});}
});

// Focused integration expected .3s/max5s: installed SDK rejects messageLimit=0,
// so the guarded recovery read must use a positive limit before supported send.
it('uses positive native message limit for an eligible guarded recovery',async()=>{
 const root=await mkdtemp(join(tmpdir(),'zcode-positive-limit-'));const path=join(root,'native.sqlite');const db=new DatabaseSync(path);
 db.exec(`create table turn_usage(session_id text,turn_id text,user_message_id text,started_at integer,completed_at integer);
 create table message(id text,session_id text,data text,sequence integer);create table session_input(session_id text,status text);`);
 db.prepare('insert into turn_usage values(?,?,?,?,?)').run('positive-session','old-turn','old-user',1,10);
 db.prepare('insert into message values(?,?,?,?)').run('old-user','positive-session',JSON.stringify({role:'user'}),1);
 class PositiveLimitClient extends FakeClient {
  override async call(channel:string,method:string,args:unknown[]):Promise<unknown>{
   if(method==='readSession')return {...snapshot,session:{...session,sessionId:'positive-session'},runtime:{stateRevision:1,pendingRequestIds:[]}};
   return super.call(channel,method,args);
  }
  async callIfReady(channel:string,method:string,args:unknown[]):Promise<unknown>{
   if(method==='readSession'){
    this.calls.push({channel,method,args});
    if(!Number.isInteger((args[0] as any).messageLimit)||(args[0] as any).messageLimit<=0)throw Error('Native schema: messageLimit expected >0');
   }
   return this.call(channel,method,args);
  }
 }
 const client=new PositiveLimitClient();const adapter=new ZcodeAdapter({client,localDbPath:path,cwd:root});
 try{
  await adapter.init();
  expect(await adapter.sendMessage('positive-session',{message:'fixture only',queue:true,inputId:'positive-recovery',recoveryBoundary:{turnId:'old-turn',userMessageId:'old-user',completedAt:10}})).toMatchObject({ok:true,admitted:true});
  expect(client.calls.find(c=>c.method==='readSession'&&(c.args[0] as any).runtimePolicy==='existing-only')?.args[0]).toMatchObject({messageLimit:1});
  expect(client.calls.filter(c=>c.method==='sendConversationCommandV4')).toHaveLength(1);
 }finally{await adapter.dispose();db.close();await rm(root,{recursive:true,force:true});}
});

// Focused integration expected .3s/max5s: strict history fallback must still
// establish exact own active turn and checkpoint it using a valid native read.
it('uses positive limits for native receipt fallback and owned shutdown checkpoint',async()=>{
 const root=await mkdtemp(join(tmpdir(),'zcode-positive-owned-')),path=join(root,'native.sqlite'),db=new DatabaseSync(path);
 const id='positive-owned',input='agent-herder:auto:exact-owned';
 db.exec(`create table message(id text,session_id text,data text,sequence integer);
 create table turn_usage(session_id text,turn_id text,user_message_id text,status text,started_at integer,completed_at integer);
 create table session_input(session_id text,status text,payload text,promoted_message_id text);`);
 db.prepare('insert into message values(?,?,?,?)').run('own-user',id,JSON.stringify({role:'user',anchor:{sourceCommandId:input,turnId:'own-turn'}}),1);
 db.prepare('insert into message values(?,?,?,?)').run('own-assistant',id,JSON.stringify({role:'assistant',parentID:'own-user'}),2);
 db.prepare('insert into turn_usage values(?,?,?,?,?,null)').run(id,'own-turn','own-user','running',1);
 class OwnedPositiveClient extends FakeClient {
  sharedOwner?:string;
  getOwnedProcessId(){return 42;}
  override async call(channel:string,method:string,args:unknown[]):Promise<unknown>{
   if(method==='readSessionEvents')throw Error('Native strict executionStartedAt event schema');
   if(method==='readSession')return {...snapshot,session:{...session,sessionId:id},runtime:{activeTurnId:'own-turn',pendingRequestIds:[],herderSharedOwner:this.sharedOwner}};
   return super.call(channel,method,args);
  }
  async callIfReady(channel:string,method:string,args:unknown[]){
   this.calls.push({channel,method,args});
   if(method==='readSession'&&(args[0] as any).messageLimit!==1)throw Error('Native schema: messageLimit expected >0');
   return this.call(channel,method,args);
  }
 }
 const client=new OwnedPositiveClient(),adapter=new ZcodeAdapter({client,cwd:root,localDbPath:path,turnStartTimeoutMs:100});
 const workspace={workspacePath:root,workspaceIdentity:root,workspaceKey:root};
 try{
  await adapter.init();(adapter as any).sessionWorkspaces.set(id,workspace);
  expect(await (adapter as any).waitForTurnStart(id,workspace,input,'fixture',undefined,undefined)).toMatchObject({ok:true,turnId:'own-turn'});
  expect((adapter as any).observedActiveTurns.get(id)).toEqual({turnId:'own-turn',inputId:input});
  expect(await adapter.checkpointOwnedRuntimeShutdown()).toEqual([id]);
  client.sharedOwner='desktop';
  expect(await adapter.checkpointOwnedRuntimeShutdown()).toEqual([]);
  const guarded=client.calls.filter(call=>call.method==='readSession'&&(call.args[0] as any).messageLimit!==undefined);
  expect(guarded.length).toBeGreaterThanOrEqual(2);expect(guarded.every(call=>(call.args[0] as any).messageLimit===1)).toBe(true);
 }finally{await adapter.dispose();db.close();await rm(root,{recursive:true,force:true});}
});

it('uses exact native command receipts when strict event and message schemas reject reads (focused integration expected .3s/max5s)',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'zcode-sdk-drift-'));const path=join(dir,'native.sqlite');const db=new DatabaseSync(path);
 db.exec(`create table message(id text,session_id text,data text,sequence integer);create table turn_usage(session_id text,turn_id text,user_message_id text,status text,started_at integer,completed_at integer);`);
 const id='sdk-session';const input='exact-accepted-input';
 db.prepare('insert into message values(?,?,?,?)').run('native-user',id,JSON.stringify({role:'user',anchor:{sourceCommandId:'agent-herder:auto:'+input}}),1);
 db.prepare('insert into message values(?,?,?,?)').run('native-assistant',id,JSON.stringify({role:'assistant',parentID:'native-user'}),2);
 class StrictSchemaClient extends FakeClient {
  override async call(channel:string,method:string,args:unknown[]):Promise<unknown>{
   if(method==='readSessionEvents'){this.calls.push({channel,method,args});throw Error(JSON.stringify([{code:'unrecognized_keys',keys:['executionStartedAt'],path:['events',0,'payload']}]));}
   if(['readSessionMessages','readSession'].includes(method)){this.calls.push({channel,method,args});throw Error(JSON.stringify([{code:'invalid_value',path:['messages',0,'info','source']}]));}
   if(method==='sendPrompt'){
    const command=(args[0] as {inputId:string}).inputId;
    db.prepare('insert into message values(?,?,?,?)').run('later-user',id,JSON.stringify({role:'user',anchor:{sourceCommandId:command}}),3);
    db.prepare('insert into message values(?,?,?,?)').run('later-assistant',id,JSON.stringify({role:'assistant',parentID:'later-user'}),4);
   }
   return super.call(channel,method,args);
  }
 }
 const client=new StrictSchemaClient();const adapter=new ZcodeAdapter({client,cwd:dir,localDbPath:path,turnStartTimeoutMs:100});
 try{
  await expect(adapter.getMessageAdmission(id,input)).resolves.toEqual({state:'admitted'});
  await expect(adapter.getMessageAdmission(id,'other-input')).resolves.toMatchObject({state:'unknown'});
  expect(client.calls.some(c=>['sendPrompt','sendConversationCommandV4','resumeSession','createSession'].includes(c.method))).toBe(false);
  await expect(adapter.sendMessage(id,{message:'fixture only',inputId:'later-input'})).resolves.toEqual({ok:true});
  expect(client.calls.filter(c=>c.method==='sendPrompt')).toHaveLength(1);
  expect(client.calls.some(c=>['sendConversationCommandV4','resumeSession','createSession'].includes(c.method))).toBe(false);
 }finally{await adapter.dispose();db.close();await rm(dir,{recursive:true,force:true});}
});

it('retains the exact native workspace of a cold historical session for supported same-ID resume (fast unit expected .1s/max2s)',async()=>{
 const native={...session,sessionId:'cold-native',workspace:{workspacePath:'/exact-owned-project',workspaceIdentity:'/exact-owned-project'}};
 class ColdWorkspaceClient extends FakeClient {
  override async call(channel:string,method:string,args:unknown[]):Promise<unknown>{
   if(method==='readSession')throw Error('ZCode Agent runtime is not running.');
   if(method==='listSessions')return [native];
   if(method==='resumeSession'){this.calls.push({channel,method,args});return {...snapshot,session:native};}
   return super.call(channel,method,args);
  }
 }
 const client=new ColdWorkspaceClient(),adapter=new ZcodeAdapter({client,cwd:'/default-project'});
 try{
  expect((await adapter.getSession('cold-native'))?.meta?.nativeLoaded).toBe(false);
  await expect(adapter.resumeSession('cold-native')).resolves.toEqual({ok:true});
  expect(client.calls.find(c=>c.method==='resumeSession')?.args[0]).toMatchObject({sessionId:'cold-native',workspacePath:'/exact-owned-project'});
  expect(client.calls.some(c=>['sendPrompt','sendConversationCommandV4','createSession','setModel'].includes(c.method))).toBe(false);
 }finally{await adapter.dispose();}
});
