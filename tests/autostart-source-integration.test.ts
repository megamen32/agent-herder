import {describe,it,expect,vi} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {UnfinishedSessionLauncher,UnfinishedSessionStore,SessionAutostartStore} from '../src/autopilot/unfinished-session-launcher.js';
describe('autostart source ownership',()=>{
 it('retains exact failed episode before notice and after working record removal',async()=>{
  const root=await mkdtemp(join(tmpdir(),'source-binding-'));
  try {
   const file=join(root,'unfinished.json');const store=new UnfinishedSessionStore(file);
   const session={id:'fixture-original',harness:'codex' as const,status:'error' as const,cwd:'/fixture/source',title:'fixture',lastActivity:new Date().toISOString(),needsPermission:false,messageCount:0};
   await store.markStarted(session,'fixture-generation');
   const record={...(await store.list())[0]!,recoveryCause:'turn.failed' as const,recoveryTurnId:'original-failed-root',state:'exhausted' as const};
   const notify=vi.fn(async()=>{const state=JSON.parse(await readFile(file,'utf8'));expect(state.sourceBindings[0]).toMatchObject({sessionId:session.id,recoveryTurnId:'original-failed-root'});});
   const launcher=new UnfinishedSessionLauncher({adapters:new Map(),store,settingsStore:new SessionAutostartStore(join(root,'settings.json'),{}),notify});
   await (launcher as any).notifyExhausted(record);
   await store.remove('codex',session.id,session.cwd);
   expect(await new UnfinishedSessionStore(file).list()).toEqual([]);
   const state=JSON.parse(await readFile(file,'utf8'));expect(state.sourceBindings[0]).toMatchObject({sessionId:session.id,startedAt:record.startedAt,recoveryTurnId:'original-failed-root'});
   expect(notify).toHaveBeenCalledTimes(1);
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it('retains the exact deferred episode before its notice',async()=>{
  const root=await mkdtemp(join(tmpdir(),'source-binding-deferral-'));
  try {
   const file=join(root,'unfinished.json');const store=new UnfinishedSessionStore(file);
   const session={id:'fixture-deferred',harness:'codex' as const,status:'error' as const,cwd:'/fixture/deferred',title:'fixture',lastActivity:new Date().toISOString(),needsPermission:false,messageCount:0};
   await store.markStarted(session,'fixture-generation');
   const record={...(await store.list())[0]!,recoveryCause:'turn.failed' as const,recoveryTurnId:'deferred-failed-root',state:'active' as const};
   const notify=vi.fn(async()=>{const state=JSON.parse(await readFile(file,'utf8'));expect(state.sourceBindings[0]).toMatchObject({sessionId:session.id,recoveryTurnId:'deferred-failed-root'});});
   const launcher=new UnfinishedSessionLauncher({adapters:new Map(),store,settingsStore:new SessionAutostartStore(join(root,'settings.json'),{}),notify});
   await (launcher as any).notifyUnsubmittedBlock(record,{reason:'below_reserve',remainingPercent:14,resetsAt:null});
   // The working record is re-armed and later removed, but the exact episode
   // stays verifiable by the source.
   await store.remove('codex',session.id,session.cwd);
   expect(await new UnfinishedSessionStore(file).list()).toEqual([]);
   const state=JSON.parse(await readFile(file,'utf8'));expect(state.sourceBindings[0]).toMatchObject({sessionId:session.id,startedAt:record.startedAt,recoveryTurnId:'deferred-failed-root'});
   expect(notify).toHaveBeenCalledTimes(1);
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it('runs one independent callback in existing watchdog even with recovery disabled; contains checker failure',async()=>{
  const root=await mkdtemp(join(tmpdir(),'source-cycle-'));
  try{
   const tick=vi.fn().mockRejectedValue(new Error('fixture unavailable'));const settings=new SessionAutostartStore(join(root,'settings.json'),{});
   const launcher=new UnfinishedSessionLauncher({adapters:new Map(),store:new UnfinishedSessionStore(join(root,'unfinished.json')),settingsStore:settings,sourceVerifierTick:tick} as any);
   (launcher as any).started=true;await (launcher as any).runWatchdog();expect(tick).toHaveBeenCalledTimes(1);expect((launcher as any).watchdogRunning).toBe(false);
  }finally{await rm(root,{recursive:true,force:true});}
 });
});

import {createAutostartSourceVerifierTick} from '../src/autopilot/autostart-source-verifier.js';
it('wires bounded helper with private env and no credential in argv',async()=>{
 const run=vi.fn().mockResolvedValue({stdout:'{"receipts":0}'});
 const env={NOTIFY_CENTER_EVENT_URL:'https://fixture.invalid/v1/events',NOTIFY_CENTER_TOKEN:'fixture-private'};
 await createAutostartSourceVerifierTick({autopilotStateDir:'/fixture/state',env,run:run as any})!();
 expect(run).toHaveBeenCalledTimes(1);const [binary,args,options]=run.mock.calls[0];
 expect(binary).toBe('python3');expect(args).toContain('--tick');expect(args.join(' ')).not.toContain('fixture-private');expect(options.timeout).toBe(45000);expect(options.env).toBe(env);
 // The kill of the helper must stay a last resort: the helper admits checks
 // for at most 18 seconds and the official SDK gives every request 8 seconds,
 // so the timeout has to stay above that bound. A kill in the middle of a
 // submission leaves an intent that no receipt can confirm any more.
 expect(options.timeout).toBeGreaterThan(18_000+8_000);
});
