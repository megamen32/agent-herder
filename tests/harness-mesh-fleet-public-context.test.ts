// Fast unit, expected 2s/max 15s. Detects cross-request cookie leakage and
// journal partition churn; network doubles prove only local request wiring.
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
const state=vi.hoisted(()=>({auth:true,calls:[] as Readonly<{cookie:string;credentialGeneration:string}>[],providers:[] as (()=>unknown)[]}));
vi.mock('node:os',()=>({hostname:()=> 'mac-mini-2012.lan',userInfo:()=>({username:'roomhacker'}),homedir:()=>process.env.TMPDIR!}));
vi.mock('../src/web/fleet-owner-auth.js',()=>({verifyFleetOwnerCookie:vi.fn(async()=>state.auth)}));
vi.mock('../src/mesh/fleet-owner-http-transport.js',()=>({FleetOwnerHttpTransport:class{
 constructor(private options:{ownerContext:()=>Readonly<{cookie:string;credentialGeneration:string}>|undefined}){state.providers.push(options.ownerContext);}
 async readSession(target:string,harness:string,id:string){
  const context=this.options.ownerContext();if(!context)throw new Error('missing context');
  state.calls.push(context);await Promise.resolve();
  expect(this.options.ownerContext()).toBe(context);
  return {hostId:target.split(':')[2],details:{session:{id,harness},historyUnavailable:true}};
 }
}}));
import {createConfiguredFleetApiHandler} from '../src/web/fleet-wiring.js';
import {FleetCabinetService} from '../src/mesh/fleet-service.js';
beforeEach(()=>{state.auth=true;state.calls=[];state.providers=[];vi.restoreAllMocks();});
const request=(cookie:string)=>({method:'GET',url:'/api/fleet/session?hostId=server-44&harness=codex&sessionId=accepted-id',socket:{remoteAddress:'192.168.2.101'},headers:{host:'agent-mac-mini.bezrabotnyi.com',cookie}} as IncomingMessage);
const response=()=>({writeHead:vi.fn(),end:vi.fn()});
describe('verified public owner context',()=>{
 it('concurrent cookie generations retain their own credentials on the same cached host transport',async()=>{
  const handler=createConfiguredFleetApiHandler({clientConfigPath:'/never-read-a-foreign-client'});
  const a=response(),b=response();await Promise.all([handler(request('gptadmin_auth=unit-a'),a as any),handler(request('gptadmin_auth=unit-b'),b as any)]);
  expect(state.providers).toHaveLength(1);expect(state.calls.map(c=>c.cookie)).toEqual(['gptadmin_auth=unit-a','gptadmin_auth=unit-b']);
  for(const c of state.calls){expect(c.credentialGeneration).toBe(createHash('sha256').update(c.cookie).digest('hex'));expect(Object.isFrozen(c)).toBe(true);}
  expect(a.writeHead).toHaveBeenCalledWith(200,expect.anything());expect(b.writeHead).toHaveBeenCalledWith(200,expect.anything());
  expect(state.providers[0]!()).toBeUndefined();
 });
 it('does not construct a peer transport when the owner cookie fails verification',async()=>{
  state.auth=false;const r=response();await createConfiguredFleetApiHandler()(request('untrusted-unit-cookie'),r as any);
  expect(r.writeHead).toHaveBeenCalledWith(401,expect.anything());expect(state.providers).toHaveLength(0);expect(state.calls).toHaveLength(0);
 });
 it('preserves the same profile service and browser partition across owner cookie rotation',async()=>{
  const seen:FleetCabinetService[]=[];
  vi.spyOn(FleetCabinetService.prototype,'snapshot').mockImplementation(async function(this:FleetCabinetService){seen.push(this);return {hosts:[],sessions:[],complete:false,limited:false};});
  const h=createConfiguredFleetApiHandler(),a=response(),b=response();
  const qa=request('gptadmin_auth=unit-a');qa.url='/api/fleet/hosts';const qb=request('gptadmin_auth=unit-b');qb.url='/api/fleet/hosts';
  await h(qa,a as any);await h(qb,b as any);
  expect(seen[0]).toBe(seen[1]);expect(JSON.parse(a.end.mock.calls[0]![0]).scopeKey).toBe(JSON.parse(b.end.mock.calls[0]![0]).scopeKey);
 });
});
