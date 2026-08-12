import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import readline from "node:readline";

const cwd = "/home/roomhacker/agents-projects/agent-herder";
const prompt = "Reply only: NATIVE_ADMISSION_PROBE_OK. Do not use tools, modify files, or run commands.";
const clientMessageId = `native-admission-probe-${randomUUID()}`;
const child = spawn("codex", ["app-server", "--stdio"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
const lifecycle = [];
const pending = new Map();
const stderrCategories = new Set();
let nextId = 1;
let threadId;
let turnId;
let timer;

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    // Register before writing: app-server can answer a compact request before
    // the pipe write callback returns.
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ method, params })}\n`);
}

function record(message) {
  const params = message.params || {};
  if (message.method === "turn/started" || message.method === "turn/completed") {
    lifecycle.push({
      method: message.method,
      threadId: typeof params.threadId === "string" ? params.threadId : undefined,
      turnId: typeof params.turn?.id === "string" ? params.turn.id : typeof params.turnId === "string" ? params.turnId : undefined,
      status: params.turn?.status,
      clientMessageId: typeof params.clientMessageId === "string" ? params.clientMessageId : undefined,
    });
  } else if (message.method === "error") {
    lifecycle.push({
      method: "error",
      threadId: typeof params.threadId === "string" ? params.threadId : undefined,
      turnId: typeof params.turnId === "string" ? params.turnId : undefined,
    });
  }
}

function redactId(value) {
  if (typeof value !== "string" || !value) return undefined;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function redactLifecycle() {
  return lifecycle.map((event) => ({
    method: event.method,
    threadBound: event.threadId === threadId,
    turnBound: event.turnId === turnId,
    status: event.status,
    clientMessageKeyBinding: event.clientMessageId === undefined
      ? "absent"
      : event.clientMessageId === clientMessageId ? "match" : "different",
  }));
}

function categorizeStderr(chunk) {
  const text = String(chunk);
  if (/stale arg0 temp dirs/i.test(text) && /permission denied/i.test(text)) stderrCategories.add("stale-arg0-cleanup-permission-warning");
  else if (text.trim()) stderrCategories.add("other-redacted-stderr");
}

const rl = readline.createInterface({ input: child.stdout });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  record(message);
  if (message.id !== undefined) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message || `RPC error ${message.error.code || "unknown"}`));
    else waiter.resolve(message.result);
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", categorizeStderr);

child.on("exit", (code, signal) => {
  for (const waiter of pending.values()) waiter.reject(new Error(`app-server exited: ${code ?? signal ?? "unknown"}`));
  pending.clear();
});

async function main() {
  const initialize = await send("initialize", {
    clientInfo: { name: "agent-herder-native-admission-probe", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  notify("initialized", {});
  const started = await send("thread/start", { cwd });
  threadId = started?.thread?.id;
  if (typeof threadId !== "string" || !threadId) throw new Error("thread/start did not return a thread id");
  const turn = await send("turn/start", {
    threadId,
    input: [{ type: "text", text: prompt }],
    clientMessageId,
  });
  turnId = turn?.turn?.id;
  const deadline = Date.now() + 30_000;
  while (!lifecycle.some((item) => item.method === "turn/completed" && item.turnId === turnId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  console.log(JSON.stringify({
    appServerVersion: typeof initialize?.userAgent === "string" ? initialize.userAgent : "redacted/unknown",
    cwd,
    threadId: redactId(threadId),
    clientMessageKey: redactId(clientMessageId),
    turnId: redactId(turnId),
    turnStartStatus: turn?.turn?.status,
    lifecycle: redactLifecycle(),
    completed: lifecycle.some((item) => item.method === "turn/completed" && item.turnId === turnId),
    stderrCategories: [...stderrCategories],
  }, null, 2));
}

timer = setTimeout(() => {
  console.error("probe timeout");
  process.exitCode = 2;
}, 35_000);

try { await main(); } catch (error) {
  console.log(JSON.stringify({
    cwd,
    clientMessageKey: redactId(clientMessageId),
    error: error instanceof Error ? error.message : String(error),
    lifecycle: redactLifecycle(),
    stderrCategories: [...stderrCategories],
  }, null, 2));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  child.kill();
}
