import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireV1BrowserAutopilotLease, createV1BrowserNativePorts, readProtectedBrowserAutopilotJson, validateV1BrowserAutopilotConfig, type V1BrowserAutopilotConfig } from "../src/automation/v1-browser-runtime.js";

const directories:string[]=[];
afterEach(async()=>{for(const path of directories.splice(0))await rm(path,{recursive:true,force:true});});
const target={instanceRef:"chatgpt-carevio",sessionRef:"opaque-session-ref"};
const config:V1BrowserAutopilotConfig={schemaVersion:1,enabled:true,statePath:"/tmp/browser-autopilot-state.json",
 gptadminProfileFile:"/tmp/owner-profile.json",profiles:[{instanceRef:target.instanceRef,nodeRef:"mac-mini",label:"Carevio",cwd:"/Users/owner/chatgpt",sessionRefs:[target.sessionRef]}],
 zai:{baseUrl:"https://api.z.ai/api/coding/paas/v4",tokenEnv:"ZAI_TEST_TOKEN"}};
function fixture(){
 const row:any={session_ref:target.sessionRef,address:{instance:{node:"mac-mini",instance_id:target.instanceRef},native_session_id:"native-chat"},
  native:{id:"native-chat",harness:"chatgpt",cwd:"/Users/owner/chatgpt",status:"idle",needsPermission:false,model:"gpt-test"},human_stop:{held:false}};
 const messages:any[]=[{id:"u1",role:"user",text:"Проверь задачу"},{id:"a1",role:"assistant",parts:[{type:"text",text:"Нужна проверка"}],phase:"final"}];
 let delivery:unknown={resultType:"task",taskId:"delivery:one",status:"working"};
 let task:unknown={resultType:"complete",taskId:"delivery:one",status:"working"};
 const call=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==="sessions")return {sessions:[structuredClone(row)],next_cursor:null};
  if(name==="session")return {session_ref:target.sessionRef,page:{messages:structuredClone(messages)}};
  if(name==="deliver")return delivery;
  if(name==="compat_task")return task;
  throw new Error("unexpected tool "+name);
 });
 return {row,messages,call,ports:createV1BrowserNativePorts(config,{call}),setDelivery:(v:unknown)=>{delivery=v},setTask:(v:unknown)=>{task=v}};
}
const delivery=(revision:string)=>({target,nativeSessionId:"native-chat",message:"Продолжи проверку.",requestKey:"stable-request",expectedRevision:revision,turnId:"a1"});

describe("browser autopilot owner configuration",()=>{
 it("accepts only the official ZAI route and one credential reference",()=>{
  expect(validateV1BrowserAutopilotConfig(config).profiles).toHaveLength(1);
  expect(validateV1BrowserAutopilotConfig({...config,zai:{baseUrl:config.zai.baseUrl,tokenFile:"/tmp/zai-owner-token"}}).zai.tokenFile).toBe("/tmp/zai-owner-token");
  expect(()=>validateV1BrowserAutopilotConfig({...config,zai:{...config.zai,tokenFile:"/tmp/token"}})).toThrow("one_token_reference");
  for(const baseUrl of ["http://api.z.ai/api/paas/v4","https://api.z.ai.evil.example/api/paas/v4","https://api.z.ai:444/api/paas/v4","https://api.z.ai/api/paas/v4?x=1"])
   expect(()=>validateV1BrowserAutopilotConfig({...config,zai:{...config.zai,baseUrl}})).toThrow("route_mismatch");
 });
 it("binds the browser transport to a verified account and an allowed persistent MCP connection",()=>{
  const browser={transport:"browser",accountScope:"a".repeat(64),browserMcpUrl:"https://mcp.bezrabotnyi.com/server/vibemacminilocal/mcp"};
  expect(validateV1BrowserAutopilotConfig({...config,zai:browser}).zai).toMatchObject(browser);
  for(const change of [{accountScope:"Carevio"},{tokenEnv:"SECRET"},{browserMcpUrl:"https://example.com/mcp"},{sshTarget:"owner@host"}])
   expect(()=>validateV1BrowserAutopilotConfig({...config,zai:{...browser,...change}})).toThrow("browser_binding_invalid");
 });
 it("requires an exact nonempty enrolled target set when enabled",()=>{
  expect(()=>validateV1BrowserAutopilotConfig({...config,profiles:[]})).toThrow("requires_enrolled");
  expect(()=>validateV1BrowserAutopilotConfig({...config,profiles:[{...config.profiles[0],sessionRefs:["*"]}]})).toThrow("wildcard");
  expect(()=>validateV1BrowserAutopilotConfig({...config,profiles:[config.profiles[0],config.profiles[0]]})).toThrow("invalid_profile");
  expect(validateV1BrowserAutopilotConfig({...config,enabled:false,profiles:[]}).enabled).toBe(false);
 });
 it("reads owner-only regular files and refuses a public or symlink config",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"browser-owner-config-"));directories.push(dir);
  const path=join(dir,"config.json"),alias=join(dir,"alias.json");
  await writeFile(path,JSON.stringify(config),{mode:0o600});
  expect(await readProtectedBrowserAutopilotJson(path)).toMatchObject({schemaVersion:1});
  await symlink(path,alias);
  await expect(readProtectedBrowserAutopilotJson(alias)).rejects.toThrow("protected_file");
  await chmod(path,0o644);
  await expect(readProtectedBrowserAutopilotJson(path)).rejects.toThrow("protected_file");
 });
 it("admits only one worker for the same state path and releases the lease on shutdown",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"browser-worker-lease-"));directories.push(dir);
  const path=join(dir,"state.json"),release=await acquireV1BrowserAutopilotLease(path,()=>{});
  try {await expect(acquireV1BrowserAutopilotLease(path,()=>{})).rejects.toThrow("state_in_use");}
  finally {await release();}
  const next=await acquireV1BrowserAutopilotLease(path,()=>{});await next();
 });

});

describe("browser autopilot native boundary",()=>{
 it("reads exact account-scoped native identity and caches passive polling",async()=>{
  const f=fixture();const first=await f.ports.read(target);const second=await f.ports.read(target);
  expect(first).toEqual(second);
  expect(first).toMatchObject({...target,nativeSessionId:"native-chat",status:"idle",humanStopHeld:false});
  expect(first.messages[1]).toMatchObject({id:"a1",role:"assistant",text:"Нужна проверка",phase:"final"});
  expect(f.call.mock.calls.map(c=>c[0])).toEqual(["sessions","session"]);
  await expect(f.ports.read({...target,sessionRef:"other"})).rejects.toThrow("target_not_configured");
 });
 it("rejects a mismatched profile binding instead of reading another account",async()=>{
  const f=fixture();f.row.address.instance.instance_id="other-profile";
  await expect(f.ports.read(target)).rejects.toThrow("binding_mismatch");
  expect(f.call.mock.calls.map(c=>c[0])).toEqual(["sessions"]);
 });
 it("requires a fresh unchanged snapshot and current HumanStop before delivery",async()=>{
  const f=fixture();const before=await f.ports.read(target);
  f.row.human_stop.held=true;
  expect(await f.ports.deliver(delivery(before.revision))).toMatchObject({status:"rejected",reason:"native_fence_changed"});
  expect(f.call.mock.calls.some(c=>c[0]==="deliver")).toBe(false);
 });
 it("rejects delivery when the real user has written a newer message",async()=>{
  const f=fixture();const before=await f.ports.read(target);f.messages.push({id:"u2",role:"user",text:"Остановись и уточни"});
  expect(await f.ports.deliver(delivery(before.revision))).toMatchObject({status:"rejected"});
  expect(f.call.mock.calls.some(c=>c[0]==="deliver")).toBe(false);
 });
 it("keeps asynchronous acceptance distinct from confirmed native delivery",async()=>{
  const f=fixture();const before=await f.ports.read(target);
  const accepted=await f.ports.deliver(delivery(before.revision));
  expect(accepted).toEqual({status:"accepted",receiptRef:"delivery:one"});
  expect(f.call).toHaveBeenCalledWith("deliver",{action:"session",session_ref:target.sessionRef,message:"Продолжи проверку.",mode:"queue",request_key:"stable-request"});
  expect(await f.ports.reconcile({target,requestKey:"stable-request",receipt:accepted})).toEqual(accepted);
  f.setTask({taskId:"delivery:one",resultType:"complete",status:"completed",result:{structuredContent:{outcome:"confirmed",native_receipt_id:"r1",native_message_id:"native-generated-1"}}});
  expect(await f.ports.reconcile({target,requestKey:"stable-request",receipt:accepted})).toEqual({status:"confirmed",receiptRef:"delivery:one",messageId:"native-generated-1"});
  expect(f.call.mock.calls.filter(c=>c[0]==="deliver")).toHaveLength(1);
 });
 it("never treats an error envelope or a different task as confirmed",async()=>{
  const f=fixture();const before=await f.ports.read(target);
  f.setDelivery({isError:true,structuredContent:{outcome:"confirmed",native_receipt_id:"cannot-be-confirmed"}});
  expect(await f.ports.deliver(delivery(before.revision))).toMatchObject({status:"unknown"});
  f.setTask({taskId:"other-task",resultType:"complete",status:"completed",result:{outcome:"confirmed",native_receipt_id:"wrong"}});
  expect(await f.ports.reconcile({target,requestKey:"stable-request",receipt:{status:"accepted",receiptRef:"delivery:one"}})).toEqual({status:"unknown",receiptRef:"delivery:one",reason:"native_delivery_unverified"});
  expect(await f.ports.reconcile({target,requestKey:"stable-request"})).toMatchObject({status:"unknown",reason:"native_delivery_unverified"});
 });
 it("respects native no-effect refusals and disables writes without a config target check",async()=>{
  const f=fixture();const before=await f.ports.read(target);
  f.setDelivery({isError:true,structuredContent:{effect:"none",reason:"human_stop"}});
  expect(await f.ports.deliver(delivery(before.revision))).toMatchObject({status:"rejected"});
  const disabled=createV1BrowserNativePorts({...config,enabled:false},{call:f.call});
  const count=f.call.mock.calls.length;
  expect(await disabled.deliver(delivery(before.revision))).toMatchObject({status:"rejected",reason:"autopilot_disabled"});
  expect(f.call.mock.calls).toHaveLength(count);
 });
 it("reconciles a lost receipt using one exact new user message at the original native turn",async()=>{
  const f=fixture();
  f.messages.push({id:"generated-native-1",role:"user",text:"Продолжи проверку."});
  const evidence={message:"Продолжи проверку.",assistantMessageId:"a1",nativeSessionId:"native-chat"};
  expect(await f.ports.reconcile({target,requestKey:"lost-response",evidence})).toEqual({status:"confirmed",messageId:"generated-native-1"});
  expect(f.call.mock.calls.some(c=>c[0]==="deliver")).toBe(false);
  f.messages.push({id:"duplicate",role:"user",text:"Продолжи проверку."});
  expect(await f.ports.reconcile({target,requestKey:"lost-response",evidence})).toMatchObject({status:"unknown"});
 });
 it("leaves absent or later matching history UNKNOWN without resending",async()=>{
  const f=fixture();
  const evidence={message:"Продолжи проверку.",assistantMessageId:"a1",nativeSessionId:"native-chat"};
  expect(await f.ports.reconcile({target,requestKey:"lost-response",evidence})).toMatchObject({status:"unknown"});
  f.messages.push({id:"human-new",role:"user",text:"Новая задача"},{id:"later-match",role:"user",text:"Продолжи проверку."});
  expect(await f.ports.reconcile({target,requestKey:"lost-response",evidence})).toMatchObject({status:"unknown"});
  expect(f.call.mock.calls.some(c=>c[0]==="deliver")).toBe(false);
 });

});
