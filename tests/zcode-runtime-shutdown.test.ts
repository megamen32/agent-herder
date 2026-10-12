import {describe,it,expect} from 'vitest';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {HumanStopStore} from '../src/human-stop-store.js';
import {ownedShutdownMatches,ownedZcodeActiveInput,zcodeRecoveryBoundaryCurrent} from '../src/adapters/zcode-recovery-boundary.js';

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
   // Even a later Herder receipt does not convert outstanding Desktop work into own work.
   db.prepare('insert into message values(?,?,?,?)').run('herder-user','s',JSON.stringify({role:'user'}),3);
   db.prepare('insert into session_input values(?,?,?,?)').run('s','herder-user','promoted',JSON.stringify({intent:{clientId:'agent-herder'}}));
   expect(ownedZcodeActiveInput(path,'s')).toBe(false);
   db.prepare('insert into turn_usage values(?,?,?,?,?)').run('s','desktop-turn','desktop-user',11,20);
   expect(ownedZcodeActiveInput(path,'s')).toBe(true);
   expect(zcodeRecoveryBoundaryCurrent('/missing','s',boundary)).toBe(false);
  }finally{db.close();await rm(dir,{recursive:true,force:true});}
 });
});
