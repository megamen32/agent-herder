import type { SessionListSettings, SessionListSort } from "./session-list.js";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/**
 * Настройки списка сессий живут в localStorage: иначе «Показывать завершённые
 * сессии», сортировка и фильтры по папке/агенту сбрасываются при перезагрузке
 * страницы. Хранилище — optional: при недоступном localStorage список обязан
 * продолжать работать, просто без сохранения.
 */
export const SESSION_LIST_SETTINGS_STORAGE_KEY = "agent-herder.list-settings";

export const DEFAULT_SESSION_LIST_SETTINGS: SessionListSettings = {
  cwd: "",
  project: "",
  harness: "",
  hostId: "",
  sort: "created",
  showAll: true,
};

const SESSION_LIST_SORTS: SessionListSort[] = ["created", "activity", "status", "harness", "title", "cwd"];

const MAX_TEXT_LENGTH = 512;

export function readSessionListSettings(
  storage: Storage,
  fallback: SessionListSettings = DEFAULT_SESSION_LIST_SETTINGS,
): SessionListSettings {
  let raw: string | null = null;
  try {
    raw = storage.getItem(SESSION_LIST_SETTINGS_STORAGE_KEY);
  } catch {
    return fallback;
  }
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
    const value = parsed as Record<string, unknown>;
    const text = (key: "cwd" | "project" | "harness"): string =>
      typeof value[key] === "string" ? (value[key] as string).slice(0, MAX_TEXT_LENGTH) : fallback[key];
    const hostId = typeof value.hostId === "string" ? value.hostId.slice(0, MAX_TEXT_LENGTH) : fallback.hostId ?? "";
    const sort = SESSION_LIST_SORTS.includes(value.sort as SessionListSort)
      ? (value.sort as SessionListSort)
      : fallback.sort;
    const showAll = typeof value.showAll === "boolean" ? value.showAll : fallback.showAll;
    return { cwd: text("cwd"), project: text("project"), harness: text("harness"), hostId, sort, showAll };
  } catch {
    return fallback;
  }
}

export function writeSessionListSettings(storage: Storage, settings: SessionListSettings): void {
  try {
    storage.setItem(SESSION_LIST_SETTINGS_STORAGE_KEY, JSON.stringify({
      hostId: settings.hostId ?? "",
      cwd: settings.cwd ?? "",
      project: settings.project ?? "",
      harness: settings.harness ?? "",
      sort: settings.sort,
      showAll: settings.showAll,
    }));
  } catch { /* Persistence is optional; the session list must keep working. */ }
}
