import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ZcodeRetainedInput {
  version: 1;
  harness: "zcode";
  origin: "automation";
  sessionId: string;
  cwd: string;
  logicalInputId: string;
  queueItemId: string;
  nativePayload: string;
  text: string;
  attachments: Array<{ ref: string; fileName?: string; mime?: string; bytes?: number; realPath: string; contentBytes: number; sha256: string }>;
  admittedSequence: number;
  createdAt: number;
  capturedAt: number;
  latestUser: { id: string; sequence: number } | null;
  fingerprint: string;
}

export const retainedInputFingerprint = (input: Omit<ZcodeRetainedInput, "fingerprint">): string =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");

export function supportedRetainedExecution(intent: any): boolean {
  const model = intent?.modelSelection;
  return intent?.planEnabled === false && ["build", "edit", "yolo"].includes(intent.mode)
    && typeof model?.providerId === "string" && typeof model?.modelId === "string"
    && Object.keys(model).every(key => ["providerId", "modelId", "options"].includes(key))
    && Object.keys(model.options ?? {}).every(key => key === "reasoningLevel")
    && (model.options?.reasoningLevel === undefined || typeof model.options.reasoningLevel === "string");
}

export function sameRetainedModel(left: any, right: any): boolean {
  return !!left && !!right && Object.keys(right).every(key=>["providerId","modelId","options"].includes(key))
    && Object.keys(right.options ?? {}).every(key=>key==="reasoningLevel")
    && left.providerId === right.providerId && left.modelId === right.modelId
    && (left.options?.reasoningLevel ?? null) === (right.options?.reasoningLevel ?? null);
}

export function validateRetainedInput(input: ZcodeRetainedInput): void {
  const { fingerprint, ...body } = input;
  if (input.version !== 1 || input.harness !== "zcode" || input.origin !== "automation"
    || !input.sessionId || !input.logicalInputId.startsWith("agent-herder:auto:") || resolve(input.cwd) !== input.cwd
    || !Number.isSafeInteger(input.admittedSequence) || !Number.isSafeInteger(input.createdAt)
    || !Number.isSafeInteger(input.capturedAt) || !Array.isArray(input.attachments)
    || input.attachments.length > 16 || Buffer.byteLength(input.nativePayload, "utf8") > 512 * 1024
    || Buffer.byteLength(input.text, "utf8") > 256 * 1024 || retainedInputFingerprint(body) !== fingerprint) {
    throw new Error("Сохранённый ввод не прошёл проверку идентичности");
  }
  const payload = JSON.parse(input.nativePayload);
  if (payload.text !== input.text || payload.intent?.clientId !== "agent-herder"
    || payload.intent.sourceCommandId !== input.logicalInputId || payload.intent.queueItemId !== input.queueItemId
    || payload.intent.kind !== "sendText" || payload.intent.requestedDelivery !== "queue"
    || !supportedRetainedExecution(payload.intent)) {
    throw new Error("Исходный native ввод не принадлежит этой доставке");
  }
}

export function retainedAttachmentsCurrent(input: ZcodeRetainedInput): boolean {
  try {
    return input.attachments.reduce((sum,file)=>sum+file.contentBytes,0)<=16*1024*1024 && input.attachments.every(file => realpathSync(file.ref) === file.realPath
      && statSync(file.ref).isFile() && statSync(file.ref).size === file.contentBytes
      && (file.bytes === undefined || file.contentBytes === file.bytes)
      && createHash("sha256").update(readFileSync(file.ref)).digest("hex") === file.sha256);
  } catch { return false; }
}

function latestUser(db: DatabaseSync, sessionId: string): ZcodeRetainedInput["latestUser"] {
  const row = db.prepare(`select id,sequence from message where session_id=? and json_valid(data)
    and json_extract(data,'$.role')='user' and not(coalesce(json_extract(data,'$.synthetic'),0)=1
      and coalesce(json_extract(data,'$.semantics.origin'),'')='agent_runtime') order by sequence desc limit 1`).get(sessionId) as any;
  return row ? { id: row.id, sequence: row.sequence } : null;
}

function noExecution(db: DatabaseSync, input: Pick<ZcodeRetainedInput, "sessionId" | "logicalInputId" | "queueItemId">): boolean {
  // Search complete native rows, not a bounded history page. Unknown JSON is
  // not negative evidence. Any exact command/queue reference in transcript or
  // tool material conservatively prevents replay, even without a promoted row.
  for (const table of ["message", "part"]) {
    const row = db.prepare(`select count(*) as n from ${table} where session_id=? and
      (not json_valid(data) or instr(data,?)>0 or instr(data,?)>0)`).get(input.sessionId, input.logicalInputId, input.queueItemId) as any;
    if (row.n !== 0) return false;
  }
  return true;
}

function exactSession(db: DatabaseSync, input: Pick<ZcodeRetainedInput, "sessionId" | "cwd">): boolean {
  const session = db.prepare("select directory,parent_id from session where id=?").get(input.sessionId) as any;
  return !!session && session.parent_id === null && resolve(session.directory) === input.cwd;
}

function configurationCurrent(db: DatabaseSync, input: ZcodeRetainedInput): boolean {
  const original = JSON.parse(input.nativePayload).intent;
  const states = db.prepare("select type,data from session_entry where session_id=? and type in ('runtime/execution_state','runtime/model_selection')").all(input.sessionId) as any[];
  if (states.length !== 2 || new Set(states.map(row=>row.type)).size !== 2) return false;
  const execution = JSON.parse(states.find(row=>row.type==='runtime/execution_state').data);
  const model = JSON.parse(states.find(row=>row.type==='runtime/model_selection').data).modelSelection;
  return execution.mode === original.mode && execution.planEnabled === original.planEnabled && sameRetainedModel(original.modelSelection, model);
}

/** Explicit candidates only. A prefix alone never establishes ownership. */
export function captureZcodeInput(path: string, sessionId: string, logicalInputId: string, cwd: string): ZcodeRetainedInput {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("begin");
    const row = db.prepare("select * from session_input where session_id=? and id=?").get(sessionId, `queue_${logicalInputId}`) as any;
    if (!row || row.status !== "admitted" || row.promoted_message_id !== null || row.promoted_sequence !== null
      || row.kind !== "sendText" || row.delivery !== "queue" || !exactSession(db, { sessionId, cwd: resolve(cwd) })) {
      throw new Error("Нет точного собственного неисполненного ввода для сохранения");
    }
    const payload = JSON.parse(row.payload), intent = payload.intent;
    if (intent?.clientId !== "agent-herder" || intent.sourceCommandId !== logicalInputId || intent.queueItemId !== row.id
      || intent.kind !== "sendText" || intent.requestedDelivery !== "queue" || intent.admittedDelivery !== "queue"
      || intent.text !== payload.text || typeof payload.text !== "string"
      || payload.conversationInputIntent?.sourceCommandId !== logicalInputId
      || !noExecution(db, { sessionId, logicalInputId, queueItemId: row.id })) {
      throw new Error("Native происхождение или отсутствие исполнения не подтверждено");
    }
    // This recovery seam supports regular build input only. Preserve the full
    // original envelope, but do not silently drop execution overrides or turn
    // a plan/Goal input into an ordinary prompt.
    if (!supportedRetainedExecution(intent)
      || Object.keys(intent).some(key=>!["sourceCommandId","queueItemId","clientId","kind","text","modelSelection","mode","planEnabled","admissionSeq","admittedAt","requestedDelivery","admittedDelivery","queuePosition","attachmentRefs"].includes(key))
      || Object.keys(payload).some(key => !["text", "intent", "conversationInputIntent"].includes(key))) {
      throw new Error("Параметры исполнения исходного ввода не поддержаны для точного восстановления");
    }
    if (!Array.isArray(intent.attachmentRefs ?? [])) throw new Error("Формат вложений неизвестен");
    const attachments = (intent.attachmentRefs ?? []).map((file: any) => {
      if (!file || typeof file.ref !== "string" || !file.ref.startsWith("/")
        || (file.fileName !== undefined && typeof file.fileName !== "string") || (file.mime !== undefined && typeof file.mime !== "string")
        || (file.bytes !== undefined && (!Number.isSafeInteger(file.bytes) || file.bytes < 0))
        || Object.keys(file).some(key => !["ref", "fileName", "mime", "bytes"].includes(key))) throw new Error("Вложение нельзя сохранить точно");
      const stat = statSync(file.ref);
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || (file.bytes !== undefined && file.bytes !== stat.size)) throw new Error("Размер вложения не подтверждён");
      return { ...file, realPath: realpathSync(file.ref), contentBytes: stat.size, sha256: createHash("sha256").update(readFileSync(file.ref)).digest("hex") };
    });
    if (attachments.reduce((sum:number,file:any)=>sum+file.contentBytes,0)>16*1024*1024) throw new Error("Общий размер вложений превышает бюджет точного сохранения");
    // Unrecognised separate file bodies or ambient references cannot silently
    // disappear from the reconstructed public sendText payload.
    if (payload.attachments || intent.sharedContextRefs?.length || payload.files) throw new Error("Дополнительный контекст ввода не поддержан для точного восстановления");
    const body: Omit<ZcodeRetainedInput, "fingerprint"> = {
      version: 1, harness: "zcode", origin: "automation", sessionId, cwd: resolve(cwd), logicalInputId,
      queueItemId: row.id, nativePayload: row.payload, text: payload.text, attachments,
      admittedSequence: row.admitted_sequence, createdAt: row.time_created, capturedAt: Date.now(), latestUser: latestUser(db, sessionId),
    };
    const capture = { ...body, fingerprint: retainedInputFingerprint(body) };
    validateRetainedInput(capture);
    return capture;
  } finally { db.close(); }
}

/** A definite refusal/NOEXECUTION proof; missing rows or schema always reject. */
export function zcodeUndeliveredFence(path: string, input: ZcodeRetainedInput, attemptId: string): boolean {
  let db: DatabaseSync | undefined;
  try {
    validateRetainedInput(input);
    if (attemptId !== `${input.logicalInputId}:delivery-attempt:1`) return false;
    if (!retainedAttachmentsCurrent(input)) return false;
    db = new DatabaseSync(path, { readOnly: true }); db.exec("begin");
    if (!exactSession(db, input) || !configurationCurrent(db, input)) return false;
    const row = db.prepare("select * from session_input where session_id=? and id=?").get(input.sessionId, input.queueItemId) as any;
    if (!row || row.status !== "discarded" || row.status_reason !== "session_resumed"
      || row.promoted_message_id !== null || row.promoted_sequence !== null || row.payload !== input.nativePayload
      || row.kind !== "sendText" || row.delivery !== "queue" || row.time_created !== input.createdAt
      || row.admitted_sequence !== input.admittedSequence || !noExecution(db, input)) return false;
    if (JSON.stringify(latestUser(db, input.sessionId)) !== JSON.stringify(input.latestUser)) return false;
    if (db.prepare("select 1 from session_input where session_id=? and status not in ('promoted','discarded','cancelled') limit 1").get(input.sessionId)) return false;
    if (db.prepare("select 1 from turn_usage where session_id=? and completed_at is null limit 1").get(input.sessionId)) return false;
    // A tool can begin during the last native await without a new user/turn
    // row or either delivery ID. Unknown tool state must also reject dispatch.
    if (db.prepare(`select 1 from part where session_id=? and json_valid(data)
      and json_extract(data,'$.type')='tool' and coalesce(json_extract(data,'$.state.status'),'')
      not in ('completed','error') limit 1`).get(input.sessionId)) return false;
    if (db.prepare("select 1 from session_input where session_id=? and id=?").get(input.sessionId, `queue_${attemptId}`)) return false;
    if (!noExecution(db, { ...input, logicalInputId: attemptId, queueItemId: `queue_${attemptId}` })) return false;
    return true;
  } catch { return false; } finally { db?.close(); }
}

export function zcodeRetainedAttemptReceipt(path: string, input: ZcodeRetainedInput, attemptId: string): { state: "admitted" | "failed" | "unknown"; pending?: boolean } {
  let db: DatabaseSync | undefined;
  try {
    validateRetainedInput(input); db = new DatabaseSync(path, { readOnly: true });
    if (attemptId !== `${input.logicalInputId}:delivery-attempt:1`) return { state: "unknown" };
    if (!exactSession(db, input)) return { state: "unknown" };
    const row = db.prepare("select * from session_input where session_id=? and id=?").get(input.sessionId, `queue_${attemptId}`) as any;
    if (!row) return { state: "unknown" };
    const payload = JSON.parse(row.payload), intent = payload.intent, original = JSON.parse(input.nativePayload).intent;
    const wireFiles = input.attachments.map(({realPath: _realPath, contentBytes: _contentBytes, sha256: _sha256, ...file}) => file);
    if (row.kind !== "sendText" || payload.text !== input.text || intent?.text !== input.text
      || intent.clientId !== "agent-herder" || intent.sourceCommandId !== attemptId || intent.queueItemId !== `queue_${attemptId}`
      || intent.kind !== "sendText" || intent.requestedDelivery !== "queue"
      || payload.conversationInputIntent?.sourceCommandId !== attemptId
      || JSON.stringify(intent.attachmentRefs ?? []) !== JSON.stringify(wireFiles)
      || !sameRetainedModel(original.modelSelection, intent.modelSelection)
      || intent.mode !== original.mode || intent.planEnabled !== original.planEnabled) return { state: "unknown" };
    if (row?.status === "admitted") return { state: "admitted", pending: true };
    if (row?.status === "promoted" && row.promoted_message_id) {
      const message = db.prepare("select data from message where session_id=? and id=?").get(input.sessionId, row.promoted_message_id) as any;
      const info = JSON.parse(message?.data ?? "{}");
      if (info.role !== "user" || info.anchor?.sourceCommandId !== attemptId) return { state: "unknown" };
      return { state: "admitted", pending: false };
    }
    if (["discarded", "cancelled"].includes(row?.status)) return { state: "failed" };
    return { state: "unknown" };
  } catch { return { state: "unknown" }; } finally { db?.close(); }
}
