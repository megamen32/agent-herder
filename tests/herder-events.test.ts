import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HerderEventBus } from "../src/herder-events.js";

describe("HerderEventBus journal", () => {
  it("assigns global sequence and per-resource revision and replays after a cursor", () => {
    const bus = new HerderEventBus();
    const first = bus.publish({ kind: "sessions", uri: "herder://sessions/claude/s1", action: "created" });
    const second = bus.publish({ kind: "sessions", uri: "herder://sessions/claude/s1", action: "changed" });
    const third = bus.publish({ kind: "jobs", uri: "herder://jobs/j1", action: "created" });

    expect(first).toMatchObject({ sequence: 1, revision: 1 });
    expect(second).toMatchObject({ sequence: 2, revision: 2 });
    expect(third).toMatchObject({ sequence: 3, revision: 1 });
    expect(bus.latestSequence()).toBe(3);
    expect(bus.revision("herder://sessions/claude/s1")).toBe(2);
    expect(bus.listAfter(1).map((event) => event.sequence)).toEqual([2, 3]);
    expect(bus.listAfter(0, 50, "herder://jobs").map((event) => event.sequence)).toEqual([3]);
  });

  it("persists cursor, revisions, and retained events across restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-herder-events-"));
    const persistencePath = join(dir, "events.json");
    try {
      const first = new HerderEventBus({ persistencePath });
      first.publish({ kind: "coordination", uri: "herder://coordination", action: "changed", source: "test" });
      first.publish({ kind: "coordination", uri: "herder://coordination", action: "changed", source: "test" });

      const restored = new HerderEventBus({ persistencePath });
      expect(restored.latestSequence()).toBe(2);
      expect(restored.revision("herder://coordination")).toBe(2);
      expect(restored.listAfter(0)).toHaveLength(2);
      expect(restored.publish({ kind: "coordination", uri: "herder://coordination", action: "changed" })).toMatchObject({ sequence: 3, revision: 3 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
