import type { AgentSession } from "../types/index.js";
import type { ZcodeRuntimeObservation } from "./zcode-runtime-observation.js";

/** A recent historical tool tail cannot restart a terminal task. */
export function zcodeStoredTailCanBeActive(rawStatus: string | undefined): boolean {
  return !["completed", "error", "aborted", "cancelled", "canceled", "stopped"].includes(rawStatus?.toLowerCase() || "");
}

/** Validate candidate activity through an existing native runtime, without loading it. */
export async function readZcodeActiveCandidates(
  candidates: AgentSession[],
  observe: (session: AgentSession) => Promise<ZcodeRuntimeObservation>,
): Promise<AgentSession[]> {
  return (await Promise.all(candidates.map(async session => {
    const observation = await observe(session);
    if (!observation.available) throw new Error(`zcode_active_native_unavailable:${observation.reason || "unknown"}`);
    if (!observation.activeTurnId && !(observation.pendingRequestCount! > 0)) return null;
    return { ...session, status: observation.pendingRequestCount! > 0 ? "needs_input" as const : "running" as const,
      needsPermission: observation.pendingRequestCount! > 0,
      meta: { ...session.meta, activityEvidence: "zcode-existing-native-runtime", activityObservedAt: observation.observedAt,
        activityExpiresAt: new Date(Date.parse(observation.observedAt) + 15_000).toISOString(),
        activeTurnId: observation.activeTurnId, nativeEventSeq: observation.eventSeq, nativeStateRevision: observation.stateRevision } };
  }))).filter((session): session is NonNullable<typeof session> => session !== null);
}
