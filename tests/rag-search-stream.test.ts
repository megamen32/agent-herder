import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHerderRag } from "../src/rag-search.js";

class CaptureResponse extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = "";
  destroyed = false;

  writeHead(statusCode: number, headers: Record<string, string>): this {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  flushHeaders(): void {}

  write(chunk: string): boolean {
    this.body += chunk;
    return true;
  }

  end(chunk = ""): this {
    this.body += chunk;
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

const point = (sessionId: string, text: string) => ({
  id: sessionId,
  payload: {
    harness: "codex", session_id: sessionId, message_id: `message-${sessionId}`,
    role: "user", title: `TGC ${sessionId}`, directory: "/projects/TelegramAuto",
    project: "/projects/TelegramAuto", timestamp: "2026-10-19T00:00:00.000Z", text,
  },
});

describe("Agent Herder progressive search", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("streams exact TGC matches before waiting for Qdrant embeddings and then adds semantic results", async () => {
    let finishEmbedding!: (response: Response) => void;
    const embedding = new Promise<Response>((resolve) => { finishEmbedding = resolve; });
    const fetchMock = vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/points/scroll")) {
        return Response.json({ result: { points: [point("exact-1", "TGC TelegramAuto")], next_page_offset: null } });
      }
      if (url.includes("/v1/embeddings")) return embedding;
      if (url.endsWith("/points/search")) {
        return Response.json({ result: [
          { id: "exact-1", score: 0.8, payload: point("exact-1", "TGC TelegramAuto").payload },
          { id: "semantic-2", score: 0.7, payload: point("semantic-2", "Восстановление комментариев").payload },
        ] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const rag = new AgentHerderRag();
    (rag as unknown as { state: unknown }).state = {
      options: { enabled: true, harnesses: { codex: true, zcode: true, opencode: true } },
      checkpoints: {},
      run: { status: "running", startedAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:00:00.000Z", processed: 0, indexed: 0 },
    };
    const response = new CaptureResponse();
    const request = new PassThrough() as PassThrough & { method: string; url: string };
    request.method = "POST";
    request.url = "/api/rag/search/stream";

    const handled = rag.handleHttp(request as never, response as never);
    request.end(JSON.stringify({ query: "TGC", harnesses: ["codex"], limit: 20 }));

    await vi.waitFor(() => expect(response.body).toContain('"source":"exact"'));
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("TGC TelegramAuto");
    expect(response.body).not.toContain('"source":"semantic"');

    finishEmbedding(Response.json({ data: [{ embedding: Array(2048).fill(0.1) }] }));
    expect(await handled).toBe(true);
    expect(response.body).toContain('"source":"semantic"');
    expect(response.body).toContain("Восстановление комментариев");
    expect(response.body).toContain('"type":"complete"');
    expect(response.headers["x-accel-buffering"]).toBe("no");
  });

  it("runs the semantic search independently even when exact matches fill their own result limit", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/points/scroll")) {
        return Response.json({ result: { points: Array.from({ length: 20 }, (_, index) => point(`exact-${index}`, "TGC TelegramAuto")), next_page_offset: null } });
      }
      if (url.includes("/v1/embeddings")) return Response.json({ data: [{ embedding: Array(2048).fill(0.1) }] });
      if (url.endsWith("/points/search")) {
        return Response.json({ result: [{ id: "semantic-1", score: 0.7, payload: point("semantic-1", "Семантическое совпадение").payload }] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const rag = new AgentHerderRag();
    (rag as unknown as { state: unknown }).state = {
      options: { enabled: true, harnesses: { codex: true, zcode: true, opencode: true } }, checkpoints: {},
    };
    const response = new CaptureResponse();
    const request = new PassThrough() as PassThrough & { method: string; url: string };
    request.method = "POST";
    request.url = "/api/rag/search/stream";
    const handled = rag.handleHttp(request as never, response as never);
    request.end(JSON.stringify({ query: "TGC", limit: 20 }));

    expect(await handled).toBe(true);
    expect(response.body).toContain('"type":"complete"');
    expect(response.body).toContain('"stage":"semantic"');
    expect(response.body).toContain('"source":"semantic"');
    expect(response.body).toContain("Семантическое совпадение");
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/v1/embeddings"))).toBe(true);
  });

  it("returns exact candidates and a Codex session-list fallback when semantic Qdrant search fails", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/points/scroll")) {
        return Response.json({ result: { points: [point("exact-session", "owner recovery")], next_page_offset: null } });
      }
      if (url.includes("/v1/embeddings")) return Response.json({ data: [{ embedding: Array(2048).fill(0.1) }] });
      if (url.endsWith("/points/search")) return new Response(JSON.stringify({ status: { error: "bad filter" } }), { status: 400 });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const rag = new AgentHerderRag();
    (rag as unknown as { state: unknown }).state = {
      options: { enabled: true, harnesses: { codex: true, zcode: true, opencode: true } }, checkpoints: {},
    };
    const result = await rag.search("owner recovery", { harnesses: ["codex"] }, undefined, async () => [
      { id: "wanted-session", title: "Owner recovery investigation", cwd: "/projects/agent-herder", lastMessage: "Find owner session" },
      { id: "unrelated-session", title: "Other project", cwd: "/projects/other" },
    ]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ session_id: "exact-session", source: "exact" });
    expect(result.searchError).toContain("HTTP 400");
    expect(result.searchError).toContain("bad filter");
    expect(result.fallback).toMatchObject({ source: "codex-session-list" });
    expect(result.fallback.candidates).toEqual([expect.objectContaining({ id: "wanted-session" })]);
  });

  it("uses the Codex session list when the exact Qdrant request itself returns HTTP 400", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: { error: "invalid session_id filter" } }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const rag = new AgentHerderRag();
    (rag as unknown as { state: unknown }).state = {
      options: { enabled: true, harnesses: { codex: true, zcode: true, opencode: true } }, checkpoints: {},
    };

    const result = await rag.search("target rollout", { harnesses: ["codex"] }, undefined, async () => [
      { id: "target-rollout", title: "Target rollout", cwd: "/projects/agent-herder" },
    ]);
    expect(result.results).toEqual([]);
    expect(result.searchError).toContain("HTTP 400");
    expect(result.searchError).toContain("invalid session_id filter");
    expect(result.fallback.candidates).toEqual([expect.objectContaining({ id: "target-rollout" })]);
  });
});
