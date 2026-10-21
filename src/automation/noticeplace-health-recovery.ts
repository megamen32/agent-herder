import { readFile } from "node:fs/promises";
import { parseNoticeIncident, type NoticeIncidentBinding } from "../autopilot/notice-incident.js";

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
 */
export async function recoverNoticeplaceHealthObservation(options: {
  candidates: NoticeplaceHealthRecoveryCandidate[];
  /** The native session still exists and is not in a terminal state. */
  isAlive: (candidate: NoticeplaceHealthRecoveryCandidate) => Promise<boolean>;
  /** Arm one observation; it reports whether the observation actually started. */
  arm: (candidate: NoticeplaceHealthRecoveryCandidate) => "started" | "duplicate" | "refused" | Promise<"started" | "duplicate" | "refused">;
  /** How many candidates are checked and armed at the same time. */
  concurrency?: number;
  /** Pause between two batches. */
  batchDelayMs?: number;
}): Promise<NoticeplaceHealthRecoveryResult> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const batchDelayMs = Math.max(0, options.batchDelayMs ?? 250);
  const result: NoticeplaceHealthRecoveryResult = { armed: 0, skipped: 0, reasons: [] };
  for (let index = 0; index < options.candidates.length; index += concurrency) {
    const batch = options.candidates.slice(index, index + concurrency);
    await Promise.all(batch.map(async (candidate) => {
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
      const outcome = await options.arm(candidate);
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
