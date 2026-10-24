import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CadenceScheduler, nextCadenceAt } from "../src/cadence-scheduler.js";
import { createCadenceRuntime } from "../src/cadence-runtime.js";
import type { HarnessAdapter } from "../src/types/index.js";
const minute=60_000;
const initial=Date.parse("2026-10-24T03:07:00Z");
const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),"herder-cadence-"));directories.push(dir);
  let now=initial;
  const inspect=vi.fn(async()=>"idle" as "idle"|"busy"|"held"|"unavailable");
  const deliver=vi.fn(async()=>({status:"accepted" as "accepted"|"rejected"|"unknown",receipt:{sessionId:"exact-thread"}}));
  const options={path:join(dir,"cadence.json"),now:()=>now,inspect,deliver};
  const service=new CadenceScheduler(options);
  return {service,options,inspect,deliver,setNow:(value:number)=>{now=value;}};
}
describe("durable exact-thread cadence",()=>{
  it("uses 15m, 30m, then first :45 anchor and hourly :45",()=>{
    let at=initial;
    const minutes:number[]=[];
    for(let i=0;i<9;i++){at=nextCadenceAt(initial,at);minutes.push((at-initial)/minute);}
    expect(minutes).toEqual([15,30,45,60,90,120,158,218,278]);
    expect(new Date(at).toISOString()).toBe("2026-10-24T07:45:00.000Z");
    expect(nextCadenceAt(initial,initial+158*minute)).toBe(initial+218*minute);
  });
  it("persists activation and exact owner; a retry never restarts cadence",async()=>{
    const f=await fixture();
    const first=await f.service.schedule({sessionId:"exact-thread",requestId:"task"});
    f.setNow(initial+minute);
    const restarted=new CadenceScheduler(f.options);
    expect(await restarted.schedule({sessionId:"exact-thread",requestId:"task"})).toEqual(first);
    expect(await restarted.list()).toEqual([first]);
    await expect(restarted.schedule({sessionId:"exact-thread",requestId:"task",message:"different"})).rejects.toThrow("another continuation");
    await expect(restarted.schedule({sessionId:"exact-thread",requestId:"another"})).rejects.toThrow("already has");
    const before=await readFile(f.options.path,"utf8");await restarted.list();
    expect(await readFile(f.options.path,"utf8")).toBe(before);
  });
  it("multiple service instances claim one due wake once and pass a stable inputId",async()=>{
    const f=await fixture();const row=await f.service.schedule({sessionId:"exact-thread",requestId:"task"});
    f.setNow(initial+15*minute);
    const restarted=new CadenceScheduler(f.options);
    await Promise.all([f.service.sweep(),restarted.sweep(),f.service.sweep()]);
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(f.deliver.mock.calls[0][0]).toMatchObject({id:row.id,sessionId:"exact-thread",sequence:1,inputId:row.id+":1"});
    expect((await restarted.list())[0]).toMatchObject({state:"scheduled",sequence:1,nextAt:new Date(initial+30*minute).toISOString()});
  });
  it("never overlaps busy native turns, skips unavailable state and sends no catch-up burst",async()=>{
    const f=await fixture();await f.service.schedule({sessionId:"exact-thread",requestId:"task"});
    f.setNow(initial+80*minute);f.inspect.mockResolvedValue("busy");await f.service.sweep();
    f.inspect.mockResolvedValue("unavailable");await f.service.sweep();expect(f.deliver).not.toHaveBeenCalled();
    f.inspect.mockResolvedValue("idle");await f.service.sweep();await f.service.sweep();
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect((await f.service.list())[0].nextAt).toBe(new Date(initial+110*minute).toISOString());
  });
  it("skips a busy or expired :45 hourly slot without a delayed backlog",async()=>{
    const f=await fixture();const row=await f.service.schedule({sessionId:"exact-thread",requestId:"task"});
    const hourly=initial+158*minute;
    await writeFile(f.options.path,JSON.stringify([{...row,nextAt:new Date(hourly).toISOString()}]));
    f.setNow(hourly);f.inspect.mockResolvedValue("busy");await f.service.sweep();
    expect((await f.service.list())[0].nextAt).toBe(new Date(hourly+60*minute).toISOString());
    f.setNow(hourly+5*minute);f.inspect.mockResolvedValue("idle");await f.service.sweep();expect(f.deliver).not.toHaveBeenCalled();
    f.setNow(hourly+65*minute);await f.service.sweep();expect(f.deliver).not.toHaveBeenCalled();
    expect((await f.service.list())[0].nextAt).toBe(new Date(hourly+120*minute).toISOString());
    f.setNow(hourly+120*minute);await f.service.sweep();expect(f.deliver).toHaveBeenCalledTimes(1);
  });
  it("platform Stop is terminal even before the next deadline and cannot auto-rearm",async()=>{
    const f=await fixture();const row=await f.service.schedule({sessionId:"exact-thread",requestId:"task"});
    f.inspect.mockResolvedValue("held");await f.service.sweep();
    f.inspect.mockResolvedValue("idle");f.setNow(initial+100*minute);await new CadenceScheduler(f.options).sweep();
    expect(f.deliver).not.toHaveBeenCalled();
    expect(await f.service.schedule({sessionId:"exact-thread",requestId:"task"})).toMatchObject({id:row.id,state:"paused",reason:"HumanStop"});
  });
  it.each(["pause","complete"] as const)("explicit %s survives restart without a wake",async action=>{
    const f=await fixture();const row=await f.service.schedule({sessionId:"exact-thread",requestId:"task"});
    await expect(f.service.control(row.id,"wrong-owner",action)).rejects.toThrow("owner");
    await f.service.control(row.id,"exact-thread",action);f.setNow(initial+200*minute);
    await new CadenceScheduler(f.options).sweep();expect(f.deliver).not.toHaveBeenCalled();
    expect((await f.service.list())[0].state).toBe(action==="pause"?"paused":"complete");
  });
  it("lost native receipt is never replayed on subsequent sweeps or restart",async()=>{
    const f=await fixture();await f.service.schedule({sessionId:"exact-thread",requestId:"task"});
    f.deliver.mockRejectedValue(new Error("connection lost after acceptance"));f.setNow(initial+15*minute);
    await f.service.sweep();f.setNow(initial+300*minute);await new CadenceScheduler(f.options).sweep();
    expect(f.deliver).toHaveBeenCalledTimes(1);expect((await f.service.list())[0].state).toBe("delivery_unknown");
  });
  it("a process crash after claim preserves unresolved dispatch without replay",async()=>{
    const f=await fixture();const row=await f.service.schedule({sessionId:"exact-thread",requestId:"task"});
    await writeFile(f.options.path,JSON.stringify([{...row,state:"dispatching",sequence:1,inputId:row.id+":1"}]));
    f.setNow(initial+300*minute);await new CadenceScheduler(f.options).sweep();
    expect(f.deliver).not.toHaveBeenCalled();expect((await f.service.list())[0].state).toBe("dispatching");
  });
  it("a pause arriving during native submission is not overwritten by its receipt",async()=>{
    const f=await fixture();const row=await f.service.schedule({sessionId:"exact-thread",requestId:"task"});
    f.deliver.mockImplementation(async()=>{await new CadenceScheduler(f.options).control(row.id,"exact-thread","pause");return {status:"accepted"};});
    f.setNow(initial+15*minute);await f.service.sweep();
    expect((await f.service.list())[0]).toMatchObject({state:"paused",result:{status:"accepted"}});
  });
  it("rechecks Stop immediately before native admission",async()=>{
    const f=await fixture();await f.service.schedule({sessionId:"exact-thread",requestId:"task"});
    f.inspect.mockResolvedValueOnce("idle").mockResolvedValueOnce("held");f.setNow(initial+15*minute);await f.service.sweep();
    expect(f.deliver).not.toHaveBeenCalled();expect((await f.service.list())[0].state).toBe("paused");
  });
  it("rejects stopped registration and corrupt persisted state",async()=>{
    const f=await fixture();f.inspect.mockResolvedValue("held");
    await expect(f.service.schedule({sessionId:"exact-thread",requestId:"task"})).rejects.toThrow("stopped");
    await writeFile(f.options.path,"{}");await expect(f.service.list()).rejects.toThrow("Invalid cadence store");
  });
  it("runtime submits automation only to original Codex ID via the supervisor",async()=>{
    const f=await fixture();
    const getSession=vi.fn(async()=>({id:"exact-thread",status:"idle",needsPermission:false,meta:{nativeStateObserved:true}}));
    const adapters=new Map([["codex",{getSession} as unknown as HarnessAdapter]]);
    const supervisor={isAutomationHeld:vi.fn(async()=>false),sendMessage:vi.fn(async()=>({ok:true,admitted:true,sessionId:"exact-thread"}))};
    const runtime=createCadenceRuntime(adapters,supervisor,f.options.path);
    const row=await runtime.schedule({sessionId:"exact-thread",requestId:"task"});
    await writeFile(f.options.path,JSON.stringify([{...row,nextAt:new Date(0).toISOString()}]));
    await runtime.sweep();
    expect(supervisor.sendMessage).toHaveBeenCalledWith("codex","exact-thread",expect.objectContaining({origin:"automation",inputId:row.id+":1",queue:true}));
    expect((await runtime.list())[0].result).toMatchObject({status:"accepted",sessionId:"exact-thread"});
  });
  it("wakes a ChatGPT chat on the same durable schedule",async()=>{
    const f=await fixture();
    const getSession=vi.fn(async()=>({id:"route:abc",status:"idle",needsPermission:false,meta:{}}));
    const adapters=new Map([["chatgpt",{getSession} as unknown as HarnessAdapter]]);
    const supervisor={isAutomationHeld:vi.fn(async()=>false),sendMessage:vi.fn(async()=>({ok:true,admitted:true,sessionId:"route:abc"}))};
    const runtime=createCadenceRuntime(adapters,supervisor,f.options.path);
    const row=await runtime.schedule({sessionId:"route:abc",requestId:"task",harness:"chatgpt"});
    expect(row.harness).toBe("chatgpt");
    await writeFile(f.options.path,JSON.stringify([{...row,nextAt:new Date(0).toISOString()}]));
    await runtime.sweep();
    expect(supervisor.sendMessage).toHaveBeenCalledWith("chatgpt","route:abc",expect.objectContaining({origin:"automation",inputId:row.id+":1",queue:true}));
    expect((await runtime.list())[0].result).toMatchObject({status:"accepted",sessionId:"route:abc"});
  });
});
