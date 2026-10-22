#!/usr/bin/env node
import {McpServer} from "@modelcontextprotocol/server";
import {serveStdio} from "@modelcontextprotocol/server/stdio";
import {z} from "zod";
import {homedir,hostname} from "node:os";
import {join} from "node:path";
import {observeCodex} from "./native-observer.js";
import {NativeCodexClient} from "./native-codex.js";
import {MeshDeliveryLedger} from "./delivery-ledger.js";
import {addressKey,type MeshSession} from "./protocol.js";
import {inventoryHarnesses} from "./inventory.js";
import {deliverSharedCodex} from "./shared-delivery.js";
import {MinimaxCodeControl} from "../adapters/minimax-code-control.js";
import {MINIMAX_CODE_HARNESS,deliverMinimaxCode,observeMinimaxCode} from "./native-minimax-code.js";
const hostId=hostname();
const codex=new NativeCodexClient();
const minimax=new MinimaxCodeControl();
const ledger=new MeshDeliveryLedger(join(homedir(),".local/state/agent-herder/harness-mesh-receipts.json"));
const server=new McpServer({name:"agent-herder-harness-mesh",version:"1"});
const result=(v:unknown)=>({content:[{type:"text" as const,text:JSON.stringify(v)}]});
const address=z.object({hostId:z.string().min(1).max(512),harness:z.string().min(1).max(64),nativeSessionId:z.string().min(1).max(512)});
server.registerTool("mesh_snapshot",{description:"Bounded native host and current-project observation; does not start a native process or LLM.",inputSchema:z.object({limit:z.number().int().min(1).max(12).default(12)})},async({limit})=>{
 let complete=true;const sources:MeshSession[][]=[[],[]];const reasons:Record<string,string>={};
 const observe=async(index:number,harness:string,read:()=>Promise<{sessions:MeshSession[];complete:boolean}>)=>{
  try{const observed=await read();sources[index]!.push(...observed.sessions);if(!observed.complete)complete=false;}catch{reasons[harness]=`native_${harness}_metadata_unavailable`;complete=false;}
 };
 await Promise.all([
  observe(0,"codex",()=>observeCodex(limit)),
  observe(1,MINIMAX_CODE_HARNESS,()=>observeMinimaxCode(limit)),
 ]);
 // One native address is published once, whatever source reported it.
 const merged=new Map<string,MeshSession>();
 for(const list of sources)for(const session of list){const key=addressKey(session.address);if(!merged.has(key))merged.set(key,session);}
 // The limit is one budget for both platforms, not one budget per source.
 const sessions=[...merged.values()].sort((a,b)=>b.lastActivity.localeCompare(a.lastActivity)).slice(0,limit);
 if(merged.size>limit)complete=false;
 const harnesses=inventoryHarnesses.map(harness=>{
  const observed=harness==="codex"||harness===MINIMAX_CODE_HARNESS;
  const reason=reasons[harness];
  return {harness,discovery:observed&&!reason?"available":"unavailable",delivery:"unsupported",reason:observed?(reason||"native_shared_control_unverified"):"native_transport_not_registered"};
 });
 return result({hostId,sessions,harnesses,complete});
});
server.registerTool("mesh_deliver",{description:"Native input through an existing documented shared native socket only. No private writer. Durable no-replay receipt, 6/pair 12/target per minute.",inputSchema:z.object({target:address,sender:address,inputId:z.string().min(1).max(256),message:z.string().min(1).max(4000)})},async request=>{
 addressKey(request.target);addressKey(request.sender);
 const rejected=(reason:string)=>({state:"not_attempted" as const,inputId:request.inputId,retryable:true,reason});
 const reject=(reason:string)=>result(rejected(reason));
 if(request.target.hostId!==hostId)return reject("native_host_identity_mismatch");
 if(request.target.harness===MINIMAX_CODE_HARNESS){
  const receipt=await deliverMinimaxCode(request,{ledger,port:{
   enqueue:async(id,message)=>{
    const answer=await minimax.enqueue(id,message);
    if(!answer.ok)return {ok:false,error:answer.error};
    const item=(answer.body??{}) as {item_id?:string};
    // The runtime took the item, but without its id the receipt stays unproven.
    if(typeof item.item_id!=="string"||!item.item_id)return {ok:true,admissionUnknown:true};
    return {ok:true,admitted:true,turnId:item.item_id};
   },
  },observe:async id=>{
   try{const observed=await observeMinimaxCode(1,undefined,hostId,id);const session=observed.sessions[0];return session?{nativeSessionId:session.address.nativeSessionId,status:session.status,cwd:session.project.currentCwd??session.project.launchCwd}:null;}catch{return null;}
  }});
  return result(receipt);
 }
 const receipt=await deliverSharedCodex(request,{client:codex,ledger,observe:async id=>{
  try{const observation=(await observeCodex(1,undefined,hostId,id)).sessions[0];return observation?{nativeSessionId:observation.address.nativeSessionId,status:observation.status}:null;}catch{return null;}
 }});
 return result(receipt);
});
process.stdin.once("end",()=>codex.close());
process.once("SIGTERM",()=>{codex.close();process.exit(0);});
await serveStdio(()=>server);
