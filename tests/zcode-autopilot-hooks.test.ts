import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const userPromptHook = resolve(root, "integrations/zcode/agent-herder-autopilot/hooks/user-prompt.mjs");
const stopHook = resolve(root, "integrations/zcode/agent-herder-autopilot/hooks/stop.mjs");

async function runNode(script: string, input: unknown, env: NodeJS.ProcessEnv, timeoutMs = 10_000): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script], { env: { ...env, AGENT_HERDER_URL: env.AGENT_HERDER_URL || "http://127.0.0.1:1" }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Stop hook kept the native turn open")); }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => { clearTimeout(timeout); code === 0 ? resolvePromise(stdout) : reject(new Error(stderr)); });
    child.stdin.end(JSON.stringify(input));
  });
}

describe("ZCode Agent Herder hooks", () => {
  it.each(["disabled", "choice"])("releases the native turn after %s without overriding session policy", async (decision) => {
    const sandbox = await mkdtemp(join(tmpdir(), "agent-herder-zcode-release-"));
    const capturePath = join(sandbox, "commands.jsonl");
    const server = createServer((_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ humanStopHeld: false })); });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test port");
      await mkdir(join(sandbox, "scripts"));
      const fake = join(sandbox, "launcher.mjs");
      await writeFile(fake, `import fs from 'node:fs'; let raw=''; for await(const c of process.stdin) raw+=c; const input=JSON.parse(raw); fs.appendFileSync(process.env.AGENT_HERDER_TEST_CAPTURE,JSON.stringify(input)+'\\n'); if(input.command==='on') fs.writeFileSync(process.env.AGENT_HERDER_TEST_CAPTURE+'.armed','yes'); const armed=fs.existsSync(process.env.AGENT_HERDER_TEST_CAPTURE+'.armed'); console.log(JSON.stringify(input.command==='stop' ? (${JSON.stringify(decision)}==='choice' ? {decision:'choice',request_id:'pending-choice'} : armed ? {decision:'continue',next_goal:'unwanted continuation'} : {decision:'disabled'}) : {ok:true}));`);
      await writeFile(join(sandbox, "scripts/autopilot-command-launcher.sh"), `#!/bin/sh\nexec '${process.execPath}' '${fake}'\n`, { mode: 0o755 });
      const output = await runNode(stopHook, { session_id: "release-test", cwd: sandbox, last_assistant_message: "Ответ завершён.", stop_hook_active: false }, {
        ...process.env, AGENT_HERDER_ROOT: sandbox, AGENT_HERDER_AUTOPILOT_STATE_DIR: sandbox,
        AGENT_HERDER_TEST_CAPTURE: capturePath, AGENT_HERDER_URL: `http://127.0.0.1:${address.port}`,
      }, 2_000);
      expect(JSON.parse(output)).toEqual({});
      const commands = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line).command);
      expect(commands).toEqual(["stop"]);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      await rm(sandbox, { force: true, recursive: true });
    }
  });
  it("keeps one fallback id for duplicate Stop events and renews it for the next user prompt", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "agent-herder-zcode-hooks-"));
    const stateDir = join(sandbox, "state");
    const fakeRoot = join(sandbox, "fake-root");
    const capturePath = join(sandbox, "launcher-inputs.jsonl");
    const launcherPath = join(fakeRoot, "scripts", "autopilot-command-launcher.sh");
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(request.url?.includes("/api/coordination/context") ? JSON.stringify({ humanStopHeld: false }) : "{}");
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server has no TCP address");
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
        AGENT_HERDER_URL: `http://127.0.0.1:${address.port}`,
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
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  });

  it.each([true, undefined, "false"])("does not invoke autopilot for a held or invalid stop flag: %s", async (humanStopHeld) => {
    const sandbox = await mkdtemp(join(tmpdir(), "agent-herder-zcode-held-"));
    const fakeRoot = join(sandbox, "fake-root");
    const capturePath = join(sandbox, "launcher-inputs.jsonl");
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ humanStopHeld }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server has no TCP address");
      await mkdir(resolve(fakeRoot, "scripts"), { recursive: true });
      await writeFile(join(fakeRoot, "scripts", "autopilot-command-launcher.sh"), "#!/usr/bin/env bash\nprintf called >> \"$AGENT_HERDER_TEST_CAPTURE\"\necho '{}'\n", { mode: 0o755 });
      const output = await runNode(stopHook, { session_id: "stopped-session", cwd: sandbox }, {
        ...process.env,
        AGENT_HERDER_ROOT: fakeRoot,
        AGENT_HERDER_TEST_CAPTURE: capturePath,
        AGENT_HERDER_URL: `http://127.0.0.1:${address.port}`,
      });
      expect(JSON.parse(output)).toEqual({});
      await expect(readFile(capturePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(sandbox, { force: true, recursive: true });
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  });
});
