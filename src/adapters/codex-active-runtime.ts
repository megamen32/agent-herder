import type { AgentSession } from "../types/index.js";
export interface CodexActiveThread {
  id: string; parentThreadId?: string; cwd?: string; path?: string; name?: string; preview?: string;
  model?: string | null; modelProvider?: string; createdAt?: string | number; updatedAt?: string | number;
  status?: string | { type?: string; activeFlags?: string[] };
}
export interface CodexActiveReceipt {
  exhaustive: boolean; observedAt: string; expiresAt: string; source: "codex-loaded-native-runtime";
  candidateCount: number; failedCandidateCount: number; pages: number;
  scope: "connected_native_controller"; reason?: string;
}
export async function readCodexActiveRuntime(
  request: (method: string, params: unknown) => Promise<unknown>,
  map: (thread: CodexActiveThread) => AgentSession,
  accepts: (thread: CodexActiveThread) => boolean = () => true,
): Promise<{ sessions: AgentSession[]; receipt: CodexActiveReceipt }> {
  const ids = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined, pages = 0;
  do {
    const result = await request("thread/loaded/list", {limit: 200, ...(cursor ? {cursor} : {})}) as {data?: unknown[]; nextCursor?: string | null};
    pages += 1;
    if (!Array.isArray(result?.data) || result.data.some(id => typeof id !== "string" || !id || id.length > 512 || /[\x00-\x1f\x7f]/.test(id))) throw new Error("codex_active_loaded_ids_invalid");
    for (const id of result.data) ids.add(id as string);
    if (result.nextCursor !== undefined && result.nextCursor !== null && typeof result.nextCursor !== "string") throw new Error("codex_active_cursor_invalid");
    cursor = result.nextCursor || undefined;
    if (cursor && cursors.has(cursor)) throw new Error("codex_active_cursor_repeated");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  const sessions: AgentSession[] = [];
  let failedCandidateCount = 0;
  const candidates = [...ids];
  for (let offset = 0; offset < candidates.length; offset += 8) {
    await Promise.all(candidates.slice(offset, offset + 8).map(async id => {
      try {
        const result = await request("thread/read", {threadId: id, includeTurns: false}) as {thread?: CodexActiveThread};
        const thread = result?.thread;
        if (thread?.id !== id) throw new Error("codex_active_identity_mismatch");
        const type = typeof thread.status === "string" ? thread.status : thread.status?.type;
        if (!type || !["active", "inProgress", "running", "idle", "notLoaded", "systemError", "failed", "error", "completed", "interrupted"].includes(type)) throw new Error("codex_active_status_unknown");
        if (!["active", "inProgress", "running"].includes(type) || !accepts(thread)) return;
        const flags = typeof thread.status === "object" ? thread.status.activeFlags || [] : [];
        const blocked = flags.some(flag => flag === "waitingOnApproval" || flag === "waitingOnUserInput");
        // Loaded-thread status proves activity but has no turn identity. Read
        // the current native turn through the adapter's existing exact read
        // route; cached IDs from `map` must never stand in for this receipt.
        let activeTurnId: string | undefined;
        let nativeLastTurn: { turnId: string; status: string; completedAt?: string | number } | undefined;
        let nativeTurnStateUnavailable = false;
        try {
          const turns = await request("thread/turns/list", {
            threadId: id, limit: 1, sortDirection: "desc", itemsView: "notLoaded",
          }) as { data?: Array<{ id?: unknown; status?: unknown; completedAt?: unknown }> };
          if (!Array.isArray(turns?.data)) throw new Error("codex_active_turn_state_unavailable");
          const latest = turns.data[0];
          if (typeof latest?.id !== "string" || !latest.id || typeof latest.status !== "string") {
            nativeTurnStateUnavailable = true;
          } else {
            nativeLastTurn = {
              turnId: latest.id,
              status: latest.status,
              ...(typeof latest.completedAt === "string" || typeof latest.completedAt === "number"
                ? { completedAt: latest.completedAt } : {}),
            };
            if (latest.status === "inProgress") activeTurnId = latest.id;
          }
        } catch {
          nativeTurnStateUnavailable = true;
        }
        if (nativeTurnStateUnavailable) failedCandidateCount += 1;
        const observedAt = new Date().toISOString();
        const session = map(thread);
        // Replace stale cached turn metadata with only the exact fresh receipt.
        const meta = {...session.meta};
        delete meta.activeTurnId;
        delete meta.nativeLastTurn;
        delete meta.nativeTurnStateUnavailable;
        sessions.push({...session, status: blocked ? "needs_input" : "running", needsPermission: flags.includes("waitingOnApproval"),
          meta: {...meta, ...(activeTurnId ? {activeTurnId} : {}), ...(nativeLastTurn ? {nativeLastTurn} : {}),
            ...(nativeTurnStateUnavailable ? {nativeTurnStateUnavailable: true} : {}),
            activityEvidence: "codex-loaded-native-runtime", activityObservedAt: observedAt,
            activityExpiresAt: new Date(Date.now()+30_000).toISOString(), nativeThreadStatus: type, nativeActiveFlags: flags}});
      } catch { failedCandidateCount += 1; }
    }));
  }
  const observedAt = new Date().toISOString();
  return {sessions, receipt: {exhaustive: failedCandidateCount === 0, observedAt, expiresAt: new Date(Date.now()+30_000).toISOString(),
    source: "codex-loaded-native-runtime", scope: "connected_native_controller", candidateCount: ids.size, failedCandidateCount, pages,
    ...(failedCandidateCount ? {reason: "native_loaded_candidate_read_partial"} : {})}};
}
