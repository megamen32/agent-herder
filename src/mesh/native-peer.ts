#!/usr/bin/env node
import {McpServer} from "@modelcontextprotocol/server";
import {serveStdio} from "@modelcontextprotocol/server/stdio";
import {z} from "zod";
import {homedir,hostname} from "node:os";
import {join} from "node:path";
import {observeCodex} from "./native-observer.js";
import {NativeCodexClient} from "./native-codex.js";
import {MeshDeliveryLedger} from "./delivery-ledger.js";
import {addressKey} from "./protocol.js";
import {inventoryHarnesses} from "./inventory.js";
import {deliverSharedCodex} from "./shared-delivery.js";
const hostId=hostname();
const codex=new NativeCodexClient();
const ledger=new MeshDeliveryLedger(join(homedir(),".local/state/agent-herder/harness-mesh-receipts.json"));
const server=new McpServer({name:"agent-herder-harness-mesh",version:"1"});
const result=(v:unknown)=>({content:[{type:"text" as const,text:JSON.stringify(v)}]});
const address=z.object({hostId:z.string().min(1).max(512),harness:z.string().min(1).max(64),nativeSessionId:z.string().min(1).max(512)});
server.registerTool("mesh_snapshot",{description:"Bounded native host and current-project observation; does not start a native process or LLM.",inputSchema:z.object({limit:z.number().int().min(1).max(12).default(12)})},async({limit})=>{
 let sessions:Awaited<ReturnType<typeof observeCodex>>["sessions"]=[],complete=false,reason:string|undefined;
 try{({sessions,complete}=await observeCodex(limit));}catch{reason="native_codex_metadata_unavailable";}
 const harnesses=inventoryHarnesses.map(harness=>({harness,discovery:harness==="codex"&&!reason?"available":"unavailable",delivery:"unsupported",...(harness==="codex"?{reason:reason||"native_shared_control_unverified",repairPlan:"Register and verify the documented existing shared native control socket; never attach a second private writer to an external live session."}:{reason:"native_transport_not_registered",repairPlan:harness==="minimax-code"?"Restore official mcode launcher and verify ACP session/list, session/load and native receipt with the Desktop ID before enabling.":"Register the existing supported local harness MCP/plugin and verify same native ID and admission; do not copy runtime core."})}));
 return result({hostId,sessions,harnesses,complete});
});
server.registerTool("mesh_deliver",{description:"Codex same-ID input through an existing documented shared native socket only. No private writer. Durable no-replay receipt, 6/pair 12/target per minute.",inputSchema:z.object({target:address,sender:address,inputId:z.string().min(1).max(256),message:z.string().min(1).max(4000)})},async request=>{
 addressKey(request.target);addressKey(request.sender);
 const rejected=(reason:string)=>({state:"not_attempted" as const,inputId:request.inputId,retryable:true,reason});
 const reject=(reason:string)=>result(rejected(reason));
 if(request.target.hostId!==hostId)return reject("native_host_identity_mismatch");
 const receipt=await deliverSharedCodex(request,{client:codex,ledger,observe:async id=>{
  try{const observation=(await observeCodex(1,undefined,hostId,id)).sessions[0];return observation?{nativeSessionId:observation.address.nativeSessionId,status:observation.status}:null;}catch{return null;}
 }});
 return result(receipt);
});
process.stdin.once("end",()=>codex.close());
process.once("SIGTERM",()=>{codex.close();process.exit(0);});
await serveStdio(()=>server);
