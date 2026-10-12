import {describe,it,expect} from 'vitest';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {HumanStopStore} from '../src/human-stop-store.js';
import {ownedShutdownMatches,ownedZcodeActiveInput,zcodeActiveInputOwnership,zcodeShutdownObservation,zcodeRecoveryBoundaryCurrent,zcodeNativeAdmission,zcodeConfirmedCrashBoundary} from '../src/adapters/zcode-recovery-boundary.js';

describe('ZCode own-runtime attribution and Desktop race (focused integration; expected 2s/max 30s; isolated DB/state only)',()=>{
 it('keeps first-upgrade proof in the existing old-readable locked store without clearing human holds',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zcode-runtime-stop-'));const path=join(dir,'stops.json');
  try{
   const store=new HumanStopStore(path);const proof={turnId:'own-turn',controllerPid:10,runtimePid:11,at:Date.now()};
   expect(await store.checkpointOwnedZcodeShutdown('owned',proof)).toBe(true);
   const old=JSON.parse(await readFile(path,'utf8'));
   expect(Object.keys(old.sessions[0]).sort()).toEqual(['active','harness','id','ignoredStopIds','stop']);
   // Simulate an old daemon's parse/write: only its existing known fields survive.
   await writeFile(path,JSON.stringify(old));
   expect(await new HumanStopStore(path).ownedZcodeShutdowns()).toEqual([{sessionId:'owned',...proof}]);
   await store.hold({harness:'zcode',id:'owned'},{id:'manual-stop',at:new Date().toISOString(),reason:'user Stop',turnId:'own-turn'});
   expect(await store.checkpointOwnedZcodeShutdown('owned',proof)).toBe(false);
   expect(await store.isHeld('zcode','owned')).toBe(true);
   expect(await store.ownedZcodeShutdowns()).toEqual([]);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it('refuses retroactive attribution when new Desktop input, successful work or unsettled tools contradict the exact crash',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zcode-confirmed-crash-'));const path=join(dir,'native.sqlite');const db=new DatabaseSync(path);
  try{
   db.exec(`create table session(id text,parent_id text);create table message(id text,session_id text,data text,sequence integer,time_updated integer);
    create table turn_usage(session_id text,turn_id text,user_message_id text,status text,started_at integer,completed_at integer);create table session_input(session_id text,status text);create table part(session_id text,data text);`);
   db.exec("insert into session values('s',null);insert into turn_usage values('s','t','u','cancelled',10,20)");
   db.prepare('insert into message values(?,?,?,?,?)').run('u','s',JSON.stringify({role:'user',anchor:{sourceCommandId:'exact'}}),1,10);
   db.prepare('insert into message values(?,?,?,?,?)').run('a','s',JSON.stringify({role:'assistant',parentID:'u',finish:'tool-calls'}),2,19);
   const proof={turnId:'t',controllerPid:1,runtimePid:2,at:18,userMessageId:'u',sourceCommandId:'exact'};const boundary={turnId:'t',userMessageId:'u',completedAt:20};
   expect(zcodeConfirmedCrashBoundary(path,'s',proof,boundary)).toBe(true);
   expect(zcodeConfirmedCrashBoundary(path,'s',proof,boundary,9)).toBe(true);
   expect(zcodeConfirmedCrashBoundary(path,'s',proof,boundary,11)).toBe(false);
   expect(zcodeConfirmedCrashBoundary(path,'s',{...proof,sourceCommandId:'fake-prefix'},boundary)).toBe(false);
   db.exec("insert into session_input values('s','admitted')");expect(zcodeConfirmedCrashBoundary(path,'s',proof,boundary)).toBe(false);db.exec('delete from session_input');
   db.prepare('insert into part values(?,?)').run('s',JSON.stringify({type:'tool',state:{status:'running'}}));expect(zcodeConfirmedCrashBoundary(path,'s',proof,boundary)).toBe(false);db.exec('delete from part');
   db.exec("update message set time_updated=21 where id='a'");expect(zcodeConfirmedCrashBoundary(path,'s',proof,boundary)).toBe(false);db.exec("update message set time_updated=19 where id='a'");
   db.prepare('insert into message values(?,?,?,?,?)').run('desktop','s',JSON.stringify({role:'user'}),3,21);expect(zcodeConfirmedCrashBoundary(path,'s',proof,boundary)).toBe(false);
  }finally{db.close();await rm(dir,{recursive:true,force:true});}
 });
 it('links confirmed parent-crash provenance to exact native user/command while preserving manual holds',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zcode-crash-context-'));const store=new HumanStopStore(join(dir,'stops.json'));
  try{
   const proof={turnId:'t',controllerPid:10,runtimePid:11,at:1000,userMessageId:'u',sourceCommandId:'accepted-command'};
   const context={kind:'parent-crash' as const,controllerStartedAt:900,journalCursor:'s=exact-journal-entry',errorCode:'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING'};
   expect(await store.checkpointOwnedZcodeShutdown('s',proof,context)).toBe(true);
   const [recorded]=await store.ownedZcodeShutdowns();expect(recorded.contextHash).toHaveLength(64);
   const turn={turnId:'t',userMessageId:'u',sourceCommandId:'accepted-command',status:'cancelled',rootSession:true,pendingInput:false,userMessageMatchesLatest:true,assistantSucceeded:false,progressedAfterFailure:false,completedAt:1100};
   expect(ownedShutdownMatches(recorded,turn)).toBe(true);
   expect(ownedShutdownMatches(recorded,{...turn,sourceCommandId:'fake-prefix'})).toBe(false);
   expect(ownedShutdownMatches(recorded,{...turn,userMessageId:'new-user'})).toBe(false);
   expect(ownedShutdownMatches(recorded,{...turn,pendingInput:true})).toBe(false);
   await store.hold({harness:'zcode',id:'s'},{id:'human-stop',at:new Date(1200).toISOString(),reason:'Stop'});
   expect(await store.checkpointOwnedZcodeShutdown('s',proof,context)).toBe(false);
   expect(await store.ownedZcodeShutdowns()).toEqual([]);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it('does not infer legacy admission from prefix, other session, or unparented assistant',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zcode-native-anchor-'));const path=join(dir,'native.sqlite');const db=new DatabaseSync(path);
  try{
   db.exec('create table message(id text,session_id text,data text,sequence integer);create table turn_usage(session_id text,turn_id text,user_message_id text,status text,started_at integer,completed_at integer)');
   db.prepare('insert into message values(?,?,?,?)').run('u','s',JSON.stringify({role:'user',anchor:{sourceCommandId:'exact'}}),1);
   expect(zcodeNativeAdmission(path,'s',['fake-prefix:exact']).state).toBe('unknown');
   expect(zcodeNativeAdmission(path,'foreign',['exact']).state).toBe('unknown');
   expect(zcodeNativeAdmission(path,'s',['exact']).state).toBe('admitted');
   // Legacy ownership needs an exact accepted identity and native turn anchor.
   db.exec('create table session_input(session_id text,promoted_message_id text,status text,payload text)');
   db.prepare('update message set data=? where id=?').run(JSON.stringify({role:'user',anchor:{sourceCommandId:'exact',turnId:'t'}}),'u');
   expect(ownedZcodeActiveInput(path,'s')).toBe(false);
   expect(ownedZcodeActiveInput(path,'s',{turnId:'t',inputId:'fake-prefix'})).toBe(false);
   expect(ownedZcodeActiveInput(path,'s',{turnId:'t',inputId:'exact'})).toBe(true);
   db.prepare('insert into message values(?,?,?,?)').run('a','s',JSON.stringify({role:'assistant',parentID:'foreign-user'}),2);
   expect(zcodeNativeAdmission(path,'s',['exact']).state).toBe('admitted');
   db.prepare('insert into turn_usage values(?,?,?,?,?,?)').run('s','t','u','cancelled',10,20);
   expect(zcodeNativeAdmission(path,'s',['exact'])).toEqual({state:'failed',userMessageId:'u',turnId:'t'});
  }finally{db.close();await rm(dir,{recursive:true,force:true});}
 });
 it('requires exact owned-turn proof and retains newer work, pending input and unknown cancellation shields',()=>{
  const proof={turnId:'own-turn',controllerPid:10,runtimePid:11,at:1000};
  const turn={turnId:'own-turn',status:'cancelled',rootSession:true,pendingInput:false,userMessageMatchesLatest:true,assistantSucceeded:false,progressedAfterFailure:false,completedAt:1100};
  expect(ownedShutdownMatches(proof,turn)).toBe(true);
  expect(ownedShutdownMatches(undefined,turn)).toBe(false);
  for(const patch of [{turnId:'foreign-turn'},{rootSession:false},{pendingInput:true},{userMessageMatchesLatest:false},{assistantSucceeded:true},{progressedAfterFailure:true},{completedAt:999},{completedAt:200000}])expect(ownedShutdownMatches(proof,{...turn,...patch})).toBe(false);
 });
 it('rejects a Desktop input admitted after the old recovery snapshot and excludes concurrent Desktop work from ownership',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zcode-race-'));const path=join(dir,'native.sqlite');const db=new DatabaseSync(path);
  try{
   db.exec(`create table turn_usage(session_id text,turn_id text,user_message_id text,started_at integer,completed_at integer);
    create table message(id text,session_id text,data text,sequence integer);
    create table session_input(session_id text,promoted_message_id text,status text,payload text);`);
   db.prepare('insert into turn_usage values(?,?,?,?,?)').run('s','old-turn','old-user',1,10);
   db.prepare('insert into message values(?,?,?,?)').run('old-user','s',JSON.stringify({role:'user'}),1);
   const boundary={turnId:'old-turn',userMessageId:'old-user',completedAt:10};
   expect(zcodeRecoveryBoundaryCurrent(path,'s',boundary)).toBe(true);
   // The foreign input arrives while cold resume / Stop-fence reads await.
   db.prepare('insert into session_input values(?,?,?,?)').run('s',null,'admitted',JSON.stringify({intent:{clientId:'desktop'}}));
   expect(zcodeRecoveryBoundaryCurrent(path,'s',boundary)).toBe(false);
   db.prepare('update session_input set status=?,promoted_message_id=?').run('promoted','desktop-user');
   db.prepare('insert into message values(?,?,?,?)').run('desktop-user','s',JSON.stringify({role:'user'}),2);
   expect(zcodeRecoveryBoundaryCurrent(path,'s',boundary)).toBe(false);
   expect(ownedZcodeActiveInput(path,'s')).toBe(false);
   expect(zcodeActiveInputOwnership(path,'s').reason).toBe('foreign_input');
   // Even a later Herder receipt does not convert outstanding Desktop work into own work.
   db.prepare('insert into message values(?,?,?,?)').run('herder-user','s',JSON.stringify({role:'user'}),3);
   db.prepare('insert into session_input values(?,?,?,?)').run('s','herder-user','promoted',JSON.stringify({intent:{clientId:'agent-herder'}}));
   expect(ownedZcodeActiveInput(path,'s')).toBe(false);
   expect(zcodeActiveInputOwnership(path,'s').reason).toBe('outstanding_foreign_input');
   db.prepare('insert into turn_usage values(?,?,?,?,?)').run('s','desktop-turn','desktop-user',11,20);
   expect(ownedZcodeActiveInput(path,'s')).toBe(true);
   expect(zcodeRecoveryBoundaryCurrent('/missing','s',boundary)).toBe(false);
  }finally{db.close();await rm(dir,{recursive:true,force:true});}
 });
 it('reports exact first-boundary exclusions without turning historical running into idle proof',()=>{
  const session={id:'s',status:'idle',meta:{nativeLoaded:true,nativeStatus:'idle',nativeStateRevision:3,pendingRequestIds:[],humanStopHeld:false}};
  const observe=(patch:any)=>zcodeShutdownObservation('/missing','s',{...session,...patch,meta:{...session.meta,...patch.meta}});
  expect(observe({}).reason).toBe('observed_idle');
  expect(observe({status:'running',meta:{nativeLoaded:false}}).reason).toBe('native_snapshot_unavailable');
  expect(observe({meta:{humanStopHeld:true}}).reason).toBe('human_hold');
  expect(observe({meta:{pendingRequestIds:['permission']}}).reason).toBe('pending_native_request');
  expect(observe({meta:{pendingRequestIds:undefined}}).reason).toBe('native_pending_requests_unknown');
  expect(observe({meta:{nativeStateRevision:undefined}}).reason).toBe('native_revision_missing');
  expect(observe({status:'running',meta:{nativeStatus:'running'}}).reason).toBe('active_turn_identity_missing');
  const active={...session,status:'running',meta:{...session.meta,nativeStatus:'running',nativeActiveTurnId:'new-turn'}};
  expect(zcodeShutdownObservation('/missing','s',active,'old-turn').reason).toBe('durable_active_turn_changed');
  expect(zcodeShutdownObservation('/missing','s',active).reason).toBe('native_input_observation_unavailable');
 });
});
