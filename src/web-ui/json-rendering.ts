type WebStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const JSON_RENDERING_OPT_OUT_STORAGE_KEY = "agent-herder.json-rendering.opt-out";

const SYSTEM_BLOCK_PATTERN = /<(system-reminder|context_guidance|agent-herder-repo-peers|agent-herder-coordination|agent-herder-deferred|oai-mem-citation)>([\s\S]*?)<\/\1>/g;
const SYSTEM_BLOCK_LABELS: Record<string, string> = {
  "system-reminder": "Системное напоминание",
  "context_guidance": "Служебный контекст",
  "agent-herder-repo-peers": "Соседи по репозиторию",
  "agent-herder-coordination": "Заметка координации",
  "agent-herder-deferred": "Отложенные сообщения",
  "oai-mem-citation": "Цитата памяти",
};
// Capturing the delimiter retains complete and streamed code blocks in split().
const CODE_FENCE_SPLIT = /(```[\s\S]*?(?:```|$))/g;

export function splitSystemBlocks(text: string): { text: string; blocks: Array<{ label: string; body: string }> } {
  const blocks: Array<{ label: string; body: string }> = [];
  const stripped = text.split(CODE_FENCE_SPLIT).map((segment) => segment.startsWith("```") ? segment : segment.replace(SYSTEM_BLOCK_PATTERN, (_match, tag: string, body: string) => {
    blocks.push({ label: SYSTEM_BLOCK_LABELS[tag] || "Служебный блок", body: body.trim() });
    return "";
  })).join("");
  return { text: stripped.trim(), blocks };
}

/**
 * Возвращает pretty-printed JSON, когда весь текст сообщения сам по себе является
 * одним JSON-значением. Объект или массив: одиночные скаляры (`true`, `42`, `"текст"`)
 * и проза вокруг JSON остаются обычным текстом.
 */
export function formatJsonPayload(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length < 2) return undefined;
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const pretty = JSON.stringify(parsed, null, 2);
  return pretty ? pretty : undefined;
}

/** По умолчанию разметка JSON включена, то есть отключается только явным opt-out. */
export const readJsonRenderingOptOut = (storage: WebStorage): boolean => {
  try {
    return storage.getItem(JSON_RENDERING_OPT_OUT_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};

export const writeJsonRenderingOptOut = (storage: WebStorage, optedOut: boolean): void => {
  try {
    if (optedOut) storage.setItem(JSON_RENDERING_OPT_OUT_STORAGE_KEY, "1");
    else storage.removeItem(JSON_RENDERING_OPT_OUT_STORAGE_KEY);
  } catch {
    // несохранённое предпочтение не блокирует просмотр переписки
  }
};
