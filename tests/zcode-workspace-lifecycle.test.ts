import {afterAll, afterEach, describe, expect, it} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ZcodeAdapter} from '../src/adapters/zcode.js';
import {getHumanStopStore} from '../src/human-stop-store.js';
import {SessionAutostartStore,UnfinishedSessionStore,UnfinishedSessionLauncher} from '../src/autopilot/unfinished-session-launcher.js';
import {SessionSupervisor} from '../src/session-supervisor.js';
import {LineageStore} from '../src/lineage-store.js';
import {createWebServer} from '../src/web/server.js';

// Focused integration: lost workspace CLI while SDK lives, missing legacy
// events and EMPTY turn_usage. Expected 1s, maximum 10s, isolated native state.
const roots:string[]=[];
const oldStops=process.env.AGENT_HERDER_HUMAN_STOP_STORE;
afterAll(()=>{if(oldStops===undefined)delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;else process.env.AGENT_HERDER_HUMAN_STOP_STORE=oldStops;});
afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
function fixture(unavailableCode='ZCODE_AGENT_RUNTIME_UNAVAILABLE'){
 const cwd=mkdtempSync(join(tmpdir(),'zcode-workspace-exit-'));roots.push(cwd);
 process.env.AGENT_HERDER_HUMAN_STOP_STORE=join(cwd,'stops.json');
 const path=join(cwd,'native.sqlite'),db=new DatabaseSync(path);
 db.exec(`create table session(id text primary key,directory text,parent_id text);
 create table message(id text,session_id text,sequence integer,data text,time_created integer,time_updated integer);
 create table part(id text,session_id text,message_id text,sequence integer,data text,time_created integer,time_updated integer);
 create table session_input(id text,session_id text,status text,payload text,promoted_message_id text,time_created integer);
 create table turn_usage(session_id text,turn_id text,user_message_id text,status text,started_at integer,completed_at integer);`);
 db.prepare('insert into session values(?,?,null)').run('own-session',cwd);
 const processProof={pid:701,parentPid:700,startTick:'100',cwd,groupId:701,descendants:[]};
 let alive=true,survivors=false,resumed=false,runtimePid=701,generation=1,dispatches=0;
 const info={sessionId:'own-session',workspace:{workspacePath:cwd,workspaceIdentity:cwd},sessionKind:'root',title:'Own fixture',mode:'build',status:'running',model:{providerId:'fixture',modelId:'fixture'},createdAt:Date.now(),updatedAt:Date.now()};
 const snap=()=>({session:{...info,status:resumed?'idle':'running'},runtime:{activeTurnId:resumed?undefined:'own-turn',eventSeq:4,stateRevision:2,pendingRequestIds:[]},messages:[],projection:{activeToolCalls:[],backgroundJobs:[]},settings:{model:{current:info.model}}});
 const calls:string[]=[];
 const client:any={start:async()=>{},close:async()=>{},getOwnedProcessId:()=>700,
  listen:()=>()=>{},callIfReady:async(_c:string,m:string,args:any[])=>{calls.push(m);
   if(m==='getWorkspaceRuntimeIdentity'){if(!alive)throw Object.assign(Error('runtime identity unavailable'),{code:unavailableCode});return {processId:runtimePid,generation,workspaceKey:cwd};}
   if(m==='readSession')return snap();
   if(m==='sendConversationCommandV4'){calls.pop();return client.call(_c,m,args);}throw Error(m);
  },call:async(_c:string,m:string,args:any[])=>{calls.push(m);
   if(m==='initialize')return {available:true};if(m==='readSession')return snap();
   if(m==='resumeSession'){resumed=true;alive=true;runtimePid=702;generation=2;return snap();}
   if(m==='readSessionEvents')throw Error('strict schema: executionStartedAt');
   if(m==='listSessions')return [info];
   if(m==='sendConversationCommandV4'){
    const id=args[0].envelope.commandId,at=Date.now(),n=++dispatches,user=n===1?'own-user':'recovery-user';
    db.prepare('insert into message values(?,?,?,?,?,?)').run(user,'own-session',n*2-1,JSON.stringify({role:'user',anchor:{sourceCommandId:id,turnId:'own-turn'}}),at,at);
    db.prepare('insert into message values(?,?,?,?,?,?)').run('assistant-'+n,'own-session',n*2,JSON.stringify({role:'assistant',parentID:user,anchor:{turnId:'own-turn'}}),at,at);
    db.prepare('insert into session_input values(?,?,?,?,?,?)').run('queue_'+id,'own-session','promoted',JSON.stringify({intent:{clientId:'agent-herder',sourceCommandId:id,kind:'sendText',queueItemId:'queue_'+id}}),user,at);
    return {commandId:id,status:'accepted',result:{type:'inputAccepted',inputId:id,delivery:'startNow'}};
   }throw Error(m);
  }};
 const adapter=new ZcodeAdapter({client,cwd,localDbPath:path,workspaceProcessProbe:{capture:()=>alive?{...processProof,pid:runtimePid,groupId:runtimePid,startTick:String(generation+99)}:null,gone:proof=>!survivors&&(proof.pid!==runtimePid||!alive)}});
 const events:any[]=[];adapter.subscribeEvents(e=>events.push(e));
 return {adapter,db,cwd,calls,events,kill:()=>{alive=false;},survivingChild:()=>{survivors=true;},async start(){await adapter.init();await adapter.sendMessage('own-session',{message:'Initial once',queue:true,origin:'automation',inputId:'initial-once'});await adapter.listSessions({cwd});}};
}
describe('native workspace lifecycle, not SDK disconnection',()=>{
 it('persists pre-death native identity and automatically claims SAME SID without terminal row',async()=>{
  const f=fixture(),store=new UnfinishedSessionStore(join(f.cwd,'unfinished.json')),settings=new SessionAutostartStore(join(f.cwd,'settings.json'),{});
  await settings.setSession({harness:'zcode',sessionId:'own-session',cwd:f.cwd},true);
  const launcher=new UnfinishedSessionLauncher({adapters:new Map([['zcode',f.adapter]]),store,settingsStore:settings,humanStopStore:getHumanStopStore(),retryDelayMs:1});
  const unsubscribe=f.adapter.subscribeEvents(event=>{void launcher.handleEvent('zcode',event);});
  launcher.start();
  const until=async(predicate:()=>Promise<boolean>)=>{const end=Date.now()+2500;while(!await predicate()){if(Date.now()>end)throw Error('Durable lifecycle did not progress');await new Promise(r=>setTimeout(r,10));}};
  try{
   await f.start();await until(async()=> (await store.list()).some(r=>r.activeTurnId==='own-turn'&&r.activeInputId==='agent-herder:auto:initial-once'));
   expect(f.db.prepare('select count(*) n from turn_usage').get()?.n).toBe(0);
   f.kill();await f.adapter.listSessions({cwd:f.cwd});
   await until(async()=>f.calls.filter(m=>m==='sendConversationCommandV4').length===2);
   expect(f.calls.filter(m=>m==='resumeSession')).toHaveLength(1);
   expect(f.db.prepare('select count(*) n from session_input').get()?.n).toBe(2);
   expect(f.db.prepare("select count(*) n from message where id='recovery-user'").get()?.n).toBe(1);
   expect(f.db.prepare("select count(*) n from session_input where id='queue_agent-herder:auto:initial-once'").get()?.n).toBe(1);
  }finally{launcher.stop();unsubscribe();await f.adapter.dispose();f.db.close();}
 });
 it('observes exact own active turn before CLI death despite missing legacy events/turn_usage',async()=>{
  const f=fixture();await f.start();
  expect(f.db.prepare('select count(*) n from turn_usage').get()?.n).toBe(0);
  expect(f.events.some(e=>e.kind==='turn.started'&&e.sessionId==='own-session'&&e.data.turnId==='own-turn'&&e.data.inputId==='agent-herder:auto:initial-once')).toBe(true);
  f.kill();await f.adapter.listSessions({cwd:f.cwd});
  expect(f.events.filter(e=>e.kind==='process.disconnected'&&e.sessionId==='own-session')).toHaveLength(1);
  await f.adapter.listSessions({cwd:f.cwd});
  expect(f.events.filter(e=>e.kind==='process.disconnected'&&e.sessionId==='own-session')).toHaveLength(1);
  expect(f.calls.filter(m=>m==='sendConversationCommandV4')).toHaveLength(1);
  await f.adapter.dispose();f.db.close();
 });
 it('does not turn a surviving own child into a safe crash boundary',async()=>{
  const f=fixture();await f.start();f.survivingChild();f.kill();await f.adapter.listSessions({cwd:f.cwd});
  expect(f.events.some(e=>e.kind==='process.disconnected'&&e.sessionId==='own-session')).toBe(false);
  await f.adapter.dispose();f.db.close();
 });
 it('does not reinterpret a request timeout as workspace process loss',async()=>{
  const f=fixture('RPC_TIMEOUT');await f.start();f.kill();await f.adapter.listSessions({cwd:f.cwd});
  expect(f.events.some(e=>e.kind==='process.disconnected'&&e.sessionId==='own-session')).toBe(false);
  await f.adapter.dispose();f.db.close();
 });
 it('does not recover an already successful assistant even without turn_usage',async()=>{
  const f=fixture();await f.start();f.db.prepare("update message set data=json_set(data,'$.finish','stop') where id='assistant-1'").run();
  f.kill();await f.adapter.listSessions({cwd:f.cwd});
  expect(f.events.some(e=>e.kind==='process.disconnected'&&e.sessionId==='own-session')).toBe(false);
  await f.adapter.dispose();f.db.close();
 });
 it('preserves a Stop committed after active observation',async()=>{
  const f=fixture();await f.start();await getHumanStopStore().hold({harness:'zcode',id:'own-session'},{id:'manual',at:new Date().toISOString(),reason:'human'});
  f.kill();await f.adapter.listSessions({cwd:f.cwd});
  expect(f.events.some(e=>e.kind==='process.disconnected'&&e.sessionId==='own-session')).toBe(false);
  await f.adapter.dispose();f.db.close();
 });
 it('does not attribute a newer Desktop user or completed assistant to the old crash',async()=>{
  const f=fixture();await f.start();
  f.db.prepare('insert into message values(?,?,?,?,?,?)').run('desktop-user','own-session',3,JSON.stringify({role:'user',anchor:{sourceCommandId:'desktop'}}),Date.now(),Date.now());
  f.kill();await f.adapter.listSessions({cwd:f.cwd});
  expect(f.events.some(e=>e.kind==='process.disconnected'&&e.sessionId==='own-session')).toBe(false);
  await f.adapter.dispose();f.db.close();
 });
});

// Focused integration: actual HTTP callback -> native promoted intent ->
// existing durable store. Expected 2s/max10s; NO native model/tools invoked.
async function hooks(){
 const f=fixture(),store=new UnfinishedSessionStore(join(f.cwd,'hook-unfinished.json')),settingsStore=new SessionAutostartStore(join(f.cwd,'hook-settings.json'),{});
 await settingsStore.setSession({harness:'zcode',sessionId:'own-session',cwd:f.cwd},true);
 const questions:any[]=[];
 const adapters=new Map([['zcode',f.adapter]]),launcher=new UnfinishedSessionLauncher({adapters,store,settingsStore,humanStopStore:getHumanStopStore(),humanRequests:{list:async()=>questions} as any});
 const supervisor=new SessionSupervisor(adapters,{} as any,new LineageStore(join(f.cwd,'lineage.json')),{humanStopStore:getHumanStopStore(),unfinishedSessions:launcher});
 const server=createWebServer({adapters,supervisor,converter:{} as any});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 await f.adapter.init();await f.adapter.sendMessage('own-session',{message:'Initial once',queue:true,origin:'automation',inputId:'initial-once'});
 return {...f,store,launcher,questions,async post(event:string,outcome?:string){const r=await fetch(origin+'/api/coordination/lifecycle',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({harness:'zcode',sessionId:'own-session',cwd:f.cwd,turnId:'own-turn',event,...(outcome?{outcome}:{})})});expect(r.status).toBe(200);return r.json();},async close(){launcher.stop();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await f.adapter.dispose();f.db.close();}};
}
describe('hooks primary native begin and successful final outcome',()=>{
 it('records begin BEFORE assistant/terminal row and resolves missing input_id as automation',async()=>{
  const f=await hooks();try{
   f.db.prepare('delete from message where id=?').run('assistant-1');
   expect(await f.post('user-prompt')).toMatchObject({origin:'automation',released:false,recorded:true});
   expect(await f.store.activeNativeTurn('zcode','own-session')).toEqual({turnId:'own-turn',inputId:'agent-herder:auto:initial-once'});
   expect(f.events.some(e=>e.kind==='turn.started')).toBe(false); // no legacy/snapshot tick used
  }finally{await f.close();}
 });
 it('never releases a human Stop for a native automation hook without input_id',async()=>{
  const f=await hooks();try{
   await getHumanStopStore().hold({harness:'zcode',id:'own-session'},{id:'manual',at:new Date().toISOString(),reason:'human'});
   expect(await f.post('user-prompt')).toMatchObject({origin:'automation',released:false,recorded:false});
   expect(await getHumanStopStore().isHeld('zcode','own-session')).toBe(true);
   expect(await f.store.list()).toHaveLength(0);
  }finally{await f.close();}
 });
 it('does not infer ownership from a fake automation prefix or unknown native actor',async()=>{
  const f=await hooks();try{
   f.db.prepare("update session_input set payload=json_set(payload,'$.intent.clientId','unknown-agent')").run();
   expect(await f.post('user-prompt')).toMatchObject({origin:'unknown',released:false,recorded:false});
   expect(await f.store.list()).toHaveLength(0);
  }finally{await f.close();}
 });
 it('does not complete a native turn while a newly pending human question is cached out',async()=>{
  const f=await hooks();try{
   await f.post('user-prompt');
   f.questions.push({target:{agent:'zcode',sessionId:'own-session',cwd:f.cwd}});
   f.db.prepare("update message set data=json_set(data,'$.finish','stop') where id='assistant-1'").run();
   expect(await f.post('turn-end','success')).toMatchObject({recorded:false});
   expect(await f.store.activeNativeTurn('zcode','own-session')).toBeDefined();
  }finally{await f.close();}
 });
 it('distinguishes absent/failed/continue Stop from verified native success',async()=>{
  const f=await hooks();try{
   await f.post('user-prompt');
   expect(await f.post('turn-end','success')).toMatchObject({recorded:false});
   f.db.prepare("update message set data=json_set(data,'$.finish','stop') where id='assistant-1'").run();
   for(const outcome of ['continue','failed','manual-stop'])expect(await f.post('turn-end',outcome)).toMatchObject({recorded:false});
   await f.adapter.listSessions({cwd:f.cwd});
   expect(await f.store.activeNativeTurn('zcode','own-session')).toBeDefined();
   expect(await f.post('turn-end','success')).toMatchObject({recorded:true});
   expect(await f.store.list()).toHaveLength(0);
  }finally{await f.close();}
 });
});
