import {DatabaseSync} from 'node:sqlite';
import type {OwnedZcodeShutdownProof} from '../human-stop-store.js';

export type ZcodeRecoveryBoundary = {turnId:string;userMessageId:string;completedAt:number};

/** Native persisted attribution survives a strict SDK event/message decoder.
 * A prefix or prompt-text match is insufficient; require the exact command ID
 * in this session's native user anchor, then its exact assistant/turn parent. */
export function zcodeNativeAdmission(path:string,id:string,inputIds:string[]): {state:'unknown'|'admitted'|'started'|'failed';userMessageId?:string;turnId?:string} {
 let db:DatabaseSync|undefined;
 try {
  db=new DatabaseSync(path,{readOnly:true});
  for(const inputId of inputIds){
   const user=db.prepare(`select id,data from message where session_id=? and json_valid(data)
    and json_extract(data,'$.role')='user' and (json_extract(data,'$.anchor.sourceCommandId')=?
     or json_extract(data,'$.metadata.inputIntent.sourceCommandId')=?
     or json_extract(data,'$.metadata.sourceCommandId')=?) order by sequence desc limit 1`).get(id,inputId,inputId,inputId) as any;
   if(!user)continue;
   const turn=db.prepare('select turn_id,status from turn_usage where session_id=? and user_message_id=? order by started_at desc limit 1').get(id,user.id) as any;
   if(['failed','error','cancelled'].includes(turn?.status))return {state:'failed',userMessageId:user.id,turnId:turn.turn_id};
   const assistant=db.prepare(`select 1 from message where session_id=? and json_valid(data)
    and json_extract(data,'$.role')='assistant' and (json_extract(data,'$.parentID')=? or json_extract(data,'$.parentMessageId')=?) limit 1`).get(id,user.id,user.id);
   const turnId=turn?.turn_id??JSON.parse(user.data).anchor?.turnId;
   return {state:assistant||turn?.status==='completed'?'started':'admitted',userMessageId:user.id,...(typeof turnId==='string'&&turnId?{turnId}:{})};
  }
 }catch{ /* A missing/unknown native schema never permits send or replay. */ }finally{db?.close();}
 return {state:'unknown'};
}

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

/** Only an externally confirmed exact parent crash may use this attribution
 * guard. This does not discover crashes or reinterpret generic cancellation. */
export function zcodeConfirmedCrashBoundary(path:string,id:string,proof:OwnedZcodeShutdownProof,boundary:ZcodeRecoveryBoundary,controllerStartedAt?:number):boolean {
 if(proof.turnId!==boundary.turnId||proof.userMessageId!==boundary.userMessageId||!proof.sourceCommandId
  ||boundary.completedAt<proof.at||boundary.completedAt-proof.at>120000||!zcodeRecoveryBoundaryCurrent(path,id,boundary))return false;
 let db:DatabaseSync|undefined;
 try{
  db=new DatabaseSync(path,{readOnly:true});
  const session=db.prepare('select parent_id from session where id=?').get(id) as any;
  if(!session||session.parent_id!==null)return false;
  const user=db.prepare('select data from message where session_id=? and id=?').get(id,proof.userMessageId) as any;
  if(JSON.parse(user?.data??'{}').anchor?.sourceCommandId!==proof.sourceCommandId)return false;
  const turn=db.prepare('select status,started_at from turn_usage where session_id=? and turn_id=? and user_message_id=?').get(id,proof.turnId,proof.userMessageId) as any;
  if(turn?.status!=='cancelled'||!Number.isSafeInteger(turn.started_at)||turn.started_at>proof.at
    ||(controllerStartedAt!==undefined&&(controllerStartedAt>proof.at||turn.started_at<controllerStartedAt)))return false;
  const tail=db.prepare(`select data,time_updated from message where session_id=? and json_valid(data)
    and not(coalesce(json_extract(data,'$.synthetic'),0)=1 and coalesce(json_extract(data,'$.semantics.origin'),'')='agent_runtime') order by sequence desc limit 1`).get(id) as any;
  const data=JSON.parse(tail?.data??'{}');
  if(data.role!=='assistant'||data.parentID!==proof.userMessageId||data.error||['stop','length'].includes(data.finish)
    ||typeof tail.time_updated!=='number'||tail.time_updated>boundary.completedAt)return false;
  const pending=db.prepare(`select count(*) as n from part where session_id=? and json_valid(data) and json_extract(data,'$.type')='tool'
    and coalesce(json_extract(data,'$.state.status'),'') not in ('completed','error')`).get(id) as any;
  return pending?.n===0;
 }catch{return false;}finally{db?.close();}
}

/** Loaded/subscribed is not ownership: require the active turn's exact native
 * input to belong to Herder, and exclude any outstanding Desktop continuation. */
export function zcodeActiveInputOwnership(path:string,id:string,accepted?:{turnId?:string;inputId?:string}): {owned:boolean;reason:string} {
 let db:DatabaseSync|undefined;
 try {
  db=new DatabaseSync(path,{readOnly:true});
  const user=db.prepare(`select id,data from message where session_id=? and json_valid(data) and json_extract(data,'$.role')='user'
    and not (coalesce(json_extract(data,'$.synthetic'),0)=1 and coalesce(json_extract(data,'$.semantics.origin'),'')='agent_runtime') order by sequence desc limit 1`).get(id) as any;
  const input=db.prepare("select payload from session_input where session_id=? and promoted_message_id=? and status='promoted'").get(id,user?.id ?? '') as any;
  if (!user) return {owned:false,reason:'native_user_missing'};
  const anchor=user.data?JSON.parse(user.data).anchor:{};
  const legacy=accepted?.inputId&&accepted?.turnId&&anchor?.sourceCommandId===accepted.inputId&&anchor?.turnId===accepted.turnId;
  if (!input&&!legacy) return {owned:false,reason:'native_input_receipt_missing'};
  if (input&&JSON.parse(input.payload).intent?.clientId!=='agent-herder') return {owned:false,reason:'foreign_input'};
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

export function ownedZcodeActiveInput(path:string,id:string,accepted?:{turnId?:string;inputId?:string}):boolean {
 return zcodeActiveInputOwnership(path,id,accepted).owned;
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
 turnId?:string;status?:string;userMessageId?:string;sourceCommandId?:string;rootSession?:boolean;pendingInput?:boolean;userMessageMatchesLatest?:boolean;
 assistantSucceeded?:boolean;progressedAfterFailure?:boolean;completedAt?:number;
}):boolean {
 return !!proof && turn.turnId===proof.turnId && turn.status==='cancelled' && turn.rootSession===true
  && (!proof.userMessageId||(turn.userMessageId===proof.userMessageId&&turn.sourceCommandId===proof.sourceCommandId))
  && turn.pendingInput===false && turn.userMessageMatchesLatest===true && turn.assistantSucceeded===false
  && turn.progressedAfterFailure===false && typeof turn.completedAt==='number'
  && turn.completedAt>=proof.at && turn.completedAt-proof.at<=120000;
}
