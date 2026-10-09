import { mkdtemp, mkdir, rm, writeFile, appendFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "../src/adapters/codex.js";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";

// Fast unit regressions: exact discovery/admission must not touch global lists
// or full metrics. Expected <1s; each case has the default 5s Vitest ceiling.
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "herder-exact-observation-"));
  roots.push(root);
  const rolloutPath = join(root, "sessions", "rollout-exact.jsonl");
  await mkdir(join(root, "sessions"));
  await writeFile(rolloutPath, [
    { type: "session_meta", payload: { id: "exact", cwd: root } },
    { type: "turn_context", payload: { model: "persisted-model" } },
    { type: "event_msg", payload: { type: "task_started" } },
  ].map(item => JSON.stringify(item) + "\n").join(""));
  const db = new DatabaseSync(join(root, "state_5.sqlite"));
  db.exec("create table threads (id text primary key, name text, cwd text, rollout_path text, model text, archived integer, updated_at_ms integer)");
  db.prepare("insert into threads values (?, ?, ?, ?, ?, ?, ?)").run("exact", "Exact target", root, rolloutPath, "persisted-model", 0, Date.now());
  db.close();
  return { root, rolloutPath };
}

function nativeAdapter(root: string, socket = true) {
  const adapter = new CodexAppServerAdapter({ codexDir: root, ...(socket ? { socketPath: join(root, "unused.sock") } : {}) });
  const internals = adapter as any;
  vi.spyOn(internals, "ensureReady").mockResolvedValue(undefined);
  vi.spyOn(adapter, "isReady").mockReturnValue(true);
  const request = vi.spyOn(internals, "request").mockImplementation(async (method: unknown) => {
    if (method === "thread/read") return { thread: { id: "exact", name: "Exact target", cwd: root, status: "active" } };
    if (method === "thread/turns/list") return { data: [{ id: "current-turn", status: "inProgress" }] };
    throw new Error(`Unexpected global or mutating RPC: ${method}`);
  });
  return { adapter, internals, request };
}

describe("Herder exact Codex discovery and delivery observation", () => {
  it("finds a native named target without paginated thread/list", async () => {
    const { root } = await fixture();
    const { adapter, request } = nativeAdapter(root);
    await expect(adapter.findNamedSessions("Exact target", root)).resolves.toMatchObject([{ id: "exact", cwd: root }]);
    expect(request.mock.calls.map(call => call[0])).toEqual(["thread/read"]);
  });

  it.each([true, false])("observes exact live turn without global rollouts or metrics (socket=%s)", async socket => {
    const { root } = await fixture();
    const { adapter, internals, request } = nativeAdapter(root, socket);
    const raw = internals.rawTranscriptAdapter;
    const list = vi.spyOn(raw, "listSessions").mockRejectedValue(new Error("Global list forbidden on admission"));
    const scan = vi.spyOn(raw, "getSessionStates").mockRejectedValue(new Error("Global rollout scan forbidden on admission"));
    const metrics = vi.spyOn(raw, "readSessionMetrics").mockRejectedValue(new Error("Full metrics forbidden on admission"));
    await expect(adapter.getSession("exact")).resolves.toMatchObject({ id: "exact", status: "running", meta: { activeTurnId: "current-turn" } });
    expect(list).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    expect(metrics).not.toHaveBeenCalled();
    expect(request.mock.calls.map(call => call[0])).toEqual(["thread/read", "thread/turns/list"]);
  });

  it("refreshes an exact manual stop without a cached global observation", async () => {
    const { root, rolloutPath } = await fixture();
    const { adapter, internals } = nativeAdapter(root);
    vi.spyOn(internals.rawTranscriptAdapter, "getSessionStates").mockRejectedValue(new Error("Global rollout scan forbidden"));
    expect((await adapter.getSession("exact"))?.meta).not.toHaveProperty("automationStop");
    const stop = { type: "event_msg", timestamp: new Date().toISOString(), payload: { type: "turn_aborted", reason: "interrupted", turn_id: "stopped-turn" } };
    await appendFile(rolloutPath, JSON.stringify(stop) + "\n");
    await expect(adapter.getSession("exact")).resolves.toMatchObject({ meta: { automationStop: { turnId: "stopped-turn", reason: "interrupted" } } });
  });

  it("keeps explicit raw statistics available", async () => {
    const { root, rolloutPath } = await fixture();
    await appendFile(rolloutPath, JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 42 } } } }) + "\n");
    const raw = new CodexAdapter({ codexDir: root });
    await writeFile(join(root, "session_index.jsonl"), JSON.stringify({ id: "exact", thread_name: "Exact target" }) + "\n");
    await expect(raw.getSession("exact")).resolves.toMatchObject({ messageCount: 0, meta: { total_tokens: 42 } });
  });

  it("treats a verified empty native name index as empty without thread/list", async () => {
    const { root } = await fixture();
    const { adapter, request } = nativeAdapter(root);
    await expect(adapter.findNamedSessions("Missing target", root)).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it("does not classify a persisted started marker as a live idle thread", async () => {
    const { root } = await fixture();
    const { adapter, request } = nativeAdapter(root);
    request.mockImplementation(async method => method === "thread/read"
      ? { thread: { id: "exact", cwd: root, status: "idle" } }
      : { data: [] });
    await expect(adapter.getSession("exact")).resolves.toMatchObject({ status: "idle", meta: { activeTurnId: undefined } });
  });

  it("refuses admission after live exact read failure instead of using persisted state", async () => {
    const { root } = await fixture();
    const { adapter, request } = nativeAdapter(root);
    request.mockRejectedValue(new Error("Native thread unavailable"));
    await expect(adapter.sendMessage("exact", { message: "do not replay", queue: true }))
      .resolves.toMatchObject({ ok: false, nonRetryable: true });
    expect(request.mock.calls.map(call => call[0])).toEqual(["thread/read"]);
  });

  it("does not convert unreadable indexed named matches into replacement creation", async () => {
    const { root } = await fixture();
    const { adapter, request } = nativeAdapter(root);
    request.mockRejectedValue(new Error("Native read timed out"));
    await expect(adapter.findNamedSessions("Exact target", root)).rejects.toThrow("Native read timed out");
    expect(request.mock.calls.map(call => call[0])).toEqual(["thread/read"]);
  });

  it("re-reads the exact native path once after an archive move and retains its manual stop", async () => {
    const { root, rolloutPath } = await fixture();
    const { adapter, internals } = nativeAdapter(root);
    const raw = internals.rawTranscriptAdapter;
    const readTail = raw.readSessionTail.bind(raw);
    const moved = join(root, "sessions", "archived-exact.jsonl");
    const reads = vi.spyOn(raw, "readSessionTail").mockImplementationOnce(async () => {
      await rename(rolloutPath, moved);
      const db = new DatabaseSync(join(root, "state_5.sqlite"));
      db.prepare("update threads set rollout_path = ? where id = ?").run(moved, "exact");
      db.close();
      await appendFile(moved, JSON.stringify({ type: "event_msg", timestamp: new Date().toISOString(), payload: { type: "turn_aborted", reason: "interrupted", turn_id: "moved-stop" } }) + "\n");
      return readTail(rolloutPath);
    });
    await expect(adapter.getSession("exact")).resolves.toMatchObject({ meta: { sessionFilePath: moved, automationStop: { turnId: "moved-stop" } } });
    expect(reads.mock.calls.map(call => call[0])).toEqual([rolloutPath, moved]);
  });

  it("blocks mutation when the exact rollout tail remains missing", async () => {
    const { root, rolloutPath } = await fixture();
    const { adapter, request } = nativeAdapter(root);
    await rm(rolloutPath);
    await expect(adapter.sendMessage("exact", { message: "must not start or steer", queue: true }))
      .resolves.toMatchObject({ ok: false, admitted: false });
    expect(request.mock.calls.map(call => call[0])).toEqual(["thread/read", "thread/turns/list"]);
  });

  it("matches native named CWD aliases without falling back to global lists", async () => {
    const { root } = await fixture();
    const db = new DatabaseSync(join(root, "state_5.sqlite"));
    db.prepare("update threads set cwd = ? where id = ?").run(root + "/.", "exact");
    db.close();
    const { adapter, request } = nativeAdapter(root);
    await expect(adapter.findNamedSessions("Exact target", root)).resolves.toMatchObject([{ id: "exact" }]);
    expect(request.mock.calls.map(call => call[0])).toEqual(["thread/read"]);
  });

  it("keeps fresh stop evidence when explicit metrics still have cached metadata", async () => {
    const { root, rolloutPath } = await fixture();
    const { adapter, internals } = nativeAdapter(root);
    const raw = internals.rawTranscriptAdapter;
    // Metrics may use the global statistics cache; it is never stop authority.
    vi.spyOn(raw, "getSession").mockResolvedValue({ id: "exact", harness: "codex", cwd: root, title: "Exact target", status: "idle", needsPermission: false, lastActivity: new Date().toISOString(), messageCount: 1, meta: { total_tokens: 42 } });
    await appendFile(rolloutPath, JSON.stringify({ type: "event_msg", timestamp: new Date().toISOString(), payload: { type: "turn_aborted", reason: "interrupted", turn_id: "fresh-stop-during-statistics" } }) + "\n");
    await expect(adapter.getSession("exact", { includeMetrics: true })).resolves.toMatchObject({ messageCount: 1, meta: { total_tokens: 42, automationStop: { turnId: "fresh-stop-during-statistics" } } });
  });
});
