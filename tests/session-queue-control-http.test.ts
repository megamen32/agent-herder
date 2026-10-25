import {afterEach,describe,expect,it,vi} from 'vitest';
import {createWebServer} from '../src/web/server.js';
import {HerderEventBus} from '../src/herder-events.js';
import {HerderJobRegistry} from '../src/herder-jobs.js';

const servers:ReturnType<typeof createWebServer>[]=[];
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}});

describe('session queue processing HTTP API',()=>{
 it('requires an exact host and forwards reads, CAS resumes and owner-scoped job reads through one gateway',async()=>{
  const directory=(await import('node:fs/promises')).mkdtemp;
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const root=await directory(join(tmpdir(),'herder-queue-http-'));
  const read=vi.fn(async(target:any)=>({target,state:{autoDrain:false,baseRevision:4,pendingCount:1,oldestQueueItemId:'item-4',nativeState:'completedSuccess',loaded:true,capability:'setAutoDrain'},canResume:true,humanStopHeld:false}));
  const submit=vi.fn(async(input:any)=>({target:{hostId:input.hostId,harness:input.harness,sessionId:input.sessionId},inputId:input.inputId,state:'queued',nonRetryable:false,job:{id:'job_remote',state:'queued',resultRef:'herder://jobs/job_remote'}}));
  const job=vi.fn(async(target:any,inputId:string,jobId:string)=>({job:{id:jobId,state:'completed',hostId:target.hostId,ownerSessionId:target.sessionId,inputId}}));
  const gateway={read,submit,job};
  const server=createWebServer({adapters:new Map(),converter:{} as never,jobs:new HerderJobRegistry(new HerderEventBus(),{persistencePath:join(root,'jobs.json')}),sessionQueueControl:gateway as never,sessionObservationManagedExternally:true});
  servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw Error('server did not bind');
  const base=`http://127.0.0.1:${address.port}`;const path='/api/sessions/zcode/fixture-session/queue-processing';
  try{
   expect((await fetch(base+path)).status).toBe(400);
   const get=await fetch(base+path+'?hostId=server-44');expect(get.status).toBe(200);expect(await get.json()).toMatchObject({target:{hostId:'server-44',harness:'zcode',sessionId:'fixture-session'},canResume:true,state:{baseRevision:4}});
   const post=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({hostId:'server-44',inputId:'queue-resume-http-1',expectedRevision:4})});
   expect(post.status).toBe(202);expect(await post.json()).toMatchObject({state:'queued',job:{id:'job_remote'},target:{hostId:'server-44'}});
   const poll=await fetch(base+'/api/jobs/job_remote?hostId=server-44&harness=zcode&sessionId=fixture-session&inputId=queue-resume-http-1');expect(poll.status).toBe(200);expect(await poll.json()).toMatchObject({job:{id:'job_remote',hostId:'server-44',ownerSessionId:'fixture-session'}});
   expect(read).toHaveBeenCalledOnce();expect(submit).toHaveBeenCalledOnce();expect(job).toHaveBeenCalledOnce();
   expect(submit.mock.calls[0]?.[0]).toMatchObject({hostId:'server-44',sessionId:'fixture-session',inputId:'queue-resume-http-1',expectedRevision:4});
  }finally{await (await import('node:fs/promises')).rm(root,{recursive:true,force:true});}
 });

 it('preserves terminal unknown as a non-retryable result instead of inventing a second action',async()=>{
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const root=await mkdtemp(join(tmpdir(),'herder-queue-http-unknown-'));
  const submit=vi.fn(async(input:any)=>({target:{hostId:input.hostId,harness:input.harness,sessionId:input.sessionId},inputId:input.inputId,state:'unknown',nonRetryable:true,error:'owner receipt unavailable'}));
  const server=createWebServer({adapters:new Map(),converter:{} as never,jobs:new HerderJobRegistry(new HerderEventBus(),{persistencePath:join(root,'jobs.json')}),sessionQueueControl:{read:async()=>{throw Error('unused')},submit,job:async()=>({job:null})} as never,sessionObservationManagedExternally:true});
  servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw Error('server did not bind');
  try{
   const response=await fetch(`http://127.0.0.1:${address.port}/api/sessions/zcode/s/queue-processing`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({hostId:'server-44',inputId:'queue-unknown-once',expectedRevision:9})});
   expect(response.status).toBe(200);expect(await response.json()).toMatchObject({state:'unknown',nonRetryable:true,inputId:'queue-unknown-once'});expect(submit).toHaveBeenCalledOnce();
  }finally{await rm(root,{recursive:true,force:true});}
 });
});
