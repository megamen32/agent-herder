import {meshDiscoveryTimeoutMs} from "../src/mesh/discovery-timeout.js";
import {describe,expect,it,vi} from "vitest";
import {LocalHarnessMesh} from "../src/mesh/local.js";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CoordinationNoteStore} from "../src/coordination-notes.js";
import {HerderEventBus} from "../src/herder-events.js";
import {HerderJobRegistry} from "../src/herder-jobs.js";
import {UserMessageDelivery} from "../src/user-message-delivery.js";
import {TRUSTED_MESH_MCP_CLIENT_ID,TRUSTED_MESH_MCP_SCOPE,trustedMeshIngressFromMcpAuthInfo} from "../src/mesh/authenticated-ingress.js";
import {coordinationNotes} from "../src/coordination-notes.js";
import {randomUUID} from "node:crypto";
const base={id:"n",harness:"codex",status:"running",cwd:"/launch",title:"t",lastActivity:new Date().toISOString(),needsPermission:false,meta:{activeCwd:"/actual",launchCwd:"/launch",projectSource:"native"}};
function sharedDelivery(root:string,adapter:any){
 const events=new HerderEventBus(),jobs=new HerderJobRegistry(events,{persistencePath:join(root,"jobs.json")});
 const delivery=new UserMessageDelivery(new Map([["codex",adapter]]),{sendMessage:async(_harness,id,options)=>adapter.sendMessage(id,options)},jobs,{pollMs:1,maxWaitMs:2_000,maxPending:32});
 const ingress=trustedMeshIngressFromMcpAuthInfo({token:"test-transport-token",clientId:TRUSTED_MESH_MCP_CLIENT_ID,scopes:[TRUSTED_MESH_MCP_SCOPE]})!;
 return {delivery,jobs,ingress};
}
describe("local mesh capabilities (focused integration; expected 5s, maximum 30s)",()=>{
 it("validates the configurable discovery timeout inside the fleet deadline",()=>{
  const diagnostic=vi.spyOn(console,"error").mockImplementation(()=>{});
  try{
   expect(meshDiscoveryTimeoutMs("")).toBe(30000);
   expect(meshDiscoveryTimeoutMs("100")).toBe(100);
   expect(meshDiscoveryTimeoutMs("300000")).toBe(300000);
   for(const value of ["0","300001","Infinity","oops","1.5"]){expect(meshDiscoveryTimeoutMs(value)).toBe(30000);}
   expect(diagnostic).toHaveBeenCalledTimes(5);
  }finally{diagnostic.mockRestore();}
 });
 it("keeps the native100 address while projecting a declared workspace on88",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-remote-mesh-"));try{
   const store=new CoordinationNoteStore(join(dir,"notes.json"));await store.declareWorkspace({sessionId:"n",harness:"codex",hostId:"host88",cwd:"/remote/project"});
   const adapter={listSessions:async()=>[{...base,meta:{},cwd:"/launch100"}],isReady:()=>true};
   const snapshot=await new LocalHarnessMesh({hostId:"host100",projectStore:store,adapters:new Map([["codex",adapter]]) as any}).snapshot(3);
   expect(snapshot.sessions[0]).toMatchObject({address:{hostId:"host100",nativeSessionId:"n"},project:{launchCwd:"/launch100",currentCwd:"/remote/project",hostId:"host88",source:"declared"}});
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it("marks an empty/disconnected adapter registry partial instead of complete",async()=>{
  const empty=new LocalHarnessMesh({hostId:"h",adapters:new Map()});expect((await empty.snapshot(1)).complete).toBe(false);
  const disconnected={type:"codex",lazyStart:true,isReady:()=>false,listSessions:vi.fn()};
  const r=await new LocalHarnessMesh({hostId:"h",adapters:new Map([['codex',disconnected]]) as any}).snapshot(1);
  expect(r.complete).toBe(false);expect(disconnected.listSessions).not.toHaveBeenCalled();
 });
 it("uses bounded discovery and does not activate a disconnected lazy native adapter",async()=>{
  const active={type:"codex",listSessions:vi.fn(async()=>[base]),getSession:vi.fn(async()=>base),isReady:()=>true};
  const disconnected={type:"zcode",lazyStart:true,isReady:()=>false,listSessions:vi.fn()};
  const m=new LocalHarnessMesh({hostId:"host",adapters:new Map([['codex',active],['zcode',disconnected]]) as any});
  const r=await m.snapshot(3);expect(active.listSessions).toHaveBeenCalledWith({limit:3});expect(disconnected.listSessions).not.toHaveBeenCalled();
  expect(r.sessions[0]?.project.currentCwd).toBe("/actual");
  expect(r.harnesses).toContainEqual(expect.objectContaining({harness:"minimax-code",delivery:"unsupported",reason:"adapter_not_registered"}));
  expect(JSON.stringify(r)).not.toContain("repairPlan");
 });
 it("discovers late MiniMax within the shared deadline when earlier providers hang",async()=>{
  vi.useFakeTimers();
  try{
   const hung={listSessions:vi.fn(()=>new Promise<any[]>(()=>{}))};
   const minimax={listSessions:vi.fn(async()=>[{...base,id:"mvs_live",harness:"minimax-code"}])};
   const adapters=new Map([["codex",hung],["claude",hung],["opencode",hung],["minimax-code",minimax]]) as any;
   const m=new LocalHarnessMesh({hostId:"h",adapters,readDeadlineMs:100,projectStore:{activeWorkspaceForSession:()=>undefined} as any});
   const pending=m.snapshot();await vi.advanceTimersByTimeAsync(100);
   const result=await pending;
   expect(result.harnesses).toContainEqual({harness:"minimax-code",discovery:"available",delivery:"available"});
   expect(result.sessions).toContainEqual(expect.objectContaining({address:{hostId:"h",harness:"minimax-code",nativeSessionId:"mvs_live"}}));
   expect(result.complete).toBe(false);
   expect(result.harnesses).toContainEqual(expect.objectContaining({harness:"codex",reason:"native_discovery_deadline"}));
  }finally{vi.useRealTimers();}
 });
 it("distinguishes an adapter failure from an exhausted discovery deadline",async()=>{
  const adapter={listSessions:async()=>{throw new Error("native backend refused");}};
  const result=await new LocalHarnessMesh({adapters:new Map([["minimax-code",adapter]]) as any}).snapshot();
  expect(result.harnesses).toContainEqual(expect.objectContaining({harness:"minimax-code",reason:"native_discovery_failed"}));
 });
 it("bounds a hung native read and discards late rows without changing later snapshots",async()=>{
  let resolve!:(r:any[])=>void;const adapter={type:"codex",listSessions:vi.fn(()=>new Promise<any[]>(r=>resolve=r)),isReady:()=>true};
  const m=new LocalHarnessMesh({hostId:"h",adapters:new Map([['codex',adapter]]) as any,readDeadlineMs:20});
  const r=await m.snapshot();expect(r.complete).toBe(false);expect(r.sessions).toEqual([]);
  resolve([base]);await Promise.resolve();adapter.listSessions.mockImplementation(async()=>[]);
  expect((await m.snapshot()).sessions).toEqual([]);
 });
 it("projects the actual working directory from the authoritative coordination store",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-mesh-projection-"));try{
   const store=new CoordinationNoteStore(join(dir,"notes.json"),new HerderEventBus());await store.heartbeatSession({sessionId:"n",cwd:"/work"});
   const row={...base,meta:undefined,cwd:"/launch"};const adapter={type:"codex",listSessions:async()=>[row],isReady:()=>true};
   const m=new LocalHarnessMesh({hostId:"h",adapters:new Map([['codex',adapter]]) as any,projectStore:store});
   expect((await m.snapshot()).sessions[0]?.project).toEqual({launchCwd:"/launch",currentCwd:"/work",source:"coordination_activity",hostId:store.localHostId});
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it("reuses the shared durable job after admission without reading a disappeared target",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-mesh-replay-"));try{
   const sendMessage=vi.fn(async(_id:string,options:any)=>({ok:true,admitted:true,inputId:options.inputId,turnId:"t"}));
   const getSession=vi.fn(async()=>({...base,hostId:"h"}));
   const adapter={type:"codex",getSession,sendMessage,sendActiveMessage:vi.fn(async(_id:string,options:any)=>sendMessage(_id,options)),isReady:()=>true};
   const adapters=new Map([['codex',adapter]]) as any;
   const core=sharedDelivery(dir,adapter);
   const request={target:{hostId:"h",harness:"codex",nativeSessionId:"n"},sender:{hostId:"s",harness:"codex",nativeSessionId:"s"},inputId:"replay",message:"delta"};
   const mesh=new LocalHarnessMesh({hostId:"h",adapters,userMessageDelivery:core.delivery,ledgerPath:join(dir,"ledger.json")});
   const first=await mesh.deliver(request,core.ingress);expect(first.state).toBe("queued");
   await vi.waitFor(()=>expect(core.jobs.get(first.jobId!)?.state).toBe("completed"));
   const readsBeforeDuplicate=getSession.mock.calls.length;
   getSession.mockRejectedValue(new Error("target gone"));
   expect(await mesh.deliver(request,core.ingress)).toMatchObject({state:"queued",jobId:first.jobId});
   expect(getSession).toHaveBeenCalledTimes(readsBeforeDuplicate);expect(sendMessage).toHaveBeenCalledTimes(1);
   core.delivery.close();
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it("keeps per-sender budgets distinct through the real send handler: 6+6, target12, pair7 rejected",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-mesh-budget-")),oldStop=process.env.AGENT_HERDER_HUMAN_STOP_STORE;
  process.env.AGENT_HERDER_HUMAN_STOP_STORE=join(dir,"stop.json");const inject=vi.spyOn(coordinationNotes,"inject").mockImplementation(async(_session,message)=>message);
  try{
   const id=randomUUID(),session={...base,id,hostId:"h"},sendMessage=vi.fn(async(_id,options)=>({ok:true,admitted:true,inputId:options.inputId,turnId:"turn"}));
   // Real codex transports deliver into the verified active turn; the mesh
   // handler refuses other lanes, so the fixture mirrors that transport.
   const sendActiveMessage=vi.fn(async(activeId:string,activeOptions:any)=>sendMessage(activeId,{...activeOptions,activeTurnOnly:true,steer:true}));
   const getSession=vi.fn(async(target)=>target===id?session:null),adapter={type:"codex",getSession,sendMessage,sendActiveMessage,isReady:()=>true};
   const core=sharedDelivery(dir,adapter);
   const m=new LocalHarnessMesh({hostId:"h",adapters:new Map([['codex',adapter]]) as any,userMessageDelivery:core.delivery,ledgerPath:join(dir,"ledger.json")});
   const request={target:{hostId:"h",harness:"codex",nativeSessionId:id},sender:{hostId:"source",harness:"codex",nativeSessionId:"sender-a"},inputId:"",message:"delta"};
   for(const sender of ['sender-a','sender-b'])for(let n=0;n<6;n++)expect((await m.deliver({...request,sender:{...request.sender,nativeSessionId:sender},inputId:`${sender}-${n}`},core.ingress)).state).toBe("queued");
   expect((await m.deliver({...request,inputId:"pair-seven"},core.ingress)).reason).toBe("rate_limited");
   await vi.waitFor(()=>expect(core.jobs.list().filter(job=>job.state==="completed")).toHaveLength(12));
   expect(sendMessage).toHaveBeenCalledTimes(12);
   core.delivery.close();
  }finally{inject.mockRestore();if(oldStop===undefined)delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;else process.env.AGENT_HERDER_HUMAN_STOP_STORE=oldStop;await rm(dir,{recursive:true,force:true});}
 });
 it("rejects another host before touching a native adapter",async()=>{
  const m=new LocalHarnessMesh({hostId:"host",adapters:new Map()});
  const r=await m.deliver({target:{hostId:"other",harness:"codex",nativeSessionId:"n"},sender:{hostId:"src",harness:"codex",nativeSessionId:"s"},inputId:"i",message:"delta"});
  expect(r.state).toBe("not_attempted");
 });
 it("keeps same native ID and hands admission proof back, never CLI textual success",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-mesh-local-test-"));try{
  const sendMessage=vi.fn(async(_id:string,options:any)=>({ok:true,admitted:true,inputId:options.inputId,turnId:"t"}));
  const sendActiveMessage=vi.fn(async(_id:string,options:any)=>({ok:true,admitted:true,inputId:options.inputId,turnId:"unexpected-active-turn"}));
  const adapter={type:"codex",getSession:vi.fn(async()=>({...base,hostId:"host"})),sendMessage,sendActiveMessage,isReady:()=>true};
  const core=sharedDelivery(dir,adapter);
  const m=new LocalHarnessMesh({hostId:"host",adapters:new Map([['codex',adapter]]) as any,userMessageDelivery:core.delivery,ledgerPath:join(dir,"ledger.json")});
  const r=await m.deliver({target:{hostId:"host",harness:"codex",nativeSessionId:"n"},sender:{hostId:"src",harness:"codex",nativeSessionId:"s"},inputId:"i",message:"delta"},core.ingress);
  expect(r.state).toBe("queued");expect(r.jobId).toBeTruthy();
  await vi.waitFor(()=>expect(core.jobs.get(r.jobId!)?.state).toBe("completed"));
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(sendMessage.mock.calls[0]?.[0]).toBe("n");
  expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({inputId:"i",queue:true,steer:false,origin:"automation"});
  expect(sendMessage.mock.calls[0]?.[1]).not.toHaveProperty("activeTurnOnly");
  expect(sendActiveMessage).not.toHaveBeenCalled();
  expect(core.jobs.list()).toHaveLength(1);
  core.delivery.close();
  }finally{await rm(dir,{recursive:true,force:true});}
 });
});
