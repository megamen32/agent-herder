import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinationNoteStore } from "../src/coordination-notes.js";

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
});
