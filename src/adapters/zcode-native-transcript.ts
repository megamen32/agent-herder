import { existsSync } from "node:fs";
import type { RawTranscriptExport } from "../types/common.js";

export const ZCODE_SQLITE_TRANSCRIPT_SCHEMA = "agent-herder/zcode-native-sqlite-transcript@1";
export const ZCODE_TRANSCRIPT_MAX_BYTES = 16 * 1024 * 1024;
export type ZcodeTranscriptFailureCode =
  | "runtime_not_ready" | "session_not_found" | "native_schema_rejected"
  | "native_read_failed" | "native_source_disabled" | "native_source_missing"
  | "native_source_unreadable" | "native_row_invalid" | "native_identity_mismatch"
  | "native_current_conversation_unverified" | "native_source_oversize";

export class ZcodeNativeTranscriptError extends Error {
  constructor(readonly code: ZcodeTranscriptFailureCode) {
    super("ZCode native transcript is unavailable");
    this.name = "ZcodeNativeTranscriptError";
  }
}

/** Only closed codes cross the AHAP boundary; exception text can contain inputs. */
export class ZcodeTranscriptReadError extends Error {
  readonly code = "ZCODE_TRANSCRIPT_SOURCE_UNAVAILABLE";
  constructor(readonly diagnostic: {
    source: "zcode-native-transcript";
    native: ZcodeTranscriptFailureCode;
    persisted: ZcodeTranscriptFailureCode;
  }) {
    super("ZCode complete native transcript is unavailable");
    this.name = "ZcodeTranscriptReadError";
  }
}

export function zcodeTranscriptFailure(error: unknown): ZcodeTranscriptFailureCode {
  if (error instanceof ZcodeNativeTranscriptError) return error.code;
  const value = error && typeof error === "object" ? error as { code?: unknown; message?: unknown; data?: {code?: unknown} } : {};
  if (value.code === "runtimeNotReady" || value.data?.code === "runtimeNotReady" || value.message === "Session runtime is not ready") return "runtime_not_ready";
  if (value.code === "proto.sessionNotFound" || value.message === "Session not found") return "session_not_found";
  if (typeof value.message === "string" && value.message.length <= 65536) {
    try {
      const issues: unknown = JSON.parse(value.message);
      if (Array.isArray(issues) && issues.length > 0 && issues.every(issue => issue && typeof issue === "object"
        && typeof (issue as {code?: unknown}).code === "string" && Array.isArray((issue as {path?: unknown}).path))) return "native_schema_rejected";
    } catch { /* No arbitrary message bytes are returned. */ }
  }
  return "native_read_failed";
}

function reject(code: ZcodeTranscriptFailureCode): never { throw new ZcodeNativeTranscriptError(code); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return reject("native_row_invalid");
  return value as Record<string, unknown>;
}
function nativeJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return reject("native_row_invalid");
  try { return record(JSON.parse(value)); }
  catch (error) {
    if (error instanceof ZcodeNativeTranscriptError) throw error;
    return reject("native_row_invalid");
  }
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/u.test(value);
}
function identity(data: Record<string, unknown>, keys: string[], expected: string): void {
  if (keys.some(key => data[key] !== undefined && data[key] !== expected)) reject("native_identity_mismatch");
}

type MessageRow = { id: string; session_id: string; data: string; sequence: number | null; time_created: number; time_updated: number };
type PartRow = MessageRow & { message_id: string };

/**
 * Canonical persisted messages and parts, in one read transaction. No session
 * activation, tail limit, repair or runtime/queue assertion is permitted here.
 * Reverted/deleted conversations require a native branch-aware reader instead.
 */
export async function readZcodeNativeTranscript(
  dbPath: string, sessionId: string, maxBytes = ZCODE_TRANSCRIPT_MAX_BYTES,
): Promise<RawTranscriptExport> {
  if (!validId(sessionId)) return reject("native_identity_mismatch");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > ZCODE_TRANSCRIPT_MAX_BYTES) return reject("native_source_oversize");
  if (!existsSync(dbPath)) return reject("native_source_missing");
  let db: import("node:sqlite").DatabaseSync | undefined;
  let transaction = false;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN");
    transaction = true;
    const columns = new Set((db.prepare("PRAGMA table_info(session)").all() as Array<{name: string}>).map(row => row.name));
    if (!columns.has("revert") || !columns.has("time_deleted")) return reject("native_current_conversation_unverified");
    const session = db.prepare("SELECT * FROM session WHERE id = ?").get(sessionId) as Record<string, unknown> | undefined;
    if (!session) return reject("session_not_found");
    if (session.id !== sessionId) return reject("native_identity_mismatch");
    if (session.revert !== null || session.time_deleted !== null) return reject("native_current_conversation_unverified");
    // Measure before allocating full native payloads. The final encoded export
    // is checked too, because identities/provenance add bytes.
    const counts = (table: "message" | "part") => db!.prepare(
      "SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(data AS BLOB)) + length(CAST(id AS BLOB))), 0) AS bytes FROM " + table + " WHERE session_id = ?",
    ).get(sessionId) as { count: number; bytes: number };
    const messageSize = counts("message");
    const partSize = counts("part");
    if (!Number.isSafeInteger(messageSize.count) || !Number.isSafeInteger(partSize.count)
      || messageSize.bytes + partSize.bytes > maxBytes) return reject("native_source_oversize");
    const rows = db.prepare(
      "SELECT id, session_id, data, sequence, time_created, time_updated FROM message WHERE session_id = ? ORDER BY sequence, time_created, id",
    ).all(sessionId) as MessageRow[];
    const parts = db.prepare(
      "SELECT id, session_id, message_id, data, sequence, time_created, time_updated FROM part WHERE session_id = ? ORDER BY message_id, sequence, time_created, id",
    ).all(sessionId) as PartRow[];
    if (rows.length !== messageSize.count || parts.length !== partSize.count) return reject("native_row_invalid");
    const messages = new Map<string, { info: Record<string, unknown>; parts: Record<string, unknown>[]; nativeRow: Record<string, unknown>; nativePartRows: Record<string, unknown>[] }>();
    for (const row of rows) {
      if (!validId(row.id) || row.session_id !== sessionId || messages.has(row.id)) return reject("native_identity_mismatch");
      const info = nativeJson(row.data);
      identity(info, ["messageId", "id"], row.id);
      identity(info, ["sessionId", "sessionID"], sessionId);
      if (info.role !== "user" && info.role !== "assistant") return reject("native_row_invalid");
      messages.set(row.id, {
        info: { ...info, messageId: row.id, sessionId }, parts: [], nativePartRows: [],
        nativeRow: { sequence: row.sequence, time_created: row.time_created, time_updated: row.time_updated },
      });
    }
    const partIds = new Set<string>();
    for (const row of parts) {
      const message = messages.get(row.message_id);
      if (!validId(row.id) || row.session_id !== sessionId || !message || partIds.has(row.id)) return reject("native_identity_mismatch");
      partIds.add(row.id);
      const part = nativeJson(row.data);
      identity(part, ["partId", "id"], row.id);
      identity(part, ["messageId", "messageID"], row.message_id);
      identity(part, ["sessionId", "sessionID"], sessionId);
      message.parts.push({ ...part, partId: row.id, messageId: row.message_id, sessionId });
      // Storage provenance belongs to our wrapper, never to arbitrary native
      // part data: a future native field with this name must survive verbatim.
      message.nativePartRows.push({
        partId: row.id, sequence: row.sequence, time_created: row.time_created, time_updated: row.time_updated,
      });
    }
    const bytes = Buffer.from(JSON.stringify({
      schema: ZCODE_SQLITE_TRANSCRIPT_SCHEMA,
      snapshot: { consistency: "sqlite-read-transaction", currentConversation: true, messageCount: rows.length, partCount: parts.length },
      session: { ...session, sessionId },
      messages: [...messages.values()],
    }), "utf8");
    if (bytes.byteLength > maxBytes) return reject("native_source_oversize");
    db.exec("COMMIT");
    transaction = false;
    return {
      bytes, complete: true,
      source: { kind: "native-file", location: dbPath, format: "json" },
      timestampCoverage: "native",
      limitations: ["Complete persisted current conversation in one native SQLite snapshot; runtime readiness and pending input queue are not asserted."],
    };
  } catch (error) {
    if (error instanceof ZcodeNativeTranscriptError) throw error;
    return reject("native_source_unreadable");
  } finally {
    if (transaction) { try { db?.exec("ROLLBACK"); } catch { /* never return partial data */ } }
    db?.close();
  }
}
