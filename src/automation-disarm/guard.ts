import type { AutomationDisarmStore } from "./state.js";

/** The reason an automatic run is refused because the global lever is on. */
export const AUTOMATION_DISARMED_MESSAGE =
  "Автоматический запуск запрещён владельцем: автоматика отключена до явного действия владельца.";

/** The reason an automatic run is refused because this work is blocked. */
export const AUTOMATION_WORK_DISARMED_MESSAGE =
  "Автоматический запуск этой работы запрещён владельцем: работа заблокирована по логическому ключу, а не по id сессии.";

/**
 * Who starts a run.
 *
 * `human` is work a person started explicitly, `explicit` is an explicit call
 * of the session-creation tool for one concrete session, and `automation` is
 * every automatic path. The lever only ever refuses `automation`.
 */
export type AutomationLaunchSource = "human" | "explicit" | "automation";

export interface AutomationDisarmDecision {
  allowed: boolean;
  /** Why the run was refused. */
  code?: "automation_disarmed" | "work_disarmed";
  reason?: string;
  /** The logical work key the refusal was made on. */
  workKey?: string;
}

/**
 * Decide whether one run may start, resolving the work keys only when they
 * can matter.
 *
 * The work key of a session is only known from a native read, so the resolver
 * is called only when the owner actually blocked a work. A runtime that is
 * armed and has no blocked work costs no native call at all, and a guard
 * placed before an admission check never changes what that check observes.
 */
export async function automationDisarmDecisionWithWork(
  store: AutomationDisarmStore,
  resolveWorkKeys: () => Promise<string[]>,
  source: AutomationLaunchSource,
): Promise<AutomationDisarmDecision> {
  if (source !== "automation") return { allowed: true };
  const state = await store.read();
  if (state.disarmed) {
    return {
      allowed: false,
      code: "automation_disarmed",
      reason: state.reason ? `${AUTOMATION_DISARMED_MESSAGE} Причина: ${state.reason}` : AUTOMATION_DISARMED_MESSAGE,
    };
  }
  if (state.blockedWorkKeys.length === 0) return { allowed: true };
  const workKeys = await resolveWorkKeys();
  const blocked = workKeys.find((key) => state.blockedWorkKeys.includes(key));
  if (blocked) {
    return { allowed: false, code: "work_disarmed", reason: AUTOMATION_WORK_DISARMED_MESSAGE, workKey: blocked };
  }
  return { allowed: true };
}

/**
 * Decide whether one run may start.
 *
 * The decision is fail-closed for automation: a disarmed runtime refuses every
 * automatic run, and a runtime whose owner file cannot be trusted refuses
 * every automatic run too. A human-started or explicitly created session is
 * never refused, so the lever is not a "stop everything" switch.
 *
 * `workKeys` are the logical identities of the run, not its session id.
 */
export async function automationDisarmDecision(
  store: AutomationDisarmStore,
  workKeys: readonly string[],
  source: AutomationLaunchSource,
): Promise<AutomationDisarmDecision> {
  if (source !== "automation") return { allowed: true };
  const state = await store.read();
  if (state.disarmed) {
    return {
      allowed: false,
      code: "automation_disarmed",
      reason: state.reason ? `${AUTOMATION_DISARMED_MESSAGE} Причина: ${state.reason}` : AUTOMATION_DISARMED_MESSAGE,
    };
  }
  const blocked = workKeys.find((key) => state.blockedWorkKeys.includes(key));
  if (blocked) {
    return { allowed: false, code: "work_disarmed", reason: AUTOMATION_WORK_DISARMED_MESSAGE, workKey: blocked };
  }
  return { allowed: true };
}
