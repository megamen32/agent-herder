import { describe,expect,it,vi } from "vitest";
import { GptAdminMesh } from "../src/mesh/gptadmin.js";
const a={hostId:"100",harness:"codex",nativeSessionId:"native"};
function hub(){return {discover:vi.fn(async()=>({servers:[{server_id:"mcp:shell:100:Herder",kind:"child_mcp",status:"online"},{server_id:"shell:mac",kind:"virtual_shell",status:"online"}]})),schema:vi.fn(async()=>({tools:[{name:"mesh_snapshot"},{name:"mesh_deliver"}]})),call:vi.fn(async(_target:string,name:string,args:Record<string,unknown>)=>name==="mesh_snapshot"?{hostId:"100",sessions:[{address:a,project:{launchCwd:"/launch",currentCwd:"/actual",source:"native"},status:"running",title:"test",lastActivity:"now"}],harnesses:[],complete:true}:{state:"admitted",inputId:args.inputId,turnId:"turn",retryable:false})};}
describe("GPTAdmin native mesh (focused integration; expected 5s, maximum 30s)",()=>{
 it("unwraps the real GPTAdmin mcp_call envelope containing MCP JSON text",async()=>{
  const h=hub(),original=h.call.getMockImplementation()!;
  h.call.mockImplementation(async(...args)=>({structuredContent:{status:"completed",result:{structuredContent:{ref:"Herder",name:args[1],result:{content:[{type:"text",text:JSON.stringify(await original(...args))}]}}}}}) as any);
  const m=new GptAdminMesh(h);expect((await m.discover()).sessions).toHaveLength(1);
  expect((await m.deliver({target:a,sender:{...a,nativeSessionId:"s"},inputId:"real-envelope",message:"delta"})).state).toBe("admitted");
 });
 it("uses discovered exact targets and schema, reports missing remote child as partial",async()=>{
  const h=hub(); const m=new GptAdminMesh(h); const r=await m.discover();
  expect(r.sessions[0]?.project.currentCwd).toBe("/actual");expect(r.complete).toBe(false);
  expect(r.hosts).toContainEqual(expect.objectContaining({hostId:"mac",state:"unavailable"}));
  expect(h.schema).toHaveBeenCalledWith("mcp:shell:100:Herder");
  expect(h.call.mock.calls[0]?.[2]).toEqual({limit:12});
 });
 it("rejects a forwarded endpoint with another native host identity",async()=>{
  const h=hub();h.call.mockImplementation(async()=>({hostId:"other",sessions:[],harnesses:[],complete:true}) as any);
  expect((await new GptAdminMesh(h).discover()).sessions).toEqual([]);
  expect((await new GptAdminMesh(h).discover()).hosts[0]?.state).toBe("unavailable");
 });
 it("forwards exact native address and stable ID once, no retry after lost admission",async()=>{
  const h=hub();const m=new GptAdminMesh(h);await m.discover();
  h.call.mockRejectedValue(new Error("lost response"));
  const request={target:a,sender:{...a,nativeSessionId:"sender"},inputId:"i",message:"delta"};
  expect((await m.deliver(request)).state).toBe("unknown");expect((await m.deliver(request)).state).toBe("unknown");
  expect(h.call.mock.calls.filter(c=>c[1]==="mesh_deliver")).toHaveLength(1);
 });
 it("does not replay an input ID with changed delta or sender",async()=>{
  const h=hub();const m=new GptAdminMesh(h);await m.discover();
  const request={target:a,sender:{...a,nativeSessionId:"sender"},inputId:"i",message:"delta"};
  await m.deliver(request);expect((await m.deliver({...request,message:"other"})).reason).toBe("input_id_conflict");
 });
 it("allows a proven pre-admission busy rejection to retry with the same input ID",async()=>{
  const h=hub();const m=new GptAdminMesh(h);await m.discover();
  h.call.mockResolvedValueOnce({state:"not_attempted",inputId:"busy",retryable:true,reason:"mesh_admission_busy"} as any);
  const request={target:a,sender:{...a,nativeSessionId:"sender"},inputId:"busy",message:"delta"};
  expect((await m.deliver(request)).state).toBe("not_attempted");expect((await m.deliver(request)).state).toBe("admitted");
 });
 it("applies the discovery limit to merged output across hosts",async()=>{
  const h=hub();h.discover.mockResolvedValue({servers:[{server_id:"mcp:shell:100:Herder",kind:"child_mcp",status:"online"},{server_id:"mcp:shell:88:Herder",kind:"child_mcp",status:"online"}]} as any);
  h.call.mockImplementation(async(target)=>{const hostId=target.includes(":88:")?"88":"100";return {hostId,sessions:Array.from({length:3},(_,n)=>({address:{...a,hostId,nativeSessionId:String(n)},project:{currentCwd:null,launchCwd:"/x",source:"unverified"},status:"idle",title:"t",lastActivity:"now"})),harnesses:[],complete:true} as any;});
  const r=await new GptAdminMesh(h).discover(3);expect(r.sessions).toHaveLength(3);expect(r.limited).toBe(true);expect(r.complete).toBe(false);
 });
});
