import {describe,expect,it,vi} from "vitest";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {handleStopAgent} from "../src/mcp-tools/handlers.js";

const nativeSession={id:"mvs_native",harness:"minimax-code",status:"idle",title:"t",cwd:"/work",hostId:"h",lastActivity:new Date().toISOString(),needsPermission:false};

describe("native MiniMax Code stop through the consolidated stop_agent command (focused integration; expected 5s, maximum 30s)",()=>{
 it("stops a native session of this host once and keeps its receipt",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-minimax-stop-")),old=process.env.AGENT_HERDER_HUMAN_STOP_STORE;
  process.env.AGENT_HERDER_HUMAN_STOP_STORE=join(dir,"stop.json");
  try{
   const stopSession=vi.fn(async()=>({ok:true,sessionId:"mvs_native"}));
   const adapter={type:"minimax-code",getSession:vi.fn(async()=>nativeSession),stopSession,isReady:()=>true};
   const stop=(inputId:string)=>handleStopAgent(new Map([["minimax-code",adapter]]) as any,{sessionId:"mvs_native",harness:"minimax-code",inputId},{localHostId:"h",ledgerPath:join(dir,"ledger.json")});
   const first=await stop("stop-1");
   expect(first.structured.state).toBe("admitted");
   expect(first.text).toContain("Stopped agent [minimax-code] mvs_native");
   expect(stopSession).toHaveBeenCalledTimes(1);
   // One stable intent stops the session once.
   const replay=await stop("stop-1");
   expect(replay.structured.state).toBe("admitted");
   expect(stopSession).toHaveBeenCalledTimes(1);
  }finally{if(old===undefined)delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;else process.env.AGENT_HERDER_HUMAN_STOP_STORE=old;await rm(dir,{recursive:true,force:true});}
 });
 it("never replays a stop whose outcome stayed unknown",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-minimax-stop-")),old=process.env.AGENT_HERDER_HUMAN_STOP_STORE;
  process.env.AGENT_HERDER_HUMAN_STOP_STORE=join(dir,"stop.json");
  try{
   const stopSession=vi.fn(async()=>{throw new Error("the runtime did not answer");});
   const adapter={type:"minimax-code",getSession:vi.fn(async()=>nativeSession),stopSession,isReady:()=>true};
   const stop=(inputId:string)=>handleStopAgent(new Map([["minimax-code",adapter]]) as any,{sessionId:"mvs_native",harness:"minimax-code",inputId},{localHostId:"h",ledgerPath:join(dir,"ledger.json")});
   const receipt=await stop("stop-unknown");
   expect(receipt.structured.state).toBe("unknown");
   expect(receipt.structured.retryable).toBe(false);
   expect((await stop("stop-unknown")).structured.state).toBe("unknown");
   expect(stopSession).toHaveBeenCalledTimes(1);
  }finally{if(old===undefined)delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;else process.env.AGENT_HERDER_HUMAN_STOP_STORE=old;await rm(dir,{recursive:true,force:true});}
 });
 it("stops a native session of another machine through its own peer transport",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-minimax-stop-")),old=process.env.AGENT_HERDER_HUMAN_STOP_STORE;
  process.env.AGENT_HERDER_HUMAN_STOP_STORE=join(dir,"stop.json");
  try{
   const calls:any[]=[];
   const transport={call:async(target:string,tool:string,args:any)=>{calls.push({target,tool,args});return {state:"admitted",inputId:args.inputId,hostId:"mac",harness:args.harness,nativeSessionId:args.sessionId,retryable:false};}};
   const outcome=await handleStopAgent(new Map(),{sessionId:"mvs_native",harness:"minimax-code",hostId:"mac"},{transport:transport as any,localHostId:"host100"});
   expect(outcome.text).toContain("Stopped agent [minimax-code] mvs_native on host 'mac'");
   expect(outcome.structured.state).toBe("admitted");
   expect(calls[0]?.tool).toBe("stop_agent");
   expect(calls[0]?.target).toBe("mcp:shell:mac:AgentHerder");
   expect(calls[0]?.args).toEqual(expect.objectContaining({sessionId:"mvs_native",harness:"minimax-code"}));
   expect(calls[0]?.args.target).toBeUndefined();
  }finally{if(old===undefined)delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;else process.env.AGENT_HERDER_HUMAN_STOP_STORE=old;await rm(dir,{recursive:true,force:true});}
 });
 it("reports an unproven remote stop instead of replaying it",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-minimax-stop-")),old=process.env.AGENT_HERDER_HUMAN_STOP_STORE;
  process.env.AGENT_HERDER_HUMAN_STOP_STORE=join(dir,"stop.json");
  try{
   const transport={call:async()=>({state:"unknown",inputId:"x",retryable:false,reason:"native_stop_unknown"})};
   const outcome=await handleStopAgent(new Map(),{sessionId:"mvs_native",harness:"minimax-code",hostId:"mac"},{transport:transport as any,localHostId:"host100"});
   expect(outcome.text).toContain("unproven");
   expect(outcome.text).toContain("must not be replayed");
   expect(outcome.structured.state).toBe("unknown");
  }finally{if(old===undefined)delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;else process.env.AGENT_HERDER_HUMAN_STOP_STORE=old;await rm(dir,{recursive:true,force:true});}
 });
 it("keeps the local stop path working",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-minimax-stop-")),old=process.env.AGENT_HERDER_HUMAN_STOP_STORE;
  process.env.AGENT_HERDER_HUMAN_STOP_STORE=join(dir,"stop.json");
  try{
   const stopSession=vi.fn(async()=>({ok:true,sessionId:"mvs_native"}));
   const adapter={type:"minimax-code",getSession:vi.fn(async()=>nativeSession),stopSession,isReady:()=>true};
   const outcome=await handleStopAgent(new Map([["minimax-code",adapter]]) as any,{sessionId:"mvs_native",harness:"minimax-code"},{localHostId:"h"});
   expect(outcome.text).toBe("Stopped agent [minimax-code] mvs_native.");
   expect(outcome.structured.state).toBe("admitted");
   expect(stopSession).toHaveBeenCalledTimes(1);
  }finally{if(old===undefined)delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;else process.env.AGENT_HERDER_HUMAN_STOP_STORE=old;await rm(dir,{recursive:true,force:true});}
 });
});
