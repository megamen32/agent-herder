// The live canary of the native rename against the real Codex app-server.
//
// It talks to the running Codex daemon over its own control socket, creates one
// throwaway thread, renames it with a Cyrillic title, reads the title back
// natively, checks that the thread id and the history survived, and deletes
// the throwaway thread again. No model turn is started, so no quota is spent.
//
// Usage: node live-codex-rename-canary.mjs [socketPath]
import WebSocket from "ws";

const socketPath = process.argv[2]
  || `${process.env.HOME}/.codex/app-server-control/app-server-control.sock`;
const cwd = "/tmp/opencode/rename-canary";
const title = "Проверка переименования | кириллица | canary";

const socket = new WebSocket(`ws+unix:${socketPath}:/rpc`, { perMessageDeflate: false });
const pending = new Map();
let nextId = 1;

const call = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

socket.on("message", (data) => {
  const message = JSON.parse(data.toString());
  if (message.id === undefined || !pending.has(message.id)) return;
  const entry = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(`${message.error.message} (${message.error.code})`));
  else entry.resolve(message.result);
});

const evidence = { socketPath, cwd, title, steps: [] };
const step = (name, value) => { evidence.steps.push({ name, value }); console.log(name, JSON.stringify(value)); };

socket.on("open", async () => {
  try {
    await call("initialize", { clientInfo: { name: "agent-herder-rename-canary", title: "Agent Herder rename canary", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    socket.send(JSON.stringify({ method: "initialized", params: {} }));
    step("initialized", { ok: true });

    const started = await call("thread/start", { cwd });
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error("thread/start returned no thread id");
    step("thread_start", { threadId, ephemeral: started.thread.ephemeral ?? null });

    const before = await call("thread/read", { threadId, includeTurns: false });
    step("title_before", { name: before?.thread?.name ?? null, preview: before?.thread?.preview ?? null });

    await call("thread/name/set", { threadId, name: title });
    const after = await call("thread/read", { threadId, includeTurns: false });
    step("title_after", { name: after?.thread?.name ?? null, sameThread: after?.thread?.id === threadId });

    const withTurns = await call("thread/read", { threadId, includeTurns: true });
    step("history_after", { turns: Array.isArray(withTurns?.thread?.turns) ? withTurns.thread.turns.length : null });

    const listed = await call("thread/list", { limit: 50, archived: false, sortKey: "updated_at", sortDirection: "desc" });
    const row = (listed?.data || []).find((item) => item.id === threadId);
    step("title_in_list", { found: Boolean(row), name: row?.name ?? null });

    await call("thread/delete", { threadId });
    const gone = await call("thread/read", { threadId, includeTurns: false });
    step("cleanup", { threadPresent: Boolean(gone?.thread?.id) });
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    console.error("canary failed:", evidence.error);
  } finally {
    socket.close();
    process.exit(evidence.error ? 1 : 0);
  }
});

socket.on("error", (error) => {
  evidence.error = error.message;
  console.error("socket error:", error.message);
  process.exit(1);
});
