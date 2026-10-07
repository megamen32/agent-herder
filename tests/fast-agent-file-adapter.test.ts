import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FastAgentFileAdapter } from "../src/adapters/fast-agent.js";

const cleanups: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Fast Agent persisted observer", () => {


  it("routes a direct MiniMax session through only the scoped config and inherited private token", async () => {
    const home = await mkdtemp(join(process.cwd(), "tests/.tmp-fast-agent-direct-"));
    cleanups.push(home);
    const directory = join(home, "sessions", "direct");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "session.json"), JSON.stringify({ session_id: "direct", continuation: { cwd: home }, metadata: { extras: { model: "anthropic.MiniMax-M3.1-Flash-Preview", healthRecovery: true } } }));
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
    expect(await adapter.sendMessage("fast-agent:direct", { message: "diagnose only" })).toEqual({ ok: true });
    const args = (await readFile(argsPath, "utf8")).split("\n");
    expect(args).toEqual(expect.arrayContaining(["--name", "herder_minimax", "--config-path", config, "--agent-cards", "--model", "anthropic.MiniMax-M3.1-Flash-Preview", "--shell", "--timeout", "300"]));
    expect(args.join(" ")).not.toContain("test-private-token");
    expect(await readFile(envPath, "utf8")).toBe("test-private-token\n\nhttps://api.minimax.io/anthropic");
  });



  it("records an actual queued child failure with a bounded redacted provider explanation", async () => {
    const home = await mkdtemp(join(process.cwd(), "tests/.tmp-fast-agent-queue-error-"));
    cleanups.push(home);
    const directory = join(home, "sessions", "queue-error");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "session.json"), JSON.stringify({ session_id: "queue-error", continuation: { cwd: home } }));
    const bin = join(home, "fail.sh");
    await writeFile(bin, "#!/bin/sh\nprintf 'Provider Error: test-private-token denied\n' >&2\nexit 1\n");
    await chmod(bin, 0o755);
    vi.stubEnv("MINIMAX_API_KEY", "test-private-token");
    const adapter = new FastAgentFileAdapter({ home, cwd: home, fastAgentBin: bin });
    expect(await adapter.sendMessage("fast-agent:queue-error", { message: "check", queue: true })).toEqual({ ok: true });
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
    const home = await mkdtemp(join(process.cwd(), "tests/.tmp-fast-agent-failure-"));
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
    const home = await mkdtemp(join(process.cwd(), "tests/.tmp-fast-agent-empty-"));
    cleanups.push(home);
    const sessionDir = join(home, "sessions", "native-empty");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session.json"), JSON.stringify({
      session_id: "native-empty", metadata: { title: "Independent recovery", extras: { model: "anthropic.MiniMax-M3.1-Flash-Preview", healthRecovery: true } },
      continuation: { cwd: "/actual/workspace", agents: {} },
    }));
    const adapter = new FastAgentFileAdapter({ home, cwd: "/fallback", fastAgentBin: "/bin/true" });
    expect(await adapter.getSession("fast-agent:native-empty")).toMatchObject({
      cwd: "/actual/workspace", model: "anthropic.MiniMax-M3.1-Flash-Preview", messageCount: 0, meta: { healthRecovery: true },
    });
  });

  it("does not revive a completed session when a stale shell PID was reused", async () => {
    const home = await mkdtemp(join(process.cwd(), "tests/.tmp-fast-agent-live-"));
    cleanups.push(home);
    const sessionDir = join(home, "sessions", "session-live");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session.json"), JSON.stringify({ session_id: "session-live", execution: { status: "completed" } }));
    await writeFile(join(sessionDir, "history_dev.json"), JSON.stringify({ messages: [{
      role: "tool", timestamp: new Date().toISOString(), content: [{ type: "tool_result", content: JSON.stringify({
        "fast-agent-shell-process-metadata": { process_status: "running", os_process_id: process.pid }
      }) }]
    }] }));
    const adapter = new FastAgentFileAdapter({ home, cwd: home, fastAgentBin: "/bin/true" });
    const [session] = await adapter.listSessions();
    expect(session.status).toBe("stopped");
  });

  it("separates embedded MiniMax reasoning from the visible answer", async () => {
    const home = await mkdtemp(join(process.cwd(), "tests/.tmp-fast-agent-think-"));
    cleanups.push(home);
    const sessionDir = join(home, "sessions", "session-think");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session.json"), JSON.stringify({ session_id: "session-think", execution: { status: "completed" } }));
    await writeFile(join(sessionDir, "history_dev.json"), JSON.stringify({ messages: [{
      role: "assistant", timestamp: new Date().toISOString(), content: [{ type: "text", text: "<think>internal plan</think>\n\nГотово." }]
    }] }));
    const adapter = new FastAgentFileAdapter({ home, cwd: home, fastAgentBin: "/bin/true" });
    const messages = await adapter.getSessionMessages("fast-agent:session-think", 1);
    expect(messages?.[0].parts).toEqual([
      { type: "thinking", text: "internal plan" },
      { type: "text", text: "Готово." },
    ]);
    expect(messages?.[0].text).toBe("internal plan\nГотово.");
  });

  it("lists native sessions and exposes recent messages without starting a process", async () => {
    const home = await mkdtemp(join(process.cwd(), "tests/.tmp-fast-agent-"));
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

    const adapter = new FastAgentFileAdapter({ home, cwd: home, fastAgentBin: "/bin/true" });
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
    expect(await adapter.sendMessage("fast-agent:session-1", { message: "continue work" })).toEqual({ ok: true });
    expect(await adapter.sendMessage("fast-agent:session-1", { message: "continue in background", queue: true })).toEqual({ ok: true });
  });
});
