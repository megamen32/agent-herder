import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "../types/index.js";
import { localSessionHostId } from "../types/index.js";
import type { MinimaxCodeControl } from "./minimax-code-control.js";

export interface MinimaxActiveReceipt {
  exhaustive: boolean;
  observedAt: string;
  expiresAt: string;
  source: "native_active_turn";
  metadataEnumerationExhaustive: boolean;
  activityCoverage: "native_active_turn" | "partial";
  candidateCount: number;
  failedCandidateCount: number;
  reason?: string;
  totalSessions: number;
  pages: number;
  stageTimingsMs: Record<string, number>;
}
interface NativeSession {
  session_id: string; agent_name?: string; title?: string; workspace_dir?: string;
  parent_session_id?: string; updated_at?: number; created_at?: number;
  status?: { status_type?: number; error_code?: number };
  model?: { model_id?: string };
}
const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("minimax_active_response_invalid");
  return value as Record<string, any>;
};

export interface MinimaxActiveOptions {
  readRuntimeCandidateIds?: () => Promise<string[]>;
  onProgress?: (stage:string)=>void;
}

/** Both normal turns and manual compaction call repository.admit before controller.register.
 * Accepted ingress is a candidate index only; the live controller API proves activity. */
export async function readMinimaxRuntimeCandidateIds(
  path = process.env.MINIMAX_CODE_RUNTIME_DB || join(homedir(), ".minimax/v2/sqlite/runtime-state.sqlite"),
): Promise<string[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("select distinct session_id from local_runtime_turn_ingress where status = 'accepted'").all() as Array<{session_id:string}>).map(row => row.session_id);
  } finally { db.close(); }
}

/** Current runtime work, including compaction. GUI optimistic loading is not execution proof. */
export async function readMinimaxActiveSessions(control: Pick<MinimaxCodeControl, "call">, options: MinimaxActiveOptions = {}): Promise<{ sessions: AgentSession[]; receipt: MinimaxActiveReceipt }> {
  const stageTimingsMs:Record<string,number>={};let stage='metadata',stageStart=performance.now();
  const progress=(next:string)=>{stageTimingsMs[stage]=Math.round(performance.now()-stageStart);stage=next;stageStart=performance.now();options.onProgress?.(next);};
  options.onProgress?.(stage);
  const request = async (path: string) => {
    const response = await control.call("GET", path);
    if (!response.ok) throw new Error(response.error || "minimax_active_runtime_unavailable");
    return object(response.body);
  };
  const owners = await request("/agent");
  if (!Array.isArray(owners.agents)) throw new Error("minimax_active_agents_invalid");
  const rows = new Map<string, NativeSession>();
  let pages = 0;
  await Promise.all(owners.agents.map(async (owner: unknown) => {
    const name = object(owner).name;
    if (typeof name !== "string" || !name) throw new Error("minimax_active_agent_invalid");
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ limit: "200", include_hidden: "true" });
      if (cursor) query.set("cursor", cursor);
      const page = await request(`/agent/${encodeURIComponent(name)}/session?${query}`);
      pages += 1;
      if (!Array.isArray(page.sessions) || typeof page.has_more !== "boolean") throw new Error("minimax_active_page_invalid");
      for (const row of page.sessions) {
        const session = object(row) as NativeSession;
        if (typeof session.session_id !== "string" || !session.session_id) throw new Error("minimax_active_identity_invalid");
        if (!session.status || ![0, 1, 2, 3].includes(session.status.status_type!)) throw new Error("minimax_active_status_unknown");
        rows.set(session.session_id, session);
      }
      cursor = page.has_more ? page.next_cursor : undefined;
      if (page.has_more && (typeof cursor !== "string" || !cursor || seen.has(cursor))) throw new Error("minimax_active_cursor_invalid");
      if (cursor) seen.add(cursor);
    } while (cursor);
  }));
  progress("candidate_seed");
  let seedComplete = true;
  let seedIds: string[] = [];
  try { seedIds = await (options.readRuntimeCandidateIds || readMinimaxRuntimeCandidateIds)(); }
  catch { seedComplete = false; }
  const candidates = [...new Set([...seedIds, ...[...rows.values()].filter(row => row.status?.status_type === 1).map(row => row.session_id)])];
  progress("controller_validation");
  const active: NativeSession[] = [];
  let failedCandidateCount = 0;
  // Bound concurrent reads, never the candidate set. A failed ID cannot erase other positives.
  for (let offset = 0; offset < candidates.length; offset += 8) {
    await Promise.all(candidates.slice(offset, offset + 8).map(async id => {
      try {
        const current = await request(`/session/${encodeURIComponent(id)}/turn-continuation`);
        if (![0, 1, 2, 3].includes(current.state)) throw new Error("minimax_active_runtime_state_invalid");
        if (current.state !== 2) return;
        let row = rows.get(id);
        if (!row) {
          const response = await request(`/session/${encodeURIComponent(id)}`);
          row = object(response.session || response) as NativeSession;
          if (row.session_id !== id) throw new Error("minimax_active_metadata_identity_invalid");
        }
        active.push(row);
      } catch { failedCandidateCount += 1; }
    }));
  }
  progress("complete");
  const observedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 15_000).toISOString();
  const exhaustive = seedComplete && failedCandidateCount === 0;
  const receipt: MinimaxActiveReceipt = { exhaustive, metadataEnumerationExhaustive: true,
    activityCoverage: exhaustive ? "native_active_turn" : "partial", observedAt, expiresAt, source: "native_active_turn",
    stageTimingsMs, totalSessions: rows.size, pages, candidateCount: candidates.length, failedCandidateCount,
    ...(!seedComplete ? { reason: "native_runtime_candidate_seed_unavailable" } : failedCandidateCount ? { reason: "native_runtime_candidate_validation_partial" } : {}),
  };
  const sessions: AgentSession[] = active.map(row => ({
    id: row.session_id, harness: "minimax-code", title: row.title || row.session_id,
    status: "running", cwd: row.workspace_dir || "", hostId: localSessionHostId(),
    lastActivity: new Date(row.updated_at || row.created_at || 0).toISOString(),
    needsPermission: false, model: row.model?.model_id,
    lineage: { kind: row.parent_session_id ? "subagent" : "root", ...(row.parent_session_id ? { parentId: row.parent_session_id } : {}), role: row.agent_name },
    meta: { activityEvidence: receipt.source, activityObservedAt: observedAt, activityExpiresAt: expiresAt,
      liveStatus: "running", nativeStatusType: row.status?.status_type, nativeContinuationState: 2, nativeAgentName: row.agent_name,
      ...(row.parent_session_id ? { parentSessionId: row.parent_session_id, lineageKind: "subagent" } : { lineageKind: "root" }),
      ...(row.status?.error_code === undefined ? {} : { retainedNativeErrorCode: row.status.error_code }) },
  }));
  return { sessions, receipt };
}
