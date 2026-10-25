#!/usr/bin/env node
import {McpServer} from "@modelcontextprotocol/server";
import {serveStdio} from "@modelcontextprotocol/server/stdio";
import {Client,StreamableHTTPClientTransport} from "@modelcontextprotocol/client";
import {z} from "zod";
import {homedir,hostname} from "node:os";
import {join} from "node:path";
import {observeCodex} from "./native-observer.js";
import {NativeCodexClient} from "./native-codex.js";
import {MeshDeliveryLedger} from "./delivery-ledger.js";
import {addressKey,type MeshAddress,type MeshSession} from "./protocol.js";
import {inventoryHarnesses} from "./inventory.js";
import {deliverSharedCodex} from "./shared-delivery.js";
import {MINIMAX_CODE_HARNESS,observeMinimaxCode} from "./native-minimax-code.js";
import {relayNativePeerDeliveryToOwner} from "./native-peer-owner-relay.js";
const hostId=hostname();
const codex=new NativeCodexClient();
const ledger=new MeshDeliveryLedger(join(homedir(),".local/state/agent-herder/harness-mesh-receipts.json"));
const ownerUrl=new URL(process.env.AGENT_HERDER_HTTP_URL||"http://127.0.0.1:18787/mcp");
if(ownerUrl.protocol!=="http:"||ownerUrl.hostname!=="127.0.0.1")throw new Error("Native mesh relay requires the existing verified loopback Agent Herder owner");
const ownerClient=new Client({name:"agent-herder-native-mesh-owner-relay",version:"1"},{versionNegotiation:{mode:"auto"}});
let ownerTransport:StreamableHTTPClientTransport|undefined,ownerReady:Promise<void>|undefined;
async function callOwnerMesh(request:{target:MeshAddress;sender:MeshAddress;inputId:string;message:string}):Promise<unknown>{
 if(!ownerReady){
  ownerTransport=new StreamableHTTPClientTransport(ownerUrl,process.env.AGENT_HERDER_HTTP_TOKEN?{authProvider:{token:async()=>process.env.AGENT_HERDER_HTTP_TOKEN!}}:{});
  ownerReady=(async()=>{await ownerClient.connect(ownerTransport!);const tools=(await ownerClient.listTools()).tools;if(!tools.some(tool=>tool.name==="mesh_deliver"))throw new Error("shared_owner_mesh_tool_unavailable");})();
 }
 await ownerReady;
 return ownerClient.callTool({name:"mesh_deliver",arguments:request},{timeout:60_000});
}
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
  const receipt=await relayNativePeerDeliveryToOwner(request,callOwnerMesh);
  return result(receipt);
 }
 const receipt=await deliverSharedCodex(request,{client:codex,ledger,observe:async id=>{
  try{const observation=(await observeCodex(1,undefined,hostId,id)).sessions[0];return observation?{nativeSessionId:observation.address.nativeSessionId,status:observation.status}:null;}catch{return null;}
 }});
 return result(receipt);
});
process.stdin.once("end",()=>{codex.close();void ownerClient.close();});
process.once("SIGTERM",()=>{codex.close();void ownerClient.close().finally(()=>process.exit(0));});
await serveStdio(()=>server);
