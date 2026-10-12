import {readFileSync, readdirSync, realpathSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';

export type WorkspaceProcess = {pid:number;parentPid:number;startTick:string;cwd:string;groupId:number;descendants:Array<{pid:number;startTick:string}>};
export type ProcessBirth={pid:number;startTick:string;parentPid:number};
export type ServiceOrigin={unit:'agent-herder.service';invocationId:string};
export type OwnerExit={unit:string;invocationId:string;code:string;status:string;atMicros:string};
export type NativeOwnerProof={service:ServiceOrigin;generationId:string;turnId:string;inputId:string;userMessageId:string;cwd:string;controller:ProcessBirth;sdk:ProcessBirth;runtime:WorkspaceProcess;at:number};
export type WorkspaceCrash = {turnId:string;inputId:string;userMessageId:string;cwd:string;runtime:WorkspaceProcess;sdkPid:number;at:number;owner?:NativeOwnerProof};
export type NativeHookTurn={sessionId:string;cwd:string;turnId:string;inputId:string;userMessageId:string;at:string;origin:'automation'|'real_user';finished:boolean;progress:string};
export interface WorkspaceProcessProbe {
 serviceOrigin?():ServiceOrigin|null;
 ownerExit?(proof:NativeOwnerProof):OwnerExit|null;
 birth?(pid:number):ProcessBirth|null;
 birthGone?(proof:ProcessBirth):boolean;
 capture(pid:number,sdkPid:number,cwd:string):WorkspaceProcess|null;
 gone(proof:WorkspaceProcess):boolean;
}
function stat(pid:number){
 const text=readFileSync(`/proc/${pid}/stat`,'utf8'),fields=text.slice(text.lastIndexOf(') ')+2).split(' ');
 return {pid,parentPid:Number(fields[1]),groupId:Number(fields[2]),startTick:fields[19]};
}
function processes(){
 const names=readdirSync('/proc').filter(n=>/^\d+$/.test(n));
 if(names.length>16384)throw Error('Process observation budget exceeded');
 return names.flatMap(n=>{try{return [stat(Number(n))];}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}});
}
export const workspaceProcessProbe:WorkspaceProcessProbe={
 serviceOrigin(){try{
  const invocationId=process.env.INVOCATION_ID;
  if(!invocationId||!/^[0-9a-f]{32}$/i.test(invocationId)||!/\/agent-herder\.service(?:\/|$)/m.test(readFileSync('/proc/self/cgroup','utf8')))return null;
  return {unit:'agent-herder.service',invocationId};
 }catch{return null;}},
 ownerExit(proof){try{
  const raw=execFileSync('/usr/bin/journalctl',[
   '--user-unit=agent-herder.service','--output=json','--no-pager','-n','4',
   `USER_INVOCATION_ID=${proof.service.invocationId}`,'MESSAGE_ID=98e322203f7a4ed290d09fe03c09fe15',
  ],{encoding:'utf8',timeout:2000,maxBuffer:65536,stdio:['ignore','pipe','pipe']});
  const rows=raw.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as Record<string,unknown>);
  const matches=rows.filter(d=>d.USER_UNIT===proof.service.unit&&d.USER_INVOCATION_ID===proof.service.invocationId
   &&d.MESSAGE_ID==='98e322203f7a4ed290d09fe03c09fe15'&&d._UID===String(process.getuid?.())
   &&d.EXIT_CODE==='killed'&&d.EXIT_STATUS==='9'&&typeof d.__REALTIME_TIMESTAMP==='string'&&/^\d+$/.test(d.__REALTIME_TIMESTAMP));
  if(matches.length!==1)return null;
  return {unit:proof.service.unit,invocationId:proof.service.invocationId,code:'killed',status:'9',atMicros:matches[0].__REALTIME_TIMESTAMP as string};
 }catch{return null;}},
 birth(pid){try{return stat(pid);}catch{return null;}},
 birthGone(proof){try{return stat(proof.pid).startTick!==proof.startTick;}catch(e){return (e as NodeJS.ErrnoException).code==='ENOENT';}},
 capture(pid,sdkPid,cwd){try{
  const root=stat(pid);
  if(root.parentPid!==sdkPid||root.groupId!==pid||realpathSync(`/proc/${pid}/cwd`)!==cwd)return null;
  const descendants:Array<{pid:number;startTick:string}>=[],seen=new Set([pid]),queue=[pid];
  for(const parent of queue){
   const tasks=readdirSync(`/proc/${parent}/task`);if(tasks.length>256||queue.length>256)throw Error('Owned descendant budget exceeded');
   for(const task of tasks){const children=readFileSync(`/proc/${parent}/task/${task}/children`,'utf8').trim().split(/\s+/).filter(Boolean);
    for(const child of children){const childPid=Number(child);if(!seen.has(childPid)){const row=stat(childPid);seen.add(childPid);queue.push(childPid);descendants.push({pid:row.pid,startTick:row.startTick});}}}
  }
  return {...root,cwd,descendants};
 }catch{return null;}},
 gone(proof){try{
  const rows=processes();
  if(rows.some(r=>r.pid===proof.pid&&r.startTick===proof.startTick||r.groupId===proof.groupId))return false;
  return !proof.descendants.some(child=>rows.some(r=>r.pid===child.pid&&r.startTick===child.startTick));
 }catch{return false;}}
};

/** Native hook transport can omit input_id. Resolve it from the actual promoted
 * intent and exact native turn anchor; a prefix/text/claimed origin never suffices. */
export function nativeHookTurn(path:string,id:string,turnId:string,cwd:string):NativeHookTurn|null{
 let db:DatabaseSync|undefined;
 try{
  if(!turnId||!cwd.startsWith('/'))return null;
  db=new DatabaseSync(path,{readOnly:true});db.exec('begin');
  const session=db.prepare('select directory,parent_id from session where id=?').get(id) as any;
  if(!session||session.directory!==cwd||session.parent_id!==null)return null;
  const user=db.prepare(`select id,data,time_created from message where session_id=? and json_valid(data) and json_extract(data,'$.role')='user'
   and not(coalesce(json_extract(data,'$.synthetic'),0)=1 and coalesce(json_extract(data,'$.semantics.origin'),'')='agent_runtime') order by sequence desc limit 1`).get(id) as any;
  const anchor=JSON.parse(user?.data??'{}').anchor;
  if(anchor?.turnId!==turnId||!anchor.sourceCommandId||!Number.isSafeInteger(user.time_created))return null;
  const row=db.prepare("select id,payload from session_input where session_id=? and promoted_message_id=? and status='promoted'").get(id,user.id) as any;
  const intent=JSON.parse(row?.payload??'{}').intent;
  if(intent?.sourceCommandId!==anchor.sourceCommandId||row.id!=='queue_'+anchor.sourceCommandId||intent.kind!=='sendText'||intent.queueItemId!==row.id)return null;
  const origin=intent.clientId==='agent-herder'?'automation':/^client-[0-9a-f-]{36}$/.test(intent.clientId??'')?'real_user':null;
  if(!origin)return null;
  const tail=db.prepare(`select id,sequence,time_updated,data from message where session_id=? and json_valid(data)
   and json_extract(data,'$.role')='assistant' and json_extract(data,'$.anchor.turnId')=? order by sequence desc limit 1`).get(id,turnId) as any;
  const assistant=JSON.parse(tail?.data??'{}');
  const unsettled=db.prepare(`select count(*) n from part p join message m on p.message_id=m.id where p.session_id=?
   and json_extract(m.data,'$.anchor.turnId')=? and (not json_valid(p.data) or
    (json_extract(p.data,'$.type')='tool' and coalesce(json_extract(p.data,'$.state.status'),'') not in ('completed','error')))` ).get(id,turnId) as any;
  return {sessionId:id,cwd,turnId,inputId:anchor.sourceCommandId,userMessageId:user.id,at:new Date(user.time_created).toISOString(),origin,
   finished:!!tail&&assistant.parentID===user.id&&!assistant.error&&['stop','length'].includes(assistant.finish)&&unsettled?.n===0,
   progress:JSON.stringify({id:tail?.id,sequence:tail?.sequence,at:tail?.time_updated})};
 }catch{return null;}finally{db?.close();}
}

/** Exact promoted own admission + active tail. Empty turn_usage is permitted,
 * but successful completion, another user/input, unknown JSON/permissions are not. */
export function workspaceInputBoundary(path:string,id:string,inputId:string,cwd:string,ownerObservedAt?:number):{turnId:string;userMessageId:string;finished:boolean}|null{
 let db:DatabaseSync|undefined;
 try{
  db=new DatabaseSync(path,{readOnly:true});db.exec('begin');
  const session=db.prepare('select directory,parent_id from session where id=?').get(id) as any;
  if(!session||session.parent_id!==null||session.directory!==cwd)return null;
  const input=db.prepare("select payload,promoted_message_id from session_input where session_id=? and id=? and status='promoted'").get(id,'queue_'+inputId) as any;
  const intent=JSON.parse(input?.payload??'{}').intent;
  if(intent?.clientId!=='agent-herder'||intent.sourceCommandId!==inputId||intent.kind!=='sendText'
    ||intent.queueItemId!=='queue_'+inputId||!input.promoted_message_id)return null;
  const user=db.prepare(`select id,data from message where session_id=? and json_valid(data) and json_extract(data,'$.role')='user'
   and not(coalesce(json_extract(data,'$.synthetic'),0)=1 and coalesce(json_extract(data,'$.semantics.origin'),'')='agent_runtime') order by sequence desc limit 1`).get(id) as any;
  const anchor=JSON.parse(user?.data??'{}').anchor;
  if(user?.id!==input.promoted_message_id||anchor?.sourceCommandId!==inputId||typeof anchor.turnId!=='string'||!anchor.turnId)return null;
  if(db.prepare("select 1 from session_input where session_id=? and status not in ('promoted','discarded','cancelled') limit 1").get(id))return null;
  for(const table of ['message','part'])if(db.prepare('select 1 from '+table+' where session_id=? and not json_valid(data) limit 1').get(id))return null;
  if(db.prepare("select 1 from part where session_id=? and json_extract(data,'$.type')='tool' and coalesce(json_extract(data,'$.state.status'),'') not in ('pending','running','completed','error') limit 1").get(id))return null;
  const tail=db.prepare(`select data from message where session_id=? and json_valid(data)
   and json_extract(data,'$.role')='assistant' and json_extract(data,'$.anchor.turnId')=? order by sequence desc limit 1`).get(id,anchor.turnId) as any;
  const assistant=JSON.parse(tail?.data??'{}');
  if(!tail||assistant.parentID!==user.id||assistant.error)return null;
  const terminal=db.prepare('select status,started_at,completed_at from turn_usage where session_id=? and turn_id=? order by started_at desc limit 1').get(id,anchor.turnId) as any;
  if(ownerObservedAt!==undefined){
   if(terminal?.status!=='cancelled'||!Number.isSafeInteger(terminal.started_at)||!Number.isSafeInteger(terminal.completed_at)
    ||terminal.started_at>ownerObservedAt||terminal.completed_at<ownerObservedAt||terminal.completed_at>Date.now())return null;
   // A late tool/background execution can appear without a new user anchor.
   // Settling an old tool is allowed; newly created work after cancellation is not.
   if(db.prepare("select 1 from part where session_id=? and json_extract(data,'$.type')='tool' and time_created>? limit 1").get(id,terminal.completed_at))return null;
  }else if(terminal?.completed_at!==null&&terminal?.completed_at!==undefined&&terminal.status!=='completed')return null;
  return {turnId:anchor.turnId,userMessageId:user.id,finished:['stop','length'].includes(assistant.finish)||terminal?.status==='completed'};
 }catch{return null;}finally{db?.close();}
}
export function workspaceCrashCurrent(path:string,id:string,proof:WorkspaceCrash,probe:WorkspaceProcessProbe=workspaceProcessProbe):boolean{
 if(proof.owner)return nativeOwnerCrashCurrent(path,id,proof.owner,probe);
 const current=workspaceInputBoundary(path,id,proof.inputId,proof.cwd);
 return !!current&&!current.finished&&current.turnId===proof.turnId&&current.userMessageId===proof.userMessageId&&probe.gone(proof.runtime);
}

/** Existing durable record only: an observed live own generation, not a
 * post-hoc controller packet, authorizes the cancelled native boundary. */
export function parseNativeOwnerProof(value:unknown):NativeOwnerProof|undefined{
 try{
  const p=value as NativeOwnerProof;
  const birth=(b:ProcessBirth)=>!!b&&Number.isSafeInteger(b.pid)&&b.pid>0&&Number.isSafeInteger(b.parentPid)&&b.parentPid>=0&&typeof b.startTick==='string'&&/^\d+$/.test(b.startTick);
  if(!p||typeof p!=='object'||p.service?.unit!=='agent-herder.service'||typeof p.service.invocationId!=='string'||! /^[0-9a-f]{32}$/i.test(p.service.invocationId)||!birth(p.controller)||!birth(p.sdk)||p.sdk.parentPid!==p.controller.pid
   ||!birth(p.runtime)||p.runtime.parentPid!==p.sdk.pid||p.runtime.groupId!==p.runtime.pid||p.runtime.cwd!==p.cwd
   ||!Number.isSafeInteger(p.at)||p.at<=0||!p.cwd.startsWith('/')
   ||![p.generationId,p.turnId,p.inputId,p.userMessageId].every(v=>typeof v==='string'&&!!v&&v.length<=4096)
   ||!Array.isArray(p.runtime.descendants)||p.runtime.descendants.length>16384
   ||p.runtime.descendants.some(c=>!Number.isSafeInteger(c.pid)||c.pid<=0||typeof c.startTick!=='string'||!/^\d+$/.test(c.startTick)))return undefined;
  return JSON.parse(JSON.stringify(p)) as NativeOwnerProof;
 }catch{return undefined;}
}
export function nativeOwnerCrashCurrent(path:string,id:string,value:NativeOwnerProof,probe:WorkspaceProcessProbe=workspaceProcessProbe):boolean{
 const p=parseNativeOwnerProof(value);if(!p||!probe.birthGone?.(p.controller)||!probe.birthGone?.(p.sdk)||!probe.gone(p.runtime))return false;
 const exit=probe.ownerExit?.(p);
 if(!exit||exit.unit!==p.service.unit||exit.invocationId!==p.service.invocationId||exit.code!=='killed'||exit.status!=='9'
   ||typeof exit.atMicros!=='string'||!/^\d+$/.test(exit.atMicros))return false;
 const loss=BigInt(exit.atMicros);
 if(loss<BigInt(p.at)*1000n||loss>BigInt(Date.now())*1000n)return false;
 const current=workspaceInputBoundary(path,id,p.inputId,p.cwd,p.at);
 if(!current)return false;
 let db:DatabaseSync|undefined;try{
  db=new DatabaseSync(path,{readOnly:true});
  const terminal=db.prepare("select completed_at from turn_usage where session_id=? and turn_id=? and user_message_id=? and status='cancelled' order by started_at desc limit 1").get(id,p.turnId,p.userMessageId) as any;
  if(!Number.isSafeInteger(terminal?.completed_at)||BigInt(terminal.completed_at)*1000n<loss)return false;
 }catch{return false;}finally{db?.close();}
 return !!current&&!current.finished&&current.turnId===p.turnId&&current.userMessageId===p.userMessageId;
}

/** A late/replayed native cancellation of the qualified dead owner is a
 * technical receipt. An unrelated cancellation remains human-stop evidence. */
export function nativeOwnerCancellationMatches(path:string,id:string,proof:NativeOwnerProof,turnId:string|undefined,at:string|undefined,inputId?:string,probe:WorkspaceProcessProbe=workspaceProcessProbe):boolean{
 if(turnId!==proof.turnId||inputId!==undefined&&inputId!==proof.inputId||!at||!nativeOwnerCrashCurrent(path,id,proof,probe))return false;
 let db:DatabaseSync|undefined;try{
  db=new DatabaseSync(path,{readOnly:true});
  const row=db.prepare("select completed_at from turn_usage where session_id=? and turn_id=? and user_message_id=? and status='cancelled' order by started_at desc limit 1").get(id,proof.turnId,proof.userMessageId) as any;
  return Number.isSafeInteger(row?.completed_at)&&row.completed_at===Date.parse(at);
 }catch{return false;}finally{db?.close();}
}
