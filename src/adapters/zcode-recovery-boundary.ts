import {DatabaseSync} from 'node:sqlite';
import type {OwnedZcodeShutdownProof} from '../human-stop-store.js';

export type ZcodeRecoveryBoundary = {turnId:string;userMessageId:string;completedAt:number};

/** Read-only native fence. V4 sendText has no idle-only CAS contract; never
 * pretend baseRevision (used by other commands) gives that guarantee. */
export function zcodeRecoveryBoundaryCurrent(path:string,id:string,boundary:ZcodeRecoveryBoundary):boolean {
 let db:DatabaseSync|undefined;
 try {
  db=new DatabaseSync(path,{readOnly:true});
  const turn=db.prepare('select turn_id,user_message_id,completed_at from turn_usage where session_id=? order by started_at desc,completed_at desc,turn_id desc limit 1').get(id) as any;
  const user=db.prepare(`select id from message where session_id=? and json_valid(data) and json_extract(data,'$.role')='user'
    and not (coalesce(json_extract(data,'$.synthetic'),0)=1 and coalesce(json_extract(data,'$.semantics.origin'),'')='agent_runtime') order by sequence desc limit 1`).get(id) as any;
  const pending=db.prepare("select count(*) as count from session_input where session_id=? and status not in ('promoted','discarded')").get(id) as any;
  return turn?.turn_id===boundary.turnId && turn.user_message_id===boundary.userMessageId
    && turn.completed_at===boundary.completedAt && user?.id===boundary.userMessageId && pending?.count===0;
 } catch { return false; } finally {db?.close();}
}

/** Loaded/subscribed is not ownership: require the active turn's exact native
 * input to belong to Herder, and exclude any outstanding Desktop continuation. */
export function zcodeActiveInputOwnership(path:string,id:string): {owned:boolean;reason:string} {
 let db:DatabaseSync|undefined;
 try {
  db=new DatabaseSync(path,{readOnly:true});
  const user=db.prepare(`select id from message where session_id=? and json_valid(data) and json_extract(data,'$.role')='user'
    and not (coalesce(json_extract(data,'$.synthetic'),0)=1 and coalesce(json_extract(data,'$.semantics.origin'),'')='agent_runtime') order by sequence desc limit 1`).get(id) as any;
  const input=db.prepare("select payload from session_input where session_id=? and promoted_message_id=? and status='promoted'").get(id,user?.id ?? '') as any;
  if (!user) return {owned:false,reason:'native_user_missing'};
  if (!input) return {owned:false,reason:'native_input_receipt_missing'};
  if (JSON.parse(input.payload).intent?.clientId!=='agent-herder') return {owned:false,reason:'foreign_input'};
  if (db.prepare('select 1 from turn_usage where session_id=? and user_message_id=? and completed_at is not null').get(id,user.id)) return {owned:false,reason:'own_input_already_terminal'};
  const foreign=db.prepare(`select count(*) as count from session_input i where i.session_id=? and json_valid(i.payload)
    and coalesce(json_extract(i.payload,'$.intent.clientId'),'')!='agent-herder'
    and (i.status not in ('promoted','discarded') or (i.status='promoted' and not exists
      (select 1 from turn_usage t where t.session_id=i.session_id and t.user_message_id=i.promoted_message_id and t.completed_at is not null)))`).get(id) as any;
  const pending=db.prepare("select count(*) as count from session_input where session_id=? and status not in ('promoted','discarded')").get(id) as any;
  if (foreign?.count!==0) return {owned:false,reason:'outstanding_foreign_input'};
  if (pending?.count!==0) return {owned:false,reason:'pending_native_input'};
  return {owned:true,reason:'owned_active_input'};
 } catch {return {owned:false,reason:'native_input_observation_unavailable'};} finally {db?.close();}
}

export function ownedZcodeActiveInput(path:string,id:string):boolean {
 return zcodeActiveInputOwnership(path,id).owned;
}

/** A historical projection, even one saying running, is never an idle proof. */
export function zcodeShutdownObservation(path:string,id:string,session:any,expectedTurnId?:string): {owned:boolean;reason:string;turnId?:string} {
 if (session?.id!==id) return {owned:false,reason:'session_identity_missing_or_mismatched'};
 const m=session.meta??{};
 if (m.humanStopHeld===true) return {owned:false,reason:'human_hold'};
 if (m.nativeLoaded!==true) return {owned:false,reason:'native_snapshot_unavailable'};
 if (!Number.isFinite(m.nativeStateRevision)) return {owned:false,reason:'native_revision_missing'};
 if (!Array.isArray(m.pendingRequestIds)) return {owned:false,reason:'native_pending_requests_unknown'};
 if (m.pendingRequestIds.length) return {owned:false,reason:'pending_native_request'};
 if (!m.nativeActiveTurnId) return {owned:false,reason:session.status==='idle'&&m.nativeStatus==='idle'?'observed_idle':'active_turn_identity_missing'};
 if (typeof m.nativeActiveTurnId!=='string') return {owned:false,reason:'active_turn_identity_invalid'};
 const turnId=m.nativeActiveTurnId;
 if (session.status!=='running'||m.nativeStatus!=='running') return {owned:false,reason:'native_status_inconsistent',turnId};
 if (expectedTurnId&&turnId!==expectedTurnId) return {owned:false,reason:'durable_active_turn_changed',turnId};
 if (m.humanStopHeld!==false) return {owned:false,reason:'human_hold_unknown',turnId};
 return {...zcodeActiveInputOwnership(path,id),turnId};
}

export function ownedShutdownMatches(proof:OwnedZcodeShutdownProof|undefined,turn: {
 turnId?:string;status?:string;rootSession?:boolean;pendingInput?:boolean;userMessageMatchesLatest?:boolean;
 assistantSucceeded?:boolean;progressedAfterFailure?:boolean;completedAt?:number;
}):boolean {
 return !!proof && turn.turnId===proof.turnId && turn.status==='cancelled' && turn.rootSession===true
  && turn.pendingInput===false && turn.userMessageMatchesLatest===true && turn.assistantSucceeded===false
  && turn.progressedAfterFailure===false && typeof turn.completedAt==='number'
  && turn.completedAt>=proof.at && turn.completedAt-proof.at<=120000;
}
