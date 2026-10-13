import {describe,it,expect,vi,afterEach} from 'vitest';
import {FleetCabinetService} from '../src/mesh/fleet-service.js';
import {fleetSessionControlSchema} from '../src/mesh/fleet-session-control.js';
import {remoteSessionStorage,remoteSessionRequest} from '../src/web-ui/fleet/session-control.js';
import {readStoredOutbox,writeStoredOutbox,classifyMessageDelivery} from '../src/web-ui/composer-delivery.js';
const address={hostId:'server-44',harness:'codex',nativeSessionId:'same-id'};
afterEach(()=>vi.unstubAllGlobals());
describe('remote chat route fences (focused integration; expected2s/max20s)',()=>{
 it('rejects replacement-session operations and messages without stable input',()=>{
  expect(fleetSessionControlSchema.safeParse({operation:'create'}).success).toBe(false);
  expect(fleetSessionControlSchema.safeParse({operation:'message',message:'hello'}).success).toBe(false);
  expect(fleetSessionControlSchema.safeParse({operation:'resume',inputId:'once'}).success).toBe(true);
 });
 it('persists outbox by owner scope + host + harness + native ID and does not touch local outbox',()=>{
  const map=new Map<string,string>();const storage={getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>map.set(k,v)} as Storage;
  const a=remoteSessionStorage(storage,'owner',address),b=remoteSessionStorage(storage,'owner',{...address,hostId:'roomhacker-server-88'}),c=remoteSessionStorage(storage,'other',address);
  writeStoredOutbox(a,[{inputId:'once',sessionKey:'remote',text:'work',mode:'queue',createdAt:Date.now(),status:'sending'}]);
  expect(readStoredOutbox(a)[0].inputId).toBe('once');expect(readStoredOutbox(b)).toEqual([]);expect(readStoredOutbox(c)).toEqual([]);expect(readStoredOutbox(storage)).toEqual([]);
 });
 it('uses same-origin full address and keeps a lost admission receipt unknown',async()=>{
  const fetch=vi.fn(async()=>({status:502,json:async()=>({admissionUnknown:true,nonRetryable:true})}));vi.stubGlobal('fetch',fetch);
  const result=await remoteSessionRequest('/api/fleet',address,{operation:'message',message:'hello',inputId:'once',mode:'queue'});
  expect(fetch).toHaveBeenCalledTimes(1);const [url,init]=fetch.mock.calls[0] as unknown as [string,RequestInit];
  expect(url).toContain('hostId=server-44');expect(url).toContain('sessionId=same-id');expect(init.method).toBe('POST');expect(init.credentials).toBe('same-origin');expect(classifyMessageDelivery(result.body,false).status).toBe('unknown');
 });
 it('captures address before an awaited core selection and refuses wrong-owner response',async()=>{
  const request=vi.fn(async()=>({hostId:'server-44',status:200,body:{ok:true}}));
  const service=new FleetCabinetService({hosts:[{hostId:'server-44',label:'44',nativeUser:'roomhacker'},{hostId:'roomhacker-server-88',label:'88',nativeUser:'roomhacker'}],scope:{profileId:'owner',userId:'me'},transportFactory:()=>({discover:async()=>({}),schema:async()=>({}),call:async()=>({}),requestSession:request})});
  let release!:()=>void;vi.spyOn(service as any,'selectedHost').mockImplementation(()=>new Promise<void>(r=>{release=r;}));
  const mutable={...address},pending=service.requestSession(mutable,{operation:'stop',inputId:'stop-once'});mutable.hostId='roomhacker-server-88';release();await pending;
  expect(request.mock.calls[0]?.[0]).toBe('mcp:shell:server-44:AgentHerder');
  request.mockResolvedValue({hostId:'roomhacker-server-88',status:200,body:{ok:true}});vi.spyOn(service as any,'selectedHost').mockResolvedValue('server-44');
  await expect(service.requestSession(address,{operation:'stop',inputId:'second'})).rejects.toThrow('response_identity_mismatch');
 });
});
