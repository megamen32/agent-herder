/**
 * The five states of the product that the panel must never read as one.
 *
 * The stop of one session, the prohibitions, the runtime of the hooks, the
 * quota policy and the emergency network pause of Notice Place are five
 * different levers: they have different owners, different files and different
 * meanings. The panel used to mix them — the stop of a session was read off
 * the prohibitions of the hooks, so one lever spoke for the others.
 *
 * Here every state stands on its own: it has its own key, its own source of
 * reading and its own «active / inactive / unknown». No state is derived from
 * another one, and nothing here writes a lever.
 */

/** The five keys, in the order the owner reads them. */
export const SEPARATION_KEYS = [
  "session_stop",
  "prohibitions",
  "hooks",
  "quota_policy",
  "network_pause",
] as const;

export type SeparationKey = (typeof SEPARATION_KEYS)[number];

/** What each state is, in the words of the owner. */
export const SEPARATION_TITLES: Record<SeparationKey, string> = {
  session_stop: "Остановка конкретной сессии",
  prohibitions: "Запреты (prohibitions)",
  hooks: "Рантайм хуков (hooks)",
  quota_policy: "Квотная политика",
  network_pause: "Сетевая аварийная пауза Notice Place",
};

/** Whose lever each state is. */
export const SEPARATION_OWNERS: Record<SeparationKey, string> = {
  session_stop: "владелец сессии",
  prohibitions: "владелец панели",
  hooks: "владелец панели",
  quota_policy: "владелец панели",
  network_pause: "оператор узла",
};

/** «активно», «неактивно» or «неизвестно». */
export type SeparationState = "active" | "inactive" | "unknown";

/** A fact of one lever: never a secret, only what the owner must read. */
export type SeparationFact = string | number | boolean | string[];

/** One reading of one lever, as it came from its own source. */
export interface SeparationReading {
  /** False when the reading cannot be trusted. */
  known: boolean;
  /** True when this lever is in effect right now. */
  active: boolean;
  /** Where the reading came from. */
  source: string;
  /** Why it reads the way it reads. */
  reason: string;
  /** The facts of the lever, without secrets. */
  facts?: Record<string, SeparationFact>;
}

/** One state, separated. */
export interface SeparationDimension {
  key: SeparationKey;
  title: string;
  state: SeparationState;
  active: boolean;
  known: boolean;
  source: string;
  owner: string;
  reason: string;
  facts: Record<string, SeparationFact>;
}

/** The whole separated view of the five states. */
export interface SeparatedStateView {
  ok: true;
  /** The keys of the dimensions, in the order of the owner. */
  keys: SeparationKey[];
  /** The five dimensions, each one read on its own. */
  dimensions: SeparationDimension[];
  /** How many of the five are in effect right now. */
  activeCount: number;
  /** The keys of the states that cannot be trusted right now. */
  unknown: SeparationKey[];
}

/**
 * Put the five readings together without letting one of them speak for another.
 *
 * A state that was not read is «неизвестно» and never «активно»: an unknown
 * lever must not look like a working one. A state that was read keeps exactly
 * the meaning its own source gave it — the reading of one lever never changes
 * the reading of another one.
 */
export function separateStates(readings: Partial<Record<SeparationKey, SeparationReading>>): SeparatedStateView {
  const dimensions: SeparationDimension[] = SEPARATION_KEYS.map((key) => {
    const reading = readings[key];
    const known = reading?.known === true;
    const active = known && reading?.active === true;
    const state: SeparationState = !known ? "unknown" : active ? "active" : "inactive";
    return {
      key,
      title: SEPARATION_TITLES[key],
      state,
      active,
      known,
      source: reading?.source ?? "не прочитано",
      owner: SEPARATION_OWNERS[key],
      reason: reading?.reason ?? (known ? "" : "состояние не прочитано"),
      facts: reading?.facts ?? {},
    };
  });
  return {
    ok: true,
    keys: [...SEPARATION_KEYS],
    dimensions,
    activeCount: dimensions.filter((dimension) => dimension.active).length,
    unknown: dimensions.filter((dimension) => dimension.state === "unknown").map((dimension) => dimension.key),
  };
}

/** One state of the view, by its key. */
export function separationDimension(view: SeparatedStateView, key: SeparationKey): SeparationDimension | undefined {
  return view.dimensions.find((dimension) => dimension.key === key);
}
