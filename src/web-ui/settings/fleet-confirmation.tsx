import React from "react";

import { loadFleetConfirmation, type SettingsFleetConfirmation } from "./settings-client.js";

/**
 * The confirmation of the fleet, as the owner reads it.
 *
 * The owner changes one thing and wants to know what the fleet made of it:
 * which node holds the wanted revision, which node did not answer and when
 * the last confirmation happened. The screen names the state, the number of
 * the nodes and the nodes themselves — a node that did not confirm is named,
 * never counted as confirmed.
 *
 * The poll reaches the other nodes of the fleet, so it is asked for by the
 * owner and not read with every view of the settings.
 */

/** The state of the application, with the number of the nodes and their names. */
function stateLine(confirmation: SettingsFleetConfirmation): string {
  const count = `${confirmation.confirmed} из ${confirmation.total}`;
  if (confirmation.state === "Применено частично") {
    return `Применено частично (${count}); не подтвердили: ${confirmation.unconfirmed.join(", ")}`;
  }
  if (confirmation.state === "Узел недоступен") {
    return `Узел недоступен; не ответили: ${confirmation.unconfirmed.join(", ")}`;
  }
  if (confirmation.state === "Применяется") {
    return `Применяется (${count}); подтверждение ещё не получено`;
  }
  return `${confirmation.state} (${count})`;
}

/** The state of the application, colored by its meaning in both themes. */
function stateClass(state: string): string {
  const base = "herder-settings-state";
  if (state === "Применено") return `${base} herder-settings-state-applied`;
  if (state === "Узел недоступен") return `${base} herder-settings-state-unreachable`;
  if (state === "Применяется") return `${base} herder-settings-state-running`;
  return `${base} herder-settings-state-pending`;
}

/** The confirmation of the fleet, as the owner reads it. */
export function FleetConfirmation(): React.ReactElement {
  const [confirmation, setConfirmation] = React.useState<SettingsFleetConfirmation | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      setConfirmation(await loadFleetConfirmation());
      setError(null);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  return (
    <section className="herder-settings-block" aria-label="Подтверждение применения в флоте">
      <h2>Подтверждение применения в флоте</h2>
      <button
        type="button"
        className="herder-settings-button"
        disabled={busy}
        onClick={() => { void load(); }}
      >
        Обновить подтверждение
      </button>
      {error ? <p className="herder-settings-error" role="alert">{error}</p> : null}
      {!confirmation ? (
        <p className="herder-settings-hint">Читаю подтверждение…</p>
      ) : (
        <>
          <p className="herder-settings-hint">
            <span className={stateClass(confirmation.state)}>{stateLine(confirmation)}</span>
            {" · "}источник: {confirmation.source}
            {confirmation.desiredRevision ? ` · запрошенная версия: ${confirmation.desiredRevision}` : ""}
            {` · прочитано: ${confirmation.checkedAt}`}
          </p>
          {confirmation.error ? <p className="herder-settings-hint">{confirmation.error}</p> : null}
          <table className="herder-settings-table">
            <thead>
              <tr><th>Узел</th><th>Подтверждение</th><th>Версия</th><th>Когда</th></tr>
            </thead>
            <tbody>
              {confirmation.nodes.map((node) => (
                <tr key={node.hostId}>
                  <td><code>{node.hostId}</code></td>
                  <td>
                    {node.status}
                    {node.reason ? <span className="herder-settings-hint"> {node.reason}</span> : null}
                  </td>
                  <td><code>{node.appliedRevision ?? "—"}</code></td>
                  <td>{node.confirmedAt ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
