import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAgentHerderMcpServer } from "../src/index.js";
import { createResumeAfterRuntime } from "../src/resume-after-runtime.js";
import { SessionSupervisor } from "../src/session-supervisor.js";
import { createFleetRecoveryAdmissionGate } from "../src/autopilot/recovery-admission.js";
import type { AgentSession, HarnessAdapter, HarnessEvent } from "../src/types/index.js";

const cleanup:Array<()=>Promise<void>>=[];
beforeAll(()=>mkdir(join(process.cwd(),".tmp"),{recursive:true}));
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const ref=(sessionId:string)=>({harness:"codex",sessionId});

async function nativeFixture() {
  const directory=await mkdtemp(join(process.cwd(),".tmp/resume-after-turns-"));
  cleanup.push(()=>rm(directory,{recursive:true,force:true}));
  const sessions=new Map<string,AgentSession>(["owner","a","b"].map(id=>[id,{
    id,harness:"codex",title:id,cwd:process.cwd(),status:id==="owner"?"idle":"running",
    lastActivity:new Date().toISOString(),needsPermission:false,
    meta:id==="owner"?{}:{activeTurnId:id+"-current"},
  }]));
  const sent:Array<{id:string;inputId?:string}>=[];
  const listeners=new Set<(event:HarnessEvent)=>void>();
  let held=false;
  let delivery={ok:true,admitted:true} as Awaited<ReturnType<HarnessAdapter["sendMessage"]>>;
  const adapter:HarnessAdapter={
    type:"codex",name:"isolated native turn fixture",async init(){},
    async listSessions(){return [...sessions.values()];},async getSession(id){return sessions.get(id)??null;},
    subscribeEvents(callback){listeners.add(callback);return()=>{listeners.delete(callback);};},
    async sendMessage(id,options){sent.push({id,inputId:options.inputId});return delivery;},
    async getMessageAdmission(){return {state:delivery.admitted?"admitted":"unknown"};},
    async stopSession(){return {ok:true};},async respondPermission(){return {ok:true};},async setPermissions(){return {ok:true};},
  };
  const adapters=new Map([["codex",adapter]]);
  const makeRuntime=()=>createResumeAfterRuntime(adapters,{
    isAutomationHeld:async()=>held,sendMessage:async(_h,id,options)=>adapter.sendMessage(id,options),
  },async()=>false,directory);
  const runtime=makeRuntime();
  const request={owner:ref("owner"),dependencies:[ref("a"),ref("b")],message:"join exact native turns",requestId:"turn-join"};
  async function emit(id:string,kind:HarnessEvent["kind"],turnId?:string,at?:string) {
    await runtime.service.observe({...ref(id),kind,at,data:{turnId}});
  }
  async function complete(id:string) {
    const session=sessions.get(id)!;
    const turnId=session.meta!.activeTurnId as string;
    session.status="idle";session.meta={nativeLastTurn:{turnId,status:"completed"}};
    await emit(id,"turn.completed",turnId);
  }
  return {directory,adapters,runtime,makeRuntime,sessions,sent,request,emit,complete,hold:()=>{held=true;},setDelivery:(value:typeof delivery)=>{delivery=value;}};
}

describe("exact native turn registration",()=>{
  it.each(["dispatching","delivery_unknown"] as const)("recovers a persisted definitive pre-send refusal from %s without an adapter send",async state=>{
    const f=await nativeFixture();
    const wait=await f.runtime.service.register(f.request);
    // Simulate the crash gap: native refusal is durable, but the wait's final
    // delivery state was not saved. No native send is made by this fixture.
    await writeFile(join(f.directory,wait.id+".json"),JSON.stringify({...wait,state}));
    const receipt={ok:false,notSubmitted:true,nonRetryable:true,error:"Exact native pre-send refusal",inputId:"resume-after:"+wait.id};
    const receiptPath=join(f.directory,"native-refusal.json");
    await writeFile(receiptPath,JSON.stringify(receipt));
    const reads:Array<{id:string;inputId:string}>=[];
    f.adapters.get("codex")!.getMessageAdmission=async(id,inputId)=>{
      reads.push({id,inputId});
      const stored=JSON.parse(await readFile(receiptPath,"utf8"));
      return {state:"failed",error:stored.error,receipt:stored};
    };
    const restored=f.makeRuntime();await restored.service.sweep();
    expect(await restored.service.get(wait.id)).toMatchObject({state:"delivery_blocked",reason:receipt.error,delivery:{status:"rejected",reason:receipt.error,receipt}});
    expect(f.sent).toHaveLength(0);
    await restored.service.sweep();
    expect((await f.makeRuntime().service.register(f.request)).state).toBe("delivery_blocked");
    await f.makeRuntime().service.sweep();
    expect(reads).toEqual([{id:"owner",inputId:receipt.inputId}]);
    expect(f.sent).toHaveLength(0);
  });
  it.each(["admitted","unknown","failed"] as const)("does not replay a recovered %s receipt without definitive refusal proof",async state=>{
    const f=await nativeFixture();
    const wait=await f.runtime.service.register(f.request);
    await writeFile(join(f.directory,wait.id+".json"),JSON.stringify({...wait,state:"dispatching"}));
    f.adapters.get("codex")!.getMessageAdmission=async()=>({state,error:"Persisted native outcome"});
    const restored=f.makeRuntime();await restored.service.sweep();await restored.service.sweep();
    expect((await restored.service.register(f.request)).state).toBe(state==="admitted"?"resumed":"delivery_unknown");
    expect(f.sent).toHaveLength(0);
  });
  it.each(["admitted","admissionUnknown"] as const)("preserves recovered %s evidence over conflicting rejection flags",async flag=>{
    const f=await nativeFixture();
    const wait=await f.runtime.service.register(f.request);
    await writeFile(join(f.directory,wait.id+".json"),JSON.stringify({...wait,state:"dispatching"}));
    f.adapters.get("codex")!.getMessageAdmission=async()=>({state:"failed",receipt:{ok:false,notSubmitted:true,nonRetryable:true,[flag]:true,error:"Conflicting native receipt"}});
    const restored=f.makeRuntime();await restored.service.sweep();await restored.service.sweep();
    expect((await restored.service.register(f.request)).state).toBe(flag==="admitted"?"resumed":"delivery_unknown");
    expect(f.sent).toHaveLength(0);
  });
  it("joins a completion observed before registration, persists its turn and retries without a second continuation",async()=>{
    const f=await nativeFixture();
    // Event-only proof: idle alone is not the completion receipt.
    f.sessions.get("a")!.status="idle";f.sessions.get("a")!.meta={};
    await f.emit("a","turn.completed","a-current");
    const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
    const server=createAgentHerderMcpServer(undefined,{resumeAfter:f.runtime.service});
    const client=new Client({name:"late-registration-canary",version:"1"},{versionNegotiation:{mode:"auto"}});
    await server.connect(serverTransport);await client.connect(clientTransport);
    cleanup.push(async()=>{await client.close();await server.close();});
    const registration=await client.callTool({name:"resume_after",arguments:f.request});
    expect(registration.isError).not.toBe(true);
    const wait=(registration.structuredContent as any).wait;
    expect(wait.completed[JSON.stringify(["codex","a"])]).toMatchObject({turnId:"a-current",outcome:"turn.completed"});
    await f.complete("b");await f.runtime.service.sweep();
    expect(f.sent).toHaveLength(1);
    expect((await f.makeRuntime().service.register(f.request)).state).toBe("resumed");
    await f.makeRuntime().service.sweep();expect(f.sent).toHaveLength(1);
    const retry=await client.callTool({name:"resume_after",arguments:f.request});
    expect((retry.structuredContent as any).wait.state).toBe("resumed");expect(f.sent).toHaveLength(1);
  });
  it("rejects a later-arriving completion for a different native turn",async()=>{
    const f=await nativeFixture();
    const wait=await f.runtime.service.register(f.request);
    await f.emit("a","turn.started","a-current");
    await f.emit("a","turn.completed","a-prior",new Date(Date.now()+1).toISOString());
    const state=await f.runtime.service.get(wait.id);
    expect(state!.completed[JSON.stringify(["codex","a"])]).toBeUndefined();
    expect(state!.observed?.[JSON.stringify(["codex","a"])]).toMatchObject({turnId:"a-current",kind:"turn.started"});
    await f.complete("b");expect(f.sent).toHaveLength(0);
    await f.complete("a");expect(f.sent).toHaveLength(1);
  });
  it("persists an explicit terminal blocker when an already-idle task has no native turn proof",async()=>{
    const f=await nativeFixture();
    f.sessions.get("a")!.status="idle";f.sessions.get("a")!.meta={};
    const wait=await f.runtime.service.register(f.request);
    expect(wait.state).toBe("delivery_failed");
    expect(wait.reason).toMatch(/codex:a.*native.*turn.*completion/i);
    await f.complete("b");await f.makeRuntime().service.sweep();
    expect((await f.makeRuntime().service.register(f.request)).state).toBe("delivery_failed");
    expect(f.sent).toHaveLength(0);
  });
  it("uses adapter-native completed-turn metadata after a cold start without relying on idle",async()=>{
    const f=await nativeFixture();
    for(const id of ["a","b"]){
      f.sessions.get(id)!.status="idle";
      f.sessions.get(id)!.meta={nativeLastTurn:{turnId:id+"-current",status:"completed",completedAt:"2026-10-20T09:59:00.000Z"}};
    }
    const wait=await f.makeRuntime().service.register(f.request);
    expect(wait.state).toBe("resumed");expect(f.sent).toHaveLength(1);
    expect(Object.values(wait.completed).map(value=>value.turnId).sort()).toEqual(["a-current","b-current"]);
    expect(Object.values(wait.completed).every(value=>value.at==="2026-10-20T09:59:00.000Z")).toBe(true);
  });
  it("blocks when a previously observed Codex turn becomes unreadable",async()=>{
    const f=await nativeFixture();
    const wait=await f.runtime.service.register(f.request);
    await f.emit("a","turn.started","a-current");
    f.sessions.get("a")!.status="idle";
    f.sessions.get("a")!.meta={nativeTurnStateUnavailable:true};
    await f.runtime.service.sweep();
    expect((await f.runtime.service.get(wait.id))?.state).toBe("delivery_failed");
    expect(f.sent).toHaveLength(0);
  });
  it("persists an unavailable exact dependency as a terminal blocker",async()=>{
    const f=await nativeFixture();f.sessions.delete("a");
    const wait=await f.runtime.service.register(f.request);
    expect(wait).toMatchObject({state:"delivery_failed",reason:expect.stringContaining("codex:a: native turn completion is unavailable")});
    expect((await f.makeRuntime().service.register(f.request)).state).toBe("delivery_failed");
    expect(f.sent).toHaveLength(0);
  });
  it("never treats a turnless terminal event plus idle as exact native completion",async()=>{
    const f=await nativeFixture();
    f.sessions.get("a")!.status="idle";f.sessions.get("a")!.meta={};
    await f.emit("a","turn.completed");
    const wait=await f.runtime.service.register(f.request);
    expect(wait.state).toBe("delivery_failed");expect(f.sent).toHaveLength(0);
  });
  it("invalidates completion if the dependency starts a newer native turn before the join",async()=>{
    const f=await nativeFixture();
    await f.runtime.service.register(f.request);
    await f.complete("a");
    f.sessions.get("a")!.status="running";f.sessions.get("a")!.meta={activeTurnId:"a-next"};
    await f.emit("a","turn.started","a-next");
    await f.complete("b");expect(f.sent).toHaveLength(0);
    await f.emit("a","turn.completed","a-current");expect(f.sent).toHaveLength(0);
    await f.complete("a");expect(f.sent).toHaveLength(1);
  });
  it("does not mistake an old cached completion for a newly running task",async()=>{
    const f=await nativeFixture();
    await f.complete("a");
    f.sessions.get("a")!.status="running";f.sessions.get("a")!.meta={activeTurnId:"a-next"};
    const wait=await f.runtime.service.register(f.request);
    expect(wait.completed[JSON.stringify(["codex","a"])]).toBeUndefined();
    await f.complete("b");expect(f.sent).toHaveLength(0);
    await f.complete("a");expect(f.sent).toHaveLength(1);
  });
  it.each(["held","stop-event","cancel"])("never sends to a %s owner, including retry and restart",async mode=>{
    const f=await nativeFixture();
    const wait=await f.runtime.service.register(f.request);
    if(mode==="held")f.hold();
    else if(mode==="stop-event")await f.runtime.service.observe({...ref("owner"),kind:"turn.completed",data:{automationStop:true}});
    else await f.runtime.service.cancel(wait.id,ref("owner"));
    await f.complete("a");await f.complete("b");
    const restored=f.makeRuntime();await restored.service.sweep();
    expect((await restored.service.register(f.request)).state).toBe("cancelled");
    expect(f.sent).toHaveLength(0);
  });
  it.each(["accepted","unknown"])("never replays %s delivery through registration retry or restart",async mode=>{
    const f=await nativeFixture();
    if(mode==="unknown")f.setDelivery({ok:false,admissionUnknown:true,error:"isolated lost native receipt"});
    const wait=await f.runtime.service.register(f.request);
    await f.complete("a");await f.complete("b");
    const restored=f.makeRuntime();await restored.service.sweep();
    expect((await restored.service.register(f.request)).state).toBe(mode==="accepted"?"resumed":"delivery_unknown");
    await restored.service.sweep();expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toEqual({id:"owner",inputId:"resume-after:"+wait.id});
  });
  it.each(["accepted","unknown"])("does not classify %s admission as retryable even with conflicting rejection flags",async mode=>{
    const f=await nativeFixture();
    f.setDelivery({ok:false,...(mode==="accepted"?{admitted:true}:{admissionUnknown:true}),notSubmitted:true,nonRetryable:true,error:"Fleet admission holds automatic delivery"});
    const wait=await f.runtime.service.register(f.request);
    await f.complete("a");await f.complete("b");
    const restored=f.makeRuntime();await restored.service.sweep();await restored.service.register(f.request);
    expect((await restored.service.get(wait.id))?.state).toBe(mode==="accepted"?"resumed":"delivery_unknown");
    expect(f.sent).toHaveLength(1);
  });
  it("cancels a held owner at registration even when dependency completion cannot be proven",async()=>{
    const f=await nativeFixture();f.hold();
    f.sessions.get("a")!.status="idle";f.sessions.get("a")!.meta={};
    expect((await f.runtime.service.register(f.request)).state).toBe("cancelled");
    expect(f.sent).toHaveLength(0);
  });
  it("preserves a fresh intentional denial with the exact supervisor refusal payload and no replay",async()=>{
    const f=await nativeFixture();
    const path=join(f.directory,"isolated-campaign.json");
    await writeFile(path,JSON.stringify({utc:"2026-10-20T09:55:00Z",heavy:{admission:"DENIED"},registry:{}}));
    const gate=createFleetRecoveryAdmissionGate(path,()=>Date.parse("2026-10-20T10:00:00Z"),{});
    const owner=f.sessions.get("owner")!;
    expect(await gate(owner,"send")).toEqual({allowed:false,reason:"Existing fleet resource admission is denied"});
    expect(await gate(owner,"autopilot-send")).toEqual({allowed:false,reason:"Existing fleet resource admission is denied"});
    const supervisor=new SessionSupervisor(f.adapters,{convert:async()=>{throw new Error("not used");}},undefined,{autoResumeFailedSessions:false,admissionGate:gate});
    const runtime=createResumeAfterRuntime(f.adapters,supervisor,async()=>false,f.directory);
    const wait=await runtime.service.register(f.request);
    for(const id of ["a","b"]){
      f.sessions.get(id)!.status="idle";
      f.sessions.get(id)!.meta={nativeLastTurn:{turnId:id+"-current",status:"completed"}};
      await runtime.service.observe({...ref(id),kind:"turn.completed",data:{turnId:id+"-current"}});
    }
    await runtime.service.sweep();
    expect(await runtime.service.get(wait.id)).toMatchObject({state:"delivery_blocked",reason:"Existing fleet resource admission is denied",delivery:{status:"rejected",receipt:{ok:false,nonRetryable:true,error:"Existing fleet resource admission is denied"}}});
    // Even a later service instance with an open gate cannot replay this wait.
    const restored=f.makeRuntime();await restored.service.sweep();
    expect((await restored.service.register(f.request)).state).toBe("delivery_blocked");
    expect(f.sent).toHaveLength(0);
  });
});

describe("MCP dependency wait through native adapter events",()=>{
  it("registers over real MCP, joins both workers and uses one native continuation",async()=>{
    const directory=await mkdtemp(join(process.cwd(),".tmp/resume-after-mcp-"));
    cleanup.push(()=>rm(directory,{recursive:true,force:true}));
    const sessions=new Map<string,AgentSession>(["owner","a","b"].map(id=>[id,{id,harness:"codex",title:id,cwd:process.cwd(),status:id==="owner"?"idle":"running",lastActivity:new Date().toISOString(),needsPermission:false,meta:id==="owner"?{}:{activeTurnId:id+"-turn"}}]));
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
      sessions.get(id)!.meta={nativeLastTurn:{turnId:id+"-turn",status:"completed"}};
      for(const listener of listeners)listener({kind:"turn.completed",harness:"codex",sessionId:id,at:new Date().toISOString(),data:{turnId:id+"-turn"}});
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
  it("refuses a dependency on a harness that publishes no native turn events",async()=>{
    const directory=await mkdtemp(join(process.cwd(),".tmp/resume-after-mcp-"));
    cleanup.push(()=>rm(directory,{recursive:true,force:true}));
    const adapter:HarnessAdapter={
      type:"codex",name:"controlled native seam",async init(){},
      async listSessions(){return [];},async getSession(id){return {id,harness:"codex",title:id,cwd:process.cwd(),status:"idle",lastActivity:new Date().toISOString(),needsPermission:false};},
      async sendMessage(){return {ok:true,admitted:true};},async stopSession(){return{ok:true};},
      async respondPermission(){return{ok:true};},async setPermissions(){return{ok:true};},
    };
    const result_adapter:HarnessAdapter={...adapter,type:"claude",name:"file-only adapter without native events"};
    const runtime=createResumeAfterRuntime(new Map([["codex",adapter],["claude",result_adapter]]),{
      isAutomationHeld:async()=>false,sendMessage:async()=>({ok:true,admitted:true}),
    },async()=>false,directory);
    const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
    const server=createAgentHerderMcpServer(undefined,{resumeAfter:runtime.service});
    const client=new Client({name:"resume-after-capability",version:"1"},{versionNegotiation:{mode:"auto"}});
    await server.connect(serverTransport);await client.connect(clientTransport);
    cleanup.push(async()=>{await client.close();await server.close();});
    const call=await client.callTool({name:"resume_after",arguments:{owner:ref("owner"),dependencies:[{harness:"claude",sessionId:"c"}]}});
    expect(call.isError).toBe(true);
    expect(JSON.stringify(call.content)).toContain("does not publish native turn events");
  });
});
