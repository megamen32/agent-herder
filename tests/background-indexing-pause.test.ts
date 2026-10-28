import { afterEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { BackgroundIndexingSettings } from "../src/indexing-settings.js";
import { startSessionSearchIndexer } from "../src/session-search-indexer.js";
import { SessionSearchIndex } from "../src/session-search.js";
import { AgentHerderRag } from "../src/rag-search.js";
import { createSettingsApi } from "../src/web/settings-api.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "indexing-pause-")); roots.push(root); return { root, settings: new BackgroundIndexingSettings(join(root, "settings.json")) }; }
it("defaults on, persists pause across restart and resumes through one common setting", async () => {
  const { settings } = await fixture();
  expect(settings.get().enabled).toBe(true);
  const listener = vi.fn(); settings.subscribe(listener);
  await settings.set(false);
  expect(new BackgroundIndexingSettings(settings.path).get().enabled).toBe(false);
  expect(listener).toHaveBeenCalledWith(false);
  await settings.set(true); expect(settings.get().enabled).toBe(true);
});
it("paused startup and close do not open a SQLite writer or invoke the scanner", async () => {
  const { root } = await fixture(); const path = join(root, "not-created.sqlite");
  const scanner = vi.fn(async function* () { throw new Error("must_not_scan"); });
  const owner = await startSessionSearchIndexer(scanner, { path, enabled: false });
  expect(owner).toBeDefined(); expect(owner?.index).toBeUndefined();
  await owner!.close(); expect(scanner).not.toHaveBeenCalled(); expect(existsSync(path)).toBe(false);
});
it("aborts partial scanning without pruning or overwriting existing searchable rows", async () => {
  const { root } = await fixture(); const path = join(root, "index.sqlite");
  const index = new SessionSearchIndex(path);
  await index.ingest({ harness: "codex", nativeSessionId: "old", title: "old", cwd: root, revision: "1", chunks: (async function* () { yield { id: "old", text: "preservedword" }; })() }, "seed");
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const owner = await startSessionSearchIndexer(async function* ({ signal, onStatus }) {
    onStatus?.({ harness: "codex", source: "fixture", state: "complete", sessions: 0 });
    started(); await new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), { once: true }));
    // Even a scanner that returns normally on abort must not prove completeness.
  }, { path });
  try { await ready; await owner!.setEnabled(false); expect(index.search({ query: "preservedword" }).results).toHaveLength(1); }
  finally { await owner!.close(); index.close(); }
});
it("keeps saved semantic search available and blocks forced reindex while paused", async () => {
  const { settings } = await fixture(); await settings.set(false);
  const rag = new AgentHerderRag(settings);
  (rag as any).state = { options: { enabled: true, harnesses: { codex: true, zcode: false, opencode: false } }, checkpoints: { old: 42 }, run: { status: "running", processed: 4, indexed: 5 } };
  const fetcher = vi.fn(async () => Response.json({ result: { points: [] } })); vi.stubGlobal("fetch", fetcher);
  await expect(rag.reindex()).rejects.toThrow("paused");
  expect((await rag.getSettings()).run).toMatchObject({ status: "paused" });
  await rag.search("saved text", { mode: "exact" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((rag as any).state.options.enabled).toBe(true); expect((rag as any).state.checkpoints.old).toBe(42);
});
it("does not write vectors after pause arrives during an embedding request", async () => {
  const { settings } = await fixture(); const rag = new AgentHerderRag(settings);
  (rag as any).state = { options: { enabled: true, harnesses: {} }, checkpoints: { old: 42 } };
  vi.stubEnv("AGENT_HERDER_EMBEDDING_TOKEN", "isolated-fixture");
  const fetcher = vi.fn(async () => { await settings.set(false); return Response.json({ data: [{ embedding: Array(2048).fill(0.1) }] }); });
  vi.stubGlobal("fetch", fetcher);
  await expect((rag as any).indexMessages("codex", { id: "fixture" }, [{ id: "message", role: "assistant", text: "Sufficiently long existing reply for indexing." }])).rejects.toThrow("paused");
  expect(fetcher).toHaveBeenCalledTimes(1); expect((rag as any).state.checkpoints.old).toBe(42);
});
it("uses existing owner and same-origin guards for the pause API", async () => {
  const { settings } = await fixture(); const api = createSettingsApi({ store: {} as any, indexing: settings, verifyOwnerCookie: async () => false });
  const server = createServer(async (request, response) => { await api(request, response); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    expect((await fetch(`${origin}/api/settings/background-indexing`, { headers: { cookie: "not-owner" } })).status).toBe(401);
    expect((await fetch(`${origin}/api/settings/background-indexing`, { method: "PUT", headers: { "content-type": "application/json", origin: "https://other.test" }, body: '{"enabled":false}' })).status).toBe(403);
    const paused = await fetch(`${origin}/api/settings/background-indexing`, { method: "PUT", headers: { "content-type": "application/json", origin }, body: '{"enabled":false}' });
    expect(paused.status).toBe(200); expect(await paused.json()).toMatchObject({ enabled: false });
    expect(await (await fetch(`${origin}/api/settings/background-indexing`)).json()).toMatchObject({ enabled: false });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
