import { expect, it } from "vitest";
import { readMinimaxActiveSessions,readMinimaxRuntimeCandidateIds } from "../src/adapters/minimax-code-active.js";
import { readMinimaxRuntimeActiveSessions } from "../src/adapters/minimax-code-runtime-activity.js";
it("reuses display metadata while validating current activity and hydrates NEW accepted IDs exactly",async()=>{
 const methods:string[]=[];let ids=["root"],running=new Set(["root"]);
 const control={call:async(_method:string,path:string)=>{methods.push(path);if(path.includes("/agent"))throw Error("historical enumeration forbidden");const id=path.split("/")[2];return{ok:true,status:200,body:path.endsWith("turn-continuation")?{state:running.has(id)?2:0}:{session_id:id,agent_name:id==="child"?"worker":"mavis",parent_session_id:id==="child"?"root":undefined,status:{status_type:0,error_code:50113},title:id}}}};
 const options={readRuntimeCandidateIds:async()=>ids};
 const first=await readMinimaxActiveSessions(control,options);expect(first.sessions.map(s=>s.id)).toEqual(["root"]);
 ids=["root","child"];running.add("child");const second=await readMinimaxActiveSessions(control,options);
 expect(second.sessions.map(s=>s.id).sort()).toEqual(["child","root"]);
 expect(second.sessions.find(s=>s.id==="child")?.meta?.parentSessionId).toBe("root");
 expect(methods.filter(p=>p==="/session/root")).toHaveLength(1);expect(methods.filter(p=>p==="/session/child")).toHaveLength(1);
 running.delete("root");expect((await readMinimaxActiveSessions(control,options)).sessions.map(s=>s.id)).toEqual(["child"]);
 expect(second.receipt).toMatchObject({exhaustive:true,source:"native_active_turn",metadataEnumerationExhaustive:false});
});
it("missing or slow metadata never excludes a positive runtime identity",async()=>{
 const control={call:async(_m:string,path:string)=>path.endsWith("turn-continuation")?{ok:true,status:200,body:{state:2}}:new Promise<any>(()=>{})};
 const started=performance.now();const r=await readMinimaxActiveSessions(control,{readRuntimeCandidateIds:async()=>["active"]});
 expect(performance.now()-started).toBeLessThan(1000);expect(r.sessions).toMatchObject([{id:"active",meta:{metadataUnavailable:true,lineageKind:"unknown"}}]);expect(r.receipt.exhaustive).toBe(true);
});
it("keeps good positives when one current runtime request fails",async()=>{
 const control={call:async(_m:string,path:string)=>path.includes("/bad/")?{ok:false,status:503,body:null}:{ok:true,status:200,body:path.endsWith("turn-continuation")?{state:2}:{session_id:"good"}}};
 const r=await readMinimaxActiveSessions(control,{readRuntimeCandidateIds:async()=>["good","bad"]});
 expect(r.sessions.map(s=>s.id)).toEqual(["good"]);expect(r.receipt).toMatchObject({exhaustive:false,failedCandidateCount:1,reason:"native_runtime_candidate_validation_partial"});
});
it("unavailable seed cannot produce a complete empty activity answer",async()=>{
 const r=await readMinimaxActiveSessions({call:async()=>{throw Error("not expected")}},{readRuntimeCandidateIds:async()=>{throw Error("missing")}});
 expect(r.receipt).toMatchObject({exhaustive:false,reason:"native_runtime_candidate_seed_unavailable"});
});
it("seeds manual compaction and regular turns from readonly accepted ingress, excluding settled history",async()=>{
 const {mkdtemp,rm}=await import("node:fs/promises"),{tmpdir}=await import("node:os"),{join}=await import("node:path"),{DatabaseSync}=await import("node:sqlite");
 const root=await mkdtemp(join(tmpdir(),"minimax-active-ingress-")),path=join(root,"native.sqlite"),db=new DatabaseSync(path);
 db.exec("create table local_runtime_turn_ingress(session_id text,status text,source text);insert into local_runtime_turn_ingress values('manual-compaction','accepted','compaction'),('ordinary','accepted','turn'),('old','completed','turn')");db.close();
 try{expect((await readMinimaxRuntimeCandidateIds(path)).sort()).toEqual(["manual-compaction","ordinary"])}finally{await rm(root,{recursive:true,force:true})}
});

it("does not turn an empty seed with an unavailable controller into complete zero",async()=>{
 const withoutRuntimeProof={readRuntimeActivity:async()=>{throw Error("minimax_runtime_state_unavailable")}};
 await expect(readMinimaxActiveSessions({call:async()=>({ok:false,status:503,body:null})},{readRuntimeCandidateIds:async()=>[],...withoutRuntimeProof})).rejects.toThrow();
 const r=await readMinimaxActiveSessions({call:async()=>({ok:true,status:200,body:{agents:[]}})},{readRuntimeCandidateIds:async()=>[]});
 expect(r.receipt.exhaustive).toBe(true);expect(r.sessions).toEqual([]);
});

it("proves activity from the runtime turn lease when the desktop transport is not published",async()=>{
 const control={call:async(_m:string,path:string)=>({ok:false,status:0,body:null,error:"MiniMax Code control transport is not published"})};
 const proof={sessions:[{id:"mvs_live",harness:"minimax-code",title:"Цель листа L31",status:"running",cwd:"/work",hostId:"host",lastActivity:new Date(0).toISOString(),needsPermission:false,lineage:{kind:"root"},meta:{activityEvidence:"native_runtime_turn_lease",activityObservedAt:new Date().toISOString(),activityExpiresAt:new Date().toISOString(),liveStatus:"running",goalSource:"runtime_state"}}],leaseCount:1,unprovenLeaseCount:0,observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+15000).toISOString()};
 const r=await readMinimaxActiveSessions(control,{readRuntimeCandidateIds:async()=>[],readRuntimeActivity:async()=>proof});
 expect(r.sessions.map(s=>s.id)).toEqual(["mvs_live"]);
 expect(r.sessions[0]?.title).toBe("Цель листа L31");
 expect(r.sessions[0]?.meta?.activityEvidence).toBe("native_runtime_turn_lease");
 expect(r.receipt).toMatchObject({exhaustive:true,source:"native_runtime_turn_lease",activityCoverage:"native_runtime_turn_lease",failedCandidateCount:0});
});

it("never invents an empty activity list from an unproven runtime lease",async()=>{
 const control={call:async()=>({ok:false,status:0,body:null,error:"MiniMax Code control transport is not published"})};
 const proof={sessions:[],leaseCount:2,unprovenLeaseCount:2,observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+15000).toISOString()};
 await expect(readMinimaxActiveSessions(control,{readRuntimeCandidateIds:async()=>[],readRuntimeActivity:async()=>proof})).rejects.toThrow();
});

it("uses the runtime turn lease when the controller confirmed no turn at all",async()=>{
 const control={call:async(_m:string,path:string)=>path.endsWith("turn-continuation")?{ok:true,status:200,body:{state:0}}:{ok:true,status:200,body:{session_id:"idle"}}};
 const proof={sessions:[{id:"mvs_lease",harness:"minimax-code",title:"Цель листа L31",status:"running",cwd:"/work",hostId:"host",lastActivity:new Date(0).toISOString(),needsPermission:false,meta:{activityEvidence:"native_runtime_turn_lease",activityObservedAt:new Date().toISOString(),activityExpiresAt:new Date().toISOString(),liveStatus:"running"}}],leaseCount:1,unprovenLeaseCount:0,observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+15000).toISOString()};
 const r=await readMinimaxActiveSessions(control,{readRuntimeCandidateIds:async()=>["idle"],readRuntimeActivity:async()=>proof});
 expect(r.sessions.map(s=>s.id)).toEqual(["mvs_lease"]);
 expect(r.receipt).toMatchObject({source:"native_runtime_turn_lease",exhaustive:true});
});

it("keeps a readable reason code when neither the controller nor the runtime state can prove activity",async()=>{
 const control={call:async()=>({ok:false,status:0,body:null,error:"MiniMax Code control transport is not published"})};
 await expect(readMinimaxActiveSessions(control,{readRuntimeCandidateIds:async()=>[],readRuntimeActivity:async()=>{throw Error("minimax_runtime_state_unavailable")}})).rejects.toThrow("minimax_control_transport_unavailable");
});

it("reads live turns from the runtime state and refuses a lease of a dead owner",async()=>{
 const {mkdtemp,rm}=await import("node:fs/promises"),{tmpdir}=await import("node:os"),{join}=await import("node:path"),{DatabaseSync}=await import("node:sqlite");
 const {spawnSync}=await import("node:child_process");
 const root=await mkdtemp(join(tmpdir(),"minimax-runtime-activity-")),path=join(root,"runtime.sqlite"),db=new DatabaseSync(path);
 const dead=spawnSync(process.execPath,["-e","0"],{stdio:"ignore"});
 db.exec(`create table local_runtime_session_locks(session_id text,owner_id text,owner_kind text,acquired_at_ms integer,expires_at_ms integer);
  create table local_runtime_sessions(session_id text,title text,workspace_dir text,parent_session_id text,agent_name text,updated_at_ms integer,created_at_ms integer);
  create table local_runtime_turn_ingress(session_id text,status text,completed_at_ms integer);
  create table local_runtime_session_agent_state(session_id text,terminal_outcome text);
  create table local_runtime_message_rows(session_id text,role text,created_at_ms integer,data_json text);`);
 const future=Date.now()+60000,aliveOwner=`turn-lease:${process.pid}:owner`,deadOwner=`turn-lease:${dead.pid}:owner`;
 db.exec(`insert into local_runtime_session_locks values('live','${aliveOwner}','turn',${Date.now()},${future});
  insert into local_runtime_session_locks values('settled','${aliveOwner}','turn',${Date.now()},${future});
  insert into local_runtime_session_locks values('dead','${deadOwner}','turn',${Date.now()},${future});
  insert into local_runtime_session_locks values('expired','${aliveOwner}','turn',${Date.now()},${Date.now()-1000});
  insert into local_runtime_sessions values('live','Цель листа L31','/work',null,'mavis',${Date.now()},${Date.now()});
  insert into local_runtime_sessions values('settled','Устаревшая','/work',null,'mavis',${Date.now()},${Date.now()});
  insert into local_runtime_sessions values('dead','Мёртвый рантайм','/work',null,'mavis',${Date.now()},${Date.now()});
  insert into local_runtime_turn_ingress values('live','accepted',null);
  insert into local_runtime_turn_ingress values('settled','completed',${Date.now()});
  insert into local_runtime_turn_ingress values('dead','accepted',null);
  insert into local_runtime_session_agent_state values('live',null);
  insert into local_runtime_session_agent_state values('settled',null);
  insert into local_runtime_session_agent_state values('dead',null);
  insert into local_runtime_message_rows values('live','user',${Date.now()},'{"msg_content":"первый промпт цели"}');`);
 db.close();
 try{
  const proof=await readMinimaxRuntimeActiveSessions(path);
  expect(proof.sessions.map(s=>s.id)).toEqual(["live"]);
  expect(proof.sessions[0]?.title).toBe("Цель листа L31");
  expect(proof.sessions[0]?.meta?.activityEvidence).toBe("native_runtime_turn_lease");
  expect(proof.unprovenLeaseCount).toBe(1);
 }finally{await rm(root,{recursive:true,force:true})}
});

it("takes the goal of a session without a title from its first prompt",async()=>{
 const {mkdtemp,rm}=await import("node:fs/promises"),{tmpdir}=await import("node:os"),{join}=await import("node:path"),{DatabaseSync}=await import("node:sqlite");
 const root=await mkdtemp(join(tmpdir(),"minimax-runtime-goal-")),path=join(root,"runtime.sqlite"),db=new DatabaseSync(path);
 const future=Date.now()+60000;
 db.exec(`create table local_runtime_session_locks(session_id text,owner_id text,owner_kind text,acquired_at_ms integer,expires_at_ms integer);
  create table local_runtime_sessions(session_id text,title text,workspace_dir text,parent_session_id text,agent_name text,updated_at_ms integer,created_at_ms integer);
  create table local_runtime_turn_ingress(session_id text,status text,completed_at_ms integer);
  create table local_runtime_session_agent_state(session_id text,terminal_outcome text);
  create table local_runtime_message_rows(session_id text,role text,created_at_ms integer,data_json text);`);
 db.exec(`insert into local_runtime_session_locks values('untitled','turn-lease:${process.pid}:owner','turn',${Date.now()},${future});
  insert into local_runtime_sessions values('untitled',null,'/work',null,'mavis',${Date.now()},${Date.now()});
  insert into local_runtime_turn_ingress values('untitled','accepted',null);
  insert into local_runtime_session_agent_state values('untitled',null);
  insert into local_runtime_message_rows values('untitled','user',${Date.now()},'{"msg_content":"Ты исполнитель листа L31 в плане флота"}');`);
 db.close();
 try{
  const proof=await readMinimaxRuntimeActiveSessions(path);
  expect(proof.sessions[0]?.title).toBe("Ты исполнитель листа L31 в плане флота");
  expect(proof.sessions[0]?.meta?.goalSource).toBe("runtime_first_message");
 }finally{await rm(root,{recursive:true,force:true})}
});
