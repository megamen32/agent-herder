import * as React from "react";
import { isRecoveryModelReference } from "../recovery-model-reference.js";

export const FALLBACK_MODEL_HARNESSES = ["opencode", "zcode"] as const;
export type FallbackModelHarness = typeof FALLBACK_MODEL_HARNESSES[number];
export type FallbackModelMap = Partial<Record<FallbackModelHarness, string[]>>;
export type LaunchPolicyFallbackDocument = { policy: Record<string, unknown>; etag: string; fallbackModels: FallbackModelMap; currentModels: Partial<Record<FallbackModelHarness, string>> };
export type SaveFallbackPolicyResult = { kind: "saved"; document: LaunchPolicyFallbackDocument } | { kind: "conflict" } | { kind: "error"; message: string };

const LABELS: Record<FallbackModelHarness, string> = { opencode: "OpenCode", zcode: "ZCode" };

export function moveFallbackModel(models: string[], index: number, offset: -1 | 1): string[] {
  const target = index + offset;
  if (index < 0 || index >= models.length || target < 0 || target >= models.length) return models;
  const next = [...models];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function fallbackModelIssue(model: string): string | undefined {
  const value = model.trim();
  if (!value) return "Укажите полный OmniRoute ID: omniroute/модель или omniroute/провайдер/модель.";
  if (value.length > 256 || /[\u0000-\u0020\u007f]/u.test(value)) return "Имя модели должно содержать не более 256 символов и не содержать пробелов.";
  if (!isRecoveryModelReference(value)) {
    return "Укажите полный OmniRoute ID или поддерживаемый нативный ID вида провайдер/модель.";
  }
  return undefined;
}

function readFallbackFields(policy: Record<string, unknown>): Pick<LaunchPolicyFallbackDocument, "fallbackModels" | "currentModels"> {
  if (policy.version !== 1 || !Array.isArray(policy.allowedHarnesses) || typeof policy.preferredHarness !== "string"
    || !policy.models || typeof policy.models !== "object" || Array.isArray(policy.models)) {
    throw new Error("Политика запуска имеет неверный формат.");
  }
  const fallbackModels: FallbackModelMap = {};
  const rawFallbackModels = policy.fallbackModels;
  if (rawFallbackModels !== undefined && (!rawFallbackModels || typeof rawFallbackModels !== "object" || Array.isArray(rawFallbackModels))) {
    throw new Error("Список запасных моделей имеет неверный формат.");
  }
  if (rawFallbackModels && typeof rawFallbackModels === "object") {
    for (const [harness, value] of Object.entries(rawFallbackModels as Record<string, unknown>)) {
      if (!(FALLBACK_MODEL_HARNESSES as readonly string[]).includes(harness) || !Array.isArray(value) || value.length > 8
        || !value.every((item) => typeof item === "string" && item.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(item))) {
        throw new Error(`Список запасных моделей для ${harness} имеет неверный формат.`);
      }
      fallbackModels[harness as FallbackModelHarness] = [...value] as string[];
    }
  }
  const rawModels = policy.models as Record<string, unknown>;
  const currentModels: Partial<Record<FallbackModelHarness, string>> = {};
  for (const harness of FALLBACK_MODEL_HARNESSES) {
    if (typeof rawModels[harness] === "string") currentModels[harness] = rawModels[harness] as string;
  }
  return { fallbackModels, currentModels };
}

export async function loadFallbackModelPolicy(): Promise<LaunchPolicyFallbackDocument> {
  const response = await fetch("/api/automation/launch-policy", { headers: { accept: "application/json" }, cache: "no-store" });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const state = typeof body.state === "string" ? body.state : "";
    const message = state === "absent"
      ? "Сначала сохраните основные настройки запуска новых сессий."
      : state === "invalid"
        ? "Политика запуска повреждена; запасные модели нельзя сохранить."
        : "Не удалось загрузить список запасных моделей.";
    throw new Error(message);
  }
  const etag = response.headers.get("etag");
  if (!etag) throw new Error("Сервер не вернул версию политики запуска.");
  const fields = readFallbackFields(body);
  return { policy: body, etag, ...fields };
}

export function normalizeFallbackModelMap(fallbackModels: FallbackModelMap): FallbackModelMap {
  const normalized: FallbackModelMap = {};
  for (const harness of FALLBACK_MODEL_HARNESSES) {
    const seen = new Set<string>();
    const models: string[] = [];
    for (const candidate of fallbackModels[harness] ?? []) {
      const model = candidate.trim();
      const key = model.toLocaleLowerCase("en-US");
      if (!model || seen.has(key)) continue;
      seen.add(key);
      models.push(model);
    }
    if (models.length) normalized[harness] = models;
  }
  return normalized;
}

export async function saveFallbackModelPolicy(
  document: LaunchPolicyFallbackDocument,
  fallbackModels: FallbackModelMap,
): Promise<SaveFallbackPolicyResult> {
  const nextFallbackModels = normalizeFallbackModelMap(fallbackModels);
  // An explicit empty map clears this field. Older launch-policy editors omit
  // the field entirely, which the server preserves for backward compatibility.
  const policy = { ...document.policy, fallbackModels: nextFallbackModels };
  let response: Response;
  try {
    response = await fetch("/api/automation/launch-policy", {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": document.etag, accept: "application/json" },
      body: JSON.stringify(policy),
    });
  } catch {
    return { kind: "error", message: "Не удалось связаться с сервером настроек запуска." };
  }
  if (response.status === 412) return { kind: "conflict" };
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) return { kind: "error", message: typeof body.error === "string" ? body.error : `Сервер отклонил настройки (код ${response.status}).` };
  const etag = response.headers.get("etag");
  if (!etag) return { kind: "error", message: "Сервер сохранил настройки без версии документа; перечитайте их перед следующей правкой." };
  try {
    const fields = readFallbackFields(body);
    return { kind: "saved", document: { policy: body, etag, ...fields } };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

export function fallbackModelsSaveIssue(fallbackModels: FallbackModelMap): string | undefined {
  for (const harness of FALLBACK_MODEL_HARNESSES) {
    const models = fallbackModels[harness] ?? [];
    const unique = new Set<string>();
    for (const model of models) {
      const issue = fallbackModelIssue(model);
      if (issue) return issue;
      unique.add(model.trim().toLocaleLowerCase("en-US"));
      if (unique.size > 8) return "Можно указать не более 8 запасных моделей для каждой среды.";
    }
  }
  return undefined;
}

export function FallbackModelsControls({
  fallbackModels,
  currentModels,
  onChange,
  disabled = false,
  modelOptions = {},
}: {
  fallbackModels: FallbackModelMap;
  currentModels: Partial<Record<FallbackModelHarness, string>>;
  onChange: (next: FallbackModelMap) => void;
  disabled?: boolean;
  modelOptions?: Partial<Record<FallbackModelHarness, string[]>>;
}) {
  const listId = React.useId();
  const update = (harness: FallbackModelHarness, models: string[]) => {
    const next = { ...fallbackModels };
    if (models.length) next[harness] = models;
    else delete next[harness];
    onChange(next);
  };

  return <fieldset className="settings-group" disabled={disabled}>
    <legend>Запасные модели при исчерпании квоты</legend>
    <p className="settings-help">Укажите полные ID в порядке попытки: рабочий OmniRoute или нативный провайдер/модель для выбранной среды. Список применяется только после подтверждённого отказа по квоте. Текущая модель и повторы будут пропущены.</p>
    {FALLBACK_MODEL_HARNESSES.map((harness) => {
      const models = fallbackModels[harness] ?? [];
      return <section className="launch-runtime-option fallback-model-harness" key={harness} aria-label={`Запасные модели · ${LABELS[harness]}`}
        style={{ flexDirection: "column", alignItems: "stretch", cursor: "default" }}>
        <span className="fallback-model-heading"><strong>{LABELS[harness]}</strong><small>Модель в общей политике: {currentModels[harness] || "не задана"} · маршрут проекта может её изменить</small></span>
        {models.length === 0 && <small className="settings-help">Запасные модели не заданы.</small>}
        <datalist id={`${listId}-${harness}`}>{(modelOptions[harness] ?? []).map(model => <option key={model} value={model} />)}</datalist>
        <ol className="fallback-model-list" style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "8px" }}>
          {models.map((model, index) => {
            const issue = fallbackModelIssue(model);
            const duplicate = model.trim() !== "" && models.slice(0, index).some((previous) => previous.trim().toLocaleLowerCase() === model.trim().toLocaleLowerCase());
            const current = model.trim() !== "" && model.trim() === currentModels[harness]?.trim();
            return <li className="fallback-model-row" key={`${harness}-${index}`}
              style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto auto auto", gap: "8px", alignItems: "center" }}>
              <span className="fallback-model-position" aria-hidden="true">{index + 1}.</span>
              <label className="launch-policy-field" style={{ gridTemplateColumns: "minmax(0, 1fr)", gap: 0, minWidth: 0 }}>
                <span className="sr-only">Запасная модель {index + 1} для {LABELS[harness]}</span>
                <input type="text" maxLength={256} value={model} list={`${listId}-${harness}`} placeholder="omniroute/провайдер/модель"
                  aria-label={`Запасная модель ${index + 1} для ${LABELS[harness]}`}
                  aria-invalid={Boolean(issue)} onChange={(event) => {
                    const next = [...models];
                    next[index] = event.target.value;
                    update(harness, next);
                  }} />
              </label>
              <button type="button" className="quiet-button" aria-label={`Поднять запасную модель ${index + 1} для ${LABELS[harness]}`}
                disabled={index === 0} onClick={() => update(harness, moveFallbackModel(models, index, -1))}>↑</button>
              <button type="button" className="quiet-button" aria-label={`Опустить запасную модель ${index + 1} для ${LABELS[harness]}`}
                disabled={index === models.length - 1} onClick={() => update(harness, moveFallbackModel(models, index, 1))}>↓</button>
              <button type="button" className="quiet-button" aria-label={`Удалить запасную модель ${index + 1} для ${LABELS[harness]}`}
                onClick={() => update(harness, models.filter((_, modelIndex) => modelIndex !== index))}>Удалить</button>
              {issue && <small className="autopilot-error" role="alert" style={{ gridColumn: "2 / -1" }}>{issue}</small>}
              {!issue && duplicate && <small className="settings-help" role="status" style={{ gridColumn: "2 / -1" }}>Повтор будет пропущен.</small>}
              {!issue && current && <small className="settings-help" role="status" style={{ gridColumn: "2 / -1" }}>Совпадает с общей моделью; маршрут проекта может выбрать другую.</small>}
            </li>;
          })}
        </ol>
        <button type="button" className="quiet-button" aria-label={`Добавить запасную модель для ${LABELS[harness]}`}
          disabled={models.length >= 8} onClick={() => update(harness, [...models, ""])}>Добавить модель</button>
        {models.length >= 8 && <small className="settings-help">Достигнут максимум: 8 запасных моделей.</small>}
      </section>;
    })}
  </fieldset>;
}

export async function loadFallbackModelOptions(harness: FallbackModelHarness): Promise<string[]> {
  const response = await fetch(`/api/models?harness=${encodeURIComponent(harness)}`, { headers: {accept:"application/json"}, cache:"no-store" });
  if (!response.ok) throw new Error("Не удалось загрузить каталог моделей среды.");
  const body = await response.json() as {models?:unknown};
  if (!Array.isArray(body.models)) throw new Error("Каталог моделей имеет неверный формат.");
  return [...new Set(body.models.filter((model):model is string => typeof model === "string" && isRecoveryModelReference(model,harness)))];
}

export function FallbackModelsSettings() {
  const [modelOptions, setModelOptions] = React.useState<Partial<Record<FallbackModelHarness,string[]>>>({});
  const [catalogError, setCatalogError] = React.useState(false);
  React.useEffect(() => {
    let current=true;
    void Promise.all(FALLBACK_MODEL_HARNESSES.map(async harness => [harness,await loadFallbackModelOptions(harness)] as const))
      .then(rows => {if(current){setModelOptions(Object.fromEntries(rows));setCatalogError(false);}})
      .catch(() => {if(current)setCatalogError(true);});
    return () => {current=false;};
  }, []);
  const [document, setDocument] = React.useState<LaunchPolicyFallbackDocument>();
  const [draft, setDraft] = React.useState<FallbackModelMap>({});
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [conflict, setConflict] = React.useState(false);
  const [error, setError] = React.useState<string>();

  const load = React.useCallback(async (preserveDraft = false) => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await loadFallbackModelPolicy();
      setDocument(next);
      if (!preserveDraft) setDraft(next.fallbackModels);
      setConflict(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить настройки запуска.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  const save = async (base = document) => {
    if (!base) return;
    const issue = fallbackModelsSaveIssue(draft);
    if (issue) { setError(issue); return; }
    setSaving(true);
    setError(undefined);
    setSaved(false);
    try {
      const result = await saveFallbackModelPolicy(base, draft);
      if (result.kind === "saved") {
        setDocument(result.document);
        setDraft(result.document.fallbackModels);
        setConflict(false);
        setSaved(true);
      } else if (result.kind === "conflict") {
        setConflict(true);
      } else {
        setError(result.message);
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading && !document) return <section className="settings-group" aria-label="Запасные модели"><p role="status">Загружаем список запасных моделей…</p></section>;
  if (!document) return <section className="settings-group" aria-label="Запасные модели"><p className="autopilot-error" role="alert">{error || "Настройки запуска недоступны."}</p><button type="button" className="quiet-button" onClick={() => void load()}>Повторить загрузку</button></section>;

  return <section className="settings-group fallback-model-settings" aria-label="Настройки запасных моделей">
    <FallbackModelsControls fallbackModels={draft} currentModels={document.currentModels} modelOptions={modelOptions} disabled={saving || loading}
      onChange={(next) => { setDraft(next); setSaved(false); setError(undefined); }} />
    {catalogError && <p className="settings-help">Каталог среды пока недоступен. Сохранённые ID видны; доступность проверяется перед запуском.</p>}
    {error && <p className="autopilot-error" role="alert">{error}</p>}
    {conflict && <p className="autopilot-error" role="alert">Политика запуска изменилась в другой вкладке. Черновик запасных моделей сохранён.
      <button type="button" className="quiet-button" disabled={saving} onClick={async () => {
        const previousDraft = draft;
        await load(true);
        setDraft(previousDraft);
      }}>Перечитать политику, сохранив черновик</button>
    </p>}
    {saved && <p className="settings-saved" role="status">Список запасных моделей сохранён.</p>}
    <div className="settings-save-row"><span>{document && !saved ? "Изменения применятся к следующим запускам." : ""}</span>
      <button type="button" className="primary-button" disabled={saving || loading || Boolean(fallbackModelsSaveIssue(draft)) || !document}
        onClick={() => void save()}>{saving ? "Сохраняем…" : "Сохранить запасные модели"}</button></div>
  </section>;
}
