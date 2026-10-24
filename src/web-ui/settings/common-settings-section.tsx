import React from "react";

import {
  loadCommonSettings,
  restoreCommonSettingsLocal,
  setCommonSettingsOptIn,
  syncCommonSettings,
  type CommonSettingsConflict,
  type CommonSettingsNodeFact,
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
 * The screen names every node honestly, and it names four facts and not two: a
 * node that holds the wanted revision applied it, a node that holds another
 * one diverged, a node that answered and applied nothing has not applied it
 * yet, and a node that did not answer is unreachable. A node that did not
 * answer is never counted as synchronized and never shown as applied.
 *
 * The confirmation of the delivery is the answer of the nodes: the panel asks
 * the fleet to take the document and shows who applied it. The panel never
 * says "применено" on its own.
 */

/** The state of the application, colored by its meaning in both themes. */
function stateClass(state: string): string {
  const base = "herder-settings-state";
  if (state === "Применено") return `${base} herder-settings-state-applied`;
  if (state === "Узел недоступен") return `${base} herder-settings-state-unreachable`;
  if (state === "Применяется") return `${base} herder-settings-state-running`;
  return `${base} herder-settings-state-pending`;
}

/**
 * The fact of the node, as the answer of the node says it.
 *
 * The answer of the node names the fact: a node that did not answer is
 * unreachable, and nothing is known about it. A node that answered and holds
 * no revision has not applied the document yet. The two are never one state.
 */
function factOf(node: CommonSettingsNodeView): CommonSettingsNodeFact {
  const fact: string | undefined = node.fact;
  if (fact === "применена" || fact === "расходится" || fact === "не применена" || fact === "недоступна") return fact;
  // An answer of an older node carries no fact of its own: the state of the
  // answer is read as it is, and nothing is added to it.
  if (node.status === "подтвердил") return "применена";
  if (node.status === "расходится") return "расходится";
  return "не применена";
}

/** The fact of the node, in the words of the owner. */
export function nodeFactText(node: CommonSettingsNodeView): string {
  const fact = factOf(node);
  if (fact === "применена") return "применена";
  if (fact === "расходится") return "расходится";
  if (fact === "не применена") return "не применена";
  return "недоступна";
}

/** The fact of the node, colored by its meaning in both themes. */
export function nodeFactClass(node: CommonSettingsNodeView): string {
  const base = "herder-settings-state";
  const fact = factOf(node);
  if (fact === "применена") return `${base} herder-settings-state-applied`;
  // A node that holds another revision is a divergence: it is not a failure of
  // the change, and it is not agreement either.
  if (fact === "расходится") return `${base} herder-settings-state-error`;
  // A node that answered and applied nothing is waiting, not down.
  if (fact === "не применена") return `${base} herder-settings-state-pending`;
  // A node that did not answer is unreachable: nothing is known about it.
  return `${base} herder-settings-state-unreachable`;
}

/**
 * The revision the node holds.
 *
 * A node that answered and holds no revision has no revision to name, and a
 * node that did not answer has nothing known about it: the two say it in their
 * own words and never borrow the revision of another node.
 */
export function nodeRevisionText(node: CommonSettingsNodeView): string {
  if (node.appliedRevision) return node.appliedRevision;
  return factOf(node) === "недоступна" ? "неизвестно" : "не применена";
}

/** The state of the application with the number of the nodes and their names. */
export function fleetStateLine(view: CommonSettingsView): string {
  const count = `${view.confirmed} из ${view.total}`;
  const unreachable: string[] = view.unreachable;
  // The node that did not answer is named as the node that did not answer: a
  // node that is down is not a node that holds another revision.
  const named = view.unconfirmed.map((hostId) => (
    unreachable.includes(hostId) ? `${hostId} (недоступен)` : hostId
  ));
  if (view.state === "Применено частично") {
    return `Применено частично (${count}); не подтвердили: ${named.join(", ")}`;
  }
  if (view.state === "Узел недоступен") {
    return `Узел недоступен; не ответили: ${named.join(", ")}`;
  }
  return `${view.state} (${count})`;
}

/**
 * The confirmation of the delivery, in the words of the owner.
 *
 * The line names the revision that was sent and the nodes that applied it.
 * The nodes that did not apply it are named too: a delivery that reached one
 * node of two is not a delivery that arrived.
 */
export function deliverySummary(view: CommonSettingsView): string {
  const revision = view.revision ?? "—";
  const applied: string[] = [];
  const missing: string[] = [];
  for (const node of view.nodes) {
    const fact = factOf(node);
    if (fact === "применена") applied.push(node.hostId);
    else if (fact === "недоступна") missing.push(`${node.hostId} (недоступен)`);
    else missing.push(`${node.hostId} (${nodeFactText(node)})`);
  }
  const reached = applied.length > 0 ? applied.join(", ") : "—";
  if (missing.length === 0) return `Реввизия ${revision} применена: ${reached}.`;
  return `Реввизия ${revision}: применили ${reached}; не применили: ${missing.join(", ")}.`;
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

/**
 * The common settings of the fleet, as the owner reads them.
 *
 * The panel is a pure view of what the fleet answered: every fact on the
 * screen is the answer of a node, and the screen adds nothing of its own.
 */
export function CommonSettingsPanel({
  view,
  busy = false,
  notice = null,
  error = null,
  onSync,
  onRefresh,
  onRestore,
  onOptIn,
  onLocalOptIn,
}: {
  view: CommonSettingsView;
  busy?: boolean;
  notice?: string | null;
  error?: string | null;
  onSync?: () => void;
  onRefresh?: () => void;
  onRestore?: (hostId: string) => void;
  onOptIn?: (hostId: string) => void;
  onLocalOptIn?: () => void;
}): React.ReactElement {
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
        <span className={stateClass(view.state)}>{fleetStateLine(view)}</span>
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
          onClick={() => { onSync?.(); }}
        >
          Разослать общие настройки
        </button>
        <button type="button" className="herder-settings-button" disabled={busy} onClick={() => { onRefresh?.(); }}>
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
                <span className={nodeFactClass(node)}>{nodeFactText(node)}</span>
                {node.reason ? <span className="herder-settings-hint"> {node.reason}</span> : null}
                {node.conflicts.filter((conflict) => conflict.open !== false).length > 0 ? (
                  <span className="herder-settings-hint">
                    {" "}Отклонения: {node.conflicts.filter((conflict) => conflict.open !== false).map(conflictLine).join("; ")}
                  </span>
                ) : null}
              </td>
              <td>
                {node.appliedRevision
                  ? <code>{node.appliedRevision}</code>
                  : <span className="herder-settings-hint">{nodeRevisionText(node)}</span>}
              </td>
              <td>{node.confirmedAt ?? "—"}</td>
              <td className="herder-settings-actions">
                <button
                  type="button"
                  className="herder-settings-button"
                  disabled={busy}
                  onClick={() => { onRestore?.(node.hostId); }}
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
                onClick={() => { onOptIn?.(hostId); }}
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
            onClick={() => { onLocalOptIn?.(); }}
          >
            Принимать общие настройки на этой ноде
          </button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The common settings of the fleet, with the state of the panel itself.
 *
 * The section reads the fleet and shows the answer. When the owner changes a
 * common setting, the fleet is asked to take the new document and the answer
 * of the nodes is the confirmation of the delivery: the panel does not claim
 * that the change arrived — the nodes say it.
 */
export function CommonSettingsSection({ delivery = 0 }: { delivery?: number } = {}): React.ReactElement {
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

  // The delivery of the change: the fleet is asked to take the document and
  // the answer of the nodes is the confirmation of the delivery. The panel
  // waits for that answer and shows it as it is.
  const delivered = React.useRef(delivery);
  React.useEffect(() => {
    if (delivery === delivered.current) return;
    delivered.current = delivery;
    setBusy(true);
    void syncCommonSettings()
      .then((result) => {
        setView(result);
        setNotice(deliverySummary(result));
        setError(null);
      })
      .catch((failure) => {
        setError((failure as Error).message);
      })
      .finally(() => {
        setBusy(false);
      });
  }, [delivery]);

  const act = async (
    action: () => Promise<CommonSettingsView>,
    message: (result: CommonSettingsView) => string,
  ): Promise<void> => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const result = await action();
      setView(result);
      setNotice(message(result));
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

  return (
    <CommonSettingsPanel
      view={view}
      busy={busy}
      notice={notice}
      error={error}
      onSync={() => { void act(syncCommonSettings, deliverySummary); }}
      onRefresh={() => { void load(); }}
      onRestore={(hostId) => { void act(() => restoreCommonSettingsLocal(hostId), () => `Локальные значения ${hostId} возвращены.`); }}
      onOptIn={(hostId) => { void act(() => setCommonSettingsOptIn(true, hostId), () => `Нода ${hostId} объявила, что берёт общие настройки.`); }}
      onLocalOptIn={() => { void act(() => setCommonSettingsOptIn(true), () => "Эта нода объявила, что берёт общие настройки."); }}
    />
  );
}
