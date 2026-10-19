import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHerderRag } from "../src/rag-search.js";

describe("Agent Herder RAG indexing batches", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("embeds up to 16 chunks per request and writes every chunk exactly once", async () => {
    vi.stubEnv("AGENT_HERDER_EMBEDDING_TOKEN", "test-token");
    const embeddingBatchSizes: number[] = [];
    const upsertBatchSizes: number[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as { input?: string[]; points?: unknown[] };
      if (url.includes("/v1/embeddings")) {
        embeddingBatchSizes.push(body.input?.length ?? 0);
        return Response.json({
          data: (body.input ?? []).map(() => ({ embedding: Array(2048).fill(0.25) })),
        });
      }
      if (url.includes("/points?wait=true")) {
        upsertBatchSizes.push(body.points?.length ?? 0);
        return Response.json({ result: { status: "completed" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const rag = new AgentHerderRag();
    (rag as any).state = {
      options: { enabled: true, harnesses: { codex: true, zcode: true, opencode: true } },
      checkpoints: {},
      run: { status: "running", startedAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:00:00.000Z", processed: 0, indexed: 0 },
    };
    vi.spyOn(rag as any, "save").mockResolvedValue(undefined);

    const messages = Array.from({ length: 17 }, (_, index) => ({
      id: `message-${index}`,
      role: "user",
      text: `Historical message ${index}: ${"x".repeat(40)}`,
    }));
    const indexed = await (rag as any).indexMessages("codex", { id: "session-1" }, messages);

    expect(embeddingBatchSizes).toEqual([16, 1]);
    expect(upsertBatchSizes).toEqual([16, 1]);
    expect(indexed).toBe(17);
    expect((rag as any).state.run.indexed).toBe(17);
  });
});
