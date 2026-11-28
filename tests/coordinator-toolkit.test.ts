import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { registerSessionTools } from "../src/mcp/session-tools.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";

it("advertises project memory to a plain MCP coordinator", async () => {
  const server = new McpServer({ name: "herder", version: "1" });
  const events = new HerderEventBus();
  registerSessionTools(server, {
    adapters: new Map(),
    events,
    jobs: new HerderJobRegistry(events),
    routingPeers: [],
  });
  const client = new Client({ name: "plain", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain(
      "project_memory",
    );
  } finally {
    await client.close();
    await server.close();
  }
});

import { hostname, tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentSession,
  HarnessAdapter,
  SessionMessageView,
} from "../src/types/index.js";
import { trustedMeshIngressForOwnerStdio } from "../src/mesh/authenticated-ingress.js";
import { registerControlPlaneTools } from "../src/mcp/control-plane-tools.js";
import { CoordinationNoteStore } from "../src/coordination-notes.js";
import { registerHumanRequestTools } from "../src/mcp/human-request-tools.js";
import { registerResumeAfterTools } from "../src/mcp/resume-after-tools.js";
import { withToolConsolidation } from "../src/mcp/tool-consolidation.js";
import { HumanRequestRegistry } from "../src/human-request/registry.js";
import { ResumeAfterService } from "../src/resume-after.js";
import { GoalStore } from "../src/autopilot/goal-store.js";
import { resolveAutopilotStateDir } from "../src/autopilot/state-dir.js";
import type { PendingHumanQuestion } from "../src/autopilot/index.js";
import { SessionSupervisor } from "../src/session-supervisor.js";

it("coordinates two native workers using only Herder MCP tools", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "herder-coordinator-"));
  const project = "integration",
    source = { harness: "codex", sessionId: "lead", cwd };
  const original = "  Keep the original wording.\nInclude both workers.  ";
  const goals = new GoalStore(resolveAutopilotStateDir());
  await goals.arm({
    identity: source,
    goal: { eventId: "u1", text: original },
    requirements: [],
  });
  const events = new HerderEventBus(),
    jobs = new HerderJobRegistry(events, {
      persistencePath: join(cwd, "jobs.json"),
    });
  const sessions = new Map<string, AgentSession>(),
    history = new Map<string, SessionMessageView[]>();
  const adapter: HarnessAdapter = {
    type: "codex",
    name: "fake worker",
    async init() {},
    async listSessions() {
      return [...sessions.values()];
    },
    async getSession(id) {
      return sessions.get(id) ?? null;
    },
    async createSession(options) {
      const id = options.name;
      const session: AgentSession = {
        id,
        harness: "codex",
        hostId: hostname(),
        title: id,
        cwd,
        status: "running",
        lastActivity: new Date().toISOString(),
        needsPermission: false,
      };
      sessions.set(id, session);
      history.set(id, []);
      return session;
    },
    async getSessionMessagesPage(id) {
      return {
        sessionId: id,
        source: "native-db",
        complete: true,
        messages: [...(history.get(id) ?? [])],
      };
    },
    async sendMessage(id, options) {
      const entries = history.get(id)!;
      entries.push({
        id: "in-" + entries.length,
        role: "user",
        text: options.message,
        parts: [],
      });
      if (options.inputId === "follow") {
        entries.push({
          id: "reply",
          role: "assistant",
          text: "Ready A",
          turnId: "follow-turn",
          parts: [],
        });
        sessions.get(id)!.status = "idle";
        sessions.get(id)!.meta = {
          nativeLastTurn: { turnId: "follow-turn", status: "completed" },
        };
      }
      return {
        ok: true,
        admitted: true,
        inputId: options.inputId,
        turnId: "follow-turn",
      };
    },
    async stopSession() {
      return { ok: true };
    },
    async respondPermission() {
      return { ok: true };
    },
    async setPermissions() {
      return { ok: true };
    },
  };
  const questions = new HumanRequestRegistry(join(cwd, "questions.json")),
    cards: PendingHumanQuestion[] = [];
  const answers: string[] = [];
  const waits = new ResumeAfterService({
    directory: join(cwd, "waits"),
    isHeld: async () => false,
    isBusy: async () => false,
    deliver: async () => ({ status: "accepted" }),
  });
  const server = new McpServer({ name: "herder", version: "1" }),
    client = new Client({ name: "plain-client", version: "1" });
  withToolConsolidation(
    server,
    () => {
      registerSessionTools(server, {
        adapters: new Map([["codex", adapter]]),
        jobs,
        events,
        routingPeers: [],
        trustedIngress: trustedMeshIngressForOwnerStdio(),
      });
      registerControlPlaneTools(server, {
        jobs,
        events,
        coordination: new CoordinationNoteStore(
          join(cwd, "notes.json"),
          events,
        ),
      });
      registerHumanRequestTools(server, questions, {
        decisionProducer: async () => ({
          source: "herder_config",
          project: "test",
          recipient: "test",
          endpoint: "http://fixture.invalid/v1/human-requests",
          token: "fixture",
        }),
        fetchDecisionResult: async (url) => {
          const id = cards[0]?.request_id;
          expect(new URL(String(url)).pathname).toBe(
            "/v1/human-requests/" + id + "/result",
          );
          return Response.json({
            kind: "user",
            schema: "ask_human.result.v1",
            request_id: id,
            state: "resolved",
            answer: "yes",
            result_ref: "result://fixture/yes",
            native: cards[0].native_target,
          });
        },
        deliverDecision: async (card) => {
          cards.push(card);
        },
        humanResume: async (req) => {
          answers.push(
            ("session_id" in req.target ? req.target.session_id : "") +
              " " +
              req.result_ref,
          );
          return {
            status: "accepted",
            target: req.target,
            result_ref: req.result_ref,
            receipt_ref: "fake-resume",
            idempotency_key: req.idempotency_key,
          };
        },
      });
      registerResumeAfterTools(server, waits, questions);
    },
    new Set(),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError)
      throw new Error(name + " " + JSON.stringify(result.content));
    return (result.structuredContent ??
      JSON.parse(result.content[0].text)) as Record<string, any>;
  };
  try {
    await server.connect(b);
    await client.connect(a);
    const observed = await call("human_messages", source);
    const humanCitations = [
      { ...source, eventId: observed.messages[0].eventId },
    ];
    for (const name of ["A", "B"]) {
      const receipt = await call("deliver", {
        project,
        harness: "codex",
        name,
        cwd,
        message: "Implement " + name,
        humanCitations,
        inputId: "start-" + name,
      });
      expect(receipt).toMatchObject({ ok: true, sessionId: name });
      const prompt = history.get(name)![0]!.text!;
      expect(prompt).toContain(JSON.stringify(original));
      expect(prompt).toContain('"author":"human"');
      expect(prompt).toContain(observed.messages[0].at);
      const envelope = prompt
        .split("\n")
        .find((line) =>
          line.startsWith('{"schema":"herder.coordinator-message.v1"'),
        )!;
      expect((await call("human_messages", { envelope })).verified).toBe(true);
      expect(
        (
          await call("human_messages", {
            envelope: envelope.replace("original wording", "invented wording"),
          })
        ).verified,
      ).toBe(false);
    }
    const response = await call("send_message", {
      harness: "codex",
      sessionId: "A",
      mode: "sync",
      awaitMs: 3000,
      inputId: "follow",
      message: "Report back",
      humanCitations,
    });
    expect(response.response).toMatchObject({ text: "Ready A" });
    const supervisor = new SessionSupervisor(
      new Map([["codex", adapter]]),
      {} as never,
      undefined,
      { events },
    );
    const progress = call("session_await", {
      sessionIds: ["B"],
      includeMessages: true,
      afterSequence: response.cursor,
      timeoutMs: 1000,
    });
    setTimeout(
      () =>
        supervisor["handleHarnessEvent"]("codex", {
          harness: "codex",
          sessionId: "B",
          kind: "message.updated",
          messageId: "progress",
        }),
      10,
    );
    const update = await progress;
    expect(update.message.uri).toBe("herder://sessions/codex/B/messages");
    const waiting = call("session_await", {
      sessionIds: ["B"],
      afterSequence: update.cursor,
      timeoutMs: 2000,
    });
    setTimeout(
      () =>
        supervisor["handleHarnessEvent"]("codex", {
          harness: "codex",
          kind: "turn.completed",
          sessionId: "B",
          completionState: {
            sessionId: "B",
            turnId: "finish-B",
            state: "finished",
            outcome: "completed",
            finishedAt: new Date().toISOString(),
            lastAssistantMessage: "Ready B",
          },
        }),
      20,
    );
    expect((await waiting).completion).toMatchObject({
      sessionId: "B",
      lastAssistantMessage: "Ready B",
    });
    const question = await call("human_request", {
      action: "create",
      kind: "user",
      ...source,
      message: "Publish?",
      choices: [
        { choiceId: "yes", label: "Publish" },
        { choiceId: "no", label: "Hold" },
      ],
      recommendedChoiceId: "yes",
    });
    expect(cards[0]?.question.choices?.[0]).toEqual({
      choice_id: "yes",
      label: "Publish (recommended)",
    });
    const again = await call("human_request", {
      action: "create",
      kind: "user",
      ...source,
      message: "Publish?",
      choices: [
        { choiceId: "yes", label: "Publish" },
        { choiceId: "no", label: "Hold" },
      ],
      recommendedChoiceId: "yes",
    });
    expect(again.request.requestId).toBe(question.request.requestId);
    const answer = await call("human_request", {
      action: "resolve",
      requestId: question.request.requestId,
      resolutionRef: "result://fixture/yes",
    });
    expect(answer.resume.status).toBe("resumed");
    expect(
      await call("human_request", {
        action: "get",
        requestId: question.request.requestId,
        includeAnswer: true,
      }),
    ).toMatchObject({ answer: "yes" });
    expect(answers).toEqual(["lead result://fixture/yes"]);
    const wake = await call("resume_after", {
      action: "wait",
      owner: { harness: "codex", sessionId: "lead" },
      requestId: "later",
      message: "Check progress",
      trigger: { kind: "delay", delayMs: 60000 },
    });
    expect(wake.wait.state).toBe("waiting");
    expect(
      (
        await call("project_memory", {
          project,
          action: "write",
          ifMatch: 0,
          text: "Reviewed",
        })
      ).revision,
    ).toBe(1);
    expect(
      await call("project_memory", {
        project,
        action: "write",
        ifMatch: 0,
        text: "Stale",
      }),
    ).toMatchObject({ error: "revision_conflict", revision: 1 });
    const target = { project, harness: "codex", sessionId: "A" };
    const digest = await call("session_info", {
      sessionId: "A",
      harness: "codex",
      view: "digest",
      limit: 1,
    });
    expect(digest.conversation.messages[0].text).toBe("Ready A");
    const earlier = await call("session_info", {
      sessionId: "A",
      harness: "codex",
      view: "digest",
      beforeMessageId: digest.conversation.beforeMessageId,
      limit: 1,
    });
    expect(earlier.conversation.messages[0].role).toBe("user");
    await call("message_reaction", {
      ...target,
      messageId: "reply",
      ack: { actor: "lead", reaction: "👍" },
    });
    expect(
      (await call("message_reaction", { ...target, messageId: "reply" }))
        .reactions,
    ).toHaveLength(1);
    await call("worker", {
      ...target,
      action: "update",
      state: "review-ready",
      prs: ["https://github.com/example/test/pull/1"],
    });
    expect(
      (await call("worker", { project, action: "list" })).workers[0].prs,
    ).toHaveLength(1);
    for (const sessionId of ["A", "B"])
      await call("worker", {
        project,
        action: "resolve",
        harness: "codex",
        sessionId,
      });
    expect(
      (await call("worker", { project, action: "list" })).workers.map(
        (w: any) => w.state,
      ),
    ).toEqual(["done", "done"]);
  } finally {
    await client.close();
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

import { createServer } from "node:http";
import { once } from "node:events";
import { vi } from "vitest";
import { registerCoordinatorTools } from "../src/mcp/coordinator-tools.js";

it("wakes on a changed URL and sends the held updates as one Notice digest", async () => {
  let status = "running";
  const notices: Record<string, unknown>[] = [];
  const fixture = createServer(async (req, res) => {
    if (req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      notices.push(JSON.parse(Buffer.concat(chunks).toString()));
    }
    res.end(status);
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const addr = fixture.address();
  if (!addr || typeof addr === "string") throw new Error("missing TCP fixture");
  const origin = "http://127.0.0.1:" + addr.port;
  vi.stubEnv("AGENT_HERDER_WATCH_ORIGINS", origin);
  vi.stubEnv("NOTIFY_CENTER_EVENT_URL", origin + "/notice");
  vi.stubEnv("NOTIFY_CENTER_TOKEN", "test-only");
  const server = new McpServer({ name: "herder", version: "1" }),
    client = new Client({ name: "plain", version: "1" });
  registerCoordinatorTools(server, async () => null);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args });
    if (response.isError) throw new Error(JSON.stringify(response.content));
    return response.structuredContent as Record<string, any>;
  };
  try {
    await server.connect(b);
    await client.connect(a);
    const url = origin + "/status";
    const initial = await call("watch_url", { url });
    const change = call("watch_url", {
      url,
      revision: initial.revision,
      timeoutMs: 3000,
    });
    setTimeout(() => {
      status = "done";
    }, 20);
    expect(await change).toMatchObject({ changed: true });
    const digest = (args: Record<string, unknown>) =>
      call("project_digest", { project: "digest", ...args });
    await digest({ action: "presence", quietMs: 60000 });
    await digest({ action: "queue", id: "A", text: "First" });
    await digest({ action: "queue", id: "B", text: "Second" });
    expect(
      await digest({ action: "flush", batchId: "report", send: true }),
    ).toMatchObject({ held: true });
    expect(notices).toEqual([]);
    await digest({ action: "presence", quietMs: 0 });
    expect(
      await digest({ action: "flush", batchId: "report", send: true }),
    ).toMatchObject({ sent: true, digest: "First\nSecond" });
    expect(
      await digest({ action: "flush", batchId: "next", send: true }),
    ).toMatchObject({ digest: "" });
    expect(notices.map((n) => n.body)).toEqual(["First\nSecond"]);
  } finally {
    vi.unstubAllEnvs();
    await client.close();
    await server.close();
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
});

import { recordGoalHumanInput } from "../src/web/autopilot-goal-api.js";
import {
  readHumanMessages,
  renderCoordinatorMessage,
  verifyCoordinatorMessage,
} from "../src/coordinator-citations.js";
it("cites an ordinary owner composer input without an armed goal and keeps a quoted envelope in the instruction field", async () => {
  const source = {
    harness: "codex",
    sessionId: "unarmed",
    cwd: "/tmp/unarmed",
  };
  const text = "  Preserve\n whitespace. ";
  await recordGoalHumanInput({ ...source, text, inputId: "owner-1" });
  await recordGoalHumanInput({ ...source, text, inputId: "owner-1" });
  const rows = await readHumanMessages(source);
  expect(rows).toHaveLength(1);
  const envelope = await renderCoordinatorMessage("Implement", [
    { ...source, eventId: rows[0].eventId },
  ]);
  expect(verifyCoordinatorMessage(envelope)).toMatchObject({
    verified: true,
    humanMessages: [{ text, at: rows[0].at }],
  });
  const imitation = await renderCoordinatorMessage(envelope);
  expect(verifyCoordinatorMessage(imitation)).toMatchObject({
    verified: true,
    instructions: envelope,
    humanMessages: [],
  });
  await expect(
    renderCoordinatorMessage("Implement", [{ ...source, eventId: "invented" }]),
  ).rejects.toThrow(/receipt/);
});

import { createWebServer } from "../src/web/server.js";
it("changes the opted-in status URL for an intermediate worker message only on its own thread", async () => {
  const events = new HerderEventBus();
  const supervisor = new SessionSupervisor(new Map(), {} as never, undefined, {
    events,
  });
  const web = createWebServer({
    adapters: new Map(),
    converter: {} as never,
    supervisor,
    herderEvents: events,
    sessionObservationManagedExternally: true,
  });
  web.listen(0, "127.0.0.1");
  await once(web, "listening");
  const addr = web.address();
  if (!addr || typeof addr === "string") throw new Error("missing TCP fixture");
  const url =
    "http://127.0.0.1:" +
    addr.port +
    "/api/sessions/codex/B/status?includeMessages=1";
  try {
    const before = await (await fetch(url)).json();
    supervisor["handleHarnessEvent"]("codex", {
      kind: "message.updated",
      harness: "codex",
      sessionId: "A",
    });
    expect(await (await fetch(url)).json()).toEqual(before);
    supervisor["handleHarnessEvent"]("codex", {
      kind: "message.updated",
      harness: "codex",
      sessionId: "B",
    });
    expect(await (await fetch(url)).json()).toMatchObject({
      messageRevision: before.messageRevision + 1,
    });
  } finally {
    web.closeAllConnections();
    await new Promise<void>((resolve) => web.close(() => resolve()));
  }
});
