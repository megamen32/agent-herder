import { describe, expect, it, vi } from "vitest";
import { readMinimaxActiveSessions } from "../src/adapters/minimax-code-active.js";
const seed = {readRuntimeCandidateIds:async()=>["root","child","idle"]};

describe("native MiniMax active runtime", () => {
  it("follows every owner/page and validates active controller IDs regardless of metadata/errors", async () => {
    const call = vi.fn(async (_method: string, path: string) => ({ ok: true, status: 200, body:
      path.endsWith("/turn-continuation") ? {state:path.includes("/idle/")?0:2} :
      path === "/agent" ? { agents: [{ name: "mavis" }, { name: "worker" }] } : path.includes("worker") ? {sessions:[{session_id:"child",parent_session_id:"root",status:{status_type:1}}],has_more:false} : path.includes("cursor=") ? {sessions:[{session_id:"idle",status:{status_type:1}}],has_more:false} : {sessions:[{session_id:"root",status:{status_type:0,error_code:50113}}],has_more:true,next_cursor:"page2"} }));
    const result = await readMinimaxActiveSessions({call},seed);
    expect(result.sessions.map(s=>s.id).sort()).toEqual(["child","root"]);
    expect(result.sessions.find(s=>s.id==="root")?.meta).toMatchObject({nativeStatusType:0,nativeContinuationState:2});
    expect(result.sessions.find(s=>s.id==="child")?.meta).toMatchObject({lineageKind:"subagent",parentSessionId:"root"});
    expect(result.receipt).toMatchObject({exhaustive:true,source:"native_active_turn",totalSessions:3,pages:3});
    expect(call.mock.calls.every(([method])=>method==="GET")).toBe(true);
  });
  it("keeps good positives when one current runtime request fails",async()=>{
    const call=async(_method:string,path:string)=> path.includes("/bad/") ? {ok:false,status:503,body:null} : {ok:true,status:200,body:path==="/agent"?{agents:[{name:"mavis"}]}:path.endsWith("/turn-continuation")?{state:2}:{sessions:[{session_id:"good",status:{status_type:0}},{session_id:"bad",status:{status_type:1}}],has_more:false}};
    const result=await readMinimaxActiveSessions({call},{readRuntimeCandidateIds:async()=>["good","bad"]});
    expect(result.sessions.map(s=>s.id)).toEqual(["good"]);
    expect(result.receipt).toMatchObject({exhaustive:false,metadataEnumerationExhaustive:true,failedCandidateCount:1,reason:"native_runtime_candidate_validation_partial"});
  });
  it("cannot claim runtime completeness from metadata alone when the seed is unavailable",async()=>{
    const call=async()=>({ok:true,status:200,body:{agents:[]}});
    const result=await readMinimaxActiveSessions({call},{readRuntimeCandidateIds:async()=>{throw Error("missing")}});
    expect(result.receipt).toMatchObject({exhaustive:false,reason:"native_runtime_candidate_seed_unavailable"});
  });
  it("does not report an empty complete result on unavailable or malformed native metadata", async () => {
    await expect(readMinimaxActiveSessions({call:async()=>({ok:false,status:0,body:null})},seed)).rejects.toThrow();
    await expect(readMinimaxActiveSessions({call:async()=>({ok:true,status:200,body:{}})},seed)).rejects.toThrow();
  });
  it("rejects repeating pagination instead of silently truncating active sessions", async () => {
    const call=async(_m:string,p:string)=>({ok:true,status:200,body:p==="/agent"?{agents:[{name:"mavis"}]}:{sessions:[],has_more:true,next_cursor:"repeat"}});
    await expect(readMinimaxActiveSessions({call},seed)).rejects.toThrow("cursor_invalid");
  });
});

it("seeds manual compaction and regular turns from readonly accepted ingress, excluding settled history",async()=>{
  const {mkdtemp,rm}=await import("node:fs/promises"),{tmpdir}=await import("node:os"),{join}=await import("node:path"),{DatabaseSync}=await import("node:sqlite");
  const {readMinimaxRuntimeCandidateIds}=await import("../src/adapters/minimax-code-active.js");
  const root=await mkdtemp(join(tmpdir(),"minimax-active-ingress-")),path=join(root,"native.sqlite");
  const db=new DatabaseSync(path);
  db.exec("create table local_runtime_turn_ingress(session_id text,status text,source text);insert into local_runtime_turn_ingress values('manual-compaction','accepted','compaction'),('ordinary','accepted','turn'),('old','completed','turn')");db.close();
  try{expect((await readMinimaxRuntimeCandidateIds(path)).sort()).toEqual(["manual-compaction","ordinary"])}finally{await rm(root,{recursive:true,force:true})}
});
