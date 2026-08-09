import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";

const fixture = join(process.cwd(), "tests/fixtures/fake-codex-app-server.mjs");

describe("Codex app-server adapter", () => {
  it("discovers persisted sessions without spawning the app-server", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-lazy-"));
    const sessionDir = join(codexDir, "sessions", "2026", "07", "30");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(codexDir, "session_index.jsonl"), [
      JSON.stringify({ id: "thread-lazy", thread_name: "Older", updated_at: "2026-01-01T00:00:00Z" }),
      JSON.stringify({ id: "thread-lazy", thread_name: "Existing", updated_at: new Date().toISOString() }),
    ].join("\n") + "\n");
    await writeFile(join(sessionDir, "rollout-thread-lazy.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { session_id: "thread-lazy", id: "thread-lazy", parent_thread_id: "thread-parent", thread_source: "subagent", agent_role: "worker", cwd: "/workspace" } }),
    ].join("\n") + "\n");
    const adapter = new CodexAppServerAdapter({ codexBin: "/definitely/not-started", codexDir });
    try {
      const sessions = await adapter.listSessions();
      expect(sessions).toMatchObject([{ id: "thread-lazy", title: "Existing", cwd: "/workspace", meta: { parentThreadId: "thread-parent", threadSource: "subagent", agentRole: "worker" } }]);
      expect(sessions).toHaveLength(1);
      expect(adapter.isReady()).toBe(false);
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("keeps a native thread, interrupts turns, resumes, and forks", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-app-"));
    const sessionDir = join(codexDir, "sessions", "2026", "07", "30");
    const rawPath = join(sessionDir, "rollout-thread-1.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(rawPath, [
      JSON.stringify({ type: "session_meta", payload: { session_id: "thread-1", id: "thread-1", parent_thread_id: "thread-parent", thread_source: "subagent", agent_role: "worker", cwd: "/workspace" } }),
      '{"type":"response_item"}',
    ].join("\n") + "\n");
    const adapter = new CodexAppServerAdapter({
      codexBin: process.execPath,
      args: [fixture],
      modelIds: ["gpt-test", "gpt-test-2"],
      codexDir,
    });
    try {
      await adapter.init();
      const sessions = await adapter.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("thread-1");
      expect(sessions[0].harness).toBe("codex");
      expect(sessions[0].meta).toMatchObject({ parentThreadId: "thread-parent", threadSource: "subagent", agentRole: "worker" });

      const created = await adapter.createSession({ name: "repair_100", cwd: "/tmp/codex-repair" });
      expect(created).toMatchObject({
        id: "thread-created-1",
        harness: "codex",
        title: "repair_100",
        cwd: "/tmp/codex-repair",
      });

      const raw = await adapter.getRawTranscript?.("thread-1");
      expect(raw).toMatchObject({ complete: true, source: { kind: "native-file", location: rawPath, format: "jsonl" } });
      expect(raw?.bytes.toString("utf8")).toContain('"session_id":"thread-1"');

      const queued = await adapter.sendMessage("thread-1", { message: "hold", queue: true });
      expect(queued).toEqual({ ok: true });
      expect(await adapter.cancelTurn("thread-1")).toEqual({ ok: true });
      expect(await adapter.resumeSession("thread-1")).toEqual({ ok: true });
      expect(await adapter.changeModel("thread-1", "gpt-test-2")).toEqual({ ok: true });

      const forked = await adapter.forkSession("thread-1", "continue in a child");
      expect(forked.ok).toBe(true);
      expect(forked.sessionId).toBe("thread-fork-1");
      expect(await adapter.listModels()).toEqual(["gpt-test", "gpt-test-2"]);
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("uses session_meta.id as the child identity when session_id names the parent", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-subagent-meta-"));
    const sessionDir = join(codexDir, "sessions", "2026", "07", "30");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-child", thread_name: "Child", updated_at: new Date().toISOString() }) + "\n");
    await writeFile(join(sessionDir, "rollout-thread-child.jsonl"), JSON.stringify({
      type: "session_meta",
      payload: { session_id: "thread-parent", id: "thread-child", parent_thread_id: "thread-parent", thread_source: "subagent", agent_nickname: "worker", cwd: "/workspace" },
    }) + "\n");
    const adapter = new CodexAppServerAdapter({ codexBin: "/definitely/not-started", codexDir });
    try {
      const sessions = await adapter.listSessions();
      expect(sessions).toMatchObject([{ id: "thread-child", meta: { parentThreadId: "thread-parent", threadSource: "subagent", agentRole: "worker" } }]);
    } finally {
      await adapter.dispose();
      await rm(codexDir, { recursive: true, force: true });
    }
  });
});
