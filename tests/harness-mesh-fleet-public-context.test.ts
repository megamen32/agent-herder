// Fast unit, expected 2s/max 15s. Detects cross-request cookie leakage and
// journal partition churn; network doubles prove only local request wiring.
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {writeFile,rm} from 'node:fs/promises';
import {FleetBrowserIntent} from '../src/web-ui/fleet/intent.js';
import type {IncomingMessage} from 'node:http';
const state=vi.hoisted(()=>({host:'mac-mini-2012.lan',auth:true,hubCalls:0,files:[] as string[],calls:[] as Readonly<{cookie:string;credentialGeneration:string}>[],providers:[] as (()=>unknown)[]}));
vi.mock('node:os',()=>({hostname:()=>state.host,userInfo:()=>({username:'roomhacker'}),homedir:()=>process.env.TMPDIR!}));
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
vi.mock('../src/mesh/fleet-gptadmin-transport.js',()=>({FleetGptAdminTransport:class{constructor(){state.hubCalls++;throw new Error('unexpected Hub request');}}}));
import {createConfiguredFleetApiHandler} from '../src/web/fleet-wiring.js';
import {FleetCabinetService} from '../src/mesh/fleet-service.js';
beforeEach(()=>{state.host='mac-mini-2012.lan';state.auth=true;state.hubCalls=0;state.calls=[];state.providers=[];vi.restoreAllMocks();vi.stubGlobal('fetch',vi.fn(async()=>new Response(null,{status:204,headers:{'X-GPTAdmin-User':'roomhacker'}})));});
afterEach(async()=>{vi.unstubAllGlobals();await Promise.all(state.files.splice(0).map(path=>rm(path)));});
const endpoint='https://unit.gptadmin.bezrabotnyi.com/mcp';
const profileId=new URL(endpoint).origin+'/client:zcode';
async function ownerOptions(){
 const path=process.env.TMPDIR+'/fleet-owner-unit-'+randomUUID()+'.json';state.files.push(path);
 const headers={Authorization:'Bearer test-fixture'};await writeFile(path,JSON.stringify({mcp:{servers:{gptadmin:{url:endpoint,headers}}}}),{mode:0o600});
 return {clientConfigPath:path,approvedCredentialGeneration:createHash('sha256').update(JSON.stringify([endpoint,headers])).digest('hex')};
}
const request=(cookie:string)=>({method:'GET',url:'/api/fleet/session?hostId=server-44&harness=codex&sessionId=accepted-id',socket:{remoteAddress:'192.168.2.101'},headers:{host:state.host==='roomhacker-server-100'?'agent.bezrabotnyi.com':'agent-mac-mini.bezrabotnyi.com',cookie}} as IncomingMessage);
const response=()=>({writeHead:vi.fn(),end:vi.fn()});
describe('verified public owner context',()=>{
 it.each(['mac-mini-2012.lan','roomhacker-server-100'])('concurrent cookie generations retain their own credentials on the same cached host transport on %s',async(host)=>{state.host=host;
  const handler=createConfiguredFleetApiHandler(host==='roomhacker-server-100'?await ownerOptions():{clientConfigPath:'/never-read-a-foreign-client'});
  const a=response(),b=response();await Promise.all([handler(request('gptadmin_auth=unit-a'),a as any),handler(request('gptadmin_auth=unit-b'),b as any)]);
  expect(state.providers).toHaveLength(1);expect(state.calls.map(c=>c.cookie)).toEqual(['gptadmin_auth=unit-a','gptadmin_auth=unit-b']);
  for(const c of state.calls){expect(c.credentialGeneration).toBe(createHash('sha256').update(c.cookie).digest('hex'));expect(Object.isFrozen(c)).toBe(true);}
  expect(a.writeHead).toHaveBeenCalledWith(200,expect.anything());expect(b.writeHead).toHaveBeenCalledWith(200,expect.anything());
  expect(state.providers[0]!()).toBeUndefined();expect(state.hubCalls).toBe(0);
 });
 it.each(['mac-mini-2012.lan','roomhacker-server-100'])('does not construct a peer transport when the owner cookie fails verification on %s',async(host)=>{state.host=host;
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
 it('keeps public100 creates on the existing Hub binding and journal lane',async()=>{
  state.host='roomhacker-server-100';const q=request('gptadmin_auth=unit-a');q.method='POST';q.url='/api/fleet/create';q.headers.origin='https://agent.bezrabotnyi.com';const r=response();
  await createConfiguredFleetApiHandler({clientConfigPath:'/never-read-a-foreign-client'})(q,r as any);
  expect(r.writeHead).toHaveBeenCalledWith(503,expect.anything());expect(state.providers).toHaveLength(0);expect(state.calls).toHaveLength(0);
 });
 it('keeps a declared bearer out of the public owner cookie lane on100',async()=>{
  state.host='roomhacker-server-100';const q=request('gptadmin_auth=unit-a');q.headers.authorization='Bearer unit-foreign';const r=response();
  await createConfiguredFleetApiHandler({clientConfigPath:'/never-read-a-foreign-client'})(q,r as any);
  expect(r.writeHead).toHaveBeenCalledWith(503,expect.anything());expect(state.providers).toHaveLength(0);expect(state.calls).toHaveLength(0);
 });
 it('public100 metadata reads retain the legacy browser UNKNOWN lock and archived history after reload',async()=>{
  state.host='roomhacker-server-100';const options=await ownerOptions();
  const oldScope=createHash('sha256').update(JSON.stringify([profileId,'roomhacker'])).digest('hex');
  const map=new Map<string,string>();const storage={getItem:(key:string)=>map.get(key)??null,setItem:(key:string,value:string)=>{map.set(key,value);},removeItem:(key:string)=>{map.delete(key);}};
  const old=new FleetBrowserIntent(storage,oldScope);const intent={hostId:'server-44',harness:'codex' as const,name:'n',cwd:'/work',inputId:'archived'};old.begin(intent);old.archiveUnknown();old.begin({...intent,inputId:'pending'});
  vi.spyOn(FleetCabinetService.prototype,'snapshot').mockResolvedValue({hosts:[],sessions:[],complete:false,limited:false});
  const q=request('gptadmin_auth=unit-a');q.url='/api/fleet/hosts';const r=response();await createConfiguredFleetApiHandler(options)(q,r as any);
  expect(r.writeHead).toHaveBeenCalledWith(200,expect.anything());const scope=JSON.parse(r.end.mock.calls[0]![0]).scopeKey;expect(scope).toBe(oldScope);
  const restored=new FleetBrowserIntent(storage,scope);expect(restored.load()?.receipt.state).toBe('unknown');expect(restored.load()?.request.inputId).toBe('pending');expect(restored.archivedUnknown()[0]?.request.inputId).toBe('archived');expect(()=>restored.begin({...intent,inputId:'new'})).toThrow();expect(state.hubCalls).toBe(0);
 });
});
