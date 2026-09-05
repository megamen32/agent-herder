import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinationNoteStore, autoTtlSeconds } from "../src/coordination-notes.js";

describe("coordination notes", () => {
  it("creates, injects, updates, and deletes owned TTL notes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-herder-notes-"));
    const store = new CoordinationNoteStore(join(dir, "notes.json"));
    const note = await store.create({ kind: "avoid", message: "editing parser", cwd: "/repo", paths: ["src/parser.ts"], authorHarness: "codex", authorSessionId: "a", ttlSeconds: 600 });
    const injected = await store.inject({ id: "b", harness: "zcode", cwd: "/repo" }, "do task");
    expect(injected).toContain("editing parser");
    expect(injected).toContain("src/parser.ts");
    expect(await store.inject({ id: "a", harness: "codex", cwd: "/repo" }, "my task")).toBe("my task");
    const changed = await store.update(note.id, "a", { message: "parser done soon", ttlSeconds: 900 });
    expect(changed.message).toBe("parser done soon");
    await expect(store.update(note.id, "other", { message: "steal" })).rejects.toThrow(/another session/);
    expect(await store.delete(note.id, "a")).toBe(true);
    expect(await store.get(note.id)).toBeNull();
  });

  it("auto-reserves paths, refreshes TTL, normalizes paths, and detects overlaps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-herder-reserve-"));
    const store = new CoordinationNoteStore(join(dir, "notes.json"));
    const first = await store.reservePaths({ harness: "codex", sessionId: "a", cwd: "/repo", paths: ["/repo/src/parser.ts"], ttlSeconds: 300 });
    expect(first.reservations).toHaveLength(1);
    expect(first.reservations[0].paths).toEqual(["src/parser.ts"]);
    expect(first.conflicts).toHaveLength(0);
    const conflict = await store.reservePaths({ harness: "zcode", sessionId: "b", cwd: "/repo", paths: ["src"], ttlSeconds: 300 });
    expect(conflict.conflicts).toHaveLength(1);
    expect(conflict.conflicts[0].note.authorSessionId).toBe("a");
    const refreshed = await store.reservePaths({ harness: "codex", sessionId: "a", cwd: "/repo", paths: ["src/parser.ts"], ttlSeconds: 300 });
    expect(refreshed.reservations[0].id).toBe(first.reservations[0].id);
    expect(refreshed.reservations[0].source).toBe("hook");
  });

  it("heartbeats all hook reservations owned by an active session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-herder-heartbeat-"));
    const store = new CoordinationNoteStore(join(dir, "notes.json"));
    const first = await store.reservePaths({ harness: "codex", sessionId: "a", cwd: "/repo", paths: ["src/a.ts", "src/b.ts"], ttlSeconds: 60 });
    const before = first.reservations.map((note) => Date.parse(note.expiresAt));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const touched = await store.heartbeatSession({ sessionId: "a", cwd: "/repo", ttlSeconds: 120 });
    expect(touched).toHaveLength(2);
    expect(touched.every((note, index) => Date.parse(note.expiresAt) > before[index])).toBe(true);
    expect(await store.heartbeatSession({ sessionId: "other", cwd: "/repo" })).toHaveLength(0);
  });

  it("defaults automatic inactivity leases to one minute", () => {
    const old = process.env.AGENT_HERDER_AUTO_TTL_SECONDS;
    delete process.env.AGENT_HERDER_AUTO_TTL_SECONDS;
    expect(autoTtlSeconds()).toBe(60);
    if (old === undefined) delete process.env.AGENT_HERDER_AUTO_TTL_SECONDS;
    else process.env.AGENT_HERDER_AUTO_TTL_SECONDS = old;
  });
});

describe("coordination note injection dedup", () => {
  async function freshStore(): Promise<CoordinationNoteStore> {
    const dir = await mkdtemp(join(tmpdir(), "agent-herder-dedup-"));
    return new CoordinationNoteStore(join(dir, "notes.json"));
  }

  it("injects the notes block once and re-injects only on material change", async () => {
    const store = await freshStore();
    await store.create({ kind: "working", message: "refactoring parser", cwd: "/repo", paths: ["src/parser.ts"], authorHarness: "zcode", authorSessionId: "sess-b", source: "hook" });

    const first = await store.renderForSession({ id: "sess-a", harness: "zcode", cwd: "/repo" });
    expect(first).toContain("agent-herder-coordination");
    expect(first).toContain("src/parser.ts");

    // Same roster again — nothing new, no injection.
    expect(await store.renderForSession({ id: "sess-a", harness: "zcode", cwd: "/repo" })).toBeNull();

    // TTL refresh of the same note carries no new information either.
    await store.heartbeatSession({ sessionId: "sess-b", cwd: "/repo" });
    expect(await store.renderForSession({ id: "sess-a", harness: "zcode", cwd: "/repo" })).toBeNull();

    // Material change: a second author appears — inject.
    await store.create({ kind: "working", message: "migrating schema", cwd: "/repo", paths: ["db/migration.sql"], authorHarness: "codex", authorSessionId: "sess-c", source: "manual" });
    const second = await store.renderForSession({ id: "sess-a", harness: "zcode", cwd: "/repo" });
    expect(second).toContain("db/migration.sql");
    expect(second).toContain("sess-c");
  });

  it("shares the dedup slot across channels: the peers roster does not repeat the notes block", async () => {
    const store = await freshStore();
    await store.create({ kind: "working", message: "touching api", cwd: "/repo", paths: ["api.ts"], authorHarness: "zcode", authorSessionId: "sess-b", source: "hook" });

    expect(await store.renderForSession({ id: "sess-a", harness: "zcode", cwd: "/repo" })).toContain("agent-herder-coordination");
    // Same information through the file-activity channel — deduped.
    expect(await store.renderWorkspacePeers({ id: "sess-a", harness: "zcode", cwd: "/repo" })).toBeNull();
  });

  it("renders a peers roster grouped by author on first sight", async () => {
    const store = await freshStore();
    await store.create({ kind: "working", message: "touching api", cwd: "/repo", paths: ["api.ts"], authorHarness: "zcode", authorSessionId: "sess-b", source: "hook" });
    const peers = await store.renderWorkspacePeers({ id: "sess-a", harness: "zcode", cwd: "/repo" });
    expect(peers).toContain("agent-herder-repo-peers");
    expect(peers).toContain("[zcode] sess-b");
    expect(peers).toContain("api.ts");
    expect(peers).toContain("send_message");
  });

  it("never shows a session its own notes", async () => {
    const store = await freshStore();
    await store.create({ kind: "working", message: "my own work", cwd: "/repo", paths: ["mine.ts"], authorHarness: "zcode", authorSessionId: "sess-a", source: "hook" });
    expect(await store.renderForSession({ id: "sess-a", harness: "zcode", cwd: "/repo" })).toBeNull();
    expect(await store.renderWorkspacePeers({ id: "sess-a", harness: "zcode", cwd: "/repo" })).toBeNull();
  });

  it("re-injects after the staleness window (context compaction safety)", async () => {
    const store = await freshStore();
    await store.create({ kind: "working", message: "long task", cwd: "/repo", paths: ["x.ts"], authorHarness: "zcode", authorSessionId: "sess-b", source: "hook" });
    expect(await store.renderForSession({ id: "sess-a", harness: "zcode", cwd: "/repo" })).not.toBeNull();
    // Age out the injection record past the reshow window.
    const state = (store as unknown as { injectionState: Map<string, { signature: string; at: number }> }).injectionState;
    const key = [...state.keys()].find((candidate) => candidate.startsWith("sess-a#"))!;
    const entry = state.get(key)!;
    state.set(key, { ...entry, at: entry.at - 46 * 60 * 1000 });
    expect(await store.renderForSession({ id: "sess-a", harness: "zcode", cwd: "/repo" })).not.toBeNull();
  });

  it("keeps per-board dedup slots: two boards inject independently", async () => {
    const store = await freshStore();
    await store.create({ kind: "working", message: "repoA work", cwd: "/repoA", paths: ["a.ts"], authorHarness: "zcode", authorSessionId: "sess-c", source: "hook" });
    await store.create({ kind: "working", message: "repoB work", cwd: "/repoB", paths: ["b.ts"], authorHarness: "zcode", authorSessionId: "sess-d", source: "hook" });
    const session = { id: "sess-a", harness: "zcode" };

    const rosterA = await store.renderWorkspacePeers({ ...session, cwd: "/repoA" });
    const rosterB = await store.renderWorkspacePeers({ ...session, cwd: "/repoB" });
    expect(rosterA).toContain("a.ts");
    expect(rosterB).toContain("b.ts");
    // Repeats per board are deduped independently — board B's roster was not
    // suppressed by board A's signature.
    expect(await store.renderWorkspacePeers({ ...session, cwd: "/repoA" })).toBeNull();
    expect(await store.renderWorkspacePeers({ ...session, cwd: "/repoB" })).toBeNull();
  });

  it("renders turn-start awareness across every board the session touched", async () => {
    const store = await freshStore();
    await store.create({ kind: "working", message: "repoA work", cwd: "/repoA", paths: ["a.ts"], authorHarness: "zcode", authorSessionId: "sess-c", source: "hook" });
    await store.create({ kind: "working", message: "repoB work", cwd: "/repoB", paths: ["b.ts"], authorHarness: "zcode", authorSessionId: "sess-d", source: "hook" });
    // sess-a touches both boards (as when editing files across repos).
    await store.reservePaths({ harness: "zcode", sessionId: "sess-a", cwd: "/repoA", paths: ["a2.ts"] });
    await store.reservePaths({ harness: "zcode", sessionId: "sess-a", cwd: "/repoB", paths: ["b2.ts"] });

    const turn = await store.renderForSession({ id: "sess-a", harness: "zcode", cwd: "/repoA" });
    expect(turn).toContain("repoA work");
    expect(turn).toContain("repoB work");
    expect(turn).toContain('board="repoB"');
  });
});
