import { describe, expect, it } from "vitest";
import {
  ADVANCED_SEARCH_STORAGE_KEY,
  DEFAULT_ADVANCED_SEARCH_PREFERENCES,
  SESSION_SEARCH_STORAGE_KEY,
  readAdvancedSearchPreferences,
  readSessionSearchPreferences,
  writeAdvancedSearchPreferences,
  writeSessionSearchPreferences,
} from "../src/web-ui/search-preferences.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("search preferences", () => {
  it("restores the ordinary session query after reload", () => {
    const storage = memoryStorage();
    writeSessionSearchPreferences(storage, { query: "zcode reconnect" });

    expect(storage.getItem(SESSION_SEARCH_STORAGE_KEY)).toBe(JSON.stringify({ query: "zcode reconnect" }));
    expect(readSessionSearchPreferences(storage)).toEqual({ query: "zcode reconnect" });
  });

  it("restores advanced query, harnesses, project, and date filters", () => {
    const storage = memoryStorage();
    const preferences = {
      query: "resume after disconnect",
      harnesses: ["codex", "opencode"],
      project: "agent-herder",
      from: "2026-10-01",
      to: "2026-10-18",
    };
    writeAdvancedSearchPreferences(storage, preferences);

    expect(storage.getItem(ADVANCED_SEARCH_STORAGE_KEY)).toBe(JSON.stringify(preferences));
    expect(readAdvancedSearchPreferences(storage)).toEqual(preferences);
  });

  it("uses defaults for malformed or unavailable local storage", () => {
    const storage = memoryStorage();
    storage.setItem(ADVANCED_SEARCH_STORAGE_KEY, "not-json");
    expect(readAdvancedSearchPreferences(storage)).toEqual(DEFAULT_ADVANCED_SEARCH_PREFERENCES);

    const blockedStorage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    expect(readSessionSearchPreferences(blockedStorage)).toEqual({ query: "" });
    expect(() => writeSessionSearchPreferences(blockedStorage, { query: "ignored" })).not.toThrow();
    expect(() => writeAdvancedSearchPreferences(blockedStorage, DEFAULT_ADVANCED_SEARCH_PREFERENCES)).not.toThrow();
  });
});
