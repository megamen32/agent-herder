import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserIoChatGptDriver, type UserIoConfig } from "../src/adapters/chatgpt-userio-driver.js";
import { makeConfiguredAdapter } from "../src/ahap-browser-runner.js";
import { userIoAccountScope } from "../src/adapters/userio-agent-channel.js";

const CHAT = "11111111-1111-4111-8111-111111111111";
const USR = "22222222-2222-4222-8222-222222222222";
const ASST = "33333333-3333-4333-8333-333333333333";
const INSTANCE = "browser-44444444-4444-4444-8444-444444444444";
const IDENTITY = "account-uuid-userio-canary";
const SCOPE = userIoAccountScope('chatgpt','user-1','account-1');
const homes:string[]=[];
afterEach(()=>{for(const dir of homes.splice(0))rmSync(dir,{force:true,recursive:true});});
function fixture(results:Record<string,Record<string,unknown>>, onlineInstances:string[]=[INSTANCE], receiptInstance:string|undefined=INSTANCE, context:{connectionId?:string;principalId?:string}={}){
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
        id,action:v.action,agent_id:"agent-default",agent_instance_id:receiptInstance,
        ...(context.connectionId?{connection_id:context.connectionId}:{}),
        ...(context.principalId?{principal_id:context.principalId}:{}),result:v.result
      }))}),{status:200});
    }
    return new Response("not found",{status:404});
  };
  const config:UserIoConfig={endpoint:"http://127.0.0.1:9999",agentId:"agent-default",
    instanceId:INSTANCE,accountScope:SCOPE,tokenFile,...context,fetcher:fetcher as typeof fetch};
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
  it("derives account scope from provider, user and workspace account identity",()=>{
    expect(userIoAccountScope('chatgpt','user-1','account-1')).toBe(
      createHash('sha256').update(JSON.stringify({provider:'chatgpt',user_id:'user-1',account_id:'account-1'})).digest('hex'));
    expect(userIoAccountScope('chatgpt','user-1','account-1')).not.toBe(userIoAccountScope('chatgpt','user-1','account-2'));
  });
  it("routes every command to one UUID and preserves latest native pair",async()=>{
    const context={connectionId:"work",principalId:"principal-work"};
    const {driver,events}=fixture({
      gpt_session_proof:{ok:true,present:true,proof:"a".repeat(64)},
      gpt_scope:{ok:true,account_scope:SCOPE,provider:'chatgpt',user_id:'user-1',account_id:'account-1'},
      gpt_list:{ok:true,chats:[{id:CHAT,title:"Existing chat",update_time:10}]},
      gpt_read:read,gpt_send:{ok:true,reply:"A",chat_url:"https://chatgpt.com/c/"+CHAT},
    },[INSTANCE],INSTANCE,context);
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
    expect(events.every(e=>(e as typeof e & {connection_id?:string}).connection_id==="work")).toBe(true);
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
  it("rejects a result from a different or missing native agent instance",async()=>{
    for(const instance of ['browser-99999999-9999-4999-8999-999999999999', '']) {
      const {driver}=fixture({gpt_session_proof:{ok:true,present:true,proof:'a'.repeat(64)}},[INSTANCE],instance);
      await expect(driver.verifyPinnedAccountScope()).rejects.toThrow('userio_command_result_mismatch');
    }
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
  it("returns the full native message snapshot and rejects a different snapshot account",async()=>{
    const earlier={...read.latest_user,id:'55555555-5555-4555-8555-555555555555',text:'earlier'};
    const snapshot={...read,account_scope:SCOPE,snapshot_epoch:'epoch-1',revision:4,
      coverage:'conversation',complete:true,limitations:[],messages:[earlier,read.latest_user,read.latest_assistant]};
    const auth={gpt_session_proof:{ok:true,present:true,proof:'a'.repeat(64)},gpt_scope:{ok:true,account_scope:SCOPE}};
    const {driver}=fixture({...auth,gpt_read:snapshot});
    await driver.verifyPinnedAccountScope();
    expect((await driver.getMessages(CHAT)).map(m=>m.text)).toEqual(['earlier',"User's original prompt",'Original assistant response']);
    const raw=await driver.getRawTranscript(CHAT);
    expect(raw.complete).toBe(true);
    expect(JSON.parse(Buffer.from(raw.bytes).toString())).toMatchObject({snapshot_epoch:'epoch-1',revision:4,account_scope:SCOPE,chat_ref:CHAT});
    const other=fixture({...auth,gpt_read:{...snapshot,account_scope:'b'.repeat(64)}}).driver;
    await other.verifyPinnedAccountScope();
    await expect(other.getMessages(CHAT)).rejects.toThrow('userio_read_account_mismatch');
  });
  it("reports a legacy latest-pair read as incomplete",async()=>{
    const {driver}=fixture({gpt_session_proof:{ok:true,present:true,proof:'a'.repeat(64)},
      gpt_scope:{ok:true,account_scope:SCOPE},gpt_read:read});
    await driver.verifyPinnedAccountScope();
    expect(await driver.getRawTranscript(CHAT)).toMatchObject({complete:false});
  });
  it("defaults to UserIO with complete config and accepts the Rust token alias",()=>{
    const {config}=fixture({});
    const adapter=makeConfiguredAdapter({AHAP_HARNESS:'chatgpt',AHAP_BROWSER_ACCOUNT_SCOPE:SCOPE,
      AHAP_USERIO_ENDPOINT:config.endpoint,AHAP_USERIO_AGENT_ID:config.agentId,
      AHAP_USERIO_INSTANCE_ID:config.instanceId,AHAP_USERIO_TOKEN_FILE:config.tokenFile});
    expect(adapter.name).toContain('UserIO');
  });
});
