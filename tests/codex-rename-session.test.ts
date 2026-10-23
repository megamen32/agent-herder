import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";

const roots: string[] = [];
const fixture = join(process.cwd(), "tests/fixtures/fake-codex-app-server.mjs");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** One native rollout of a thread, so the history of the thread is observable. */
async function seedRollout(codexDir: string, threadId: string, text: string): Promise<void> {
  const sessionDir = join(codexDir, "sessions", "2026", "10", "23");
  await mkdir(sessionDir, { recursive: true });
  const rolloutPath = join(sessionDir, `rollout-${threadId}.jsonl`);
  const record = (type: string, payload: unknown) => JSON.stringify({ type, timestamp: "2026-10-23T10:00:00.000Z", payload });
  await writeFile(rolloutPath, [
    record("session_meta", { id: threadId, session_id: threadId, cwd: "/tmp/codex-fixture" }),
    record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] }),
    record("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "history stays" }] }),
    "",
  ].join("\n"));
  await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: threadId, updated_at: "2026-10-23T10:00:00.000Z" }) + "\n");
  const db = new DatabaseSync(join(codexDir, "state_5.sqlite"));
  db.exec("create table threads (id text, rollout_path text, cwd text, model text, preview text, updated_at_ms integer, thread_source text, agent_role text, is_pinned integer)");
  db.prepare("insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    threadId, rolloutPath, "/tmp/codex-fixture", "gpt-test", "history stays", Date.parse("2026-10-23T10:00:00.000Z"), null, null, 0,
  );
  db.close();
}

async function nativeRequests(logPath: string): Promise<Array<{ method: string; params: Record<string, unknown> }>> {
  const raw = await readFile(logPath, "utf8").catch(() => "");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
    .filter((event) => event.kind === "request");
}

describe("Codex native rename of an existing thread", () => {
  it("changes the title of the same thread, keeps its id and history, and starts no turn", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-rename-"));
    roots.push(codexDir);
    await seedRollout(codexDir, "thread-1", "the original task");
    const logPath = join(codexDir, "requests.jsonl");
    const previousLog = process.env.CODEX_APP_SERVER_LOG;
    process.env.CODEX_APP_SERVER_LOG = logPath;
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await adapter.init();
      const before = await adapter.getSession("thread-1");
      expect(before?.id).toBe("thread-1");

      const result = await adapter.renameSession("thread-1", { title: "Notice Place | голосовой секретарь | координация" });
      expect(result).toMatchObject({ ok: true, sessionId: "thread-1", previousTitle: null });
      expect(result.title).toBe("Notice Place | голосовой секретарь | координация");

      // The native readback of the same thread shows the new title.
      await expect(adapter.getSession("thread-1")).resolves.toMatchObject({
        id: "thread-1",
        title: "Notice Place | голосовой секретарь | координация",
      });
      // The thread id and the history of the session are untouched.
      await expect(adapter.getSessionMessages("thread-1", 10)).resolves.toMatchObject([
        { role: "user", text: "the original task" },
        { role: "assistant", text: "history stays" },
      ]);

      const requests = await nativeRequests(logPath);
      const methods = requests.map((request) => request.method);
      expect(methods).toContain("thread/name/set");
      expect(methods).not.toContain("thread/start");
      expect(methods).not.toContain("turn/start");
      expect(methods).not.toContain("turn/interrupt");
      expect(methods).not.toContain("thread/delete");
      const set = requests.find((request) => request.method === "thread/name/set");
      expect(set?.params).toMatchObject({ threadId: "thread-1", name: "Notice Place | голосовой секретарь | координация" });
    } finally {
      await adapter.dispose();
      if (previousLog === undefined) delete process.env.CODEX_APP_SERVER_LOG;
      else process.env.CODEX_APP_SERVER_LOG = previousLog;
    }
  });

  it("keeps an active turn running while the title changes", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-rename-running-"));
    roots.push(codexDir);
    const logPath = join(codexDir, "requests.jsonl");
    const previousLog = process.env.CODEX_APP_SERVER_LOG;
    const previousStatus = process.env.CODEX_APP_SERVER_THREAD_STATUS;
    process.env.CODEX_APP_SERVER_LOG = logPath;
    process.env.CODEX_APP_SERVER_THREAD_STATUS = "active";
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await adapter.init();
      const result = await adapter.renameSession("thread-1", { title: "LHC | понятные планы | завершение релиза" });
      expect(result.ok).toBe(true);
      await expect(adapter.getSession("thread-1")).resolves.toMatchObject({ status: "running" });
      const methods = (await nativeRequests(logPath)).map((request) => request.method);
      expect(methods).not.toContain("turn/interrupt");
      expect(methods).not.toContain("turn/start");
    } finally {
      await adapter.dispose();
      if (previousLog === undefined) delete process.env.CODEX_APP_SERVER_LOG;
      else process.env.CODEX_APP_SERVER_LOG = previousLog;
      if (previousStatus === undefined) delete process.env.CODEX_APP_SERVER_THREAD_STATUS;
      else process.env.CODEX_APP_SERVER_THREAD_STATUS = previousStatus;
    }
  });

  it("refuses an empty title and an unknown thread without a false success", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-rename-empty-"));
    roots.push(codexDir);
    const logPath = join(codexDir, "requests.jsonl");
    const previousLog = process.env.CODEX_APP_SERVER_LOG;
    process.env.CODEX_APP_SERVER_LOG = logPath;
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await adapter.init();
      const empty = await adapter.renameSession("thread-1", { title: "   " });
      expect(empty.ok).toBe(false);
      expect(empty.error).toMatch(/title is required/i);
      const unknown = await adapter.renameSession("thread-does-not-exist", { title: "ExManager | команды и поручения | приёмка" });
      expect(unknown.ok).toBe(false);
      expect(unknown.error).toMatch(/not found/i);
      const methods = (await nativeRequests(logPath)).map((request) => request.method);
      expect(methods).not.toContain("thread/name/set");
    } finally {
      await adapter.dispose();
      if (previousLog === undefined) delete process.env.CODEX_APP_SERVER_LOG;
      else process.env.CODEX_APP_SERVER_LOG = previousLog;
    }
  });

  it("keeps a long unicode title whole instead of cutting it", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-rename-long-"));
    roots.push(codexDir);
    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    const title = `Проект ${"я".repeat(200)} | цель ${"ё".repeat(200)} | этап`;
    try {
      await adapter.init();
      const result = await adapter.renameSession("thread-1", { title });
      expect(result.ok).toBe(true);
      expect(result.title).toBe(title);
      await expect(adapter.getSession("thread-1")).resolves.toMatchObject({ title });
    } finally {
      await adapter.dispose();
    }
  });
});
