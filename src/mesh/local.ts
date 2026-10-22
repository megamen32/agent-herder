import {homedir,hostname} from "node:os";
import {join} from "node:path";
import type {HarnessAdapter} from "../types/index.js";
import {handleSendMessage} from "../mcp-tools/handlers.js";
import {compactSession,parseNativeReceipt,addressKey,type MeshAddress,type MeshSession,type NativeReceipt,type NativeStopReceipt} from "./protocol.js";
import type {MeshDelivery} from "./gptadmin.js";
import {MeshDeliveryLedger} from "./delivery-ledger.js";
import {inventoryHarnesses} from "./inventory.js";
import {coordinationNotes,type CoordinationNoteStore} from "../coordination-notes.js";
import {checkDeliveryModel,deliveryRefusalText,resolveSessionWorkDirectory,type ProjectModelPolicyStateProvider} from "../project-model-delivery-gate.js";
import {MINIMAX_CODE_HARNESS_CWD} from "../adapters/minimax-code-store.js";
import {MINIMAX_CODE_HARNESS,observeMinimaxCode,runMinimaxCodeDelivery} from "./native-minimax-code.js";
export interface HarnessMeshCapability {harness:string;discovery:"available"|"unavailable";delivery:"available"|"unsupported";reason?:string}
/** Injects the active coordination notes of the target into a delivered message. */
export type MeshNotesInjector=(session:{id:string;harness:string;cwd:string;hostId?:string},message:string)=>Promise<string>;
/** Independent native observation of one exact session of this host. */
export type MeshNativeObserver=(harness:string,nativeSessionId:string)=>Promise<{nativeSessionId:string;status:string;cwd?:string|null}|null>;
type Dependencies={hostId?:string;adapters:Map<string,HarnessAdapter>;send?:(args:Record<string,unknown>)=>Promise<unknown>;ledgerPath?:string;readDeadlineMs?:number;projectStore?:Pick<CoordinationNoteStore,"activeWorkspaceForSession"> & Partial<Pick<CoordinationNoteStore,"activeWorkspaceObservation">>;notes?:MeshNotesInjector;nativeObserve?:MeshNativeObserver;deliveryPolicy?:ProjectModelPolicyStateProvider};
export class LocalHarnessMesh {
 readonly hostId:string;
 private readonly ids=new Map<string,string>();
 private readonly ledger:MeshDeliveryLedger;
 constructor(private readonly deps:Dependencies){this.hostId=deps.hostId||hostname();this.ledger=new MeshDeliveryLedger(deps.ledgerPath||join(homedir(),".local/state/agent-herder/harness-mesh-receipts.json"));}
 async snapshot(limit=12):Promise<{hostId:string;sessions:MeshSession[];harnesses:HarnessMeshCapability[];complete:boolean;limited:boolean}>{
  if(!Number.isInteger(limit)||limit<1||limit>12)throw new Error("Mesh snapshot limit must be 1..12");
  const sessions:MeshSession[]=[];const harnesses:HarnessMeshCapability[]=[];let complete=true;let limited=false;
  const deadline=Date.now()+(this.deps.readDeadlineMs??2000);
  const freshIds=new Map<string,string>();
  const inspect=async(harness:string)=>{
   const adapter=this.deps.adapters.get(harness);
   if(!adapter || (adapter.lazyStart&&adapter.isReady&&!adapter.isReady())){
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
    const deliverable=harness==="codex"||harness===MINIMAX_CODE_HARNESS;
    harnesses.push({harness,discovery:"available",delivery:deliverable?"available":"unsupported",...(deliverable?{}:{reason:"native_admission_receipt_unverified"})});
   }catch{complete=false;harnesses.push({harness,discovery:"unavailable",delivery:"unsupported",reason:"native_discovery_failed"});}
  };
  let next=0;await Promise.all(Array.from({length:3},async()=>{for(;;){const harness=inventoryHarnesses[next++];if(!harness)return;await inspect(harness);}}));
  this.ids.clear();for(const [key,value]of freshIds)this.ids.set(key,value);
  const sorted=sessions.sort((a,b)=>b.lastActivity.localeCompare(a.lastActivity)).slice(0,limit);
  if(sessions.length>limit){complete=false;limited=true;}
  return {hostId:this.hostId,sessions:sorted,harnesses,complete,limited};
 }
 async deliver(request:MeshDelivery):Promise<NativeReceipt&{reason?:string}>{
  addressKey(request.target);addressKey(request.sender);
  const reject=(reason:string)=>({state:"not_attempted" as const,inputId:request.inputId,retryable:true,reason});
  if(request.target.hostId!==this.hostId)return reject("native_host_identity_mismatch");
  if(!request.inputId||request.inputId.length>256||!request.message.trim()||request.message.length>4000)throw new Error("A stable inputId and bounded delta are required");
  return this.ledger.once(request,async()=>{
   const adapter=this.deps.adapters.get(request.target.harness);
   if(!adapter)return reject("adapter_not_registered");
   // A native session that was born outside herder's tools never passed
   // through the tool gate, so the delivery guards the model itself.
   const refusal=await this.checkDeliveryModel(request,adapter);
   if(refusal)return refusal;
   // A native MiniMax Code session owns its own turn inside the desktop
   // runtime, so the delivery is queued there and proven by its receipt.
   if(request.target.harness===MINIMAX_CODE_HARNESS)return this.deliverMinimaxCode(request,adapter);
   if(request.target.harness!=="codex")return reject("native_admission_receipt_unverified");
   const sessionId=this.ids.get(addressKey(request.target))||request.target.nativeSessionId;
   const session=await adapter.getSession(sessionId);
   if(!session)return reject("native_session_not_found");
   if(compactSession(this.hostId,session).address.nativeSessionId!==request.target.nativeSessionId)return reject("native_session_identity_mismatch");
   const args={sessionId,harness:request.target.harness,inputId:request.inputId,mode:"queue",meshSender:request.sender,message:request.message};
   const raw=this.deps.send?await this.deps.send(args):await handleSendMessage(this.deps.adapters,args);
   return parseNativeReceipt(typeof raw==="string"?{content:[{type:"text",text:raw}]}:raw,request.inputId);
  });
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
   checkDeliveryModel(state,{directory:resolveSessionWorkDirectory(session,declared?.cwd),harness:request.target.harness});
  }catch(error){
   return {state:"not_attempted",inputId:request.inputId,retryable:false,reason:deliveryRefusalText(error)};
  }
  return null;
 }
 /** One native MiniMax Code delivery, proven by the admission of the runtime. */
 private async deliverMinimaxCode(request:MeshDelivery,adapter:HarnessAdapter):Promise<NativeReceipt&{reason?:string}>{
  const notes=this.deps.notes??((session,message)=>coordinationNotes.inject(session,message));
  return runMinimaxCodeDelivery(request,{
   port:{enqueue:async(id,message,inputId)=>adapter.sendMessage(id,{message,queue:true,inputId,origin:"automation"})},
   observe:id=>this.observeNative(MINIMAX_CODE_HARNESS,id),
   notes,
  });
 }
 /** Independent native observation: the writer alone never proves identity. */
 private async observeNative(harness:string,nativeSessionId:string):Promise<{nativeSessionId:string;status:string;cwd?:string|null}|null>{
  if(this.deps.nativeObserve)return this.deps.nativeObserve(harness,nativeSessionId);
  if(harness!==MINIMAX_CODE_HARNESS)return null;
  const observed=await observeMinimaxCode(1,undefined,this.hostId,nativeSessionId).catch(()=>null);
  const session=observed?.sessions[0];
  return session?{nativeSessionId:session.address.nativeSessionId,status:session.status,cwd:session.project.currentCwd??session.project.launchCwd??MINIMAX_CODE_HARNESS_CWD}:null;
 }
 /** Stop one exact native session of this host. An unproven stop is never replayed. */
 async stop(request:{target:MeshAddress;inputId:string}):Promise<NativeStopReceipt>{
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
   let result;
   try{result=await adapter.stopSession(sessionId);}catch{return {state:"unknown" as const,inputId:request.inputId,retryable:false,reason:"native_stop_unknown"};}
   if(!result.ok)return {state:"not_attempted" as const,inputId:request.inputId,retryable:true,reason:result.error||"native_stop_failed"};
   return {state:"admitted" as const,inputId:request.inputId,retryable:false,reason:"native_session_stopped"};
  });
  return {...receipt,hostId:this.hostId,harness:request.target.harness,nativeSessionId:request.target.nativeSessionId};
 }
}
