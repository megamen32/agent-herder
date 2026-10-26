import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHerderRag } from "../src/rag-search.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function fixture() {
  const rag = new AgentHerderRag();
  (rag as any).state = { options: { enabled: true, harnesses: { codex: true, zcode: true, opencode: true } }, checkpoints: {} };
  vi.spyOn(rag as any, "save").mockResolvedValue(undefined);
  return rag;
}

it("exact mode returns local coverage without any embedding or semantic request", async () => {
  const fetchMock = vi.fn(async (url: unknown) => {
    expect(String(url)).toContain("/points/scroll");
    return Response.json({ result: { points: [] } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const result = await fixture().search("149 158", { mode: "exact" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(result.mode).toBe("exact");
  expect(result.timings).not.toHaveProperty("semanticMs");
  expect(result.coverage).toMatchObject({ scope: "local-index", fleetComplete: false });
});

it("indexes the native Codex metadata id rather than the rollout filename", async () => {
  const home = await mkdtemp(join(tmpdir(), "rag-native-id-"));
  try {
    vi.stubEnv("CODEX_HOME", home);
    await mkdir(join(home, "sessions"));
    const id = "01a134e4-c26e-7ae0-900c-f9be106dbc98";
    const legacyId = "old-native-session-alias";
    await writeFile(join(home, "sessions", `rollout-2026-10-13T10-00-00-${id}.jsonl`), [
      JSON.stringify({ type: "session_meta", payload: { id, session_id: legacyId, cwd: "/test" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ text: "A sufficiently long historical reply for indexing." }] } }),
    ].join("\n"));
    const deletes: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => { deletes.push(JSON.parse(String(init.body))); return Response.json({ result: {} }); }));
    const rag = fixture();
    (rag as any).state.checkpoints[`codex:${id}`] = Date.now() + 100_000;
    const index = vi.spyOn(rag as any, "indexMessages").mockResolvedValue(1);
    await (rag as any).indexCodex((rag as any).state);
    expect(index.mock.calls[0][1]).toMatchObject({ id, directory: "/test", project: "/test" });
    expect(deletes[0].filter.must[1].match.any).toContain(legacyId);
    expect((rag as any).state.checkpoints[`codex-native-v2:${id}`]).toBeGreaterThan(0);
    await (rag as any).indexCodex((rag as any).state);
    expect(index).toHaveBeenCalledTimes(1);
  } finally { await rm(home, { recursive: true, force: true }); }
});

it("semantic mode skips the exact request and its timing", async () => {
  vi.stubEnv("AGENT_HERDER_EMBEDDING_TOKEN", "test-token");
  const fetchMock = vi.fn(async (url: unknown) => {
    expect(String(url)).not.toContain("/points/scroll");
    return String(url).includes("/embeddings")
      ? Response.json({ data: [{ embedding: Array(2048).fill(0) }] })
      : Response.json({ result: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const result = await fixture().search("views", { mode: "semantic" });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(result.timings).not.toHaveProperty("exactMs");
  expect(result.timings).toHaveProperty("semanticMs");
});
