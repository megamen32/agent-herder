#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

async function readStdin() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

function agentHerderRoot() {
  if (process.env.AGENT_HERDER_ROOT?.trim()) return resolve(process.env.AGENT_HERDER_ROOT);
  // Source-checkout installation: integrations/zcode/agent-herder-autopilot/hooks.
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

function invoke(root, payload) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("bash", [resolve(root, "scripts/autopilot-command-launcher.sh")], {
      env: { ...process.env, AGENT_HERDER_AUTOPILOT_ALL_SESSIONS: process.env.AGENT_HERDER_AUTOPILOT_ALL_SESSIONS || "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `autopilot launcher exited ${code}`));
      try { resolvePromise(JSON.parse(stdout)); } catch { reject(new Error("autopilot launcher returned invalid JSON")); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function stateDirectory() {
  return process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR || resolve(homedir(), ".local/state/agent-herder/autopilot-live");
}

async function humanStopHeld(sessionId, cwd) {
  const query = new URLSearchParams({ harness: "zcode", sessionId, cwd, touch: "0", consume: "0" });
  const response = await fetch(`${process.env.AGENT_HERDER_URL || "http://127.0.0.1:18787"}/api/coordination/context?${query}`, {
    signal: AbortSignal.timeout(1200),
  });
  if (!response.ok) throw new Error(`human-stop status unavailable (${response.status})`);
  const status = await response.json();
  if (typeof status.humanStopHeld !== "boolean") throw new Error("human-stop status is invalid");
  return status.humanStopHeld === true;
}

async function main() {
  const raw = await readStdin();
  const input = raw.trim() ? JSON.parse(raw) : {};
  const sessionId = typeof input.session_id === "string" ? input.session_id : input.sessionId;
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.env.ZCODE_PROJECT_DIR || process.cwd();
  if (!sessionId) throw new Error("ZCode Stop hook did not provide session_id");
  const root = agentHerderRoot();
  let held = false;
  try { held = await humanStopHeld(sessionId, cwd); } catch { held = true; }
  if (held) return writeEmpty();
  const userContext = await lastUserContext(sessionId);
  // The turn just ended: record the lifecycle boundary before judging, so
  // the coordination boards see this session as idle, not running.
  try {
    await fetch(`${process.env.AGENT_HERDER_URL || "http://127.0.0.1:18787"}/api/coordination/lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ harness: "zcode", sessionId, cwd, event: "turn-end" }),
      signal: AbortSignal.timeout(1200),
    });
  } catch {}
  // Evaluate the existing session/global policy. A Stop event must never
  // re-enable a session explicitly switched off by its user.
  if (await humanStopHeld(sessionId, cwd)) return writeEmpty();
  const result = await invoke(root, {
    command: "stop",
    harness: "zcode",
    sessionId,
    // ZCode normally includes turnId. If an older runtime omits it, use the
    // nonce captured by UserPromptSubmit: stable for duplicate Stop delivery,
    // but fresh for the next user message in the same session.
    turnId: nonEmptyString(input.turn_id)
      ?? nonEmptyString(input.turnId)
      ?? userContext?.turnId
      ?? `zcode-session-${sessionId}`,
    cwd,
    lastAssistantMessage: typeof input.last_assistant_message === "string" ? input.last_assistant_message : null,
    lastUserMessage: userContext?.text ?? null,
    transcriptPath: typeof input.transcript_path === "string" ? input.transcript_path : undefined,
    stopHookActive: input.stop_hook_active === true,
  });
  // A choice is durable, but waiting for it here holds ZCode's native turn
  // open and prevents its queued user messages from starting. Release the
  // turn; a later selection resumes this exact session through Agent Resume.
  const nextGoal = result?.decision === "continue" ? result.next_goal : null;
  if (typeof nextGoal === "string" && nextGoal.trim()) {
    if (await humanStopHeld(sessionId, cwd)) return writeEmpty();
    // ZCode handles this natively: it retains the current session and starts
    // its next turn with this additional context. No app-server or relay client.
    process.stdout.write(JSON.stringify({ continue: true, reason: nextGoal, additionalContext: nextGoal }));
  } else {
    process.stdout.write("{}");
    // Session wrapped up (judge has no next goal): drop its auto-reserved
    // leases and presence from the coordination boards immediately, so
    // peers stop seeing a dead agent before the TTL expires.
    try {
      await fetch(`${process.env.AGENT_HERDER_URL || "http://127.0.0.1:18787"}/api/coordination/session-end`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ harness: "zcode", sessionId, cwd }),
        signal: AbortSignal.timeout(1500),
      });
    } catch {}
  }
}

function writeEmpty() { process.stdout.write("{}"); }

void main().catch((error) => {
  process.stderr.write(`[agent-herder-zcode] ${(error instanceof Error ? error.message : String(error))}\n`);
  process.stdout.write("{}");
});

async function lastUserContext(sessionId) {
  try {
    const file = JSON.parse(await readFile(resolve(stateDirectory(), "zcode-user-prompts.json"), "utf8"));
    const entry = file?.sessions?.[sessionId];
    if (!entry || typeof entry !== "object") return null;
    const text = typeof entry.text === "string" ? entry.text : null;
    const turnId = nonEmptyString(entry.turnId);
    return text || turnId ? { text, turnId } : null;
  } catch {
    return null;
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}
