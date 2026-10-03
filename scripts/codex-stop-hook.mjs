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

if (sessionId) {
  try {
    const query = new URLSearchParams({ harness: "codex", sessionId, cwd, consume: "1" });
    const response = await fetch(`${endpoint}/api/coordination/context?${query}`, { signal: AbortSignal.timeout(1500) });
    if (response.ok) {
      const payload = await response.json();
      if (typeof payload.inboxContext === "string" && payload.inboxContext.trim()) {
        process.stdout.write(JSON.stringify({ decision: "block", reason: payload.inboxContext }));
        process.exit(0);
      }
    }
  } catch { /* Herder outage must not break the existing autopilot hook */ }
}

const pluginRoot = process.env.PLUGIN_ROOT?.trim()
  ? resolve(process.env.PLUGIN_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn("bash", [resolve(pluginRoot, "scripts/autopilot-hook-launcher.sh")], {
  env: process.env,
  stdio: ["pipe", "inherit", "inherit"],
});
child.stdin.end(raw);
child.once("error", (error) => { process.stderr.write(`${error.message}\n`); process.exit(1); });
child.once("close", (code) => process.exit(code ?? 1));
