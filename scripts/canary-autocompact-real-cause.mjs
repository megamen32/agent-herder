/**
 * Canary for the autocompact incident of 2026-10-14T19:51:31Z: the real zcode
 * receipt of the failed compact turn must yield a human-readable cause through
 * the built artifact, instead of the placeholder [UNKNOWN_ERROR] unknown_error.
 *
 * Reads only the live zcode SQLite database; sends nothing and mutates nothing.
 * Expected 5s/max 30s.
 */
import { DatabaseSync } from "node:sqlite";
import { AutoCompactService, AutoCompactStore } from "../dist/autocontinue/auto-compact.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DB = process.env.ZCODE_DB_PATH ?? join(process.env.HOME ?? "/home/roomhacker", ".zcode", "cli", "db", "db.sqlite");
const SESSION = "sess_0dd4a3ee-bc7d-4008-b9fa-c25146ec5392";
const TURN = "turn_3461f34c-7a3b-4d03-b460-770c79861ba5";
const INCIDENT_INPUT_ID = "autocompact:25ff5a5b69a82eed6004e7c39a0d0c259c4cb63f14fa9c74e7207d3ecdb5b893";

const db = new DatabaseSync(DB, { readOnly: true });
const turn = db.prepare("select * from turn_usage where session_id = ? and turn_id = ?").get(SESSION, TURN);
const request = db.prepare("select query_source, status, error_type, error_message from model_usage where session_id = ? and turn_id = ? and coalesce(error_message,'') <> ''").all(SESSION, TURN);
db.close();

const root = await mkdtemp(join(tmpdir(), "herder-canary-"));
const store = new AutoCompactStore(join(root, "state.json"));
const receipt = {
  inputId: INCIDENT_INPUT_ID, sourceKey: INCIDENT_INPUT_ID.split(":")[1], harness: "zcode", sessionId: SESSION,
  userMessageId: "msg_mv8itlrd_f76c3842-cd77-43de-adeb-12e508bae18c", tokensBefore: 362193,
  turnBoundaryAt: "turn_116c331c-b39d-49ae-813b-9437883921f2", state: "submitting", automatic: true,
  createdAt: "2026-10-14T19:50:16.129Z", updatedAt: "2026-10-14T19:50:16.129Z",
};
await store.claim(receipt, undefined);

const notices = [];
// The real turn_usage row as the durable receipt, plus the per-request detail the
// built zcode adapter now reads from model_usage.
const nativeLastTurn = {
  turnId: String(turn.turn_id), status: String(turn.status), userMessageId: undefined,
  startedAt: Number(turn.started_at), completedAt: Number(turn.completed_at),
  cancelledByUser: Number(turn.cancelled_by_user) === 1,
  errorType: turn.error_type ?? undefined, errorCode: turn.error_code ?? undefined,
  ...(request[0]?.error_message ? {
    modelErrorType: request[0].error_type ?? undefined,
    errorMessage: request[0].error_message ?? undefined,
  } : {}),
};
const now = Date.parse("2026-10-14T19:51:43.500Z");
const service = new AutoCompactService({
  adapters: new Map([["zcode", { isReady: () => true, getSession: async () => ({
    id: SESSION, harness: "zcode", cwd: "/home/roomhacker", status: "idle",
    lastActivity: new Date(now).toISOString(), meta: {
      nativeLoaded: true, nativeStatus: "idle", nativeHumanMessageCount: 12,
      latestUserPrompt: { id: receipt.userMessageId }, nativeLastTurn,
      nativeContextUsage: { used: 362193, size: 1000000, cache: {} },
    } }), listSessions: async () => [] }]]),
  store, held: async () => false, worthResuming: async () => true, now: () => now,
  notify: async (notice) => { notices.push(notice); },
});
await service.tick();
await service.tick();

const settled = (await store.read()).operations[0];
const body = notices[0]?.body ?? "";
const result = {
  builtArtifact: join(import.meta.dirname, "../dist/autocontinue/auto-compact.js"),
  realIncidentInputId: INCIDENT_INPUT_ID,
  realSessionId: SESSION,
  realTurnId: TURN,
  nativeTurnReceipt: { status: nativeLastTurn.status, errorType: nativeLastTurn.errorType, errorCode: nativeLastTurn.errorCode },
  nativeRequestReceipt: request.map((row) => ({ querySource: row.query_source, status: row.status, errorType: row.error_type, errorMessage: row.error_message })),
  turnBeforeFix: "[UNKNOWN_ERROR] unknown_error",
  settledCause: settled?.cause,
  settledState: settled?.state,
  noticeBody: body,
  namedRealCause: /Network connection failed for the provider request\./.test(body) && /network_error/.test(body),
  placeholderSuppressed: !body.includes("UNKNOWN_ERROR"),
  compactSessionCalls: 0,
  unchangedAfterSecondTick: (await store.read()).operations.length === 1,
};
await writeFile(join(root, "canary.json"), `${JSON.stringify(result, null, 2)}\n`);
await rm(root, { recursive: true, force: true });
console.log(JSON.stringify(result, null, 2));
if (!result.namedRealCause || !result.placeholderSuppressed || !result.unchangedAfterSecondTick) process.exitCode = 1;