import {expect,it,vi} from "vitest";
import {readCodexActiveRuntime,type CodexActiveThread} from "../src/adapters/codex-active-runtime.js";
import {CodexAppServerAdapter} from "../src/adapters/codex-app-server.js";
import type {AgentSession} from "../src/types/index.js";
const map=(t:CodexActiveThread)=>({id:t.id,harness:"codex",title:t.id,cwd:t.cwd||"/workspace",status:"running",needsPermission:false,lastActivity:new Date().toISOString()}) as AgentSession;
it("reads only fully paginated loaded IDs and current metadata; excludes loaded terminals",async()=>{
 const calls:string[]=[];
 const request=async(method:string,params:any)=>{
  calls.push(method);
  if(method==="thread/loaded/list")return params.cursor?{data:["blocked"],nextCursor:null}:{data:["active","terminal"],nextCursor:"next"};
  expect(method).toBe("thread/read");expect(params.includeTurns).toBe(false);
  return{thread:{id:params.threadId,status:{type:params.threadId==="terminal"?"idle":"active",activeFlags:params.threadId==="blocked"?["waitingOnUserInput"]:[]}}};
 };
 const r=await readCodexActiveRuntime(request,map);
 expect(r.sessions.map(s=>s.id).sort()).toEqual(["active","blocked"]);
 expect(r.sessions.find(s=>s.id==="blocked")?.status).toBe("needs_input");
 expect(r.receipt).toMatchObject({exhaustive:true,candidateCount:3,pages:2,scope:"connected_native_controller"});
 expect(calls).not.toContain("thread/list");
});
it("preserves current positives when one loaded metadata read fails",async()=>{
 const r=await readCodexActiveRuntime(async(method,params:any)=>method==="thread/loaded/list"?{data:["good","bad"]}:params.threadId==="bad"?Promise.reject(Error("unavailable")):{thread:{id:"good",status:"active"}},map);
 expect(r.sessions.map(s=>s.id)).toEqual(["good"]);expect(r.receipt).toMatchObject({exhaustive:false,failedCandidateCount:1});
});
it("never starts a native transport or falls back to history when disconnected",async()=>{
 const adapter=new CodexAppServerAdapter({cwd:"/workspace"});
 const internals=adapter as any;
 internals.isReady=()=>false;internals.ensureReady=vi.fn();internals.rawTranscriptAdapter.listSessions=vi.fn();
 await expect(adapter.listActiveSessions()).rejects.toThrow("existing_transport_unavailable");
 expect(internals.ensureReady).not.toHaveBeenCalled();expect(internals.rawTranscriptAdapter.listSessions).not.toHaveBeenCalled();
});
it("adapter bypasses slow full history and stale cached active-turn flags",async()=>{
 const adapter=new CodexAppServerAdapter({cwd:"/workspace"});const internals=adapter as any;
 internals.isReady=()=>true;internals.activeTurns.set("terminal","old-turn");
 internals.listAllThreads=()=>{throw Error("history forbidden")};
 internals.rawTranscriptAdapter.getNativeSessionMetadata=()=>{throw Error("history forbidden")};
 internals.request=async(method:string,params:any)=>method==="thread/loaded/list"?{data:["active","terminal"]}:{thread:{id:params.threadId,status:params.threadId==="active"?{type:"active",activeFlags:[]}:"idle"}};
 await expect(adapter.listSessions()).rejects.toThrow("history forbidden");
 expect((await adapter.listActiveSessions()).map(s=>s.id)).toEqual(["active"]);
 expect(adapter.getActiveSessionSnapshotReceipt()).toMatchObject({exhaustive:true,source:"codex-loaded-native-runtime"});
});

it.skipIf(!process.env.CODEX_ACTIVE_PROBE_SOCKET)("reads current loaded native activity twice without history or activation",async()=>{
 const {NativeCodexClient}=await import("../src/mesh/native-codex.js");
 const {writeFile}=await import("node:fs/promises");
 const client=new NativeCodexClient(process.env.CODEX_ACTIVE_PROBE_SOCKET);
 await client.connect();
 try{
  const snapshots=[];
  for(let pass=0;pass<2;pass++){
   const started=performance.now(),methods:string[]=[];
   const r=await readCodexActiveRuntime(async(method,params)=>{methods.push(method);return client.request(method,params as Record<string,unknown>)},map);
   expect(r.receipt.exhaustive).toBe(true);expect(methods.every(m=>m==="thread/loaded/list"||m==="thread/read")).toBe(true);
   snapshots.push({elapsedMs:Math.round(performance.now()-started),receipt:r.receipt,ids:r.sessions.map(s=>s.id),statuses:r.sessions.map(s=>({id:s.id,status:s.status,flags:s.meta?.nativeActiveFlags}))});
  }
  await writeFile("/home/roomhacker/agents-projects/agent-herder/.agents/tasks/20261023-fleet-session-search/codex-native-active-freshness-proof.json",JSON.stringify({snapshots},null,2));
 }finally{client.close()}
},20000);
