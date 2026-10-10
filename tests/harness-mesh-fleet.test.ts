import {describe,it,expect,vi} from "vitest";
import {FleetCabinetService} from "../src/mesh/fleet-service.js";
const hosts=[{hostId:"100",label:"Сервер100"},{hostId:"44",label:"Сервер44"},{hostId:"mac",label:"Mac M1"}];
const row=(hostId:string)=>({address:{hostId,harness:"codex",nativeSessionId:"same-id"},project:{launchCwd:"/launch",currentCwd:null,source:"unverified"},status:"unknown",title:"t",lastActivity:"now"});
function transport(){return {
 discover:vi.fn(async()=>({servers:[{kind:"virtual_shell",server_id:"shell:100",status:"online"},{kind:"virtual_shell",server_id:"shell:44",status:"online"},{kind:"virtual_shell",server_id:"shell:mac",status:"offline"},{kind:"child_mcp",server_id:"mcp:shell:100:AgentHerder",name:"agent-herder",status:"online"}]})),
 schema:vi.fn(async()=>({tools:[{name:"fleet_node_info"},{name:"mesh_snapshot"},{name:"create_session",inputSchema:{properties:{harness:{enum:["codex","zcode","opencode"]}}}}]})),
 call:vi.fn(async(_target:string,tool:string,args?:Record<string,unknown>)=>tool==="fleet_node_info"?{hostId:"100",nativeUser:"roomhacker",generation:1,createHarnesses:["codex","zcode","opencode"]}:tool==="mesh_snapshot"?{hostId:"100",sessions:[row("100")],complete:false,harnesses:[]}:{ok:true,created:true,harness:args?.harness,sessionId:"new-native",cwd:"/work"})
};}
describe("fleet cabinet registry/read API (focused integration; expected 3s, maximum 30s)",()=>{
 it("uses existing GPTAdmin routes and distinguishes reachable native owner, missing daemon and offline host",async()=>{
  const t=transport();const service=new FleetCabinetService({hosts,scope:{profileId:"herder",userId:"u"},transportFactory:()=>t});
  const r=await service.snapshot({limit:3});expect(r.hosts.map(h=>h.state)).toEqual(["ready","unavailable","offline"]);
  expect(r.sessions[0]?.key).toBe(JSON.stringify(["100","codex","same-id"]));expect(r.sessions[0]?.project.currentCwd).toBeNull();
  expect(r.hosts[0]?.createHarnesses).toEqual(["codex","zcode","opencode"]);expect(r.complete).toBe(false);
 });
 it("rejects Mac forwarded owner identity before session relabel or creation capability",async()=>{
  const t=transport();t.discover.mockResolvedValue({servers:[{kind:"child_mcp",server_id:"mcp:shell:mac:AgentHerder",name:"agent-herder",status:"online"}]} as any);
  const r=await new FleetCabinetService({hosts,scope:{profileId:"p",userId:"u"},transportFactory:()=>t}).snapshot();
  expect(r.sessions).toEqual([]);expect(r.hosts.find(h=>h.hostId==="mac")?.createHarnesses).toEqual([]);
  expect(t.call.mock.calls.some(c=>c[1]==="mesh_snapshot")).toBe(false);
 });
 it("does not renew freshness of missing peers; stale cached rows retain their host identity",async()=>{
  let now=1000;const t=transport();const s=new FleetCabinetService({hosts,scope:{profileId:"p",userId:"u"},transportFactory:()=>t,now:()=>now,ttlMs:100});
  const first=await s.snapshot();now=1200;t.discover.mockResolvedValue({servers:[]} as any);
  const second=await s.snapshot();expect(second.hosts[0]?.state).toBe("stale");expect(second.hosts[0]?.fetchedAt).toBe(first.hosts[0]?.fetchedAt);
  expect(second.hosts[0]?.expiresAt).toBe(1100);expect(second.hosts[0]?.createHarnesses).toEqual([]);
 });
 it("partitions mutable transports by profile/user/host and globally bounds merged sessions",async()=>{
  const factory=vi.fn(()=>transport());const scope={profileId:"p1",userId:"u1"};
  const s=new FleetCabinetService({hosts,scope,transportFactory:factory});await s.snapshot({limit:1});
  expect(factory).toHaveBeenCalledWith({profileId:"p1",userId:"u1",hostId:"100"});
  const other=new FleetCabinetService({hosts,scope:{profileId:"p2",userId:"u2"},transportFactory:factory});await other.snapshot();
  expect(factory).toHaveBeenCalledWith({profileId:"p2",userId:"u2",hostId:"100"});
 });
});

describe('fleet native creation intent (focused integration; expected 3s, maximum 30s)',()=>{
 it('persists native creation and returns it after restart before any reads when the host disappears',async()=>{
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const directory=await mkdtemp(join(tmpdir(),'fleet-create-'));try{
   const t=transport(),deps={hosts,scope:{profileId:'p',userId:'u'},transportFactory:()=>t,journalPath:join(directory,'intents.json')};
   const request={hostId:'100',harness:'codex' as const,name:'canary',cwd:'/work',inputId:'one'};
   const result=await new FleetCabinetService(deps).create(request);expect(result.state).toBe('created');expect(result.address?.nativeSessionId).toBe('new-native');
   t.call.mockClear();t.discover.mockClear();t.schema.mockClear();t.discover.mockRejectedValue(new Error('offline'));
   expect(await new FleetCabinetService(deps).create(request)).toEqual(result);expect(t.discover).not.toHaveBeenCalled();expect(t.call).not.toHaveBeenCalled();
   expect((await new FleetCabinetService(deps).create({...request,name:'different'})).reason).toBe('input_id_conflict');
  }finally{await rm(directory,{recursive:true,force:true});}
 });
 it('lost native creation receipt remains UNKNOWN across restart with no replay, even if the target is available',async()=>{
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const directory=await mkdtemp(join(tmpdir(),'fleet-lost-'));try{
   const t=transport();const original=t.call.getMockImplementation()!;t.call.mockImplementation(async(target,tool,args)=>{if(tool==='create_session')throw new Error('response lost after mutation');return original(target,tool,args);});
   const deps={hosts,scope:{profileId:'p',userId:'u'},transportFactory:()=>t,journalPath:join(directory,'intents.json')};
   const request={hostId:'100',harness:'opencode' as const,name:'canary',cwd:'/work',inputId:'lost'};
   const service=new FleetCabinetService(deps);expect((await service.create(request)).state).toBe('unknown');t.call.mockClear();t.discover.mockClear();
   deps.scope.userId='mutated-after-construction';expect((await service.create(request)).state).toBe('unknown');expect(t.call).not.toHaveBeenCalled();deps.scope.userId='u';
   expect((await new FleetCabinetService(deps).create(request)).state).toBe('unknown');expect(t.call).not.toHaveBeenCalled();expect(t.discover).not.toHaveBeenCalled();
  }finally{await rm(directory,{recursive:true,force:true});}
 });
 it('releases proven unavailable intent for explicit retry and isolates the same input across authenticated users',async()=>{
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const directory=await mkdtemp(join(tmpdir(),'fleet-scope-'));try{
   const t=transport(),deps={hosts,scope:{profileId:'p',userId:'u'},transportFactory:()=>t,journalPath:join(directory,'intents.json')};
   const request={hostId:'44',harness:'zcode' as const,name:'same',cwd:'/work',inputId:'scope'};
   const unavailable=await new FleetCabinetService(deps).create(request);expect(unavailable.state).toBe('not_attempted');expect(unavailable.retryable).toBe(true);expect(t.call.mock.calls.filter(c=>c[1]==='create_session')).toHaveLength(0);
   const good={...request,hostId:'100'};expect((await new FleetCabinetService(deps).create(good)).state).toBe('created');
   expect((await new FleetCabinetService({...deps,scope:{profileId:'p',userId:'other'}}).create(good)).state).toBe('created');expect(t.call.mock.calls.filter(c=>c[1]==='create_session')).toHaveLength(2);
  }finally{await rm(directory,{recursive:true,force:true});}
 });
 it('enforces a GLOBAL window and rejects malformed peer paths without identity truncation',async()=>{
  const t=transport();t.discover.mockResolvedValue({servers:['100','44'].map(h=>({kind:'child_mcp',server_id:`mcp:shell:${h}:AgentHerder`,status:'online'}))} as any);
  t.call.mockImplementation(async(target,tool)=>{const host=target.includes(':100:')?'100':'44';return tool==='fleet_node_info'?{hostId:host,generation:1,createHarnesses:['codex']}:tool==='mesh_snapshot'?{hostId:host,complete:true,sessions:[0,1,2].map(i=>({...row(host),address:{hostId:host,harness:'codex',nativeSessionId:'id'+i},title:'x'.repeat(300),extra:'secret transcript'}))}:{};});
  const result=await new FleetCabinetService({hosts,scope:{profileId:'p',userId:'u'},transportFactory:()=>t}).snapshot({limit:3});
  expect(result.sessions).toHaveLength(3);expect(result.sessions.map(s=>s.address.hostId)).toEqual(['100','44','100']);expect(result.limited).toBe(true);expect(result.complete).toBe(false);expect(result.sessions[0]?.title).toHaveLength(160);expect(result.sessions[0]).not.toHaveProperty('extra');
 });
 it('deadline produces partial without late cache writes',async()=>{
  const t=transport();let finish:(value:any)=>void=()=>{};t.call.mockImplementation(async(_target,tool)=>tool==='fleet_node_info'?{hostId:'100',generation:1,createHarnesses:['codex']}:new Promise(resolve=>{finish=resolve;}));
  const s=new FleetCabinetService({hosts,scope:{profileId:'p',userId:'u'},transportFactory:()=>t,readDeadlineMs:5});
  const result=await s.snapshot();expect(result.complete).toBe(false);expect(result.sessions).toEqual([]);finish({hostId:'100',complete:true,sessions:[row('100')]});await Promise.resolve();
  t.discover.mockResolvedValue({servers:[]} as any);expect((await s.snapshot()).sessions).toEqual([]);
 });
});
describe('fleet identity fences (focused integration; expected 2s, maximum 20s)',()=>{
 it('does not relabel a receipt from a different native harness',async()=>{
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const directory=await mkdtemp(join(tmpdir(),'fleet-wrong-owner-'));
  try{const t=transport();const original=t.call.getMockImplementation()!;t.call.mockImplementation(async(target,tool,args)=>tool==='create_session'?{ok:true,created:true,harness:'opencode',sessionId:'foreign',cwd:'/work'}:original(target,tool,args));
   const s=new FleetCabinetService({hosts,scope:{profileId:'p',userId:'u'},transportFactory:()=>t,journalPath:join(directory,'ledger.json')});const result=await s.create({hostId:'100',harness:'codex',name:'n',cwd:'/work',inputId:'identity'});expect(result.state).toBe('unknown');expect(result.address).toBeUndefined();
  }finally{await rm(directory,{recursive:true,force:true});}
 });
});

describe('fleet read economy (focused integration; expected 1s, maximum 15s)',()=>{
 it('reuses fresh /hosts + /sessions reads but honors forced refresh and fresh creation preflight',async()=>{
  const t=transport();const s=new FleetCabinetService({hosts,scope:{profileId:'p',userId:'u'},transportFactory:()=>t});await s.snapshot();t.call.mockClear();t.discover.mockClear();t.schema.mockClear();
  await s.snapshot({hostId:'100',limit:3});expect(t.call).not.toHaveBeenCalled();expect(t.discover).not.toHaveBeenCalled();await s.snapshot({refresh:true});expect(t.discover).toHaveBeenCalledTimes(1);expect(t.call).toHaveBeenCalledTimes(2);
 });
});
describe('fleet scope and per-host TTL (focused integration; expected 1s, maximum 15s)',()=>{
 it('canonicalizes browser scope partition independent of auth object key order',()=>{
  const a=new FleetCabinetService({hosts,scope:{profileId:'p',userId:'u'},transportFactory:transport});const b=new FleetCabinetService({hosts,scope:{userId:'u',profileId:'p'},transportFactory:transport});expect(a.browserScopeKey).toBe(b.browserScopeKey);
 });
 it('refreshes an expired fast host even when another peer finished the last refresh later',async()=>{
  let now=1000;const t=transport();let finish:(value:any)=>void=()=>{};
  t.discover.mockResolvedValue({servers:['100','44'].map(h=>({kind:'child_mcp',server_id:`mcp:shell:${h}:AgentHerder`,status:'online'}))} as any);
  t.call.mockImplementation(async(target,tool)=>{const host=target.includes(':100:')?'100':'44';if(tool==='fleet_node_info')return {hostId:host,generation:1,createHarnesses:['codex']};const result={hostId:host,sessions:[row(host)],complete:true};if(host==='44')return new Promise(resolve=>{finish=resolve;});return result;});
  const s=new FleetCabinetService({hosts:hosts.slice(0,2),scope:{profileId:'p',userId:'u'},transportFactory:()=>t,now:()=>now,ttlMs:100});const pending=s.snapshot();await new Promise(resolve=>setTimeout(resolve,0));now=1050;finish({hostId:'44',sessions:[row('44')],complete:true});const first=await pending;expect(first.hosts[0]?.expiresAt).toBe(1100);
  now=1120;t.discover.mockClear();t.call.mockImplementation(async(target,tool)=>{const host=target.includes(':100:')?'100':'44';return tool==='fleet_node_info'?{hostId:host,generation:1,createHarnesses:['codex']}:{hostId:host,sessions:[row(host)],complete:true};});await s.snapshot();expect(t.discover).toHaveBeenCalledTimes(1);
 });
});
describe('measured registered fleet latency (fast unit fake time; expected 1s, maximum 10s)',()=>{
 it('keeps discovery finite but accepts a13.8s metadata path with each read below5s',async()=>{
  vi.useFakeTimers();try{
   const wait=async(ms:number,value:unknown)=>{await new Promise(resolve=>setTimeout(resolve,ms));return value;};
   const t={discover:()=>wait(3700,{servers:[{kind:'child_mcp',server_id:'mcp:shell:100:AgentHerder',status:'online'}]}),schema:()=>wait(3200,{tools:[{name:'fleet_node_info'},{name:'mesh_snapshot'},{name:'create_session'}]}),call:(_target:string,tool:string)=>tool==='fleet_node_info'?wait(3100,{hostId:'100',generation:1,createHarnesses:['codex']}):wait(3800,{hostId:'100',sessions:[row('100')],complete:true})};
   const s=new FleetCabinetService({hosts:hosts.slice(0,1),scope:{profileId:'p',userId:'u'},transportFactory:()=>t});const pending=s.snapshot();await vi.advanceTimersByTimeAsync(14000);const result=await pending;expect(result.hosts[0]?.state).toBe('ready');expect(result.sessions).toHaveLength(1);
  }finally{vi.useRealTimers();}
 });
});
describe('fleet unrelated slow host isolation (fast unit fake time; expected 1s, maximum 10s)',()=>{
 it('marks an early peer stale if it expires before full publication, retaining its original timestamps',async()=>{
  vi.useFakeTimers();vi.setSystemTime(0);try{
   const t=transport();t.discover.mockResolvedValue({servers:['100','44'].map(h=>({kind:'child_mcp',server_id:`mcp:shell:${h}:AgentHerder`,status:'online'}))} as any);
   t.call.mockImplementation(async(target,tool)=>{const host=target.includes(':100:')?'100':'44';if(tool==='fleet_node_info')return {hostId:host,generation:1,createHarnesses:['codex']};if(host==='44')await new Promise(resolve=>setTimeout(resolve,20000));return {hostId:host,sessions:[row(host)],complete:true};});
   const s=new FleetCabinetService({hosts:hosts.slice(0,2),scope:{profileId:'p',userId:'u'},transportFactory:()=>t,readDeadlineMs:25000,ttlMs:15000});const pending=s.snapshot();await vi.advanceTimersByTimeAsync(21000);const result=await pending;expect(result.hosts[0]?.state).toBe('stale');expect(result.hosts[0]?.expiresAt).toBe(15000);expect(result.hosts[0]?.createHarnesses).toEqual([]);expect(result.complete).toBe(false);
  }finally{vi.useRealTimers();}
 });
 it('creation preflight only inspects its selected host, never waiting on an unrelated slow native peer',async()=>{
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const directory=await mkdtemp(join(tmpdir(),'fleet-target-read-'));try{
   const t=transport();t.discover.mockResolvedValue({servers:['100','44'].map(h=>({kind:'child_mcp',server_id:`mcp:shell:${h}:AgentHerder`,status:'online'}))} as any);
   const original=t.call.getMockImplementation()!;t.call.mockImplementation(async(target,tool,args)=>{if(target.includes(':44:'))return new Promise(()=>{});return original(target,tool,args);});
   const s=new FleetCabinetService({hosts,scope:{profileId:'p',userId:'u'},transportFactory:()=>t,journalPath:join(directory,'ledger.json')});expect((await s.create({hostId:'100',harness:'codex',name:'n',cwd:'/work',inputId:'selected'})).state).toBe('created');expect(t.call.mock.calls.some(call=>call[0].includes(':44:'))).toBe(false);
  }finally{await rm(directory,{recursive:true,force:true});}
 });
});
describe('fleet old-observation publication fence (focused integration; expected 1s, maximum 15s)',()=>{
 it('does not restore old owner generation or create capability after a newer selected-host proof',async()=>{
  let now=1000;const t=transport();let info=0,snapshots=0;let releaseOld:(value:any)=>void=()=>{};
  t.discover.mockResolvedValue({servers:[{kind:'child_mcp',server_id:'mcp:shell:100:AgentHerder',status:'online'}]} as any);
  t.call.mockImplementation(async(_target,tool)=>{if(tool==='fleet_node_info'){info++;return {hostId:'100',generation:info,createHarnesses:info===1?['codex']:[]};}snapshots++;if(snapshots===1)return new Promise(resolve=>{releaseOld=resolve;});return {hostId:'100',sessions:[row('100')],complete:true};});
  const s=new FleetCabinetService({hosts:hosts.slice(0,1),scope:{profileId:'p',userId:'u'},transportFactory:()=>t,now:()=>now});const older=s.snapshot();await new Promise(resolve=>setTimeout(resolve,0));now=1010;
  const newer=await s.snapshot({hostId:'100',refresh:true});expect(newer.hosts[0]?.generation).toBe(2);expect(newer.hosts[0]?.createHarnesses).toEqual([]);now=1020;releaseOld({hostId:'100',sessions:[row('100')],complete:true});
  const result=await older;expect(result.hosts[0]?.generation).toBe(2);expect(result.hosts[0]?.createHarnesses).toEqual([]);expect((await s.snapshot()).hosts[0]?.generation).toBe(2);
 });
});

describe('cold registered fleet latency (fast unit fake time; expected 1s, maximum 10s)',()=>{
 it('publishes five live peers after two finite worker waves and expires absent peers without timestamp renewal',async()=>{
  vi.useFakeTimers();vi.setSystemTime(0);try{
   const names=['100','44','88','mini','m1'];const definitions=names.map(hostId=>({hostId,label:hostId}));
   const wait=async(value:unknown)=>{await new Promise(resolve=>setTimeout(resolve,5000));return value;};
   const t={discover:vi.fn(async()=>({servers:names.map(hostId=>({kind:'child_mcp',server_id:`mcp:shell:${hostId}:AgentHerder`,status:'online'}))})),schema:()=>wait({tools:[{name:'fleet_node_info'},{name:'mesh_snapshot'},{name:'create_session'}]}),call:(target:string,tool:string)=>{const hostId=target.split(':')[2]!;return wait(tool==='fleet_node_info'?{hostId,generation:1,createHarnesses:['codex']}:{hostId,sessions:[row(hostId)],complete:true});}};
   const s=new FleetCabinetService({hosts:definitions,scope:{profileId:'p',userId:'u'},transportFactory:()=>t});const pending=s.snapshot();await vi.advanceTimersByTimeAsync(30000);const result=await pending;
   expect(result.hosts.map(h=>h.state)).toEqual(names.map(()=>'ready'));expect(result.hosts[0]?.fetchedAt).toBe(15000);expect(result.hosts[0]?.expiresAt).toBe(75000);
   t.discover.mockResolvedValue({servers:[]});await vi.advanceTimersByTimeAsync(60000);const absent=await s.snapshot();expect(absent.hosts.every(h=>h.state==='stale'&&h.createHarnesses.length===0)).toBe(true);expect(absent.hosts[0]?.fetchedAt).toBe(15000);expect(absent.hosts[0]?.expiresAt).toBe(75000);
  }finally{vi.useRealTimers();}
 });
 it('accepts6–9s metadata reads and a32s full path using aligned finite defaults',async()=>{
  vi.useFakeTimers();vi.setSystemTime(0);try{
   const wait=async(ms:number,value:unknown)=>{await new Promise(resolve=>setTimeout(resolve,ms));return value;};
   const t={discover:vi.fn(()=>wait(6000,{servers:[{kind:'child_mcp',server_id:'mcp:shell:100:AgentHerder',status:'online'}]})),schema:vi.fn(()=>wait(8000,{tools:[{name:'fleet_node_info'},{name:'mesh_snapshot'},{name:'create_session'}]})),call:vi.fn((_target:string,tool:string)=>tool==='fleet_node_info'?wait(9000,{hostId:'100',nativeUser:'roomhacker',generation:1,createHarnesses:['codex']}):wait(9000,{hostId:'100',sessions:[row('100')],complete:true}))};
   const s=new FleetCabinetService({hosts:hosts.slice(0,1),scope:{profileId:'p',userId:'u'},transportFactory:()=>t});const pending=s.snapshot();await vi.advanceTimersByTimeAsync(33000);const result=await pending;
   expect(result.hosts[0]?.state).toBe('ready');expect(result.hosts[0]?.createHarnesses).toEqual(['codex']);expect(result.sessions[0]?.address.nativeSessionId).toBe('same-id');expect(result.complete).toBe(true);
   expect(t.discover).toHaveBeenCalledTimes(1);expect(t.schema).toHaveBeenCalledTimes(1);expect(t.call).toHaveBeenCalledTimes(2);
  }finally{vi.useRealTimers();}
 });
 it('bounds the aggregate at45s even when individual read overrides are longer',async()=>{
  vi.useFakeTimers();vi.setSystemTime(0);try{
   const t=transport();const originalDiscover=t.discover.getMockImplementation()!,originalSchema=t.schema.getMockImplementation()!,originalCall=t.call.getMockImplementation()!;
   const wait=async(run:()=>unknown)=>{await new Promise(resolve=>setTimeout(resolve,12000));return run();};
   t.discover.mockImplementation(()=>wait(originalDiscover));t.schema.mockImplementation(()=>wait(originalSchema));t.call.mockImplementation((target,tool,args)=>wait(()=>originalCall(target,tool,args)));
   const s=new FleetCabinetService({hosts:hosts.slice(0,1),scope:{profileId:'p',userId:'u'},transportFactory:()=>t,readDeadlineMs:15000});let result:any;const pending=s.snapshot().then(r=>{result=r;});await vi.advanceTimersByTimeAsync(44999);expect(result).toBeUndefined();await vi.advanceTimersByTimeAsync(1);await pending;
   expect(result.hosts[0]?.state).toBe('unavailable');expect(result.hosts[0]?.reason).toBe('fleet_read_deadline');expect(result.sessions).toEqual([]);expect(result.complete).toBe(false);expect(t.call).toHaveBeenCalledTimes(2);
  }finally{vi.useRealTimers();}
 });
});

// Fast unit: stale published child health must not override a live enrolled parent.
// Defect: hourly heartbeat cached failed health hid a working M1. Expected1s/max10s.
describe('fleet cached child health versus live native proof (fast unit; expected1s, maximum10s)',()=>{
 it.each(['failed','offline'])('probes registered %s child under an online parent and requires genuine identity/snapshot',async(status)=>{
  const t=transport();t.discover.mockResolvedValue({servers:[{kind:'virtual_shell',server_id:'shell:100',status:'online'},{kind:'child_mcp',server_id:'mcp:shell:100:AgentHerder',status}]} as any);
  const r=await new FleetCabinetService({hosts:hosts.slice(0,1),scope:{profileId:'p',userId:'u'},transportFactory:()=>t}).snapshot();
  expect(r.hosts[0]?.state).toBe('ready');expect(t.schema).toHaveBeenCalledTimes(1);expect(t.call.mock.calls.map(c=>c[1])).toEqual(['fleet_node_info','mesh_snapshot']);
 });
 it('retains offline parent fence even with an online child descriptor',async()=>{
  const t=transport();t.discover.mockResolvedValue({servers:[{kind:'virtual_shell',server_id:'shell:100',status:'offline'},{kind:'child_mcp',server_id:'mcp:shell:100:AgentHerder',status:'online'}]} as any);
  const r=await new FleetCabinetService({hosts:hosts.slice(0,1),scope:{profileId:'p',userId:'u'},transportFactory:()=>t}).snapshot();
  expect(r.hosts[0]?.state).toBe('offline');expect(r.hosts[0]?.createHarnesses).toEqual([]);expect(t.schema).not.toHaveBeenCalled();
 });
 it('does not probe stale child without an online enrolled parent',async()=>{
  const t=transport();t.discover.mockResolvedValue({servers:[{kind:'child_mcp',server_id:'mcp:shell:100:AgentHerder',status:'failed'}]} as any);
  const r=await new FleetCabinetService({hosts:hosts.slice(0,1),scope:{profileId:'p',userId:'u'},transportFactory:()=>t}).snapshot();
  expect(r.hosts[0]?.state).toBe('unavailable');expect(t.schema).not.toHaveBeenCalled();
 });
 it('cached failed health never grants control when actual native identity fails',async()=>{
  const t=transport();t.discover.mockResolvedValue({servers:[{kind:'virtual_shell',server_id:'shell:100',status:'online'},{kind:'child_mcp',server_id:'mcp:shell:100:AgentHerder',status:'failed'}]} as any);
  t.call.mockResolvedValue({hostId:'foreign'} as any);
  const r=await new FleetCabinetService({hosts:hosts.slice(0,1),scope:{profileId:'p',userId:'u'},transportFactory:()=>t}).snapshot();
  expect(r.hosts[0]?.state).toBe('unavailable');expect(r.hosts[0]?.reason).toBe('native_owner_identity_mismatch');expect(r.hosts[0]?.createHarnesses).toEqual([]);expect(t.call).toHaveBeenCalledTimes(1);
 });
});
