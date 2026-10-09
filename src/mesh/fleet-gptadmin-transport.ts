import {randomUUID} from 'node:crypto';
import {unwrapResult} from './protocol.js';
import type {GptAdminTransport} from './gptadmin.js';
export interface FleetFacadeOptions {
 endpoint:string;
 /** Bound by integration to one verified client/profile/user/host/credential generation; secrets stay in memory. */
 headersProvider:()=>Promise<Record<string,string>>|Record<string,string>;
 fetch?:typeof fetch;readDeadlineMs?:number;createDeadlineMs?:number;
}
/** Existing tenant GPTAdmin facade only. No admin API, token mint, registry or mutation retries. */
export class FleetGptAdminTransport implements GptAdminTransport {
 private initialized=false;private initializing?:Promise<void>;private sessionId?:string;
 private readonly endpoint:URL;private readonly fetcher:typeof fetch;
 constructor(private readonly options:FleetFacadeOptions){this.endpoint=new URL(options.endpoint);if(!['http:','https:'].includes(this.endpoint.protocol)||this.endpoint.username||this.endpoint.password||this.endpoint.hash)throw new Error('Invalid GPTAdmin facade endpoint');this.fetcher=options.fetch??fetch;}
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
  }finally{clearTimeout(timer);}
 }
 private async connect(deadline:number):Promise<void>{
  // initializing first: an open connection is not an initialized MCP session.
  if(this.initializing){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),Math.max(1,deadline-Date.now()));try{return await abortable(this.initializing,controller.signal);}finally{clearTimeout(timer);}}if(this.initialized)return;
  this.initializing=this.rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'agent-herder-fleet',version:'1'}},deadline).then(async()=>{await this.rpc('notifications/initialized',{},deadline);this.initialized=true;}).catch(error=>{this.initialized=false;this.sessionId=undefined;throw error;}).finally(()=>{this.initializing=undefined;});return this.initializing;
 }
 private async facade(tool:string,args:Record<string,unknown>,deadline:number):Promise<Record<string,unknown>>{
  await this.connect(deadline);let result=unwrapResult(await this.rpc('tools/call',{name:tool,arguments:args},deadline));
  // The facade's async job is observed, never resubmitted. Owner target comes from this exact receipt.
  for(let reads=0;reads<32&&['queued','running','waiting','pending'].includes(String(result.status));reads++){
   const id=result.job_id??result.id;if(typeof id!=='string')throw new Error('gptadmin_job_identity_missing');
   if(Date.now()+100>=deadline)throw new Error('gptadmin_job_incomplete');
   await new Promise(resolve=>setTimeout(resolve,Math.max(100,Math.min(1000,Math.floor((deadline-Date.now())/(32-reads))))));
   result=unwrapResult(await this.rpc('tools/call',{name:'job',arguments:{id,...(typeof result.owner_target==='string'?{owner_target:result.owner_target}:{}),detail:'full'}},deadline));
  }
  if(['queued','running','waiting','pending'].includes(String(result.status)))throw new Error('gptadmin_job_read_limit');
  return result;
 }
 discover():Promise<unknown>{return this.facade('discover',{detail:'full'},Date.now()+(this.options.readDeadlineMs??3000));}
 schema(target:string):Promise<unknown>{return this.facade('schema',{target},Date.now()+(this.options.readDeadlineMs??3000));}
 call(target:string,tool:string,args:Record<string,unknown>,idempotencyKey?:string):Promise<unknown>{
  if(idempotencyKey&&idempotencyKey.length>200)throw new Error('gptadmin_idempotency_key_too_long');
  return this.facade('execute',{target,tool,args,...(idempotencyKey?{idempotency_key:idempotencyKey}:{}),detail:'compact'},Date.now()+(tool==='create_session'?this.options.createDeadlineMs??30000:this.options.readDeadlineMs??3000));
 }
}

async function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
 signal.throwIfAborted();let cancel:()=>void=()=>{};
 try{return await Promise.race([promise,new Promise<never>((_,reject)=>{cancel=()=>reject(new Error('gptadmin_deadline'));signal.addEventListener('abort',cancel,{once:true});})]);}finally{signal.removeEventListener('abort',cancel);}
}
function ownSseEnvelope(text:string,id:string):Record<string,unknown>|undefined{
 const frames=text.split(/\r?\n\r?\n/);frames.pop();
 for(const frame of frames){const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');try{const value=JSON.parse(data);if(value.id===id&&(value.result||value.error))return value;}catch{/* Wait for a complete own JSON-RPC frame. */}}return undefined;
}
