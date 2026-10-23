import {describe,expect,it,vi} from "vitest";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {LocalHarnessMesh} from "../src/mesh/local.js";
import {CoordinationNoteStore} from "../src/coordination-notes.js";
import {HerderEventBus} from "../src/herder-events.js";

const nativeSession={id:"mvs_native",harness:"minimax-code",status:"idle",title:"t",cwd:"/work",hostId:"h",lastActivity:new Date().toISOString(),needsPermission:false};
const request={target:{hostId:"h",harness:"minimax-code",nativeSessionId:"mvs_native"},sender:{hostId:"src",harness:"codex",nativeSessionId:"s"},inputId:"i-1",message:"delta"};

describe("native MiniMax Code delivery (focused integration; expected 5s, maximum 30s)",()=>{
 it("admits a native session with a proof and never sends one intent twice",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-minimax-delivery-"));try{
   const sendMessage=vi.fn(async(_id:string,options:any)=>({ok:true,admitted:true,turnId:"item-1",inputId:options.inputId}));
   const adapter={type:"minimax-code",getSession:vi.fn(async()=>nativeSession),sendMessage,isReady:()=>true};
   const mesh=new LocalHarnessMesh({hostId:"h",adapters:new Map([["minimax-code",adapter]]) as any,ledgerPath:join(dir,"ledger.json"),nativeObserve:async(harness,id)=>harness==="minimax-code"&&id==="mvs_native"?{nativeSessionId:id,status:"idle",cwd:"/work"}:null});
   const receipt=await mesh.deliver(request);
   expect(receipt.state).toBe("admitted");
   expect(receipt.turnId).toBe("item-1");
   expect(sendMessage).toHaveBeenCalledTimes(1);
   expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({queue:true,inputId:"i-1"});
   // The same intent is never executed twice.
   expect((await mesh.deliver(request)).state).toBe("admitted");
   expect(sendMessage).toHaveBeenCalledTimes(1);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it("steers the current running native session instead of leaving a new directive queued",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-minimax-steer-"));try{
   const sendMessage=vi.fn(async(_id:string,options:any)=>({ok:true,admitted:true,turnId:"current-turn",inputId:options.inputId}));
   const adapter={type:"minimax-code",getSession:vi.fn(async()=>({...nativeSession,status:"running"})),sendMessage,isReady:()=>true};
   const mesh=new LocalHarnessMesh({hostId:"h",adapters:new Map([["minimax-code",adapter]]) as any,ledgerPath:join(dir,"ledger.json"),nativeObserve:async(_h,id)=>({nativeSessionId:id,status:"running",cwd:"/work"})});
   expect((await mesh.deliver(request)).state).toBe("admitted");
   expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({steer:true,inputId:"i-1"});
   await mesh.deliver(request);expect(sendMessage).toHaveBeenCalledTimes(1);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it("refuses another host and an unknown native session before the writer",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-minimax-delivery-"));try{
   const sendMessage=vi.fn();
   const adapter={type:"minimax-code",getSession:vi.fn(async()=>nativeSession),sendMessage,isReady:()=>true};
   const mesh=new LocalHarnessMesh({hostId:"h",adapters:new Map([["minimax-code",adapter]]) as any,ledgerPath:join(dir,"ledger.json"),nativeObserve:async()=>null});
   const foreign=await mesh.deliver({...request,target:{...request.target,hostId:"mac"}});
   expect(foreign.state).toBe("not_attempted");
   expect(foreign.reason).toBe("native_host_identity_mismatch");
   const unknown=await mesh.deliver(request);
   expect(unknown.state).toBe("not_attempted");
   expect(unknown.reason).toBe("independent_native_identity_unknown");
   expect(sendMessage).not.toHaveBeenCalled();
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it("never replays an unproven admission",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-minimax-delivery-"));try{
   const sendMessage=vi.fn(async()=>{throw new Error("the runtime did not answer");});
   const adapter={type:"minimax-code",getSession:vi.fn(async()=>nativeSession),sendMessage,isReady:()=>true};
   const mesh=new LocalHarnessMesh({hostId:"h",adapters:new Map([["minimax-code",adapter]]) as any,ledgerPath:join(dir,"ledger.json"),nativeObserve:async(_h,id)=>({nativeSessionId:id,status:"idle",cwd:"/work"})});
   const receipt=await mesh.deliver(request);
   expect(receipt.state).toBe("unknown");
   expect(receipt.retryable).toBe(false);
   expect((await mesh.deliver(request)).state).toBe("unknown");
   expect(sendMessage).toHaveBeenCalledTimes(1);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it("carries the active coordination notes into the native session",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-minimax-delivery-"));try{
   const store=new CoordinationNoteStore(join(dir,"notes.json"),new HerderEventBus());
   await store.create({authorSessionId:"other",kind:"avoid",cwd:"/work",hostId:"h",message:"src/a.ts is mine",paths:["src/a.ts"]});
   const sendMessage=vi.fn(async(_id:string,options:any)=>({ok:true,admitted:true,turnId:"item-1",inputId:options.inputId}));
   const adapter={type:"minimax-code",getSession:vi.fn(async()=>nativeSession),sendMessage,isReady:()=>true};
   const mesh=new LocalHarnessMesh({hostId:"h",adapters:new Map([["minimax-code",adapter]]) as any,ledgerPath:join(dir,"ledger.json"),nativeObserve:async(_h,id)=>({nativeSessionId:id,status:"idle",cwd:"/work"}),notes:(session,message)=>store.inject(session,message)});
   await mesh.deliver(request);
   const delivered=String(sendMessage.mock.calls[0]?.[1]?.message??"");
   expect(delivered).toContain("src/a.ts");
   expect(delivered).toContain("delta");
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it("keeps the native address of a remote session apart from a local session of the same id",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-minimax-delivery-"));try{
   const sendMessage=vi.fn(async(_id:string,options:any)=>({ok:true,admitted:true,turnId:"item-1",inputId:options.inputId}));
   const adapter={type:"minimax-code",getSession:vi.fn(async()=>nativeSession),sendMessage,isReady:()=>true};
   const mesh=new LocalHarnessMesh({hostId:"h",adapters:new Map([["minimax-code",adapter]]) as any,ledgerPath:join(dir,"ledger.json"),nativeObserve:async(_h,id)=>({nativeSessionId:id,status:"idle",cwd:"/work"})});
   const remote=await mesh.deliver({...request,inputId:"i-remote",target:{hostId:"mac",harness:"minimax-code",nativeSessionId:"mvs_native"}});
   expect(remote.state).toBe("not_attempted");
   expect(remote.reason).toBe("native_host_identity_mismatch");
   // The same native id on this host is a different address and stays deliverable.
   expect((await mesh.deliver({...request,inputId:"i-local"})).state).toBe("admitted");
  }finally{await rm(dir,{recursive:true,force:true});}
 });
});
