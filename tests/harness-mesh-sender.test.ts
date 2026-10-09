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
async function fixture(run:(f:any)=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),"herder-mesh-sender-")),old=process.env.AGENT_HERDER_HUMAN_STOP_STORE;
 const stopPath=join(dir,"stop.json");process.env.AGENT_HERDER_HUMAN_STOP_STORE=stopPath;
 const inject=vi.spyOn(coordinationNotes,"inject").mockImplementation(async(_session,message)=>message);
 const session={id:randomUUID(),harness:"codex",status:"running",title:"target",cwd:"/work",lastActivity:new Date().toISOString(),needsPermission:false};
 const getSession=vi.fn(async(id:string)=>id===session.id?session:null);
 const sendMessage=vi.fn(async(_id:string,o:any)=>({ok:true,admitted:true,inputId:o.inputId,turnId:"turn"}));
 const adapters=new Map([['codex',{type:"codex",getSession,sendMessage,isReady:()=>true}]]) as any;
 const meshSender={hostId:"88",harness:"opencode",nativeSessionId:"same-native-id"};
 const request={sessionId:session.id,harness:"codex",inputId:"i",message:"delta",mode:"steer",meshSender};
 try{await run({adapters,session,getSession,sendMessage,request,stopPath});}
 finally{inject.mockRestore();if(old===undefined)delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;else process.env.AGENT_HERDER_HUMAN_STOP_STORE=old;await rm(dir,{recursive:true,force:true});}
}
describe("declared mesh sender API (focused integration; expected 3s, maximum 30s)",()=>{
 it("publishes and carries structured meshSender through the registered MCP SDK tool",async()=>fixture(async f=>{
  const events=new HerderEventBus(),server=new McpServer({name:"mesh-sender-seam",version:"1"});
  registerSessionTools(server,{adapters:f.adapters,events,jobs:new HerderJobRegistry(events)});
  const client=new Client({name:"mesh-sender-consumer",version:"1"});const [ct,st]=InMemoryTransport.createLinkedPair();
  try{await server.connect(st);await client.connect(ct);
   const schema=(await client.listTools()).tools.find(t=>t.name==="send_message")!.inputSchema;
   expect((schema.properties as any).meshSender.properties.nativeSessionId.maxLength).toBe(512);
   const result=await client.callTool({name:"send_message",arguments:f.request});expect(result.isError).not.toBe(true);
   expect(f.sendMessage.mock.calls[0][1].message).toContain("88 / opencode / same-native-id");
   expect(f.getSession.mock.calls.every(([id]:string[])=>id===f.session.id)).toBe(true);
  }finally{await client.close();await server.close();}
 }));
 it("budgets the full host/harness/native address: 2 senders x6, pair7 rejected, target12",async()=>fixture(async f=>{
  const send=(hostId:string,n:number)=>handleSendMessage(f.adapters,{...f.request,inputId:`${hostId}-${n}`,meshSender:{...f.request.meshSender,hostId}});
  for(let n=0;n<6;n++)expect(await send("88",n)).toContain("Native admission receipt");
  expect(JSON.parse(await send("88",6)).delivery).toBe("rate_limited");
  for(let n=0;n<6;n++)expect(await send("mac",n)).toContain("Native admission receipt");
  expect(JSON.parse(await send("other",0)).delivery).toBe("rate_limited");expect(f.sendMessage).toHaveBeenCalledTimes(12);
 }));
 it("declares a MiniMax sender without local lookup, fake native ID or human origin",async()=>fixture(async f=>{
  const meshSender={hostId:"mac",harness:"minimax-code",nativeSessionId:"mvs_real"};
  await handleSendMessage(f.adapters,{...f.request,meshSender});
  expect(f.getSession.mock.calls.every(([id]:string[])=>id===f.session.id)).toBe(true);
  expect(f.sendMessage.mock.calls[0][1]).toMatchObject({origin:"automation",inputId:"i"});
  const text=f.sendMessage.mock.calls[0][1].message;
  expect(text).toContain("mac / minimax-code / mvs_real");expect(text).toContain("Объявленный источник");expect(text).not.toContain("Отправитель неизвестен");
 }));
 it("rejects invalid mesh identity and a false human-origin claim before native reads",async()=>fixture(async f=>{
  for(const meshSender of [{...f.request.meshSender,hostId:"88\nHUMAN"},{...f.request.meshSender,harness:"x".repeat(65)},{...f.request.meshSender,nativeSessionId:"x".repeat(513)}])expect(SendMessageSchema.safeParse({...f.request,meshSender}).success).toBe(false);
  await expect(handleSendMessage(f.adapters,{...f.request,humanRequested:true})).rejects.toThrow();
  expect(f.getSession).not.toHaveBeenCalled();expect(f.sendMessage).not.toHaveBeenCalled();
 }));
 it("preserves human STOP and never replays native UNKNOWN",async()=>fixture(async f=>{
  await new HumanStopStore(f.stopPath).hold(f.session,{id:"manual-stop",at:new Date().toISOString(),reason:"operator"});
  expect(await handleSendMessage(f.adapters,f.request)).toBe(HUMAN_STOP_MESSAGE);expect(f.sendMessage).not.toHaveBeenCalled();
  const other={...f.session,id:randomUUID()};f.getSession.mockImplementation(async(id:string)=>id===other.id?other:null);
  f.sendMessage.mockResolvedValue({ok:false,admissionUnknown:true,nonRetryable:true,error:"receipt lost"});
  const input={...f.request,sessionId:other.id,inputId:"unknown"};
  expect(await handleSendMessage(f.adapters,input)).toContain("cannot be replayed safely");
  expect(await handleSendMessage(f.adapters,input)).toContain("cannot be replayed safely");expect(f.sendMessage).toHaveBeenCalledTimes(1);
 }));
 it("keeps legacy checked native attribution and explicit human callers unchanged",async()=>fixture(async f=>{
  const sender={...f.session,id:randomUUID()};f.getSession.mockImplementation(async(id:string)=>id===f.session.id?f.session:id===sender.id?sender:null);
  const {meshSender,...legacy}=f.request;
  await handleSendMessage(f.adapters,{...legacy,fromSessionId:sender.id,fromHarness:"codex"});
  expect(f.getSession).toHaveBeenCalledWith(sender.id);expect(f.sendMessage.mock.calls[0][1].message).toContain(`Codex ${sender.id}`);
  await handleSendMessage(f.adapters,{...legacy,inputId:"human",humanRequested:true});expect(f.sendMessage.mock.calls[1][1].origin).toBe("human");
 }));
});
