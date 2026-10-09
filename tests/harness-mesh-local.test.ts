import {describe,expect,it,vi} from "vitest";
import {LocalHarnessMesh} from "../src/mesh/local.js";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CoordinationNoteStore} from "../src/coordination-notes.js";
import {HerderEventBus} from "../src/herder-events.js";
import {coordinationNotes} from "../src/coordination-notes.js";
import {randomUUID} from "node:crypto";
const base={id:"n",harness:"codex",status:"running",cwd:"/launch",title:"t",lastActivity:new Date().toISOString(),needsPermission:false,meta:{activeCwd:"/actual",launchCwd:"/launch",projectSource:"native"}};
describe("local mesh capabilities (focused integration; expected 5s, maximum 30s)",()=>{
 it("uses bounded discovery and does not activate a disconnected lazy native adapter",async()=>{
  const active={type:"codex",listSessions:vi.fn(async()=>[base]),getSession:vi.fn(async()=>base),isReady:()=>true};
  const disconnected={type:"zcode",lazyStart:true,isReady:()=>false,listSessions:vi.fn()};
  const m=new LocalHarnessMesh({hostId:"host",adapters:new Map([['codex',active],['zcode',disconnected]]) as any});
  const r=await m.snapshot(3);expect(active.listSessions).toHaveBeenCalledWith({limit:3});expect(disconnected.listSessions).not.toHaveBeenCalled();
  expect(r.sessions[0]?.project.currentCwd).toBe("/actual");
  expect(r.harnesses).toContainEqual(expect.objectContaining({harness:"minimax-code",delivery:"unsupported",repairPlan:expect.any(String)}));
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
   expect((await m.snapshot()).sessions[0]?.project).toEqual({launchCwd:"/launch",currentCwd:"/work",source:"coordination_activity"});
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it("returns durable admission before reading a disappeared or stopped target",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-mesh-replay-"));try{
   const send=vi.fn(async()=>({admitted:true,inputId:"replay",turnId:"t"})),getSession=vi.fn(async()=>base);
   const adapters=new Map([['codex',{type:"codex",getSession,isReady:()=>true}]]) as any;
   const request={target:{hostId:"h",harness:"codex",nativeSessionId:"n"},sender:{hostId:"s",harness:"codex",nativeSessionId:"s"},inputId:"replay",message:"delta"};
   const deps={hostId:"h",adapters,send,ledgerPath:join(dir,"ledger.json")};expect((await new LocalHarnessMesh(deps).deliver(request)).state).toBe("admitted");
   getSession.mockRejectedValue(new Error("target gone"));expect((await new LocalHarnessMesh(deps).deliver(request)).state).toBe("admitted");expect(getSession).toHaveBeenCalledTimes(1);expect(send).toHaveBeenCalledTimes(1);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it("keeps per-sender budgets distinct through the real send handler: 6+6, target12, pair7 rejected",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-mesh-budget-")),oldStop=process.env.AGENT_HERDER_HUMAN_STOP_STORE;
  process.env.AGENT_HERDER_HUMAN_STOP_STORE=join(dir,"stop.json");const inject=vi.spyOn(coordinationNotes,"inject").mockImplementation(async(_session,message)=>message);
  try{
   const id=randomUUID(),session={...base,id},sendMessage=vi.fn(async(_id,options)=>({ok:true,admitted:true,inputId:options.inputId,turnId:"turn"}));
   const getSession=vi.fn(async(target)=>target===id?session:null),adapter={type:"codex",getSession,sendMessage,isReady:()=>true};
   const m=new LocalHarnessMesh({hostId:"h",adapters:new Map([['codex',adapter]]) as any,ledgerPath:join(dir,"ledger.json")});
   const request={target:{hostId:"h",harness:"codex",nativeSessionId:id},sender:{hostId:"source",harness:"codex",nativeSessionId:"sender-a"},inputId:"",message:"delta"};
   for(const sender of ['sender-a','sender-b'])for(let n=0;n<6;n++)expect((await m.deliver({...request,sender:{...request.sender,nativeSessionId:sender},inputId:`${sender}-${n}`})).state).toBe("admitted");
   expect((await m.deliver({...request,inputId:"pair-seven"})).reason).toBe("rate_limited");expect(sendMessage).toHaveBeenCalledTimes(12);
  }finally{inject.mockRestore();if(oldStop===undefined)delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;else process.env.AGENT_HERDER_HUMAN_STOP_STORE=oldStop;await rm(dir,{recursive:true,force:true});}
 });
 it("rejects another host before touching a native adapter",async()=>{
  const send=vi.fn();const m=new LocalHarnessMesh({hostId:"host",adapters:new Map(),send});
  const r=await m.deliver({target:{hostId:"other",harness:"codex",nativeSessionId:"n"},sender:{hostId:"src",harness:"codex",nativeSessionId:"s"},inputId:"i",message:"delta"});
  expect(r.state).toBe("not_attempted");expect(send).not.toHaveBeenCalled();
 });
 it("keeps same native ID and hands admission proof back, never CLI textual success",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-mesh-local-test-"));try{
  const send=vi.fn(async()=>({admitted:true,inputId:"i",turnId:"t"}));
  const adapter={type:"codex",getSession:vi.fn(async()=>base),isReady:()=>true};
  const m=new LocalHarnessMesh({hostId:"host",adapters:new Map([['codex',adapter]]) as any,send,ledgerPath:join(dir,"ledger.json")});
  const r=await m.deliver({target:{hostId:"host",harness:"codex",nativeSessionId:"n"},sender:{hostId:"src",harness:"codex",nativeSessionId:"s"},inputId:"i",message:"delta"});
  expect(r.state).toBe("admitted");expect(send.mock.calls[0]?.[0]).toEqual(expect.objectContaining({sessionId:"n",inputId:"i"}));
  }finally{await rm(dir,{recursive:true,force:true});}
 });
});
