#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let input = {};
try { input = JSON.parse(raw || "{}"); } catch { /* autopilot hook reports invalid payload */ }

const sessionId = typeof input.session_id === "string" ? input.session_id : "";
const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
const endpoint = process.env.AGENT_HERDER_URL || "http://127.0.0.1:18787";

if (!sessionId) {
  process.stdout.write("{}");
  process.exit(0);
}

async function readContext(consume) {
  const query = new URLSearchParams({ harness: "codex", sessionId, cwd, consume: consume ? "1" : "0" });
  const response = await fetch(`${endpoint}/api/coordination/context?${query}`, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error(`human-stop status unavailable (${response.status})`);
  return response.json();
}

async function humanStopHeld() {
  const context = await readContext(false);
  return context.humanStopHeld === true;
}

async function exitWithoutContinuation() {
  process.stdout.write("{}");
  process.exit(0);
}

if (sessionId) {
  let payload;
  try {
    if (await humanStopHeld()) await exitWithoutContinuation();
    // The consuming read checks the durable stop fence atomically before it
    // drains the coordination inbox.
    payload = await readContext(true);
    if (payload.humanStopHeld === true) await exitWithoutContinuation();
    if (typeof payload.inboxContext === "string" && payload.inboxContext.trim()) {
      if (await humanStopHeld()) await exitWithoutContinuation();
      process.stdout.write(JSON.stringify({ decision: "block", reason: payload.inboxContext }));
      process.exit(0);
    }
  } catch {
    // A failed fence read must never force the native Stop hook to continue.
    await exitWithoutContinuation();
  }
}

const pluginRoot = process.env.PLUGIN_ROOT?.trim()
  ? resolve(process.env.PLUGIN_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn("bash", [resolve(pluginRoot, "scripts/autopilot-hook-launcher.sh")], {
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});
child.stdin.end(raw);
child.once("error", (error) => { process.stderr.write(`${error.message}\n`); process.exit(1); });
let childOutput = "";
child.stdout.setEncoding("utf8").on("data", (chunk) => { childOutput += chunk; });
child.once("close", async (code) => {
  if (code !== 0) process.exit(code ?? 1);
  try {
    if (sessionId && await humanStopHeld()) await exitWithoutContinuation();
    process.stdout.write(childOutput || "{}");
    process.exit(0);
  } catch {
    await exitWithoutContinuation();
  }
});
