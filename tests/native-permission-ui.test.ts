import {expect,it,vi} from 'vitest';
import {createNativePermissionApproval,nativePermissionActionability} from '../src/web-ui/native-permission.js';
const target={hostId:'host-a',harness:'zcode',sessionId:'native/id',requestId:'permission/id'};

it('requires an exact fresh native request that the harness says is answerable',()=>{
 const state={target:{hostId:'host-a',harness:'zcode',sessionId:target.sessionId},pendingRequests:[{id:target.requestId,canRespond:true}]};
 expect(nativePermissionActionability(state,target)).toBe('actionable');
 expect(nativePermissionActionability({...state,pendingRequests:[{id:target.requestId,canRespond:false,unsupportedReason:'native subset required'}]},target)).toBe('unsupported');
 expect(nativePermissionActionability({...state,target:{...state.target,hostId:'host-b'}},target)).toBe('stale');
 expect(nativePermissionActionability({...state,pendingRequests:[{id:'different-request',canRespond:true}]},target)).toBe('stale');
 expect(nativePermissionActionability(null,target)).toBe('unavailable');
});

it('answers the captured exact request once, without granting persistent rights',async()=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({ok:true}),{status:200}));
 const approve=createNativePermissionApproval(fetcher as typeof fetch);
 const [first,second]=await Promise.all([approve(target),approve(target)]);
 expect(first.state).toBe('sent');expect(second.state).toBe('sent');
 expect(fetcher).toHaveBeenCalledTimes(1);
 expect(fetcher).toHaveBeenCalledWith('/api/sessions/zcode/native%2Fid/permissions/permission%2Fid',expect.objectContaining({method:'POST',body:JSON.stringify({hostId:'host-a',response:'allow',remember:false})}));
});

it('does not replay a lost reply, including after the UI is remounted',async()=>{
 const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
 const fetcher=vi.fn(async()=>{throw Error('reply lost');});
 expect((await createNativePermissionApproval(fetcher as typeof fetch,storage)(target)).state).toBe('unknown');
 expect((await createNativePermissionApproval(fetcher as typeof fetch,storage)(target)).state).toBe('unknown');
 expect(fetcher).toHaveBeenCalledTimes(1);
 await createNativePermissionApproval(fetcher as typeof fetch,storage)({...target,requestId:'a-new-request'});
 expect(fetcher).toHaveBeenCalledTimes(2);
});

it('can send one exact denial and will not admit the opposite answer afterwards',async()=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({ok:true}),{status:200}));
 const approve=createNativePermissionApproval(fetcher as typeof fetch);
 expect((await approve(target,'deny')).state).toBe('sent');
 expect(fetcher).toHaveBeenCalledTimes(1);
 expect(fetcher).toHaveBeenCalledWith('/api/sessions/zcode/native%2Fid/permissions/permission%2Fid',expect.objectContaining({body:JSON.stringify({hostId:'host-a',response:'deny',remember:false})}));
 expect((await approve(target,'allow')).response).toBe('deny');
 expect(fetcher).toHaveBeenCalledTimes(1);
});

it('blocks a replay when a legacy attempt is not bound to a host',async()=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({ok:true}),{status:200}));
 const oldKey='agent-herder.permission.'+JSON.stringify(['zcode','native/id','permission/id']);
 const values=new Map([[oldKey,'sent:deny']]);
 const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)};
 const result=await createNativePermissionApproval(fetcher as typeof fetch,storage)(target);
 expect(result.state).toBe('unknown');
 expect(fetcher).not.toHaveBeenCalled();
});
