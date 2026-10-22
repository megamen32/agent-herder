import { readFile } from "node:fs/promises";
import { parseNoticeIncident, type HealthPlanId, type NoticeIncidentBinding } from "../autopilot/notice-incident.js";
import { AUTOMATION_DISABLED_CODE, NO_SELECTED_HEALTH_PLAN_CODE, healthOwnerGate, healthWorkKeys, type HealthReasonRefusal } from "./health-reason-codes.js";

/** One armed session of the durable autopilot store that carries an incident binding. */
export interface NoticeplaceHealthRecoveryCandidate {
  harness: string;
  sessionId: string;
  cwd: string;
  binding: NoticeIncidentBinding;
}

export interface NoticeplaceHealthRecoveryResult {
  /** Sessions that were armed again after the restart. */
  armed: number;
  /** Sessions that were skipped: not alive, no plan, or no observation slot. */
  skipped: number;
  /** Why each skipped session was skipped, for the operator's log. */
  reasons: string[];
  /**
   * The refusals of the recovery with their machine-readable class.
   *
   * The reasons are the wording an operator reads; these records are what a
   * reader counts, so the class of a refusal never has to be parsed out of a
   * free text.
   */
  refusals: HealthReasonRefusal[];
}

/**
 * The armed sessions of the durable autopilot store.
 *
 * The store keeps the original incident binding of every armed session, so a
 * restart of herder does not need the center to repeat its arming call: the
 * binding is the evidence that the session was armed for that incident.
 */
export async function readArmedHealthCandidates(path: string): Promise<NoticeplaceHealthRecoveryCandidate[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const sessions = (parsed as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return [];
  const candidates: NoticeplaceHealthRecoveryCandidate[] = [];
  for (const entry of sessions) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    // Only an explicitly armed session is observed: a reset record keeps the
    // incident binding but no longer asks for autopilot.
    if (record.enabled !== true) continue;
    if (typeof record.harness !== "string" || typeof record.sessionId !== "string" || typeof record.cwd !== "string") continue;
    if (!record.noticeIncident) continue;
    let binding: NoticeIncidentBinding;
    try {
      binding = parseNoticeIncident(record.noticeIncident);
    } catch {
      continue;
    }
    candidates.push({ harness: record.harness, sessionId: record.sessionId, cwd: record.cwd, binding });
  }
  return candidates;
}

/**
 * Arm the observation again for the sessions that are still alive.
 *
 * The candidates are armed in small batches: a restart with hundreds of armed
 * sessions must not turn into a burst of native reads against the harness.
 *
 * A candidate whose record does not carry the selected plan is armed only when
 * the plan of its launch is known: the center accepts the progress of one
 * selected plan, so a guessed plan would only produce refused publications.
 */
export async function recoverNoticeplaceHealthObservation(options: {
  candidates: NoticeplaceHealthRecoveryCandidate[];
  /** The native session still exists and is not in a terminal state. */
  isAlive: (candidate: NoticeplaceHealthRecoveryCandidate) => Promise<boolean>;
  /** Arm one observation; it reports whether the observation actually started. */
  arm: (candidate: NoticeplaceHealthRecoveryCandidate) => "started" | "duplicate" | "refused" | Promise<"started" | "duplicate" | "refused">;
  /**
   * The selected plan of a candidate whose record does not carry one.
   *
   * The plan of a launch is stated by the center and remembered durably, so a
   * record written without a plan can be repaired after a restart instead of
   * being skipped for good.
   */
  resolvePlan?: (candidate: NoticeplaceHealthRecoveryCandidate) => Promise<HealthPlanId | undefined>;
  /** How many candidates are checked and armed at the same time. */
  concurrency?: number;
  /** Pause between two batches. */
  batchDelayMs?: number;
}): Promise<NoticeplaceHealthRecoveryResult> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const batchDelayMs = Math.max(0, options.batchDelayMs ?? 250);
  const result: NoticeplaceHealthRecoveryResult = { armed: 0, skipped: 0, reasons: [], refusals: [] };
  for (let index = 0; index < options.candidates.length; index += concurrency) {
    const batch = options.candidates.slice(index, index + concurrency);
    await Promise.all(batch.map(async (candidate) => {
      // The owner-level lever decides before the repair: while automation is
      // forbidden, the observation is not armed again and the incident card
      // stays open for the operator.
      const gate = await healthOwnerGate({
        workKeys: healthWorkKeys({
          harness: candidate.harness,
          sessionId: candidate.sessionId,
          cwd: candidate.cwd,
          project: candidate.binding.project,
        }),
      });
      if (!gate.allowed) {
        result.skipped += 1;
        const reason = gate.reason ?? "the owner forbids automation";
        result.reasons.push(`${candidate.sessionId}: ${reason} [${AUTOMATION_DISABLED_CODE}]`);
        // The same refusal with its class: the wording stays for the operator,
        // the record is what a reader counts.
        result.refusals.push({
          code: AUTOMATION_DISABLED_CODE,
          reason: `${candidate.sessionId}: ${reason}`,
          sessionId: candidate.sessionId,
          incidentId: candidate.binding.incidentId,
          harness: candidate.harness,
          // The area of the refusal, beside its class: the path of the scope
          // that refused, or the catch-all scope of the whole contour.
          ...(gate.routingReasonDetail ? { detail: gate.routingReasonDetail } : {}),
          ...(gate.workKey ? { workKey: gate.workKey } : {}),
        });
        return;
      }
      let alive = false;
      try {
        alive = await options.isAlive(candidate);
      } catch {
        alive = false;
      }
      if (!alive) {
        result.skipped += 1;
        result.reasons.push(`${candidate.sessionId}: the session is gone or finished`);
        return;
      }
      const planId = candidate.binding.planId ?? await resolvePlan(options.resolvePlan, candidate);
      if (!planId) {
        // The observer publishes only for the selected plan of the incident:
        // an unknown plan is a refusal, never a guess.
        result.skipped += 1;
        const reason = `the incident ${candidate.binding.incidentId} has no selected health plan`;
        result.reasons.push(`${candidate.sessionId}: ${reason} [${NO_SELECTED_HEALTH_PLAN_CODE}]`);
        result.refusals.push({
          code: NO_SELECTED_HEALTH_PLAN_CODE,
          reason: `${candidate.sessionId}: ${reason}`,
          sessionId: candidate.sessionId,
          incidentId: candidate.binding.incidentId,
          harness: candidate.harness,
        });
        return;
      }
      const outcome = await options.arm(planId === candidate.binding.planId
        ? candidate
        : { ...candidate, binding: { ...candidate.binding, planId } });
      if (outcome === "started") {
        result.armed += 1;
        return;
      }
      result.skipped += 1;
      result.reasons.push(`${candidate.sessionId}: the observation was not armed (${outcome})`);
    }));
    if (batchDelayMs && index + concurrency < options.candidates.length) await new Promise((resolve) => { setTimeout(resolve, batchDelayMs).unref?.(); });
  }
  return result;
}

/** The plan of a launch, when the caller knows one; an unreadable plan is no plan. */
async function resolvePlan(
  resolver: ((candidate: NoticeplaceHealthRecoveryCandidate) => Promise<HealthPlanId | undefined>) | undefined,
  candidate: NoticeplaceHealthRecoveryCandidate,
): Promise<HealthPlanId | undefined> {
  if (!resolver) return undefined;
  try {
    return await resolver(candidate);
  } catch {
    return undefined;
  }
}
