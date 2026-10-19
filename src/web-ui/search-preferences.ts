export type SearchHarness = "codex" | "zcode" | "opencode";

export type SessionSearchPreferences = { query: string };
export type AdvancedSearchPreferences = {
  query: string;
  harnesses: SearchHarness[];
  project: string;
  from: string;
  to: string;
};

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
type RecordValue = Record<string, unknown>;

export const SESSION_SEARCH_STORAGE_KEY = "agent-herder.session-search";
export const ADVANCED_SEARCH_STORAGE_KEY = "agent-herder.advanced-search";

const HARNESSES: readonly SearchHarness[] = ["codex", "zcode", "opencode"];
const MAX_QUERY_LENGTH = 2048;
const MAX_PROJECT_LENGTH = 512;

export const DEFAULT_ADVANCED_SEARCH_PREFERENCES: AdvancedSearchPreferences = {
  query: "",
  harnesses: [...HARNESSES],
  project: "",
  from: "",
  to: "",
};

function parseRecord(storage: Storage, key: string): RecordValue | undefined {
  try {
    const raw = storage.getItem(key);
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
  } catch {
    return undefined;
  }
}

function boundedString(value: unknown, fallback: string, limit: number): string {
  return typeof value === "string" ? value.slice(0, limit) : fallback;
}

function validDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : "";
}

function normalizeHarnesses(value: unknown): SearchHarness[] {
  if (!Array.isArray(value)) return [...HARNESSES];
  return [...new Set(value.filter((item): item is SearchHarness => HARNESSES.includes(item as SearchHarness)))];
}

export function readSessionSearchPreferences(storage: Storage): SessionSearchPreferences {
  const saved = parseRecord(storage, SESSION_SEARCH_STORAGE_KEY);
  return { query: boundedString(saved?.query, "", MAX_QUERY_LENGTH) };
}

export function writeSessionSearchPreferences(storage: Storage, preferences: SessionSearchPreferences): void {
  try {
    storage.setItem(SESSION_SEARCH_STORAGE_KEY, JSON.stringify({
      query: boundedString(preferences.query, "", MAX_QUERY_LENGTH),
    }));
  } catch { /* Persistence is optional; searching must keep working. */ }
}

export function readAdvancedSearchPreferences(storage: Storage): AdvancedSearchPreferences {
  const saved = parseRecord(storage, ADVANCED_SEARCH_STORAGE_KEY);
  if (!saved) return { ...DEFAULT_ADVANCED_SEARCH_PREFERENCES, harnesses: [...HARNESSES] };
  return {
    query: boundedString(saved.query, "", MAX_QUERY_LENGTH),
    harnesses: normalizeHarnesses(saved.harnesses),
    project: boundedString(saved.project, "", MAX_PROJECT_LENGTH),
    from: validDate(saved.from),
    to: validDate(saved.to),
  };
}

export function writeAdvancedSearchPreferences(storage: Storage, preferences: AdvancedSearchPreferences): void {
  try {
    storage.setItem(ADVANCED_SEARCH_STORAGE_KEY, JSON.stringify({
      query: boundedString(preferences.query, "", MAX_QUERY_LENGTH),
      harnesses: normalizeHarnesses(preferences.harnesses),
      project: boundedString(preferences.project, "", MAX_PROJECT_LENGTH),
      from: validDate(preferences.from),
      to: validDate(preferences.to),
    }));
  } catch { /* Persistence is optional; searching must keep working. */ }
}
