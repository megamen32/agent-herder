import {homedir,hostname} from "node:os";
import {join} from "node:path";
import type {HarnessAdapter} from "../types/index.js";
import {handleSendMessage} from "../mcp-tools/handlers.js";
import {compactSession,parseNativeReceipt,addressKey,type MeshSession,type NativeReceipt} from "./protocol.js";
import type {MeshDelivery} from "./gptadmin.js";
import {MeshDeliveryLedger} from "./delivery-ledger.js";
import {inventoryHarnesses} from "./inventory.js";
import {coordinationNotes,type CoordinationNoteStore} from "../coordination-notes.js";
export interface HarnessMeshCapability {harness:string;discovery:"available"|"unavailable";delivery:"available"|"unsupported";reason?:string}
type Dependencies={hostId?:string;adapters:Map<string,HarnessAdapter>;send?:(args:Record<string,unknown>)=>Promise<unknown>;ledgerPath?:string;readDeadlineMs?:number;projectStore?:Pick<CoordinationNoteStore,"activeWorkspaceForSession">};
export class LocalHarnessMesh {
 readonly hostId:string;
 private readonly ids=new Map<string,string>();
 private readonly ledger:MeshDeliveryLedger;
 constructor(private readonly deps:Dependencies){this.hostId=deps.hostId||hostname();this.ledger=new MeshDeliveryLedger(deps.ledgerPath||join(homedir(),".local/state/agent-herder/harness-mesh-receipts.json"));}
 async snapshot(limit=12):Promise<{hostId:string;sessions:MeshSession[];harnesses:HarnessMeshCapability[];complete:boolean}>{
  if(!Number.isInteger(limit)||limit<1||limit>12)throw new Error("Mesh snapshot limit must be 1..12");
  const sessions:MeshSession[]=[];const harnesses:HarnessMeshCapability[]=[];let complete=true;
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
    const rows=await Promise.race([adapter.listSessions({limit}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("mesh_read_deadline")),remaining);})]).finally(()=>{if(timer)clearTimeout(timer);});
    const receipt=adapter.getSessionSnapshotReceipt?.();
    if(receipt?.exhaustive!==true)complete=false;
    for(const row of rows.slice(0,limit)){
     const activeCwd=(this.deps.projectStore??coordinationNotes).activeWorkspaceForSession(row.id);
     const projected=activeCwd?{...row,cwd:activeCwd,meta:{...row.meta,launchCwd:row.meta?.launchCwd??row.cwd,activeCwd,projectSource:"coordination_activity"}}:row;
     const session=compactSession(this.hostId,projected);sessions.push(session);freshIds.set(addressKey(session.address),row.id);
    }
    // Existing API implementations do not all provide native admission proof.
    harnesses.push({harness,discovery:"available",delivery:harness==="codex"?"available":"unsupported",...(harness!=="codex"?{reason:"native_admission_receipt_unverified"}:{})});
   }catch{complete=false;harnesses.push({harness,discovery:"unavailable",delivery:"unsupported",reason:"native_discovery_failed"});}
  };
  let next=0;await Promise.all(Array.from({length:3},async()=>{for(;;){const harness=inventoryHarnesses[next++];if(!harness)return;await inspect(harness);}}));
  this.ids.clear();for(const [key,value]of freshIds)this.ids.set(key,value);
  const sorted=sessions.sort((a,b)=>b.lastActivity.localeCompare(a.lastActivity)).slice(0,limit);
  if(sessions.length>limit)complete=false;
  return {hostId:this.hostId,sessions:sorted,harnesses,complete};
 }
 async deliver(request:MeshDelivery):Promise<NativeReceipt&{reason?:string}>{
  addressKey(request.target);addressKey(request.sender);
  const reject=(reason:string)=>({state:"not_attempted" as const,inputId:request.inputId,retryable:true,reason});
  if(request.target.hostId!==this.hostId)return reject("native_host_identity_mismatch");
  if(!request.inputId||request.inputId.length>256||!request.message.trim()||request.message.length>4000)throw new Error("A stable inputId and bounded delta are required");
  return this.ledger.once(request,async()=>{
   const adapter=this.deps.adapters.get(request.target.harness);
   if(!adapter)return reject("adapter_not_registered");
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
}
