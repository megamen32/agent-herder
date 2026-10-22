import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stopHook = fileURLToPath(new URL("../scripts/codex-stop-hook.mjs", import.meta.url));
const coordinationHook = fileURLToPath(new URL("../scripts/coordination-hook.mjs", import.meta.url));
const stopGate = fileURLToPath(new URL("../scripts/hooks-stop-gate.mjs", import.meta.url));

const servers: Server[] = [];
const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-herder-hooks-script-"));
  cleanups.push(dir);
  return dir;
}

interface HerderScenario {
  /** The state the lever of the owner reports. */
  prohibitions?: Record<string, unknown>;
  /** The context of the coordination of the session. */
  inboxContext?: string;
  /** The context of the activity of the tool call. */
  activityContext?: string;
}

interface HerderProbe {
  url: string;
  requests: Array<{ method: string; path: string; body: string }>;
}

/** A herder that answers the questions of the hooks and remembers what it was asked. */
async function startHerder(scenario: HerderScenario): Promise<HerderProbe> {
  const probe: HerderProbe = { url: "", requests: [] };
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const part of request) raw += part;
    probe.requests.push({ method: request.method ?? "", path: request.url ?? "", body: raw });
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/api/hooks/prohibitions")) {
      response.end(JSON.stringify(scenario.prohibitions ?? { ok: true, known: true, prohibitionsEnabled: true, disabledHooks: [] }));
      return;
    }
    if (request.url?.startsWith("/api/hooks/activity")) {
      response.end("{}");
      return;
    }
    if (request.url?.startsWith("/api/coordination/context")) {
      response.end(JSON.stringify({ humanStopHeld: false, inboxContext: scenario.inboxContext ?? "", inboxIds: [] }));
      return;
    }
    if (request.url?.startsWith("/api/coordination/activity")) {
      response.end(JSON.stringify({ context: scenario.activityContext ?? null, inboxIds: [] }));
      return;
    }
    response.end("{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the herder of the test did not bind");
  probe.url = `http://127.0.0.1:${address.port}`;
  return probe;
}

async function runScript(
  script: string,
  input: unknown,
  env: Record<string, string> = {},
  args: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [script, ...args], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  const code = await new Promise<number>((resolve) => {
    child.on("error", () => resolve(-1));
    child.on("exit", (value) => resolve(value ?? 0));
  });
  return { code, stdout, stderr };
}

/** A plugin root whose human-stop store works, so the Stop hook may continue a turn. */
async function pluginRootWithStore(): Promise<string> {
  const dir = await workDir();
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(join(dir, "dist", "human-stop-store.js"), [
    "export function getHumanStopStore() {",
    "  return { async rememberGeneratedPrompt() { return true; } };",
    "}",
    "",
  ].join("\n"), "utf8");
  return dir;
}

describe("the hook of the stop: a hook that cannot work never gets in the way", () => {
  it("does not hold the stop and does not fail when the herder is unreachable", async () => {
    const stateDir = await workDir();
    const result = await runScript(stopHook, { session_id: "codex:1", cwd: "/repo" }, {
      // Nothing listens on this port: the read of the lever fails.
      AGENT_HERDER_URL: "http://127.0.0.1:9",
      AGENT_HERDER_HOOK_STATE_DIR: stateDir,
    });
    expect(result.code).toBe(0);
    // An empty decision: the session stops the way the owner expects it to.
    expect(result.stdout.trim()).toBe("{}");
    // The failure is written to the journal of the hook.
    const journal = await readFile(join(stateDir, "Stop.jsonl"), "utf8");
    expect(journal).toContain("state-unavailable");
  });

  it("does not hold the stop when the owner turned the prohibitions off", async () => {
    const stateDir = await workDir();
    const herder = await startHerder({ prohibitions: { ok: true, known: true, prohibitionsEnabled: false, disabledHooks: [] } });
    const result = await runScript(stopHook, { session_id: "codex:1", cwd: "/repo" }, {
      AGENT_HERDER_URL: herder.url,
      AGENT_HERDER_HOOK_STATE_DIR: stateDir,
    });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("{}");
    // The hook never asked the herder for the inbox: it did not continue the turn.
    expect(herder.requests.some((request) => request.path.startsWith("/api/coordination/context"))).toBe(false);
    const journal = await readFile(join(stateDir, "Stop.jsonl"), "utf8");
    expect(journal).toContain("prohibitions-off");
  });

  it("does not hold the stop when only the Stop hook is switched off", async () => {
    const stateDir = await workDir();
    const herder = await startHerder({ prohibitions: { ok: true, known: true, prohibitionsEnabled: true, disabledHooks: ["Stop"] } });
    const result = await runScript(stopHook, { session_id: "codex:1", cwd: "/repo" }, {
      AGENT_HERDER_URL: herder.url,
      AGENT_HERDER_HOOK_STATE_DIR: stateDir,
    });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("{}");
    expect(herder.requests.some((request) => request.path.startsWith("/api/coordination/context"))).toBe(false);
  });

  it("holds the stop and names the refusal while the prohibitions are on", async () => {
    const stateDir = await workDir();
    const pluginRoot = await pluginRootWithStore();
    const herder = await startHerder({ inboxContext: "входящее сообщение ждёт" });
    const result = await runScript(stopHook, { session_id: "codex:1", cwd: "/repo" }, {
      AGENT_HERDER_URL: herder.url,
      AGENT_HERDER_HOOK_STATE_DIR: stateDir,
      PLUGIN_ROOT: pluginRoot,
    });
    expect(result.code).toBe(0);
    const decision = JSON.parse(result.stdout) as { decision?: string };
    expect(decision.decision).toBe("block");
    // The refusal is reported to the herder, so the panel can show it.
    const report = herder.requests.find((request) => request.path.startsWith("/api/hooks/activity") && request.body.includes("refused"));
    expect(report?.body).toContain("Stop");
    expect(report?.body).toContain("продолжил ход");
  });
});

describe("the hook of the coordination: the prohibition travels only while it is on", () => {
  const conflict = "<agent-herder-path-conflict>\nдругой агент работал с тем же файлом\n</agent-herder-path-conflict>";

  it("does not pass the prohibition on when the owner turned it off", async () => {
    const stateDir = await workDir();
    const herder = await startHerder({
      prohibitions: { ok: true, known: true, prohibitionsEnabled: false, disabledHooks: [] },
      activityContext: conflict,
    });
    const result = await runScript(coordinationHook, {
      hook_event_name: "PreToolUse", session_id: "codex:1", cwd: "/repo", tool_name: "write_file", tool_input: { path: "/repo/a.txt" },
    }, { AGENT_HERDER_URL: herder.url, AGENT_HERDER_HOOK_STATE_DIR: stateDir });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("agent-herder-path-conflict");
    // No refusal is reported: the hook did not refuse anything.
    const report = herder.requests.find((request) => request.path.startsWith("/api/hooks/activity") && request.body.includes("refused"));
    expect(report).toBeUndefined();
  });

  it("passes the prohibition on and names the refusal while it is on", async () => {
    const stateDir = await workDir();
    const herder = await startHerder({
      prohibitions: { ok: true, known: true, prohibitionsEnabled: true, disabledHooks: [] },
      activityContext: conflict,
    });
    const result = await runScript(coordinationHook, {
      hook_event_name: "PreToolUse", session_id: "codex:1", cwd: "/repo", tool_name: "write_file", tool_input: { path: "/repo/a.txt" },
    }, { AGENT_HERDER_URL: herder.url, AGENT_HERDER_HOOK_STATE_DIR: stateDir });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("agent-herder-path-conflict");
    const report = herder.requests.find((request) => request.path.startsWith("/api/hooks/activity") && request.body.includes("refused"));
    expect(report?.body).toContain("PreToolUse");
    expect(report?.body).toContain("конфликт по путям");
  });

  it("stays quiet and does not fail when the herder is unreachable", async () => {
    const stateDir = await workDir();
    const result = await runScript(coordinationHook, {
      hook_event_name: "PreToolUse", session_id: "codex:1", cwd: "/repo", tool_name: "write_file", tool_input: { path: "/repo/a.txt" },
    }, { AGENT_HERDER_URL: "http://127.0.0.1:9", AGENT_HERDER_HOOK_STATE_DIR: stateDir });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });
});

describe("the gate of the stop of Claude Code", () => {
  it("does not run the launcher while the prohibitions are off", async () => {
    const stateDir = await workDir();
    const herder = await startHerder({ prohibitions: { ok: true, known: true, prohibitionsEnabled: false, disabledHooks: [] } });
    const result = await runScript(stopGate, { session_id: "claude:1" }, {
      AGENT_HERDER_URL: herder.url,
      AGENT_HERDER_HOOK_STATE_DIR: stateDir,
    }, ["--", process.execPath, "-e", "process.stdout.write('{\"decision\":\"block\"}')"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("{}");
  });

  it("runs the launcher while the prohibitions are on", async () => {
    const stateDir = await workDir();
    const herder = await startHerder({});
    const result = await runScript(stopGate, { session_id: "claude:1" }, {
      AGENT_HERDER_URL: herder.url,
      AGENT_HERDER_HOOK_STATE_DIR: stateDir,
    }, ["--", process.execPath, "-e", "process.stdout.write('{\"decision\":\"block\"}')"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("decision");
  });
});

describe("the manifest of the hooks is safe", () => {
  it.each([
    ["hooks/hooks.json"],
    ["com.openai/hooks/hooks.json"],
  ])("names only scripts that exist and never fails the session: %s", async (relative) => {
    const manifest = JSON.parse(await readFile(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    for (const entries of Object.values(manifest.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          // A hook that cannot start must not break the session.
          expect(hook.command.trimEnd().endsWith("|| true")).toBe(true);
          for (const match of hook.command.matchAll(/\$\{(?:PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT)\}\/([^"'\s]+)/g)) {
            const script = fileURLToPath(new URL(`../${match[1] ?? ""}`, import.meta.url));
            await expect(readFile(script, "utf8")).resolves.toBeTruthy();
          }
        }
      }
    }
  });
});
