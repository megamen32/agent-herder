import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stopHook = fileURLToPath(new URL("../scripts/codex-stop-hook.mjs", import.meta.url));
const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface StopRun {
  readonly stdout: string;
  readonly code: number | null;
  readonly activity: Array<Record<string, unknown>>;
  readonly digests: Array<Record<string, unknown>>;
}

/** Run the Stop hook of the plugin against a panel that answers like the panel does. */
async function runStopHook(options: {
  readonly inboxContext?: string;
  readonly prohibitionsEnabled?: boolean;
  readonly digestRoute?: boolean;
  readonly pluginRoot?: string;
  readonly sessionId?: string;
  readonly harness?: string;
}): Promise<StopRun> {
  const activity: Array<Record<string, unknown>> = [];
  const digests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const part of request) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    if (request.url === "/api/hooks/activity") activity.push(body);
    if (request.url === "/api/human-stop/generated-prompt") {
      digests.push(body);
      response.statusCode = options.digestRoute === false ? 404 : 200;
      response.setHeader("content-type", "application/json");
      response.end(options.digestRoute === false ? JSON.stringify({ error: "not found" }) : JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === "/api/hooks/prohibitions") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        ok: true,
        known: true,
        prohibitionsEnabled: options.prohibitionsEnabled !== false,
        disabledHooks: [],
      }));
      return;
    }
    if (request.url?.startsWith("/api/coordination/context")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        context: "",
        inboxContext: options.inboxContext ?? null,
        inboxCount: options.inboxContext ? 1 : 0,
        inboxIds: options.inboxContext ? ["inbox-1"] : [],
        humanStopHeld: false,
      }));
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the test panel did not bind");

  const pluginRoot = options.pluginRoot ?? await mkdtemp(join(tmpdir(), "agent-herder-hook-"));
  if (!options.pluginRoot) roots.push(pluginRoot);

  const child = spawn(process.execPath, [stopHook], {
    env: {
      ...process.env,
      AGENT_HERDER_URL: `http://127.0.0.1:${address.port}`,
      PLUGIN_ROOT: pluginRoot,
      ...(options.harness ? { AGENT_HERDER_HARNESS: options.harness } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stdin.end(JSON.stringify({
    hook_event_name: "Stop",
    session_id: options.sessionId ?? "session-1",
    cwd: "/repo",
    transcript_path: "/repo/transcript.jsonl",
    stop_hook_active: false,
    last_assistant_message: "готово",
  }));
  const code = await new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(-1));
    child.once("exit", (value) => resolve(value));
  });
  return { stdout, code, activity, digests };
}

describe("the Stop hook of the plugin of MiniMax Code", () => {
  it("refuses the stop of the session when the panel has a message for it", async () => {
    const run = await runStopHook({ inboxContext: "сообщение панели" });
    expect(JSON.parse(run.stdout)).toEqual({ decision: "block", reason: "сообщение панели" });
    expect(run.code).toBe(0);
    expect(run.activity.some((entry) => entry.outcome === "refused")).toBe(true);
  });

  it("writes the digest of the message through the panel, not through a local store", async () => {
    const run = await runStopHook({ inboxContext: "сообщение панели", harness: "minimax-code" });
    expect(run.digests).toEqual([{ harness: "minimax-code", sessionId: "session-1", text: "сообщение панели" }]);
    expect(JSON.parse(run.stdout)).toEqual({ decision: "block", reason: "сообщение панели" });
  });

  it("keeps the session alone when the panel does not know the route of the digest", async () => {
    // The package of MiniMax Code carries no dist/, so the digest has nowhere to
    // go: the hook must not continue the turn on a fence it could not record.
    const run = await runStopHook({ inboxContext: "сообщение панели", digestRoute: false, harness: "minimax-code" });
    expect(JSON.parse(run.stdout)).toEqual({});
    expect(run.code).toBe(0);
  });

  it("stays quiet while the lever of the owner forbids the hook", async () => {
    const run = await runStopHook({ inboxContext: "сообщение панели", prohibitionsEnabled: false });
    expect(JSON.parse(run.stdout)).toEqual({});
    expect(run.digests).toEqual([]);
    expect(run.activity.some((entry) => entry.outcome === "fired")).toBe(true);
  });

  it("leaves the session alone when the panel does not answer at all", async () => {
    const server = createServer(() => { /* the panel is silent */ });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("the silent panel did not bind");
    const child = spawn(process.execPath, [stopHook], {
      env: { ...process.env, AGENT_HERDER_URL: `http://127.0.0.1:${address.port}`, PLUGIN_ROOT: "/nonexistent" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stdin.end(JSON.stringify({ hook_event_name: "Stop", session_id: "session-2", cwd: "/repo" }));
    const code = await new Promise<number | null>((resolve) => {
      child.once("error", () => resolve(-1));
      child.once("exit", (value) => resolve(value));
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });
});
