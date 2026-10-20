import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinationNoteStore, autoTtlSeconds } from "../src/coordination-notes.js";
import { HerderEventBus } from "../src/herder-events.js";

describe("coordination notes", () => {
  it("reads remote-host notes by their globally unique note ID", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herder-remote-note-"));
    const store = new CoordinationNoteStore(join(dir, "notes.json"));
    const note = await store.create({kind:"avoid",authorSessionId:"remote",cwd:"/project",hostId:"host88",paths:["x.ts"],message:"remote hazard"});
    expect(await store.get(note.id)).toMatchObject({hostId:"host88",message:"remote hazard"});
    expect(await store.list({cwd:"/project"})).toEqual([]);
  });
  it("refuses device sinks even from stale hook clients", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herder-device-sinks-"));
    const store = new CoordinationNoteStore(join(dir, "notes.json"));
    const result = await store.reservePaths({harness:"codex",sessionId:"old-hook",cwd:"/repo",paths:["/dev/null","/dev/stderr"]});
    expect(result.reservations).toEqual([]);
    expect(await store.list({cwd:"/repo"})).toEqual([]);
  });
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

  it("isolates identical paths by host while detecting same-host conflicts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-herder-host-notes-"));
    const store = new CoordinationNoteStore(join(dir, "notes.json"));
    await store.create({ hostId: "host-88", kind: "working", message: "remote owner", cwd: "/srv/project", paths: ["src/a.ts"], authorSessionId: "remote" });

    expect(await store.list({ hostId: "host-100", cwd: "/srv/project" })).toHaveLength(0);
    expect(await store.list({ hostId: "host-88", cwd: "/srv/project" })).toHaveLength(1);
    expect((await store.reservePaths({ hostId: "host-100", harness: "codex", sessionId: "local", cwd: "/srv/project", paths: ["src/a.ts"] })).conflicts).toHaveLength(0);
    expect((await store.reservePaths({ hostId: "host-88", harness: "codex", sessionId: "same-host", cwd: "/srv/project", paths: ["src/a.ts"] })).conflicts).toHaveLength(1);
  });

  it("persists a bounded explicit workspace and keeps it above local hook activity until clear or expiry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-herder-workspace-declaration-"));
    const path = join(dir, "notes.json");
    const first = new CoordinationNoteStore(path);
    const declared = await first.declareWorkspace({ sessionId: "session", harness: "codex", hostId: "host-88", cwd: "/srv/a/../project", ttlSeconds: 60 });
    expect(declared.cwd).toBe("/srv/project");
    expect(first.cachedWorkspaceObservation("session")).toMatchObject({ hostId: "host-88", cwd: "/srv/project", source: "declared" });
    await first.reservePaths({ harness: "codex", sessionId: "session", cwd: "/launch", paths: ["local.ts"] });
    expect(await first.activeWorkspaceObservation("session")).toMatchObject({ hostId: "host-88", cwd: "/srv/project", source: "declared" });
    expect(first.activeWorkspaceForSession("session")).toBe("/launch");

    const restarted = new CoordinationNoteStore(path);
    expect(await restarted.activeWorkspaceObservation("session")).toMatchObject({ hostId: "host-88", cwd: "/srv/project", source: "declared", expiresAt: declared.expiresAt });
    expect(restarted.activeWorkspaceForSession("session")).toBeUndefined();
    expect(restarted.cachedWorkspaceObservation("session")).toMatchObject({ hostId: "host-88", cwd: "/srv/project", source: "declared" });

    expect(await restarted.clearWorkspace("session")).toBe(true);
    expect(await restarted.activeWorkspaceObservation("session")).toBeUndefined();
    expect(await first.activeWorkspaceObservation("session")).toMatchObject({ hostId: first.localHostId, cwd: "/launch", source: "coordination_activity" });
    await restarted.declareWorkspace({ sessionId: "expiring", harness: "codex", hostId: "host-88", cwd: "/srv/expiring", ttlSeconds: 60 });
    const file = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));
    file.workspaceDeclarations.find((row: { sessionId: string }) => row.sessionId === "expiring").expiresAt = new Date(Date.now() - 1).toISOString();
    await (await import("node:fs/promises")).writeFile(path, JSON.stringify(file));
    expect(await restarted.activeWorkspaceObservation("expiring")).toBeUndefined();
  });

  it("defaults legacy notes and workspace operations to the local host and rejects invalid remote identities", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-herder-host-default-"));
    const store = new CoordinationNoteStore(join(dir, "notes.json"));
    await store.create({ kind: "working", message: "legacy local", cwd: "/repo", paths: ["a.ts"], authorSessionId: "local" });
    expect((await store.list({ cwd: "/repo" }))[0]?.hostId).toBe((await import("node:os")).hostname());
    await expect(store.declareWorkspace({ sessionId: "bad", harness: "codex", hostId: "bad\nhost", cwd: "/repo" })).rejects.toThrow(/hostId/);
    await expect(store.declareWorkspace({ sessionId: "bad-path", harness: "codex", hostId: "host-88", cwd: "~other/project" })).rejects.toThrow(/absolute/);
  });

  it("renders declared remote workspace ownership without mixing a same-path local board", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-herder-remote-render-"));
    const store = new CoordinationNoteStore(join(dir, "notes.json"));
    await store.create({ hostId: "host-88", kind: "avoid", message: "remote migration", cwd: "/srv/project", paths: ["src/db.ts"], authorSessionId: "remote-owner" });
    await store.create({ hostId: store.localHostId, kind: "avoid", message: "local migration", cwd: "/srv/project", paths: ["src/db.ts"], authorSessionId: "local-owner" });
    await store.declareWorkspace({ sessionId: "launched-on-100", harness: "codex", hostId: "host-88", cwd: "/srv/project" });

    const rendered = await store.renderForSession({ id: "launched-on-100", harness: "codex", cwd: "/launch/path" });
    expect(rendered).toContain("remote migration");
    expect(rendered).not.toContain("local migration");
    expect(rendered).toContain('board="host-88:/srv/project"');
    expect(rendered).toContain("herder://coordination/workspaces/%5B%22host-88%22%2C%22%2Fsrv%2Fproject%22%5D");
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
    expect(first).toContain("Ownership changes: 1 active, 0 released");
    expect(first).toContain('coordination_note_list({cwd: "/repo"})');
    expect(first).not.toContain("src/parser.ts");
    expect(first).not.toContain("refactoring parser");
    expect(first).not.toContain("sess-b");

    // Same roster again — nothing new, no injection.
    expect(await store.renderForSession({ id: "sess-a", harness: "zcode", cwd: "/repo" })).toBeNull();

    // TTL refresh of the same note carries no new information either.
    await store.heartbeatSession({ sessionId: "sess-b", cwd: "/repo" });
    expect(await store.renderForSession({ id: "sess-a", harness: "zcode", cwd: "/repo" })).toBeNull();

    // Material change: a second author appears — inject.
    await store.create({ kind: "working", message: "migrating schema", cwd: "/repo", paths: ["db/migration.sql"], authorHarness: "codex", authorSessionId: "sess-c", source: "manual" });
    const second = await store.renderForSession({ id: "sess-a", harness: "zcode", cwd: "/repo" });
    expect(second).toContain("Ownership changes: 1 active, 0 released");
    expect(second).not.toContain("db/migration.sql");
    expect(second).not.toContain("sess-c");
    expect(second).not.toContain("migrating schema");
  });

  it("shares the dedup slot across channels: the peers roster does not repeat the notes block", async () => {
    const store = await freshStore();
    await store.create({ kind: "working", message: "touching api", cwd: "/repo", paths: ["api.ts"], authorHarness: "zcode", authorSessionId: "sess-b", source: "hook" });

    expect(await store.renderForSession({ id: "sess-a", harness: "zcode", cwd: "/repo" })).toContain("agent-herder-coordination");
    // Same information through the file-activity channel — deduped.
    expect(await store.renderWorkspacePeers({ id: "sess-a", harness: "zcode", cwd: "/repo" })).toBeNull();
  });

  it("summarizes passive ownership changes and leaves the exact snapshot in note_list", async () => {
    const store = await freshStore();
    await store.create({ kind: "working", message: "touching api with private detail", cwd: "/repo", paths: ["api.ts"], authorHarness: "zcode", authorSessionId: "sess-b", source: "hook" });
    const peers = await store.renderWorkspacePeers({ id: "sess-a", harness: "zcode", cwd: "/repo" });
    expect(peers).toContain("agent-herder-repo-peers");
    expect(peers).toContain('coordination_note_list({cwd: "/repo"})');
    expect(peers!.length).toBeLessThan(240);
    expect(peers).not.toContain("sess-b");
    expect(peers).not.toContain("api.ts");
    expect(peers).not.toContain("private detail");
    expect(peers).not.toContain("noteId=");
    expect(await store.list({ cwd: "/repo" })).toMatchObject([{ authorSessionId: "sess-b", paths: ["api.ts"], message: "touching api with private detail" }]);
    expect(await store.renderForSession({ id: "sess-a", harness: "zcode", cwd: "/repo" })).toBeNull();
    const state = (store as unknown as { injectionState: Map<string, { signature: string; at: number; notes: Map<string, string> }> }).injectionState;
    const key = [...state.keys()].find(candidate => candidate.startsWith("sess-a#"))!;
    const entry = state.get(key)!;
    state.set(key, { ...entry, at: entry.at - 46 * 60 * 1000 });
    expect(await store.renderWorkspacePeers({ id: "sess-a", harness: "zcode", cwd: "/repo" })).toBeNull();
    expect(await store.renderForSession({ id: "sess-a", harness: "zcode", cwd: "/repo" })).toBeNull();
    await store.create({ kind: "working", message: "second owner's detailed task", cwd: "/repo", paths: ["src/second.ts"], authorHarness: "codex", authorSessionId: "sess-c", source: "hook" });
    const delta = await store.renderWorkspacePeers({ id: "sess-a", harness: "zcode", cwd: "/repo" });
    expect(delta).toContain('coordination_note_list({cwd: "/repo"})');
    expect(delta).not.toContain("sess-c");
    expect(await store.list({ cwd: "/repo" })).toHaveLength(2);
    expect(await store.renderWorkspacePeers({ id: "sess-a", harness: "zcode", cwd: "/repo" })).toBeNull();
    expect(await store.renderForSession({ id: "sess-a", harness: "zcode", cwd: "/repo" })).toBeNull();
  });

  it("does not swallow active manual decisions or avoid notes in the passive summary", async () => {
    const store = await freshStore();
    await store.create({ kind: "working", message: "automatic file activity", cwd: "/repo", paths: ["auto.ts"], authorSessionId: "hook-owner", source: "hook" });
    expect(await store.renderWorkspacePeers({ id: "reader", harness: "zcode", cwd: "/repo" })).toContain("coordination_note_list");
    await store.create({ kind: "avoid", message: "Do not edit the migration until the review completes", cwd: "/repo", paths: ["db/migration.sql"], authorSessionId: "manual-owner" });
    expect(await store.renderWorkspacePeers({ id: "reader", harness: "zcode", cwd: "/repo" })).toBeNull();
    const active = await store.renderForSession({ id: "reader", harness: "zcode", cwd: "/repo" });
    expect(active).toContain("Do not edit the migration until the review completes");
    expect(active).toContain("db/migration.sql");
    expect(active).not.toContain("automatic file activity");
  });

  it("summarizes mixed hook and manual working notes but keeps avoid decisions actionable", async () => {
    const store = await freshStore();
    await store.create({ kind: "working", message: "shell wrote /dev/null details", cwd: "/repo", paths: ["src/auto.ts"], authorHarness: "codex", authorSessionId: "hook-uuid", source: "hook" });
    await store.create({ kind: "working", message: "long manual task prose", cwd: "/repo", paths: ["private/path.ts"], authorHarness: "zcode", authorSessionId: "manual-uuid", source: "manual" });

    const working = await store.renderForSession({ id: "reader", harness: "codex", cwd: "/repo" });
    expect(working).toContain("Ownership changes: 2 active, 0 released");
    expect(working).toContain('coordination_note_list({cwd: "/repo"})');
    expect(working).not.toContain("/dev/null");
    expect(working).not.toContain("private/path.ts");
    expect(working).not.toContain("hook-uuid");
    expect(working).not.toContain("manual-uuid");
    expect(working).not.toContain("long manual task prose");
    expect(working).not.toContain("Details: coordination_note_get");

    const avoid = await store.create({ kind: "avoid", message: "Do not change the migration yet", cwd: "/repo", paths: ["db/migration.sql"], authorHarness: "codex", authorSessionId: "owner", source: "manual" });
    const actionable = await store.renderForSession({ id: "reader", harness: "codex", cwd: "/repo" });
    expect(actionable).toContain("Do not change the migration yet");
    expect(actionable).toContain("db/migration.sql");
    expect(actionable).toContain(avoid.id);
  });

  it("reports released working ownership by count without exposing previous roster details", async () => {
    const store = await freshStore();
    const note = await store.create({ kind: "working", message: "private task text", cwd: "/repo", paths: ["secret/path.ts"], authorSessionId: "owner-uuid", source: "manual" });
    expect(await store.renderForSession({ id: "reader", harness: "codex", cwd: "/repo" })).toContain("Ownership changes: 1 active, 0 released");
    await store.delete(note.id, "owner-uuid");
    const released = await store.renderForSession({ id: "reader", harness: "codex", cwd: "/repo" });
    expect(released).toContain("Ownership changes: 0 active, 1 released");
    expect(released).toContain('coordination_note_list({cwd: "/repo"})');
    expect(released).not.toContain("secret/path.ts");
    expect(released).not.toContain("private task text");
    expect(released).not.toContain("owner-uuid");
    expect(released).not.toContain("Details: coordination_note_get");
  });

  it("shows a hook reservation promoted to avoid immediately in active context", async () => {
    const store = await freshStore();
    const [note] = (await store.reservePaths({ harness: "codex", sessionId: "owner", cwd: "/repo", paths: ["db/migration.sql"] })).reservations;
    expect(await store.renderWorkspacePeers({ id: "reader", harness: "zcode", cwd: "/repo" })).toContain("coordination_note_list");
    await store.update(note!.id, "owner", { kind: "avoid", message: "Migration is blocked pending review" });
    const active = await store.renderForSession({ id: "reader", harness: "zcode", cwd: "/repo" });
    expect(active).toContain("[avoid]");
    expect(active).toContain("Migration is blocked pending review");
    expect(active).toContain("db/migration.sql");
  });

  it("never shows a session its own notes", async () => {
    const store = await freshStore();
    await store.create({ kind: "working", message: "my own work", cwd: "/repo", paths: ["mine.ts"], authorHarness: "zcode", authorSessionId: "sess-a", source: "hook" });
    expect(await store.renderForSession({ id: "sess-a", harness: "zcode", cwd: "/repo" })).toBeNull();
    expect(await store.renderWorkspacePeers({ id: "sess-a", harness: "zcode", cwd: "/repo" })).toBeNull();
  });

  it("does not periodically re-inject unchanged notes after the staleness window", async () => {
    const store = await freshStore();
    await store.create({ kind: "working", message: "long task", cwd: "/repo", paths: ["x.ts"], authorHarness: "zcode", authorSessionId: "sess-b", source: "hook" });
    expect(await store.renderForSession({ id: "sess-a", harness: "zcode", cwd: "/repo" })).not.toBeNull();
    // Age out the injection record past the reshow window.
    const state = (store as unknown as { injectionState: Map<string, { signature: string; at: number }> }).injectionState;
    const key = [...state.keys()].find((candidate) => candidate.startsWith("sess-a#"))!;
    const entry = state.get(key)!;
    state.set(key, { ...entry, at: entry.at - 46 * 60 * 1000 });
    expect(await store.renderForSession({ id: "sess-a", harness: "zcode", cwd: "/repo" })).toBeNull();
  });

  it("keeps per-board dedup slots: two boards inject independently", async () => {
    const store = await freshStore();
    await store.create({ kind: "working", message: "repoA work", cwd: "/repoA", paths: ["a.ts"], authorHarness: "zcode", authorSessionId: "sess-c", source: "hook" });
    await store.create({ kind: "working", message: "repoB work", cwd: "/repoB", paths: ["b.ts"], authorHarness: "zcode", authorSessionId: "sess-d", source: "hook" });
    const session = { id: "sess-a", harness: "zcode" };

    const rosterA = await store.renderWorkspacePeers({ ...session, cwd: "/repoA" });
    const rosterB = await store.renderWorkspacePeers({ ...session, cwd: "/repoB" });
    expect(rosterA).toContain('coordination_note_list({cwd: "/repoA"})');
    expect(rosterB).toContain('coordination_note_list({cwd: "/repoB"})');
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
    expect(turn).toContain("Ownership changes: 1 active, 0 released");
    expect(turn).toContain('coordination_note_list({cwd: "/repoA"})');
    expect(turn).toContain('coordination_note_list({cwd: "/repoB"})');
    expect(turn).not.toContain("repoA work");
    expect(turn).not.toContain("repoB work");
    expect(turn).toContain('board="repoB"');
  });

  it("keeps passive notices limited to a scoped ownership read", async () => {
    const store = await freshStore();
    await store.create({ kind: "working", message: "peer work", cwd: "/repo", paths: ["p.ts"], authorHarness: "zcode", authorSessionId: "sess-b", source: "hook" });

    const first = await store.renderWorkspacePeers({ id: "sess-a", harness: "zcode", cwd: "/repo" });
    expect(first).toContain('coordination_note_list({cwd: "/repo"})');
    expect(first).not.toContain("have not declared your own task yet");
    expect(first).not.toContain("coordination_note_create");

    // Dedup: the same roster (still undeclared) is not repeated.
    expect(await store.renderWorkspacePeers({ id: "sess-a", harness: "zcode", cwd: "/repo" })).toBeNull();

    // Manual declarations do not leak into the passive summary.
    await store.create({ kind: "working", message: "my declared task", cwd: "/repo", paths: ["mine.ts"], authorHarness: "zcode", authorSessionId: "sess-a", source: "manual" });
    expect(await store.renderWorkspacePeers({ id: "sess-a", harness: "zcode", cwd: "/repo" })).toBeNull();
  });

  it("publishes granular presence resource updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-herder-presence-events-"));
    const events = new HerderEventBus();
    const seen: string[] = [];
    events.subscribe((event) => seen.push(event.uri));
    const store = new CoordinationNoteStore(join(dir, "notes.json"), events);
    await store.reservePaths({ harness: "zcode", sessionId: "sess-presence", cwd: "/repo", paths: ["a.ts"] });
    expect(seen).toEqual(expect.arrayContaining([
      "herder://presence",
      "herder://presence/sess-presence",
      "herder://presence/workspaces/%2Frepo",
    ]));
  });

  it("exposes granular session and workspace presence snapshots", async () => {
    const store = await freshStore();
    await store.reservePaths({ harness: "zcode", sessionId: "sess-presence", cwd: "/repo", paths: ["a.ts"] });
    await store.reservePaths({ harness: "zcode", sessionId: "sess-other", cwd: "/repo", paths: ["b.ts"] });
    expect(store.presenceForSession("sess-presence")).toMatchObject({ sessionId: "sess-presence", boards: [expect.objectContaining({ cwd: "/repo" })] });
    expect(store.presenceForWorkspace("/repo").map((entry) => entry.sessionId).sort()).toEqual(["sess-other", "sess-presence"]);
    expect(store.presenceForSession("missing")).toBeNull();
  });

  it("endSession purges hook leases and presence but keeps manual notes", async () => {
    const store = await freshStore();
    await store.reservePaths({ harness: "zcode", sessionId: "sess-x", cwd: "/repo", paths: ["a.ts"] });
    await store.create({ kind: "handoff", message: "handing over", cwd: "/repo", paths: ["b.ts"], authorHarness: "zcode", authorSessionId: "sess-x", source: "manual" });

    const result = await store.endSession("sess-x");
    expect(result.removed).toBe(1);

    // The deliberate handoff note is excluded from passive summaries and
    // remains available through the detailed active turn renderer.
    const peers = await store.renderWorkspacePeers({ id: "sess-y", harness: "zcode", cwd: "/repo" });
    expect(peers).toBeNull();
    const active = await store.renderForSession({ id: "sess-y", harness: "zcode", cwd: "/repo" });
    expect(active).toContain("sess-x");
    expect(active).toContain("b.ts");
  });
});
