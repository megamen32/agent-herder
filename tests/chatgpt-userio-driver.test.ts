import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserIoChatGptDriver, type UserIoConfig } from "../src/adapters/chatgpt-userio-driver.js";
import { makeConfiguredAdapter } from "../src/ahap-browser-runner.js";

const CHAT = "11111111-1111-4111-8111-111111111111";
const USR = "22222222-2222-4222-8222-222222222222";
const ASST = "33333333-3333-4333-8333-333333333333";
const INSTANCE = "browser-44444444-4444-4444-8444-444444444444";
const IDENTITY = "account-uuid-userio-canary";
const SCOPE = createHash("sha256").update(IDENTITY).digest("hex");
const homes:string[]=[];
afterEach(()=>{for(const dir of homes.splice(0))rmSync(dir,{force:true,recursive:true});});
function fixture(results:Record<string,Record<string,unknown>>, onlineInstances:string[]=[INSTANCE]){
  const home=mkdtempSync(join(tmpdir(),"herder-userio-test-"));homes.push(home);
  const tokenFile=join(home,"token");writeFileSync(tokenFile,"test-valid-token-12345",{mode:0o600});
  const events:{action:string;args:Record<string,unknown>;agent_instance_id:string}[]=[];
  const pending=new Map<string,{action:string;result:Record<string,unknown>}>();
  let seq=0;
  const fetcher=async (raw:RequestInfo|URL,opts:RequestInit={})=>{
    const url=new URL(String(raw));
    if(url.pathname==="/v1/agent/status"){
      return new Response(JSON.stringify({agents:[{
        agent_id:"agent-default",instances:onlineInstances
      }]}),{status:200});
    }
    if(url.pathname==="/v1/agent/commands"&&opts.method==="POST"){
      const item=JSON.parse(String(opts.body)) as {
        action:string;agent_instance_id:string;args:Record<string,unknown>;
      };
      events.push(item);
      const id="agent-default:"+(++seq);
      pending.set(id,{action:item.action,result:results[item.action]??{ok:false,error:"unknown_action"}});
      return new Response(JSON.stringify({queued:true,id}),{status:202});
    }
    if(url.pathname==="/v1/agent/results"&&opts.method==="GET"){
      return new Response(JSON.stringify({results:[...pending].map(([id,v])=>({
        id,action:v.action,agent_id:"agent-default",result:v.result
      }))}),{status:200});
    }
    return new Response("not found",{status:404});
  };
  const config:UserIoConfig={endpoint:"http://127.0.0.1:9999",agentId:"agent-default",
    instanceId:INSTANCE,accountScope:SCOPE,tokenFile,fetcher:fetcher as typeof fetch};
  return {driver:new UserIoChatGptDriver(config),config,events};
}
const read={
  ok:true,chat_ref:CHAT,ready:true,phase:"idle",
  latest_user:{id:USR,role:"user",text:"User's original prompt",status:"finished_successfully",
    end_turn:true,create_time:1,update_time:1,phase:"final"},
  latest_assistant:{id:ASST,role:"assistant",text:"Original assistant response",status:"finished_successfully",
    end_turn:true,create_time:2,update_time:2,phase:"final",model:"gpt-6"},
};

describe("strict UserIO ChatGPT transport",()=>{
  it("routes every command to one UUID and preserves latest native pair",async()=>{
    const {driver,events}=fixture({
      gpt_session_proof:{ok:true,present:true,proof:"a".repeat(64)},
      gpt_scope:{ok:true,account_scope:SCOPE},
      gpt_list:{ok:true,chats:[{id:CHAT,title:"Existing chat",update_time:10}]},
      gpt_read:read,gpt_send:{ok:true,reply:"A",chat_url:"https://chatgpt.com/c/"+CHAT},
    });
    await driver.verifyPinnedAccountScope();
    expect(driver.getAccountScope()).toBe(SCOPE);
    const sessions=await driver.listObservedChats();
    expect(sessions.map(c=>c.id)).toEqual([CHAT]);
    const pair=await driver.getMessages(CHAT);
    expect(pair).toHaveLength(2);
    expect(pair[0]).toMatchObject({id:USR,role:"user",text:"User's original prompt"});
    expect(pair[1]).toMatchObject({id:ASST,role:"assistant",
      completionStatus:"finished_successfully",endTurn:true,model:"gpt-6"});
    expect(await driver.sendMessage({chatId:CHAT,text:"new user message"})).toEqual({assistantText:"A"});
    expect(events.every(e=>e.agent_instance_id===INSTANCE)).toBe(true);
    expect(events.filter(e=>e.action==="gpt_send")).toHaveLength(1);
    expect(events.find(e=>e.action==="gpt_send")?.args).toMatchObject({
      chat_ref:CHAT,mode:"ui",expected_account_scope:SCOPE});
  });
  it("rejects bearer principal mismatch before enqueueing any command",async()=>{
    const {driver,events}=fixture({
      gpt_session_proof:{ok:true,present:true,proof:"a".repeat(64)},
      gpt_scope:{ok:true,account_scope:SCOPE}
    },[]);
    await expect(driver.verifyPinnedAccountScope()).rejects.toThrow(
      "userio_profile_principal_mismatch");
    expect(events).toHaveLength(0);
  });
  it("refuses any account mismatch before enumerating or sending",async()=>{
    const {driver,events}=fixture({
      gpt_session_proof:{ok:true,present:true,proof:"a".repeat(64)},
      gpt_scope:{ok:true,account_scope:"b".repeat(64)}
    });
    await expect(driver.verifyPinnedAccountScope()).rejects.toThrow("scope mismatch");
    await expect(driver.listObservedChats()).rejects.toThrow("scope mismatch");
    expect(events.map(e=>e.action)).toEqual(["gpt_session_proof","gpt_scope"]);
  });
  it("never writes after an incomplete ChatGPT response",async()=>{
    const {driver,events}=fixture({
      gpt_session_proof:{ok:true,present:true,proof:"a".repeat(64)},
      gpt_scope:{ok:true,account_scope:SCOPE},
      gpt_read:{...read,ready:false,
        latest_assistant:{...read.latest_assistant,status:"in_progress",end_turn:false}}
    });
    await driver.verifyPinnedAccountScope();
    await expect(driver.sendMessage({chatId:CHAT,text:"new prompt"})).rejects.toThrow("send_not_ready");
    expect(events.some(e=>e.action==="gpt_send")).toBe(false);
  });
  it("classifies a send acknowledgement failure as UNKNOWN, not retryable",async()=>{
    const {driver,events}=fixture({
      gpt_session_proof:{ok:true,present:true,proof:"a".repeat(64)},
      gpt_scope:{ok:true,account_scope:SCOPE},
      gpt_read:read,gpt_send:{ok:false,error:"network_unknown"}
    });
    await driver.verifyPinnedAccountScope();
    await expect(driver.sendMessage({chatId:CHAT,text:"only once"}))
      .rejects.toThrow("outcome unknown");
    expect(events.filter(e=>e.action==="gpt_send")).toHaveLength(1);
  });
  it("rejects HTTPS downgrade, foreign routes and wrong transport",()=>{
    const {config}=fixture({});
    expect(()=>new UserIoChatGptDriver({...config,endpoint:"http://public.example"}))
      .toThrow("userio_endpoint_invalid");
    expect(()=>new UserIoChatGptDriver({...config,instanceId:"browser-invalid"}))
      .toThrow("userio_profile_invalid");
    expect(()=>makeConfiguredAdapter({
      AHAP_HARNESS:"chatgpt",AHAP_BROWSER_TRANSPORT:"vibe-mcp",
    } as NodeJS.ProcessEnv)).toThrow("Vibe is not permitted");
  });
});
