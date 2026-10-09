import {describe,expect,it,vi} from "vitest";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {SingletonHarnessMesh} from "../src/mesh/singleton.js";
const session={id:"native",harness:"codex",status:"running",title:"t",cwd:"/work",lastActivity:"now",meta:{launchCwd:"/launch",activeCwd:"/work",projectSource:"coordination_activity"}};
async function fixture(run:(mesh:SingletonHarnessMesh,call:ReturnType<typeof vi.fn>)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),"herder-mesh-relay-"));try{
 const call=vi.fn(async(name:string,args:any)=>name==="list_agents"?{content:[{type:"text",text:"opaque legacy overview"}],structuredContent:{complete:false,limited:true,sessions:[session],unavailable:[]}}:{content:[{type:"text",text:`Message sent. Native admission receipt: ${JSON.stringify({admitted:true,inputId:args.inputId,turnId:"t"})}`} ]});
 await run(new SingletonHarnessMesh({hostId:"100",call,ledgerPath:join(dir,"ledger.json")}),call);
}finally{await rm(dir,{recursive:true,force:true});}}
describe("thin existing singleton relay (focused integration; expected 3s, maximum 30s)",()=>{
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
});
