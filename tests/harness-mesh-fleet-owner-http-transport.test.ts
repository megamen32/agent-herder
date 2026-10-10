import {EventEmitter} from 'node:events';
import type {ClientRequest,IncomingMessage} from 'node:http';
import type {RequestOptions} from 'node:https';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {FleetOwnerHttpTransport} from '../src/mesh/fleet-owner-http-transport.js';

const target44='mcp:shell:server-44:AgentHerder',target88='mcp:shell:roomhacker-server-88:AgentHerder';
type Context={cookie:string;credentialGeneration:string};
function fixture(){
 let context:Context|undefined={cookie:'session=owner-a',credentialGeneration:'a'};
 const calls:Array<{options:RequestOptions;body?:any;req:any;res?:any}>=[];
 let handler=(call:typeof calls[number]):unknown=>{
  const body=call.body;
  if(call.options.method==='GET')return {session:{id:'accepted-44',harness:'codex'},history:{source:'unavailable',complete:false},messages:[]};
  if(body.method==='initialize')return {protocolVersion:'2025-11-25',capabilities:{},serverInfo:{name:'Herder',version:'1'}};
  if(body.method==='tools/list')return {tools:[{name:'create_session'}]};
  const host=String((call.options.headers as any).Host)==='agent88.bezrabotnyi.com'?'roomhacker-server-88':'server-44';
  if(body.params?.name==='fleet_node_info')return {content:[{type:'text',text:JSON.stringify({hostId:host,nativeUser:'roomhacker'})}]};
  if(body.params?.name==='mesh_snapshot')return {structuredContent:{hostId:host,sessions:[]}};
  return {structuredContent:{state:'unknown'}};
 };
 const respond=(call:typeof calls[number],data:unknown,status=200,headers:Record<string,unknown>={})=>{
  const res=Object.assign(new EventEmitter(),{statusCode:status,headers:{'content-type':'application/json',...headers},complete:false,destroy:vi.fn()});
  call.res=res;(call as any).callback(res);
  if(!res.destroy.mock.calls.length){if(data!==undefined)res.emit('data',Buffer.from(JSON.stringify(data)));res.complete=true;res.emit('end');}
  return res;
 };
 let held=false;
 const request=vi.fn((options:RequestOptions,cb:(res:IncomingMessage)=>void)=>{
  const call:any={options,callback:cb};
  call.req=Object.assign(new EventEmitter(),{destroy:vi.fn(),end:vi.fn((body?:string)=>{
   call.body=body?JSON.parse(body):undefined;
   if(!held)queueMicrotask(()=>{
    if(call.body?.method==='notifications/initialized')return void respond(call,undefined,202);
    const result=handler(call);
    const data=call.body?{jsonrpc:'2.0',id:call.body.id,result}:result;
    respond(call,data,200,call.body?.method==='initialize'?{'mcp-session-id':String((options.headers as any).Host)+':'+String((options.headers as any).Cookie)}:{});
   });
  })});calls.push(call);return call.req as ClientRequest;
 });
 const transport=new FleetOwnerHttpTransport({ownerContext:()=>context},request);
 return {transport,calls,request,respond,setContext:(c:Context|undefined)=>{context=c;},setHandler:(h:typeof handler)=>{handler=h;},hold:()=>{held=true;},release:()=>{held=false;}};
}
afterEach(()=>vi.useRealTimers());
describe('owner cookie native HTTP transport (fast unit; expected2s/max25s)',()=>{
 it('uses only approved TLS aliases/physicalHAOS and required own Origin, with no bearer/pooled socket',async()=>{
  const f=fixture();expect(await f.transport.schema(target44)).toEqual({tools:[{name:'create_session'}]});
  const first=f.calls[0].options;
  expect(first).toMatchObject({hostname:'agent44.bezrabotnyi.com',port:8443,servername:'agent44.bezrabotnyi.com',rejectUnauthorized:true,agent:false,path:'/mcp',method:'POST'});
  expect(first.headers).toMatchObject({Host:'agent44.bezrabotnyi.com',Origin:'https://agent44.bezrabotnyi.com',Cookie:'session=owner-a'});
  expect(first.headers).not.toHaveProperty('Authorization');
  const cb=vi.fn();(first.lookup as Function)('agent44.bezrabotnyi.com',{},cb);expect(cb).not.toHaveBeenCalled();await Promise.resolve();expect(cb).toHaveBeenCalledWith(null,'192.168.2.101',4);
  expect(f.calls.every(c=>c.req.destroy.mock.calls.length===1&&c.res.destroy.mock.calls.length===1)).toBe(true);
  const discovery:any=await f.transport.discover();expect(discovery.servers).toHaveLength(10);expect(discovery.servers.every((s:any)=>s.status==='configured')).toBe(true);
 });
 it('captures cookie before await and isolates sessions by generation and host',async()=>{
  const f=fixture();const first=f.transport.schema(target44);
  f.setContext({cookie:'session=owner-b',credentialGeneration:'b'});
  await Promise.all([first,f.transport.schema(target44),f.transport.schema(target88)]);
  const init=f.calls.filter(c=>c.body?.method==='initialize');expect(init).toHaveLength(3);
  const ids=f.calls.filter(c=>c.body?.id).map(c=>c.body.id);expect(new Set(ids).size).toBe(ids.length);
  for(const c of f.calls.filter(c=>c.body?.method==='tools/list')){
   const headers=c.options.headers as any;expect(headers['Mcp-Session-Id']).toBe(headers.Host+':'+headers.Cookie);
  }
  const sameGeneration=f.transport.schema(target44);await sameGeneration;
  expect(f.calls.filter(c=>c.body?.method==='initialize')).toHaveLength(3);
 });
 it('rejects undefined/malformed context and unknown target before network',async()=>{
  const f=fixture();f.setContext(undefined);await expect(f.transport.schema(target44)).rejects.toThrow('owner_http_context_missing');
  f.setContext({cookie:'x\r\nforged: yes',credentialGeneration:'a'});await expect(f.transport.schema(target44)).rejects.toThrow('owner_http_context_invalid');
  f.setContext({cookie:'x'.repeat(16385),credentialGeneration:'a'});await expect(f.transport.schema(target44)).rejects.toThrow('owner_http_context_invalid');
  f.setContext({cookie:'x',credentialGeneration:'a'});await expect(f.transport.schema('mcp:shell:foreign:AgentHerder')).rejects.toThrow('owner_http_target_not_authorized');
  expect(f.calls).toHaveLength(0);
 });
 it('rejects reused generation with changed cookie and evicts only idle old generations',async()=>{
  const f=fixture();await f.transport.schema(target44);
  f.setContext({cookie:'other',credentialGeneration:'a'});await expect(f.transport.schema(target44)).rejects.toThrow('owner_http_generation_mismatch');
  f.setContext({cookie:'b',credentialGeneration:'b'});await f.transport.schema(target44);
  f.setContext({cookie:'c',credentialGeneration:'c'});await f.transport.schema(target44);
  f.setContext({cookie:'session=owner-a',credentialGeneration:'a'});await f.transport.schema(target44);
  expect(f.calls.filter(c=>c.body?.method==='initialize')).toHaveLength(4);
 });
 it('bounds active generations and inflight without discarding a pending operation',async()=>{
  vi.useFakeTimers();const f=fixture();f.hold();const a=f.transport.schema(target44);
  f.setContext({cookie:'b',credentialGeneration:'b'});const b=f.transport.schema(target44);
  f.setContext({cookie:'c',credentialGeneration:'c'});await expect(f.transport.schema(target44)).rejects.toThrow('owner_http_generation_capacity');
  f.setContext({cookie:'b',credentialGeneration:'b'});const second=f.transport.schema(target44);
  await expect(f.transport.schema(target44)).rejects.toThrow('owner_http_inflight_capacity');
  const settled=Promise.allSettled([a,b,second]);await vi.advanceTimersByTimeAsync(10000);await settled;
  expect(f.calls.every(c=>c.req.destroy.mock.calls.length===1)).toBe(true);expect(vi.getTimerCount()).toBe(0);
 });
 it('verifies exact native host/user before details; mismatches cannot read sessions or create',async()=>{
  const f=fixture();const original={protocolVersion:'2025-11-25',capabilities:{}};
  f.setHandler(c=>c.body.method==='initialize'?original:{structuredContent:{hostId:'roomhacker-server-100',nativeUser:'roomhacker'}});
  await expect(f.transport.readSession(target44,'codex','accepted-44')).rejects.toThrow('owner_http_native_identity_mismatch');
  await expect(f.transport.call(target44,'create_session',{harness:'codex',cwd:'/work',name:'n'},'a'.repeat(64))).rejects.toThrow('owner_http_native_identity_mismatch');
  expect(f.calls.some(c=>c.options.method==='GET'||c.body?.params?.name==='fleet_create_session')).toBe(false);
 });
 it('keeps successful source unavailable honest and allows only502→verifiedmetadata fallback',async()=>{
  const f=fixture();let details:any=await f.transport.readSession(target44,'codex','accepted-44');
  expect(details).toMatchObject({hostId:'server-44',details:{session:{id:'accepted-44'},historyUnavailable:true,history:{source:'unavailable',complete:false}}});
  f.hold();const pending=f.transport.readSession(target44,'codex','accepted-44');await Promise.resolve();await Promise.resolve();
  const info=f.calls.at(-1)!;f.respond(info,{id:info.body.id,result:{structuredContent:{hostId:'server-44',nativeUser:'roomhacker'}}});
  await vi.waitFor(()=>expect(f.calls.at(-1)!.options.method).toBe('GET'));
  f.respond(f.calls.at(-1)!,undefined,502);
  await vi.waitFor(()=>expect(String(f.calls.at(-1)!.options.path)).not.toContain('/details'));
  f.respond(f.calls.at(-1)!,{session:{id:'accepted-44',harness:'codex'}});
  details=await pending;expect(details.details.historyUnavailable).toBe(true);expect(details.details).not.toHaveProperty('messages');
 });
 it('sends one create with exact digest and does not replay a lost response',async()=>{
  const f=fixture();await f.transport.schema(target44);f.hold();
  vi.useFakeTimers();const pending=f.transport.call(target44,'create_session',{harness:'codex',cwd:'/work',name:'n',inputId:'wrong'},'a'.repeat(64));
  await Promise.resolve();await Promise.resolve();const info=f.calls.at(-1)!;
  f.respond(info,{id:info.body.id,result:{structuredContent:{hostId:'server-44',nativeUser:'roomhacker'}}});
  for(let i=0;i<8;i++)await Promise.resolve();
  const create=f.calls.at(-1)!;expect(create.body.params).toMatchObject({name:'fleet_create_session',arguments:{inputId:'a'.repeat(64)}});
  const rejected=expect(pending).rejects.toThrow('owner_http_deadline');await vi.advanceTimersByTimeAsync(30000);await rejected;
  expect(f.calls.filter(c=>c.body?.params?.name==='fleet_create_session')).toHaveLength(1);expect(vi.getTimerCount()).toBe(0);
 });
 it.each([302,401,404,503])('fails closed HTTP%s with no redirect or retry',async status=>{
  const f=fixture();f.hold();const pending=f.transport.schema(target44);
  f.respond(f.calls[0],undefined,status,{location:'https://foreign/'});
  await expect(pending).rejects.toThrow('owner_http_http_'+status);expect(f.calls).toHaveLength(1);
 });
 it('bounds response bytes and ignores foreign SSE frames while accepting only its own receipt',async()=>{
  const f=fixture();f.hold();const pending=f.transport.schema(target44);const call=f.calls[0];
  const res=Object.assign(new EventEmitter(),{statusCode:200,headers:{'content-type':'text/event-stream','mcp-session-id':'own'},complete:false,destroy:vi.fn()});
  (call as any).callback(res);call.res=res;
  res.emit('data',Buffer.from('data: '+JSON.stringify({id:'foreign',result:{}})+'\n\n'));
  res.emit('data',Buffer.from('data: '+JSON.stringify({id:call.body.id,result:{protocolVersion:'2025-11-25',capabilities:{}}})+'\n\n'));
  f.release();await pending;expect(res.destroy).toHaveBeenCalledOnce();
  f.hold();const overflow=f.transport.schema(target44);for(let i=0;i<8;i++)await Promise.resolve();const last=f.calls.at(-1)!;
  const huge=Object.assign(new EventEmitter(),{statusCode:200,headers:{'content-type':'application/json'},complete:false,destroy:vi.fn()});(last as any).callback(huge);
  huge.emit('data',Buffer.alloc(1048577));await expect(overflow).rejects.toThrow('owner_http_response_limit');expect(huge.destroy).toHaveBeenCalledOnce();
 });
 it('single-flight initialization waits for the response and failedinit reconnects metadata only',async()=>{
  const f=fixture();f.hold();const a=f.transport.schema(target44),b=f.transport.schema(target44);
  expect(f.calls).toHaveLength(1);f.respond(f.calls[0],{id:f.calls[0].body.id,error:{code:-1}});
  await Promise.all([expect(a).rejects.toThrow('owner_http_rpc_failed'),expect(b).rejects.toThrow('owner_http_rpc_failed')]);
  f.release();await f.transport.schema(target44);expect(f.calls.filter(c=>c.body?.method==='initialize')).toHaveLength(2);
 });
 it.each(['wrong-id','wrong-harness'])('rejects %s details without reinterpreting history or retrying',async outcome=>{
  const f=fixture();await f.transport.schema(target44);f.hold();
  const pending=f.transport.readSession(target44,'codex','accepted-44');
  await vi.waitFor(()=>expect(f.calls.at(-1)!.body?.params?.name).toBe('fleet_node_info'));
  const info=f.calls.at(-1)!;f.respond(info,{id:info.body.id,result:{structuredContent:{hostId:'server-44',nativeUser:'roomhacker'}}});
  await vi.waitFor(()=>expect(f.calls.at(-1)!.options.method).toBe('GET'));
  f.respond(f.calls.at(-1)!,{session:{id:outcome==='wrong-id'?'foreign':'accepted-44',harness:outcome==='wrong-harness'?'zcode':'codex'}});
  await expect(pending).rejects.toThrow('owner_http_session_identity_mismatch');
  expect(f.calls.filter(c=>c.options.method==='GET')).toHaveLength(1);
 });
 it('a slow response body shares the10s operation deadline and cleans late responses',async()=>{
  vi.useFakeTimers();const f=fixture();f.hold();const pending=f.transport.schema(target44),call=f.calls[0];
  const res=Object.assign(new EventEmitter(),{statusCode:200,headers:{'content-type':'application/json'},complete:false,destroy:vi.fn()});
  (call as any).callback(res);res.emit('data',Buffer.from('{'));
  const rejected=expect(pending).rejects.toThrow('owner_http_deadline');await vi.advanceTimersByTimeAsync(10000);await rejected;
  expect(call.req.destroy).toHaveBeenCalledOnce();expect(res.destroy).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
  const late=f.respond(call,{},200);expect(late.destroy).toHaveBeenCalledOnce();expect(()=>late.emit('error',new Error('fixture'))).not.toThrow();
 });
 it('the normal100 alias keeps its own TLS/Origin and does not borrow44 identity',async()=>{
  const f=fixture();f.setHandler(c=>c.body.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{}}:{structuredContent:{hostId:'server-44',nativeUser:'roomhacker'}});
  await expect(f.transport.schema('mcp:shell:roomhacker-server-100:AgentHerder')).rejects.toThrow('owner_http_native_identity_mismatch');
  expect(f.calls[0].options).toMatchObject({hostname:'agent.bezrabotnyi.com',servername:'agent.bezrabotnyi.com',headers:{Host:'agent.bezrabotnyi.com',Origin:'https://agent.bezrabotnyi.com'}});
 });
});
