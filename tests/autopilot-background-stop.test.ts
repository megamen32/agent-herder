import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundAutopilotStop } from "../src/autopilot/background-stop.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { HerderEventBus } from "../src/herder-events.js";
import { createWebServer } from "../src/web/server.js";
const resources: Array<()=>Promise<void>>=[];
afterEach(async()=>{ for(const clean of resources.splice(0).reverse()) await clean(); });
const event={command:"stop" as const,harness:"codex" as const,sessionId:"same-native-sid",cwd:"/test",turnId:"native-turn-1",lastAssistantMessage:"Осталась проверка"};
async function fixture() {
 const root=await mkdtemp(join(tmpdir(),"background-stop-")); resources.push(()=>rm(root,{recursive:true,force:true}));
 const jobs=new HerderJobRegistry(new HerderEventBus(),{persistencePath:join(root,"jobs.json")});
 let finish!:(r:any)=>void; const pending=new Promise<any>(r=>{finish=r});
 let held=false,allowed=true; let messages=[{id:"u1",role:"user",text:"Почини и проверь",parts:[]},{id:"a1",role:"assistant",text:event.lastAssistantMessage,parts:[]}];
 const adapter={type:"codex",listSessions:vi.fn(async()=>{throw Error("Full inventory must never run for an exact Stop target")}),getSession:vi.fn(async(id:string)=>id===event.sessionId?{id:event.sessionId,harness:"codex",cwd:"/test",status:"idle",lastActivity:new Date().toISOString()}:null),getSessionMessages:async()=>messages};
 const evaluate=vi.fn(async()=>pending),deliver=vi.fn(async()=>({status:"accepted"}));
 const consumer=new BackgroundAutopilotStop({jobs,adapters:new Map([["codex",adapter as any]]),evaluate,deliver,held:async()=>held,allowed:async()=>allowed});
 return {root,jobs,consumer,adapter,evaluate,deliver,finish,setHeld:(v:boolean)=>{held=v},setAllowed:(v:boolean)=>{allowed=v},newMessage:()=>{messages=[...messages,{id:"u2",role:"user",text:"Стоп, другое поручение",parts:[]}]}};
}
async function waitUntil(fn:()=>boolean) { const end=Date.now()+3000; while(!fn()){if(Date.now()>end)throw Error("unfinished job");await new Promise(r=>setTimeout(r,5));} }
describe("background Stop delivery",()=>{
 it("HTTP returns202 before the judge finishes, then continues the same SID once",async()=>{
  const f=await fixture();const server=createWebServer({adapters:new Map(),converter:{} as any,jobs:f.jobs,backgroundAutopilotStop:f.consumer});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));resources.push(()=>new Promise<void>((r,j)=>server.close(e=>e?j(e):r())));
  const port=(server.address() as any).port;const url=`http://127.0.0.1:${port}/api/autopilot/stop`;
  const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(event)});
  expect(response.status).toBe(202);const body=await response.json() as any;
  expect(f.jobs.get(body.jobId)?.state).not.toBe("completed");expect(f.deliver).not.toHaveBeenCalled();
  const duplicate=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(event)});
  expect((await duplicate.json() as any).jobId).toBe(body.jobId);
  await waitUntil(()=>f.evaluate.mock.calls.length===1);expect(f.consumer.isPending("codex",event.sessionId)).toBe(true);
  f.finish({decision:"continue",next_goal:"Проверь"});await waitUntil(()=>f.jobs.get(body.jobId)?.state==="completed");
  expect(f.adapter.listSessions).not.toHaveBeenCalled();expect(f.adapter.getSession).toHaveBeenCalledWith(event.sessionId);
  expect(f.deliver).toHaveBeenCalledTimes(1);expect(f.deliver.mock.calls[0][0]).toMatchObject({sessionId:event.sessionId,cwd:event.cwd,turnId:event.turnId});
  expect(f.consumer.isPending("codex",event.sessionId)).toBe(false);
  expect(f.consumer.submit(event).id).toBe(body.jobId);
 });
 it("binds a cold ZCode workspace before checking the exact native target",async()=>{
  const f=await fixture();const scoped=vi.fn(async()=>[{id:event.sessionId,harness:"zcode",cwd:event.cwd,status:"idle",lastActivity:new Date().toISOString()}]);
  const adapter={...f.adapter,type:"zcode",listSessions:scoped,getSession:vi.fn(async()=>null)};
  const consumer=new BackgroundAutopilotStop({jobs:f.jobs,adapters:new Map([["zcode",adapter as any]]),evaluate:f.evaluate,deliver:f.deliver,held:async()=>false,allowed:async()=>true});
  const job=consumer.submit({...event,harness:"zcode"});await waitUntil(()=>f.evaluate.mock.calls.length===1);
  f.finish({decision:"continue",next_goal:"Проверить"});await waitUntil(()=>f.jobs.get(job.id)?.state==="completed");
  expect(scoped).toHaveBeenCalledWith({cwd:event.cwd});expect(adapter.getSession).not.toHaveBeenCalled();expect(f.deliver).toHaveBeenCalledTimes(1);
 });
 it.each(["stop","new-message","opt-out","cancel"])("suppresses late continuation after %s",async reason=>{
  const f=await fixture();const job=f.consumer.submit(event);await waitUntil(()=>f.evaluate.mock.calls.length===1);
  if(reason==="stop")f.setHeld(true);if(reason==="new-message")f.newMessage();if(reason==="opt-out")f.setAllowed(false);if(reason==="cancel")f.jobs.cancel(job.id);
  f.finish({decision:"continue",next_goal:"Нельзя отправить"});await waitUntil(()=>["completed","cancelled"].includes(f.jobs.get(job.id)?.state||""));
  expect(f.deliver).not.toHaveBeenCalled();
 });
 it("keeps accepted/interrupted history after restart and never replays that event",async()=>{
  const f=await fixture();const job=f.consumer.submit(event);await waitUntil(()=>f.evaluate.mock.calls.length===1);
  const restored=new HerderJobRegistry(new HerderEventBus(),{persistencePath:join(f.root,"jobs.json")});
  const c=new BackgroundAutopilotStop({jobs:restored,adapters:new Map(),evaluate:vi.fn(),held:async()=>false,allowed:async()=>true,deliver:vi.fn()});
  expect(c.submit(event).state).toBe("interrupted");
  f.finish({decision:"done"});await waitUntil(()=>f.jobs.get(job.id)?.state==="completed");
 });
});
