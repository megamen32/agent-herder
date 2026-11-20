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
import type {CanonicalAutomationClient} from "../canonical-herder.js";
import {meshDeliverySchema as delivery} from "./delivery-schema.js";
const result=(value:unknown)=>({content:[{type:"text" as const,text:JSON.stringify(value)}]});
/** Root integration seam: reuse singleton adapters; an authenticated Hub client is optional. */
export function registerHarnessMeshTools(server:McpServer,deps:{adapters:Map<string,HarnessAdapter>;hostId?:string;gptadmin?:GptAdminTransport;ledgerPath?:string;deliveryPolicy?:ProjectModelPolicyStateProvider;canonicalClient?:CanonicalAutomationClient;userMessageDelivery?:UserMessageDelivery;supervisor?:Pick<SessionSupervisor,"sendMessage">;nativeObserve?:(harness:string,nativeSessionId:string)=>Promise<{nativeSessionId:string;status:string;cwd?:string|null}|null>;trustedIngress?:TrustedMeshIngress}):void{
 const local=new LocalHarnessMesh(deps);
 server.registerTool("mesh_snapshot",{description:"Read-only native host/session/current-project snapshot. No LLM, transcript export or lazy native process launch. Partial and unsupported are explicit.",inputSchema:z.object({limit:z.number().int().min(1).max(12).default(12)})},async args=>result(await local.snapshot(args.limit)));
 server.registerTool("mesh_deliver",{description:"Compatibility delivery endpoint for one exact native session on this host. The ordinary deliver target envelope is the canonical caller contract; mesh_deliver remains available for older peers and capability probes. For a remote target return a compatibility hint to use ordinary deliver; never replay UNKNOWN.",inputSchema:delivery},async args=>{
  if(args.target.hostId!==local.hostId){
   const remoteRouteAvailable=Boolean(deps.gptadmin);
   return result({state:"not_attempted",inputId:args.inputId,retryable:remoteRouteAvailable,
    reason:remoteRouteAvailable?"remote_target_use_deliver":"remote_mesh_transport_unavailable",
    requestedHost:args.target.hostId,localHost:local.hostId,...(remoteRouteAvailable?{suggestedTool:"deliver"}:{})});
  }
  return result(await local.deliver(args,deps.trustedIngress));
 });
 if(deps.gptadmin){
  const mesh=new GptAdminMesh(deps.gptadmin,meshDiscoveryTimeoutMs()+10000,deps.deliveryPolicy,
   deps.canonicalClient?{client:deps.canonicalClient,ledger:local.ledger}:undefined);
  server.registerTool("mesh_discover",{description:"Discover registered native mesh peers through the existing authenticated fleet transport, with compact partial host receipts.",inputSchema:z.object({limit:z.number().int().min(1).max(12).default(12)})},async args=>result(await mesh.discover(args.limit)));
 server.registerTool("mesh_route",{description:"Compatibility route for older callers. The ordinary deliver target envelope selects the remote host from target.hostId and is the canonical cross-host contract; this name remains callable without being required. Resolves the exact peer and checks its live host identity and native session before delivery. Requires authenticated owner MCP ingress; sender is attribution only. Never retry uncertain admission or replay UNKNOWN.",inputSchema:delivery},async args=>{
   if(!deps.trustedIngress)return result({state:"not_attempted",inputId:args.inputId,retryable:false,reason:"authenticated_mesh_ingress_required"});
   return result(await mesh.deliver(args));
  });
 }
}
