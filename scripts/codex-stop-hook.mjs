#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { journal, readProhibitions, reportActivity } from "./hooks-prohibitions.mjs";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let input = {};
try { input = JSON.parse(raw || "{}"); } catch { /* autopilot hook reports invalid payload */ }

const sessionId = typeof input.session_id === "string" ? input.session_id : "";
const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
const endpoint = process.env.AGENT_HERDER_URL || "http://127.0.0.1:18787";
const pluginRoot = process.env.PLUGIN_ROOT?.trim()
  ? resolve(process.env.PLUGIN_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (!sessionId) {
  process.stdout.write("{}");
  process.exit(0);
}

// The lever of the owner. While the prohibitions of the Stop hook are on,
// the hook may hold the stop of the session and continue the same turn.
// When they are off — or when the state of the lever cannot be read at all —
// the hook stays quiet: it never holds the stop of a session.
const prohibition = await readProhibitions("Stop");
await reportActivity("Stop", { outcome: "fired", sessionId, harness: "codex" });
if (!prohibition.enabled) {
  await journal("Stop", { event: "prohibitions-off", sessionId, known: prohibition.known });
  process.stdout.write("{}");
  process.exit(0);
}

async function readContext(consume) {
  const query = new URLSearchParams({ harness: "codex", sessionId, cwd, consume: consume ? "1" : "0" });
  const response = await fetch(`${endpoint}/api/coordination/context?${query}`, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error(`human-stop status unavailable (${response.status})`);
  const context = await response.json();
  if (typeof context.humanStopHeld !== "boolean") throw new Error("human-stop status is invalid");
  return context;
}

async function humanStopHeld() {
  const context = await readContext(false);
  return context.humanStopHeld === true;
}

async function rememberGeneratedPrompt(text) {
  try {
    const moduleUrl = pathToFileURL(resolve(pluginRoot, "dist/human-stop-store.js")).href;
    const { getHumanStopStore } = await import(moduleUrl);
    await getHumanStopStore().rememberGeneratedPrompt("codex", sessionId, text);
    return true;
  } catch {
    return false;
  }
}

async function exitWithoutContinuation() {
  process.stdout.write("{}");
  process.exit(0);
}

if (sessionId) {
  let payload;
  try {
    if (await humanStopHeld()) await exitWithoutContinuation();
    // The consuming read rechecks the durable stop fence before draining the inbox.
    payload = await readContext(true);
    if (payload.humanStopHeld === true) await exitWithoutContinuation();
    if (typeof payload.inboxContext === "string" && payload.inboxContext.trim()) {
      if (await humanStopHeld()) await exitWithoutContinuation();
      if (!await rememberGeneratedPrompt(payload.inboxContext)) await exitWithoutContinuation();
      if (await humanStopHeld()) await exitWithoutContinuation();
      // The hook refuses to stop the session: the panel shows the refusal.
      await reportActivity("Stop", {
        outcome: "refused",
        reason: "сессия не остановлена: хук продолжил ход по входящему сообщению",
        sessionId,
        harness: "codex",
      });
      process.stdout.write(JSON.stringify({ decision: "block", reason: payload.inboxContext }));
      if (payload.inboxIds?.length) await fetch(`${endpoint}/api/coordination/inbox-ack`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId,ids:payload.inboxIds}),signal:AbortSignal.timeout(1200)}).catch(()=>{});
      process.exit(0);
    }
  } catch {
    // A failed fence read must never force the native Stop hook to continue.
    await exitWithoutContinuation();
  }
}

try {
  const { notifyAutopilotStop } = await import(pathToFileURL(resolve(pluginRoot, "dist/autopilot/stop-notify.js")).href);
  await notifyAutopilotStop({ command: "stop", harness: "codex", sessionId, cwd,
    turnId: input.turn_id, lastUserMessage: input.last_user_message,
    lastAssistantMessage: input.last_assistant_message ?? null, transcriptPath: input.transcript_path ?? null });
} catch { /* Unavailable Herder never holds the native Stop or runs a local model. */ }
process.stdout.write("{}");
