import {MinimaxCodeControl} from '../adapters/minimax-code-control.js';
import {readMinimaxNativeSession} from '../adapters/minimax-code-native-session.js';
import {meshDiscoveryTimeoutMs} from "./discovery-timeout.js";
import {homedir,hostname} from "node:os";
import {join} from "node:path";
import type {HarnessAdapter} from "../types/index.js";
import type {SessionSupervisor} from "../session-supervisor.js";
import type {UserMessageDelivery} from "../user-message-delivery.js";
import {handleSendMessage} from "../mcp-tools/handlers.js";
import {compactSession,parseNativeReceipt,addressKey,type MeshAddress,type MeshSession,type NativeReceipt,type NativeStopReceipt,type NativeRenameReceipt,type MeshSessionLabel} from "./protocol.js";
import type {MeshDelivery} from "./gptadmin.js";
import {MeshDeliveryLedger} from "./delivery-ledger.js";
import {inventoryHarnesses} from "./inventory.js";
import {coordinationNotes,type CoordinationNoteStore} from "../coordination-notes.js";
import {checkDeliveryModel,deliveryRefusalText,resolveSessionWorkDirectory,type ProjectModelPolicyStateProvider} from "../project-model-delivery-gate.js";
import {automationDisarmDecisionWithWork,sessionWorkKey,AutomationDisarmStore} from "../automation-disarm/index.js";
import {automaticDeliveryHeld,holdManualStop} from "../human-stop-actions.js";
import {getHumanStopStore} from "../human-stop-store.js";
import {MINIMAX_CODE_HARNESS_CWD} from "../adapters/minimax-code-store.js";
import {MINIMAX_CODE_HARNESS,observeMinimaxCode} from "./native-minimax-code.js";
import {isTrustedMeshIngress,type TrustedMeshIngress} from "./authenticated-ingress.js";
import {composeSessionTitle,mergeSessionLabel,writeSessionLabel} from "../session-labels.js";
/**
 * Receipt of one native rename.
 *
 * The metadata of the session belongs to Herder and is stored first and on its
 * own; the native name of the session is an optional operation of the harness.
 * The receipt tells the two outcomes apart with renamed: the native name
 * changed, or it did not change and the receipt says why. A rename that did
 * not happen never takes the stored metadata away.
 */
export type MeshRenameReceipt=NativeRenameReceipt&{
 /** The native name changed. The stored metadata does not depend on it. */
 renamed?:boolean;
 /** The native title after the rename, as the native readback returned it. */
 nativeTitle?:string;
 /** Why the native name of the session did not change. */
 renameError?:string;
 /** What the owner reads: the same words the panel shows for a stored label. */
 message?:string;
};
export interface HarnessMeshCapability {harness:string;discovery:"available"|"unavailable";delivery:"available"|"unsupported";reason?:string}
/** Injects the active coordination notes of the target into a delivered message. */
export type MeshNotesInjector=(session:{id:string;harness:string;cwd:string;hostId?:string},message:string)=>Promise<string>;
/** Independent native observation of one exact session of this host. */
export type MeshNativeObserver=(harness:string,nativeSessionId:string)=>Promise<{nativeSessionId:string;status:string;cwd?:string|null}|null>;
const officialZcode=(harness:string,adapter:HarnessAdapter|undefined)=>harness==='zcode'&&(adapter as HarnessAdapter & {getOfficialMeshAdmission?:()=>string|undefined}|undefined)?.getOfficialMeshAdmission?.()==='official-ws-v4';
type Dependencies={hostId?:string;adapters:Map<string,HarnessAdapter>;ledgerPath?:string;readDeadlineMs?:number;projectStore?:Pick<CoordinationNoteStore,"activeWorkspaceForSession"> & Partial<Pick<CoordinationNoteStore,"activeWorkspaceObservation">>;notes?:MeshNotesInjector;nativeObserve?:MeshNativeObserver;deliveryPolicy?:ProjectModelPolicyStateProvider;userMessageDelivery?:UserMessageDelivery;supervisor?:Pick<SessionSupervisor,"sendMessage">};
export class LocalHarnessMesh {
 readonly hostId:string;
 private readonly ids=new Map<string,string>();
 private readonly ledger:MeshDeliveryLedger;
 constructor(private readonly deps:Dependencies){this.hostId=deps.hostId||hostname();this.ledger=new MeshDeliveryLedger(deps.ledgerPath||join(homedir(),".local/state/agent-herder/harness-mesh-receipts.json"));}
 async snapshot(limit=12):Promise<{hostId:string;sessions:MeshSession[];harnesses:HarnessMeshCapability[];complete:boolean;limited:boolean}>{
  if(!Number.isInteger(limit)||limit<1||limit>12)throw new Error("Mesh snapshot limit must be 1..12");
  const sessions:MeshSession[]=[];const harnesses:HarnessMeshCapability[]=[];let complete=true;let limited=false;
  const deadline=Date.now()+(this.deps.readDeadlineMs??meshDiscoveryTimeoutMs());
  const freshIds=new Map<string,string>();
  const inspect=async(harness:string)=>{
   const adapter=this.deps.adapters.get(harness);
   if(!adapter || (adapter.lazyStart&&adapter.isReady&&!adapter.isReady()&&!officialZcode(harness,adapter))){
    complete=false;
    harnesses.push({harness,discovery:"unavailable",delivery:"unsupported",reason:!adapter?"adapter_not_registered":"native_transport_disconnected"});return;
   }
   try{
    const remaining=deadline-Date.now();if(remaining<=0)throw new Error("mesh_read_deadline");
    let timer:ReturnType<typeof setTimeout>|undefined;
    // Native persistent pages may hydrate metadata per row. Keep compact Codex
    // discovery useful within the existing deadline; exact-ID reads stay separate.
    const adapterLimit=harness==="codex"?Math.min(limit,3):limit;
    const rows=await Promise.race([adapter.listSessions({limit:adapterLimit}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("mesh_read_deadline")),remaining);})]).finally(()=>{if(timer)clearTimeout(timer);});
    const receipt=adapter.getSessionSnapshotReceipt?.();
    if(receipt?.exhaustive!==true||rows.length>adapterLimit||receipt?.reason==="bounded_native_page")complete=false;
    if(rows.length>adapterLimit||receipt?.reason==="bounded_native_page"||adapterLimit<limit&&receipt?.exhaustive!==true)limited=true;
    for(const row of rows.slice(0,adapterLimit)){
     const store=this.deps.projectStore??coordinationNotes;
     const workspace=await store.activeWorkspaceObservation?.(row.id);
     const activeCwd=workspace?.cwd??store.activeWorkspaceForSession(row.id);
     const projected=activeCwd?{...row,cwd:activeCwd,meta:{...row.meta,launchCwd:row.meta?.launchCwd??row.cwd,activeCwd,workspaceHostId:workspace?.hostId??this.hostId,workspaceExpiresAt:workspace?.expiresAt,projectSource:workspace?.source??"coordination_activity"}}:row;
     const session=compactSession(this.hostId,projected);sessions.push(session);freshIds.set(addressKey(session.address),row.id);
    }
    // Existing API implementations do not all provide native admission proof.
    const deliverable=harness==="codex"||harness===MINIMAX_CODE_HARNESS||officialZcode(harness,adapter);
    harnesses.push({harness,discovery:"available",delivery:deliverable?"available":"unsupported",...(deliverable?{}:{reason:"native_admission_receipt_unverified"})});
   }catch(error){complete=false;harnesses.push({harness,discovery:"unavailable",delivery:"unsupported",reason:error instanceof Error&&error.message==="mesh_read_deadline"?"native_discovery_deadline":"native_discovery_failed"});}
  };
  // Each registered provider gets the same bounded discovery window. Queuing
  // behind a hung provider consumed that window before later harnesses started.
  await Promise.all(inventoryHarnesses.map(inspect));
  this.ids.clear();for(const [key,value]of freshIds)this.ids.set(key,value);
  const sorted=sessions.sort((a,b)=>b.lastActivity.localeCompare(a.lastActivity)).slice(0,limit);
  if(sessions.length>limit){complete=false;limited=true;}
  return {hostId:this.hostId,sessions:sorted,harnesses,complete,limited};
 }
 async deliver(request:MeshDelivery,ingress?:TrustedMeshIngress):Promise<NativeReceipt&{reason?:string}>{
  addressKey(request.target);addressKey(request.sender);
  const reject=(reason:string)=>({state:"not_attempted" as const,inputId:request.inputId,retryable:true,reason});
  if(request.target.hostId!==this.hostId)return reject("native_host_identity_mismatch");
  if(!request.inputId||request.inputId.length>256||!request.message.trim()||request.message.length>4000)throw new Error("A stable inputId and bounded delta are required");
  if(!isTrustedMeshIngress(ingress))return {...reject("authenticated_mesh_ingress_required"),retryable:false};
  if(request.target.harness===MINIMAX_CODE_HARNESS){
   return this.deliverMinimaxThroughCommonCore(request,ingress);
  }
  return this.ledger.once(request,async()=>{
   const adapter=this.deps.adapters.get(request.target.harness);
   if(!adapter)return reject("adapter_not_registered");
   // A native session that was born outside herder's tools never passed
   // through the tool gate, so the delivery guards the model itself.
   const refusal=await this.checkDeliveryModel(request,adapter);
   if(refusal)return refusal;
   if(officialZcode(request.target.harness,adapter))return this.deliverZcodeOfficial(request,adapter);
   if(request.target.harness!=="codex")return reject("native_admission_receipt_unverified");
   const sessionId=this.ids.get(addressKey(request.target))||request.target.nativeSessionId;
   const session=await adapter.getSession(sessionId);
   if(!session)return reject("native_session_not_found");
   if(compactSession(this.hostId,session).address.nativeSessionId!==request.target.nativeSessionId)return reject("native_session_identity_mismatch");
   const args={sessionId,harness:request.target.harness,inputId:request.inputId,mode:"queue",meshSender:request.sender,message:request.message};
   const raw=await handleSendMessage(this.deps.adapters,args,this.deps.userMessageDelivery,ingress);
   const current=this.deps.userMessageDelivery?.get(request.target.harness,sessionId,request.inputId);
   if(current?.job){
    if(["queued","running","waiting","cancelling"].includes(current.job.state))return {state:"queued",inputId:request.inputId,jobId:current.job.id,retryable:false,reason:"durable_job_pending"};
    if(current.job.state==="completed"&&current.job.result)return parseNativeReceipt(current.job.result,request.inputId);
   }
   return parseNativeReceipt(typeof raw==="string"?{content:[{type:"text",text:raw}]}:raw,request.inputId);
  });
 }
 private async deliverMinimaxThroughCommonCore(request:MeshDelivery,ingress:TrustedMeshIngress):Promise<NativeReceipt&{reason?:string}>{
  const reject=(reason:string,retryable=true):NativeReceipt=>({state:"not_attempted",inputId:request.inputId,retryable,reason});
  const delivery=this.deps.userMessageDelivery;
  if(!delivery)return reject("shared_durable_delivery_core_unavailable");
  const adapter=this.deps.adapters.get(MINIMAX_CODE_HARNESS);
  if(!adapter?.getSession)return reject("native_session_reader_unavailable");
  const sessionId=this.ids.get(addressKey(request.target))||request.target.nativeSessionId;
  const session=await adapter.getSession(sessionId).catch(()=>null);
  if(!session||session.id!==sessionId||session.harness!==MINIMAX_CODE_HARNESS||compactSession(this.hostId,session).address.nativeSessionId!==request.target.nativeSessionId)return reject("native_session_identity_mismatch");
  const observation=await this.observeNative(MINIMAX_CODE_HARNESS,request.target.nativeSessionId).catch(()=>null);
  if(!observation||observation.nativeSessionId!==request.target.nativeSessionId)return reject("independent_native_identity_unknown");
  const refusal=await this.checkDeliveryModel(request,adapter);
  if(refusal)return refusal;
  if(await automaticDeliveryHeld(session,false,adapter))return reject("human_stopped_native_session",false);
  const provenance=`Источник: ${request.sender.hostId} / ${request.sender.harness} / ${request.sender.nativeSessionId}.\n${request.message}`;
  const message=await (this.deps.notes?this.deps.notes(session,provenance):coordinationNotes.inject(session,provenance));
  const route={adapter,supervisor:this.deps.supervisor??{sendMessage:async(_harness:string,id:string,options:any)=>adapter.sendMessage(id,options)}};
  let receipt;
  const mode=observation.status==="running"&&adapter.controlCapabilities?.steer===true?"steer":"queue";
  try{receipt=await delivery.submitMinimaxAgent({harness:MINIMAX_CODE_HARNESS,sessionId,inputId:request.inputId,message,mode},request.sender,ingress,route);}
  catch(error){return reject(error instanceof Error?error.message:"durable_admission_refused",false);}
  if(receipt.delivery==="deferred"&&receipt.job)return {state:"queued",inputId:request.inputId,jobId:receipt.job.id,retryable:false,reason:"durable_job_pending"};
  if(receipt.ok&&receipt.admitted===true&&receipt.turnId)return {state:"admitted",inputId:request.inputId,turnId:receipt.turnId,retryable:false};
  if(receipt.notSubmitted===true&&!receipt.admissionUnknown)return reject(receipt.error||"native_admission_not_submitted",receipt.nonRetryable!==true);
  return {state:"unknown",inputId:request.inputId,retryable:false,reason:receipt.error||"native_admission_unknown"};
 }
 /** Queue through the already-supported official V4 adapter. The durable mesh
  * ledger surrounds this call; admission/unknown input is never reissued. */
 private async deliverZcodeOfficial(request:MeshDelivery,adapter:HarnessAdapter):Promise<NativeReceipt>{
  const reject=(reason:string):NativeReceipt=>({state:'not_attempted',inputId:request.inputId,retryable:true,reason});
  const session=await adapter.getSession(request.target.nativeSessionId).catch(()=>null);
  if(!session||compactSession(this.hostId,session).address.nativeSessionId!==request.target.nativeSessionId)return reject('native_session_identity_unknown');
  if(session.meta?.nativeExecutor!=='official-server'||session.meta.nativeActivityFresh!==true||session.status!=='running')return reject('official_native_activity_unknown');
  const disarm=await automationDisarmDecisionWithWork(AutomationDisarmStore.forRuntime(),async()=>[sessionWorkKey(session.harness,session.title,session.cwd)],'automation');
  if(!disarm.allowed)return reject('automation_disarmed');
  if(await automaticDeliveryHeld(session,false,adapter))return reject('human_stopped_native_session');
  const provenance=`Источник: ${request.sender.hostId} / ${request.sender.harness} / ${request.sender.nativeSessionId}.\n${request.message}`;
  const message=await (this.deps.notes?this.deps.notes(session,provenance):coordinationNotes.inject(session,provenance));
  if(!officialZcode('zcode',adapter)||await automaticDeliveryHeld(session,false,adapter))return reject('official_native_admission_held');
  const receipt=await adapter.sendMessage(session.id,{message,inputId:request.inputId,queue:true,origin:'automation'});
  if(receipt.admitted===true&&receipt.inputId===request.inputId&&receipt.admissionKind!=='current_turn_context')return {state:'admitted',inputId:request.inputId,retryable:false,...(receipt.turnId?{turnId:receipt.turnId}:{}),reason:'official_zcode_v4_input_accepted'};
  if(receipt.notSubmitted===true&&receipt.admissionUnknown!==true)return {state:'not_attempted',inputId:request.inputId,retryable:receipt.nonRetryable!==true,reason:'official_zcode_v4_not_submitted'};
  return {state:'unknown',inputId:request.inputId,retryable:false,reason:'official_zcode_v4_admission_unknown'};
 }
 /**
  * The per-project model gate of one delivery.
  *
  * The project is the work place of the session: its declared work place
  * first, then its own working directory. A refusal is not retryable, so the
  * ledger keeps it and the same intent is never delivered again.
  */
 private async checkDeliveryModel(request:MeshDelivery,adapter:HarnessAdapter):Promise<(NativeReceipt&{reason?:string})|null>{
  const provider=this.deps.deliveryPolicy;
  if(!provider)return null;
  const state=await provider().catch(()=>({kind:"invalid" as const,error:"the project model policy could not be read"}));
  const sessionId=this.ids.get(addressKey(request.target))||request.target.nativeSessionId;
  const session=await adapter.getSession(sessionId).catch(()=>null);
  const declared=await this.deps.projectStore?.activeWorkspaceObservation?.(sessionId)?.catch(()=>undefined);
  try{
   const nativeWorkspace=request.target.harness===MINIMAX_CODE_HARNESS?await adapter.getNativeWorkspaceDirectory?.(sessionId).catch(()=>null):null;
   const exactNativeCwd=nativeWorkspace&&nativeWorkspace.hostId===request.target.hostId&&nativeWorkspace.harness===request.target.harness&&nativeWorkspace.sessionId===request.target.nativeSessionId?nativeWorkspace.cwd:null;
   const directory=request.target.harness===MINIMAX_CODE_HARNESS
    ? exactNativeCwd
    : resolveSessionWorkDirectory(session,declared?.cwd);
   checkDeliveryModel(state,{directory,harness:request.target.harness});
  }catch(error){
   return {state:"not_attempted",inputId:request.inputId,retryable:false,reason:deliveryRefusalText(error)};
  }
  return null;
 }
 /** Independent native observation: the writer alone never proves identity. */
 private async observeNative(harness:string,nativeSessionId:string):Promise<{nativeSessionId:string;status:string;cwd?:string|null}|null>{
  if(this.deps.nativeObserve)return this.deps.nativeObserve(harness,nativeSessionId);
  if(harness!==MINIMAX_CODE_HARNESS)return null;
  const control=new MinimaxCodeControl();
  if(await control.available()){const session=await readMinimaxNativeSession(control,nativeSessionId);return session?{nativeSessionId:session.id,status:session.status,cwd:session.cwd}:null;}
  const observed=await observeMinimaxCode(1,undefined,this.hostId,nativeSessionId).catch(()=>null);
  const session=observed?.sessions[0];
  return session?{nativeSessionId:session.address.nativeSessionId,status:session.status,cwd:session.project.currentCwd??session.project.launchCwd??MINIMAX_CODE_HARNESS_CWD}:null;
 }
 /** Stop one exact native session of this host. An unproven stop is never replayed. */ async stop(request:{target:MeshAddress;inputId:string}):Promise<NativeStopReceipt>{
  addressKey(request.target);
  const rejected=(reason:string,retryable=true,state:"not_attempted"|"unknown"="not_attempted"):NativeStopReceipt=>({state,inputId:request.inputId,hostId:request.target.hostId,harness:request.target.harness,nativeSessionId:request.target.nativeSessionId,retryable,reason});
  if(request.target.hostId!==this.hostId)return rejected("native_host_identity_mismatch");
  const adapter=this.deps.adapters.get(request.target.harness);
  if(!adapter)return rejected("adapter_not_registered");
  const sessionId=this.ids.get(addressKey(request.target))||request.target.nativeSessionId;
  const session=await adapter.getSession(sessionId).catch(()=>null);
  if(!session)return rejected("native_session_not_found");
  if(compactSession(this.hostId,session).address.nativeSessionId!==request.target.nativeSessionId)return rejected("native_session_identity_mismatch");
  // One stable intent stops the session once; an unproven stop keeps its receipt.
  const receipt=await this.ledger.once({target:request.target,sender:request.target,inputId:request.inputId,message:"stop"},async()=>{
   // The fence of the stop: the same manual hold the local path writes, on
   // this host, so the delivery path of this host sees the stopped session.
   await holdManualStop(session);
   const held=await getHumanStopStore().isHeld(session.harness,session.id).catch(()=>false);
   let result;
   try{result=await adapter.stopSession(sessionId);}catch{return {state:"unknown" as const,inputId:request.inputId,retryable:false,reason:"native_stop_unknown",held};}
   if(!result.ok)return {state:"not_attempted" as const,inputId:request.inputId,retryable:true,reason:result.error||"native_stop_failed",held};
   return {state:"admitted" as const,inputId:request.inputId,retryable:false,reason:held?"native_session_stopped":"native_session_stopped_without_hold",held};
  });
  return {...receipt,hostId:this.hostId,harness:request.target.harness,nativeSessionId:request.target.nativeSessionId};
 }
 /**
 * Rename one exact native session of this host.
 *
 * Only the title of the same session changes: no session is created, no
 * model turn starts and no active turn is interrupted. The receipt carries
 * the native titles of the readback, so a caller sees what the harness
 * really shows.
 */
 async rename(request:{target:MeshAddress;title?:string;project?:string;goal?:string;stage?:string}):Promise<MeshRenameReceipt>{
  addressKey(request.target);
  const rejected=(reason:string,state:"not_attempted"|"unsupported"|"not_found"="not_attempted"):MeshRenameReceipt=>({state,hostId:this.hostId,harness:request.target.harness,nativeSessionId:request.target.nativeSessionId,reason});
  if(request.target.hostId!==this.hostId)return rejected("native_host_identity_mismatch");
  const adapter=this.deps.adapters.get(request.target.harness);
  if(!adapter)return rejected("adapter_not_registered");
  const sessionId=this.ids.get(addressKey(request.target))||request.target.nativeSessionId;
  const session=await adapter.getSession(sessionId).catch(()=>null);
  if(!session)return rejected("native_session_not_found","not_found");
  if(compactSession(this.hostId,session).address.nativeSessionId!==request.target.nativeSessionId)return rejected("native_session_identity_mismatch");
  const patch={project:request.project,goal:request.goal,stage:request.stage};
  const hasFields=request.project!==undefined||request.goal!==undefined||request.stage!==undefined;
  const merged=hasFields?await mergeSessionLabel(session.harness,session.id,patch):await mergeSessionLabel(session.harness,session.id,{});
  const title=request.title?.trim()||composeSessionTitle(merged);
  if(!title)return rejected("native_title_required");
  // The metadata of the session belongs to Herder and is stored first and on
  // its own: it does not depend on what the harness can or cannot do with a name.
  const label:MeshSessionLabel=hasFields?await writeSessionLabel(session.harness,session.id,patch):merged;
  // The native name is an optional operation of the harness. The receipt tells
  // the two outcomes apart with renamed: the name changed, or it did not change
  // and the receipt says why. A rename that did not happen never takes the
  // stored metadata away.
  if(typeof adapter.renameSession!=="function"){
   const renameError=`У среды '${session.harness}' нет нативного канала переименования: имя сессии осталось прежним.`;
   return {state:"unsupported",renamed:false,hostId:this.hostId,harness:session.harness,nativeSessionId:session.id,previousTitle:null,title,label,renameError,message:`Метка сохранена. Имя сессии не изменилось — ${renameError}`};
  }
  const result=await adapter.renameSession(session.id,{title});
  if(!result.ok){
   const renameError=result.error||"Нативное переименование не удалось.";
   return {state:"not_attempted",renamed:false,hostId:this.hostId,harness:session.harness,nativeSessionId:session.id,previousTitle:result.previousTitle??null,title,label,renameError,message:`Метка сохранена. Имя сессии не изменилось — ${renameError}`};
  }
  return {state:"renamed",renamed:true,hostId:this.hostId,harness:session.harness,nativeSessionId:session.id,previousTitle:result.previousTitle??null,title:result.title??title,nativeTitle:result.title??title,label,message:`Сохранено. Название сессии: «${result.title??title}».`};
 }
}
