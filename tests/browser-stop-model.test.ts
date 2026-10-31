import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { BrowserChatAdapter, type BrowserChatDriver } from "../src/adapters/browser-chat.js";
import { ChatGptMacCdpDriver } from "../src/adapters/chatgpt-mac-cdp-driver.js";
import { ZaiCdpDriver } from "../src/adapters/zai-cdp-driver.js";
import type { ChromePageTools } from "../src/adapters/mac-mini-chrome-transport.js";

const GPT_ID="6ada477c-7014-83ed-82ae-7881dbe3e109";
const ZAI_PATH="/c/123e4567-e89b-12d3-a456-426614174000";
const fenced=(v:unknown)=>"Script ran on page and returned:\n```json\n"+JSON.stringify(v)+"\n```";

describe("provider-specific browser controls",()=>{
  it("exposes Stop and model selection only for site drivers that implement them",async()=>{
    let stopped="", changed="";
    const driver:BrowserChatDriver={
      listChats:async()=>[],sendMessage:async()=>({}),
      stopTurn:async id=>{stopped=id;return {stopped:true}},
      supportsModelSwitch:()=>true,listModels:async()=>["A","B"],
      changeModel:async ({chatId})=>{changed=chatId;return {ok:true}},
    };
    const adapter=new BrowserChatAdapter(driver,{id:"chatgpt",name:"ChatGPT",harness:"chatgpt",cwd:"/browser/chatgpt"},"/browser/chatgpt",true);
    expect(adapter.controlCapabilities).toMatchObject({cancelTurn:true,modelSwitch:true,terminate:false});
    expect(await adapter.listModels()).toEqual(["A","B"]);
    expect(await adapter.changeModel("chatgpt::native","B")).toEqual({ok:true});
    expect(changed).toBe("native");
    expect(await adapter.stopSession("chatgpt::native")).toMatchObject({ok:true,sessionId:"chatgpt::native"});
    expect(stopped).toBe("native");
    expect(await adapter.cancelTurn("zai::native")).toMatchObject({ok:false});
    expect(stopped).toBe("native");
    const readOnly=new BrowserChatAdapter({listChats:async()=>[],sendMessage:async()=>({})},
      {id:"zai",name:"Z.ai",harness:"zai",cwd:"/browser/zai"});
    expect(readOnly.controlCapabilities).toMatchObject({cancelTurn:false,modelSwitch:false});
  });

  it("ChatGPT Stop only clicks exact selected generating conversation; never Send",async()=>{
    let clicked=0,scriptCalls=0,actualPath="/c/"+GPT_ID,phase="generating";
    const tools:ChromePageTools={async call(name,args={}){
      if(name==="list_pages")return "7: ChatGPT (https://chatgpt.com/c/"+GPT_ID+")";
      if(name==="evaluate_script"){
        const script=String(args.function);
        if(script.includes("stop_control_not_unique")){
          scriptCalls++;
          const stop={disabled:false,getClientRects:()=>[1],
            getAttribute:(key:string)=>key==="data-testid"?"stop-button":null,click:()=>{clicked++}};
          return fenced(runInNewContext("("+script+")()",{
            location:{origin:"https://chatgpt.com",pathname:actualPath},
            document:{querySelectorAll:()=>[stop]},
          }));
        }
        return fenced({origin:"https://chatgpt.com",path:"/c/"+GPT_ID,
          authenticated:true,composer:true,phase,draftPresent:false,chats:[]});
      }
      throw Error("unexpected tool "+name);
    }};
    const d=new ChatGptMacCdpDriver(tools);
    expect(await d.stopTurn(GPT_ID)).toEqual({stopped:true});
    expect(clicked).toBe(1);
    actualPath="/c/unrelated";
    expect(await d.stopTurn(GPT_ID)).toMatchObject({stopped:false,error:"target_changed"});
    expect(clicked).toBe(1);
    phase="idle";
    expect((await d.stopTurn(GPT_ID)).stopped).toBe(false);
    expect(scriptCalls).toBe(2);
  });

  it("Z.ai Stop only clicks verified native generating chat with square Stop",async()=>{
    let clicks=0, actualPath=ZAI_PATH, selectedTitle="Test fixture";
    const tools:ChromePageTools={async call(name,args={}){
      if(name==="list_pages")return "11: ZAI (https://chat.z.ai"+ZAI_PATH+")";
      if(name==="evaluate_script"){
        const script=String(args.function);
        if(script.includes("stop_control_not_unique")){
          const btn={disabled:false,getClientRects:()=>[1],
            querySelector:(q:string)=>q.includes("span.block.size-3")?{}:null,click:()=>{clicks++}};
          const sel={querySelector:()=>({textContent:selectedTitle}),textContent:selectedTitle};
          const document={querySelector:(q:string)=>q.includes("data-selected")?sel:null,
            querySelectorAll:()=>[btn]};
          return fenced(runInNewContext("("+script+")()",{
            location:{origin:"https://chat.z.ai",pathname:actualPath},document,
          }));
        }
        return fenced({origin:"https://chat.z.ai",path:ZAI_PATH,loggedIn:true,
          composer:true,phase:"generating",draftPresent:false,
          titles:["Test fixture"],selectedTitle:"Test fixture"});
      }
      throw Error("unexpected "+name);
    }};
    const d=new ZaiCdpDriver(tools);
    await d.listChats();
    expect((await d.stopTurn("sidebar:Test%20fixture")).stopped).toBe(true);
    expect(clicks).toBe(1);
    actualPath="/c/other";
    expect(await d.stopTurn("sidebar:Test%20fixture")).toMatchObject({stopped:false,error:"target_changed"});
    expect(clicks).toBe(1);
    selectedTitle="Other";
    expect((await d.stopTurn("sidebar:Test%20fixture")).stopped).toBe(false);
  });
});

describe("model switching uses site-specific menus and exact target IDs",()=>{
  it("ChatGPT: lists actual menu entries, rejects busy, and verifies the per-chat script",async()=>{
    let phase:"idle"|"generating"="idle";
    const actions:string[]=[];
    const tools:ChromePageTools={async call(name,args={}){
      actions.push(name);
      if(name==="list_pages")return "7: ChatGPT (https://chatgpt.com/c/"+GPT_ID+")";
      if(name==="evaluate_script"){
        const fn=String(args.function);
        if(fn.includes("const model =")){
          expect(()=>new Function("return ("+fn+")")).not.toThrow();
          expect(fn).toContain('location.pathname === chatPath');
          return fenced({ok:true});
        }
        if(fn.includes("model_picker_unavailable"))return fenced({models:["GPT-6","GPT-5.6 Sol"]});
        return fenced({origin:"https://chatgpt.com",path:"/c/"+GPT_ID,
          authenticated:true,composer:true,phase,draftPresent:false,chats:[{id:GPT_ID,title:"Test"}]});
      }
      throw Error("unexpected "+name);
    }};
    const driver=new ChatGptMacCdpDriver(tools);
    expect(await driver.listModels()).toEqual(["GPT-6","GPT-5.6 Sol"]);
    expect(await driver.changeModel({chatId:GPT_ID,model:"GPT-6"})).toEqual({ok:true});
    expect(actions).not.toContain("navigate_page");
    phase="generating";
    expect((await driver.changeModel({chatId:GPT_ID,model:"GPT-5.6 Sol"})).ok).toBe(false);
  });

  it("Z.ai: uses GLM menu and refuses unknown models or target changes",async()=>{
    let phase:"idle"|"generating"="idle";
    const actions:string[]=[];
    const tools:ChromePageTools={async call(name,args={}){
      actions.push(name);
      if(name==="list_pages")return "11: Z.ai (https://chat.z.ai"+ZAI_PATH+")";
      if(name==="evaluate_script"){
        const fn=String(args.function);
        if(fn.includes("const model =")){
          expect(()=>new Function("return ("+fn+")")).not.toThrow();
          expect(fn).toContain("location.origin === 'https://chat.z.ai'");
          return fenced({ok:true});
        }
        if(fn.includes("model_picker_unavailable"))return fenced({models:["GLM-5.3-Flash","GLM-5.3","GLM-5.2"]});
        return fenced({origin:"https://chat.z.ai",path:ZAI_PATH,loggedIn:true,composer:true,
          phase,draftPresent:false,titles:["Test fixture"],selectedTitle:"Test fixture"});
      }
      throw Error("unexpected "+name);
    }};
    const driver=new ZaiCdpDriver(tools);
    expect(await driver.listModels()).toEqual(["GLM-5.3-Flash","GLM-5.3","GLM-5.2"]);
    await driver.listChats();
    expect(await driver.changeModel({chatId:"sidebar:Test%20fixture",model:"GLM-5.3"})).toEqual({ok:true});
    expect((await driver.changeModel({chatId:"sidebar:Test%20fixture",model:"not-a-model"})).ok).toBe(false);
    phase="generating";
    expect((await driver.changeModel({chatId:"sidebar:Test%20fixture",model:"GLM-5.2"})).ok).toBe(false);
    expect(actions).not.toContain("navigate_page");
  });
});
