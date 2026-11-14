import {assertRemoteCodexAdmission} from "../codex-quota-guard.js";
import {randomUUID} from 'node:crypto';
import {unwrapResult} from './protocol.js';
import type {GptAdminTransport} from './gptadmin.js';
export interface FleetFacadeOptions {
 endpoint:string;
 /** Bound by integration to one verified client/profile/user/host/credential generation; secrets stay in memory. */
 headersProvider:()=>Promise<Record<string,string>>|Record<string,string>;
 fetch?:typeof fetch;readDeadlineMs?:number;createDeadlineMs?:number;
 /** An exact authority may preserve typed domain payloads containing a result field. */
 unwrapResponse?:(value:unknown)=>Record<string,unknown>;
 /** Trusted native protocol composition. Its exact target uses recipient AHAP admission guards. */
 nativeHerderAuthority?:string;
}
/** Existing tenant GPTAdmin facade only. No admin API, token mint, registry or mutation retries. */
export class FleetGptAdminTransport implements GptAdminTransport {
 private initialized=false;private initializing?:Promise<void>;private sessionId?:string;
 private readonly endpoint:URL;private readonly fetcher:typeof fetch;
 private readonly nativeHerderAuthority?:string;
 constructor(private readonly options:FleetFacadeOptions){this.endpoint=new URL(options.endpoint);if(!['http:','https:'].includes(this.endpoint.protocol)||this.endpoint.username||this.endpoint.password||this.endpoint.hash)throw new Error('Invalid GPTAdmin facade endpoint');this.fetcher=options.fetch??fetch;
  if(options.nativeHerderAuthority!==undefined&&!/^mcp:shell:[A-Za-z0-9._-]+:AgentHerder$/.test(options.nativeHerderAuthority))throw new Error('native_herder_authority_invalid');
  this.nativeHerderAuthority=options.nativeHerderAuthority;
 }
 private async rpc(method:string,params:unknown,deadline:number):Promise<Record<string,unknown>>{
  const controller=new AbortController(),remaining=deadline-Date.now();if(remaining<=0)throw new Error('gptadmin_deadline');
  const timer=setTimeout(()=>controller.abort(),remaining);
  const id=randomUUID();
  try{
   const protectedHeaders=await abortable(Promise.resolve(this.options.headersProvider()),controller.signal);
   controller.signal.throwIfAborted();
   const response=await this.fetcher(this.endpoint,{method:'POST',redirect:'error',signal:controller.signal,headers:{...protectedHeaders,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25',...(this.sessionId?{'Mcp-Session-Id':this.sessionId}:{})},body:JSON.stringify({jsonrpc:'2.0',...(method.startsWith('notifications/')?{}:{id}),method,params})});
   if(!response.ok){if([401,404].includes(response.status)){this.initialized=false;this.sessionId=undefined;}throw new Error('gptadmin_http_'+response.status);}
   if(method.startsWith('notifications/')){await response.body?.cancel();return {};}
   const reader=response.body?.getReader();if(!reader)throw new Error('gptadmin_empty_response');
   const chunks:Uint8Array[]=[];let length=0;let sseEnvelope:Record<string,unknown>|undefined;const sse=response.headers.get('content-type')?.includes('text/event-stream');
   try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>1048576)throw new Error('gptadmin_response_limit');chunks.push(value);if(sse){sseEnvelope=ownSseEnvelope(Buffer.concat(chunks).toString('utf8'),id);if(sseEnvelope)break;}}}finally{await reader.cancel().catch(()=>{});}
   const text=Buffer.concat(chunks).toString('utf8');let envelope:Record<string,unknown>;
   if(sse){if(!sseEnvelope)throw new Error('gptadmin_missing_rpc_response');envelope=sseEnvelope;}else envelope=JSON.parse(text);
   if(envelope.id!==id)throw new Error('gptadmin_rpc_identity_mismatch');
   if(envelope.error||!envelope.result||typeof envelope.result!=='object')throw new Error('gptadmin_rpc_failed');
   if(method==='initialize')this.sessionId=response.headers.get('mcp-session-id')??undefined;
   return envelope.result as Record<string,unknown>;
  }catch(error){if(controller.signal.aborted)throw new Error('gptadmin_deadline');throw error;}finally{clearTimeout(timer);}
 }
 private async connect(deadline:number):Promise<void>{
  // initializing first: an open connection is not an initialized MCP session.
  if(this.initializing){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),Math.max(1,deadline-Date.now()));try{return await abortable(this.initializing,controller.signal);}finally{clearTimeout(timer);}}if(this.initialized)return;
  this.initializing=this.rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'agent-herder-fleet',version:'1'}},deadline).then(async()=>{await this.rpc('notifications/initialized',{},deadline);this.initialized=true;}).catch(error=>{this.initialized=false;this.sessionId=undefined;throw error;}).finally(()=>{this.initializing=undefined;});return this.initializing;
 }
 private async facade(tool:string,args:Record<string,unknown>,deadline:number):Promise<Record<string,unknown>>{
  const unwrap=this.options.unwrapResponse??unwrapResult;
  await this.connect(deadline);let result=unwrap(await this.rpc('tools/call',{name:tool,arguments:args},deadline));
  // The facade's async job is observed, never resubmitted. Owner target comes from this exact receipt.
  for(let reads=0;reads<32&&['queued','running','waiting','pending'].includes(String(result.status));reads++){
   const id=result.job_id??result.id;if(typeof id!=='string')throw new Error('gptadmin_job_identity_missing');
   if(Date.now()+100>=deadline)throw new Error('gptadmin_job_incomplete');
   await new Promise(resolve=>setTimeout(resolve,Math.max(100,Math.min(1000,Math.floor((deadline-Date.now())/(32-reads))))));
   result=unwrap(await this.rpc('tools/call',{name:'job',arguments:{id,...(typeof result.owner_target==='string'?{owner_target:result.owner_target}:{}),detail:'full'}},deadline));
  }
  if(['queued','running','waiting','pending'].includes(String(result.status)))throw new Error('gptadmin_job_read_limit');
  return result;
 }
 discover():Promise<unknown>{return this.facade('discover',{detail:'full'},Date.now()+(this.options.readDeadlineMs??10000));}
 async readSession(target:string,harness:string,sessionId:string):Promise<unknown>{
  const hostId=target.match(/^mcp:shell:([^:]+):AgentHerder$/)?.[1];if(!hostId||!['codex','zcode','opencode'].includes(harness)||!sessionId||sessionId.length>512||/[\x00-\x1f\x7f]/.test(sessionId))throw new Error('fleet_session_invalid');
  const info=unwrapResult(await this.call(target,'fleet_node_info',{}));if(info.hostId!==hostId)throw new Error('native_owner_identity_mismatch');
  const result=unwrapResult(await this.call(target,'agent_info',{sessionId,harness}));const session=result.session as Record<string,any>|undefined|null;
  if(!session)throw new Error('fleet_session_not_found');
  if(session.hostId!==hostId)throw new Error('native_owner_identity_mismatch');
  if(session.id!==sessionId||session.harness!==harness)throw new Error('fleet_session_identity_mismatch');return result;
 }
 readSessionPage(target:string,cursor?:string,limit=100):Promise<unknown>{return this.call(target,'fleet_session_page',{limit,...(cursor?{cursor}:{})});}
 schema(target:string):Promise<unknown>{return this.facade('schema',{target,detail:'full'},Date.now()+(this.options.readDeadlineMs??10000));}
 async call(target:string,tool:string,args:Record<string,unknown>,idempotencyKey?:string):Promise<unknown>{
  if(idempotencyKey&&idempotencyKey.length>200)throw new Error('gptadmin_idempotency_key_too_long');
  if(this.nativeHerderAuthority!==undefined){
   if(target!==this.nativeHerderAuthority)throw new Error('native_herder_authority_mismatch');
   assertNativeHerderCall(tool,args);
   // Native Codex AHAP enforces its recipient quota immediately before each
   // consuming write. The legacy model_quotas facade is not a native MCP tool.
  }else await assertRemoteCodexAdmission(tool,args,()=>this.call(target,"model_quotas",{}));
  // The hub retired its direct execute facade for programmatic callers: the
  // native tool DTO is reached through the exec sandbox's mcp.call bridge,
  // and mutation idempotency stays with the native inputId admission.
  const deadline=Date.now()+(tool==='create_session'?this.options.createDeadlineMs??30000:this.options.readDeadlineMs??10000);
  const code=`return await mcp.call(${JSON.stringify(target)},${JSON.stringify(tool)},${JSON.stringify(args)});`;
  return this.facade('exec',{code,timeout_ms:Math.min(60000,Math.max(1,deadline-Date.now())),max_output_bytes:65536},deadline);
 }
}

/** A native transport cannot become a legacy delivery escape hatch through extra fields. */
function assertNativeHerderCall(tool:string,args:Record<string,unknown>):void{
 const exact=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=4096&&value.trim()===value&&!/[\x00-\x1f\x7f]/.test(value);
 const keys=(required:string[],optional:string[]=[]):boolean=>required.every(key=>Object.hasOwn(args,key))&&Object.keys(args).every(key=>required.includes(key)||optional.includes(key));
 const revision=()=>Number.isSafeInteger(args.revision)&&Number(args.revision)>0;
 let valid=false;
 if(tool==='session'&&args.action==='resolve')valid=keys(['action','harness','native_session_id'],['node_ref'])&&exact(args.harness)&&exact(args.native_session_id)&&(args.node_ref===undefined||exact(args.node_ref));
 if(tool==='deliver'&&args.action==='receipt')valid=keys(['action','session_ref','request_key'])&&exact(args.session_ref)&&exact(args.request_key);
 if(tool==='deliver'&&args.action==='session')valid=keys(['action','session_ref','request_key','message','mode'])&&exact(args.session_ref)&&exact(args.request_key)&&typeof args.message==='string'&&args.message.length>0&&args.message.length<=1024*1024&&['queue','start'].includes(String(args.mode));
 if(tool==='compat_task'&&args.action==='get')valid=keys(['action','task_ref'])&&exact(args.task_ref);
 if(tool==='automation'){
  if(args.action==='list')valid=keys(['action']);
  if(args.action==='get')valid=keys(['action','rule_ref'])&&exact(args.rule_ref);
  if(args.action==='delete'||args.action==='pause')valid=keys(['action','rule_ref','revision'])&&exact(args.rule_ref)&&revision();
  if(args.action==='wait_status')valid=keys(['action','harness','native_session_id'],['node_ref'])&&exact(args.harness)&&exact(args.native_session_id)&&(args.node_ref===undefined||exact(args.node_ref));
  if(args.action==='create'){
   const rule=args.rule&&typeof args.rule==='object'&&!Array.isArray(args.rule)?args.rule as Record<string,unknown>:undefined;
   valid=keys(['action','session_ref','request_key','rule'])&&exact(args.session_ref)&&exact(args.request_key)&&!!rule&&['timer','session_completion'].includes(String(rule.kind));
  }
 }
 if(!valid)throw new Error('native_herder_call_not_allowed');
}

async function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
 signal.throwIfAborted();let cancel:()=>void=()=>{};
 try{return await Promise.race([promise,new Promise<never>((_,reject)=>{cancel=()=>reject(new Error('gptadmin_deadline'));signal.addEventListener('abort',cancel,{once:true});})]);}finally{signal.removeEventListener('abort',cancel);}
}
function ownSseEnvelope(text:string,id:string):Record<string,unknown>|undefined{
 const frames=text.split(/\r?\n\r?\n/);frames.pop();
 for(const frame of frames){const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');try{const value=JSON.parse(data);if(value.id===id&&(value.result||value.error))return value;}catch{/* Wait for a complete own JSON-RPC frame. */}}return undefined;
}
