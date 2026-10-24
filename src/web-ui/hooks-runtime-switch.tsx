import React from "react";

import { loadHooks, saveHooksProhibitions, type HooksView } from "./hooks-section.js";
import type { HookKind } from "../hooks/catalog.js";

/**
 * The switch of the whole optional hooks runtime of the herder.
 *
 * The owner asked for one prominent place where the state of the product is
 * visible and changeable: the general switch of the hooks comes first, and
 * every hook has its own switch with a plain description, its true state, its
 * scope and the way it travels.
 *
 * Two levers live here and they are not the same lever. The runtime switch
 * says whether the optional hooks of the herder run at all. The prohibitions
 * say whether the hooks that run may refuse a tool call or hold the stop of a
 * turn. The second one is in the section "Хуки" of the panel; this block is
 * about the first one, and it says so in the words of the owner.
 */

/** The state of the whole runtime, in one line. */
export function hooksRuntimeText(view: HooksView | null): string {
  if (!view) return "Состояние хуков читается…";
  if (view.known === false) {
    return "Состояние хуков неизвестно: herder не ответил или файл состояния повреждён. Пока состояние неизвестно, ни один хук herder не выполняется.";
  }
  if (view.hooksEnabled === true) {
    return "Хуки Agent Herder включены: herder выполняет свои хуки в сессиях.";
  }
  return "Хуки Agent Herder выключены: ни один хук herder не выполняется, сессии работают без них.";
}

/** What the general switch will do, as the owner reads the button. */
export function hooksRuntimeToggleLabel(view: HooksView | null): string {
  if (!view || view.known === false) return "Обновить состояние";
  return view.hooksEnabled === true ? "Выключить хуки Agent Herder" : "Включить хуки Agent Herder";
}

/** What the general switch changes, in the words of the confirmation. */
export function hooksRuntimeConfirmText(enable: boolean): string {
  if (enable) {
    return "Включить хуки Agent Herder? Herder начнёт выполнять свои хуки в сессиях: подмешивать контекст, отмечать работу с файлами и проверять маршрут модели. Авторизация MCP, права инструментов, ручной Stop и защита квот не затрагиваются.";
  }
  return "Выключить хуки Agent Herder? Herder перестанет выполнять свои хуки в сессиях. Авторизация MCP, права инструментов, ручной Stop и защита квот не затрагиваются.";
}

/** The true state of one hook, as the owner reads it. */
export function hooksHookStateText(hook: { state?: string; kind?: HookKind }): string {
  if (!hook.state) return "неизвестно";
  if (hook.state === "неизвестно") return "неизвестно";
  if (hook.state === "не выполняется") return "не выполняется";
  if (hook.state === "выполняется, может запрещать") return "выполняется и может запрещать";
  return "выполняется, но не запрещает";
}

/** The scope of the general switch, in the words of the owner. */
export const HOOKS_RUNTIME_SCOPE = "Область: эта машина (узел). Общие настройки флота этот переключатель не переносят и не включают.";

export function HooksRuntimeSwitch(): React.ReactElement {
  const [view, setView] = React.useState<HooksView | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<null | { enable: boolean }>(null);

  const reload = React.useCallback(async (): Promise<void> => {
    try {
      setView(await loadHooks());
      setError(null);
    } catch (cause) {
      setError(`Состояние хуков не прочитано: ${(cause as Error).message}`);
    }
  }, []);

  React.useEffect(() => { void reload(); }, [reload]);

  const apply = async (change: { hooksEnabled?: boolean; inactiveHooks?: HookKind[]; reason: string }): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setView(await saveHooksProhibitions(change, view?.etag));
      setPending(null);
    } catch (cause) {
      setError(`Состояние не изменено: ${(cause as Error).message}`);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const hooks = view?.hooks ?? [];
  const inactive = new Set<HookKind>(view?.inactiveHooks ?? []);

  const toggleHook = async (kind: HookKind): Promise<void> => {
    const next = new Set(inactive);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    await apply({ inactiveHooks: [...next], reason: `Хук ${kind} ${next.has(kind) ? "выключен" : "включен"} владельцем` });
  };

  return (
    <section className="herder-settings-block" aria-label="Хуки Agent Herder">
      <h2>Хуки Agent Herder</h2>
      <p className="herder-settings-state-line" role="status">{hooksRuntimeText(view)}</p>
      <p className="herder-settings-hint">
        Хуки — это то, что Agent Herder подвешивает к сессии: подмешивание контекста, отметка работы
        с файлами, проверка маршрута модели и решение, можно ли остановить ход. Это необязательная
        интеграция: по умолчанию она выключена, и включать её нужно вручную.
      </p>
      <p className="herder-settings-hint">
        Не затрагивается: авторизация MCP, права инструментов, ручной Stop и защита квот. Это другие
        рычаги, они живут в своих разделах.
      </p>
      <p className="herder-settings-hint">{HOOKS_RUNTIME_SCOPE}</p>

      {error ? <p className="herder-settings-error" role="alert">{error}</p> : null}

      <div className="herder-settings-actions">
        <button
          type="button"
          className={view?.hooksEnabled === true ? "herder-settings-button herder-settings-button-danger" : "herder-settings-button"}
          disabled={busy || view?.known === false}
          onClick={() => { setPending({ enable: view?.hooksEnabled !== true }); }}
        >
          {hooksRuntimeToggleLabel(view)}
        </button>
        <button type="button" className="herder-settings-button" disabled={busy} onClick={() => { void reload(); }}>
          Обновить состояние
        </button>
      </div>

      <table className="herder-settings-table">
        <thead>
          <tr><th>Хук</th><th>Что делает</th><th>Действует</th><th>Состояние</th><th>Действия</th></tr>
        </thead>
        <tbody>
          {hooks.map((hook) => (
            <tr key={hook.kind}>
              <td>
                <strong>{hook.humanName ?? hook.kind}</strong>
                <span className="herder-settings-action">{hook.kind}</span>
              </td>
              <td>{hook.purpose ?? "—"}</td>
              <td>{hook.scope ?? "—"}</td>
              <td>{hooksHookStateText(hook)}</td>
              <td className="herder-settings-actions">
                <button
                  type="button"
                  className="herder-settings-button"
                  disabled={busy || view?.known === false}
                  onClick={() => { void toggleHook(hook.kind); }}
                >
                  {inactive.has(hook.kind) ? "Включить хук" : "Выключить хук"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {pending ? (
        <div className="herder-settings-notice" role="dialog" aria-label="Подтверждение">
          <p>{hooksRuntimeConfirmText(pending.enable)}</p>
          <div className="herder-settings-actions">
            <button
              type="button"
              className="herder-settings-button"
              disabled={busy}
              onClick={() => { void apply({ hooksEnabled: pending.enable, reason: pending.enable ? "Владелец включил хуки Agent Herder" : "Владелец выключил хуки Agent Herder" }); }}
            >
              Подтвердить
            </button>
            <button type="button" className="herder-settings-button" disabled={busy} onClick={() => { setPending(null); }}>
              Отмена
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
