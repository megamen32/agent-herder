import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const userPromptHook = resolve(root, "integrations/zcode/agent-herder-autopilot/hooks/user-prompt.mjs");
const stopHook = resolve(root, "integrations/zcode/agent-herder-autopilot/hooks/stop.mjs");

async function runNode(script: string, input: unknown, env: NodeJS.ProcessEnv): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolvePromise(stdout) : reject(new Error(stderr)));
    child.stdin.end(JSON.stringify(input));
  });
}

describe("ZCode Agent Herder hooks", () => {
  it("keeps one fallback id for duplicate Stop events and renews it for the next user prompt", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "agent-herder-zcode-hooks-"));
    const stateDir = join(sandbox, "state");
    const fakeRoot = join(sandbox, "fake-root");
    const capturePath = join(sandbox, "launcher-inputs.jsonl");
    const launcherPath = join(fakeRoot, "scripts", "autopilot-command-launcher.sh");
    try {
      await mkdir(resolve(fakeRoot, "scripts"), { recursive: true });
      await writeFile(launcherPath, [
        "#!/usr/bin/env bash",
        "payload=$(cat)",
        "printf '%s\\n' \"$payload\" >> \"$AGENT_HERDER_TEST_CAPTURE\"",
        "case \"$payload\" in",
        '  *\\\"command\\\":\\\"stop\\\"*) echo \'{"decision":"continue","next_goal":"continue canary"}\' ;;',
        "  *) echo '{\"ok\":true}' ;;",
        "esac",
      ].join("\n"), { encoding: "utf8", mode: 0o755 });

      const env = {
        ...process.env,
        AGENT_HERDER_AUTOPILOT_STATE_DIR: stateDir,
        AGENT_HERDER_ROOT: fakeRoot,
        AGENT_HERDER_TEST_CAPTURE: capturePath,
      };
      const sessionId = "sess-zcode-hook-test";
      await runNode(userPromptHook, { session_id: sessionId, prompt: "first request" }, env);
      const first = JSON.parse(await readFile(join(stateDir, "zcode-user-prompts.json"), "utf8"));
      const firstTurnId = first.sessions[sessionId].turnId;

      const stopOutput = JSON.parse(await runNode(stopHook, {
        session_id: sessionId,
        turn_id: "",
        cwd: sandbox,
        last_assistant_message: "still incomplete",
        stop_hook_active: true,
      }, env));
      expect(stopOutput).toMatchObject({ continue: true, reason: "continue canary" });
      const firstStop = JSON.parse((await readFile(capturePath, "utf8")).trim().split("\n").at(-1)!);
      expect(firstStop.turnId).toBe(firstTurnId);

      const duplicateStopOutput = JSON.parse(await runNode(stopHook, {
        session_id: sessionId,
        turn_id: "",
        cwd: sandbox,
        last_assistant_message: "still incomplete",
        stop_hook_active: true,
      }, env));
      expect(duplicateStopOutput).toMatchObject({ continue: true, reason: "continue canary" });
      const duplicateStop = JSON.parse((await readFile(capturePath, "utf8")).trim().split("\n").at(-1)!);
      expect(duplicateStop.turnId).toBe(firstTurnId);

      await runNode(userPromptHook, { session_id: sessionId, prompt: "second request" }, env);
      const second = JSON.parse(await readFile(join(stateDir, "zcode-user-prompts.json"), "utf8"));
      expect(second.sessions[sessionId].turnId).not.toBe(firstTurnId);

      const nextTurnStopOutput = JSON.parse(await runNode(stopHook, {
        session_id: sessionId,
        turn_id: "",
        cwd: sandbox,
        last_assistant_message: "still incomplete",
        stop_hook_active: true,
      }, env));
      expect(nextTurnStopOutput).toMatchObject({ continue: true, reason: "continue canary" });
      const nextTurnStop = JSON.parse((await readFile(capturePath, "utf8")).trim().split("\n").at(-1)!);
      expect(nextTurnStop.turnId).toBe(second.sessions[sessionId].turnId);
    } finally {
      await rm(sandbox, { force: true, recursive: true });
    }
  });
});
