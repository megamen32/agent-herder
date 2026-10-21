import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_LIST_SETTINGS,
  SESSION_LIST_SETTINGS_STORAGE_KEY,
  readSessionListSettings,
  writeSessionListSettings,
} from "../src/web-ui/session-list-preferences.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("session list settings", () => {
  it("restores the 'show completed sessions' toggle after reload", () => {
    const storage = memoryStorage();
    writeSessionListSettings(storage, { ...DEFAULT_SESSION_LIST_SETTINGS, showAll: false });

    expect(JSON.parse(storage.getItem(SESSION_LIST_SETTINGS_STORAGE_KEY) as string).showAll).toBe(false);
    expect(readSessionListSettings(storage).showAll).toBe(false);
  });

  it("restores filters, sorting, and machine together", () => {
    const storage = memoryStorage();
    const settings = { cwd: "/home/roomhacker/app", project: "agent-herder", harness: "opencode", hostId: "roomhacker-server-100", sort: "activity" as const, showAll: true };
    writeSessionListSettings(storage, settings);

    expect(readSessionListSettings(storage)).toEqual(settings);
  });

  it("keeps the default view for malformed, partial, or unavailable storage", () => {
    const storage = memoryStorage();
    storage.setItem(SESSION_LIST_SETTINGS_STORAGE_KEY, "not-json");
    expect(readSessionListSettings(storage)).toEqual(DEFAULT_SESSION_LIST_SETTINGS);

    storage.setItem(SESSION_LIST_SETTINGS_STORAGE_KEY, JSON.stringify({ showAll: false, sort: "unknown-sort" }));
    const partial = readSessionListSettings(storage);
    expect(partial.showAll).toBe(false);
    expect(partial.sort).toBe("created");

    const blockedStorage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(readSessionListSettings(blockedStorage)).toEqual(DEFAULT_SESSION_LIST_SETTINGS);
    expect(() => writeSessionListSettings(blockedStorage, DEFAULT_SESSION_LIST_SETTINGS)).not.toThrow();
  });
});
