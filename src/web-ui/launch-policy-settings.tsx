import * as React from "react";

export type LaunchPolicy = {
  version: 1;
  allowedHarnesses: string[];
  preferredHarness: string;
  models: Record<string, string>;
};

export type LaunchRuntimeOption = { id: string; name: string; active: boolean };

export const DEFAULT_LAUNCH_POLICY: LaunchPolicy = {
  version: 1,
  allowedHarnesses: ["codex", "zcode"],
  preferredHarness: "codex",
  models: {
    codex: "gpt-5.6-sol",
    zcode: "account:zai-individual-coding-plan/GLM-5.3-Flash$high",
  },
};

const FALLBACK_LABELS: Record<string, string> = {
  codex: "Codex",
  zcode: "ZCode",
  opencode: "OpenCode",
  claude: "Claude Code",
  qoder: "Qoder",
  hermes: "Hermes",
  "fast-agent": "Fast Agent",
  chatgpt: "ChatGPT",
};

export function updateAllowedHarness(policy: LaunchPolicy, harness: string, allowed: boolean): LaunchPolicy {
  const allowedHarnesses = allowed
    ? [...new Set([...policy.allowedHarnesses, harness])]
    : policy.allowedHarnesses.filter((item) => item !== harness);
  const preferredHarness = allowedHarnesses.length === 0
    ? policy.preferredHarness
    : allowedHarnesses.includes(policy.preferredHarness) ? policy.preferredHarness : allowedHarnesses[0]!;
  return { ...policy, allowedHarnesses, preferredHarness };
}

export function updatePreferredHarness(policy: LaunchPolicy, harness: string): LaunchPolicy {
  return policy.allowedHarnesses.includes(harness) ? { ...policy, preferredHarness: harness } : policy;
}

function parseLaunchPolicy(value: unknown): LaunchPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ответ настроек запуска имеет неверный формат");
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || !Array.isArray(candidate.allowedHarnesses)
    || !candidate.allowedHarnesses.every((item) => typeof item === "string")
    || typeof candidate.preferredHarness !== "string"
    || !candidate.models || typeof candidate.models !== "object" || Array.isArray(candidate.models)
    || Object.values(candidate.models as Record<string, unknown>).some((model) => typeof model !== "string")) {
    throw new Error("Ответ настроек запуска имеет неверный формат");
  }
  const models = candidate.models as Record<string, string>;
  const policy = {
    version: 1 as const,
    allowedHarnesses: [...new Set(candidate.allowedHarnesses as string[])],
    preferredHarness: candidate.preferredHarness,
    models,
  };
  if (policy.allowedHarnesses.length > 0 && !policy.allowedHarnesses.includes(policy.preferredHarness)) {
    throw new Error("Основная среда должна входить в разрешённые варианты");
  }
  return policy;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  });
  if (!response.ok) throw new Error(String(response.status));
  return response.json() as Promise<T>;
}

function errorForPerson(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.match(/^(\d{3})/)?.[1];
  if (status === "503") return "Сервис настроек запуска временно недоступен.";
  if (status === "400") return "Сервер не принял настройки. Проверьте выбранные среды и модели.";
  if (status) return `Не удалось выполнить запрос к серверу (код ${status}).`;
  if (/формат|среда|разрешён/i.test(message)) return message;
  return "Не удалось связаться с сервером настроек. Проверьте соединение и повторите попытку.";
}

function labelFor(harness: string, runtimes: LaunchRuntimeOption[]): string {
  return runtimes.find((runtime) => runtime.id === harness)?.name ?? FALLBACK_LABELS[harness] ?? harness;
}

function inputId(harness: string): string {
  return `launch-model-${harness.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

export function LaunchPolicySettings() {
  const [policy, setPolicy] = React.useState<LaunchPolicy>(DEFAULT_LAUNCH_POLICY);
  const [runtimes, setRuntimes] = React.useState<LaunchRuntimeOption[]>([]);
  const [modelOptions, setModelOptions] = React.useState<Record<string, string[]>>({});
  const [loading, setLoading] = React.useState(true);
  const [needsSetup, setNeedsSetup] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string>();
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string>();

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      const [policyResult, runtimeResult] = await Promise.allSettled([
        requestJson<unknown>("/api/automation/launch-policy"),
        requestJson<{ adapters?: Array<{ id: string; name: string; active: boolean }> }>("/api/adapters"),
      ]);
      if (cancelled) return;
      if (policyResult.status === "fulfilled") {
        try {
          setPolicy(parseLaunchPolicy(policyResult.value));
          setNeedsSetup(false);
          setLoadError(undefined);
        } catch (error) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      } else {
        const error = policyResult.reason instanceof Error ? policyResult.reason.message : String(policyResult.reason);
        if (error.startsWith("503")) {
          setPolicy(DEFAULT_LAUNCH_POLICY);
          setNeedsSetup(true);
          setLoadError(undefined);
      } else setLoadError(errorForPerson(error));
      }
      const active = runtimeResult.status === "fulfilled"
        ? (runtimeResult.value.adapters ?? []).filter((item) => item.active).map(({ id, name, active: isActive }) => ({ id, name, active: isActive }))
        : [];
      setRuntimes(active);
      setLoading(false);
    };
    void load();
    return () => { cancelled = true; };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const results = await Promise.all(runtimes.map(async ({ id }) => {
        try {
          const result = await requestJson<{ models?: string[] }>(`/api/models?harness=${encodeURIComponent(id)}`);
          return [id, result.models ?? []] as const;
        } catch { return [id, []] as const; }
      }));
      if (!cancelled) setModelOptions(Object.fromEntries(results));
    };
    if (runtimes.length > 0) void load();
    return () => { cancelled = true; };
  }, [runtimes]);

  const known = new Map(runtimes.map((runtime) => [runtime.id, runtime]));
  const displayedHarnesses = [...new Set([
    ...runtimes.map(({ id }) => id),
    ...policy.allowedHarnesses,
    policy.preferredHarness,
  ])];
  const optionsForSelect = policy.allowedHarnesses.length > 0 ? policy.allowedHarnesses : displayedHarnesses;
  const valid = (policy.allowedHarnesses.length === 0 || policy.allowedHarnesses.includes(policy.preferredHarness))
    && policy.preferredHarness.length > 0
    && policy.allowedHarnesses.every((harness) => {
      const model = policy.models[harness];
      return Boolean(model?.trim()) && model.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(model);
    });

  const save = async () => {
    if (!valid || saving || loading || Boolean(loadError)) return;
    setSaving(true);
    setSaved(false);
    setSaveError(undefined);
    try {
      const savedPolicy = parseLaunchPolicy(await requestJson<unknown>("/api/automation/launch-policy", {
        method: "PUT",
        body: JSON.stringify(policy),
      }));
      setPolicy(savedPolicy);
      setNeedsSetup(false);
      setSaved(true);
    } catch (error) {
      setSaveError(errorForPerson(error));
    } finally { setSaving(false); }
  };

  return <section className="global-autopilot-card launch-policy-settings" aria-label="Запуск новых сессий">
    <div className="global-autopilot-head">
      <div><span className="eyebrow">НОВЫЕ СЕССИИ</span><h3>Запуск новых сессий</h3><p>Выберите, где Herder может автоматически создавать новые сессии и какой вариант предпочитать. Это не меняет текущие сессии и автопродолжение.</p></div>
    </div>
    {loading ? <p className="settings-loading" role="status">Загружаем настройки запуска…</p> : <>
      {needsSetup && <p className="launch-policy-notice" role="status">Настройки запуска ещё не сохранены. До сохранения автоматический запуск новых сессий запрещён.</p>}
      {loadError && <p className="autopilot-error" role="alert">Не удалось загрузить настройки запуска: {loadError}. Обновите страницу и повторите.</p>}
      <fieldset className="settings-group" disabled={saving || Boolean(loadError)}>
        <legend>Разрешённые среды</legend>
        {displayedHarnesses.length === 0
          ? <p className="settings-help">Нет доступных сред запуска.</p>
          : <div className="launch-runtime-list">{displayedHarnesses.map((harness) => <label className="launch-runtime-option" key={harness}>
            <span><strong>{labelFor(harness, [...known.values()])}</strong></span>
            <input type="checkbox" checked={policy.allowedHarnesses.includes(harness)} onChange={(event) => {
              setPolicy((current) => updateAllowedHarness(current, harness, event.target.checked));
              setSaved(false);
            }} />
          </label>)}</div>}
        {policy.allowedHarnesses.length > 0 && <label className="launch-policy-field"><span>Основная среда</span><select value={policy.preferredHarness} onChange={(event) => {
          setPolicy((current) => updatePreferredHarness(current, event.target.value));
          setSaved(false);
        }}>{optionsForSelect.map((harness) => <option value={harness} key={harness}>{labelFor(harness, [...known.values()])}</option>)}</select></label>}
        {policy.allowedHarnesses.map((harness) => <label className="launch-policy-field" key={harness}>
          <span>Модель · {labelFor(harness, [...known.values()])}</span>
          <input type="text" maxLength={256} list={inputId(harness)} value={policy.models[harness] ?? ""} placeholder="Укажите модель" onChange={(event) => {
            setPolicy((current) => ({ ...current, models: { ...current.models, [harness]: event.target.value } }));
            setSaved(false);
          }} />
          <datalist id={inputId(harness)}>{(modelOptions[harness] ?? []).map((model) => <option value={model} key={model} />)}</datalist>
        </label>)}
        {policy.allowedHarnesses.length === 0 && <p className="settings-help">Автоматический запуск новых сессий отключён. Основной вариант сохранён и будет доступен после выбора разрешённой среды.</p>}
      </fieldset>
      {saveError && <p className="autopilot-error" role="alert">Не удалось сохранить настройки: {saveError}</p>}
      <div className="settings-save-row"><span>{saved ? <span className="settings-saved" role="status">Настройки сохранены</span> : needsSetup ? "Сохраните выбор, чтобы разрешить создание сессий." : "Изменения применятся только к новым сессиям."}</span>
        <button className="primary-button" disabled={!valid || saving || loading || Boolean(loadError)} onClick={() => void save()}>{saving ? "Сохраняем…" : "Сохранить"}</button></div>
    </>}
  </section>;
}
