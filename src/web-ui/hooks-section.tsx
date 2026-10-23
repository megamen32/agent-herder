import React from "react";

import "./hooks-section.css";

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
 *
 * Everything the owner reads here is in words of the owner: the column of the
 * prohibition names what it is about, the time of the last firing is the same
 * human time as in the section of the tasks, and the codes of the
 * implementation stay out of sight.
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
  prohibitionsEnabled?: boolean;
  disabledHooks?: HookKind[];
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

/** The Moscow zone: the times of the panel are read in it. */
const MSK = "Europe/Moscow";

/**
 * The moment of the day, as the owner reads the clock.
 *
 * The same human time as in the section of the tasks: «05:12 МСК».
 */
export function hooksClockText(when: Date = new Date()): string {
  const human = when.toLocaleTimeString("ru-RU", { timeZone: MSK, hour: "2-digit", minute: "2-digit", hour12: false });
  return `${human} МСК`;
}

/**
 * The moment of the day, as the owner reads it after a refresh.
 *
 * The button of the refresh owes the owner a sign that it did something.
 */
export function hooksRefreshText(when: Date = new Date()): string {
  return `Обновлено в ${hooksClockText(when)}`;
}

/**
 * The moment of the table, in the human form of the panel.
 *
 * The same format as in the section of the tasks: «23.10.2026, 03:25 МСК».
 */
export function hooksWhenText(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const human = new Date(time).toLocaleString("ru-RU", {
    timeZone: MSK,
    dateStyle: "short",
    timeStyle: "short",
    hour12: false,
  });
  return `${human} МСК`;
}

/**
 * The text of the owner without the codes of the implementation.
 *
 * A raw date, a hash of a document or the name of an unreachable node are
 * not words of the owner: they are replaced with words of the owner.
 */
export function hooksPlainText(text: string | undefined): string {
  if (!text) return "";
  return text
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, (moment) => hooksWhenText(moment) || "время неизвестно")
    .replace(/sha256:[0-9a-f]+/gi, "хэш документа")
    .replace(/direct_peer_unavailable/gi, "не отвечает");
}

/** The name of the owner, as the owner reads it. */
export function hooksActorText(actor: string | undefined): string {
  const name = (actor ?? "").trim();
  if (!name) return "владелец";
  if (name === "owner" || name === "user" || name === "владелец") return "владелец";
  return name;
}

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
 * How the button of the main switch looks.
 *
 * One meaning — one look: the button that turns the prohibitions off is the
 * dangerous one and wears the dangerous colour, the button that turns them
 * back on is safe and wears the safe colour.
 */
export type HooksButtonTone = "danger" | "plain";

export function hooksToggleTone(view: HooksView | null): HooksButtonTone {
  return hooksToggleIntent(view) === "disable" ? "danger" : "plain";
}

/**
 * How the button of the Stop hook looks.
 *
 * The same rule as the main switch: the action that turns a prohibition off
 * is dangerous and looks dangerous.
 */
export function hooksStopTone(view: HooksView | null): HooksButtonTone {
  const disabled = view?.disabledHooks?.includes("Stop") === true;
  return disabled ? "plain" : "danger";
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

/**
 * The state of one hook, as the table shows it.
 *
 * The short form of the state, as it comes from the server.
 */
export function hooksStateLabel(hook: HooksPanelHook): string {
  if (hook.canProhibit === false) return "не запрещает";
  if (hook.state === "неизвестно") return "неизвестно";
  if (hook.state === "выключены") return "выключены";
  return "включены";
}

/**
 * What the hook may forbid, in the words of the owner.
 *
 * The column does not say «включены» alone: it says what is switched on or
 * off, so the owner cannot read it as «всё в порядке».
 */
export function hooksProhibitionText(hook: HooksPanelHook): string {
  if (hook.canProhibit === false) return "Запреты не действуют";
  const state = hooksStateLabel(hook);
  if (state === "неизвестно") return "Неизвестно";
  return state === "выключены" ? "Запреты выключены" : "Запреты включены";
}

/**
 * The state of the Stop hook in the words of the owner.
 *
 * The Stop hook holds the stop of the session, so the owner reads one line:
 * may the session stop or not.
 */
export function hooksStopStatusText(view: HooksView | null): string {
  if (!view || view.known === false) return "Остановка сессии: неизвестно";
  const stop = view.hooks?.find((hook) => hook.kind === "Stop");
  if (stop && stop.canProhibit === false) return "Остановка сессии: разрешена";
  const disabled = view.disabledHooks?.includes("Stop") === true;
  if (view.prohibitionsEnabled === false || disabled) return "Остановка сессии: разрешена";
  return "Остановка сессии: запрещена";
}

/** When the hook ran last, as the server says it. */
export function hooksLastFiredText(hook: HooksPanelHook): string {
  return hook.lastFiredAt ? hook.lastFiredAt : "ещё не срабатывал";
}

/**
 * When the hook ran last, as the owner reads it.
 *
 * The same human time as in the section of the tasks.
 */
export function hooksFiredText(hook: HooksPanelHook): string {
  const raw = hooksLastFiredText(hook);
  if (raw === "ещё не срабатывал") return raw;
  return hooksWhenText(raw) || "время неизвестно";
}

/** The last refusal of the hook, as the table shows it. */
export function hooksLastRefusalText(hook: HooksPanelHook): string {
  const refusal = hook.lastRefusal;
  if (!refusal) return "отказов не было";
  const when = refusal.at ? hooksWhenText(refusal.at) : "время неизвестно";
  const reason = hooksPlainText(refusal.reason) || "причина не названа";
  return `${when} — ${reason}`;
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
  change: { prohibitionsEnabled?: boolean; disabledHooks?: HookKind[]; reason: string },
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
export type PendingAction = { kind: "all"; intent: HooksToggleIntent } | { kind: "stop"; disabled: boolean };

export interface HooksPanelProps {
  view: HooksView | null;
  busy?: boolean;
  error?: { reason: string; hint: string } | null;
  pending?: PendingAction | null;
  /** The sign of the last refresh of the owner. */
  refreshedAt?: string | null;
  onToggleAll?: () => void;
  onToggleStop?: () => void;
  onRefresh?: () => void;
  onConfirm?: () => void;
  onCancel?: () => void;
}

/**
 * The screen of the hooks, as the owner reads it.
 *
 * The screen is separate from the reading of the state, so the owner sees
 * the same screen in the test and in the panel.
 */
export function HooksPanel({
  view,
  busy = false,
  error = null,
  pending = null,
  refreshedAt = null,
  onToggleAll,
  onToggleStop,
  onRefresh,
  onConfirm,
  onCancel,
}: HooksPanelProps): React.ReactElement {
  const intent = hooksToggleIntent(view);
  const hooks = view?.hooks ?? [];
  const stopDisabled = view?.disabledHooks?.includes("Stop") === true;
  const toggleTone = hooksToggleTone(view);
  const stopTone = hooksStopTone(view);

  return (
    <section className="herder-settings-block herder-hooks" aria-label="Хуки">
      <h2>Хуки</h2>
      {/* The state comes first: on a phone the owner sees the state and the
          action before anything else. */}
      <p className="herder-settings-state-line" role="status">{hooksLeverText(view)}</p>
      {/* The Stop hook has its own line: the owner reads whether the session
          may stop, without reading the table. */}
      <p className="herder-hooks-stop-status" role="status">{hooksStopStatusText(view)}</p>
      <p className="herder-settings-hint">
        Хуки — это то, что агент-herder подвешивает к сессии: проверка перед вызовом инструмента и решение, можно ли остановить ход.
        Запрет автоматики и аварийная пауза — другие рычаги, они здесь не меняются.
      </p>

      <div className="herder-settings-actions">
        <button
          type="button"
          className={toggleTone === "danger" ? "herder-settings-button herder-settings-button-danger" : "herder-settings-button"}
          disabled={busy || intent === null}
          onClick={() => { onToggleAll?.(); }}
        >
          {hooksToggleLabel(view)}
        </button>
        <button
          type="button"
          className={stopTone === "danger" ? "herder-settings-button herder-settings-button-danger" : "herder-settings-button"}
          disabled={busy || view?.known === false}
          onClick={() => { onToggleStop?.(); }}
        >
          {hooksStopLabel(view)}
        </button>
        <button type="button" className="herder-settings-button" disabled={busy} onClick={() => { onRefresh?.(); }}>
          Обновить состояние
        </button>
      </div>

      {/* The button of the refresh owes the owner a sign that it did something. */}
      {refreshedAt ? <p className="herder-hooks-refreshed" role="status">{refreshedAt}</p> : null}

      {pending ? (
        <div className="herder-settings-notice" role="status">
          <p>
            {pending.kind === "all"
              ? hooksConfirmText(pending.intent)
              : hooksStopConfirmText(pending.disabled)}
          </p>
          <div className="herder-settings-actions">
            <button type="button" className="herder-settings-button" disabled={busy} onClick={() => { onConfirm?.(); }}>
              {busy ? "Применяю…" : "Да, применить"}
            </button>
            <button type="button" className="herder-settings-button" disabled={busy} onClick={() => { onCancel?.(); }}>
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
        {`Изменил: ${hooksActorText(view?.changedBy)}`}
        {view?.changedAt ? ` · ${hooksWhenText(view.changedAt)}` : ""}
        {view?.reason ? ` · ${hooksPlainText(view.reason)}` : ""}
      </p>

      {/* The table scrolls sideways instead of losing a column, and its
          header stays above the rows while the owner scrolls. */}
      <div className="herder-hooks-table-wrap">
        <table className="herder-settings-table herder-hooks-table">
          <thead>
            <tr><th>Хук</th><th>Что делает</th><th>Что может запрещать</th><th>Когда сработал</th><th>Последний отказ</th></tr>
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
                    <span className="herder-settings-hint">Запрещает: {hooksPlainText(hook.prohibition) || "запрет"}.</span>
                  ) : (
                    <span className="herder-settings-hint">Ничего не запрещает.</span>
                  )}
                </td>
                <td>
                  <span className={hook.state === "неизвестно" ? "herder-settings-status-unknown" : "herder-settings-status-known"}>
                    {hooksProhibitionText(hook)}
                  </span>
                </td>
                <td>{hooksFiredText(hook)}</td>
                <td>
                  <span>{hooksLastRefusalText(hook)}</span>
                  {/* The identifier of the session is a code of the
                      implementation: it stays out of the way until the owner
                      opens it. */}
                  {hook.lastRefusal?.sessionId ? (
                    <details className="herder-settings-details">
                      <summary>Подробности отказа</summary>
                      <span className="herder-settings-hint">Сессия: {hook.lastRefusal.sessionId}</span>
                    </details>
                  ) : null}
                </td>
              </tr>
            ))}
            {!hooks.length ? (
              <tr><td colSpan={5}>Список хуков придёт от herder. Обновите состояние.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

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
                  <td>{record.at ? hooksWhenText(record.at) : "время неизвестно"}</td>
                  <td>{hooksActorText(record.actor)}</td>
                  <td>{hooksPlainText(record.reason) || "причина не названа"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </section>
  );
}

export function HooksSection(): React.ReactElement {
  const [view, setView] = React.useState<HooksView | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{ reason: string; hint: string } | null>(null);
  const [pending, setPending] = React.useState<PendingAction | null>(null);
  const [refreshedAt, setRefreshedAt] = React.useState<string | null>(null);

  const reload = React.useCallback(async (): Promise<boolean> => {
    try {
      setView(await loadHooks());
      setError(null);
      return true;
    } catch (cause) {
      setError(hooksReadErrorText((cause as Error).message));
      return false;
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
  const stopDisabled = view?.disabledHooks?.includes("Stop") === true;

  return (
    <HooksPanel
      view={view}
      busy={busy}
      error={error}
      pending={pending}
      refreshedAt={refreshedAt}
      onToggleAll={() => { setPending({ kind: "all", intent: intent ?? "disable" }); }}
      onToggleStop={() => { setPending({ kind: "stop", disabled: !stopDisabled }); }}
      onRefresh={() => {
        void reload().then((read) => { if (read) setRefreshedAt(hooksRefreshText()); });
      }}
      onConfirm={() => {
        if (!pending) return;
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
      onCancel={() => { setPending(null); }}
    />
  );
}
