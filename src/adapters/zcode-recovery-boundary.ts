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
export function ownedZcodeActiveInput(path:string,id:string):boolean {
 let db:DatabaseSync|undefined;
 try {
  db=new DatabaseSync(path,{readOnly:true});
  const user=db.prepare(`select id from message where session_id=? and json_valid(data) and json_extract(data,'$.role')='user'
    and not (coalesce(json_extract(data,'$.synthetic'),0)=1 and coalesce(json_extract(data,'$.semantics.origin'),'')='agent_runtime') order by sequence desc limit 1`).get(id) as any;
  const input=db.prepare("select payload from session_input where session_id=? and promoted_message_id=? and status='promoted'").get(id,user?.id ?? '') as any;
  if (!input || JSON.parse(input.payload).intent?.clientId!=='agent-herder') return false;
  if (db.prepare('select 1 from turn_usage where session_id=? and user_message_id=? and completed_at is not null').get(id,user.id)) return false;
  const foreign=db.prepare(`select count(*) as count from session_input i where i.session_id=? and json_valid(i.payload)
    and coalesce(json_extract(i.payload,'$.intent.clientId'),'')!='agent-herder'
    and (i.status not in ('promoted','discarded') or (i.status='promoted' and not exists
      (select 1 from turn_usage t where t.session_id=i.session_id and t.user_message_id=i.promoted_message_id and t.completed_at is not null)))`).get(id) as any;
  const pending=db.prepare("select count(*) as count from session_input where session_id=? and status not in ('promoted','discarded')").get(id) as any;
  return foreign?.count===0 && pending?.count===0;
 } catch {return false;} finally {db?.close();}
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
