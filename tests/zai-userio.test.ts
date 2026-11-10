import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserIoConfig } from "../src/adapters/userio-agent-channel.js";
import { ZaiUserIoDriver } from "../src/adapters/zai-userio-driver.js";
import { ZaiUserIoJudgeSlot } from "../src/autopilot/zai-userio-judge.js";
import { makeConfiguredAdapter } from "../src/ahap-browser-runner.js";
import { validateV1BrowserAutopilotConfig } from "../src/automation/v1-browser-runtime.js";

const REF=randomUUID();
const USER=randomUUID();
const ASST=randomUUID();
const SCOPE=createHash("sha256").update(randomUUID()).digest("hex");
const INSTANCE="browser-"+randomUUID();
const folders:string[]=[];
afterEach(()=>{for(const d of folders.splice(0))rmSync(d,{force:true,recursive:true});});
const read={ok:true,chat_ref:REF,ready:true,messages:[
  {id:USER,role:"user",text:"Original request",timestamp:1},
  {id:ASST,role:"assistant",text:"Original answer",timestamp:2,done:true,model:"GLM-5.3"}
]};
type Command={action:string;args:Record<string,unknown>;agent_instance_id:string};
function fixture(outcomes:Record<string,Record<string,unknown>>,instances:string[]=[INSTANCE]){
 const home=mkdtempSync(join(tmpdir(),"userio-zai-tests-"));folders.push(home);
 const tokenFile=join(home,"auth.token");
 writeFileSync(tokenFile,"fixture-token",{mode:0o600});
 const commands:Command[]=[],pending=new Map<string,{action:string;value:Record<string,unknown>}>();
 let seq=0;
 const fake=async(uri:RequestInfo|URL,options:RequestInit={})=>{
  const url=new URL(String(uri));
  if(url.pathname==="/v1/agent/status")
   return new Response(JSON.stringify({agents:[{agent_id:"fixture-agent",instances}]}),{status:200});
  if(url.pathname==="/v1/agent/commands"){
   const cmd=JSON.parse(String(options.body)) as Command;
   commands.push(cmd);
   const id="fixture-agent:"+(++seq);
   pending.set(id,{action:cmd.action,value:outcomes[cmd.action]??{ok:false,error:"missing_action"}});
   return new Response(JSON.stringify({queued:true,id}),{status:202});
  }
  if(url.pathname==="/v1/agent/results")
   return new Response(JSON.stringify({results:[...pending].map(([id,v])=>({
     id,action:v.action,agent_id:"fixture-agent",agent_instance_id:INSTANCE,result:v.value
   }))}),{status:200});
  return new Response(JSON.stringify({error:"missing"}),{status:404});
 };
 const config:UserIoConfig={endpoint:"http://127.0.0.1:9999",agentId:"fixture-agent",
   instanceId:INSTANCE,accountScope:SCOPE,tokenFile,fetcher:fake as typeof fetch};
 return {config,commands,driver:new ZaiUserIoDriver(config)};
}
const outcomes={
 zai_scope:{ok:true,account_scope:SCOPE},
 zai_list:{ok:true,account_scope:SCOPE,chats:[
   {id:REF,title:"Chat Z",updated_at:1,last_run_status:"completed",unread:false}
 ]},
 zai_read:read,
 zai_send:{ok:true,admission:"confirmed",chat_ref:REF,native_user_message_id:USER},
 zai_judge:{ok:true,kind:"answer",text:'{"done":true}',userMessageId:USER,assistantMessageId:ASST},
};
const attempt=(model:"glm-5.3"|"glm-5.2"|"glm-5.3-flash"="glm-5.3")=>({
 model,prompt:"latest user and assistant",signal:new AbortController().signal
});
describe("ZAI under exact UserIO browser profile",()=>{
 it("lists native ZAI conversations and reads original user+assistant",async()=>{
   const {driver,commands}=fixture(outcomes);
   await driver.verifyPinnedAccountScope();
   expect(driver.getAccountScope()).toBe(SCOPE);
   const chats=await driver.listChats();
   expect(chats).toHaveLength(1);
   expect(chats[0]).toMatchObject({id:"route:"+REF,title:"Chat Z",working:false});
   const messages=await driver.getMessages("route:"+REF);
   expect(messages[0]).toMatchObject({role:"user",id:USER,text:"Original request"});
   expect(messages[1]).toMatchObject({role:"assistant",id:ASST,endTurn:true,model:"GLM-5.3"});
   expect(commands.every(c=>c.agent_instance_id===INSTANCE)).toBe(true);
 });
 it("refuses an account mismatch before reading or writing",async()=>{
   const {driver,commands}=fixture({...outcomes,zai_scope:{ok:true,account_scope:"a".repeat(64)}});
   await expect(driver.verifyPinnedAccountScope()).rejects.toThrow("scope mismatch");
   await expect(driver.getMessages("route:"+REF)).rejects.toThrow("scope mismatch");
   expect(commands.map(c=>c.action)).toEqual(["zai_scope"]);
 });
 it("refuses cross-profile token mismatch before any command",async()=>{
   const {driver,commands}=fixture(outcomes,[]);
   await expect(driver.verifyPinnedAccountScope()).rejects.toThrow("profile_principal_mismatch");
   expect(commands).toHaveLength(0);
 });
 it("sends exactly once after confirmed read preflight and receipt",async()=>{
   const {driver,commands}=fixture(outcomes);
   await driver.verifyPinnedAccountScope();
   await driver.sendMessage({chatId:"route:"+REF,text:"only once"});
   expect(commands.filter(x=>x.action==="zai_send")).toHaveLength(1);
   expect(commands.find(x=>x.action==="zai_send")?.args).toMatchObject({
     chat_ref:REF,expected_account_scope:SCOPE,text:"only once"
   });
 });
 it("prevents sends from native busy chats",async()=>{
   const {driver,commands}=fixture({...outcomes,zai_read:{...read,ready:false}});
   await driver.verifyPinnedAccountScope();
   await expect(driver.sendMessage({chatId:"route:"+REF,text:"never"}))
     .rejects.toThrow("send_not_ready");
   expect(commands.some(c=>c.action==="zai_send")).toBe(false);
 });
 it("rejects Vibe as the owner transport for ZAI",()=>{
   const env:NodeJS.ProcessEnv={AHAP_HARNESS:"zai",AHAP_BROWSER_TRANSPORT:"vibe-mcp"};
   expect(()=>makeConfiguredAdapter(env)).toThrow("Vibe is not permitted");
 });
});
describe("UserIO judge plugged into existing GLM fallback pool",()=>{
 it("proves the profile and receives a correlated answer",async()=>{
   const {config,commands}=fixture(outcomes);
   const slot=new ZaiUserIoJudgeSlot(config);
   const r=await slot.infer(attempt("glm-5.2"));
   expect(r).toEqual({kind:"answer",text:'{"done":true}',
     userMessageId:USER,assistantMessageId:ASST});
   const judge=commands.filter(c=>c.action==="zai_judge");
   expect(judge).toHaveLength(1);
   expect(judge[0]?.args).toMatchObject({model:"glm-5.2",
     expected_account_scope:SCOPE,prompt:"latest user and assistant"});
 });
 it("typed model unavailable permits next GLM without a duplicate click",async()=>{
   const {config,commands}=fixture({...outcomes,zai_judge:{ok:true,kind:"model_unavailable"}});
   const slot=new ZaiUserIoJudgeSlot(config);
   expect(await slot.infer(attempt())).toEqual({kind:"model_unavailable"});
   expect(slot.isQuarantined()).toBe(false);
   expect(commands.filter(c=>c.action==="zai_judge")).toHaveLength(1);
 });
 it("UNKNOWN requires reconciliation and prohibits automatic replay",async()=>{
   const {config,commands}=fixture({...outcomes,zai_judge:{ok:false,error:"zai_judge_outcome_unknown"}});
   const slot=new ZaiUserIoJudgeSlot(config);
   await expect(slot.infer(attempt())).rejects.toThrow("zai_userio_outcome_unknown");
   expect(slot.isQuarantined()).toBe(true);
   await expect(slot.infer(attempt("glm-5.2"))).rejects.toThrow("requires_reconciliation");
   expect(commands.filter(c=>c.action==="zai_judge")).toHaveLength(1);
 });
 it("does not enqueue anything after cancellation",async()=>{
   const {config,commands}=fixture(outcomes);
   const slot=new ZaiUserIoJudgeSlot(config);
   const aborter=new AbortController();aborter.abort();
   await expect(slot.infer({...attempt(),signal:aborter.signal})).rejects.toThrow();
   expect(commands).toHaveLength(0);
 });
});
describe("runtime config supports several distinct UserIO profiles",()=>{
 it("accepts multiple bounded profile credentials by file path",()=>{
   const cfg={schemaVersion:1,enabled:false,
     statePath:"/tmp/autopilot.json",gptadminProfileFile:"/tmp/profile.json",profiles:[],
     zai:{transport:"userio",profiles:[
       {endpoint:"https://example.invalid",agentId:"fixture-agent",
         instanceId:INSTANCE,accountScope:SCOPE,tokenFile:"/tmp/carevio.token"},
       {endpoint:"https://example.invalid",agentId:"fixture-agent",
         instanceId:"browser-"+randomUUID(),
         accountScope:"a".repeat(64),tokenFile:"/tmp/default.token"}
     ]}};
   const verified=validateV1BrowserAutopilotConfig(cfg);
   expect(verified.zai.transport).toBe("userio");
   if(verified.zai.transport==="userio")expect(verified.zai.profiles).toHaveLength(2);
 });
 it("rejects duplicate instance UUIDs and Vibe URLs",()=>{
   const p={endpoint:"https://example.invalid",agentId:"fixture-agent",
     instanceId:INSTANCE,accountScope:SCOPE,tokenFile:"/tmp/auth.token"};
   const base={schemaVersion:1,enabled:false,
     statePath:"/tmp/autopilot.json",gptadminProfileFile:"/tmp/profile.json",profiles:[]};
   expect(()=>validateV1BrowserAutopilotConfig({...base,zai:{transport:"userio",profiles:[p,p]}}))
     .toThrow("profile_invalid");
   expect(()=>validateV1BrowserAutopilotConfig({...base,
     zai:{transport:"browser",accountScope:SCOPE,browserMcpUrl:"https://example.invalid/server/fixture/mcp"}}))
     .toThrow("vibe_transport_disabled");
 });
});
