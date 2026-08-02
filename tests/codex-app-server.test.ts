import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";

const fixture = join(process.cwd(), "tests/fixtures/fake-codex-app-server.mjs");

describe("Codex app-server adapter", () => {
  it("keeps a native thread, interrupts turns, resumes, and forks", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-app-"));
    const sessionDir = join(codexDir, "sessions", "2026", "07", "30");
    const rawPath = join(sessionDir, "rollout-thread-1.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(rawPath, '{"session_id":"thread-1","cwd":"/workspace"}\n{"type":"response_item"}\n');
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
});
