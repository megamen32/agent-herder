import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {homedir,hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {AgentSession,HarnessAdapter} from './types/index.js';
import {sessionWorkspaces,sessionWorkspaceKey,type SessionWorkspace} from './session-workspaces.js';
import {createSessionWorkspaceOwnerUpdater} from './session-workspaces-backfill.js';
import {unwrapResult} from './mesh/protocol.js';
export interface ActiveSessionRow {id:string;harness:string;title:string;runtimeHostId:string;parentSessionId?:string;activity:{state:string;observedAt:string;evidence:string;expiresAt?:string};workspaces:Array<Pick<SessionWorkspace,'hostId'|'absolutePath'>&Partial<SessionWorkspace>>}
export interface ActiveHostReceipt {hostId:string;state:string;observedAt:string|null;reason?:string;sources?:Array<{harness:string;exhaustive:boolean;source:string;reason?:string}>}
export interface ActiveInventory {sessions:ActiveSessionRow[];hosts:ActiveHostReceipt[];partial:boolean}
export interface ActiveInventoryQuery {hostId?:string;runtimeHostId?:string;harness?:string;limit?:number;offset?:number}
export const activeInventoryPath=()=>process.env.AGENT_HERDER_ACTIVE_INVENTORY||resolve(homedir(),'.local/state/agent-herder/active-inventory.json');
export function filterActiveInventory(inventory:ActiveInventory,input:ActiveInventoryQuery){
 const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
 const matched=inventory.sessions.filter(row=>(!input.hostId||row.workspaces.some(w=>same(w.hostId,input.hostId!)))&&(!input.runtimeHostId||same(row.runtimeHostId,input.runtimeHostId))&&(!input.harness||input.harness==='all'||row.harness===input.harness));
 const offset=input.offset??0;const sessions=matched.slice(offset,input.limit===undefined?undefined:offset+input.limit);
 const confirmed=matched.filter(s=>s.activity?.state==='active');
 const unassigned=inventory.sessions.filter(s=>!s.workspaces.length&&(!input.runtimeHostId||same(s.runtimeHostId,input.runtimeHostId))&&(!input.harness||input.harness==='all'||s.harness===input.harness)).length;
 const partial=inventory.partial||Boolean(input.hostId&&unassigned);
 return {...inventory,partial,unassignedWorkspaceCount:unassigned,sessions,total:matched.length,activeCount:confirmed.length,activeCountExact:partial?null:confirmed.length,activeRootCount:confirmed.filter(s=>!s.parentSessionId).length,activeChildCount:confirmed.filter(s=>Boolean(s.parentSessionId)).length,unknownActivityCount:matched.length-confirmed.length,countIsLowerBound:partial,limited:sessions.length<matched.length,unknownWorkspaceCount:matched.filter(row=>!row.workspaces.length).length,filters:input};
}
/** Read-only consumers never enumerate adapters or renew freshness. */
export async function readActiveInventory(options:{path?:string;hostId?:string;now?:number;ttlMs?:number}={}):Promise<ActiveInventory>{
 const hostId=options.hostId??hostname();
 try{
  const value=JSON.parse(await readFile(options.path??activeInventoryPath(),'utf8')) as ActiveInventory;
  if(!Array.isArray(value.sessions)||value.hosts?.length!==1||value.hosts[0].hostId!==hostId||value.sessions.some(s=>s.runtimeHostId!==hostId||typeof s.id!=='string'||!Array.isArray(s.workspaces)))throw new Error('active_inventory_identity_invalid');
  const receipt=value.hosts[0],age=(options.now??Date.now())-Date.parse(receipt.observedAt??'');
  if(!Number.isFinite(age)||age< -5000||age>(options.ttlMs??30000))return {...value,partial:true,hosts:[{...receipt,state:'stale',reason:'activity_snapshot_expired'}],sessions:value.sessions.map(s=>({...s,activity:{...s.activity,state:s.activity.expiresAt&&Date.parse(s.activity.expiresAt)>(options.now??Date.now())?s.activity.state:'unknown'}}))};
  const sessions=value.sessions.map(s=>s.activity.expiresAt&&Date.parse(s.activity.expiresAt)<=(options.now??Date.now())?{...s,activity:{...s.activity,state:'unknown'}}:s);
  return {...value,sessions,partial:value.partial||sessions.some(s=>s.activity.state==='unknown')};
 }catch(error){return {sessions:[],partial:true,hosts:[{hostId,state:'unavailable',observedAt:null,reason:(error as NodeJS.ErrnoException).code==='ENOENT'?'activity_snapshot_not_ready':'activity_snapshot_unreadable'}]};}
}
/** Existing owner polling supplies current native sessions; no additional native scan. */
export function startActiveInventoryOwner(snapshot:()=>{sessions:AgentSession[];observedAt:string|null;warming:boolean;failures?:Record<string,string>},adapters:Map<string,HarnessAdapter>,options:{path?:string;hostId?:string;intervalMs?:number}={}){
 const hostId=options.hostId??hostname(),path=options.path??activeInventoryPath();let closed=false,pending=false;let lastGeneration='';
 const updateWorkspaces=createSessionWorkspaceOwnerUpdater({store:sessionWorkspaces,readEvidence:async()=>[]});
 const tick=async()=>{
  if(pending||closed)return;pending=true;
  try{
   const current=snapshot();
   // Workspace declarations may change independently of the native generation.
   const dedicated=await Promise.all([...adapters].filter(([,a])=>typeof (a as HarnessAdapter & {listActiveSessions?:unknown}).listActiveSessions==='function').map(async ([harness,adapter])=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {const sessions=await Promise.race([(adapter as HarnessAdapter & {listActiveSessions():Promise<AgentSession[]>}).listActiveSessions(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('native_activity_deadline')),20000);})]);return {harness,sessions,failed:false};}
    catch{return {harness,sessions:[] as AgentSession[],failed:true};}finally{if(timer)clearTimeout(timer);}
   }));
   const dedicatedNames=new Set(dedicated.map(d=>d.harness));
   const nativeSessions=[...current.sessions.filter(s=>!dedicatedNames.has(s.harness)),...dedicated.flatMap(d=>d.sessions)];
   await updateWorkspaces(nativeSessions.map(s=>({runtimeHostId:hostId,harness:s.harness,nativeSessionId:s.id,lastActivity:s.lastActivity,...(typeof s.meta?.parentSessionId==='string'?{parentSessionId:s.meta.parentSessionId}:{})})));
   const identities=nativeSessions.map(s=>({runtimeHostId:hostId,harness:s.harness,nativeSessionId:s.id}));
   const places=await sessionWorkspaces.readMany(identities);
   const sources=[...adapters].map(([harness,adapter])=>{const r=adapter.getSessionSnapshotReceipt?.();const live=dedicated.find(d=>d.harness===harness);if(!live&&!current.observedAt)return {harness,exhaustive:false,source:r?.source??'native-adapter',reason:'native_snapshot_warming'};if(!live&&current.failures?.[harness])return {harness,exhaustive:false,source:r?.source??'native-adapter',reason:current.failures[harness]};if(live)return {harness,exhaustive:!live.failed,source:'native-active-observer',...(live.failed?{reason:'native_activity_unavailable'}:{})};return {harness,exhaustive:r?.exhaustive??false,source:r?.source??'native-adapter',...(!r?{reason:'native_enumeration_coverage_unknown'}:r.reason?{reason:r.reason}:{})};});
   const sessions=nativeSessions.filter(s=>s.status==='running'||s.status==='needs_input').map(s=>({id:s.id,harness:s.harness,title:s.title,runtimeHostId:hostId,...(typeof s.meta?.parentSessionId==='string'?{parentSessionId:s.meta.parentSessionId}:typeof s.meta?.parentThreadId==='string'?{parentSessionId:s.meta.parentThreadId}:typeof s.meta?.parentID==='string'?{parentSessionId:s.meta.parentID}:{}),activity:{state:'active',observedAt:String(s.meta?.activityObservedAt??current.observedAt!),evidence:String(s.meta?.activityEvidence??s.meta?.transport??'native-adapter-status'),expiresAt:String(s.meta?.activityExpiresAt??new Date(Date.parse(current.observedAt!)+30000).toISOString())},workspaces:places.get(sessionWorkspaceKey({runtimeHostId:hostId,harness:s.harness,nativeSessionId:s.id}))?.workspaces??[]}));
   const value:ActiveInventory={sessions,partial:sources.some(s=>!s.exhaustive),hosts:[{hostId,state:'available',observedAt:current.observedAt??new Date().toISOString(),sources}]};
   const serialized=JSON.stringify(value);if(serialized===lastGeneration)return;
   await mkdir(dirname(path),{recursive:true});const tmp=`${path}.${randomUUID()}.tmp`;await writeFile(tmp,serialized,{mode:0o600});await rename(tmp,path);lastGeneration=serialized;
  }finally{pending=false;}
 };
 const run=()=>void tick().catch(()=>{});const timer=setInterval(run,options.intervalMs??5000);timer.unref();run();return ()=>{closed=true;clearInterval(timer);};
}
export async function activeInventoryFleet(input:ActiveInventoryQuery,peers:readonly {hostId:string;target:string}[],call:(peer:{hostId:string;target:string})=>Promise<unknown>,deadlineMs=3000){
 const selected=peers.filter(p=>!input.runtimeHostId||p.hostId.toLowerCase()===input.runtimeHostId.toLowerCase());
 if(input.runtimeHostId&&!selected.length)throw new Error('active_runtime_host_unknown');
 const hosts=await Promise.all(selected.map(async p=>{let timer:ReturnType<typeof setTimeout>|undefined;try{
  const response=unwrapResult(await Promise.race([call(p),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('activity_host_deadline')),deadlineMs);})])) as unknown as ActiveInventory;
  if(!Array.isArray(response.sessions)||response.hosts?.length!==1||response.hosts[0].hostId!==p.hostId||response.sessions.some(s=>s.runtimeHostId!==p.hostId)||typeof response.partial!=='boolean')throw new Error('active_host_receipt_invalid');
  return response;
 }catch(error){return {sessions:[],partial:true,hosts:[{hostId:p.hostId,state:'unavailable',observedAt:null,reason:error instanceof Error?error.message:'activity_host_unavailable'}]} as ActiveInventory;}finally{if(timer)clearTimeout(timer);}}));
 return filterActiveInventory({sessions:hosts.flatMap(h=>h.sessions),hosts:hosts.flatMap(h=>h.hosts),partial:!hosts.length||hosts.some(h=>h.partial)},input);
}
