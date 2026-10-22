import {hostname,userInfo,platform,homedir} from 'node:os';
import {join} from 'node:path';
import {FleetCreateJournal} from './fleet-create-journal.js';
import type {McpServer} from '@modelcontextprotocol/server';
import {z} from 'zod';
import type {SessionSupervisor} from '../session-supervisor.js';
import type {HarnessAdapter} from '../types/index.js';
import {sessionInventoryPage,type LocalInventorySnapshot} from './session-page.js';
import {fleetHarnesses} from './fleet-contract.js';
import type {IntegratorFleetRuntime,IntegratorProjectReadinessSnapshot} from '../integrator-fleet-runtime.js';
import {assertModelAllowedForDirectoryWithPolicy,type ProjectModelPolicyProvider} from '../project-model-gate.js';
// One process generation across all MCP connections and authenticated contexts.
let viewReads=0;
const processGeneration=Date.now()-Math.floor(process.uptime()*1000);
/** Attach to the existing local controller. No override, native activation, private writer or subprocess. */
export function registerFleetNodeTools(server:McpServer,deps:{adapters:Map<string,HarnessAdapter>;inventorySnapshot?:()=>LocalInventorySnapshot;readSupervisor?:Pick<SessionSupervisor,'getSession'|'getSessionDetails'>;integratorRuntime?:IntegratorFleetRuntime;ownerJournal?:Pick<FleetCreateJournal,'once'>;launchPolicy?:ProjectModelPolicyProvider}):void{
 server.registerTool('fleet_session_page',{description:'Read one page of the existing local session metadata snapshot, with native IDs, observation time and partial state. No history or native activation.',annotations:{readOnlyHint:true},inputSchema:z.object({cursor:z.string().max(2048).optional(),limit:z.number().int().min(1).max(100).default(100)}).strict()},async({cursor,limit})=>{
  const snapshot=deps.inventorySnapshot?.()??{sessions:[],warming:true,observedAt:null};
  const result=sessionInventoryPage(hostname(),snapshot,cursor,limit);
  return {structuredContent:{...result},content:[{type:'text' as const,text:'Session metadata page'}]};
 });

 server.registerTool('fleet_session_view',{description:'Read the latest three messages of one exact native session, on demand. Unavailable history is explicit; no activation or mutation.',annotations:{readOnlyHint:true},inputSchema:z.object({harness:z.enum(['codex','zcode','opencode']),sessionId:z.string().min(1).max(512).refine(s=>!/[\x00-\x1f\x7f]/.test(s))}).strict()},async({harness,sessionId})=>{
  const routed=await deps.integratorRuntime?.adapterForSession({hostId:hostname(),harness,nativeSessionId:sessionId});
  if(routed?.kind==='deny')throw new Error('fleet_session_scope_unavailable');
  const adapter=routed?.kind==='scoped'?routed.adapter:deps.adapters.get(harness);if(!adapter||adapter.lazyStart&&(!adapter.isReady||!adapter.isReady()))throw new Error('fleet_session_native_not_ready');
  if((!deps.readSupervisor&&routed?.kind!=='scoped')||viewReads>=3)throw new Error('fleet_session_read_unavailable');viewReads++;let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const operation=(async()=>{
    const native=routed?.kind==='scoped'?await adapter.getSession(sessionId):await deps.readSupervisor!.getSession(harness,sessionId);if(!native||native.id!==sessionId||native.harness!==harness)throw new Error('fleet_session_identity_mismatch');
    let details:Awaited<ReturnType<SessionSupervisor['getSessionDetails']>>|undefined;
    let scopedMessages:Awaited<ReturnType<NonNullable<HarnessAdapter['getSessionMessages']>>>|null|undefined;
    if(routed?.kind!=='scoped')try{details=await deps.readSupervisor!.getSessionDetails(harness,sessionId,{limit:3,quick:true,history:'acp'});}catch{/* Exact native metadata is available, history is not. */}
    else if(adapter.getSessionMessages)try{scopedMessages=await adapter.getSessionMessages(sessionId,3);}catch{/* Exact scoped metadata is available, history is not. */}
    if(details&&(details.session.id!==sessionId||details.session.harness!==harness))throw new Error('fleet_session_identity_mismatch');
    const session=details?.session??native;
    const result={hostId:hostname(),details:{session:{id:sessionId,harness,title:session.title,cwd:session.cwd,model:session.model},historyUnavailable:routed?.kind==='scoped'?scopedMessages==null:!details||details.history.source==='unavailable',messages:(routed?.kind==='scoped'?scopedMessages??[]:details?.messages??[]).slice(-3).map(m=>({role:m.role,text:m.text}))}};
    if(Buffer.byteLength(JSON.stringify(result))>900000)throw new Error('fleet_session_response_limit');return result;
   })().finally(()=>{viewReads--;});
   const result=await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('fleet_session_read_deadline')),9000);})]);
   return {structuredContent:result,content:[{type:'text' as const,text:'Native session read view'}]};
  }finally{if(timer)clearTimeout(timer);}
 });
 const generation=processGeneration;
 const nativeUser=userInfo().username;
 const ownerJournal=deps.ownerJournal??new FleetCreateJournal(join(homedir(),'.local/state/agent-herder/fleet/direct-peer-create.json'),{profileId:'native-owner:'+nativeUser,userId:nativeUser});
 // Receiver owns the once-record across sender-node failure and client disconnect.
 const readinessSchema=z.object({state:z.literal('ready').optional(),projectId:z.string(),projectRoot:z.string(),rootIdentity:z.string(),policyRevision:z.string(),hostId:z.string(),harness:z.literal('codex'),harnessVersion:z.string(),model:z.literal('gpt-6-luna'),requiredTools:z.array(z.string()),availableTools:z.array(z.string()),availableModels:z.array(z.string()),resourceReady:z.boolean(),runtimeInstanceId:z.string(),cwd:z.string(),pathResolution:z.object({requestedCwd:z.string(),canonicalCwd:z.string(),rootPath:z.string(),contained:z.boolean(),identityMatches:z.boolean()}).strict(),observedAtMs:z.number()}).strict();
 server.registerTool('fleet_create_session',{description:'Create one local empty session with a durable exact intent identity. An uncertain result is never replayed.',inputSchema:z.object({inputId:z.string().regex(/^[a-f0-9]{64}$/),harness:z.enum(['codex','zcode','opencode']),name:z.string().trim().min(1).max(128),cwd:z.string().min(1).max(4096),model:z.string().min(1).max(128).optional(),project:z.string().trim().min(1).max(512).optional(),projectReadinessContract:z.literal('integrator-host-readiness-v1').optional(),projectReadiness:readinessSchema.optional()}).strict()},async(request)=>{
  // A model the project forbids must not reach a session, whatever created it.
  await assertModelAllowedForDirectoryWithPolicy(deps.launchPolicy,request.cwd,request.model,request.harness);
  if(request.project!==undefined){
   if(request.harness!=='codex'||!deps.integratorRuntime||request.projectReadinessContract!=='integrator-host-readiness-v1'||!request.projectReadiness
     ||!await deps.integratorRuntime.validateReadiness({project:request.project,inputId:request.inputId,name:request.name,cwd:request.cwd,...(request.model?{model:request.model}:{}),projectReadinessContract:request.projectReadinessContract,projectReadiness:request.projectReadiness as IntegratorProjectReadinessSnapshot})){
    const refused={ok:false,created:false,state:'not_attempted',inputId:request.inputId,reason:'project_readiness_not_validated'};
    return {structuredContent:refused,content:[{type:'text' as const,text:JSON.stringify(refused)}]};
   }
  }
  const receipt=await ownerJournal.once({...request,hostId:hostname()},async()=>{
   if(request.project!==undefined){
    if(request.harness!=='codex'||!deps.integratorRuntime)return {state:'not_attempted',inputId:request.inputId,retryable:false,reason:'project_scoped_create_unavailable'};
    return deps.integratorRuntime.create({project:request.project,inputId:request.inputId,name:request.name,cwd:request.cwd,...(request.model?{model:request.model}:{}),projectReadinessContract:request.projectReadinessContract,projectReadiness:request.projectReadiness as IntegratorProjectReadinessSnapshot});
   }
   const adapter=deps.adapters.get(request.harness);
   if(!adapter?.createSession)return {state:'not_attempted',inputId:request.inputId,retryable:false,reason:'native_create_unavailable'};
   const session=await adapter.createSession({name:request.name,cwd:request.cwd,...(request.model?{model:request.model}:{})});
   return {state:'created',inputId:request.inputId,address:{hostId:hostname(),harness:request.harness,nativeSessionId:session.id},launchCwd:session.cwd,retryable:false};
  });
  const result=receipt.state==='created'&&receipt.address&&receipt.launchCwd?{ok:true,created:true,harness:receipt.address.harness,sessionId:receipt.address.nativeSessionId,cwd:receipt.launchCwd,inputId:receipt.inputId}:{ok:false,created:false,state:receipt.state,inputId:receipt.inputId};
  const resultWithReadiness=request.project===undefined?result:{...result,projectReadinessContract:'integrator-host-readiness-v1',projectExecution:receipt.state==='created'?receipt.projectExecution:undefined};
  return {structuredContent:resultWithReadiness,content:[{type:'text' as const,text:JSON.stringify(resultWithReadiness)}]};
 });
 server.registerTool('fleet_node_info',{description:'Read actual local Herder host/user identity and configured session-creation capability; project readiness is an explicit host-owned scoped preflight.',inputSchema:z.object({project:z.string().trim().min(1).max(512).optional()}).strict()},async(request?:{project?:string})=>{
  const project=request?.project;
  const snapshot={hostId:hostname(),nativeUser:userInfo().username,platform:platform(),generation,createHarnesses:fleetHarnesses.filter(h=>typeof deps.adapters.get(h)?.createSession==='function')};
  if(project===undefined)return {structuredContent:snapshot,content:[{type:'text' as const,text:JSON.stringify(snapshot)}]};
  const readiness=deps.integratorRuntime?await deps.integratorRuntime.readiness(project):undefined;
  const result={...snapshot,projectReadinessContract:'integrator-host-readiness-v1',projectReadiness:readiness??{state:'not_ready',projectId:project,reason:'project_scoped_runtime_unavailable'}};
  return {structuredContent:result,content:[{type:'text' as const,text:JSON.stringify(result)}]};
 });
}
