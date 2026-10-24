import React from "react";

/**
 * The separated states of the automation of the herder.
 *
 * Five different levers live in the product, and the owner reads them apart:
 * the stop of a session, the prohibitions of the hooks, the runtime of the
 * hooks, the quota guard of Codex and the emergency pause of the notice
 * service. One line that mixes them says the wrong thing: a lever that is
 * off is not a session that may stop, and a held session is not a lever.
 *
 * Every row of this block names its own source and reads the state from the
 * source that owns it. A state that cannot be read reads as «не прочитано»,
 * never as «выключено»: the panel never promises a state it did not see.
 */

export type HeldSession = { id: string; harness: string; title?: string };

export type QuotaGuardPolicy = {
  enabled?: boolean;
  minRemainingPercent?: number;
  onUnknown?: string;
};

/** The sessions of this machine: the source of the held sessions. */
export const SESSIONS_ENDPOINT = "/api/sessions?quick=1&limit=100";
/** The quota guard of Codex: the source of the quota policy. */
export const QUOTA_GUARD_ENDPOINT = "/api/codex-quota-guard";

/** The stop of the sessions, as the owner reads it. */
export function sessionStopText(held: HeldSession[] | null, failed: boolean): string {
  if (failed) return "состояние не прочитано";
  if (!held) return "состояние читается…";
  if (held.length === 0) return "остановленных сессий в списке нет";
  const names = held.slice(0, 5).map((session) => session.title?.trim() || `${session.harness}:${session.id.slice(0, 8)}`);
  const rest = held.length > names.length ? ` и ещё ${held.length - names.length}` : "";
  return `остановлено сессий: ${held.length} (${names.join(", ")}${rest})`;
}

/** The prohibitions of the hooks, as the owner reads them. */
export function prohibitionsRowText(enabled: boolean | undefined, known: boolean): string {
  if (!known) return "состояние неизвестно";
  return enabled === true ? "запреты включены" : "запреты выключены";
}

/** The runtime of the hooks, as the owner reads it. */
export function hooksRuntimeRowText(enabled: boolean | undefined, known: boolean): string {
  if (!known) return "состояние неизвестно";
  return enabled === true ? "хуки Agent Herder выполняются" : "хуки Agent Herder выключены";
}

/** The quota guard of Codex, as the owner reads it. */
export function quotaGuardRowText(policy: QuotaGuardPolicy | null, failed: boolean): string {
  if (failed) return "состояние не прочитано";
  if (!policy) return "состояние читается…";
  if (policy.enabled !== true) return "выключен";
  const threshold = typeof policy.minRemainingPercent === "number"
    ? `порог ${policy.minRemainingPercent} %`
    : "порог не назван";
  const unknown = policy.onUnknown
    ? `при неизвестной квоте — ${policy.onUnknown}`
    : "при неизвестной квоте — правило не названо";
  return `включён, ${threshold}, ${unknown}`;
}

/**
 * The emergency pause of the notice service.
 *
 * The panel has no route that reads the state of the pause: the unit of the
 * pause lives on the machine, and the route that separates the states is not
 * in the panel yet. The row says so instead of promising a state it did not
 * see.
 */
export function networkPauseRowText(): string {
  return "панель не читает состояние паузы: нужен маршрут разделения состояний (/api/state-separation)";
}

type SessionRow = { id?: string; harness?: string; title?: string; meta?: { humanStopHeld?: boolean } };

/** The held sessions of this machine, as the list of the owner reads it. */
export async function loadHeldSessions(fetchImpl: typeof fetch = fetch): Promise<HeldSession[]> {
  const response = await fetchImpl(SESSIONS_ENDPOINT, { cache: "no-store" });
  const body = await response.json() as { sessions?: SessionRow[]; error?: string };
  if (!response.ok) throw new Error(body?.error ?? `herder ответил ${response.status}`);
  const sessions = Array.isArray(body?.sessions) ? body.sessions : [];
  return sessions
    .filter((session) => session?.meta?.humanStopHeld === true)
    .map((session) => ({ id: String(session.id ?? ""), harness: String(session.harness ?? ""), title: session.title }));
}

/** The quota guard of Codex, as the panel reads it. */
export async function loadQuotaGuardPolicy(fetchImpl: typeof fetch = fetch): Promise<QuotaGuardPolicy> {
  const response = await fetchImpl(QUOTA_GUARD_ENDPOINT, { cache: "no-store" });
  const body = await response.json() as { policy?: QuotaGuardPolicy; error?: string };
  if (!response.ok) throw new Error(body?.error ?? `herder ответил ${response.status}`);
  return body?.policy ?? {};
}

/**
 * The block of the separated states.
 *
 * The block reads two sources of its own — the sessions of this machine and
 * the quota guard — and takes the state of the hooks from the screen that
 * already read it. Reading starts nothing: no executor runs and no event is
 * written.
 */
export function StateSeparationRows({
  hooksKnown,
  hooksEnabled,
  prohibitionsEnabled,
}: {
  hooksKnown: boolean;
  hooksEnabled: boolean | undefined;
  prohibitionsEnabled: boolean | undefined;
}): React.ReactElement {
  const [held, setHeld] = React.useState<HeldSession[] | null>(null);
  const [heldFailed, setHeldFailed] = React.useState(false);
  const [quota, setQuota] = React.useState<QuotaGuardPolicy | null>(null);
  const [quotaFailed, setQuotaFailed] = React.useState(false);

  const reload = React.useCallback(async (): Promise<void> => {
    try {
      setHeld(await loadHeldSessions());
      setHeldFailed(false);
    } catch {
      setHeldFailed(true);
    }
    try {
      setQuota(await loadQuotaGuardPolicy());
      setQuotaFailed(false);
    } catch {
      setQuotaFailed(true);
    }
  }, []);

  React.useEffect(() => { void reload(); }, [reload]);

  const rows: Array<{ label: string; value: string }> = [
    { label: "Остановка сессии", value: sessionStopText(held, heldFailed) },
    { label: "Запреты хуков", value: prohibitionsRowText(prohibitionsEnabled, hooksKnown) },
    { label: "Хуки Agent Herder", value: hooksRuntimeRowText(hooksEnabled, hooksKnown) },
    { label: "Квотный гард", value: quotaGuardRowText(quota, quotaFailed) },
    { label: "Аварийная пауза уведомлений", value: networkPauseRowText() },
  ];

  return (
    <section className="herder-settings-block" aria-label="Состояния автоматики">
      <h2>Состояния автоматики</h2>
      <p className="herder-settings-hint">
        Пять разных рычагов — их состояния показаны отдельно. Остановка сессии, запреты хуков, рантайм хуков,
        квотный гард и аварийная пауза — это разные вещи; одно состояние не выдаётся за другое.
        Строка «Остановка сессии» читается по списку сессий этой машины.
      </p>
      <table className="herder-settings-table">
        <thead>
          <tr><th>Состояние</th><th>Как оно есть</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td><strong>{row.label}</strong></td>
              <td>{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="herder-settings-button" onClick={() => { void reload(); }}>
        Обновить состояния
      </button>
    </section>
  );
}
