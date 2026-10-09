import {describe,expect,it,vi} from "vitest";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {SingletonHarnessMesh} from "../src/mesh/singleton.js";
const session={id:"native",harness:"codex",status:"running",title:"t",cwd:"/work",lastActivity:"now",meta:{launchCwd:"/launch",activeCwd:"/work",projectSource:"coordination_activity"}};
async function fixture(run:(mesh:SingletonHarnessMesh,call:ReturnType<typeof vi.fn>)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),"herder-mesh-relay-"));try{
 const call=vi.fn(async(name:string,args:any)=>name==="list_agents"?{content:[{type:"text",text:"opaque legacy overview"}],structuredContent:{complete:false,limited:true,sessions:[session],unavailable:[]}}:{content:[{type:"text",text:`Message sent. Native admission receipt: ${JSON.stringify({admitted:true,inputId:args.inputId,turnId:"t"})}`} ]});
 await run(new SingletonHarnessMesh({hostId:"100",call,ledgerPath:join(dir,"ledger.json"),verifyOwner:async()=>{},canDeliver:true,allowedSender:{hostId:"88",harness:"opencode",nativeSessionId:"source"}}),call);
}finally{await rm(dir,{recursive:true,force:true});}}
describe("thin existing singleton relay (focused integration; expected 3s, maximum 30s)",()=>{
 it("treats absent harnesses in limit1/limited:true as unobserved, keeps proven errors distinct and omits repair prose",async()=>fixture(async(mesh,call)=>{
  let r=await mesh.snapshot(1);
  expect(r.harnesses).toContainEqual({harness:"hermes",discovery:"not_observed",delivery:"unsupported",reason:"outside_snapshot_window"});
  expect(JSON.stringify(r)).not.toContain("repairPlan");expect(r.complete).toBe(false);
  call.mockResolvedValueOnce({structuredContent:{complete:false,limited:true,sessions:[session],unavailable:[{harness:"hermes",error:"transport unavailable"}]}});
  r=await mesh.snapshot(1);expect(r.harnesses).toContainEqual({harness:"hermes",discovery:"unavailable",delivery:"unsupported",reason:"singleton_native_discovery_failed"});
 }));
 it("preserves singleton actual native ID/project projection without starting an adapter",async()=>fixture(async(mesh,call)=>{
  const r=await mesh.snapshot(1);expect(call.mock.calls[0]).toEqual(["list_agents",{harness:"all",limit:1,includeLastMessage:false}]);
  expect(r.sessions[0]?.address).toEqual({hostId:"100",harness:"codex",nativeSessionId:"native"});expect(r.sessions[0]?.project.currentCwd).toBe("/work");expect(r.complete).toBe(false);
 }));
 it("returns persisted receipt without replaying accepted native singleton input",async()=>fixture(async(mesh,call)=>{
  const request={target:{hostId:"100",harness:"codex",nativeSessionId:"native"},sender:{hostId:"88",harness:"opencode",nativeSessionId:"source"},inputId:"i",message:"delta"};
  expect((await mesh.deliver(request)).state).toBe("admitted");expect((await mesh.deliver(request)).state).toBe("admitted");
  expect(call.mock.calls).toHaveLength(1);expect(call.mock.calls[0]?.[0]).toBe("send_message");expect(call.mock.calls[0]?.[1]).toEqual(expect.objectContaining({sessionId:"native",inputId:"i",mode:"steer"}));
 }));
 it("keeps lost admission UNKNOWN, no second native call",async()=>fixture(async(mesh,call)=>{
  call.mockRejectedValue(new Error("lost"));const request={target:{hostId:"100",harness:"codex",nativeSessionId:"native"},sender:{hostId:"88",harness:"opencode",nativeSessionId:"source"},inputId:"lost",message:"delta"};
  expect((await mesh.deliver(request)).state).toBe("unknown");expect((await mesh.deliver(request)).state).toBe("unknown");expect(call).toHaveBeenCalledTimes(1);
 }));
 it("rejects an unsupported upstream sender deterministically before ledger or native call",async()=>fixture(async(mesh,call)=>{
  const request={target:{hostId:"100",harness:"codex",nativeSessionId:"native"},sender:{hostId:"88",harness:"minimax-code",nativeSessionId:"source"},inputId:"unsupported",message:"delta"};
  expect((await mesh.deliver(request)).reason).toBe("unsupported_native_sender_harness");expect((await mesh.deliver(request)).state).toBe("not_attempted");expect(call).not.toHaveBeenCalled();
 }));
 it("rejects the Mac forward before snapshot labels or send, using pinned owner verifier",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-mesh-pin-"));try{
   const call=vi.fn(),verifyOwner=vi.fn(async()=>{throw new Error("singleton_native_owner_identity_unverified");});
   const mesh=new SingletonHarnessMesh({hostId:"100",call,ledgerPath:join(dir,"ledger.json"),verifyOwner});
   await expect(mesh.snapshot()).rejects.toThrow("singleton_native_owner_identity_unverified");
   const request={target:{hostId:"100",harness:"codex",nativeSessionId:"native"},sender:{hostId:"88",harness:"opencode",nativeSessionId:"source"},inputId:"mismatch",message:"delta"};
   expect((await mesh.deliver(request)).state).toBe("not_attempted");expect(call).not.toHaveBeenCalled();
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it("does not persist proven owner-PID preflight rejection as UNKNOWN and preserves prior admission",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-mesh-repin-"));try{
   let valid=false;const verifyOwner=vi.fn(async()=>{if(!valid)throw new Error("pin changed");});
   const call=vi.fn(async()=>({admitted:true,inputId:"pin",turnId:"t"}));
   const sender={hostId:"88",harness:"opencode",nativeSessionId:"source"};
   const mesh=new SingletonHarnessMesh({hostId:"100",call,verifyOwner,allowedSender:sender,canDeliver:true,ledgerPath:join(dir,"ledger.json")});
   const request={target:{hostId:"100",harness:"codex",nativeSessionId:"native"},sender,inputId:"pin",message:"delta"};
   expect((await mesh.deliver(request)).state).toBe("not_attempted");expect(call).not.toHaveBeenCalled();valid=true;
   expect((await mesh.deliver(request)).state).toBe("admitted");valid=false;
   expect((await mesh.deliver(request)).state).toBe("admitted");expect(call).toHaveBeenCalledTimes(1);expect(verifyOwner).toHaveBeenCalledTimes(2);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
});
