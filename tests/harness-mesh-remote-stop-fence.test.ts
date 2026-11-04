import {describe,expect,it,vi} from "vitest";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {handleStopAgent} from "../src/mcp-tools/handlers.js";
import {getHumanStopStore} from "../src/human-stop-store.js";
import type {AgentSession,HarnessAdapter} from "../src/types/index.js";

const session=(id:string,harness="codex"):AgentSession=>({id,harness,status:"running",title:"t",cwd:"/work",lastActivity:new Date().toISOString(),needsPermission:false,messageCount:1,lastMessage:"x"} as AgentSession);

function adapterOf(sessions:AgentSession[],stopSession:ReturnType<typeof vi.fn>):HarnessAdapter{
 return {type:"codex",name:"Fixture",async init(){},async listSessions(){return sessions;},async getSession(id:string){return sessions.find(s=>s.id===id)??null;},async getParent(){return null;},async listChildren(){return[];},async listModels(){return[];},async sendMessage(){return{ok:true};},async stopSession(id:string){return stopSession(id);},async respondPermission(){return{ok:true};},async setPermissions(){return{ok:true};},async createSession(){return session("created");},async changeModel(){return{ok:true};}} as unknown as HarnessAdapter;
}

describe("the fence of a stop on another machine",()=>{
 it("records the manual hold on the target host and aborts the session once",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"remote-stop-fence-"));try{
   const stopSession=vi.fn(async()=>({ok:true,sessionId:"native-1"}));
   const adapters=new Map([["codex",adapterOf([session("native-1")],stopSession)]]) as any;
   const stop=(inputId:string)=>handleStopAgent(adapters,{sessionId:"native-1",harness:"codex",inputId},{localHostId:"mac",ledgerPath:join(dir,"ledger.json")});
   const receipt=(await stop("stop-1")).structured;
   expect(receipt.state).toBe("admitted");
   expect(receipt.held).toBe(true);
   // The hold of the target host is what fences its own delivery path.
   expect(await getHumanStopStore().isHeld("codex","native-1")).toBe(true);
   expect(stopSession).toHaveBeenCalledTimes(1);
   // A repeated stop is one hold and one abort.
   expect((await stop("stop-1")).structured.state).toBe("admitted");
   expect(stopSession).toHaveBeenCalledTimes(1);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it("persists the manual hold for MiniMax before a native stop as well",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"remote-stop-fence-"));try{
   const stopSession=vi.fn(async()=>({ok:true,sessionId:"native-2"}));
   const adapters=new Map([["minimax-code",adapterOf([session("native-2","minimax-code")],stopSession)]]) as any;
   const receipt=(await handleStopAgent(adapters,{sessionId:"native-2",harness:"minimax-code",inputId:"stop-2"},{localHostId:"mac",ledgerPath:join(dir,"ledger.json")})).structured;
   expect(receipt.state).toBe("admitted");
   expect(receipt.held).toBe(true);
   expect(receipt.reason).toBe("native_session_stopped");
   expect(await getHumanStopStore().isHeld("minimax-code","native-2")).toBe(true);
   expect(stopSession).toHaveBeenCalledTimes(1);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it("does not replay an unproven stop",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"remote-stop-fence-"));try{
   const stopSession=vi.fn(async()=>{throw new Error("the runtime did not answer");});
   const adapters=new Map([["codex",adapterOf([session("native-3")],stopSession)]]) as any;
   const stop=()=>handleStopAgent(adapters,{sessionId:"native-3",harness:"codex",inputId:"stop-3"},{localHostId:"mac",ledgerPath:join(dir,"ledger.json")});
   const receipt=(await stop()).structured;
   expect(receipt.state).toBe("unknown");
   expect(receipt.retryable).toBe(false);
   expect((await stop()).structured.state).toBe("unknown");
   expect(stopSession).toHaveBeenCalledTimes(1);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it("never reports a plain success from the hub when the hold was not recorded",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"remote-stop-fence-"));
  try{
   const transport={call:async()=>({state:"admitted",inputId:"x",hostId:"mac",harness:"minimax-code",nativeSessionId:"native-2",retryable:false,reason:"native_session_stopped_without_hold",held:false})};
   const message=await handleStopAgent(new Map(),{sessionId:"native-2",harness:"minimax-code",hostId:"mac"},{transport:transport as any,localHostId:"host-100"});
   expect(message.text).toContain("Stopped agent [minimax-code] native-2 on host 'mac'");
   expect(message.text).toContain("the hold was not recorded");
   expect(message.structured.held).toBe(false);
   const held={call:async()=>({state:"admitted",inputId:"x",hostId:"mac",harness:"codex",nativeSessionId:"native-1",retryable:false,reason:"native_session_stopped",held:true})};
   const plain=await handleStopAgent(new Map(),{sessionId:"native-1",harness:"codex",hostId:"mac"},{transport:held as any,localHostId:"host-100"});
   expect(plain.text).toBe("Stopped agent [codex] native-1 on host 'mac'.");
   expect(plain.structured.held).toBe(true);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it("keeps the local stop path as it was",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"remote-stop-fence-"));
  try{
   const stopSession=vi.fn(async()=>({ok:true,sessionId:"native-4"}));
   const adapter=adapterOf([session("native-4")],stopSession);
   const message=await handleStopAgent(new Map([["codex",adapter]]) as any,{sessionId:"native-4",harness:"codex"});
   expect(message.text).toBe("Stopped agent [codex] native-4.");
   expect(message.structured.state).toBe("admitted");
   expect(stopSession).toHaveBeenCalledTimes(1);
   expect(await getHumanStopStore().isHeld("codex","native-4")).toBe(true);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
});
