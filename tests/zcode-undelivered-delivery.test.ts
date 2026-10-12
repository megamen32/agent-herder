import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {describe,it,expect,vi} from 'vitest';
import {HerderJobRegistry} from '../src/herder-jobs.js';
import {HerderEventBus} from '../src/herder-events.js';
import {UserMessageDelivery} from '../src/user-message-delivery.js';
import {retainedInputFingerprint,type ZcodeRetainedInput} from '../src/adapters/zcode-undelivered.js';
import {captureZcodeInput,zcodeUndeliveredFence,zcodeRetainedAttemptReceipt} from '../src/adapters/zcode-undelivered.js';
import {DatabaseSync} from 'node:sqlite';
import {ZcodeAdapter} from '../src/adapters/zcode.js';
import {getHumanStopStore} from '../src/human-stop-store.js';
// @ts-expect-error operator JS preparation utility has no declaration file
import {prepareFirstUpgradeCallback} from '../scripts/checkpoint-zcode-undelivered-input.mjs';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

function capture():ZcodeRetainedInput {
 const id='agent-herder:auto:original';
 const payload={text:'exact original instruction',intent:{clientId:'agent-herder',sourceCommandId:id,queueItemId:'queue_'+id,kind:'sendText',requestedDelivery:'queue',mode:'build',planEnabled:false,modelSelection:{providerId:'fixture',modelId:'same-model'}}};
 const body={version:1 as const,harness:'zcode' as const,origin:'automation' as const,sessionId:'same-sid',cwd:'/same-cwd',logicalInputId:id,queueItemId:'queue_'+id,nativePayload:JSON.stringify(payload),text:payload.text,attachments:[],admittedSequence:1,createdAt:10,capturedAt:20,latestUser:{id:'original-user',sequence:2}};
 return {...body,fingerprint:retainedInputFingerprint(body)};
}

describe('retained ZCode logical delivery (focused integration expected1s/max10s)',()=>{
 it('keeps original envelope outside interrupted result and hides it from public jobs',async()=>{
  const root=await mkdtemp(join(tmpdir(),'zcode-retention-'));const path=join(root,'jobs.json');
  try{
   const jobs=new HerderJobRegistry(new HerderEventBus(),{persistencePath:path});
   const receipt=(jobs as any).retainZcodeInput(capture());
   (jobs as any).reserveZcodeInputAttempt(receipt.jobId);
   const state=JSON.parse(await readFile(path,'utf8'));state.jobs[0].state='running';state.jobs[0].result={temporary:'not original envelope'};
   await writeFile(path,JSON.stringify(state));
   const restored=new HerderJobRegistry(new HerderEventBus(),{persistencePath:path});
   expect((restored as any).readZcodeInput(receipt.jobId).capture).toEqual(capture());
   expect((restored as any).readZcodeInput(receipt.jobId).attempt.inputId).toContain(':delivery-attempt:1');
   expect(JSON.stringify(restored.get(receipt.jobId))).not.toContain('exact original instruction');
   expect(JSON.stringify(restored.list())).not.toContain('exact original instruction');
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it('strictly reserves before send and never resends an accepted or unknown attempt',async()=>{
  const root=await mkdtemp(join(tmpdir(),'zcode-once-'));const path=join(root,'jobs.json');
  try{
   const jobs=new HerderJobRegistry(new HerderEventBus(),{persistencePath:path});
   const receipt=(jobs as any).retainZcodeInput(capture());
   const retry=vi.fn(async(c:ZcodeRetainedInput,id:string)=>{
    const persisted=JSON.parse(await readFile(path,'utf8')).jobs[0];
    expect(persisted.zcodeInput.attempt.inputId).toBe(id);expect(persisted.zcodeInput.capture).toEqual(capture());
    expect(c.origin).toBe('automation');expect(c.text).toBe(capture().text);
    return {ok:false,admissionUnknown:true,inputId:id};
   });
   const query=vi.fn(()=>({state:'unknown'}));
   const adapter={canRetryRetainedInput:()=>true,retryRetainedInput:retry,getRetainedInputAttempt:query};
   const supervisor={sendMessage:vi.fn()};const delivery=new UserMessageDelivery(new Map([['zcode',adapter as any]]),supervisor as any,jobs);
   await (delivery as any).retryZcodeInput(receipt.jobId);
   await (delivery as any).retryZcodeInput(receipt.jobId);
   expect(retry).toHaveBeenCalledTimes(1);expect(query).toHaveBeenCalledTimes(1);expect(supervisor.sendMessage).not.toHaveBeenCalled();
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it('does not dispatch when strict attempt persistence fails',async()=>{
  const root=await mkdtemp(join(tmpdir(),'zcode-reserve-fail-'));
  try{
   const jobs=new HerderJobRegistry(new HerderEventBus(),{persistencePath:join(root,'jobs.json')});
   const receipt=(jobs as any).retainZcodeInput(capture());
   vi.spyOn(jobs as any,'persist').mockImplementationOnce(()=>{throw Error('fixture EIO');});
   const retry=vi.fn();const delivery=new UserMessageDelivery(new Map([['zcode',{canRetryRetainedInput:()=>true,retryRetainedInput:retry} as any]]),{sendMessage:vi.fn()} as any,jobs);
   await expect((delivery as any).retryZcodeInput(receipt.jobId)).rejects.toThrow('fixture EIO');
   expect(retry).not.toHaveBeenCalled();expect((jobs as any).readZcodeInput(receipt.jobId).attempt).toBeUndefined();
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it('runs the first-upgrade checkpoint method against the existing live registry without another writer',async()=>{
  const root=await mkdtemp(join(tmpdir(),'zcode-first-checkpoint-'));const path=join(root,'jobs.json');
  try{
   const jobs=new HerderJobRegistry(new HerderEventBus(),{persistencePath:path});
   const foreign=jobs.start({kind:'foreign durable job',durableOnce:true,idempotencyKey:'foreign-operation',run:async()=>({retainedForeign:true})});
   await vi.waitFor(()=>expect(jobs.get(foreign.id)?.state).toBe('completed'));
   const source=HerderJobRegistry.prototype.retainZcodeInput.toString();
   const firstBoundary=Function('return (function '+source+')')();
   const receipt=firstBoundary.call(jobs,capture());
   expect((jobs as any).readZcodeInput(receipt.jobId).capture).toEqual(capture());
   expect(jobs.get(foreign.id)?.result).toEqual({retainedForeign:true});
   expect(JSON.parse(await readFile(path,'utf8')).jobs).toHaveLength(2);
  }finally{await rm(root,{recursive:true,force:true});}
 });
});

async function nativeFixture() {
 const root=await mkdtemp(join(tmpdir(),'zcode-never-executed-')),path=join(root,'native.sqlite'),db=new DatabaseSync(path);
 db.exec(`create table session(id text,directory text,parent_id text);
 create table session_input(id text,session_id text,kind text,delivery text,payload text,admitted_sequence integer,promoted_sequence integer,promoted_message_id text,status text,status_reason text,time_created integer,time_updated integer);
 create table message(id text,session_id text,data text,sequence integer);create table part(session_id text,data text);
 create table turn_usage(session_id text,completed_at integer);create table session_entry(session_id text,type text,data text);`);
 db.prepare('insert into session values(?,?,null)').run('same-sid',root);
 db.prepare('insert into message values(?,?,?,?)').run('old-user','same-sid',JSON.stringify({role:'user'}),1);
 const id='agent-herder:auto:original';
 const payload={text:'exact original',intent:{clientId:'agent-herder',sourceCommandId:id,queueItemId:'queue_'+id,kind:'sendText',requestedDelivery:'queue',admittedDelivery:'queue',text:'exact original',mode:'build',planEnabled:false,modelSelection:{providerId:'fixture',modelId:'same-model'}},conversationInputIntent:{sourceCommandId:id}};
 db.prepare('insert into session_input values(?,?,?,?,?,?,null,null,?,null,?,?)').run('queue_'+id,'same-sid','sendText','queue',JSON.stringify(payload),1,'admitted',10,11);
 db.prepare('insert into session_entry values(?,?,?)').run('same-sid','runtime/execution_state',JSON.stringify({mode:'build',planEnabled:false}));
 db.prepare('insert into session_entry values(?,?,?)').run('same-sid','runtime/model_selection',JSON.stringify({modelSelection:payload.intent.modelSelection}));
 return {root,path,db,id,payload,close:async()=>{db.close();await rm(root,{recursive:true,force:true});}};
}

describe('authoritative native nonexecution fence (fast unit expected1s/max5s)',()=>{
 it('allows only exact restart-discarded never-promoted input and rejects pending or changed evidence',async()=>{
  const f=await nativeFixture();
  try{
   const c=captureZcodeInput(f.path,'same-sid',f.id,f.root),attempt=f.id+':delivery-attempt:1';
   expect(zcodeUndeliveredFence(f.path,c,attempt)).toBe(false);
   f.db.exec("update session_input set status='discarded',status_reason='session_resumed'");
   expect(zcodeUndeliveredFence(f.path,c,attempt)).toBe(true);
   f.db.prepare('insert into message values(?,?,?,?)').run('desktop-new','same-sid',JSON.stringify({role:'user'}),2);
   expect(zcodeUndeliveredFence(f.path,c,attempt)).toBe(false);
   f.db.exec("delete from message where id='desktop-new';insert into turn_usage values('same-sid',null)");
   expect(zcodeUndeliveredFence(f.path,c,attempt)).toBe(false);
  }finally{await f.close();}
 });
 it.each(['promoted','foreign actor','unknown schema','original tool evidence'])('refuses %s rather than treating it as NOEXECUTION',async(reason)=>{
  const f=await nativeFixture();
  try{
   if(reason==='promoted')f.db.exec("update session_input set status='promoted',promoted_message_id='real-user',promoted_sequence=2");
   if(reason==='foreign actor'){f.payload.intent.clientId='desktop';f.db.prepare('update session_input set payload=?').run(JSON.stringify(f.payload));}
   if(reason==='unknown schema')f.db.exec('drop table part');
   if(reason==='original tool evidence')f.db.prepare('insert into part values(?,?)').run('same-sid',JSON.stringify({type:'tool',sourceCommandId:f.id,state:{status:'completed'}}));
   expect(()=>captureZcodeInput(f.path,'same-sid',f.id,f.root)).toThrow();
  }finally{await f.close();}
 });
 it('fingerprints attachment content and refuses changed or missing bytes after restart',async()=>{
  const f=await nativeFixture();
  try{
   const attachment=join(f.root,'image.png');await writeFile(attachment,'original bytes');
   (f.payload.intent as any).attachmentRefs=[{ref:attachment,fileName:'image.png',mime:'image/png',bytes:14}];
   f.db.prepare('update session_input set payload=?').run(JSON.stringify(f.payload));
   const c=captureZcodeInput(f.path,'same-sid',f.id,f.root);
   f.db.exec("update session_input set status='discarded',status_reason='session_resumed'");
   expect(zcodeUndeliveredFence(f.path,c,f.id+':delivery-attempt:1')).toBe(true);
   await writeFile(attachment,'mutated bytes!');expect(zcodeUndeliveredFence(f.path,c,f.id+':delivery-attempt:1')).toBe(false);
   await rm(attachment);expect(zcodeUndeliveredFence(f.path,c,f.id+':delivery-attempt:1')).toBe(false);
  }finally{await f.close();}
 });
 it.each(['plan','model options'])('rejects unsupported %s rather than dropping original execution settings',async(kind)=>{
  const f=await nativeFixture();
  try{
   if(kind==='plan')f.payload.intent.planEnabled=true;
   else (f.payload.intent.modelSelection as any).options={temperature:0.1};
   f.db.prepare('update session_input set payload=?').run(JSON.stringify(f.payload));
   expect(()=>captureZcodeInput(f.path,'same-sid',f.id,f.root)).toThrow(/Параметры исполнения/);
  }finally{await f.close();}
 });
 it('keeps a deterministic-ID collision UNKNOWN instead of attributing someone else\'s delivery',async()=>{
  const f=await nativeFixture();
  try{
   const c=captureZcodeInput(f.path,'same-sid',f.id,f.root),attempt=f.id+':delivery-attempt:1';
   const p=structuredClone(f.payload);p.intent.sourceCommandId=attempt;p.intent.queueItemId='queue_'+attempt;p.conversationInputIntent.sourceCommandId=attempt;
   f.db.prepare('insert into session_input values(?,?,?,?,?,?,null,null,?,null,?,?)').run('queue_'+attempt,'same-sid','sendText','queue',JSON.stringify(p),2,'admitted',20,21);
   expect(zcodeRetainedAttemptReceipt(f.path,c,attempt)).toEqual({state:'admitted',pending:true});
   p.intent.clientId='other-controller';f.db.prepare('update session_input set payload=? where id=?').run(JSON.stringify(p),'queue_'+attempt);
   expect(zcodeRetainedAttemptReceipt(f.path,c,attempt)).toEqual({state:'unknown'});
   p.intent.clientId='agent-herder';p.text='different instruction';f.db.prepare('update session_input set payload=? where id=?').run(JSON.stringify(p),'queue_'+attempt);
   expect(zcodeRetainedAttemptReceipt(f.path,c,attempt)).toEqual({state:'unknown'});
  }finally{await f.close();}
 });
});

describe('exact native retry dispatch (focused integration expected1s/max10s)',()=>{
 it.each(['eligible','eligible yolo','eligible late promoted ACK','Stop during read','Desktop during read','native busy','generation change','configuration during identity','duplicate collision text','duplicate collision actor','background running','background unknown','tool pending','late tool during identity','late background during identity'])('handles %s without wrapper, hold release or preemption',async(situation)=>{
  const f=await nativeFixture(),oldStore=process.env.AGENT_HERDER_HUMAN_STOP_STORE;
  process.env.AGENT_HERDER_HUMAN_STOP_STORE=join(f.root,'human-stops.json');
  if(situation==='eligible yolo'){
   f.payload.intent.mode='yolo';(f.payload.intent.modelSelection as any).options={reasoningLevel:'medium'};
   f.db.prepare('update session_input set payload=?').run(JSON.stringify(f.payload));
   f.db.prepare("update session_entry set data=? where type='runtime/execution_state'").run(JSON.stringify({mode:'yolo',planEnabled:false}));
   f.db.prepare("update session_entry set data=? where type='runtime/model_selection'").run(JSON.stringify({modelSelection:f.payload.intent.modelSelection}));
  }
  const c=captureZcodeInput(f.path,'same-sid',f.id,f.root),attempt=f.id+':delivery-attempt:1';
  f.db.exec("update session_input set status='discarded',status_reason='session_resumed'");
  const calls:any[]=[];let identities=0;
  const client={async start(){throw Error('no bootstrap');},async close(){},getOwnedProcessId:()=>41,
   async call(){throw Error('no start-if-needed call');},
   async callIfReady(_channel:string,method:string,args:any[]){
    calls.push({method,args});
    if(method==='getWorkspaceRuntimeIdentity'){
     identities++;
     if(situation==='configuration during identity'&&identities===2)f.db.prepare("update session_entry set data=? where type='runtime/execution_state'").run(JSON.stringify({mode:'build',planEnabled:true}));
     if(situation==='late tool during identity'&&identities===2)f.db.prepare('insert into part values(?,?)').run('same-sid',JSON.stringify({type:'tool',state:{status:'running'},toolCallId:'foreign-without-input-link'}));
     return {processId:situation==='generation change'&&identities>1?43:42,generation:1,workspaceKey:f.root};
    }
    if(method==='readSession'){
     expect(args[0].messageLimit).toBe(1);
     if(situation==='Stop during read')await getHumanStopStore().hold({harness:'zcode',id:'same-sid'},{id:'new-human-stop',at:new Date().toISOString(),reason:'human Stop'});
     if(situation==='Desktop during read')f.db.prepare('insert into message values(?,?,?,?)').run('desktop-new','same-sid',JSON.stringify({role:'user'}),2);
     return {session:{sessionId:'same-sid',status:situation==='native busy'?'running':'idle',workspace:{workspacePath:f.root},mode:f.payload.intent.mode,model:f.payload.intent.modelSelection},runtime:{activeTurnId:situation==='native busy'?'foreign-turn':null,pendingRequestIds:[]},projection:{activeToolCalls:situation==='tool pending'?[{status:'pending'}]:[],backgroundJobs:situation==='background running'||situation==='late background during identity'&&identities>=2?[{status:'running'}]:situation==='background unknown'?[{workId:'unknown'}]:[{status:'failed'}]}};
    }
    if(method==='sendConversationCommandV4'){
     const payload=structuredClone(f.payload);payload.intent.sourceCommandId=attempt;payload.intent.queueItemId='queue_'+attempt;payload.conversationInputIntent.sourceCommandId=attempt;
     if(situation==='duplicate collision text')payload.text='foreign text';
     if(situation==='duplicate collision actor')payload.intent.clientId='foreign actor';
     f.db.prepare('insert into session_input values(?,?,?,?,?,?,null,?,?,null,?,?)').run('queue_'+attempt,'same-sid','sendText','queue',JSON.stringify(payload),2,'attempt-user','promoted',20,21);
     f.db.prepare('insert into message values(?,?,?,?)').run('attempt-user','same-sid',JSON.stringify({role:'user',anchor:{sourceCommandId:attempt}}),2);
     return {commandId:attempt,status:situation.startsWith('duplicate collision')?'duplicate':'accepted',result:{type:'inputAccepted',inputId:attempt,delivery:situation==='eligible late promoted ACK'?'queue':'startNow'}};
    }
    throw Error('unexpected native call');
   }};
  const adapter=new ZcodeAdapter({client,cwd:f.root,localDbPath:f.path});
  try{
   const result=await adapter.retryRetainedInput(c,attempt);
   const sends=calls.filter(call=>call.method==='sendConversationCommandV4');
   if(situation.startsWith('eligible')){
    expect(result).toMatchObject({ok:true,admitted:true});expect(sends).toHaveLength(1);
    expect(result.pending).toBe(false);
    expect(sends[0].args[0].envelope).toMatchObject({sessionId:'same-sid',commandId:attempt,clientId:'agent-herder',payload:{text:'exact original',requestedDelivery:'queue'}});
    expect(sends[0].args[0].envelope.payload).toEqual({text:'exact original',requestedDelivery:'queue',modelSelection:f.payload.intent.modelSelection,mode:f.payload.intent.mode,planEnabled:false});
   }else if(situation.startsWith('duplicate collision')){expect(result).toMatchObject({ok:false,admissionUnknown:true,nonRetryable:true});expect(sends).toHaveLength(1);}
   else{expect(result).toMatchObject({ok:false,notSubmitted:true});expect(sends).toHaveLength(0);}
   if(situation==='Stop during read')expect(await getHumanStopStore().isHeld('zcode','same-sid')).toBe(true);
   expect(calls.every(call=>['getWorkspaceRuntimeIdentity','readSession','sendConversationCommandV4'].includes(call.method))).toBe(true);
  }finally{
   await adapter.dispose();if(oldStore===undefined)delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;else process.env.AGENT_HERDER_HUMAN_STOP_STORE=oldStore;await f.close();
  }
 });
});

it('installs old get/list/cancel redaction before first live-registry retention (focused integration expected .3s/max5s)',async()=>{
 const f=await nativeFixture(),jobsPath=join(f.root,'jobs.json');
 try{
  const c=captureZcodeInput(f.path,'same-sid',f.id,f.root),jobs=new HerderJobRegistry(new HerderEventBus(),{persistencePath:jobsPath});
  // Simulate the pre-upgrade unredacted dynamic methods on the same registry.
  (jobs as any).get=function(id:string){return JSON.parse(JSON.stringify((this as any).jobs.get(id)?.record??null));};
  (jobs as any).list=function(limit=100){return [...(this as any).jobs.values()].slice(0,limit).map((x:any)=>JSON.parse(JSON.stringify(x.record)));};
  (jobs as any).cancel=function(id:string){return (this as any).get(id);};
  const expected={controllerPid:10,controllerTick:'a',sdkPid:11,sdkTick:'b',cliPid:12,cliTick:'c',jobsPath,nativeDb:f.path};
  const declaration=prepareFirstUpgradeCallback(c,expected,HerderJobRegistry.prototype.retainZcodeInput.toString());
  const fakeFs={...fs,readFileSync(path:any,...args:any[]){
   if(String(path).startsWith('/proc/')){const pid=Number(String(path).split('/')[2]),fields=Array(20).fill('0');fields[1]=String(pid===12?11:pid===11?10:0);fields[19]=pid===10?'a':pid===11?'b':'c';return `${pid} (fixture) ${fields.join(' ')}`;}
   return (fs.readFileSync as any)(path,...args);
  },realpathSync(path:any){return String(path).startsWith('/proc/')?f.root:fs.realpathSync(path);}};
  const fakeProcess={pid:10,getBuiltinModule(name:string){return name==='fs'?fakeFs:name==='crypto'?crypto:name==='node:sqlite'?{DatabaseSync}:undefined;}};
  const callback=Function('process','return ('+declaration+')')(fakeProcess),receipt=callback.call(jobs);
  expect(receipt).toMatchObject({retained:true,stopAuthorized:false,exposureBridge:{get:true,list:true,cancel:true}});
  expect(JSON.stringify(jobs.get(receipt.jobId))).not.toContain('exact original');
  expect(JSON.stringify(jobs.list())).not.toContain('exact original');
  expect(JSON.stringify(jobs.cancel(receipt.jobId))).not.toContain('exact original');
  expect(jobs.get('missing')).toBeNull();expect(jobs.list(0)).toEqual([]);
  expect(JSON.parse(await readFile(jobsPath,'utf8')).jobs[0].zcodeInput.capture.nativePayload).toBe(c.nativePayload);
 }finally{await f.close();}
});
