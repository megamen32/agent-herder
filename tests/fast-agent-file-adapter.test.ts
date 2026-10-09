import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as workloadLauncher from "../src/workload-launcher.js";
import { FastAgentFileAdapter } from "../src/adapters/fast-agent.js";
import { handleCreateSession, handleNewOrResume } from "../src/mcp-tools/handlers.js";

const cleanups: string[] = [];

async function fixtureHome(prefix: string): Promise<string> {
  // Keep fixtures inside the runner's measured lease; local runs use project .tmp.
  const root = process.env.TMPDIR || join(process.cwd(), ".tmp");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, prefix));
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Fast Agent persisted observer", () => {
  it("persists a bounded named creation and reuses it through a fresh native observer", async () => {
    const home = await fixtureHome("fast-agent-create-");
    cleanups.push(home);
    const moduleDir = join(home, "fast_agent", "session");
    await mkdir(moduleDir, { recursive: true });
    await writeFile(join(home, "fast_agent", "__init__.py"), "");
    await writeFile(join(moduleDir, "__init__.py"), "");
    // Minimal native persistence fixture; execute the adapter's actual Python script.
    await writeFile(join(moduleDir, "session_manager.py"), [
      "import json",
      "from pathlib import Path",
      "from types import SimpleNamespace",
      "class SessionManager:",
      "    def __init__(self,cwd,home_override): self.cwd=cwd; self.home=Path(home_override)",
      "    def create_session(self,name,metadata):",
      "        directory=self.home/'sessions'/name",
      "        directory.mkdir(parents=True,exist_ok=True)",
      "        (directory/'session.json').write_text(json.dumps({'session_id':name,'metadata':{'title':metadata.pop('title',None),'extras':metadata},'continuation':{'cwd':metadata.pop('cwd')}}))",
      "        return SimpleNamespace(info=SimpleNamespace(name=name))",
    ].join("\n"));
    const bin = join(home, "fast-agent");
    await writeFile(bin, "#!/usr/bin/python3\n");
    vi.stubEnv("PYTHONPATH", home);
    const isolated = vi.spyOn(workloadLauncher, "spawnIsolatedWorkload");
    const adapter = new FastAgentFileAdapter({ home, cwd: "/fallback", fastAgentBin: bin });
    const model = "generic.MiniMax-M3";
    const created = JSON.parse(await handleCreateSession(new Map([["fast-agent", adapter]]), {
      harness: "fast-agent", name: "stable-worker", cwd: home, model,
    }));
    expect(created).toMatchObject({ ok: true, created: true, sessionId: "fast-agent:stable-worker", model });
    expect(isolated.mock.calls[0]?.[2]).toMatchObject({
      label: "fast-agent-create", timeout: 15000,
      resourceProperties: ["CPUQuota=100%", "MemoryHigh=384M", "MemoryMax=768M", "MemorySwapMax=0", "TasksMax=64", "IOWeight=25"],
    });
    const observer = new FastAgentFileAdapter({ home, cwd: "/fallback", fastAgentBin: "/usr/bin/true" });
    expect(await observer.getSession(created.sessionId)).toMatchObject({ title: "stable-worker", cwd: home, model, meta: { herderManaged: true, readOnly: false } });
    const reused = JSON.parse(await handleNewOrResume(new Map([["fast-agent", observer]]), {
      harness: "fast-agent", name: "stable-worker", cwd: home, model, message: "continue", mode: "sync",
    }));
    expect(reused).toMatchObject({ ok: true, created: false, sessionId: created.sessionId, delivery: "completed" });
    expect(await observer.listSessions()).toHaveLength(1);
  });

  it.each([false, true])("bounds ordinary and recovery send jobs (recovery=%s)", async (recovery) => {
    const home = await fixtureHome("fast-agent-budget-");
    cleanups.push(home);
    const directory = join(home, "sessions", "bounded");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "session.json"), JSON.stringify({
      session_id: "bounded", continuation: { cwd: home }, metadata: { extras: { healthRecovery: recovery } },
    }));
    const isolated = vi.spyOn(workloadLauncher, "spawnIsolatedWorkload");
    const adapter = new FastAgentFileAdapter({ home, fastAgentBin: "/usr/bin/true" });
    expect(await adapter.sendMessage("fast-agent:bounded", { message: "sync" })).toEqual({ ok: true });
    expect(await adapter.sendMessage("fast-agent:bounded", { message: "queued", queue: true })).toEqual({ ok: true, admitted: true, pending: true });
    const properties = ["CPUQuota=100%", "MemoryHigh=384M", "MemoryMax=768M", "MemorySwapMax=0", "TasksMax=64", "IOWeight=25"];
    expect(isolated.mock.calls[0]?.[2].resourceProperties).toEqual(properties);
    expect(isolated.mock.calls[1]?.[2].resourceProperties).toEqual(properties);
    const args = isolated.mock.calls[1]?.[1] ?? [];
    expect(args.includes("--shell")).toBe(recovery);
    expect(args.includes("300")).toBe(recovery);
  });



  it("allows replies only to Herder-managed native sessions", async () => {
    const home = await fixtureHome("fast-agent-writable-");
    cleanups.push(home);
    for (const [id, extras] of [
      ["managed", { herderManaged: true }],
      ["legacy-recovery", { healthRecovery: true }],
      ["legacy-ordinary", { healthRecovery: false }],
      ["foreign", {}],
    ] as const) {
      const directory = join(home, "sessions", id);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "session.json"), JSON.stringify({ session_id: id, metadata: { extras } }));
    }
    const isolated = vi.spyOn(workloadLauncher, "spawnIsolatedWorkload");
    const adapter = new FastAgentFileAdapter({ home, cwd: home, fastAgentBin: "/usr/bin/true" });
    for (const id of ["managed", "legacy-recovery", "legacy-ordinary"]) {
      expect(await adapter.getSession(`fast-agent:${id}`)).toMatchObject({ meta: { readOnly: false, herderManaged: true } });
      expect(await adapter.resumeSession(`fast-agent:${id}`)).toEqual({ ok: true });
      expect(await adapter.sendMessage(`fast-agent:${id}`, { message: "user reply", origin: "human" })).toEqual({ ok: true });
    }
    expect(await adapter.getSession("fast-agent:foreign")).toMatchObject({ meta: { readOnly: true, herderManaged: false } });
    const admittedCount = isolated.mock.calls.length;
    expect(await adapter.resumeSession("fast-agent:foreign")).toMatchObject({ ok: false, error: expect.stringContaining("read-only") });
    expect(await adapter.resumeSession("fast-agent:missing")).toMatchObject({ ok: false, error: expect.stringContaining("not found") });
    for (const queue of [false, true]) {
      expect(await adapter.sendMessage("fast-agent:foreign", { message: "user reply", queue })).toMatchObject({ ok: false, error: expect.stringContaining("read-only") });
    }
    expect(isolated.mock.calls).toHaveLength(admittedCount);
    await expect(readFile(join(home, "sessions", "foreign", "herder-execution.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { label: "top-level marker", parent: "", fields: { archived: true } },
    { label: "metadata marker", parent: "", fields: { metadata: { archived: true, extras: { herderManaged: true } } } },
    { label: "extras marker", parent: "", fields: { metadata: { extras: { archived: true, herderManaged: true } } } },
    ...["archive", "archived", ".archive", ".archived"].map((parent) => ({ label: `${parent} directory`, parent, fields: {} })),
  ])("keeps managed archived sessions read-only ($label)", async ({ parent, fields }) => {
    const home = await fixtureHome("fast-agent-archived-");
    cleanups.push(home);
    const directory = join(home, "sessions", parent, "managed");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "session.json"), JSON.stringify({
      session_id: "managed", metadata: { extras: { herderManaged: true } }, ...fields,
    }));
    const isolated = vi.spyOn(workloadLauncher, "spawnIsolatedWorkload");
    const adapter = new FastAgentFileAdapter({ home, cwd: home, fastAgentBin: "/usr/bin/true" });
    expect(await adapter.getSession("fast-agent:managed")).toMatchObject({ meta: { readOnly: true, herderManaged: true, archived: true } });
    expect(await adapter.resumeSession("fast-agent:managed")).toMatchObject({ ok: false, error: expect.stringContaining("read-only") });
    for (const queue of [false, true]) {
      expect(await adapter.sendMessage("fast-agent:managed", { message: "user reply", queue })).toMatchObject({ ok: false, error: expect.stringContaining("read-only") });
    }
    expect(isolated).not.toHaveBeenCalled();
    await expect(readFile(join(directory, "herder-execution.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("routes a direct MiniMax session through only the scoped config and inherited private token", async () => {
    const home = await fixtureHome("fast-agent-direct-");
    cleanups.push(home);
    const directory = join(home, "sessions", "direct");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "session.json"), JSON.stringify({ session_id: "direct", continuation: { cwd: home, active_agent: "herder_minimax", agents: { dev: { model: "unrelated" }, herder_minimax: { model: "MiniMax-M3.1-Flash-Preview" } } }, metadata: { extras: { model: "anthropic.MiniMax-M3.1-Flash-Preview", herderManaged: true, healthRecovery: false } } }));
    const config = join(home, "direct.yaml");
    await writeFile(config, "anthropic:\n  base_url: https://api.minimax.io/anthropic\n");
    const bin = join(home, "capture.sh");
    const argsPath = join(home, "arguments.txt");
    const envPath = join(home, "environment.txt");
    await writeFile(bin, `#!/bin/sh\nprintf '%s\n' "$@" > '${argsPath}'\nprintf '%s\n%s\n%s' "$ANTHROPIC_API_KEY" "$ANTHROPIC_AUTH_TOKEN" "$ANTHROPIC_BASE_URL" > '${envPath}'\n`);
    await chmod(bin, 0o755);
    vi.stubEnv("FAST_AGENT_MINIMAX_CONFIG", config);
    vi.stubEnv("MINIMAX_API_KEY", "test-private-token");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "unrelated-payg-token");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://unrelated.example");
    const adapter = new FastAgentFileAdapter({ home, cwd: home, fastAgentBin: bin });
    const launch = vi.spyOn(workloadLauncher, "spawnIsolatedWorkload");
    expect(await adapter.sendMessage("fast-agent:direct", { message: "diagnose only" })).toEqual({ ok: true });
    expect(launch.mock.calls[0][2].resourceProperties).toEqual(["CPUQuota=100%", "MemoryHigh=384M", "MemoryMax=768M", "MemorySwapMax=0", "TasksMax=64", "IOWeight=25"]);

    const args = (await readFile(argsPath, "utf8")).split("\n");
    expect(args).toEqual(expect.arrayContaining(["--name", "herder_minimax", "--config-path", config, "--agent-cards", "--model", "anthropic.MiniMax-M3.1-Flash-Preview", "--shell", "--timeout", "300"]));
    expect(args.join(" ")).not.toContain("test-private-token");
    expect(await readFile(envPath, "utf8")).toBe("test-private-token\n\nhttps://api.minimax.io/anthropic");
  });






  it("keeps the verified direct provider prefix after native persistence strips it", async () => {
    const home = await fixtureHome("fast-agent-provider-identity-");
    cleanups.push(home);
    const directory = join(home, "sessions", "direct-identity");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "session.json"), JSON.stringify({
      session_id: "direct-identity",
      metadata: { extras: { model: "anthropic.MiniMax-M3.1-Flash-Preview", healthRecovery: true } },
      continuation: { active_agent: "herder_minimax", agents: { dev: { model: "different-model" }, herder_minimax: { model: "MiniMax-M3.1-Flash-Preview" } } },
    }));
    const adapter = new FastAgentFileAdapter({ home, cwd: home, fastAgentBin: "/bin/true" });
    expect(await adapter.getSession("fast-agent:direct-identity")).toMatchObject({ model: "anthropic.MiniMax-M3.1-Flash-Preview" });
    await writeFile(join(directory, "session.json"), JSON.stringify({
      session_id: "direct-identity",
      metadata: { extras: { model: "anthropic.MiniMax-M3.1-Flash-Preview" } },
      continuation: { active_agent: "herder_minimax", agents: { dev: { model: "old-model" }, herder_minimax: { model: "MiniMax-M3" } } },
    }));
    expect(await adapter.getSession("fast-agent:direct-identity")).toMatchObject({ model: "MiniMax-M3" });

  });

  it("exposes native Anthropic Fast Agent tool maps and reasoning channels", async () => {
    const home = await fixtureHome("fast-agent-native-tools-");
    cleanups.push(home);
    const directory = join(home, "sessions", "native-tools");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "session.json"), JSON.stringify({ session_id: "native-tools" }));
    await writeFile(join(directory, "history_herder_minimax.json"), JSON.stringify({ messages: [
      { role: "assistant", content: [], tool_calls: { call_1: { method: "tools/call", params: { name: "bash", arguments: { command: "watchdog.py --check" } } } } },
      { role: "user", content: [], tool_results: { call_1: { content: [{ type: "text", text: '{"healthy":true}' }], isError: false } } },
      { role: "assistant", content: [{ type: "text", text: "Проверка прошла." }], channels: { reasoning: [{ type: "text", text: "Оценка результата." }] } },
    ] }));
    const adapter = new FastAgentFileAdapter({ home, cwd: home, fastAgentBin: "/bin/true" });
    const messages = await adapter.getSessionMessages("fast-agent:native-tools", 3);
    expect(messages).toMatchObject([
      { role: "assistant", parts: [{ type: "tool_call", name: "bash", input: { command: "watchdog.py --check" } }] },
      { role: "tool", parts: [{ type: "tool_result", name: "bash", output: '{"healthy":true}', error: false }] },
      { role: "assistant", parts: [{ type: "thinking", text: "Оценка результата." }, { type: "text", text: "Проверка прошла." }] },
    ]);
  });

  it("records an actual queued child failure with a bounded redacted provider explanation", async () => {
    const home = await fixtureHome("fast-agent-queue-error-");
    cleanups.push(home);
    const directory = join(home, "sessions", "queue-error");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "session.json"), JSON.stringify({ session_id: "queue-error", continuation: { cwd: home }, metadata: { extras: { herderManaged: true } } }));
    const bin = join(home, "fail.sh");
    await writeFile(bin, "#!/bin/sh\nprintf 'Provider Error: test-private-token denied\n' >&2\nexit 1\n");
    await chmod(bin, 0o755);
    vi.stubEnv("MINIMAX_API_KEY", "test-private-token");
    const adapter = new FastAgentFileAdapter({ home, cwd: home, fastAgentBin: bin });
    expect(await adapter.sendMessage("fast-agent:queue-error", { message: "check", queue: true })).toEqual({ ok: true, admitted: true, pending: true });
    let receipt: { running?: boolean; error?: string } = {};
    for (let i = 0; i < 40; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      receipt = JSON.parse(await readFile(join(directory, "herder-execution.json"), "utf8"));
      if (!receipt.running) break;
    }
    expect(receipt.error).toContain("<redacted> denied");
    expect(receipt.error).not.toContain("test-private-token");
    expect(await adapter.getSession("fast-agent:queue-error")).toMatchObject({ status: "error" });
  });

  it("shows a queued provider failure instead of a silently empty conversation", async () => {
    const home = await fixtureHome("fast-agent-failure-");
    cleanups.push(home);
    const directory = join(home, "sessions", "failed");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "session.json"), JSON.stringify({ session_id: "failed", execution: { status: "completed" } }));
    await writeFile(join(directory, "herder-execution.json"), JSON.stringify({ error: "Fast Agent завершился без нового ответа.", endedAt: "2026-10-07T18:40:00Z" }));
    const adapter = new FastAgentFileAdapter({ home, cwd: home, fastAgentBin: "/bin/true" });
    expect(await adapter.getSession("fast-agent:failed")).toMatchObject({ status: "error", meta: { lastError: expect.stringContaining("без нового ответа") } });
    expect(await adapter.getSessionMessages("fast-agent:failed", 1)).toMatchObject([{ role: "assistant", text: expect.stringContaining("без нового ответа") }]);
  });

  it("observes an empty native session before first delivery with its actual workspace and model", async () => {
    const home = await fixtureHome("fast-agent-empty-");
    cleanups.push(home);
    const sessionDir = join(home, "sessions", "native-empty");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session.json"), JSON.stringify({
      session_id: "native-empty", metadata: { title: "Independent recovery", extras: { model: "anthropic.MiniMax-M3.1-Flash-Preview", healthRecovery: true } },
      continuation: { cwd: "/actual/workspace", agents: {} },
    }));
    const adapter = new FastAgentFileAdapter({ home, cwd: "/fallback", fastAgentBin: "/usr/bin/true" });
    expect(await adapter.getSession("fast-agent:native-empty")).toMatchObject({
      cwd: "/actual/workspace", model: "anthropic.MiniMax-M3.1-Flash-Preview", messageCount: 0, meta: { healthRecovery: true },
    });
  });

  it("does not revive a completed session when a stale shell PID was reused", async () => {
    const home = await fixtureHome("fast-agent-live-");
    cleanups.push(home);
    const sessionDir = join(home, "sessions", "session-live");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session.json"), JSON.stringify({ session_id: "session-live", execution: { status: "completed" } }));
    await writeFile(join(sessionDir, "history_dev.json"), JSON.stringify({ messages: [{
      role: "tool", timestamp: new Date().toISOString(), content: [{ type: "tool_result", content: JSON.stringify({
        "fast-agent-shell-process-metadata": { process_status: "running", os_process_id: process.pid }
      }) }]
    }] }));
    const adapter = new FastAgentFileAdapter({ home, cwd: home, fastAgentBin: "/usr/bin/true" });
    const [session] = await adapter.listSessions();
    expect(session.status).toBe("stopped");
  });

  it("separates embedded MiniMax reasoning from the visible answer", async () => {
    const home = await fixtureHome("fast-agent-think-");
    cleanups.push(home);
    const sessionDir = join(home, "sessions", "session-think");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session.json"), JSON.stringify({ session_id: "session-think", execution: { status: "completed" } }));
    await writeFile(join(sessionDir, "history_dev.json"), JSON.stringify({ messages: [{
      role: "assistant", timestamp: new Date().toISOString(), content: [{ type: "text", text: "<think>internal plan</think>\n\nГотово." }]
    }] }));
    const adapter = new FastAgentFileAdapter({ home, cwd: home, fastAgentBin: "/usr/bin/true" });
    const messages = await adapter.getSessionMessages("fast-agent:session-think", 1);
    expect(messages?.[0].parts).toEqual([
      { type: "thinking", text: "internal plan" },
      { type: "text", text: "Готово." },
    ]);
    expect(messages?.[0].text).toBe("internal plan\nГотово.");
  });

  it("lists native sessions and exposes recent messages without starting a process", async () => {
    const home = await fixtureHome("fast-agent-");
    cleanups.push(home);
    const sessionDir = join(home, "sessions", "session-1");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session.json"), JSON.stringify({
      session_id: "session-1",
      created_at: "2026-08-18T10:00:00.000Z",
      last_activity: "2026-08-18T10:01:00.000Z",
      metadata: { first_user_preview: "Inspect the project", extras: { harness_session_id: "session-1" } },
      execution: { status: "completed" },
    }));
    await writeFile(join(sessionDir, "history_dev.json"), JSON.stringify({ messages: [
      { role: "user", timestamp: "2026-08-18T10:00:00.000Z", content: [{ type: "text", text: "Inspect the project" }] },
      { role: "assistant", timestamp: "2026-08-18T10:01:00.000Z", content: [{ type: "text", text: "I inspected it." }] },
    ] }));

    const adapter = new FastAgentFileAdapter({ home, cwd: home, fastAgentBin: "/usr/bin/true" });
    await adapter.init();
    const sessions = await adapter.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: "fast-agent:session-1",
      harness: "fast-agent",
      status: "stopped",
      title: "Inspect the project",
      cwd: home,
      messageCount: 2,
      lastMessage: "I inspected it.",
    });
    expect(await adapter.getSessionMessages("fast-agent:session-1", 1)).toMatchObject([{ text: "I inspected it." }]);
    expect(await adapter.sendMessage("fast-agent:session-1", { message: "continue work" })).toMatchObject({ ok: false, error: expect.stringContaining("read-only") });
    expect(await adapter.sendMessage("fast-agent:session-1", { message: "continue in background", queue: true })).toMatchObject({ ok: false });
  });
});
