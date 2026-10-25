import {expect,it,vi} from 'vitest';
import {SessionSupervisor} from '../src/session-supervisor.js';
import {localSessionHostId} from '../src/types/index.js';

function fixture(id:string){
 const current:any={id,harness:'zcode',hostId:localSessionHostId(),cwd:'/fixture',title:'permission fixture',status:'needs_input',needsPermission:true,lastActivity:new Date().toISOString(),permissionDetails:{id:'perm-'+id,type:'permission',description:'fixture'}};
 const reply=vi.fn(async()=>{current.needsPermission=false;current.permissionDetails=undefined;current.status='idle';return {ok:true};});
 const adapter:any={type:'zcode',name:'fixture',getSession:async()=>({...current}),respondPermission:reply};
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
