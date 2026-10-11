/** Production named runner → real plugin HTTP/atomic gate/terminal override. Expected3/max12s. */
import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import {mkdtemp,mkdir,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it} from "vitest";
import {HermesAdapter} from "../src/adapters/hermes/adapter.js";
import {newOrResumeNamedSession} from "../src/named-session.js";

it("refuses cached/resolved A after B in the actual plugin and leaves terminal CWD untouched",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"herder-task-binding-")),cwdA=join(dir,"A"),cwdB=join(dir,"B");await mkdir(cwdA);await mkdir(cwdB);
 const child=spawn("/home/roomhacker/.hermes/hermes-agent/venv/bin/python",["-B","tests/fixtures/hermes-task-peer.py",dir],{stdio:["pipe","pipe","pipe"]});
 const lines=createInterface({input:child.stdout});let stderr="";child.stderr.on("data",p=>stderr+=String(p));
 const next=()=>new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(stderr||"peer deadline")),4000);lines.once("line",line=>{clearTimeout(timer);resolve(JSON.parse(line));});child.once("exit",()=>{clearTimeout(timer);reject(new Error(stderr||"peer exited"));});});
 try {
  const peer=await next();const adapter=new HermesAdapter({gatewayEndpoint:peer.url,env:{AGENT_RESUME_HERMES_TOKEN:"fixture-token"}});
  const adapters=new Map([["hermes",adapter]]);
  const a={harness:"hermes",name:"repair-A",cwd:cwdA,message:"A initial",inputId:"a-initial",mode:"queue" as const};
  expect(await newOrResumeNamedSession(adapters,a)).toMatchObject({ok:true,admitted:true,sessionId:peer.key});
  const resolvedA=await adapter.getSession(peer.key);
  const b=await adapter.createSession({name:"repair-B",cwd:cwdB});
  expect(await adapter.sendMessage(peer.key,{message:"B initial",inputId:"b-initial",expectedTaskBinding:b.meta!.taskBinding as any})).toMatchObject({admitted:true});
  expect(await newOrResumeNamedSession(adapters,{...a,message:"Distinct cached A",inputId:"a-cached"})).toMatchObject({ok:false});
  expect(await adapter.sendMessage(peer.key,{message:"Earlier resolved A",inputId:"a-resolved",expectedTaskBinding:resolvedA!.meta!.taskBinding as any})).toMatchObject({ok:false,notSubmitted:true});
  expect(await adapter.getMessageAdmission(peer.key,"a-cached")).toEqual({state:"not_found"});
  expect(await adapter.sendMessage(peer.key,{message:"Current home followup",inputId:"home-current"})).toMatchObject({admitted:true});
  const pending=next();child.stdin.write("proof\n");const proof=await pending;
  expect(proof.calls.map((v:any)=>v.cwd)).toEqual([cwdA,cwdB,cwdB]);
  expect(proof.calls.every((v:any)=>v.sessionKey===peer.key)).toBe(true);
  expect(await adapter.getMessageAdmission(peer.key,"a-initial")).toEqual({state:"admitted"});
 } finally {
  child.stdin.end("stop\n");await new Promise<void>(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>{child.kill();resolve();},1500);child.once("exit",()=>{clearTimeout(timer);resolve();});});lines.close();await rm(dir,{recursive:true,force:true});
 }
},12000);
