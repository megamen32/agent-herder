import {afterEach,expect,it,vi} from "vitest";
import {OpenCodeClient} from "../src/harness/opencode/client.js";

afterEach(()=>vi.unstubAllGlobals());

it("preserves the native assistant turn identity and terminal finish in the existing phase field",async()=>{
 const fetch=vi.fn(async()=>new Response(JSON.stringify({data:[
  {id:"msg_assistant",type:"assistant",turnId:"turn_exact",finish:"stop",content:[{type:"text",text:"HF26_OK"}]},
  {id:"msg_user",type:"user",metadata:{agentHerderInputId:"input_exact"},text:"bounded fixture"},
 ]}),{headers:{"content-type":"application/json"}}));
 vi.stubGlobal("fetch",fetch);
 const client=new OpenCodeClient({baseUrl:"http://opencode.test",protocol:"v2"});
 const messages=await client.getMessages("ses_exact",10);
 expect(messages).toMatchObject([
  {id:"msg_user",role:"user"},
  {id:"msg_assistant",role:"assistant",turnId:"turn_exact",phase:"stop"},
 ]);
 expect(fetch).toHaveBeenCalledOnce();
});

it("returns an empty array for a successful empty native history",async()=>{
 const fetch=vi.fn(async()=>new Response(JSON.stringify({data:[]}),{headers:{"content-type":"application/json"}}));
 vi.stubGlobal("fetch",fetch);
 const client=new OpenCodeClient({baseUrl:"http://opencode.test",protocol:"v2"});

 expect(await client.getMessages("ses_empty",10)).toEqual([]);
});

it("keeps a nonempty status-only history unavailable when it has no failure details",async()=>{
 const fetch=vi.fn(async()=>new Response(JSON.stringify({data:[
  {id:"status_running",type:"step-start",sessionID:"ses_status"},
 ]}),{headers:{"content-type":"application/json"}}));
 vi.stubGlobal("fetch",fetch);
 const client=new OpenCodeClient({baseUrl:"http://opencode.test",protocol:"v2"});

 expect(await client.getMessages("ses_status",10)).toBeNull();
});
