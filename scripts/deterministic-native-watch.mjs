#!/usr/bin/env node
// A finite observer only: no prompts, native resumes, LLM, shared ledger writes or daemon.
import { readFile, stat, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const UID_ROOT = "/sys/fs/cgroup/user.slice/user-1000.slice";
const SOCKET = "/home/roomhacker/.codex/app-server-control/app-server-control.sock";
const STATE = "/home/roomhacker/ServersAdministartion/.tmp/fleet-codex-watch-20261007/monitor/state.json";
const GIB = 1024 ** 3;

export function classifyRecoveryObservation(session, durable, owner, resources, now = Date.now()) {
  if (!session) return "native access unavailable";
  if (session.status === "running" || session.meta?.activeTurnId) return "native turn already active";
  if (session.status === "needs_input" || session.needsPermission) return "native user input or permission required";
  if (session.meta?.automationStop) return "native human-stop evidence requires explicit owner review";
  const last = session.meta?.nativeLastTurn;
  const matchingDisconnect = durable?.recoveryCause === "process.disconnected" && durable?.recoveryTurnId === last?.turnId;
  const matchingFailure = durable?.recoveryCause === "turn.failed" && durable?.recoveryTurnId === last?.turnId && ["failed", "error"].includes(last?.status);
  if (!last?.turnId || !(matchingDisconnect || matchingFailure)) return "no exact native failure/disconnect proof";
  if (!owner || owner.taskState !== "active") return "owning task has no active recovery grant";
  if (["recoveryBlockedReason", "resourceBlockedReason", "stdioBlocker", "blocker"].some(k => typeof owner[k] === "string" && owner[k].trim())) return "owning task retains a blocker";
  if (!resources || !["observedAt", "psiSome", "psiFull", "hostAvailable", "uidEffectiveSpare"].every(k => Number.isFinite(resources[k]))
    || now < resources.observedAt || now - resources.observedAt > 5000 || resources.psiSome > 0 || resources.psiFull > 0
    || resources.hostAvailable < 20 * GIB || resources.uidEffectiveSpare < 2.5 * GIB) return "fresh reserve/PSI gate holds";
  return "eligible proof observed; runtime admission and same-turn control receipt still required";
}
async function text(path, maxBytes = 16 * 1024 * 1024) {
  const size = (await stat(path)).size;
  if (size > maxBytes) throw new Error("bounded input budget exceeded");
  return readFile(path, "utf8");
}
function finiteLimit(value) { const n = Number(value.trim()); return value.trim() !== "max" && Number.isFinite(n) ? n : Infinity; }
async function resources() {
  const [memory, psi, current, high, hard] = await Promise.all([
    text("/proc/meminfo", 65536), text("/proc/pressure/memory", 4096),
    text(UID_ROOT + "/memory.current", 128), text(UID_ROOT + "/memory.high", 128), text(UID_ROOT + "/memory.max", 128),
  ]);
  const fields = Object.fromEntries(memory.split("\n").map(line => { const m = line.match(/^(\w+):\s+(\d+)/); return m ? [m[1], Number(m[2]) * 1024] : ["", 0]; }));
  const avg = name => Number(psi.match(new RegExp(name + ".*?avg10=([\\d.]+)"))?.[1] ?? NaN);
  const used = Number(current.trim()), soft = finiteLimit(high), max = finiteLimit(hard);
  return { observedAt: Date.now(), hostAvailable: fields.MemAvailable, uidSoftSpare: Number.isFinite(soft) ? soft - used : null,
    uidHardSpare: Number.isFinite(max) ? max - used : null, uidEffectiveSpare: Math.min(soft, max) - used,
    psiSome: avg("some"), psiFull: avg("full") };
}
async function atomicReceipt(path, receipt) {
  const bytes = JSON.stringify(receipt);
  if (Buffer.byteLength(bytes) > 1024 * 1024) throw new Error("receipt budget exceeded");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const pending = path + "." + process.pid + ".pending";
  await writeFile(pending, bytes, { mode: 0o600 });
  await rename(pending, path);
}
// The established app-server Unix WS read protocol, without raw-index/ORM imports.
export function compactNativeSnapshot(id, thread, turns) {
  if (thread?.id !== id || !Array.isArray(turns?.data)) return undefined;
  const raw = typeof thread.status === "object" ? thread.status?.type : thread.status;
  const flags = typeof thread.status === "object" ? thread.status?.activeFlags ?? [] : [];
  const latest = turns.data[0];
  const active = turns.data.find(turn => turn.status === "inProgress" && typeof turn.id === "string");
  const recognized = ["active", "inProgress", "running", "error", "failed", "systemError", "idle", "notLoaded", "interrupted", "completed"];
  if (!recognized.includes(raw)) return undefined;
  return { id, status: active || ["active", "inProgress", "running"].includes(raw) ? "running" : "idle",
    needsPermission: flags.includes("waitingOnApproval"),
    meta: { activeTurnId: active?.id, nativeLastTurn: typeof latest?.id === "string" && typeof latest.status === "string"
      ? { turnId: latest.id, status: latest.status } : undefined } };
}
async function nativeReader(socketPath) {
  const { default: WebSocket } = await import("ws");
  const socket = new WebSocket(`ws+unix:${socketPath}:/rpc`, { perMessageDeflate: false, handshakeTimeout: 1500, maxPayload: 1024 * 1024 });
  const pending = new Map(); let nextId = 1;
  socket.on("message", bytes => {
    try {
      const value = JSON.parse(bytes.toString());
      if (value.method || !pending.has(value.id)) return; // Ignore all broadcasts, dialogue and server requests.
      const request = pending.get(value.id); pending.delete(value.id); clearTimeout(request.timer);
      if (value.error) request.reject(new Error("native read rejected")); else request.resolve(value.result);
    } catch {}
  });
  const fail = () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("native socket unavailable")); } pending.clear(); };
  socket.on("error", fail); socket.on("close", fail);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); socket.once("close", () => reject(new Error("native socket closed"))); });
  const request = (method, params) => {
    if (!["initialize", "thread/read", "thread/turns/list"].includes(method)) throw new Error("read-only method gate");
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("native read timed out")); }, 1500);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }), error => { if (error) { clearTimeout(timer); pending.delete(id); reject(error); } });
    });
  };
  try {
    await request("initialize", { clientInfo: { name: "agent-herder-native-observer", title: "Finite native observer", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    socket.send(JSON.stringify({ method: "initialized", params: {} }));
  } catch (error) { socket.close(); throw error; }
  return {
    async getSession(id) {
      const snapshot = await request("thread/read", { threadId: id, includeTurns: false });
      const turns = await request("thread/turns/list", { threadId: id, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
      return compactNativeSnapshot(id, snapshot?.thread, turns);
    },
    async dispose() { fail(); socket.close(); },
  };
}

export async function runNativeWatch(args) {
  const targets = args.filter(arg => /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(arg));
  if (targets.length < 1 || targets.length > 2 || new Set(targets).size !== targets.length) throw new Error("one or two explicit existing thread IDs required");
  if (!(await stat(SOCKET)).isSocket()) throw new Error("existing native Unix socket unavailable");
  const root = resolve(new URL("..", import.meta.url).pathname);
  const receiptPath = resolve(root, ".tmp/broken-session-continuator/native-watch.json");
  const adapter = await nativeReader(SOCKET);
  const started = Date.now(), deadline = started + 40000;
  const receipt = { version: 1, startedAt: new Date(started).toISOString(), readOnly: true, llmCalls: 0,
    nativeControls: 0, sharedLedgerWrites: 0, checks: 0, targets: {}, maxRssBytes: 0, runtimeState: "observing" };
  try {
    for (let check = 0; check < 6 && Date.now() < deadline - 6000; check++) {
      const rss = process.memoryUsage().rss;
      receipt.maxRssBytes = Math.max(receipt.maxRssBytes, rss);
      if (rss > 128 * 1024 * 1024) throw new Error("observer soft RSS budget reached");
      let state = {}, durable = { sessions: [] }, measured;
      try { state = JSON.parse(await text(STATE)); } catch {}
      try { durable = JSON.parse(await text("/home/roomhacker/.local/state/agent-herder/autopilot-live/unfinished-sessions.json")); } catch {}
      try { measured = await resources(); } catch {}
      for (const id of targets) {
        let session;
        try { session = await adapter.getSession(id); } catch {}
        const record = durable.sessions?.find(row => row.harness === "codex" && row.sessionId === id);
        const age = typeof state.utc === "string" ? Date.now() - Date.parse(state.utc) : Infinity;
        const owner = age >= 0 && age < 30 * 60 * 1000 ? state.registry?.[id] : undefined;
        receipt.targets[id] = { sessionId: id, owningHost: "server-100", observedAt: new Date().toISOString(),
          nativeStatus: session?.status ?? "access unavailable", activeTurnId: session?.meta?.activeTurnId ?? null,
          latestTurnId: session?.meta?.nativeLastTurn?.turnId ?? null, latestTurnStatus: session?.meta?.nativeLastTurn?.status ?? null,
          recoveryCause: record?.recoveryCause ?? null,
          decision: "HOLD", reason: classifyRecoveryObservation(session, record, owner, measured) };
      }
      receipt.checks++; receipt.resources = measured ?? { access: "unavailable" };
      receipt.maxRssBytes = Math.max(receipt.maxRssBytes, process.memoryUsage().rss);
      await atomicReceipt(receiptPath, receipt);
      if (check < 5 && Date.now() + 11000 < deadline) await new Promise(resolve => setTimeout(resolve, 5000));
    }
    receipt.runtimeState = "finished";
  } finally {
    await adapter.dispose();
    receipt.finishedAt = new Date().toISOString();
    receipt.maxRssBytes = Math.max(receipt.maxRssBytes, process.memoryUsage().rss);
    await atomicReceipt(receiptPath, receipt);
    console.log(JSON.stringify({ receiptPath, checks: receipt.checks, maxRssBytes: receipt.maxRssBytes,
      llmCalls: 0, nativeControls: 0, targets: receipt.targets }));
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runNativeWatch(process.argv.slice(2)).catch(() => { console.error("finite native watcher failed; inspect compact receipt"); process.exitCode = 1; });
}
