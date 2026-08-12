import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("autopilot hook concurrency", () => {
  it("judges simultaneous Stop events from different Codex sessions", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agent-herder-hook-concurrency-"));
    temporaryRoots.push(stateDir);

    let judgeCalls = 0;
    const server = createServer((_request, response) => {
      judgeCalls += 1;
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            kind: "continue",
            nextGoal: "Continue this exact Codex session",
          }) } }],
        }));
      }, 2_300);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("judge did not bind");
      const env = {
        ...process.env,
        AGENT_HERDER_AUTOPILOT_STATE_DIR: stateDir,
        AGENT_HERDER_AUTOPILOT_ALL_SESSIONS: "1",
        AGENT_HERDER_AUTOPILOT_JUDGE_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        AGENT_HERDER_AUTOPILOT_JUDGE_MODEL: "test-judge",
      };

      const [first, second] = await Promise.all([
        runHook("session-a", env),
        runHook("session-b", env),
      ]);

      expect(first).toEqual({
        decision: "block",
        reason: "Continue this exact Codex session",
      });
      expect(second).toEqual(first);
      expect(judgeCalls).toBe(2);
      const receipts = JSON.parse(
        await readFile(join(stateDir, "receipts.json"), "utf8"),
      ) as Record<string, { kind: string }>;
      expect(Object.values(receipts)).toEqual([
        { kind: "continue" },
        { kind: "continue" },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  }, 10_000);
});

async function runHook(sessionId: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  const child = spawn(process.execPath, [join(process.cwd(), "dist", "autopilot-hook.js")], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(JSON.stringify({
    hook_event_name: "Stop",
    session_id: sessionId,
    cwd: "/workspace/canary",
    turn_id: "turn-1",
    transcript_path: null,
    last_assistant_message: "The requested work is incomplete.",
    stop_hook_active: false,
  }));

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const errorText = Buffer.concat(stderr).toString("utf8").trim();
  if (exitCode !== 0) throw new Error(`hook exited ${exitCode}: ${errorText}`);
  return JSON.parse(Buffer.concat(stdout).toString("utf8"));
}
