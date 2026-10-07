import type { ZcodeClientLike } from "./zcode-protocol.js";

export interface ExistingZcodeWorkspace {
  workspacePath: string;
  workspaceIdentity: string;
  workspaceKey: string;
}
export type ZcodeRuntimeObservation = {
  sessionId: string;
  observedAt: string;
  available: boolean;
  reason?: string;
  activeTurnId?: string;
  pendingRequestCount?: number;
  eventSeq?: number;
  stateRevision?: number;
  // The existing snapshot contract does not enumerate loaded identities or input queues.
  loadedSessionCoverage: "unknown";
  queuedInputCount: null;
  admittedNotStartedCount: null;
  idleProof: false;
};

/** Read one known session through an existing transport/runtime only.
 * This is a partial diagnostic, never sufficient evidence to restart its owner. */
export async function readExistingZcodeRuntimeObservation(
  client: Pick<ZcodeClientLike, "callIfReady">,
  workspace: ExistingZcodeWorkspace,
  sessionId: string,
): Promise<ZcodeRuntimeObservation> {
  const base: ZcodeRuntimeObservation = {
    sessionId, observedAt: new Date().toISOString(), available: false,
    loadedSessionCoverage: "unknown", queuedInputCount: null,
    admittedNotStartedCount: null, idleProof: false,
  };
  if (!client.callIfReady) return { ...base, reason: "existing_transport_read_unsupported" };
  try {
    const value = await client.callIfReady("zcode-agent", "readSession", [{
      ...workspace, sessionId, runtimePolicy: "existing-only", messageLimit: 0,
    }]);
    if (!value || typeof value !== "object") return { ...base, reason: "native_snapshot_invalid" };
    const snapshot = value as Record<string, unknown>;
    const session = snapshot.session as Record<string, unknown> | undefined;
    const runtime = snapshot.runtime as Record<string, unknown> | undefined;
    if (session?.sessionId !== sessionId || !runtime || typeof runtime !== "object") {
      return { ...base, reason: "native_snapshot_identity_or_runtime_missing" };
    }
    const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
    if (!integer(runtime.eventSeq) || !integer(runtime.stateRevision)
      || !Array.isArray(runtime.pendingRequestIds)
      || !runtime.pendingRequestIds.every((id) => typeof id === "string" && id.length > 0)
      || (runtime.activeTurnId !== undefined && (typeof runtime.activeTurnId !== "string" || !runtime.activeTurnId))) {
      return { ...base, reason: "native_snapshot_runtime_invalid" };
    }
    return {
      ...base, available: true, eventSeq: runtime.eventSeq, stateRevision: runtime.stateRevision,
      pendingRequestCount: runtime.pendingRequestIds.length,
      ...(typeof runtime.activeTurnId === "string" ? { activeTurnId: runtime.activeTurnId } : {}),
    };
  } catch {
    return { ...base, reason: "existing_transport_or_runtime_unavailable" };
  }
}
