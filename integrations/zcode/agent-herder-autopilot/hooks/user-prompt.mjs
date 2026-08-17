#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
try {
  const input = raw.trim() ? JSON.parse(raw) : {};
  const sessionId = typeof input.session_id === "string" ? input.session_id : input.sessionId;
  const prompt = typeof input.prompt === "string" ? input.prompt : null;
  if (sessionId && prompt) {
    const stateDir = process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR || resolve(homedir(), ".local/state/agent-herder/autopilot-live");
    const path = resolve(stateDir, "zcode-user-prompts.json");
    let file = { version: 1, sessions: {} };
    try { file = JSON.parse(await readFile(path, "utf8")); } catch {}
    file.sessions ||= {};
    file.sessions[sessionId] = { text: prompt.slice(0, 12_000), cwd: input.cwd, updatedAt: new Date().toISOString() };
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file)}\n`, "utf8");
    await rename(temporary, path);
  }
} catch (error) {
  process.stderr.write(`[agent-herder-zcode] ${(error instanceof Error ? error.message : String(error))}\n`);
}
process.stdout.write("{}");
