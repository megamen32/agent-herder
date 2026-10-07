import type { AgentSession } from "../types/index.js";

/** Read-only directory projection: native activity is never task completion. */
export function projectSessionInventory(sessions: AgentSession[]) {
  return sessions.map((session) => {
    const meta = session.meta ?? {};
    const turn = meta.nativeLastTurn && typeof meta.nativeLastTurn === "object" && !Array.isArray(meta.nativeLastTurn)
      ? meta.nativeLastTurn as Record<string, unknown> : {};
    const label = (value: unknown) => typeof value === "string" && value.length <= 128 ? value : undefined;
    return {
      id: session.id,
      harness: session.harness,
      cwd: session.cwd,
      status: session.status,
      lastActivity: session.lastActivity,
      needsPermission: session.needsPermission,
      hostId: label(meta.hostId),
      persistedTaskStatus: label(meta.persistedTaskStatus),
      nativeTimeUpdated: typeof meta.nativeTimeUpdated === "number" ? meta.nativeTimeUpdated : label(meta.nativeTimeUpdated),
      nativeTurnId: label(turn.turnId),
      nativeTurnStatus: label(turn.status),
      humanStopHeld: typeof meta.humanStopHeld === "boolean" ? meta.humanStopHeld : undefined,
      requiresHuman: typeof turn.requiresHuman === "boolean" ? turn.requiresHuman : undefined,
      nativeBlocked: typeof turn.blockedReason === "string" ? turn.blockedReason.trim().length > 0 : undefined,
    };
  });
}
