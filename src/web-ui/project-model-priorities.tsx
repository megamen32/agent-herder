import * as React from "react";
import { routeModelViolation } from "../project-model-gate.js";
import { isRecoveryModelReference } from "../recovery-model-reference.js";
import { moveFallbackModel } from "./fallback-models-controls.js";
import type { LaunchPolicy, ProjectLaunchRoute } from "./launch-policy-settings.js";

/** Priority references only: the model catalog and project permissions stay authoritative. */
export function ProjectModelPriorities({ project, route, policy, catalog, disabled, onChange }: {
  project: string;
  route: ProjectLaunchRoute;
  policy: LaunchPolicy;
  catalog: Record<string, string[]>;
  disabled?: boolean;
  onChange: (route: ProjectLaunchRoute) => void;
}) {
  return <section className="projects-field" aria-label={`Автопереключение моделей проекта ${project}`}>
    <strong>Приоритет моделей при исчерпании квоты</strong>
    <p className="settings-help">Включатель находится в «Автопродолжение → Автопереключение моделей». Здесь задаётся порядок уже доступных моделей. Разрешения проекта действуют на каждую попытку; новая модель в реестре не создаётся.</p>
    {route.harnesses.filter((harness): harness is "opencode" | "zcode" => harness === "opencode" || harness === "zcode").map(harness => {
      const override = route.fallbackModels?.[harness];
      const inherited = override === undefined;
      const models = override ?? policy.fallbackModels?.[harness] ?? [];
      const available = [...new Set([...(catalog[harness] ?? []), ...(route.allowedModels ?? [])])]
        .filter(model => isRecoveryModelReference(model, harness) && !routeModelViolation(route, model) && !models.includes(model));
      const change = (next?: string[]) => {
        const fallbackModels = { ...route.fallbackModels };
        if (next === undefined) delete fallbackModels[harness];
        else fallbackModels[harness] = next;
        // Explicit {} clears the override; omission belongs to legacy editors.
        onChange({ ...route, fallbackModels });
      };
      return <div key={harness}>
        <label className="runtime-toggle-setting"><span>{harness === "opencode" ? "OpenCode" : "ZCode"}: использовать общий порядок</span>
          <input type="checkbox" checked={inherited} disabled={disabled} aria-label={`Общий порядок моделей ${harness} проекта ${project}`}
            onChange={event => change(event.target.checked ? undefined : [...models])} />
        </label>
        <ol className="projects-model-list" aria-label={`Порядок моделей ${harness} проекта ${project}`}>
          {models.length === 0 && <li className="settings-help">{inherited ? "Общий список пуст — переключаться не на что." : "Порядок пуст — для этого проекта переключение выключено."}</li>}
          {models.map((model, index) => {
            const blocked = routeModelViolation(route, model);
            return <li key={model} className="projects-model-item">
              <span><code>{model}</code>{blocked && <small className="autopilot-error">Модель не разрешена проектом и будет пропущена.</small>}</span>
              <div>
                <button type="button" className="quiet-button" disabled={disabled || inherited || index === 0}
                  aria-label={`Повысить приоритет ${model} в ${harness}`} onClick={() => change(moveFallbackModel(models, index, -1))}>↑</button>
                <button type="button" className="quiet-button" disabled={disabled || inherited || index === models.length - 1}
                  aria-label={`Понизить приоритет ${model} в ${harness}`} onClick={() => change(moveFallbackModel(models, index, 1))}>↓</button>
                <button type="button" className="quiet-button" disabled={disabled || inherited}
                  aria-label={`Убрать ${model} из порядка ${harness}`} onClick={() => change(models.filter(value => value !== model))}>Убрать</button>
              </div>
            </li>;
          })}
        </ol>
        {!inherited && <label className="launch-policy-field"><span>Выбрать следующую разрешённую модель</span>
          <select value="" disabled={disabled || models.length >= 8 || available.length === 0}
            aria-label={`Добавить в порядок моделей ${harness} проекта ${project}`}
            onChange={event => { if (event.target.value) change([...models, event.target.value]); }}>
            <option value="">{available.length ? "Выберите из существующего каталога" : "Нет других разрешённых моделей"}</option>
            {available.map(model => <option key={model} value={model}>{model}</option>)}
          </select>
        </label>}
      </div>;
    })}
  </section>;
}
