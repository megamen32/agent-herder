import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {homedir,hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {AgentSession,HarnessAdapter,SessionSnapshotReceipt} from './types/index.js';
import {sessionWorkspaces,sessionWorkspaceKey,type SessionWorkspace} from './session-workspaces.js';
import {MinimaxCodeControl} from './adapters/minimax-code-control.js';
import {createMavisWorkspaceEvidenceReader,createSessionWorkspaceOwnerUpdater} from './session-workspaces-backfill.js';
import {unwrapResult} from './mesh/protocol.js';
export interface ActiveSessionRow {id:string;harness:string;title:string;runtimeHostId:string;status?:string;parentSessionId?:string;activity:{state:string;observedAt:string;evidence:string;expiresAt?:string};workspaces:Array<Pick<SessionWorkspace,'hostId'|'absolutePath'>&Partial<SessionWorkspace>>}
export interface ActiveHostReceipt {hostId:string;ownerPid?:number;state:string;observedAt:string|null;reason?:string;sources?:Array<{harness:string;exhaustive:boolean;source:string;reason?:string}>}
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
 return {...inventory,partial,unassignedWorkspaceCount:unassigned,sessions,total:matched.length,activeCount:confirmed.length,activeRunningCount:confirmed.filter(s=>s.status!=='needs_input').length,activeWaitingCount:confirmed.filter(s=>s.status==='needs_input').length,activeCountExact:partial?null:confirmed.length,activeRootCount:confirmed.filter(s=>!s.parentSessionId).length,activeChildCount:confirmed.filter(s=>Boolean(s.parentSessionId)).length,unknownActivityCount:matched.length-confirmed.length,countIsLowerBound:partial,limited:sessions.length<matched.length,unknownWorkspaceCount:matched.filter(row=>!row.workspaces.length).length,filters:input};
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
/** Only the local official supervisor's current execution workspace is an owner fact. */
export function officialNativeWorkspace(s:AgentSession,hostId:string):SessionWorkspace|undefined {
 const m=s.meta;if(s.harness!=='zcode'||s.hostId!==hostId||m?.activityEvidence!=='zcode-official-supervisor-running-tasks'||m.nativeExecutor!=='official-server'||!Number.isSafeInteger(m.nativeRuntimePid)||Number(m.nativeRuntimePid)<=0||!Number.isSafeInteger(m.nativeRuntimeGeneration)||typeof s.cwd!=='string'||!s.cwd.startsWith('/')||typeof m.activityObservedAt!=='string'||!Number.isFinite(Date.parse(m.activityObservedAt))||Date.parse(String(m.activityExpiresAt))<=Date.now())return;
 return {hostId,absolutePath:s.cwd,source:'observed',observedAt:m.activityObservedAt,evidence:'local official supervisor running-tasks execution workspace; native pid '+m.nativeRuntimePid+' generation '+m.nativeRuntimeGeneration};
}
export function activeWorkspaceIdentity(s:AgentSession,hostId:string){
 const parent=s.meta?.parentSessionId??s.meta?.parentThreadId??s.meta?.parentID;
 return {runtimeHostId:hostId,harness:s.harness,nativeSessionId:s.id,lastActivity:s.lastActivity,...(typeof parent==='string'?{parentSessionId:parent}:{})};
}
/** Materialize generic snapshots and independently refreshed native activity. Consumers never scan native history. */
export function startActiveInventoryOwner(snapshot:()=>{sessions:AgentSession[];observedAt:string|null;warming:boolean;failures?:Record<string,string>;sources?:Record<string,SessionSnapshotReceipt>},adapters:Map<string,HarnessAdapter>,options:{path?:string;hostId?:string;intervalMs?:number;nativeDeadlineMs?:number;publishIntervalMs?:number;nativeStartDelayMs?:number}={}){
 const hostId=options.hostId??hostname(),path=options.path??activeInventoryPath();let closed=false,pending=false;let lastGeneration='';let workspaceUpdatePending=false;let publishAgain=false;
 const live=new Map<string,{harness:string;sessions:AgentSession[];failed:boolean;observedAt:string|null;exhaustive:boolean;reason?:string;coverage?:Record<string,unknown>;refreshDurationMs?:number;errorName?:string}>();
 const refreshing=new Set<string>();
 for(const [harness,adapter] of adapters)if(typeof (adapter as HarnessAdapter & {listActiveSessions?:unknown}).listActiveSessions==='function')live.set(harness,{harness,sessions:[],failed:true,observedAt:null,exhaustive:false,reason:'native_activity_warming'});
 const nativeWorkspaceReader=createMavisWorkspaceEvidenceReader({control:new MinimaxCodeControl()});
 const updateWorkspaces=createSessionWorkspaceOwnerUpdater({store:sessionWorkspaces,readEvidence:nativeWorkspaceReader});
 // The workspace ledger is durable evidence, not a per-tick log. A declaration
 // is written only when the ledger does not already carry this observation or a
 // newer one, so an unchanged owner does not rewrite the whole ledger once per
 // second and the next read does not have to parse it again.
 const declaredWorkspaces=new Map<string,string>();
 const tick=async()=>{
  if(closed)return;if(pending){publishAgain=true;return;}pending=true;
  try{
   const current=snapshot();
   // Workspace declarations may change independently of the native generation.
   const dedicated=[...live.values()];
   const dedicatedNames=new Set(dedicated.map(d=>d.harness));
   const nativeSessions=[...current.sessions.filter(s=>!dedicatedNames.has(s.harness)&&(s.status==='running'||s.status==='needs_input')),...dedicated.flatMap(d=>d.sessions)];
   if(!workspaceUpdatePending){workspaceUpdatePending=true;void (async()=>{for(const s of nativeSessions){const workspace=officialNativeWorkspace(s,hostId);if(workspace){const key=sessionWorkspaceKey({runtimeHostId:hostId,harness:s.harness,nativeSessionId:s.id});const seen=declaredWorkspaces.get(key);if(seen!==undefined&&Date.parse(seen)>=Date.parse(workspace.observedAt))continue;try{await sessionWorkspaces.declare({runtimeHostId:hostId,harness:s.harness,nativeSessionId:s.id,workspaces:[workspace],mode:'union',observedAt:workspace.observedAt});declaredWorkspaces.set(key,workspace.observedAt);}catch{/* isolate each native identity */}}}await updateWorkspaces(nativeSessions.map(s=>activeWorkspaceIdentity(s,hostId)));})().catch(()=>{}).finally(()=>{workspaceUpdatePending=false;});}
   const identities=nativeSessions.map(s=>({runtimeHostId:hostId,harness:s.harness,nativeSessionId:s.id}));
   const places=await sessionWorkspaces.readMany(identities);
   // A declaration this owner believes it made must still be in the ledger:
   // if the durable record lost the observation, the next tick declares it again.
   for(const [key,observedAt] of declaredWorkspaces){const record=places.get(key);const kept=record?.workspaces.some(w=>Date.parse(w.observedAt)>=Date.parse(observedAt));if(!kept)declaredWorkspaces.delete(key);}
   const sources=[...adapters].map(([harness,adapter])=>{const r=current.sources?.[harness]??adapter.getSessionSnapshotReceipt?.();const live=dedicated.find(d=>d.harness===harness);if(!live&&!current.observedAt)return {harness,exhaustive:false,source:r?.source??'native-adapter',reason:'native_snapshot_warming'};if(!live&&current.failures?.[harness])return {harness,exhaustive:false,source:r?.source??'native-adapter',reason:current.failures[harness]};if(live)return {harness,exhaustive:live.exhaustive&&!live.failed,source:'native-active-observer',observedAt:live.observedAt,...live.coverage,refreshDurationMs:live.refreshDurationMs,errorName:live.errorName,...(live.reason?{reason:live.reason}:{})};return {harness,exhaustive:r?.exhaustive??false,source:r?.source??'native-adapter',...(!r?{reason:'native_enumeration_coverage_unknown'}:r.reason?{reason:r.reason}:{})};});
   const sessions=nativeSessions.filter(s=>s.status==='running'||s.status==='needs_input').map(s=>({id:s.id,harness:s.harness,title:s.title,runtimeHostId:hostId,status:s.status,...(typeof s.meta?.parentSessionId==='string'?{parentSessionId:s.meta.parentSessionId}:typeof s.meta?.parentThreadId==='string'?{parentSessionId:s.meta.parentThreadId}:typeof s.meta?.parentID==='string'?{parentSessionId:s.meta.parentID}:{}),activity:{state:'active',observedAt:String(s.meta?.activityObservedAt??current.observedAt!),evidence:String(s.meta?.activityEvidence??s.meta?.transport??'native-adapter-status'),expiresAt:String(s.meta?.activityExpiresAt??new Date(Date.parse(current.observedAt!)+30000).toISOString())},workspaces:places.get(sessionWorkspaceKey({runtimeHostId:hostId,harness:s.harness,nativeSessionId:s.id}))?.workspaces??[]}));
   const value:ActiveInventory={sessions,partial:sources.some(s=>!s.exhaustive),hosts:[{hostId,ownerPid:process.pid,state:'available',observedAt:[current.observedAt,...dedicated.map(d=>d.observedAt)].filter((v):v is string=>Boolean(v)).sort().at(-1)??null,sources}]};
   const serialized=JSON.stringify(value);if(serialized===lastGeneration)return;
   await mkdir(dirname(path),{recursive:true});const tmp=`${path}.${randomUUID()}.tmp`;await writeFile(tmp,serialized,{mode:0o600});await rename(tmp,path);lastGeneration=serialized;
  }finally{pending=false;if(publishAgain&&!closed){publishAgain=false;void tick().catch(()=>{});}}
 };
 const publish=()=>void tick().catch(()=>{});
 // The native read of a harness is scheduled by the expiry of the evidence it
 // produced, not by a blind timer. A harness whose evidence is still valid for
 // another 15 s does not need a full re-read of the native database now, and a
 // harness that failed comes back quickly. The evidence keeps its own
 // observedAt, so a published row never claims to be fresher than the
 // observation behind it, and a row whose evidence expired is marked unknown by
 // the reader instead of being carried forward as fresh.
 const dueAt=new Map<string,number>();
 const fallbackMs=options.intervalMs??5000;
 const nowMs=()=>Date.now();
 const refreshDedicated=()=>{const now=nowMs();for(const [harness,adapter] of adapters){
  if(!live.has(harness)||refreshing.has(harness)||closed)continue;
  const due=dueAt.get(harness);if(due!==undefined&&now<due)continue;
  refreshing.add(harness);
  const native=adapter as HarnessAdapter & {listActiveSessions():Promise<AgentSession[]>;getActiveSessionRefreshProgress?():{stage:string;stageStartedAt:string}|null;getActiveSessionSnapshotReceipt?():{exhaustive:boolean;observedAt:string;reason?:string;[key:string]:unknown}|null};
  const refreshStarted=performance.now();
  const deadline=setTimeout(()=>{const prior=live.get(harness)!;live.set(harness,{...prior,failed:true,exhaustive:false,reason:'native_activity_deadline',refreshDurationMs:Math.round(performance.now()-refreshStarted),coverage:{...prior.coverage,refreshProgress:native.getActiveSessionRefreshProgress?.()??null}});dueAt.set(harness,nowMs()+fallbackMs);publish();},options.nativeDeadlineMs??20000);deadline.unref?.();
  // A deadline changes evidence, not ownership of a still-running native read.
  void native.listActiveSessions().then(sessions=>{
   const receipt=native.getActiveSessionSnapshotReceipt?.();
   const coverage=Object.fromEntries(['source','activityCoverage','metadataEnumerationExhaustive','candidateCount','failedCandidateCount','totalSessions','pages','expiresAt','stageTimingsMs'].filter(key=>receipt?.[key]!==undefined).map(key=>[key,receipt![key]]));
   if(!closed)live.set(harness,{harness,sessions,failed:false,observedAt:receipt?.observedAt??new Date().toISOString(),exhaustive:receipt?.exhaustive??false,coverage,refreshDurationMs:Math.round(performance.now()-refreshStarted),...(receipt?.reason?{reason:receipt.reason}:{})});
   // The next read is due before the evidence this one produced expires, so the
   // published row never goes stale while the owner is still running.
   const expiries:number[]=[];const receiptExpiry=Date.parse(String(receipt?.expiresAt??''));if(Number.isFinite(receiptExpiry))expiries.push(receiptExpiry);
   for(const session of sessions){const expiry=Date.parse(String(session.meta?.activityExpiresAt??''));if(Number.isFinite(expiry))expiries.push(expiry);}
   const earliest=expiries.length?Math.min(...expiries):undefined;
   const ttl=earliest!==undefined?Math.max(0,earliest-nowMs()):undefined;
   dueAt.set(harness,earliest!==undefined?Math.max(nowMs()+1000,earliest-Math.max(4000,Math.floor((ttl??0)/3))):nowMs()+fallbackMs);
  }).catch(error=>{const prior=live.get(harness)!;const code=error instanceof Error&&/^[a-z_]+$/.test(error.message)?error.message:'native_activity_unavailable';live.set(harness,{...prior,failed:true,exhaustive:false,reason:code,errorName:error instanceof Error?error.name:'UnknownError',refreshDurationMs:Math.round(performance.now()-refreshStarted),coverage:{...prior.coverage,refreshProgress:native.getActiveSessionRefreshProgress?.()??null}});dueAt.set(harness,nowMs()+fallbackMs);}).finally(()=>{clearTimeout(deadline);refreshing.delete(harness);publish();});
 }};
 const timer=setInterval(publish,options.publishIntervalMs??1000);timer.unref();const observer=setInterval(refreshDedicated,1000);observer.unref();publish();
 // The first native read starts on the next turn of the event loop, after the
 // owner has bound its HTTP listener: the port is up before a slow native
 // database can occupy the loop, and the first read is never later than the
 // moment the owner was ready to serve.
 const firstRead=setTimeout(()=>{refreshDedicated();},options.nativeStartDelayMs??0);firstRead.unref?.();
 return ()=>{closed=true;clearInterval(timer);clearInterval(observer);clearTimeout(firstRead);};
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
