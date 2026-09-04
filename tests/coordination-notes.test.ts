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
