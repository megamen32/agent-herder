import {expect,it,vi} from 'vitest';
import {SessionSupervisor} from '../src/session-supervisor.js';
import {localSessionHostId} from '../src/types/index.js';

function fixture(id:string){
 const current:any={id,harness:'zcode',hostId:localSessionHostId(),cwd:'/fixture',title:'permission fixture',status:'needs_input',needsPermission:true,lastActivity:new Date().toISOString(),permissionDetails:{id:'perm-'+id,type:'permission',description:'fixture'}};
 const reply=vi.fn(async()=>{current.needsPermission=false;current.permissionDetails=undefined;current.status='idle';return {ok:true};});
 const adapter:any={type:'zcode',name:'fixture',getSession:async()=>({...current}),getPermissionState:async()=>({
  target:{hostId:current.hostId,harness:'zcode',sessionId:current.id},scope:'session',canSetMode:false,
  pendingRequests:current.needsPermission?[{id:current.permissionDetails?.id,canRespond:true,nativeMethod:'fixtures/respond'}]:[],
  observedAt:new Date().toISOString(),
 }),respondPermission:reply};
 const create=()=>new SessionSupervisor(new Map([['zcode',adapter]]),{convert:async()=>({success:true})} as any);
 return {current,reply,create,supervisor:create()};
}

it('does not send a response to a stale native permission',async()=>{
 const f=fixture('stale');
 const result=await f.supervisor.respondPermission('zcode','stale','old-request','allow');
 expect(result.ok).toBe(false);expect(f.reply).not.toHaveBeenCalled();
});

it('rejects an exact-ID read that belongs to another native session',async()=>{
 const f=fixture('identity');f.current.id='foreign';
 expect((await f.supervisor.respondPermission('zcode','identity','perm-identity','allow')).ok).toBe(false);
 expect(f.reply).not.toHaveBeenCalled();
});

it('remembers the accepted decision across supervisor instances and refuses a conflicting reply',async()=>{
 const f=fixture('accepted');
 expect((await f.supervisor.respondPermission('zcode','accepted','perm-accepted','allow')).ok).toBe(true);
 expect((await f.create().respondPermission('zcode','accepted','perm-accepted','allow')).ok).toBe(true);
 expect((await f.create().respondPermission('zcode','accepted','perm-accepted','deny')).ok).toBe(false);
 expect(f.reply).toHaveBeenCalledTimes(1);
});

it('does not replay a native write with unknown outcome after recreating the controller',async()=>{
 const f=fixture('unknown');f.reply.mockImplementation(async()=>{throw Error('connection lost after response write');});
 expect((await f.supervisor.respondPermission('zcode','unknown','perm-unknown','allow')).ok).toBe(false);
 expect((await f.create().respondPermission('zcode','unknown','perm-unknown','allow')).ok).toBe(false);
 expect(f.reply).toHaveBeenCalledTimes(1);
});

it('sends concurrent clicks for the same request at most once',async()=>{
 const f=fixture('concurrent');
 const results=await Promise.all([f.supervisor.respondPermission('zcode','concurrent','perm-concurrent','allow'),f.create().respondPermission('zcode','concurrent','perm-concurrent','allow')]);
 expect(results.some(r=>r.ok)).toBe(true);expect(f.reply).toHaveBeenCalledTimes(1);
});

it('does not retry a native response that returned an ambiguous failure',async()=>{
 const f=fixture('rejected');f.reply.mockImplementation(async()=>({ok:false,error:'native response failed'}));
 expect((await f.supervisor.respondPermission('zcode','rejected','perm-rejected','allow')).ok).toBe(false);
 expect((await f.create().respondPermission('zcode','rejected','perm-rejected','allow')).ok).toBe(false);
 expect(f.reply).toHaveBeenCalledTimes(1);
});

it('refuses the response if the selected host changes before the locked native read',async()=>{
 const f=fixture('host-drift');let reads=0;
 const adapter:any={type:'zcode',name:'fixture',getPermissionState:async()=>({
  target:{hostId:++reads===1?'selected-host':'different-host',harness:'zcode',sessionId:'host-drift'},scope:'session',canSetMode:false,
  pendingRequests:[{id:'perm-host-drift',canRespond:true,nativeMethod:'fixtures/respond'}],observedAt:new Date().toISOString(),
 }),respondPermission:f.reply};
 const supervisor=new SessionSupervisor(new Map([['zcode',adapter]]),{convert:async()=>({success:true})} as any);
 const result=await supervisor.respondPermission('zcode','host-drift','perm-host-drift','allow');
 expect(result.ok).toBe(false);expect(f.reply).not.toHaveBeenCalled();
});

it('does not call an adapter for an exact pending request it marks non-resolvable',async()=>{
 const f=fixture('unsupported');
 const adapter:any={type:'zcode',name:'fixture',getSession:async()=>({...f.current}),getPermissionState:async()=>({
  target:{hostId:f.current.hostId,harness:'zcode',sessionId:'unsupported'},scope:'session',canSetMode:false,
  pendingRequests:[{id:'perm-unsupported',canRespond:false,unsupportedReason:'requires a permission subset',nativeMethod:'item/permissions/requestApproval'}],observedAt:new Date().toISOString(),
 }),respondPermission:f.reply};
 const supervisor=new SessionSupervisor(new Map([['zcode',adapter]]),{convert:async()=>({success:true})} as any);
 const result=await supervisor.respondPermission('zcode','unsupported','perm-unsupported','allow');
 expect(result.ok).toBe(false);expect(f.reply).not.toHaveBeenCalled();
});

it('fails closed when a native adapter cannot prove that the pending request is answerable',async()=>{
 const f=fixture('unproven');
 const adapter:any={type:'zcode',name:'legacy-fixture',getSession:async()=>({...f.current}),respondPermission:f.reply};
 const supervisor=new SessionSupervisor(new Map([['zcode',adapter]]),{convert:async()=>({success:true})} as any);
 const result=await supervisor.respondPermission('zcode','unproven','perm-unproven','allow');
 expect(result.ok).toBe(false);expect(f.reply).not.toHaveBeenCalled();
});
