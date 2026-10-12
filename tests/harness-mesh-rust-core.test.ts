// Fast units only: injected HTTP boundaries are not deployed Rust/fleet proof.
import {EventEmitter} from 'node:events';
import type {ClientRequest,IncomingMessage,RequestOptions} from 'node:http';
import {describe,it,expect,vi,afterEach} from 'vitest';
import {RustCoreClient} from '../src/mesh/rust-core-client.js';
import {FleetCabinetService} from '../src/mesh/fleet-service.js';

type Result=(input:Record<string,unknown>)=>Record<string,unknown>;
function boundary(result:Result){
 const options:RequestOptions[]=[];const bodies:Record<string,unknown>[]=[];const destroyed=vi.fn();
 const request=(opts:RequestOptions,callback:(response:IncomingMessage)=>void)=>{
  options.push(opts);const req=new EventEmitter() as ClientRequest;
  req.destroy=destroyed as any;
  req.end=((body:Buffer)=>{
   const input=JSON.parse(body.toString());bodies.push(input);
   queueMicrotask(()=>{const response=new EventEmitter() as IncomingMessage;response.statusCode=200;response.destroy=destroyed as any;callback(response);response.emit('data',Buffer.from(JSON.stringify(result(input))));response.emit('end');});
   return req;
  }) as any;return req;
 };
 return {request,options,bodies,destroyed};
}
const matching=(input:Record<string,unknown>)=>({request_id:input.request_id,origin_host:input.origin_host,hop_count:0,hosts:[input.hosts]});
afterEach(()=>vi.useRealTimers());
describe('private shared Rust host selection',()=>{
 it('keeps each exact request/host and sends no auth/profile/session headers',async()=>{
  const fake=boundary(matching);const core=new RustCoreClient('/private/core.sock','native-100',fake.request);
  expect(await core.resolveHost('44',['44','88'],'input-44')).toBe('44');
  expect(await core.resolveHost('88',['44','88'],'input-88')).toBe('88');
  expect(fake.bodies.map(b=>b.request_id)).toEqual(['input-44','input-88']);
  expect(fake.bodies.map(b=>b.hosts)).toEqual(['44','88']);
  expect(fake.options[0]!.headers).toEqual({'Content-Type':'application/json','Content-Length':expect.any(Number)});
  expect(fake.options[0]!.agent).toBe(false);expect(fake.options[0]!.socketPath).toBe('/private/core.sock');
 });
 it('denies a host outside authenticated configured hosts before IPC',async()=>{
  const fake=boundary(matching);const core=new RustCoreClient('/private/core.sock','100',fake.request);
  await expect(core.resolveHost('foreign',['44'],'input')).rejects.toThrow('rust_core_host_denied');expect(fake.bodies).toHaveLength(0);
 });
 it('refuses mismatching ID, origin, hop or retargeted response',async()=>{
  for(const bad of [{request_id:'other'},{origin_host:'other'},{hop_count:1},{hosts:['88']}]){
   const fake=boundary(input=>({...matching(input),...bad}));const core=new RustCoreClient('/private/core.sock','100',fake.request);
   await expect(core.resolveHost('44',['44','88'],'exact')).rejects.toThrow('rust_core_route_unverified');expect(fake.bodies).toHaveLength(1);
  }
 });
 it('bounds three inflight calls and total deadline without retries',async()=>{
  vi.useFakeTimers();const requests:ClientRequest[]=[];
  const fake=()=>{const req=new EventEmitter() as ClientRequest;req.destroy=vi.fn() as any;req.end=vi.fn() as any;requests.push(req);return req;};
  const core=new RustCoreClient('/private/core.sock','100',fake);
  const pending=[1,2,3].map(n=>core.resolveHost('44',['44'],String(n)).catch(e=>e.message));
  await expect(core.resolveHost('44',['44'],'4')).rejects.toThrow('rust_core_busy');
  await vi.advanceTimersByTimeAsync(3000);expect(await Promise.all(pending)).toEqual(['rust_core_deadline','rust_core_deadline','rust_core_deadline']);
  expect(requests).toHaveLength(3);for(const req of requests)expect(req.destroy).toHaveBeenCalledOnce();
 });
 it('fails before peer read when core is unavailable or retargets',async()=>{
  const readSession=vi.fn(async()=>({}));const transportFactory=vi.fn(()=>({readSession} as any));
  for(const rustCore of [{resolveHost:vi.fn(async()=>{throw new Error('core down');})},{resolveHost:vi.fn(async()=> '88')}]){
   const fleet=new FleetCabinetService({hosts:[{hostId:'44',label:'44'}],scope:{profileId:'approved',userId:'owner'},transportFactory,rustCore});
   await expect(fleet.readSession({hostId:'44',harness:'codex',nativeSessionId:'existing'})).rejects.toThrow();
  }
  expect(transportFactory).not.toHaveBeenCalled();expect(readSession).not.toHaveBeenCalled();
 });
 it('rejects selected inventory before discovery when the configured core is down',async()=>{
  const transportFactory=vi.fn();const fleet=new FleetCabinetService({hosts:[{hostId:'44',label:'44'}],scope:{profileId:'approved',userId:'owner'},transportFactory,rustCore:{resolveHost:async()=>{throw new Error('core down');}}});
  await expect(fleet.inventory({hostId:'44'})).rejects.toThrow('core down');expect(transportFactory).not.toHaveBeenCalled();
 });
 it('destroys a response arriving after the total deadline and handles late errors',async()=>{
  vi.useFakeTimers();let callback!:(response:IncomingMessage)=>void;
  const request=(_options:RequestOptions,cb:typeof callback)=>{callback=cb;const req=new EventEmitter() as ClientRequest;req.destroy=vi.fn() as any;req.end=vi.fn() as any;return req;};
  const core=new RustCoreClient('/private/core.sock','100',request);
  const pending=core.resolveHost('44',['44']).catch(e=>e.message);await vi.advanceTimersByTimeAsync(3000);expect(await pending).toBe('rust_core_deadline');
  const incoming=new EventEmitter() as IncomingMessage;incoming.destroy=vi.fn() as any;callback(incoming);expect(incoming.destroy).toHaveBeenCalledOnce();
  expect(()=>incoming.emit('error',new Error('late private error'))).not.toThrow();
 });
 it('preserves the prior direct source path when no core is configured',async()=>{
  const readSession=vi.fn(async()=>({existing:true}));const fleet=new FleetCabinetService({hosts:[{hostId:'44',label:'44'}],scope:{profileId:'approved',userId:'owner'},transportFactory:()=>({readSession} as any)});
  await expect(fleet.readSession({hostId:'44',harness:'codex',nativeSessionId:'existing'})).resolves.toEqual({existing:true});expect(readSession).toHaveBeenCalledOnce();
 });
});
