import { INCIDENT_EXECUTION, normalizeIncidentExecution, type HealthExecutionProfile } from "../health-remediation.js";
import * as React from "react";

export type ProjectLaunchRoute = {
  harnesses: string[];
  models?: Record<string, string>;
  /** Real card project identifiers that resolve to this route. */
  aliases?: string[];
};

export type LaunchPolicy = {
  version: 1;
  allowedHarnesses: string[];
  preferredHarness: string;
  models: Record<string, string>;
  incidentExecution?: HealthExecutionProfile;
  projectRoutes?: Record<string, ProjectLaunchRoute>;
};

export type LaunchRuntimeOption = { id: string; name: string; active: boolean };

export const DEFAULT_LAUNCH_POLICY: LaunchPolicy = {
  version: 1,
  allowedHarnesses: ["codex", "zcode"],
  preferredHarness: "codex",
  models: {
    codex: "gpt-6.1-sol",
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

export function normalizeProjectKey(project: string): string {
  return project.trim().replace(/\/+$/, "");
}

export function updateProjectRoute(
  policy: LaunchPolicy,
  project: string,
  update: (route: ProjectLaunchRoute) => ProjectLaunchRoute,
): LaunchPolicy {
  const key = normalizeProjectKey(project);
  const routes = { ...(policy.projectRoutes ?? {}) };
  if (key.length === 0 || !routes[key]) return { ...policy, projectRoutes: routes };
  routes[key] = update(routes[key]);
  return { ...policy, projectRoutes: routes };
}

export function moveProjectRouteHarness(route: ProjectLaunchRoute, harness: string, offset: -1 | 1): ProjectLaunchRoute {
  const index = route.harnesses.indexOf(harness);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= route.harnesses.length) return route;
  const harnesses = [...route.harnesses];
  [harnesses[index], harnesses[target]] = [harnesses[target]!, harnesses[index]!];
  return { ...route, harnesses };
}

export function updateProjectRouteModel(route: ProjectLaunchRoute, harness: string, model: string): ProjectLaunchRoute {
  const models = { ...(route.models ?? {}) };
  if (model.trim()) models[harness] = model;
  else delete models[harness];
  return { ...route, models };
}

export function removeProjectRouteHarness(route: ProjectLaunchRoute, harness: string): ProjectLaunchRoute {
  const updated = updateProjectRouteModel(route, harness, "");
  return { ...updated, harnesses: route.harnesses.filter((item) => item !== harness) };
}

export function parseProjectRoutes(value: unknown): Record<string, ProjectLaunchRoute> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Маршруты проектов должны быть объектом");
  const routes: Record<string, ProjectLaunchRoute> = {};
  for (const [project, raw] of Object.entries(value as Record<string, unknown>)) {
    const key = normalizeProjectKey(project);
    if (!key.startsWith("/")) throw new Error(`Маршрут проекта «${project}» должен быть абсолютным путём`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Маршрут проекта «${project}» имеет неверный формат`);
    const route = raw as { harnesses?: unknown; models?: unknown };
    if (!Array.isArray(route.harnesses) || route.harnesses.length === 0
      || !route.harnesses.every((item) => typeof item === "string" && item.length > 0)) {
      throw new Error(`Маршрут проекта «${project}» должен содержать среды`);
    }
    const aliases = Array.isArray((route as { aliases?: unknown }).aliases)
      ? [...new Set((route as { aliases: string[] }).aliases
        .filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0)
        .map((alias) => alias.trim()))]
      : undefined;
    const models: Record<string, string> | undefined = route.models && typeof route.models === "object" && !Array.isArray(route.models)
      ? Object.fromEntries(Object.entries(route.models as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0 && entry[1].length <= 256))
      : undefined;
    routes[key] = {
      harnesses: [...new Set(route.harnesses as string[])],
      ...(models && Object.keys(models).length > 0 ? { models } : {}),
      ...(aliases && aliases.length > 0 ? { aliases } : {}),
    };
  }
  return routes;
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
    ...(candidate.incidentExecution === undefined ? {} : { incidentExecution: normalizeIncidentExecution(candidate.incidentExecution) }),
    ...(candidate.projectRoutes === undefined ? {} : { projectRoutes: parseProjectRoutes(candidate.projectRoutes) }),
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
  const label = runtimes.find((runtime) => runtime.id === harness)?.name ?? FALLBACK_LABELS[harness];
  if (label) return label;
  const humanized = harness.replace(/[-_]+/g, " ").trim();
  return humanized ? humanized[0]!.toUpperCase() + humanized.slice(1) : harness;
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
  const [newProject, setNewProject] = React.useState("");
  const [newProjectHarnesses, setNewProjectHarnesses] = React.useState<string[]>([]);

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
  const projectRoutes = Object.entries(policy.projectRoutes ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const routesValid = projectRoutes.every(([project, route]) =>
    project.startsWith("/") && route.harnesses.length > 0
    && route.harnesses.every((harness) => policy.allowedHarnesses.length === 0 || policy.allowedHarnesses.includes(harness))
    && route.harnesses.every((harness) => {
      const model = route.models?.[harness] ?? policy.models[harness];
      return Boolean(model?.trim()) && model.length <= 256;
    }));
  const valid = routesValid
    && (policy.allowedHarnesses.length === 0 || policy.allowedHarnesses.includes(policy.preferredHarness))
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
      <div><span className="eyebrow">НОВЫЕ СЕССИИ</span><h3>Запуск новых сессий</h3><p>Выберите, где Herder может создавать новые сессии и какая среда основная. Текущие сессии и автопродолжение это не затрагивает.</p></div>
    </div>
    {loading ? <p className="settings-loading" role="status">Загружаем настройки запуска…</p> : <>
      {needsSetup && <p className="launch-policy-notice" role="status">Настройки запуска ещё не сохранены. До сохранения автоматический запуск новых сессий запрещён.</p>}
      {loadError && <p className="autopilot-error" role="alert">Не удалось загрузить настройки запуска: {loadError}. Обновите страницу и повторите.</p>}
      <details className="settings-advanced"><summary>Дополнительно: автоматическое исправление инцидентов</summary>
      <fieldset className="settings-group" disabled={saving || Boolean(loadError)}>
        <legend>Диагностика и исправление инцидентов Noticeplace</legend>
        <p>MiniMax по подписке. Этот выбор сохраняется отдельно для новых расследований и исправлений. Разрешённые среды ниже относятся к обычным задачам; маршрут инцидентов использует свой выбор.</p>
        <label className="launch-policy-field"><span>Среда исполнения инцидентов</span>
          <select aria-label="Среда исполнения инцидентов" value={policy.incidentExecution?.runtime ?? ""} onChange={() => {
            setPolicy((current) => ({ ...current, incidentExecution: { ...INCIDENT_EXECUTION } })); setSaved(false);
          }}><option value="" disabled>Выберите среду</option><option value="opencode">OpenCode · MiniMax по подписке</option></select>
        </label>
        <label className="launch-policy-field"><span>Модель для инцидентов · MiniMax по подписке</span>
          <select aria-label="Модель для инцидентов" value={policy.incidentExecution ? `${policy.incidentExecution.provider}/${policy.incidentExecution.model}` : ""}
            onChange={() => { setPolicy((current) => ({ ...current, incidentExecution: { ...INCIDENT_EXECUTION } })); setSaved(false); }}>
            <option value="" disabled>Выберите доступную модель</option>
            <option value="minimax-coding-plan/MiniMax-M3.1-Flash" disabled={!(modelOptions.opencode ?? []).includes("minimax-coding-plan/MiniMax-M3.1-Flash")}>
              {`MiniMax-M3.1-Flash · MiniMax по подписке${(modelOptions.opencode ?? []).includes("minimax-coding-plan/MiniMax-M3.1-Flash") ? "" : " · доступность не подтверждена"}`}
            </option>
          </select>
        </label>
        <p className="settings-help" role="status">Модель: MiniMax-M3.1-Flash · {(modelOptions.opencode ?? []).includes("minimax-coding-plan/MiniMax-M3.1-Flash") ? "есть в списке OpenCode" : "доступность не подтверждена"}.</p>
        <small>Провайдер: minimax-coding-plan. При отказе запуск сохраняет причину и не меняет провайдера.</small>
        {!policy.incidentExecution && <p role="status">Маршрут инцидентов ещё не сохранён.</p>}
        {policy.incidentExecution && !(modelOptions.opencode ?? []).includes("minimax-coding-plan/MiniMax-M3.1-Flash") &&
          <p role="alert">Подписочная модель пока не подтверждена OpenCode. Запуск будет отклонён без смены провайдера.</p>}
      </fieldset>
      </details>
      <fieldset className="settings-group" disabled={saving || Boolean(loadError)}>
        <legend>Разрешённые среды</legend>
        {displayedHarnesses.length === 0
          ? <p className="settings-help">Нет доступных сред запуска.</p>
          : <div className="launch-runtime-list">{displayedHarnesses.map((harness) => {
            const harnessLabel = labelFor(harness, [...known.values()]);
            const allowed = policy.allowedHarnesses.includes(harness);
            return <label className="launch-runtime-option" key={harness} title={harness === harnessLabel ? undefined : harness}>
              <span>
                <strong>{harnessLabel}</strong>
                <small aria-hidden="true">{allowed ? "вкл" : "выкл"}</small>
              </span>
              <input type="checkbox" checked={allowed} aria-label={`${harnessLabel}: ${allowed ? "вкл" : "выкл"}`} onChange={(event) => {
              setPolicy((current) => updateAllowedHarness(current, harness, event.target.checked));
              setSaved(false);
            }} />
            </label>;
          })}</div>}
        {policy.allowedHarnesses.length > 0 && <label className="launch-policy-field"><span>Основная среда</span><select value={policy.preferredHarness} aria-label="Основная среда запуска" onChange={(event) => {
          setPolicy((current) => updatePreferredHarness(current, event.target.value));
          setSaved(false);
        }}>{optionsForSelect.map((harness) => <option value={harness} key={harness}>{labelFor(harness, [...known.values()])}</option>)}</select></label>}
        {policy.allowedHarnesses.map((harness) => <label className="launch-policy-field" key={harness}>
          <span>Модель · {labelFor(harness, [...known.values()])}</span>
          <input type="text" maxLength={256} list={inputId(harness)} value={policy.models[harness] ?? ""} placeholder="Укажите модель" aria-label={`Модель для среды ${labelFor(harness, [...known.values()])}`} onChange={(event) => {
            setPolicy((current) => ({ ...current, models: { ...current.models, [harness]: event.target.value } }));
            setSaved(false);
          }} />
          <datalist id={inputId(harness)}>{(modelOptions[harness] ?? []).map((model) => <option value={model} key={model} />)}</datalist>
        </label>)}
        {policy.allowedHarnesses.length === 0 && <p className="settings-help">Автоматический запуск новых сессий отключён. Основной вариант сохранён и будет доступен после выбора разрешённой среды.</p>}
      </fieldset>
      <fieldset className="settings-group" disabled={saving || Boolean(loadError)}>
        <legend>Порядок сред для проектов</legend>
        <p>Для явно настроенного проекта Herder идёт по списку сверху вниз и переключается только после отказа, когда запуск точно не состоялся. Проекты без маршрута работают как раньше.</p>
        {projectRoutes.length === 0
          ? <p className="settings-help">Маршруты проектов не настроены. Для всех проектов используется основная среда.</p>
          : <div className="launch-runtime-list">{projectRoutes.map(([project, route]) => <div className="launch-runtime-option" key={project}>
            <span>
              <strong>{project}</strong>
              <small aria-hidden="true">
                {route.harnesses.map((harness) => labelFor(harness, [...known.values()])).join(" → ")}
                {route.aliases?.length ? ` · карточки: ${route.aliases.join(", ")}` : ""}
              </small>
            </span>
            <button type="button" aria-label={`Удалить маршрут проекта ${project}`} onClick={() => {
              setPolicy((current) => {
                const routes = { ...(current.projectRoutes ?? {}) };
                delete routes[project];
                return { ...current, projectRoutes: routes };
              });
              setSaved(false);
            }}>Удалить</button>
          </div>)}</div>}
        {projectRoutes.map(([project, route]) => <div key={`${project}-harnesses`}>
          <p className="settings-help">{project}</p>
          <div className="launch-runtime-list">{route.harnesses.map((harness, index) => <div className="launch-runtime-option" key={harness}>
            <span>
              <strong>{index + 1}. {labelFor(harness, [...known.values()])}</strong>
              <small aria-hidden="true">{route.models?.[harness] ?? policy.models[harness] ?? "модель не задана"}</small>
            </span>
            <span>
              <button type="button" aria-label={`Поднять ${labelFor(harness, [...known.values()])} выше в маршруте ${project}`} disabled={index === 0}
                onClick={() => { setPolicy((current) => updateProjectRoute(current, project, (value) => moveProjectRouteHarness(value, harness, -1))); setSaved(false); }}>↑</button>
              <button type="button" aria-label={`Опустить ${labelFor(harness, [...known.values()])} ниже в маршруте ${project}`} disabled={index === route.harnesses.length - 1}
                onClick={() => { setPolicy((current) => updateProjectRoute(current, project, (value) => moveProjectRouteHarness(value, harness, 1))); setSaved(false); }}>↓</button>
              <button type="button" aria-label={`Убрать ${labelFor(harness, [...known.values()])} из маршрута ${project}`}
                onClick={() => { setPolicy((current) => updateProjectRoute(current, project, (value) => removeProjectRouteHarness(value, harness))); setSaved(false); }}>Убрать</button>
            </span>
          </div>)}</div>
          <label className="launch-policy-field">
            <span>Идентификаторы карточек · {project}</span>
            <input type="text" value={(route.aliases ?? []).join(", ")} placeholder="tg-commentator, autotelegramviews"
              aria-label={`Идентификаторы карточек проекта ${project}`} onChange={(event) => {
                const aliases = event.target.value.split(",").map((alias) => alias.trim()).filter(Boolean);
                setPolicy((current) => updateProjectRoute(current, project, (value) => (aliases.length > 0 ? { ...value, aliases } : { ...value, aliases: undefined })));
                setSaved(false);
              }} />
            <small>Через запятую. Карточка приходит с таким идентификатором, а не с путём к папке.</small>
          </label>
          {route.harnesses.map((harness) => <label className="launch-policy-field" key={`${project}-${harness}`}>
            <span>Модель маршрута · {project} · {labelFor(harness, [...known.values()])}</span>
            <input type="text" maxLength={256} list={inputId(`route-${harness}`)} value={route.models?.[harness] ?? ""}
              placeholder={policy.models[harness] ?? "Укажите модель"} aria-label={`Модель маршрута для ${project} и среды ${labelFor(harness, [...known.values()])}`} onChange={(event) => {
                setPolicy((current) => updateProjectRoute(current, project, (value) => updateProjectRouteModel(value, harness, event.target.value)));
                setSaved(false);
              }} />
            <datalist id={inputId(`route-${harness}`)}>{(modelOptions[harness] ?? []).map((model) => <option value={model} key={model} />)}</datalist>
            <small>Пустое поле использует общую модель среды {labelFor(harness, [...known.values()])}.</small>
          </label>)}
        </div>)}
        <label className="launch-policy-field"><span>Новый проект</span>
          <input type="text" value={newProject} placeholder="/home/user/project" aria-label="Абсолютный путь проекта для маршрута" onChange={(event) => setNewProject(event.target.value)} />
        </label>
        <div className="launch-runtime-list">{optionsForSelect.map((harness) => {
          const label = labelFor(harness, [...known.values()]);
          const selected = newProjectHarnesses.includes(harness);
          return <label className="launch-runtime-option" key={`add-${harness}`}>
            <span><strong>{label}</strong><small aria-hidden="true">{selected ? `позиция ${newProjectHarnesses.indexOf(harness) + 1}` : "не в маршруте"}</small></span>
            <input type="checkbox" checked={selected} aria-label={`Добавить ${label} в маршрут нового проекта`} onChange={(event) => {
              setNewProjectHarnesses((current) => event.target.checked
                ? [...current, harness].slice(-4)
                : current.filter((item) => item !== harness));
            }} />
          </label>;
        })}</div>
        <button type="button" aria-label="Добавить маршрут проекта" disabled={!normalizeProjectKey(newProject).startsWith("/") || newProjectHarnesses.length === 0}
          onClick={() => {
            const key = normalizeProjectKey(newProject);
            if (!key.startsWith("/") || newProjectHarnesses.length === 0) return;
            setPolicy((current) => ({ ...current, projectRoutes: { ...(current.projectRoutes ?? {}), [key]: { harnesses: [...newProjectHarnesses] } } }));
            setNewProject("");
            setNewProjectHarnesses([]);
            setSaved(false);
          }}>Добавить маршрут</button>
        {policy.allowedHarnesses.length === 0 && projectRoutes.length > 0 && <p className="settings-help">Маршруты используют только разрешённые среды. Пока выбор пуст, они не применяются.</p>}
      </fieldset>
      {saveError && <p className="autopilot-error" role="alert">Не удалось сохранить настройки: {saveError}</p>}
      <div className="settings-save-row"><span>{saved ? <span className="settings-saved" role="status">Настройки сохранены</span> : needsSetup ? "Сохраните выбор, чтобы разрешить создание сессий." : "Изменения применятся только к новым сессиям."}</span>
        <button className="primary-button" aria-label="Сохранить настройки запуска" disabled={!valid || saving || loading || Boolean(loadError)} onClick={() => void save()}>{saving ? "Сохраняем…" : "Сохранить"}</button></div>
    </>}
  </section>;
}
