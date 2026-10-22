import React from "react";

/**
 * The button that stops the automation of the owner.
 *
 * The lever itself is the existing one: the state of the lever is durable,
 * it survives a restart and it is confirmed across the fleet nodes. The
 * panel asks the server to move it on behalf of the owner: the token of the
 * lever never reaches the browser, and the rights are checked on the
 * backend.
 *
 * The screen is honest about what the lever does. It forbids the new
 * automatic launches of the scope and it does not stop the executors that
 * are already running — the screen says so instead of promising it. A node
 * that did not answer is «неизвестно», never «включено» or «выключено».
 *
 * Reading the state and opening the page start no executor of the herder.
 */

export type DisarmNode = { hostId?: string; status?: string; reason?: string; applied?: boolean };

export type DisarmRecord = {
  scope?: string;
  forbidden?: boolean;
  owner?: string;
  reason?: string;
  createdAt?: string;
  workKeys?: string[];
};

export type DisarmState = {
  ok?: boolean;
  applied?: boolean;
  scope?: string;
  forbidden?: boolean;
  disarmed?: boolean;
  state?: { disarmed?: boolean; reason?: string; records?: DisarmRecord[]; blockedWorkKeys?: string[] };
  records?: DisarmRecord[];
  nodes?: DisarmNode[];
  summary?: string;
  etag?: string;
  error?: string;
  reason?: string;
};

/** The endpoint the panel asks: the server moves the lever on behalf of the owner. */
export const DISARM_PANEL_ENDPOINT = "/api/settings/automation/disarm";

/**
 * What the lever does and what it does not do.
 *
 * The lever forbids the new automatic launches of a scope. The executors
 * that are already running keep running: the screen says this plainly
 * instead of promising a stop that does not happen.
 */
export const LEVER_SCOPE_NOTICE =
  "Рычаг запрещает новые автоматические запуски в области. Уже запущенные исполнители продолжают работу — останавливает их тот, кто их запустил.";

/** What happens when the owner allows the scope again. */
export const LEVER_LIFT_NOTICE =
  "Повторное разрешение открывает новые автоматические запуски в области. Подтверждения узлов приходят от каждой ноды отдельно.";

/**
 * The state of the nodes as the screen shows it.
 *
 * A node that reported is «подтверждено», a node that did not is
 * «неизвестно»: the panel never promises what it did not hear.
 */
export function nodeStatusText(node: DisarmNode): { label: string; known: boolean } {
  const status = (node.status ?? "").toLowerCase();
  if (status.includes("unreachable") || status.includes("offline") || status.includes("unavailable")) {
    return { label: "Неизвестно: узел не ответил", known: false };
  }
  if (status.includes("error") || status.includes("failed")) {
    return { label: `Ошибка: ${node.reason ?? status}`, known: true };
  }
  if (status.includes("applied") || status.includes("ok") || status.includes("confirmed")) {
    return { label: `Подтверждено${node.reason ? `: ${node.reason}` : ""}`, known: true };
  }
  return { label: `Неизвестно${node.reason ? `: ${node.reason}` : ""}`, known: false };
}

/** The reason, when the current runs of the area were not stopped. */
export function currentRunsNotice(state: DisarmState | null): string | null {
  if (!state) return null;
  if (state.applied === true) return null;
  const reason = state.reason ?? state.error ?? state.summary;
  if (!reason) return null;
  return `Текущие запуски в этой области не остановлены: ${reason}`;
}

/** The state of the lever, in one line. */
export function leverStateText(state: DisarmState | null): string {
  if (!state) return "Состояние рычага читается…";
  const records = state.records ?? state.state?.records ?? [];
  const forbidden = records.filter((record) => record.forbidden === true);
  if (!forbidden.length) return "Новые автоматические запуски не запрещены.";
  return `Новые автоматические запуски запрещены в областях: ${forbidden.map((record) => record.scope ?? "*").join(", ")}.`;
}

export function StopControl({ onState }: { onState?: (state: DisarmState | null) => void }): React.ReactElement {
  const [scope, setScope] = React.useState("*");
  const [state, setState] = React.useState<DisarmState | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const accept = React.useCallback((body: DisarmState): void => {
    setState(body);
    onState?.(body);
  }, [onState]);

  // Reading the state starts nothing: the panel asks the server and the
  // server reads the durable state of the lever.
  const read = React.useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(DISARM_PANEL_ENDPOINT, { method: "GET" });
      const text = await response.text();
      let body: DisarmState = {};
      try {
        body = text ? JSON.parse(text) as DisarmState : {};
      } catch {
        body = {};
      }
      if (!response.ok) {
        setError(body.error ?? body.summary ?? `сервер ответил ${response.status}`);
        accept(body);
        return;
      }
      setError(null);
      accept(body);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, [accept]);

  React.useEffect(() => { void read(); }, [read]);

  const move = async (forbidden: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(DISARM_PANEL_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The revision of the state the owner read: a state that moved on
          // is a conflict and nothing is written.
          ...(state?.etag ? { "if-match": state.etag } : {}),
        },
        body: JSON.stringify({
          source: "owner",
          scope: scope.trim() || "*",
          forbidden,
          reason: forbidden ? "остановка новых автоматических запусков владельцем из панели" : "разрешение новых автоматических запусков владельцем из панели",
        }),
      });
      const text = await response.text();
      let body: DisarmState = {};
      try {
        body = text ? JSON.parse(text) as DisarmState : {};
      } catch {
        body = {};
      }
      if (!response.ok) {
        setError(body.error ?? body.summary ?? `сервер ответил ${response.status}`);
        accept(body);
        await read();
        return;
      }
      accept(body);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const notice = currentRunsNotice(state);
  const records = state?.records ?? state?.state?.records ?? [];

  return (
    <section className="herder-settings-block" aria-label="Остановка автоматики">
      <h2>Остановка автоматики</h2>
      {/* The state comes first: on a phone the owner sees the state and the
          action before anything else. */}
      <p className="herder-settings-state-line" role="status">{leverStateText(state)}</p>
      <p className="herder-settings-hint">{LEVER_SCOPE_NOTICE}</p>

      <div className="herder-settings-row">
        <label className="herder-settings-field">
          <span>Область</span>
          <input
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            placeholder="* или абсолютный путь проекта"
            aria-label="Область остановки"
          />
        </label>
      </div>
      <div className="herder-settings-actions">
        <button
          type="button"
          className="herder-settings-button herder-settings-button-danger"
          onClick={() => { void move(true); }}
          disabled={busy}
        >
          {busy ? "Применяю…" : "Запретить новые запуски"}
        </button>
        <button
          type="button"
          className="herder-settings-button"
          onClick={() => { void move(false); }}
          disabled={busy}
        >
          Разрешить снова
        </button>
        <button type="button" className="herder-settings-button" onClick={() => { void read(); }} disabled={busy}>
          Обновить состояние
        </button>
      </div>
      <p className="herder-settings-hint">{LEVER_LIFT_NOTICE}</p>

      {error ? <p className="herder-settings-error" role="alert">{error}</p> : null}
      {notice ? <p className="herder-settings-notice" role="status">{notice}</p> : null}
      {state?.summary ? <p className="herder-settings-hint">{state.summary}</p> : null}

      {records.length ? (
        <table className="herder-settings-table">
          <thead>
            <tr><th>Область</th><th>Решение</th><th>Кто и когда</th></tr>
          </thead>
          <tbody>
            {records.map((record, index) => (
              <tr key={`${record.scope ?? "*"}-${index}`}>
                <td><code>{record.scope ?? "*"}</code></td>
                <td>{record.forbidden ? "запрещены" : "разрешены"}</td>
                <td>
                  {record.owner ?? "владелец"}
                  {record.createdAt ? ` · ${record.createdAt}` : ""}
                  {record.reason ? ` · ${record.reason}` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {state?.nodes?.length ? (
        <table className="herder-settings-table">
          <thead>
            <tr><th>Узел</th><th>Состояние</th></tr>
          </thead>
          <tbody>
            {state.nodes.map((node, index) => {
              const status = nodeStatusText(node);
              return (
                <tr key={node.hostId ?? index}>
                  <td>{node.hostId ?? "узел без имени"}</td>
                  <td className={status.known ? "herder-settings-status-known" : "herder-settings-status-unknown"}>{status.label}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      {state && !state.nodes?.length ? (
        <p className="herder-settings-hint">Подтверждений от узлов нет: состояние неизвестно.</p>
      ) : null}
    </section>
  );
}
