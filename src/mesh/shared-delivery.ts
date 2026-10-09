import type {MeshDelivery} from "./gptadmin.js";
import type {MeshDeliveryLedger} from "./delivery-ledger.js";
import type {NativeReceipt} from "./protocol.js";
import {getHumanStopStore,type HumanStopStore} from "../human-stop-store.js";
type Rpc={connect():Promise<void>;request(method:string,params:Record<string,unknown>):Promise<any>};
type Proof={nativeSessionId:string;status:string};
/** Shared control and an independent native observation are both required.
 * Existing durable intent wins over every fresh preflight, including STOP. */
export async function deliverSharedCodex(request:MeshDelivery,deps:{client:Rpc;ledger:MeshDeliveryLedger;observe:(id:string)=>Promise<Proof|null>;stopStore?:HumanStopStore}):Promise<NativeReceipt&{reason?:string}>{
 const rejected=(reason:string)=>({state:"not_attempted" as const,inputId:request.inputId,retryable:true,reason});
 return deps.ledger.once(request,async()=>{
  if(request.target.harness!=="codex")return rejected("native_transport_not_registered");
  const stops=deps.stopStore??getHumanStopStore();
  if(await stops.isHeld("codex",request.target.nativeSessionId))return rejected("human_stopped_native_session");
  const observation=await deps.observe(request.target.nativeSessionId);
  if(!observation||observation.nativeSessionId!==request.target.nativeSessionId||observation.status!=="running")return rejected("independent_native_writer_unknown");
  try{await deps.client.connect();}catch{return rejected("native_shared_transport_unavailable");}
  let thread:any;
  try{thread=(await deps.client.request("thread/read",{threadId:request.target.nativeSessionId,includeTurns:false})).thread;}catch{return rejected("native_session_not_found");}
  if(thread?.id!==request.target.nativeSessionId)return rejected("native_session_identity_mismatch");
  const turns=await deps.client.request("thread/turns/list",{threadId:request.target.nativeSessionId,limit:1,sortDirection:"desc",itemsView:"notLoaded"});
  if(!Array.isArray(turns.data))return rejected("native_writer_status_unknown");
  if(turns.data[0]?.status==="interrupted")return rejected("human_stopped_native_session");
  const active=turns.data.find((t:any)=>t.status==="inProgress"&&typeof t.id==="string");
  if(!active)return rejected("idle_native_writer_ownership_unproven");
  if(await stops.isHeld("codex",request.target.nativeSessionId))return rejected("human_stopped_native_session");
  const message=`Источник: ${request.sender.hostId} / ${request.sender.harness} / ${request.sender.nativeSessionId}.\n${request.message}`;
  await stops.rememberGeneratedPrompt("codex",request.target.nativeSessionId,message,active.id);
  const r=await deps.client.request("turn/steer",{threadId:request.target.nativeSessionId,expectedTurnId:active.id,input:[{type:"text",text:message}]});
  return r.turnId===active.id?{state:"admitted" as const,inputId:request.inputId,turnId:r.turnId,retryable:false}:{state:"unknown" as const,inputId:request.inputId,retryable:false};
 });
}
