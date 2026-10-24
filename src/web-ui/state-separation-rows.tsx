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
 *
 * The fifth row reads the pause from the route that separates the five
 * states. That route answers with every lever apart and the panel takes the
 * one lever it needs from it, so the row says what the route says — «действует»,
 * «не действует» or «состояние неизвестно». The row never says that a route
 * is missing: the route is there and it answers.
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
/** The route that separates the five states: the source of the emergency pause. */
export const STATE_SEPARATION_ENDPOINT = "/api/state-separation";
/** The key of the emergency pause inside the separated view. */
export const NETWORK_PAUSE_KEY = "network_pause";
/** How long a reading may stay on the screen before it is called stale. */
export const STATE_SEPARATION_STALE_MS = 60_000;
/** The Moscow zone: the times of the panel are read in it. */
const MSK = "Europe/Moscow";

/** «активно», «неактивно» or «неизвестно». */
export type SeparationState = "active" | "inactive" | "unknown";

/** One state of the separated view, as the route answers it. */
export interface SeparationDimension {
  key: string;
  title?: string;
  state?: SeparationState;
  active?: boolean;
  known?: boolean;
  source?: string;
  owner?: string;
  reason?: string;
  facts?: Record<string, unknown>;
}

/** The whole separated view, as the route answers it. */
export interface SeparatedStateView {
  ok?: boolean;
  keys?: string[];
  dimensions?: SeparationDimension[];
  activeCount?: number;
  unknown?: string[];
}

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

/** One state of the separated view, by its key. */
export function separationDimension(
  view: SeparatedStateView | null | undefined,
  key: string,
): SeparationDimension | undefined {
  const dimensions = view?.dimensions;
  if (!Array.isArray(dimensions)) return undefined;
  return dimensions.find((dimension) => dimension?.key === key);
}

/**
 * The emergency pause of the notice service, as the owner reads it.
 *
 * The state comes from the route that separates the five states: the panel
 * reads the dimension of the pause and says what the route says. A state the
 * route cannot confirm reads as «состояние неизвестно» and never as
 * «выключено»: a pause that was not seen is not a pause that is off. A route
 * that cannot be reached at all reads as «состояние не прочитано»: the read
 * failed, and the route itself is there.
 */
export function networkPauseRowText(input: {
  view?: SeparatedStateView | null;
  failed?: boolean;
}): string {
  if (input.failed === true) return "состояние не прочитано";
  const view = input.view;
  if (!view) return "состояние читается…";
  const dimension = separationDimension(view, NETWORK_PAUSE_KEY);
  if (!dimension) return "состояние неизвестно";
  if (dimension.known !== true || dimension.state === "unknown") return "состояние неизвестно";
  if (dimension.state === "active" || dimension.active === true) return "аварийная пауза действует";
  if (dimension.state === "inactive" || dimension.active === false) return "аварийная пауза не действует";
  return "состояние неизвестно";
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
 * The separated view of the five states, as the panel reads it.
 *
 * The panel asks the route that separates the states and keeps the answer as
 * it came: the reading of one lever never becomes the reading of another one.
 */
export async function loadStateSeparation(fetchImpl: typeof fetch = fetch): Promise<SeparatedStateView> {
  const response = await fetchImpl(STATE_SEPARATION_ENDPOINT, { cache: "no-store" });
  const body = await response.json() as SeparatedStateView & { error?: string };
  if (!response.ok) throw new Error(body?.error ?? `herder ответил ${response.status}`);
  return body ?? {};
}

/** One row of the block: a lever and what it is now. */
export type SeparationRow = { label: string; value: string };

/**
 * The five rows of the block, each one on its own source.
 *
 * The rows stay five separate rows: the stop of a session, the prohibitions,
 * the runtime of the hooks, the quota guard and the emergency pause are five
 * levers, and one state never speaks for another one.
 */
export function stateSeparationRows(input: {
  held: HeldSession[] | null;
  heldFailed: boolean;
  quota: QuotaGuardPolicy | null;
  quotaFailed: boolean;
  hooksKnown: boolean;
  hooksEnabled: boolean | undefined;
  prohibitionsEnabled: boolean | undefined;
  separation: SeparatedStateView | null;
  separationFailed: boolean;
}): SeparationRow[] {
  return [
    { label: "Остановка сессии", value: sessionStopText(input.held, input.heldFailed) },
    { label: "Запреты хуков", value: prohibitionsRowText(input.prohibitionsEnabled, input.hooksKnown) },
    { label: "Хуки Agent Herder", value: hooksRuntimeRowText(input.hooksEnabled, input.hooksKnown) },
    { label: "Квотный гард", value: quotaGuardRowText(input.quota, input.quotaFailed) },
    {
      label: "Аварийная пауза уведомлений",
      value: networkPauseRowText({ view: input.separation, failed: input.separationFailed }),
    },
  ];
}

/** The moment of the day, as the owner reads the clock. */
export function stateSeparationClockText(when: Date): string {
  const human = when.toLocaleTimeString("ru-RU", { timeZone: MSK, hour: "2-digit", minute: "2-digit", hour12: false });
  return `${human} МСК`;
}

/**
 * When the states were read — and whether that reading is still fresh.
 *
 * The label never promises freshness it cannot prove: a reading older than
 * the threshold is marked as stale, so the owner knows that the screen shows
 * what was true when it was read and not what is true now.
 */
export function stateSeparationReadAtText(readAt: Date | null, now: Date = new Date()): string {
  if (!readAt) return "";
  const clock = stateSeparationClockText(readAt);
  const age = now.getTime() - readAt.getTime();
  if (!Number.isFinite(age) || age < 0) return `Состояния прочитаны в ${clock}`;
  if (age > STATE_SEPARATION_STALE_MS) {
    return `Состояния прочитаны в ${clock} — данные устарели, обновите состояния`;
  }
  return `Состояния прочитаны в ${clock}`;
}

/**
 * The table of the separated states.
 *
 * The table is separate from the reading, so the owner sees the same five
 * rows in the test and in the panel.
 */
export function StateSeparationTable({
  rows,
  readAt = null,
  now = new Date(),
}: {
  rows: SeparationRow[];
  readAt?: Date | null;
  now?: Date;
}): React.ReactElement {
  const readAtText = stateSeparationReadAtText(readAt, now);
  return (
    <>
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
      {/* The sign of the reading: the owner sees when the screen was filled
          and whether what it shows is still fresh. */}
      {readAtText ? <p className="herder-settings-hint" role="status">{readAtText}</p> : null}
    </>
  );
}

/**
 * The block of the separated states.
 *
 * The block reads three sources of its own — the sessions of this machine, the
 * quota guard and the route that separates the states — and takes the state
 * of the hooks from the screen that already read it. Reading starts nothing:
 * no executor runs and no event is written.
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
  const [separation, setSeparation] = React.useState<SeparatedStateView | null>(null);
  const [separationFailed, setSeparationFailed] = React.useState(false);
  const [readAt, setReadAt] = React.useState<Date | null>(null);
  const [now, setNow] = React.useState<Date>(() => new Date());

  const reload = React.useCallback(async (): Promise<void> => {
    let read = false;
    try {
      setHeld(await loadHeldSessions());
      setHeldFailed(false);
      read = true;
    } catch {
      setHeldFailed(true);
    }
    try {
      setQuota(await loadQuotaGuardPolicy());
      setQuotaFailed(false);
      read = true;
    } catch {
      setQuotaFailed(true);
    }
    try {
      setSeparation(await loadStateSeparation());
      setSeparationFailed(false);
      read = true;
    } catch {
      // A route that cannot be reached leaves no old answer on the screen:
      // the row says that the state was not read, and an old fact would be
      // a fact about another moment.
      setSeparation(null);
      setSeparationFailed(true);
    }
    if (read) setReadAt(new Date());
  }, []);

  React.useEffect(() => { void reload(); }, [reload]);

  // The mark of the reading must not go stale in silence: the screen is
  // re-read every ten seconds, so an old reading turns into «данные устарели»
  // without the owner doing anything.
  React.useEffect(() => {
    const timer = window.setInterval(() => { setNow(new Date()); }, 10_000);
    return () => { window.clearInterval(timer); };
  }, []);

  const rows = stateSeparationRows({
    held,
    heldFailed,
    quota,
    quotaFailed,
    hooksKnown,
    hooksEnabled,
    prohibitionsEnabled,
    separation,
    separationFailed,
  });

  return (
    <section className="herder-settings-block" aria-label="Состояния автоматики">
      <h2>Состояния автоматики</h2>
      <p className="herder-settings-hint">
        Пять разных рычагов — их состояния показаны отдельно. Остановка сессии, запреты хуков, рантайм хуков,
        квотный гард и аварийная пауза — это разные вещи; одно состояние не выдаётся за другое.
        Строка «Остановка сессии» читается по списку сессий этой машины, строка «Аварийная пауза уведомлений» —
        по состоянию аварийной паузы на этой машине.
      </p>
      <StateSeparationTable rows={rows} readAt={readAt} now={now} />
      <button type="button" className="herder-settings-button" onClick={() => { void reload(); }}>
        Обновить состояния
      </button>
    </section>
  );
}
