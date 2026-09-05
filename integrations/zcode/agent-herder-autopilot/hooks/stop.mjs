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

async function selectedGoal(requestId) {
  try {
    const file = JSON.parse(await readFile(resolve(stateDirectory(), "choices.json"), "utf8"));
    const record = Array.isArray(file.requests) ? file.requests.find((item) => item?.requestId === requestId) : undefined;
    return (record?.status === "claimed" || record?.status === "resumed") && typeof record.nextGoal === "string" ? record.nextGoal : null;
  } catch {
    return null;
  }
}

async function waitForChoice(requestId) {
  // The running Stop hook is the continuation transport. Telegram only marks
  // the durable selection; no second ZCode client is ever launched.
  const until = Date.now() + 7 * 24 * 60 * 60 * 1000;
  while (Date.now() < until) {
    const goal = await selectedGoal(requestId);
    if (goal) return goal;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  return null;
}

try {
  const raw = await readStdin();
  const input = raw.trim() ? JSON.parse(raw) : {};
  const sessionId = typeof input.session_id === "string" ? input.session_id : input.sessionId;
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.env.ZCODE_PROJECT_DIR || process.cwd();
  if (!sessionId) throw new Error("ZCode Stop hook did not provide session_id");
  const root = agentHerderRoot();
  const userContext = await lastUserContext(sessionId);
  // ZCode has no slash-command callback with a session id. Arm the exact
  // session from its authoritative Stop payload before judging it.
  await invoke(root, { command: "on", harness: "zcode", sessionId, cwd });
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
  const nextGoal = result?.decision === "continue" ? result.next_goal
    : result?.decision === "choice" && typeof result.request_id === "string" ? await waitForChoice(result.request_id)
      : null;
  if (typeof nextGoal === "string" && nextGoal.trim()) {
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
} catch (error) {
  process.stderr.write(`[agent-herder-zcode] ${(error instanceof Error ? error.message : String(error))}\n`);
  process.stdout.write("{}");
}

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
