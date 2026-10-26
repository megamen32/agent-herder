import {meshDiscoveryTimeoutMs} from "./discovery-timeout.js";
import type {McpServer} from "@modelcontextprotocol/server";
import {z} from "zod";
import {LocalHarnessMesh} from "./local.js";
import type {ProjectModelPolicyStateProvider} from "../project-model-delivery-gate.js";
import {GptAdminMesh,type GptAdminTransport} from "./gptadmin.js";
import type {HarnessAdapter} from "../types/index.js";
import type {SessionSupervisor} from "../session-supervisor.js";
import type {UserMessageDelivery} from "../user-message-delivery.js";
import type {TrustedMeshIngress} from "./authenticated-ingress.js";
const address=z.object({hostId:z.string().min(1).max(512),harness:z.string().min(1).max(64),nativeSessionId:z.string().min(1).max(512)});
const rename=z.object({target:address,title:z.string().min(1).max(4096).optional(),project:z.string().min(1).max(512).optional(),goal:z.string().min(1).max(2048).optional(),stage:z.string().min(1).max(2048).optional()});
const delivery=z.object({target:address,sender:address,inputId:z.string().min(1).max(256),message:z.string().min(1).max(4000)});
const stop=z.object({target:address,inputId:z.string().min(1).max(256)});
const result=(value:unknown)=>({content:[{type:"text" as const,text:JSON.stringify(value)}]});
/** Root integration seam: reuse singleton adapters; an authenticated Hub client is optional. */
export function registerHarnessMeshTools(server:McpServer,deps:{adapters:Map<string,HarnessAdapter>;hostId?:string;gptadmin?:GptAdminTransport;ledgerPath?:string;deliveryPolicy?:ProjectModelPolicyStateProvider;userMessageDelivery?:UserMessageDelivery;supervisor?:Pick<SessionSupervisor,"sendMessage">;nativeObserve?:(harness:string,nativeSessionId:string)=>Promise<{nativeSessionId:string;status:string;cwd?:string|null}|null>;trustedIngress?:TrustedMeshIngress}):void{
 const local=new LocalHarnessMesh(deps);
 server.registerTool("mesh_snapshot",{description:"Read-only native host/session/current-project snapshot. No LLM, transcript export or lazy native process launch. Partial and unsupported are explicit.",inputSchema:z.object({limit:z.number().int().min(1).max(12).default(12)})},async args=>result(await local.snapshot(args.limit)));
 server.registerTool("mesh_deliver",{description:"Deliver one bounded work delta to an exact native session on this host only. For a session on another host, use mesh_route when available; do not retry this local tool. Stable inputId, durable intent and 6/pair 12/target limits. Requires authenticated owner MCP ingress; sender is attribution only. Never replay UNKNOWN.",inputSchema:delivery},async args=>{
  if(args.target.hostId!==local.hostId){
   const remoteRouteAvailable=Boolean(deps.gptadmin);
   return result({state:"not_attempted",inputId:args.inputId,retryable:remoteRouteAvailable,
    reason:remoteRouteAvailable?"remote_target_requires_mesh_route":"remote_mesh_transport_unavailable",
    requestedHost:args.target.hostId,localHost:local.hostId,...(remoteRouteAvailable?{suggestedTool:"mesh_route"}:{})});
  }
  return result(await local.deliver(args,deps.trustedIngress));
 });
 server.registerTool("mesh_stop",{description:"Stop one exact native session of this host. The session is stopped, never deleted. An unproven stop must never be replayed.",inputSchema:stop},async args=>result(await local.stop(args)));
 server.registerTool("mesh_rename_session",{description:"Rename one exact native session of this host. The title of the same session changes in place: no session is created, no model turn starts and no active turn is interrupted. Without a title Herder composes 'goal | short canonical project name' from stored metadata; stage is omitted.",inputSchema:rename},async args=>result(await local.rename(args)));
 if(deps.gptadmin){
  const mesh=new GptAdminMesh(deps.gptadmin,meshDiscoveryTimeoutMs()+10000,deps.deliveryPolicy);
  server.registerTool("mesh_discover",{description:"Discover registered native mesh peers through the existing authenticated fleet transport, with compact partial host receipts.",inputSchema:z.object({limit:z.number().int().min(1).max(12).default(12)})},async args=>result(await mesh.discover(args.limit)));
  server.registerTool("mesh_route",{description:"Route one bounded work delta to an exact session on a remote host. Resolves the exact peer and checks its live host identity and native session before delivery; use mesh_deliver for this host. No mode parameter: the MiniMax active native lane steers the current turn. Ordinary inter-agent send_message exchange should use explicit mode:steer (default); queue is intentional deferred work, may wait hours, and is not immediate exchange. Requires authenticated owner MCP ingress; sender is attribution only. Never retry uncertain admission or replay UNKNOWN.",inputSchema:delivery},async args=>{
   if(!deps.trustedIngress)return result({state:"not_attempted",inputId:args.inputId,retryable:false,reason:"authenticated_mesh_ingress_required"});
   return result(await mesh.deliver(args));
  });
 }
}
