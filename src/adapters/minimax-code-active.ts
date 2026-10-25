import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "../types/index.js";
import { localSessionHostId } from "../types/index.js";
import type { MinimaxCodeControl } from "./minimax-code-control.js";
import type { MinimaxRuntimeActiveProof } from "./minimax-code-runtime-activity.js";
import { sessionWorkspaces, type SessionWorkspaceStore } from "../session-workspaces.js";
import { backfillSessionWorkspaces, workspaceEvidenceFromNativeSession } from "../session-workspaces-backfill.js";

export interface MinimaxActiveReceipt {
  exhaustive: boolean;
  observedAt: string;
  expiresAt: string;
  source: "native_active_turn" | "native_runtime_turn_lease";
  metadataEnumerationExhaustive: boolean;
  activityCoverage: "native_active_turn" | "native_runtime_turn_lease" | "partial";
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
const METADATA_TTL_MS = 60_000;
interface MetadataEntry { row?: NativeSession; at?: number; pending?: Promise<void> }
const metadataCaches = new WeakMap<object, Map<string, MetadataEntry>>();
const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("minimax_active_response_invalid");
  return value as Record<string, any>;
};

export interface MinimaxActiveOptions {
  readRuntimeCandidateIds?: () => Promise<string[]>;
  onProgress?: (stage:string)=>void;
  /** Runtime-state proof of activity, used when the desktop transport cannot prove it.
   * The caller wires the real source; without it the answer stays controller-only. */
  readRuntimeActivity?: () => Promise<MinimaxRuntimeActiveProof>;
  /** Injectable durable metadata store for isolated tests. */
  workspaceStore?: SessionWorkspaceStore;
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
async function proveMinimaxActiveTurns(control: Pick<MinimaxCodeControl, "call">, options: MinimaxActiveOptions = {}): Promise<{ sessions: AgentSession[]; receipt: MinimaxActiveReceipt }> {
  const stageTimingsMs:Record<string,number>={};let stage='metadata',stageStart=performance.now();
  const progress=(next:string)=>{stageTimingsMs[stage]=Math.round(performance.now()-stageStart);stage=next;stageStart=performance.now();options.onProgress?.(next);};
  options.onProgress?.(stage);
  const request = async (path: string) => {
    const response = await control.call("GET", path);
    // A fixed code keeps the reason of the refusal readable in the panel: a
    // free-text message would collapse into one generic "unavailable" code.
    if (!response.ok) {
      const unpublished = response.status === 0 || /not published/i.test(response.error ?? "");
      throw new Error(unpublished ? "minimax_control_transport_unavailable" : "minimax_control_request_failed");
    }
    return object(response.body);
  };
  // Activity never waits for a historical metadata enumeration. Cache only
  // exact active-ID display records, independently from current runtime proof.
  let rows = metadataCaches.get(control);
  if (!rows) { rows = new Map(); metadataCaches.set(control, rows); }
  const pages = 0;
  progress("candidate_seed");
  let seedComplete = true;
  let seedIds: string[] = [];
  try { seedIds = await (options.readRuntimeCandidateIds || readMinimaxRuntimeCandidateIds)(); }
  catch { seedComplete = false; }
  const candidates = [...new Set(seedComplete ? seedIds : [...rows.keys()])];
  // An empty durable seed alone cannot prove that the live controller exists.
  if (seedComplete && candidates.length === 0) {
    const live = await request("/agent");
    if (!Array.isArray(live.agents)) throw new Error("minimax_active_runtime_unavailable");
  }
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
        let entry = rows.get(id);
        if (!entry) { entry = {}; rows.set(id, entry); }
        if (!entry.row || Date.now() - (entry.at || 0) >= METADATA_TTL_MS) {
          if (!entry.pending) {
            const target = entry;
            target.pending = request(`/session/${encodeURIComponent(id)}`).then(response => {
              const row = object(response.session || response) as NativeSession;
              if (row.session_id !== id) throw new Error("minimax_active_metadata_identity_invalid");
              target.row = row; target.at = Date.now();
            }).catch(() => undefined).finally(() => { target.pending = undefined; });
          }
          // A delayed/missing title must not stall or discard a proven active ID.
          await Promise.race([entry.pending, new Promise<void>(resolve => setTimeout(resolve, 300))]);
        }
        active.push(entry.row || {session_id: id});
      } catch { failedCandidateCount += 1; }
    }));
  }
  progress("complete");
  const observedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 15_000).toISOString();
  const exhaustive = seedComplete && failedCandidateCount === 0;
  const receipt: MinimaxActiveReceipt = { exhaustive, metadataEnumerationExhaustive: false,
    activityCoverage: exhaustive ? "native_active_turn" : "partial", observedAt, expiresAt, source: "native_active_turn",
    stageTimingsMs, totalSessions: candidates.length, pages, candidateCount: candidates.length, failedCandidateCount,
    ...(!seedComplete ? { reason: "native_runtime_candidate_seed_unavailable" } : failedCandidateCount ? { reason: "native_runtime_candidate_validation_partial" } : {}),
  };
  const sessions: AgentSession[] = active.map(row => ({
    id: row.session_id, harness: "minimax-code", title: row.title || row.session_id,
    status: "running", cwd: row.workspace_dir || "", hostId: localSessionHostId(),
    lastActivity: new Date(row.updated_at || row.created_at || 0).toISOString(),
    needsPermission: false, model: row.model?.model_id,
    lineage: { kind: row.parent_session_id ? "subagent" : row.agent_name ? "root" : "unknown", ...(row.parent_session_id ? { parentId: row.parent_session_id } : {}), role: row.agent_name },
    meta: { activityEvidence: receipt.source, activityObservedAt: observedAt, activityExpiresAt: expiresAt,
      liveStatus: "running", nativeStatusType: row.status?.status_type, nativeContinuationState: 2, nativeAgentName: row.agent_name,
      ...(row.parent_session_id ? { parentSessionId: row.parent_session_id, lineageKind: "subagent" } : { lineageKind: row.agent_name ? "root" : "unknown" }),
      ...(!row.agent_name && !row.title ? { metadataUnavailable: true } : {}),
      ...(row.status?.error_code === undefined ? {} : { retainedNativeErrorCode: row.status.error_code }) },
  }));
  return { sessions, receipt };
}

/**
 * Activity of the MiniMax Code sessions of this host.
 *
 * The desktop transport stays the primary proof: it reaches the very runtime
 * the app is showing. A host that runs the MiniMax Code runtime without that
 * transport (a fleet node that executes turns for other machines) cannot
 * answer through it at all, and the refusal of the controller must not become
 * "no activity anywhere". Such a host still owns the truth about its own
 * turns: the runtime holds a turn lease while it executes a turn.
 *
 * The lease proof is used only when the controller proved nothing: it either
 * refused or it confirmed no turn at all. It is marked as its own evidence, so
 * a lease is never presented as a controller proof. Without any proof the
 * answer stays a refusal: an empty activity list is never invented.
 */
export async function readMinimaxActiveSessions(control: Pick<MinimaxCodeControl, "call">, options: MinimaxActiveOptions = {}): Promise<{ sessions: AgentSession[]; receipt: MinimaxActiveReceipt }> {
  const persistNativeWorkspaces = async (sessions:AgentSession[]) => {
    const evidence=sessions.flatMap(session=>workspaceEvidenceFromNativeSession({
      runtimeHostId:session.hostId,harness:session.harness,nativeSessionId:session.id,
      hostId:session.hostId,cwd:session.cwd,observedAt:String(session.meta?.activityObservedAt??""),
      activityEvidence:String(session.meta?.activityEvidence??""),
    }));
    if(evidence.length) await backfillSessionWorkspaces(options.workspaceStore??sessionWorkspaces,evidence);
  };
  let proven: { sessions: AgentSession[]; receipt: MinimaxActiveReceipt } | null = null;
  let refusal: unknown = null;
  try {
    proven = await proveMinimaxActiveTurns(control, options);
  } catch (error) {
    refusal = error;
  }
  if (!proven || proven.sessions.length === 0) {
    let proof: MinimaxRuntimeActiveProof | null = null;
    try {
      proof = options.readRuntimeActivity ? await options.readRuntimeActivity() : null;
    } catch {
      proof = null;
    }
    if (proof && proof.sessions.length) {
      await persistNativeWorkspaces(proof.sessions);
      const receipt: MinimaxActiveReceipt = {
        exhaustive: proof.unprovenLeaseCount === 0, observedAt: proof.observedAt, expiresAt: proof.expiresAt,
        source: "native_runtime_turn_lease", metadataEnumerationExhaustive: false,
        activityCoverage: proof.unprovenLeaseCount === 0 ? "native_runtime_turn_lease" : "partial",
        candidateCount: proof.leaseCount, failedCandidateCount: proof.unprovenLeaseCount,
        totalSessions: proof.leaseCount, pages: 1, stageTimingsMs: { runtime_lease: 0 },
        ...(proof.unprovenLeaseCount ? { reason: "native_runtime_lease_owner_unproven" } : {}),
      };
      return { sessions: proof.sessions, receipt };
    }
  }
  if (!proven) throw refusal;
  await persistNativeWorkspaces(proven.sessions);
  return proven;
}
