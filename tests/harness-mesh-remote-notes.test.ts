import {describe,expect,it,vi} from "vitest";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {GptAdminMesh} from "../src/mesh/gptadmin.js";
import {coordinationNotes} from "../src/coordination-notes.js";

const address={hostId:"100",harness:"minimax-code",nativeSessionId:"native-remote"};

function hub(project:{launchCwd:string|null;currentCwd:string|null}){
 return {
  discover:vi.fn(async()=>({servers:[{server_id:"mcp:shell:100:Herder",kind:"child_mcp",status:"online"}]})),
  schema:vi.fn(async()=>({tools:[{name:"mesh_snapshot"},{name:"mesh_deliver"}]})),
  call:vi.fn(async(_target:string,name:string,args:Record<string,unknown>)=>name==="mesh_snapshot"
   ? {hostId:"100",sessions:[{address:{...address,nativeSessionId:"native-remote"},project:{...project,source:project.currentCwd?"native":"unverified"},status:"running",title:"t",lastActivity:"now"}],harnesses:[],complete:true}
   : {state:"admitted",inputId:args.inputId,turnId:"turn",retryable:false}),
 };
}

describe("the notes of the hub in a delivery to another machine",()=>{
 it("carries the active notes of the hub into the native session of the other machine",async()=>{
  const root=await mkdtemp(join(tmpdir(),"remote-notes-"));
  try{
   await coordinationNotes.create({authorSessionId:"other-session",kind:"avoid",cwd:root,hostId:"100",message:"src/a.ts is mine",paths:["src/a.ts"]});
   const h=hub({launchCwd:root,currentCwd:null});
   const mesh=new GptAdminMesh(h as never);
   await mesh.discover();
   const receipt=await mesh.deliver({target:address,sender:{...address,nativeSessionId:"source"},inputId:"notes-1",message:"work"});
   expect(receipt.state).toBe("admitted");
   const sent=h.call.mock.calls.find(call=>call[1]==="mesh_deliver");
   const message=String((sent?.[2] as {message?:string}).message??"");
   expect(message).toContain("<agent-herder-coordination");
   expect(message).toContain("src/a.ts");
   expect(message).toContain("work");
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it("never carries two coordination blocks",async()=>{
  const root=await mkdtemp(join(tmpdir(),"remote-notes-"));
  try{
   await coordinationNotes.create({authorSessionId:"other-session",kind:"avoid",cwd:root,hostId:"100",message:"src/a.ts is mine",paths:["src/a.ts"]});
   const h=hub({launchCwd:root,currentCwd:null});
   const mesh=new GptAdminMesh(h as never);
   await mesh.discover();
   await mesh.deliver({target:address,sender:{...address,nativeSessionId:"source"},inputId:"notes-2",message:"work"});
   const sent=h.call.mock.calls.find(call=>call[1]==="mesh_deliver");
   const message=String((sent?.[2] as {message?:string}).message??"");
   // The remote side injects its own notes only when the block is not there.
   const remoteSide=await coordinationNotes.inject({id:"native-remote",harness:"minimax-code",cwd:root},message);
   expect(remoteSide).toBe(message);
   expect(message.match(/<agent-herder-coordination/g)).toHaveLength(1);
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it("keeps the codex lane of the network path as it was",async()=>{
  const root=await mkdtemp(join(tmpdir(),"remote-notes-"));
  try{
   await coordinationNotes.create({authorSessionId:"other-session",kind:"avoid",cwd:root,hostId:"100",message:"src/a.ts is mine",paths:["src/a.ts"]});
   const h=hub({launchCwd:root,currentCwd:null});
   const mesh=new GptAdminMesh(h as never);
   await mesh.discover();
   await mesh.deliver({target:{...address,harness:"codex"},sender:{...address,nativeSessionId:"source"},inputId:"notes-3",message:"work"});
   const sent=h.call.mock.calls.find(call=>call[1]==="mesh_deliver");
   expect(String((sent?.[2] as {message?:string}).message??"")).toBe("work");
  }finally{await rm(root,{recursive:true,force:true});}
 });
});
