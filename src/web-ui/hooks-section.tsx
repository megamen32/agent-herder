import React from "react";

/**
 * The section of the hooks of the product.
 *
 * The owner came here because the hooks get in the way: the Stop hook keeps
 * a turn going and the hook before a tool call may refuse the call. The
 * section shows what each hook does, whether it may still forbid something,
 * when it ran last and what it refused last.
 *
 * The main switch moves the prohibitions of every hook at once, and the
 * second action moves the prohibitions of the Stop hook alone — the hook the
 * owner named. Both actions ask for a confirmation that says exactly what
 * changes, and the confirmation names what does not change: the automation
 * lever and the emergency pause are different levers and are not touched
 * here.
 *
 * The screen is honest about the state: a lever that cannot be read reads as
 * «состояние неизвестно», never as «выключено».
 */

export type HookKind = "Stop" | "PreToolUse" | "PostToolUse" | "SessionStart" | "UserPromptSubmit";

export interface HooksRefusal {
  at?: string;
  reason?: string;
  sessionId?: string;
  harness?: string;
}

export interface HooksPanelHook {
  kind: HookKind;
  humanName?: string;
  purpose?: string;
  scope?: string;
  canProhibit?: boolean;
  prohibition?: string;
  state?: string;
  lastFiredAt?: string;
  lastRefusal?: HooksRefusal;
}

export interface HooksView {
  ok?: boolean;
  /** False when the state of the lever cannot be trusted. */
  known?: boolean;
  /** True when the optional hooks runtime of the herder runs at all. */
  hooksEnabled?: boolean;
  prohibitionsEnabled?: boolean;
  disabledHooks?: HookKind[];
  /** The hooks that do not run at all, even when the runtime is on. */
  inactiveHooks?: HookKind[];
  changedBy?: string;
  changedAt?: string;
  reason?: string;
  etag?: string;
  hooks?: HooksPanelHook[];
  /** The journal of the changes of the lever. */
  audit?: Array<{ at?: string; actor?: string; reason?: string }>;
  error?: string;
}

/** The endpoint the panel asks for the state of the hooks. */
export const HOOKS_ENDPOINT = "/api/hooks";

/** The endpoint the panel asks to move the lever of the owner. */
export const HOOKS_PROHIBITIONS_ENDPOINT = "/api/hooks/prohibitions";

/** What the owner may change: every prohibition at once. */
export type HooksToggleIntent = "disable" | "enable";

/** The state of the lever, in one line, as the owner reads it. */
export function hooksLeverText(view: HooksView | null): string {
  if (!view) return "Состояние запретов хуков читается…";
  if (view.known === false) {
    return "Состояние запретов хуков неизвестно: herder не ответил или файл состояния повреждён. Пока состояние неизвестно, хуки ничего не запрещают.";
  }
  if (view.prohibitionsEnabled === false) {
    return "Запреты хуков выключены: хуки не отказывают в вызове инструментов и не держат ход.";
  }
  return "Запреты хуков включены: хуки могут отказывать в вызове инструментов и не давать сессии остановиться.";
}

/** What the main switch will do, as the owner reads the button. */
export function hooksToggleIntent(view: HooksView | null): HooksToggleIntent | null {
  if (!view || view.known === false) return null;
  return view.prohibitionsEnabled === false ? "enable" : "disable";
}

/** The name of the main switch, in the state it is now. */
export function hooksToggleLabel(view: HooksView | null): string {
  const intent = hooksToggleIntent(view);
  if (intent === "disable") return "Выключить запреты хуков";
  if (intent === "enable") return "Включить запреты хуков";
  return "Обновить состояние";
}

/**
 * What the switch changes, in the exact words of the confirmation.
 *
 * The confirmation says what changes and what does not: the automation lever
 * and the emergency pause are not touched by this switch.
 */
export function hooksConfirmText(intent: HooksToggleIntent): string {
  if (intent === "disable") {
    return "Выключить запреты хуков? Хуки перестанут отказывать в вызове инструментов и останавливать ход; запрет автоматики и аварийная пауза не затрагиваются.";
  }
  return "Включить запреты хуков? Хуки снова смогут отказывать в вызове инструментов и не давать сессии остановиться; запрет автоматики и аварийная пауза не затрагиваются.";
}

/** What the action of the Stop hook alone changes. */
export function hooksStopConfirmText(disabled: boolean): string {
  if (disabled) {
    return "Выключить запреты только у хука Stop? Этот хук перестанет продолжать ход и держать сессию; остальные хуки, запрет автоматики и аварийная пауза не затрагиваются.";
  }
  return "Включить запреты только у хука Stop? Этот хук снова сможет продолжать ход и держать сессию; остальные хуки, запрет автоматики и аварийная пауза не затрагиваются.";
}

/** The name of the action of the Stop hook alone. */
export function hooksStopLabel(view: HooksView | null): string {
  const disabled = view?.disabledHooks?.includes("Stop") === true;
  return disabled ? "Включить запреты у Stop-хука" : "Выключить запреты у Stop-хука";
}

/** The state of one hook, as the table shows it. */
export function hooksStateLabel(hook: HooksPanelHook): string {
  if (hook.canProhibit === false) return "не запрещает";
  if (hook.state === "неизвестно") return "неизвестно";
  if (hook.state === "выключены") return "выключены";
  return "включены";
}

/** When the hook ran last, as the table shows it. */
export function hooksLastFiredText(hook: HooksPanelHook): string {
  return hook.lastFiredAt ? hook.lastFiredAt : "ещё не срабатывал";
}

/** The last refusal of the hook, as the table shows it. */
export function hooksLastRefusalText(hook: HooksPanelHook): string {
  const refusal = hook.lastRefusal;
  if (!refusal) return "отказов не было";
  const when = refusal.at ? refusal.at : "время неизвестно";
  const reason = refusal.reason ? refusal.reason : "причина не названа";
  const session = refusal.sessionId ? ` (сессия ${refusal.sessionId})` : "";
  return `${when} — ${reason}${session}`;
}

/**
 * The failure of a change, in the words of the owner.
 *
 * The screen says what happened and what to do about it: the reason comes
 * first, the way out second, and neither of them uses the words of the
 * implementation.
 */
export function hooksErrorText(error: string, status?: number): { reason: string; hint: string } {
  if (status === 401 || status === 403) {
    return {
      reason: `Запреты хуков не изменены: ${error}`,
      hint: "Что делать: войдите в кабинет владельца и повторите действие.",
    };
  }
  if (status === 409 || status === 412) {
    return {
      reason: `Запреты хуков не изменены: ${error}`,
      hint: "Что делать: обновите раздел «Хуки» и повторите действие — состояние уже изменилось в другой вкладке.",
    };
  }
  if (status === 400) {
    return {
      reason: `Запреты хуков не изменены: ${error}`,
      hint: "Что делать: проверьте, что выбраны настоящие хуки, и повторите действие.",
    };
  }
  return {
    reason: `Запреты хуков не изменены: ${error}`,
    hint: "Что делать: проверьте, что herder запущен и отвечает, и повторите действие.",
  };
}

/** The state of the read, as the owner reads it. */
export function hooksReadErrorText(error: string): { reason: string; hint: string } {
  return {
    reason: `Не удалось прочитать состояние запретов хуков: ${error}`,
    hint: "Что делать: проверьте, что herder запущен, и нажмите «Обновить состояние». Пока состояние неизвестно, хуки ничего не запрещают.",
  };
}

/** The reason of the change, as it goes into the journal of the owner. */
export function hooksChangeReason(intent: HooksToggleIntent | "stop-disable" | "stop-enable"): string {
  if (intent === "disable") return "выключение запретов хуков владельцем из панели";
  if (intent === "enable") return "включение запретов хуков владельцем из панели";
  if (intent === "stop-disable") return "выключение запрета Stop-хука владельцем из панели";
  return "включение запрета Stop-хука владельцем из панели";
}

/** Read the state of the hooks. */
export async function loadHooks(): Promise<HooksView> {
  const response = await fetch(HOOKS_ENDPOINT, { cache: "no-store" });
  const text = await response.text();
  let body: HooksView = {};
  try {
    body = text ? JSON.parse(text) as HooksView : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    const failure = new Error(body.error ?? `herder ответил ${response.status}`);
    (failure as Error & { status?: number }).status = response.status;
    throw failure;
  }
  return body;
}

/** Move the lever of the owner. */
export async function saveHooksProhibitions(
  change: { prohibitionsEnabled?: boolean; disabledHooks?: HookKind[]; hooksEnabled?: boolean; inactiveHooks?: HookKind[]; reason: string },
  etag?: string,
): Promise<HooksView> {
  const response = await fetch(HOOKS_PROHIBITIONS_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(etag ? { "if-match": etag } : {}),
    },
    body: JSON.stringify({ source: "owner", actor: "owner", ...change }),
  });
  const text = await response.text();
  let body: HooksView = {};
  try {
    body = text ? JSON.parse(text) as HooksView : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    const failure = new Error(body.error ?? `herder ответил ${response.status}`);
    (failure as Error & { status?: number }).status = response.status;
    throw failure;
  }
  return body;
}

/** What the owner is about to confirm. */
type PendingAction = { kind: "all"; intent: HooksToggleIntent } | { kind: "stop"; disabled: boolean };

export function HooksSection(): React.ReactElement {
  const [view, setView] = React.useState<HooksView | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{ reason: string; hint: string } | null>(null);
  const [pending, setPending] = React.useState<PendingAction | null>(null);

  const reload = React.useCallback(async (): Promise<void> => {
    try {
      setView(await loadHooks());
      setError(null);
    } catch (cause) {
      setError(hooksReadErrorText((cause as Error).message));
    }
  }, []);

  // Reading the state starts nothing: the panel asks the server.
  React.useEffect(() => { void reload(); }, [reload]);

  const apply = async (change: { prohibitionsEnabled?: boolean; disabledHooks?: HookKind[]; reason: string }): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setView(await saveHooksProhibitions(change, view?.etag));
      setPending(null);
    } catch (cause) {
      setError(hooksErrorText((cause as Error).message, (cause as Error & { status?: number }).status));
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const intent = hooksToggleIntent(view);
  const hooks = view?.hooks ?? [];
  const stopDisabled = view?.disabledHooks?.includes("Stop") === true;

  return (
    <section className="herder-settings-block" aria-label="Хуки">
      <h2>Хуки</h2>
      {/* The state comes first: on a phone the owner sees the state and the
          action before anything else. */}
      <p className="herder-settings-state-line" role="status">{hooksLeverText(view)}</p>
      <p className="herder-settings-hint">
        Хуки — это то, что агент-herder подвешивает к сессии: проверка перед вызовом инструмента и решение, можно ли остановить ход.
        Запрет автоматики и аварийная пауза — другие рычаги, они здесь не меняются.
      </p>

      <div className="herder-settings-actions">
        <button
          type="button"
          className={intent === "enable" ? "herder-settings-button" : "herder-settings-button herder-settings-button-danger"}
          disabled={busy || intent === null}
          onClick={() => { setPending({ kind: "all", intent: intent ?? "disable" }); }}
        >
          {hooksToggleLabel(view)}
        </button>
        <button
          type="button"
          className="herder-settings-button"
          disabled={busy || view?.known === false}
          onClick={() => { setPending({ kind: "stop", disabled: !stopDisabled }); }}
        >
          {hooksStopLabel(view)}
        </button>
        <button type="button" className="herder-settings-button" disabled={busy} onClick={() => { void reload(); }}>
          Обновить состояние
        </button>
      </div>

      {pending ? (
        <div className="herder-settings-notice" role="status">
          <p>
            {pending.kind === "all"
              ? hooksConfirmText(pending.intent)
              : hooksStopConfirmText(pending.disabled)}
          </p>
          <div className="herder-settings-actions">
            <button
              type="button"
              className="herder-settings-button"
              disabled={busy}
              onClick={() => {
                if (pending.kind === "all") {
                  void apply({
                    prohibitionsEnabled: pending.intent === "enable",
                    reason: hooksChangeReason(pending.intent),
                  });
                  return;
                }
                const disabledHooks: HookKind[] = (view?.disabledHooks ?? []).filter((kind) => kind !== "Stop");
                if (pending.disabled) disabledHooks.push("Stop");
                void apply({
                  disabledHooks,
                  reason: hooksChangeReason(pending.disabled ? "stop-disable" : "stop-enable"),
                });
              }}
            >
              {busy ? "Применяю…" : "Да, применить"}
            </button>
            <button type="button" className="herder-settings-button" disabled={busy} onClick={() => { setPending(null); }}>
              Отмена
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <>
          <p className="herder-settings-error" role="alert">{error.reason}</p>
          <p className="herder-settings-hint">{error.hint}</p>
        </>
      ) : null}

      <p className="herder-settings-hint">
        {view?.changedBy ? `Изменил: ${view.changedBy}` : "Изменил: владелец"}
        {view?.changedAt ? ` · ${view.changedAt}` : ""}
        {view?.reason ? ` · ${view.reason}` : ""}
      </p>

      <table className="herder-settings-table">
        <thead>
          <tr><th>Хук</th><th>Что делает</th><th>Состояние</th><th>Когда сработал</th><th>Последний отказ</th></tr>
        </thead>
        <tbody>
          {hooks.map((hook) => (
            <tr key={hook.kind}>
              <td>
                <strong>{hook.humanName ?? hook.kind}</strong>
                <span className="herder-settings-hint">{hook.scope ?? ""}</span>
              </td>
              <td>
                {hook.purpose ?? ""}
                {hook.canProhibit ? (
                  <span className="herder-settings-hint">Может запрещать: {hook.prohibition ?? "запрет"}.</span>
                ) : (
                  <span className="herder-settings-hint">Запретов не ставит.</span>
                )}
              </td>
              <td>
                <span className={hook.state === "неизвестно" ? "herder-settings-status-unknown" : "herder-settings-status-known"}>
                  {hooksStateLabel(hook)}
                </span>
              </td>
              <td>{hooksLastFiredText(hook)}</td>
              <td>{hooksLastRefusalText(hook)}</td>
            </tr>
          ))}
          {!hooks.length ? (
            <tr><td colSpan={5}>Список хуков придёт от herder. Обновите состояние.</td></tr>
          ) : null}
        </tbody>
      </table>

      {view?.audit?.length ? (
        <details className="herder-settings-details">
          <summary>Журнал изменений запретов ({view.audit.length})</summary>
          <table className="herder-settings-table">
            <thead>
              <tr><th>Когда</th><th>Кто</th><th>Причина</th></tr>
            </thead>
            <tbody>
              {[...view.audit].reverse().map((record, index) => (
                <tr key={`${record.at ?? index}`}>
                  <td>{record.at ?? "время неизвестно"}</td>
                  <td>{record.actor ?? "владелец"}</td>
                  <td>{record.reason ?? "причина не названа"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </section>
  );
}
