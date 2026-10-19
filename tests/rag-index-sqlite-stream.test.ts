import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHerderRag } from "../src/rag-search.js";

describe("Agent Herder SQLite indexing", () => {
  let temporaryDirectory: string | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  });

  it("streams only user/assistant text parts in bounded message batches", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "herder-rag-sqlite-"));
    const databasePath = join(temporaryDirectory, "source.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE session (id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE INDEX message_session_time_created_id_idx ON message(session_id,time_created,id);
      CREATE INDEX part_message_id_id_idx ON part(message_id,id);
    `);
    const updated = Date.now();
    database.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?)").run("session-1", "History", "/repo", updated, updated);
    const insertMessage = database.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    const insertPart = database.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
    for (let index = 0; index < 25; index++) {
      const id = `message-${String(index).padStart(2, "0")}`;
      insertMessage.run(id, "session-1", updated + index, updated + index, JSON.stringify({ role: index % 2 ? "assistant" : "user" }));
      insertPart.run(`text-${index}`, id, "session-1", updated + index, updated + index, JSON.stringify({ type: "text", text: `indexable historical text ${index}` }));
      insertPart.run(`reasoning-${index}`, id, "session-1", updated + index, updated + index, JSON.stringify({ type: "reasoning", text: "not indexed" }));
      insertPart.run(`tool-${index}`, id, "session-1", updated + index, updated + index, JSON.stringify({ type: "tool", state: "x".repeat(64 * 1024) }));
    }
    insertMessage.run("tool-message", "session-1", updated + 50, updated + 50, JSON.stringify({ role: "tool" }));
    insertPart.run("tool-message-part", "tool-message", "session-1", updated + 50, updated + 50, JSON.stringify({ type: "text", text: "tool output must not enter RAG" }));
    database.close();

    vi.stubEnv("AGENT_HERDER_EMBEDDING_TOKEN", "test-token");
    const embeddingBatchSizes: number[] = [];
    const upsertBatchSizes: number[] = [];
    const embeddedTexts: string[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as { input?: string[]; points?: Array<{ payload: { text: string } }> };
      if (url.endsWith("/points/delete?wait=true")) return Response.json({ result: { status: "completed" } });
      if (url.includes("/v1/embeddings")) {
        const inputs = body.input ?? [];
        embeddingBatchSizes.push(inputs.length);
        embeddedTexts.push(...inputs);
        return Response.json({ data: inputs.map(() => ({ embedding: Array(2048).fill(0.25) })) });
      }
      if (url.includes("/points?wait=true")) {
        const points = body.points ?? [];
        upsertBatchSizes.push(points.length);
        return Response.json({ result: { status: "completed" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const rag = new AgentHerderRag();
    (rag as any).state = {
      options: { enabled: true, harnesses: { codex: true, zcode: true, opencode: true } },
      checkpoints: {},
      run: { status: "running", startedAt: new Date(updated).toISOString(), updatedAt: new Date(updated).toISOString(), processed: 0, indexed: 0 },
    };
    vi.spyOn(rag as any, "save").mockResolvedValue(undefined);

    await (rag as any).indexSqlite("zcode", databasePath, (rag as any).state);

    expect(embeddingBatchSizes).toEqual([16, 8, 1]);
    expect(upsertBatchSizes).toEqual([16, 8, 1]);
    expect(embeddedTexts).toEqual(Array.from({ length: 25 }, (_, index) => `indexable historical text ${index}`));
    expect((rag as any).state.run.processed).toBe(1);
    expect((rag as any).state.run.indexed).toBe(25);
    expect((rag as any).state.checkpoints["zcode:session-1"]).toBe(updated);
  }, 15_000);
});
