import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {afterEach,expect,it,vi} from 'vitest';
import {DeferredMessageStore,deferredMessages,withDeferred} from '../src/deferred-messages.js';
import {createWebServer} from '../src/web/server.js';
import {OpenCodeAdapter} from '../src/adapters/opencode.js';
import {ZcodeAdapter} from '../src/adapters/zcode.js';
import plugin from '../integrations/opencode/agent-herder-autopilot.js';
// Focused integration; actual store/HTTP/plugin and native read-only adapter contracts.
// Expected3/max15s. Real model/race acceptance belongs to Root, never claimed here.
afterEach(()=>vi.restoreAllMocks());
it('scoped context never enters regular deferred take, withDeferred, or a later identity',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'active-context-'));try{
  const store=new DeferredMessageStore(join(dir,'inbox.json'));
  const m=await store.addActive('zcode','s','turn-1','logical-once','ACTIVE-secret');
  expect(await store.list('s')).toEqual([]);expect(await store.take('s')).toEqual([]);
  expect(await store.offerActive('zcode','s','unknown',async()=>false)).toEqual([]);
  expect((await store.activeReceipt('zcode','s','logical-once'))?.activeTurn?.state).toBe('pending');
  expect(await store.offerActive('zcode','s','turn-2',async()=>true)).toEqual([]);
  expect((await store.activeReceipt('zcode','s','logical-once'))?.activeTurn?.state).toBe('expired');
  expect((await store.addActive('zcode','s','turn-2','logical-once','ACTIVE-secret')).id).toBe(m.id);
  await expect(store.addActive('zcode','s','turn-2','logical-once','different')).rejects.toThrow('conflicts');
 }finally{await rm(dir,{recursive:true,force:true})}
});
it('TTL is checked after awaited native guard, and offers are durable/query-only',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'active-ttl-'));try{
  const store=new DeferredMessageStore(join(dir,'inbox.json'));const at=Date.now();
  await store.addActive('opencode','s','user-1','expired','late');
  expect(await store.offerActive('opencode','s','user-1',async()=>{vi.spyOn(Date,'now').mockReturnValue(at+300001);return true})).toEqual([]);
  vi.restoreAllMocks();await store.addActive('opencode','s','user-1','fresh','only once');
  const first=await store.offerActive('opencode','s','user-1',async()=>true);expect(first).toHaveLength(1);
  expect(await store.offerActive('opencode','s','user-1',async()=>true)).toEqual([]);
  await store.acknowledgeActive('s',first.map(m=>m.id));
  expect((await store.activeReceipt('opencode','s','fresh'))?.activeTurn?.state).toBe('hook_returned');
 }finally{await rm(dir,{recursive:true,force:true})}
});
it('OpenCode only reads native busy/root-user identity and current plugin context; no prompt POST',async()=>{
 const id='opencode-'+randomUUID();let busy=true;let root='native-root-user';const mutations:string[]=[];
 const native=createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.method!=='GET')mutations.push(req.url||'');
  const p=new URL(req.url||'','http://local').pathname;
  res.end(JSON.stringify(p==='/session/status'?{[id]:{type:busy?'busy':'idle'}}:p.endsWith('/message')?[{info:{id:root,sessionID:id,role:'user'},parts:[{type:'text',text:'initial'}]}]:{id,directory:'/workspace'}));});
 await new Promise<void>(r=>native.listen(0,'127.0.0.1',r));
 const adapter=new OpenCodeAdapter({baseUrl:`http://127.0.0.1:${(native.address() as any).port}`, protocol: "v1"});
 let held=false;const server=createWebServer({adapters:new Map([['opencode',adapter]]),converter:{} as any,supervisor:{isAutomationHeld:async()=>held} as any});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const endpoint=`http://127.0.0.1:${(server.address() as any).port}`;const old=process.env.AGENT_HERDER_URL;process.env.AGENT_HERDER_URL=endpoint;
 const nativeFetch=globalThis.fetch;vi.spyOn(globalThis,'fetch').mockImplementation((input,init)=>{const url=new URL(String(input));return nativeFetch(url.pathname.startsWith('/api/coordination/')?endpoint+url.pathname+url.search:input,init)});
 try{
  expect(await adapter.sendActiveMessage(id,{message:'ACTIVE unpredictable fixture text',inputId:'once'})).toMatchObject({admitted:true,pending:true});
  expect((await withDeferred(id,'new explicit task')).message).toBe('new explicit task');
  const hooks=await plugin.server({directory:'/workspace',$:undefined} as any);
  const output={messages:[{info:{id:root,sessionID:id,role:'user'},parts:[{type:'text',text:'initial'}]}]};
  await hooks['experimental.chat.messages.transform']({},output);
  expect(JSON.stringify(output)).toContain('ACTIVE unpredictable fixture text');
  const second={messages:[{info:{id:root,sessionID:id,role:'user'},parts:[{type:'text',text:'initial'}]}]};
  await hooks['experimental.chat.messages.transform']({},second);expect(JSON.stringify(second)).not.toContain('ACTIVE unpredictable');
  await adapter.sendActiveMessage(id,{message:'never next task',inputId:'late'});root='new-native-user';
  const next={messages:[{info:{id:root,sessionID:id,role:'user'},parts:[{type:'text',text:'new task'}]}]};
  await hooks['experimental.chat.messages.transform']({},next);expect(JSON.stringify(next)).not.toContain('never next task');
  await adapter.sendActiveMessage(id,{message:'held context',inputId:'held'});held=true;
  await hooks['experimental.chat.messages.transform']({},next);expect(JSON.stringify(next)).not.toContain('held context');
  busy=false;expect(await adapter.sendActiveMessage(id,{message:'inactive',inputId:'inactive'})).toMatchObject({notSubmitted:true});
  expect(mutations).toEqual([]);
 }finally{if(old===undefined)delete process.env.AGENT_HERDER_URL;else process.env.AGENT_HERDER_URL=old;await new Promise<void>(r=>server.close(()=>r()));await new Promise<void>(r=>native.close(()=>r()))}
});
it('ZCode active context uses only ready existing-only native reads, never guide/send/resume',async()=>{
 const id='zcode-'+randomUUID();const calls:string[]=[];let running=true;
 const client={async start(){throw Error('no startup')},async close(){},async call(){throw Error('no generic RPC')},
  async callIfReady(channel:string,method:string,args:any[]){calls.push(method);expect(channel).toBe('zcode-agent');expect(method).toBe('readSession');expect(args[0]).toMatchObject({sessionId:id,runtimePolicy:'existing-only',messageLimit:1});return {session:{sessionId:id,status:running?'running':'idle'},runtime:{activeTurnId:running?'exact-turn':undefined,pendingRequestIds:[]}}}};
 const adapter=new ZcodeAdapter({client:client as any});(adapter as any).sessionWorkspaces.set(id,{workspacePath:'/workspace',workspaceIdentity:'/workspace'});
 expect(await adapter.sendActiveMessage(id,{message:'native hook only',inputId:'one'})).toMatchObject({admitted:true,pending:true,turnId:'exact-turn'});
 running=false;expect(await adapter.sendActiveMessage(id,{message:'late',inputId:'two'})).toMatchObject({notSubmitted:true});
 expect(await adapter.getCoordinationMessageAdmission(id,'one')).toEqual({state:'admitted',pending:true});
 expect(await deferredMessages.list(id)).toEqual([]);expect(calls).toEqual(['readSession','readSession']);
});

it.each(['opencode','hermes'] as const)('real supervisor context reads late persisted Stop for %s',async harness=>{
 const {SessionSupervisor}=await import('../src/session-supervisor.js');
 const {getHumanStopStore}=await import('../src/human-stop-store.js');
 const {LineageStore}=await import('../src/lineage-store.js');
 const root=await mkdtemp(join(tmpdir(),'real-context-stop-')),id=harness+'-'+randomUUID();
 const session={id,harness,title:'active fixture',cwd:root,status:'running',lastActivity:new Date().toISOString(),needsPermission:false};
 const adapter={type:harness,getSession:async()=>session,getCoordinationActiveTurnId:async()=> 'exact-live-identity'} as any;
 const adapters=new Map([[harness,adapter]]),stops=getHumanStopStore();
 const supervisor=new SessionSupervisor(adapters,{} as any,new LineageStore(join(root,'lineage.json')),{humanStopStore:stops});
 const server=createWebServer({adapters,converter:{} as any,supervisor});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{
  await deferredMessages.addActive(harness,id,'exact-live-identity','late-once','must not enter stopped context');
  await stops.hold(session as any,{id:'manual-stop',at:new Date().toISOString(),reason:'explicit human Stop'});
  // The manual stop fences the opencode harness as well; the historical API
  // still does not cover the harnesses it never covered.
  expect(await supervisor.isAutomationHeld(harness,id)).toBe(harness==='opencode');
  const response=await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/coordination/context?${new URLSearchParams({harness,sessionId:id,cwd:root,activeTurnId:'exact-live-identity',consumeActive:'1'})}`);
  const body=await response.json();expect(body.humanStopHeld).toBe(true);expect(body.activeInboxIds).toEqual([]);expect(body.activeInboxContext).toBeNull();
  expect((await deferredMessages.activeReceipt(harness,id,'late-once'))?.activeTurn?.state).toBe('expired');
  await stops.release(harness,id);
  const after=await fetch(response.url);expect((await after.json()).activeInboxIds).toEqual([]);
 }finally{await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true})}
});

it('regular explicit inbox transfers only with the exact durable hook offer, and survives a held drop',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'active-inbox-'));try{
  const store=new DeferredMessageStore(join(dir,'inbox.json'));
  const prior=await store.add('s','explicit older instruction');
  const unrelated=await store.add('other','independent instruction');
  await store.addActive('opencode','s','user-1','held','report',[prior.id,unrelated.id]);
  expect((await store.list('s')).map(m=>m.id)).toEqual([prior.id]);
  await store.discardActive('opencode','s');
  expect((await store.list('s')).map(m=>m.id)).toEqual([prior.id]);
  await store.addActive('opencode','s','user-1','offered','report',[prior.id,unrelated.id]);
  expect(await store.offerActive('opencode','s','user-1',async()=>false)).toEqual([]);
  expect((await store.list('s')).map(m=>m.id)).toEqual([prior.id]);
  expect(await store.offerActive('opencode','s','user-1',async()=>true)).toHaveLength(1);
  expect(await store.list('s')).toEqual([]);expect((await store.list('other')).map(m=>m.id)).toEqual([unrelated.id]);
 }finally{await rm(dir,{recursive:true,force:true})}
});

// Pending plugin context is not proof that an older explicit instruction was offered.
it.each(['send_message','deliver','named'] as const)('Hermes %s pending context preserves the older explicit inbox without identity-read capability',async route=>{
 const {Client,InMemoryTransport}=await import('@modelcontextprotocol/client');
 const {McpServer}=await import('@modelcontextprotocol/server');
 const {registerSessionTools}=await import('../src/mcp/session-tools.js');
 const {HerderEventBus}=await import('../src/herder-events.js');
 const {HerderJobRegistry}=await import('../src/herder-jobs.js');
 const {coordinationNotes}=await import('../src/coordination-notes.js');
 const root=await mkdtemp(join(tmpdir(),'hermes-inbox-')),id='hermes-'+randomUUID();
 const session={id,harness:'hermes',title:'active Hermes task',cwd:root,status:'running',lastActivity:new Date().toISOString(),needsPermission:false};
 const reserve=vi.fn(async(_id:string,_options:any)=>({ok:true,admitted:true,pending:true,admissionKind:'current_turn_context',inputId:'context-once'}));
 const adapter={type:'hermes',name:'Hermes plugin transport',getSession:async()=>session,listSessions:async()=>[session],sendActiveMessage:reserve,sendMessage:async()=>{throw Error('native input forbidden')}} as any;
 expect(adapter.getCoordinationActiveTurnId).toBeUndefined();
 vi.spyOn(coordinationNotes,'inject').mockImplementation(async(_session,message)=>message);
 const prior=await deferredMessages.add(id,'older explicit instruction');
 const remove=vi.spyOn(deferredMessages,'remove');
 const events=new HerderEventBus(),server=new McpServer({name:'hermes-retention',version:'1'}),client=new Client({name:'peer',version:'1'});
 registerSessionTools(server,{adapters:new Map([['hermes',adapter]]),events,jobs:new HerderJobRegistry(events)});
 const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
 try{
  const result=await client.callTool({name:route==='named'?'deliver':route,arguments:{harness:'hermes',...(route==='named'?{name:session.title,cwd:root,create:'never'}:{sessionId:id}),message:'current coordination report',inputId:randomUUID(),mode:'queue'}});
  expect(result.content[0]).toMatchObject({text:expect.stringContaining(route==='send_message'?'model observation':'accepted_unconfirmed')});
  expect(reserve).toHaveBeenCalledOnce();expect(reserve.mock.calls[0]?.[1]?.message).toContain('older explicit instruction');
  expect(remove).not.toHaveBeenCalled();expect((await deferredMessages.list(id)).map(m=>m.id)).toEqual([prior.id]);
 }finally{await client.close();await server.close();await rm(root,{recursive:true,force:true})}
});
