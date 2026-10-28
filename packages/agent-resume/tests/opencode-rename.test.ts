import {afterEach, expect, it, vi} from 'vitest';
import {OpenCodeClient} from '../src/harness/opencode/client.js';
afterEach(()=>vi.unstubAllGlobals());
it('renames the exact native session through PATCH without a turn or recreation',async()=>{
  const calls:Array<{url:string;method:string;body?:string}>=[];
  vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    calls.push({url:String(input),method:init?.method??'GET',body:init?.body as string});
    return new Response(JSON.stringify({data:{id:'ses_exact',title:'Проверить доступность сайта',location:{directory:'/qa'}}}),{headers:{'Content-Type':'application/json'}});
  }));
  const c=new OpenCodeClient({baseUrl:'http://native.test',protocol:'v2'});
  await c.renameSession('ses_exact','Проверить доступность сайта');
  expect(calls).toEqual([{url:'http://native.test/api/session/ses_exact',method:'PATCH',body:JSON.stringify({title:'Проверить доступность сайта'})}]);
});
