import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HarnessRuntimeSettingsStore,
  emptyHarnessRuntimeSettings,
  parseHarnessRuntimeSettings,
} from "./harness-runtime-settings.js";

describe("release occupancy runtime setting", () => {
  it("fails closed for legacy documents without the switch", () => {
    expect(parseHarnessRuntimeSettings(JSON.stringify({ version: 1, pollingEnabled: true, harnesses: {} })))
      .toMatchObject({ releaseOccupancyEnabled: false });
    expect(emptyHarnessRuntimeSettings().releaseOccupancyEnabled).toBe(false);
  });

  it("persists an owner change without losing the harness switches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-herder-settings-"));
    try {
      const path = join(dir, "harness-runtime-settings.json");
      const store = HarnessRuntimeSettingsStore.at(dir);
      await store.update({ harnesses: { codex: { hooksEnabled: false } } }, { by: "test" });
      const enabled = await store.update({ releaseOccupancyEnabled: true }, { by: "test" });
      expect(enabled.releaseOccupancyEnabled).toBe(true);
      expect(enabled.harnesses.codex?.hooksEnabled).toBe(false);
      expect(JSON.parse(await readFile(path, "utf8")).releaseOccupancyEnabled).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
