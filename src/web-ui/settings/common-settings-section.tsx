import React from "react";

import {
  loadCommonSettings,
  restoreCommonSettingsLocal,
  setCommonSettingsOptIn,
  syncCommonSettings,
  type CommonSettingsConflict,
  type CommonSettingsNodeView,
  type CommonSettingsView,
} from "./settings-client.js";

/**
 * The common settings of the fleet, as the owner reads them.
 *
 * One place owns the document of the common settings and one revision names
 * it. The owner changes a common setting in one place — in the table of the
 * variables of the product — and every node that takes the common settings
 * gets the same value and confirms the revision it applied.
 *
 * The screen names every node honestly: a node that holds the wanted revision
 * confirmed, a node that holds another one diverged, and a node that did not
 * answer is unknown. A node that did not answer is never counted as
 * synchronized.
 */

/** The state of the application, colored by its meaning in both themes. */
function stateClass(state: string): string {
  const base = "herder-settings-state";
  if (state === "Применено") return `${base} herder-settings-state-applied`;
  if (state === "Узел недоступен") return `${base} herder-settings-state-unreachable`;
  if (state === "Применяется") return `${base} herder-settings-state-running`;
  return `${base} herder-settings-state-pending`;
}

/** The state of the application with the number of the nodes and their names. */
function stateLine(view: CommonSettingsView): string {
  const count = `${view.confirmed} из ${view.total}`;
  if (view.state === "Применено частично") {
    return `Применено частично (${count}); не подтвердили: ${view.unconfirmed.join(", ")}`;
  }
  if (view.state === "Узел недоступен") {
    return `Узел недоступен; не ответили: ${view.unconfirmed.join(", ")}`;
  }
  return `${view.state} (${count})`;
}

/** The state of one node, colored by its meaning in both themes. */
function nodeStateClass(node: CommonSettingsNodeView): string {
  const base = "herder-settings-state";
  if (node.status === "подтвердил") return `${base} herder-settings-state-applied`;
  // A node that holds another revision is a divergence: it is not a failure of
  // the change, and it is not agreement either.
  if (node.status === "расходится") return `${base} herder-settings-state-error`;
  // A node that did not answer is unknown.
  return `${base} herder-settings-state-unreachable`;
}

/** One deviation, in the words of the owner: both values are named. */
function conflictLine(conflict: CommonSettingsConflict): string {
  if (conflict.hooksChanged) {
    const local = conflict.localHooksState
      ? (conflict.localHooksState.prohibitionsEnabled ? "запреты включены" : "запреты выключены")
      : "состояние неизвестно";
    const common = conflict.commonHooksState
      ? (conflict.commonHooksState.prohibitionsEnabled ? "запреты включены" : "запреты выключены")
      : "неизвестно";
    return `рычаг запретов хуков: на ноде ${local}, общий ${common}`;
  }
  return `${conflict.id}: на ноде «${conflict.localValue ?? "—"}», общий «${conflict.commonValue ?? "—"}»`;
}

/** The common settings of the fleet. */
export function CommonSettingsSection(): React.ReactElement {
  const [view, setView] = React.useState<CommonSettingsView | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      setView(await loadCommonSettings());
      setError(null);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  const act = async (action: () => Promise<CommonSettingsView>, message: string): Promise<void> => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const result = await action();
      setView(result);
      setNotice(message);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!view) {
    return (
      <section className="herder-settings-block herder-settings-common" aria-label="Общие настройки флота">
        <h2>Общие настройки флота</h2>
        {error ? <p className="herder-settings-error" role="alert">{error}</p> : <p className="herder-settings-hint">Читаю общие настройки…</p>}
      </section>
    );
  }

  const hooks = view.document?.hooks;

  return (
    <section className="herder-settings-block herder-settings-common" aria-label="Общие настройки флота">
      <h2>Общие настройки флота</h2>
      <p className="herder-settings-hint">
        Общие настройки меняются один раз — в таблице переменных продукта выше. Машинные пути и порты остаются своими у каждой машины.
      </p>
      {error ? <p className="herder-settings-error" role="alert">{error}</p> : null}
      {notice ? <p className="herder-settings-notice" role="status">{notice}</p> : null}
      {view.error ? <p className="herder-settings-hint">{view.error}</p> : null}

      <p className="herder-settings-hint">
        <span className={stateClass(view.state)}>{stateLine(view)}</span>
        {" · "}ревизия: {view.revision ?? "—"}
        {view.owner ? ` · владелец: ${view.owner}` : ""}
        {` · прочитано: ${view.checkedAt}`}
      </p>

      {hooks ? (
        <p className="herder-settings-hint">
          Рычаг запретов хуков в общем документе: {hooks.prohibitionsEnabled ? "запреты включены" : "запреты выключены"}
          {hooks.disabledHooks.length > 0 ? `; выключены хуки: ${hooks.disabledHooks.join(", ")}` : ""}
        </p>
      ) : null}

      <div className="herder-settings-row">
        <button
          type="button"
          className="herder-settings-button"
          disabled={busy || !view.ok}
          onClick={() => { void act(syncCommonSettings, "Разослано: узлы берут общий документ и подтверждают применённую ревизию."); }}
        >
          Разослать общие настройки
        </button>
        <button type="button" className="herder-settings-button" disabled={busy} onClick={() => { void load(); }}>
          Обновить состояние
        </button>
      </div>

      <table className="herder-settings-table">
        <thead>
          <tr><th>Узел</th><th>Состояние</th><th>Реввизия</th><th>Когда</th><th>Действия</th></tr>
        </thead>
        <tbody>
          {view.nodes.map((node) => (
            <tr key={node.hostId}>
              <td><code>{node.hostId}</code></td>
              <td>
                <span className={nodeStateClass(node)}>{node.status}</span>
                {node.reason ? <span className="herder-settings-hint"> {node.reason}</span> : null}
                {node.conflicts.filter((conflict) => conflict.open !== false).length > 0 ? (
                  <span className="herder-settings-hint">
                    {" "}Отклонения: {node.conflicts.filter((conflict) => conflict.open !== false).map(conflictLine).join("; ")}
                  </span>
                ) : null}
              </td>
              <td><code>{node.appliedRevision ?? "—"}</code></td>
              <td>{node.confirmedAt ?? "—"}</td>
              <td className="herder-settings-actions">
                <button
                  type="button"
                  className="herder-settings-button"
                  disabled={busy}
                  onClick={() => { void act(() => restoreCommonSettingsLocal(node.hostId), `Локальные значения ${node.hostId} возвращены.`); }}
                >
                  Вернуть локальные значения
                </button>
              </td>
            </tr>
          ))}
          {view.nodes.length === 0 ? (
            <tr>
              <td colSpan={5}>
                <span className="herder-settings-hint">
                  Ни один узел не взял общие настройки: opt-in объявляет сам узел, а нода без ответа остаётся неизвестной.
                </span>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {view.notParticipating.length > 0 ? (
        <>
          <p className="herder-settings-hint">
            Не берут общие настройки: {view.notParticipating.join(", ")}. Пока нода не объявила, что берёт их, её никто не пишет.
          </p>
          <div className="herder-settings-row">
            {view.notParticipating.map((hostId) => (
              <button
                key={hostId}
                type="button"
                className="herder-settings-button"
                disabled={busy || !view.ok}
                onClick={() => { void act(() => setCommonSettingsOptIn(true, hostId), `Нода ${hostId} объявила, что берёт общие настройки.`); }}
              >
                Включить общие настройки: {hostId}
              </button>
            ))}
          </div>
        </>
      ) : null}

      {view.role === "member" ? (
        <div className="herder-settings-row">
          <button
            type="button"
            className="herder-settings-button"
            disabled={busy || !view.ok}
            onClick={() => { void act(() => setCommonSettingsOptIn(true), "Эта нода объявила, что берёт общие настройки."); }}
          >
            Принимать общие настройки на этой ноде
          </button>
        </div>
      ) : null}
    </section>
  );
}
