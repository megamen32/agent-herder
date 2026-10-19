import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHerderRag } from "../src/rag-search.js";

describe("Agent Herder RAG settings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("enables indexing without waiting for an embedding inference request", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      if (String(input).includes("/collections/agent_herder_sessions_v1")) {
        return Response.json({ result: { config: { params: { vectors: { size: 2048 } } } } });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const rag = new AgentHerderRag();
    (rag as any).state = {
      options: { enabled: false, harnesses: { codex: true, zcode: true, opencode: true } },
      checkpoints: { "codex:existing": 123 },
      run: { status: "paused", startedAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:00:00.000Z", processed: 1, indexed: 20 },
    };
    vi.spyOn(rag as any, "save").mockResolvedValue(undefined);
    const startIndex = vi.spyOn(rag as any, "startIndex").mockImplementation(() => {});

    const settings = await rag.setSettings({ enabled: true });

    expect(settings).toMatchObject({ enabled: true, run: { status: "paused", processed: 1, indexed: 20 } });
    expect((rag as any).state.checkpoints["codex:existing"]).toBe(123);
    expect(startIndex).toHaveBeenCalledWith(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
