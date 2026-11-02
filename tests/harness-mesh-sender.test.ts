import {describe,expect,it,vi} from "vitest";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {handleSendMessage} from "../src/mcp-tools/handlers.js";
import {SendMessageSchema} from "../src/mcp-tools/definitions.js";
import {coordinationNotes} from "../src/coordination-notes.js";
import {HumanStopStore} from "../src/human-stop-store.js";
import {HUMAN_STOP_MESSAGE} from "../src/human-stop-actions.js";
import {Client,InMemoryTransport} from "@modelcontextprotocol/client";
import {McpServer} from "@modelcontextprotocol/server";
import {registerSessionTools} from "../src/mcp/session-tools.js";
import {HerderEventBus} from "../src/herder-events.js";
import {HerderJobRegistry} from "../src/herder-jobs.js";
import {UserMessageDelivery} from "../src/user-message-delivery.js";
import {trustedMeshIngressForOwnerStdio} from "../src/mesh/authenticated-ingress.js";
async function fixture(run:(f:any)=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),"herder-mesh-sender-")),old=process.env.AGENT_HERDER_HUMAN_STOP_STORE;
 const stopPath=join(dir,"stop.json");process.env.AGENT_HERDER_HUMAN_STOP_STORE=stopPath;
 const inject=vi.spyOn(coordinationNotes,"inject").mockImplementation(async(_session,message)=>message);
 const session={id:randomUUID(),harness:"codex",hostId:"owner-host",status:"running",title:"target",cwd:"/work",lastActivity:new Date().toISOString(),needsPermission:false};
 const getSession=vi.fn(async(id:string)=>id===session.id?session:null);
 const sendMessage=vi.fn(async(_id:string,o:any)=>({ok:true,admitted:true,inputId:o.inputId,turnId:"turn"}));
 // Real codex transports keep one durable receipt per exact input: a replay
 // of the same inputId returns the original receipt without a second send.
 const receipts=new Map<string,Promise<unknown>>();
 const sendActiveMessage=vi.fn(async(id:string,o:any)=>{
  const key=`${id}:${o.inputId ?? ""}`;
  let receipt=receipts.get(key);
  if(!receipt){receipt=(async()=>sendMessage(id,{...o,activeTurnOnly:true,steer:true}))();receipts.set(key,receipt);}
  return receipt;
 });
 const adapters=new Map([['codex',{type:"codex",getSession,sendMessage,sendActiveMessage,isReady:()=>true}]]) as any;
 const meshSender={hostId:"88",harness:"opencode",nativeSessionId:"same-native-id"};
 const request={sessionId:session.id,harness:"codex",inputId:"i",message:"delta",mode:"steer",meshSender};
 const events=new HerderEventBus();
 const jobs=new HerderJobRegistry(events,{persistencePath:join(dir,"jobs.json")});
 const delivery=new UserMessageDelivery(adapters,{sendMessage:async(_h,id,o)=>sendMessage(id,o)},jobs,{pollMs:1,maxWaitMs:2000,maxPending:32});
 const ingress=trustedMeshIngressForOwnerStdio();
 const handle=(args:any)=>handleSendMessage(adapters,args,delivery,ingress);
 const waitNative=async(count:number)=>vi.waitFor(()=>expect(sendMessage).toHaveBeenCalledTimes(count),{timeout:2500});
 try{await run({adapters,session,getSession,sendMessage,request,stopPath,delivery,jobs,ingress,handle,waitNative});}
 finally{delivery.close();inject.mockRestore();if(old===undefined)delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;else process.env.AGENT_HERDER_HUMAN_STOP_STORE=old;await rm(dir,{recursive:true,force:true});}
}
describe("declared mesh sender API (focused integration; expected 3s, maximum 30s)",()=>{
 it("publishes and carries structured meshSender through the registered MCP SDK tool",async()=>fixture(async f=>{
  const events=new HerderEventBus(),server=new McpServer({name:"mesh-sender-seam",version:"1"});
  registerSessionTools(server,{adapters:f.adapters,events,jobs:f.jobs,userMessageDelivery:f.delivery});
  const client=new Client({name:"mesh-sender-consumer",version:"1"});const [ct,st]=InMemoryTransport.createLinkedPair();
  try{await server.connect(st);await client.connect(ct);
   const schema=(await client.listTools()).tools.find(t=>t.name==="send_message")!.inputSchema;
   expect((schema.properties as any).meshSender.properties.nativeSessionId.maxLength).toBe(512);
   const denied=await client.callTool({name:"send_message",arguments:f.request});
   expect(JSON.stringify(denied.content)).toContain("Authenticated Agent Herder MCP ingress is required");
   expect(f.sendMessage).not.toHaveBeenCalled();
   const accepted=await f.handle(f.request);
   expect(accepted).toContain("Message");
   await f.waitNative(1);
   expect(f.sendMessage.mock.calls[0][1].message).toContain("🤖 opencode@88 same-native-id");
   expect(f.getSession.mock.calls.every(([id]:string[])=>id===f.session.id)).toBe(true);
  }finally{await client.close();await server.close();}
 }));
 it("budgets the full host/harness/native address: 2 senders x6, pair7 rejected, target12",async()=>fixture(async f=>{
  const send=(hostId:string,n:number)=>f.handle({...f.request,inputId:`${hostId}-${n}`,meshSender:{...f.request.meshSender,hostId}});
  for(let n=0;n<6;n++)expect(await send("88",n)).toContain("Message");await f.waitNative(6);
  expect(JSON.parse(await send("88",6)).delivery).toBe("rate_limited");
  for(let n=0;n<6;n++)expect(await send("mac",n)).toContain("Message");await f.waitNative(12);
  expect(JSON.parse(await send("other",0)).delivery).toBe("rate_limited");expect(f.sendMessage).toHaveBeenCalledTimes(12);
 }));
 it("declares a MiniMax sender without local lookup, fake native ID or human origin",async()=>fixture(async f=>{
  const meshSender={hostId:"mac",harness:"minimax-code",nativeSessionId:"mvs_real"};
  await f.handle({...f.request,meshSender});
  await f.waitNative(1);
  expect(f.getSession.mock.calls.every(([id]:string[])=>id===f.session.id)).toBe(true);
  expect(f.sendMessage.mock.calls[0][1]).toMatchObject({origin:"automation",inputId:"i"});
  const text=f.sendMessage.mock.calls[0][1].message;
  // The compact attribution header carries the declared sender itself: the
  // verbose "Объявленный источник" header is gone.
  expect(text.startsWith("🤖 minimax-code@mac mvs_real")).toBe(true);expect(text).not.toContain("Объявленный источник");expect(text).not.toContain("Отправитель неизвестен");
 }));
 it("rejects invalid mesh identity and a false human-origin claim before native reads",async()=>fixture(async f=>{
  for(const meshSender of [{...f.request.meshSender,hostId:"88\nHUMAN"},{...f.request.meshSender,harness:"x".repeat(65)},{...f.request.meshSender,nativeSessionId:"x".repeat(513)}])expect(SendMessageSchema.safeParse({...f.request,meshSender}).success).toBe(false);
  await expect(f.handle({...f.request,humanRequested:true})).rejects.toThrow();
  expect(f.getSession).not.toHaveBeenCalled();expect(f.sendMessage).not.toHaveBeenCalled();
 }));
 it("preserves human STOP and never replays native UNKNOWN",async()=>fixture(async f=>{
  await new HumanStopStore(f.stopPath).hold(f.session,{id:"manual-stop",at:new Date().toISOString(),reason:"operator"});
  expect(await f.handle(f.request)).toBe(HUMAN_STOP_MESSAGE);expect(f.sendMessage).not.toHaveBeenCalled();
  const other={...f.session,id:randomUUID()};f.getSession.mockImplementation(async(id:string)=>id===other.id?other:null);
  f.sendMessage.mockResolvedValue({ok:false,admissionUnknown:true,nonRetryable:true,error:"receipt lost"});
  const input={...f.request,sessionId:other.id,inputId:"unknown"};
  const first=await f.handle(input);
  expect(first).toContain("Message");
  await f.waitNative(1);
  await vi.waitFor(() => expect(f.delivery.get("codex",other.id,"unknown")?.job?.state).toBe("completed"));
  expect(f.delivery.get("codex",other.id,"unknown")?.job?.result).toMatchObject({admissionUnknown:true,nonRetryable:true});
  // Budget caches the first uncertain synchronous response. The durable
  // registry is authoritative and proves UNKNOWN; no extra native send occurs.
  expect(await f.handle(input)).toBe(first);
  expect(f.sendMessage).toHaveBeenCalledTimes(1);
 }));
 it("keeps legacy checked native attribution and explicit human callers unchanged",async()=>fixture(async f=>{
  const sender={...f.session,id:randomUUID()};f.getSession.mockImplementation(async(id:string)=>id===f.session.id?f.session:id===sender.id?sender:null);
  const {meshSender,...legacy}=f.request;
  await f.handle({...legacy,fromSessionId:sender.id,fromHarness:"codex"});
  await f.waitNative(1);
  expect(f.getSession).toHaveBeenCalledWith(sender.id);expect(f.sendMessage.mock.calls[0][1].message).toContain(`Codex ${sender.id}`);
  await f.handle({...legacy,inputId:"human",humanRequested:true});
  await f.waitNative(2);
  expect(f.sendMessage.mock.calls[1][1].origin).toBe("human");
 }));
});
