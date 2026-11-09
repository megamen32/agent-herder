
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAutopilotCore, createOpenAICompatibleJudge, type StopHookInput } from "../src/autopilot/index.js";
import { UserStyleStore } from "../src/autopilot/user-style.js";

const dirs:string[]=[];
afterEach(async()=>{for(const path of dirs.splice(0))await rm(path,{recursive:true,force:true});});
const hook:StopHookInput={hook_event_name:"Stop",session_id:"zai-context-integration",cwd:"/test",turn_id:"turn-1",
 harness:"chatgpt",last_user_message:"Выполни мою задачу",last_assistant_message:"Выполнено",transcript_path:null,stop_hook_active:false};
async function style(){const dir=await mkdtemp(join(tmpdir(),"zai-judge-integration-"));dirs.push(dir);return new UserStyleStore(join(dir,"style.json"));}
const success=()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({kind:"done",summary:"Задача завершена",notify:false})}}]}),{status:200,headers:{"content-type":"application/json"}});

describe("configured Z.AI autopilot judge",()=>{
 it("cycles the actual inference requests and retains the complete latest pair through the semantic core",async()=>{
  const requests:any[]=[];
  const fetchImpl=vi.fn(async(_url:any,init:any)=>{
   requests.push(JSON.parse(init.body));
   if(requests.length<3)return new Response(JSON.stringify({error:{code:"1305",message:"busy"}}),{status:503,headers:{"content-type":"application/json"}});
   return success();
  });
  const lastUser="Проверь каждое из требований. ".repeat(250)+"КОНЕЦ_ЗАДАЧИ";
  const lastAssistant="Промежуточный результат с проверками. ".repeat(300)+"КОНЕЦ_ОТВЕТА";
  const judge=createOpenAICompatibleJudge({baseUrl:"https://api.z.ai/api/coding/paas/v4",model:"unused-default",retryPolicy:"zai-cycle",
   retrySleep:async()=>{},fetchImpl:fetchImpl as typeof fetch,styleStore:await style()});
  const notify={send:vi.fn(async()=>{})};
  const core=createAutopilotCore({judge,notify,receiptStore:new Map(),allowSessions:new Set([hook.session_id]),maxContinuationsPerSession:3});
  await core.handleStop({...hook,last_user_message:lastUser,last_assistant_message:lastAssistant,
   messages:[{id:"old-user",role:"user",text:"Ранее поставленная задача"},{id:"old-answer",role:"assistant",text:"Предыдущий результат"},
    {id:"new-user",role:"user",text:lastUser},{id:"new-answer",role:"assistant",text:lastAssistant}]});
  expect(requests.map(request=>request.model)).toEqual(["glm-5.3","glm-5.2","glm-5.3-flash"]);
  for(const request of requests){
   const payload=JSON.parse(request.messages[1].content);
   expect(payload.hook.last_user_message).toBe(lastUser);
   expect(payload.hook.last_assistant_message).toBe(lastAssistant);
   expect(payload.hook).not.toHaveProperty("messages");
   expect(payload.conversation_history.map((message:any)=>message.content)).toEqual(["Ранее поставленная задача","Предыдущий результат"]);
   expect(payload.context_truncation.contextBytes).toBeLessThanOrEqual(128*1024);
  }
  expect(notify.send).not.toHaveBeenCalled();
 });

 it("retains the one-attempt behavior of an unselected provider",async()=>{
  const fetchImpl=vi.fn(async()=>new Response(JSON.stringify({error:{message:"busy"}}),{status:503}));
  const judge=createOpenAICompatibleJudge({baseUrl:"https://judge.example/v1",model:"existing-model",fetchImpl:fetchImpl as typeof fetch,styleStore:await style()});
  await expect(judge.decide({hook,evidence:"",remainingContinuations:3})).rejects.toThrow();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
 });

 it("does not call Z.AI with a missing mandatory human request",async()=>{
  const fetchImpl=vi.fn(async()=>success());
  const judge=createOpenAICompatibleJudge({baseUrl:"https://api.z.ai/api/coding/paas/v4",model:"glm-5.3",retryPolicy:"zai-cycle",fetchImpl:fetchImpl as typeof fetch,styleStore:await style()});
  await expect(judge.decide({hook:{...hook,last_user_message:null},evidence:"",remainingContinuations:3})).rejects.toMatchObject({code:"missing_user_message"});
  expect(fetchImpl).not.toHaveBeenCalled();
 });

 it("cancels the retry loop when the session is no longer eligible",async()=>{
  let eligible=true;
  const fetchImpl=vi.fn(async()=>new Response(JSON.stringify({error:{code:"1305",message:"busy"}}),{status:503}));
  const judge=createOpenAICompatibleJudge({baseUrl:"https://api.z.ai/api/coding/paas/v4",model:"glm-5.3",retryPolicy:"zai-cycle",
   shouldContinue:()=>eligible,retrySleep:async()=>{eligible=false},fetchImpl:fetchImpl as typeof fetch,styleStore:await style()});
  await expect(judge.decide({hook,evidence:"",remainingContinuations:3})).rejects.toMatchObject({name:"AbortError"});
  expect(fetchImpl).toHaveBeenCalledTimes(1);
 });
 it("halts on the actual ZAI no-resource-package code instead of cycling a billing refusal",async()=>{
  const fetchImpl=vi.fn(async()=>new Response(JSON.stringify({error:{code:"1113",message:"Insufficient balance or no resource package."}}),{status:429}));
  const judge=createOpenAICompatibleJudge({baseUrl:"https://api.z.ai/api/coding/paas/v4",model:"glm-5.3",retryPolicy:"zai-cycle",
   retrySleep:async()=>{},fetchImpl:fetchImpl as typeof fetch,styleStore:await style()});
  await expect(judge.decide({hook,evidence:"",remainingContinuations:3})).rejects.toMatchObject({diagnostic:{kind:"quota_exhausted",providerCode:"1113"}});
  expect(fetchImpl).toHaveBeenCalledTimes(1);
 });

});
