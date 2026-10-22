import { automationDisarmDecision, projectWorkKey, sessionWorkKey, AutomationDisarmStore } from "../automation-disarm/index.js";

/**
 * The machine-readable classes of the refusals of the health contour.
 *
 * A class is a stable ASCII literal, one line per value: an observer counts
 * the refusals without parsing a Russian or an English wording. The wording
 * stays free for the person who reads the log, and the two never replace each
 * other.
 *
 * The dispatcher has its own classes of a routing decision; they live in
 * `project-launch-dispatch.ts`. Only the class of a forbidden automation is
 * shared with it, because it names the same refusal in both places.
 */

/** The owner forbids every automatic run: the lever of the owner is on. */
export const AUTOMATION_DISABLED_CODE = "automation_disabled";

/** The incident has no selected health plan, so no progress of it is accepted. */
export const NO_SELECTED_HEALTH_PLAN_CODE = "no_selected_health_plan";

/** The incident is not open any more, so it accepts no progress at all. */
export const INCIDENT_NOT_OPEN_CODE = "incident_not_open";

/**
 * One refusal of the health contour, with its machine-readable class.
 *
 * The class is what a reader counts; the reason is the wording an operator
 * reads. Neither of them replaces the other.
 */
export interface HealthReasonRefusal {
  /** The stable ASCII class of the refusal. */
  code: string;
  /** The wording of the refusal, unchanged. */
  reason: string;
  /** The session whose observation was refused. */
  sessionId: string;
  /** The incident the refusal belongs to. */
  incidentId: string;
}

/** The decision of the owner-level lever for one automatic run. */
export interface HealthOwnerGateDecision {
  /** False when the run is forbidden. */
  allowed: boolean;
  /** Why the run is forbidden, in the words of the owner state. */
  reason?: string;
}

/**
 * Ask the owner-level lever whether one automatic run may happen.
 *
 * The decision is fail-soft about I/O and fail-closed about meaning: a state
 * that cannot be read is a forbidden state, and the failure never leaves this
 * function, so a broken owner file cannot crash the health contour.
 *
 * The contract of the lever lives in `src/automation-disarm/`: the durable
 * owner state, the decision function and the logical work keys.
 */
export async function healthOwnerGate(options: {
  /** The durable owner state; the store of the runtime by default. */
  store?: AutomationDisarmStore;
  /** The logical work keys of the run, not its session id. */
  workKeys: readonly string[];
}): Promise<HealthOwnerGateDecision> {
  try {
    const decision = await automationDisarmDecision(
      options.store ?? AutomationDisarmStore.forRuntime(),
      options.workKeys,
      "automation",
    );
    return { allowed: decision.allowed, ...(decision.reason ? { reason: decision.reason } : {}) };
  } catch (error) {
    return {
      allowed: false,
      reason: `Состояние запрета автоматики не прочитано: ${(error as Error).message}`,
    };
  }
}

/**
 * The logical work keys of one observed health run.
 *
 * The observer knows the session id, not the name of the launch, so the
 * session key is built from the identity it has; the project key names the
 * work of the incident itself. Both are checked against the keys the owner
 * blocked, so a blocked work stays blocked under a fresh session id.
 */
export function healthWorkKeys(input: {
  harness: string;
  sessionId: string;
  cwd: string;
  project: string;
}): string[] {
  return [
    projectWorkKey(input.project),
    sessionWorkKey(input.harness, input.sessionId, input.cwd),
  ];
}
