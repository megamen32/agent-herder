import {describe,expect,it,vi} from 'vitest';
import {SessionQueueControlGateway} from '../src/session-queue-control-gateway.js';
import {sessionQueueControlJobId,type SessionQueueControl} from '../src/session-queue-control.js';
import type {HerderJobRegistry} from '../src/herder-jobs.js';
import type {GptAdminTransport} from '../src/mesh/gptadmin.js';

const target={hostId:'server-100',harness:'zcode',sessionId:'fixture-session'} as const;
const input={...target,inputId:'resume-fixture-1',expectedRevision:17};
const state={autoDrain:false,baseRevision:17,pendingCount:1,oldestQueueItemId:'native-item-1',nativeState:'completedSuccess',loaded:true as const,capability:'setAutoDrain' as const};

function gateway(transport?:GptAdminTransport){
 const local={read:vi.fn(async()=>({target,state,canResume:true,humanStopHeld:false})),submit:vi.fn(()=>({id:'job_local',state:'queued',resultRef:'herder://jobs/job_local'}))};
 const jobs={get:vi.fn((id:string)=>id==='job_local'?{id,ownerSessionId:target.sessionId,kind:'Возобновление очереди (zcode)',state:'completed'}:null)};
 const peers=[{hostId:'server-44',target:'mcp:shell:server-44:AgentHerder'}];
 const service=new SessionQueueControlGateway({ownerHostId:'server-100',local:local as unknown as SessionQueueControl,jobs:jobs as unknown as HerderJobRegistry,transport,peers});
 return {service,local,jobs,peers};
}

describe('native queue owner gateway',()=>{
 it('uses the shared local control and job registry for local requests',async()=>{
  const f=gateway();
  expect(await f.service.read(target)).toMatchObject({target,state,canResume:true});
  expect(await f.service.submit(input)).toMatchObject({target,inputId:input.inputId,state:'queued',job:{id:'job_local'}});
  const actualLocalJobId=(await import('../src/session-queue-control.js')).sessionQueueControlJobId({...target,inputId:input.inputId,expectedRevision:0});
  const localJobGateway=gateway();localJobGateway.jobs.get.mockImplementation((id:string)=>({id,ownerSessionId:target.sessionId,kind:'Возобновление очереди (zcode)',state:'completed'}) as any);
  // A caller-selected job id cannot be used to inspect unrelated local jobs.
  expect(await f.service.job(target,input.inputId,'job_local')).toMatchObject({available:false});
  expect(await localJobGateway.service.job(target,input.inputId,actualLocalJobId)).toMatchObject({job:{id:actualLocalJobId,ownerSessionId:target.sessionId}});
  expect(f.local.read).toHaveBeenCalledOnce();expect(f.local.submit).toHaveBeenCalledOnce();expect(f.jobs.get).not.toHaveBeenCalled();expect(localJobGateway.jobs.get).toHaveBeenCalledOnce();
 });

 it('forwards remote reads and resume once to the exact native owner',async()=>{
  const call=vi.fn(async(_target:string,_tool:string,args:Record<string,unknown>)=>({structuredContent:{target:args,state,canResume:true,humanStopHeld:false}}));
  const f=gateway({call} as unknown as GptAdminTransport);
  const remoteInput={...input,hostId:'server-44'};
  expect(await f.service.read({...target,hostId:'server-44'})).toMatchObject({target:{hostId:'server-44',sessionId:target.sessionId},canResume:true});
  const expectedJobId=sessionQueueControlJobId(remoteInput);
  call.mockResolvedValueOnce({structuredContent:{target:{...target,hostId:'server-44'},inputId:input.inputId,state:'queued',nonRetryable:false,job:{id:expectedJobId,state:'queued',resultRef:`herder://jobs/${expectedJobId}`}}});
  expect(await f.service.submit(remoteInput)).toMatchObject({state:'queued',job:{id:expectedJobId}});
  const mismatchInput={...remoteInput,inputId:'resume-fixture-mismatch'};
  call.mockResolvedValueOnce({structuredContent:{target:{...target,hostId:'server-44'},inputId:mismatchInput.inputId,state:'queued',nonRetryable:false,job:{id:'job_wrong',state:'queued',resultRef:'herder://jobs/job_wrong'}}});
  expect(await f.service.submit(mismatchInput)).toMatchObject({state:'unknown',nonRetryable:true,inputId:mismatchInput.inputId});
  expect(call.mock.calls.map(row=>row[1])).toEqual(['session_queue_processing_get','session_queue_processing_resume','session_queue_processing_resume']);
  expect(call.mock.calls[1]?.[2]).toMatchObject({hostId:'server-44',sessionId:input.sessionId,inputId:input.inputId,expectedRevision:17});
  expect(f.local.submit).not.toHaveBeenCalled();
 });

 it('makes an ambiguous remote submit terminal and does not retry it',async()=>{
  const call=vi.fn(async()=>{throw new Error('transport timed out');});
  const f=gateway({call} as unknown as GptAdminTransport);
  expect(await f.service.submit({...input,hostId:'server-44'})).toMatchObject({state:'unknown',nonRetryable:true,inputId:input.inputId});
  expect(call).toHaveBeenCalledOnce();
  expect(f.local.submit).not.toHaveBeenCalled();
 });

 it('rejects mismatched remote read targets and job identities',async()=>{
  const call=vi.fn(async(_target:string,tool:string)=>tool==='session_queue_processing_get'
    ?{structuredContent:{target:{...target,sessionId:'other'},state,canResume:true}}
    :{structuredContent:{job:{id:'other-job',ownerSessionId:target.sessionId,kind:'Возобновление очереди (zcode)'}}});
  const f=gateway({call} as unknown as GptAdminTransport);
  expect(await f.service.read({...target,hostId:'server-44'})).toMatchObject({available:false});
  const exactJob=(await import('../src/session-queue-control.js')).sessionQueueControlJobId({...target,hostId:'server-44',inputId:input.inputId,expectedRevision:0});
  expect(await f.service.job({...target,hostId:'server-44'},input.inputId,exactJob)).toMatchObject({available:false});
 });
});
