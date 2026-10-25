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
import { AutomationDisarmStore, buildAutomationDisarmSummary, humanWorkKeys, type AutomationDisarmRecord } from '../automation-disarm/index.js';
import { sameSecret } from '../secret-compare.js';
import { readFleetPolicyRevisions, type FleetPolicyRevisionPeer, type FleetPolicyRevisionTransport } from './fleet-policy-revision.js';
// One process generation across all MCP connections and authenticated contexts.
let viewReads=0;
const processGeneration=Date.now()-Math.floor(process.uptime()*1000);
/** Attach to the existing local controller. No override, native activation, private writer or subprocess. */
export function registerFleetNodeTools(server:McpServer,deps:{adapters:Map<string,HarnessAdapter>;inventorySnapshot?:()=>LocalInventorySnapshot;readSupervisor?:Pick<SessionSupervisor,'getSession'|'getSessionDetails'>;integratorRuntime?:IntegratorFleetRuntime;ownerJournal?:Pick<FleetCreateJournal,'once'>;launchPolicy?:ProjectModelPolicyProvider;launchPolicyRevision?:()=>Promise<{kind:'valid'|'absent'|'invalid';appliedRevision:string}>;fleetTransport?:FleetPolicyRevisionTransport;fleetPeers?:readonly FleetPolicyRevisionPeer[];policyRevisionLedgerPath?:string}):void{
 const disarmRecordSchema=z.object({scope:z.string().min(1).max(4096),forbidden:z.boolean(),owner:z.string().max(200).optional(),reason:z.string().max(500).optional(),createdAt:z.string().max(64).optional(),policyRevision:z.string().max(128).optional(),workKeys:z.array(z.string().min(1).max(1024)).max(256).optional()}).strict();
 server.registerTool('automation_disarm',{description:'Hold or release the owner-level automation lever on this node. The state is durable on disk and survives a restart of the runtime. The caller must hold the owner token of this node (AGENT_HERDER_DISARM_TOKEN) and state an explicit owner action; a node without a configured token fails closed and never moves the lever. The records of the owner decision travel with the request and are the authority on this node; the flat lever and the flat list of works travel with them for a node of the earlier format. In read mode the node only reports the state it holds and changes nothing. The answer always names this node and the state it now holds, so a fleet answer can tell a confirmed node from an unreachable one.',inputSchema:z.object({mode:z.enum(['apply','read']).optional(),disarmed:z.boolean().optional(),workKeys:z.array(z.string().min(1).max(1024)).max(256).optional(),records:z.array(disarmRecordSchema).max(256).optional(),reason:z.string().max(500).optional(),decisionId:z.string().min(1).max(128).optional(),source:z.literal('owner').optional(),token:z.string().min(1).max(512).optional()}).strict()},async(request)=>{
  const refuse=(code:string,reason:string)=>{const refused={ok:false,hostId:hostname(),code,reason,decisionId:request.decisionId??null};return {structuredContent:refused,content:[{type:'text' as const,text:JSON.stringify(refused)}]};};
  // The secret proves who asks, the intent marker says what is asked. A node
  // without a configured token fails closed: it never moves the lever for a
  // caller it cannot authenticate.
  const expected=process.env.AGENT_HERDER_DISARM_TOKEN?.trim();
  if(!expected)return refuse('disarm_token_not_configured','AGENT_HERDER_DISARM_TOKEN is not configured on this node, so the lever was not moved.');
  if(!request.token||!sameSecret(request.token,expected))return refuse('unauthorized','The disarm token is missing or wrong, so the lever was not moved.');
  if(request.source!=='owner')return refuse('not_owner_action','The request is not an explicit owner action, so the lever was not moved.');
  const store=AutomationDisarmStore.forRuntime();
  // A read reports the state of this node and changes nothing at all.
  if(request.mode=='read'){
   const state=await store.read();
   const read={ok:true,hostId:hostname(),mode:'read',state:{...state,blockedWorkKeysHuman:humanWorkKeys(state.blockedWorkKeys)},summary:buildAutomationDisarmSummary({applied:true,disarmed:state.disarmed,nodes:[{hostId:hostname(),status:'confirmed'}]}),decisionId:request.decisionId??null};
   return {structuredContent:read,content:[{type:'text' as const,text:JSON.stringify(read)}]};
  }
  // The records of the decision are the authority here; the flat shape of the
  // earlier format is still accepted for a node that sends only that.
  const change=request.records?.length
   ?await store.replaceRecords({source:'owner',records:request.records as AutomationDisarmRecord[],...(request.reason?{reason:request.reason}:{})})
   :typeof request.disarmed==='boolean'
    ?await store.apply({source:'owner',disarmed:request.disarmed,...(request.workKeys===undefined?{}:{workKeys:request.workKeys}),...(request.reason?{reason:request.reason}:{})})
    :undefined;
  if(!change)return refuse('invalid_request','The request names neither the records of a decision nor a lever position, so the lever was not moved.');
  if(!change.ok)return refuse(change.code,change.reason);
  const payload={ok:true,hostId:hostname(),state:{...change.state,blockedWorkKeysHuman:humanWorkKeys(change.state.blockedWorkKeys)},summary:buildAutomationDisarmSummary({applied:true,disarmed:change.state.disarmed,nodes:[{hostId:hostname(),status:'confirmed'}]}),decisionId:request.decisionId??null};
  return {structuredContent:payload,content:[{type:'text' as const,text:JSON.stringify(payload)}]};
 });
 server.registerTool('fleet_policy_revisions',{description:'Read the applied revision of the policy of the launch on every node of the fleet. The version the owner saved is the desired one; every node is asked which version it holds right now, and the answer names the versions: a node that holds the wanted one is synchronized, a node that holds another one is diverged, and a node that did not answer is unconfirmed with the last confirmation that is known.',annotations:{readOnlyHint:true},inputSchema:z.object({}).strict()},async()=>{
  const refuse=(code:string,error:string)=>{const refused={ok:false,hostId:hostname(),code,error};return {structuredContent:refused,content:[{type:'text' as const,text:JSON.stringify(refused)}]};};
  if(!deps.launchPolicyRevision)return refuse('policy_revision_unavailable','The node does not read the policy of the launch, so it cannot name the version it holds.');
  const local=await deps.launchPolicyRevision();
  if(!deps.fleetTransport)return refuse('fleet_transport_unavailable','The node has no transport to the other nodes of the fleet.');
  const summary=await readFleetPolicyRevisions({
    transport:deps.fleetTransport,
    peers:deps.fleetPeers??[],
    desiredRevision:local.appliedRevision,
    local:{hostId:hostname(),answer:{kind:local.kind,appliedRevision:local.appliedRevision}},
    ledgerPath:deps.policyRevisionLedgerPath,
  });
  return {structuredContent:{...summary,hostId:hostname()},content:[{type:'text' as const,text:JSON.stringify(summary)}]};
 });
 server.registerTool('fleet_session_page',{description:'Read one page of the existing local session metadata snapshot, with native IDs, observation time and partial state. No history or native activation.',annotations:{readOnlyHint:true},inputSchema:z.object({cursor:z.string().max(2048).optional(),limit:z.number().int().min(1).max(100).default(100)}).strict()},async({cursor,limit})=>{
  const snapshot=deps.inventorySnapshot?.()??{sessions:[],warming:true,observedAt:null};
  const result=sessionInventoryPage(hostname(),snapshot,cursor,limit);
  return {structuredContent:{...result},content:[{type:'text' as const,text:'Session metadata page'}]};
 });

 server.registerTool('fleet_session_view',{description:'Read the latest three messages of one exact native session, on demand. Unavailable history is explicit; no activation or mutation.',annotations:{readOnlyHint:true},inputSchema:z.object({harness:z.enum(['codex','zcode','opencode','minimax-code']),sessionId:z.string().min(1).max(512).refine(s=>!/[\x00-\x1f\x7f]/.test(s))}).strict()},async({harness,sessionId})=>{
  const routed=await deps.integratorRuntime?.adapterForSession({hostId:hostname(),harness,nativeSessionId:sessionId});
  if(routed?.kind==='deny')throw new Error('fleet_session_scope_unavailable');
  const adapter:HarnessAdapter|undefined=routed?.kind==='scoped'?routed.adapter:deps.adapters.get(harness);if(!adapter||adapter.lazyStart&&!adapter.nativeReadWithoutActivation&&(!adapter.isReady||!adapter.isReady()))throw new Error('fleet_session_native_not_ready');
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
    const result={hostId:hostname(),details:{session:{id:sessionId,harness,title:session.title,cwd:session.cwd,model:session.model,status:session.status,needsPermission:session.needsPermission,permissionDetails:session.permissionDetails},historyUnavailable:routed?.kind==='scoped'?scopedMessages==null:!details||details.history.source==='unavailable',messages:(routed?.kind==='scoped'?scopedMessages??[]:details?.messages??[]).slice(-3).map(m=>({role:m.role,text:m.text}))}};
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
  const snapshot={hostId:hostname(),nativeUser:userInfo().username,platform:platform(),generation,createHarnesses:fleetHarnesses.filter(h=>typeof deps.adapters.get(h)?.createSession==='function'),...(deps.launchPolicyRevision?{launchPolicy:await deps.launchPolicyRevision()}:{})};
  if(project===undefined)return {structuredContent:snapshot,content:[{type:'text' as const,text:JSON.stringify(snapshot)}]};
  const readiness=deps.integratorRuntime?await deps.integratorRuntime.readiness(project):undefined;
  const result={...snapshot,projectReadinessContract:'integrator-host-readiness-v1',projectReadiness:readiness??{state:'not_ready',projectId:project,reason:'project_scoped_runtime_unavailable'}};
  return {structuredContent:result,content:[{type:'text' as const,text:JSON.stringify(result)}]};
 });
}
