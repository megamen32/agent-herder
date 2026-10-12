import {afterAll, afterEach, describe, expect, it} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ZcodeAdapter} from '../src/adapters/zcode.js';
import {parseNativeOwnerProof} from '../src/adapters/zcode-workspace-lifecycle.js';
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
 let sampledChildren:Array<{pid:number;startTick:string}>=[];
 const detachedLive=new Set<string>();
 const info={sessionId:'own-session',workspace:{workspacePath:cwd,workspaceIdentity:cwd},sessionKind:'root',title:'Own fixture',mode:'build',status:'running',model:{providerId:'fixture',modelId:'fixture'},createdAt:Date.now(),updatedAt:Date.now()};
 const snap=()=>({session:{...info,status:resumed?'idle':'running'},runtime:{activeTurnId:resumed?undefined:'own-turn',eventSeq:4,stateRevision:2,pendingRequestIds:[]},messages:[],projection:{activeToolCalls:[],backgroundJobs:[]},settings:{model:{current:info.model}}});
 const calls:string[]=[];
 let nativeListener:((payload:unknown)=>void)|undefined;
 let generationId='parent-generation-A',sdkPid=700,parentGone=false,sdkGone=false;
 let exitAt:number|null|undefined;
 let proofSink:(id:string,proof:any,current:()=>boolean)=>Promise<boolean>=async()=>false;
 let latestAdapter:ZcodeAdapter,injectParentReplay=false,parentReplayObserved=false;
 const client:any={start:async()=>{},close:async()=>{},getOwnedProcessId:()=>sdkPid,
  listen:(_channel:string,_event:string,_args:unknown,handler:(payload:unknown)=>void)=>{nativeListener=handler;return ()=>{nativeListener=undefined;};},callIfReady:async(_c:string,m:string,args:any[])=>{calls.push(m);
   if(m==='getWorkspaceRuntimeIdentity'){if(!alive)throw Object.assign(Error('runtime identity unavailable'),{code:unavailableCode});return {processId:runtimePid,generation,workspaceKey:cwd};}
   if(m==='readSession'){
    if(resumed&&injectParentReplay){injectParentReplay=false;parentReplayObserved=true;
     const at=(db.prepare('select completed_at from turn_usage where turn_id=?').get('own-turn') as any).completed_at;
     if(!nativeListener)throw Error('Cold native listener missing');
     nativeListener({type:'session.event',event:{type:'turn.completed',eventId:'owner-exit-cancelled',sessionId:'own-session',turnId:'own-turn',seq:8,timestamp:at,payload:{resultType:'cancelled',inputId:'agent-herder:auto:initial-once'}}});
     await Promise.all([...(latestAdapter as any).sessionEventTasks]);
    }return snap();}
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
 const probe:any={serviceOrigin:()=>({unit:'agent-herder.service',invocationId:'a'.repeat(32)}),ownerExit:(proof:any)=>exitAt===null?null:{unit:'agent-herder.service',invocationId:'a'.repeat(32),code:'killed',status:'9',atMicros:exitAt===undefined?String(BigInt(proof.at)*1000n+1n):String(BigInt(exitAt)*1000n)},birth:(pid:number)=>({pid,startTick:pid===process.pid?'1000':pid===runtimePid?String(generation+99):'2000',parentPid:pid===sdkPid?process.pid:1}),birthGone:(birth:any)=>birth.pid===process.pid?parentGone:sdkGone,capture:()=>alive?{...processProof,parentPid:sdkPid,pid:runtimePid,groupId:runtimePid,startTick:String(generation+99),descendants:[...sampledChildren]}:null,gone:(proof:any)=>!survivors&&(proof.pid!==runtimePid||!alive)&&!proof.descendants.some((child:any)=>detachedLive.has(`${child.pid}:${child.startTick}`))};
 const makeAdapter=()=>latestAdapter=new ZcodeAdapter({client,cwd,localDbPath:path,workspaceProcessProbe:probe,controllerGenerationId:generationId,persistNativeOwner:(id:string,proof:any,current:()=>boolean)=>proofSink(id,proof,current)} as any);
 const adapter=makeAdapter();
 const events:any[]=[];adapter.subscribeEvents(e=>events.push(e));
 return {adapter,db,cwd,calls,events,setOwnerExit(at:number|null){exitAt=at;},replayOwnerCancellation(){injectParentReplay=true;},parentReplayObserved:()=>parentReplayObserved,setProofSink(sink:typeof proofSink){proofSink=sink;},coldAdapter(){generationId='parent-generation-B';sdkPid=800;return makeAdapter();},loseParent(){alive=false;parentGone=true;sdkGone=true;},keepOldSdk(){sdkGone=false;},async emitNative(payload:unknown){if(!nativeListener)throw Error('Native subscription missing');nativeListener(payload);await Promise.all([...(latestAdapter as any).sessionEventTasks]);},observeChild(pid:number,startTick:string){sampledChildren=[{pid,startTick}];detachedLive.add(`${pid}:${startTick}`);},detachChildren(){sampledChildren=[];},kill:()=>{alive=false;},survivingChild:()=>{survivors=true;},async start(){await adapter.init();await adapter.sendMessage('own-session',{message:'Initial once',queue:true,origin:'automation',inputId:'initial-once'});await adapter.listSessions({cwd});}};
}
describe('native workspace lifecycle, not SDK disconnection',()=>{
 it.each(['controller','sdk','runtime','child'])('rejects numeric persisted startTick for %s',target=>{
  const proof:any={service:{unit:'agent-herder.service',invocationId:'a'.repeat(32)},generationId:'A',turnId:'turn',inputId:'input',userMessageId:'user',cwd:'/tmp/fixture',at:Date.now(),controller:{pid:101,parentPid:1,startTick:'1000'},sdk:{pid:202,parentPid:101,startTick:'2000'},runtime:{pid:302,parentPid:202,startTick:'3000',cwd:'/tmp/fixture',groupId:302,descendants:[{pid:303,startTick:'4000'}]}};
  expect(parseNativeOwnerProof(proof)).toBeDefined();
  (target==='child'?proof.runtime.descendants[0]:proof[target]).startTick=1000;
  expect(parseNativeOwnerProof(proof)).toBeUndefined();
 });
 it('automatically persists exact owner before loss, then a NEW launcher claims SAME SID without a checkpoint',async()=>{
  const f=fixture(),path=join(f.cwd,'parent-unfinished.json'),store=new UnfinishedSessionStore(path),settings=new SessionAutostartStore(join(f.cwd,'parent-settings.json'),{});
  await settings.setSession({harness:'zcode',sessionId:'own-session',cwd:f.cwd},true);
  f.setProofSink((id,proof,current)=>(store as any).recordNativeOwnerProof(id,proof,current));
  const first=new UnfinishedSessionLauncher({adapters:new Map([['zcode',f.adapter]]),store,settingsStore:settings,humanStopStore:getHumanStopStore(),generationId:'parent-generation-A'});
  const unsub=f.adapter.subscribeEvents(e=>{void first.handleEvent('zcode',e);});let cold:ZcodeAdapter|undefined,second:UnfinishedSessionLauncher|undefined;
  try{
   await f.start();await new Promise(r=>setTimeout(r,50));await f.adapter.listSessions({cwd:f.cwd});
   const saved=(await store.list())[0] as any;expect(saved.activeNativeOwner).toMatchObject({turnId:'own-turn',inputId:'agent-herder:auto:initial-once',controller:{pid:process.pid,startTick:'1000'},sdk:{pid:700,startTick:'2000'}});
   expect(saved.recoveryCause).toBeUndefined();
   f.loseParent();unsub();
   f.db.prepare('insert into turn_usage values(?,?,?,?,?,?)').run('own-session','own-turn','own-user','cancelled',saved.activeNativeOwner.at-10,Date.now());
   cold=f.coldAdapter();second=new UnfinishedSessionLauncher({adapters:new Map([['zcode',cold]]),store:new UnfinishedSessionStore(path),settingsStore:settings,humanStopStore:getHumanStopStore(),generationId:'parent-generation-B',retryDelayMs:1});
   cold.subscribeEvents(e=>{void second?.handleEvent('zcode',e);});f.replayOwnerCancellation();
   second.start();const end=Date.now()+3000;while(f.db.prepare('select count(*) n from session_input').get()?.n!==2){if(Date.now()>end)throw Error('Cold parent-crash continuation missing');await new Promise(r=>setTimeout(r,10));}
   expect(f.calls.filter(m=>m==='resumeSession')).toHaveLength(1);
   expect(f.parentReplayObserved()).toBe(true);
   expect(await getHumanStopStore().isHeld('zcode','own-session')).toBe(false);
   expect(f.db.prepare("select count(*) n from session_input where id='queue_agent-herder:auto:initial-once'").get()?.n).toBe(1);
  }finally{first.stop();second?.stop();unsub();await cold?.dispose();await f.adapter.dispose();f.db.close();}
 });
 it.each(['surviving-sdk','detached-child','manual-hold','new-desktop','pending-input','missing-terminal','success','cancel-before-proof','new-tool','unknown-tool','manualcancel-before-death','unknown-exit','legacy-no-proof'])(
  'refuses parent-crash adoption with %s',async(reason)=>{
  const f=fixture(),path=join(f.cwd,'negative-parent.json'),store=new UnfinishedSessionStore(path),settings=new SessionAutostartStore(join(f.cwd,'negative-settings.json'),{});
  await settings.setSession({harness:'zcode',sessionId:'own-session',cwd:f.cwd},true);
  if(reason!=='legacy-no-proof')f.setProofSink((id,proof,current)=>(store as any).recordNativeOwnerProof(id,proof,current));
  const first=new UnfinishedSessionLauncher({adapters:new Map([['zcode',f.adapter]]),store,settingsStore:settings,humanStopStore:getHumanStopStore(),generationId:'parent-generation-A'});
  const unsub=f.adapter.subscribeEvents(e=>{void first.handleEvent('zcode',e);});let cold:ZcodeAdapter|undefined,second:UnfinishedSessionLauncher|undefined;
  try{
   await f.start();await new Promise(r=>setTimeout(r,50));
   if(reason==='detached-child')f.observeChild(703,'3000');
   await f.adapter.listSessions({cwd:f.cwd});
   if(reason==='detached-child'){f.detachChildren();await f.adapter.listSessions({cwd:f.cwd});}
   const saved=(await store.list())[0] as any,at=saved.activeNativeOwner?.at??Date.now();
   if(reason==='legacy-no-proof')expect(saved.activeNativeOwner).toBeUndefined();else expect(saved.activeNativeOwner).toBeDefined();
   // A metadata refresh from another generation may not relabel this ownership.
   await store.markStarted({id:'own-session',harness:'zcode',cwd:f.cwd,title:'fixture',status:'running',lastActivity:new Date().toISOString(),needsPermission:false},'parent-generation-B');
   if(reason!=='legacy-no-proof')expect((await store.list())[0].generationId).toBe('parent-generation-A');
   f.loseParent();unsub();
   if(reason==='surviving-sdk')f.keepOldSdk();
   if(reason==='unknown-exit')f.setOwnerExit(null);
   if(reason==='manualcancel-before-death')f.setOwnerExit(at+2);
   if(reason!=='missing-terminal')f.db.prepare('insert into turn_usage values(?,?,?,?,?,?)').run('own-session','own-turn','own-user',reason==='success'?'completed':'cancelled',at-10,reason==='cancel-before-proof'?at-1:reason==='manualcancel-before-death'?at+1:Date.now());
   if(reason==='manual-hold')await getHumanStopStore().hold({harness:'zcode',id:'own-session'},{id:'manual',at:new Date().toISOString(),reason:'human'});
   if(reason==='new-desktop')f.db.prepare('insert into message values(?,?,?,?,?,?)').run('desktop','own-session',3,JSON.stringify({role:'user',anchor:{sourceCommandId:'desktop',turnId:'new'}}),Date.now(),Date.now());
   if(reason==='pending-input')f.db.prepare('insert into session_input values(?,?,?,?,?,?)').run('other','own-session','admitted','{}',null,Date.now());
   if(reason==='success')f.db.prepare("update message set data=json_set(data,'$.finish','stop') where id='assistant-1'").run();
   if(reason==='new-tool')f.db.prepare('insert into part values(?,?,?,?,?,?,?)').run('late','own-session','assistant-1',1,JSON.stringify({type:'tool',state:{status:'running'}}),Date.now()+1,Date.now()+1);
   if(reason==='unknown-tool')f.db.prepare('insert into part values(?,?,?,?,?,?,?)').run('unknown','own-session','assistant-1',1,JSON.stringify({type:'tool',state:{status:'unknown'}}),at-1,at-1);
   cold=f.coldAdapter();second=new UnfinishedSessionLauncher({adapters:new Map([['zcode',cold]]),store:new UnfinishedSessionStore(path),settingsStore:settings,humanStopStore:getHumanStopStore(),generationId:'parent-generation-B'});
   second.start();await second.recoverPending();
   expect(f.calls.filter(m=>m==='resumeSession')).toHaveLength(0);expect(f.calls.filter(m=>m==='sendConversationCommandV4')).toHaveLength(1);
  }finally{first.stop();second?.stop();unsub();await cold?.dispose();await f.adapter.dispose();f.db.close();}
 });
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
 it('retains an observed detached child across captures of the SAME CLI generation',async()=>{
  const f=fixture();try{
   await f.start();
   f.observeChild(703,'child-start-1');await f.adapter.listSessions({cwd:f.cwd});
   // The child reparents and takes another PGID; the next current tree is empty.
   f.detachChildren();await f.adapter.listSessions({cwd:f.cwd});
   f.kill();await f.adapter.listSessions({cwd:f.cwd});
   expect(f.events.some(e=>e.kind==='process.disconnected'&&e.sessionId==='own-session')).toBe(false);
   expect(f.calls.filter(m=>m==='sendConversationCommandV4')).toHaveLength(1);
  }finally{await f.adapter.dispose();f.db.close();}
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
 const lifecycleTasks:Promise<void>[]=[];const unsubscribe=f.adapter.subscribeEvents(event=>{lifecycleTasks.push(launcher.handleEvent('zcode',event));});
 const supervisor=new SessionSupervisor(adapters,{} as any,new LineageStore(join(f.cwd,'lineage.json')),{humanStopStore:getHumanStopStore(),unfinishedSessions:launcher});
 const server=createWebServer({adapters,supervisor,converter:{} as any});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 await f.adapter.init();await f.adapter.sendMessage('own-session',{message:'Initial once',queue:true,origin:'automation',inputId:'initial-once'});
 return {...f,store,launcher,questions,async emitCompleted(){await f.emitNative({type:'session.event',event:{type:'turn.completed',eventId:'generic-model-completed',sessionId:'own-session',turnId:'own-turn',seq:8,timestamp:Date.now(),payload:{resultType:'success',inputId:'agent-herder:auto:initial-once'}}});await Promise.all(lifecycleTasks.splice(0));},async post(event:string,outcome?:string){const r=await fetch(origin+'/api/coordination/lifecycle',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({harness:'zcode',sessionId:'own-session',cwd:f.cwd,turnId:'own-turn',event,...(outcome?{outcome}:{})})});expect(r.status).toBe(200);return r.json();},async close(){launcher.stop();unsubscribe();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await f.adapter.dispose();f.db.close();}};
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
 it('keeps hook-primary tracking and durable active through generic model completion until verified Stop success',async()=>{
  const f=await hooks();try{
   await f.post('user-prompt');
   let technicalAck:any;
   (f.adapter as any).turnStartWaiters.set('own-session:agent-herder:auto:initial-once',(result:unknown)=>{technicalAck=result;});
   await f.emitCompleted();
   expect(technicalAck).toMatchObject({ok:true,turnId:'own-turn'});
   expect(await f.store.activeNativeTurn('zcode','own-session')).toBeDefined();
   expect(f.events.some(e=>e.kind==='turn.completed')).toBe(false);
   expect((f.adapter as any).observedActiveTurns.get('own-session')?.hookStarted).toBe(true);
   for(const outcome of ['continue','failed','unknown']){await f.post('turn-end',outcome);await f.emitCompleted();expect(await f.store.activeNativeTurn('zcode','own-session')).toBeDefined();}
   f.db.prepare("update message set data=json_set(data,'$.finish','stop') where id='assistant-1'").run();
   expect(await f.post('turn-end','success')).toMatchObject({recorded:true});
   expect(await f.store.list()).toHaveLength(0);
   expect((f.adapter as any).observedActiveTurns.has('own-session')).toBe(false);
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
