import {compactSession,parseNativeReceipt,unwrapResult,addressKey,type MeshSession} from "./protocol.js";
import type {MeshDelivery} from "./gptadmin.js";
import {MeshDeliveryLedger} from "./delivery-ledger.js";
import {inventoryHarnesses} from "./inventory.js";
type Call=(name:string,args:Record<string,unknown>)=>Promise<unknown>;
/** Thin relay to the already running singleton, not an adapter/controller/writer. */
export class SingletonHarnessMesh {
 private readonly ledger:MeshDeliveryLedger;
 constructor(private readonly deps:{hostId:string;call:Call;ledgerPath:string;canDeliver?:boolean;verifyOwner:()=>Promise<void>;allowedSender?:MeshDelivery["sender"]}){if(typeof deps.verifyOwner!=="function")throw new Error("singleton_owner_proof_missing");this.ledger=new MeshDeliveryLedger(deps.ledgerPath);}
 async snapshot(limit=12):Promise<{hostId:string;sessions:MeshSession[];harnesses:unknown[];complete:boolean}>{
  if(!Number.isInteger(limit)||limit<1||limit>12)throw new Error("Mesh discovery limit must be 1..12");
  await this.deps.verifyOwner();
  const data=unwrapResult(await this.deps.call("list_agents",{harness:"all",limit,includeLastMessage:false}));
  if(!Array.isArray(data.sessions))throw new Error("singleton_snapshot_unavailable");
  const sessions=data.sessions.slice(0,limit).map(row=>compactSession(this.deps.hostId,row));
  const unavailable=Array.isArray(data.unavailable)?data.unavailable as Array<{harness:string}>:[];
  const harnesses=inventoryHarnesses.map(harness=>{
   const observed=sessions.some(s=>s.address.harness===harness),failed=unavailable.some(s=>s.harness===harness);
   return {harness,discovery:observed&&!failed?"available":"unavailable",delivery:harness==="codex"&&this.deps.canDeliver===true&&Boolean(this.deps.allowedSender)&&observed?"available":"unsupported",...(observed&&!failed?{}:{reason:failed?"singleton_native_discovery_failed":"no_native_session_in_bounded_snapshot",repairPlan:harness==="minimax-code"?"Verify the official mcode ACP launcher and same Desktop ID; enum or empty connector tools are not native availability.":"Use an exact native ID or focused harness metadata read via the existing singleton; enable only after native admission proof."})};
  });
  return {hostId:this.deps.hostId,sessions,harnesses,complete:data.complete===true&&data.limited!==true&&harnesses.every(h=>h.discovery==="available")};
 }
 async deliver(request:MeshDelivery){
  addressKey(request.target);addressKey(request.sender);
  if(!request.inputId||request.inputId.length>256||!request.message.trim()||request.message.length>4000)throw new Error("Stable inputId and bounded delta required");
  if(request.target.hostId!==this.deps.hostId)return {state:"not_attempted" as const,inputId:request.inputId,retryable:true,reason:"native_host_identity_mismatch"};
  const reject=(reason:string)=>({state:"not_attempted" as const,inputId:request.inputId,retryable:false,reason});
  if(!["opencode","claude","codex","qoder","hermes","zcode","fast-agent","chatgpt"].includes(request.sender.harness))return reject("unsupported_native_sender_harness");
  if(this.deps.allowedSender&&addressKey(request.sender)!==addressKey(this.deps.allowedSender))return reject("interim_known_sender_only");
  return this.ledger.once(request,async()=>{
   try{await this.deps.verifyOwner();}catch{return {state:"not_attempted" as const,inputId:request.inputId,retryable:true,reason:"singleton_native_owner_identity_unverified"};}
   if(request.target.harness!=="codex"||this.deps.canDeliver!==true||!this.deps.allowedSender)return {state:"not_attempted" as const,inputId:request.inputId,retryable:true,reason:"singleton_native_admission_unverified"};
   // The live old owner has no separate mesh budget/native-attribution seam.
   // Do not forge a native sender ID or trigger a guaranteed failed lookup.
   // Interim release is restricted to one approved actor, and the old unknown
   // sender bucket imposes a stricter six-per-target limit until owner reload.
   const raw=await this.deps.call("send_message",{sessionId:request.target.nativeSessionId,harness:"codex",inputId:request.inputId,mode:"steer",message:`Объявленный источник: ${request.sender.hostId} / ${request.sender.harness} / ${request.sender.nativeSessionId}. Native attribution на старом owner недоступна.\n${request.message}`});
   return parseNativeReceipt(raw,request.inputId);
  });
 }
}
