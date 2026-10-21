import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { cleanupDistBuild, ensureDist } from "./fixtures/ensure-dist.mjs";

// Since the Stop judging moved into the process-owned background consumer,
// the hook's only job is a fast, lossless notification of /api/autopilot/stop.
// Concurrent Stops from different sessions must both reach the endpoint,
// return instantly with an empty decision object, and never judge in-process.
const temporaryRoots: string[] = [];

afterEach(async () => {
  cleanupDistBuild();
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("autopilot hook concurrency", () => {
  it("notifies the process-owned Stop endpoint for simultaneous Codex sessions without judging in-process", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agent-herder-hook-concurrency-"));
    temporaryRoots.push(stateDir);

    let stopPosts = 0;
    let judgeCalls = 0;
    const submitted: string[] = [];
    const server = createServer((request, response) => {
      const path = (request.url ?? "").split("?")[0];
      if (path === "/api/autopilot/stop" && request.method === "POST") {
        stopPosts += 1;
        request.setEncoding("utf8");
        let body = "";
        request.on("data", (chunk: string) => { body += chunk; });
        request.on("end", () => {
          submitted.push((JSON.parse(body) as { sessionId?: string }).sessionId ?? "");
          response.writeHead(202, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      judgeCalls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          kind: "continue",
          nextGoal: "Continue this exact Codex session",
        }) } }],
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("endpoint did not bind");
      const env = {
        ...process.env,
        AGENT_HERDER_URL: `http://127.0.0.1:${address.port}`,
        AGENT_HERDER_AUTOPILOT_STATE_DIR: stateDir,
        AGENT_HERDER_AUTOPILOT_ALL_SESSIONS: "1",
        // The judge credentials must never be consumed by the hook itself.
        AGENT_HERDER_AUTOPILOT_JUDGE_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        AGENT_HERDER_AUTOPILOT_JUDGE_MODEL: "test-judge",
      };

      const [first, second] = await Promise.all([
        runHook("session-a", env),
        runHook("session-b", env),
      ]);

      expect(first).toEqual({});
      expect(second).toEqual(first);
      expect(stopPosts).toBe(2);
      expect(submitted.sort()).toEqual(["session-a", "session-b"]);
      expect(judgeCalls).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  }, 120_000);
});

async function runHook(sessionId: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  const child = spawn(process.execPath, [ensureDist("autopilot-hook.js")], {
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
