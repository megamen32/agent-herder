// Fast unit, expected 2s/max 10s: actual owned loopback HTTP with injected
// throwing route logic. This tests local response lifecycle, not fleet health.
import {afterEach,describe,expect,it} from 'vitest';
import type {Server} from 'node:http';
import {createWebServer} from '../src/web/server.js';
let server:Server|undefined;
afterEach(async()=>{if(server){server.closeAllConnections();await new Promise<void>(r=>server!.close(()=>r()));server=undefined;}});
async function start(){
 server=createWebServer({adapters:new Map(),converter:{} as any,supervisor:{} as any,
  fleetApiHandler:async(request,response)=>{
   if(request.url==='/unit/normal'){response.writeHead(204);response.end();return true;}
   if(request.url==='/unit/early')throw new Error('unit-only early error');
   response.writeHead(200);response.write('unit-only partial response');
   await Promise.resolve();throw new Error('unit-only late error');
  }});
 await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));
 return 'http://127.0.0.1:'+(server.address() as {port:number}).port;
}
describe('owned HTTP response lifecycle',()=>{
 it('closes a partial late-failed response without a second status or an unhandled rejection',async()=>{
  const origin=await start();
  await fetch(origin+'/unit/late').then(r=>r.text()).catch(()=>undefined);
  expect((await fetch(origin+'/unit/normal')).status).toBe(204);
 });
 it('preserves the existing error response before headers have been sent',async()=>{
  const origin=await start(),response=await fetch(origin+'/unit/early');
  expect(response.status).toBe(502);expect(await response.json()).toEqual({error:'unit-only early error'});
 });
});
