import readline from "node:readline";

const thread = (id = "thread-1", overrides = {}) => ({
  id,
  sessionId: id,
  cwd: "/tmp/codex-fixture",
  path: "/tmp/codex-fixture",
  preview: "Fixture thread",
  modelProvider: "openai",
  model: "gpt-test",
  status: "idle",
  createdAt: "2026-07-19T00:00:00.000Z",
  updatedAt: "2026-07-19T00:00:01.000Z",
  ...overrides,
});

let activeTurnId = null;
let nextId = 0;
const threads = [thread()];

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function notify(method, params) {
  process.stdout.write(`${JSON.stringify({ method, params })}\n`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") return reply(request.id, { userAgent: "fake-codex/1" });
  if (request.method === "initialized") return;
  if (request.method === "thread/list") return reply(request.id, { data: threads });
  if (request.method === "thread/start") {
    const created = thread(`thread-created-${threads.length}`, {
      cwd: request.params.cwd || "/tmp/codex-fixture",
      path: request.params.cwd || "/tmp/codex-fixture",
      preview: "",
    });
    threads.push(created);
    return reply(request.id, {
      approvalPolicy: "never",
      cwd: created.cwd,
      model: "gpt-test",
      modelProvider: "openai",
      sandbox: "workspace-write",
      thread: created,
    });
  }
  if (request.method === "thread/name/set") {
    const target = threads.find((item) => item.id === request.params.threadId);
    if (target) target.name = request.params.name;
    return reply(request.id, {});
  }
  if (request.method === "thread/resume") return reply(request.id, {
    approvalPolicy: "never",
    cwd: "/tmp/codex-fixture",
    model: request.params.model || "gpt-test",
    modelProvider: "openai",
    sandbox: "workspace-write",
    thread: thread(request.params.threadId),
  });
  if (request.method === "thread/fork") return reply(request.id, {
    approvalPolicy: "never",
    cwd: "/tmp/codex-fixture",
    model: "gpt-test",
    modelProvider: "openai",
    sandbox: "workspace-write",
    thread: thread("thread-fork-1"),
  });
  if (request.method === "turn/interrupt") {
    activeTurnId = null;
    notify("turn/completed", { threadId: request.params.threadId, turn: { id: request.params.turnId, status: "interrupted" } });
    return reply(request.id, {});
  }
  if (request.method === "turn/start") {
    activeTurnId = `turn-${++nextId}`;
    notify("turn/started", { threadId: request.params.threadId, turn: { id: activeTurnId, status: "inProgress" } });
    if (request.params.input?.[0]?.text === "hold") return reply(request.id, { turn: { id: activeTurnId, status: "inProgress" } });
    notify("item/agentMessage/delta", { threadId: request.params.threadId, turnId: activeTurnId, itemId: "item-1", delta: "done" });
    notify("turn/completed", { threadId: request.params.threadId, turn: { id: activeTurnId, status: "completed" } });
    activeTurnId = null;
    return reply(request.id, { turn: { id: `turn-${nextId}`, status: "completed" } });
  }
  reply(request.id, {});
});
