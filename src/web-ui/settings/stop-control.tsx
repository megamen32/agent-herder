import React from "react";

/**
 * The button that stops the automation of the owner.
 *
 * The lever itself is the existing one: the state of the lever is durable,
 * it survives a restart and it is confirmed across the fleet nodes. The
 * panel asks the server to move it on behalf of the owner: the token of the
 * lever never reaches the browser.
 *
 * The screen shows what the nodes confirmed. A node that did not answer is
 * shown as unknown, never as "включено" or "выключено".
 */

export type DisarmNode = { hostId?: string; status?: string; reason?: string; applied?: boolean };

export type DisarmState = {
  ok?: boolean;
  applied?: boolean;
  scope?: string;
  forbidden?: boolean;
  disarmed?: boolean;
  state?: unknown;
  records?: unknown[];
  nodes?: DisarmNode[];
  summary?: string;
  etag?: string;
  error?: string;
  reason?: string;
};

export type DisarmMode = "stop_new" | "stop_new_and_current";

/** The endpoint the panel asks: the server moves the lever on behalf of the owner. */
export const DISARM_PANEL_ENDPOINT = "/api/settings/automation/disarm";

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

export function StopControl({ onState }: { onState?: (state: DisarmState | null) => void }): React.ReactElement {
  const [scope, setScope] = React.useState("*");
  const [mode, setMode] = React.useState<DisarmMode>("stop_new");
  const [busy, setBusy] = React.useState(false);
  const [state, setState] = React.useState<DisarmState | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const move = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(DISARM_PANEL_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: scope.trim() || "*", mode, reason: "остановка автоматики владельцем из панели" }),
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
        setState(body);
        onState?.(body);
        return;
      }
      setState(body);
      onState?.(body);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const notice = currentRunsNotice(state);

  return (
    <section className="herder-settings-block" aria-label="Остановка автоматики">
      <h2>Остановка автоматики</h2>
      <p className="herder-settings-hint">
        Рычаг запрещает новые автоматические запуски в области. Права проверяет сервер: токен рычага в браузере не появляется.
      </p>
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
        <fieldset className="herder-settings-modes">
          <legend>Режим</legend>
          <label>
            <input type="radio" name="herder-disarm-mode" value="stop_new" checked={mode === "stop_new"} onChange={() => setMode("stop_new")} />
            Не запускать новые, текущим дать завершиться
          </label>
          <label>
            <input type="radio" name="herder-disarm-mode" value="stop_new_and_current" checked={mode === "stop_new_and_current"} onChange={() => setMode("stop_new_and_current")} />
            Остановить новые и текущие
          </label>
        </fieldset>
      </div>
      <button type="button" className="herder-settings-button herder-settings-button-danger" onClick={() => { void move(); }} disabled={busy}>
        {busy ? "Применяю…" : "Остановить автоматику"}
      </button>
      {error ? <p className="herder-settings-error" role="alert">{error}</p> : null}
      {notice ? <p className="herder-settings-notice" role="status">{notice}</p> : null}
      {state?.summary ? <p className="herder-settings-hint">{state.summary}</p> : null}
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
