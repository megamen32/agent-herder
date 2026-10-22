import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { automationDisarmDecision, projectWorkKey, sessionWorkKey, AutomationDisarmStore, AUTOMATION_FORBIDDEN_CODE, ALL_SCOPES, type AutomationDisarmDecision } from "../automation-disarm/index.js";

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
  /**
   * The area of the refusal, as a structured value beside the class.
   *
   * The code names the class of the refusal; this field names where it
   * happened: the canonical path of the scope that refused, or the catch-all
   * scope of the whole contour. The area is never carried by the wording
   * alone, so a reader tells one project from another without reading it.
   */
  detail?: string;
  /** The logical work key the refusal was made on. */
  workKey?: string;
  /** The harness of the refused run. */
  harness?: string;
}

/** The decision of the owner-level lever for one automatic run. */
export interface HealthOwnerGateDecision {
  /** False when the run is forbidden. */
  allowed: boolean;
  /** Why the run is forbidden, in the words of the owner state. */
  reason?: string;
  /**
   * The stable ASCII class of the disarm decision itself.
   *
   * The lever refuses in two ways: the whole automation is forbidden, or one
   * concrete work is blocked. The class of the decision tells the two apart
   * without reading the wording of the reason.
   */
  disarmCode?: AutomationDisarmDecision["code"];
  /**
   * The area of the refusal, in the canonical form of the scope.
   *
   * The owner lever names the area beside the class: the path of the scope
   * that refused, or the catch-all scope for the whole automation.
   */
  routingReasonDetail?: string;
  /** The logical work key the refusal was made on. */
  workKey?: string;
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
    return {
      allowed: decision.allowed,
      ...(decision.reason ? { reason: decision.reason } : {}),
      // The class of the decision travels with the wording: a reader counts the
      // refusals by the class and never parses the reason.
      ...(decision.code ? { disarmCode: decision.code } : {}),
      // The area travels beside the class, never inside the wording.
      ...(decision.routingReasonDetail ? { routingReasonDetail: decision.routingReasonDetail } : {}),
      ...(decision.workKey ? { workKey: decision.workKey } : {}),
    };
  } catch (error) {
    return {
      allowed: false,
      reason: `Состояние запрета автоматики не прочитано: ${(error as Error).message}`,
      // A state that cannot be read is the global lever, so the class of the
      // decision is the class of the global lever and the area is the area of
      // the whole contour.
      disarmCode: AUTOMATION_FORBIDDEN_CODE,
      routingReasonDetail: ALL_SCOPES,
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

/**
 * The durable trail of the refusals of the health contour.
 *
 * The trail lives in the state directory of the runtime, beside the owner
 * state of the lever. It is a trail and not a gate: a failed write never
 * fails the contour.
 */
export function healthRefusalAuditPath(stateDir: string): string {
  return join(stateDir, "health-refusals.audit.jsonl");
}

/**
 * Append one refusal to the durable trail.
 *
 * The record is one JSON object per line: a reader counts the refusals by
 * their code with a JSON reader and never parses the wording.
 */
export async function appendHealthRefusalAudit(path: string, refusal: HealthReasonRefusal): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...refusal })}\n`, { mode: 0o600 });
  } catch {
    // The trail must never break the health contour.
  }
}
