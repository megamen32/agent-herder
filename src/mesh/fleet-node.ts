import {hostname,userInfo,platform,homedir} from 'node:os';
import {join} from 'node:path';
import {FleetCreateJournal} from './fleet-create-journal.js';
import type {McpServer} from '@modelcontextprotocol/server';
import {z} from 'zod';
import type {HarnessAdapter} from '../types/index.js';
import {fleetHarnesses} from './fleet-contract.js';
// One process generation across all MCP connections and authenticated contexts.
const processGeneration=Date.now()-Math.floor(process.uptime()*1000);
/** Attach to the existing local controller. No override, native activation, private writer or subprocess. */
export function registerFleetNodeTools(server:McpServer,deps:{adapters:Map<string,HarnessAdapter>}):void{
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
