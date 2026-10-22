import {describe,expect,it,vi} from "vitest";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {LocalHarnessMesh} from "../src/mesh/local.js";
import {handleStopAgent} from "../src/mcp-tools/handlers.js";

const nativeSession={id:"mvs_native",harness:"minimax-code",status:"idle",title:"t",cwd:"/work",hostId:"h",lastActivity:new Date().toISOString(),needsPermission:false};
const target={hostId:"h",harness:"minimax-code",nativeSessionId:"mvs_native"};

describe("native MiniMax Code stop (focused integration; expected 5s, maximum 30s)",()=>{
 it("stops a native session of this host once and keeps its receipt",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-minimax-stop-"));try{
   const stopSession=vi.fn(async()=>({ok:true,sessionId:"mvs_native"}));
   const adapter={type:"minimax-code",getSession:vi.fn(async()=>nativeSession),stopSession,isReady:()=>true};
   const mesh=new LocalHarnessMesh({hostId:"h",adapters:new Map([["minimax-code",adapter]]) as any,ledgerPath:join(dir,"ledger.json")});
   const receipt=await mesh.stop({target,inputId:"stop-1"});
   expect(receipt.state).toBe("admitted");
   expect(receipt.nativeSessionId).toBe("mvs_native");
   expect(stopSession).toHaveBeenCalledTimes(1);
   // One intent stops the session once.
   expect((await mesh.stop({target,inputId:"stop-1"})).state).toBe("admitted");
   expect(stopSession).toHaveBeenCalledTimes(1);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it("never replays a stop whose outcome stayed unknown",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-minimax-stop-"));try{
   const stopSession=vi.fn(async()=>{throw new Error("the runtime did not answer");});
   const adapter={type:"minimax-code",getSession:vi.fn(async()=>nativeSession),stopSession,isReady:()=>true};
   const mesh=new LocalHarnessMesh({hostId:"h",adapters:new Map([["minimax-code",adapter]]) as any,ledgerPath:join(dir,"ledger.json")});
   const receipt=await mesh.stop({target,inputId:"stop-unknown"});
   expect(receipt.state).toBe("unknown");
   expect(receipt.retryable).toBe(false);
   expect((await mesh.stop({target,inputId:"stop-unknown"})).state).toBe("unknown");
   expect(stopSession).toHaveBeenCalledTimes(1);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it("stops a native session of another machine through its own peer transport",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-minimax-stop-")),old=process.env.AGENT_HERDER_HUMAN_STOP_STORE;
  process.env.AGENT_HERDER_HUMAN_STOP_STORE=join(dir,"stop.json");
  try{
   const calls:any[]=[];
   const transport={call:async(target:string,tool:string,args:any)=>{calls.push({target,tool,args});return {state:"admitted",inputId:args.inputId,hostId:"mac",harness:args.target.harness,nativeSessionId:args.target.nativeSessionId,retryable:false};}};
   const message=await handleStopAgent(new Map(),{sessionId:"mvs_native",harness:"minimax-code",hostId:"mac"},{transport:transport as any,localHostId:"host100"});
   expect(message).toContain("Stopped agent [minimax-code] mvs_native on host 'mac'");
   expect(calls[0]?.tool).toBe("mesh_stop");
   expect(calls[0]?.target).toBe("mcp:shell:mac:AgentHerder");
   expect(calls[0]?.args.target).toEqual({hostId:"mac",harness:"minimax-code",nativeSessionId:"mvs_native"});
  }finally{if(old===undefined)delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;else process.env.AGENT_HERDER_HUMAN_STOP_STORE=old;await rm(dir,{recursive:true,force:true});}
 });
 it("reports an unproven remote stop instead of replaying it",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-minimax-stop-")),old=process.env.AGENT_HERDER_HUMAN_STOP_STORE;
  process.env.AGENT_HERDER_HUMAN_STOP_STORE=join(dir,"stop.json");
  try{
   const transport={call:async()=>({state:"unknown",inputId:"x",retryable:false,reason:"native_stop_unknown"})};
   const message=await handleStopAgent(new Map(),{sessionId:"mvs_native",harness:"minimax-code",hostId:"mac"},{transport:transport as any,localHostId:"host100"});
   expect(message).toContain("unproven");
   expect(message).toContain("must not be replayed");
  }finally{if(old===undefined)delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;else process.env.AGENT_HERDER_HUMAN_STOP_STORE=old;await rm(dir,{recursive:true,force:true});}
 });
 it("keeps the local stop path working",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-minimax-stop-")),old=process.env.AGENT_HERDER_HUMAN_STOP_STORE;
  process.env.AGENT_HERDER_HUMAN_STOP_STORE=join(dir,"stop.json");
  try{
   const stopSession=vi.fn(async()=>({ok:true,sessionId:"mvs_native"}));
   const adapter={type:"minimax-code",getSession:vi.fn(async()=>nativeSession),stopSession,isReady:()=>true};
   const message=await handleStopAgent(new Map([["minimax-code",adapter]]) as any,{sessionId:"mvs_native",harness:"minimax-code"});
   expect(message).toBe("Stopped agent [minimax-code] mvs_native.");
   expect(stopSession).toHaveBeenCalledTimes(1);
  }finally{if(old===undefined)delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;else process.env.AGENT_HERDER_HUMAN_STOP_STORE=old;await rm(dir,{recursive:true,force:true});}
 });
});
