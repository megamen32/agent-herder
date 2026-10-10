/** Префиксы провайдера в имени модели: `anthropic.MiniMax-…` → `MiniMax-…`. */
const PROVIDER_PREFIXES = new Set(["anthropic", "openai", "google", "meta", "minimax", "deepseek", "qwen", "zai", "mistral", "xai"]);

/** Подпись модели для чипа: короткое имя без префикса провайдера. */
export const shortModelLabel = (model?: string): string => {
  const trimmed = (model || "").trim();
  if (!trimmed) return "Модель по умолчанию";
  const tail = trimmed.split("/").pop() || trimmed;
  const [head, ...rest] = tail.split(".");
  // точку режем только у известного провайдера: в самой модели точки значимы (M3.1, gpt-6.1)
  return rest.length && PROVIDER_PREFIXES.has(head.toLowerCase()) ? rest.join(".") : tail;
};

/**
 * Харнесс, который умеет менять модель на живой сессии. В списке адаптеров это
 * capabilities.modelSwitch; без него чип прячем, чтобы не показывать мёртвый контрол.
 */
export const modelSwitchSupported = (
  adapters: Array<{ id: string; active?: boolean; capabilities?: { modelSwitch?: boolean } | null }>,
  harness: string | undefined,
): boolean => {
  if (!harness) return false;
  const adapter = adapters.find((item) => item.id === harness);
  return adapter?.active === true && adapter.capabilities?.modelSwitch === true;
};

/** Текущая модель, если она совпадает с выбором пользователя; иначе undefined. */
export const currentModelOption = (current: string | undefined, options: string[]): string | undefined => {
  const trimmed = (current || "").trim();
  return trimmed && options.includes(trimmed) ? trimmed : undefined;
};

export type ModelSwitchOutcome =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Смена модели живой сессии: POST /api/sessions/<harness>/<id> с action "model"
 * вызывает supervisor.changeModel. Ошибку адаптера показываем пользователю как есть.
 */
export const requestModelChange = async (
  fetchImpl: typeof fetch,
  harness: string,
  sessionId: string,
  model: string,
): Promise<ModelSwitchOutcome> => {
  try {
    const response = await fetchImpl(`/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "model", model }),
    });
    const payload = await response.json().catch(() => undefined) as { ok?: boolean; error?: string } | undefined;
    if (response.ok && payload?.ok !== false) return { ok: true };
    const detail = payload?.error || `${response.status} ${response.statusText}`.trim();
    return { ok: false, message: `Не удалось сменить модель: ${detail}` };
  } catch (error) {
    // обрыв связи — тоже понятное сообщение вместо необработанного исключения
    return { ok: false, message: `Не удалось сменить модель: ${(error as Error).message}` };
  }
};