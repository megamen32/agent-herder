import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinationNoteStore } from "../src/coordination-notes.js";

/**
 * Counts how often the store reads its ledger file. The private read is the
 * only place the file is touched, so the counter shows the real read count.
 */
function countReads(store: CoordinationNoteStore): () => number {
  const target = store as unknown as { read: () => Promise<unknown> };
  const original = target.read.bind(store);
  let reads = 0;
  target.read = async () => { reads += 1; return original(); };
  return () => reads;
}

describe("bulk workspace observations", () => {
  it("answers a long session list with one read of the ledger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herder-bulk-observation-"));
    const store = new CoordinationNoteStore(join(dir, "notes.json"));
    await store.declareWorkspace({ sessionId: "declared", harness: "codex", hostId: "host-88", cwd: "/srv/remote", ttlSeconds: 600 });
    await store.heartbeatSession({ sessionId: "active", cwd: "/srv/active" });

    const ids = ["declared", "active", "silent", ...Array.from({ length: 500 }, (_, index) => `bulk-${index}`)];
    const reads = countReads(store);
    const observations = await store.activeWorkspaceObservations(ids);

    expect(reads()).toBe(1);
    expect(observations.get("declared")).toMatchObject({ hostId: "host-88", cwd: "/srv/remote", source: "declared" });
    expect(observations.get("active")).toMatchObject({ hostId: store.localHostId, cwd: "/srv/active", source: "coordination_activity" });
    // A session without any signal stays out of the answer, so its native values survive.
    expect(observations.has("silent")).toBe(false);
    expect(observations.size).toBe(2);
  });

  it("gives the same answer as the single observation of every session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herder-bulk-parity-"));
    const store = new CoordinationNoteStore(join(dir, "notes.json"));
    await store.declareWorkspace({ sessionId: "declared", harness: "codex", hostId: "host-88", cwd: "/srv/remote", ttlSeconds: 600 });
    await store.heartbeatSession({ sessionId: "active", cwd: "/srv/active" });

    const ids = ["declared", "active", "silent"];
    const bulk = await store.activeWorkspaceObservations(ids);
    for (const id of ids) expect(bulk.get(id)).toEqual(await store.activeWorkspaceObservation(id));
  });

  it("ignores an expired declaration and leaves the sessions without one untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herder-bulk-expired-"));
    const path = join(dir, "notes.json");
    const store = new CoordinationNoteStore(path);
    await store.declareWorkspace({ sessionId: "declared", harness: "codex", hostId: "host-88", cwd: "/srv/remote", ttlSeconds: 600 });
    const ledger = JSON.parse(await readFile(path, "utf8"));
    ledger.workspaceDeclarations.find((row: { sessionId: string }) => row.sessionId === "declared").expiresAt = new Date(Date.now() - 1).toISOString();
    await writeFile(path, JSON.stringify(ledger));

    const observations = await store.activeWorkspaceObservations(["declared", "silent"]);
    expect(observations.has("declared")).toBe(false);
    expect(observations.has("silent")).toBe(false);
    expect(await store.activeWorkspaceObservation("declared")).toBeUndefined();
  });
});
