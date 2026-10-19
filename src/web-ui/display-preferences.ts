type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export const REASONING_DISPLAY_STORAGE_KEY = "agent-herder.show-reasoning";
export const TOOLS_DISPLAY_STORAGE_KEY = "agent-herder.show-tools";

export function readDisplayPreference(storage: Storage, key: string): boolean {
  try {
    return storage.getItem(key) === "true";
  } catch {
    return false;
  }
}

export function writeDisplayPreference(storage: Storage, key: string, value: boolean): void {
  try {
    storage.setItem(key, String(value));
  } catch { /* Persistence is optional; rendering must keep working. */ }
}
