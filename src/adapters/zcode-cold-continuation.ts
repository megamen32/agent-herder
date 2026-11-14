import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const ZCODE_COLD_CONTINUATION = "cold-queue-subscription-v1";
export type ZcodeColdFailure =
  | "source_unavailable" | "source_unbounded" | "session_unverified" | "workspace_unverified"
  | "pending_native_input" | "promoted_input_unsettled" | "unfinished_native_turn"
  | "native_human_stop" | "native_runtime_owner" | "native_goal" | "unfinished_native_work"
  | "model_unverified" | "permission_unverified" | "persisted_state_changed"
  | "runtime_not_idle" | "queue_not_empty" | "model_changed" | "permission_changed";

export class ZcodeColdContinuationError extends Error {
  constructor(readonly code: ZcodeColdFailure) {
    super("ZCode cold continuation: " + code);
    this.name = "ZcodeColdContinuationError";
  }
}
type Row = Record<string, unknown>;
const object = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v);
const requireProof = (ok: unknown, code: ZcodeColdFailure): void => {
  if (!ok) throw new ZcodeColdContinuationError(code);
};
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (object(v)) return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  return v === undefined ? "undefined" : JSON.stringify(v);
}
const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const textId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(v);
const record = (v: unknown): Row => object(v) ? v : {};

export interface ZcodeColdPreflight {
  sessionId: string;
  workspace: { workspacePath: string; workspaceIdentity: string; workspaceKey: string };
  fingerprint: string;
  modelSelection: Row;
  permission: Row;
  lastTurnId: string | null;
  messageCount: number;
}

/** Exact read transaction. It proves safe eligibility for lifecycle preparation,
 * never claims that an unloaded session is currently idle or has a live queue. */
export function readZcodeColdPreflight(dbPath: string, sessionId: string): ZcodeColdPreflight {
  let db: DatabaseSync | undefined;
  try {
    requireProof(textId(sessionId), "session_unverified");
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN");
    const session = db.prepare("SELECT id,directory,workspace_id,revert,time_deleted,permission,last_outcome,time_updated FROM session WHERE id=?").get(sessionId) as Row | undefined;
    requireProof(session?.id === sessionId && session.revert === null && session.time_deleted === null, "session_unverified");
    const directory = session!.directory, workspaceId = session!.workspace_id;
    requireProof(textId(directory) && isAbsolute(directory) && resolve(directory) === directory
      && (workspaceId === null || workspaceId === directory), "workspace_unverified");
    const rows = (table: string, columns: string, order: string): Row[] => {
      const count = db!.prepare("SELECT COUNT(*) AS n FROM " + table + " WHERE session_id=?").get(sessionId) as { n: number };
      requireProof(Number.isSafeInteger(count.n) && count.n >= 0 && count.n <= 10000, "source_unbounded");
      return db!.prepare("SELECT " + columns + " FROM " + table + " WHERE session_id=? ORDER BY " + order).all(sessionId) as Row[];
    };
    const inputs = rows("session_input", "id,kind,status,status_reason,promoted_message_id,admitted_sequence,promoted_sequence,time_updated", "admitted_sequence,id");
    const turns = rows("turn_usage", "turn_id,user_message_id,status,started_at,completed_at,cancelled_by_user,model_request_count,model_retry_count,tool_call_count", "started_at,turn_id");
    const presence = rows("session_runtime_presence", "owner_id,process_id", "owner_id");
    const targets = rows("session_target", "target_id,status,active_input_id,active_run_started_at,active_run_last_seen_at", "target_id");
    const modelRequests = rows("model_usage", "id,turn_id,status,started_at,completed_at", "started_at,id");
    const tools = rows("tool_usage", "id,turn_id,status,started_at,completed_at", "started_at,id");
    const modelSize = db.prepare("SELECT COUNT(*) AS n,COALESCE(SUM(LENGTH(CAST(data AS BLOB))),0) AS bytes FROM session_entry WHERE session_id=? AND type='runtime/model_selection'").get(sessionId) as { n: number; bytes: number };
    requireProof(modelSize.n === 1 && modelSize.bytes <= 65536, "model_unverified");
    const modelRows = db.prepare("SELECT data FROM session_entry WHERE session_id=? AND type='runtime/model_selection'").all(sessionId) as Row[];
    let historyBytes = 0;
    for (const table of ["message", "part"]) {
      const size = db.prepare("SELECT COUNT(*) AS n,COALESCE(SUM(LENGTH(CAST(data AS BLOB))),0) AS bytes FROM " + table + " WHERE session_id=?").get(sessionId) as { n: number; bytes: number };
      requireProof(Number.isSafeInteger(size.n) && size.n <= 10000 && Number.isSafeInteger(size.bytes) && size.bytes >= 0, "source_unbounded");
      historyBytes += size.bytes;
    }
    requireProof(historyBytes <= 16 * 1024 * 1024, "source_unbounded");
    const messages = rows("message", "id,role,sequence,time_created,time_updated,data", "sequence,id");
    const parts = rows("part", "id,message_id,sequence,time_created,time_updated,data", "message_id,sequence,id");
    requireProof(presence.length === 0, "native_runtime_owner");
    requireProof(targets.length === 0, "native_goal");
    requireProof(inputs.every(row => ["promoted", "cancelled", "discarded", "failed"].includes(String(row.status))), "pending_native_input");
    requireProof(turns.every(row => textId(row.turn_id) && ["success", "error", "cancelled"].includes(String(row.status))
      && typeof row.started_at === "number" && Number.isFinite(row.started_at)
      && typeof row.completed_at === "number" && Number.isFinite(row.completed_at) && row.completed_at >= row.started_at
      && (row.cancelled_by_user === 0 || row.cancelled_by_user === 1)), "unfinished_native_turn");
    const latest = turns.at(-1);
    requireProof(!latest || (latest.cancelled_by_user === 0 && latest.status !== "cancelled"), "native_human_stop");
    requireProof(inputs.every(input => input.status !== "promoted" || textId(input.promoted_message_id)
      && turns.some(turn => turn.user_message_id === input.promoted_message_id)), "promoted_input_unsettled");
    requireProof([...modelRequests, ...tools].every(row => typeof row.completed_at === "number" && Number.isFinite(row.completed_at)
      && typeof row.started_at === "number" && Number.isFinite(row.started_at) && row.completed_at >= row.started_at
      && !["pending", "running", "in_progress", "started"].includes(String(row.status))), "unfinished_native_work");
    requireProof(modelRows.length === 1 && typeof modelRows[0].data === "string", "model_unverified");
    let modelSelection: unknown, permission: unknown;
    try { modelSelection = record(JSON.parse(modelRows[0].data as string)).modelSelection; }
    catch { throw new ZcodeColdContinuationError("model_unverified"); }
    try { permission = typeof session!.permission === "string" ? JSON.parse(session!.permission) : undefined; }
    catch { throw new ZcodeColdContinuationError("permission_unverified"); }
    requireProof(object(modelSelection) && textId(modelSelection.providerId) && textId(modelSelection.modelId), "model_unverified");
    requireProof(object(permission) && ["build", "plan", "edit", "guarded", "auto", "yolo"].includes(String(permission.mode)), "permission_unverified");
    const state = { session, inputs, turns, presence, targets, modelRequests, tools, modelSelection, permission, messages, parts };
    requireProof(Buffer.byteLength(canonical(state), "utf8") <= 20 * 1024 * 1024, "source_unbounded");
    db.exec("COMMIT");
    return { sessionId, workspace: { workspacePath: directory as string, workspaceIdentity: directory as string, workspaceKey: directory as string },
      fingerprint: digest(state), modelSelection: modelSelection as Row, permission: permission as Row,
      lastTurnId: latest?.turn_id as string | undefined ?? null, messageCount: messages.length };
  } catch (error) {
    if (error instanceof ZcodeColdContinuationError) throw error;
    throw new ZcodeColdContinuationError("source_unavailable");
  } finally {
    try { db?.close(); } catch { /* Read-only handle; preserve the typed failure. */ }
  }
}

export function assertZcodeColdPreflightUnchanged(before: ZcodeColdPreflight, after: ZcodeColdPreflight): void {
  requireProof(before.sessionId === after.sessionId && before.fingerprint === after.fingerprint, "persisted_state_changed");
}

/** Runtime and full V4 queue are checked after the one lifecycle boundary.
 * Historical terminal error in control.phase never substitutes for runtime idle. */
export function assertZcodePreparedContinuation(before: ZcodeColdPreflight, value: unknown, queueValue: unknown): void {
  const snapshot = record(value), session = record(snapshot.session), runtime = record(snapshot.runtime);
  const settings = record(snapshot.settings), queueSnapshot = record(queueValue), queue = record(queueSnapshot.queue), control = record(queueSnapshot.control);
  requireProof(session.sessionId === before.sessionId && session.status === "idle"
    && !runtime.activeTurnId && !runtime.activeTurnKind
    && Array.isArray(runtime.pendingRequestIds) && runtime.pendingRequestIds.length === 0, "runtime_not_idle");
  requireProof(queueSnapshot.sessionId === before.sessionId && Number.isSafeInteger(queueSnapshot.revision)
    && Array.isArray(queue.items) && queue.items.length === 0 && typeof queue.autoDrain === "boolean"
    && Array.isArray(control.activeWorks) && control.activeWorks.length === 0
    && control.apiRetry === null && control.stopState === "idle" && control.canStop === false
    && control.sessionEnded === false && ["idle", "error", "completed"].includes(String(control.phase)), "queue_not_empty");
  requireProof(digest(record(settings.model).current) === digest(before.modelSelection), "model_changed");
  // Runtime may add a rules revision; every persisted permission field must agree.
  const permission = record(settings.permission);
  requireProof(Object.keys(before.permission).every(key => canonical(permission[key]) === canonical(before.permission[key])), "permission_changed");
}
