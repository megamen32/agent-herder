/** Production Herder → frozen Notice HTTP/DB/card worker; expected 3s/max 12s. */
import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {expect,it} from "vitest";
import {createAutopilotCore,createNoticePlaceSink,drainPendingNotices,loadReceiptStore,persistReceiptStore,type StopHookInput} from "../src/autopilot/index.js";

it.runIf(Boolean(process.env.NOTICEPLACE_TEST_ROOT))("persists real executor independently of a long generic summary and replays one canonical card",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"herder-display-coupled-"));
 const child=spawn("/usr/bin/python3",["-B","tests/fixtures/autopilot-notice-peer.py",dir,process.env.NOTICEPLACE_TEST_ROOT!,"execution-display"],{stdio:["pipe","pipe","pipe"]});
 const lines=createInterface({input:child.stdout});let stderr="";child.stderr.on("data",part=>stderr+=String(part));
 try {
  const peer=await new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(stderr||"peer setup deadline")),4000);lines.once("line",line=>{clearTimeout(timer);resolve(JSON.parse(line));});child.once("exit",()=>{clearTimeout(timer);reject(new Error(stderr));});});
  const sink=createNoticePlaceSink({eventUrl:peer.url+"/v1/events",token:"hermes-token"});
  const receipts=new Map();const hook:StopHookInput={hook_event_name:"Stop",session_id:"ses_REAL",harness:"opencode",cwd:dir,model:"minimax-coding-plan/MiniMax-M2.5",turn_id:"long-done",last_assistant_message:"Исправлено",transcript_path:null,stop_hook_active:false};
  await createAutopilotCore({judge:{decide:async()=>({kind:"done",summary:"Исправление сервиса проверено. ".repeat(400)})},notify:{async send(p){await sink.send(p);throw new Error("lost ACK");}},receiptStore:receipts,allowSessions:new Set([hook.session_id]),maxContinuationsPerSession:3,harness:"opencode",notification:{project:"hermes",recipient:"me",kind:"notification"}}).handleStop(hook);
  const path=join(dir,"receipts.json");await persistReceiptStore(path,receipts);
  expect(await drainPendingNotices(await loadReceiptStore(path),sink)).toBe(1);
  const proof:any=await(await fetch(peer.url+"/fixture-proof")).json();
  expect(proof.incidents).toBe(1);expect(proof.questions).toBe(0);expect(proof.progress).toBe(0);
  expect(proof.payloads).toHaveLength(1);
  expect(proof.payloads[0].execution_identity).toEqual({harness:"opencode",session_id:hook.session_id,model:hook.model,cwd:dir,session_url:"https://agent.bezrabotnyi.com/#/session/opencode%3Ases_REAL"});
  const sends=proof.calls.filter((c:any)=>c.method==="sendMessage");expect(sends).toHaveLength(1);
  expect(JSON.stringify(sends[0])).toContain("OpenCode");expect(JSON.stringify(sends[0])).toContain("opencode%3Ases_REAL");
 } finally {
  child.stdin.end("stop\n");await new Promise<void>(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>{child.kill();resolve();},1500);child.once("exit",()=>{clearTimeout(timer);resolve();});});lines.close();await rm(dir,{recursive:true,force:true});
 }
},12000);
