import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { HermesAdapter } from "../src/adapters/hermes/adapter.js";
import type { HermesJobSpawner } from "../src/adapters/hermes/adapter.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  readonly kill = vi.fn(() => true);
}

describe("Hermes CLI job adapter", () => {
  it("fails closed when an unknown session observation bridge never responds", async () => {
    const adapter = new HermesAdapter({
      // Deliberately use a bridge that accepted the connection but never
      // returns a lookup result, matching the historical post-restart route.
      client: { async callTool() { return await new Promise<never>(() => undefined); } },
      observationTimeoutMs: 10,
    } as ConstructorParameters<typeof HermesAdapter>[0]);

    const outcome = await Promise.race([
      adapter.getSession("lost-hermes-session"),
      new Promise<"test-timeout">((resolve) => setTimeout(() => resolve("test-timeout"), 100)),
    ]);

    expect(outcome).toBeNull();
  });

  it("starts a bounded health job with the canonical model, provider, and reasoning", async () => {
    const child = new FakeChild();
    let command = "";
    let args: string[] = [];
    const spawnJob: HermesJobSpawner = (nextCommand, nextArgs) => {
      command = nextCommand;
      args = nextArgs;
      return child as unknown as ChildProcessWithoutNullStreams;
    };
    const adapter = new HermesAdapter({
      hermesBin: "/opt/hermes/bin/hermes",
      jobProvider: "openai-codex",
      jobReasoning: "high",
      jobToolsets: "terminal",
      spawnJob,
    });

    const session = await adapter.createSession({ name: "health-inc-1-repair", cwd: "/tmp" });
    expect(session.harness).toBe("hermes");
    expect((await adapter.changeModel(session.id, "gpt-5.6-luna")).ok).toBe(true);
    expect(await adapter.sendMessage(session.id, { message: "Repair only the selected synthetic incident.", queue: true })).toEqual({ ok: true });
    expect(command).toBe("/opt/hermes/bin/hermes");
    expect(args).toEqual([
      "chat", "-q", "Repair only the selected synthetic incident.",
      "--model", "gpt-5.6-luna",
      "--provider", "openai-codex",
      "--reasoning", "high",
      "--toolsets", "terminal",
      "--source", "agent-herder-health",
    ]);

    child.stdout.write("Session: 20260809_000000_canary\nHERMES_JOB_OK\n");
    child.emit("exit", 0, null);
    const finished = await adapter.getSession(session.id);
    expect(finished).toMatchObject({ status: "stopped", model: "gpt-5.6-luna", messageCount: 3 });
    expect(finished?.meta).toMatchObject({ nativeSessionId: "20260809_000000_canary", transport: "hermes-cli-job" });
    expect((await adapter.getTranscript(session.id)) || "").toContain("HERMES_JOB_OK");
    const raw = await adapter.getRawTranscript(session.id);
    expect(raw?.source.kind).toBe("observed-cli-output");
    expect(JSON.parse(new TextDecoder().decode(raw!.bytes))).toMatchObject({
      schema: "agent-herder.hermes-cli-trace.v1",
      native_session_id: "20260809_000000_canary",
      stdout: expect.stringContaining("HERMES_JOB_OK"),
    });
  });

  it("terminates a hung CLI job at the configured wall-clock deadline", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const adapter = new HermesAdapter({
        jobTimeoutMs: 1_000,
        spawnJob: () => child as unknown as ChildProcessWithoutNullStreams,
      });
      const session = await adapter.createSession({ name: "health-timeout", cwd: "/tmp" });
      await adapter.changeModel(session.id, "gpt-5.6-luna");
      await adapter.sendMessage(session.id, { message: "wait", queue: true });
      await vi.advanceTimersByTimeAsync(1_001);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(await adapter.getSession(session.id)).toMatchObject({ status: "error" });
      expect((await adapter.getSession(session.id))?.meta).toMatchObject({ timedOut: true, terminationReason: "timeout", timeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(5_001);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not expose public MCP model control as a fake CLI capability", async () => {
    const adapter = new HermesAdapter({ client: { async callTool() { return { conversations: [] }; } } });
    expect(await adapter.changeModel("telegram:missing", "gpt-5.6-luna")).toEqual({
      ok: false,
      error: "Hermes public MCP surface does not expose model switching",
    });
  });
});
