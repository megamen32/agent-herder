import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentHerderMcpServer } from "../src/index.js";
import { createResumeAfterRuntime } from "../src/resume-after-runtime.js";
import type { AgentSession, HarnessAdapter, HarnessEvent } from "../src/types/index.js";

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const ref=(sessionId:string)=>({harness:"codex",sessionId});

describe("MCP dependency wait through native adapter events",()=>{
  it("registers over real MCP, joins both workers and uses one native continuation",async()=>{
    const directory=await mkdtemp(join(process.cwd(),".tmp/resume-after-mcp-"));
    cleanup.push(()=>rm(directory,{recursive:true,force:true}));
    const sessions=new Map<string,AgentSession>(["owner","a","b"].map(id=>[id,{id,harness:"codex",title:id,cwd:process.cwd(),status:id==="owner"?"idle":"running",lastActivity:new Date().toISOString(),needsPermission:false}]));
    const listeners=new Set<(event:HarnessEvent)=>void>();
    const sent:Array<{id:string;options:Record<string,unknown>}>=[];
    const adapter:HarnessAdapter={
      type:"codex",name:"controlled native seam",async init(){},
      async listSessions(){return [...sessions.values()];},async getSession(id){return sessions.get(id)??null;},
      subscribeEvents(callback){listeners.add(callback);return()=>{listeners.delete(callback);};},
      async sendMessage(id,options){sent.push({id,options:{...options}});return{ok:true,admitted:true,inputId:options.inputId};},
      async getMessageAdmission(_id,inputId){return{state:sent.some(x=>x.options.inputId===inputId)?"admitted":"not_found"};},
      async stopSession(){return{ok:true};},async respondPermission(){return{ok:true};},async setPermissions(){return{ok:true};},
    };
    const runtime=createResumeAfterRuntime(new Map([["codex",adapter]]),{
      isAutomationHeld:async()=>false,
      sendMessage:async(_h,id,options)=>adapter.sendMessage(id,options),
    },async()=>false,directory);
    const stop=runtime.start();cleanup.push(async()=>stop());
    const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
    const server=createAgentHerderMcpServer(undefined,{resumeAfter:runtime.service});
    const client=new Client({name:"resume-after-canary",version:"1"},{versionNegotiation:{mode:"auto"}});
    await server.connect(serverTransport);await client.connect(clientTransport);
    cleanup.push(async()=>{await client.close();await server.close();});
    const tools=(await client.listTools()).tools.map(t=>t.name);
    expect(tools).toEqual(expect.arrayContaining(["resume_after","resume_after_status","resume_after_cancel"]));
    const registration=await client.callTool({name:"resume_after",arguments:{owner:ref("owner"),dependencies:[ref("a"),ref("b")],message:"merge the actual work",requestId:"native-join"}});
    expect(registration.isError).not.toBe(true);
    const wait=(registration.structuredContent as any).wait;
    const emit=async(id:string)=>{
      sessions.get(id)!.status="idle";
      for(const listener of listeners)listener({kind:"turn.completed",harness:"codex",sessionId:id,at:new Date().toISOString()});
      await runtime.service.sweep();
    };
    await emit("a");expect(sent).toHaveLength(0);
    await emit("b");await emit("b");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({id:"owner",options:{message:"merge the actual work",origin:"automation",inputId:"resume-after:"+wait.id}});
    const status=await client.callTool({name:"resume_after_status",arguments:{waitId:wait.id}});
    expect((status.structuredContent as any).wait.state).toBe("resumed");
    const retry=await client.callTool({name:"resume_after",arguments:{owner:ref("owner"),dependencies:[ref("a"),ref("b")],message:"merge the actual work",requestId:"native-join"}});
    expect((retry.structuredContent as any).wait.id).toBe(wait.id);expect(sent).toHaveLength(1);
  });
});
