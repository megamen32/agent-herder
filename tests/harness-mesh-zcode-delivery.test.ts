import {it,expect,vi} from 'vitest';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {LocalHarnessMesh} from '../src/mesh/local.js';
const row={id:'current',harness:'zcode',status:'running',title:'Task',cwd:'/owned',hostId:'h',lastActivity:new Date().toISOString(),needsPermission:false,meta:{activityEvidence:'zcode-official-supervisor-running-tasks',nativeActivityFresh:true,nativeExecutor:'official-server'}};
const request={target:{hostId:'h',harness:'zcode',nativeSessionId:'current'},sender:{hostId:'s',harness:'codex',nativeSessionId:'sender'},inputId:'stable',message:'bounded delta'};
it('advertises and routes only verified official ZCode V4 admission, retaining accepted input without requiring a fabricated turnId',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mesh-zc-'));let ready=true;const sendMessage=vi.fn(async(_id:string,o:any)=>({ok:true,admitted:true,admission:'accepted',inputId:o.inputId}));const adapter={type:'zcode',lazyStart:true,isReady:()=>false,getOfficialMeshAdmission:()=>ready?'official-ws-v4':undefined,listSessions:async()=>[row],getSession:async()=>row,sendMessage};
 try{const mesh=new LocalHarnessMesh({hostId:'h',adapters:new Map([['zcode',adapter]]) as any,ledgerPath:join(dir,'ledger.json')});
  expect((await mesh.snapshot()).harnesses).toContainEqual(expect.objectContaining({harness:'zcode',discovery:'available',delivery:'available'}));
  expect(await mesh.deliver(request)).toMatchObject({state:'admitted',inputId:'stable',retryable:false});expect(sendMessage.mock.calls[0]).toMatchObject(['current',{queue:true,inputId:'stable',origin:'automation'}]);
  ready=false;expect((await mesh.deliver(request)).state).toBe('admitted');expect(sendMessage).toHaveBeenCalledTimes(1);
 }finally{await rm(dir,{recursive:true,force:true})}
});
it('never replays an uncertain official ZCode input or enables an unsupported adapter',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mesh-zcu-'));const sendMessage=vi.fn(async()=>({ok:false,admissionUnknown:true,nonRetryable:true,inputId:'stable'}));const adapter={type:'zcode',getOfficialMeshAdmission:()=> 'official-ws-v4',getSession:async()=>row,sendMessage};
 try{const mesh=new LocalHarnessMesh({hostId:'h',adapters:new Map([['zcode',adapter],['opencode',adapter]]) as any,ledgerPath:join(dir,'ledger.json')});
  expect(await mesh.deliver(request)).toMatchObject({state:'unknown',retryable:false});expect(await mesh.deliver(request)).toMatchObject({state:'unknown',retryable:false});expect(sendMessage).toHaveBeenCalledTimes(1);
  expect((await mesh.deliver({...request,inputId:'other',target:{...request.target,harness:'opencode'}})).state).toBe('not_attempted');expect(sendMessage).toHaveBeenCalledTimes(1);
 }finally{await rm(dir,{recursive:true,force:true})}
});
