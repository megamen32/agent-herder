import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";

it("reads the app server's native transcript from its isolated CODEX_HOME", async () => {
  const home = await mkdtemp(join(tmpdir(), "herder-codex-home-"));
  try {
    vi.stubEnv("CODEX_HOME", home);
    vi.stubEnv("CODEX_DATA_DIR", "");
    const dir = join(home, "sessions", "2026", "11", "07");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "rollout-ci-thread.jsonl");
    await writeFile(file, [
      JSON.stringify({ type: "session_meta", payload: { id: "ci-thread", cwd: "/tmp/ci" } }),
      JSON.stringify({ type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "fixture request" }] } }),
      JSON.stringify({ type: "response_item", payload: { role: "assistant", content: [{ type: "output_text", text: "fixture answer" }] } }),
    ].join("\n") + "\n");
    const adapter = new CodexAppServerAdapter({ codexBin: "/unused" });
    const transcript = await adapter.getRawTranscript("ci-thread");
    expect(transcript).toMatchObject({ complete: true, source: { kind: "native-file", location: file } });
    expect(transcript?.bytes.toString()).toContain("fixture answer");
  } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
});

it.each([false, true])("finds a newly created session with a warm cache (indexed=%s)", async (indexed) => {
  const home = await mkdtemp(join(tmpdir(), "herder-codex-cache-"));
  let db: DatabaseSync | undefined;
  try {
    const dir = join(home, "sessions", "2026", "11", "07");
    await mkdir(dir, { recursive: true });
    if (indexed) {
      db = new DatabaseSync(join(home, "state_5.sqlite"));
      db.exec("create table threads(id text primary key, rollout_path text, cwd text, model text, preview text, updated_at_ms integer, thread_source text, agent_role text); create table thread_spawn_edges(child_thread_id text, parent_thread_id text)");
    }
    const add = async (id: string) => {
      const file = join(dir, `rollout-${id}.jsonl`);
      await writeFile(file, JSON.stringify({ type: "session_meta", payload: { id, cwd: "/tmp/ci" } }) + "\n");
      db?.prepare("insert into threads(id,rollout_path) values(?,?)").run(id, file);
    };
    await add("first");
    const adapter = new CodexAppServerAdapter({ codexBin: "/unused", codexDir: home });
    expect(await adapter.getRawTranscript("first")).toMatchObject({ complete: true });
    await add("second");
    expect(await adapter.getRawTranscript("second")).toMatchObject({ complete: true });
  } finally { db?.close(); await rm(home, { recursive: true, force: true }); }
});
