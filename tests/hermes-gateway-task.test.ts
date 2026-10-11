/** Focused HTTP integration; expected 2s/max 10s. No live Hermes/Telegram writes. */
import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { HermesAdapter } from "../src/adapters/hermes/adapter.js";
import { newOrResumeNamedSession } from "../src/named-session.js";

const key = "agent:main:telegram:group:-1004360838692:9", nativeId = "20260909_220106_70ff6a6b";
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(closes.splice(0).map(fn => fn())); });
async function fixture(effectiveModel: string | null = "glm-5.3-flash") {
  let session: any, generation=0; const inputs = new Map<string, any>(); const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    expect(req.url).toBe("/v1/agent-resume/task"); expect(req.headers.authorization).toBe("Bearer existing-protected-token");
    let text=""; for await (const part of req) text += part;
    const b=JSON.parse(text); bodies.push(b); let result:any={ok:true};
    if(b.op==="bind") session={id:key,harness:"hermes",title:b.name,cwd:b.cwd,model:effectiveModel,status:"idle",lastActivity:"",needsPermission:false,meta:{selectedModel:"glm-5.3-flash",transport:"hermes-gateway-task",nativeSessionId:nativeId,taskBinding:{name:b.name,cwd:b.cwd,generation:String(++generation)},origin:{platform:"telegram",chat_id:"-1004360838692",thread_id:"9"}}};
    if(["bind","find","session","home"].includes(b.op)) result={ok:true,session:session||null};
    if(b.op==="send") {
      if(inputs.has(b.input_id))result=inputs.get(b.input_id);
      else if(JSON.stringify(b.expected_binding)!==JSON.stringify(session.meta.taskBinding))result={ok:false,notSubmitted:true,error:"Named task binding changed"};
      else {inputs.set(b.input_id,{ok:true,admitted:true,pending:true,completed:false,inputId:b.input_id,turnId:"actual-turn",model:"glm-5.3-flash",nativeSessionId:nativeId,sessionKey:key,state:"admitted"});result=inputs.get(b.input_id);}
    }
    if(b.op==="receipt")result=inputs.get(b.input_id)||{ok:true,state:"not_found"};
    res.setHeader("Content-Type","application/json");res.end(JSON.stringify(result));
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  closes.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const endpoint=`http://127.0.0.1:${(server.address() as any).port}`;
  const spawnJob=vi.fn(()=>{throw new Error("no CLI writer")});
  const options={gatewayEndpoint:endpoint,env:{AGENT_RESUME_HERMES_TOKEN:"existing-protected-token"},spawnJob};
  return {adapter:new HermesAdapter(options),options,bodies,inputs,spawnJob};
}
it("binds the real topic key and preserves native identity/model across adapter restart",async()=>{
  const f=await fixture();const session=await f.adapter.createSession({name:"repair",cwd:"/tmp"});
  expect(session.id).toBe(key);expect(session.meta?.nativeSessionId).toBe(nativeId);expect(session.model).toBe("glm-5.3-flash");
  const ack=await f.adapter.sendMessage(key,{message:"Ремонт",inputId:"one",queue:true});
  expect(ack).toMatchObject({ok:true,admitted:true,completed:false,turnId:"actual-turn",inputId:"one"});
  const restarted=new HermesAdapter(f.options);
  expect(await restarted.findNamedSessions("repair","/tmp")).toEqual([session]);
  expect(await restarted.getSession(key)).toEqual(session);
  expect(await restarted.getSession(nativeId)).toEqual(session);
  expect(await restarted.getMessageAdmission(key,"one")).toEqual({state:"admitted"});
  expect(await restarted.getMessageAdmission(nativeId,"one")).toEqual({state:"admitted"});
  expect(await restarted.sendMessage(nativeId,{message:"Ремонт",inputId:"one",queue:true})).toEqual(ack);
  expect(f.inputs.size).toBe(1);expect(f.spawnJob).not.toHaveBeenCalled();
});
it("refuses silent model switching and active-turn steering",async()=>{
  const f=await fixture();const s=await f.adapter.createSession({name:"repair",cwd:"/tmp"});
  expect(await f.adapter.changeModel(s.id,"MiniMax-M3")).toMatchObject({ok:false});
  expect(await f.adapter.changeModel(s.id,"glm-5.3-flash")).toEqual({ok:true});
  const before=f.bodies.length;
  expect(await f.adapter.sendMessage(s.id,{message:"work",steer:true})).toMatchObject({ok:false,notSubmitted:true});
  expect(f.bodies).toHaveLength(before);expect(f.inputs.size).toBe(0);
});
it("keeps missing native ACK non-retryable and query-only",async()=>{
  const f=await fixture();await f.adapter.createSession({name:"repair",cwd:"/tmp"});
  f.inputs.set("unknown",{ok:false,admitted:false,admissionUnknown:true,nonRetryable:true,pending:true,state:"scheduled",completed:false});
  expect(await f.adapter.sendMessage(key,{message:"work",inputId:"unknown",queue:true})).toMatchObject({ok:false,admissionUnknown:true,nonRetryable:true,pending:true});
  expect(await f.adapter.getMessageAdmission(key,"unknown")).toEqual({state:"unknown"});
});
it("fails before task binding without the protected credential",async()=>{
  const old=process.env.AGENT_RESUME_HERMES_TOKEN;delete process.env.AGENT_RESUME_HERMES_TOKEN;
  try {await expect(new HermesAdapter().createSession({name:"repair",cwd:"/tmp"})).rejects.toThrow("protected");}
  finally {if(old!==undefined)process.env.AGENT_RESUME_HERMES_TOKEN=old;}
});
it("production named runner treats a native ACK as admission while the LLM is still running",async()=>{
 const f=await fixture();
 const request={harness:"hermes",name:"native-topic-admission",cwd:"/tmp",message:"Исправление",inputId:"runner-one",mode:"sync" as const,model:"glm-5.3-flash"};
 const result=await newOrResumeNamedSession(new Map([["hermes",f.adapter]]),request);
 expect(result).toMatchObject({ok:true,sessionId:key,admitted:true,pending:true,delivery:"accepted_unconfirmed"});
 expect(await newOrResumeNamedSession(new Map([["hermes",new HermesAdapter(f.options)]]),request)).toEqual(result);
 expect(f.inputs.size).toBe(1);expect(f.spawnJob).not.toHaveBeenCalled();
 expect(f.adapter.controlCapabilities).toMatchObject({cancelTurn:false,terminate:false,modelSwitch:false});
});

it("fences cached A and resolve-A→bind-B races while fresh home follow-ups use B explicitly",async()=>{
 const f=await fixture();
 const a={harness:"hermes",name:"cwd-race-A",cwd:"/tmp",message:"A",inputId:"race-A-1",mode:"queue" as const};
 expect((await newOrResumeNamedSession(new Map([["hermes",f.adapter]]),a)).admitted).toBe(true);
 const resolvedA=await f.adapter.getSession(key);
 const b=await f.adapter.createSession({name:"cwd-race-B",cwd:"/home/roomhacker"});
 expect((await f.adapter.sendMessage(key,{message:"B",inputId:"race-B-1",expectedTaskBinding:b.meta!.taskBinding as any})).admitted).toBe(true);
 const cachedA=await newOrResumeNamedSession(new Map([["hermes",f.adapter]]),{...a,inputId:"race-A-2",message:"Distinct A"});
 expect(cachedA).toMatchObject({ok:false,delivery:"failed"});
 expect(await f.adapter.sendMessage(key,{message:"Resolved A",inputId:"race-A-3",expectedTaskBinding:resolvedA!.meta!.taskBinding as any})).toMatchObject({ok:false,notSubmitted:true});
 expect(f.inputs.size).toBe(2);
 expect(await f.adapter.sendMessage(key,{message:"Current home follow-up",inputId:"current-home"})).toMatchObject({admitted:true});
 expect(f.bodies.filter(v=>v.op==="send").at(-1).expected_binding).toEqual(b.meta!.taskBinding);
 expect(f.inputs.size).toBe(3);
});

it("production named runner honors selected intent while displaying actual fallback independently",async()=>{
 const f=await fixture("MiniMax-M3");
 const request={harness:"hermes",name:"selected-effective",cwd:"/tmp",message:"Read only",inputId:"model-distinct",mode:"queue" as const,model:"glm-5.3-flash"};
 const result=await newOrResumeNamedSession(new Map([["hermes",f.adapter]]),request);
 expect(result).toMatchObject({ok:true,admitted:true});
 const session=await f.adapter.getSession(key);
 expect(session?.model).toBe("MiniMax-M3");expect(session?.meta?.selectedModel).toBe("glm-5.3-flash");
 expect(await f.adapter.changeModel(key,"glm-5.3-flash")).toEqual({ok:true});
 expect(await f.adapter.changeModel(key,"MiniMax-M3")).toMatchObject({ok:false});
 expect(f.bodies.filter(v=>v.op==="send")).toHaveLength(1);expect(f.spawnJob).not.toHaveBeenCalled();
});

it("keeps unknown effective model valid for the optional AgentSession/MCP model field",async()=>{
 const f=await fixture(null);
 const request={harness:"hermes",name:"unknown-effective",cwd:"/tmp",message:"Read only",inputId:"model-unknown",mode:"queue" as const,model:"glm-5.3-flash"};
 expect(await newOrResumeNamedSession(new Map([["hermes",f.adapter]]),request)).toMatchObject({ok:true,admitted:true});
 const session=await f.adapter.getSession(key);
 expect(session).not.toHaveProperty("model");expect(session?.meta?.selectedModel).toBe("glm-5.3-flash");
 expect(await f.adapter.findNamedSessions("unknown-effective","/tmp")).toEqual([session]);
 expect(f.inputs.size).toBe(1);expect(f.spawnJob).not.toHaveBeenCalled();
});
