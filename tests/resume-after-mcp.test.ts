import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentHerderMcpServer } from "../src/index.js";
import { HumanRequestRegistry } from "../src/human-request/registry.js";
import { createResumeAfterRuntime, parseResumeAfterStartupHold } from "../src/resume-after-runtime.js";
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
  const makeRuntime=(holdExistingWaitingAtStartup=false)=>createResumeAfterRuntime(adapters,{
    isAutomationHeld:async()=>held,sendMessage:async(_h,id,options)=>adapter.sendMessage(id,options),
  },async()=>false,directory,holdExistingWaitingAtStartup);
  const runtime=makeRuntime();
  const request={owner:ref("owner"),dependencies:[ref("a"),ref("b")],message:"join exact native turns",requestId:"turn-join"};
  async function emit(id:string,kind:HarnessEvent["kind"],turnId?:string,at?:string) {
    await runtime.service.observe({...ref(id),kind,at,data:{turnId}});
  }
  async function complete(id:string) {
    const session=sessions.get(id)!;
    const turnId=session.meta!.activeTurnId as string;
    const completedAt=new Date().toISOString();
    session.status="idle";session.meta={nativeLastTurn:{turnId,status:"completed",completedAt}};
    await runtime.service.observe({...ref(id),kind:"turn.completed",at:completedAt,data:{turnId}});
  }
  return {directory,adapters,runtime,makeRuntime,sessions,sent,request,emit,complete,hold:()=>{held=true;},setDelivery:(value:typeof delivery)=>{delivery=value;}};
}

describe("exact native turn registration",()=>{
  it("captures existing waits before startup sweep and still delivers a new wait once",async()=>{
    const f=await nativeFixture();
    const legacy=await f.runtime.service.register(f.request);
    await f.complete("a");
    const bytes=JSON.stringify(await f.runtime.service.get(legacy.id));
    const heldRuntime=f.makeRuntime(true);
    const stop=await heldRuntime.start();cleanup.push(async()=>stop());
    expect(JSON.stringify(await heldRuntime.service.get(legacy.id))).toBe(bytes);
    f.sessions.get("b")!.status="idle";
    f.sessions.get("b")!.meta={nativeLastTurn:{turnId:"b-current",status:"completed",completedAt:new Date().toISOString()}};
    await heldRuntime.service.observe({...ref("b"),kind:"turn.completed",at:new Date().toISOString(),data:{turnId:"b-current"}});
    expect(JSON.stringify(await heldRuntime.service.get(legacy.id))).toBe(bytes);
    expect(f.sent).toHaveLength(0);

    const fresh=await heldRuntime.service.register({...f.request,dependencies:[ref("a")],message:"fresh after startup",requestId:"fresh-after-startup"});
    expect(fresh.state).toBe("resumed");
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({id:"owner",inputId:"resume-after:"+fresh.id});
    expect(JSON.stringify(await heldRuntime.service.get(legacy.id))).toBe(bytes);
  });
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
  it("normalizes a numeric native ZCode completion timestamp",async()=>{
    const f=await nativeFixture();
    const completedAt=Date.parse("2026-10-20T09:59:00.000Z");
    for(const id of ["a","b"])f.sessions.get(id)!.status="idle";
    const codex=f.adapters.get("codex")!;
    const zcode:HarnessAdapter={...codex,type:"zcode",async getSession(id){
      const session=await codex.getSession(id);
      return session?{...session,harness:"zcode",meta:{nativeLastTurn:{turnId:id+"-current",status:"completed",completedAt}}}:null;
    }};
    const adapters=new Map(f.adapters);adapters.set("zcode",zcode);
    let sends=0;
    const runtime=createResumeAfterRuntime(adapters,{
      isAutomationHeld:async()=>false,sendMessage:async()=>{sends++;return {ok:true,admitted:true};},
    },async()=>false,f.directory);
    const wait=await runtime.service.register({owner:ref("owner"),dependencies:[
      {harness:"zcode",sessionId:"a"},{harness:"zcode",sessionId:"b"},
    ],requestId:"zcode-number-completion"});
    expect(wait.state).toBe("resumed");
    expect(Object.values(wait.completed).map(value=>value.at)).toEqual(["2026-10-20T09:59:00.000Z","2026-10-20T09:59:00.000Z"]);
    expect(sends).toBe(1);
  });
  it("does not synthesize a native completion timestamp for a Codex summary",async()=>{
    const f=await nativeFixture();
    for(const id of ["a","b"]){
      f.sessions.get(id)!.status="idle";
      f.sessions.get(id)!.meta={nativeLastTurn:{turnId:id+"-current",status:"completed"}};
    }
    const wait=await f.makeRuntime().service.register(f.request);
    expect(wait.state).toBe("delivery_failed");
    expect(wait.reason).toMatch(/native turn completion is unavailable/i);
    expect(f.sent).toHaveLength(0);
  });
  it("blocks a running dependency when its native turn identity cannot be verified",async()=>{
    const f=await nativeFixture();
    f.sessions.get("a")!.meta={};
    const wait=await f.runtime.service.register(f.request);
    expect(wait.state).toBe("delivery_failed");
    expect(wait.reason).toMatch(/native turn identity is unavailable/i);
    f.sessions.get("a")!.meta={activeTurnId:"a-current"};
    await f.emit("a","turn.started","a-current");
    await f.complete("a");
    expect(f.sent).toHaveLength(0);
    await f.complete("b");
    expect((await f.runtime.service.get(wait.id))?.state).toBe("delivery_failed");
    expect(f.sent).toHaveLength(0);
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

describe("one-shot scheduled resume over the existing MCP service",()=>{
  async function clientFor(f:Awaited<ReturnType<typeof nativeFixture>>){
    const server=createAgentHerderMcpServer(undefined,{resumeAfter:f.runtime.service});
    const client=new Client({name:"scheduled-resume-test",version:"1"},{versionNegotiation:{mode:"auto"}});
    const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);await client.connect(clientTransport);
    cleanup.push(async()=>{await client.close();await server.close();});
    return client;
  }

  it("schedules a relative delay durably, deduplicates it, and delivers exactly once when due",async()=>{
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T09:00:00.000Z"));
    try{
      const f=await nativeFixture(),client=await clientFor(f);
      const tool=(await client.listTools()).tools.find(item=>item.name==="resume_after");
      expect(tool?.inputSchema).toHaveProperty("anyOf");
      const request={owner:ref("owner"),message:"continue once after the delay",requestId:"delay-one",trigger:{kind:"delay",delayMs:3_600_000}};
      const first=await client.callTool({name:"resume_after",arguments:request});
      expect(first.isError).not.toBe(true);
      const wait=(first.structuredContent as any).wait;
      expect((first.structuredContent as any)).toMatchObject({jobId:wait.id,scheduledAt:"2026-10-24T10:00:00.000Z"});
      expect(wait).toMatchObject({state:"waiting",scheduledAt:"2026-10-24T10:00:00.000Z",trigger:request.trigger});
      expect(f.sent).toHaveLength(0);

      const afterRestart=f.makeRuntime();
      expect(await afterRestart.service.get(wait.id)).toMatchObject({state:"waiting",scheduledAt:wait.scheduledAt});
      const retry=await client.callTool({name:"resume_after",arguments:request});
      expect((retry.structuredContent as any).wait).toMatchObject({id:wait.id,scheduledAt:wait.scheduledAt});
      const conflict=await client.callTool({name:"resume_after",arguments:{...request,message:"different message"}});
      expect(conflict.isError).toBe(true);
      expect(f.sent).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(3_600_000);
      await afterRestart.service.sweep();
      expect(f.sent).toEqual([{id:"owner",inputId:"resume-after:"+wait.id}]);
      await f.makeRuntime().service.sweep();
      expect(f.sent).toHaveLength(1);
    }finally{vi.useRealTimers();}
  });

  it("accepts one timezone-qualified absolute instant and rejects a conflicting requestId without replay",async()=>{
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T09:00:00.000Z"));
    try{
      const f=await nativeFixture(),client=await clientFor(f);
      const request={owner:ref("owner"),message:"resume at the chosen instant",requestId:"absolute-one",trigger:{kind:"at",at:"2026-10-24T12:30:00+03:00"}};
      const first=await client.callTool({name:"resume_after",arguments:request});
      expect(first.isError).not.toBe(true);
      const wait=(first.structuredContent as any).wait;
      expect(wait).toMatchObject({state:"waiting",scheduledAt:"2026-10-24T09:30:00.000Z",trigger:request.trigger});
      expect(f.sent).toHaveLength(0);
      const conflict=await client.callTool({name:"resume_after",arguments:{...request,trigger:{kind:"at",at:"2026-10-24T12:31:00+03:00"}}});
      expect(conflict.isError).toBe(true);
      await vi.advanceTimersByTimeAsync(30*60_000);
      await f.makeRuntime().service.sweep();
      expect(f.sent).toEqual([{id:"owner",inputId:"resume-after:"+wait.id}]);
      await f.makeRuntime().service.sweep();
      expect(f.sent).toHaveLength(1);
    }finally{vi.useRealTimers();}
  });

  it("does not admit a scheduled resume for a HumanStop-held exact session",async()=>{
    const f=await nativeFixture();f.hold();const client=await clientFor(f);
    const call=await client.callTool({name:"resume_after",arguments:{owner:ref("owner"),message:"must stay stopped",requestId:"held-schedule",trigger:{kind:"delay",delayMs:60_000}}});
    expect(call.isError).not.toBe(true);
    expect((call.structuredContent as any).wait).toMatchObject({state:"cancelled",reason:"requester was stopped"});
    expect(f.sent).toHaveLength(0);
  });

  it("rejects missing, mixed, or timezone-ambiguous trigger requests before persistence",async()=>{
    const f=await nativeFixture(),client=await clientFor(f);
    const base={owner:ref("owner"),message:"valid scheduled message",requestId:"invalid-trigger"};
    expect((await client.callTool({name:"resume_after",arguments:base})).isError).toBe(true);
    expect((await client.callTool({name:"resume_after",arguments:{...base,dependencies:[ref("a")],trigger:{kind:"delay",delayMs:1000}}})).isError).toBe(true);
    expect((await client.callTool({name:"resume_after",arguments:{...base,trigger:{kind:"at",at:"2026-10-24T12:00:00"}}})).isError).toBe(true);
    expect(await f.runtime.service.list()).toHaveLength(0);
    expect(f.sent).toHaveLength(0);
  });

  it("keeps an uncertain scheduled native admission non-replayable across restart",async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-24T09:00:00.000Z"));
    try{
      const f=await nativeFixture();f.setDelivery({ok:false,admissionUnknown:true,nonRetryable:true,error:"receipt unknown"});
      const request={owner:ref("owner"),message:"one possibly admitted message",requestId:"unknown-scheduled",trigger:{kind:"delay",delayMs:1}};
      const wait=await f.runtime.service.register(request);
      await vi.advanceTimersByTimeAsync(1);
      await f.runtime.service.sweep();
      expect((await f.runtime.service.get(wait.id))?.state).toBe("delivery_unknown");
      expect(f.sent).toHaveLength(1);
      const restored=f.makeRuntime();await restored.service.sweep();await restored.service.sweep();
      expect((await restored.service.register(request)).state).toBe("delivery_unknown");
      expect(f.sent).toHaveLength(1);
    }finally{vi.useRealTimers();}
  });
});

describe("MCP dependency wait through native adapter events",()=>{
  it("parses the explicit startup maintenance mode and fails closed on malformed config",()=>{
    expect(parseResumeAfterStartupHold(undefined)).toBe(false);
    expect(parseResumeAfterStartupHold("enabled")).toBe(true);
    expect(parseResumeAfterStartupHold("disabled")).toBe(false);
    for(const value of ["","true","maybe"])
      expect(()=>parseResumeAfterStartupHold(value)).toThrow(/AGENT_HERDER_RESUME_AFTER_STARTUP_HOLD/);
  });
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
    const stop=await runtime.start();cleanup.push(async()=>stop());
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
  it("refuses an OpenCode dependency without an exact execution identity at registration",async()=>{
    const directory=await mkdtemp(join(process.cwd(),".tmp/resume-after-mcp-"));
    cleanup.push(()=>rm(directory,{recursive:true,force:true}));
    const session=(id:string,status:"idle"|"running"):AgentSession=>({id,harness:"opencode",title:id,cwd:process.cwd(),status,lastActivity:new Date().toISOString(),needsPermission:false});
    const adapter={type:"opencode",name:"OpenCode fixture",async getSession(id:string){return session(id,id==="dependency"?"running":"idle");},
      subscribeEvents(){return()=>{};}} as unknown as HarnessAdapter;
    const runtime=createResumeAfterRuntime(new Map([["opencode",adapter]]),{
      isAutomationHeld:async()=>false,sendMessage:async()=>{throw new Error("must not deliver");},
    },async()=>false,directory);
    await expect(runtime.service.register({owner:{harness:"opencode",sessionId:"owner"},dependencies:[{harness:"opencode",sessionId:"dependency"}],requestId:"unsupported-exact-identity"}))
      .rejects.toThrow(/does not expose an exact native turn identity/i);
  });
  it.each([false,true])("preflights every dependency before persisting a wait, even if an earlier dependency or owner is terminal",async held=>{
    const f=await nativeFixture();
    f.sessions.get("a")!.meta={};
    let heldChecks=0;
    const unsupported:HarnessAdapter={
      ...f.adapters.get("codex")!,type:"opencode",name:"OpenCode fixture",
      async getSession(id){return {id,harness:"opencode",title:id,cwd:process.cwd(),status:"running",lastActivity:new Date().toISOString(),needsPermission:false};},
      subscribeEvents(){return()=>{};},
    };
    const adapters=new Map(f.adapters);adapters.set("opencode",unsupported);
    const runtime=createResumeAfterRuntime(adapters,{
      isAutomationHeld:async()=>false,sendMessage:async()=>{throw new Error("must not deliver");},
    },async()=>{heldChecks++;return held;},f.directory);
    await expect(runtime.service.register({owner:ref("owner"),dependencies:[ref("a"),{harness:"opencode",sessionId:"unsupported"}],requestId:`preflight-${held}`}))
      .rejects.toThrow(/does not expose an exact native turn identity/i);
    expect(heldChecks).toBe(0);
    expect(await runtime.service.list()).toHaveLength(0);
    expect(f.sent).toHaveLength(0);
  });
});

describe("HumanRequest join through the resume_after MCP route",()=>{
  it("binds a pending HumanRequest whose native target matches the owner tuple",async()=>{
    const f=await nativeFixture();
    const registryRoot=await mkdtemp(join(process.cwd(),".tmp/resume-after-mcp-hr-"));
    cleanup.push(()=>rm(registryRoot,{recursive:true,force:true}));
    const humanRequests=new HumanRequestRegistry(join(registryRoot,"human-requests.json"));
    const request=await humanRequests.create({kind:"user",target:{harness:"codex",sessionId:"owner"}});
    const server=createAgentHerderMcpServer(undefined,{resumeAfter:f.runtime.service,humanRequests});
    const client=new Client({name:"hr-join-canary",version:"1"},{versionNegotiation:{mode:"auto"}});
    const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);await client.connect(clientTransport);
    cleanup.push(async()=>{await client.close();await server.close();});
    const call=await client.callTool({name:"resume_after",arguments:{
      owner:ref("owner"),dependencies:[ref("a")],requestId:"hr-join",message:"apply the canonical answer",
      humanRequestId:request.requestId,expiresAt:"2027-01-01T00:00:00Z",
    }});
    expect(call.isError).not.toBe(true);
    const wait=(call.structuredContent as any).wait;
    expect(wait).toMatchObject({humanRequestId:request.requestId,state:"waiting"});
    const durable=await humanRequests.get(request.requestId);
    expect(durable?.resumeWaitId).toBe(wait.id);
  });
  it("rejects a foreign native target and cancels only the wait it created",async()=>{
    const f=await nativeFixture();
    const registryRoot=await mkdtemp(join(process.cwd(),".tmp/resume-after-mcp-hr-"));
    cleanup.push(()=>rm(registryRoot,{recursive:true,force:true}));
    const humanRequests=new HumanRequestRegistry(join(registryRoot,"human-requests.json"));
    const foreign=await humanRequests.create({kind:"user",target:{harness:"codex",sessionId:"stranger-session"}});
    const server=createAgentHerderMcpServer(undefined,{resumeAfter:f.runtime.service,humanRequests});
    const client=new Client({name:"hr-join-foreign",version:"1"},{versionNegotiation:{mode:"auto"}});
    const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);await client.connect(clientTransport);
    cleanup.push(async()=>{await client.close();await server.close();});
    const call=await client.callTool({name:"resume_after",arguments:{
      owner:ref("owner"),dependencies:[ref("a")],requestId:"hr-foreign",message:"must not bind",
      humanRequestId:foreign.requestId,
    }});
    expect(call.isError).toBe(true);
    expect(JSON.stringify(call.content)).toContain("native target does not match");
    const waits=(await f.runtime.service.list()).filter(w=>w.humanRequestId===foreign.requestId);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({state:"cancelled"});
    const durable=await humanRequests.get(foreign.requestId);
    expect(durable?.resumeWaitId).toBeUndefined();
    expect(durable?.status).toBe("pending");
    expect(f.sent).toHaveLength(0);
  });
});
