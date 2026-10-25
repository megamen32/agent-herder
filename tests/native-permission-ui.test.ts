import {expect,it,vi} from 'vitest';
import {createNativePermissionApproval} from '../src/web-ui/native-permission.js';
const target={harness:'zcode',sessionId:'native/id',requestId:'permission/id'};

it('answers the captured exact request once, without granting persistent rights',async()=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({ok:true}),{status:200}));
 const approve=createNativePermissionApproval(fetcher as typeof fetch);
 const [first,second]=await Promise.all([approve(target),approve(target)]);
 expect(first.state).toBe('sent');expect(second.state).toBe('sent');
 expect(fetcher).toHaveBeenCalledTimes(1);
 expect(fetcher).toHaveBeenCalledWith('/api/sessions/zcode/native%2Fid/permissions/permission%2Fid',expect.objectContaining({method:'POST',body:JSON.stringify({response:'allow',remember:false})}));
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
