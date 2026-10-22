import * as React from "react";
import {
  labelFor,
  mergeProjectRouteParts,
  moveProjectRouteHarness,
  normalizeProjectKey,
  removeProjectRouteHarness,
  removeProjectRouteModelList,
  routeInputId,
  sameProjectRoute,
  updateProjectRouteModel,
  updateProjectRouteModelList,
  useHarnessModelCatalog,
  useLaunchPolicyDraft,
  useRuntimeModels,
  type LaunchPolicy,
  type LaunchRuntimeOption,
  type PolicyMergeContext,
  type PolicyMergeResult,
  type ProjectLaunchRoute,
} from "./launch-policy-settings.js";
import { conflictingModelEntries, routeModelViolation } from "../project-model-gate.js";

/**
 * The working directories of the live sessions, as known project paths.
 *
 * The list only helps the operator pick a path; the path field stays editable
 * by hand for a project that has no live session yet.
 */
export function useKnownProjectPaths() {
  const [paths, setPaths] = React.useState<string[]>([]);
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/sessions?quick=1");
        if (!response.ok) throw new Error("sessions unavailable");
        const result = await response.json() as { sessions?: Array<{ cwd?: string }> };
        if (cancelled) return;
        const directories = (result.sessions ?? [])
          .map((session) => session.cwd)
          .filter((cwd): cwd is string => typeof cwd === "string" && cwd.trim().length > 0)
          .map((cwd) => cwd.trim().replace(/\/+$/, ""));
        setPaths([...new Set(directories)].sort((left, right) => left.localeCompare(right)));
      } catch {
        if (!cancelled) setPaths([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  return paths;
}

/**
 * Merge the edited project routes into a newer document.
 *
 * Only the parts the operator changed are carried over. The merge is per part:
 * an edit of the model lists of a project does not overwrite a route change
 * that happened elsewhere at the same time, and the other way round. A part
 * both sides changed is a real conflict: the server value survives, the
 * operator's draft stays in the form, and the project is reported.
 */
export function mergeProjectRoutes({ base, fresh, draft, kept }: PolicyMergeContext): PolicyMergeResult {
  const baseRoutes = base.projectRoutes ?? {};
  const freshRoutes = fresh.projectRoutes ?? {};
  const draftRoutes = draft.projectRoutes ?? {};
  const merged: Record<string, ProjectLaunchRoute> = { ...freshRoutes };
  const nextKept: Record<string, ProjectLaunchRoute | undefined> = {};
  const conflicts: string[] = [];

  const keys = new Set([...Object.keys(baseRoutes), ...Object.keys(draftRoutes)]);
  for (const key of keys) {
    const baseValue = baseRoutes[key];
    const draftValue = draftRoutes[key];
    if (sameProjectRoute(baseValue, draftValue)) continue;
    const frozen = kept[key];
    if (key in kept && sameProjectRoute(frozen, draftValue)) {
      // The operator already lost this project once and has not re-edited it.
      conflicts.push(key);
      nextKept[key] = draftValue;
      continue;
    }
    const freshValue = freshRoutes[key];
    if (draftValue === undefined) {
      // The operator removed the project.
      if (sameProjectRoute(baseValue, freshValue)) {
        delete merged[key];
        continue;
      }
      conflicts.push(key);
      nextKept[key] = draftValue;
      continue;
    }
    if (baseValue === undefined) {
      // The operator added the project.
      if (freshValue === undefined) {
        merged[key] = draftValue;
        continue;
      }
      conflicts.push(key);
      nextKept[key] = draftValue;
      continue;
    }
    const result = mergeProjectRouteParts(baseValue, freshValue, draftValue);
    if (result.route === undefined) delete merged[key];
    else merged[key] = result.route;
    if (result.conflict) {
      conflicts.push(key);
      nextKept[key] = draftValue;
    }
  }
  return { merged: { ...fresh, projectRoutes: merged }, conflicts, kept: nextKept };
}

/**
 * One model list of a project: the allowed or the denied models.
 *
 * The list is filled from the model catalog of the harnesses of the route and
 * accepts any model id by hand, so a model that is not in the catalog can be
 * named as well.
 */
function ProjectModelList({
  project,
  route,
  field,
  title,
  hint,
  suggestions,
  disabled,
  onChange,
}: {
  project: string;
  route: ProjectLaunchRoute;
  field: "allowedModels" | "deniedModels";
  title: string;
  hint: string;
  suggestions: string[];
  disabled?: boolean;
  onChange: (next: ProjectLaunchRoute) => void;
}) {
  const [value, setValue] = React.useState("");
  const models = route[field] ?? [];
  const listId = `projects-${field}-${project}`.replace(/[^a-zA-Z0-9_-]/g, "-");
  const add = () => {
    const model = value.trim();
    if (!model) return;
    onChange(updateProjectRouteModelList(route, field, model));
    setValue("");
  };
  return <div className="projects-field">
    <span className="projects-field-label">{title}</span>
    <ul className="projects-model-list" aria-label={`${title} для проекта ${project}`}>
      {models.length === 0
        ? <li className="projects-help" aria-hidden="true">Список пуст</li>
        : models.map((model) => <li className="projects-model-item" key={model}>
          <code>{model}</code>
          <button type="button" aria-label={`Убрать модель ${model} из списка «${title}» проекта ${project}`}
            disabled={disabled} onClick={() => onChange(removeProjectRouteModelList(route, field, model))}>Убрать</button>
        </li>)}
    </ul>
    <div className="projects-model-add">
      <label htmlFor={listId}>{`${title} · добавить модель`}</label>
      <input id={listId} type="text" list={`${listId}-options`} value={value} maxLength={256}
        placeholder="model id" aria-label={`${title} для проекта ${project}: добавить модель`}
        disabled={disabled} onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }} />
      <datalist id={`${listId}-options`}>{suggestions.map((model) => <option value={model} key={model} />)}</datalist>
      <button type="button" aria-label={`Добавить модель в список «${title}» проекта ${project}`}
        disabled={disabled || !value.trim()} onClick={add}>Добавить</button>
    </div>
    <small className="projects-help">{hint}</small>
  </div>;
}

/**
 * The per-project model policy of one route.
 *
 * The empty allowed list means no restriction at all. A model that is denied
 * is never used in the project, even when it is the effective model of a
 * harness of the route: that harness simply stops being used.
 */
export function ProjectModelPolicyEditor({
  project,
  route,
  policy,
  runtimes,
  modelOptions,
  disabled,
  onChange,
}: {
  project: string;
  route: ProjectLaunchRoute;
  policy: LaunchPolicy;
  runtimes: LaunchRuntimeOption[];
  modelOptions: Record<string, string[]>;
  disabled?: boolean;
  onChange: (next: ProjectLaunchRoute) => void;
}) {
  const catalog = useHarnessModelCatalog(route.harnesses);
  const suggestions = [...new Set(route.harnesses.flatMap((harness) => [
    ...(catalog[harness] ?? []),
    ...(modelOptions[harness] ?? []),
  ]))].sort((left, right) => left.localeCompare(right));
  const allowedModels = route.allowedModels ?? [];
  const deniedModels = route.deniedModels ?? [];
  const conflicts = conflictingModelEntries(allowedModels, deniedModels);

  return <fieldset className="projects-fieldset" disabled={disabled}>
    <legend>Модели проекта</legend>
    <p className="projects-help">Здесь задаётся, какие модели этому проекту разрешены, а какие запрещены. Пустой список разрешённых означает «без ограничений»: работает общая политика модели среды. Запрет всегда сильнее разрешения: запрещённая модель в этом проекте не запускается никогда.</p>
    <ProjectModelList project={project} route={route} field="allowedModels" title="Разрешённые модели"
      hint="Список разрешённых моделей. Пустой список — без ограничений, действует общая модель среды. Можно указать шаблон через «*», например omniroute/minimax-*."
      suggestions={suggestions} disabled={disabled} onChange={onChange} />
    <ProjectModelList project={project} route={route} field="deniedModels" title="Запрещённые модели"
      hint="Список запрещённых моделей. Модель из этого списка не используется в проекте, даже если она указана в разрешённых или является общей моделью среды."
      suggestions={suggestions} disabled={disabled} onChange={onChange} />
    {conflicts.length > 0 && <p className="autopilot-error" role="alert">{`Модель «${conflicts[0]}» указана и как разрешённая, и как запрещённая. Уберите её из одного из списков, иначе политика не сохранится.`}</p>}
    <div className="projects-field">
      <span className="projects-field-label">Эффективная модель по средам маршрута</span>
      <ul className="projects-model-list" aria-label={`Эффективная модель по средам маршрута проекта ${project}`}>
        {route.harnesses.map((harness) => {
          const effective = route.models?.[harness] ?? policy.models[harness];
          const violation = routeModelViolation(route, effective);
          return <li className={`projects-model-item${violation ? " projects-model-item-warn" : ""}`} key={harness}>
            <span>
              <strong>{labelFor(harness, runtimes)}</strong>
              <code aria-hidden="true">{effective || "модель не задана"}</code>
            </span>
            {violation === "denied" && <span className="projects-model-warn" role="status">Модель запрещена в этом проекте: среда перестанет использоваться.</span>}
            {violation === "not_allowed" && <span className="projects-model-warn" role="status">Модель не разрешена в этом проекте: среда перестанет использоваться.</span>}
          </li>;
        })}
        {route.harnesses.length === 0 && <li className="projects-help" aria-hidden="true">В маршруте нет ни одной среды.</li>}
      </ul>
    </div>
  </fieldset>;
}

/** One project route: the ordered harnesses, the model of each and the card ids. */
export function ProjectRoutesEditor({
  project,
  route,
  policy,
  runtimes,
  modelOptions,
  disabled,
  onChange,
  onRemove,
}: {
  project: string;
  route: ProjectLaunchRoute;
  policy: LaunchPolicy;
  runtimes: LaunchRuntimeOption[];
  modelOptions: Record<string, string[]>;
  disabled?: boolean;
  onChange: (next: ProjectLaunchRoute) => void;
  onRemove: () => void;
}) {
  const allowed = policy.allowedHarnesses;
  const available = allowed.length > 0
    ? allowed
    : [...new Set([...runtimes.map(({ id }) => id), ...route.harnesses])];
  const addable = available.filter((harness) => !route.harnesses.includes(harness));
  return <article className="projects-card" aria-label={`Маршрут проекта ${project}`}>
    <header className="projects-card-head">
      <div>
        <h2 className="projects-card-title">{project}</h2>
        <small className="projects-card-hint">Папка проекта на этой машине. Карточка приходит с идентификатором, а не с путём.</small>
      </div>
      <button type="button" className="quiet-button" aria-label={`Удалить маршрут проекта ${project}`} disabled={disabled} onClick={onRemove}>Удалить маршрут</button>
    </header>
    <fieldset className="projects-fieldset" disabled={disabled}>
      <legend>Порядок сред</legend>
      <p className="projects-help">Herder идёт по списку сверху вниз и переключается на следующую среду только после отказа, когда запуск точно не состоялся. Проекты без маршрута работают как раньше.</p>
      {route.harnesses.length === 0
        ? <p className="projects-help" role="status">В маршруте нет ни одной среды. Добавьте хотя бы одну, иначе маршрут не сохранится.</p>
        : <ol className="projects-order" aria-label={`Порядок сред для проекта ${project}`}>
          {route.harnesses.map((harness, index) => <li className="projects-order-item" key={harness}>
            <span className="projects-order-name">
              <strong>{index + 1}. {labelFor(harness, runtimes)}</strong>
              <small aria-hidden="true">{route.models?.[harness] ?? policy.models[harness] ?? "модель не задана"}</small>
            </span>
            <span className="projects-order-actions">
              <button type="button" aria-label={`Поднять ${labelFor(harness, runtimes)} выше в маршруте ${project}`} disabled={index === 0}
                onClick={() => onChange(moveProjectRouteHarness(route, harness, -1))}>↑</button>
              <button type="button" aria-label={`Опустить ${labelFor(harness, runtimes)} ниже в маршруте ${project}`} disabled={index === route.harnesses.length - 1}
                onClick={() => onChange(moveProjectRouteHarness(route, harness, 1))}>↓</button>
              <button type="button" aria-label={`Убрать ${labelFor(harness, runtimes)} из маршрута ${project}`}
                onClick={() => onChange(removeProjectRouteHarness(route, harness))}>Убрать</button>
            </span>
          </li>)}
        </ol>}
      <div className="projects-field">
        <label htmlFor={`projects-add-harness-${project}`}>Добавить среду в маршрут</label>
        <select id={`projects-add-harness-${project}`} value="" aria-label={`Добавить среду в маршрут проекта ${project}`}
          onChange={(event) => {
            const harness = event.target.value;
            if (!harness) return;
            onChange({ ...route, harnesses: [...route.harnesses, harness] });
          }}>
          <option value="">Выберите среду</option>
          {addable.map((harness) => <option value={harness} key={harness}>{labelFor(harness, runtimes)}</option>)}
        </select>
        <small className="projects-help">В маршрут можно добавить только среду из общего списка разрешённых.</small>
      </div>
    </fieldset>
    <fieldset className="projects-fieldset" disabled={disabled}>
      <legend>Модель маршрута</legend>
      <p className="projects-help">Укажите модель, которую Herder отдаст этой среде для этого проекта. Например, <code>omniroute/minimax-combo-m3.1</code> для OpenCode. Пустое поле берёт общую модель среды.</p>
      {route.harnesses.map((harness) => <div className="projects-field" key={`${project}-${harness}`}>
        <label htmlFor={routeInputId(project, harness)}>Модель · {labelFor(harness, runtimes)}</label>
        <input id={routeInputId(project, harness)} type="text" maxLength={256} list={routeInputId(project, harness)}
          value={route.models?.[harness] ?? ""} placeholder={policy.models[harness] ?? "Укажите модель"}
          aria-label={`Модель маршрута для ${project} и среды ${labelFor(harness, runtimes)}`}
          onChange={(event) => onChange(updateProjectRouteModel(route, harness, event.target.value))} />
        <datalist id={routeInputId(project, harness)}>{(modelOptions[harness] ?? []).map((model) => <option value={model} key={model} />)}</datalist>
        <small className="projects-help">Пустое поле использует общую модель среды {labelFor(harness, runtimes)}: {policy.models[harness] || "не задана"}.</small>
      </div>)}
    </fieldset>
    <fieldset className="projects-fieldset" disabled={disabled}>
      <legend>Идентификаторы карточек</legend>
      <div className="projects-field">
        <label htmlFor={`projects-aliases-${project}`}>Идентификаторы карточек · {project}</label>
        <input id={`projects-aliases-${project}`} type="text" value={(route.aliases ?? []).join(", ")} placeholder="tg-commentator, autotelegramviews"
          aria-label={`Идентификаторы карточек проекта ${project}`}
          onChange={(event) => {
            const aliases = event.target.value.split(",").map((alias) => alias.trim()).filter(Boolean);
            onChange(aliases.length > 0 ? { ...route, aliases } : { ...route, aliases: undefined });
          }} />
        <small className="projects-help">Через запятую. Карточка приходит с таким идентификатором, а не с путём к папке.</small>
      </div>
    </fieldset>
    <ProjectModelPolicyEditor project={project} route={route} policy={policy} runtimes={runtimes}
      modelOptions={modelOptions} disabled={disabled} onChange={onChange} />
  </article>;
}

/**
 * The first-class Projects screen.
 *
 * It edits only the project routes of the Herder launch policy. The model of
 * the incident analysis stays in Notice Place and the global allowlist stays
 * in the launch settings, so this page never touches either of them.
 */
export function ProjectsSettings({ onOpenLaunchSettings }: { onOpenLaunchSettings?: () => void } = {}) {
  const draft = useLaunchPolicyDraft({ merge: mergeProjectRoutes });
  const { runtimes, modelOptions } = useRuntimeModels();
  const policy = draft.policy;
  const loading = draft.phase === "loading";
  const needsSetup = draft.phase === "absent";
  const loadError = draft.loadError;
  const saving = draft.saving;
  const saved = draft.saved;
  const saveError = draft.saveError;
  const [newProject, setNewProject] = React.useState("");
  const [newProjectHarnesses, setNewProjectHarnesses] = React.useState<string[]>([]);

  const projectRoutes = Object.entries(policy.projectRoutes ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const allowed = policy.allowedHarnesses;
  const available = allowed.length > 0 ? allowed : runtimes.map(({ id }) => id);
  const knownPaths = useKnownProjectPaths();
  const routesValid = projectRoutes.every(([project, route]) =>
    project.startsWith("/") && route.harnesses.length > 0
    && route.harnesses.every((harness) => allowed.length === 0 || allowed.includes(harness))
    && route.harnesses.every((harness) => {
      const model = route.models?.[harness] ?? policy.models[harness];
      return Boolean(model?.trim()) && model.length <= 256;
    })
    // A model that is allowed and denied at the same time is ambiguous and
    // must not reach the saved policy.
    && conflictingModelEntries(route.allowedModels, route.deniedModels).length === 0
    && (route.allowedModels ?? []).every((model) => model.trim().length > 0 && model.length <= 256)
    && (route.deniedModels ?? []).every((model) => model.trim().length > 0 && model.length <= 256));
  const valid = routesValid;

  const setRoutes = (routes: Record<string, ProjectLaunchRoute>) => {
    draft.edit({ ...policy, projectRoutes: routes }, "projectRoutes");
  };

  return <section className="projects-page" aria-label="Проекты">
    <header className="projects-heading">
      <div>
        <span className="eyebrow">AGENT HERDER · ПРОЕКТЫ</span>
        <h1>Проекты</h1>
        <p>Здесь задаётся маршрут каждого проекта: в какой среде Herder запустит работу, какая модель у этой среды и по каким идентификаторам приходят карточки. Страница меняет только маршруты проектов в политике запуска Herder.</p>
      </div>
      {onOpenLaunchSettings && <button type="button" className="quiet-button projects-heading-action" aria-label="Открыть общие настройки запуска" onClick={onOpenLaunchSettings}>Общие настройки запуска</button>}
    </header>
    <section className="projects-globals" aria-label="Общие настройки запуска">
      <div>
        <span className="eyebrow">РАЗРЕШЁННЫЕ СРЕДЫ</span>
        <p className="projects-globals-value">{allowed.length > 0 ? allowed.map((harness) => labelFor(harness, runtimes)).join(", ") : "Ни одна среда не разрешена"}</p>
        <small className="projects-help">В маршрут проекта попадают только эти среды. Список меняется в общих настройках запуска.</small>
      </div>
      <div>
        <span className="eyebrow">МОДЕЛЬ ДЛЯ АНАЛИЗА ИНЦИДЕНТОВ</span>
        <p className="projects-globals-value">Notice Place</p>
        <small className="projects-help">Модель для анализа инцидентов выбирается в <a href="https://notify.bezrabotnyi.com/admin/#health-model">админке Notice Place</a>. Эта страница её не меняет.</small>
      </div>
    </section>
    {loading ? <p className="settings-loading" role="status">Загружаем маршруты проектов…</p> : <>
      {needsSetup && <p className="launch-policy-notice" role="status">Настройки запуска ещё не сохранены. Сохраните маршрут проекта, чтобы он начал применяться.</p>}
      {draft.phase === "invalid" && <p className="autopilot-error" role="alert">Политика запуска повреждена, поэтому сохранить маршруты из формы нельзя: {loadError}. Файл политики на сервере нужно исправить вручную.</p>}
      {draft.phase === "error" && <p className="autopilot-error" role="alert">Не удалось загрузить настройки запуска: {loadError}. Обновите страницу и повторите.</p>}
      <div className="projects-list">
        {projectRoutes.length === 0
          ? <p className="projects-empty">Маршруты проектов не настроены. Для всех проектов используется основная среда. Добавьте первый проект ниже.</p>
          : projectRoutes.map(([project, route]) => <ProjectRoutesEditor key={project}
            project={project}
            route={route}
            policy={policy}
            runtimes={runtimes}
            modelOptions={modelOptions}
            disabled={saving || Boolean(loadError)}
            onChange={(next) => setRoutes({ ...(policy.projectRoutes ?? {}), [project]: next })}
            onRemove={() => {
              const routes = { ...(policy.projectRoutes ?? {}) };
              delete routes[project];
              setRoutes(routes);
            }} />)}
      </div>
      <section className="projects-card projects-card-new" aria-label="Новый проект">
        <h2 className="projects-card-title">Новый проект</h2>
        <fieldset className="projects-fieldset" disabled={saving || Boolean(loadError)}>
          <legend>Путь и среды</legend>
          <div className="projects-field">
            <label htmlFor="projects-new-path">Абсолютный путь проекта</label>
            <input id="projects-new-path" type="text" value={newProject} placeholder="/home/user/project"
              aria-label="Абсолютный путь проекта для маршрута" onChange={(event) => setNewProject(event.target.value)} />
            <small className="projects-help">Папка проекта на этой машине. Регистр и завершающий слеш не важны.</small>
          </div>
          <div className="projects-field">
            <label htmlFor="projects-new-known">Известные проекты</label>
            <select id="projects-new-known" value="" aria-label="Выбрать известный проект из списка живых сессий"
              onChange={(event) => {
                if (!event.target.value) return;
                setNewProject(event.target.value);
              }}>
              <option value="">Выберите папку проекта</option>
              {knownPaths.map((path) => <option value={path} key={path}>{path}</option>)}
            </select>
            <small className="projects-help">Папки живых сессий на этой машине. Можно и ввести путь руками.</small>
          </div>
          <div className="projects-field">
            <span className="projects-field-label">Среды маршрута</span>
            <div className="launch-runtime-list">{available.map((harness) => {
              const selected = newProjectHarnesses.includes(harness);
              return <label className="launch-runtime-option" key={`add-${harness}`}>
                <span><strong>{labelFor(harness, runtimes)}</strong><small aria-hidden="true">{selected ? `позиция ${newProjectHarnesses.indexOf(harness) + 1}` : "не в маршруте"}</small></span>
                <input type="checkbox" checked={selected} aria-label={`Добавить ${labelFor(harness, runtimes)} в маршрут нового проекта`} onChange={(event) => {
                  setNewProjectHarnesses((current) => event.target.checked
                    ? [...current, harness].slice(-4)
                    : current.filter((item) => item !== harness));
                }} />
              </label>;
            })}</div>
            {available.length === 0 && <p className="projects-help" role="status">Нет сред, которые можно добавить в маршрут. Сначала разрешите среду в общих настройках запуска.</p>}
          </div>
          <button type="button" className="primary-button" aria-label="Добавить маршрут проекта"
            disabled={!normalizeProjectKey(newProject).startsWith("/") || newProjectHarnesses.length === 0}
            onClick={() => {
              const key = normalizeProjectKey(newProject);
              if (!key.startsWith("/") || newProjectHarnesses.length === 0) return;
              setRoutes({ ...(policy.projectRoutes ?? {}), [key]: { harnesses: [...newProjectHarnesses] } });
              setNewProject("");
              setNewProjectHarnesses([]);
            }}>Добавить проект</button>
        </fieldset>
      </section>
      {draft.conflict && draft.conflicts.length === 0 && <p className="autopilot-error" role="alert">Политика запуска изменилась в другой вкладке. Ваши правки сохранены в форме и не отправлены.
        <button type="button" className="quiet-button" aria-label="Обновить маршруты и применить правки заново" disabled={saving} onClick={() => void draft.resolveConflict()}>Обновить и применить заново</button>
      </p>}
      {draft.conflicts.length > 0 && <p className="autopilot-error" role="alert">{`Проект${draft.conflicts.length > 1 ? "ы" : ""} ${draft.conflicts.join(", ")} изменились в другой вкладке. Ваша версия оставлена в форме, но не сохранена: перезагрузите страницу или измените проект заново.`}
        <button type="button" className="quiet-button" aria-label="Перезагрузить маршруты и отбросить правки" disabled={saving} onClick={() => void draft.reload()}>Перезагрузить и отбросить правки</button>
      </p>}
      {saveError && <p className="autopilot-error" role="alert">Не удалось сохранить маршруты: {saveError}</p>}
      {!valid && <p className="projects-help" role="alert">Маршрут задан некорректно: проверьте путь проекта, среды и модели. Пока это не исправлено, политика запуска не сохранится.</p>}
      <div className="settings-save-row projects-save-row">
        <span role="status">{saved ? <span className="settings-saved">Маршруты сохранены</span> : "Изменения применятся к новым сессиям этого проекта."}</span>
        <button type="button" className="primary-button" aria-label="Сохранить маршруты проектов"
          disabled={!valid || saving || loading || Boolean(loadError)} onClick={() => void draft.save()}>{saving ? "Сохраняем…" : "Сохранить"}</button>
      </div>
    </>}
  </section>;
}
