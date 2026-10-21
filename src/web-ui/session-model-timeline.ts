type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/**
 * Таймлайн моделей сессии: какая модель была выбрана и в какой момент.
 *
 * Нативная сессия отдаёт только текущую модель (`session.model`), а она
 * обновляется не сразу после смены — поэтому «справа» часто видна предыдущая
 * модель. Таймлайн решает две задачи: помогает понять, с какой моделью
 * отправлено конкретное сообщение, и переживает перезагрузку страницы.
 */
export const MODEL_TIMELINE_STORAGE_PREFIX = "agent-herder.model-timeline.";

export type ModelTimelineEntry = { at: number; model: string };

const MAX_ENTRIES = 64;

const MAX_MODEL_LENGTH = 200;

export function modelTimelineKey(sessionKey: string): string {
  return MODEL_TIMELINE_STORAGE_PREFIX + sessionKey;
}

export function readModelTimeline(storage: Storage, sessionKey: string): ModelTimelineEntry[] {
  try {
    const raw = storage.getItem(modelTimelineKey(sessionKey));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is ModelTimelineEntry =>
        Boolean(item)
        && typeof item === "object"
        && typeof (item as ModelTimelineEntry).at === "number"
        && Number.isFinite((item as ModelTimelineEntry).at)
        && typeof (item as ModelTimelineEntry).model === "string"
        && (item as ModelTimelineEntry).model.length > 0)
      .map((item) => ({ at: item.at, model: item.model.slice(0, MAX_MODEL_LENGTH) }))
      .sort((left, right) => left.at - right.at)
      .slice(-MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function writeModelTimeline(storage: Storage, sessionKey: string, entries: ModelTimelineEntry[]): void {
  try {
    storage.setItem(modelTimelineKey(sessionKey), JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch { /* Persistence is optional; the chat must keep working. */ }
}

/** Фиксирует модель в моменте времени. Повтор той же модели не плодит записи. */
export function recordModelAt(entries: ModelTimelineEntry[], at: number, model: string): ModelTimelineEntry[] {
  const trimmed = model.trim();
  if (!trimmed) return entries;
  const last = entries[entries.length - 1];
  if (last && last.model === trimmed) {
    return last.at === at ? entries : [...entries.slice(0, -1), { at, model: trimmed }];
  }
  return [...entries, { at, model: trimmed }].slice(-MAX_ENTRIES);
}

/** Модель, действовавшая в указанный момент времени (милликунды epoch). */
export function modelAt(entries: ModelTimelineEntry[], at: number): string | undefined {
  let found: string | undefined;
  for (const entry of entries) {
    if (entry.at <= at) found = entry.model;
    else break;
  }
  return found;
}

/** Последняя модель, выбранная пользователем в этой сессии. */
export function latestModel(entries: ModelTimelineEntry[]): string | undefined {
  return entries[entries.length - 1]?.model;
}
