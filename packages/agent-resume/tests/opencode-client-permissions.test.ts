import {afterEach,expect,it,vi} from "vitest";
import {OpenCodeClient} from "../src/harness/opencode/client.js";

afterEach(()=>vi.unstubAllGlobals());

const sessionId="ses_exact";
const permission={
 id:"per_exact",
 sessionID:sessionId,
 action:"shell",
 resources:["python3 -c 'print(\"marker\")'"],
 save:["python3 *"],
 source:{type:"tool",messageID:"msg_exact",id:"call_exact"},
};

function installNativeReadFixture(){
 const calls:string[]=[];
 const fetch=vi.fn(async(input:RequestInfo|URL)=>{
  const url=String(input); calls.push(url);
  const json=(data:unknown)=>new Response(JSON.stringify({data}),{headers:{"content-type":"application/json"}});
  if(url.endsWith("/api/config"))return json({});
  if(url.endsWith(`/api/session/${sessionId}`))return json({id:sessionId,location:{directory:"/qa/project"}});
  if(url.endsWith("/api/session/active"))return json({[sessionId]:{type:"running"}});
  if(url.endsWith("/api/permission/request"))return json([]);
  if(url.endsWith(`/api/session/${sessionId}/permission`))return json([permission]);
  return new Response("not found",{status:404});
 });
 vi.stubGlobal("fetch",fetch);
 return calls;
}

it("reads pending permissions from the exact session endpoint even when the global request list is empty",async()=>{
 const calls=installNativeReadFixture();
 const client=new OpenCodeClient({baseUrl:"http://opencode.test",protocol:"v2"});

 const state=await client.getPermissionState(sessionId);

 expect(calls).toContain(`http://opencode.test/api/session/${sessionId}/permission`);
 expect(state?.pendingRequests).toEqual([{
  id:"per_exact",
  toolName:"shell",
  command:"python3 -c 'print(\"marker\")'",
  canRespond:true,
  nativeMethod:"POST /api/session/:id/permission/:requestId/reply",
 }]);
});

it("normalizes OpenCode's native allow wildcard to the canonical fullAuto mode",async()=>{
 const fetch=vi.fn(async(input:RequestInfo|URL)=>{
  const url=String(input);
  const json=(data:unknown)=>new Response(JSON.stringify({data}),{headers:{"content-type":"application/json"}});
  if(url.endsWith("/api/config"))return json({});
  if(url.endsWith(`/api/session/${sessionId}`))return json({
   id:sessionId,
   permissions:[{action:"*",resource:"*",effect:"allow"}],
  });
  if(url.endsWith(`/api/session/${sessionId}/permission`))return json([]);
  return new Response("not found",{status:404});
 });
 vi.stubGlobal("fetch",fetch);
 const client=new OpenCodeClient({baseUrl:"http://opencode.test",protocol:"v2"});

 expect((await client.getPermissionState(sessionId))?.currentMode).toBe("fullAuto");
});

it("projects the exact native session permission into the session read",async()=>{
 const calls=installNativeReadFixture();
 const client=new OpenCodeClient({baseUrl:"http://opencode.test",protocol:"v2"});

 const session=await client.getSession(sessionId);

 expect(calls).toContain(`http://opencode.test/api/session/${sessionId}/permission`);
 expect(session).toMatchObject({
  id:sessionId,
  status:"running",
  needsPermission:true,
  permissionDetails:{id:"per_exact",type:"shell",toolName:"shell",details:"python3 -c 'print(\"marker\")'"},
 });
});

it("uses the global permission list only when the session endpoint is unsupported and filters by session id",async()=>{
 const calls:string[]=[];
 const fetch=vi.fn(async(input:RequestInfo|URL)=>{
  const url=String(input); calls.push(url);
  const json=(data:unknown)=>new Response(JSON.stringify({data}),{headers:{"content-type":"application/json"}});
  if(url.endsWith("/api/config"))return json({});
  if(url.endsWith(`/api/session/${sessionId}`))return json({id:sessionId,location:{directory:"/qa/project"}});
  if(url.endsWith(`/api/session/${sessionId}/permission`))return new Response("unsupported",{status:404});
  if(url.endsWith("/api/permission/request"))return json([{...permission,sessionID:"ses_other"},permission]);
  return new Response("not found",{status:404});
 });
 vi.stubGlobal("fetch",fetch);
 const client=new OpenCodeClient({baseUrl:"http://opencode.test",protocol:"v2"});

 const state=await client.getPermissionState(sessionId);

 expect(state?.pendingRequests.map(({id})=>id)).toEqual(["per_exact"]);
 expect(calls).toContain("http://opencode.test/api/permission/request");
});

it("fails closed when a session-scoped permission read returns a request for another session",async()=>{
 const fetch=vi.fn(async(input:RequestInfo|URL)=>{
  const url=String(input);
  const json=(data:unknown)=>new Response(JSON.stringify({data}),{headers:{"content-type":"application/json"}});
  if(url.endsWith("/api/config"))return json({});
  if(url.endsWith(`/api/session/${sessionId}`))return json({id:sessionId,location:{directory:"/qa/project"}});
  if(url.endsWith(`/api/session/${sessionId}/permission`))return json([{...permission,sessionID:"ses_other"}]);
  return json([]);
 });
 vi.stubGlobal("fetch",fetch);
 const client=new OpenCodeClient({baseUrl:"http://opencode.test",protocol:"v2"});

 expect(await client.getPermissionState(sessionId)).toBeNull();
 expect(fetch.mock.calls.map(([input])=>String(input))).not.toContain("http://opencode.test/api/permission/request");
});

it("does not fall back to the global list for a non-404 session permission error",async()=>{
 const calls:string[]=[];
 const fetch=vi.fn(async(input:RequestInfo|URL)=>{
  const url=String(input); calls.push(url);
  const json=(data:unknown)=>new Response(JSON.stringify({data}),{headers:{"content-type":"application/json"}});
  if(url.endsWith("/api/config"))return json({});
  if(url.endsWith(`/api/session/${sessionId}`))return json({id:sessionId,location:{directory:"/qa/project"}});
  if(url.endsWith(`/api/session/${sessionId}/permission`))return new Response("temporarily unavailable",{status:503});
  return json([]);
 });
 vi.stubGlobal("fetch",fetch);
 const client=new OpenCodeClient({baseUrl:"http://opencode.test",protocol:"v2"});

 expect(await client.getPermissionState(sessionId)).toBeNull();
 expect(calls).not.toContain("http://opencode.test/api/permission/request");
});

it("preserves pending permission from the listing fallback when the exact session read fails",async()=>{
 const fetch=vi.fn(async(input:RequestInfo|URL)=>{
  const url=String(input);
  const json=(data:unknown)=>new Response(JSON.stringify({data}),{headers:{"content-type":"application/json"}});
  if(url.endsWith("/api/config"))return json({});
  if(url.endsWith(`/api/session/${sessionId}`))return new Response("temporary failure",{status:503});
  if(url.includes("/api/session?")||url.endsWith("/api/session?order=desc&limit=100"))return json([{id:sessionId,location:{directory:"/qa/project"}}]);
  if(url.endsWith("/api/session/active"))return json({[sessionId]:{type:"running"}});
  if(url.endsWith(`/api/session/${sessionId}/permission`))return json([permission]);
  if(url.endsWith("/api/permission/request"))return json([]);
  return new Response("not found",{status:404});
 });
 vi.stubGlobal("fetch",fetch);
 const client=new OpenCodeClient({baseUrl:"http://opencode.test",protocol:"v2"});

 const session=await client.getSession(sessionId);

 expect(session).toMatchObject({id:sessionId,needsPermission:true,permissionDetails:{id:"per_exact"}});
});

it("checks all IDs in a multi-session listing so an idle pending session is not skipped",async()=>{
 const calls:string[]=[];
 const otherId="ses_idle_other";
 const fetch=vi.fn(async(input:RequestInfo|URL)=>{
  const url=String(input); calls.push(url);
  const json=(data:unknown)=>new Response(JSON.stringify({data}),{headers:{"content-type":"application/json"}});
  if(url.endsWith("/api/config"))return json({});
  if(url.includes("/api/session?"))return json([
   {id:sessionId,location:{directory:"/qa/project"}},
   {id:otherId,location:{directory:"/qa/project"}},
  ]);
  if(url.endsWith("/api/session/active"))return json({[sessionId]:{type:"idle"},[otherId]:{type:"idle"}});
  if(url.endsWith(`/api/session/${sessionId}/permission`))return json([permission]);
  if(url.endsWith(`/api/session/${otherId}/permission`))return json([]);
  return new Response("not found",{status:404});
 });
 vi.stubGlobal("fetch",fetch);
 const client=new OpenCodeClient({baseUrl:"http://opencode.test",protocol:"v2"});

 const sessions=await client.listSessions({cwd:"/qa/project"});

 expect(sessions.find(({id})=>id===sessionId)).toMatchObject({needsPermission:true,permissionDetails:{id:"per_exact"}});
 expect(calls).toContain(`http://opencode.test/api/session/${sessionId}/permission`);
 expect(calls).toContain(`http://opencode.test/api/session/${otherId}/permission`);
});

it("bounds session-scoped permission reads across a large listing",async()=>{
 let activeReads=0,maximumReads=0;
 const sessions=Array.from({length:17},(_,index)=>({id:`ses_${index}`,location:{directory:"/qa/project"}}));
 const fetch=vi.fn(async(input:RequestInfo|URL)=>{
  const url=String(input);
  const json=(data:unknown)=>new Response(JSON.stringify({data}),{headers:{"content-type":"application/json"}});
  if(url.endsWith("/api/config"))return json({});
  if(url.includes("/api/session?"))return json(sessions);
  if(url.endsWith("/api/session/active"))return json({});
  if(url.includes("/api/session/")&&url.endsWith("/permission")){
   activeReads++;maximumReads=Math.max(maximumReads,activeReads);
   await new Promise(resolve=>setTimeout(resolve,2));activeReads--;
   return json([]);
  }
  return new Response("not found",{status:404});
 });
 vi.stubGlobal("fetch",fetch);
 const client=new OpenCodeClient({baseUrl:"http://opencode.test",protocol:"v2"});

 await client.listSessions({cwd:"/qa/project",limit:100});

 expect(maximumReads).toBeLessThanOrEqual(8);
 expect(fetch.mock.calls.filter(([input])=>String(input).includes("/permission")).length).toBe(17);
});
