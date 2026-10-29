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

it("preserves the admitted input identity of a user message",async()=>{
 // The consumer binds one native message to the delivery that caused it by
 // this identity. Without it the durable receipt cannot name the message that
 // carried the admitted goal.
 const fetch=vi.fn(async()=>new Response(JSON.stringify({data:[
  {id:"msg_callback",type:"user",metadata:{agentHerderInputId:"herder-resume-abc"},text:"continue"},
  {id:"msg_plain",type:"user",text:"no binding"},
 ]}),{headers:{"content-type":"application/json"}}));
 vi.stubGlobal("fetch",fetch);
 const client=new OpenCodeClient({baseUrl:"http://opencode.test",protocol:"v2"});

 const messages=await client.getMessages("ses_exact",10);
 expect(messages).toMatchObject([
  {id:"msg_plain",role:"user"},
  {id:"msg_callback",role:"user",inputId:"herder-resume-abc"},
 ]);
 // A message without a proven binding must not carry one.
 expect(messages?.[0]?.inputId).toBeUndefined();
});
