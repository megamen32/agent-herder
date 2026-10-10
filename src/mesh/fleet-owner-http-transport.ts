import {request as httpsRequest,type RequestOptions} from 'node:https';
import type {ClientRequest,IncomingMessage,IncomingHttpHeaders} from 'node:http';
import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import {unwrapResult} from './protocol.js';
import type {GptAdminTransport} from './gptadmin.js';

export type FleetOwnerHttpContext=Readonly<{cookie:string;credentialGeneration:string}>;
export interface FleetOwnerHttpOptions {ownerContext:()=>FleetOwnerHttpContext|undefined}
type RequestBoundary=(options:RequestOptions,callback:(response:IncomingMessage)=>void)=>ClientRequest;
type Peer=Readonly<{hostId:string;alias:string;nativeUser:string}>;
// Shared registry is unchanged. These are only the existing approved ingress routes.
const peers:readonly Peer[]=Object.freeze([
 {hostId:'roomhacker-server-100',alias:'agent.bezrabotnyi.com',nativeUser:'roomhacker'},
 {hostId:'server-44',alias:'agent44.bezrabotnyi.com',nativeUser:'roomhacker'},
 {hostId:'roomhacker-server-88',alias:'agent88.bezrabotnyi.com',nativeUser:'roomhacker'},
 {hostId:'mac-mini-2012.lan',alias:'agent-mac-mini.bezrabotnyi.com',nativeUser:'roomhacker'},
 {hostId:'MacBook-Pro-User.local',alias:'agent-mac-m1.bezrabotnyi.com',nativeUser:'user'},
]);
type Connection={context:FleetOwnerHttpContext;peer:Peer;initialized:boolean;initializing?:Promise<void>;sessionId?:string;inflight:number;used:number};
type HttpResult={status:number;headers:IncomingHttpHeaders;data?:unknown};
const record=(value:unknown):Record<string,any>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:undefined;

/** Cookie authority is supplied only by the owner's verified HTTP request scope.
 * No credentials, journaling, roles, SSH routes or mutation retries are created here.
 */
export class FleetOwnerHttpTransport implements GptAdminTransport {
 private readonly connections=new Map<string,Map<string,Connection>>();
 private inflight=0;private sequence=0;
 private readonly mobileActor=hostname()==='MacBook-Pro-User.local';
 constructor(private readonly options:FleetOwnerHttpOptions,private readonly request:RequestBoundary=httpsRequest){}
 private context():FleetOwnerHttpContext {
  const supplied=this.options.ownerContext();
  if(!supplied)throw new Error('owner_http_context_missing');
  const {cookie,credentialGeneration}=supplied;
  if(typeof cookie!=='string'||!cookie||Buffer.byteLength(cookie)>16384||/[\r\n]/.test(cookie)
   ||typeof credentialGeneration!=='string'||!credentialGeneration||credentialGeneration.length>512||/[\x00-\x1f\x7f]/.test(credentialGeneration))throw new Error('owner_http_context_invalid');
  return Object.freeze({cookie,credentialGeneration});
 }
 private peer(target:string):Peer {
  const peer=peers.find(p=>target===`mcp:shell:${p.hostId}:AgentHerder`);
  if(!peer)throw new Error('owner_http_target_not_authorized');return peer;
 }
 private lease(peer:Peer,context:FleetOwnerHttpContext):Connection {
  let generations=this.connections.get(peer.hostId);
  if(!generations){generations=new Map();this.connections.set(peer.hostId,generations);}
  let state=generations.get(context.credentialGeneration);
  if(state&&state.context.cookie!==context.cookie)throw new Error('owner_http_generation_mismatch');
  if(!state){
   if(generations.size>=2){
    const idle=[...generations.values()].filter(s=>s.inflight===0&&!s.initializing).sort((a,b)=>a.used-b.used)[0];
    if(!idle)throw new Error('owner_http_generation_capacity');generations.delete(idle.context.credentialGeneration);
   }
   state={peer,context,initialized:false,inflight:0,used:0};generations.set(context.credentialGeneration,state);
  }
  if(this.inflight>=8||[...generations.values()].reduce((n,s)=>n+s.inflight,0)>=3)throw new Error('owner_http_inflight_capacity');
  this.inflight++;state.inflight++;state.used=++this.sequence;return state;
 }
 private async operation<T>(target:string,timeout:number,run:(state:Connection,signal:AbortSignal)=>Promise<T>):Promise<T>{
  // Capture before the first await; a later request must never select this cookie.
  const context=this.context(),state=this.lease(this.peer(target),context);
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeout);
  try{return await run(state,controller.signal);}finally{clearTimeout(timer);state.inflight--;this.inflight--;}
 }
 private http(state:Connection,signal:AbortSignal,method:'GET'|'POST',path:string,payload?:string,id?:string):Promise<HttpResult>{
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
   let req:ClientRequest|undefined,res:IncomingMessage|undefined,finished=false,length=0;
   const chunks:Buffer[]=[];
   const finish=(error?:Error,data?:unknown)=>{
    if(finished)return;finished=true;signal.removeEventListener('abort',abort);
    res?.destroy();req?.destroy();error?reject(error):resolve({status:res!.statusCode??0,headers:res!.headers,data});
   };
   const abort=()=>finish(new Error('owner_http_deadline'));
   signal.addEventListener('abort',abort,{once:true});
   try{
    // Fixed mobile host/actor only: use existing public ingress and reverse SSH.
    // Route selection precedes the operation; failed mutations are never retried.
    const mobile=this.mobileActor||state.peer.hostId==='MacBook-Pro-User.local';
    req=this.request({hostname:state.peer.alias,port:mobile?443:8443,servername:state.peer.alias,rejectUnauthorized:true,agent:false,method,path,
     headers:{Host:state.peer.alias,Origin:`https://${state.peer.alias}`,Cookie:state.context.cookie,
      Accept:'application/json, text/event-stream',...(method==='POST'?{'Content-Type':'application/json','MCP-Protocol-Version':'2025-11-25',...(state.sessionId?{'Mcp-Session-Id':state.sessionId}:{})}:{} )},
     ...(mobile?{}:{lookup:(_hostname,options,callback)=>{queueMicrotask(()=>{if(options.all)callback(null,[{address:'192.168.2.101',family:4}]);else callback(null,'192.168.2.101',4);});}} as Pick<RequestOptions,'lookup'>),
    },message=>{
     message.on('error',()=>finish(new Error('owner_http_response_failed')));
     if(finished){message.destroy();return;}res=message;
     message.once('aborted',()=>finish(new Error('owner_http_response_failed')));
     message.once('close',()=>finish(new Error('owner_http_response_incomplete')));
     if((message.statusCode??0)<200||(message.statusCode??0)>=300){finish();return;}
     const sse=message.headers['content-type']?.includes('text/event-stream');
     message.on('data',(data:Buffer|string)=>{
      if(finished)return;const chunk=Buffer.isBuffer(data)?data:Buffer.from(data);length+=chunk.length;
      if(length>1048576){finish(new Error('owner_http_response_limit'));return;}chunks.push(chunk);
      if(sse&&id){const envelope=ownEnvelope(Buffer.concat(chunks).toString('utf8'),id);if(envelope)finish(undefined,envelope);}
     });
     message.once('end',()=>{
      if(finished)return;if(!message.complete){finish(new Error('owner_http_response_incomplete'));return;}
      if(sse&&id){finish(new Error('owner_http_missing_rpc_response'));return;}
      try{finish(undefined,length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{});}catch{finish(new Error('owner_http_response_invalid'));}
     });
    });
    req.on('error',()=>finish(new Error('owner_http_request_failed')));
    req.once('close',()=>{if(!res?.complete)finish(new Error('owner_http_response_incomplete'));});
    if(finished)req.destroy();else req.end(payload);
   }catch{finish(new Error('owner_http_request_failed'));}
  });
 }
 private async rpc(state:Connection,signal:AbortSignal,method:string,params:unknown):Promise<Record<string,any>>{
  const notify=method.startsWith('notifications/'),id=notify?undefined:randomUUID();
  const payload=JSON.stringify({jsonrpc:'2.0',...(id?{id}:{}),method,params});
  if(Buffer.byteLength(payload)>16384)throw new Error('owner_http_request_limit');
  const response=await this.http(state,signal,'POST','/mcp',payload,id);
  if(response.status<200||response.status>=300){
   if([401,404].includes(response.status)){state.initialized=false;state.sessionId=undefined;}
   throw new Error('owner_http_http_'+response.status);
  }
  if(notify)return {};
  const envelope=record(response.data);
  if(!envelope||envelope.id!==id)throw new Error('owner_http_rpc_identity_mismatch');
  if(envelope.error||!record(envelope.result))throw new Error('owner_http_rpc_failed');
  if(envelope.result.isError===true)throw new Error('owner_http_tool_failed');
  if(method==='initialize'){
   if(envelope.result.protocolVersion!=='2025-11-25')throw new Error('owner_http_protocol_unavailable');
   const session=response.headers['mcp-session-id'];
   if(session!==undefined&&(typeof session!=='string'||!session||session.length>512||/[\x00-\x1f\x7f]/.test(session)))throw new Error('owner_http_session_invalid');
   state.sessionId=session;
  }
  return envelope.result;
 }
 private async connect(state:Connection,signal:AbortSignal):Promise<void>{
  if(state.initializing)return waitFor(state.initializing,signal);
  if(state.initialized)return;
  state.initializing=this.rpc(state,signal,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'herder-fleet-owner-http',version:'1'}})
   .then(async()=>{await this.rpc(state,signal,'notifications/initialized',{});state.initialized=true;})
   .catch(error=>{state.initialized=false;state.sessionId=undefined;throw error;}).finally(()=>{state.initializing=undefined;});
  return state.initializing;
 }
 private async info(state:Connection,signal:AbortSignal):Promise<Record<string,any>>{
  const result=await this.rpc(state,signal,'tools/call',{name:'fleet_node_info',arguments:{}}),info=unwrapResult(result);
  if(info.hostId!==state.peer.hostId||info.nativeUser!==state.peer.nativeUser)throw new Error('owner_http_native_identity_mismatch');return result;
 }
 async discover():Promise<unknown>{
  this.context();return {servers:peers.flatMap(p=>[{server_id:`shell:${p.hostId}`,kind:'virtual_shell',status:'configured'},
   {server_id:`mcp:shell:${p.hostId}:AgentHerder`,kind:'child_mcp',status:'configured'}])};
 }
 schema(target:string):Promise<unknown>{return this.operation(target,10000,async(state,signal)=>{await this.connect(state,signal);await this.info(state,signal);return this.rpc(state,signal,'tools/list',{});});}
 call(target:string,tool:string,args:Record<string,unknown>,idempotencyKey?:string):Promise<unknown>{
  if(!['fleet_node_info','mesh_snapshot','create_session'].includes(tool))return Promise.reject(new Error('owner_http_tool_not_authorized'));
  if(tool==='create_session'&&(!idempotencyKey||!/^[a-f0-9]{64}$/.test(idempotencyKey)))return Promise.reject(new Error('owner_http_create_identity_missing'));
  // Flat native tool args are frozen as a serialized snapshot before any handshake.
  let captured:Record<string,unknown>;
  try{const text=JSON.stringify(args);if(Buffer.byteLength(text)>12000||!record(args))throw new Error();captured=JSON.parse(text);}catch{return Promise.reject(new Error('owner_http_arguments_invalid'));}
  return this.operation(target,tool==='create_session'?30000:10000,async(state,signal)=>{
   await this.connect(state,signal);if(tool==='fleet_node_info')return this.info(state,signal);
   if(tool==='create_session')await this.info(state,signal);
   const result=await this.rpc(state,signal,'tools/call',{name:tool==='create_session'?'fleet_create_session':tool,arguments:tool==='create_session'?{...captured,inputId:idempotencyKey}:captured});
   if(tool==='mesh_snapshot'&&unwrapResult(result).hostId!==state.peer.hostId)throw new Error('owner_http_native_identity_mismatch');return result;
  });
 }
 readSession(target:string,harness:string,sessionId:string):Promise<unknown>{
  if(!['codex','zcode','opencode'].includes(harness)||typeof sessionId!=='string'||!sessionId||sessionId.length>512||/[\x00-\x1f\x7f]/.test(sessionId))return Promise.reject(new Error('owner_http_session_invalid'));
  return this.operation(target,10000,async(state,signal)=>{
   await this.connect(state,signal);await this.info(state,signal);
   const path=`/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(sessionId)}`;
   let response=await this.http(state,signal,'GET',path+'/details?limit=3&quick=1');const unavailable=response.status===502;
   if(unavailable)response=await this.http(state,signal,'GET',path);
   if(response.status!==200)throw new Error('owner_http_http_'+response.status);
   const details=record(response.data),session=record(details?.session);
   if(session?.id!==sessionId||session.harness!==harness)throw new Error('owner_http_session_identity_mismatch');
   return {hostId:state.peer.hostId,details:{...details,...(unavailable?{history:{source:'unavailable',complete:false}}:{}),
    ...(unavailable||details?.history?.source==='unavailable'?{historyUnavailable:true}:{})}};
  });
 }
}

async function waitFor<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted)throw new Error('owner_http_deadline');let abort=()=>{};
 try{return await Promise.race([promise,new Promise<never>((_,reject)=>{abort=()=>reject(new Error('owner_http_deadline'));signal.addEventListener('abort',abort,{once:true});})]);}finally{signal.removeEventListener('abort',abort);}
}
function ownEnvelope(text:string,id:string):Record<string,any>|undefined {
 const frames=text.split(/\r?\n\r?\n/);frames.pop();
 for(const frame of frames){const body=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
  try{const envelope=record(JSON.parse(body));if(envelope?.id===id)return envelope;}catch{/* Ignore notifications/partial frames, bounded by response cap. */}}
 return undefined;
}
