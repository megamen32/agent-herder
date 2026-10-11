import {hostname,userInfo,platform,homedir} from 'node:os';
import {join} from 'node:path';
import {FleetCreateJournal} from './fleet-create-journal.js';
import type {McpServer} from '@modelcontextprotocol/server';
import {z} from 'zod';
import type {SessionSupervisor} from '../session-supervisor.js';
import type {HarnessAdapter} from '../types/index.js';
import {sessionInventoryPage,type LocalInventorySnapshot} from './session-page.js';
import {fleetHarnesses} from './fleet-contract.js';
// One process generation across all MCP connections and authenticated contexts.
let viewReads=0;
const processGeneration=Date.now()-Math.floor(process.uptime()*1000);
/** Attach to the existing local controller. No override, native activation, private writer or subprocess. */
export function registerFleetNodeTools(server:McpServer,deps:{adapters:Map<string,HarnessAdapter>;inventorySnapshot?:()=>LocalInventorySnapshot;readSupervisor?:Pick<SessionSupervisor,'getSession'|'getSessionDetails'>}):void{
 server.registerTool('fleet_session_page',{description:'Read one page of the existing local session metadata snapshot, with native IDs, observation time and partial state. No history or native activation.',annotations:{readOnlyHint:true},inputSchema:z.object({cursor:z.string().max(2048).optional(),limit:z.number().int().min(1).max(100).default(100)}).strict()},async({cursor,limit})=>{
  const snapshot=deps.inventorySnapshot?.()??{sessions:[],warming:true,observedAt:null};
  const result=sessionInventoryPage(hostname(),snapshot,cursor,limit);
  return {structuredContent:{...result},content:[{type:'text' as const,text:'Session metadata page'}]};
 });

 server.registerTool('fleet_session_view',{description:'Read the latest three messages of one exact native session, on demand. Unavailable history is explicit; no activation or mutation.',annotations:{readOnlyHint:true},inputSchema:z.object({harness:z.enum(['codex','zcode','opencode']),sessionId:z.string().min(1).max(512).refine(s=>!/[\x00-\x1f\x7f]/.test(s))}).strict()},async({harness,sessionId})=>{
  const adapter=deps.adapters.get(harness);if(!adapter||adapter.lazyStart&&(!adapter.isReady||!adapter.isReady()))throw new Error('fleet_session_native_not_ready');
  if(!deps.readSupervisor||viewReads>=3)throw new Error('fleet_session_read_unavailable');viewReads++;let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const operation=(async()=>{
    const native=await deps.readSupervisor!.getSession(harness,sessionId);if(!native||native.id!==sessionId||native.harness!==harness)throw new Error('fleet_session_identity_mismatch');
    let details:Awaited<ReturnType<SessionSupervisor['getSessionDetails']>>|undefined;
    try{details=await deps.readSupervisor!.getSessionDetails(harness,sessionId,{limit:3,quick:true,history:'acp'});}catch{/* Exact native metadata is available, history is not. */}
    if(details&&(details.session.id!==sessionId||details.session.harness!==harness))throw new Error('fleet_session_identity_mismatch');
    const session=details?.session??native;
    const result={hostId:hostname(),details:{session:{id:sessionId,harness,title:session.title,cwd:session.cwd,model:session.model},historyUnavailable:!details||details.history.source==='unavailable',messages:(details?.messages??[]).slice(-3).map(m=>({role:m.role,text:m.text}))}};
    if(Buffer.byteLength(JSON.stringify(result))>900000)throw new Error('fleet_session_response_limit');return result;
   })().finally(()=>{viewReads--;});
   const result=await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('fleet_session_read_deadline')),9000);})]);
   return {structuredContent:result,content:[{type:'text' as const,text:'Native session read view'}]};
  }finally{if(timer)clearTimeout(timer);}
 });
 const generation=processGeneration;
 const nativeUser=userInfo().username;
 const ownerJournal=new FleetCreateJournal(join(homedir(),'.local/state/agent-herder/fleet/direct-peer-create.json'),{profileId:'native-owner:'+nativeUser,userId:nativeUser});
 // Receiver owns the once-record across sender-node failure and client disconnect.
 server.registerTool('fleet_create_session',{description:'Create one local empty session with a durable exact intent identity. An uncertain result is never replayed.',inputSchema:z.object({inputId:z.string().regex(/^[a-f0-9]{64}$/),harness:z.enum(['codex','zcode','opencode']),name:z.string().trim().min(1).max(128),cwd:z.string().min(1).max(4096),model:z.string().min(1).max(128).optional()}).strict()},async(request)=>{
  const receipt=await ownerJournal.once({...request,hostId:hostname()},async()=>{
   const adapter=deps.adapters.get(request.harness);
   if(!adapter?.createSession)return {state:'not_attempted',inputId:request.inputId,retryable:false,reason:'native_create_unavailable'};
   const session=await adapter.createSession({name:request.name,cwd:request.cwd,...(request.model?{model:request.model}:{})});
   return {state:'created',inputId:request.inputId,address:{hostId:hostname(),harness:request.harness,nativeSessionId:session.id},launchCwd:session.cwd,retryable:false};
  });
  const result=receipt.state==='created'&&receipt.address&&receipt.launchCwd?{ok:true,created:true,harness:receipt.address.harness,sessionId:receipt.address.nativeSessionId,cwd:receipt.launchCwd,inputId:receipt.inputId}:{ok:false,created:false,state:receipt.state,inputId:receipt.inputId};
  return {content:[{type:'text' as const,text:JSON.stringify(result)}]};
 });
 server.registerTool('fleet_node_info',{description:'Read actual local Herder host/user identity and configured session-creation capability, without activating a harness.',inputSchema:z.object({})},async()=>{
  const snapshot={hostId:hostname(),nativeUser:userInfo().username,platform:platform(),generation,createHarnesses:fleetHarnesses.filter(h=>typeof deps.adapters.get(h)?.createSession==='function')};
  return {content:[{type:'text' as const,text:JSON.stringify(snapshot)}]};
 });
}
