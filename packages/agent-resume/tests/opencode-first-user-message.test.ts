import {afterEach,expect,it,vi} from "vitest";
import {OpenCodeClient} from "../src/harness/opencode/client.js";

afterEach(()=>vi.unstubAllGlobals());

const sessionId="ses_qa_join";
const initialInput={
 id:"msg_180ebd0ec001dc4ojwCQvJxogL",
 type:"user",
 messageID:"msg_180ebd0ec001dc4ojwCQvJxogL",
 sessionID:sessionId,
};
const laterUser={id:"msg_later_user",type:"user",sessionID:sessionId};
const turnStatus={id:"turn_1",type:"turn",sessionID:sessionId};

function installHistoryFixture(history:unknown[]){
 const calls:string[]=[];
 const fetch=vi.fn(async(input:RequestInfo|URL)=>{
  const url=String(input); calls.push(url);
  const json=(data:unknown)=>new Response(JSON.stringify({data} as any),{headers:{"content-type":"application/json"}});
  if(url.endsWith("/api/config"))return json({});
  if(url.endsWith(`/api/session/${sessionId}`))return json({id:sessionId,location:{directory:"/qa/project"}});
  if(url.includes(`/api/session/${sessionId}/message`)){
   const query=new URL(url).searchParams;
   if(query.get("order")==="asc")return json(history.filter(m=>m.type==="user") as any);
   return json(history as any);
  }
  return new Response("not found",{status:404});
 });
 vi.stubGlobal("fetch",fetch);
 return calls;
}

it("reads the earliest user message from a bounded head-of-history window",async()=>{
 const history=[initialInput,{id:"msg_a1",type:"assistant",sessionID:sessionId},laterUser,turnStatus];
 const calls=installHistoryFixture(history);
 const client=new OpenCodeClient({baseUrl:"http://opencode.test",protocol:"v2"});

 const first=await client.getFirstUserMessage(sessionId);

 expect(first).not.toBeNull();
 expect(first!.id).toBe(initialInput.id);
 expect(first!.role).toBe("user");
 const ascCall=calls.find(url=>url.includes("order=asc"));
 expect(ascCall).toBeTruthy();
 expect(ascCall).toContain("type=user");
 expect(ascCall).toContain("limit=5");
});

it("reaches an initial input that lives beyond the latest-50 tail window",async()=>{
 // The head-of-history window is keyed by order=asc, so an early message is
 // reachable regardless of how many newer messages exist after it.
 const history=[initialInput];
 for(let i=0;i<60;i++)history.push({id:`msg_newer_${i}`,type:"assistant",sessionID:sessionId});
 const calls=installHistoryFixture(history);
 const client=new OpenCodeClient({baseUrl:"http://opencode.test",protocol:"v2"});

 const first=await client.getFirstUserMessage(sessionId);

 expect(first?.id).toBe(initialInput.id);
 expect(calls.some(url=>url.includes("order=asc"))).toBe(true);
});

it("returns null when the head window carries no user message",async()=>{
 installHistoryFixture([{id:"msg_assistant_only",type:"assistant",sessionID:sessionId}]);
 const client=new OpenCodeClient({baseUrl:"http://opencode.test",protocol:"v2"});
 expect(await client.getFirstUserMessage(sessionId)).toBeNull();
});
