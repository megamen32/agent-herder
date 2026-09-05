import { describe, expect, it } from "vitest";
import type { ZcodeClientLike } from "../src/adapters/zcode-protocol.js";
import { ZcodeAdapter } from "../src/adapters/zcode.js";
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

  async start(): Promise<void> { this.started = true; }
  async close(): Promise<void> { this.closed = true; }

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
