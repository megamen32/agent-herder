import { describe, expect, it } from "vitest";
import {
  REASONING_DISPLAY_STORAGE_KEY,
  TOOLS_DISPLAY_STORAGE_KEY,
  readDisplayPreference,
  writeDisplayPreference,
} from "../src/web-ui/display-preferences.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe("display preferences", () => {
  it("restores reasoning and tools visibility after reload", () => {
    const storage = memoryStorage();
    writeDisplayPreference(storage, REASONING_DISPLAY_STORAGE_KEY, true);
    writeDisplayPreference(storage, TOOLS_DISPLAY_STORAGE_KEY, false);

    expect(readDisplayPreference(storage, REASONING_DISPLAY_STORAGE_KEY)).toBe(true);
    expect(readDisplayPreference(storage, TOOLS_DISPLAY_STORAGE_KEY)).toBe(false);
  });

  it("defaults to hidden when local storage is invalid or unavailable", () => {
    const storage = memoryStorage();
    storage.setItem(REASONING_DISPLAY_STORAGE_KEY, "yes");
    expect(readDisplayPreference(storage, REASONING_DISPLAY_STORAGE_KEY)).toBe(false);

    const blockedStorage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(readDisplayPreference(blockedStorage, TOOLS_DISPLAY_STORAGE_KEY)).toBe(false);
    expect(() => writeDisplayPreference(blockedStorage, TOOLS_DISPLAY_STORAGE_KEY, true)).not.toThrow();
  });
});
