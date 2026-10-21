import { describe, expect, it } from "vitest";
import {
  MODEL_TIMELINE_STORAGE_PREFIX,
  latestModel,
  modelAt,
  modelTimelineKey,
  readModelTimeline,
  recordModelAt,
  writeModelTimeline,
} from "../src/web-ui/session-model-timeline.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("session model timeline", () => {
  it("keeps the model of every message by time", () => {
    const storage = memoryStorage();
    const sessionKey = "opencode:ses_1";
    writeModelTimeline(storage, sessionKey, [
      { at: 1_000, model: "omniroute/minimax/MiniMax-M3.1-Flash" },
      { at: 2_000, model: "codex/gpt-6.1-sol" },
    ]);

    const entries = readModelTimeline(storage, sessionKey);
    expect(entries).toHaveLength(2);
    expect(modelAt(entries, 1_500)).toBe("omniroute/minimax/MiniMax-M3.1-Flash");
    expect(modelAt(entries, 2_000)).toBe("codex/gpt-6.1-sol");
    expect(modelAt(entries, 500)).toBeUndefined();
    expect(latestModel(entries)).toBe("codex/gpt-6.1-sol");
    expect(storage.getItem(MODEL_TIMELINE_STORAGE_PREFIX + sessionKey)).toBeTruthy();
  });

  it("does not multiply entries for the same model", () => {
    const entries = recordModelAt([], 1_000, "gpt-6-luna");
    const again = recordModelAt(entries, 2_000, "gpt-6-luna");
    expect(again).toHaveLength(1);
    expect(again[0].at).toBe(2_000);
    expect(modelAt(again, 1_500)).toBeUndefined();
  });

  it("keeps timelines of different sessions apart and survives broken storage", () => {
    const storage = memoryStorage();
    writeModelTimeline(storage, "opencode:ses_1", [{ at: 1, model: "a" }]);
    writeModelTimeline(storage, "opencode:ses_2", [{ at: 1, model: "b" }]);
    expect(readModelTimeline(storage, "opencode:ses_1")[0].model).toBe("a");
    expect(readModelTimeline(storage, "opencode:ses_2")[0].model).toBe("b");
    expect(modelTimelineKey("opencode:ses_1")).toBe(MODEL_TIMELINE_STORAGE_PREFIX + "opencode:ses_1");

    storage.setItem(modelTimelineKey("opencode:ses_1"), "not-json");
    expect(readModelTimeline(storage, "opencode:ses_1")).toEqual([]);

    const blockedStorage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(readModelTimeline(blockedStorage, "opencode:ses_1")).toEqual([]);
    expect(() => writeModelTimeline(blockedStorage, "opencode:ses_1", [{ at: 1, model: "a" }])).not.toThrow();
  });
});
