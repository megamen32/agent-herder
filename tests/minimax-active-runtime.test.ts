import { expect, it } from "vitest";
import { readMinimaxActiveSessions,readMinimaxRuntimeCandidateIds } from "../src/adapters/minimax-code-active.js";
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
 await expect(readMinimaxActiveSessions({call:async()=>({ok:false,status:503,body:null})},{readRuntimeCandidateIds:async()=>[]})).rejects.toThrow();
 const r=await readMinimaxActiveSessions({call:async()=>({ok:true,status:200,body:{agents:[]}})},{readRuntimeCandidateIds:async()=>[]});
 expect(r.receipt.exhaustive).toBe(true);expect(r.sessions).toEqual([]);
});
