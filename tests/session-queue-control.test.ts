import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {HerderJobRegistry} from '../src/herder-jobs.js';
import {HerderEventBus} from '../src/herder-events.js';
import {HumanStopStore} from '../src/human-stop-store.js';
import {SessionQueueControl,type SessionQueueControlSnapshot} from '../src/session-queue-control.js';

const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
const target={hostId:'host-a',harness:'zcode',sessionId:'native-owned'};
const input={...target,inputId:'explicit-resume-1',expectedRevision:7};
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'herder-queue-control-'));roots.push(root);
 const path=join(root,'jobs.json'),jobs=new HerderJobRegistry(new HerderEventBus(),{persistencePath:path}),humanStops=new HumanStopStore(join(root,'stops.json'));
 const snapshot:SessionQueueControlSnapshot={session:{id:target.sessionId,harness:'zcode',hostId:target.hostId,status:'idle',needsPermission:false},state:{autoDrain:true,baseRevision:7,pendingCount:2,oldestQueueItemId:'oldest',nativeState:'completedSuccess',loaded:true,capability:'setAutoDrain'},holds:[]};
 const readTarget=vi.fn(async()=>snapshot);
 const resume=vi.fn(async(t:any,options:any)=>{
  const file=JSON.parse(await readFile(path,'utf8'));
  expect(file.jobs).toContainEqual(expect.objectContaining({durableOnce:true,state:'running',ownerSessionId:target.sessionId}));
  return{ok:true,status:'accepted' as const,inputId:options.inputId,state:{...snapshot.state!,autoDrain:true,baseRevision:8}};
 });
 const control=new SessionQueueControl({jobs,humanStops,readTarget,resume});
 return{root,path,jobs,humanStops,snapshot,readTarget,resume,control};
}
async function done(jobs:HerderJobRegistry,id:string){await vi.waitFor(()=>expect(['completed','failed','interrupted']).toContain(jobs.get(id)?.state));return jobs.get<any>(id)!;}

it('claims the existing durable job before exact target/revision resume and never resends accepted after restart',async()=>{
 const f=await fixture(),first=f.control.submit(input),same=f.control.submit({...input});expect(same.id).toBe(first.id);
 expect((await done(f.jobs,first.id)).result).toMatchObject({ok:true,status:'accepted'});
 expect(f.resume).toHaveBeenCalledExactlyOnceWith(target,{inputId:input.inputId,expectedRevision:7});
 const restored=new HerderJobRegistry(new HerderEventBus(),{persistencePath:f.path});
 const control=new SessionQueueControl({...f,jobs:restored});
 expect(control.submit({...input}).id).toBe(first.id);expect(f.resume).toHaveBeenCalledTimes(1);
 expect(()=>control.submit({...input,expectedRevision:8})).toThrow(/использован|changed|conflict/);
});
it('lost native reply becomes UNKNOWN and is not replayed after restart',async()=>{
 const f=await fixture();f.resume.mockImplementation(async()=>{throw Error('lost after native write');});
 const job=f.control.submit(input);expect((await done(f.jobs,job.id)).result).toMatchObject({ok:false,status:'unknown',nonRetryable:true});
 const restored=new HerderJobRegistry(new HerderEventBus(),{persistencePath:f.path});new SessionQueueControl({...f,jobs:restored}).submit(input);expect(f.resume).toHaveBeenCalledTimes(1);
});
it.each(['hostId','id','harness'] as const)('rejects changed exact session %s before native dispatch',async key=>{
 const f=await fixture();(f.snapshot.session as any)[key]='other';const job=f.control.submit(input);expect((await done(f.jobs,job.id)).result).toMatchObject({ok:false,status:'not-submitted'});expect(f.resume).not.toHaveBeenCalled();
});
it('refuses a held HumanStop without clearing it',async()=>{
 const f=await fixture();await f.humanStops.hold({harness:'zcode',id:target.sessionId},{id:'human-stop',at:new Date().toISOString(),reason:'operator stop'});
 const job=f.control.submit(input);expect((await done(f.jobs,job.id)).result).toMatchObject({ok:false,status:'not-submitted'});expect(f.resume).not.toHaveBeenCalled();expect(await f.humanStops.isHeld('zcode',target.sessionId)).toBe(true);
});
it.each([['release hold'],null] as const)('refuses a canonical hold or unknown hold state %j',async holds=>{
 const f=await fixture();f.snapshot.holds=holds;const job=f.control.submit(input);expect((await done(f.jobs,job.id)).result).toMatchObject({ok:false,status:'not-submitted'});expect(f.resume).not.toHaveBeenCalled();
});
it('refuses native permission waits',async()=>{
 const f=await fixture();f.snapshot.session.needsPermission=true;const job=f.control.submit(input);expect((await done(f.jobs,job.id)).result).toMatchObject({ok:false,status:'not-submitted'});expect(f.resume).not.toHaveBeenCalled();
});
it('reports stale without native writes',async()=>{
 const f=await fixture();f.snapshot.state!.baseRevision=8;const job=f.control.submit(input);expect((await done(f.jobs,job.id)).result).toMatchObject({ok:false,status:'stale-no-write'});expect(f.resume).not.toHaveBeenCalled();
});
it('keeps unloaded sessions unsupported and never activates a runtime',async()=>{
 const f=await fixture();f.snapshot.state=null;const job=f.control.submit(input);expect((await done(f.jobs,job.id)).result).toMatchObject({ok:false,status:'not-submitted'});expect(f.resume).not.toHaveBeenCalled();
});
it('returns an interrupted attempt after restart without executing it again',async()=>{
 const f=await fixture();f.resume.mockImplementation(()=>new Promise(()=>{}));const job=f.control.submit(input);await vi.waitFor(()=>expect(f.resume).toHaveBeenCalledOnce());
 const restored=new HerderJobRegistry(new HerderEventBus(),{persistencePath:f.path});const replay=new SessionQueueControl({...f,jobs:restored}).submit(input);expect(replay.state).toBe('interrupted');expect(replay.result).toMatchObject({nativeOutcome:'unknown',replay:'forbidden'});expect(f.resume).toHaveBeenCalledTimes(1);
});
it('fails before dispatch when no durable registry exists',async()=>{
 const f=await fixture();const control=new SessionQueueControl({...f,jobs:new HerderJobRegistry(new HerderEventBus())});expect(()=>control.submit(input)).toThrow(/durable_registry_required/);expect(f.resume).not.toHaveBeenCalled();
});

it('rechecks canonical holds after a successful read instead of trusting a prior UI view',async()=>{
 const f=await fixture();expect(await f.control.read(target)).toMatchObject({canResume:true,humanStopHeld:false,state:{baseRevision:7}});
 f.snapshot.holds=['release hold appeared after inspection'];const job=f.control.submit(input);
 expect((await done(f.jobs,job.id)).result).toMatchObject({ok:false,status:'not-submitted'});expect(f.readTarget).toHaveBeenCalledTimes(2);expect(f.resume).not.toHaveBeenCalled();
});
it('keeps a readonly unloaded view unsupported without attempting resume',async()=>{
 const f=await fixture();f.snapshot.state=null;expect(await f.control.read(target)).toMatchObject({canResume:false,state:null});expect(f.resume).not.toHaveBeenCalled();
});
