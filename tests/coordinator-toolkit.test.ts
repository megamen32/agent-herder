import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { registerSessionTools } from "../src/mcp/session-tools.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";

it("advertises project memory to a plain MCP coordinator", async () => {
  const server = new McpServer({name:"herder",version:"1"});
  const events = new HerderEventBus();
  registerSessionTools(server,{adapters:new Map(),events,jobs:new HerderJobRegistry(events),routingPeers:[]});
  const client = new Client({name:"plain",version:"1"});
  const [a,b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    expect((await client.listTools()).tools.map(t=>t.name)).toContain("project_memory");
  } finally { await client.close(); await server.close(); }
});

import { hostname, tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSession, HarnessAdapter, SessionMessageView } from "../src/types/index.js";
import { trustedMeshIngressForOwnerStdio } from "../src/mesh/authenticated-ingress.js";
import { registerControlPlaneTools } from "../src/mcp/control-plane-tools.js";
import { CoordinationNoteStore } from "../src/coordination-notes.js";
import { registerHumanRequestTools } from "../src/mcp/human-request-tools.js";
import { registerResumeAfterTools } from "../src/mcp/resume-after-tools.js";
import { withToolConsolidation } from "../src/mcp/tool-consolidation.js";
import { HumanRequestRegistry } from "../src/human-request/registry.js";
import { ResumeAfterService } from "../src/resume-after.js";
import { GoalStore } from "../src/autopilot/goal-store.js";
import { resolveAutopilotStateDir } from "../src/autopilot/state-dir.js";
import type { PendingHumanQuestion } from "../src/autopilot/index.js";
import { SessionSupervisor } from "../src/session-supervisor.js";

it("coordinates two native workers using only Herder MCP tools",async()=>{
  const cwd=await mkdtemp(join(tmpdir(),"herder-coordinator-"));
  const project="integration", source={harness:"codex",sessionId:"lead",cwd};
  const original="  Keep the original wording.\nInclude both workers.  ";
  const goals=new GoalStore(resolveAutopilotStateDir());
  await goals.arm({identity:source,goal:{eventId:"u1",text:original},requirements:[]});
  const events=new HerderEventBus(), jobs=new HerderJobRegistry(events,{persistencePath:join(cwd,"jobs.json")});
  const sessions=new Map<string,AgentSession>(), history=new Map<string,SessionMessageView[]>();
  const adapter:HarnessAdapter={
    type:"codex",name:"fake worker",async init(){},
    async listSessions(){return [...sessions.values()]},async getSession(id){return sessions.get(id)??null},
    async createSession(options){
      const id=options.name;
      const session:AgentSession={id,harness:"codex",hostId:hostname(),title:id,cwd,status:"running",lastActivity:new Date().toISOString(),needsPermission:false};
      sessions.set(id,session);history.set(id,[]);return session;
    },
    async getSessionMessagesPage(id){return {sessionId:id,source:"native-db",complete:true,messages:[...(history.get(id)??[])]}},
    async sendMessage(id,options){
      const entries=history.get(id)!;
      entries.push({id:"in-"+entries.length,role:"user",text:options.message,parts:[]});
      if(options.inputId==="follow"){
        entries.push({id:"reply",role:"assistant",text:"Ready A",turnId:"follow-turn",parts:[]});
        sessions.get(id)!.status="idle";
        sessions.get(id)!.meta={nativeLastTurn:{turnId:"follow-turn",status:"completed"}};
      }
      return {ok:true,admitted:true,inputId:options.inputId,turnId:"follow-turn"};
    },
    async stopSession(){return {ok:true}},async respondPermission(){return {ok:true}},async setPermissions(){return {ok:true}},
  };
  const questions=new HumanRequestRegistry(join(cwd,"questions.json")), cards:PendingHumanQuestion[]=[];
  const answers:string[]=[];
  const waits=new ResumeAfterService({directory:join(cwd,"waits"),isHeld:async()=>false,isBusy:async()=>false,deliver:async()=>({status:"accepted"})});
  const server=new McpServer({name:"herder",version:"1"}), client=new Client({name:"plain-client",version:"1"});
  withToolConsolidation(server,()=>{
    registerSessionTools(server,{adapters:new Map([["codex",adapter]]),jobs,events,routingPeers:[],trustedIngress:trustedMeshIngressForOwnerStdio()});
    registerControlPlaneTools(server,{jobs,events,coordination:new CoordinationNoteStore(join(cwd,"notes.json"),events)});
    registerHumanRequestTools(server,questions,{deliverDecision:async card=>{cards.push(card)},humanResume:async req=>{
      answers.push(req.target.session_id+" "+req.result_ref);
      return {status:"accepted",target:req.target,result_ref:req.result_ref,receipt_ref:"fake-resume",idempotency_key:req.idempotency_key};
    }});
    registerResumeAfterTools(server,waits,questions);
  },new Set());
  const [a,b]=InMemoryTransport.createLinkedPair();
  const call=async(name:string,args:Record<string,unknown>)=>{
    const result=await client.callTool({name,arguments:args});
    if(result.isError) throw new Error(name+" "+JSON.stringify(result.content));
    return (result.structuredContent??JSON.parse(result.content[0].text)) as Record<string,any>;
  };
  try {
    await server.connect(b);await client.connect(a);
    const observed=await call("human_messages",source);
    const humanCitations=[{...source,eventId:observed.messages[0].eventId}];
    for(const name of ["A","B"]){
      const receipt=await call("deliver",{project,harness:"codex",name,cwd,message:"Implement "+name,humanCitations,inputId:"start-"+name});
      expect(receipt).toMatchObject({ok:true,sessionId:name});
      const prompt=history.get(name)![0]!.text!;
      expect(prompt).toContain(JSON.stringify(original));
      expect(prompt).toContain('"author":"human"');
      expect(prompt).toContain(observed.messages[0].at);
    }
    const response=await call("send_message",{harness:"codex",sessionId:"A",mode:"sync",inputId:"follow",message:"Report back",humanCitations});
    expect(response.response).toMatchObject({text:"Ready A"});
    const supervisor=new SessionSupervisor(new Map([["codex",adapter]]),{} as never,undefined,{events});
    const waiting=call("session_await",{sessionIds:["B"],afterSequence:response.cursor,timeoutMs:2000});
    setTimeout(()=>supervisor["handleHarnessEvent"]("codex",{harness:"codex",kind:"turn.completed",sessionId:"B",completionState:{sessionId:"B",turnId:"finish-B",state:"finished",outcome:"completed",finishedAt:new Date().toISOString(),lastAssistantMessage:"Ready B"}}),20);
    expect((await waiting).completion).toMatchObject({sessionId:"B",lastAssistantMessage:"Ready B"});
    const question=await call("human_request",{action:"create",kind:"user",...source,message:"Publish?",choices:[{choiceId:"yes",label:"Publish"},{choiceId:"no",label:"Hold"}],recommendedChoiceId:"yes"});
    expect(cards[0]?.question.choices?.[0]).toEqual({choice_id:"yes",label:"Publish (recommended)"});
    const answer=await call("human_request",{action:"resolve",requestId:question.request.requestId,resolutionRef:"result://fixture/yes"});
    expect(answer.resume.status).toBe("resumed");expect(answers).toEqual(["lead result://fixture/yes"]);
    const wake=await call("resume_after",{action:"wait",owner:{harness:"codex",sessionId:"lead"},requestId:"later",message:"Check progress",trigger:{kind:"delay",delayMs:60000}});
    expect(wake.wait.state).toBe("waiting");
    expect((await call("project_memory",{project,action:"write",ifMatch:0,text:"Reviewed"})).revision).toBe(1);
    expect(await call("project_memory",{project,action:"write",ifMatch:0,text:"Stale"})).toMatchObject({error:"revision_conflict",revision:1});
    for(const sessionId of ["A","B"]) await call("worker",{project,action:"resolve",harness:"codex",sessionId});
    expect((await call("worker",{project,action:"list"})).workers.map((w:any)=>w.state)).toEqual(["done","done"]);
  } finally { await client.close();await server.close();await rm(cwd,{recursive:true,force:true}); }
});
