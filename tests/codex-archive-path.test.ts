import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";

const roots: string[] = [];
const fixture = join(process.cwd(), "tests/fixtures/fake-codex-app-server.mjs");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Codex archived rollout path refresh", () => {
  it("refreshes one exact cached ID after archive moves its transcript and keeps history and stop evidence", async () => {
    const codexDir = await mkdtemp(join(tmpdir(), "agent-herder-codex-archive-path-"));
    roots.push(codexDir);
    const initialDir = join(codexDir, "sessions", "2026", "10", "06");
    const archivedDir = join(codexDir, "archived_threads", "2026", "10", "06");
    const initialPath = join(initialDir, "rollout-thread-1.jsonl");
    const archivedPath = join(archivedDir, "rollout-thread-1.jsonl");
    await mkdir(initialDir, { recursive: true });
    await mkdir(archivedDir, { recursive: true });
    const record = (type: string, payload: unknown) => JSON.stringify({ type, timestamp: "2026-10-06T10:00:00.000Z", payload });
    await writeFile(initialPath, [
      record("session_meta", { id: "thread-1", session_id: "thread-1", cwd: "/tmp/codex-fixture" }),
      record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "retain the archived history" }] }),
      record("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "completed before archiving" }] }),
      record("event_msg", { type: "turn_aborted", reason: "interrupted", turn_id: "stop-turn-1", completed_at: "2026-10-06T10:00:00.000Z" }),
      "",
    ].join("\n"));
    await writeFile(join(codexDir, "session_index.jsonl"), JSON.stringify({ id: "thread-1", updated_at: "2026-10-06T10:00:00.000Z" }) + "\n");
    const db = new DatabaseSync(join(codexDir, "state_5.sqlite"));
    db.exec("create table threads (id text, rollout_path text, cwd text, model text, preview text, updated_at_ms integer, thread_source text, agent_role text, is_pinned integer)");
    db.exec("create table thread_spawn_edges (child_thread_id text, parent_thread_id text)");
    db.prepare("insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "thread-1", initialPath, "/tmp/codex-fixture", "gpt-test", "completed before archiving", Date.parse("2026-10-06T10:00:00.000Z"), null, null, 0,
    );
    db.close();

    const adapter = new CodexAppServerAdapter({ codexBin: process.execPath, args: [fixture], codexDir });
    try {
      await adapter.init();
      await expect(adapter.getSessionMessages("thread-1", 10)).resolves.toMatchObject([
        { role: "user", text: "retain the archived history" },
        { role: "assistant", text: "completed before archiving" },
      ]);
      await expect(adapter.getSession("thread-1")).resolves.toMatchObject({
        meta: { automationStop: { id: "stop-turn-1", turnId: "stop-turn-1", reason: "interrupted" } },
      });

      await expect(adapter.archiveSession("thread-1")).resolves.toMatchObject({ ok: true });
      await rename(initialPath, archivedPath);
      const update = new DatabaseSync(join(codexDir, "state_5.sqlite"));
      update.prepare("update threads set rollout_path = ? where id = ?").run(archivedPath, "thread-1");
      update.close();

      await expect(adapter.getSession("thread-1")).resolves.toMatchObject({
        id: "thread-1", harness: "codex",
        meta: {
          sessionFilePath: archivedPath,
          automationStop: { id: "stop-turn-1", turnId: "stop-turn-1", reason: "interrupted" },
        },
      });
      await expect(adapter.listSessions()).resolves.toEqual([]);
      await expect(adapter.getSessionMessages("thread-1", 10)).resolves.toMatchObject([
        { role: "user", text: "retain the archived history" },
        { role: "assistant", text: "completed before archiving" },
      ]);

      const unindexedPath = join(codexDir, "unindexed", "rollout-thread-1.jsonl");
      await mkdir(join(codexDir, "unindexed"), { recursive: true });
      await rename(archivedPath, unindexedPath);
      // A fresh native thread/read remains authoritative even when the archive
      // has moved outside the index. This must not invent a raw transcript.
      await expect(adapter.getSession("thread-1")).resolves.toMatchObject({ id: "thread-1", status: "idle" });
      await expect(adapter.getRawTranscript("thread-1")).resolves.toBeNull();
    } finally {
      await adapter.dispose();
    }
  });
});
