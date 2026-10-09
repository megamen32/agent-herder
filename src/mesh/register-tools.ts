import type {McpServer} from "@modelcontextprotocol/server";
import {z} from "zod";
import {LocalHarnessMesh} from "./local.js";
import {GptAdminMesh,type GptAdminTransport} from "./gptadmin.js";
import type {HarnessAdapter} from "../types/index.js";
const address=z.object({hostId:z.string().min(1).max(512),harness:z.string().min(1).max(64),nativeSessionId:z.string().min(1).max(512)});
const delivery=z.object({target:address,sender:address,inputId:z.string().min(1).max(256),message:z.string().min(1).max(4000)});
const result=(value:unknown)=>({content:[{type:"text" as const,text:JSON.stringify(value)}]});
/** Root integration seam: reuse singleton adapters; an authenticated Hub client is optional. */
export function registerHarnessMeshTools(server:McpServer,deps:{adapters:Map<string,HarnessAdapter>;hostId?:string;gptadmin?:GptAdminTransport;ledgerPath?:string}):void{
 const local=new LocalHarnessMesh(deps);
 server.registerTool("mesh_snapshot",{description:"Read-only native host/session/current-project snapshot. No LLM, transcript export or lazy native process launch. Partial and unsupported are explicit.",inputSchema:z.object({limit:z.number().int().min(1).max(12).default(12)})},async args=>result(await local.snapshot(args.limit)));
 server.registerTool("mesh_deliver",{description:"Deliver one bounded work delta to exact host+harness+nativeSessionID. Stable inputId, durable intent and 6/pair 12/target limits. UNKNOWN must never be replayed.",inputSchema:delivery},async args=>result(await local.deliver(args)));
 if(deps.gptadmin){
  const mesh=new GptAdminMesh(deps.gptadmin);
  server.registerTool("mesh_discover",{description:"Discover registered native mesh peers through the authenticated GPTAdmin profile, with compact partial host receipts.",inputSchema:z.object({limit:z.number().int().min(1).max(12).default(12)})},async args=>result(await mesh.discover(args.limit)));
  server.registerTool("mesh_route",{description:"Address one discovered remote native peer via GPTAdmin. Never retries uncertain admission.",inputSchema:delivery},async args=>result(await mesh.deliver(args)));
 }
}
