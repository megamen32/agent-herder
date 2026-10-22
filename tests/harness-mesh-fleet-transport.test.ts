import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
// An empty state dir means the default quota policy: enabled, reserve 20%.
const POLICY_DIR='/tmp/herder-quota-policy-none';
import {FleetGptAdminTransport} from '../src/mesh/fleet-gptadmin-transport.js';
describe('GPTAdmin tenant fleet transport (focused integration; expected 2s, maximum 20s)',()=>{
 beforeEach(()=>vi.stubEnv('AGENT_HERDER_AUTOPILOT_STATE_DIR',POLICY_DIR));
 afterEach(()=>vi.unstubAllEnvs());
 it('requests full native DTOs and schemas rather than human compact previews (regression; expected 1s, maximum 5s)',async()=>{
  const requests:any[]=[];
  const fake=vi.fn(async(_url:any,init:any)=>{
   const r=JSON.parse(init.body);
   if(r.method==='notifications/initialized')return new Response(null,{status:202});
   let result:any={protocolVersion:'2025-11-25'};
   if(r.method==='tools/call'){
    requests.push(r.params);const full=r.params.arguments.detail==='full';
    // The fleet guard reads the recipient's own Codex quota before an admission.
    if(r.params.name==='execute'&&r.params.arguments.tool==='model_quotas')result={structuredContent:{checkedAt:new Date().toISOString(),providers:[{provider:'codex',state:'reported',checkedAt:new Date().toISOString(),details:{primary_used:10,secondary_used:10,allowed:true,limit_reached:false}}]}};
    else result=r.params.name==='schema'?(full?{tools:[{name:'mesh_snapshot',inputSchema:{type:'object'}}]}:{preview:'schema preview'}):(full?{hostId:'roomhacker-server-100',sessions:[]}:{bytes:128,preview:'native snapshot preview',status:'completed'});
   }
   return new Response(JSON.stringify({id:r.id,result}));
  });
  const t=new FleetGptAdminTransport({endpoint:'https://hub.test/mcp',headersProvider:()=>({}),fetch:fake as any});
  expect(await t.call('peer','mesh_snapshot',{limit:1})).toEqual({hostId:'roomhacker-server-100',sessions:[]});
  expect((await t.schema('peer') as any).tools[0].inputSchema).toEqual({type:'object'});
  for(const tool of ['fleet_node_info','fleet_session_page','fleet_session_view','create_session'])await t.call('peer',tool,{},tool==='create_session'?'stable-once':undefined);
  expect(requests.every(r=>r.arguments.detail==='full')).toBe(true);
  expect(requests.filter(r=>r.arguments.tool==='create_session')).toHaveLength(1);
  expect(requests.find(r=>r.arguments.tool==='create_session').arguments.idempotency_key).toBe('stable-once');
 });
 it('uses initialize/discover/schema/execute/job facade, schema response unwrap and one mutation even with async job',async()=>{
  const calls:any[]=[];const fake=vi.fn(async(_url:any,init:any)=>{const request=JSON.parse(init.body);calls.push(request);expect(init.redirect).toBe('error');expect(init.headers.Authorization).toBe('protected-memory-only');
   const tool=request.params?.name;let result:any={protocolVersion:'2025-11-25',capabilities:{},serverInfo:{name:'hub',version:'1'}};
   if(tool==='discover')result={structuredContent:{status:'completed',response:{servers:[]}}};
   if(tool==='schema')result={content:[{type:'text',text:JSON.stringify({status:'completed',server_id:'mcp:shell:88:AgentHerder',response:{tools:[{name:'create_session'}]}})}]};
   if(tool==='execute')result=request.params.arguments.tool==='model_quotas'?{structuredContent:{checkedAt:new Date().toISOString(),providers:[{provider:'codex',state:'reported',checkedAt:new Date().toISOString(),details:{primary_used:10,secondary_used:10,allowed:true,limit_reached:false}}]}}:{structuredContent:{status:'running',job_id:'j',owner_target:'shell:88'}};
   if(tool==='job'){expect(request.params.arguments.id).toBe('j');result={structuredContent:{status:'completed',result:{content:[{type:'text',text:JSON.stringify({ok:true,created:true,harness:'codex',sessionId:'native',cwd:'/work'})}]}}};}
   return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}),{headers:{'Content-Type':'application/json','Mcp-Session-Id':'owned-session'}});
  });
  const transport=new FleetGptAdminTransport({endpoint:'https://hub.test/mcp/tenant',headersProvider:()=>({Authorization:'protected-memory-only'}),fetch:fake as any});
  await transport.discover();expect((await transport.schema('mcp:shell:88:AgentHerder') as any).tools[0].name).toBe('create_session');
  expect((await transport.call('mcp:shell:88:AgentHerder','create_session',{harness:'codex'},'digest') as any).sessionId).toBe('native');
  // The quota preflight is one more execute; the mutation itself stays single.
  expect(calls.filter(r=>r.params?.name==='execute'&&r.params.arguments.tool==='create_session')).toHaveLength(1);expect(calls.filter(r=>r.method==='initialize')).toHaveLength(1);
 });
 it('does not retry a lost mutation response and never shares session headers with another transport',async()=>{
  const first=vi.fn(async(_url:any,init:any)=>{const r=JSON.parse(init.body);if(r.method==='initialize')return new Response(JSON.stringify({id:r.id,result:{protocolVersion:'2025-11-25'}}),{headers:{'Mcp-Session-Id':'one'}});if(r.method==='notifications/initialized')return new Response(null,{status:202});throw new Error('lost after mutation');});
  const t=new FleetGptAdminTransport({endpoint:'https://hub.test/mcp',headersProvider:()=>({}),fetch:first as any});await expect(t.call('x','create_session',{},'id')).rejects.toThrow();expect(first).toHaveBeenCalledTimes(3);
  const second=vi.fn(async(_url:any,init:any)=>{expect(init.headers['Mcp-Session-Id']).toBeUndefined();const r=JSON.parse(init.body);return new Response(JSON.stringify({id:r.id,result:{}}));});
  await new FleetGptAdminTransport({endpoint:'https://hub.test/mcp',headersProvider:()=>({}),fetch:second as any}).discover();
 });
});

describe('facade identity/deadline fences (focused integration; expected 1s, maximum 15s)',()=>{
 it('rejects a foreign JSON-RPC result instead of accepting it as initialization or native receipt',async()=>{
  const fake=vi.fn(async()=>new Response(JSON.stringify({id:'foreign',result:{protocolVersion:'2025-11-25'}})));
  const t=new FleetGptAdminTransport({endpoint:'https://hub.test/mcp',headersProvider:()=>({}),fetch:fake as any});await expect(t.discover()).rejects.toThrow('identity_mismatch');expect(fake).toHaveBeenCalledTimes(1);
 });
 it('bounds a never-resolving headers provider and resets failed initialization without posting a delayed call',async()=>{
  const fake=vi.fn(),headers=vi.fn(()=>new Promise<Record<string,string>>(()=>{}));const t=new FleetGptAdminTransport({endpoint:'https://hub.test/mcp',headersProvider:headers,fetch:fake,readDeadlineMs:5});
  await expect(t.discover()).rejects.toThrow('deadline');await expect(t.discover()).rejects.toThrow('deadline');expect(headers).toHaveBeenCalledTimes(2);expect(fake).not.toHaveBeenCalled();
 });
 it('SSE ignores foreign frames, consumes one owned result and cancels ONLY its response stream',async()=>{
  const fake=vi.fn(async(_url:any,init:any)=>{const r=JSON.parse(init.body);if(r.method==='notifications/initialized')return new Response(null,{status:202});
   const data='data: '+JSON.stringify({id:'foreign',result:{servers:[{fake:true}]}})+'\n\ndata: '+JSON.stringify({id:r.id,result:r.method==='initialize'?{protocolVersion:'2025-11-25'}:{content:[{type:'text',text:JSON.stringify({servers:[]})}]}})+'\n\n';
   return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(data));}}),{headers:{'Content-Type':'text/event-stream'}});
  });const t=new FleetGptAdminTransport({endpoint:'https://hub.test/mcp',headersProvider:()=>({}),fetch:fake as any,readDeadlineMs:100});expect(await t.discover()).toEqual({servers:[]});
 });
});
describe('measured facade metadata budget (fast unit fake time; expected 1s, maximum 10s)',()=>{
 it('accepts a 3.2s native metadata response under the finite default10s deadline',async()=>{
  vi.useFakeTimers();try{
   const fake=vi.fn(async(_url:any,init:any)=>{const r=JSON.parse(init.body);if(r.method==='notifications/initialized')return new Response(null,{status:202});if(r.method==='tools/call')await new Promise(resolve=>setTimeout(resolve,3200));return new Response(JSON.stringify({id:r.id,result:r.method==='initialize'?{protocolVersion:'2025-11-25'}:{servers:[]}}));});
   const t=new FleetGptAdminTransport({endpoint:'https://hub.test/mcp',headersProvider:()=>({}),fetch:fake as any});const pending=t.discover();await vi.advanceTimersByTimeAsync(3500);expect(await pending).toEqual({servers:[]});
  }finally{vi.useRealTimers();}
 });
});

describe('cold facade metadata budget (fast unit fake time; expected 1s, maximum 10s)',()=>{
 it.each(['discover','schema','mesh_snapshot'])('accepts a9s %s receipt exactly once under the default10s bound',async(tool)=>{
  vi.useFakeTimers();try{
   const fake=vi.fn(async(_url:any,init:any)=>{const r=JSON.parse(init.body);if(r.method==='notifications/initialized')return new Response(null,{status:204});if(r.method==='tools/call')await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,9000);init.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('aborted'));},{once:true});});return new Response(JSON.stringify({id:r.id,result:r.method==='initialize'?{protocolVersion:'2025-11-25'}:{verified:'metadata'}}));});
   const t=new FleetGptAdminTransport({endpoint:'https://hub.test/mcp',headersProvider:()=>({}),fetch:fake as any});
   const operation=tool==='discover'?t.discover():tool==='schema'?t.schema('peer'):t.call('peer',tool,{});const outcome=operation.then(value=>({value}),error=>({error:error.message}));await vi.advanceTimersByTimeAsync(9500);
   expect(await outcome).toEqual({value:{verified:'metadata'}});expect(fake.mock.calls.filter(c=>JSON.parse(c[1].body).method==='tools/call')).toHaveLength(1);
  }finally{vi.useRealTimers();}
 });
 it('aborts an unresolved read at10s without a read retry or delayed execute',async()=>{
  vi.useFakeTimers();try{
   const fake=vi.fn(async(_url:any,init:any)=>{const r=JSON.parse(init.body);if(r.method==='notifications/initialized')return new Response(null,{status:204});if(r.method==='tools/call')return new Promise<Response>((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));return new Response(JSON.stringify({id:r.id,result:{protocolVersion:'2025-11-25'}}));});
   const t=new FleetGptAdminTransport({endpoint:'https://hub.test/mcp',headersProvider:()=>({}),fetch:fake as any});let error:string|undefined;const pending=t.call('peer','mesh_snapshot',{}).catch(e=>{error=e.message;});await vi.advanceTimersByTimeAsync(9999);expect(error).toBeUndefined();await vi.advanceTimersByTimeAsync(1);await pending;
   expect(error).toBe('gptadmin_deadline');expect(fake.mock.calls.filter(c=>JSON.parse(c[1].body).method==='tools/call')).toHaveLength(1);
  }finally{vi.useRealTimers();}
 });
});
