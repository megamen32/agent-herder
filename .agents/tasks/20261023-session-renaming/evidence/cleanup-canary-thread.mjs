// Removes the throwaway thread of the rename canary.
//
// The daemon refuses to delete a thread it has not loaded, so the thread is
// resumed first and deleted afterwards. Nothing else is touched.
import WebSocket from "ws";

const socketPath = process.argv[2]
  || `${process.env.HOME}/.codex/app-server-control/app-server-control.sock`;
const threadId = process.argv[3];
if (!threadId) {
  console.error("usage: cleanup-canary-thread.mjs [socketPath] <threadId>");
  process.exit(2);
}

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

socket.on("open", async () => {
  try {
    await call("initialize", { clientInfo: { name: "agent-herder-rename-canary-cleanup", title: "Agent Herder rename canary cleanup", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    socket.send(JSON.stringify({ method: "initialized", params: {} }));
    try {
      const resumed = await call("thread/resume", { threadId });
      console.log("resume", JSON.stringify({ id: resumed?.thread?.id ?? null, name: resumed?.thread?.name ?? null }));
    } catch (error) {
      console.log("resume failed:", error.message);
    }
    try {
      await call("thread/delete", { threadId });
      console.log("delete ok");
    } catch (error) {
      console.log("delete failed:", error.message);
    }
    try {
      const read = await call("thread/read", { threadId, includeTurns: false });
      console.log("read after cleanup", JSON.stringify({ present: Boolean(read?.thread?.id), name: read?.thread?.name ?? null }));
    } catch (error) {
      console.log("read after cleanup failed:", error.message);
    }
  } catch (error) {
    console.error("cleanup failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    socket.close();
  }
});
socket.on("error", (error) => { console.error("socket error:", error.message); process.exit(1); });
