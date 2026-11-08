import { it, expect } from "vitest";
import { runInNewContext } from "node:vm";
import { webcrypto, createHash } from "node:crypto";
import { chatgptArchiveScript } from "../src/adapters/chatgpt-archive.js";
import { BrowserChatAdapter, type BrowserChatDriver } from "../src/adapters/browser-chat.js";

const id="123e4567-e89b-12d3-a456-426614174000";
const scope=createHash("sha256").update("account").digest("hex");
async function exercise(options:{wrongAccount?:boolean;wrongId?:boolean;archived?:boolean;status?:number;lostReadback?:boolean}={}) {
  const calls:Array<{url:string;method:string;body?:string}>=[];
  let archived=!!options.archived;
  const result=await runInNewContext(`(${chatgptArchiveScript(id,scope)})()`, {
    location:{origin:"https://chatgpt.com"},crypto:webcrypto,TextEncoder,AbortController,setTimeout,clearTimeout,
    fetch:async(url:string,init:RequestInit={})=>{
      calls.push({url,method:init.method??"GET",body:init.body as string|undefined});
      if(url==="/api/auth/session")return {ok:true,json:async()=>({accessToken:"not-a-real-token",account:{id:options.wrongAccount?"other":"account"}})};
      if(init.method==="PATCH"){archived=true;return {ok:true};}
      if(options.status)return {ok:false,status:options.status};
      return {ok:true,json:async()=>({conversation_id:options.wrongId?"other":id,is_archived:options.lostReadback?false:archived})};
    },
  });
  return {result,calls};
}
it("archives the exact chat with one PATCH, verifies native readback, never DELETE",async()=>{
  const {result,calls}=await exercise();expect(result.ok).toBe(true);
  expect(calls.filter(c=>c.method==="PATCH")).toEqual([{url:`/backend-api/conversation/${id}`,method:"PATCH",body:'{"is_archived":true}'}]);
  expect(calls.at(-1)?.method).toBe("GET");expect(calls.some(c=>c.method==="DELETE")).toBe(false);
});
it.each([{wrongAccount:true},{wrongId:true},{status:429}])("does not mutate an unverified or unavailable chat %j",async options=>{
  const {result,calls}=await exercise(options);expect(result.ok).toBe(false);expect(calls.every(c=>c.method==="GET")).toBe(true);
});
it("already archived is idempotent and a missing confirmation is not success",async()=>{
  const existing=await exercise({archived:true});expect(existing.result).toMatchObject({ok:true,already:true});expect(existing.calls.length).toBe(2);
  const missing=await exercise({lostReadback:true});expect(missing.result).toMatchObject({ok:false,error:"archive_readback_unconfirmed"});
});
it("the adapter maps its scoped ID and returns the same public ID",async()=>{
  const seen:string[]=[];
  const driver={listChats:async()=>[],sendMessage:async()=>({}),archiveChat:async(chatId:string)=>{seen.push(chatId);return {ok:true}}} satisfies BrowserChatDriver;
  const adapter=new BrowserChatAdapter(driver,{id:"chatgpt",name:"ChatGPT",harness:"chatgpt",cwd:"/test"},"/test",true);
  expect(await adapter.archiveSession(`chatgpt::${id}`)).toEqual({ok:true,sessionId:`chatgpt::${id}`});expect(seen).toEqual([id]);
  await expect(adapter.archiveSession(`zai::${id}`)).rejects.toThrow();
});

it("Z.ai native toggle is never called on an already archived chat",async()=>{
  const {zaiArchiveScript}=await import("../src/adapters/zai-archive.js");
  for(const initial of [false,true,undefined]) {
    let archived=initial;let posts=0;
    const result=await runInNewContext(`(${zaiArchiveScript(id,scope)})()`,{
      location:{origin:"https://chat.z.ai"},localStorage:{getItem:()=>null},crypto:webcrypto,TextEncoder,AbortController,setTimeout,clearTimeout,
      fetch:async(_url:string,opts:RequestInit={})=>{
        if(opts.method==="POST"){posts++;archived=!archived;return {ok:true};}
        return {ok:true,json:async()=>({id,user_id:"account",archived})};
      },
    });
    expect(posts).toBe(initial===false?1:0);expect(result.ok).toBe(initial!==undefined);
  }
});
